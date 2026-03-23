import type { BotConfig, ConditionType, RiskConfig } from "./config.js";

export interface Preset {
  name: string;
  description: string;
  strategy: "grid" | "dca" | "funding-arb";
  risk: "low" | "medium" | "high";
  buildConfig: (exchange: string, symbol: string) => BotConfig;
}

const DEFAULT_RISK: RiskConfig = {
  max_position_usd: 1000,
  max_daily_loss: 100,
  max_drawdown: 200,
  pause_after_loss_sec: 300,
  max_open_bots: 5,
};

// ── Grid Presets ──

const gridConservative: Preset = {
  name: "grid-conservative",
  description: "Wide range (±5%), 8 grids, small size, no leverage — low risk sideways strategy",
  strategy: "grid",
  risk: "low",
  buildConfig: (exchange, symbol) => ({
    name: `grid-conservative-${symbol.toLowerCase()}-${Date.now().toString(36)}`,
    exchange,
    symbol,
    strategy: {
      type: "grid",
      grids: 8,
      size: 0.05,
      side: "neutral" as const,
      range_mode: "auto" as const,
      range_pct: 5,
      rebalance: true,
      rebalance_cooldown: 120,
    },
    entry_conditions: [{ type: "volatility_below" as ConditionType, value: 8 }],
    exit_conditions: [
      { type: "volatility_above" as ConditionType, value: 15 },
      { type: "time_after" as ConditionType, value: 86400 },
    ],
    risk: { ...DEFAULT_RISK, max_drawdown: 50, max_daily_loss: 30 },
    monitor_interval_sec: 15,
  }),
};

const gridStandard: Preset = {
  name: "grid-standard",
  description: "Medium range (±3%), 12 grids, moderate size — balanced grid trading",
  strategy: "grid",
  risk: "medium",
  buildConfig: (exchange, symbol) => ({
    name: `grid-standard-${symbol.toLowerCase()}-${Date.now().toString(36)}`,
    exchange,
    symbol,
    strategy: {
      type: "grid",
      grids: 12,
      size: 0.1,
      side: "neutral" as const,
      range_mode: "auto" as const,
      range_pct: 3,
      rebalance: true,
      rebalance_cooldown: 60,
    },
    entry_conditions: [{ type: "always" as ConditionType, value: 0 }],
    exit_conditions: [
      { type: "volatility_above" as ConditionType, value: 12 },
    ],
    risk: { ...DEFAULT_RISK, max_drawdown: 100, max_daily_loss: 50 },
    monitor_interval_sec: 10,
  }),
};

const gridAggressive: Preset = {
  name: "grid-aggressive",
  description: "Tight range (±1.5%), 20 grids, 5x leverage — high frequency, high risk",
  strategy: "grid",
  risk: "high",
  buildConfig: (exchange, symbol) => ({
    name: `grid-aggressive-${symbol.toLowerCase()}-${Date.now().toString(36)}`,
    exchange,
    symbol,
    strategy: {
      type: "grid",
      grids: 20,
      size: 0.2,
      side: "neutral" as const,
      range_mode: "auto" as const,
      range_pct: 1.5,
      rebalance: true,
      rebalance_cooldown: 30,
      leverage: 5,
    },
    entry_conditions: [{ type: "volatility_below" as ConditionType, value: 5 }],
    exit_conditions: [
      { type: "volatility_above" as ConditionType, value: 8 },
    ],
    risk: { ...DEFAULT_RISK, max_drawdown: 200, max_daily_loss: 100, max_position_usd: 5000 },
    monitor_interval_sec: 5,
  }),
};

const gridLongBias: Preset = {
  name: "grid-long-bias",
  description: "Long-biased grid (±3%), 10 grids — profit from uptrend + range trading",
  strategy: "grid",
  risk: "medium",
  buildConfig: (exchange, symbol) => ({
    name: `grid-long-${symbol.toLowerCase()}-${Date.now().toString(36)}`,
    exchange,
    symbol,
    strategy: {
      type: "grid",
      grids: 10,
      size: 0.1,
      side: "long" as const,
      range_mode: "auto" as const,
      range_pct: 3,
      rebalance: true,
      rebalance_cooldown: 60,
    },
    entry_conditions: [{ type: "always" as ConditionType, value: 0 }],
    exit_conditions: [],
    risk: { ...DEFAULT_RISK, max_drawdown: 150, max_daily_loss: 75 },
    monitor_interval_sec: 10,
  }),
};

// ── DCA Presets ──

const dcaDaily: Preset = {
  name: "dca-daily",
  description: "Buy once per day, 30 orders — steady accumulation over 1 month",
  strategy: "dca",
  risk: "low",
  buildConfig: (exchange, symbol) => ({
    name: `dca-daily-${symbol.toLowerCase()}-${Date.now().toString(36)}`,
    exchange,
    symbol,
    strategy: {
      type: "dca",
      amount: 0.01,
      interval_sec: 86400,
      total_orders: 30,
    },
    entry_conditions: [{ type: "always" as ConditionType, value: 0 }],
    exit_conditions: [],
    risk: { ...DEFAULT_RISK, max_drawdown: 100, max_daily_loss: 50 },
    monitor_interval_sec: 3600,
  }),
};

