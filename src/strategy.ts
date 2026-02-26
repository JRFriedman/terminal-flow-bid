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

const POLL_INTERVAL_MS = 4000; // Check every 4 seconds (~2 blocks)

export interface StrategyParams {
  bidder: string;
  auctionAddress: string;
  minFdvUsd: number;
  maxFdvUsd: number;
  amount: number;
  exitProfile?: string; // "conservative", "moderate", "aggressive", or custom "50@3x,50@5x"
}

export interface StrategyState {
  auctionAddress: string;
  status: "waiting" | "running" | "done" | "failed";
  currentFdv: number;
  impliedFdv: number;
  bidsPlaced: number;
  lastBidFdv: number | null;
  clearingPrice: string | null;
  totalBids: number;
  exitProfile?: string;
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
    return true;
  }
  return false;
}

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
  const { bidder, auctionAddress, minFdvUsd, maxFdvUsd, amount, exitProfile } = params;

  const state: StrategyState = {
    auctionAddress,
    status: "waiting",
    currentFdv: minFdvUsd,
    impliedFdv: 0,
    bidsPlaced: 0,
    lastBidFdv: null,
    clearingPrice: null,
    totalBids: 0,
    exitProfile,
    log: [],
  };
  strategies.set(auctionAddress, state);

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
        }, POLL_INTERVAL_MS);
      });
    }

    if (state.status === "done") return; // Cancelled while waiting

    state.status = "running";
    addLog(state, "Auction started — placing initial bid", "info");

    // Place initial bid at minFdv
    await placeBid(state, { bidder, auctionAddress, maxFdvUsd: minFdvUsd, amount });

    // Poll and adjust during auction
    await new Promise<void>((resolve) => {
      const interval = setInterval(async () => {
        if (state.status === "done") {
          clearInterval(interval);
          resolve();
          return;
        }

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
            clearInterval(interval);
            resolve();
            return;
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
            await placeBid(state, { bidder, auctionAddress, maxFdvUsd: newFdv, amount });
          }
        } catch (err: any) {
          addLog(state, `Poll error: ${err.message}`, "error");
        }
      }, POLL_INTERVAL_MS);
    });
  } catch (err: any) {
    state.status = "failed";
    addLog(state, `Strategy failed: ${err.message}`, "error");
    throw err;
  }
}

async function placeBid(
  state: StrategyState,
  params: BuildBidTxParams
): Promise<void> {
  try {
    addLog(state, `Bidding ${params.amount} USDC @ $${params.maxFdvUsd} FDV`, "bid");
    await submitBid(params);
    state.bidsPlaced++;
    state.lastBidFdv = params.maxFdvUsd;
    addLog(state, `Bid confirmed @ $${params.maxFdvUsd} FDV`, "bid");
  } catch (err: any) {
    addLog(state, `Bid failed: ${err.message}`, "error");
    throw err;
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
