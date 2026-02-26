import { FLOW_BID_BASE_URL } from "./config.js";

const BASE_URL = FLOW_BID_BASE_URL;

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Flow.bid API error ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// --- Types ---

export interface SafetyResponse {
  [key: string]: unknown;
}

export interface BuildBidTxParams {
  bidder: string;
  auctionAddress: string;
  maxFdvUsd: number;
  amount: number;
  currencyPriceUsd?: number;
}

export interface BuildBidTxResult {
  steps?: Array<{
    to: string;
    data: string;
    value?: string;
    gasLimit?: string;
  }>;
  transactions?: Array<{
    to: string;
    data: string;
    value?: string;
    step?: number;
    description?: string;
  }>;
  params: {
    maxFdvUsd: number;
    currencyPriceUsd: number;
    maxPriceQ96Aligned: string;
    amount: number;
    amountRaw: string;
    currencyAddress: string;
  };
}

export interface AuctionInfo {
  auctionAddress: string;
  startBlock: number;
  [key: string]: unknown;
}

export interface AuctionBid {
  [key: string]: unknown;
}

export interface CurrentBlock {
  blockNumber: number;
  timestamp: number;
  [key: string]: unknown;
}

export interface UserBid {
  [key: string]: unknown;
}

export interface Launch {
  id: string;
  auction: string;
  token: string;
  tokenName: string;
  tokenSymbol: string;
  startBlock: string;
  endBlock: string;
  clearingPrice: string | null;
  requiredCurrencyRaised: string;
  currencyRaised: string | null;
  isGraduated: boolean;
  deployer: string;
  metadata: string;
  [key: string]: unknown;
}

export interface LaunchesResponse {
  launches: Launch[];
}

// --- API Functions ---

export async function getLaunches(): Promise<Launch[]> {
  const data = await fetchJson<LaunchesResponse>("/launches");
  return data.launches;
}

export async function getSafety(auctionAddress: string): Promise<SafetyResponse> {
  return fetchJson<SafetyResponse>(`/launches/${auctionAddress}/safety`);
}

export async function buildBidTx(params: BuildBidTxParams): Promise<BuildBidTxResult> {
  return fetchJson<BuildBidTxResult>("/bids/build-tx", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function getAuction(auctionAddress: string): Promise<AuctionInfo> {
  return fetchJson<AuctionInfo>(`/launches/${auctionAddress}`);
}

export async function getAuctionBids(auctionAddress: string): Promise<AuctionBid[]> {
  const data = await fetchJson<{ bids: AuctionBid[] }>(`/launches/${auctionAddress}/bids`);
  return data.bids;
}

export async function getCurrentBlock(): Promise<CurrentBlock> {
  return fetchJson<CurrentBlock>("/block/current");
}

export async function getUserBids(address: string): Promise<UserBid[]> {
  const data = await fetchJson<{ bids: UserBid[] }>(`/user/${address}/bids`);
  return data.bids;
}
