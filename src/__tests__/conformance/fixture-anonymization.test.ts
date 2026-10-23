/**
 * Anonymization of recorded fixtures (docs/TESTING.md §7.3: "no secrets / real ids").
 *
 * 0.16.0 shipped 7 real Arcus counterparty wallets in `arcus.json`: the scrubber listed the
 * bare key `maker`, the venue sends `makerAddress`, and the anchored regex did not match it
 * (HIK-10). These tests pin both halves of the fix — the scrubber covers the suffixed spellings,
 * and the committed fixtures carry no real-looking wallet outside the classified protocol
 * constants — so the same shape of hole fails here instead of reaching a release.
 *
 * The sweep walks the WHOLE `src/__tests__/fixtures/` tree, not just `conformance/`. Scoping it
 * to one directory is what let `hyperliquid/read-path-2026-10-19.json` keep 23 real counterparty
 * wallets while this suite was green (HIK-10 review). The pre-existing exceptions are named one
 * by one in `LEGACY_UNCLASSIFIED` below and frozen there, so "the gate is green" means every
 * other fixture in the tree is actually clean.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, relative, sep } from "node:path";
import {
  PublicScrubber, guardFixtureIdentities, isAddressShaped, isDummyAddress, isPlaceholderAddress,
  isPublicAddressKey, type Json,
} from "./fixture-tools.js";

const FIXTURE_ROOT = join(import.meta.dirname, "../fixtures");
/**
 * Address-shaped inputs, invented here on purpose: a test about not committing real wallets may
 * not carry one. They are not the dummy shape either, so the guard must treat them as real.
 */
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";

const scrubbed = (body: Json): Json => new PublicScrubber().walk(body) as Json;

/** Every (key, address-shaped string value) pair in a fixture, with `.gz` fixtures expanded. */
function* addressValues(file: string): Generator<{ key: string; value: string }> {
  const path = join(FIXTURE_ROOT, file);
  const raw = file.endsWith(".gz") ? gunzipSync(readFileSync(path)).toString("utf8") : readFileSync(path, "utf8");
  const stack: Array<{ key: string; node: Json }> = [{ key: "", node: JSON.parse(raw) as Json }];
  while (stack.length > 0) {
    const { key, node } = stack.pop()!;
    if (Array.isArray(node)) for (const n of node) stack.push({ key, node: n });
    else if (node !== null && typeof node === "object") for (const [k, v] of Object.entries(node)) stack.push({ key: k, node: v });
    else if (typeof node === "string" && isAddressShaped(node)) yield { key, value: node };
  }
}

describe("PublicScrubber covers the suffixed spellings of a trader identity", () => {
  it("remaps an Arcus trade row: makerAddress / takerAddress / makerOrderId / takerOrderId", () => {
    const row = {
      marketDisplayName: "BTC-USD", side: "BUY", price: "82453.0", size: "0.001",
      makerOrderId: "0a1b2c3d4e5f6071", takerOrderId: "9f8e7d6c5b4a3021",
      makerAddress: WALLET_A, takerAddress: WALLET_B,
    };
    const out = scrubbed(row) as Record<string, string>;
    expect(out.makerAddress).not.toBe(WALLET_A);
    expect(out.takerAddress).not.toBe(WALLET_B);
    expect(isDummyAddress(out.makerAddress)).toBe(true);
    expect(isDummyAddress(out.takerAddress)).toBe(true);
    expect(out.makerOrderId).toMatch(/^dummy-\d+$/);
    expect(out.takerOrderId).toMatch(/^dummy-\d+$/);
    // market data is untouched — the cross-venue invariants are checked against it
    expect(out.price).toBe("82453.0");
    expect(out.marketDisplayName).toBe("BTC-USD");
  });

  it("remaps a Lighter order row's owner_account_index (the `account_index` spelling was covered, this one was not)", () => {
    const out = scrubbed({ owner_account_index: 17548, ask_account_id: 931, price: "17548.0" }) as Record<string, Json>;
    expect(out.owner_account_index).not.toBe(17548);
    expect(out.ask_account_id).not.toBe(931);
    expect(out.price).toBe("17548.0"); // a number that merely looks like an id is not an id
  });

  it("keeps rows joinable: one real identity always becomes the same dummy, two never collide", () => {
    const out = scrubbed([
      { makerAddress: WALLET_A, takerAddress: WALLET_B },
      { makerAddress: WALLET_B, takerAddress: WALLET_A },
    ]) as Array<Record<string, string>>;
    expect(out[0].makerAddress).toBe(out[1].takerAddress);
    expect(out[0].takerAddress).toBe(out[1].makerAddress);
    expect(out[0].makerAddress).not.toBe(out[0].takerAddress);
  });

  it("leaves protocol constants readable — a token contract is not a person", () => {
    const out = scrubbed({ contractAddress: WALLET_A, baseAssetAddress: WALLET_B, quote: WALLET_A }) as Record<string, string>;
    expect(out.contractAddress).toBe(WALLET_A);
    expect(out.baseAssetAddress).toBe(WALLET_B);
    expect(out.quote).toBe(WALLET_A);
  });
});

