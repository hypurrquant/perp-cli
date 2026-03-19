// arb/ barrel — public API
export { computeMatchedSize, computeSpotPerpMatchedSize, reconcileArbFills } from "./sizing.js";
export {
  SETTLEMENT_SCHEDULES,
  getLastSettlement,
  getMinutesSinceSettlement,
  aggressiveSettleBoost,
  estimateFundingUntilSettlement,
  computeBasisRisk,
  formatNotifyMessage,
  sendNotification,
  notifyIfEnabled,
} from "./utils.js";
export type { SettleStrategy, BasisRisk, ArbNotifyEvent } from "./utils.js";
export {
  setStateFilePath,
  resetStateFilePath,
  loadArbState,
  saveArbState,
  addPosition,
  removePosition,
  updatePosition,
  getPositions,
  createInitialState,
} from "./state.js";
export type { ArbPositionState, ArbDaemonState } from "./state.js";
export { computeEnhancedStats } from "./history-stats.js";
export type { ArbTradeForStats, ExchangePairPerf, TimeOfDayPerf, EnhancedHistoryStats } from "./history-stats.js";
