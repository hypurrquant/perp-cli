/**
 * perp-cli/ws Phase 2: private (user) channels and bbo. Anonymized Phase 0 fixtures + documented delta
 * shapes; fill dedupe across a reconnect; refetch-required gaps; Lighter auth token use, 80 % TTL refresh
 * and redaction; auth failures → WS_AUTH_FAILED; bbo ordering by venue sequence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { arcus, aster, createVenueStream, hyperliquid, lighter, pacifica } from "../../ws/index.js";
import type { BboUpdate, CredentialProvider, StreamControl, StreamLog, UserUpdate, VenueCodec, VenueStreamOptions } from "../../ws/index.js";
import { createCliCredentialProvider } from "../../ws-cli/credentials.js";
import {
  ARCUS_ROUTES, ASTER_ROUTES, HL_ROUTES, LIGHTER_ROUTES, PACIFICA_ROUTES, fakeFetch, fakeTransport, fixtureFrames, flush, type FakeWs,
} from "./helpers.js";

const EVM = "0x000000000000000000000000000000000000dEaD" as const;
const SOL = "DummyPacificaAccount111111111111111111111111";
const LIGHTER_ACCT = 1000001;
type Ev = UserUpdate | BboUpdate | StreamControl;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_791_900_000_000);
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function userStream(codec: VenueCodec, routes: Record<string, unknown>, credentials: CredentialProvider | undefined, channels: Array<"account" | "positions" | "orders" | "fills">, extra: VenueStreamOptions = {}) {
  const t = fakeTransport();
  const logs: StreamLog[] = [];
  const stream = createVenueStream(codec, { transport: t.factory, fetch: fakeFetch(routes), visibility: null, credentials, logger: l => logs.push(l), ...extra });
  const sub = stream.subscribe({ kind: "user", channels });
  const ev: Ev[] = [];
  sub.on(e => ev.push(e as Ev));
  await flush(40);
  return { t, stream, sub, ev, logs, of: <T extends Ev["type"]>(type: T) => ev.filter((e): e is Extract<Ev, { type: T }> => e.type === type) };
}

const hlUser: CredentialProvider = { user: async () => ({ venue: "hyperliquid", address: EVM }) };
const pacUser: CredentialProvider = { user: async () => ({ venue: "pacifica", account: SOL }) };
const arcUser: CredentialProvider = { user: async () => ({ venue: "arcus", address: EVM, subaccount: null }) };

describe("hyperliquid user channels", () => {
  it("decodes the private fixtures: per-dex account, positions, open orders, fills snapshot (deduped on re-send)", async () => {
    const r = await userStream(hyperliquid, HL_ROUTES, hlUser, ["account", "positions", "orders", "fills"], { hip3Dexes: ["xyz"] });
    r.t.last().open();
    const subs = (r.t.last().sentJson() as Array<{ subscription: { type: string; dex?: string } }>).map(m => `${m.subscription.type}${m.subscription.dex === undefined ? "" : `:${m.subscription.dex}`}`);
    expect(subs).toEqual(["clearinghouseState", "clearinghouseState:xyz", "openOrders", "openOrders:xyz", "orderUpdates", "userFills"]);
    for (const n of ["private-control", "private-clearinghouseState", "private-openOrders", "private-userFills"]) for (const f of fixtureFrames("hyperliquid", n)) r.t.last().message(f);
    r.t.last().message({ channel: "openOrders", data: { dex: "xyz", user: EVM, orders: [] } }); // the fixture has the native dex only
    await expect(r.sub.ready).resolves.toBeUndefined();
    expect(r.of("error")).toEqual([]);
    expect(r.of("account").map(a => a.dex)).toEqual([null, "xyz"]);
    expect(r.of("account")[0]).toMatchObject({ equity: "0.0", available: "0.0", marginUsed: "0.0", unrealizedPnl: null, venueTs: 1791035142454 });
    expect(r.of("positions").at(-1)).toMatchObject({ snapshot: true, positions: [] });
    expect(r.of("orders").at(-1)).toMatchObject({ snapshot: true, complete: true, orders: [] }); // every selected dex snapshotted
    // snapshot = ONE `fills` event; the identical 2nd snapshot frame adds nothing (and is no gap: it overlaps)
    expect(r.of("fill")).toEqual([]);
    const batches = r.of("fills");
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ snapshot: true, source: "snapshot" });
    expect(batches[0].fills.map(f => f.fillId)).toEqual(["900003", "900006", expect.any(String)]);
    expect(batches[0].fills[0]).toMatchObject({ symbol: "xyz:GOLD", dex: "xyz", side: "buy", price: "4468.3", size: "0.00537", fee: "0.019303", feeToken: "USDC", liquidity: "taker", orderId: "900002" });
    expect(r.of("gap")).toEqual([]);
    expect(r.of("account")[0].source).toBe("snapshot");
  });

  it("merges orderUpdates deltas and positions; a reconnect replay adds no duplicate fill, a new fill arrives once", async () => {
    const r = await userStream(hyperliquid, HL_ROUTES, hlUser, ["positions", "orders", "fills"]);
    r.t.last().open();
    const snap = fixtureFrames("hyperliquid", "private-userFills")[0];
    r.t.last().message(snap);
    const order = { coin: "BTC", side: "B", limitPx: "80000.0", sz: "0.001", oid: 77, timestamp: 1, origSz: "0.001" };
    r.t.last().message({ channel: "orderUpdates", data: [{ order, status: "open", statusTimestamp: 2 }] });
    expect(r.of("orders").at(-1)).toMatchObject({ snapshot: false, orders: [{ orderId: "77", side: "buy", price: "80000.0", status: "open" }] });
    r.t.last().message({ channel: "orderUpdates", data: [{ order, status: "filled", statusTimestamp: 3 }] });
    expect(r.of("orders").at(-1)!.orders).toEqual([]);
    r.t.last().message({
      channel: "clearinghouseState",
      data: { dex: "", user: EVM, clearinghouseState: { marginSummary: { accountValue: "10", totalMarginUsed: "1" }, withdrawable: "9", time: 5,
        assetPositions: [{ type: "oneWay", position: { coin: "ETH", szi: "-0.5", entryPx: "2500", positionValue: "1250", unrealizedPnl: "-1", liquidationPx: null, marginUsed: "1", leverage: { type: "cross", value: 10 } } }] } },
    });
    expect(r.of("positions").at(-1)!.positions).toEqual([expect.objectContaining({ symbol: "ETH", side: "short", size: "0.5", leverage: "10", liquidationPrice: null })]);
    expect(r.of("fills")).toHaveLength(1);
    r.t.last().serverClose(1006);
    vi.advanceTimersByTime(1_000);
    r.t.last().open();
    r.t.last().message(snap); // replay on resubscribe
    expect(r.of("fills")).toHaveLength(1);
    expect(r.of("fill")).toEqual([]);
    expect(r.of("gap")).toEqual([]); // replayable and overlapping → no gap
    const before = 0;
    const fresh = { ...(snap as { data: { fills: object[] } }).data.fills[0], tid: 999001, hash: "0xd0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0ffff0001" };
    r.t.last().message({ channel: "userFills", data: { user: EVM, fills: [fresh] } });
    r.t.last().message({ channel: "userFills", data: { user: EVM, fills: [fresh] } });
    expect(r.of("fill").slice(before).map(f => [f.fillId, f.snapshot, f.fill.fillId])).toEqual([["999001", false, "999001"]]);
  });
});

describe("pacifica user channels", () => {
  it("account/positions from fixtures; orders gap at subscribe; fills + orders gaps after a reconnect", async () => {
    const r = await userStream(pacifica, PACIFICA_ROUTES, pacUser, ["account", "positions", "orders", "fills"]);
    expect(r.of("gap")).toEqual([{ type: "gap", venue: "pacifica", channel: "orders", symbol: null, expected: null, got: null, action: "refetch-required" }]);
    expect(r.of("orders")).toEqual([expect.objectContaining({ orders: [], complete: false })]);
    r.t.last().open();
    expect((r.t.last().sentJson() as Array<{ params: { source: string; account: string } }>).map(m => m.params.source))
      .toEqual(["account_info", "account_positions", "account_order_updates", "account_trades"]);
    for (const f of fixtureFrames("pacifica", "private-account")) r.t.last().message(f);
    await expect(r.sub.ready).resolves.toBeUndefined();
    expect(r.of("error")).toEqual([]);
    expect(r.of("account")[0]).toMatchObject({ equity: "0.028483", available: "0.006282", marginUsed: "0", venueTs: 1791035103648 });
    expect(r.of("positions")[0]).toMatchObject({ snapshot: true, positions: [] });
    r.t.last().message({ channel: "account_positions", data: [{ s: "BTC", d: "ask", a: "0.1", p: "83000", m: "0", f: "0", i: false, l: null, t: 9, li: 900011 }], li: 900011 });
    expect(r.of("positions").at(-1)!.positions).toEqual([expect.objectContaining({ symbol: "BTC", side: "short", size: "0.1", entryPrice: "83000" })]);
    r.t.last().message({ channel: "account_order_updates", data: [{ i: 5, I: null, s: "BTC", d: "bid", p: "0", ip: "80000", a: "0.1", f: "0", os: "open", ot: "limit", r: false, ct: 1, ut: 1, li: 2 }] });
    expect(r.of("orders").at(-1)).toMatchObject({ snapshot: false, complete: false, orders: [{ orderId: "5", side: "buy", price: "80000" }] });
    r.t.last().message({ channel: "account_order_updates", data: [{ i: 5, s: "BTC", d: "bid", os: "filled", li: 3 }] });
    expect(r.of("orders").at(-1)!.orders).toEqual([]);
    const trade = { h: 80063441, i: 5, I: null, s: "BTC", p: "80000", o: "80000", a: "0.1", te: "fulfill_maker", ts: "open_long", tc: "normal", f: "0.01", n: "0", t: 10, li: 4 };
    r.t.last().message({ channel: "account_trades", data: [trade] });
    expect(r.of("fill")).toEqual([expect.objectContaining({ fillId: "80063441:5", snapshot: false, fill: expect.objectContaining({ side: "buy", liquidity: "maker", fee: "0.01" }) })]);
    r.t.last().message({ channel: "account_order_updates", data: [{ i: 6, s: "ETH", d: "ask", ip: "3000", a: "1", f: "0", os: "open", ot: "limit", li: 5 }] });
    expect(r.of("orders").at(-1)!.orders.map(o => o.orderId)).toEqual(["6"]);
    r.t.last().serverClose(1006);
    vi.advanceTimersByTime(1_000);
    r.t.last().open();
    expect(r.of("gap").slice(1).map(g => g.channel)).toEqual(["orders", "fills"]);
    // pre-disconnect orders are unknown now: cleared, and the set is not complete
    expect(r.of("orders").at(-1)).toMatchObject({ orders: [], complete: false });
  });
});

describe("lighter user channels + auth token", () => {
  const tokenOf = (n: number) => `1791903600:${LIGHTER_ACCT}:3:${"ab".repeat(40)}${n}`;

  function provider(ttlMs = 100_000, fail = false) {
    let n = 0;
    const p: CredentialProvider & { calls: number } = {
      calls: 0,
      user: async () => ({ venue: "lighter", accountIndex: LIGHTER_ACCT }),
      authToken: async ({ purpose, maxTtlSec }) => {
        p.calls++;
        expect(purpose).toBe("lighter:account_all_orders");
        expect(maxTtlSec).toBe(3600);
        if (fail) throw new Error(`signer unavailable token=${tokenOf(99)}`);
        return { token: tokenOf(++n), expiresAt: Date.now() + ttlMs };
      },
    };
    return p;
  }

  it("decodes the private fixtures; the orders subscribe carries the token; refresh at 80 % TTL resubscribes", async () => {
    const cred = provider();
    const r = await userStream(lighter, LIGHTER_ROUTES, cred, ["account", "positions", "orders", "fills"]);
    r.t.last().open();
    const sent = r.t.last().sentJson() as Array<{ channel: string; auth?: string }>;
    expect(sent.map(m => m.channel)).toEqual([`user_stats/${LIGHTER_ACCT}`, `account_all_positions/${LIGHTER_ACCT}`, `account_all_orders/${LIGHTER_ACCT}`, `account_all_trades/${LIGHTER_ACCT}`]);
    expect(sent[2].auth).toBe(tokenOf(1));
    expect(sent.filter(m => m.auth !== undefined)).toHaveLength(1);
    for (const f of fixtureFrames("lighter", "private-account")) r.t.last().message(f);
    await expect(r.sub.ready).resolves.toBeUndefined();
    expect(r.of("error")).toEqual([]);
    expect(r.of("account")[0]).toMatchObject({ equity: "0.002285", available: "0.002285", marginUsed: null });
    expect(r.of("positions")[0]).toMatchObject({ snapshot: true, positions: [] }); // flat markets are not positions
    expect(r.of("orders")[0]).toMatchObject({ snapshot: true, complete: true, orders: [] });
    expect(r.of("fill")).toEqual([]); // trades:{} snapshot
    // a fill where we are the maker ask
    r.t.last().message({
      channel: `account_all_trades:${LIGHTER_ACCT}`, type: "update/account_all_trades",
      trades: { 1: [{ trade_id: 5, trade_id_str: "5", market_id: 1, size: "0.01", price: "83000", ask_id_str: "11", bid_id_str: "12", ask_account_id: LIGHTER_ACCT, bid_account_id: 7, is_maker_ask: true, timestamp: 1 }] },
    });
    expect(r.of("fill")[0]).toMatchObject({ fillId: "5", fill: { symbol: "BTC", side: "sell", liquidity: "maker", orderId: "11", fee: null } });
    // refresh at 80 % of the 100 s TTL
    expect(cred.calls).toBe(1);
    for (let i = 0; i < 8; i++) { vi.advanceTimersByTime(10_000); r.t.last().message({ type: "pong" }); } // answer app pings
    await flush(20);
    expect(cred.calls).toBe(2);
    const after = (r.t.last().sentJson() as Array<{ type: string; channel: string; auth?: string }>).slice(4).filter(m => m.type !== "ping");
    expect(after).toEqual([
      { type: "unsubscribe", channel: `account_all_orders/${LIGHTER_ACCT}` },
      { type: "subscribe", channel: `account_all_orders/${LIGHTER_ACCT}`, auth: tokenOf(2) },
    ]);
    // reconnect → fills gap (account_all_trades does not replay)
    r.t.last().serverClose(1006);
    vi.advanceTimersByTime(1_000);
    r.t.last().open();
    expect(r.of("gap").map(g => g.channel)).toEqual(["fills"]);
    // tokens never leave the library (events, logs, state)
    r.t.last().message({ error: { code: 20001, message: `invalid auth ${tokenOf(2)} for account_all_trades:${LIGHTER_ACCT}` } });
    const dump = JSON.stringify({ ev: r.ev, logs: r.logs, state: r.stream.state });
    expect(dump).not.toContain(tokenOf(1));
    expect(dump).not.toContain(tokenOf(2));
  });

  it("a 20001 frame for the orders channel → fatal WS_AUTH_FAILED", async () => {
    const r = await userStream(lighter, LIGHTER_ROUTES, provider(), ["orders"]);
    r.t.last().open();
    r.t.last().message({ error: { code: 20001, message: `invalid param : auth field is required: account_all_orders:${LIGHTER_ACCT}` } });
    await expect(r.sub.ready).rejects.toMatchObject({ structured: { code: "WS_AUTH_FAILED" } });
  });

  it.each([
    ["no credential provider", undefined],
    ["provider without authToken", { user: async () => ({ venue: "lighter", accountIndex: LIGHTER_ACCT }) }],
    ["authToken throws", "fail"],
    ["authToken returns an expired token", { user: async () => ({ venue: "lighter", accountIndex: LIGHTER_ACCT }), authToken: async () => ({ token: "x".repeat(20), expiresAt: 1 }) }],
  ] as const)("%s → WS_AUTH_FAILED before any socket opens (no secret in the message)", async (_n, c) => {
    const cred = c === "fail" ? provider(100_000, true) : (c as CredentialProvider | undefined);
    const r = await userStream(lighter, LIGHTER_ROUTES, cred, ["orders"]);
    await expect(r.sub.ready).rejects.toMatchObject({ structured: { code: "WS_AUTH_FAILED" } });
    expect(r.t.sockets).toHaveLength(0);
    expect(JSON.stringify({ ev: r.ev, logs: r.logs })).not.toContain(tokenOf(99));
  });

  it("account channels need no token (no authToken call)", async () => {
    const cred = provider();
    const r = await userStream(lighter, LIGHTER_ROUTES, cred, ["account", "positions", "fills"]);
    r.t.last().open();
    expect(cred.calls).toBe(0);
    expect((r.t.last().sentJson() as Array<{ auth?: string }>).every(m => m.auth === undefined)).toBe(true);
  });
});

describe("arcus user channels", () => {
  it("snapshots from fixtures (recentClosedOrders are not open orders); streaming deltas merge", async () => {
    const r = await userStream(arcus, ARCUS_ROUTES, arcUser, ["account", "positions", "orders", "fills"]);
    r.t.last().open();
    expect(r.t.last().sentJson()).toEqual(["account", "positions", "orders", "userFills"].map(channel => ({ type: "subscribe", channel, id: EVM })));
    for (const f of fixtureFrames("arcus", "private-account")) r.t.last().message(f);
    await expect(r.sub.ready).resolves.toBeUndefined();
    expect(r.of("error")).toEqual([]);
    expect(r.of("account")[0]).toMatchObject({ equity: "0.007894037", available: "0.008471091" });
    expect(r.of("orders")[0]).toMatchObject({ snapshot: true, complete: true, orders: [] });
    expect(r.of("fills")).toHaveLength(1);
    expect(r.of("fills")[0].fills.map(f => [f.fillId, f.side, f.liquidity])).toEqual([["900015", "sell", "taker"], ["900016", "buy", "taker"]]);
    expect(r.of("fills")[0].fills[0].time).toBe(1790962029380);
    r.t.last().message({ type: "channel_data", channel: "positions", id: EVM, contents: { isSnapshot: false, marketId: 1, marketDisplayName: "BTC-USD", side: "LONG", size: "0.15", averageEntryPrice: "64620.00" } });
    expect(r.of("positions").at(-1)!.positions).toEqual([expect.objectContaining({ symbol: "BTC-USD", side: "long", size: "0.15" })]);
    r.t.last().message({ type: "channel_data", channel: "positions", id: EVM, contents: { isSnapshot: false, marketId: 1, marketDisplayName: "BTC-USD", side: "FLAT", size: "0", averageEntryPrice: "0" } });
    expect(r.of("positions").at(-1)!.positions).toEqual([]);
    r.t.last().message({ type: "channel_data", channel: "userFills", id: EVM, contents: { isSnapshot: false, tradeId: "t-1", orderId: "o-1", market: "BTC-USD", side: "BUY", fillPrice: "50000.00", fillSize: "0.01" } });
    expect(r.of("fill").at(-1)).toMatchObject({ fillId: "t-1", snapshot: false, fill: { symbol: "BTC-USD", price: "50000.00", size: "0.01" } });
    // resubscribe replay after a reconnect → no duplicate, no gap
    r.t.last().serverClose(1006);
    vi.advanceTimersByTime(1_000);
    r.t.last().open();
    const n = r.of("fill").length + r.of("fills").length;
    r.t.last().message(fixtureFrames("arcus", "private-account")[3]);
    expect(r.of("fill").length + r.of("fills").length).toBe(n);
    expect(r.of("gap")).toEqual([]);
  });

  it("account order events (no balances) are not emitted as account updates", async () => {
    const r = await userStream(arcus, ARCUS_ROUTES, arcUser, ["account"]);
    r.t.last().open();
    r.t.last().message({ type: "channel_data", channel: "account", id: EVM, contents: { type: "PLACED", netQuoteBalance: "1" } });
    expect(r.of("account")).toEqual([]);
    expect(r.of("error")).toEqual([]);
  });
});

describe("user channel gating", () => {
  it("aster user channels → CAPABILITY_UNSUPPORTED (0.15.1)", async () => {
    const r = await userStream(aster, ASTER_ROUTES, { user: async () => ({ venue: "aster", user: EVM, signer: EVM }) }, ["fills"]);
    await expect(r.sub.ready).rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(r.t.sockets).toHaveLength(0);
  });

  it("a UserRef for another venue → INVALID_PARAMS", async () => {
    const r = await userStream(pacifica, PACIFICA_ROUTES, hlUser, ["account"]);
    await expect(r.sub.ready).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
  });

  it("live fills are never evicted before an iterator attaches: a full buffer overflows (fatal) instead", async () => {
    const r = await userStream(hyperliquid, HL_ROUTES, hlUser, ["fills"], { buffer: { size: 3 } });
    const sub2 = r.stream.subscribe({ kind: "user", channels: ["fills"] });
    await flush(40);
    r.t.last().open();
    const live = (tid: number) => ({ channel: "userFills", data: { user: EVM, fills: [{ coin: "BTC", px: "1", sz: "1", side: "B", time: tid, tid, oid: 1, crossed: false, fee: "0", feeToken: "USDC", closedPnl: "0" }] } });
    for (let tid = 1; tid <= 4; tid++) r.t.last().message(live(tid));
    expect(sub2.status).toBe("closed");
    const it2 = sub2[Symbol.asyncIterator]();
    const got: string[] = [];
    for (;;) { const x = await it2.next(); if (x.done) break; got.push((x.value as Ev).type); }
    expect(got.filter(t => t === "fill")).toHaveLength(3);
    expect(got.at(-1)).toBe("error");
  });
});

describe("fill snapshots, dedupe and replay gaps", () => {
  const hlFill = (tid: number, extra: Record<string, unknown> = {}) => ({ coin: "BTC", px: "1", sz: "1", side: "B", time: 1_000 + tid, tid, oid: 1, crossed: true, fee: "0", feeToken: "USDC", closedPnl: "0", ...extra });

  it("an HL snapshot larger than buffer.size is ONE event: no overflow, subscription stays active", async () => {
    const r = await userStream(hyperliquid, HL_ROUTES, hlUser, ["fills"], { buffer: { size: 16 } });
    const it = r.sub[Symbol.asyncIterator]();
    r.t.last().open();
    r.t.last().message({ channel: "userFills", data: { isSnapshot: true, user: EVM, fills: Array.from({ length: 2000 }, (_, i) => hlFill(i + 1)) } });
    expect(r.sub.status).toBe("active");
    const types: string[] = [];
    for (let i = 0; i < 2; i++) types.push(((await it.next()).value as Ev).type);
    expect(types).toEqual(["state", "fills"]); // on() attached first → the iterator starts at its creation
    const batch = r.of("fills");
    expect(batch).toHaveLength(1);
    expect(batch[0].fills).toHaveLength(2000);
    expect(r.of("error")).toEqual([]);
  });

  it("HL long outage: the replay snapshot does not reach the fills seen before → gap{fills, refetch-required}", async () => {
    const r = await userStream(hyperliquid, HL_ROUTES, hlUser, ["fills"]);
    r.t.last().open();
    r.t.last().message({ channel: "userFills", data: { isSnapshot: true, user: EVM, fills: [hlFill(1), hlFill(2)] } });
    r.t.last().serverClose(1006);
    vi.advanceTimersByTime(1_000);
    r.t.last().open();
    // the venue's replay window moved past tid 1-2 (all new fills)
    r.t.last().message({ channel: "userFills", data: { isSnapshot: true, user: EVM, fills: [hlFill(10), hlFill(11)] } });
    expect(r.of("gap")).toEqual([expect.objectContaining({ channel: "fills", action: "refetch-required" })]);
    expect(r.of("fills").map(b => b.fills.length)).toEqual([2, 2]);
    // overlapping replay → no further gap
    r.t.last().serverClose(1006);
    vi.advanceTimersByTime(2_000);
    r.t.last().open();
    r.t.last().message({ channel: "userFills", data: { isSnapshot: true, user: EVM, fills: [hlFill(11), hlFill(12)] } });
    expect(r.of("gap")).toHaveLength(1);
  });

  it("self-trade: both legs sharing a trade id are kept (dedupe key = id + side + order)", async () => {
    const r = await userStream(hyperliquid, HL_ROUTES, hlUser, ["fills"]);
    r.t.last().open();
    r.t.last().message({ channel: "userFills", data: { user: EVM, fills: [hlFill(7, { side: "B", oid: 1 }), hlFill(7, { side: "A", oid: 2 })] } });
    r.t.last().message({ channel: "userFills", data: { user: EVM, fills: [hlFill(7, { side: "B", oid: 1 })] } });
    expect(r.of("fill").map(f => [f.fillId, f.fill.side])).toEqual([["7", "buy"], ["7", "sell"]]);
  });

  it("lighter self-trade (our account on both sides) → two fills", async () => {
    const cred: CredentialProvider = { user: async () => ({ venue: "lighter", accountIndex: LIGHTER_ACCT }) };
    const r = await userStream(lighter, LIGHTER_ROUTES, cred, ["fills"]);
    r.t.last().open();
    r.t.last().message({
      channel: `account_all_trades:${LIGHTER_ACCT}`, type: "update/account_all_trades",
      trades: { 1: [{ trade_id_str: "9", market_id: 1, size: "1", price: "2", ask_id_str: "11", bid_id_str: "12", ask_account_id: LIGHTER_ACCT, bid_account_id: LIGHTER_ACCT, is_maker_ask: true, timestamp: 1 }] },
    });
    expect(r.of("fill").map(f => [f.fill.side, f.fill.orderId, f.fill.liquidity])).toEqual([["sell", "11", "maker"], ["buy", "12", "taker"]]);
  });
});

describe("pacifica docs sync (docs.pacifica.fi)", () => {
  it("24 h forced close of a long-lived socket → reconnect, resubscribe, orders/fills refetch-required gaps", async () => {
    const r = await userStream(pacifica, PACIFICA_ROUTES, pacUser, ["account", "positions", "orders", "fills"]);
    const first = r.t.last();
    first.open();
    for (const f of fixtureFrames("pacifica", "private-account")) first.message(f);
    await expect(r.sub.ready).resolves.toBeUndefined();
    first.message({ channel: "account_order_updates", data: [{ i: 6, s: "ETH", d: "ask", ip: "3000", a: "1", f: "0", os: "open", ot: "limit", li: 900020 }] });
    // 24 h of heartbeats: every 20 s ping answered (the venue's 60 s idle close never triggers).
    for (let elapsed = 0; elapsed < 24 * 3_600_000; elapsed += 20_000) {
      vi.advanceTimersByTime(20_000);
      first.message({ channel: "pong" });
    }
    expect(r.t.sockets).toHaveLength(1);
    const pings = first.sentJson().filter(m => (m as { method: string }).method === "ping").length;
    expect(pings).toBeGreaterThan(4000);
    const gapsBefore = r.of("gap").length;
    first.serverClose(1000, "connection lifetime exceeded");
    expect(r.stream.state).toMatchObject({ status: "reconnecting", reason: { wsCode: 1000 } });
    vi.advanceTimersByTime(1_000);
    expect(r.t.sockets).toHaveLength(2);
    r.t.last().open();
    expect((r.t.last().sentJson() as Array<{ params: { source: string } }>).map(m => m.params.source))
      .toEqual(["account_info", "account_positions", "account_order_updates", "account_trades"]);
    expect(r.of("gap").slice(gapsBefore).map(g => [g.channel, g.action])).toEqual([["orders", "refetch-required"], ["fills", "refetch-required"]]);
    expect(r.of("orders").at(-1)).toMatchObject({ orders: [], complete: false });
    // The resubscribe snapshot is the new baseline (its li may be anything): applied.
    r.t.last().message({ channel: "account_positions", data: [{ s: "BTC", d: "bid", a: "1", p: "1", m: "0", f: "0", i: false, l: null, t: 1, li: 5 }], li: 5 });
    expect(r.of("positions").at(-1)!.positions.map(p => p.symbol)).toEqual(["BTC"]);
    expect(r.stream.state).toMatchObject({ status: "live" });
  });

  it("account_positions: a snapshot with an older envelope li is dropped; equal and newer are applied", async () => {
    const r = await userStream(pacifica, PACIFICA_ROUTES, pacUser, ["positions"]);
    r.t.last().open();
    const pos = (sym: string, li: number) => ({ channel: "account_positions", data: [{ s: sym, d: "bid", a: "1", p: "1", m: "0", f: "0", i: false, l: null, t: 1, li }], li });
    r.t.last().message(pos("BTC", 100));
    r.t.last().message(pos("ETH", 99)); // delayed older snapshot
    expect(r.of("positions").at(-1)!.positions.map(p => p.symbol)).toEqual(["BTC"]);
    r.t.last().message(pos("SOL", 100));
    expect(r.of("positions").at(-1)!.positions.map(p => p.symbol)).toEqual(["SOL"]);
    r.t.last().message({ channel: "account_positions", data: [], li: 101 }); // closed → flat
    expect(r.of("positions").at(-1)!.positions).toEqual([]);
    r.t.last().message({ channel: "account_positions", data: [{ s: "BTC", d: "bid", a: "1", p: "1", m: "0", f: "0", i: false, l: null, t: 1 }] }); // no li: not ordered
    expect(r.of("positions").at(-1)!.positions.map(p => p.symbol)).toEqual(["BTC"]);
    expect(r.of("error")).toEqual([]);
    expect(r.logs.filter(l => l.event === "stale-snapshot")).toHaveLength(1);
  });

  it("directory = instrument_type \"perpetual\" rows; spot rows in `prices` are skipped without an unknown-market warning", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(PACIFICA_ROUTES), visibility: null });
    expect((await stream.markets()).map(m => m.symbol)).toEqual(["BTC", "ETH", "FARTCOIN", "TSLA"]);
    const sub = stream.subscribe({ kind: "allMarkets" });
    const ev: Array<{ type: string; symbol?: string }> = [];
    sub.on(e => ev.push(e as { type: string; symbol?: string }));
    await flush(40);
    t.last().open();
    const row = (symbol: string) => ({ symbol, mark: "1", oracle: "1", funding: "0", next_funding: "0", open_interest: "0", volume_24h: "0", timestamp: 1 });
    t.last().message({ channel: "prices", data: [row("BTC"), row("SOL-USDC")] });
    expect(ev.filter(e => e.type === "market").map(e => e.symbol)).toEqual(["BTC"]);
    expect(ev.filter(e => e.type === "error")).toEqual([]);
  });

  it("a /info row without instrument_type is left out with a non-fatal directory warning; the rest stream", async () => {
    const routes = { "GET https://api.pacifica.fi/api/v1/info": { success: true, data: [{ symbol: "BTC", instrument_type: "perpetual" }, { symbol: "ETH" }] } };
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(routes), visibility: null });
    expect((await stream.markets()).map(m => m.symbol)).toEqual(["BTC"]);
    const sub = stream.subscribe({ kind: "allMarkets" });
    const ev: Array<{ type: string; code?: string; fatal?: boolean; message?: string; symbol?: string }> = [];
    sub.on(e => ev.push(e as (typeof ev)[number]));
    await flush(40);
    expect(ev.filter(e => e.type === "error")).toEqual([expect.objectContaining({ code: "EXCHANGE_ERROR", fatal: false, message: expect.stringContaining("without instrument_type left out (cannot tell perp from spot): ETH") })]);
    t.last().open();
    const row = (symbol: string) => ({ symbol, mark: "1", oracle: "1", funding: "0", next_funding: "0", open_interest: "0", volume_24h: "0", timestamp: 1 });
    t.last().message({ channel: "prices", data: [row("BTC"), row("ETH")] });
    expect(ev.filter(e => e.type === "market").map(e => e.symbol)).toEqual(["BTC"]); // ETH skipped, no unknown-market warning
    expect(ev.filter(e => e.type === "error")).toHaveLength(1);
  });});

describe("bbo channel", () => {
  async function bbo(codec: VenueCodec, routes: Record<string, unknown>, symbol: string, frames: unknown[]) {
    const t = fakeTransport();
    const stream = createVenueStream(codec, { transport: t.factory, fetch: fakeFetch(routes), visibility: null });
    const sub = stream.subscribe({ kind: "market", symbol, channels: ["bbo"] });
    const ev: Ev[] = [];
    sub.on(e => ev.push(e as Ev));
    await flush(40);
    t.last().open();
    for (const f of frames) t.last().message(f);
    return { t, ev, sub, bbo: ev.filter((e): e is BboUpdate => e.type === "bbo"), errors: ev.filter(e => e.type === "error") };
  }

  it("hyperliquid bbo{coin}", async () => {
    const r = await bbo(hyperliquid, HL_ROUTES, "BTC", fixtureFrames("hyperliquid", "bbo").slice(0, 4));
    expect(r.t.last().sentJson()).toEqual([{ method: "subscribe", subscription: { type: "bbo", coin: "BTC" } }]);
    expect(r.errors).toEqual([]);
    expect(r.bbo[0]).toMatchObject({ venue: "hyperliquid", dex: null, symbol: "BTC", bid: "83234.0", bidSize: "0.00277", ask: "83235.0", askSize: "19.04009", venueTs: 1791900008348 });
    expect(r.bbo).toHaveLength(4);
  });

  it("pacifica bbo: out-of-order li dropped; ≤ 20 per connection", async () => {
    const frames = fixtureFrames("pacifica", "bbo");
    const r = await bbo(pacifica, PACIFICA_ROUTES, "BTC", [frames[1], frames[0], frames[1], frames[2]]);
    expect(r.t.last().sentJson()).toEqual([{ method: "subscribe", params: { source: "bbo", symbol: "BTC" } }]);
    expect(r.bbo.map(b => b.askSize)).toEqual(["0.51561", "0.53713"]); // frames[0] (older li) and the duplicate dropped
    expect(r.errors).toEqual([]);
  });

  it("lighter ticker/{id}, aster bookTicker, arcus bbo", async () => {
    const l = await bbo(lighter, LIGHTER_ROUTES, "BTC", fixtureFrames("lighter", "ticker"));
    expect(l.t.last().sentJson()).toEqual([{ type: "subscribe", channel: "ticker/1" }]);
    expect(l.bbo[0]).toMatchObject({ symbol: "BTC", bid: "83228.7", bidSize: "0.00130", ask: "83230.5", askSize: "0.03003", venueTs: 1791900008501 });
    expect(l.errors).toEqual([]);
    const a = await bbo(aster, ASTER_ROUTES, "BTCUSDT", [{ id: 1, result: null }, ...fixtureFrames("aster", "bookTicker")]);
    expect(a.t.last().sentJson()).toEqual([{ method: "SUBSCRIBE", params: ["btcusdt@bookTicker"], id: 1 }]);
    expect(a.bbo).toHaveLength(4);
    expect(a.bbo[0]).toMatchObject({ symbol: "BTCUSDT", bid: "83225.8", bidSize: "0.551", ask: "83225.9", askSize: "0.001" });
    expect(a.errors).toEqual([]);
    const c = await bbo(arcus, ARCUS_ROUTES, "BTC-USD", fixtureFrames("arcus", "bbo"));
    expect(c.t.last().sentJson()).toEqual([{ type: "subscribe", channel: "bbo", id: "BTC-USD" }]);
    expect(c.bbo[0]).toMatchObject({ symbol: "BTC-USD", bid: "83151.6", askSize: "0.48202108", venueTs: 1791900008416 });
    expect(c.errors).toEqual([]);
  });

  const pacDir = (symbols: string[]) => ({
    "GET https://api.pacifica.fi/api/v1/info": { success: true, data: symbols.map(symbol => ({ symbol, instrument_type: "perpetual", base_asset: symbol })) },
  });
  const bboSource = (ws: { sentJson(): unknown[] }) =>
    (ws.sentJson() as Array<{ method: string; params: { source: string; symbol?: string } }>).filter(m => m.method === "subscribe").map(m => m.params.symbol === undefined ? m.params.source : m.params.symbol);

  it("pacifica: > 20 bbo channels are spread over sockets (20 per channel per connection), prices stays on the first", async () => {
    const symbols = Array.from({ length: 45 }, (_, i) => `S${i}`);
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(pacDir(symbols)), visibility: null });
    const states: Array<{ status: string; sockets?: number }> = [];
    stream.onState(st => states.push(st as { status: string; sockets?: number }));
    const all = stream.subscribe({ kind: "allMarkets" });
    const subs = symbols.map(s => stream.subscribe({ kind: "market", symbol: s, channels: ["bbo"] }));
    await flush(80);
    expect(t.sockets).toHaveLength(3);
    for (const ws of t.sockets) ws.open();
    expect(bboSource(t.sockets[0])).toEqual(["prices", ...symbols.slice(0, 20)]);
    expect(bboSource(t.sockets[1])).toEqual(symbols.slice(20, 40));
    expect(bboSource(t.sockets[2])).toEqual(symbols.slice(40));
    expect(stream.state).toMatchObject({ status: "live", sockets: 3 });
    // Acks / frames are routed by wire on whichever socket they arrive.
    t.sockets[0].message({ channel: "subscribe", data: { source: "prices" } });
    symbols.forEach((s, i) => t.sockets[Math.floor(i / 20)].message({ channel: "subscribe", data: { source: "bbo", symbol: s } }));
    await expect(all.ready).resolves.toBeUndefined();
    await Promise.all(subs.map(x => x.ready));
    const got: BboUpdate[] = [];
    subs[44].on(e => { if (e.type === "bbo") got.push(e as BboUpdate); });
    t.sockets[2].message({ channel: "bbo", data: { s: "S44", i: 1, b: "1", B: "2", a: "3", A: "4", t: 5, li: 7 } });
    expect(got.map(b => [b.symbol, b.bid, b.ask])).toEqual([["S44", "1", "3"]]);
    // Releasing every wire of the third socket closes only that socket; the aggregate stays live.
    for (const x of subs.slice(40)) await x.unsubscribe();
    expect(t.sockets[2].closedWith).toEqual({ code: 1000, reason: "idle" });
    expect(t.sockets[0].closedWith).toBeNull();
    expect(stream.state).toMatchObject({ status: "live", sockets: 2 });
    // The first two sockets are full for bbo: a new bbo channel reopens the idle third slot (no 4th slot).
    const again = stream.subscribe({ kind: "market", symbol: "S40", channels: ["bbo"] });
    await flush(40);
    expect(t.sockets).toHaveLength(4);
    t.last().open();
    expect(bboSource(t.last())).toEqual(["S40"]);
    expect(again.status).toBe("pending");
    await stream.close();
    expect(states.at(-1)).toMatchObject({ status: "closed" });
  });

  it("pacifica: bbo beyond 20 × budget.maxSockets → SUBSCRIPTION_LIMIT before any send", async () => {
    const symbols = Array.from({ length: 41 }, (_, i) => `S${i}`);
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(pacDir(symbols)), visibility: null, budget: { maxSockets: 2 } });
    const subs = symbols.map(s => stream.subscribe({ kind: "market", symbol: s, channels: ["bbo"] }));
    await flush(80);
    await expect(subs[40].ready).rejects.toMatchObject({ structured: { code: "SUBSCRIPTION_LIMIT", details: { needed: 41, allowed: 40 } } });
    expect(subs[39].status).toBe("pending");
    expect(t.sockets).toHaveLength(2);
    for (const ws of t.sockets) ws.open();
    expect(t.sockets.flatMap(bboSource)).toEqual(symbols.slice(0, 40)); // the rejected one was never sent
  });

  it("pacifica: the new-connection budget is shared by the stream's sockets; one socket's reconnects exhausted closes the stream", async () => {
    const symbols = Array.from({ length: 45 }, (_, i) => `S${i}`);
    const t = fakeTransport();
    const stream = createVenueStream(pacifica, {
      transport: t.factory, fetch: fakeFetch(pacDir(symbols)), visibility: null,
      budget: { newConnectionsPerMin: 2 }, reconnect: { maxAttempts: 1, baseMs: 1000, maxMs: 1000 },
    });
    const subs = symbols.map(s => stream.subscribe({ kind: "market", symbol: s, channels: ["bbo"] }));
    await flush(80);
    expect(t.sockets).toHaveLength(2); // the third socket waits for the per-stream budget
    const ack = (ws: (typeof t.sockets)[number], from: number, to: number) => {
      ws.open();
      for (const sym of symbols.slice(from, to)) ws.message({ channel: "subscribe", data: { source: "bbo", symbol: sym } });
    };
    ack(t.sockets[0], 0, 20);
    ack(t.sockets[1], 20, 40);
    for (let i = 0; i < 3; i++) { vi.advanceTimersByTime(20_000); for (const ws of t.sockets) ws.message({ channel: "pong" }); }
    expect(t.sockets).toHaveLength(3);
    ack(t.sockets[2], 40, 45);
    await Promise.all(subs.map(x => x.ready));
    t.sockets[1].serverClose(1006);
    vi.advanceTimersByTime(60_000);
    t.last().serverClose(1006); // handshake fails again → attempts exhausted
    expect(stream.state).toMatchObject({ status: "closed", reason: { code: "EXCHANGE_UNREACHABLE" } });
    expect(subs.map(x => x.status)).toEqual(symbols.map(() => "closed")); // active subscriptions ended with the close reason
    expect(t.sockets[0].closedWith).not.toBeNull(); // the healthy sockets were stopped too
  });

  /** Pacifica stream with `n` bbo symbols (+ optional user channels), sockets opened and every channel acked. */
  async function spread(n: number, extra: VenueStreamOptions = {}, user = false) {
    const symbols = Array.from({ length: n }, (_, i) => `S${i}`);
    const t = fakeTransport();
    const logs: StreamLog[] = [];
    const stream = createVenueStream(pacifica, { transport: t.factory, fetch: fakeFetch(pacDir(symbols)), visibility: null, credentials: pacUser, logger: l => logs.push(l), ...extra });
    const states: unknown[] = [];
    stream.onState(st => states.push(st));
    const userEv: Ev[] = [];
    const usub = user ? stream.subscribe({ kind: "user", channels: ["orders", "fills"] }) : null;
    usub?.on(e => userEv.push(e as Ev));
    await flush(40);
    const subs = symbols.map(sym => stream.subscribe({ kind: "market", symbol: sym, channels: ["bbo"] }));
    await flush(80);
    return { symbols, t, stream, states, subs, usub, userEv, logs };
  }
  const ackAll = (ws: FakeWs) => {
    for (const m of ws.sentJson() as Array<{ method: string; params: { source: string; symbol?: string; account?: string } }>) {
      if (m.method === "subscribe") ws.message({ channel: "subscribe", data: m.params });
    }
  };
  const sockState = (st: unknown) => st as { status: string; sockets?: number; pending?: number };

  it("state sequence when a 2nd socket is added (budget ok, then budget-deferred), and M1: a deferred socket whose channels are all released never opens", async () => {
    const r = await spread(21, { budget: { newConnectionsPerMin: 1 } });
    // Socket 0 connected; socket 1 is deferred by the budget (1/min): it reports as pending, not idle.
    expect(r.t.sockets).toHaveLength(1);
    expect(r.stream.state).toEqual({ status: "connecting", attempt: 1 });
    r.t.sockets[0].open();
    ackAll(r.t.sockets[0]);
    expect(sockState(r.stream.state)).toMatchObject({ status: "live", sockets: 1, pending: 1 });
    // Release the 21st (the only channel on the deferred socket): its connect is cancelled.
    await r.subs[20].unsubscribe();
    expect(sockState(r.stream.state)).toMatchObject({ status: "live", sockets: 1, pending: 0 });
    for (let i = 0; i < 6; i++) { vi.advanceTimersByTime(20_000); r.t.sockets[0].message({ channel: "pong" }); }
    expect(r.t.sockets).toHaveLength(1); // no empty socket opened after the budget window
    // Re-adding it: budget available now → socket 1 connects; the stream stays live (pending 1) until it opens.
    const again = r.stream.subscribe({ kind: "market", symbol: "S20", channels: ["bbo"] });
    await flush(40);
    expect(r.t.sockets).toHaveLength(2);
    r.t.sockets[1].open();
    expect(r.states.map(sockState).map(s => [s.status, s.sockets, s.pending])).toEqual([
      ["connecting", undefined, undefined], ["live", 1, 1], ["live", 1, 0], ["live", 1, 1], ["live", 2, 0],
    ]);
    ackAll(r.t.sockets[1]);
    await expect(again.ready).resolves.toBeUndefined();
  });

  it("one socket reconnecting: the stream reports reconnecting; only that socket resubscribes; gaps only for channels on it", async () => {
    const r = await spread(25, {}, true); // socket 0: account_order_updates, account_trades + S0..S19; socket 1: S20..S24
    for (const ws of r.t.sockets) { ws.open(); ackAll(ws); }
    expect(r.t.sockets).toHaveLength(2);
    expect(bboSource(r.t.sockets[0]).slice(0, 2)).toEqual(["account_order_updates", "account_trades"]);
    await Promise.all([...r.subs.map(x => x.ready), r.usub!.ready]);
    const gaps0 = r.userEv.filter(e => e.type === "gap").length;
    const sent0 = r.t.sockets[0].sent.length;
    r.t.sockets[1].serverClose(1006);
    expect(r.stream.state).toMatchObject({ status: "reconnecting" });
    vi.advanceTimersByTime(1_000);
    expect(r.t.sockets).toHaveLength(3);
    r.t.last().open();
    expect(bboSource(r.t.last())).toEqual(r.symbols.slice(20)); // only socket 1's channels
    expect(r.t.sockets[0].sent.length).toBe(sent0); // socket 0 untouched
    expect(r.userEv.filter(e => e.type === "gap").length).toBe(gaps0); // its user channels had no gap
    expect(sockState(r.stream.state)).toMatchObject({ status: "live", sockets: 2, pending: 0 });
    // Socket 0 dropping → gaps for the user channels on it.
    r.t.sockets[0].serverClose(1006);
    vi.advanceTimersByTime(1_000);
    r.t.last().open();
    expect(r.userEv.filter(e => e.type === "gap").slice(gaps0).map(g => (g as { channel: string }).channel)).toEqual(["orders", "fills"]);
  });

  it("a stale socket makes the stream stale (channel named); data recovers it to live with every socket counted", async () => {
    const r = await spread(25);
    const all = r.stream.subscribe({ kind: "allMarkets" });
    await flush(40);
    for (const ws of r.t.sockets) { ws.open(); ackAll(ws); }
    expect(bboSource(r.t.sockets[0])).toContain("prices");
    await all.ready;
    const row = { symbol: "S0", mark: "1", oracle: "1", funding: "0", next_funding: "0", open_interest: "0", volume_24h: "0", timestamp: 1 };
    r.t.sockets[0].message({ channel: "prices", data: [row] });
    vi.advanceTimersByTime(11_000);
    for (const ws of r.t.sockets) ws.message({ channel: "pong" });
    expect(r.stream.state).toMatchObject({ status: "stale", channel: "prices" });
    r.t.sockets[0].message({ channel: "prices", data: [row] });
    expect(sockState(r.stream.state)).toMatchObject({ status: "live", sockets: 2, pending: 0 });
  });

  it("a frame / ack for a wire that lives on another socket is ignored (late-frame logged)", async () => {
    const r = await spread(25);
    for (const ws of r.t.sockets) ws.open();
    ackAll(r.t.sockets[0]);
    // S20's ack arrives on socket 0 (it lives on socket 1): not an ack.
    r.t.sockets[0].message({ channel: "subscribe", data: { source: "bbo", symbol: "S20" } });
    r.t.sockets[0].message({ channel: "bbo", data: { s: "S20", b: "1", B: "1", a: "2", A: "1", t: 1, li: 1 } });
    expect(r.subs[20].status).toBe("pending");
    const got: BboUpdate[] = [];
    r.subs[20].on(e => { if (e.type === "bbo") got.push(e as BboUpdate); });
    r.t.sockets[0].message({ channel: "bbo", data: { s: "S20", b: "1", B: "1", a: "2", A: "1", t: 1, li: 2 } });
    expect(got).toEqual([]);
    expect(r.logs.filter(l => l.event === "late-ack" || l.event === "late-frame").map(l => l.message)).toEqual([
      "ack for bbo:S20 on socket 0; it lives on socket 1",
      "frame for bbo:S20 on socket 0; it lives on socket 1",
      "frame for bbo:S20 on socket 0; it lives on socket 1",
    ]);
    r.t.sockets[1].message({ channel: "bbo", data: { s: "S20", b: "1", B: "1", a: "2", A: "1", t: 1, li: 3 } });
    expect(got).toHaveLength(1);
    expect(r.subs[20].status).toBe("active");
  });

  it("maxPayload closes count per socket: 3 on socket 1 fail only its subscriptions", async () => {
    const r = await spread(25);
    for (const ws of r.t.sockets) { ws.open(); ackAll(ws); }
    await Promise.all(r.subs.map(x => x.ready));
    const tooBig = (ws: FakeWs) => { ws.onerror?.({ code: "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH" }); ws.serverClose(1006); };
    const tick = () => { vi.advanceTimersByTime(20_000); for (const ws of r.t.sockets) ws.message({ channel: "pong" }); };
    tooBig(r.t.sockets[0]); // one on socket 0
    tick();
    const s0 = r.t.last();
    s0.open(); ackAll(s0);
    let ws1 = r.t.sockets[1];
    for (let i = 0; i < 3; i++) {
      tooBig(ws1);
      if (i < 2) { tick(); ws1 = r.t.last(); ws1.open(); ackAll(ws1); }
    }
    expect(r.subs.slice(20).map(x => x.status)).toEqual(Array(5).fill("closed"));
    expect(r.subs.slice(0, 20).every(x => x.status === "active")).toBe(true);
    expect(sockState(r.stream.state)).toMatchObject({ status: "live", sockets: 1 });
  });

  it("hyperliquid (per-IP limits, no maxSockets): every channel stays on one socket", async () => {
    const t = fakeTransport();
    const stream = createVenueStream(hyperliquid, { transport: t.factory, fetch: fakeFetch(HL_ROUTES), visibility: null });
    for (const s of ["BTC", "ETH", "SOL", "ATOM", "DYDX"]) stream.subscribe({ kind: "market", symbol: s, channels: ["bbo", "market"] });
    await flush(80);
    expect(t.sockets).toHaveLength(1);
  });

});

