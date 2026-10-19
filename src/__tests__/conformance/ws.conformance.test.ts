/**
 * WS library conformance (docs/TESTING.md §3.6) — every exported codec of perp-cli/ws
 * (@hypurrquant/perp-ws), through the REAL stream (createVenueStream) with a fake WsFactory:
 *
 *  A. recorded frames (src/__tests__/fixtures/ws/<venue>/, scripts/ws-probe) replayed through the
 *     stream, on the directories the codec tests use (src/__tests__/ws/helpers.ts — they match the
 *     trimmed frames): schema 1; every Dec is a decimal string or null (never NaN / undefined /
 *     a "0" stand-in for "no data"); funding rateKind / predictedRate per the documented table
 *     (skills/perp-cli/references/ws-library.md); bbo bid < ask; the connection state sequence;
 *     close() leaves no timer; a rejected `ready` exposes `.code`.
 *  B. CLI ⇄ WS directory parity + eligibility, over ONE recorded, untrimmed fixture per venue
 *     (src/__tests__/fixtures/conformance/ws-<venue>.json — the REST directory the stream loads and
 *     the CLI `market list` / `market funding`, recorded together): the stream.markets() set equals
 *     the CLI market-list set (differences only through WS_DIRECTORY_ALLOWLIST, with a reason);
 *     non-tradable markets (SETTLING / PENDING / OFFLINE / inactive / delisted) appear in neither;
 *     canonical symbols and rateKind agree.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Sockets the CLI opens itself (Lighter `market list`: the market_stats funding snapshot) go
// through the session (recorded / replayed); this file's own stream transport uses the real `ws`.
vi.mock("ws", async (importOriginal) => {
  const real = await importOriginal<typeof import("ws")>();
  const { activeSession } = await import("./harness.js");
  const Real = real.default as unknown as new (...a: unknown[]) => never;
  const Wrapped = new Proxy(Real, {
    construct: (_t, args: unknown[]) => new (activeSession().wrapWs(Real as never) as unknown as new (...a: unknown[]) => object)(...args),
  });
  return { ...real, default: Wrapped, WebSocket: Wrapped };
});
const { default: WebSocket } = await vi.importActual<typeof import("ws")>("ws");
import "../../exchanges/venues/index.js";
import { createVenueStream } from "../../ws/stream.js";
import { USD_LIKE_QUOTES } from "../../ws/canonical.js";
import { hyperliquid } from "../../ws/codecs/hyperliquid.js";
import { pacifica } from "../../ws/codecs/pacifica.js";
import { lighter, lighterRh } from "../../ws/codecs/lighter.js";
import { aster } from "../../ws/codecs/aster.js";
import { arcus } from "../../ws/codecs/arcus.js";
import * as wsIndex from "../../ws/index.js";
import type { AllMarketsTarget, BboUpdate, ConnectionState, FetchLike, MarketDirectoryEntry, MarketUpdate, StreamControl, VenueCodec, WsFactory, WsLike } from "../../ws/types.js";
import {
  ARCUS_ROUTES, ASTER_ROUTES, HL_ROUTES, LIGHTER_RH_ROUTES, LIGHTER_ROUTES, PACIFICA_ROUTES, fakeFetch, fakeTransport, fixtureFrames, flush,
} from "../ws/helpers.js";
import { baseOf } from "./checks.js";
import { hasFixture, IS_LIVE, loadFixture, MODE, runCli, Session, VENUE_FILTER, type CliRun } from "./harness.js";
import type { Json } from "./fixture-tools.js";
import { expectCheck, staleKnownFailures } from "./known-failures.js";

const DEC = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

interface CodecCase {
  venue: string;
  codec: VenueCodec;
  routes: Record<string, unknown>;
  /** [fixture venue dir, frame file] of the all-markets channel. */
  market: [string, string];
  /** bbo channel frames (null = the venue's bbo is not a separate recorded channel). */
  bbo: [string, string] | null;
  /** A symbol of the trimmed fixtures, for the bbo subscription. */
  bboSymbol: string;
  /** Documented funding (ws-library.md §4): rate kind and whether predictedRate is published. */
  rateKind: "lastSettled" | "accruing";
  predicted: boolean;
}

