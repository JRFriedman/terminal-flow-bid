import { type Address, erc20Abi } from "viem";
import type {
  TradingStrategyState,
  Trade,
  RiskLimits,
  StrategyType,
  PricePoint,
} from "./types.js";
import { getPublicClient, getAccount, USDC_BASE } from "../config.js";
import { swapExactInputSingle } from "../swap.js";
import { baseScanTxUrl } from "../utils.js";
import { markDirty, registerCollector } from "../persistence.js";
import { sendTelegramMessage } from "../notify.js";
import {
  startTracking,
  stopTracking,
  getPrice,
  getHistory,
  ema as getEma,
  sma as getSma,
} from "./price-tracker.js";

const POLL_INTERVAL_MS = 30_000;
const MAX_SINGLE_TRADE_USDC = 500;

// ─── State ───

const tradingStrategies = new Map<string, TradingStrategyState>();
const strategyTimers = new Map<string, ReturnType<typeof setInterval>>();
let nextStrategyNum = 1;

// Persistence
registerCollector(() => ({
  section: "Trading Strategies",
  data: Array.from(tradingStrategies.values()),
}));

// ─── Public API ───

export function getTradingStrategies(): TradingStrategyState[] {
  return Array.from(tradingStrategies.values());
}

export function getTradingStrategy(id: string): TradingStrategyState | undefined {
  return tradingStrategies.get(id);
}

/** Generate sequential strategy ID like "001", "002", etc. */
export function nextStrategyId(): string {
  const id = String(nextStrategyNum).padStart(3, "0");
  nextStrategyNum++;
  return id;
}

/** Remove a done/cancelled strategy entirely */
export function removeTradingStrategy(id: string): boolean {
  const s = tradingStrategies.get(id);
  if (!s) return false;
  if (s.status === "running" || s.status === "paused") {
    stopStrategyLoop(id);
  }
  tradingStrategies.delete(id);
  markDirty();
  return true;
}

export function cancelTradingStrategy(id: string): boolean {
  const s = tradingStrategies.get(id);
  if (!s || (s.status !== "running" && s.status !== "paused")) return false;
  s.status = "done";
  addLog(s, "Strategy cancelled by user", "info");
  stopStrategyLoop(id);
  markDirty();
  return true;
}

export function pauseTradingStrategy(id: string): boolean {
  const s = tradingStrategies.get(id);
  if (!s || s.status !== "running") return false;
  s.status = "paused";
  addLog(s, "Strategy paused", "info");
  markDirty();
  return true;
}

export function resumeTradingStrategy(id: string): boolean {
  const s = tradingStrategies.get(id);
  if (!s || s.status !== "paused") return false;
  s.status = "running";
  addLog(s, "Strategy resumed", "info");
  markDirty();
  return true;
}

/** Restore strategies from persisted state (called during boot) */
export function setTradingStrategies(states: TradingStrategyState[]): void {
  for (const s of states) {
    tradingStrategies.set(s.id, s);
    // Update nextStrategyNum to avoid collisions with restored numeric IDs
    const num = parseInt(s.id, 10);
    if (!isNaN(num) && num >= nextStrategyNum) {
      nextStrategyNum = num + 1;
    }
  }
}

/** Resume running strategies after boot */
export function resumeTradingStrategies(
  evaluators: Map<StrategyType, EvaluateFn>
): void {
  for (const state of tradingStrategies.values()) {
    if (state.status === "running") {
      const evaluate = evaluators.get(state.type);
      if (evaluate) {
        console.log(`[trading:${state.id}] Resuming ${state.type} strategy`);
        startStrategyLoop(state, evaluate);
      }
    }
  }
}

// ─── Types ───

export interface Signal {
  side: "buy" | "sell";
  amountUsdc: number;
}

export interface Indicators {
  price: number;
  ema: (periodMinutes: number) => number | null;
  sma: (periodMinutes: number) => number | null;
  history: PricePoint[];
}

export type EvaluateFn = (
  state: TradingStrategyState,
  indicators: Indicators
) => Signal | null;

// ─── Core Loop ───

export function runTradingStrategy(
  state: TradingStrategyState,
  evaluate: EvaluateFn
): void {
  tradingStrategies.set(state.id, state);
  markDirty();

  // Start price tracking (30s intervals)
  startTracking(state.tokenAddress, POLL_INTERVAL_MS, state.tokenDecimals);

  startStrategyLoop(state, evaluate);
}

function startStrategyLoop(
  state: TradingStrategyState,
  evaluate: EvaluateFn
): void {
  // Start price tracking in case it was restored
  startTracking(state.tokenAddress, POLL_INTERVAL_MS, state.tokenDecimals);

  const timer = setInterval(async () => {
    if (state.status !== "running") {
      if (state.status === "paused") return; // keep timer alive for resume
      stopStrategyLoop(state.id);
      return;
    }

    try {
      await tick(state, evaluate);
    } catch (err: any) {
      addLog(state, `Tick error: ${err.message}`, "error");
    }
  }, POLL_INTERVAL_MS);

  strategyTimers.set(state.id, timer);
}