const dcaDipBuyer: Preset = {
  name: "dca-dip-buyer",
  description: "Buy only when volatility is high — accumulate during dips",
  strategy: "dca",
  risk: "medium",
  buildConfig: (exchange, symbol) => ({
    name: `dca-dip-${symbol.toLowerCase()}-${Date.now().toString(36)}`,
    exchange,
    symbol,
    strategy: {
      type: "dca",
      amount: 0.02,
      interval_sec: 3600,
      total_orders: 0, // unlimited
    },
    entry_conditions: [{ type: "volatility_above" as ConditionType, value: 5 }],
    exit_conditions: [
      { type: "volatility_below" as ConditionType, value: 2 },
    ],
    risk: { ...DEFAULT_RISK, max_drawdown: 200, max_daily_loss: 100 },
    monitor_interval_sec: 1800,
  }),
};

const dcaHourly: Preset = {
  name: "dca-hourly",
  description: "Buy every hour, 24 orders — short-term aggressive accumulation",
  strategy: "dca",
  risk: "medium",
  buildConfig: (exchange, symbol) => ({
    name: `dca-hourly-${symbol.toLowerCase()}-${Date.now().toString(36)}`,
    exchange,
    symbol,
    strategy: {
      type: "dca",
      amount: 0.005,
      interval_sec: 3600,
      total_orders: 24,
    },
    entry_conditions: [{ type: "always" as ConditionType, value: 0 }],
    exit_conditions: [],
    risk: { ...DEFAULT_RISK, max_drawdown: 50, max_daily_loss: 30 },
    monitor_interval_sec: 600,
  }),
};

const dcaSeller: Preset = {
  name: "dca-seller",
  description: "Sell (short) periodically — dollar-cost average out of a position",
  strategy: "dca",
  risk: "medium",
  buildConfig: (exchange, symbol) => ({
    name: `dca-sell-${symbol.toLowerCase()}-${Date.now().toString(36)}`,
    exchange,
    symbol,
    strategy: {
      type: "dca",
      amount: 0.01,
      interval_sec: 3600,
      total_orders: 24,
      side: "sell" as const,
    },
    entry_conditions: [{ type: "always" as ConditionType, value: 0 }],
    exit_conditions: [],
    risk: { ...DEFAULT_RISK, max_drawdown: 100, max_daily_loss: 50 },
    monitor_interval_sec: 600,
  }),
};

// ── Funding Arb Presets ──

const arbConservative: Preset = {
  name: "arb-conservative",
  description: "High spread threshold (30%), small size ($30/leg), 2 max positions",
  strategy: "funding-arb",
  risk: "low",
  buildConfig: (exchange, _symbol) => ({
    name: `arb-conservative-${Date.now().toString(36)}`,
    exchange,
    symbol: "ETH",
    strategy: {
      type: "funding-arb",
      min_spread: 30,
      close_spread: 10,
      size_usd: 30,
      max_positions: 2,
      exchanges: ["pacifica", "hyperliquid"],
    },
    entry_conditions: [{ type: "always" as ConditionType, value: 0 }],
    exit_conditions: [],
    risk: { ...DEFAULT_RISK, max_drawdown: 100, max_daily_loss: 50, max_position_usd: 200 },
    monitor_interval_sec: 120,
  }),
};

const arbStandard: Preset = {
  name: "arb-standard",
  description: "Medium spread (20%), $50/leg, 3 positions, 3 exchanges",
  strategy: "funding-arb",
  risk: "medium",
  buildConfig: (exchange, _symbol) => ({
    name: `arb-standard-${Date.now().toString(36)}`,
    exchange,
    symbol: "ETH",
    strategy: {
      type: "funding-arb",
      min_spread: 20,
      close_spread: 5,
      size_usd: 50,
      max_positions: 3,
      exchanges: ["pacifica", "hyperliquid", "lighter"],
    },
    entry_conditions: [{ type: "always" as ConditionType, value: 0 }],
    exit_conditions: [],
    risk: { ...DEFAULT_RISK, max_drawdown: 200, max_daily_loss: 100, max_position_usd: 500 },
    monitor_interval_sec: 60,
  }),
};

const arbAggressive: Preset = {
  name: "arb-aggressive",
  description: "Low spread (10%), $100/leg, 5 positions — captures smaller opportunities",
  strategy: "funding-arb",
  risk: "high",
  buildConfig: (exchange, _symbol) => ({
    name: `arb-aggressive-${Date.now().toString(36)}`,
    exchange,
    symbol: "ETH",
    strategy: {
      type: "funding-arb",
      min_spread: 10,
      close_spread: 3,
      size_usd: 100,
      max_positions: 5,
      exchanges: ["pacifica", "hyperliquid", "lighter"],
    },
    entry_conditions: [{ type: "always" as ConditionType, value: 0 }],
    exit_conditions: [],
    risk: { ...DEFAULT_RISK, max_drawdown: 500, max_daily_loss: 200, max_position_usd: 2000 },
    monitor_interval_sec: 30,
  }),
};

// ── Registry ──

export const PRESETS: Preset[] = [
  // Grid
  gridConservative,
  gridStandard,
  gridAggressive,
  gridLongBias,
  // DCA
  dcaDaily,
  dcaDipBuyer,
  dcaHourly,
  dcaSeller,
  // Funding Arb
  arbConservative,
  arbStandard,
  arbAggressive,
];

export function getPreset(name: string): Preset | undefined {
  return PRESETS.find(p => p.name === name);
}

export function getPresetsByStrategy(strategy: string): Preset[] {
  return PRESETS.filter(p => p.strategy === strategy);
}
