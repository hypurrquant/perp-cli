import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// ── Condition types ──

export type ConditionType =
  | "price_above"
  | "price_below"
  | "volatility_above"
  | "volatility_below"
  | "funding_rate_above"
  | "funding_rate_below"
  | "spread_above"      // cross-exchange spread
  | "rsi_above"
  | "rsi_below"
  | "balance_above"
  | "balance_below"
  | "time_after"        // cron-like or timestamp
  | "max_drawdown"      // drawdown exceeded threshold
  | "always";           // always true (start immediately)

export interface Condition {
  type: ConditionType;
  value: number | string;
  symbol?: string;       // override bot symbol
  exchange?: string;     // for cross-exchange conditions
}

// ── Risk config ──

export interface RiskConfig {
  max_position_usd: number;
  max_daily_loss: number;
  max_drawdown: number;
  pause_after_loss_sec: number;
  max_open_bots: number;
}

// ── Strategy params ──

export interface GridStrategyParams {
  type: "grid";
  grids: number;
  size: number;
  side: "long" | "short" | "neutral";
  range_mode: "auto" | "fixed";
  range_pct?: number;       // auto mode: ±X% from current price
  upper?: number;           // fixed mode
  lower?: number;           // fixed mode
  rebalance: boolean;       // auto-adjust when price exits range
  rebalance_cooldown: number; // seconds between rebalances
  leverage?: number;
}

export interface DCAStrategyParams {
  type: "dca";
  amount: number;           // base size per order
  interval_sec: number;
  total_orders: number;     // 0 = unlimited
  price_limit?: number;
  side?: "buy" | "sell";
}

export interface FundingArbStrategyParams {
  type: "funding-arb";
  min_spread: number;
  close_spread: number;
  spot_perp_min_spread?: number; // default: min_spread (spot-perp is safer so can be lower)
  size_usd: number;
  max_positions: number;
  exchanges: string[];
  leverage?: number; // max leverage to use (default: 3, capped by market maxLeverage)
}

export interface GenericStrategyParams {
  type: string;
  [key: string]: unknown;
}

export type StrategyParams = GridStrategyParams | DCAStrategyParams | FundingArbStrategyParams | GenericStrategyParams;

// ── Full bot config ──

export interface BotConfig {
  name: string;
  exchange: string;
  symbol: string;
  strategy: StrategyParams;
  entry_conditions: Condition[];
  exit_conditions: Condition[];
  risk: RiskConfig;
  monitor_interval_sec: number;  // how often to check conditions
}

// ── Defaults ──

const DEFAULT_RISK: RiskConfig = {
  max_position_usd: 1000,
  max_daily_loss: 100,
  max_drawdown: 200,
  pause_after_loss_sec: 300,
  max_open_bots: 5,
};

// ── Loader ──

export function loadBotConfig(pathOrInline: string): BotConfig {
  let raw: Record<string, unknown>;

  if (existsSync(pathOrInline)) {
    const content = readFileSync(pathOrInline, "utf-8");
    if (pathOrInline.endsWith(".json")) {
      raw = JSON.parse(content);
    } else {
      raw = parseYaml(content) as Record<string, unknown>;
    }
  } else {
    // Try parsing as inline JSON
    raw = JSON.parse(pathOrInline);
  }

  return parseBotConfig(raw);
}

function parseBotConfig(raw: Record<string, unknown>): BotConfig {
  const name = String(raw.name ?? `bot-${Date.now()}`);
  const exchange = String(raw.exchange ?? "hyperliquid");
  const symbol = String(raw.symbol ?? "ETH");
  const monitorInterval = Number(raw.monitor_interval_sec ?? raw.interval ?? 10);

  // Strategy
  const stratRaw = (raw.strategy ?? raw.params ?? {}) as Record<string, unknown>;
  const stratType = String(stratRaw.type ?? raw.strategy_type ?? "grid");
  const strategy = parseStrategy(stratType, stratRaw);

  // Conditions
  const entryConds = parseConditions(raw.entry_conditions as unknown[] | undefined);
  const exitConds = parseConditions(raw.exit_conditions as unknown[] | undefined);

  // If no entry conditions, default to "always"
  if (entryConds.length === 0) {
    entryConds.push({ type: "always", value: 0 });
  }

  // Risk
  const riskRaw = (raw.risk ?? {}) as Record<string, unknown>;
  const risk: RiskConfig = {
    max_position_usd: Number(riskRaw.max_position_usd ?? DEFAULT_RISK.max_position_usd),
    max_daily_loss: Number(riskRaw.max_daily_loss ?? DEFAULT_RISK.max_daily_loss),
    max_drawdown: Number(riskRaw.max_drawdown ?? DEFAULT_RISK.max_drawdown),
    pause_after_loss_sec: Number(riskRaw.pause_after_loss_sec ?? riskRaw.pause_after_loss ?? DEFAULT_RISK.pause_after_loss_sec),
    max_open_bots: Number(riskRaw.max_open_bots ?? DEFAULT_RISK.max_open_bots),
  };

  return { name, exchange, symbol, strategy, entry_conditions: entryConds, exit_conditions: exitConds, risk, monitor_interval_sec: monitorInterval };
}

