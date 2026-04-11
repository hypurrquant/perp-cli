/**
 * Preemptive OWS policy cap for bot configs.
 *
 * When a bot runs with `--ows-key` / `OWS_API_KEY`, every signing request is
 * already guarded by `perp-guardrail`. But the guardrail only denies *after*
 * the order is submitted, which means a bot can fire N hopeless orders per
 * tick before giving up.
 *
 * This module pulls policy limits from two best-effort sources at bot start:
 *   1. Environment variables (`PERP_POLICY_MAX_TX_USD`, `PERP_POLICY_MAX_DAILY_USD`)
 *   2. OWS policy records (via `loadOws().listPolicies()` when the SDK is usable)
 *
 * ...then intersects them with the bot's own risk config so order sizing
 * respects the stricter of the two. Pure decision logic lives in
 * `intersectBotConfig()` and is directly unit-testable without touching OWS.
 */

import type { BotConfig, StrategyParams, FundingArbStrategyParams, GridStrategyParams, DCAStrategyParams } from "../bot/config.js";

export interface PolicyLimits {
  maxTxUsd?: number;
  maxDailyUsd?: number;
  maxWithdrawUsd?: number;
  maxDailyWithdrawUsd?: number;
}

export interface PreflightResult {
  bot: BotConfig;
  notes: string[];
}

/** Source name → limits. Later sources override earlier keys but always keep the min. */
interface LabeledLimits {
  source: string;
  limits: PolicyLimits;
}

function mergeLimits(sources: LabeledLimits[]): { merged: PolicyLimits; provenance: Record<string, string> } {
  const merged: PolicyLimits = {};
  const provenance: Record<string, string> = {};
  const keys = ["maxTxUsd", "maxDailyUsd", "maxWithdrawUsd", "maxDailyWithdrawUsd"] as const;

  for (const { source, limits } of sources) {
    for (const key of keys) {
      const v = limits[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
      if (merged[key] === undefined || v < (merged[key] as number)) {
        merged[key] = v;
        provenance[key] = source;
      }
    }
  }
  return { merged, provenance };
}

/** Read policy limits from process.env. All fields are optional. */
export function readPolicyLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): PolicyLimits {
  const limits: PolicyLimits = {};
  const parse = (v: string | undefined): number | undefined => {
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  limits.maxTxUsd = parse(env.PERP_POLICY_MAX_TX_USD);
  limits.maxDailyUsd = parse(env.PERP_POLICY_MAX_DAILY_USD);
  limits.maxWithdrawUsd = parse(env.PERP_POLICY_MAX_WITHDRAW_USD);
  limits.maxDailyWithdrawUsd = parse(env.PERP_POLICY_MAX_DAILY_WITHDRAW_USD);
  return limits;
}

/** Shape of a single OWS policy record we care about (loose — SDK types may vary). */
interface OwsPolicyLike {
  id?: string;
  config?: {
    max_tx_usd?: number;
    max_daily_usd?: number;
    max_withdraw_usd?: number;
    max_daily_withdraw_usd?: number;
  } | null;
}

/**
 * Best-effort read of OWS policy limits. Returns the most-restrictive limits
 * across the provided policy list (or an empty record if none / on error).
 * Pure w.r.t. inputs — pass `loadPolicies` in tests to avoid touching the vault.
 */
export function readPolicyLimitsFromOwsPolicies(policies: OwsPolicyLike[]): PolicyLimits {
  const merged: PolicyLimits = {};
  for (const p of policies) {
    const c = p.config;
    if (!c) continue;
    const pairs: Array<[keyof PolicyLimits, number | undefined]> = [
      ["maxTxUsd", c.max_tx_usd],
      ["maxDailyUsd", c.max_daily_usd],
      ["maxWithdrawUsd", c.max_withdraw_usd],
      ["maxDailyWithdrawUsd", c.max_daily_withdraw_usd],
    ];
    for (const [key, v] of pairs) {
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) continue;
      if (merged[key] === undefined || v < (merged[key] as number)) {
        merged[key] = v;
      }
    }
  }
  return merged;
}

/**
 * Intersect bot config with policy limits. Pure function — no side effects.
 *
 * Currently caps:
 *  - `risk.max_position_usd`  ← `maxTxUsd`
 *  - `risk.max_daily_loss`    ← `maxDailyUsd` (daily PnL drawdown ≤ daily spend cap)
 *  - `strategy.size_usd` for funding-arb ← `maxTxUsd`
 *  - `strategy.upper` for grid is untouched; we only size-cap via `risk.max_position_usd`
 *    because grid size is in base units and needs market price to convert.
 */
