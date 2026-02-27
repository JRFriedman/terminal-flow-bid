import { type Address, erc20Abi } from "viem";
import type { TradingStrategyState, RiskLimits } from "../types.js";
import type { EvaluateFn, Signal } from "../engine.js";
import { runTradingStrategy, nextStrategyId } from "../engine.js";
import { getPublicClient, getAccount } from "../../config.js";

export interface DcaParams {
  amountPerBuy: number;    // USDC per purchase
  intervalMs: number;      // time between buys
  totalBudget: number;     // max total USDC to spend (0 = unlimited)
  lastBuyTime: number;     // timestamp of last buy
}

const dcaEvaluate: EvaluateFn = (state, indicators) => {
  const params = state.params as unknown as DcaParams;

  // Check if enough time has elapsed since last buy
  const now = Date.now();
  if (params.lastBuyTime > 0 && now - params.lastBuyTime < params.intervalMs) {
    return null;
  }

  // Check budget
  if (params.totalBudget > 0 && state.position.totalInvested >= params.totalBudget) {
    return null; // budget exhausted — engine will keep running for risk mgmt
  }

  // Calculate how much to buy (respect remaining budget)
  let amount = params.amountPerBuy;
  if (params.totalBudget > 0) {
    const remaining = params.totalBudget - state.position.totalInvested;
    amount = Math.min(amount, remaining);
  }

  if (amount <= 0) return null;

  // Mark time (will be committed after trade executes)
  params.lastBuyTime = now;

  return { side: "buy", amountUsdc: amount };
};

export function parseInterval(input: string): number {
  const match = input.match(/^(\d+)(m|h|d)$/i);
  if (!match) throw new Error(`Invalid interval: ${input} (use 1h, 4h, 12h, 1d, 30m)`);
  const val = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === "m") return val * 60_000;
  if (unit === "h") return val * 3_600_000;
  if (unit === "d") return val * 86_400_000;
  throw new Error(`Invalid interval unit: ${unit}`);
}

export interface StartDcaOptions {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountPerBuy: number;
  intervalMs: number;
  totalBudget?: number;
  riskLimits?: Partial<RiskLimits>;
}

export function startDca(opts: StartDcaOptions): TradingStrategyState {
  const id = nextStrategyId();

  const riskLimits: RiskLimits = {
    maxPositionUsdc: opts.riskLimits?.maxPositionUsdc ?? 5000,
    stopLossPercent: opts.riskLimits?.stopLossPercent ?? 20,
    maxDrawdownPercent: opts.riskLimits?.maxDrawdownPercent ?? 30,
  };

  const params: DcaParams = {
    amountPerBuy: opts.amountPerBuy,
    intervalMs: opts.intervalMs,
    totalBudget: opts.totalBudget ?? 0,
    lastBuyTime: 0,
  };

  const state: TradingStrategyState = {
    id,
    type: "dca",
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

  const intervalDesc = formatDuration(opts.intervalMs);
  const budgetDesc = opts.totalBudget ? ` | budget: $${opts.totalBudget}` : " | no budget limit";
  state.log.push({
    time: Date.now(),
    message: `DCA started: $${opts.amountPerBuy} every ${intervalDesc}${budgetDesc}`,
    type: "info",
  });

  runTradingStrategy(state, dcaEvaluate);
  return state;
}

export { dcaEvaluate };

function formatDuration(ms: number): string {
  if (ms >= 86_400_000) return `${ms / 86_400_000}d`;
  if (ms >= 3_600_000) return `${ms / 3_600_000}h`;
  return `${ms / 60_000}m`;
}
