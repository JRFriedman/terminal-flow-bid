import { type Address, erc20Abi } from "viem";
import { getPublicClient, getAccount } from "./config.js";
import { getAuction, getLaunches, type Launch } from "./api.js";
import { getStrategies, type StrategyState } from "./strategy.js";
import {
  runExitStrategy,
  getExitStrategy,
  type ExitProfileName,
} from "./exit-strategy.js";

const POLL_INTERVAL_MS = 60_000; // Check every 60 seconds

// Track which auctions we've already processed
const processedGraduations = new Set<string>();

/**
 * Start the graduation monitor background loop.
 * Watches auctions that have active/completed bid strategies and detects graduation.
 */
export function startGraduationMonitor(): void {
  console.log("[graduation-monitor] Started");

  setInterval(async () => {
    try {
      await checkGraduations();
    } catch (err: any) {
      console.error("[graduation-monitor] Error:", err.message);
    }
  }, POLL_INTERVAL_MS);
}

async function checkGraduations(): Promise<void> {
  // Get strategies that have an exit profile configured
  const strategies = getStrategies();
  const withExit = strategies.filter(
    (s) => (s as any).exitProfile && !processedGraduations.has(s.auctionAddress)
  );

  if (withExit.length === 0) return;

  // Fetch all launches to check graduation status
  let launches: Launch[];
  try {
    launches = await getLaunches();
  } catch {
    return; // Transient error, try again next poll
  }

  for (const strategy of withExit) {
    const launch = launches.find((l) => l.auction === strategy.auctionAddress);
    if (!launch) continue;
    if (!launch.isGraduated) continue;

    // Already have an exit strategy running?
    if (getExitStrategy(strategy.auctionAddress)) {
      processedGraduations.add(strategy.auctionAddress);
      continue;
    }

    console.log(
      `[graduation-monitor] ${launch.tokenSymbol} graduated! Starting exit strategy...`
    );
    processedGraduations.add(strategy.auctionAddress);

    try {
      await startExitFromGraduation(strategy, launch);
    } catch (err: any) {
      console.error(
        `[graduation-monitor] Failed to start exit for ${launch.tokenSymbol}: ${err.message}`
      );
    }
  }
}

async function startExitFromGraduation(
  strategy: StrategyState,
  launch: Launch
): Promise<void> {
  const publicClient = getPublicClient();
  const account = getAccount();

  const tokenAddress = launch.token as Address;
  const tokenDecimals = parseInt(String((launch as any).tokenDecimals || "18"));
  const totalSupply = BigInt((launch as any).totalSupply || "0");

  // Get our token balance
  const tokenBalance = await publicClient.readContract({
    address: tokenAddress,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });

  if (tokenBalance === 0n) {
    console.log(
      `[graduation-monitor] No ${launch.tokenSymbol} tokens in wallet, skipping exit`
    );
    return;
  }

  // Compute entry FDV from clearing price
  const entryFdv = computeEntryFdv(launch);
  if (entryFdv <= 0) {
    console.error("[graduation-monitor] Could not compute entry FDV");
    return;
  }

  const exitProfile = (strategy as any).exitProfile as string;

  // Run exit strategy in background
  runExitStrategy({
    auctionAddress: strategy.auctionAddress,
    tokenAddress,
    tokenDecimals,
    totalSupply,
    entryFdv,
    tokenBalance,
    profileOrCustom: exitProfile,
  }).catch((err) => {
    console.error(
      `[graduation-monitor] Exit strategy error for ${launch.tokenSymbol}: ${err.message}`
    );
  });
}

/**
 * Compute entry FDV from the auction's clearing price using the same
 * q96ToFdv logic from strategy.ts.
 */
function computeEntryFdv(launch: Launch): number {
  const info = launch as any;
  const clearingQ96 = parseFloat(info.clearingPrice || "0");
  const floorPrice = parseFloat(info.floorPrice || "0");
  if (clearingQ96 <= 0 || floorPrice <= 0) return 0;

  const requiredRaised = parseFloat(info.requiredCurrencyRaised || "0");
  const auctionAmount = parseFloat(info.auctionAmount || "0");
  const totalSupply = parseFloat(info.totalSupply || "0");
  const tokenDecimals = parseInt(info.tokenDecimals || "18");
  const currencyDecimals = 6;

  if (auctionAmount <= 0 || totalSupply <= 0 || requiredRaised <= 0) return 0;

  const requiredRaisedHuman = requiredRaised / 10 ** currencyDecimals;
  const auctionAmountHuman = auctionAmount / 10 ** tokenDecimals;
  const totalSupplyHuman = totalSupply / 10 ** tokenDecimals;

  const floorFdv = (requiredRaisedHuman / auctionAmountHuman) * totalSupplyHuman;
  return clearingQ96 * (floorFdv / floorPrice);
}
