import type { Side } from "./order.js";

export interface Position {
  symbol: string;
  side: Side;
  amount: string;
  entry_price: string;
  mark_price: string;
  liquidation_price: string;
  unrealized_pnl: string;
  margin_used: string;
  leverage: number;
  created_at: number;
}
