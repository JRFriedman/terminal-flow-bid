process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("[FATAL] Unhandled rejection:", err);
});

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { formatEther, formatUnits, erc20Abi } from "viem";
import { getPublicClient, getAccount, USDC_BASE } from "./config.js";
import {
  getAuction,
  getSafety,
  getAuctionBids,
  getCurrentBlock,
  getUserBids,
  getLaunches,
  buildLaunchTx,
  buildClaimTx,
} from "./api.js";
import { submitBid } from "./bid.js";
import { scheduleBid } from "./scheduler.js";
import { runStrategy, getStrategies, getStrategy, cancelStrategy } from "./strategy.js";
import {
  runExitStrategy,
  getExitStrategies,
  getExitStrategy,
  cancelExitStrategy,
  resolveTranches,
} from "./exit-strategy.js";
import { getTokenPrice } from "./swap.js";
import { startGraduationMonitor, setProcessedGraduations } from "./graduation-monitor.js";
import { startReadinessMonitor, getActiveAlerts, dismissAlert, setAlertedStages } from "./readiness.js";
import { startTelegramBot } from "./telegram-bot.js";
import { loadState, markDirty, registerCollector } from "./persistence.js";
import { setExitStrategies, resumeExitStrategies } from "./exit-strategy.js";
import { setStrategies } from "./strategy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());

// ─── Auth middleware ───
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

if (AUTH_TOKEN) {
  app.use("/api", (req, res, next) => {
    // Allow requests from localhost without auth (telegram bot, internal)
    const ip = req.ip || req.socket.remoteAddress || "";
    if (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") {
      return next();
    }
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (token !== AUTH_TOKEN) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });
  console.log("[auth] API protected with AUTH_TOKEN");
} else {
  console.log("[auth] No AUTH_TOKEN set — API is open (local-only)");
}

app.use(express.static(path.join(__dirname, "..", "public")));

// ─── Agent state ───
interface ArmedBid {
  auctionAddress: string;
  maxFdvUsd: number;
  amount: number;
}

interface AgentState {
  watching: string[];
  status: "idle" | "watching" | "armed" | "bidding";
  armedBids: ArmedBid[];
  lastResult: {
    type: "success" | "error";
    message: string;
    txHashes?: string[];
    timestamp: number;
  } | null;
}

const agent: AgentState = {
  watching: [],
  status: "idle",
  armedBids: [],
  lastResult: null,
};

// Register agent state for persistence
registerCollector(() => ({
  section: "Agent",
  data: {
    watching: agent.watching,
    status: agent.status,
    armedBids: agent.armedBids,
  },
}));

// GET /api/agent — current agent state
app.get("/api/agent", (_req, res) => {
  res.json({ ...agent, readinessAlerts: getActiveAlerts() });
});

// POST /api/agent/watch — add auction to watch list
app.post("/api/agent/watch", (req, res) => {
  const { auctionAddress } = req.body;
  if (!auctionAddress) {
    res.status(400).json({ error: "Missing auctionAddress" });
    return;
  }
  if (!agent.watching.includes(auctionAddress)) {
    agent.watching.push(auctionAddress);
  }
  if (agent.status === "idle") agent.status = "watching";
  markDirty();
  res.json(agent);
});

// POST /api/agent/unwatch — remove auction (or all) from watch list
app.post("/api/agent/unwatch", (req, res) => {
  const { auctionAddress } = req.body || {};
  if (auctionAddress) {
    agent.watching = agent.watching.filter((a) => a !== auctionAddress);
  } else {
    agent.watching = [];
  }
  if (auctionAddress) {
    agent.armedBids = agent.armedBids.filter((b) => b.auctionAddress !== auctionAddress);
  }
  if (agent.watching.length === 0) {
    agent.armedBids = [];
    agent.status = "idle";
  }
  markDirty();
  res.json(agent);
});

// POST /api/agent/disarm — remove armed bid without unwatching
app.post("/api/agent/disarm", (req, res) => {
  const { auctionAddress } = req.body || {};
  if (auctionAddress) {
    agent.armedBids = agent.armedBids.filter((b) => b.auctionAddress !== auctionAddress);
  } else {
    agent.armedBids = [];
  }
  if (agent.armedBids.length === 0 && agent.status === "armed") {
    agent.status = agent.watching.length > 0 ? "watching" : "idle";
  }
  markDirty();
  res.json(agent);
});

