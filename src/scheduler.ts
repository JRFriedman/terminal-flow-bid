import { getAuction, getCurrentBlock, type BuildBidTxParams } from "./api.js";
import { submitBid } from "./bid.js";
import {
  estimateTimestampForBlock,
  formatTimestamp,
  formatCountdown,
} from "./utils.js";

const POLL_INTERVAL_MS = 2000; // Match Base block time

export async function scheduleBid(params: BuildBidTxParams): Promise<void> {
  const auction = await getAuction(params.auctionAddress);
  const startBlock = auction.startBlock;

  if (!startBlock) {
    throw new Error("Auction has no startBlock defined");
  }

  const block = await getCurrentBlock();
  const currentBlock = block.blockNumber;

  if (currentBlock >= startBlock) {
    console.log("Auction already active. Submitting bid immediately...");
    await submitBid(params);
    return;
  }

  const estimatedTimestamp = estimateTimestampForBlock(
    startBlock,
    currentBlock,
    block.timestamp
  );
  const secondsUntilStart = estimatedTimestamp - block.timestamp;

  console.log(`Auction start block: ${startBlock}`);
  console.log(`Current block:       ${currentBlock}`);
  console.log(`Blocks remaining:    ${startBlock - currentBlock}`);
  console.log(`Estimated start:     ${formatTimestamp(estimatedTimestamp)}`);
  console.log(`Countdown:           ${formatCountdown(secondsUntilStart)}`);
  console.log(`\nPolling every ${POLL_INTERVAL_MS / 1000}s until auction starts...`);

  // Poll until startBlock is reached
  await new Promise<void>((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        const latest = await getCurrentBlock();
        const remaining = startBlock - latest.blockNumber;

        if (remaining <= 0) {
          clearInterval(interval);
          console.log(`\nStart block reached (block ${latest.blockNumber}). Submitting bid...`);
          try {
            await submitBid(params);
            resolve();
          } catch (err) {
            reject(err);
          }
          return;
        }

        const eta = remaining * 2;
        process.stdout.write(
          `\r  Block ${latest.blockNumber} | ${remaining} blocks remaining | ~${formatCountdown(eta)}  `
        );
      } catch (err) {
        console.error("\nPoll error:", err);
      }
    }, POLL_INTERVAL_MS);
  });
}
