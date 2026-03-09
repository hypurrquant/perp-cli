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

// WS subscribe/unsubscribe
export interface WSSubscription {
  method: "subscribe" | "unsubscribe";
  params: {
    source: Channel;
    [key: string]: unknown;
  };
}

// WS trading commands
export type WSTradingMethod =
  | "create_order"
  | "create_market_order"
  | "edit_order"
  | "batch_order"
  | "cancel_order"
  | "cancel_all_orders";

export interface WSTradingRequest {
  id: string;
  params: Record<string, unknown>;
}

export interface WSTradingResponse {
  code: number;
  data: Record<string, unknown>;
  id: string;
  t: number;
  type: string;
}

// Field abbreviation mappings for order updates
export const ORDER_UPDATE_FIELDS: Record<string, string> = {
  i: "order_id",
  I: "client_order_id",
  u: "account",
  s: "symbol",
  d: "side",
  p: "price",
  a: "amount",
  f: "filled",
  oe: "order_event",
  os: "order_status",
  ot: "order_type",
  li: "last_order_id",
};

// Field abbreviation mappings for account info
export const ACCOUNT_INFO_FIELDS: Record<string, string> = {
  b: "balance",
  f: "fee_level",
  ae: "account_equity",
  as: "available_to_spend",
  aw: "available_to_withdraw",
  pb: "pending_balance",
  mu: "margin_used",
  cm: "cross_mmr",
  pc: "positions_count",
  oc: "orders_count",
  sc: "stop_orders_count",
  t: "timestamp",
};

// WS error codes
export const WS_CODES = {
  SUCCESS: 200,
  INVALID_REQUEST: 400,
  INVALID_SIGNATURE: 401,
  INVALID_SIGNER: 402,
  UNAUTHORIZED: 403,
  ENGINE_ERROR: 420,
  RATE_LIMIT: 429,
  UNKNOWN_ERROR: 500,
} as const;
