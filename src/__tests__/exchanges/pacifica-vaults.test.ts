/**
 * Pacifica vaults (lakes): request building against the docs examples
 * (api-documentation/api/rest-api/vaults/deposit-to-vault, withdraw-from-vault), parsing of the
 * live /lake/list (fixture 2026-10-19: omitted config fields, 28-digit balances) and of the docs
 * example, and the deposit / withdraw rules of docs vaults/depositing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { envelopeData } from "../../exchanges/pacifica-print.js";
import {
  buildVaultDepositRequest, buildVaultWithdrawRequest, findVault, heldShares, parseVault, parseVaultList,
  planVaultDeposit, planVaultWithdraw, withdrawWindowAt, type PacificaVault,
} from "../../exchanges/pacifica-vaults.js";

const FX = resolve(__dirname, "../fixtures/pacifica-earn");
const fx = (n: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(FX, n), "utf8")) as Record<string, unknown>;
const live = parseVaultList(envelopeData(fx("lake-list.json"), "/lake/list"));

// docs list-vaults response example
const DOC_LAKE = {
  address: "AbCdEfGh123456789...", creator: "42trU9A5...", manager: "8zFqj1Kp...", nickname: "BTC Basis Vault",
  lp_shares: "900000.00", manager_shares: "100000.00", lp_balance: "910000.00", manager_balance: "115000.00",
  last_checked_equity: "1025000.00", high_watermark: "1025000.00", created_at: 1700000000000, referrer: "7xyReferrer...", user_share: "500.00",
  config: { deposit_cap: "1000000.00", manager_profit_share: "0.20", manager_loss_share: "0", deposit_min_duration_ms: 86400000, manager_min_balance_portion: "0.10", manager_liquidation_balance_portion: "0.05", withdraw_window_s: 2592000, withdraw_duration_s: 259200 },
};
const doc = parseVault(DOC_LAKE);
const LP = "LpAccount1111111111111111111111111111111111";

describe("docs examples: deposit_to_lake / withdraw_from_lake", () => {
  it("deposit body and canonical message", () => {
    const r = buildVaultDepositRequest("AbCdEfGh123456789...", "1000.00", { account: "42trU9A5...", agentWallet: null }, { timestamp: 1716200000000, idempotencyKey: "550e8400-e29b-41d4-a716-446655440000", expiryWindow: 30000 });
    expect(r.path).toBe("/lake/deposit");
    expect(r.body).toEqual({ account: "42trU9A5...", timestamp: 1716200000000, expiry_window: 30000, lake: "AbCdEfGh123456789...", amount: "1000.00", idempotency_key: "550e8400-e29b-41d4-a716-446655440000" });
    expect(r.message).toBe('{"data":{"amount":"1000.00","idempotency_key":"550e8400-e29b-41d4-a716-446655440000","lake":"AbCdEfGh123456789..."},"expiry_window":30000,"timestamp":1716200000000,"type":"deposit_to_lake"}');
  });

  it("withdraw body has no destination: always the signing account", () => {
    const r = buildVaultWithdrawRequest("AbCdEfGh123456789...", "50.00", { account: "42trU9A5...", agentWallet: "69trU9A5..." }, { timestamp: 1716200000000, idempotencyKey: "550e8400-e29b-41d4-a716-446655440000", expiryWindow: 30000 });
    expect(r.type).toBe("withdraw_from_lake");
    expect(r.body).toEqual({ account: "42trU9A5...", agent_wallet: "69trU9A5...", timestamp: 1716200000000, expiry_window: 30000, lake: "AbCdEfGh123456789...", shares: "50.00", idempotency_key: "550e8400-e29b-41d4-a716-446655440000" });
    expect(Object.keys(r.body).some((k) => /dest|to|recipient/.test(k))).toBe(false);
    expect(r.message).toBe('{"data":{"idempotency_key":"550e8400-e29b-41d4-a716-446655440000","lake":"AbCdEfGh123456789...","shares":"50.00"},"expiry_window":30000,"timestamp":1716200000000,"type":"withdraw_from_lake"}');
  });
});

describe("parsing", () => {
  it("docs example: NAV per share, TVL, config, user_share", () => {
    expect(doc).toMatchObject({
      schema: 1, tvl: "1025000", navPerLpShare: "1.011111111111", navPerManagerShare: "1.15", apy: null, userShares: "500",
      config: { depositCap: "1000000", managerProfitShare: "0.2", depositMinDurationMs: 86400000, withdrawWindowS: 2592000, withdrawDurationS: 259200 },
    });
  });

  it("live list: omitted config fields → null (never 0), long decimals exact", () => {
    expect(live.length).toBe(5);
    const hatch = findVault(live, "The Hatch");
    expect(hatch.config.depositCap).toBeNull();
    expect(hatch.config.withdrawWindowS).toBeNull();
    expect(hatch.lpBalance).toMatch(/^\d+\.\d{20,}$/);
    expect(hatch.navPerLpShare).toMatch(/^1\.\d+$/);
    const windowed = live.find((v) => v.config.withdrawWindowS !== null);
    expect(windowed?.config).toMatchObject({ withdrawWindowS: 604800, withdrawDurationS: 86400, depositMinDurationMs: 86400000 });
    const noConfig = live.find((v) => v.config.managerProfitShare === null && v.config.depositCap === null);
    expect(noConfig).toBeDefined();
  });

  it("an empty LP class has no NAV (the next deposit mints 1:1)", () => {
    const empty = live.find((v) => v.lpShares === "0");
    expect(empty?.navPerLpShare).toBeNull();
  });

  it("missing balances → EXCHANGE_ERROR; lookup by address or exact nickname", () => {
    expect(() => parseVault({ ...DOC_LAKE, lp_balance: undefined })).toThrow(/lp_balance/);
    expect(() => parseVaultList({})).toThrow(/lakes/);
    expect(findVault(live, hatchAddr()).nickname).toBe("The Hatch");
    expect(() => findVault(live, "nope")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND" }) }));
  });
});

function hatchAddr(): string { return findVault(live, "The Hatch").address; }

describe("findVault: duplicate nicknames are never resolved silently", () => {
  // live /lake/list 2026-10-19: "Pacifica Vault" (49CuhGAM…) and "Pacifica vault" (6zZcfPBx…), different managers
  const a = parseVault({ ...DOC_LAKE, address: "49CuhGAMaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", nickname: "Pacifica Vault", manager: "4kfunezuMgrA" });
  const b = parseVault({ ...DOC_LAKE, address: "6zZcfPBxbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", nickname: "Pacifica vault", manager: "9oR4tFBZMgrB" });
  const list = [b, a, doc];
  it("2+ case-insensitive matches → INVALID_PARAMS listing every candidate (address, manager, TVL)", () => {
    for (const ref of ["Pacifica Vault", "pacifica vault", "Pacifica vault"]) {
      try { findVault(list, ref); throw new Error("no throw"); } catch (e) {
        const st = (e as { structured: { code: string; message: string; details: { candidates: Array<{ address: string; manager: string; tvl: string }> } } }).structured;
        expect(st.code).toBe("INVALID_PARAMS");
        expect(st.details.candidates.map((c) => c.address).sort()).toEqual([a.address, b.address].sort());
        expect(st.details.candidates[0]).toHaveProperty("tvl");
        expect(st.message).toMatch(/4kfunezuMgrA/);
        expect(st.message).toMatch(/9oR4tFBZMgrB/);
      }
    }
  });
  it("the address always resolves; a unique nickname resolves", () => {
    expect(findVault(list, b.address)).toBe(b);
    expect(findVault(list, "btc basis vault")).toBe(doc);
  });
});

describe("withdrawal window (epoch-anchored, docs example: 1h every day)", () => {
  const c = { ...doc.config, withdrawWindowS: 86400, withdrawDurationS: 3600 };
  it("open 00:00–01:00 UTC, closed after", () => {
    expect(withdrawWindowAt(c, Date.UTC(2026, 9, 19, 0, 30))).toEqual({ restricted: true, open: true, nextChangeAt: Date.UTC(2026, 9, 19, 1, 0) });
    expect(withdrawWindowAt(c, Date.UTC(2026, 9, 19, 1, 0))).toEqual({ restricted: true, open: false, nextChangeAt: Date.UTC(2026, 9, 20, 0, 0) });
  });
  it("unset → unrestricted", () => {
    expect(withdrawWindowAt({ ...c, withdrawWindowS: null }, 0)).toEqual({ restricted: false, open: true, nextChangeAt: null });
  });
});

describe("planVaultDeposit", () => {
  const ok = { availableToWithdraw: "1000", whitelist: [] as string[] };
  const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { structured?: { code: string } }).structured?.code; } return undefined; };

  it("min 10 USDC, USDC decimals, available_to_withdraw", () => {
    expect(code(() => planVaultDeposit(doc, LP, "9.99", ok))).toBe("INVALID_PARAMS");
    expect(code(() => planVaultDeposit(doc, LP, "10.0000001", ok))).toBe("INVALID_PARAMS");
    expect(code(() => planVaultDeposit(doc, LP, "1000.01", ok))).toBe("INSUFFICIENT_BALANCE");
  });

  it("deposit cap counts the LP balance (manager deposits are not capped)", () => {
    expect(code(() => planVaultDeposit(doc, LP, "90000.01", { ...ok, availableToWithdraw: "1000000" }))).toBe("INVALID_PARAMS");
    expect(code(() => planVaultDeposit(doc, LP, "90000", { ...ok, availableToWithdraw: "1000000" }))).toBeUndefined();
    expect(planVaultDeposit(doc, "8zFqj1Kp...", "200000", { ...ok, availableToWithdraw: "1000000" }).role).toBe("manager");
  });

  it("deposit whitelist (unofficial endpoint) is advisory: a warning, the venue's refusal is final", () => {
    const excluded = planVaultDeposit(doc, LP, "10", { ...ok, whitelist: ["Someone"] });
    expect(excluded.warnings.join(" ")).toMatch(/unofficial endpoint.*will likely refuse/);
    expect(planVaultDeposit(doc, LP, "10", { ...ok, whitelist: null }).warnings.join(" ")).toMatch(/whitelist unknown/);
    expect(planVaultDeposit(doc, LP, "10", { ...ok, whitelist: [LP] }).warnings.join(" ")).not.toMatch(/whitelist/);
  });

  it("refuses a class whose NAV is zero or undefined (live XAU_Stable_Growth: lp_shares 10, lp_balance 0)", () => {
    const zero = parseVault({ ...DOC_LAKE, nickname: "XAU_Stable_Growth", lp_shares: "10.00000000000000330077666654", lp_balance: "0", user_share: null });
    expect(code(() => planVaultDeposit(zero, LP, "10", ok))).toBe("INVALID_PARAMS");
    const undef = parseVault({ ...DOC_LAKE, lp_shares: "0", lp_balance: "5", user_share: null });
    expect(code(() => planVaultDeposit(undef, LP, "10", ok))).toBe("INVALID_PARAMS");
    const empty = parseVault({ ...DOC_LAKE, lp_shares: "0", lp_balance: "0", user_share: null });
    expect(planVaultDeposit(empty, LP, "10", ok).estimatedShares).toBe("10"); // 1:1
  });

  it("the plan names the resolved vault address and manager; leading zeros refused", () => {
    expect(planVaultDeposit(doc, LP, "10", ok)).toMatchObject({ vault: doc.address, manager: doc.manager });
    expect(planVaultDeposit(doc, LP, "10", ok).warnings.join(" ")).toMatch(/Manager: 8zFqj1Kp/);
    expect(code(() => planVaultDeposit(doc, LP, "010", ok))).toBe("INVALID_PARAMS");
  });

  it("warns about the lock-up reset, window and fee; estimates shares at NAV", () => {
    const p = planVaultDeposit(doc, LP, "91", ok); // 91 × 900000 ÷ 910000 = 90
    expect(p.warnings.join(" ")).toMatch(/restarts for your WHOLE balance/);
    expect(p.warnings.join(" ")).toMatch(/Withdrawals open only/);
    expect(p.estimatedShares).toBe("90");
  });
});

describe("planVaultWithdraw", () => {
  const now = Date.UTC(2026, 9, 1, 12); // 2592000 s window: open in the first 3 days of each 30-day period
  const unrestricted: PacificaVault = { ...doc, config: { ...doc.config, withdrawWindowS: null, withdrawDurationS: null } };
  const code = (f: () => unknown) => { try { f(); } catch (e) { return (e as { structured?: { code: string } }).structured?.code; } return undefined; };

  it("LP: up to user_share; --all; estimate = shares × NAV; destination = the account", () => {
    const p = planVaultWithdraw(unrestricted, LP, "all", { nowMs: now, vaultAvailableToWithdraw: "1000000" });
    expect(p).toMatchObject({ role: "lp", shares: "500", destination: LP, estimatedAmount: "505.5555555555" });
    expect(code(() => planVaultWithdraw(unrestricted, LP, "500.01", { nowMs: now, vaultAvailableToWithdraw: null }))).toBe("SIZE_TOO_LARGE");
    expect(code(() => planVaultWithdraw(unrestricted, LP, "-1", { nowMs: now, vaultAvailableToWithdraw: null }))).toBe("INVALID_PARAMS");
    expect(code(() => planVaultWithdraw(unrestricted, LP, "010", { nowMs: now, vaultAvailableToWithdraw: null }))).toBe("INVALID_PARAMS");
  });

  it("manager redeems manager shares", () => {
    expect(heldShares(doc, "8zFqj1Kp...")).toEqual({ role: "manager", shares: "100000", nav: "1.15" });
  });

  it("no shares → POSITION_NOT_FOUND", () => {
    expect(code(() => planVaultWithdraw({ ...unrestricted, userShares: null }, LP, "1", { nowMs: now, vaultAvailableToWithdraw: null }))).toBe("POSITION_NOT_FOUND");
  });

  it("closed window → POLICY_DENIED with the next opening", () => {
    const closed = Date.UTC(2026, 9, 25);
    expect(withdrawWindowAt(doc.config, closed).open).toBe(false);
    expect(code(() => planVaultWithdraw(doc, LP, "1", { nowMs: closed, vaultAvailableToWithdraw: null }))).toBe("POLICY_DENIED");
  });

  it("warns when the vault's free balance may not cover it, and about the lock-up", () => {
    const p = planVaultWithdraw(unrestricted, LP, "500", { nowMs: now, vaultAvailableToWithdraw: "100" });
    expect(p.warnings.join(" ")).toMatch(/may pay only part/);
    expect(p.warnings.join(" ")).toMatch(/most recent deposit/);
  });
});
