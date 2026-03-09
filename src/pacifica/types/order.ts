export type Side = "bid" | "ask";
export type TimeInForce = "GTC" | "IOC" | "ALO" | "TOB";

export interface MarketOrderParams {
  symbol: string;
  amount: string;
  side: Side;
  slippage_percent: string;
  reduce_only: boolean;
  client_order_id?: string;
}

export interface LimitOrderParams {
  symbol: string;
  price: string;
  amount: string;
  side: Side;
  tif: TimeInForce;
  reduce_only: boolean;
  client_order_id?: string;
}

export interface StopOrderParams {
  symbol: string;
  side: Side;
  reduce_only: boolean;
  stop_order: {
    stop_price: string;
    amount: string;
    limit_price?: string;
    client_order_id?: string;
  };
}

export interface EditOrderParams {
  symbol: string;
  order_id: number;
  price: string;
  amount: string;
}

export interface CancelOrderParams {
  symbol: string;
  order_id?: number;
  client_order_id?: string;
}

export interface CancelAllOrdersParams {
  all_symbols: boolean;
  exclude_reduce_only: boolean;
}

export interface TWAPParams {
  symbol: string;
  amount: string;
  side: Side;
  slippage_percent?: string;
  reduce_only?: boolean;
  duration_in_seconds: number;
  client_order_id?: string;
}

export interface CancelTWAPParams {
  symbol: string;
  twap_order_id: number;
}

export interface TPSLParams {
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

export type BatchActionType = "Create" | "Cancel";

export interface BatchAction {
  type: BatchActionType;
  data: Record<string, unknown>;
}

export interface OrderInfo {
  order_id: number;
  client_order_id: string | null;
  symbol: string;
  side: Side;
  price: string;
  initial_amount: string;
  filled_amount: string;
  cancelled_amount: string;
  stop_price: string | null;
  order_type: string;
  stop_parent_order_id: number | null;
  trigger_price_type: string | null;
  reduce_only: boolean;
  created_at: number;
  updated_at: number;
}