const CASES: CodecCase[] = [
  { venue: "hyperliquid", codec: hyperliquid, routes: HL_ROUTES, market: ["hyperliquid", "allDexsAssetCtxs"], bbo: ["hyperliquid", "bbo"], bboSymbol: "BTC", rateKind: "accruing", predicted: false },
  { venue: "pacifica", codec: pacifica, routes: PACIFICA_ROUTES, market: ["pacifica", "prices"], bbo: ["pacifica", "bbo"], bboSymbol: "BTC", rateKind: "lastSettled", predicted: true },
  { venue: "lighter", codec: lighter, routes: LIGHTER_ROUTES, market: ["lighter", "market_stats-all"], bbo: ["lighter", "ticker"], bboSymbol: "BTC", rateKind: "lastSettled", predicted: true },
  { venue: "lighter-rh", codec: lighterRh, routes: LIGHTER_RH_ROUTES, market: ["lighter-rh", "market_stats-all"], bbo: ["lighter-rh", "ticker"], bboSymbol: "BTC", rateKind: "lastSettled", predicted: true },
  { venue: "aster", codec: aster, routes: ASTER_ROUTES, market: ["aster", "markPrice-arr"], bbo: ["aster", "bookTicker"], bboSymbol: "BTCUSDT", rateKind: "accruing", predicted: false },
  { venue: "arcus", codec: arcus, routes: ARCUS_ROUTES, market: ["arcus", "markets"], bbo: ["arcus", "bbo"], bboSymbol: "BTC-USD", rateKind: "lastSettled", predicted: true },
];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("every exported codec is covered", () => {
  it("the ws entry exports exactly the codecs in CASES", () => {
    const exported = Object.entries(wsIndex)
      .filter(([, v]) => v !== null && typeof v === "object" && "venue" in (v as object) && typeof (v as { venue: unknown }).venue === "string")
      .map(([, v]) => (v as { venue: string }).venue).sort();
    expect(exported).toEqual(CASES.map(c => c.venue).sort());
  });
});

/** Dec / "0"-stand-in / rateKind problems of a batch of market events. */
function marketProblems(markets: MarketUpdate[], c: CodecCase): { schema: string | null; decimals: string | null; zero: string | null; kind: string | null } {
  const bad: string[] = [];
  const zero: string[] = [];
  for (const m of markets) {
    const decs: Record<string, unknown> = {
      mark: m.mark, index: m.index, bestBid: m.bestBid, bestAsk: m.bestAsk, last: m.last, rate: m.funding.rate,
      predictedRate: m.funding.predictedRate, openInterest: m.openInterest.value, volume24hNotional: m.volume24hNotional,
    };
    for (const [k, v] of Object.entries(decs)) {
      if (v === undefined || (v !== null && (typeof v !== "string" || !DEC.test(v)))) bad.push(`${m.symbol}.${k}=${String(v)}`);
    }
    // Prices are never 0: a "0" here is a stand-in for "no data" (must be null).
    for (const k of ["mark", "index", "bestBid", "bestAsk", "last"] as const) if (m[k] !== null && Number(m[k]) === 0) zero.push(`${m.symbol}.${k}`);
  }
  const withRate = markets.filter(m => m.funding.rate !== null);
  const wrongKind = withRate.filter(m => m.funding.rateKind !== c.rateKind).map(m => `${m.symbol}:${m.funding.rateKind}`);
  const wrongPred = c.predicted ? [] : withRate.filter(m => m.funding.predictedRate !== null).map(m => m.symbol);
  return {
    schema: markets.every(m => m.schema === 1) ? null : "an event without schema 1",
    decimals: bad.length === 0 ? null : bad.slice(0, 5).join(", "),
    zero: zero.length === 0 ? null : `"0" for no data: ${[...new Set(zero)].slice(0, 6).join(", ")} (${zero.length} values)`,
    kind: wrongKind.length + wrongPred.length === 0 ? null : `kind ${wrongKind.slice(0, 3).join(",")}; predicted ${wrongPred.slice(0, 3).join(",")}`,
  };
}

