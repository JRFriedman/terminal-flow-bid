import {
  getAuction,
  getAuctionBids,
  getCurrentBlock,
  type BuildBidTxParams,
  type AuctionBid,
  type AuctionInfo,
} from "./api.js";
import { submitBid } from "./bid.js";
import { formatCountdown } from "./utils.js";
import { markDirty, registerCollector } from "./persistence.js";

/** Dynamic poll interval based on phase and blocks remaining */
function getPollInterval(status: StrategyState["status"], blocksLeft: number): number {
  if (status === "watching") return 10_000;  // observing: every 10s
  // Bidding phase
  if (blocksLeft <= 5) return 1000;   // last ~10s: every 1s (freshest data)
  return 2000;                         // bid window: every 2s
}

export interface StrategyParams {
  bidder: string;
  auctionAddress: string;
  minFdvUsd: number;
  maxFdvUsd: number;
  amount: number;
  exitProfile?: string; // "conservative", "moderate", "aggressive", or custom "50@3x,50@5x"
  stopLoss?: number;
}

export interface StrategyState {
  auctionAddress: string;
  status: "waiting" | "watching" | "bidding" | "done" | "failed";
  amount: number;
  minFdvUsd: number;
  maxFdvUsd: number;
  currentFdv: number;
  impliedFdv: number;
  bidsPlaced: number;
  maxBidAttempts: number;
  lastBidFdv: number | null;
  clearingPrice: string | null;
  totalBids: number;
  fdvHistory: number[];
  exitProfile?: string;
  stopLoss?: number;
  log: Array<{ time: number; message: string; type: "info" | "bid" | "error" }>;
}

// Active strategies, keyed by auction address
const strategies = new Map<string, StrategyState>();

export function getStrategies(): StrategyState[] {
  return Array.from(strategies.values());
}

export function getStrategy(auctionAddress: string): StrategyState | undefined {
  return strategies.get(auctionAddress);
}

export function cancelStrategy(auctionAddress: string): boolean {
  const s = strategies.get(auctionAddress);
  if (s && (s.status === "waiting" || s.status === "watching" || s.status === "bidding")) {
    s.status = "done";
    addLog(s, "Strategy cancelled", "info");
    markDirty();
    return true;
  }
  return false;
}

/** Restore strategies from persisted state */
export function setStrategies(states: StrategyState[]): void {
  for (const s of states) {
    strategies.set(s.auctionAddress, s);
  }
}

// Register persistence collector
registerCollector(() => ({
  section: "Bid Strategies",
  data: Array.from(strategies.values()),
}));

function addLog(
  state: StrategyState,
  message: string,
  type: "info" | "bid" | "error"
) {
  state.log.push({ time: Date.now(), message, type });
  // Keep last 50 log entries
  if (state.log.length > 50) state.log.shift();
  console.log(`[strategy:${state.auctionAddress.slice(0, 8)}] ${message}`);
}

