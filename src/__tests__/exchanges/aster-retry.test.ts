/**
 * Codex v0.12.12 final QA #3 — Aster signed-GET/DELETE retry loop reaches
 * all 3 documented backoffs (2s/4s/8s).
 *
 * Prior to this fix MAX_ATTEMPTS = 3, so the third attempt threw immediately
 * without sleeping — the documented 8s backoff was never reached. This test
 * forces 4 consecutive 429 responses and asserts:
 *   - fetch called exactly 4 times (initial + 3 retries)
 *   - 3 setTimeout backoffs invoked with 2000, 4000, 8000 ms in order
 *   - final attempt throws
 *
 * Uses vi.useFakeTimers + vi.advanceTimersByTimeAsync so we don't actually
 * wait 14 seconds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

function makeAgentMeta() {
  return {
    agentName: "test-agent",
    agentWalletName: "agent-aster-main",
    agentEvmAddress: "0xAgentAddr000000000000000000000000000000" as `0x${string}`,
    userEvmAddress: "0xMasterAddr00000000000000000000000000000" as `0x${string}`,
    masterWalletName: "main",
    owsApiKeyId: "ows_key_test",
    owsPolicyId: "policy-test",
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    approvedAt: new Date().toISOString(),
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
    asterApprovalNonce: "1000",
    status: "active" as const,
  };
}

function makeAgentStrategy() {
  return {
    getAddress: vi.fn().mockReturnValue("0xAgentAddr000000000000000000000000000000"),
    signTypedData: vi.fn().mockResolvedValue({
      signature: "0xAgentSignature",
      r: "0x00",
      s: "0x00",
      v: 27,
    }),
  };
}

function make429Response() {
  return {
    ok: false,
    status: 429,
    json: vi.fn().mockResolvedValue({ code: -1003, msg: "Too many requests" }),
    text: vi.fn().mockResolvedValue(""),
    headers: { get: vi.fn().mockReturnValue("5") },
  };
}

function makeInitResponse() {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ serverTime: Date.now() }),
    text: vi.fn().mockResolvedValue(""),
    headers: { get: vi.fn().mockReturnValue(null) },
  };
}

describe("AsterAdapter — retry loop reaches all 3 backoffs (C3)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("4 attempts total (initial + 3 retries) on consecutive 429s — backoffs 2s/4s/8s", async () => {
    // First call: init's /fapi/v1/time. Subsequent 4 calls: signed GET retries.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeInitResponse())   // init() ping
      .mockResolvedValueOnce(make429Response())    // attempt 0 → backoff 2s
      .mockResolvedValueOnce(make429Response())    // attempt 1 → backoff 4s
      .mockResolvedValueOnce(make429Response())    // attempt 2 → backoff 8s
      .mockResolvedValueOnce(make429Response());   // attempt 3 → final, throws
    vi.stubGlobal("fetch", fetchMock);

    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const ast = new AsterAdapter(undefined, false);
    await ast.init();
    const meta = makeAgentMeta();
    ast.setAgent(meta, makeAgentStrategy());

    // Spy on setTimeout to capture backoff delays
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    // Kick off the retry loop, advance timers, await result
    let err: unknown;
    const promise = ast.getOpenOrders().catch((e) => { err = e; });

    // Advance through each backoff: 2s, 4s, 8s
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);
    // _handleAsterResponse on final 429 also has its own waitOnce path
    await vi.advanceTimersByTimeAsync(30_000);

    await promise;

    expect(err).toBeDefined();
    // 1 init + 4 retry attempts = 5 fetch calls
    expect(fetchMock).toHaveBeenCalledTimes(5);

    // Filter to setTimeout calls invoked with (fn, ms) where ms is one of
    // the documented backoffs. Other internal setTimeouts (handleResponse's
    // 429-Retry-After path) are filtered out by the exact ms match.
    const backoffDelays = setTimeoutSpy.mock.calls
      .map((c) => c[1])
      .filter((d): d is number => d === 2000 || d === 4000 || d === 8000);
    expect(backoffDelays).toContain(2000);
    expect(backoffDelays).toContain(4000);
    expect(backoffDelays).toContain(8000);
  });

  it("retry loop succeeds on attempt 4 if first 3 are 429 (recovery path)", async () => {
    // Attempt 3 (the 4th one) succeeds with array body
    const successResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue([]),
      text: vi.fn().mockResolvedValue("[]"),
      headers: { get: vi.fn().mockReturnValue(null) },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(makeInitResponse())   // init()
      .mockResolvedValueOnce(make429Response())    // attempt 0
      .mockResolvedValueOnce(make429Response())    // attempt 1
      .mockResolvedValueOnce(make429Response())    // attempt 2
      .mockResolvedValueOnce(successResponse);     // attempt 3 — success
    vi.stubGlobal("fetch", fetchMock);

    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const ast = new AsterAdapter(undefined, false);
    await ast.init();
    const meta = makeAgentMeta();
    ast.setAgent(meta, makeAgentStrategy());

    const promise = ast.getOpenOrders();

    // Advance through 2s + 4s + 8s of backoff
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);

    const orders = await promise;
    expect(Array.isArray(orders)).toBe(true);
    expect(orders.length).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
