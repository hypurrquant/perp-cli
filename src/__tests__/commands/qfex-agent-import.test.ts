/**
 * `perp wallet agent import qfex`: every check is a read and runs
 * BEFORE anything is stored; the key is bound to a concrete account UUID that must be
 * confirmed; permissions are informational; no secret appears in any output or error.
 *
 * No network: fetch is mocked and `ws` is replaced by a scripted fake (auth + subscribe).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";

vi.mock("../../exchanges/rate-limiter.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/rate-limiter.js")>()),
  acquireRate: vi.fn(async () => undefined),
}));

const wsState = vi.hoisted(() => ({ authReply: { authenticated: true } as unknown, urls: [] as string[], sent: [] as Array<Record<string, unknown>> }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    constructor(url: string) {
      super();
      wsState.urls.push(url);
      setImmediate(() => this.emit("open"));
    }
    send(data: string, cb?: (err?: Error) => void): void {
      const msg = JSON.parse(data) as Record<string, unknown>;
      wsState.sent.push(msg);
      cb?.();
      if (msg.type === "auth") setImmediate(() => this.emit("message", Buffer.from(JSON.stringify(wsState.authReply))));
      if (msg.type === "subscribe") {
        const ch = (msg.params as { channels: string[] }).channels[0];
        setImmediate(() => this.emit("message", Buffer.from(JSON.stringify({ subscribed: ch }))));
      }
    }
    close(): void { this.readyState = 3; setImmediate(() => this.emit("close", 1000, Buffer.alloc(0))); }
    terminate(): void { this.readyState = 3; }
  }
  return { WebSocket: FakeWebSocket, WebSocketServer: class {} };
});

import "../../exchanges/venues/index.js";
import { PerpError } from "../../errors.js";
import { getVenueAgent, getVenueAgentForNetwork } from "../../agent-wallet/store.js";
import { venueKeystorePath } from "../../agent-wallet/venue-keystore.js";
import {
  importSecretFromLines, importSecretLabel, importSecretLineCount, importVenueAgent, deleteImportedAgentLocal,
  type ImportAgentParams,
} from "../../commands/agent-import.js";
import { assertAgentApproveSupported, defaultAgentName } from "../../commands/agent.js";
import { loadQfexCredentials } from "../../exchanges/qfex/agent.js";
import { QfexAdapter } from "../../exchanges/qfex/adapter.js";
import { qfexVenue } from "../../exchanges/venues/qfex.js";
import { READ_ONLY_CREDENTIALS } from "../../exchanges/venue.js";

const PRIMARY = "11111111-1111-4111-8111-111111111111";
const SUB = "22222222-2222-4222-8222-222222222222";
const SECRET = "qfex_secret_very_private_value";
let seq = 0;
let pub = "";

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(body) };
}

let routes: Record<string, (headers: Record<string, string>) => unknown>;
const requests: Array<{ method: string; url: URL; headers: Record<string, string> }> = [];

function params(over: Partial<ImportAgentParams> = {}): ImportAgentParams {
  return {
    venue: "qfex", network: "testnet", agentName: null, masterAddress: null, accountIndex: null, apiKeyIndex: null, expiresIn: null,
    replace: false, secret: { kind: "qfex", publicKey: pub, secret: SECRET }, accountId: null, confirmAccount: async () => true, ...over,
  };
}

async function rejection(p: Promise<unknown>): Promise<PerpError> {
  try { await p; } catch (e) { return e as PerpError; }
  throw new Error("expected a rejection");
}

const stored = (): boolean => existsSync(venueKeystorePath("qfex-agents", pub));

beforeEach(() => {
  pub = `qfex_pub_import_${++seq}`;
  wsState.authReply = { authenticated: true };
  wsState.urls.length = 0;
  wsState.sent.length = 0;
  requests.length = 0;
  routes = {
    "/user/subaccounts/balance": () => reply(200, { accounts: [{ account_id: SUB, available_balance: 1, is_master: false }, { account_id: PRIMARY.toUpperCase(), available_balance: 20, is_master: true }] }),
    "/user/positions": () => reply(200, { balance: {}, positions: [] }),
    "/user/trade": () => reply(200, { count: 0, data: [] }),
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const url = new URL(input);
    const method = init.method ?? "GET";
    requests.push({ method, url, headers: init.headers ?? {} });
    const route = routes[url.pathname];
    if (route === undefined || method !== "GET") throw new Error(`unexpected request ${method} ${url.href}`);
    return route(init.headers ?? {});
  }));
});

describe("stdin shape", () => {
  it("qfex takes two lines: public key, then secret", () => {
    expect(importSecretLineCount("qfex")).toBe(2);
    expect(importSecretFromLines("qfex", ["pk", "sk"])).toEqual({ kind: "qfex", publicKey: "pk", secret: "sk" });
    expect(importSecretLabel("qfex")).toBe("QFEX API secret");
    expect(defaultAgentName("qfex", "testnet")).toBe("perp-cli-qfex-tn");
  });

  it("`wallet agent approve qfex` is the uniform unsupported response pointing at import", () => {
    expect(() => assertAgentApproveSupported("qfex", "testnet", "approve")).toThrow(expect.objectContaining({
      structured: expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED", remediation: expect.stringMatching(/perp -n testnet wallet agent import qfex/) }),
    }));
  });
});

describe("import flow", () => {
  it("verifies with reads + WS auth on the UAT hosts, binds the primary account UUID, confirms it, then stores", async () => {
    const seen: unknown[] = [];
    const outcome = await importVenueAgent(params({ confirmAccount: async b => { seen.push({ ...b, storedYet: stored() }); return true; } }));
    // confirmation happened with the concrete account, before anything was written
    expect(seen).toEqual([expect.objectContaining({ accountId: PRIMARY, isPrimaryAccount: true, storedYet: false })]);
    expect(outcome).toMatchObject({ venue: "qfex", network: "testnet", agentName: "web-qfex-tn", source: "imported", publicKey: pub, accountId: PRIMARY, verification: { status: "verified" } });
    // only reads, on the testnet (UAT) REST host; never the banker
    expect(requests.every(r => r.method === "GET" && r.url.origin === "https://api.qfex.io")).toBe(true);
    expect(requests.map(r => r.url.pathname)).toEqual(["/user/subaccounts/balance", "/user/positions", "/user/trade"]);
    // the account-scoped reads name the account explicitly; the listing does not
    expect(requests[0].headers["x-qfex-requested-account-id"]).toBeUndefined();
    expect(requests[1].headers["x-qfex-requested-account-id"]).toBe(PRIMARY);
    // WS: UAT trade host, auth with the account, subscriptions only — no command
    expect(wsState.urls[0]).toMatch(/^wss:\/\/trade\.qfex\.io\/\?api_key=qfex_pub_import_/);
    expect(wsState.sent.map(m => m.type)).toEqual(["auth", "subscribe", "subscribe", "subscribe"]);
    expect((wsState.sent[0].params as { account_id: string }).account_id).toBe(PRIMARY);
    // stored: keystore (encrypted) + meta with the UUID, never null
    const meta = getVenueAgent("qfex", "web-qfex-tn")!;
    expect(meta).toMatchObject({ kind: "qfex", publicKey: pub, accountId: PRIMARY, isPrimaryAccount: true, network: "testnet", source: "imported" });
    expect(meta.permissions).toEqual({ viewPositions: true, viewBalance: true, viewOrders: true, executeOrders: null, depositWithdraw: null });
    expect(loadQfexCredentials(pub)).toEqual({ publicKey: pub, secret: SECRET });
    expect(readFileSync(venueKeystorePath("qfex-agents", pub), "utf8")).not.toContain(SECRET);
    // no secret in the outcome or the settings record
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
    expect(JSON.stringify(meta)).not.toContain(SECRET);
    // selected by network: never handed to a mainnet adapter
    expect(getVenueAgentForNetwork("qfex", "mainnet")?.publicKey).not.toBe(pub);
    expect(() => new QfexAdapter(qfexVenue, { network: "mainnet", credentials: { ...READ_ONLY_CREDENTIALS, agent: meta }, noAgent: false, hlDex: null, readOnly: false, noBuilder: false }))
      .toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "AGENT_NOT_REGISTERED" }) }));
    await deleteImportedAgentLocal("qfex", "testnet", meta);
    expect(stored()).toBe(false);
    expect(getVenueAgent("qfex", "web-qfex-tn")).toBeNull();
  });

  it("--account-id binds that subaccount when the venue lists it; an unlisted one is refused and nothing is stored", async () => {
    const outcome = await importVenueAgent(params({ agentName: "sub-key", accountId: SUB }));
    expect(outcome.accountId).toBe(SUB);
    expect(getVenueAgent("qfex", "sub-key")).toMatchObject({ accountId: SUB, isPrimaryAccount: false });
    await deleteImportedAgentLocal("qfex", "testnet", getVenueAgent("qfex", "sub-key")!);

    pub = `qfex_pub_import_${++seq}`;
    const e = await rejection(importVenueAgent(params({ agentName: "other", accountId: "33333333-3333-4333-8333-333333333333" })));
    expect(e.structured.code).toBe("AGENT_NOT_REGISTERED");
    expect(stored()).toBe(false);
    expect(getVenueAgent("qfex", "other")).toBeNull();
  });

  it("a declined confirmation stores nothing", async () => {
    const e = await rejection(importVenueAgent(params({ confirmAccount: async () => false })));
    expect(e.structured.code).toBe("INVALID_PARAMS");
    expect(e.message).toMatch(new RegExp(`account ${PRIMARY} was not confirmed`));
    expect(stored()).toBe(false);
    expect(getVenueAgent("qfex", "web-qfex-tn")).toBeNull();
  });

  it("without a confirmation callback the import is refused before any request", async () => {
    const e = await rejection(importVenueAgent(params({ confirmAccount: null })));
    expect(e.structured.code).toBe("INVALID_PARAMS");
    expect(requests).toEqual([]);
  });

  it("401 on the first read → SIGNATURE_FAILED, nothing stored, the secret never appears in the error", async () => {
    routes["/user/subaccounts/balance"] = () => reply(401, { title: "Unauthorized", detail: `bad signature for ${SECRET}` });
    const e = await rejection(importVenueAgent(params()));
    expect(e.structured.code).toBe("SIGNATURE_FAILED");
    expect(JSON.stringify(e.structured)).not.toContain(SECRET);
    expect(stored()).toBe(false);
  });

  it("a key that cannot list accounts needs --account-id; with it, a signed read as that account is the proof", async () => {
    routes["/user/subaccounts/balance"] = () => reply(403, { title: "Forbidden", detail: "scope" });
    const e = await rejection(importVenueAgent(params()));
    expect(e.structured.code).toBe("POLICY_DENIED");
    expect(e.structured.remediation).toMatch(/--account-id <uuid>/);
    expect(stored()).toBe(false);

    const outcome = await importVenueAgent(params({ agentName: "scoped", accountId: SUB }));
    expect(outcome.accountId).toBe(SUB);
    expect(getVenueAgent("qfex", "scoped")).toMatchObject({ accountId: SUB, isPrimaryAccount: false });
    await deleteImportedAgentLocal("qfex", "testnet", getVenueAgent("qfex", "scoped")!);

    // neither listing nor a read as the account works → nothing proves the binding
    pub = `qfex_pub_import_${++seq}`;
    routes["/user/positions"] = () => reply(403, { title: "Forbidden" });
    expect((await rejection(importVenueAgent(params({ agentName: "scoped2", accountId: SUB })))).structured.code).toBe("POLICY_DENIED");
    expect(stored()).toBe(false);
  });

  it("a missing View permission is recorded as false (informational); it does not block the import", async () => {
    routes["/user/trade"] = () => reply(403, { title: "Forbidden" });
    await importVenueAgent(params({ agentName: "no-orders" }));
    const meta = getVenueAgent("qfex", "no-orders")!;
    expect(meta.permissions).toMatchObject({ viewPositions: true, viewOrders: false, executeOrders: null, depositWithdraw: null });
    await deleteImportedAgentLocal("qfex", "testnet", meta);
  });

  it("a never-funded account (HTTP 500 \"position balance not found\") imports with the View permission unknown (null)", async () => {
    routes["/user/positions"] = () => reply(500, { message: "position balance not found" });
    await importVenueAgent(params({ agentName: "unfunded" }));
    const meta = getVenueAgent("qfex", "unfunded")!;
    expect(meta.permissions).toMatchObject({ viewPositions: null, viewBalance: null, viewOrders: true });
    await deleteImportedAgentLocal("qfex", "testnet", meta);
  });

  it("any other 500 on the positions read still aborts the import", async () => {
    routes["/user/positions"] = () => reply(500, { message: "internal error" });
    await rejection(importVenueAgent(params({ agentName: "broken" })));
    expect(stored()).toBe(false);
  });

  it("a refused Trade WebSocket authentication aborts before storing", async () => {
    wsState.authReply = { err: { error_code: "PermissionDenied", message: "no", incoming_message: { type: "auth", params: {} } } };
    const e = await rejection(importVenueAgent(params()));
    expect(e.structured.code).toBe("POLICY_DENIED");
    expect(stored()).toBe(false);
  });

  it("bad input formats are refused locally (input never echoed)", async () => {
    const e = await rejection(importVenueAgent(params({ secret: { kind: "qfex", publicKey: "has space", secret: SECRET } })));
    expect(e.structured.code).toBe("INVALID_PARAMS");
    expect((await rejection(importVenueAgent(params({ accountId: "not-a-uuid" })))).structured.code).toBe("INVALID_PARAMS");
    expect((await rejection(importVenueAgent(params({ secret: { kind: "key", key: "x" } })))).structured.code).toBe("INVALID_PARAMS");
    expect(requests).toEqual([]);
  });

  it("an existing name needs --replace; the replaced key's keystore is removed after the new record is written", async () => {
    await importVenueAgent(params({ agentName: "dup" }));
    const first = pub;
    pub = `qfex_pub_import_${++seq}`;
    expect((await rejection(importVenueAgent(params({ agentName: "dup" })))).structured.remediation).toMatch(/--replace/);
    await importVenueAgent(params({ agentName: "dup", replace: true }));
    expect(getVenueAgent("qfex", "dup")!.publicKey).toBe(pub);
    expect(existsSync(venueKeystorePath("qfex-agents", first))).toBe(false);
    await deleteImportedAgentLocal("qfex", "testnet", getVenueAgent("qfex", "dup")!);
  });
});
