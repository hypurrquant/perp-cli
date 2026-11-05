/**
 * Dashboard live feeds (`portfolio --serve`) against a local venue socket: what each feed
 * subscribes, how it applies the venue's frames, and when it falls back to REST. Frames are the
 * recorded ones (src/__tests__/fixtures/ws/, scripts/ws-probe); the adapters are stubs that count
 * the REST reads (no network).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { ExchangeAdapter, ExchangeBalance } from "../exchanges/interface.js";
import { WsFeedManager, isFeedStale, FEED_STALE_MS, type WsFeedState } from "../dashboard/ws-feeds.js";
import { fixtureFrames } from "./ws/helpers.js";

type Frame = Record<string, unknown> & { channel?: string; data?: Record<string, unknown> };
const HL_USER = "0x000000000000000000000000000000000000dEaD"; // the recorded frames' (anonymized) user

/** The recorded REST clearinghouseState of an account with positions (live public mainnet, conformance fixture). */
const HL_STATE = (JSON.parse(gunzipSync(readFileSync(resolve(import.meta.dirname, "fixtures/conformance/positions-by-address.json.gz"))).toString()) as {
  http: Array<{ body: string | null; response: { assetPositions: unknown[] } }>;
}).http.find(h => h.body === '{"type":"clearinghouseState","user":"0x00000000000000000000000000000000000a0001"}')!.response;

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

/** A local venue WebSocket: records what the feed sends; `send` pushes a frame to the feed. */
async function venueSocket() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise(r => wss.once("listening", r));
  const received: unknown[] = [];
  let sock: WebSocket | null = null;
  let connections = 0;
  wss.on("connection", (s) => { sock = s; connections++; s.on("message", (m) => received.push(JSON.parse(String(m)))); });
  cleanup.push(() => { for (const c of wss.clients) c.terminate(); return new Promise(r => wss.close(r)); });
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    received,
    send: (f: unknown) => sock!.send(JSON.stringify(f)),
    /** The venue drops the current socket. */
    drop: () => sock!.terminate(),
    get connections() { return connections; },
  };
}

const BAL: ExchangeBalance = { equity: "1000", available: "800", marginUsed: "200", unrealizedPnl: "5" };

/** A stub adapter counting REST reads, plus the account fields the feed reads. */
function stubAdapter(fields: Record<string, unknown>) {
  const calls = { getBalance: 0, getPositions: 0, getOpenOrders: 0 };
  const adapter = {
    getBalance: async () => { calls.getBalance++; return BAL; },
    getPositions: async () => { calls.getPositions++; return []; },
    getOpenOrders: async () => { calls.getOpenOrders++; return []; },
    ...fields,
  } as unknown as ExchangeAdapter;
  return { adapter, calls };
}

/** The real feed for `name`, its venue socket pointed at `url` (only the transport is replaced). */
function feedFor(name: string, adapter: ExchangeAdapter, url: string) {
  const mgr = new WsFeedManager([{ name, adapter }], { onUpdate: () => {} });
  cleanup.push(() => mgr.close());
  const feed = (mgr as unknown as { feeds: Map<string, { getState(): WsFeedState }> }).feeds.get(name)!;
  Object.defineProperty(feed, "wsUrl", { get: () => url });
  return { mgr, feed };
}

