import { type Hash } from "viem";
import { getPublicClient, getWalletClient, getAccount } from "./config.js";
import { buildBidTx, getSafety, type BuildBidTxParams } from "./api.js";
import { baseScanTxUrl } from "./utils.js";

interface BidResult {
  txHashes: Hash[];
  links: string[];
}

export async function submitBid(params: BuildBidTxParams): Promise<BidResult> {
  // Run safety check first
  console.log("Running safety check...");
  const safety = await getSafety(params.auctionAddress);
  console.log("Safety assessment:", JSON.stringify(safety, null, 2));

  // Build transactions
  console.log("\nBuilding bid transactions...");
  const result = await buildBidTx(params);

  const steps = result.steps || (result as any).transactions || [];

  console.log(`\nBid parameters:`);
  console.log(`  Max FDV:  $${params.maxFdvUsd}`);
  console.log(`  Amount:   ${params.amount} USDC`);
  console.log(`  Auction:  ${params.auctionAddress}`);
  console.log(`  Currency: ${result.params.currencyAddress}`);
  console.log(`  Steps:    ${steps.length} transaction(s)`);

  const walletClient = getWalletClient();
  const publicClient = getPublicClient();
  const account = getAccount();
  const txHashes: Hash[] = [];
  const links: string[] = [];

  // Submit transactions sequentially
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    console.log(`\nSubmitting transaction ${i + 1}/${steps.length}...`);

    const hash = await walletClient.sendTransaction({
      to: step.to as `0x${string}`,
      data: step.data as `0x${string}`,
      value: step.value ? BigInt(step.value) : 0n,
      account,
      chain: walletClient.chain,
      gas: 500_000n,
    });

    console.log(`  TX hash: ${hash}`);
    console.log(`  ${baseScanTxUrl(hash)}`);

    // Wait for confirmation before submitting next tx
    console.log("  Waiting for confirmation...");
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    if (receipt.status === "reverted") {
      throw new Error(`Transaction ${i + 1} reverted: ${hash}`);
    }

    console.log(`  Confirmed in block ${receipt.blockNumber}`);
    txHashes.push(hash);
    links.push(baseScanTxUrl(hash));
  }

  console.log("\nBid submitted successfully!");
  return { txHashes, links };
}
