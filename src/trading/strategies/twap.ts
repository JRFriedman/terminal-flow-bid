import type { TradingStrategyState, RiskLimits } from "../types.js";
import type { EvaluateFn, Signal } from "../engine.js";
import { runTradingStrategy, nextStrategyId } from "../engine.js";

export interface TwapParams {
  totalAmount: number;     // total USDC to deploy
  durationMs: number;      // time window
  chunks: number;          // number of equal trades
  chunkSize: number;       // totalAmount / chunks
  chunkInterval: number;   // durationMs / chunks
  chunksExecuted: number;  // how many chunks done
  startTime: number;       // when strategy started
  lastChunkTime: number;   // timestamp of last chunk
}

const twapEvaluate: EvaluateFn = (state, indicators) => {
  const params = state.params as unknown as TwapParams;

  // All chunks done?
  if (params.chunksExecuted >= params.chunks) {
    state.status = "done";
    state.log.push({
      time: Date.now(),
      message: `TWAP complete: ${params.chunksExecuted}/${params.chunks} chunks executed`,
      type: "info",
    });
    return null;
  }

  // Check if next chunk is due
  const now = Date.now();
  const nextChunkTime = params.startTime + (params.chunksExecuted + 1) * params.chunkInterval;

  if (now < nextChunkTime) return null;

  // Signal buy for one chunk
  params.chunksExecuted++;
  params.lastChunkTime = now;

  return { side: "buy", amountUsdc: params.chunkSize };
};

export function parseDuration(input: string): number {
  const match = input.match(/^(\d+)(m|h|d)$/i);
  if (!match) throw new Error(`Invalid duration: ${input} (use 30m, 1h, 4h, 1d)`);
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m") return val * 60_000;
  if (unit === "h") return val * 3_600_000;
  if (unit === "d") return val * 86_400_000;
  throw new Error(`Invalid duration unit: ${unit}`);
}

export interface StartTwapOptions {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  totalAmount: number;
  durationMs: number;
  chunks: number;
  riskLimits?: Partial<RiskLimits>;
}

export function startTwap(opts: StartTwapOptions): TradingStrategyState {
  const id = nextStrategyId();

  const riskLimits: RiskLimits = {
    maxPositionUsdc: opts.riskLimits?.maxPositionUsdc ?? 5000,
    stopLossPercent: opts.riskLimits?.stopLossPercent ?? 20,
    maxDrawdownPercent: opts.riskLimits?.maxDrawdownPercent ?? 30,
  };

  const chunkSize = opts.totalAmount / opts.chunks;
  const chunkInterval = opts.durationMs / opts.chunks;

  const params: TwapParams = {
    totalAmount: opts.totalAmount,
    durationMs: opts.durationMs,
    chunks: opts.chunks,
    chunkSize,
    chunkInterval,
    chunksExecuted: 0,
    startTime: Date.now(),
    lastChunkTime: 0,
  };

  const state: TradingStrategyState = {
    id,
    type: "twap",
    status: "running",
    tokenAddress: opts.tokenAddress,
    tokenSymbol: opts.tokenSymbol,
    tokenDecimals: opts.tokenDecimals,
    position: { tokenBalance: 0, avgEntryPrice: 0, totalInvested: 0, totalRealized: 0 },
    priceHistory: [],
    trades: [],
    pnl: { realized: 0, unrealized: 0 },
    riskLimits,
    params: params as unknown as Record<string, any>,
    log: [],
  };

  const durationDesc = formatDuration(opts.durationMs);
  state.log.push({
    time: Date.now(),
    message: `TWAP started: $${opts.totalAmount} over ${durationDesc} in ${opts.chunks} chunks ($${chunkSize.toFixed(2)} each, every ${formatDuration(chunkInterval)})`,
    type: "info",
  });

  runTradingStrategy(state, twapEvaluate);
  return state;
}

export { twapEvaluate };

function formatDuration(ms: number): string {
  if (ms >= 86_400_000) return `${(ms / 86_400_000).toFixed(1)}d`;
  if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 60_000).toFixed(0)}m`;
}