describe("Hyperliquid feed: documented user channels (webData2 is refused by the venue)", () => {
  it("subscribes clearinghouseState and openOrders for the account", async () => {
    const v = await venueSocket();
    const { mgr } = feedFor("hyperliquid", stubAdapter({ _address: HL_USER }).adapter, v.url);
    await mgr.start();
    await expect.poll(() => v.received).toEqual([
      { method: "subscribe", subscription: { type: "clearinghouseState", user: HL_USER } },
      { method: "subscribe", subscription: { type: "openOrders", user: HL_USER } },
    ]);
  });

  it("positions and orders come from the clearinghouseState / openOrders frames", async () => {
    const v = await venueSocket();
    const { mgr, feed } = feedFor("hyperliquid", stubAdapter({ _address: HL_USER }).adapter, v.url);
    await mgr.start();
    // The recorded frame's envelope with the recorded positions (the same documented clearinghouseState type).
    const chs = fixtureFrames("hyperliquid", "private-clearinghouseState")[0] as Frame;
    v.send({ ...chs, data: { ...chs.data, clearinghouseState: HL_STATE } });
    v.send(fixtureFrames("hyperliquid", "private-openOrders")[0]);
    await expect.poll(() => feed.getState().orders).toEqual([]);
    const st = feed.getState();
    expect(st.positions).toHaveLength(HL_STATE.assetPositions.length);
    expect(st.positions![0]).toMatchObject({
      symbol: "BTC", side: "short", size: "2584.67833", entryPrice: "76204.7",
      liquidationPrice: "154159.180620393", unrealizedPnl: "-14157032.2945590001", leverage: 5,
    });
  });

  it("an error frame (a refused subscription) switches to REST at once", async () => {
    const v = await venueSocket();
    const { adapter, calls } = stubAdapter({ _address: HL_USER });
    const { mgr } = feedFor("hyperliquid", adapter, v.url);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    cleanup.push(() => stderr.mockRestore());
    await mgr.start();
    v.send((fixtureFrames("hyperliquid", "control") as Frame[]).find(f => f.channel === "error"));
    await expect.poll(() => calls.getOpenOrders, { timeout: 1000 }).toBeGreaterThan(0); // WS_DATA_TIMEOUT is 5 s
    expect(stderr.mock.calls.some(c => String(c[0]).includes("hyperliquid ws-error failed (1x): Error parsing JSON"))).toBe(true);
  });
});

/** A frontendOpenOrders row (the openOrders channel's row type; docs.hyperliquid.xyz info example —
 *  the recorded openOrders frame of the probe account is empty, no recorded row exists). */
const hlOrder = (o: Record<string, unknown>) => ({
  coin: "BTC", side: "B", limitPx: "29792.0", sz: "0.0", oid: 91490942, timestamp: 1681247412573, origSz: "5.0",
  triggerCondition: "N/A", isTrigger: false, triggerPx: "0.0", children: [], isPositionTpsl: false, reduceOnly: false,
  orderType: "Limit", tif: "Gtc", cloid: null, ...o,
});
const hlOrders = (...rows: unknown[]) => {
  const f = fixtureFrames("hyperliquid", "private-openOrders")[0] as Frame;
  return { ...f, data: { ...f.data, orders: rows } };
};

describe("Hyperliquid feed: openOrders rows are mapped as the REST read maps them", () => {
  it("spot orders (@107, PURR/USDC) are left out, as in getOpenOrders", async () => {
    const v = await venueSocket();
    const { mgr, feed } = feedFor("hyperliquid", stubAdapter({ _address: HL_USER }).adapter, v.url);
    await mgr.start();
    v.send(hlOrders(hlOrder({ oid: 1 }), hlOrder({ oid: 2, coin: "@107" }), hlOrder({ oid: 3, coin: "PURR/USDC" })));
    await expect.poll(() => feed.getState().orders?.map(o => `${o.orderId} ${o.symbol}`)).toEqual(["1 BTC"]);
  });

  it("a row without oid / limitPx is reported (ws-openOrders), never listed as id \"\" or price \"0\"", async () => {
    const v = await venueSocket();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    cleanup.push(() => stderr.mockRestore());
    const { mgr, feed } = feedFor("hyperliquid", stubAdapter({ _address: HL_USER }).adapter, v.url);
    await mgr.start();
    const { oid: _o, ...noOid } = hlOrder({});
    const { limitPx: _p, ...noPx } = hlOrder({ oid: 5 });
    v.send(hlOrders(noOid, noPx));
    await expect.poll(() => feed.getState().lastError).toMatch(/^ws-openOrders: .*without oid/);
    expect(feed.getState().orders).toBeNull();
  });
});

