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
  GenericStrategyParams,
  StrategyParams,
  BotConfig,
} from "./config.js";
export { runBot } from "./engine.js";
export type { BotLog } from "./engine.js";
export { PRESETS, getPreset, getPresetsByStrategy } from "./presets.js";
export type { Preset } from "./presets.js";
export { evaluateCondition, evaluateAllConditions, getMarketSnapshot, calculateRSI } from "./conditions.js";
export type { MarketSnapshot } from "./conditions.js";
export * from "./indicators.js";
export * from "./strategy-types.js";
export { registerStrategy, getStrategy, listStrategies } from "./strategy-registry.js";
export type { StrategyFactory } from "./strategy-registry.js";
export { appendJournal, readJournal, clearJournal } from "./trade-journal.js";
export type { JournalEntry } from "./trade-journal.js";
export { analyzePerformance, suggestAdjustments } from "./reflect.js";
export type { ReflectReport } from "./reflect.js";
