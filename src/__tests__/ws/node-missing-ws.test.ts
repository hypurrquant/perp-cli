/**
 * The /node entry and its optional peer `ws`: importing always works. When `ws` itself cannot be
 * resolved, creating a stream or a transport throws INVALID_PARAMS with the install remediation (never
 * a reconnect loop). A MODULE_NOT_FOUND from inside an installed `ws` is NOT reported as "not
 * installed": it is rethrown with context and the original error as `cause`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

let requireError: Error = new Error("unset");

vi.mock("node:module", () => ({
  createRequire: () => () => { throw requireError; },
}));

function notFound(id: string, requireStack: string[]): Error {
  return Object.assign(new Error(`Cannot find module '${id}'\nRequire stack:\n${requireStack.map(p => `- ${p}`).join("\n")}`), {
    code: "MODULE_NOT_FOUND", requireStack,
  });
}

async function freshNode() {
  vi.resetModules(); // the module caches the loaded `ws`
  return import("../../ws/node.js");
}

function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (e) { return e; }
  return null;
}

afterEach(() => { vi.resetModules(); });

describe("perp-cli/ws/node and the optional `ws` peer", () => {
  it("`ws` not installed → INVALID_PARAMS with `npm install ws` from createVenueStream / createNodeTransport / nodeTransport", async () => {
    requireError = notFound("ws", ["/app/node_modules/@hypurrquant/perp-ws/dist/node.js"]);
    const m = await freshNode();
    expect(typeof m.nodeTransport).toBe("function");
    for (const fn of [() => m.createVenueStream(m.hyperliquid), () => m.createNodeTransport(), () => m.nodeTransport("ws://127.0.0.1:1")]) {
      expect(thrown(fn)).toMatchObject({
        structured: { code: "INVALID_PARAMS", remediation: expect.stringContaining("npm install ws@^8.21.0") },
      });
    }
    // An explicit transport needs no `ws`.
    expect(() => m.createVenueStream(m.hyperliquid, { transport: () => { throw new Error("unused"); }, fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) })).not.toThrow();
  });

  it.each([
    ["the browser entry's createVenueStream + { transport: nodeTransport }", "browser"],
    ["/node createVenueStream + a wrapper around nodeTransport", "wrapper"],
  ] as const)("%s → ready rejects INVALID_PARAMS (install remediation), stream closed, no reconnect", async (_n, how) => {
    requireError = notFound("ws", ["/app/node_modules/@hypurrquant/perp-ws/dist/node.js"]);
    const m = await freshNode();
    const browser = await import("../../ws/stream.js");
    let calls = 0;
    const transport = (url: string) => { calls++; return m.nodeTransport(url); };
    const fetch = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: [{ symbol: "BTC", instrument_type: "perpetual" }] }) });
    const opts = { transport, fetch, visibility: null };
    const stream = how === "browser" ? browser.createVenueStream(m.pacifica, opts) : m.createVenueStream(m.pacifica, opts);
    const states: string[] = [];
    stream.onState((st) => states.push(st.status));
    const err = await stream.subscribe({ kind: "allMarkets" }).ready.then(() => null, (e: unknown) => e as { structured: { code: string; remediation?: string; retryable: boolean } });
    expect(err?.structured).toMatchObject({ code: "INVALID_PARAMS", retryable: false, remediation: expect.stringContaining("npm install ws@^8.21.0") });
    expect(states).toEqual(["connecting", "closed"]);
    await new Promise((r) => setTimeout(r, 1500)); // past the first reconnect backoff (1 s)
    expect(calls).toBe(1);
    expect(stream.state).toMatchObject({ status: "closed", reason: { code: "INVALID_PARAMS" } });
    await expect(stream.subscribe({ kind: "allMarkets" }).ready).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it.each([
    ["a module required by an installed ws", notFound("./lib/receiver", ["/app/node_modules/ws/index.js", "/app/node_modules/@hypurrquant/perp-ws/dist/node.js"])],
    ["'ws' named, but raised from inside node_modules/ws", notFound("ws", ["/app/node_modules/ws/wrapper.js"])],
    ["another error code", Object.assign(new Error("Unexpected token"), { code: "ERR_SOMETHING" })],
  ])("%s → rethrown with context and cause (not reported as 'not installed')", async (_n, original) => {
    requireError = original;
    const m = await freshNode();
    const err = thrown(() => m.createNodeTransport()) as Error & { cause?: unknown; structured?: unknown };
    expect(err).toBeInstanceOf(Error);
    expect(err.structured).toBeUndefined();
    expect(err.message).toContain("could not load the `ws` package");
    expect(err.message).toContain(original.message.split("\n")[0]);
    expect(err.cause).toBe(original);
  });
});