describe("Hyperliquid feed: a computed mark keeps its precision", () => {
  it("positionValue / |szi| = 0.0042 is \"0.0042\", not \"0.00\"", async () => {
    const v = await venueSocket();
    const { mgr, feed } = feedFor("hyperliquid", stubAdapter({ _address: HL_USER }).adapter, v.url);
    await mgr.start();
    const chs = fixtureFrames("hyperliquid", "private-clearinghouseState")[0] as Frame;
    const ap = HL_STATE.assetPositions[0] as { position: Record<string, unknown> };
    const position = { ...ap.position, coin: "kPEPE", szi: "-1000", positionValue: "4.2" };
    v.send({ ...chs, data: { ...chs.data, clearinghouseState: { ...HL_STATE, assetPositions: [{ ...ap, position }] } } });
    await expect.poll(() => feed.getState().positions?.[0]?.markPrice).toBe("0.0042");
  });
});

describe("leverage the venue frame does not carry is null (unknown), never 1", () => {
  it("Pacifica: account_positions rows carry no leverage → null", async () => {
    const v = await venueSocket();
    const { mgr, feed } = feedFor("pacifica", stubAdapter({ publicKey: "DummyPacificaAccount111111111111111111111111" }).adapter, v.url);
    await mgr.start();
    // account_positions row (docs.pacifica.fi; the recorded frame of the probe account is empty).
    v.send({ channel: "account_positions", data: [{ s: "BTC", d: "bid", a: "0.1", p: "80000", m: "0", f: "0", i: false, l: null, t: 1 }], li: 900011 });
    await expect.poll(() => feed.getState().positions?.map(p => p.leverage)).toEqual([null]);
  });

  it("Lighter: a position without initial_margin_fraction → null", async () => {
    const v = await venueSocket();
    const { adapter } = stubAdapter({
      _accountIndex: 1000001, network: { wsUrl: v.url }, signer: { createAuthToken: async () => ({ authToken: "test-token" }) },
    });
    const { mgr, feed } = feedFor("lighter", adapter, v.url);
    await mgr.start();
    const frame = (fixtureFrames("lighter", "private-account") as Frame[]).find(f => String(f.channel).startsWith("account_all_positions"))!;
    const { initial_margin_fraction: _imf, ...eth } = (frame.positions as Record<string, Record<string, unknown>>)["0"];
    v.send({ ...frame, positions: { 0: { ...eth, position: "1.5", position_value: "4500" } } });
    await expect.poll(() => feed.getState().positions?.map(p => p.leverage)).toEqual([null]);
  });
});

describe("REST fallback", () => {
  it("keeps polling while the socket stays silent: its own reads never stop it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }); // the 5 s poll interval only
    cleanup.push(() => vi.useRealTimers());
    const v = await venueSocket(); // accepts the subscriptions, never sends a frame
    const { adapter, calls } = stubAdapter({ _address: HL_USER });
    const { mgr, feed } = feedFor("hyperliquid", adapter, v.url);
    (feed as unknown as { WS_DATA_TIMEOUT: number }).WS_DATA_TIMEOUT = 50;
    await mgr.start();
    await expect.poll(() => calls.getOpenOrders).toBe(1); // REST after the WS data timeout
    vi.advanceTimersByTime(2 * 5000);
    await expect.poll(() => calls.getOpenOrders).toBe(3);
    expect(feed.getState().mode).toBe("rest");
  });
});

