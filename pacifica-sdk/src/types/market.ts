export interface MarketInfo {
  symbol: string;
  tick_size: string;
  lot_size: string;
  max_leverage: number;
  funding_rate: string;
  next_funding_rate: string;
  open_interest: string;
  volume_24h: string;
  mark_price: string;
  index_price: string;
}

export interface PriceInfo {
  symbol: string;
  mark: string;
  mid: string;
  oracle: string;
  funding: string;
  next_funding: string;
  open_interest: string;
  volume_24h: string;
  timestamp: number;
}

export interface OrderbookEntry {
  p: string; // price
  a: string; // amount
  n: number; // num_orders
}

export interface Orderbook {
  s: string; // symbol
  l: [OrderbookEntry[], OrderbookEntry[]]; // [bids, asks]
  t: number; // timestamp
  li: number; // last_id
}

export interface Trade {
  event_type: string;
  price: string;
  amount: string;
  side: "bid" | "ask";
  cause: string;
  created_at: number;
}

export interface Kline {
  t: number; // open_time
  T: number; // close_time
  s: string; // symbol
  i: string; // interval
  o: string; // open
  c: string; // close
  h: string; // high
  l: string; // low
  v: string; // volume
  n: number; // trade_count
}

export interface FundingRateHistory {
  oracle_price: string;
  bid_impact_price: string;
  ask_impact_price: string;
  funding_rate: string;
  next_funding_rate: string;
  created_at: number;
}

export type KlineInterval =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "4h"
  | "8h"
  | "12h"
  | "1d";

export type AggLevel = 1 | 10 | 100 | 1000 | 10000;