describe("guardFixtureIdentities refuses to write a leaking fixture", () => {
  it("throws when an address survives under a key the scrubber does not classify", () => {
    const body = { http: [{ response: { trades: [{ counterPartyWallet: WALLET_A }] } }] };
    expect(() => guardFixtureIdentities(body as Json, "arcus.json"))
      .toThrow(/counterPartyWallet.*real-looking wallet address/s);
  });

  it("accepts the scrubbed form of the row that leaked, and a protocol constant", () => {
    const body = { http: [{ response: scrubbed({ makerAddress: WALLET_A }) }], meta: { contractAddress: WALLET_B } };
    expect(() => guardFixtureIdentities(body as Json, "arcus.json")).not.toThrow();
  });

  it("is the guard the recorder runs, not a guard only this test knows about", () => {
    // the scrubber's own output must always pass its own guard
    expect(() => guardFixtureIdentities(scrubbed({ users: [WALLET_A], maker: WALLET_B }), "x.json")).not.toThrow();
  });
});

/**
 * Fixtures that predate this gate and still hold address-shaped values under a key the scrubber
 * does not classify. Every entry is a pre-0.16.0 file; HIK-10's scope was the 0.16.0 additions,
 * and the honest record of a legacy unknown is an entry here, not a guessed classification.
 *
 * This list may SHRINK, never grow (`LEGACY_CAP`). A new fixture cannot be parked here without
 * failing the freeze test, which is the whole point of sweeping the tree.
 */
const LEGACY_UNCLASSIFIED: Record<string, { keys: string[]; reason: string }> = {
  "derive/get_all_currencies.json": {
    keys: ["address"],
    reason:
      "Token contracts of Derive's currency list. Cannot be classified by key name: bare `address` " +
      "is also a party key (BARE_PARTY), so adding it to PUBLIC_ADDRESS_KEY would un-anonymize " +
      "every venue that names a wallet `address`. Needs a per-venue rule, not a global one.",
  },
  "relay-quotes.json": {
    keys: ["from", "to", "sender", "recipient", "solver", "depository", "address", "currency"],
    reason:
      "A recorded Relay quote. `solver` / `depository` / `currency` / `to` are Relay contracts, but " +
      "`from` / `sender` / `recipient` are one repeated wallet that is ALSO hardcoded as the test " +
      "SENDER / USER / depositor in 5 test files (src/__tests__/relay-swap.test.ts:55 and others). " +
      "Whose wallet it is was NOT determined — it is plausibly ours. Reported in HIK-10 for a " +
      "separate decision rather than silently remapped or silently blessed here.",
  },
  "risex/permissions-evidence.json": {
    keys: ["proxy", "implementation", "router", "accountRegistry", "mainnet", "testnet", "auth"],
    reason:
      "Contract permission evidence for RiseX — the deployed proxy / implementation / registry " +
      "addresses ARE the subject of the document, so remapping them would delete its value. Left " +
      "readable deliberately; not added to PUBLIC_ADDRESS_KEY because `auth` collides with " +
      "SECRET_KEY and `mainnet` / `testnet` are too generic to classify globally.",
  },
};
/** 3 legacy files predate the sweep. Raising this means a leak was parked instead of fixed. */
const LEGACY_CAP = 3;

/** Repo-relative (posix) paths of every fixture, the provenance manifest aside. */
function fixtureFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return fixtureFiles(p);
    if (!statSync(p).isFile() || !/\.json(\.gz)?$/.test(d.name)) return [];
    const rel = relative(FIXTURE_ROOT, p).split(sep).join("/");
    return rel === "PROVENANCE.json" ? [] : [rel];
  });
}

describe("no committed fixture in the tree carries a real wallet", () => {
  const files = fixtureFiles(FIXTURE_ROOT);

  it("sweeps the whole fixture tree, not one directory", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some(f => f.startsWith("conformance/"))).toBe(true);
    expect(files.some(f => f.startsWith("hyperliquid/"))).toBe(true);
    expect(files.some(f => f.startsWith("ws/"))).toBe(true);
  });

  it.each(files)("%s", file => {
    const allowed = LEGACY_UNCLASSIFIED[file]?.keys ?? [];
    const leaked = [...addressValues(file)]
      .filter(({ key, value }) =>
        !isDummyAddress(value) && !isPlaceholderAddress(value) && !isPublicAddressKey(key) && !allowed.includes(key))
      .map(({ key }) => key);
    expect([...new Set(leaked)]).toEqual([]);
  });

  it("the legacy exception list stays frozen — it may shrink, never grow", () => {
    expect(Object.keys(LEGACY_UNCLASSIFIED).length).toBeLessThanOrEqual(LEGACY_CAP);
  });

  it("the legacy exception list does not rot: every path it names still exists", () => {
    expect(Object.keys(LEGACY_UNCLASSIFIED).filter(f => !files.includes(f))).toEqual([]);
  });

  it("every legacy exception is still needed, and says why it is there", () => {
    for (const [file, { keys, reason }] of Object.entries(LEGACY_UNCLASSIFIED)) {
      expect(reason.length, `${file} must state why`).toBeGreaterThan(80);
      // an exception that no longer matches anything is dead weight hiding the next real one
      const present = new Set([...addressValues(file)]
        .filter(({ value }) => !isDummyAddress(value) && !isPlaceholderAddress(value))
        .map(({ key }) => key));
      expect(keys.filter(k => !present.has(k)), `${file} lists keys it no longer holds`).toEqual([]);
    }
  });
});
