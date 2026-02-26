import { type Address, type Hash, erc20Abi } from "viem";
import { getPublicClient, getAccount, USDC_BASE } from "./config.js";
import { getTokenPrice, swapExactInputSingle } from "./swap.js";
import { baseScanTxUrl } from "./utils.js";
import { markDirty, registerCollector } from "./persistence.js";

const POLL_INTERVAL_MS = 30_000; // Check price every 30 seconds

// ─── Types ───

export interface Tranche {
  pctToSell: number;     // 0-100
  targetMultiple: number; // e.g. 3 = sell when FDV is 3x entry
}

export interface ExecutedTranche extends Tranche {
  status: "pending" | "executed" | "skipped";
  executedAt?: number;
  txHash?: string;
  amountSold?: string;    // human-readable token amount
  usdcReceived?: string;  // human-readable USDC amount
}

export type ExitProfileName = "conservative" | "moderate" | "aggressive" | "custom";

export interface ExitStrategyState {
  auctionAddress: string;
  tokenAddress: Address;
  tokenDecimals: number;
  totalSupply: string;
  entryFdv: number;
  initialBalance: string; // raw bigint as string
  currentBalance: string; // raw bigint as string
  currentFdv: number;
  currentMultiple: number;
  profileName: ExitProfileName;
  tranches: ExecutedTranche[];
  totalUsdcRealized: number;
  status: "running" | "done" | "failed" | "cancelled" | "stopped";
  log: Array<{ time: number; message: string; type: "info" | "sell" | "error" }>;
  uniswapFee: number;
  stopLossMultiple?: number;
}

// ─── Preset profiles (dynamic — just shortcuts) ───

export const PROFILES: Record<Exclude<ExitProfileName, "custom">, Tranche[]> = {
  conservative: [
    { pctToSell: 50, targetMultiple: 3 },
    { pctToSell: 50, targetMultiple: 5 },
  ],
  moderate: [
    { pctToSell: 33, targetMultiple: 3 },
    { pctToSell: 33, targetMultiple: 6 },
    { pctToSell: 34, targetMultiple: 10 },
  ],
  aggressive: [
    { pctToSell: 20, targetMultiple: 5 },
    { pctToSell: 30, targetMultiple: 10 },
    { pctToSell: 50, targetMultiple: 20 },
  ],
};

/**
 * Parse custom tranche string like "50@3x,50@5x"
 */
export function parseTranches(input: string): Tranche[] {
  return input.split(",").map((part) => {
    const match = part.trim().match(/^(\d+)@(\d+(?:\.\d+)?)x$/i);
    if (!match) throw new Error(`Invalid tranche format: "${part.trim()}" — use "50@3x"`);
    return {
      pctToSell: parseInt(match[1]),
      targetMultiple: parseFloat(match[2]),
    };
  });
}

/**
 * Resolve profile name or custom string to tranche array
 */
export function resolveTranches(profileOrCustom: string): { name: ExitProfileName; tranches: Tranche[] } {
  const lower = profileOrCustom.toLowerCase();
  if (lower in PROFILES) {
    return { name: lower as Exclude<ExitProfileName, "custom">, tranches: PROFILES[lower as keyof typeof PROFILES] };
  }
  // Try parsing as custom
  return { name: "custom", tranches: parseTranches(profileOrCustom) };
}

// ─── State management ───

const exitStrategies = new Map<string, ExitStrategyState>();

export function getExitStrategies(): ExitStrategyState[] {
  return Array.from(exitStrategies.values());
}

export function getExitStrategy(auctionAddress: string): ExitStrategyState | undefined {
  return exitStrategies.get(auctionAddress);
}

export function cancelExitStrategy(auctionAddress: string): boolean {
  const s = exitStrategies.get(auctionAddress);
  if (s && s.status === "running") {
    s.status = "cancelled";
    addLog(s, "Exit strategy cancelled", "info");
    markDirty();
    return true;
  }
  return false;
}

/** Restore exit strategies from persisted state */
export function setExitStrategies(states: ExitStrategyState[]): void {
  for (const s of states) {
    exitStrategies.set(s.auctionAddress, s);
  }
}

