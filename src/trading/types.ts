export interface PricePoint {
  timestamp: number;
  price: number;
}

export interface Trade {
  timestamp: number;
  side: "buy" | "sell";
  amountUsdc: number;
  amountToken: number;
  price: number;
  txHash: string;
}

export interface Position {
  tokenBalance: number;       // human-readable
  avgEntryPrice: number;
  totalInvested: number;      // total USDC spent buying
  totalRealized: number;      // total USDC received selling
}

export interface RiskLimits {
  maxPositionUsdc: number;
  stopLossPercent: number;    // sell all if down X% from avg entry
  maxDrawdownPercent: number; // pause if down X% from peak value
}

export type StrategyType = "dca" | "twap" | "mean-reversion";
export type StrategyStatus = "running" | "paused" | "done" | "failed";

export interface TradingStrategyState {
  id: string;
  type: StrategyType;
  status: StrategyStatus;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  position: Position;
  priceHistory: PricePoint[];  // last 24h, kept lean
  trades: Trade[];
  pnl: { realized: number; unrealized: number };
  riskLimits: RiskLimits;
  params: Record<string, any>;  // strategy-specific
  log: Array<{ time: number; message: string; type: "info" | "trade" | "error" }>;
}
