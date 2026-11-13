/**
 * Venue requests that had no deadline now time out (src/http.ts): a read fails with TIMEOUT, a
 * write that is on the wire becomes an unknown outcome (ORDER_PENDING — do NOT resubmit).
 * Each test drives a fetch that never answers with fake timers.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PerpError, classifyError } from "../errors.js";
import { HTTP_TIMEOUT_MS } from "../http.js";
import { hangingFetch } from "./helpers/hanging-fetch.js";
import { AsterAdapter } from "../exchanges/aster.js";
import { HyperliquidAdapter } from "../exchanges/hyperliquid.js";
import { fetchHyperliquidAllMidsRaw } from "../api/public/hyperliquid.js";
import { LighterAdapter } from "../exchanges/lighter.js";
import { fetchLighterFundingRatesRaw } from "../api/public/lighter.js";
import { PacificaClient } from "../pacifica/client.js";
import { fetchPacificaPricesRaw } from "../api/public/pacifica.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Run `call` against a never-answering fetch and return what it rejects with after `ms`. */
async function afterDeadline(call: () => Promise<unknown>, ms: number = HTTP_TIMEOUT_MS): Promise<unknown> {
  vi.useFakeTimers();
  const f = hangingFetch();
  vi.stubGlobal("fetch", f);
  const p = call().then(() => { throw new Error("expected a rejection"); }, (e: unknown) => e);
  await vi.advanceTimersByTimeAsync(ms);
  expect(f).toHaveBeenCalled();
  return p;
}
const codeOf = (e: unknown) => (e instanceof PerpError ? e.structured.code : classifyError(e).code);

describe("Aster", () => {
  type AsterInternals = {
    _signedPostEip712(path: string, params: Record<string, string>, r: unknown): Promise<unknown>;
    _signedDeleteEip712(path: string, params: Record<string, string>, r: unknown): Promise<unknown>;
    _publicGet(path: string): Promise<unknown>;
  };
  const aster = (): AsterInternals => Object.assign(Object.create(AsterAdapter.prototype), {
    _baseUrl: "https://fapi.test",
    _buildSignedQueryString: async () => "symbol=BTCUSDT&signature=0x00",
    invalidateOpenOrdersCache: () => {},
  }) as AsterInternals;

  it("an order POST that times out is ORDER_PENDING, not a rejection", async () => {
    const e = await afterDeadline(() => aster()._signedPostEip712("/fapi/v3/order", { symbol: "BTCUSDT" }, {}));
    expect(codeOf(e)).toBe("ORDER_PENDING");
    expect((e as PerpError).structured.remediation).toMatch(/Do NOT resubmit/);
  });

  it("a cancel DELETE that times out is ORDER_PENDING", async () => {
    const e = await afterDeadline(() => aster()._signedDeleteEip712("/fapi/v3/order", { symbol: "BTCUSDT", orderId: "1" }, {}));
    expect(codeOf(e)).toBe("ORDER_PENDING");
  });

  it("a public GET that times out fails with TIMEOUT", async () => {
    const e = await afterDeadline(() => aster()._publicGet("/fapi/v3/ticker/price"));
    expect(codeOf(e)).toBe("TIMEOUT");
  });
});

describe("Hyperliquid /info reads", () => {
  it("an adapter account read (portfolio) that times out fails with TIMEOUT", async () => {
    const hl = Object.assign(Object.create(HyperliquidAdapter.prototype), { _address: "0x0000000000000000000000000000000000000001", _testnet: true }) as HyperliquidAdapter;
    expect(codeOf(await afterDeadline(() => hl.getPortfolio()))).toBe("TIMEOUT");
  });

  it("a shared public read (allMids) that times out fails with TIMEOUT", async () => {
    expect(codeOf(await afterDeadline(() => fetchHyperliquidAllMidsRaw()))).toBe("TIMEOUT");
  });
});

describe("Lighter REST reads", () => {
  it("an adapter REST GET that times out fails with TIMEOUT", async () => {
    const lt = Object.assign(Object.create(LighterAdapter.prototype), { _baseUrl: "https://lighter.test", rhRate: async () => {} }) as
      { restGet(path: string, params: Record<string, string>): Promise<unknown> };
    expect(codeOf(await afterDeadline(() => lt.restGet("/nextNonce", { account_index: "1" })))).toBe("TIMEOUT");
  });

  it("a shared public read (funding rates) that times out fails with TIMEOUT", async () => {
    expect(codeOf(await afterDeadline(() => fetchLighterFundingRatesRaw()))).toBe("TIMEOUT");
  });
});

describe("Pacifica REST reads", () => {
  it("a client GET that times out fails with TIMEOUT", async () => {
    const pac = new PacificaClient({ network: "testnet" }) as unknown as { get(path: string): Promise<unknown> };
    expect(codeOf(await afterDeadline(() => pac.get("/info")))).toBe("TIMEOUT");
  });

  it("a shared public read (prices) that times out fails with TIMEOUT", async () => {
    expect(codeOf(await afterDeadline(() => fetchPacificaPricesRaw()))).toBe("TIMEOUT");
  });
});
