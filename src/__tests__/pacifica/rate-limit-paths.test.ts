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

describe("in-flight credits are always released (a leak would stall the client forever)", () => {
  const inFlight = (kind: "signed" | "unsigned") =>
    (pacificaRateLimiter(MAINNET_REST, undefined, kind) as unknown as { inFlight: number }).inFlight;
  const named = (name: string, msg: string) => Object.assign(new Error(msg), { name });
  const outcomes: Array<[string, () => Promise<Response>]> = [
    ["throw (TypeError)", async () => { throw new TypeError("fetch failed"); }],
    ["timeout", async () => { throw named("TimeoutError", "The operation was aborted due to timeout"); }],
    ["abort", async () => { throw named("AbortError", "This operation was aborted"); }],
    ["429", async () => new Response("busy", { status: 429, headers: { "retry-after": "1" } })],
    ["5xx", async () => new Response("upstream", { status: 503 })],
    ["bad JSON", async () => new Response("<html>not json", { status: 200 })],
    ["200", async () => new Response('{"success":true,"data":[]}', { status: 200 })],
  ];
  const paths: Array<[string, "signed" | "unsigned", (c: Internals) => Promise<unknown>]> = [
    ["GET", "unsigned", (c) => c.get("/info/prices")],
    ["POST create", "signed", (c) => c.post("/orders/create", {})],
    ["POST cancel", "signed", (c) => c.post("/orders/cancel", {})],
  ];
  for (const [pathName, kind, call] of paths) {
    for (const [outcome, respond] of outcomes) {
      it(`${pathName} — ${outcome} → inFlight 0`, async () => {
        vi.stubGlobal("fetch", vi.fn(respond));
        await call(client()).catch(() => undefined);
        expect(inFlight(kind)).toBe(0);
      });
    }
  }
});

describe("signed listing reads use the read need before AND after signing", () => {
  const signer = () => vi.fn(async () => new Uint8Array(64));

  it("below the read reserve → refused before signing (nothing signed, nothing sent)", async () => {
    const f = vi.fn(async () => ok('"credits";r=20;t=50'));
    vi.stubGlobal("fetch", f);
    pacificaRateLimiter(MAINNET_REST, undefined, "signed").observe(ok('"credits";r=125;t=50')); // 12.5 credits: a write fits, a read does not
    const sign = signer();
    const e = await new PacificaClient({ network: "mainnet" }).listAgentWallets("acct", sign).catch((x: unknown) => x);
    expect((e as PerpError).structured).toMatchObject({ code: "RATE_LIMITED", details: { sent: false } });
    expect((e as PerpError).message).toMatch(/list_agent_wallets not sent/); // the pre-sign check, not the post-sign one
    expect(sign).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it("above the read reserve → signed and sent", async () => {
    const f = vi.fn(async () => ok('"credits";r=200;t=50'));
    vi.stubGlobal("fetch", f);
    pacificaRateLimiter(MAINNET_REST, undefined, "signed").observe(ok('"credits";r=200;t=50'));
    const sign = signer();
    await new PacificaClient({ network: "mainnet" }).listAgentWallets("acct", sign);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledTimes(1);
  });
});
