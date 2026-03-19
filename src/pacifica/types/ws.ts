// WebSocket channel names
export type PublicChannel =
  | "prices"
  | "book"
  | "bbo"
  | "trades"
  | "candle"
  | "mark_price_candle";

export type PrivateChannel =
  | "account_positions"
  | "account_order_updates"
  | "account_info"
  | "account_margin"
  | "account_leverage"
  | "account_trades"
  | "account_twap_orders"
  | "account_twap_order_updates";

export type Channel = PublicChannel | PrivateChannel;

export interface WSTradingResponse {
  code: number;
  data: Record<string, unknown>;
  id: string;
  t: number;
  type: string;
}
