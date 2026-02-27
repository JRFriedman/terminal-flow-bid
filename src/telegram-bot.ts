import { Bot } from "grammy";

const API_BASE = `http://127.0.0.1:${process.env.PORT || 3000}`;

let bot: Bot | null = null;

async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  return res.json();
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(6);
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return "$" + (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return "$" + (n / 1_000).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

function fmtTime(seconds: number): string {
  if (seconds <= 0) return "now";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (h > 0) parts.push(h + "h");
  if (m > 0) parts.push(m + "m");
  parts.push(s + "s");
  return parts.join(" ");
}

function shortAddr(a: string): string {
  return a && a.length > 14 ? a.slice(0, 6) + ".." + a.slice(-4) : a;
}

function q96ToFdv(q96: number, info: any): number {
  const floor = parseFloat(info.floorPrice || "0");
  if (floor <= 0) return 0;
  const req = parseFloat(info.requiredCurrencyRaised || "0") / 1e6;
  const auction = parseFloat(info.auctionAmount || "0") / 1e18;
  const supply = parseFloat(info.totalSupply || "0") / 1e18;
  if (!auction || !supply || !req) return 0;
  return (q96 * ((req / auction) * supply)) / floor;
}

let launchesCache: any[] = [];

async function resolveAuction(input: string): Promise<string | null> {
  if (!input) return null;
  if (input.startsWith("0x") && input.length > 10) return input;
  if (launchesCache.length === 0) {
    launchesCache = await api("/api/launches");
  }
  const idx = parseInt(input);
  if (!isNaN(idx) && idx >= 1 && idx <= launchesCache.length) {
    return launchesCache[idx - 1].auction;
  }
  const lower = input.toLowerCase();
  const match = launchesCache.find(
    (l: any) =>
      l.tokenSymbol.toLowerCase() === lower ||
      l.tokenName.toLowerCase().includes(lower)
  );
  return match ? match.auction : null;
}

export function startTelegramBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[telegram] No TELEGRAM_BOT_TOKEN, bot disabled");
    return;
  }

  bot = new Bot(token);

  // Register command menu
  bot.api.setMyCommands([
    { command: "auctions", description: "List all auctions" },
    { command: "wallet", description: "Show wallet balances" },
    { command: "status", description: "Show agent state" },
    { command: "strategies", description: "Show active strategies" },
    { command: "exits", description: "Show exit strategies" },
    { command: "trades", description: "Show trading strategies" },
    { command: "help", description: "Show all commands" },
  ]).catch((err) => console.error("[telegram] setMyCommands failed:", err.message));

  bot.command("start", (ctx) =>
    ctx.reply(
      "Flow Terminal Bot\n\nSend commands like you would in the terminal, or use the / menu."
    )
  );

  // Handle slash commands — strip the / and route to handleCommand
  for (const cmd of ["auctions", "wallet", "status", "strategies", "exits", "trades", "help"]) {
    bot.command(cmd, async (ctx) => {
      try {
        const args = ctx.match ? `${cmd} ${ctx.match}` : cmd;
        const reply = await handleCommand(args);
        await ctx.reply(reply, { parse_mode: "Markdown" });
      } catch (err: any) {
        await ctx.reply(`Error: ${err.message}`);
      }
    });
  }

  // Commands that take arguments
  for (const cmd of ["watch", "unwatch", "info", "arm", "disarm", "bid", "strategy", "cancel", "exit", "exit-cancel", "launch", "claim", "claim-all", "trade", "trade-cancel", "trade-remove", "trade-pause", "trade-resume"]) {
    bot.command(cmd.replace("-", "_"), async (ctx) => {
      try {
        const args = ctx.match ? `${cmd} ${ctx.match}` : cmd;
        const reply = await handleCommand(args);
        await ctx.reply(reply, { parse_mode: "Markdown" });
      } catch (err: any) {
        await ctx.reply(`Error: ${err.message}`);
      }
    });
  }

  // Handle plain text messages as CLI commands
  bot.on("message:text", async (ctx) => {
    const raw = ctx.message.text.trim();
    if (raw.startsWith("/")) return; // already handled above

    try {
      const reply = await handleCommand(raw);
      await ctx.reply(reply, { parse_mode: "Markdown" });
    } catch (err: any) {
      await ctx.reply(`Error: ${err.message}`);
    }
  });

  bot.catch((err) => {
    console.error("[telegram] Bot error:", err.message || err);
  });

  // Start with retry — during deploys, old and new instances overlap briefly
  async function startWithRetry(attempts = 5): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        await bot!.start({
          onStart: () => console.log("[telegram] Bot polling started"),
        });
        return;
      } catch (err: any) {
        if (err?.error_code === 409 && i < attempts - 1) {
          const delay = (i + 1) * 3000;
          console.log(`[telegram] Conflict with other instance, retrying in ${delay / 1000}s...`);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          console.error("[telegram] Bot start failed:", err.message || err);
          return;
        }
      }
    }
  }

  startWithRetry();
  console.log("[telegram] Bot started");
}

