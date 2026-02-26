#!/usr/bin/env node
import { Command } from "commander";
import { config } from "dotenv";

config();

const program = new Command();

program
  .name("flow-bid")
  .description("CLI for Flow.bid token launch auctions on Base")
  .version("1.0.0");

// --- Wallet commands ---
const wallet = program.command("wallet").description("Wallet management");

wallet
  .command("generate")
  .description("Generate a new wallet keypair")
  .action(async () => {
    const { generateWallet } = await import("./wallet.js");
    generateWallet();
  });

wallet
  .command("balance")
  .description("Show ETH and USDC balance")
  .action(async () => {
    const { showBalance } = await import("./wallet.js");
    await showBalance();
  });

wallet
  .command("address")
  .description("Show wallet address from .env private key")
  .action(async () => {
    const { showAddress } = await import("./wallet.js");
    await showAddress();
  });

// --- Auction commands ---
const auction = program.command("auction").description("Auction information");

auction
  .command("info <address>")
  .description("Show auction details")
  .action(async (address: string) => {
    const { getAuction, getCurrentBlock } = await import("./api.js");
    const { estimateTimestampForBlock, formatTimestamp, formatCountdown } = await import("./utils.js");

    const [auctionData, block] = await Promise.all([
      getAuction(address),
      getCurrentBlock(),
    ]);

    console.log("Auction info:");
    console.log(JSON.stringify(auctionData, null, 2));

    if (auctionData.startBlock) {
      const estTimestamp = estimateTimestampForBlock(
        auctionData.startBlock,
        block.blockNumber,
        block.timestamp
      );
      const secondsUntil = estTimestamp - block.timestamp;
      console.log(`\nStart block:      ${auctionData.startBlock}`);
      console.log(`Current block:    ${block.blockNumber}`);
      if (secondsUntil > 0) {
        console.log(`Estimated start:  ${formatTimestamp(estTimestamp)}`);
        console.log(`Countdown:        ${formatCountdown(secondsUntil)}`);
      } else {
        console.log(`Status:           ACTIVE`);
      }
    }
  });

auction
  .command("safety <address>")
  .description("Run safety check on an auction")
  .action(async (address: string) => {
    const { getSafety } = await import("./api.js");
    const result = await getSafety(address);
    console.log("Safety assessment:");
    console.log(JSON.stringify(result, null, 2));
  });

auction
  .command("bids <address>")
  .description("List current bids for an auction")
  .action(async (address: string) => {
    const { getAuctionBids } = await import("./api.js");
    const bids = await getAuctionBids(address);
    console.log(`Bids for auction ${address}:`);
    console.log(JSON.stringify(bids, null, 2));
  });

// --- Bid commands ---
const bid = program.command("bid").description("Submit bids");

bid
  .command("submit <address>")
  .description("Submit a bid to an auction")
  .requiredOption("--fdv <usd>", "Maximum FDV in USD", parseFloat)
  .requiredOption("--amount <usdc>", "Bid amount in USDC", parseFloat)
  .action(async (address: string, opts: { fdv: number; amount: number }) => {
    const { getAccount } = await import("./config.js");
    const { submitBid } = await import("./bid.js");

    const account = getAccount();
    console.log(`Bidding on auction ${address}`);
    console.log(`  Wallet:  ${account.address}`);
    console.log(`  Max FDV: $${opts.fdv}`);
    console.log(`  Amount:  ${opts.amount} USDC\n`);

    const result = await submitBid({
      bidder: account.address,
      auctionAddress: address,
      maxFdvUsd: opts.fdv,
      amount: opts.amount,
    });

    console.log("\nTransaction links:");
    result.links.forEach((link) => console.log(`  ${link}`));
  });

bid
  .command("schedule <address>")
  .description("Schedule a bid for auction start")
  .requiredOption("--fdv <usd>", "Maximum FDV in USD", parseFloat)
  .requiredOption("--amount <usdc>", "Bid amount in USDC", parseFloat)
  .action(async (address: string, opts: { fdv: number; amount: number }) => {
    const { getAccount } = await import("./config.js");
    const { scheduleBid } = await import("./scheduler.js");

    const account = getAccount();
    console.log(`Scheduling bid on auction ${address}`);
    console.log(`  Wallet:  ${account.address}`);
    console.log(`  Max FDV: $${opts.fdv}`);
    console.log(`  Amount:  ${opts.amount} USDC\n`);

    await scheduleBid({
      bidder: account.address,
      auctionAddress: address,
      maxFdvUsd: opts.fdv,
      amount: opts.amount,
    });
  });

// --- Launch server ---
program
  .command("launch")
  .description("Start the terminal.flow.bid web server")
  .option("-p, --port <port>", "Port number", "3000")
  .action(async (opts: { port: string }) => {
    process.env.PORT = opts.port;
    await import("./server.js");
  });

// --- User bids ---
program
  .command("bids")
  .description("List your bids")
  .action(async () => {
    const { getAccount } = await import("./config.js");
    const { getUserBids } = await import("./api.js");

    const account = getAccount();
    const bids = await getUserBids(account.address);
    console.log(`Bids for ${account.address}:`);
    console.log(JSON.stringify(bids, null, 2));
  });

program.parseAsync();
