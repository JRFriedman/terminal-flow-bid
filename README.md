# terminal.flow.bid

Agent-centric terminal for [Flow.bid](https://flow.bid) token launch auctions on Base.

The server watches auctions, schedules bids at start blocks, and executes transactions autonomously. The web frontend is a monitoring terminal — you watch what the agent sees and steer it with commands.

## Setup

```bash
npm install
cp .env.example .env
```

Add your wallet credentials to `.env`:

```
MNEMONIC=your twelve word recovery phrase here
# OR
PRIVATE_KEY=0x...
```

## Run

```bash
npm run server
```

Open `http://localhost:3000` — the terminal UI loads automatically.

## Commands

Type in the web terminal or use keyboard shortcuts:

| Command | Description | Shortcut |
|---|---|---|
| `auctions` | List all auctions | `Cmd+L` |
| `watch <id>` | Watch auction (symbol, #, or address) | |
| `unwatch [id]` | Stop watching one or all | |
| `arm [auction] <fdv> <amt>` | Schedule bid for auction start | |
| `bid [auction] <fdv> <amt>` | Bid now | |
| `info <id>` | One-shot auction lookup | |
| `status` | Show agent state | `Cmd+J` |
| `bids` | Your bid history | `Cmd+B` |
| `wallet` | Wallet info | `Cmd+W` |
| `clear` | Clear output | `Cmd+K` |
| `help` | Show commands | `Cmd+/` |

Auction identifiers can be a token symbol (`flow`), list number (`1`), or contract address.

## CLI

Also works as a standalone CLI:

```bash
npx tsx src/index.ts auction info <address>
npx tsx src/index.ts bid submit <address> --fdv 3000000 --amount 500
npx tsx src/index.ts bid schedule <address> --fdv 3000000 --amount 500
```

## Architecture

- **`src/server.ts`** — Express server, agent state, API endpoints
- **`src/api.ts`** — Flow.bid API client
- **`src/scheduler.ts`** — Block polling + scheduled bid execution
- **`src/bid.ts`** — Transaction building + submission via viem
- **`src/config.ts`** — Wallet + chain configuration
- **`public/index.html`** — Web terminal UI

The server talks to the Flow.bid API for auction data and transaction building, and to Base via RPC for wallet operations and transaction submission. The frontend polls the server every 3 seconds and interpolates countdowns locally at 1-second intervals.

## Stack

TypeScript, Express, viem, vanilla JS frontend. No frameworks, no build step for the frontend.