describe("CLI credential provider", () => {
  it("is a perp-cli/ws CredentialProvider (structural)", () => {
    const p: CredentialProvider = createCliCredentialProvider("lighter", "mainnet");
    expect(typeof p.user).toBe("function");
    expect(typeof p.authToken).toBe("function");
    expect(createCliCredentialProvider("hyperliquid", "mainnet").authToken).toBeUndefined();
  });
});

describe("lighter auth token resilience", () => {
  const tok = (n: number) => `1791903600:${LIGHTER_ACCT}:3:${"cd".repeat(40)}${n}`;
  function scripted(results: Array<"ok" | "transient" | "definite">, ttlMs = 100_000) {
    let n = 0;
    const p: CredentialProvider & { calls: number } = {
      calls: 0,
      user: async () => ({ venue: "lighter", accountIndex: LIGHTER_ACCT }),
      authToken: async () => {
        const r = results[Math.min(p.calls, results.length - 1)];
        p.calls++;
        if (r === "transient") throw new Error(`network blip (token=${tok(77)})`);
        if (r === "definite") throw Object.assign(new Error("keystore needs a passphrase"), { structured: { code: "PASSPHRASE_REQUIRED", message: "keystore needs a passphrase", status: 401, retryable: false } });
        return { token: tok(++n), expiresAt: Date.now() + ttlMs };
      },
    };
    return p;
  }
  async function ordersStream(cred: CredentialProvider) {
    const r = await userStream(lighter, LIGHTER_ROUTES, cred, ["orders"]);
    r.t.last().open();
    r.t.last().message({ channel: `account_all_orders:${LIGHTER_ACCT}`, type: "subscribed/account_all_orders", orders: {} });
    await r.sub.ready;
    return r;
  }
  const advance = async (r: Awaited<ReturnType<typeof ordersStream>>, ms: number) => {
    for (let t = 0; t < ms; t += 5_000) { vi.advanceTimersByTime(5_000); r.t.last().message({ type: "pong" }); await flush(10); }
  };
  const authSubs = (r: Awaited<ReturnType<typeof ordersStream>>) =>
    (r.t.last().sentJson() as Array<{ type: string; auth?: string }>).filter(m => m.type === "subscribe" && m.auth !== undefined).map(m => m.auth);

  it("a transient refresh failure is retried with backoff while the token is valid; the channel survives", async () => {
    const cred = scripted(["ok", "transient", "transient", "ok"]);
    const r = await ordersStream(cred);
    await advance(r, 80_000); // refresh due at 80 s → fails, retries 1 s, 2 s → ok
    await advance(r, 10_000);
    expect(cred.calls).toBe(4);
    expect(r.sub.status).toBe("active");
    expect(authSubs(r)).toEqual([tok(1), tok(2)]);
    expect(r.of("error").filter(e => e.type === "error" && e.fatal)).toEqual([]);
    expect(r.of("error").length).toBe(2); // non-fatal retry notices
    expect(JSON.stringify({ ev: r.ev, logs: r.logs })).not.toContain(tok(77));
  });

  it("transient failures until the token expires → WS_AUTH_FAILED (fatal)", async () => {
    const cred = scripted(["ok", "transient"], 100_000);
    const r = await ordersStream(cred);
    await advance(r, 140_000);
    await expect(r.sub.ready).resolves.toBeUndefined();
    expect(r.sub.status).toBe("closed");
    expect(r.of("error").at(-1)).toMatchObject({ code: "WS_AUTH_FAILED", fatal: true });
  });

  it("a definite failure (non-retryable provider error) fails at once", async () => {
    const cred = scripted(["ok", "definite"]);
    const r = await ordersStream(cred);
    await advance(r, 80_000);
    expect(cred.calls).toBe(2);
    expect(r.sub.status).toBe("closed");
    expect(r.of("error").at(-1)).toMatchObject({ code: "WS_AUTH_FAILED", fatal: true });
  });

  it("reconnect after the token expired: a transient fetch failure is retried, then the channel resubscribes", async () => {
    const cred = scripted(["ok", "transient", "ok"], 10_000);
    const r = await userStream(lighter, LIGHTER_ROUTES, cred, ["orders"], { reconnect: { maxAttempts: null, baseMs: 100, maxMs: 100 } });
    r.t.last().open();
    r.t.last().message({ channel: `account_all_orders:${LIGHTER_ACCT}`, type: "subscribed/account_all_orders", orders: {} });
    await r.sub.ready;
    r.t.last().serverClose(1006);
    // outage longer than the token TTL (handshakes keep failing); the 80 % refresh finds no open socket
    for (let i = 0; i < 30; i++) { vi.advanceTimersByTime(500); await flush(5); if (r.t.last().readyState === 0) r.t.last().serverClose(1006); }
    const sockets = r.t.sockets.length;
    vi.advanceTimersByTime(500);
    expect(r.t.sockets.length).toBeGreaterThan(sockets);
    r.t.last().open(); // token expired: fetch → transient → retried after 1 s → ok
    for (let i = 0; i < 4; i++) { vi.advanceTimersByTime(1_000); r.t.last().message({ type: "pong" }); await flush(10); }
    expect(cred.calls).toBe(3); // the refresh due while offline was skipped (no socket to resubscribe)
    expect(r.sub.status).toBe("active");
    const subs = (r.t.last().sentJson() as Array<{ type: string; auth?: string }>).filter(m => m.type === "subscribe");
    expect(subs).toHaveLength(1);
    expect(subs[0].auth).toBe(tok(2));
  });
});