function stopStrategyLoop(id: string): void {
  const timer = strategyTimers.get(id);
  if (timer) {
    clearInterval(timer);
    strategyTimers.delete(id);
  }
  const state = tradingStrategies.get(id);
  if (state) {
    stopTracking(state.tokenAddress);
  }
}

async function tick(
  state: TradingStrategyState,
  evaluate: EvaluateFn
): Promise<void> {
  // Get current price
  const currentPrice = getPrice(state.tokenAddress);
  if (currentPrice == null) return; // no price yet

  // Sync price history from tracker into state (for persistence)
  state.priceHistory = getHistory(state.tokenAddress);

  // Update unrealized PnL
  const currentValue = state.position.tokenBalance * currentPrice;
  state.pnl.unrealized = currentValue - state.position.totalInvested + state.position.totalRealized;

  // ── Risk checks ──
  const limits = state.riskLimits;

  // Stop-loss: sell all if price drops X% below avg entry
  if (
    state.position.tokenBalance > 0 &&
    state.position.avgEntryPrice > 0 &&
    limits.stopLossPercent > 0
  ) {
    const stopPrice = state.position.avgEntryPrice * (1 - limits.stopLossPercent / 100);
    if (currentPrice < stopPrice) {
      addLog(
        state,
        `STOP-LOSS triggered at $${currentPrice.toFixed(6)} (${limits.stopLossPercent}% below avg entry $${state.position.avgEntryPrice.toFixed(6)})`,
        "trade"
      );
      await executeSell(state, state.position.tokenBalance, currentPrice, "stop-loss");
      state.status = "done";
      addLog(state, "Strategy stopped by stop-loss", "info");
      markDirty();
      return;
    }
  }

  // Max drawdown: pause if portfolio value dropped X% from peak
  if (limits.maxDrawdownPercent > 0 && state.position.totalInvested > 0) {
    const totalReturn = state.pnl.realized + state.pnl.unrealized;
    const drawdownPct = (-totalReturn / state.position.totalInvested) * 100;
    if (drawdownPct > limits.maxDrawdownPercent) {
      addLog(
        state,
        `MAX DRAWDOWN hit: ${drawdownPct.toFixed(1)}% (limit: ${limits.maxDrawdownPercent}%)`,
        "trade"
      );
      state.status = "paused";
      markDirty();
      return;
    }
  }

  // Build indicators
  const indicators: Indicators = {
    price: currentPrice,
    ema: (period) => getEma(state.tokenAddress, period),
    sma: (period) => getSma(state.tokenAddress, period),
    history: state.priceHistory,
  };

  // Evaluate strategy
  const signal = evaluate(state, indicators);
  if (!signal) return;

  // Cap single trade size
  const cappedAmount = Math.min(signal.amountUsdc, MAX_SINGLE_TRADE_USDC);

  // Max position check (skip buys if over limit)
  if (signal.side === "buy" && limits.maxPositionUsdc > 0) {
    const positionValue = state.position.tokenBalance * currentPrice;
    if (positionValue >= limits.maxPositionUsdc) {
      return; // silently skip
    }
  }

  if (signal.side === "buy") {
    await executeBuy(state, cappedAmount, currentPrice);
  } else {
    // Sell: convert USDC amount to token amount
    const tokenAmount = cappedAmount / currentPrice;
    const sellAmount = Math.min(tokenAmount, state.position.tokenBalance);
    if (sellAmount > 0) {
      await executeSell(state, sellAmount, currentPrice, "signal");
    }
  }
}

// ─── Trade execution ───

