/**
 * Strategy interface for Bot Engine v2.
 * All trading strategies implement this interface.
 */

import type { ExchangeAdapter, ExchangeKline } from "../exchanges/index.js";
import type { MarketSnapshot } from "./conditions.js";

// ── Enriched market data passed to strategies ──

export interface EnrichedSnapshot extends MarketSnapshot {
  klines: ExchangeKline[];
  orderbook: { bids: [string, string][]; asks: [string, string][] };
  openInterest: string;
}

// ── Actions a strategy can return ──

export type StrategyAction =
  | { type: "place_order"; side: "buy" | "sell"; price: string; size: string; orderType: "limit" | "market"; reduceOnly?: boolean; tif?: string }
  | { type: "cancel_order"; orderId: string }
  | { type: "cancel_all" }
  | { type: "edit_order"; orderId: string; price: string; size: string }
  | { type: "set_leverage"; leverage: number; marginMode?: "cross" | "isolated" }
  | { type: "noop" };

// ── Strategy context ──

export interface StrategyContext {
  adapter: ExchangeAdapter;
  symbol: string;
  config: Record<string, unknown>;
  state: Map<string, unknown>;
  tick: number;
  log: (msg: string) => void;
}

// ── Strategy parameter definition ──

export interface ParamDef {
  name: string;
  type: "number" | "string" | "boolean";
  required: boolean;
  default?: unknown;
  description: string;
}

// ── Strategy interface ──

export interface Strategy {
  readonly name: string;
  describe(): { description: string; params: ParamDef[] };
  init(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<void>;
  onTick(ctx: StrategyContext, snapshot: EnrichedSnapshot): Promise<StrategyAction[]>;
  onStop(ctx: StrategyContext): Promise<StrategyAction[]>;
}
