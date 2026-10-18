import { describe, it, expect, vi, afterEach } from "vitest";
import { PerpError, isDefiniteOrderFailure } from "../../errors.js";
import { PacificaClient } from "../../pacifica/client.js";
import {
  PACIFICA_MAX_THROTTLE_WAIT_MS, PACIFICA_RATE_RESERVE, PacificaRateLimiter, isPacificaRateLimited,
  pacificaRateLimitOf, pacificaRateLimiter, parsePacificaRateLimit, parseRetryAfterMs, resetPacificaRateLimiters,
  type RateClock,
} from "../../pacifica/rate-limit.js";
import { pacificaCreateRejection, pacificaRefused } from "../../exchanges/pacifica.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetPacificaRateLimiters();
});

// docs.pacifica.fi api-documentation/api/rate-limits (sample) and live mainnet GET /info/prices 2026-10-19.
const DOCS_RL = '"credits";r=1200;t=32';
const DOCS_POLICY = '"credits";q=1250;w=60';
const LIVE_RL = '"credits";r=980;t=22';
const LIVE_POLICY = '"credits";q=1000;w=60';

describe("parsePacificaRateLimit — strict", () => {
  it("parses the documented and the live header values (credits ×10)", () => {
    expect(parsePacificaRateLimit(DOCS_RL, DOCS_POLICY)).toEqual({ remaining: 1200, resetSec: 32, quota: 1250, windowSec: 60 });
    expect(parsePacificaRateLimit(LIVE_RL, LIVE_POLICY)).toEqual({ remaining: 980, resetSec: 22, quota: 1000, windowSec: 60 });
    expect(parsePacificaRateLimit(' "credits"; t=5; r=0 ', null)).toEqual({ remaining: 0, resetSec: 5, quota: null, windowSec: null });
  });

  it("absent or malformed ratelimit → null (no info, never a guess)", () => {
    for (const bad of [
      null, "", "credits;r=1;t=2", '"tokens";r=1;t=2', '"credits";r=1', '"credits";t=2', '"credits";r=-1;t=2',
      '"credits";r=1.5;t=2', '"credits";r=abc;t=2', '"credits";r=1;r=2;t=3', '"credits";r=1;t=2;junk', '"credits";r=;t=2',
    ]) {
      expect(parsePacificaRateLimit(bad, DOCS_POLICY)).toBeNull();
    }
  });

  it("a malformed or absent policy only nulls quota / windowSec", () => {
    for (const bad of [null, '"credits";q=10', '"credits";q=10;w=0', '"credits";q=x;w=60', "q=10;w=60"]) {
      expect(parsePacificaRateLimit(DOCS_RL, bad)).toEqual({ remaining: 1200, resetSec: 32, quota: null, windowSec: null });
    }
  });

  it("a CloudFront cache hit replays another caller's headers → null", () => {
    const res = (h: Record<string, string>) => new Response("{}", { headers: { ratelimit: DOCS_RL, "ratelimit-policy": DOCS_POLICY, ...h } });
    expect(pacificaRateLimitOf(res({ "x-cache": "Hit from cloudfront", age: "16" }))).toBeNull();
    expect(pacificaRateLimitOf(res({ "x-cache": "RefreshHit from cloudfront" }))).toBeNull();
    expect(pacificaRateLimitOf(res({ age: "3" }))).toBeNull();
    expect(pacificaRateLimitOf(res({ "x-cache": "Miss from cloudfront" }))).toMatchObject({ remaining: 1200 });
    expect(pacificaRateLimitOf({})).toBeNull();
  });

  it("Retry-After: delta-seconds only", () => {
    expect(parseRetryAfterMs("7")).toBe(7000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("1.5")).toBeNull();
    expect(parseRetryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBeNull();
  });
});

function fakeClock(start = 1_000_000): RateClock & { t: number; sleeps: number[] } {
  const c = {
    t: start,
    sleeps: [] as number[],
    now: () => c.t,
    sleep: async (ms: number) => { c.sleeps.push(ms); c.t += ms; },
  };
  return c;
}
const headers = (rl: string) => ({ headers: new Headers({ ratelimit: rl, "ratelimit-policy": LIVE_POLICY }) });

describe("PacificaRateLimiter throttle (fake clock)", () => {
  it("no info → sends immediately", async () => {
    const c = fakeClock();
    await new PacificaRateLimiter("t", c).throttle("GET /x");
    expect(c.sleeps).toEqual([]);
  });

  it("at / above the reserve → no wait; below → waits until the window refreshes, then clears", async () => {
    const c = fakeClock();
    const l = new PacificaRateLimiter("t", c);
    l.observe(headers(`"credits";r=${PACIFICA_RATE_RESERVE};t=8`));
    expect(l.waitMs()).toBe(0);
    l.observe(headers(`"credits";r=${PACIFICA_RATE_RESERVE - 1};t=8`));
    c.t += 3000;
    await l.throttle("GET /x");
    expect(c.sleeps).toEqual([5250]); // 8 s − 3 s elapsed + 250 ms margin
    expect(l.snapshot()).toBeNull();
    await l.throttle("GET /x");
    expect(c.sleeps).toHaveLength(1);
  });

  it("requests sent since the last header count against the reserve", () => {
    const l = new PacificaRateLimiter("t", fakeClock());
    l.observe(headers(`"credits";r=${PACIFICA_RATE_RESERVE + 10};t=8`));
    l.noteSent();
    expect(l.waitMs()).toBe(0);
    l.noteSent();
    expect(l.waitMs()).toBeGreaterThan(0);
  });

  it("a wait above the max fails fast: RATE_LIMITED, sent:false, retryAfterMs, remediation — no sleep", async () => {
    const c = fakeClock();
    const l = new PacificaRateLimiter("t", c);
    l.observe(headers('"credits";r=0;t=40'));
    const e = await l.throttle("POST /orders/create").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PerpError);
    expect((e as PerpError).structured).toMatchObject({ code: "RATE_LIMITED", details: { exchange: "pacifica", sent: false, retryAfterMs: 40_250 } });
    expect((e as PerpError).structured.remediation).toMatch(/Nothing was sent/);
    expect(c.sleeps).toEqual([]);
    expect(isPacificaRateLimited(e)).toBe(true);
    expect(isDefiniteOrderFailure(e)).toBe(true);
    // The signed-POST bound is tighter.
    l.observe(headers('"credits";r=0;t=3'));
    await expect(l.throttle("POST /orders/create", 2000)).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
    expect(PACIFICA_MAX_THROTTLE_WAIT_MS).toBe(15_000);
  });

  it("an expired window is spent; a clock stepping backwards never lengthens the wait", () => {
    const c = fakeClock();
    const l = new PacificaRateLimiter("t", c);
    l.observe(headers('"credits";r=0;t=10'));
    c.t -= 60_000;
    expect(l.waitMs()).toBe(10_250);
    c.t += 60_000 + 10_250;
    expect(l.waitMs()).toBe(0);
    expect(l.snapshot()).toBeNull();
  });

  it("malformed / cached headers leave the state unchanged", () => {
    const l = new PacificaRateLimiter("t", fakeClock());
    l.observe(headers('"credits";r=0;t=10'));
    l.observe(headers('"credits";r=oops;t=10'));
    l.observe({ headers: new Headers({ ratelimit: '"credits";r=2980;t=38', "x-cache": "Hit from cloudfront" }) });
    expect(l.snapshot()).toMatchObject({ remaining: 0 });
  });

  it("state is per base URL and per credential tier", () => {
    const main = pacificaRateLimiter("https://api.pacifica.fi/api/v1", undefined);
    expect(pacificaRateLimiter("https://api.pacifica.fi/api/v1", undefined)).toBe(main);
    expect(pacificaRateLimiter("https://test-api.pacifica.fi/api/v1", undefined)).not.toBe(main);
    const keyed = pacificaRateLimiter("https://api.pacifica.fi/api/v1", "k1");
    expect(keyed).not.toBe(main);
    expect(pacificaRateLimiter("https://api.pacifica.fi/api/v1", "k2")).not.toBe(keyed);
  });
});

