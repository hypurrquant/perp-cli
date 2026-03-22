// apex/ barrel -- Radar + Pulse + Guard
export { scoreOpportunity } from "./radar.js";
export type { RadarScore } from "./radar.js";
export { detectPulse, tierRank } from "./pulse.js";
export type { PulseTier, PulseSignal } from "./pulse.js";
export { evaluateGuard, createGuardState, GUARD_PRESETS } from "./guard.js";
export type { GuardConfig, GuardState } from "./guard.js";
