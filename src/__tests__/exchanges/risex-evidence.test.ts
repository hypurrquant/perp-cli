/**
 * Committed evidence behind two RISEx decisions:
 *  - fundingVerified: payment = position size × index price × rate for the hour, the rate equals the
 *    settled history print, the period is one hour, and a positive payment means the account PAID
 *    (fixture: raw public records from 6 mainnet accounts);
 *  - the signer restriction model (permission ids, signer-signed DisablePermission, account-only
 *    EnablePermission, argument order) as recorded on chain.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { keccak256, toUtf8Bytes, id } from "ethers";
import { RISEX_AUTH_IFACE, RISEX_NON_TRADING_PERMISSIONS, RISEX_TRADING_PERMISSION, RISEX_PERMISSION_IDS, typeHash, typeString } from "../../exchanges/risex/typed-data.js";
import { RISEX_FUNDING_INTERVAL_NS } from "../../exchanges/risex/public.js";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "risex");
const funding = JSON.parse(readFileSync(resolve(DIR, "funding-payments-evidence.json"), "utf-8")) as {
  records: Array<{ account: string; market_id: string; side: string; position_size: string; funding_payment: string; funding_rate: string; block_time: string;
    history: { funding_rate: string; index_price: string; start_time: string; end_time: string } }>;
};
const perms = JSON.parse(readFileSync(resolve(DIR, "permissions-evidence.json"), "utf-8"));

describe("RISEx funding evidence (fundingVerified: true)", () => {
  const rs = funding.records;

  it("covers ≥3 accounts, many markets and periods", () => {
    expect(new Set(rs.map(r => r.account)).size).toBeGreaterThanOrEqual(3);
    expect(new Set(rs.map(r => r.market_id)).size).toBeGreaterThanOrEqual(10);
    expect(new Set(rs.map(r => r.block_time)).size).toBeGreaterThanOrEqual(10);
    expect(rs.length).toBeGreaterThanOrEqual(100);
  });

  it("rate = the settled print of that hour; the period is exactly 1h", () => {
    for (const r of rs) {
      expect(r.funding_rate).toBe(r.history.funding_rate);
      expect(r.block_time).toBe(r.history.end_time);
      expect((BigInt(r.history.end_time) - BigInt(r.history.start_time)).toString()).toBe(RISEX_FUNDING_INTERVAL_NS);
    }
  });

  it("payment = size × index × rate (fraction per hour, no ×100), positive = paid", () => {
    for (const r of rs) {
      const computed = Number(r.position_size) * Number(r.history.index_price) * Number(r.funding_rate);
      const actual = Number(r.funding_payment);
      expect(Math.abs(actual - computed)).toBeLessThanOrEqual(Math.max(1e-9, Math.abs(computed) * 1e-6));
      // long (size > 0) with a positive rate pays: funding_payment > 0 → perp-cli negates it (positive = received).
      if (computed !== 0) expect(Math.sign(actual)).toBe(Math.sign(Number(r.position_size)) * Math.sign(Number(r.funding_rate)));
      expect(r.side === "long").toBe(Number(r.position_size) > 0);
    }
  });
});

describe("RISEx signer-permission evidence", () => {
  it("recorded typehashes match the type strings perp-cli signs", () => {
    expect(typeHash("DisablePermission")).toBe(perms.authorization.typehashesByEthCall["DISABLE_PERMISSION_TYPEHASH()"]);
    expect(typeString("DisablePermission")).toBe(perms.authorization.typeStringsMatchingThoseHashes.DisablePermission);
    expect(keccak256(toUtf8Bytes(perms.authorization.typeStringsMatchingThoseHashes.EnablePermission))).toBe(perms.authorization.typehashesByEthCall["ENABLE_PERMISSION_TYPEHASH()"]);
  });

  it("recorded selectors match the ABI perp-cli encodes", () => {
    for (const [sel, sig] of Object.entries(perms.authorization.selectorsFromBytecode as Record<string, string>)) {
      expect(id(sig).slice(0, 10)).toBe(sel);
    }
    expect(RISEX_AUTH_IFACE.getFunction("disablePermission")!.selector).toBe("0x06991816");
    expect(RISEX_AUTH_IFACE.getFunction("hasPermission")!.selector).toBe("0xed82f4b8");
    expect(perms.argumentOrder.conclusion).toMatch(/nonceAnchor, nonceBitmap, permission/);
  });

  it("permission ids: 0..4 exist, trading = 2, perp-cli disables the rest; only the account can re-enable", () => {
    expect(Object.keys(perms.permissionIds.result).filter(k => /^\d$/.test(k)).map(Number)).toEqual([...RISEX_PERMISSION_IDS]);
    expect(perms.tradingPermission.id).toBe(RISEX_TRADING_PERMISSION);
    expect([...RISEX_NON_TRADING_PERMISSIONS]).toEqual([0, 3, 4]); // 1 = "all" mask: never disabled
    expect(perms.signerOnlyDisable["disablePermission(account, signer, anchor, bit, permission=4, sig)"]["signed by account (master)"]).toMatch(/^revert 0x3492c099/);
    expect(perms.signerOnlyDisable["enablePermission(account, signer, 2, 7, permission=4, sig)"]["signed by signer"]).toMatch(/^revert/);
    expect(id("InvalidSignerSignature(address,address)").slice(0, 10)).toBe("0x3492c099");
    expect(id("InvalidSignature(address)").slice(0, 10)).toBe("0xd855c4f4");
  });
});

describe("RISEx sessionKeys bitmap evidence (M1)", () => {
  it("layout decodes as (expiration, bitmap, status) and the recorded ids ≥5 are unaddressable", async () => {
    const { decodeSessionKey } = await import("../../exchanges/risex/session.js");
    const { RISEX_PINS, RISEX_FORBIDDEN_BITS, RISEX_TRADING_BIT } = await import("../../exchanges/risex/typed-data.js");
    const ev = perms.sessionKeysBitmap;
    expect(decodeSessionKey(ev.sampleReturn)).toEqual({ expiration: ev.sampleRegisterSignerExpiration, bitmap: 0xffffffffn, status: 1 });
    expect(ev.idsAbove4["permission=5"]).toMatch(/revert/);
    expect(ev.implementations.mainnet.toLowerCase()).toBe(RISEX_PINS.mainnet.authImplementation.toLowerCase());
    expect(ev.implementations.testnet.toLowerCase()).toBe(RISEX_PINS.testnet.authImplementation.toLowerCase());
    for (const net of ["mainnet", "testnet"] as const) {
      expect(ev.implementations.router[net].toLowerCase()).toBe(RISEX_PINS[net].routerImplementation.toLowerCase());
      expect(ev.implementations.accountRegistry[net].proxy.toLowerCase()).toBe(RISEX_PINS[net].accountRegistry.toLowerCase());
      expect(ev.implementations.accountRegistry[net].implementation.toLowerCase()).toBe(RISEX_PINS[net].accountRegistryImplementation.toLowerCase());
    }
    expect(ev.residual).toMatch(/refuses every signed action/);
    // After disabling 0, 3, 4 (live testnet result 0xffffffe6): bits 0, 3, 4 clear, bit 2 set; bit 1 and 5–31 stay set.
    expect(0xffffffe6n & RISEX_FORBIDDEN_BITS).toBe(0n);
    expect(0xffffffe6n & RISEX_TRADING_BIT).toBe(RISEX_TRADING_BIT);
  });
});
