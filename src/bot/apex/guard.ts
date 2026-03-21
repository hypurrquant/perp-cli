/**
 * Guard: 2-phase trailing stop with profit-locking tiers.
 * Phase 1: wide retrace tolerance while position builds.
 * Phase 2: tiered profit floors (e.g., at 3% ROE lock 1%, at 6% lock 3%, etc.)
 */

export interface GuardConfig {
  /** Max retrace from entry allowed in Phase 1 (percentage, e.g., 2 = 2%) */
  phase1MaxRetrace: number;
  /** ROE threshold to transition from Phase 1 to Phase 2 (percentage) */
  phase2Trigger: number;
  /** Profit-locking tiers: [roeTrigger, floorRoe] pairs sorted ascending */
  profitTiers: [number, number][];
  /** Hard stop loss from entry (percentage, e.g., 5 = -5%) */
  hardStop: number;
}

export interface GuardState {
  phase: 1 | 2;
  peakRoe: number;
  currentFloor: number;
}

export const GUARD_PRESETS: Record<string, GuardConfig> = {
  conservative: {
    phase1MaxRetrace: 1.5,
    phase2Trigger: 1.5,
    profitTiers: [[1.5, 0.5], [3, 1.5], [5, 3], [8, 5], [12, 8]],
    hardStop: 3,
  },
  moderate: {
    phase1MaxRetrace: 2.5,
    phase2Trigger: 2,
    profitTiers: [[2, 0.5], [3, 1], [5, 2.5], [8, 5], [12, 8], [20, 15]],
    hardStop: 5,
  },
  aggressive: {
    phase1MaxRetrace: 4,
    phase2Trigger: 3,
    profitTiers: [[3, 1], [6, 3], [10, 6], [15, 10], [25, 18]],
    hardStop: 8,
  },
};

export function createGuardState(): GuardState {
  return { phase: 1, peakRoe: 0, currentFloor: 0 };
}

export function evaluateGuard(
  roe: number,
  state: GuardState,
  config: GuardConfig,
): { action: "hold" | "close"; newState: GuardState } {
  // Update peak ROE
  const peakRoe = Math.max(state.peakRoe, roe);

  // Hard stop: always active
  if (roe <= -config.hardStop) {
    return {
      action: "close",
      newState: { ...state, peakRoe },
    };
  }

  // ── Phase 1: wide retrace tolerance ──
  if (state.phase === 1) {
    // Check if we should transition to Phase 2
    if (roe >= config.phase2Trigger) {
      // Transition to Phase 2 — find the current floor
      let floor = 0;
      for (const [trigger, lockFloor] of config.profitTiers) {
        if (roe >= trigger) floor = lockFloor;
      }
      return {
        action: "hold",
        newState: { phase: 2, peakRoe, currentFloor: floor },
      };
    }

    // Phase 1: allow retrace up to phase1MaxRetrace from peak
    const retrace = peakRoe - roe;
    if (retrace > config.phase1MaxRetrace) {
      return {
        action: "close",
        newState: { ...state, peakRoe },
      };
    }

    return {
      action: "hold",
      newState: { phase: 1, peakRoe, currentFloor: 0 },
    };
  }

  // ── Phase 2: tiered profit floors ──
  // Update floor based on current ROE
  let floor = state.currentFloor;
  for (const [trigger, lockFloor] of config.profitTiers) {
    if (roe >= trigger && lockFloor > floor) {
      floor = lockFloor;
    }
  }

  // Check if ROE dropped below current floor
  if (roe < floor) {
    return {
      action: "close",
      newState: { phase: 2, peakRoe, currentFloor: floor },
    };
  }

  return {
    action: "hold",
    newState: { phase: 2, peakRoe, currentFloor: floor },
  };
}
