import { describe, it, expect } from "vitest";
import {
  intersectBotConfig,
  readPolicyLimitsFromEnv,
  readPolicyLimitsFromOwsPolicies,
  preflightBotPolicy,
  type PolicyLimits,
} from "../guardrail/bot-preflight.js";
import type { BotConfig } from "../bot/config.js";

// ── Fixtures ──

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    name: "test-bot",
    exchange: "hyperliquid",
    symbol: "ETH",
    strategy: {
      type: "grid",
      grids: 10,
      size: 0.1,
      side: "neutral",
      range_mode: "auto",
      range_pct: 3,
      rebalance: true,
      rebalance_cooldown: 60,
    },
    entry_conditions: [{ type: "always", value: 0 }],
    exit_conditions: [],
    risk: {
      max_position_usd: 5000,
      max_daily_loss: 500,
      max_drawdown: 300,
      pause_after_loss_sec: 300,
      max_open_bots: 5,
    },
    monitor_interval_sec: 30,
    ...overrides,
  };
}

// ── readPolicyLimitsFromEnv ──

describe("readPolicyLimitsFromEnv", () => {
  it("returns empty limits when no env vars set", () => {
    const limits = readPolicyLimitsFromEnv({});
    expect(limits.maxTxUsd).toBeUndefined();
    expect(limits.maxDailyUsd).toBeUndefined();
  });

  it("parses all four PERP_POLICY_* vars", () => {
    const limits = readPolicyLimitsFromEnv({
      PERP_POLICY_MAX_TX_USD: "1000",
      PERP_POLICY_MAX_DAILY_USD: "5000",
      PERP_POLICY_MAX_WITHDRAW_USD: "200",
      PERP_POLICY_MAX_DAILY_WITHDRAW_USD: "800",
    });
    expect(limits).toEqual({
      maxTxUsd: 1000,
      maxDailyUsd: 5000,
      maxWithdrawUsd: 200,
      maxDailyWithdrawUsd: 800,
    });
  });

  it("ignores non-positive or non-numeric values", () => {
    const limits = readPolicyLimitsFromEnv({
      PERP_POLICY_MAX_TX_USD: "0",
      PERP_POLICY_MAX_DAILY_USD: "-1",
      PERP_POLICY_MAX_WITHDRAW_USD: "abc",
    });
    expect(limits.maxTxUsd).toBeUndefined();
    expect(limits.maxDailyUsd).toBeUndefined();
    expect(limits.maxWithdrawUsd).toBeUndefined();
  });
});

// ── readPolicyLimitsFromOwsPolicies ──

describe("readPolicyLimitsFromOwsPolicies", () => {
  it("returns empty limits for empty list", () => {
    expect(readPolicyLimitsFromOwsPolicies([])).toEqual({});
  });

  it("ignores policies with null/missing config", () => {
    expect(
      readPolicyLimitsFromOwsPolicies([{ id: "p1", config: null }, { id: "p2" }]),
    ).toEqual({});
  });

  it("takes the most-restrictive limit across multiple policies", () => {
    const limits = readPolicyLimitsFromOwsPolicies([
      { id: "loose", config: { max_tx_usd: 5000, max_daily_usd: 20000 } },
      { id: "tight", config: { max_tx_usd: 1000, max_daily_usd: 3000 } },
      { id: "mid", config: { max_tx_usd: 2000 } },
    ]);
    expect(limits).toEqual({ maxTxUsd: 1000, maxDailyUsd: 3000 });
  });

  it("skips invalid numeric values", () => {
    const limits = readPolicyLimitsFromOwsPolicies([
      { id: "p1", config: { max_tx_usd: 0 } },
      { id: "p2", config: { max_tx_usd: NaN } },
      { id: "p3", config: { max_tx_usd: 500 } },
    ]);
    expect(limits).toEqual({ maxTxUsd: 500 });
  });
});

// ── intersectBotConfig ──

