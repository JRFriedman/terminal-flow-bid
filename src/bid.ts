import { type Hash } from "viem";
import { getPublicClient, getWalletClient, getAccount } from "./config.js";
import { buildBidTx, getAuction, getSafety, type BuildBidTxParams } from "./api.js";
import { baseScanTxUrl } from "./utils.js";

interface BidResult {
  txHashes: Hash[];
  links: string[];
  actualFdv: number;
}

export async function submitBid(params: BuildBidTxParams): Promise<BidResult> {
  // Run safety check first
  console.log("Running safety check...");
  const safety = await getSafety(params.auctionAddress);
  console.log("Safety assessment:", JSON.stringify(safety, null, 2));

  // Fetch auction info to get floor price for Q96 alignment check
  const auctionInfo = await getAuction(params.auctionAddress);
  const floorPrice = (auctionInfo as any).floorPrice || "0";
  const clearingPrice = (auctionInfo as any).clearingPrice || "0";
  const referencePrice = clearingPrice !== "0" && clearingPrice !== "None" ? clearingPrice : floorPrice;

  // Build transactions — retry with higher FDV if Q96 aligns to floor/clearing
  let bidFdv = params.maxFdvUsd;
  let result = await buildBidTx({ ...params, maxFdvUsd: bidFdv });
  const MAX_ALIGNMENT_RETRIES = 5;

  for (let attempt = 0; attempt < MAX_ALIGNMENT_RETRIES; attempt++) {
    const aligned = result.params.maxPriceQ96Aligned;
    console.log(`  Q96 aligned: ${aligned}, floor: ${floorPrice}, clearing: ${clearingPrice}`);

    if (BigInt(aligned) > BigInt(referencePrice)) {
      break; // Q96 is strictly above — good to go
    }

    // Q96 rounded down to floor/clearing — bump FDV and rebuild
    bidFdv = Math.ceil(bidFdv * 1.15);
    console.log(`  Q96 ${aligned} <= reference ${referencePrice} — bumping FDV to $${bidFdv} and rebuilding`);
    result = await buildBidTx({ ...params, maxFdvUsd: bidFdv });
  }

  const steps = result.steps || (result as any).transactions || [];

  console.log(`\nBid parameters:`);
  console.log(`  Max FDV:  $${bidFdv}${bidFdv !== params.maxFdvUsd ? ` (bumped from $${params.maxFdvUsd})` : ""}`);
  console.log(`  Amount:   ${params.amount} USDC`);
  console.log(`  Auction:  ${params.auctionAddress}`);
  console.log(`  Currency: ${result.params.currencyAddress}`);
  console.log(`  Q96:      ${result.params.maxPriceQ96Aligned}`);
  console.log(`  Steps:    ${steps.length} transaction(s)`);

  const walletClient = getWalletClient();
  const publicClient = getPublicClient();
  const account = getAccount();
  const txHashes: Hash[] = [];
  const links: string[] = [];

  // Submit transactions sequentially
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const isLastStep = i === steps.length - 1;
    console.log(`\nSubmitting transaction ${i + 1}/${steps.length}${isLastStep ? " (bid)" : " (approve)"}...`);

    // Simulate the bid tx (last step) before sending — catches reverts without wasting gas
    // Only block on auction-level errors; allowance errors are expected race conditions
    // since the approve tx was just confirmed and RPC may not reflect it yet
    if (isLastStep && steps.length > 1) {
      try {
        await publicClient.call({
          to: step.to as `0x${string}`,
          data: step.data as `0x${string}`,
          value: step.value ? BigInt(step.value) : 0n,
          account: account.address,
        });
        console.log("  Simulation passed");
      } catch (simErr: any) {
        const simMsg = simErr.message || String(simErr);
        if (simMsg.includes("0x5f259e52") || simMsg.includes("BidMustBeAboveClearingPrice")) {
          throw new Error("BidMustBeAboveClearingPrice — simulation rejected bid (Q96 price still too low)");
        }
        if (simMsg.includes("0xa0e92984") || simMsg.includes("AuctionEnded")) {
          throw new Error("AuctionEnded — auction is no longer accepting bids");
        }
        // Allowance/balance errors after a fresh approve are RPC race conditions — proceed anyway
        console.log(`  Simulation warning (proceeding): ${simMsg.slice(0, 150)}`);
      }
    }

    const hash = await walletClient.sendTransaction({
      to: step.to as `0x${string}`,
      data: step.data as `0x${string}`,
      value: step.value ? BigInt(step.value) : 0n,
      account,
      chain: walletClient.chain,
      gas: 1_000_000n,
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
  return { txHashes, links, actualFdv: bidFdv };
}
