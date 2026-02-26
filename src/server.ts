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
} from "./api.js";
import { submitBid } from "./bid.js";
import { scheduleBid } from "./scheduler.js";
import { runStrategy, getStrategies, getStrategy, cancelStrategy } from "./strategy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
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

// GET /api/agent — current agent state
app.get("/api/agent", (_req, res) => {
  res.json(agent);
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
    const { auctionAddress, minFdvUsd, maxFdvUsd, amount } = req.body;
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

    res.json({ status: "started", auctionAddress, minFdvUsd, maxFdvUsd, amount });
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

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, () => {
  console.log(`terminal.flow.bid running on http://localhost:${PORT}`);
});
