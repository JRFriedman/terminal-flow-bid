import { formatEther, formatUnits, erc20Abi } from "viem";
import { getPublicClient, getAccount, USDC_BASE } from "./config.js";
import { getAuction, getCurrentBlock } from "./api.js";
import { getStrategies, type StrategyState } from "./strategy.js";
import { sendTelegramMessage } from "./notify.js";
import { markDirty, registerCollector } from "./persistence.js";

const POLL_INTERVAL_MS = 10_000;

// Alert stages: blocks before auction start
const ALERT_STAGES = [
  { name: "15min", blocks: 450 },
  { name: "5min", blocks: 150 },
  { name: "1min", blocks: 30 },
] as const;

type StageName = (typeof ALERT_STAGES)[number]["name"];

export interface ReadinessAlert {
  auctionAddress: string;
  stage: StageName;
  timestamp: number;
  checks: {
    usdc: { ok: boolean; balance: number; needed: number };
    eth: { ok: boolean; balance: number };
    config: { ok: boolean; description: string };
  };
  dismissed: boolean;
}

// Track which (auction, stage) pairs have already fired
const alertedStages = new Map<string, Set<StageName>>();

// Active alerts for UI consumption
const activeAlerts: ReadinessAlert[] = [];

function alertKey(auction: string, stage: StageName): string {
  return `${auction}:${stage}`;
}

function hasAlerted(auction: string, stage: StageName): boolean {
  return alertedStages.get(auction)?.has(stage) ?? false;
}

function markAlerted(auction: string, stage: StageName): void {
  if (!alertedStages.has(auction)) {
    alertedStages.set(auction, new Set());
  }
  alertedStages.get(auction)!.add(stage);
  markDirty();
}

/** Restore alerted stages from persisted state */
export function setAlertedStages(
  data: Array<{ auction: string; stages: StageName[] }>
): void {
  for (const { auction, stages } of data) {
    alertedStages.set(auction, new Set(stages));
  }
}

export function getAlertedStagesData(): Array<{
  auction: string;
  stages: StageName[];
}> {
  const result: Array<{ auction: string; stages: StageName[] }> = [];
  for (const [auction, stages] of alertedStages) {
    result.push({ auction, stages: Array.from(stages) });
  }
  return result;
}

export function getActiveAlerts(): ReadinessAlert[] {
  return activeAlerts.filter((a) => !a.dismissed);
}

export function dismissAlert(auctionAddress: string, stage: StageName): void {
  const alert = activeAlerts.find(
    (a) => a.auctionAddress === auctionAddress && a.stage === stage
  );
  if (alert) alert.dismissed = true;
}

// Register persistence collector
registerCollector(() => ({
  section: "Readiness Alerts",
  data: getAlertedStagesData(),
}));

interface AgentStateSnapshot {
  watching: string[];
  armedBids: Array<{
    auctionAddress: string;
    maxFdvUsd: number;
    amount: number;
  }>;
}

/**
 * Start the readiness monitor background loop.
 */
export function startReadinessMonitor(
  getAgentState: () => AgentStateSnapshot
): void {
  console.log("[readiness] Started");

  setInterval(async () => {
    try {
      await checkReadiness(getAgentState);
    } catch (err: any) {
      console.error("[readiness] Error:", err.message);
    }
  }, POLL_INTERVAL_MS);
}