async function replay(c: CodecCase, frames: unknown[], target: AllMarketsTarget | { kind: "market"; symbol: string; channels: Array<"market" | "bbo"> }) {
  const t = fakeTransport();
  const stream = createVenueStream(c.codec, { transport: t.factory, fetch: fakeFetch(c.routes), visibility: null });
  const states: ConnectionState["status"][] = [stream.state.status];
  stream.onState(s => states.push(s.status));
  const sub = target.kind === "allMarkets" ? stream.subscribe(target) : stream.subscribe(target);
  const events: Array<MarketUpdate | BboUpdate | StreamControl> = [];
  sub.on(e => events.push(e as MarketUpdate | BboUpdate | StreamControl));
  await flush(40);
  const ws = t.last();
  ws.open();
  for (const f of frames) ws.message(f);
  await flush(10);
  return { stream, sub, ws, states, events };
}

for (const c of CASES) {
  describe(`ws codec ${c.venue} (recorded frames)`, () => {
    const id = (check: string) => `ws:${c.venue}:${check}`;

    it("market events: schema 1, decimal strings or null, no \"0\" stand-in for no data", async () => {
      const { events, stream } = await replay(c, fixtureFrames(...c.market), { kind: "allMarkets" });
      const markets = events.filter((e): e is MarketUpdate => e.type === "market");
      expect(markets.length).toBeGreaterThan(0);
      const p = marketProblems(markets, c);
      expectCheck(id("schema"), p.schema);
      expectCheck(id("decimals"), p.decimals);
      expectCheck(id("no-zero-placeholder"), p.zero);
      await stream.close();
    });

    it(`funding rateKind = ${c.rateKind}, predictedRate ${c.predicted ? "published" : "null"} (documented table)`, async () => {
      const { events, stream } = await replay(c, fixtureFrames(...c.market), { kind: "allMarkets" });
      expectCheck(id("rate-kind"), marketProblems(events.filter((e): e is MarketUpdate => e.type === "market"), c).kind);
      await stream.close();
    });

    if (c.bbo !== null) {
      it("bbo: schema 1, decimal strings, bid < ask", async () => {
        const { events, stream } = await replay(c, fixtureFrames(...c.bbo!), { kind: "market", symbol: c.bboSymbol, channels: ["bbo"] });
        const bbos = events.filter((e): e is BboUpdate => e.type === "bbo");
        expect(bbos.length).toBeGreaterThan(0);
        const bad = bbos.filter(b => b.schema !== 1 || [b.bid, b.ask, b.bidSize, b.askSize].some(v => v !== null && (typeof v !== "string" || !DEC.test(v))));
        const crossed = bbos.filter(b => b.bid !== null && b.ask !== null && !(Number(b.bid) < Number(b.ask)));
        expectCheck(id("bbo"), bad.length + crossed.length === 0 ? null : `${bad.length} malformed, ${crossed.length} crossed/locked`);
        await stream.close();
      });
    }

    it("state machine: idle → connecting → live, close() → closed (no other transition)", async () => {
      const { states, stream } = await replay(c, fixtureFrames(...c.market), { kind: "allMarkets" });
      await stream.close();
      const seq = states.filter((s, i) => i === 0 || s !== states[i - 1]);
      expectCheck(id("state-sequence"), JSON.stringify(seq) === JSON.stringify(["idle", "connecting", "live", "closed"]) ? null : `sequence ${seq.join(" → ")}`);
    });

    it("close() leaves no timer behind", async () => {
      vi.useFakeTimers();
      const { stream } = await replay(c, fixtureFrames(...c.market), { kind: "allMarkets" });
      await stream.close();
      await flush(10);
      expectCheck(id("close-timers"), vi.getTimerCount() === 0 ? null : `${vi.getTimerCount()} timer(s) left after close()`);
    });

    it("a rejected `ready` exposes .code (not only .structured.code)", async () => {
      const t = fakeTransport();
      const stream = createVenueStream(c.codec, { transport: t.factory, fetch: fakeFetch(c.routes), visibility: null });
      const sub = stream.subscribe({ kind: "allMarkets", canonicals: ["NOPEXYZ"] });
      sub.on(() => { /* events not inspected */ });
      const err = await sub.ready.then(() => null, (e: unknown) => e as { code?: unknown; structured?: { code?: unknown } });
      expect(err, "ready must reject when no requested canonical is listed").not.toBeNull();
      expect(err!.structured?.code).toBe("INVALID_PARAMS");
      expectCheck(id("ready-code"), err!.code === "INVALID_PARAMS" ? null : `.code = ${String(err!.code)} (structured.code ${String(err!.structured?.code)})`);
      await stream.close();
    });
  });
}