describe("intersectBotConfig", () => {
  it("is a no-op when no limits provided", () => {
    const bot = makeBot();
    const { bot: next, notes } = intersectBotConfig(bot, {});
    expect(next.risk.max_position_usd).toBe(5000);
    expect(next.risk.max_daily_loss).toBe(500);
    // notes may contain grid-informational line, but no cap notes
    expect(notes.some(n => n.includes("capped"))).toBe(false);
  });

  it("does not mutate the original bot config", () => {
    const bot = makeBot();
    const limits: PolicyLimits = { maxTxUsd: 1000 };
    const { bot: next } = intersectBotConfig(bot, limits);
    expect(bot.risk.max_position_usd).toBe(5000);
    expect(next.risk.max_position_usd).toBe(1000);
    expect(next).not.toBe(bot);
  });

  it("caps risk.max_position_usd when maxTxUsd is tighter", () => {
    const bot = makeBot();
    const { bot: next, notes } = intersectBotConfig(bot, { maxTxUsd: 750 });
    expect(next.risk.max_position_usd).toBe(750);
    expect(notes.find(n => /max_position_usd capped \$5000 → \$750/.test(n))).toBeDefined();
  });

  it("leaves risk.max_position_usd alone when maxTxUsd is looser", () => {
    const bot = makeBot({
      risk: {
        max_position_usd: 500,
        max_daily_loss: 100,
        max_drawdown: 200,
        pause_after_loss_sec: 300,
        max_open_bots: 5,
      },
    });
    const { bot: next, notes } = intersectBotConfig(bot, { maxTxUsd: 10_000 });
    expect(next.risk.max_position_usd).toBe(500);
    expect(notes.some(n => /max_position_usd capped/.test(n))).toBe(false);
  });

  it("caps risk.max_daily_loss when maxDailyUsd is tighter", () => {
    const bot = makeBot();
    const { bot: next, notes } = intersectBotConfig(bot, { maxDailyUsd: 250 });
    expect(next.risk.max_daily_loss).toBe(250);
    expect(notes.find(n => /max_daily_loss capped \$500 → \$250/.test(n))).toBeDefined();
  });

  it("caps funding-arb strategy.size_usd when tighter than maxTxUsd", () => {
    const bot = makeBot({
      strategy: {
        type: "funding-arb",
        min_spread: 20,
        close_spread: 5,
        size_usd: 2000,
        max_positions: 3,
        exchanges: ["pacifica", "hyperliquid"],
      },
    });
    const { bot: next, notes } = intersectBotConfig(bot, { maxTxUsd: 400 });
    expect((next.strategy as { size_usd: number }).size_usd).toBe(400);
    expect(notes.find(n => /size_usd capped \$2000 → \$400/.test(n))).toBeDefined();
  });

  it("emits an informational note for grid strategies (base-unit sizing)", () => {
    const bot = makeBot();
    const { notes } = intersectBotConfig(bot, { maxTxUsd: 1000 });
    expect(notes.find(n => /grid size=/.test(n) && /max_position_usd=1000 enforced/.test(n))).toBeDefined();
  });

  it("emits an informational note for dca strategies", () => {
    const bot = makeBot({
      strategy: {
        type: "dca",
        amount: 0.05,
        interval_sec: 60,
        total_orders: 10,
      },
    });
    const { notes } = intersectBotConfig(bot, { maxTxUsd: 500 });
    expect(notes.find(n => /dca size=0.05/.test(n))).toBeDefined();
  });
});

// ── preflightBotPolicy ──

describe("preflightBotPolicy", () => {
  it("is a no-op when env is empty and no OWS loader provided (no OWS_API_KEY)", async () => {
    const bot = makeBot();
    const { bot: next, notes } = await preflightBotPolicy(bot, {
      env: {}, // no OWS_API_KEY, no PERP_POLICY_*
    });
    expect(next.risk.max_position_usd).toBe(5000);
    expect(notes).toEqual([]);
  });

  it("reads env limits and applies caps", async () => {
    const bot = makeBot();
    const { bot: next, notes } = await preflightBotPolicy(bot, {
      env: { PERP_POLICY_MAX_TX_USD: "800", PERP_POLICY_MAX_DAILY_USD: "200" },
    });
    expect(next.risk.max_position_usd).toBe(800);
    expect(next.risk.max_daily_loss).toBe(200);
    expect(notes.find(n => /applying caps from/.test(n))).toBeDefined();
  });

  it("reads OWS policy loader when provided and merges with env (min wins)", async () => {
    const bot = makeBot();
    const { bot: next } = await preflightBotPolicy(bot, {
      env: { PERP_POLICY_MAX_TX_USD: "2000" },
      loadPolicies: () => [{ id: "strict", config: { max_tx_usd: 500 } }],
    });
    expect(next.risk.max_position_usd).toBe(500);
  });

  it("swallows loader errors and emits a warning note", async () => {
    const bot = makeBot();
    const { bot: next, notes } = await preflightBotPolicy(bot, {
      env: {},
      loadPolicies: () => {
        throw new Error("vault locked");
      },
    });
    expect(next.risk.max_position_usd).toBe(5000);
    expect(notes.find(n => /policy lookup failed.*vault locked/.test(n))).toBeDefined();
  });
});
