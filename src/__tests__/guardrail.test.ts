import { describe, it, expect } from "vitest";
import { evaluate, isWithdrawTx, weiToUsd, type PolicyContext } from "../guardrail/policy.js";
import { ALLOWED_CHAINS } from "../guardrail/contracts.js";

// ── Fixture helpers ──

const ARB_CHAIN = "eip155:42161";
const HL_SIGNING_CHAIN = "eip155:1337";
const CCTP_V2_TOKEN_MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const ARBITRUM_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

function makeCtx(overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    chain_id: ARB_CHAIN,
    wallet_id: "w1",
    api_key_id: "k1",
    transaction: { to: CCTP_V2_TOKEN_MESSENGER, value: "0", data: "0x" },
    spending: { daily_total: "0", date: "2026-04-12" },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// ── weiToUsd ──

describe("weiToUsd", () => {
  it("converts 1 ETH @ $3500 → 3500", () => {
    expect(weiToUsd("1000000000000000000", 3500)).toBeCloseTo(3500);
  });

  it("handles empty string → 0", () => {
    expect(weiToUsd("", 3500)).toBe(0);
  });

  it("handles large values without overflow", () => {
    // 1000 ETH @ $3500 = $3,500,000
    expect(weiToUsd("1000000000000000000000", 3500)).toBeCloseTo(3_500_000);
  });
});

// ── isWithdrawTx ──

describe("isWithdrawTx", () => {
  it("detects withdraw() selector 0x3ccfd60b", () => {
    expect(isWithdrawTx("0x3ccfd60b")).toBe(true);
  });

  it("detects withdraw(uint256) selector 0x2e1a7d4d", () => {
    expect(isWithdrawTx("0x2e1a7d4d00000000000000000000000000000000000000000000000000000000000003e8")).toBe(true);
  });

  it("returns false for empty / 0x data", () => {
    expect(isWithdrawTx(undefined)).toBe(false);
    expect(isWithdrawTx("0x")).toBe(false);
  });

  it("returns false for non-withdraw selectors", () => {
    expect(isWithdrawTx("0xa9059cbb")).toBe(false);
  });
});

// ── evaluate: chain whitelist ──

describe("evaluate — chain whitelist", () => {
  it("denies a chain outside the allowed list", () => {
    const res = evaluate(makeCtx({ chain_id: "eip155:999999" }));
    expect(res.allow).toBe(false);
    expect(res.reason).toMatch(/chain eip155:999999 not in allowed list/);
  });

  it("allows each chain in the default ALLOWED_CHAINS list", () => {
    for (const chain of ALLOWED_CHAINS) {
      // Use a signing-only fixture so contract whitelist never rejects us.
      const res = evaluate(makeCtx({ chain_id: chain, transaction: { to: undefined, value: "0" } }));
      expect(res.allow, `chain ${chain} should pass`).toBe(true);
    }
  });
});

// ── evaluate: contract whitelist ──

describe("evaluate — contract whitelist", () => {
  it("allows a whitelisted Arbitrum contract (CCTP token messenger)", () => {
    expect(evaluate(makeCtx()).allow).toBe(true);
  });

  it("denies a non-whitelisted Arbitrum contract", () => {
    const res = evaluate(
      makeCtx({ transaction: { to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", value: "0", data: "0x" } }),
    );
    expect(res.allow).toBe(false);
    expect(res.reason).toMatch(/not whitelisted/);
  });

  it("is case-insensitive on contract address match", () => {
    const res = evaluate(
      makeCtx({ transaction: { to: CCTP_V2_TOKEN_MESSENGER.toLowerCase(), value: "0", data: "0x" } }),
    );
    expect(res.allow).toBe(true);
  });

  it("skips contract whitelist for signing-only chains (empty whitelist)", () => {
    const res = evaluate(
      makeCtx({ chain_id: HL_SIGNING_CHAIN, transaction: { to: "0x0000000000000000000000000000000000000000", value: "0" } }),
    );
    expect(res.allow).toBe(true);
  });
});

// ── evaluate: blocked selectors ──

describe("evaluate — blocked selectors", () => {
  it("denies approve() when block_selectors contains it", () => {
    const res = evaluate(
      makeCtx({
        transaction: { to: ARBITRUM_USDC, value: "0", data: "0x095ea7b300000000000000000000000000000000000000000000000000000000" },
        policy_config: { block_selectors: ["0x095ea7b3"] },
      }),
    );
    expect(res.allow).toBe(false);
    expect(res.reason).toMatch(/approve is blocked/);
  });

  it("denies transferFrom() when blocked", () => {
    const res = evaluate(
      makeCtx({
        transaction: { to: ARBITRUM_USDC, value: "0", data: "0x23b872dd" },
        policy_config: { block_selectors: ["0x23b872dd"] },
      }),
    );
    expect(res.allow).toBe(false);
    expect(res.reason).toMatch(/transferFrom is blocked/);
  });

  it("is case-insensitive on selector match", () => {
    const res = evaluate(
      makeCtx({
        transaction: { to: ARBITRUM_USDC, value: "0", data: "0x095EA7B3" },
        policy_config: { block_selectors: ["0x095ea7b3"] },
      }),
    );
    expect(res.allow).toBe(false);
  });

  it("allows when block_selectors is empty (default)", () => {
    const res = evaluate(
      makeCtx({
        transaction: { to: ARBITRUM_USDC, value: "0", data: "0x095ea7b3" },
      }),
    );
    expect(res.allow).toBe(true);
  });
});

// ── evaluate: per-tx USD cap ──

describe("evaluate — per-tx USD cap", () => {
  it("denies when tx value exceeds max_tx_usd", () => {
    const res = evaluate(
      makeCtx({
        transaction: { to: CCTP_V2_TOKEN_MESSENGER, value: "1000000000000000000", data: "0x" }, // 1 ETH
        policy_config: { max_tx_usd: 100, eth_price_usd: 3500 },                                // cap $100 < $3500
      }),
    );
    expect(res.allow).toBe(false);
    expect(res.reason).toMatch(/tx value.*exceeds limit/);
  });

  it("allows when tx value is under max_tx_usd", () => {
    const res = evaluate(
      makeCtx({
        transaction: { to: CCTP_V2_TOKEN_MESSENGER, value: "10000000000000000", data: "0x" }, // 0.01 ETH ≈ $35
        policy_config: { max_tx_usd: 100, eth_price_usd: 3500 },
      }),
    );
    expect(res.allow).toBe(true);
  });
});

// ── evaluate: withdrawal limits ──

describe("evaluate — withdrawal limits", () => {
  const WITHDRAW_DATA = "0x3ccfd60b";

  it("denies withdrawal when value exceeds max_withdraw_usd", () => {
    const res = evaluate(
      makeCtx({
        transaction: { to: CCTP_V2_TOKEN_MESSENGER, value: "200000000000000000", data: WITHDRAW_DATA }, // 0.2 ETH ≈ $700
        policy_config: { max_tx_usd: 10000, max_withdraw_usd: 500, eth_price_usd: 3500 },
      }),
    );
    expect(res.allow).toBe(false);
    expect(res.reason).toMatch(/withdrawal.*exceeds per-tx limit/);
  });

  it("denies withdrawal when daily cumulative exceeds max_daily_withdraw_usd", () => {
    const res = evaluate(
      makeCtx({
        transaction: { to: CCTP_V2_TOKEN_MESSENGER, value: "10000000000000000", data: WITHDRAW_DATA }, // small
        spending: { daily_total: "1000000000000000000", date: "2026-04-12" },                          // 1 ETH ≈ $3500
        policy_config: { max_tx_usd: 5000, max_daily_usd: 10000, max_daily_withdraw_usd: 2000, eth_price_usd: 3500 },
      }),
    );
    expect(res.allow).toBe(false);
    expect(res.reason).toMatch(/daily withdrawals.*exceeds limit/);
  });

  it("allows withdrawal within per-tx and daily caps", () => {
    const res = evaluate(
      makeCtx({
        transaction: { to: CCTP_V2_TOKEN_MESSENGER, value: "10000000000000000", data: WITHDRAW_DATA }, // 0.01 ETH ≈ $35
        spending: { daily_total: "50000000000000000", date: "2026-04-12" },                           // 0.05 ETH ≈ $175
        policy_config: { max_tx_usd: 5000, max_daily_usd: 10000, max_withdraw_usd: 500, max_daily_withdraw_usd: 2000, eth_price_usd: 3500 },
      }),
    );
    expect(res.allow).toBe(true);
  });
});

// ── evaluate: daily spending limit ──

describe("evaluate — daily spending limit", () => {
  it("denies when daily total exceeds max_daily_usd", () => {
    const res = evaluate(
      makeCtx({
        transaction: { to: CCTP_V2_TOKEN_MESSENGER, value: "0", data: "0x" },
        spending: { daily_total: "2000000000000000000", date: "2026-04-12" }, // 2 ETH ≈ $7000
        policy_config: { max_daily_usd: 5000, eth_price_usd: 3500 },
      }),
    );
    expect(res.allow).toBe(false);
    expect(res.reason).toMatch(/daily spending.*exceeds limit/);
  });

  it("allows when daily total is under max_daily_usd", () => {
    const res = evaluate(
      makeCtx({
        spending: { daily_total: "100000000000000000", date: "2026-04-12" }, // 0.1 ETH ≈ $350
        policy_config: { max_daily_usd: 5000, eth_price_usd: 3500 },
      }),
    );
    expect(res.allow).toBe(true);
  });
});

// ── evaluate: defaults fallback ──

describe("evaluate — defaults fallback", () => {
  it("uses DEFAULT_LIMITS when policy_config omitted", () => {
    // DEFAULT_LIMITS.max_tx_usd = 1000 ⇒ 1 ETH @ $3500 denied
    const res = evaluate(
      makeCtx({
        transaction: { to: CCTP_V2_TOKEN_MESSENGER, value: "1000000000000000000", data: "0x" },
      }),
    );
    expect(res.allow).toBe(false);
    expect(res.reason).toMatch(/exceeds limit/);
  });

  it("accepts a clean signing-only tx with no policy_config", () => {
    const res = evaluate(
      makeCtx({ chain_id: HL_SIGNING_CHAIN, transaction: { to: undefined, value: "0", data: "0x" } }),
    );
    expect(res.allow).toBe(true);
  });
});