// ── B. CLI ⇄ WS directory parity + eligibility (recorded, untrimmed) ──

/** Normalized market key shared by CLI rows and WS directory entries. */
const keyOf = (s: string): string => s.toUpperCase().replace(/-PERP$/, "");

/**
 * Documented CLI ⇄ WS directory differences (venue → key → reason). A difference not listed here
 * fails the parity check.
 */
export const WS_DIRECTORY_ALLOWLIST: Record<string, Record<string, string>> = {};

/** Non-tradable markets in the recorded REST directory, per venue (venue status ≠ tradable). */
const NON_TRADABLE: Record<string, (http: Array<{ url: string; response: unknown }>) => string[]> = {
  aster: http => http.filter(x => x.url.includes("/exchangeInfo")).flatMap(x => ((x.response as { symbols?: Array<{ symbol: string; status: string }> }).symbols ?? [])
    .filter(s => s.status !== "TRADING").map(s => s.symbol)),
  arcus: http => http.filter(x => /\/v1\/markets(\?|$)/.test(x.url)).flatMap(x => ((x.response as { markets?: Array<Record<string, unknown>> }).markets ?? [])
    .filter(m => typeof m.status === "string" && m.status !== "ONLINE" && m.status !== "ACTIVE").map(m => String(m.marketDisplayName))),
  lighter: http => http.filter(x => /orderBooks(\?|$)/.test(x.url)).flatMap(x => ((x.response as { order_books?: Array<{ symbol: string; status: string; market_type?: string }> }).order_books ?? [])
    .filter(b => b.market_type !== "spot" && b.status !== "active").map(b => b.symbol)),
  "lighter-rh": http => NON_TRADABLE.lighter(http),
  hyperliquid: http => http.filter(x => x.url.endsWith("/info") && (x as { body?: string }).body?.includes("\"meta\"")).flatMap(x => {
    const r = x.response as { universe?: Array<{ name: string; isDelisted?: boolean }> } | [{ universe?: Array<{ name: string; isDelisted?: boolean }> }, unknown];
    const u = Array.isArray(r) ? r[0]?.universe : r.universe;
    return (u ?? []).filter(m => m.isDelisted === true).map(m => m.name);
  }),
  pacifica: () => [],
};

/** How long record mode streams each venue. */
const STREAM_RECORD_MS = 8_000;
/** Bytes of inbound frames kept per recorded socket. */
const STREAM_MAX_BYTES = 150_000;

/**
 * perp-cli/ws transport over the session: live → the real `ws` socket, inbound frames captured
 * (record); replay → a fake socket that answers the stream's subscribe with the recorded frames.
 */
