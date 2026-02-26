import { config } from "dotenv";
import { createPublicClient, createWalletClient, http, type Chain } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, mnemonicToAccount } from "viem/accounts";

config();

export const FLOW_BID_BASE_URL = "https://www.flow.bid/api";
export const CCA_FACTORY = "0xCCccCcCAE7503Cac057829BF2811De42E16e0bD5" as const;
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;

export function getRpcUrl(): string {
  return process.env.BASE_RPC_URL || "https://mainnet.base.org";
}

export function getPublicClient() {
  return createPublicClient({
    chain: base,
    transport: http(getRpcUrl()),
  });
}

export function getAccount() {
  const mnemonic = process.env.MNEMONIC;
  if (mnemonic) {
    return mnemonicToAccount(mnemonic);
  }

  const key = process.env.PRIVATE_KEY;
  if (key) {
    const hex = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
    return privateKeyToAccount(hex);
  }

  console.error("Error: Set MNEMONIC or PRIVATE_KEY in .env");
  process.exit(1);
}

export function getWalletClient() {
  const account = getAccount();
  return createWalletClient({
    account,
    chain: base,
    transport: http(getRpcUrl()),
  });
}
