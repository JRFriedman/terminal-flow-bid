import type { Address } from "viem";
import type { PricePoint } from "./types.js";
import { getTokenPrice } from "../swap.js";

const MAX_HISTORY_POINTS = 2880; // ~24h at 30s intervals

interface TrackerEntry {
  interval: ReturnType<typeof setInterval>;
  history: PricePoint[];
  refCount: number;
  decimals: number;
}

const trackers = new Map<string, TrackerEntry>();

export function startTracking(
  tokenAddress: string,
  intervalMs: number,
  tokenDecimals: number = 18
): void {
  const key = tokenAddress.toLowerCase();
  const existing = trackers.get(key);

  if (existing) {
    existing.refCount++;
    return;
  }

  const entry: TrackerEntry = {
    interval: null!,
    history: [],
    refCount: 1,
    decimals: tokenDecimals,
  };

  async function poll() {
    try {
      const price = await getTokenPrice(key as Address, entry.decimals);
      const point: PricePoint = { timestamp: Date.now(), price };
      entry.history.push(point);
      if (entry.history.length > MAX_HISTORY_POINTS) {
        entry.history.shift();
      }
    } catch (err: any) {
      console.error(`[price-tracker] ${key.slice(0, 10)}: ${err.message}`);
    }
  }

  // First poll immediately
  poll();
  entry.interval = setInterval(poll, intervalMs);
  trackers.set(key, entry);
  console.log(`[price-tracker] Started tracking ${key.slice(0, 10)} every ${intervalMs / 1000}s`);
}

export function stopTracking(tokenAddress: string): void {
  const key = tokenAddress.toLowerCase();
  const entry = trackers.get(key);
  if (!entry) return;

  entry.refCount--;
  if (entry.refCount <= 0) {
    clearInterval(entry.interval);
    trackers.delete(key);
    console.log(`[price-tracker] Stopped tracking ${key.slice(0, 10)}`);
  }
}

export function getPrice(tokenAddress: string): number | null {
  const entry = trackers.get(tokenAddress.toLowerCase());
  if (!entry || entry.history.length === 0) return null;
  return entry.history[entry.history.length - 1].price;
}

export function getHistory(tokenAddress: string): PricePoint[] {
  const entry = trackers.get(tokenAddress.toLowerCase());
  return entry ? entry.history : [];
}

/**
 * Exponential moving average over the last `periodMinutes` of price data.
 */
export function ema(tokenAddress: string, periodMinutes: number): number | null {
  const entry = trackers.get(tokenAddress.toLowerCase());
  if (!entry || entry.history.length === 0) return null;

  const cutoff = Date.now() - periodMinutes * 60_000;
  const points = entry.history.filter((p) => p.timestamp >= cutoff);
  if (points.length < 2) return null;

  const k = 2 / (points.length + 1);
  let emaVal = points[0].price;
  for (let i = 1; i < points.length; i++) {
    emaVal = points[i].price * k + emaVal * (1 - k);
  }
  return emaVal;
}

/**
 * Simple moving average over the last `periodMinutes` of price data.
 */
export function sma(tokenAddress: string, periodMinutes: number): number | null {
  const entry = trackers.get(tokenAddress.toLowerCase());
  if (!entry || entry.history.length === 0) return null;

  const cutoff = Date.now() - periodMinutes * 60_000;
  const points = entry.history.filter((p) => p.timestamp >= cutoff);
  if (points.length === 0) return null;

  const sum = points.reduce((acc, p) => acc + p.price, 0);
  return sum / points.length;
}