function sessionTransport(session: Session): WsFactory {
  if (IS_LIVE) {
    return (url: string): WsLike => {
      const rec = session.wsRecord(url);
      let bytes = 0;
      const ws = new WebSocket(url);
      ws.addEventListener("message", (ev: { data: unknown }) => {
        const text = String(ev.data);
        if (bytes + text.length > STREAM_MAX_BYTES) return;
        try { rec.frames.push(JSON.parse(text) as Json); bytes += text.length; } catch { /* non-JSON frame */ }
      });
      const send = ws.send.bind(ws);
      (ws as unknown as { send(d: string): void }).send = (d: string) => { rec.sent.push(d); send(d); };
      return ws as unknown as WsLike;
    };
  }
  return (url: string): WsLike => {
    const rec = session.wsReplay(url);
    const fake = {
      readyState: 0,
      onopen: null as WsLike["onopen"], onmessage: null as WsLike["onmessage"], onclose: null as WsLike["onclose"], onerror: null as WsLike["onerror"],
      sentOnce: false,
      send(_d: string) {
        if (fake.sentOnce || rec === null) return;
        fake.sentOnce = true;
        setTimeout(() => { for (const f of rec.frames) if (fake.readyState === 1) fake.onmessage?.({ data: JSON.stringify(f) }); }, 0);
      },
      close(code?: number, reason?: string) {
        if (fake.readyState === 3) return;
        fake.readyState = 3;
        setTimeout(() => fake.onclose?.({ code: code ?? 1000, reason: reason ?? "", wasClean: true }), 0);
      },
    };
    setTimeout(() => {
      if (rec === null) { fake.onerror?.(new Error(`WebSocket ${url} not in fixture`)); return; }
      fake.readyState = 1;
      fake.onopen?.();
      if (rec.sent.length === 0) fake.send("");
    }, 0);
    return fake as unknown as WsLike;
  };
}

