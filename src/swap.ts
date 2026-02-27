import { type Hash, type Address, erc20Abi, maxUint256 } from "viem";
import {
  createConfig,
  getQuote,
  getRawQuotes,
  getPricing,
  odos,
  kyberswap,
  lifi,
} from "@spandex/core";
import { getPublicClient, getWalletClient, getAccount, USDC_BASE } from "./config.js";
import { baseScanTxUrl } from "./utils.js";

const BASE_CHAIN_ID = 8453;

// Spandex config — uses free/no-key aggregators
function getSpandexConfig() {
  return createConfig({
    providers: [
      odos({}),
      kyberswap({ clientId: "flow-bid" }),
      lifi({}),
    ],
    options: {
      deadlineMs: 15_000,
      numRetries: 2,
      initialRetryDelayMs: 500,
    },
    clients: [getPublicClient()] as any,
  });
}

/**
 * Ensure token approval for a spender. Skips if allowance is already sufficient.
 */
// Track gas spent on approvals within current swap call
let _lastApprovalGasEth = 0;

async function ensureApproval(
  token: Address,
  spender: Address,
  amount: bigint
): Promise<void> {
  const publicClient = getPublicClient();
  const walletClient = getWalletClient();
  const account = getAccount();

  const allowance = await publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [account.address, spender],
  });

  if (allowance >= amount) { _lastApprovalGasEth = 0; return; }

  console.log(`  Approving ${spender.slice(0, 10)}... (max uint256)`);
  const hash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, maxUint256],
    account,
    chain: walletClient.chain,
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") throw new Error(`Approve reverted: ${hash}`);
  _lastApprovalGasEth = Number(receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n)) / 1e18;
  console.log(`  Approved in block ${receipt.blockNumber} (gas: ${_lastApprovalGasEth.toFixed(6)} ETH)`);

  // Poll until RPC reflects the new allowance (up to 15s)
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const updated = await publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [account.address, spender],
    });
    if (updated >= amount) {
      console.log(`  Allowance confirmed after ${(i + 1) * 3}s`);
      return;
    }
    console.log(`  Waiting for allowance to reflect... (${(i + 1) * 3}s)`);
  }
  console.log(`  Proceeding despite allowance not yet visible (may retry on gas est)`);
}

/**
 * Swap exact input via Spandex meta-aggregator.
 * Queries Odos, KyberSwap, LiFi for best price. Simulates onchain if RPC supports it.
 * Handles approval + swap tx sending with local signing.
 */
