import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { formatEther, formatUnits, erc20Abi } from "viem";
import { getPublicClient, getAccount, USDC_BASE } from "./config.js";

export function generateWallet() {
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  console.log("New wallet generated:\n");
  console.log(`  Address:     ${account.address}`);
  console.log(`  Private Key: ${privateKey}`);
  console.log("\nAdd the private key to your .env file:");
  console.log(`  PRIVATE_KEY=${privateKey}`);
  console.log("\nFund this wallet with ETH (for gas) and USDC on Base chain.");
}

export async function showAddress() {
  const account = getAccount();
  console.log(`Wallet address: ${account.address}`);
}

export async function showBalance() {
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

  console.log(`Wallet: ${account.address}\n`);
  console.log(`  ETH:  ${formatEther(ethBalance)}`);
  console.log(`  USDC: ${formatUnits(usdcBalance, 6)}`);
}
