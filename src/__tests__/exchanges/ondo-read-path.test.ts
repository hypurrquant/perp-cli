/**
 * Ondo read path (0.15.1), on real mainnet responses recorded 2026-10-19
 * (fixtures/ondo/*-2026-10-19.json, trimmed to BTC / AAPL / OPENAI / CXMT):
 *  - indexPrice is the live /v1/perps/mark_prices `oraclePrice`, not /v1/perps/contracts
 *    `indexPrice` (frozen: BTC 82702.30 for 17+ minutes while the oracle moved 0.5%);
 *  - disabled listings (OPENAI-USD.P `disabled: true`) are tradable false / status "disabled",
 *    with no funding rate, and every per-symbol read refuses them with one clear error;
 *  - one symbol normalizer: "AAPL", "AAPL-USD", "AAPL-USD.P", "AAPL-PERP" → "AAPL-USD.P".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));

import "../../exchanges/venues/index.js";
import { OndoAdapter } from "../../exchanges/ondo/adapter.js";
import { ondoVenueSymbol } from "../../exchanges/ondo/public.js";
import { getVenue } from "../../exchanges/venue.js";
import { PerpError } from "../../errors.js";

const fx = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/ondo/${name}`, import.meta.url), "utf8"));
const MARKETS = fx("markets-2026-10-19.json");
const CONTRACTS = fx("contracts-2026-10-19.json");
const MARKS = fx("mark-prices-2026-10-19.json");
const FUNDING_AAPL = fx("funding-aapl-2026-10-19.json");

let requests: URL[];

function reply(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(body) };
}

function adapter(): OndoAdapter {
  return new OndoAdapter(getVenue("ondo"), {
    network: "mainnet", credentials: { pk: null, owsWallet: null, owsPassphrase: null, owsKeyToken: null, agent: null },
    noAgent: false, hlDex: null, readOnly: true, noBuilder: false,
  });
}

async function rejection(p: Promise<unknown>): Promise<PerpError> {
  try { await p; } catch (e) { return e as PerpError; }
  throw new Error("expected a rejection");
}

beforeEach(() => {
  requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    requests.push(url);
    switch (url.pathname) {
      case "/v1/markets": return reply(MARKETS);
      case "/v1/perps/contracts": return reply(CONTRACTS);
      case "/v1/perps/mark_prices": return reply(MARKS);
      case "/v1/perps/funding_rate_history": return reply(FUNDING_AAPL);
      default: throw new Error(`unexpected request ${url.href}`);
    }
  }));
});

describe("Ondo indexPrice", () => {
  it("is the mark_prices oracle, not the frozen contracts indexPrice", async () => {
    const btc = (await adapter().getMarkets()).find(m => m.symbol === "BTC");
    // contracts.indexPrice in the same capture: 82702.29977925499930785 (stale)
    expect(btc?.indexPrice).toBe("82348.91880985499883585");
    expect(btc?.markPrice).toBe("82325");
  });
});

describe("Ondo listing state", () => {
  it("disabled → tradable false, status disabled, fundingRate null; isClosed → status closed; live → active", async () => {
    const rows = await adapter().getMarkets();
    const by = (s: string) => rows.find(m => m.symbol === s);
    expect(by("OPENAI")).toMatchObject({ tradable: false, status: "disabled", fundingRate: null });
    expect(by("CXMT")).toMatchObject({ tradable: false, status: "closed" });
    expect(by("BTC")).toMatchObject({ tradable: true, status: "active", fundingRate: "0.0000125" });
  });

  it("every per-symbol read of a disabled market refuses with one error, before any market-data request", async () => {
    const a = adapter();
    const reads: Array<() => Promise<unknown>> = [
      () => a.getOrderbook("OPENAI"),
      () => a.getRecentTrades("OPENAI", 5),
      () => a.getFundingHistory("OPENAI-USD.P", 5),
      () => a.getKlines("OPENAI-PERP", "1h", 0, 3_600_000),
      () => a.getMarketInfo("openai-usd"),
    ];
    for (const read of reads) {
      requests = [];
      const e = await rejection(read());
      expect(e.structured).toMatchObject({ code: "SYMBOL_NOT_FOUND", details: expect.objectContaining({ status: "disabled" }) });
      expect(e.message).toBe("Ondo Perps OPENAI-USD.P is disabled (delisted / paused) — no live market data");
      expect(requests.every(u => u.pathname === "/v1/markets")).toBe(true);
    }
  });
});

describe("Ondo symbol normalizer", () => {
  it("strips -USD, -USD.P and -PERP (0.15.0 built AAPL-USD-USD.P / AAPL-PERP-USD.P)", () => {
    for (const s of ["AAPL", "aapl", "AAPL-USD", "AAPL-USD.P", "aapl-usd.p", "AAPL-PERP", " AAPL "]) {
      expect(ondoVenueSymbol(s)).toBe("AAPL-USD.P");
    }
    expect(() => ondoVenueSymbol("-USD.P")).toThrow(/symbol is empty/);
  });

  it("market info and market funding accept every form", async () => {
    const a = adapter();
    for (const s of ["AAPL", "AAPL-USD", "AAPL-USD.P", "AAPL-PERP"]) {
      expect(await a.getMarketInfo(s)).toMatchObject({ symbol: "AAPL", tradable: true, status: "active", indexPrice: "342.6409428621307887" });
      requests = [];
      expect((await a.getFundingHistory(s, 3))[0]).toMatchObject({ rate: "0.0000063", intervalHours: 1 });
      expect(requests.find(u => u.pathname === "/v1/perps/funding_rate_history")?.searchParams.get("market")).toBe("AAPL-USD.P");
    }
  });
});
