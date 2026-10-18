import { describe, it, expect, vi, afterEach } from "vitest";
import { PerpError, isDefiniteOrderFailure } from "../../errors.js";
import { PacificaClient } from "../../pacifica/client.js";
import {
  PACIFICA_COST_CANCEL, PACIFICA_COST_STANDARD, PACIFICA_MAX_THROTTLE_WAIT_MS, PACIFICA_READ_NEED, PACIFICA_READ_RESERVE,
  PACIFICA_SIGNED_MAX_WAIT_MS, PacificaRateLimiter, isPacificaRateLimited, pacificaRateLimitOf, pacificaRateLimiter,
  parsePacificaRateLimit, parseRetryAfterMs, resetPacificaRateLimiters, type RateClock, type RateNeed,
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
const headers = (rl: string, policy = LIVE_POLICY) => ({ headers: new Headers({ ratelimit: rl, "ratelimit-policy": policy }) });
const READ = PACIFICA_READ_NEED;
const WRITE: RateNeed = { cost: PACIFICA_COST_STANDARD, reserve: 0, maxWaitMs: PACIFICA_SIGNED_MAX_WAIT_MS };
const CANCEL: RateNeed = { cost: PACIFICA_COST_CANCEL, reserve: 0, maxWaitMs: PACIFICA_SIGNED_MAX_WAIT_MS };

describe("PacificaRateLimiter throttle (fake clock)", () => {
  it("no info → sends immediately", async () => {
    const c = fakeClock();
    (await new PacificaRateLimiter("t", c).acquire("GET /x", READ)).release();
    expect(c.sleeps).toEqual([]);
  });

  it("reads: at / above the reserve → no wait; below → waits until the window refreshes, then clears", async () => {
    const c = fakeClock();
    const l = new PacificaRateLimiter("t", c);
    l.observe(headers(`"credits";r=${PACIFICA_READ_RESERVE + PACIFICA_COST_STANDARD};t=8`));
    expect(l.waitMs(READ)).toBe(0);
    resetObs(l);
    l.observe(headers(`"credits";r=${PACIFICA_READ_RESERVE + PACIFICA_COST_STANDARD - 1};t=8`));
    c.t += 3000;
    (await l.acquire("GET /x", READ)).release();
    expect(c.sleeps).toEqual([5250]); // 8 s − 3 s elapsed + 250 ms margin
    expect(l.snapshot()).toBeNull();
    (await l.acquire("GET /x", READ)).release();
    expect(c.sleeps).toHaveLength(1);
  });

  it("writes need only their own cost: a drained quota (amend's replacement leg) is not blocked by the read reserve", async () => {
    const c = fakeClock();
    const l = new PacificaRateLimiter("t", c);
    l.observe(headers('"credits";r=10;t=40')); // 1 credit left: reads wait, a create / cancel goes
    expect(l.waitMs(READ)).toBeGreaterThan(0);
    const t = await l.acquire("POST /orders/create", WRITE);
    expect(c.sleeps).toEqual([]);
    t.settle(headers('"credits";r=0;t=40'));
    // Below its own cost and the wait exceeds the post-sign cap → fails locally (nothing sent).
    await expect(l.acquire("POST /orders/create", WRITE)).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { sent: false } } });
    // A cancel (0.5 credits) fits where a create (1 credit) does not.
    resetObs(l);
    l.observe(headers('"credits";r=5;t=40'));
    await expect(l.acquire("POST /orders/create", WRITE)).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
    (await l.acquire("POST /orders/cancel", CANCEL)).release();
  });

  it("a wait above the max fails fast: RATE_LIMITED, sent:false, retryAfterMs, remediation — no sleep", async () => {
    const c = fakeClock();
    const l = new PacificaRateLimiter("t", c);
    l.observe(headers('"credits";r=0;t=40'));
    const e = await l.acquire("GET /x", READ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PerpError);
    expect((e as PerpError).structured).toMatchObject({ code: "RATE_LIMITED", details: { exchange: "pacifica", sent: false, retryAfterMs: 40_250 } });
    expect((e as PerpError).structured.remediation).toMatch(/Nothing was sent/);
    expect(c.sleeps).toEqual([]);
    expect(isPacificaRateLimited(e)).toBe(true);
    expect(isDefiniteOrderFailure(e)).toBe(true);
    expect(PACIFICA_MAX_THROTTLE_WAIT_MS).toBe(15_000);
  });

  it("a backwards clock step does not stretch the wall-clock stall", async () => {
    const c = fakeClock();
    const l = new PacificaRateLimiter("t", c);
    l.observe(headers('"credits";r=0;t=10'));
    c.t += 4000;
    expect(l.waitMs(READ)).toBe(6250);
    c.t -= 60_000; // a non-monotonic clock steps back a minute: re-anchored, not restarted
    (await l.acquire("GET /x", READ)).release();
    expect(c.sleeps).toEqual([6250]); // 10 s − 4 s really elapsed + margin, not 10 s or 70 s
  });

  it("the default clock is monotonic: a Date.now() step back does not lengthen the real wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    try {
      const l = new PacificaRateLimiter("t");
      l.observe(headers('"credits";r=0;t=1'));
      const wall = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(wall - 60_000);
      let done = false;
      const p = l.acquire("GET /x", READ).then((t) => { t.release(); done = true; });
      await vi.advanceTimersByTimeAsync(1249);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(done).toBe(true); // released after exactly 1 s + margin of (fake) real time
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("concurrent acquires reserve synchronously: Promise.all never overshoots the observed credits", async () => {
    const c = fakeClock();
    const l = new PacificaRateLimiter("t", c);
    l.observe(headers(`"credits";r=${PACIFICA_READ_RESERVE + 35};t=50`)); // room for 3 reads (10 each) above the reserve
    const settled = await Promise.allSettled(Array.from({ length: 6 }, () => l.acquire("GET /x", { ...READ, maxWaitMs: 0 })));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(3);
    expect(settled.filter((s) => s.status === "rejected")).toHaveLength(3);
    expect(l.snapshot()).toMatchObject({ inFlight: 30 });
    // A header landing meanwhile does not wipe the in-flight count; settling releases it.
    l.observe(headers(`"credits";r=${PACIFICA_READ_RESERVE + 20};t=50`));
    expect(l.snapshot()).toMatchObject({ remaining: PACIFICA_READ_RESERVE + 20, inFlight: 30 });
    for (const s of settled) if (s.status === "fulfilled") s.value.release();
    expect(l.snapshot()).toMatchObject({ inFlight: 0 });
  });

  it("a stale, late response (higher r) and another quota's response (different q) are dropped within the window", () => {
    const l = new PacificaRateLimiter("t", fakeClock());
    l.observe(headers('"credits";r=300;t=30'));
    l.observe(headers('"credits";r=900;t=31')); // late response from before others landed
    expect(l.snapshot()).toMatchObject({ remaining: 300 });
    l.observe(headers('"credits";r=200;t=30', '"credits";q=3000;w=60')); // account quota, not this IP's
    expect(l.snapshot()).toMatchObject({ remaining: 300 });
    l.observe(headers('"credits";r=250;t=29'));
    expect(l.snapshot()).toMatchObject({ remaining: 250 });
  });

  it("after a sleep, a newer observation that landed meanwhile is kept and re-checked", async () => {
    let l!: PacificaRateLimiter;
    const c = fakeClock();
    const sleep = c.sleep;
    c.sleep = async (ms) => { await sleep(ms); l.observe(headers('"credits";r=0;t=1')); };
    l = new PacificaRateLimiter("t", c);
    l.observe(headers('"credits";r=0;t=1'));
    await expect(l.acquire("GET /x", { ...READ, maxWaitMs: 2000 })).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
    expect(c.sleeps).toEqual([1250]); // the second wait would exceed the remaining 750 ms budget
  });

  it("t and Retry-After are clamped to the window (+1 s)", async () => {
    const l = new PacificaRateLimiter("t", fakeClock());
    l.observe(headers('"credits";r=0;t=99999'));
    expect(l.snapshot()?.resetInMs).toBe(61_250);
    const e = l.rateLimitedError("GET /x", { status: 429, headers: new Headers({ "retry-after": "3600" }) }, "");
    expect(e.structured.details?.retryAfterMs).toBe(61_000);
  });

  it("malformed / cached headers leave the state unchanged", () => {
    const l = new PacificaRateLimiter("t", fakeClock());
    l.observe(headers('"credits";r=0;t=10'));
    l.observe(headers('"credits";r=oops;t=10'));
    l.observe({ headers: new Headers({ ratelimit: '"credits";r=0;t=38', "x-cache": "Hit from cloudfront" }) });
    expect(l.snapshot()).toMatchObject({ remaining: 0, resetInMs: 10_250 });
  });

  it("state is per base URL, per credential tier and per request kind (signed / unsigned)", () => {
    const main = pacificaRateLimiter("https://api.pacifica.fi/api/v1", undefined, "unsigned");
    expect(pacificaRateLimiter("https://api.pacifica.fi/api/v1", undefined, "unsigned")).toBe(main);
    expect(pacificaRateLimiter("https://api.pacifica.fi/api/v1", undefined, "signed")).not.toBe(main);
    expect(pacificaRateLimiter("https://test-api.pacifica.fi/api/v1", undefined, "unsigned")).not.toBe(main);
    const keyed = pacificaRateLimiter("https://api.pacifica.fi/api/v1", "k1", "unsigned");
    expect(keyed).not.toBe(main);
    expect(pacificaRateLimiter("https://api.pacifica.fi/api/v1", "k2", "unsigned")).not.toBe(keyed);
  });
});

/** Forget a limiter's observation (test helper: lets a lower-then-higher sequence be set up). */
function resetObs(l: PacificaRateLimiter): void {
  (l as unknown as { obs: unknown }).obs = null;
}

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