async function handleCommand(raw: string): Promise<string> {
  const parts = raw.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "help":
      return [
        "*Flow Terminal*",
        "",
        "`auctions` — list all auctions",
        "`watch <id>` — watch auction",
        "`unwatch` — stop watching",
        "`strategy <id> <min> <max> <amt> [exit] [sl]` — bid strategy",
        "`strategies` — show active strategies",
        "`cancel <id>` — cancel strategy",
        "`arm <id> <fdv> <amt>` — schedule bid",
        "`disarm [id]` — remove armed bid",
        "`bid <id> <fdv> <amt>` — bid now",
        "`exit <id> [profile] [sl]` — exit strategy",
        "`exits` — list exit strategies",
        "`launch <name> <symbol>` — launch token",
        "`claim <id>` — claim/exit a bid",
        "`claim-all` — claim all claimable bids",
        "",
        "*Trading*",
        "`trade dca <token> <amt> <interval> [budget] [sl%]`",
        "`trade twap <token> <total> <duration> <chunks> [sl%]`",
        "`trade mean-revert <token> <amt> <ema> <buyDip> <sellRip> [sl%]`",
        "`trades` — list active trading strategies",
        "`trade-cancel <id>` — cancel",
        "`trade-remove <id>` — remove finished strategy",
        "`trade-pause <id>` — pause",
        "`trade-resume <id>` — resume",
        "",
        "`status` — agent state",
        "`wallet` — wallet balances",
        "`info <id>` — auction details",
      ].join("\n");

    case "auctions":
    case "ls": {
      const [launches, block] = await Promise.all([
        api("/api/launches"),
        api("/api/block"),
      ]);
      launchesCache = launches;
      const cur = block.blockNumber;
      const lines = ["*Auctions*", ""];
      launches.forEach((l: any, i: number) => {
        const start = parseInt(l.startBlock);
        const end = parseInt(l.endBlock);
        let status: string;
        if (cur < start) {
          status = `starts in ${fmtTime((start - cur) * 2)}`;
        } else if (cur < end) {
          status = `LIVE ${fmtTime((end - cur) * 2)} left`;
        } else {
          status = l.isGraduated ? "graduated" : "ended";
        }
        const icon =
          cur < start ? "\u23F3" : cur < end ? "\uD83D\uDFE2" : "\u2B1C";
        lines.push(
          `${icon} \`${String(i + 1).padStart(2)}\` *${l.tokenSymbol}* ${l.tokenName.slice(0, 20)} — ${status}`
        );
      });
      return lines.join("\n");
    }

    case "wallet": {
      const w = await api("/api/wallet");
      if (w.error) throw new Error(w.error);
      return [
        "*Wallet*",
        `\`${w.address}\``,
        `ETH: ${parseFloat(w.ethBalance).toFixed(6)}`,
        `USDC: ${parseFloat(w.usdcBalance).toFixed(2)}`,
      ].join("\n");
    }

    case "status": {
      const agent = await api("/api/agent");
      const lines = ["*Status:* " + agent.status];
      const watching = agent.watching || [];
      if (watching.length === 0) {
        lines.push("Watching: none");
      } else {
        for (const addr of watching) {
          const match = launchesCache.find((l: any) => l.auction === addr);
          lines.push(
            `Watching: ${match ? match.tokenSymbol + " (" + match.tokenName + ")" : shortAddr(addr)}`
          );
        }
      }
      (agent.armedBids || []).forEach((ab: any) => {
        const match = launchesCache.find(
          (l: any) => l.auction === ab.auctionAddress
        );
        lines.push(
          `Armed: ${match ? match.tokenSymbol : shortAddr(ab.auctionAddress)} — ${ab.amount} USDC @ ${fmtUsd(ab.maxFdvUsd)} FDV`
        );
      });
      return lines.join("\n");
    }

    case "watch": {
      const input = parts[1];
      if (!input) return "Usage: `watch <symbol | # | addr>`";
      const addr = await resolveAuction(input);
      if (!addr) return `Could not find auction: ${input}`;
      const data = await api("/api/agent/watch", "POST", {
        auctionAddress: addr,
      });
      if (data.error) throw new Error(data.error);
      const match = launchesCache.find((l: any) => l.auction === addr);
      return `\u2705 Watching *${match ? match.tokenSymbol : shortAddr(addr)}*`;
    }

    case "unwatch":
    case "stop": {
      const input = parts[1];
      if (input) {
        const addr = await resolveAuction(input);
        if (!addr) return `Could not find auction: ${input}`;
        await api("/api/agent/unwatch", "POST", { auctionAddress: addr });
        const match = launchesCache.find((l: any) => l.auction === addr);
        return `Unwatched ${match ? match.tokenSymbol : shortAddr(addr)}`;
      }
      await api("/api/agent/unwatch", "POST", {});
      return "Stopped watching all";
    }

    case "arm": {
      let auctionInput: string, fdv: string, amt: string;
      if (parts.length >= 4) {
        auctionInput = parts[1];
        fdv = parts[2];
        amt = parts[3];
      } else {
        return "Usage: `arm <auction> <fdv> <amt>`";
      }
      const addr = await resolveAuction(auctionInput);
      if (!addr) return `Could not find auction: ${auctionInput}`;
      const data = await api("/api/bid/schedule", "POST", {
        auctionAddress: addr,
        maxFdvUsd: Number(fdv),
        amount: Number(amt),
      });
      if (data.error) throw new Error(data.error);
      const match = launchesCache.find((l: any) => l.auction === addr);
      return `\u2705 Armed *${match ? match.tokenSymbol : shortAddr(addr)}* — ${amt} USDC @ ${fmtUsd(Number(fdv))} FDV`;
    }

    case "disarm": {
      const input = parts[1];
      if (input) {
        const addr = await resolveAuction(input);
        if (!addr) return `Could not find auction: ${input}`;
        await api("/api/agent/disarm", "POST", { auctionAddress: addr });
        const match = launchesCache.find((l: any) => l.auction === addr);
        return `Disarmed ${match ? match.tokenSymbol : shortAddr(addr)}`;
      }
      await api("/api/agent/disarm", "POST", {});
      return "Disarmed all";
    }

    case "bid": {
      let auctionInput: string, fdv: string, amt: string;
      if (parts.length >= 4) {
        auctionInput = parts[1];
        fdv = parts[2];
        amt = parts[3];
      } else {
        return "Usage: `bid <auction> <fdv> <amt>`";
      }
      const addr = await resolveAuction(auctionInput);
      if (!addr) return `Could not find auction: ${auctionInput}`;
      const data = await api("/api/bid", "POST", {
        auctionAddress: addr,
        maxFdvUsd: Number(fdv),
        amount: Number(amt),
      });
      if (data.error) throw new Error(data.error);
      const match = launchesCache.find((l: any) => l.auction === addr);
      let msg = `\u2705 Bid confirmed on *${match ? match.tokenSymbol : shortAddr(addr)}*`;
      if (data.txHashes) {
        data.txHashes.forEach((h: string) => {
          msg += `\n[tx](https://basescan.org/tx/${h})`;
        });
      }
      return msg;
    }

    case "strategy": {
      const id = parts[1],
        minFdv = parts[2],
        maxFdv = parts[3],
        amt = parts[4];
      const exitProf = parts[5] || undefined;
      const stopLoss = parts[6] ? Number(parts[6]) : undefined;
      if (!id || !minFdv || !maxFdv || !amt)
        return "Usage: `strategy <auction> <minFdv> <maxFdv> <amount> [exit] [stop-loss]`";
      const addr = await resolveAuction(id);
      if (!addr) return `Could not find auction: ${id}`;
      const body: any = {
        auctionAddress: addr,
        minFdvUsd: Number(minFdv),
        maxFdvUsd: Number(maxFdv),
        amount: Number(amt),
      };
      if (exitProf) body.exitProfile = exitProf;
      if (stopLoss != null) body.stopLoss = stopLoss;
      const data = await api("/api/strategy", "POST", body);
      if (data.error) throw new Error(data.error);
      const match = launchesCache.find((l: any) => l.auction === addr);
      let msg = `\u2705 Strategy started on *${match ? match.tokenSymbol : shortAddr(addr)}*\nFDV range: ${fmtUsd(Number(minFdv))} → ${fmtUsd(Number(maxFdv))}\nAmount: ${amt} USDC\nMode: watch-then-bid (single bid in final ~30s)`;
      if (exitProf) msg += `\nExit: ${exitProf}`;
      if (stopLoss != null) msg += `\nStop-loss: ${stopLoss}x`;
      return msg;
    }

    case "strategies": {
      const strats = await api("/api/strategies");
      if (!Array.isArray(strats) || strats.length === 0)
        return "No active strategies";
      const lines = ["*Strategies*", ""];
      strats.forEach((s: any) => {
        const match = launchesCache.find(
          (l: any) => l.auction === s.auctionAddress
        );
        const name = match ? match.tokenSymbol : shortAddr(s.auctionAddress);
        const icon =
          s.status === "bidding"
            ? "\uD83D\uDFE2"
            : s.status === "watching"
              ? "\uD83D\uDFE1"
              : s.status === "waiting"
                ? "\u23F3"
                : "\u2B1C";
        lines.push(
          `${icon} *${name}* ${s.status} — FDV: ${fmtUsd(s.currentFdv)} — ${s.bidsPlaced} bids`
        );
      });
      return lines.join("\n");
    }

    case "cancel": {
      const id = parts[1];
      if (!id) return "Usage: `cancel <auction>`";
      const addr = await resolveAuction(id);
      if (!addr) return `Could not find auction: ${id}`;
      const data = await api(`/api/strategy/${addr}/cancel`, "POST");
      if (data.error) throw new Error(data.error);
      const match = launchesCache.find((l: any) => l.auction === addr);
      return `Cancelled strategy on ${match ? match.tokenSymbol : shortAddr(addr)}`;
    }

    case "info": {
      const input = parts[1];
      if (!input) return "Usage: `info <symbol | # | addr>`";
      const addr = await resolveAuction(input);
      if (!addr) return `Could not find auction: ${input}`;
      const [info, bids, block] = await Promise.all([
        api(`/api/auction/${addr}`),
        api(`/api/auction/${addr}/bids`),
        api("/api/block"),
      ]);
      if (info.error) throw new Error(info.error);

      const cur = block.blockNumber;
      const start = parseInt(info.startBlock) || 0;
      const end = parseInt(info.endBlock) || start + 270;
      let status: string;
      if (cur < start) status = `\u23F3 WAITING — starts in ${fmtTime((start - cur) * 2)}`;
      else if (cur < end) status = `\uD83D\uDFE2 LIVE — ${fmtTime((end - cur) * 2)} left`;
      else status = "\u2B1C ENDED";

      const raised = parseFloat(info.currencyRaised || "0") / 1e6;
      const required = parseFloat(info.requiredCurrencyRaised || "0") / 1e6;
      const clearingQ96 = parseFloat(info.clearingPrice || "0");
      const fdv = clearingQ96 > 0 ? q96ToFdv(clearingQ96, info) : null;
      const bidList = Array.isArray(bids) ? bids : [];

      const lines = [
        `*${info.tokenName || ""}* ($${info.tokenSymbol || ""})`,
        status,
        `Raised: ${fmtUsd(raised)}${required > 0 ? " / " + fmtUsd(required) : ""}`,
        `Bids: ${bidList.length}`,
      ];
      if (fdv) lines.push(`FDV: ${fmtUsd(fdv)}`);
      lines.push(`Blocks: ${start} → ${end}`);
      return lines.join("\n");
    }

    case "exit": {
      const exitId = parts[1];
      const exitProfile = parts[2] || "moderate";
      const stopLoss = parts[3] ? Number(parts[3]) : undefined;
      if (!exitId) return "Usage: `exit <auction> [profile] [stop-loss]`";
      const addr = await resolveAuction(exitId);
      if (!addr) return `Could not find auction: ${exitId}`;
      const body: any = { auctionAddress: addr, profileOrCustom: exitProfile };
      if (stopLoss != null) body.stopLoss = stopLoss;
      const data = await api("/api/exit-strategy", "POST", body);
      if (data.error) throw new Error(data.error);
      const match = launchesCache.find((l: any) => l.auction === addr);
      return `\u2705 Exit strategy started on *${match ? match.tokenSymbol : shortAddr(addr)}*\nProfile: ${exitProfile}\nEntry FDV: ${fmtUsd(data.entryFdv)}`;
    }

    case "exits": {
      const exits = await api("/api/exit-strategies");
      if (!Array.isArray(exits) || exits.length === 0)
        return "No active exit strategies";
      const lines = ["*Exit Strategies*", ""];
      exits.forEach((e: any) => {
        const match = launchesCache.find(
          (l: any) => l.auction === e.auctionAddress
        );
        const name = match ? match.tokenSymbol : shortAddr(e.auctionAddress);
        lines.push(
          `*${name}* ${e.profileName} ${e.status.toUpperCase()} — ${e.currentMultiple.toFixed(2)}x — realized: ${fmtUsd(e.totalUsdcRealized)}`
        );
      });
      return lines.join("\n");
    }

    case "claim": {
      const claimInput = parts[1];
      if (!claimInput) return "Usage: `claim <auction>` or `claim-all`";
      const claimAddr = await resolveAuction(claimInput);
      if (!claimAddr) return `Could not find auction: ${claimInput}`;
      const claimData = await api("/api/claim", "POST", { auctionAddress: claimAddr });
      if (claimData.error) throw new Error(claimData.error);
      const claimMatch = launchesCache.find((l: any) => l.auction === claimAddr);
      let msg = `\u2705 Claimed *${claimMatch ? claimMatch.tokenSymbol : shortAddr(claimAddr)}*`;
      msg += `\nMethod: ${claimData.method}`;
      if (claimData.note) msg += `\n${claimData.note}`;
      if (claimData.txHash) msg += `\n[tx](https://basescan.org/tx/${claimData.txHash})`;
      return msg;
    }

    case "claim-all": {
      const caData = await api("/api/claim-all", "POST");
      if (caData.error) throw new Error(caData.error);
      if (caData.status === "nothing_to_claim") return "No claimable bids found.";
      const lines: string[] = ["*Claim Results*", ""];
      for (const c of caData.claimed || []) {
        const m = launchesCache.find((l: any) => l.auction === c.auction);
        lines.push(`\u2705 ${m ? m.tokenSymbol : shortAddr(c.auction)} — ${c.method}`);
      }
      for (const e of caData.errors || []) {
        const m = launchesCache.find((l: any) => l.auction === e.auction);
        lines.push(`\u274C ${m ? m.tokenSymbol : shortAddr(e.auction)} — ${e.error.slice(0, 80)}`);
      }
      return lines.join("\n");
    }

    case "launch": {
      if (parts.length < 3) return "Usage: `launch <name> <SYMBOL>` (last word is symbol)";
      const symbol = parts[parts.length - 1];
      const name = parts.slice(1, -1).join(" ");
      const data = await api("/api/launch", "POST", { name, symbol });
      if (data.error) throw new Error(data.error);
      const startIn = Math.round(
        (parseInt(data.auctionTiming.startBlock) - parseInt(data.auctionTiming.currentBlock)) * 2 / 60
      );
      let msg = `\u2705 Launched *${name}* ($${symbol})`;
      msg += `\nToken: \`${data.tokenAddress}\``;
      msg += `\nAuction starts in ~${startIn}min`;
      if (data.txHash) msg += `\n[tx](https://basescan.org/tx/${data.txHash})`;
      return msg;
    }

    case "exit-cancel": {
      const id = parts[1];
      if (!id) return "Usage: `exit-cancel <auction>`";
      const addr = await resolveAuction(id);
      if (!addr) return `Could not find auction: ${id}`;
      const data = await api(`/api/exit-strategy/${addr}/cancel`, "POST");
      if (data.error) throw new Error(data.error);
      return `Cancelled exit strategy on ${shortAddr(addr)}`;
    }

    case "trade": {
      const subCmd = parts[1]?.toLowerCase();
      if (!subCmd) return "Usage: `trade dca|twap|mean-revert <token> ...`\nSend `help` for details.";

      // Resolve token: accept 0x address or flow.bid symbol/index
      const tokenInput = parts[2];
      if (!tokenInput) return "Usage: `trade ${subCmd} <token> ...`";

      let tokenAddress = tokenInput;
      if (!tokenInput.startsWith("0x")) {
        // Try to resolve from launches
        const addr = await resolveAuction(tokenInput);
        if (!addr) return `Could not resolve token: ${tokenInput}`;
        // Get token address from launch
        if (launchesCache.length === 0) launchesCache = await api("/api/launches");
        const launch = launchesCache.find((l: any) => l.auction === addr);
        if (!launch) return `Could not find token for auction: ${tokenInput}`;
        tokenAddress = launch.token;
      }

      switch (subCmd) {
        case "dca": {
          // trade dca <token> <amountPerBuy> <interval> [totalBudget] [stopLoss%]
          const amtStr = parts[3], intervalStr = parts[4];
          if (!amtStr || !intervalStr)
            return "Usage: `trade dca <token> <amountPerBuy> <interval> [budget] [stopLoss%]`\ninterval: 30m, 1h, 4h, 12h, 1d";
          const budgetStr = parts[5];
          const slStr = parts[6];

          // Parse interval string to ms
          const intervalMatch = intervalStr.match(/^(\d+)(m|h|d)$/i);
          if (!intervalMatch) return `Invalid interval: ${intervalStr} (use 1h, 4h, 12h, 1d, 30m)`;
          const ival = parseInt(intervalMatch[1]);
          const iunit = intervalMatch[2].toLowerCase();
          const intervalMs = iunit === "m" ? ival * 60000 : iunit === "h" ? ival * 3600000 : ival * 86400000;

          const body: any = {
            type: "dca",
            tokenAddress,
            params: {
              amountPerBuy: Number(amtStr),
              intervalMs,
            },
            riskLimits: {},
          };
          if (budgetStr) body.params.totalBudget = Number(budgetStr);
          if (slStr) body.riskLimits.stopLossPercent = Number(slStr);

          const data = await api("/api/trading-strategy", "POST", body);
          if (data.error) throw new Error(data.error);
          return `\u2705 DCA started on *${data.tokenSymbol}*\nID: \`${data.id}\`\n$${amtStr} every ${intervalStr}${budgetStr ? ` | budget: $${budgetStr}` : ""}${slStr ? ` | stop-loss: ${slStr}%` : ""}`;
        }

        case "twap": {
          // trade twap <token> <totalAmount> <duration> <chunks> [stopLoss%]
          const totalStr = parts[3], durStr = parts[4], chunksStr = parts[5];
          if (!totalStr || !durStr || !chunksStr)
            return "Usage: `trade twap <token> <total> <duration> <chunks> [stopLoss%]`\nduration: 30m, 1h, 4h, 1d";
          const slStr = parts[6];

          const durMatch = durStr.match(/^(\d+)(m|h|d)$/i);
          if (!durMatch) return `Invalid duration: ${durStr}`;
          const dval = parseInt(durMatch[1]);
          const dunit = durMatch[2].toLowerCase();
          const durationMs = dunit === "m" ? dval * 60000 : dunit === "h" ? dval * 3600000 : dval * 86400000;

          const body: any = {
            type: "twap",
            tokenAddress,
            params: {
              totalAmount: Number(totalStr),
              durationMs,
              chunks: Number(chunksStr),
            },
            riskLimits: {},
          };
          if (slStr) body.riskLimits.stopLossPercent = Number(slStr);

          const data = await api("/api/trading-strategy", "POST", body);
          if (data.error) throw new Error(data.error);
          const chunkSize = (Number(totalStr) / Number(chunksStr)).toFixed(2);
          return `\u2705 TWAP started on *${data.tokenSymbol}*\nID: \`${data.id}\`\n$${totalStr} over ${durStr} in ${chunksStr} chunks ($${chunkSize} each)${slStr ? ` | stop-loss: ${slStr}%` : ""}`;
        }

        case "mean-revert": {
          // trade mean-revert <token> <amount> <emaPeriod> <buyDip> <sellRip> [stopLoss%]
          const amtStr = parts[3], emaStr = parts[4], buyStr = parts[5], sellStr = parts[6];
          if (!amtStr || !emaStr || !buyStr || !sellStr)
            return "Usage: `trade mean-revert <token> <amt> <emaPeriod> <buyDip%> <sellRip%> [stopLoss%]`\nemaPeriod: minutes (e.g. 60 for 1h)";
          const slStr = parts[7];

          const body: any = {
            type: "mean-reversion",
            tokenAddress,
            params: {
              amountPerTrade: Number(amtStr),
              emaPeriodMinutes: Number(emaStr),
              buyThresholdPct: Number(buyStr),
              sellThresholdPct: Number(sellStr),
            },
            riskLimits: {},
          };
          if (slStr) body.riskLimits.stopLossPercent = Number(slStr);

          const data = await api("/api/trading-strategy", "POST", body);
          if (data.error) throw new Error(data.error);
          return `\u2705 Mean-Reversion started on *${data.tokenSymbol}*\nID: \`${data.id}\`\n$${amtStr}/trade, ${emaStr}min EMA, buy at -${buyStr}%, sell at +${sellStr}%${slStr ? ` | stop-loss: ${slStr}%` : ""}`;
        }

        default:
          return `Unknown trade sub-command: ${subCmd}\nUse: \`trade dca|twap|mean-revert\``;
      }
    }

    case "trades": {
      const strats = await api("/api/trading-strategies");
      if (!Array.isArray(strats) || strats.length === 0)
        return "No active trading strategies";
      const lines = ["*Trading Strategies*", ""];
      strats.forEach((s: any) => {
        const icon = s.status === "running" ? "\uD83D\uDFE2" : s.status === "paused" ? "\u23F8\uFE0F" : s.status === "done" ? "\u2705" : "\u274C";
        const posValue = s.position.tokenBalance * (s.priceHistory.length > 0 ? s.priceHistory[s.priceHistory.length - 1].price : 0);
        const pnlTotal = s.pnl.realized + s.pnl.unrealized;
        const pnlStr = pnlTotal >= 0 ? `+${fmtUsd(pnlTotal)}` : `-${fmtUsd(Math.abs(pnlTotal))}`;
        lines.push(`${icon} \`${s.id}\``);
        lines.push(`  ${s.type} ${s.tokenSymbol} — ${s.status}`);
        lines.push(`  Position: ${fmtNum(s.position.tokenBalance)} ($${posValue.toFixed(2)}) | PnL: ${pnlStr}`);
        lines.push(`  Trades: ${s.trades.length} | Invested: ${fmtUsd(s.position.totalInvested)}`);
      });
      return lines.join("\n");
    }

    case "trade-cancel": {
      const id = parts[1];
      if (!id) return "Usage: `trade-cancel <id>`";
      const data = await api(`/api/trading-strategy/${id}/cancel`, "POST");
      if (data.error) throw new Error(data.error);
      return `Cancelled trading strategy \`${id}\``;
    }

    case "trade-pause": {
      const id = parts[1];
      if (!id) return "Usage: `trade-pause <id>`";
      const data = await api(`/api/trading-strategy/${id}/pause`, "POST");
      if (data.error) throw new Error(data.error);
      return `Paused trading strategy \`${id}\``;
    }

    case "trade-remove": {
      const id = parts[1];
      if (!id) return "Usage: `trade-remove <id>`";
      const data = await api(`/api/trading-strategy/${id}`, "DELETE");
      if (data.error) throw new Error(data.error);
      return `Removed trading strategy \`${id}\``;
    }

    case "trade-resume": {
      const id = parts[1];
      if (!id) return "Usage: `trade-resume <id>`";
      const data = await api(`/api/trading-strategy/${id}/resume`, "POST");
      if (data.error) throw new Error(data.error);
      return `Resumed trading strategy \`${id}\``;
    }

    default:
      return `Unknown command: ${cmd}\nSend \`help\` for available commands.`;
  }
}