describe("lighter auth token: one refresh loop per purpose", () => {
  const tok = (n: number) => `1791903600:${LIGHTER_ACCT}:3:${"9a".repeat(40)}${n}`;
  function failingAfterFirst(ttlMs: number) {
    const p: CredentialProvider & { calls: number[] } = {
      calls: [],
      user: async () => ({ venue: "lighter", accountIndex: LIGHTER_ACCT }),
      authToken: async () => {
        p.calls.push(Date.now());
        if (p.calls.length === 1) return { token: tok(1), expiresAt: Date.now() + ttlMs };
        throw new Error("net down");
      },
    };
    return p;
  }
  async function start(cred: CredentialProvider) {
    const r = await userStream(lighter, LIGHTER_ROUTES, cred, ["orders"], { reconnect: { maxAttempts: null, baseMs: 100, maxMs: 100 } });
    r.t.last().open();
    r.t.last().message({ channel: `account_all_orders:${LIGHTER_ACCT}`, type: "subscribed/account_all_orders", orders: {} });
    await r.sub.ready;
    return r;
  }
  const step = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush(10); }; // microtasks between timers

  it("a failing refresh plus 3 reconnects calls the provider once per backoff step", async () => {
    const cred = failingAfterFirst(10_000);
    const r = await start(cred);
    const t0 = Date.now();
    await step(8_000); // refresh due (80 %) → loop: call 2
    for (let i = 0; i < 3; i++) { r.t.last().serverClose(1006); await step(100); r.t.last().open(); await step(100); } // reconnects at ~8.2–8.6 s
    await step(2_900); // → 11.5 s: retries at +1 s (9 s) and +2 s (11 s)
    expect(cred.calls.slice(1).map(c => c - t0)).toEqual([8_000, 9_000, 11_000]);
    expect(r.logs.filter(l => l.event === "auth-token-retry")).toHaveLength(3);
    expect(r.of("error").filter(e => e.type === "error" && !e.fatal)).toHaveLength(3);
  });

  it("the retry loop stops once no channel uses the token any more", async () => {
    const cred = failingAfterFirst(100_000);
    const r = await start(cred);
    for (let i = 0; i < 16; i++) { await step(5_000); r.t.last().message({ type: "pong" }); } // 80 s: refresh fails → retry scheduled
    const n = cred.calls.length;
    expect(n).toBe(2);
    await r.sub.unsubscribe();
    await step(120_000);
    expect(cred.calls.length).toBe(n);
    expect(r.logs.some(l => l.event === "auth-token-retry-stopped")).toBe(true);
  });
});