// ─── Wallet ───
app.get("/api/wallet", async (_req, res) => {
  try {
    const account = getAccount();
    const client = getPublicClient();

    const [ethBalance, usdcBalance] = await Promise.all([
      client.getBalance({ address: account.address }),
      client.readContract({
        address: USDC_BASE,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [account.address],
      }),
    ]);

    res.json({
      address: account.address,
      ethBalance: formatEther(ethBalance),
      usdcBalance: formatUnits(usdcBalance, 6),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Launches ───
app.get("/api/launches", async (_req, res) => {
  try {
    const launches = await getLaunches();
    res.json(launches);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Auction data ───
app.get("/api/auction/:addr", async (req, res) => {
  try {
    const data = await getAuction(req.params.addr);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/auction/:addr/safety", async (req, res) => {
  try {
    const data = await getSafety(req.params.addr);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/auction/:addr/bids", async (req, res) => {
  try {
    const data = await getAuctionBids(req.params.addr);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/block", async (_req, res) => {
  try {
    const data = await getCurrentBlock();
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/bids", async (_req, res) => {
  try {
    const account = getAccount();
    const data = await getUserBids(account.address);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Bid actions ───
app.post("/api/bid", async (req, res) => {
  try {
    const { auctionAddress, maxFdvUsd, amount } = req.body;
    if (!auctionAddress || !maxFdvUsd || !amount) {
      res.status(400).json({ error: "Missing auctionAddress, maxFdvUsd, or amount" });
      return;
    }
    const account = getAccount();
    agent.status = "bidding";
    const result = await submitBid({
      bidder: account.address,
      auctionAddress,
      maxFdvUsd: Number(maxFdvUsd),
      amount: Number(amount),
    });
    agent.lastResult = {
      type: "success",
      message: `Bid confirmed: ${amount} USDC @ $${maxFdvUsd} FDV`,
      txHashes: result.txHashes,
      timestamp: Date.now(),
    };
    agent.status = agent.watching.length > 0 ? "watching" : "idle";
    res.json(result);
  } catch (err: any) {
    agent.lastResult = {
      type: "error",
      message: err.message,
      timestamp: Date.now(),
    };
    agent.status = agent.watching.length > 0 ? "watching" : "idle";
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/bid/schedule", async (req, res) => {
  try {
    const { auctionAddress, maxFdvUsd, amount } = req.body;
    if (!auctionAddress || !maxFdvUsd || !amount) {
      res.status(400).json({ error: "Missing auctionAddress, maxFdvUsd, or amount" });
      return;
    }
    const account = getAccount();
    const armed: ArmedBid = { auctionAddress, maxFdvUsd: Number(maxFdvUsd), amount: Number(amount) };
    // Replace if already armed for this auction, otherwise add
    agent.armedBids = agent.armedBids.filter((b) => b.auctionAddress !== auctionAddress);
    agent.armedBids.push(armed);
    agent.status = "armed";

    scheduleBid({
      bidder: account.address,
      auctionAddress,
      maxFdvUsd: Number(maxFdvUsd),
      amount: Number(amount),
    })
      .then(() => {
        agent.lastResult = {
          type: "success",
          message: `Scheduled bid executed: ${amount} USDC @ $${maxFdvUsd} FDV`,
          timestamp: Date.now(),
        };
        agent.armedBids = agent.armedBids.filter((b) => b.auctionAddress !== auctionAddress);
        agent.status = agent.armedBids.length > 0 ? "armed" : agent.watching.length > 0 ? "watching" : "idle";
      })
      .catch((err) => {
        console.error("Scheduled bid error:", err);
        agent.lastResult = {
          type: "error",
          message: err.message,
          timestamp: Date.now(),
        };
        agent.armedBids = agent.armedBids.filter((b) => b.auctionAddress !== auctionAddress);
        agent.status = agent.armedBids.length > 0 ? "armed" : agent.watching.length > 0 ? "watching" : "idle";
      });

    res.json({ status: "armed", auctionAddress, maxFdvUsd, amount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Launch ───
app.post("/api/launch", async (req, res) => {
  try {
    const { name, symbol, metadata } = req.body;
    if (!name || !symbol) {
      res.status(400).json({ error: "Missing name or symbol" });
      return;
    }
    const account = getAccount();
    const publicClient = getPublicClient();
    const walletClient = (await import("./config.js")).getWalletClient();

    // Build the launch transaction
    const result = await buildLaunchTx({
      deployer: account.address,
      name,
      symbol,
      metadata: metadata || undefined,
    });

    console.log(`[launch] Deploying ${name} (${symbol})`);
    console.log(`  Predicted token: ${result.predictedTokenAddress}`);
    console.log(`  Start block: ${result.auctionTiming.startBlock} (~${Math.round((parseInt(result.auctionTiming.startBlock) - parseInt(result.auctionTiming.currentBlock)) * 2 / 60)}min)`);

    // Send the transaction
    const hash = await walletClient.sendTransaction({
      to: result.to as `0x${string}`,
      data: result.data as `0x${string}`,
      value: result.value ? BigInt(result.value) : 0n,
      account,
      chain: walletClient.chain,
      gas: 2_000_000n,
    });

    console.log(`  TX hash: ${hash}`);

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") {
      throw new Error(`Launch transaction reverted: ${hash}`);
    }

    console.log(`  Confirmed in block ${receipt.blockNumber}`);

    // Auto-watch the new auction
    const auctionAddr = result.predictedAuctionAddress || result.predictedTokenAddress;
    if (auctionAddr && !agent.watching.includes(auctionAddr)) {
      agent.watching.push(auctionAddr);
      agent.status = "watching";
      markDirty();
    }

    agent.lastResult = {
      type: "success",
      message: `Launched ${name} (${symbol})`,
      txHashes: [hash],
      timestamp: Date.now(),
    };

    res.json({
      status: "launched",
      txHash: hash,
      tokenAddress: result.predictedTokenAddress,
      auctionTiming: result.auctionTiming,
    });
  } catch (err: any) {
    agent.lastResult = {
      type: "error",
      message: err.message,
      timestamp: Date.now(),
    };
    res.status(500).json({ error: err.message });
  }
});

// ─── Strategy ───
app.get("/api/strategies", (_req, res) => {
  res.json(getStrategies());
});

app.get("/api/strategy/:addr", (req, res) => {
  const s = getStrategy(req.params.addr);
  if (!s) {
    res.status(404).json({ error: "No strategy for this auction" });
    return;
  }
  res.json(s);
});

app.post("/api/strategy", async (req, res) => {
  try {
    const { auctionAddress, minFdvUsd, maxFdvUsd, amount, exitProfile, stopLoss } = req.body;
    if (!auctionAddress || !minFdvUsd || !maxFdvUsd || !amount) {
      res.status(400).json({ error: "Missing auctionAddress, minFdvUsd, maxFdvUsd, or amount" });
      return;
    }
    const account = getAccount();

    // Add to watch list if not already
    if (!agent.watching.includes(auctionAddress)) {
      agent.watching.push(auctionAddress);
    }
    agent.status = "armed";

    // Run strategy in background
    runStrategy({
      bidder: account.address,
      auctionAddress,
      minFdvUsd: Number(minFdvUsd),
      maxFdvUsd: Number(maxFdvUsd),
      amount: Number(amount),
      exitProfile: exitProfile || undefined,
      stopLoss: stopLoss != null ? Number(stopLoss) : undefined,
    })
      .then(() => {
        agent.lastResult = {
          type: "success",
          message: `Strategy completed for ${auctionAddress.slice(0, 10)}`,
          timestamp: Date.now(),
        };
        agent.status = agent.watching.length > 0 ? "watching" : "idle";
      })
      .catch((err) => {
        agent.lastResult = {
          type: "error",
          message: err.message,
          timestamp: Date.now(),
        };
        agent.status = agent.watching.length > 0 ? "watching" : "idle";
      });

    res.json({ status: "started", auctionAddress, minFdvUsd, maxFdvUsd, amount, exitProfile });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/strategy/:addr/cancel", (req, res) => {
  const cancelled = cancelStrategy(req.params.addr);
  if (!cancelled) {
    res.status(404).json({ error: "No active strategy for this auction" });
    return;
  }
  res.json({ status: "cancelled" });
});

// ─── Exit Strategies ───
app.get("/api/exit-strategies", (_req, res) => {
  res.json(getExitStrategies());
});

app.get("/api/exit-strategy/:addr", (req, res) => {
  const s = getExitStrategy(req.params.addr);
  if (!s) {
    res.status(404).json({ error: "No exit strategy for this auction" });
    return;
  }
  res.json(s);
});

app.post("/api/exit-strategy", async (req, res) => {
  try {
    const { auctionAddress, profileOrCustom, stopLoss } = req.body;
    if (!auctionAddress) {
      res.status(400).json({ error: "Missing auctionAddress" });
      return;
    }
    const profile = profileOrCustom || "moderate";
    const stopLossMultiple = stopLoss != null ? Number(stopLoss) : undefined;

    // Validate profile
    try {
      resolveTranches(profile);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }

    // Look up auction info
    const auction = await getAuction(auctionAddress);
    const launches = await getLaunches();
    const launch = launches.find((l) => l.auction === auctionAddress);
    if (!launch) {
      res.status(404).json({ error: "Auction not found in launches" });
      return;
    }

    const tokenAddress = launch.token as `0x${string}`;
    const tokenDecimals = parseInt(String((launch as any).tokenDecimals || "18"));
    const totalSupply = BigInt((launch as any).totalSupply || "0");

    // Get token balance
    const publicClient = getPublicClient();
    const account = getAccount();
    const tokenBalance = await publicClient.readContract({
      address: tokenAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });

    if (tokenBalance === 0n) {
      res.status(400).json({ error: "No token balance in wallet" });
      return;
    }

    // Compute entry FDV from clearing price
    const info = launch as any;
    const clearingQ96 = parseFloat(info.clearingPrice || "0");
    const floorPrice = parseFloat(info.floorPrice || "0");
    let entryFdv = 0;
    if (clearingQ96 > 0 && floorPrice > 0) {
      const requiredRaised = parseFloat(info.requiredCurrencyRaised || "0");
      const auctionAmount = parseFloat(info.auctionAmount || "0");
      const ts = parseFloat(info.totalSupply || "0");
      if (auctionAmount > 0 && ts > 0 && requiredRaised > 0) {
        const reqHuman = requiredRaised / 1e6;
        const aucHuman = auctionAmount / 10 ** tokenDecimals;
        const supHuman = ts / 10 ** tokenDecimals;
        const floorFdv = (reqHuman / aucHuman) * supHuman;
        entryFdv = clearingQ96 * (floorFdv / floorPrice);
      }
    }

    if (entryFdv <= 0) {
      res.status(400).json({ error: "Could not compute entry FDV from clearing price" });
      return;
    }

    // Start in background
    runExitStrategy({
      auctionAddress,
      tokenAddress,
      tokenDecimals,
      totalSupply,
      entryFdv,
      tokenBalance,
      profileOrCustom: profile,
      stopLossMultiple,
    }).catch((err) => {
      console.error("Exit strategy error:", err.message);
    });

    res.json({
      status: "started",
      auctionAddress,
      profile,
      entryFdv: Math.round(entryFdv),
      tokenBalance: tokenBalance.toString(),
      stopLoss: stopLossMultiple,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/exit-strategy/:addr/cancel", (req, res) => {
  const cancelled = cancelExitStrategy(req.params.addr);
  if (!cancelled) {
    res.status(404).json({ error: "No active exit strategy for this auction" });
    return;
  }
  res.json({ status: "cancelled" });
});

// ─── Claims ───
app.post("/api/claim", async (req, res) => {
  try {
    const { auctionAddress, bidId } = req.body;
    if (!auctionAddress) {
      res.status(400).json({ error: "Missing auctionAddress" });
      return;
    }
    const account = getAccount();
    const publicClient = getPublicClient();
    const walletClient = (await import("./config.js")).getWalletClient();

    const result = await buildClaimTx({
      auctionAddress,
      claimer: account.address,
      bidId: bidId || "0",
    });

    console.log(`[claim] ${result.transaction.description}`);

    const hash = await walletClient.sendTransaction({
      to: result.transaction.to as `0x${string}`,
      data: result.transaction.data as `0x${string}`,
      value: result.transaction.value ? BigInt(result.transaction.value) : 0n,
      account,
      chain: walletClient.chain,
      gas: 1_000_000n,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "reverted") {
      throw new Error(`Claim transaction reverted: ${hash}`);
    }

    res.json({
      status: "claimed",
      txHash: hash,
      method: result.params.claimMethod,
      graduated: result.params.isGraduated,
      note: result.note,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/claim-all", async (req, res) => {
  try {
    const account = getAccount();
    const publicClient = getPublicClient();
    const walletClient = (await import("./config.js")).getWalletClient();

    const userBids = await getUserBids(account.address);
    const claimable = (userBids as any[]).filter(
      (b) => !b.hasClaimedTokens && !b.hasExited && b.isFilled
    );

    if (claimable.length === 0) {
      res.json({ status: "nothing_to_claim", claimed: [] });
      return;
    }

    const claimed: Array<{ auction: string; txHash: string; method: string; note?: string }> = [];
    const errors: Array<{ auction: string; error: string }> = [];

    for (const bid of claimable) {
      try {
        const result = await buildClaimTx({
          auctionAddress: bid.auction,
          claimer: account.address,
          bidId: bid.bidId || "0",
        });

        console.log(`[claim-all] ${bid.auction}: ${result.transaction.description}`);

        const hash = await walletClient.sendTransaction({
          to: result.transaction.to as `0x${string}`,
          data: result.transaction.data as `0x${string}`,
          value: result.transaction.value ? BigInt(result.transaction.value) : 0n,
          account,
          chain: walletClient.chain,
          gas: 1_000_000n,
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === "reverted") {
          errors.push({ auction: bid.auction, error: `Reverted: ${hash}` });
          continue;
        }

        claimed.push({
          auction: bid.auction,
          txHash: hash,
          method: result.params.claimMethod,
          note: result.note,
        });
      } catch (err: any) {
        errors.push({ auction: bid.auction, error: err.message });
      }
    }

    res.json({ status: "done", claimed, errors });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Token price ───
app.get("/api/token/:addr/price", async (req, res) => {
  try {
    const price = await getTokenPrice(req.params.addr as `0x${string}`);
    res.json({ token: req.params.addr, priceUsd: price });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Readiness alerts ───
app.post("/api/readiness/dismiss", (req, res) => {
  const { auctionAddress, stage } = req.body;
  if (!auctionAddress || !stage) {
    res.status(400).json({ error: "Missing auctionAddress or stage" });
    return;
  }
  dismissAlert(auctionAddress, stage);
  res.json({ status: "dismissed" });
});

// ─── Boot: restore state and start ───
const PORT = Number(process.env.PORT) || 3000;

// Load persisted state before starting
const savedState = loadState();

if (savedState["Agent"]) {
  const a = savedState["Agent"] as any;
  if (Array.isArray(a.watching)) agent.watching = a.watching;
  if (a.status) agent.status = a.status;
  if (Array.isArray(a.armedBids)) agent.armedBids = a.armedBids;
  console.log(`[boot] Restored agent: watching ${agent.watching.length} auctions, status=${agent.status}`);
}

if (savedState["Bid Strategies"]) {
  const strats = savedState["Bid Strategies"] as any[];
  if (Array.isArray(strats)) {
    setStrategies(strats);
    console.log(`[boot] Restored ${strats.length} bid strategies`);
  }
}

if (savedState["Exit Strategies"]) {
  const exits = savedState["Exit Strategies"] as any[];
  if (Array.isArray(exits)) {
    setExitStrategies(exits);
    const running = exits.filter((e) => e.status === "running").length;
    console.log(`[boot] Restored ${exits.length} exit strategies (${running} running)`);
  }
}

if (savedState["Processed Graduations"]) {
  const grads = savedState["Processed Graduations"] as string[];
  if (Array.isArray(grads)) {
    setProcessedGraduations(grads);
    console.log(`[boot] Restored ${grads.length} processed graduations`);
  }
}

if (savedState["Readiness Alerts"]) {
  const alerts = savedState["Readiness Alerts"] as any[];
  if (Array.isArray(alerts)) {
    setAlertedStages(alerts);
    console.log(`[boot] Restored readiness alert stages for ${alerts.length} auctions`);
  }
}

const HOST = AUTH_TOKEN ? "0.0.0.0" : "127.0.0.1";
app.listen(PORT, HOST, () => {
  console.log(`terminal.flow.bid running on http://localhost:${PORT}`);
  startGraduationMonitor();
  startReadinessMonitor(() => agent);
  startTelegramBot();
  // Resume running exit strategies after load
  resumeExitStrategies();
});