describe("freshness in ws mode comes from the socket only", () => {
  const silentFor = async (ms: number) => { vi.setSystemTime(Date.now() + ms); await vi.advanceTimersByTimeAsync(ms); };

  it("Hyperliquid: the balance poll does not keep a silent socket fresh (stale after FEED_STALE_MS)", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    cleanup.push(() => vi.useRealTimers());
    const v = await venueSocket();
    const { mgr, feed } = feedFor("hyperliquid", stubAdapter({ _address: HL_USER }).adapter, v.url);
    await mgr.start();
    v.send(fixtureFrames("hyperliquid", "private-openOrders")[0]);
    await expect.poll(() => feed.getState().mode).toBe("ws");
    await silentFor(FEED_STALE_MS + 5000); // the 5 s balance poll keeps succeeding meanwhile
    expect(isFeedStale(feed.getState())).toBe(true);
  });

  it("Pacifica: the mark-price poll does not keep a silent socket fresh", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    cleanup.push(() => vi.useRealTimers());
    const v = await venueSocket();
    const { mgr, feed } = feedFor("pacifica", stubAdapter({ publicKey: "DummyPacificaAccount111111111111111111111111" }).adapter, v.url);
    await mgr.start();
    v.send((fixtureFrames("pacifica", "private-account") as Frame[]).find(f => f.channel === "account_info"));
    await expect.poll(() => feed.getState().mode).toBe("ws");
    await silentFor(FEED_STALE_MS + 5000); // the venue answers no ping
    expect(isFeedStale(feed.getState())).toBe(true);
  });

  it("Pacifica: pings every 10 s; the pong confirms a quiet account", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    cleanup.push(() => vi.useRealTimers());
    const v = await venueSocket();
    const { mgr, feed } = feedFor("pacifica", stubAdapter({ publicKey: "DummyPacificaAccount111111111111111111111111" }).adapter, v.url);
    await mgr.start();
    v.send((fixtureFrames("pacifica", "private-account") as Frame[]).find(f => f.channel === "account_info"));
    await expect.poll(() => feed.getState().mode).toBe("ws");
    await vi.advanceTimersByTimeAsync(10_000);
    await expect.poll(() => v.received).toContainEqual({ method: "ping" });
    await silentFor(FEED_STALE_MS - 5000);
    v.send((fixtureFrames("pacifica", "control") as Frame[]).find(f => f.channel === "pong"));
    await silentFor(10_000); // 35 s after the last account frame, 10 s after the pong
    await expect.poll(() => isFeedStale(feed.getState())).toBe(false);
  });
});

describe("REST fallback hands over to the socket", () => {
  it("socket data after a reconnect stops REST polling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    cleanup.push(() => vi.useRealTimers());
    const v = await venueSocket();
    const { adapter, calls } = stubAdapter({ _address: HL_USER });
    const { mgr, feed } = feedFor("hyperliquid", adapter, v.url);
    await mgr.start();
    v.send(fixtureFrames("hyperliquid", "private-openOrders")[0]);
    await expect.poll(() => feed.getState().mode).toBe("ws");
    v.drop(); // the venue drops the socket: REST at once, reconnect in 1 s
    await expect.poll(() => feed.getState().mode).toBe("rest");
    await vi.advanceTimersByTimeAsync(1000);
    await expect.poll(() => v.connections).toBe(2);
    v.send(fixtureFrames("hyperliquid", "private-openOrders")[0]);
    await expect.poll(() => feed.getState().mode).toBe("ws");
    const restReads = calls.getOpenOrders;
    await vi.advanceTimersByTimeAsync(3 * 5000);
    expect(calls.getOpenOrders).toBe(restReads);
  });

  it("a REST read still in flight when socket data arrives is discarded (a cancelled order does not come back)", async () => {
    let answer!: (o: ExchangeOrder[]) => void;
    const v = await venueSocket();
    const stale: ExchangeOrder = { orderId: "9", symbol: "BTC", side: "buy", price: "1", size: "1", filled: "0", status: "open", type: "limit", triggerPrice: null };
    const { adapter } = stubAdapter({ _address: HL_USER, getOpenOrders: () => new Promise<ExchangeOrder[]>(r => { answer = r; }) });
    const { mgr, feed } = feedFor("hyperliquid", adapter, v.url);
    (feed as unknown as { WS_DATA_TIMEOUT: number }).WS_DATA_TIMEOUT = 50;
    await mgr.start();
    await expect.poll(() => typeof answer).toBe("function"); // the REST read is in flight
    v.send(fixtureFrames("hyperliquid", "private-openOrders")[0]); // the socket: no open order
    await expect.poll(() => feed.getState().orders).toEqual([]);
    answer([stale]);
    await new Promise(r => setImmediate(r)); // after every microtask: the REST read has been handled
    expect(feed.getState().orders).toEqual([]);
  });
});