async function checkReadiness(
  getAgentState: () => AgentStateSnapshot
): Promise<void> {
  const agent = getAgentState();
  const watching = agent.watching;
  if (watching.length === 0) return;

  let currentBlock: number;
  try {
    const block = await getCurrentBlock();
    currentBlock = block.blockNumber;
  } catch {
    return;
  }

  for (const auctionAddr of watching) {
    let startBlock: number;
    try {
      const auction = await getAuction(auctionAddr);
      startBlock = parseInt(String(auction.startBlock));
      if (!startBlock) continue;
    } catch {
      continue;
    }

    // Only care about auctions that haven't started yet
    if (currentBlock >= startBlock) continue;

    const blocksUntilStart = startBlock - currentBlock;

    for (const stage of ALERT_STAGES) {
      // Check if we've crossed the threshold (blocks remaining <= stage threshold)
      if (blocksUntilStart > stage.blocks) continue;
      if (hasAlerted(auctionAddr, stage.name)) continue;

      // Run checklist
      const checks = await runChecklist(auctionAddr, agent);

      // Build alert
      const alert: ReadinessAlert = {
        auctionAddress: auctionAddr,
        stage: stage.name,
        timestamp: Date.now(),
        checks,
        dismissed: false,
      };
      activeAlerts.push(alert);
      markAlerted(auctionAddr, stage.name);

      // Send Telegram notification
      const message = formatTelegramMessage(alert, blocksUntilStart);
      await sendTelegramMessage(message);

      console.log(
        `[readiness] Alert sent: ${auctionAddr.slice(0, 10)} @ ${stage.name}`
      );
    }
  }
}

async function runChecklist(
  auctionAddr: string,
  agent: AgentStateSnapshot
): Promise<ReadinessAlert["checks"]> {
  const publicClient = getPublicClient();
  const account = getAccount();

  // Fetch balances
  let ethBalance = 0;
  let usdcBalance = 0;
  try {
    const [ethRaw, usdcRaw] = await Promise.all([
      publicClient.getBalance({ address: account.address }),
      publicClient.readContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      }),
    ]);
    ethBalance = parseFloat(formatEther(ethRaw));
    usdcBalance = parseFloat(formatUnits(usdcRaw, 6));
  } catch (err: any) {
    console.error("[readiness] Balance fetch failed:", err.message);
  }

  // Determine needed USDC from armed bids or strategies
  let neededUsdc = 0;
  let configDescription = "";

  const armedBid = agent.armedBids.find(
    (b) => b.auctionAddress === auctionAddr
  );
  const strategy = getStrategies().find(
    (s) =>
      s.auctionAddress === auctionAddr &&
      (s.status === "waiting" || s.status === "watching" || s.status === "bidding")
  );

  if (strategy) {
    neededUsdc = strategy.amount;
    configDescription = `${strategy.amount} USDC @ $${fmtK(strategy.currentFdv)} FDV`;
    if (strategy.exitProfile)
      configDescription += ` | exit: ${strategy.exitProfile}`;
  } else if (armedBid) {
    neededUsdc = armedBid.amount;
    configDescription = `${armedBid.amount} USDC @ $${fmtK(armedBid.maxFdvUsd)} FDV`;
  }

  const configOk = !!(strategy || armedBid);

  return {
    usdc: {
      ok: usdcBalance >= neededUsdc,
      balance: usdcBalance,
      needed: neededUsdc,
    },
    eth: { ok: ethBalance > 0.002, balance: ethBalance },
    config: {
      ok: configOk,
      description: configOk ? configDescription : "No bid or strategy configured",
    },
  };
}

function fmtK(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return n.toFixed(0);
}

function formatTelegramMessage(
  alert: ReadinessAlert,
  blocksLeft: number
): string {
  const { checks, stage } = alert;
  const timeLabel =
    stage === "15min" ? "~15min" : stage === "5min" ? "~5min" : "~1min";

  const usdcIcon = checks.usdc.ok ? "\u2705" : "\u274C";
  const ethIcon = checks.eth.ok ? "\u2705" : "\u274C";
  const configIcon = checks.config.ok ? "\u2705" : "\u274C";

  const allGood = checks.usdc.ok && checks.eth.ok && checks.config.ok;
  const footer = allGood ? "*Ready to go.*" : "*\u26A0\uFE0F Action needed.*";

  let msg = `\u26A0\uFE0F *KLARA* \u2014 Auction in ${timeLabel}\n\n`;
  msg += `${usdcIcon} USDC: $${checks.usdc.balance.toFixed(2)} (need $${checks.usdc.needed.toFixed(2)})\n`;
  msg += `${ethIcon} ETH: ${checks.eth.balance.toFixed(4)} (gas)\n`;
  msg += `${configIcon} ${checks.config.description}\n\n`;
  msg += footer;

  return msg;
}