export async function swapExactInputSingle(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  _fee: number = 3000,
  slippageBps: number = 100
): Promise<{ hash: Hash; amountOut: bigint; gasCostEth: number }> {
  const config = getSpandexConfig();
  const publicClient = getPublicClient();
  const walletClient = getWalletClient();
  const account = getAccount();

  const swap = {
    chainId: BASE_CHAIN_ID,
    inputToken: tokenIn,
    outputToken: tokenOut,
    mode: "exactIn" as const,
    inputAmount: amountIn,
    slippageBps,
    swapperAccount: account.address,
  };

  console.log(`  Querying DEX aggregators for best price...`);

  // Try simulated quote first (requires eth_simulateV1 RPC), fall back to raw
  let bestQuote: any = null;
  let outputAmount: bigint = 0n;

  try {
    bestQuote = await getQuote({ config, swap, strategy: "bestPrice" });
    if (bestQuote) {
      outputAmount = bestQuote.simulation?.outputAmount ?? 0n;
      console.log(`  Best (simulated): ${bestQuote.provider} → ${Number(outputAmount) / 1e6} USDC`);
    }
  } catch {
    // Simulation not available, fall back to raw quotes
  }

  if (!bestQuote) {
    // Fall back to raw quotes without simulation
    const quotes = await getRawQuotes({ config, swap });
    const successful = quotes.filter((q) => q.success);
    if (successful.length === 0) throw new Error("No DEX aggregator returned a viable quote");

    bestQuote = successful.reduce((a: any, b: any) => {
      const aOut = BigInt(a.outputAmount || "0");
      const bOut = BigInt(b.outputAmount || "0");
      return bOut > aOut ? b : a;
    });
    outputAmount = BigInt(bestQuote.outputAmount || "0");
    console.log(`  Best (raw): ${bestQuote.provider} → ${Number(outputAmount) / 1e6} USDC`);
  }

  // Approve the router/aggregator to spend our tokens
  const approvalTarget = bestQuote.approval?.spender || bestQuote.approvalAddress || bestQuote.txData?.to;
  if (approvalTarget) {
    await ensureApproval(tokenIn, approvalTarget, amountIn);
  }

  // Estimate gas explicitly to avoid viem over-estimation
  // Retry up to 3 times on failure (handles post-approval RPC sync delay)
  const nonce = await publicClient.getTransactionCount({ address: account.address });
  let gasEstimate: bigint | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      gasEstimate = await publicClient.estimateGas({
        account: account.address,
        to: bestQuote.txData.to as Address,
        data: bestQuote.txData.data as `0x${string}`,
        value: bestQuote.txData.value ? BigInt(bestQuote.txData.value) : 0n,
      });
      break;
    } catch (e: any) {
      if (attempt === 2) throw e;
      const wait = (attempt + 1) * 3;
      console.log(`  Gas estimation failed (attempt ${attempt + 1}/3), retrying in ${wait}s... (${e.message?.slice(0, 60)})`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }

  const hash = await walletClient.sendTransaction({
    to: bestQuote.txData.to as Address,
    data: bestQuote.txData.data as `0x${string}`,
    value: bestQuote.txData.value ? BigInt(bestQuote.txData.value) : 0n,
    gas: gasEstimate! + gasEstimate! / 5n, // 20% buffer
    nonce,
    account,
    chain: walletClient.chain,
  });

  console.log(`  Swap TX: ${hash}`);
  console.log(`  ${baseScanTxUrl(hash)}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status === "reverted") throw new Error(`Swap reverted: ${hash}`);

  // Calculate gas cost (swap + any approval)
  const swapGasEth = Number(receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n)) / 1e18;
  const totalGasEth = swapGasEth + _lastApprovalGasEth;
  _lastApprovalGasEth = 0;
  console.log(`  Swap confirmed in block ${receipt.blockNumber} (gas: ${totalGasEth.toFixed(6)} ETH)`);

  // Parse actual received amount from Transfer events
  const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const myAddr = account.address.toLowerCase();
  let actualOut = outputAmount; // fallback to quoted amount
  for (const log of receipt.logs) {
    if (log.topics[0] === TRANSFER_TOPIC && log.address.toLowerCase() === tokenOut.toLowerCase()) {
      const to = log.topics[2] ? ("0x" + log.topics[2].slice(26)).toLowerCase() : "";
      if (to === myAddr) {
        actualOut = BigInt(log.data);
        break;
      }
    }
  }
  if (actualOut !== outputAmount) {
    console.log(`  Actual received: ${actualOut} (quoted: ${outputAmount})`);
  }

  return { hash, amountOut: actualOut, gasCostEth: totalGasEth };
}

/**
 * Get the current price of a token in USDC terms.
 * Uses Spandex raw quotes across all configured aggregators.
 */
export async function getTokenPrice(
  token: Address,
  tokenDecimals: number = 18,
  _fee: number = 3000
): Promise<number> {
  const config = getSpandexConfig();
  const account = getAccount();
  const oneToken = 10n ** BigInt(tokenDecimals);

  const swap = {
    chainId: BASE_CHAIN_ID,
    inputToken: token,
    outputToken: USDC_BASE,
    mode: "exactIn" as const,
    inputAmount: oneToken,
    slippageBps: 100,
    swapperAccount: account.address,
  };

  const quotes = await getRawQuotes({ config, swap });
  const successful = quotes.filter((q) => q.success);

  if (successful.length === 0) {
    throw new Error(`No price quotes available for token ${token}`);
  }

  // Try USD pricing metadata first
  const pricing = getPricing(quotes);
  if (pricing.inputToken?.usdPrice) {
    return pricing.inputToken.usdPrice;
  }

  // Fallback: best raw quote output
  const best = successful.reduce((a: any, b: any) => {
    const aOut = BigInt(a.outputAmount || "0");
    const bOut = BigInt(b.outputAmount || "0");
    return bOut > aOut ? b : a;
  });

  return Number(BigInt((best as any).outputAmount || "0")) / 1e6;
}

/**
 * Get the current FDV of a token based on its DEX price.
 */
export async function getTokenFdv(
  token: Address,
  totalSupply: bigint,
  tokenDecimals: number = 18,
  fee: number = 3000
): Promise<number> {
  const price = await getTokenPrice(token, tokenDecimals, fee);
  const supplyHuman = Number(totalSupply) / 10 ** tokenDecimals;
  return price * supplyHuman;
}
