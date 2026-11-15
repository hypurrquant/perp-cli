import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchWithTimeout, HTTP_TIMEOUT_MS } from "../http.js";
import { classifyError, isTransportFailure, sendFailure } from "../errors.js";
import { hangingFetch } from "./helpers/hanging-fetch.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchWithTimeout", () => {
  it("passes url, method, headers and body to the global fetch unchanged", async () => {
    const f = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", f);
    await fetchWithTimeout("https://x.test/a?b=1", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{\"k\":1}" });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://x.test/a?b=1");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.body).toBe("{\"k\":1}");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects with a TimeoutError when the venue does not answer within the default deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const p = fetchWithTimeout("https://x.test/a");
    const settled = expect(p).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS);
    await settled;
  });

  it("does not time out before the deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    let done = false;
    fetchWithTimeout("https://x.test/a").catch(() => { done = true; });
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS - 1);
    expect(done).toBe(false);
  });

  it("honours a caller-specific deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const p = fetchWithTimeout("https://x.test/a", {}, 30_000);
    const settled = expect(p).rejects.toMatchObject({ name: "TimeoutError", message: "HTTP request timed out after 30000ms" });
    await vi.advanceTimersByTimeAsync(30_000);
    await settled;
  });

  it("a timed-out read classifies as TIMEOUT", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const p = fetchWithTimeout("https://x.test/a").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS);
    expect(classifyError(await p).code).toBe("TIMEOUT");
  });

  it("a timed-out write is an unknown outcome (ORDER_PENDING), not a rejection", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const p = fetchWithTimeout("https://x.test/exchange", { method: "POST", body: "{}" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS);
    const e = await p;
    expect(isTransportFailure(e)).toBe(true);
    expect(sendFailure("venue", "order", e).structured.code).toBe("ORDER_PENDING");
  });

  it("leaves the timeout message free of the request url (signed query strings)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", hangingFetch());
    const p = fetchWithTimeout("https://x.test/a?signature=0xdeadbeef").catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUT_MS);
    expect(String((await p as Error).message)).not.toContain("signature");
  });

  it("passes a fetch failure through unchanged", async () => {
    const boom = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn(async () => { throw boom; }));
    await expect(fetchWithTimeout("https://x.test/a")).rejects.toBe(boom);
  });
});
