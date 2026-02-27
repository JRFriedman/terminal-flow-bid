import type { TradingStrategyState, RiskLimits } from "../types.js";
import type { EvaluateFn, Signal } from "../engine.js";
import { runTradingStrategy, nextStrategyId } from "../engine.js";

export interface MeanReversionParams {
  amountPerTrade: number;      // USDC per buy/sell
  emaPeriodMinutes: number;    // EMA lookback
  buyThresholdPct: number;     // buy when price is X% below EMA
  sellThresholdPct: number;    // sell when price is X% above EMA
  cooldownMs: number;          // min time between trades
  lastTradeTime: number;       // timestamp of last trade
}

const DEFAULT_COOLDOWN_MS = 5 * 60_000; // 5 minutes

const meanReversionEvaluate: EvaluateFn = (state, indicators) => {
  const params = state.params as unknown as MeanReversionParams;

  // Need enough history for EMA
  const emaValue = indicators.ema(params.emaPeriodMinutes);
  if (emaValue == null) return null; // still warming up

  // Cooldown check
  const now = Date.now();
  if (params.lastTradeTime > 0 && now - params.lastTradeTime < params.cooldownMs) {
    return null;
  }

  const currentPrice = indicators.price;
  const deviation = ((currentPrice - emaValue) / emaValue) * 100;

  // Buy when price is below EMA by threshold
  if (deviation < -params.buyThresholdPct) {
    params.lastTradeTime = now;
    return { side: "buy", amountUsdc: params.amountPerTrade };
  }

  // Sell when price is above EMA by threshold (only if we have tokens)
  if (deviation > params.sellThresholdPct && state.position.tokenBalance > 0) {
    params.lastTradeTime = now;
    return { side: "sell", amountUsdc: params.amountPerTrade };
  }

  return null;
};

export interface StartMeanReversionOptions {
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  amountPerTrade: number;
  emaPeriodMinutes: number;
  buyThresholdPct: number;
  sellThresholdPct: number;
  cooldownMs?: number;
  riskLimits?: Partial<RiskLimits>;
}

export function startMeanReversion(
  opts: StartMeanReversionOptions
): TradingStrategyState {
  const id = nextStrategyId();

  const riskLimits: RiskLimits = {
    maxPositionUsdc: opts.riskLimits?.maxPositionUsdc ?? 5000,
    stopLossPercent: opts.riskLimits?.stopLossPercent ?? 25,
    maxDrawdownPercent: opts.riskLimits?.maxDrawdownPercent ?? 30,
  };

  const params: MeanReversionParams = {
    amountPerTrade: opts.amountPerTrade,
    emaPeriodMinutes: opts.emaPeriodMinutes,
    buyThresholdPct: opts.buyThresholdPct,
    sellThresholdPct: opts.sellThresholdPct,
    cooldownMs: opts.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    lastTradeTime: 0,
  };

  const state: TradingStrategyState = {
    id,
    type: "mean-reversion",
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

  state.log.push({
    time: Date.now(),
    message: `Mean-Reversion started: $${opts.amountPerTrade}/trade, ${opts.emaPeriodMinutes}min EMA, buy at -${opts.buyThresholdPct}%, sell at +${opts.sellThresholdPct}%`,
    type: "info",
  });

  runTradingStrategy(state, meanReversionEvaluate);
  return state;
}

export { meanReversionEvaluate };