/** Resume polling for strategies that were running when server stopped */
export function resumeExitStrategies(): void {
  for (const state of exitStrategies.values()) {
    if (state.status === "running") {
      console.log(`[exit:${state.auctionAddress.slice(0, 8)}] Resuming exit strategy`);
      pollAndExecute(state).catch((err: any) => {
        if (state.status === "running") {
          state.status = "failed";
          addLog(state, `Exit strategy failed on resume: ${err.message}`, "error");
          markDirty();
        }
      });
    }
  }
}

// Register persistence collector
registerCollector(() => ({
  section: "Exit Strategies",
  data: Array.from(exitStrategies.values()),
}));

function addLog(
  state: ExitStrategyState,
  message: string,
  type: "info" | "sell" | "error"
) {
  state.log.push({ time: Date.now(), message, type });
  if (state.log.length > 50) state.log.shift();
  console.log(`[exit:${state.auctionAddress.slice(0, 8)}] ${message}`);
}

// ─── Core engine ───

export interface RunExitParams {
  auctionAddress: string;
  tokenAddress: Address;
  tokenDecimals?: number;
  totalSupply: bigint;
  entryFdv: number;
  tokenBalance: bigint;
  profileOrCustom: string;
  uniswapFee?: number;
  stopLossMultiple?: number;
}

export async function runExitStrategy(params: RunExitParams): Promise<void> {
  const {
    auctionAddress,
    tokenAddress,
    tokenDecimals = 18,
    totalSupply,
    entryFdv,
    tokenBalance,
    profileOrCustom,
    uniswapFee = 3000,
    stopLossMultiple,
  } = params;

  const { name, tranches } = resolveTranches(profileOrCustom);

  const state: ExitStrategyState = {
    auctionAddress,
    tokenAddress,
    tokenDecimals,
    totalSupply: totalSupply.toString(),
    entryFdv,
    initialBalance: tokenBalance.toString(),
    currentBalance: tokenBalance.toString(),
    currentFdv: 0,
    currentMultiple: 0,
    profileName: name,
    tranches: tranches.map((t) => ({ ...t, status: "pending" as const })),
    totalUsdcRealized: 0,
    status: "running",
    log: [],
    uniswapFee,
    stopLossMultiple,
  };

  exitStrategies.set(auctionAddress, state);
  markDirty();

  const trancheDesc = tranches.map((t) => `${t.pctToSell}%@${t.targetMultiple}x`).join(", ");
  addLog(state, `Exit strategy started: ${name} [${trancheDesc}]${stopLossMultiple ? ` | stop-loss: ${stopLossMultiple}x` : ""}`, "info");
  addLog(state, `Entry FDV: $${entryFdv.toLocaleString()} | Balance: ${formatTokenBalance(tokenBalance, tokenDecimals)} tokens`, "info");

  try {
    await pollAndExecute(state);
  } catch (err: any) {
    if (state.status === "running") {
      state.status = "failed";
      addLog(state, `Exit strategy failed: ${err.message}`, "error");
      markDirty();
    }
  }
}