describe("CLI credential provider behaviour", () => {
  const meta = { accountIndex: LIGHTER_ACCT, apiKeyIndex: 3 } as never;
  const SECRET_KEY = "ab".repeat(40);
  const decryptFail = () => Object.assign(new Error("LIGHTER_KEYSTORE_DECRYPT_FAILED: Unsupported state or unable to authenticate data"), {
    structured: { code: "SIGNATURE_FAILED", message: "x", status: 500, retryable: false },
  });

  it("a passphrase-protected keystore → PASSPHRASE_REQUIRED; other keystore errors keep their code with a safe message", async () => {
    const { PerpError } = await import("../../errors.js");
    const pass = createCliCredentialProvider("lighter", "mainnet", {
      lighterAgent: () => meta,
      loadLighterKey: async () => { throw new PerpError("SIGNATURE_FAILED", "LIGHTER_KEYSTORE_DECRYPT_FAILED: Unsupported state or unable to authenticate data"); },
    });
    await expect(pass.authToken!({ purpose: "x", maxTtlSec: 60 })).rejects.toMatchObject({ structured: { code: "PASSPHRASE_REQUIRED" } });
    const missing = createCliCredentialProvider("lighter", "mainnet", {
      lighterAgent: () => meta,
      loadLighterKey: async () => { throw new PerpError("KEY_NOT_FOUND", `LIGHTER_KEYSTORE_NOT_FOUND: /home/u/.perp/lighter-agents/${SECRET_KEY}.json`, { remediation: "approve an agent" }); },
    });
    const err = await missing.authToken!({ purpose: "x", maxTtlSec: 60 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ structured: { code: "KEY_NOT_FOUND", remediation: "approve an agent" } });
    expect(JSON.stringify(err) + String((err as Error).message)).not.toContain(SECRET_KEY);
    void decryptFail;
  });

  it("decrypts the key once and reuses one signer; never logs; the key never reaches errors", async () => {
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    let loads = 0;
    let signers = 0;
    let fail = false;
    const p = createCliCredentialProvider("lighter", "mainnet", {
      lighterAgent: () => meta,
      loadLighterKey: async () => { loads++; return SECRET_KEY; },
      makeLighterSigner: async (_v, _n, _m, key) => {
        signers++;
        expect(key).toBe(SECRET_KEY);
        return { createAuthToken: async (deadline) => { if (fail) throw new Error("wasm signer failed"); return `${deadline}:1:3:${"ef".repeat(40)}`; } };
      },
    });
    const a = await p.authToken!({ purpose: "x", maxTtlSec: 60 });
    const b = await p.authToken!({ purpose: "x", maxTtlSec: 120 });
    expect([loads, signers]).toEqual([1, 1]);
    expect(b.expiresAt - a.expiresAt).toBeGreaterThanOrEqual(59_000);
    fail = true;
    const e = await p.authToken!({ purpose: "x", maxTtlSec: 60 }).catch((x: unknown) => x);
    expect(String((e as Error).message)).not.toContain(SECRET_KEY);
    expect([log, err, warn].every(s => s.mock.calls.length === 0)).toBe(true);
  });

  it("arcus all-subaccounts agent (255) → subaccount null with a warning", async () => {
    const p = createCliCredentialProvider("arcus", "mainnet", { arcusAgent: () => ({ ownerAddress: EVM, accountIndex: 255 }) });
    await expect(p.user()).resolves.toEqual({ venue: "arcus", address: EVM, subaccount: null });
    expect(p.warnings).toEqual([expect.stringContaining("all subaccounts")]);
    const q = createCliCredentialProvider("arcus", "mainnet", { arcusAgent: () => ({ ownerAddress: EVM, accountIndex: 2 }) });
    await expect(q.user()).resolves.toEqual({ venue: "arcus", address: EVM, subaccount: 2 });
    expect(q.warnings).toEqual([]);
  });
});