for (const c of CASES.filter(x => VENUE_FILTER === null || VENUE_FILTER.has(x.venue))) {
  const name = `ws-${c.venue}`;
  const runnable = IS_LIVE || hasFixture(name);
  describe(`CLI ⇄ WS directory ${c.venue} (${MODE})`, () => {
    it(`has a recorded fixture (pnpm conformance:record --ws)`, () => expect(runnable).toBe(true));
    if (!runnable) return;
    const id = (check: string) => `ws:${c.venue}:${check}`;
    let dir: MarketDirectoryEntry[] = [];
    const streamed: MarketUpdate[] = [];
    let list: CliRun;
    let nonTradable: string[] = [];

    beforeAll(async () => {
      const session = new Session(name, [], { trim: false });
      session.start();
      try {
        session.begin("ws:markets");
        const fetchLike: FetchLike = (u, init) => globalThis.fetch(u, init as RequestInit) as unknown as ReturnType<FetchLike>;
        const stream = createVenueStream(c.codec, { transport: fakeTransport().factory, fetch: fetchLike, visibility: null });
        dir = await stream.markets();
        await stream.close();
        session.begin("ws:stream");
        const live = createVenueStream(c.codec, { transport: sessionTransport(session), fetch: fetchLike, visibility: null });
        const sub = live.subscribe({ kind: "allMarkets" });
        sub.on(e => { if ((e as MarketUpdate).type === "market") streamed.push(e as MarketUpdate); });
        await new Promise(r => setTimeout(r, IS_LIVE ? STREAM_RECORD_MS : 300));
        await live.close();
        session.begin("cli:list");
        list = await runCli(["-e", c.venue, "market", "list"]);
        session.finalize();
      } finally {
        session.stop();
      }
      if (!IS_LIVE || MODE === "record") {
        const f = hasFixture(name) ? loadFixture(name) : null;
        nonTradable = f === null ? [] : [...new Set(NON_TRADABLE[c.venue](f.http))];
      }
    }, IS_LIVE ? 600_000 : 60_000);

    const cliRows = () => (list.envelope.data ?? []) as Array<{ symbol: string; venueSymbol?: unknown }>;
    /** CLI rows that name their venue symbol (Aster: one row per venue market, any quote) are compared by it. */
    const byVenueSymbol = () => cliRows().length > 0 && cliRows().every(r => typeof r.venueSymbol === "string");
    /** CLI rows by canonical key (CLI symbols are base symbols, "-PERP" stripped), or by venue symbol. */
    const cliKeys = () => new Set(cliRows().map(r => keyOf(byVenueSymbol() ? String(r.venueSymbol) : r.symbol)));
    /** WS entries by canonical (dex prefix kept), else by venue symbol — or by venue symbol (see byVenueSymbol). */
    const wsKeys = () => new Set(dir.map(m => keyOf(byVenueSymbol() ? m.venueSymbol : (m.canonical ?? m.symbol))));
    /** WS entries of non-tradable venue symbols, by canonical key. */
    const wsKeyOfVenueSymbol = (vs: string): string | null => {
      const m = dir.find(d => keyOf(d.venueSymbol) === keyOf(vs) || keyOf(d.symbol) === keyOf(vs));
      return m === undefined ? null : keyOf(m.canonical ?? m.symbol);
    };

    it("CLI market list is ok", () => {
      expect(list.envelope.ok, JSON.stringify(list.envelope.error)).toBe(true);
    });

    it("recorded stream: market events are schema 1, decimal strings, no \"0\" stand-in, documented rateKind", () => {
      expect(streamed.length, "no market event replayed").toBeGreaterThan(0);
      const p = marketProblems(streamed, c);
      expectCheck(id("stream-schema"), p.schema);
      expectCheck(id("stream-decimals"), p.decimals);
      expectCheck(id("stream-no-zero-placeholder"), p.zero);
      expectCheck(id("stream-rate-kind"), p.kind);
    });

    it("stream.markets() set = CLI market list set (allowlisted differences only)", () => {
      const allow = WS_DIRECTORY_ALLOWLIST[c.venue] ?? {};
      const a = cliKeys();
      const b = wsKeys();
      const onlyCli = [...a].filter(k => !b.has(k) && !(k in allow));
      const onlyWs = [...b].filter(k => !a.has(k) && !(k in allow));
      expectCheck(id("directory-parity"), onlyCli.length + onlyWs.length === 0 ? null
        : `cli ${a.size} vs ws ${b.size}; cli-only [${onlyCli.slice(0, 6).join(",")}${onlyCli.length > 6 ? ` +${onlyCli.length - 6}` : ""}]; ws-only [${onlyWs.slice(0, 6).join(",")}${onlyWs.length > 6 ? ` +${onlyWs.length - 6}` : ""}]`);
    });

    it("canonical symbols agree (every USD-quoted / dex WS entry has a canonical; CLI symbols are canonical keys)", () => {
      // A market quoted in a non-USD currency (Aster "U") is not comparable by default: canonical
      // null by contract (defaultCanonicalize), like a canonical-null CLI / public row.
      const missing = dir.filter(m => m.canonical === null && (m.dex !== null || m.quote === null || USD_LIKE_QUOTES.has(m.quote.toUpperCase()))).map(m => m.symbol);
      expectCheck(id("canonical-parity"), missing.length === 0 ? null : `${missing.length} WS entries without canonical: ${missing.slice(0, 5).join(",")}`);
    });

    it("rateKind agrees: CLI market rows carry the WS funding rateKind", () => {
      const rows = (list.envelope.data ?? []) as Array<{ fundingRateKind?: unknown }>;
      const kinds = new Set(rows.map(r => r.fundingRateKind));
      expectCheck(id("ratekind-parity"), kinds.size === 1 && kinds.has(c.rateKind) ? null
        : `CLI fundingRateKind ${[...kinds].map(String).join(",")} vs WS ${c.rateKind}`);
    });

    it("eligibility: non-tradable markets appear in neither the CLI list nor the WS directory", () => {
      const cli = cliKeys();
      const inCli = nonTradable.filter(vs => cli.has(keyOf(vs)) || cli.has(baseOf(vs)));
      const inWs = nonTradable.filter(vs => wsKeyOfVenueSymbol(vs) !== null);
      expectCheck(id("eligibility-cli"), inCli.length === 0 ? null : `cli lists ${inCli.slice(0, 6).join(",")} (${inCli.length} non-tradable)`);
      expectCheck(id("eligibility-ws"), inWs.length === 0 ? null : `ws lists ${inWs.slice(0, 6).join(",")} (${inWs.length} non-tradable)`);
    });
  });
}

describe("known failures of this file are all evaluated", () => {
  it("no stale ws: entry", () => {
    if (VENUE_FILTER !== null) return;
    expect(staleKnownFailures(["ws:"])).toEqual([]);
  });
});