export function intersectBotConfig(
  config: BotConfig,
  limits: PolicyLimits,
): PreflightResult {
  const notes: string[] = [];
  // shallow clone so callers can rely on immutability
  const next: BotConfig = {
    ...config,
    risk: { ...config.risk },
    strategy: { ...(config.strategy as Record<string, unknown>) } as StrategyParams,
  };

  if (typeof limits.maxTxUsd === "number") {
    const cap = limits.maxTxUsd;
    if (next.risk.max_position_usd > cap) {
      notes.push(
        `[ows-policy] risk.max_position_usd capped $${next.risk.max_position_usd} → $${cap}`,
      );
      next.risk.max_position_usd = cap;
    }

    // funding-arb strategy carries an explicit USD notional
    if (next.strategy.type === "funding-arb") {
      const strat = next.strategy as FundingArbStrategyParams;
      if (typeof strat.size_usd === "number" && strat.size_usd > cap) {
        notes.push(
          `[ows-policy] strategy.size_usd capped $${strat.size_usd} → $${cap}`,
        );
        strat.size_usd = cap;
      }
    }
  }

  if (typeof limits.maxDailyUsd === "number") {
    const cap = limits.maxDailyUsd;
    if (next.risk.max_daily_loss > cap) {
      notes.push(
        `[ows-policy] risk.max_daily_loss capped $${next.risk.max_daily_loss} → $${cap}`,
      );
      next.risk.max_daily_loss = cap;
    }
  }

  // Grid/DCA carry size in base units; we can't cap without a live price.
  // Surface a warning so the operator notices when a preemptive cap wouldn't
  // apply to their strategy.
  if (
    typeof limits.maxTxUsd === "number" &&
    (next.strategy.type === "grid" || next.strategy.type === "dca")
  ) {
    const sizeField =
      next.strategy.type === "grid"
        ? (next.strategy as GridStrategyParams).size
        : (next.strategy as DCAStrategyParams).amount;
    notes.push(
      `[ows-policy] ${next.strategy.type} size=${sizeField} (base units); risk.max_position_usd=${next.risk.max_position_usd} enforced instead`,
    );
  }

  return { bot: next, notes };
}

/**
 * Full preflight pipeline. Gathers limits from all available sources and
 * intersects them with the bot config.
 *
 * Sources are plugged in for testability — pass `loadPolicies` to avoid
 * touching the real OWS vault during tests. In production (no overrides):
 *  - env vars are always read
 *  - OWS policies are only queried when `OWS_API_KEY` is set on the process
 */
export async function preflightBotPolicy(
  config: BotConfig,
  opts?: {
    env?: NodeJS.ProcessEnv;
    loadPolicies?: () => OwsPolicyLike[] | Promise<OwsPolicyLike[]>;
  },
): Promise<PreflightResult> {
  const env = opts?.env ?? process.env;
  const envLimits = readPolicyLimitsFromEnv(env);

  let owsLimits: PolicyLimits = {};
  let owsError: string | undefined;
  const owsKeyPresent = Boolean(env.OWS_API_KEY);
  if (owsKeyPresent || opts?.loadPolicies) {
    try {
      const loader = opts?.loadPolicies ?? (async () => {
        const { loadOws } = await import("../signer/ows-loader.js");
        const ows = loadOws() as unknown as { listPolicies?: () => OwsPolicyLike[] };
        return ows.listPolicies ? ows.listPolicies() : [];
      });
      const policies = await Promise.resolve(loader());
      owsLimits = readPolicyLimitsFromOwsPolicies(policies);
    } catch (e) {
      owsError = e instanceof Error ? e.message : String(e);
    }
  }

  const { merged, provenance } = mergeLimits([
    { source: "env", limits: envLimits },
    { source: "ows-policy", limits: owsLimits },
  ]);

  const hasAny =
    merged.maxTxUsd !== undefined ||
    merged.maxDailyUsd !== undefined ||
    merged.maxWithdrawUsd !== undefined ||
    merged.maxDailyWithdrawUsd !== undefined;

  const notes: string[] = [];
  if (owsError) {
    notes.push(`[ows-policy] policy lookup failed: ${owsError} (continuing without cap)`);
  }
  if (!hasAny) {
    return { bot: config, notes };
  }

  const sourceSummary = Object.entries(provenance)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  notes.push(`[ows-policy] applying caps from { ${sourceSummary} }`);

  const result = intersectBotConfig(config, merged);
  return { bot: result.bot, notes: [...notes, ...result.notes] };
}
