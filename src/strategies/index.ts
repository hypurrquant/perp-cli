// strategies/ barrel — public API
export { runGrid } from "./grid.js";
export type { GridParams, GridState } from "./grid.js";
export { runDCA } from "./dca.js";
export type { DCAParams, DCAState } from "./dca.js";
export { runTWAP } from "./twap.js";
export type { TWAPParams, TWAPState } from "./twap.js";
export { runFundingArb } from "./funding-arb.js";
export type { FundingArbParams } from "./funding-arb.js";
export { runTrailingStop } from "./trailing-stop.js";
export type { TrailingStopParams, TrailingStopResult } from "./trailing-stop.js";
export { runSplitOrder } from "./split-order.js";
export type { SplitOrderParams, SplitSlice, SplitOrderResult } from "./split-order.js";
