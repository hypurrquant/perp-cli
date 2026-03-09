import type { Side } from "./order";

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

export interface PositionTPSL {
  symbol: string;
  side: Side;
  take_profit?: {
    stop_price: string;
    limit_price?: string;
    amount?: string;
  };
  stop_loss?: {
    stop_price: string;
  };
}