async function executeBuy(
  state: TradingStrategyState,
  amountUsdc: number,
  currentPrice: number
): Promise<void> {
  const publicClient = getPublicClient();
  const account = getAccount();

  // Check USDC balance
  const usdcBalance = await publicClient.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  const usdcAvailable = Number(usdcBalance) / 1e6;

  if (usdcAvailable < amountUsdc) {
    addLog(state, `Insufficient USDC: need $${amountUsdc.toFixed(2)}, have $${usdcAvailable.toFixed(2)}`, "error");
    return;
  }

  const amountIn = BigInt(Math.floor(amountUsdc * 1e6));
  addLog(state, `BUY $${amountUsdc.toFixed(2)} USDC → ${state.tokenSymbol}`, "trade");

  try {
    const { hash, amountOut, gasCostEth } = await swapExactInputSingle(
      USDC_BASE,
      state.tokenAddress as Address,
      amountIn
    );

    const tokenReceived = Number(amountOut) / 10 ** state.tokenDecimals;
    const effectivePrice = amountUsdc / tokenReceived;

    // Update position
    const oldBalance = state.position.tokenBalance;
    const oldAvg = state.position.avgEntryPrice;
    state.position.tokenBalance += tokenReceived;
    state.position.avgEntryPrice =
      (oldAvg * oldBalance + effectivePrice * tokenReceived) /
      state.position.tokenBalance;
    state.position.totalInvested += amountUsdc;
    state.totalGasCostEth = (state.totalGasCostEth || 0) + gasCostEth;

    // Record trade
    const trade: Trade = {
      timestamp: Date.now(),
      side: "buy",
      amountUsdc,
      amountToken: tokenReceived,
      price: effectivePrice,
      txHash: hash,
      gasCostEth,
    };
    state.trades.push(trade);

    addLog(
      state,
      `BUY OK: ${formatNum(tokenReceived)} ${state.tokenSymbol} @ $${effectivePrice.toFixed(6)} [${hash.slice(0, 10)}] (gas: ${gasCostEth.toFixed(5)} ETH)`,
      "trade"
    );
    markDirty();

    // Telegram alert
    const pnlPct = state.position.avgEntryPrice > 0
      ? ((currentPrice - state.position.avgEntryPrice) / state.position.avgEntryPrice * 100)
      : 0;
    const posValue = state.position.tokenBalance * currentPrice;
    await sendTelegramMessage(
      `\uD83D\uDFE2 ${state.type.toUpperCase()} BUY: $${amountUsdc.toFixed(2)} USDC \u2192 ${formatNum(tokenReceived)} ${state.tokenSymbol} @ $${effectivePrice.toFixed(6)}\n` +
      `Position: ${formatNum(state.position.tokenBalance)} ${state.tokenSymbol} ($${posValue.toFixed(2)}) | Avg entry: $${state.position.avgEntryPrice.toFixed(6)} | PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%\n` +
      `[tx](${baseScanTxUrl(hash)})`
    );
  } catch (err: any) {
    addLog(state, `BUY FAILED: ${err.message}`, "error");
  }
}

async function executeSell(
  state: TradingStrategyState,
  tokenAmount: number,
  currentPrice: number,
  reason: string
): Promise<void> {
  const amountIn = BigInt(
    Math.floor(tokenAmount * 10 ** state.tokenDecimals)
  );

  addLog(
    state,
    `SELL ${formatNum(tokenAmount)} ${state.tokenSymbol} (${reason})`,
    "trade"
  );

  try {
    const { hash, amountOut, gasCostEth } = await swapExactInputSingle(
      state.tokenAddress as Address,
      USDC_BASE,
      amountIn
    );

    const usdcReceived = Number(amountOut) / 1e6;
    const effectivePrice = usdcReceived / tokenAmount;

    // Update position
    state.position.tokenBalance -= tokenAmount;
    if (state.position.tokenBalance < 0) state.position.tokenBalance = 0;
    state.position.totalRealized += usdcReceived;
    state.totalGasCostEth = (state.totalGasCostEth || 0) + gasCostEth;

    // Update realized PnL
    state.pnl.realized =
      state.position.totalRealized -
      state.position.totalInvested +
      state.position.tokenBalance * state.position.avgEntryPrice;

    // Record trade
    const trade: Trade = {
      timestamp: Date.now(),
      side: "sell",
      amountUsdc: usdcReceived,
      amountToken: tokenAmount,
      price: effectivePrice,
      txHash: hash,
      gasCostEth,
    };
    state.trades.push(trade);

    addLog(
      state,
      `SELL OK: ${formatNum(tokenAmount)} ${state.tokenSymbol} \u2192 $${usdcReceived.toFixed(2)} @ $${effectivePrice.toFixed(6)} [${hash.slice(0, 10)}] (gas: ${gasCostEth.toFixed(5)} ETH)`,
      "trade"
    );
    markDirty();

    // Telegram alert
    const pnlPct = state.position.avgEntryPrice > 0
      ? ((currentPrice - state.position.avgEntryPrice) / state.position.avgEntryPrice * 100)
      : 0;
    const posValue = state.position.tokenBalance * currentPrice;
    await sendTelegramMessage(
      `\uD83D\uDD34 ${state.type.toUpperCase()} SELL: ${formatNum(tokenAmount)} ${state.tokenSymbol} \u2192 $${usdcReceived.toFixed(2)} USDC @ $${effectivePrice.toFixed(6)} (${reason})\n` +
      `Position: ${formatNum(state.position.tokenBalance)} ${state.tokenSymbol} ($${posValue.toFixed(2)}) | Avg entry: $${state.position.avgEntryPrice.toFixed(6)} | PnL: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%\n` +
      `[tx](${baseScanTxUrl(hash)})`
    );
  } catch (err: any) {
    addLog(state, `SELL FAILED: ${err.message}`, "error");
  }
}

