# terminal.flow.bid

Agent-centric terminal for [Flow.bid](https://flow.bid) token launch auctions on Base. Watches auctions, bids autonomously, sells after graduation via exit strategies with stop-loss protection. State persists across restarts.

## Setup

```bash
npm install
cp .env.example .env   # add PRIVATE_KEY or MNEMONIC
npm run server          # http://localhost:3000
```

## Commands

Auction `<id>` can be a token symbol (`klara`), list number (`3`), or contract address.

**Watching & bidding**

| Command | Description |
|---|---|
| `auctions` | List all auctions |
| `watch <id>` | Watch auction in monitor panel |
| `unwatch [id]` | Stop watching (one or all) |
| `bid [auction] <fdv> <amt>` | Bid now |
| `arm [auction] <fdv> <amt>` | Schedule bid for auction start |
| `disarm [auction]` | Remove armed bid |
| `info <id>` | One-shot auction lookup |

**Strategies**

| Command | Description |
|---|---|
| `strategy <id> <min> <max> <amt> [exit] [stop-loss]` | Automated bid strategy |
| `strategies` | Show active strategies |
| `cancel <id>` | Cancel a strategy |
| `exit <id> [profile] [stop-loss]` | Start exit strategy |
| `exits` | Show active exit strategies |
| `exit-cancel <id>` | Cancel exit strategy |
| `price <id>` | Check token price |

**Examples**

```
strategy klara 10000 50000 100 moderate 0.5   # bid 100 USDC, FDV 10K-50K, moderate exit, stop-loss 0.5x
exit klara moderate                            # sell at 33%@3x, 33%@6x, 34%@10x
exit klara 50@3x,50@5x 0.3                    # custom tranches + stop-loss at 0.3x
```

Exit profiles: **conservative** (50%@3x, 50%@5x), **moderate** (33%@3x, 33%@6x, 34%@10x), **aggressive** (20%@5x, 30%@10x, 50%@20x), or custom `pct@mult` pairs.

Stop-loss is an optional last argument — sells 100% immediately if price drops below that multiple of entry FDV.

**Keyboard shortcuts:** `Cmd+L` auctions, `Cmd+J` status, `Cmd+B` bids, `Cmd+W` wallet, `Cmd+K` clear, `Cmd+/` help, `Cmd+M` collapse/expand monitors.

## CLI

```bash
npx tsx src/index.ts auction info <address>
npx tsx src/index.ts bid submit <address> --fdv 3000000 --amount 500
```

## Architecture

TypeScript, Express, viem, vanilla JS frontend. No frameworks, no build step.

| File | Role |
|---|---|
| `src/server.ts` | Express server, agent state, API routes |
| `src/strategy.ts` | Automated bid strategies |
| `src/exit-strategy.ts` | Exit strategies with stop-loss |
| `src/graduation-monitor.ts` | Detects graduation, triggers exits |
| `src/persistence.ts` | State persistence to `data/state.md` |
| `src/swap.ts` | DEX aggregator swaps (Odos, KyberSwap, LiFi) |
| `src/bid.ts` | Transaction building + submission |
| `src/api.ts` | Flow.bid API client |
| `src/config.ts` | Wallet + chain config |
| `public/index.html` | Web terminal UI |
