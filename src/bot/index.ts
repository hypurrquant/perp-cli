// bot/ barrel — public API
export {
  loadBotConfig,
  quickGridConfig,
  quickDCAConfig,
} from "./config.js";
export type {
  ConditionType,
  Condition,
  RiskConfig,
  GridStrategyParams,
  DCAStrategyParams,
  FundingArbStrategyParams,
  StrategyParams,
  BotConfig,
} from "./config.js";
export { runBot } from "./engine.js";
export type { BotLog } from "./engine.js";
export { PRESETS, getPreset, getPresetsByStrategy } from "./presets.js";
export type { Preset } from "./presets.js";
export { evaluateCondition, evaluateAllConditions, getMarketSnapshot, calculateRSI } from "./conditions.js";
export type { MarketSnapshot } from "./conditions.js";