type Internals = { get(p: string): Promise<unknown>; post(p: string, b: object): Promise<unknown> };
const client = () => new PacificaClient({ network: "testnet" }) as unknown as Internals;
const tooMany = (h: Record<string, string> = {}) =>
  new Response('{"success":false,"error":"Too many requests"}', { status: 429, headers: h });

describe("Pacifica HTTP 429 — structural RATE_LIMITED", () => {
  it("GET 429 → RATE_LIMITED with retryAfterMs from Retry-After; one request, no retry", async () => {
    const f = vi.fn().mockResolvedValue(new Response("busy", { status: 429, headers: { "retry-after": "7" } }));
    vi.stubGlobal("fetch", f);
    const e = await client().get("/info/prices").catch((x: unknown) => x);
    expect((e as PerpError).structured).toMatchObject({ code: "RATE_LIMITED", details: { httpStatus: 429, retryAfterMs: 7000 } });
    expect((e as PerpError).structured.remediation).toBeTruthy();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("no Retry-After → retryAfterMs from the ratelimit reset; neither → no retryAfterMs", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tooMany({ ratelimit: '"credits";r=0;t=9' })));
    await expect(client().get("/book")).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { retryAfterMs: 9000 } } });
    resetPacificaRateLimiters();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tooMany()));
    const e = await client().get("/book").catch((x: unknown) => x) as PerpError;
    expect(e.structured.code).toBe("RATE_LIMITED");
    expect(e.structured.details?.retryAfterMs).toBeUndefined();
  });

  it("an exhausted window seen in headers fails the next GET fast, without sending it", async () => {
    const f = vi.fn(async () => new Response('{"success":true,"data":[]}', { headers: { ratelimit: '"credits";r=20;t=45', "ratelimit-policy": LIVE_POLICY } }));
    vi.stubGlobal("fetch", f);
    const c = client();
    await c.get("/info/prices");
    await expect(c.get("/info/prices")).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { sent: false } } });
    expect(f).toHaveBeenCalledTimes(1);
    // Another tier / network is not affected.
    await new PacificaClient({ network: "mainnet" }).getPrices();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("a write that gets 429 is never retried — and the next write is refused before sending", async () => {
    const f = vi.fn().mockResolvedValue(tooMany({ "retry-after": "30" }));
    vi.stubGlobal("fetch", f);
    const c = client();
    const e = await c.post("/orders/create_market", {}).catch((x: unknown) => x);
    expect((e as PerpError).structured).toMatchObject({
      code: "RATE_LIMITED", details: { exchange: "pacifica", httpStatus: 429, sent: false, retryAfterMs: 30_000 },
    });
    expect(f).toHaveBeenCalledTimes(1);
    // Definite (nothing executed) — never ORDER_PENDING, and the order mappers keep it as is.
    expect(isDefiniteOrderFailure(e)).toBe(true);
    expect(pacificaRefused(e)).toBe(true);
    expect(pacificaCreateRejection(e, "market")).toBe(e);
    // The next write is throttled locally (30 s > the signed-POST bound): fetch is not called again.
    await expect(c.post("/orders/cancel", {})).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { sent: false } } });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a write 5xx is still ORDER_PENDING (unchanged)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream", { status: 503 })));
    await expect(client().post("/orders/create", {})).rejects.toMatchObject({ structured: { code: "ORDER_PENDING" } });
  });
});
