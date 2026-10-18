/**
 * Pacifica credit limiter wired into the request paths: signed vs unsigned state, writes vs the
 * read reserve, public fetchers (fail fast, cache hits uncounted), the health ping, and cancels
 * refused by the limiter. fetch is mocked; no on-disk cache.
 */
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../cache.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../cache.js")>();
  return { ...orig, withCache: async (_k: string, _t: number, f: () => Promise<unknown>) => f() };
});

import "../../exchanges/venues/index.js";
import { PerpError } from "../../errors.js";
import { PacificaClient } from "../../pacifica/client.js";
import { MAINNET_REST } from "../../pacifica/constants.js";
import { pacificaRateLimiter, resetPacificaRateLimiters } from "../../pacifica/rate-limit.js";
import { fetchPacificaPricesRaw, pingPacifica } from "../../api/public/pacifica.js";
import { toTradingV2 } from "../../exchanges/legacy-trading-v2.js";
import { PacificaAdapter } from "../../exchanges/pacifica.js";
import type { ExchangeAdapter } from "../../exchanges/interface.js";
import type { PacificaTestAdapter } from "../helpers/internals.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetPacificaRateLimiters();
});

const IP_POLICY = '"credits";q=1000;w=60';
const ok = (rl: string, policy = IP_POLICY, extra: Record<string, string> = {}) =>
  new Response('{"success":true,"data":[]}', { headers: { ratelimit: rl, "ratelimit-policy": policy, ...extra } });
type Internals = { get(p: string): Promise<unknown>; post(p: string, b: object): Promise<unknown> };
const client = () => new PacificaClient({ network: "mainnet" }) as unknown as Internals;

describe("signed and unsigned requests keep separate quota state", () => {
  it("a signed POST reporting the account quota (q=3000) never changes the keyless GET state", async () => {
    const f = vi.fn(async (_u: string, init?: { method?: string }) => init?.method === "POST"
      ? ok('"credits";r=20;t=50', '"credits";q=3000;w=60')
      : ok('"credits";r=900;t=50'));
    vi.stubGlobal("fetch", f);
    const c = client();
    await c.get("/info/prices");
    await c.post("/agent/list", {});
    expect(pacificaRateLimiter(MAINNET_REST, undefined, "unsigned").snapshot()).toMatchObject({ remaining: 900 });
    expect(pacificaRateLimiter(MAINNET_REST, undefined, "signed").snapshot()).toMatchObject({ remaining: 20 });
    await c.get("/info/prices"); // not blocked by the signed state
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe("writes are not blocked by the read reserve", () => {
  it("amend replacement leg: 2 credits left → reads fail fast, the create POST is still sent", async () => {
    const f = vi.fn(async () => ok('"credits";r=20;t=50'));
    vi.stubGlobal("fetch", f);
    const c = client();
    await c.post("/orders/cancel", {}); // amend's cancel drains the signed quota to 2 credits
    await expect(c.post("/agent/list", {})).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { sent: false } } });
    await c.post("/orders/create", {}); // the replacement needs only its own cost (1 credit)
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("concurrent GETs (Promise.all) reserve before sending: no request goes out beyond the observed credits", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { calls++; return ok('"credits";r=135;t=50'); }));
    const c = client();
    await c.get("/info/prices"); // 13.5 credits left: one more read above the 12-credit reserve
    const r = await Promise.allSettled([c.get("/a"), c.get("/b"), c.get("/c")]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe("public fetchers and ping", () => {
  it("public reads never wait: a nearly spent quota fails the Pacifica leg fast (RATE_LIMITED, nothing sent)", async () => {
    const f = vi.fn(async () => ok('"credits";r=50;t=55'));
    vi.stubGlobal("fetch", f);
    await fetchPacificaPricesRaw();
    const t0 = Date.now();
    await expect(fetchPacificaPricesRaw()).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { sent: false } } });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("CloudFront cache hits are not counted and their headers are ignored", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok('"credits";r=2980;t=38', '"credits";q=3000;w=60', { "x-cache": "Hit from cloudfront", age: "16" })));
    await fetchPacificaPricesRaw();
    await fetchPacificaPricesRaw();
    expect(pacificaRateLimiter(MAINNET_REST, undefined, "unsigned").snapshot()).toBeNull();
  });

  it("pingPacifica records headers through the limiter", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok('"credits";r=700;t=30')));
    expect(await pingPacifica()).toMatchObject({ ok: true, status: 200 });
    expect(pacificaRateLimiter(MAINNET_REST, undefined, "unsigned").snapshot()).toMatchObject({ remaining: 700, inFlight: 0 });
  });
});

describe("a cancel refused by the limiter / HTTP 429 is failed (not executed), not pending", () => {
  it("no history read; reported failed", async () => {
    const a = Object.create(PacificaAdapter.prototype) as PacificaTestAdapter;
    const rateLimited = new PerpError("RATE_LIMITED", "Pacifica POST /orders/cancel rate limited (HTTP 429)", { exchange: "pacifica", httpStatus: 429, sent: false, retryAfterMs: 5000, remediation: "wait" });
    const cl = { cancelOrder: vi.fn(async () => { throw rateLimited; }), getOrderHistoryById: vi.fn() };
    Object.defineProperty(a, "name", { value: "pacifica" });
    a.client = cl;
    a.account = "acct";
    a.signMessage = vi.fn();
    a.ensureSigner = vi.fn();
    a.getOpenOrders = vi.fn().mockResolvedValue([]);
    const r = await toTradingV2(a as unknown as ExchangeAdapter, "testnet").cancelByRef("BTC", { kind: "orderId", value: "404335369" });
    expect(cl.getOrderHistoryById).not.toHaveBeenCalled();
    expect(r.cancelled).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.failed[0].error).toMatch(/not executed \(rate limited/);
  });
});
