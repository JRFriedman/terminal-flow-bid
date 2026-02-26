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

/** Dynamic poll interval based on blocks remaining */
function getPollInterval(blocksLeft: number): number {
  if (blocksLeft <= 5) return 2000;   // last ~10s: every 2s
  if (blocksLeft <= 30) return 5000;  // last ~1min: every 5s
  return 30_000;                       // first ~8min: every 30s
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
  status: "waiting" | "running" | "done" | "failed";
  amount: number;
  currentFdv: number;
  impliedFdv: number;
  bidsPlaced: number;
  lastBidFdv: number | null;
  clearingPrice: string | null;
  totalBids: number;
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
  if (s && (s.status === "waiting" || s.status === "running")) {
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
    currentFdv: minFdvUsd,
    impliedFdv: 0,
    bidsPlaced: 0,
    lastBidFdv: null,
    clearingPrice: null,
    totalBids: 0,
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

    // Wait for auction start
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

    state.status = "running";
    markDirty();
    addLog(state, "Auction started — placing initial bid", "info");

    // Fetch initial auction state to bid above clearing
    // Contract requires strictly above clearing/floor — need enough buffer
    // to survive Q96 tick-spacing alignment (1% gets rounded down to floor)
    let initialFdv = Math.ceil(minFdvUsd * 1.05); // 5% above floor to clear tick alignment
    try {
      const auctionInfo = await getAuction(auctionAddress);
      const clearingQ96 = parseFloat((auctionInfo as any).clearingPrice || "0");
      if (clearingQ96 > 0) {
        const impliedFdv = q96ToFdv(clearingQ96, auctionInfo);
        if (impliedFdv >= initialFdv) {
          // Bid 15% above clearing to ensure acceptance
          initialFdv = Math.ceil(impliedFdv * 1.15);
          addLog(state, `Clearing FDV is $${Math.round(impliedFdv)}, bidding at $${initialFdv}`, "info");
        }
      }
    } catch {}
    initialFdv = Math.min(initialFdv, maxFdvUsd);

    // Initial bid — don't die if it fails
    const initialOk = await placeBid(state, { bidder, auctionAddress, maxFdvUsd: initialFdv, amount });
    if (initialOk) {
      state.currentFdv = initialFdv;
    }

    // Poll and adjust during auction with dynamic interval
    while (state.status !== "done") {
      try {
        const [currentBlock, bids, auctionInfo] = await Promise.all([
          getCurrentBlock(),
          getAuctionBids(auctionAddress),
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
        state.totalBids = bids.length;
        state.clearingPrice = (auctionInfo as any).clearingPrice || null;

        // Track implied FDV from clearing price
        const clearingQ96 = parseFloat((auctionInfo as any).clearingPrice || "0");
        if (clearingQ96 > 0) {
          state.impliedFdv = Math.round(q96ToFdv(clearingQ96, auctionInfo));
        }

        // Decide whether to adjust
        const newFdv = calculateAdjustment(state, bids, auctionInfo, {
          minFdvUsd,
          maxFdvUsd,
          blocksLeft,
          auctionDuration: endBlock - startBlock,
        });

        if (newFdv && newFdv > state.currentFdv) {
          state.currentFdv = newFdv;
          addLog(state, `Adjusting FDV to $${newFdv} (${blocksLeft} blocks left)`, "info");
          const ok = await placeBid(state, { bidder, auctionAddress, maxFdvUsd: newFdv, amount });
          if (!ok && (state.status as string) === "done") break; // AuctionEnded
        }

        // If we haven't placed any bid yet, keep trying
        if (state.bidsPlaced === 0) {
          let retryFdv: number;
          if (state.impliedFdv > 0) {
            retryFdv = Math.min(Math.ceil(state.impliedFdv * 1.15), maxFdvUsd);
          } else {
            // No clearing data — use currentFdv (which gets bumped on each failure)
            retryFdv = Math.min(state.currentFdv, maxFdvUsd);
          }
          if (retryFdv >= state.currentFdv && retryFdv <= maxFdvUsd) {
            addLog(state, `Retrying bid at $${retryFdv}${state.impliedFdv > 0 ? ` (above clearing $${state.impliedFdv})` : " (no clearing data)"}`, "info");
            const ok = await placeBid(state, { bidder, auctionAddress, maxFdvUsd: retryFdv, amount });
            if (!ok && (state.status as string) === "done") break;
          }
        }

        // Wait — shorter as auction end approaches
        const delay = getPollInterval(blocksLeft);
        addLog(state, `Next check in ${delay / 1000}s (${blocksLeft} blocks left)`, "info");
        await new Promise((r) => setTimeout(r, delay));
      } catch (err: any) {
        addLog(state, `Poll error: ${err.message}`, "error");
        await new Promise((r) => setTimeout(r, 5000));
      }
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
    // Extract revert reason if present
    if (msg.includes("BidMustBeAboveClearingPrice")) {
      // Bump FDV for next attempt — even if clearing price is unknown,
      // aggressive bumps will eventually clear the tick spacing
      const bumpedFdv = Math.ceil(state.currentFdv * 1.20);
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

interface AdjustmentContext {
  minFdvUsd: number;
  maxFdvUsd: number;
  blocksLeft: number;
  auctionDuration: number;
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

function calculateAdjustment(
  state: StrategyState,
  bids: AuctionBid[],
  auctionInfo: any,
  ctx: AdjustmentContext
): number | null {
  // Already at max
  if (state.currentFdv >= ctx.maxFdvUsd) return null;

  // Check clearing price — if it's above our current bid, we need to adjust
  const clearingPriceQ96 = parseFloat(auctionInfo.clearingPrice || "0");
  if (clearingPriceQ96 <= 0) return null;

  const impliedFdv = q96ToFdv(clearingPriceQ96, auctionInfo);
  if (impliedFdv <= 0 || impliedFdv <= state.currentFdv) return null;

  // The clearing FDV is above our current bid — adjust up
  // Strategy: bid slightly above clearing to stay competitive, but don't exceed max
  // Add a 10% buffer above clearing
  const targetFdv = Math.ceil(impliedFdv * 1.1);
  const cappedFdv = Math.min(targetFdv, ctx.maxFdvUsd);

  // Only adjust if it's meaningfully higher (>5% increase) to avoid spamming
  if (cappedFdv <= state.currentFdv * 1.05) return null;

  return cappedFdv;
}
