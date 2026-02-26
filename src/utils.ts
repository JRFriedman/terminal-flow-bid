import { getCurrentBlock } from "./api.js";

const BASE_BLOCK_TIME_SECONDS = 2;

export function estimateTimestampForBlock(
  targetBlock: number,
  currentBlock: number,
  currentTimestamp: number
): number {
  const blockDiff = targetBlock - currentBlock;
  return currentTimestamp + blockDiff * BASE_BLOCK_TIME_SECONDS;
}

export function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

export function baseScanTxUrl(txHash: string): string {
  return `https://basescan.org/tx/${txHash}`;
}

export async function getBlockTiming() {
  const block = await getCurrentBlock();
  return {
    blockNumber: block.blockNumber,
    timestamp: block.timestamp,
  };
}

export function printJson(label: string, data: unknown) {
  console.log(`\n${label}:`);
  console.log(JSON.stringify(data, null, 2));
}