describe("clientId round-trip, Lighter fees, Arcus positions (consumer requests)", () => {
  it("hyperliquid: cloid on open orders, order updates and (when present) fills", async () => {
    const r = await userStream(hyperliquid, HL_ROUTES, hlUser, ["orders", "fills"]);
    r.t.last().open();
    const order = { coin: "BTC", side: "B", limitPx: "1", sz: "1", oid: 5, timestamp: 1, origSz: "1", cloid: "0x0000000000000000000000000000abcd" };
    r.t.last().message({ channel: "openOrders", data: { dex: "", user: EVM, orders: [order] } });
    expect(r.of("orders").at(-1)!.orders[0].clientId).toBe("0x0000000000000000000000000000abcd");
    r.t.last().message({ channel: "orderUpdates", data: [{ order: { ...order, oid: 6, cloid: "0x0000000000000000000000000000beef" }, status: "open", statusTimestamp: 2 }] });
    expect(r.of("orders").at(-1)!.orders.map(o => o.clientId)).toEqual(["0x0000000000000000000000000000abcd", "0x0000000000000000000000000000beef"]);
    r.t.last().message({ channel: "userFills", data: { user: EVM, fills: [{ coin: "BTC", px: "1", sz: "1", side: "B", time: 1, tid: 1, oid: 5, crossed: true, fee: "0", feeToken: "USDC", closedPnl: "0", cloid: "0x0000000000000000000000000000abcd" }, { coin: "BTC", px: "1", sz: "1", side: "B", time: 2, tid: 2, oid: 7, crossed: true, fee: "0", feeToken: "USDC", closedPnl: "0" }] } });
    expect(r.of("fill").map(f => f.fill.clientId)).toEqual(["0x0000000000000000000000000000abcd", null]);
  });

  it("pacifica: I on order updates and trades", async () => {
    const r = await userStream(pacifica, PACIFICA_ROUTES, pacUser, ["orders", "fills"]);
    r.t.last().open();
    const cid = "00000000-0000-4000-8000-000000000001";
    r.t.last().message({ channel: "account_order_updates", data: [{ i: 5, I: cid, s: "BTC", d: "bid", ip: "1", a: "1", f: "0", os: "open", ot: "limit", li: 1 }] });
    r.t.last().message({ channel: "account_trades", data: [{ h: 9, i: 5, I: cid, s: "BTC", p: "1", a: "1", te: "fulfill_taker", ts: "open_long", f: "0", n: "0", t: 1, li: 2 }] });
    expect(r.of("orders").at(-1)!.orders[0].clientId).toBe(cid);
    expect(r.of("fill")[0].fill.clientId).toBe(cid);
  });

  it("lighter: client_order_id on orders; client ids and fee (usd_amount × rate × 1e-6) per leg on fills", async () => {
    const cred: CredentialProvider = {
      user: async () => ({ venue: "lighter", accountIndex: LIGHTER_ACCT }),
      authToken: async () => ({ token: "t".repeat(32), expiresAt: Date.now() + 3_600_000 }),
    };
    const r = await userStream(lighter, LIGHTER_ROUTES, cred, ["orders", "fills"]);
    r.t.last().open();
    r.t.last().message({
      channel: `account_all_orders:${LIGHTER_ACCT}`, type: "update/account_all_orders",
      orders: { 1: [{ order_index: 77, order_id: "77", client_order_index: 4242, client_order_id: "4242", market_index: 1, is_ask: false, status: "open", price: "1", initial_base_amount: "1", filled_base_amount: "0", remaining_base_amount: "1" }] },
    });
    expect(r.of("orders").at(-1)!.orders[0]).toMatchObject({ orderId: "77", clientId: "4242" });
    // the documented example trade (websocket reference, Trade JSON): taker bid, maker ask; we are both sides
    const trade = {
      trade_id: 16164557907, trade_id_str: "16164557907", type: "trade", market_id: 1, size: "0.1336", price: "2181.83", usd_amount: "291.492488",
      ask_id_str: "281476612587355", bid_id_str: "562948334068259", ask_client_id_str: "363283", bid_client_id_str: "23004521241",
      ask_account_id: LIGHTER_ACCT, bid_account_id: LIGHTER_ACCT, is_maker_ask: true, timestamp: 1773854156654, taker_fee: 196, maker_fee: 28,
    };
    r.t.last().message({ channel: `account_all_trades:${LIGHTER_ACCT}`, type: "update/account_all_trades", trades: { 1: [trade] } });
    expect(r.of("fill").map(f => [f.fill.side, f.fill.liquidity, f.fill.clientId, f.fill.fee, f.fill.feeToken])).toEqual([
      ["sell", "maker", "363283", "0.008161789664", "USDC"],
      ["buy", "taker", "23004521241", "0.057132527648", "USDC"],
    ]);
    // a zero fee is omitted by the venue (omitempty) → "0"
    r.t.last().message({ channel: `account_all_trades:${LIGHTER_ACCT}`, type: "update/account_all_trades", trades: { 1: [{ ...trade, trade_id_str: "2", maker_fee: undefined, bid_account_id: 5 }] } });
    expect(r.of("fill").at(-1)!.fill).toMatchObject({ side: "sell", liquidity: "maker", fee: "0" });
  });

  it("arcus: clientId on orders and fills; signed position size, mark, value, margin; no liquidation price", async () => {
    const r = await userStream(arcus, ARCUS_ROUTES, arcUser, ["positions", "orders", "fills"]);
    r.t.last().open();
    for (const f of fixtureFrames("arcus", "private-account").slice(1)) r.t.last().message(f);
    expect(r.of("fills")[0].fills.map(f => f.clientId)).toEqual(["dummy-id-12", "dummy-id-14"]);
    r.t.last().message({ type: "channel_data", channel: "orders", id: EVM, contents: { orderId: "o-1", clientId: "my-order-42", marketId: 1, side: "BUY", status: "OPEN", price: "1", originalSize: "1", remainingSize: "1" } });
    expect(r.of("orders").at(-1)!.orders[0]).toMatchObject({ orderId: "o-1", clientId: "my-order-42" });
    r.t.last().message({ type: "channel_data", channel: "positions", id: EVM, contents: { isSnapshot: false, marketId: 1, side: "SHORT", size: "-0.2", averageEntryPrice: "80000", markPx: "79000", positionValueNotional: "15800", unrealizedPnl: "200", marginUsed: "790" } });
    expect(r.of("positions").at(-1)!.positions[0]).toEqual(expect.objectContaining({
      symbol: "BTC-USD", side: "short", size: "0.2", markPrice: "79000", positionValue: "15800", unrealizedPnl: "200", marginUsed: "790", liquidationPrice: null,
    }));
  });
});