/** Sell a percentage (0-100) of a strategy's token position */
export async function sellStrategyPosition(id: string, pct: number): Promise<{ sold: string } | { error: string }> {
  const s = tradingStrategies.get(id);
  if (!s) return { error: "Strategy not found" };
  if (s.position.tokenBalance <= 0) return { error: "No position to sell" };
  if (pct <= 0 || pct > 100) return { error: "Percentage must be 1-100" };

  const tokenAmount = s.position.tokenBalance * (pct / 100);
  const currentPrice = getPrice(s.tokenAddress) ?? s.position.avgEntryPrice;
  const label = pct === 100 ? "manual sell (all)" : `manual sell (${pct}%)`;

  await executeSell(s, tokenAmount, currentPrice, label);

  // If sold 100%, cancel the strategy
  if (pct === 100 && (s.status === "running" || s.status === "paused")) {
    s.status = "done";
    addLog(s, "Strategy stopped after full sell", "info");
    stopStrategyLoop(id);
  }
  markDirty();

  return { sold: `${formatNum(tokenAmount)} ${s.tokenSymbol} (${pct}%)` };
}

/** Cancel all strategies and sell all token positions back to USDC */
export async function liquidateAll(): Promise<{ cancelled: number; sold: string[]; errors: string[] }> {
  const results = { cancelled: 0, sold: [] as string[], errors: [] as string[] };

  // 1. Cancel all running/paused strategies
  for (const state of tradingStrategies.values()) {
    if (state.status === "running" || state.status === "paused") {
      state.status = "done";
      addLog(state, "Strategy cancelled (liquidate all)", "info");
      stopStrategyLoop(state.id);
      results.cancelled++;
    }
  }
  markDirty();

  // 2. Sell all token positions
  // Deduplicate by token address (multiple strategies may hold the same token)
  const positions = new Map<string, { balance: number; symbol: string; decimals: number; states: TradingStrategyState[] }>();
  for (const state of tradingStrategies.values()) {
    if (state.position.tokenBalance > 0) {
      const key = state.tokenAddress.toLowerCase();
      const existing = positions.get(key);
      if (existing) {
        existing.balance += state.position.tokenBalance;
        existing.states.push(state);
      } else {
        positions.set(key, {
          balance: state.position.tokenBalance,
          symbol: state.tokenSymbol,
          decimals: state.tokenDecimals,
          states: [state],
        });
      }
    }
  }

  for (const [addr, pos] of positions) {
    try {
      const amountIn = BigInt(Math.floor(pos.balance * 10 ** pos.decimals));
      const { hash, amountOut, gasCostEth } = await swapExactInputSingle(
        addr as Address,
        USDC_BASE,
        amountIn
      );
      const usdcReceived = Number(amountOut) / 1e6;
      const effectivePrice = usdcReceived / pos.balance;

      for (const state of pos.states) {
        const sold = state.position.tokenBalance;
        const gasShare = gasCostEth * (sold / pos.balance);
        state.position.tokenBalance = 0;
        state.position.totalRealized += (sold / pos.balance) * usdcReceived;
        state.pnl.realized = state.position.totalRealized - state.position.totalInvested;
        state.totalGasCostEth = (state.totalGasCostEth || 0) + gasShare;
        state.trades.push({
          timestamp: Date.now(),
          side: "sell",
          amountUsdc: (sold / pos.balance) * usdcReceived,
          amountToken: sold,
          price: effectivePrice,
          txHash: hash,
          gasCostEth: gasShare,
        });
        addLog(state, `LIQUIDATED: ${formatNum(sold)} ${pos.symbol} → $${((sold / pos.balance) * usdcReceived).toFixed(2)} USDC [${hash.slice(0, 10)}]`, "trade");
      }

      results.sold.push(`${formatNum(pos.balance)} ${pos.symbol} → $${usdcReceived.toFixed(2)}`);
      await sendTelegramMessage(
        `🔴 LIQUIDATED: ${formatNum(pos.balance)} ${pos.symbol} → $${usdcReceived.toFixed(2)} USDC @ $${effectivePrice.toFixed(6)}\n[tx](${baseScanTxUrl(hash)})`
      );
    } catch (err: any) {
      results.errors.push(`${pos.symbol}: ${err.message}`);
    }
  }

  markDirty();
  return results;
}

// ─── Helpers ───

function addLog(
  state: TradingStrategyState,
  message: string,
  type: "info" | "trade" | "error"
): void {
  state.log.push({ time: Date.now(), message, type });
  if (state.log.length > 100) state.log.shift();
  console.log(`[trading:${state.id}] ${message}`);
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(6);
}
