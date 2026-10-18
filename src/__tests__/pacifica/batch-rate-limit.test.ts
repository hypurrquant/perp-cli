/**
 * POST /orders/batch and the credit limiter: the batch is reserved per ACTION (docs rate-limits:
 * "Standard request/action 1", "Order cancellation 0.5"; the batch-order page names no batch cost),
 * a pre-sign wait (awaitBatchCapacity, up to 15 s) and a post-sign wait capped by the caller's
 * signature deadline. fetch is mocked; nothing is sent anywhere.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PacificaClient, pacificaBatchCost } from "../../pacifica/client.js";
import { MAINNET_REST } from "../../pacifica/constants.js";
import { pacificaRateLimiter, resetPacificaRateLimiters } from "../../pacifica/rate-limit.js";
import type { BatchAction } from "../../pacifica/types/order.js";

afterEach(() => { vi.unstubAllGlobals(); resetPacificaRateLimiters(); });

const POLICY = '"credits";q=1000;w=60';
const headers = (rl: string) => ({ ratelimit: rl, "ratelimit-policy": POLICY });
/** Seed the signed quota state: `r` = remaining credits ×10, `t` = seconds to refresh. */
const seed = (r: number, t: number) => pacificaRateLimiter(MAINNET_REST, undefined, "signed").observe(new Response(null, { headers: headers(`"credits";r=${r};t=${t}`) }));
const market = (n: number): BatchAction[] => Array.from({ length: n }, () => ({ type: "CreateMarket", data: {} }));
const okBatch = () => new Response('{"success":true,"data":{"results":[]}}', { headers: headers('"credits";r=900;t=50') });

describe("pacificaBatchCost", () => {
  it("1 credit (×10) per create / edit / TP-SL action, 0.5 per cancel", () => {
    expect(pacificaBatchCost(["CreateMarket", "CreateMarket"])).toBe(20);
    expect(pacificaBatchCost(["Create", "Edit", "SetPositionTpsl", "Cancel", "CancelStopOrder"])).toBe(40);
    expect(pacificaBatchCost(Array(10).fill("CreateMarket"))).toBe(100);
  });
});

describe("batchOrders reserves the whole batch's cost", () => {
  it("2.5 credits left: a 2-action batch is sent, a 3-action batch is refused before sending (a 1-credit reservation would pass it)", async () => {
    const f = vi.fn(async () => okBatch());
    vi.stubGlobal("fetch", f);
    const c = new PacificaClient({ network: "mainnet" });
    seed(25, 50);
    await expect(c.batchOrders(market(3))).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { sent: false } } });
    expect(f).not.toHaveBeenCalled();
    seed(25, 50);
    await c.batchOrders(market(2));
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("the post-sign wait is capped by maxWaitMs (the signature deadline), never above 2 s", async () => {
    const f = vi.fn(async () => okBatch());
    vi.stubGlobal("fetch", f);
    const c = new PacificaClient({ network: "mainnet" });
    seed(5, 0); // window refreshes in ~250 ms
    await expect(c.batchOrders(market(2), { maxWaitMs: 100 })).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { sent: false } } });
    expect(f).not.toHaveBeenCalled();
    seed(5, 0);
    await c.batchOrders(market(2), { maxWaitMs: 1_000 }); // waits ~250 ms, then sends
    expect(f).toHaveBeenCalledTimes(1);
    seed(5, 3); // ~3.25 s away: even a generous caller deadline is clamped to 2 s
    await expect(c.batchOrders(market(2), { maxWaitMs: 10_000 })).rejects.toMatchObject({ structured: { code: "RATE_LIMITED" } });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("awaitBatchCapacity (pre-sign)", () => {
  it("waits for the window when the batch does not fit, sends nothing; > 15 s away → RATE_LIMITED", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    const c = new PacificaClient({ network: "mainnet" });
    seed(5, 0);
    const t0 = performance.now();
    await c.awaitBatchCapacity(["CreateMarket", "CreateMarket"]);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(200);
    seed(5, 50);
    await expect(c.awaitBatchCapacity(["CreateMarket"])).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { sent: false } } });
    expect(f).not.toHaveBeenCalled();
    // Enough credits → no wait, and nothing stays reserved (a later batch still fits).
    resetPacificaRateLimiters();
    const c2 = new PacificaClient({ network: "mainnet" });
    seed(30, 50);
    await c2.awaitBatchCapacity(["CreateMarket", "CreateMarket", "CreateMarket"]);
    expect(pacificaRateLimiter(MAINNET_REST, undefined, "signed").snapshot()).toMatchObject({ inFlight: 0 });
  });
});