describe("lighter: liquidation price \"0\" and client id 0 (review)", () => {
  const cred: CredentialProvider = {
    user: async () => ({ venue: "lighter", accountIndex: LIGHTER_ACCT }),
    authToken: async () => ({ token: "t".repeat(32), expiresAt: Date.now() + 3_600_000 }),
  };
  const pos = (liq: string) => ({
    market_id: 1, symbol: "BTC", sign: -1, position: "0.5", avg_entry_price: "80000", position_value: "40000",
    unrealized_pnl: "-10", realized_pnl: "0", liquidation_price: liq, allocated_margin: "0",
  });

  it("an open position with liquidation_price \"0\" → null; a positive one is kept", async () => {
    const r = await userStream(lighter, LIGHTER_ROUTES, cred, ["positions"]);
    r.t.last().open();
    r.t.last().message({ channel: `account_all_positions:${LIGHTER_ACCT}`, type: "subscribed/account_all_positions", positions: { 1: pos("0"), 0: { ...pos("3100.5"), market_id: 0, symbol: "ETH" } } });
    const rows = r.of("positions").at(-1)!.positions;
    expect(rows.find(p => p.symbol === "BTC")).toMatchObject({ side: "short", size: "0.5", liquidationPrice: null });
    expect(rows.find(p => p.symbol === "ETH")).toMatchObject({ liquidationPrice: "3100.5" });
  });

  it("client id 0 means none → null on orders and fills", async () => {
    const r = await userStream(lighter, LIGHTER_ROUTES, cred, ["orders", "fills"]);
    r.t.last().open();
    r.t.last().message({
      channel: `account_all_orders:${LIGHTER_ACCT}`, type: "update/account_all_orders",
      orders: { 1: [{ order_index: 77, order_id: "77", client_order_index: 0, client_order_id: "0", market_index: 1, is_ask: true, status: "open", price: "1", initial_base_amount: "1" }] },
    });
    expect(r.of("orders").at(-1)!.orders[0].clientId).toBeNull();
    r.t.last().message({
      channel: `account_all_trades:${LIGHTER_ACCT}`, type: "update/account_all_trades",
      trades: { 1: [{ trade_id_str: "3", market_id: 1, size: "1", price: "1", usd_amount: "1", ask_id_str: "77", bid_id_str: "9", ask_client_id: 0, ask_client_id_str: "0", bid_client_id_str: "5", ask_account_id: LIGHTER_ACCT, bid_account_id: 2, is_maker_ask: true, timestamp: 1 }] },
    });
    expect(r.of("fill").at(-1)!.fill.clientId).toBeNull();
  });
});
