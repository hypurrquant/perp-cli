/**
 * Anonymization of recorded fixtures (docs/TESTING.md §7.3: "no secrets / real ids").
 *
 * 0.16.0 shipped five real Arcus counterparty wallets in `arcus.json`: the scrubber listed the
 * bare key `maker`, the venue sends `makerAddress`, and the anchored regex did not match it
 * (HIK-10). These tests pin both halves of the fix — the scrubber covers the suffixed spellings,
 * and the committed fixtures carry no real-looking wallet outside the classified protocol
 * constants — so the same shape of hole fails here instead of reaching a release.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import {
  PublicScrubber, guardFixtureIdentities, isAddressShaped, isDummyAddress, isPublicAddressKey,
  type Json,
} from "./fixture-tools.js";

const FIXTURE_DIR = join(import.meta.dirname, "../fixtures/conformance");
/**
 * Address-shaped inputs, invented here on purpose: a test about not committing real wallets may
 * not carry one. They are not the dummy shape either, so the guard must treat them as real.
 */
const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2";

const scrubbed = (body: Json): Json => new PublicScrubber().walk(body) as Json;

/** Every (key, string value) pair in a fixture, with `.gz` fixtures expanded. */
function* addressValues(file: string): Generator<{ key: string; value: string }> {
  const path = join(FIXTURE_DIR, file);
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

describe("the committed conformance fixtures carry no real wallet", () => {
  const files = readdirSync(FIXTURE_DIR).filter(f => f.endsWith(".json") || f.endsWith(".json.gz"));

  it("finds fixtures to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files)("%s", file => {
    const leaked = [...addressValues(file)]
      .filter(({ key, value }) => !isDummyAddress(value) && !isPublicAddressKey(key))
      .map(({ key }) => key);
    expect([...new Set(leaked)]).toEqual([]);
  });
});