export async function runStrategy(params: StrategyParams): Promise<void> {
  const { bidder, auctionAddress, minFdvUsd, maxFdvUsd, amount, exitProfile, stopLoss } = params;

  const state: StrategyState = {
    auctionAddress,
    status: "waiting",
    amount,
    minFdvUsd,
    maxFdvUsd,
    currentFdv: minFdvUsd,
    impliedFdv: 0,
    bidsPlaced: 0,
    maxBidAttempts: 2,
    lastBidFdv: null,
    clearingPrice: null,
    totalBids: 0,
    fdvHistory: [],
    exitProfile,
    stopLoss,
    log: [],
  };
  strategies.set(auctionAddress, state);
  markDirty();

  addLog(state, `Strategy started: ${amount} USDC, FDV range $${minFdvUsd} - $${maxFdvUsd}`, "info");

  try {
    // Get auction info
    const auction = await getAuction(auctionAddress);
    const startBlock = parseInt(String(auction.startBlock));
    const endBlock = parseInt(String(auction.endBlock || startBlock + 270));

    if (!startBlock) throw new Error("No startBlock");

    // ── Phase 1: WAITING — wait for auction start ──
    let block = await getCurrentBlock();
    if (block.blockNumber < startBlock) {
      addLog(state, `Waiting for start block ${startBlock} (${startBlock - block.blockNumber} blocks)`, "info");

      await new Promise<void>((resolve, reject) => {
        const interval = setInterval(async () => {
          if (state.status === "done") {
            clearInterval(interval);
            resolve();
            return;
          }
          try {
            block = await getCurrentBlock();
            if (block.blockNumber >= startBlock) {
              clearInterval(interval);
              resolve();
            }
          } catch (err) {
            // Transient error, keep polling
          }
        }, 4000);
      });
    }

    if (state.status === "done") return; // Cancelled while waiting

    // ── Phase 2: WATCHING — observe clearing price, do NOT bid ──
    state.status = "watching";
    markDirty();
    addLog(state, "Auction started — watching clearing price (will bid in final ~30s)", "info");

    while (state.status === "watching") {
      try {
        const [currentBlock, bids, auctionInfo] = await Promise.all([
          getCurrentBlock(),
          getAuctionBids(auctionAddress),
          getAuction(auctionAddress),
        ]);

        // Check if auction ended while watching
        if (currentBlock.blockNumber >= endBlock) {
          addLog(state, "Auction ended before bid window", "info");
          state.status = "done";
          markDirty();
          break;
        }

        const blocksLeft = endBlock - currentBlock.blockNumber;
        state.totalBids = bids.length;
        state.clearingPrice = (auctionInfo as any).clearingPrice || null;

        // Track implied FDV from clearing price
        const clearingQ96 = parseFloat((auctionInfo as any).clearingPrice || "0");
        if (clearingQ96 > 0) {
          state.impliedFdv = Math.round(q96ToFdv(clearingQ96, auctionInfo));
          // Track FDV history (last 20 observations)
          state.fdvHistory.push(state.impliedFdv);
          if (state.fdvHistory.length > 20) state.fdvHistory.shift();
        }

        addLog(
          state,
          `Watching: ${blocksLeft} blocks left, ${bids.length} bids, clearing FDV: $${state.impliedFdv || "n/a"}`,
          "info"
        );

        // Transition to bidding when ≤15 blocks (~30s) remain
        if (blocksLeft <= 15) {
          state.status = "bidding";
          markDirty();
          addLog(state, `Entering bid window (${blocksLeft} blocks left)`, "info");
          break;
        }

        // Wait — just observing, no urgency
        const delay = getPollInterval("watching", blocksLeft);
        await new Promise((r) => setTimeout(r, delay));
      } catch (err: any) {
        addLog(state, `Watch error: ${err.message}`, "error");
        await new Promise((r) => setTimeout(r, 5000));
      }
    }

    if (state.status === "done") return; // Cancelled or auction ended

    // ── Phase 3: BIDDING — place single optimized bid ──
    let bidAttempts = 0;

    while (state.status === "bidding" && bidAttempts < state.maxBidAttempts) {
      try {
        const [currentBlock, auctionInfo] = await Promise.all([
          getCurrentBlock(),
          getAuction(auctionAddress),
        ]);

        // Check if auction ended
        if (currentBlock.blockNumber >= endBlock) {
          addLog(state, "Auction ended", "info");
          state.status = "done";
          markDirty();
          break;
        }

        const blocksLeft = endBlock - currentBlock.blockNumber;

        // Refresh clearing price
        const clearingQ96 = parseFloat((auctionInfo as any).clearingPrice || "0");
        if (clearingQ96 > 0) {
          state.impliedFdv = Math.round(q96ToFdv(clearingQ96, auctionInfo));
        }

        // Calculate target FDV
        let targetFdv: number;
        if (state.impliedFdv > 0) {
          // Bid 15% above clearing, capped at max
          targetFdv = Math.min(Math.ceil(state.impliedFdv * 1.15), maxFdvUsd);
        } else {
          // No clearing data — bid at floor + 5% buffer
          targetFdv = Math.ceil(minFdvUsd * 1.05);
        }
        state.currentFdv = targetFdv;

        addLog(
          state,
          `Bidding attempt ${bidAttempts + 1}/${state.maxBidAttempts}: ${amount} USDC @ $${targetFdv} FDV (clearing: $${state.impliedFdv || "n/a"}, ${blocksLeft} blocks left)`,
          "info"
        );

        const ok = await placeBid(state, {
          bidder,
          auctionAddress,
          maxFdvUsd: targetFdv,
          amount,
        });

        bidAttempts++;

        if (ok) {
          // Bid placed successfully — we're done
          state.status = "done";
          markDirty();
          addLog(state, "Strategy complete — bid placed", "info");
          break;
        }

        if ((state.status as string) === "done") break; // AuctionEnded (set by placeBid)

        // Bid failed (e.g. below clearing) — retry with bumped FDV if we have attempts left
        if (bidAttempts < state.maxBidAttempts) {
          addLog(state, `Retrying in 2s...`, "info");
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (err: any) {
        addLog(state, `Bid error: ${err.message}`, "error");
        bidAttempts++;
        if (bidAttempts < state.maxBidAttempts) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    // If we exhausted attempts without a successful bid
    if (state.status === "bidding") {
      state.status = "done";
      markDirty();
      addLog(state, `Strategy ended — ${bidAttempts} bid attempts exhausted`, "error");
    }
  } catch (err: any) {
    state.status = "failed";
    addLog(state, `Strategy failed: ${err.message}`, "error");
    markDirty();
    throw err;
  }
}

async function placeBid(
  state: StrategyState,
  params: BuildBidTxParams
): Promise<boolean> {
  try {
    addLog(state, `Bidding ${params.amount} USDC @ $${params.maxFdvUsd} FDV`, "bid");
    const result = await submitBid(params);
    state.bidsPlaced++;
    state.lastBidFdv = result.actualFdv;
    // Update currentFdv if bid.ts bumped it due to Q96 alignment
    if (result.actualFdv > state.currentFdv) {
      state.currentFdv = result.actualFdv;
    }
    addLog(state, `Bid confirmed @ $${result.actualFdv} FDV`, "bid");
    return true;
  } catch (err: any) {
    const msg = err.message || String(err);
    if (msg.includes("BidMustBeAboveClearingPrice")) {
      // Bump FDV 20% for retry
      const bumpedFdv = Math.min(Math.ceil(state.currentFdv * 1.20), state.maxFdvUsd);
      addLog(state, `Bid below clearing price (FDV $${state.currentFdv}) — bumping to $${bumpedFdv} for retry`, "error");
      state.currentFdv = bumpedFdv;
    } else if (msg.includes("AuctionEnded")) {
      addLog(state, `Auction ended`, "error");
      state.status = "done";
      markDirty();
    } else {
      addLog(state, `Bid failed: ${msg.slice(0, 200)}`, "error");
    }
    return false;
  }
}

/**
 * Convert a Q96 price to implied FDV in USD.
 *
 * The Q96 clearing/floor prices are linearly proportional to token price.
 * We derive the conversion factor from the floor price and the minimum raise:
 *   floor_FDV = (requiredCurrencyRaised / auctionAmount) * totalSupply
 *   implied_FDV = clearingPrice * (floor_FDV / floorPrice)
 */
function q96ToFdv(q96Price: number, auctionInfo: any): number {
  const floorPrice = parseFloat(auctionInfo.floorPrice || "0");
  if (floorPrice <= 0) return 0;

  const requiredRaised = parseFloat(auctionInfo.requiredCurrencyRaised || "0");
  const auctionAmount = parseFloat(auctionInfo.auctionAmount || "0");
  const totalSupply = parseFloat(auctionInfo.totalSupply || "0");
  const tokenDecimals = parseInt(auctionInfo.tokenDecimals || "18");
  const currencyDecimals = 6; // USDC

  if (auctionAmount <= 0 || totalSupply <= 0 || requiredRaised <= 0) return 0;

  // Convert to human-readable units
  const requiredRaisedHuman = requiredRaised / 10 ** currencyDecimals;
  const auctionAmountHuman = auctionAmount / 10 ** tokenDecimals;
  const totalSupplyHuman = totalSupply / 10 ** tokenDecimals;

  const floorFdv = (requiredRaisedHuman / auctionAmountHuman) * totalSupplyHuman;
  return q96Price * (floorFdv / floorPrice);
}