async function pollAndExecute(state: ExitStrategyState): Promise<void> {
  await new Promise<void>((resolve) => {
    const interval = setInterval(async () => {
      if (state.status !== "running") {
        clearInterval(interval);
        resolve();
        return;
      }

      try {
        // Get current token price and compute FDV
        const price = await getTokenPrice(
          state.tokenAddress,
          state.tokenDecimals,
          state.uniswapFee
        );
        const supplyHuman = Number(BigInt(state.totalSupply)) / 10 ** state.tokenDecimals;
        state.currentFdv = price * supplyHuman;
        state.currentMultiple = state.entryFdv > 0 ? state.currentFdv / state.entryFdv : 0;

        // Refresh on-chain balance
        const publicClient = getPublicClient();
        const account = getAccount();
        const onChainBalance = await publicClient.readContract({
          address: state.tokenAddress,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
        });
        state.currentBalance = onChainBalance.toString();

        // Check stop-loss
        if (
          state.stopLossMultiple != null &&
          state.currentMultiple > 0 &&
          state.currentMultiple < state.stopLossMultiple &&
          BigInt(state.currentBalance) > 0n
        ) {
          addLog(
            state,
            `STOP-LOSS triggered at ${state.currentMultiple.toFixed(2)}x (threshold: ${state.stopLossMultiple}x) — selling 100%`,
            "sell"
          );
          try {
            const sellAmount = BigInt(state.currentBalance);
            const { hash, amountOut } = await swapExactInputSingle(
              state.tokenAddress,
              USDC_BASE,
              sellAmount,
              state.uniswapFee
            );
            const usdcReceived = Number(amountOut) / 1e6;
            state.totalUsdcRealized += usdcReceived;
            state.currentBalance = "0";
            // Mark all pending tranches as skipped
            for (const t of state.tranches) {
              if (t.status === "pending") t.status = "skipped";
            }
            addLog(state, `Stop-loss sold all for $${usdcReceived.toFixed(2)} USDC (tx: ${hash.slice(0, 10)}...)`, "sell");
          } catch (err: any) {
            addLog(state, `Stop-loss sell failed: ${err.message}`, "error");
          }
          state.status = "stopped";
          markDirty();
          clearInterval(interval);
          resolve();
          return;
        }

        // Check each pending tranche
        for (const tranche of state.tranches) {
          if (tranche.status !== "pending") continue;
          if (state.currentMultiple < tranche.targetMultiple) continue;

          // Tranche triggered!
          const currentBalance = BigInt(state.currentBalance);
          if (currentBalance === 0n) {
            tranche.status = "skipped";
            addLog(state, `Tranche ${tranche.targetMultiple}x skipped — no balance`, "info");
            continue;
          }

          const sellAmount = (currentBalance * BigInt(tranche.pctToSell)) / 100n;
          if (sellAmount === 0n) {
            tranche.status = "skipped";
            addLog(state, `Tranche ${tranche.targetMultiple}x skipped — amount too small`, "info");
            continue;
          }

          addLog(
            state,
            `Tranche ${tranche.targetMultiple}x triggered! Selling ${tranche.pctToSell}% (${formatTokenBalance(sellAmount, state.tokenDecimals)} tokens) at ${state.currentMultiple.toFixed(1)}x`,
            "sell"
          );

          try {
            const { hash, amountOut } = await swapExactInputSingle(
              state.tokenAddress,
              USDC_BASE,
              sellAmount,
              state.uniswapFee
            );

            const usdcReceived = Number(amountOut) / 1e6;
            tranche.status = "executed";
            tranche.executedAt = Date.now();
            tranche.txHash = hash;
            tranche.amountSold = formatTokenBalance(sellAmount, state.tokenDecimals);
            tranche.usdcReceived = usdcReceived.toFixed(2);
            state.totalUsdcRealized += usdcReceived;

            // Refresh balance after sell
            const newBalance = await publicClient.readContract({
              address: state.tokenAddress,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [account.address],
            });
            state.currentBalance = newBalance.toString();

            addLog(
              state,
              `Sold ${tranche.amountSold} tokens for $${usdcReceived.toFixed(2)} USDC`,
              "sell"
            );
            markDirty();
          } catch (err: any) {
            addLog(state, `Tranche ${tranche.targetMultiple}x sell failed: ${err.message}`, "error");
            // Don't mark as executed — will retry next poll
          }
        }

        // Check if all tranches are done
        const allDone = state.tranches.every((t) => t.status !== "pending");
        if (allDone) {
          state.status = "done";
          addLog(
            state,
            `All tranches complete. Total realized: $${state.totalUsdcRealized.toFixed(2)} USDC`,
            "info"
          );
          markDirty();
        }
      } catch (err: any) {
        addLog(state, `Poll error: ${err.message}`, "error");
      }
    }, POLL_INTERVAL_MS);
  });
}

function formatTokenBalance(amount: bigint, decimals: number): string {
  const whole = amount / 10n ** BigInt(decimals);
  const frac = amount % 10n ** BigInt(decimals);
  const fracStr = frac.toString().padStart(decimals, "0").slice(0, 4);
  return `${whole}.${fracStr}`;
}