export function parseStrategy(type: string, raw: Record<string, unknown>): StrategyParams {
  switch (type) {
    case "grid":
      return {
        type: "grid",
        grids: Number(raw.grids ?? 10),
        size: Number(raw.size ?? 0.1),
        side: (String(raw.side ?? "neutral")) as "long" | "short" | "neutral",
        range_mode: String(raw.range_mode ?? "auto") as "auto" | "fixed",
        range_pct: raw.range_pct !== undefined ? Number(raw.range_pct) : 3,
        upper: raw.upper !== undefined ? Number(raw.upper) : undefined,
        lower: raw.lower !== undefined ? Number(raw.lower) : undefined,
        rebalance: raw.rebalance !== false && raw.rebalance !== "false",
        rebalance_cooldown: Number(raw.rebalance_cooldown ?? 60),
        leverage: raw.leverage !== undefined ? Number(raw.leverage) : undefined,
      };
    case "dca":
      return {
        type: "dca",
        amount: Number(raw.amount ?? 0.01),
        interval_sec: Number(raw.interval_sec ?? raw.interval ?? 60),
        total_orders: Number(raw.total_orders ?? raw.orders ?? 0),
        price_limit: raw.price_limit !== undefined ? Number(raw.price_limit) : undefined,
        side: raw.side !== undefined ? (String(raw.side) as "buy" | "sell") : undefined,
      };
    case "funding-arb":
      return {
        type: "funding-arb",
        min_spread: Number(raw.min_spread ?? 20),
        close_spread: Number(raw.close_spread ?? 5),
        spot_perp_min_spread: raw.spot_perp_min_spread !== undefined ? Number(raw.spot_perp_min_spread) : undefined,
        size_usd: Number(raw.size_usd ?? raw.size ?? 50),
        max_positions: Number(raw.max_positions ?? 3),
        exchanges: Array.isArray(raw.exchanges)
          ? raw.exchanges.map(String)
          : String(raw.exchanges ?? "pacifica,hyperliquid").split(",").map(s => s.trim()),
        leverage: raw.leverage !== undefined ? Number(raw.leverage) : undefined,
      };
    default:
      return { type, ...raw } as GenericStrategyParams;
  }
}

function parseConditions(raw?: unknown[]): Condition[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((c) => {
    const cond = c as Record<string, unknown>;
    return {
      type: String(cond.type ?? "always") as ConditionType,
      value: cond.value !== undefined ? (typeof cond.value === "number" ? cond.value : String(cond.value)) : 0,
      symbol: cond.symbol ? String(cond.symbol) : undefined,
      exchange: cond.exchange ? String(cond.exchange) : undefined,
    };
  });
}

// ── Quick config builders ──

export function quickGridConfig(opts: {
  exchange: string; symbol: string; rangePct: number; grids: number;
  size: number; side: string; maxDrawdown: number; maxRuntime?: number;
  leverage?: number;
}): BotConfig {
  return {
    name: `grid-${opts.symbol.toLowerCase()}-${Date.now().toString(36)}`,
    exchange: opts.exchange,
    symbol: opts.symbol,
    strategy: {
      type: "grid",
      grids: opts.grids,
      size: opts.size,
      side: opts.side as "long" | "short" | "neutral",
      range_mode: "auto",
      range_pct: opts.rangePct,
      rebalance: true,
      rebalance_cooldown: 60,
      leverage: opts.leverage,
    },
    entry_conditions: [{ type: "always", value: 0 }],
    exit_conditions: [
      { type: "max_drawdown", value: opts.maxDrawdown },
      ...(opts.maxRuntime ? [{ type: "time_after" as ConditionType, value: opts.maxRuntime }] : []),
    ],
    risk: { ...DEFAULT_RISK, max_drawdown: opts.maxDrawdown },
    monitor_interval_sec: 10,
  };
}

export function quickDCAConfig(opts: {
  exchange: string; symbol: string; side: string; amount: number;
  intervalSec: number; orders: number; triggerDrop?: number;
  priceLimit?: number; maxDrawdown: number;
}): BotConfig {
  const entryConds: Condition[] = [];
  if (opts.triggerDrop) {
    entryConds.push({ type: "price_below", value: opts.triggerDrop });
  } else {
    entryConds.push({ type: "always", value: 0 });
  }

  return {
    name: `dca-${opts.symbol.toLowerCase()}-${Date.now().toString(36)}`,
    exchange: opts.exchange,
    symbol: opts.symbol,
    strategy: {
      type: "dca",
      amount: opts.amount,
      interval_sec: opts.intervalSec,
      total_orders: opts.orders,
      price_limit: opts.priceLimit,
      side: (opts.side as "buy" | "sell") ?? "buy",
    },
    entry_conditions: entryConds,
    exit_conditions: [
      { type: "max_drawdown", value: opts.maxDrawdown },
    ],
    risk: { ...DEFAULT_RISK, max_drawdown: opts.maxDrawdown },
    monitor_interval_sec: opts.intervalSec,
  };
}
