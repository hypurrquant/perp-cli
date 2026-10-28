/**
 * Public-address positions (`perp -e <v> account positions --address <addr>`, MCP
 * get_positions_by_address) on every venue whose public data reads positions by address
 * (VenuePublicData.fetchPositionsByAddress — registry-driven: a new supporting venue is included).
 *
 * Fixture "positions-by-address" (gzipped, untrimmed): recorded keyless from live mainnet. The
 * account addresses are REDACTED — every URL, body and response carries a dummy address
 * (Session.redact), the Lighter account objects are reduced to the fields the mapper reads, and
 * the scrubber remaps account ids. Record: `pnpm conformance:record --positions`, with the
 * accounts in PERP_CONFORMANCE_ADDRESS_<VENUE> (else discovered: an HLP child vault, a Lighter
 * account from the public trade tape, the Pacifica leaderboard's largest open interest).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("ws", async (importOriginal) => {
  const real = await importOriginal<typeof import("ws")>();
  const { activeSession } = await import("./harness.js");
  const Real = real.default as unknown as new (...a: unknown[]) => never;
  const Wrapped = new Proxy(Real, {
    construct: (_t, args: unknown[]) => new (activeSession().wrapWs(Real as never) as unknown as new (...a: unknown[]) => object)(...args),
  });
  return { ...real, default: Wrapped, WebSocket: Wrapped };
});

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools = new Map<string, ToolHandler>();
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {
    tool(name: string, _d: string, _s: unknown, h: ToolHandler) { tools.set(name, h); }
    resource() { /* not used */ }
    prompt() { /* not used */ }
    async connect() { /* no transport in tests */ }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({ StdioServerTransport: class {} }));

import "../../exchanges/venues/index.js";
import { listPublicPositionVenues } from "../../exchanges/venue.js";
import { issues, PositionList } from "./contracts.js";
import type { Json } from "./fixture-tools.js";
import { hasFixture, IS_LIVE, missesFailure, MODE, runCli, Session, type CliRun, type Envelope } from "./harness.js";
import { expectCheck } from "./known-failures.js";

const NAME = "positions-by-address";
const VENUES = listPublicPositionVenues().map(v => v.id as string);

/**
 * The address each venue's cells read in REPLAY (and what the recorded account is redacted to).
 * lighter-rh / risex read 0x…01 live too (no account there: the "empty answer" path).
 */
const DUMMY: Readonly<Record<string, string>> = {
  hyperliquid: "0x00000000000000000000000000000000000a0001",
  lighter: "0x00000000000000000000000000000000000a0002",
  "lighter-rh": "0x0000000000000000000000000000000000000001",
  risex: "0x0000000000000000000000000000000000000001",
  pacifica: "So11111111111111111111111111111111111111112",
};

/** Hyperliquid's protocol vault (HLP): its child vaults are public accounts that hold positions. */
const HLP_VAULT = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
const hlInfo = (body: unknown) => getJson("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Live / record: the account a venue's cells read (env first, then a public discovery; never logged). */
async function liveAddress(venue: string): Promise<string> {
  const env = process.env[`PERP_CONFORMANCE_ADDRESS_${venue.toUpperCase().replace(/-/g, "_")}`];
  if (env !== undefined && env !== "") return env;
  if (venue === "hyperliquid") {
    const v = await hlInfo({ type: "vaultDetails", vaultAddress: HLP_VAULT }) as { relationship?: { data?: { childAddresses?: string[] } } };
    for (const child of v.relationship?.data?.childAddresses ?? []) {
      const s = await hlInfo({ type: "clearinghouseState", user: child }) as { assetPositions?: unknown[] };
      if ((s.assetPositions ?? []).length > 0) return child;
    }
  }
  if (venue === "lighter") {
    const base = "https://mainnet.zklighter.elliot.ai/api/v1";
    const ids = new Set<number>();
    for (const m of [0, 1, 2]) {
      const t = await getJson(`${base}/recentTrades?market_id=${m}&limit=20`) as { trades?: Array<{ ask_account_id: number; bid_account_id: number }> };
      for (const x of t.trades ?? []) { ids.add(x.ask_account_id); ids.add(x.bid_account_id); }
    }
    for (const id of [...ids].slice(0, 20)) {
      const a = await getJson(`${base}/account?by=index&value=${id}`) as { accounts?: Array<{ l1_address?: string; positions?: Array<{ position: string }> }> };
      const acct = a.accounts?.[0];
      if (acct?.l1_address !== undefined && (acct.positions ?? []).some(p => Number(p.position) !== 0)) return acct.l1_address;
    }
  }
  if (venue === "pacifica") {
    const l = await getJson("https://api.pacifica.fi/api/v1/leaderboard") as { data?: Array<{ address: string; oi_current?: string }> };
    const top = [...(l.data ?? [])].sort((a, b) => Number(b.oi_current ?? 0) - Number(a.oi_current ?? 0))[0];
    if (top !== undefined) return top.address;
  }
  return DUMMY[venue];
}

/** Record: keep what lighterPositionRows / lighterPositionsByAddress read of a third party's account. */
function responseFilter(url: string, response: Json): Json {
  if (!/\/api\/v1\/account\?by=l1_address/.test(url) || response === null || typeof response !== "object" || Array.isArray(response)) return response;
  const r = response as { [k: string]: Json };
  if (!Array.isArray(r.accounts)) return response;
  const POS_FIELDS = ["market_id", "symbol", "initial_margin_fraction", "sign", "position", "avg_entry_price", "position_value", "unrealized_pnl", "liquidation_price", "margin_mode"];
  const pick = (o: Json, keys: string[]): Json => Object.fromEntries(keys.filter(k => o !== null && typeof o === "object" && !Array.isArray(o) && k in o).map(k => [k, (o as { [k: string]: Json })[k]]));
  return {
    code: r.code ?? null, total: r.total ?? null,
    accounts: r.accounts.map(a => ({
      ...(pick(a, ["account_index", "account_type"]) as { [k: string]: Json }),
      positions: Array.isArray((a as { positions?: Json }).positions) ? ((a as { positions: Json[] }).positions).map(p => pick(p, POS_FIELDS)) : [],
    })),
  };
}

const cli = new Map<string, CliRun>();
const mcp = new Map<string, Envelope>();
const addressOf = new Map<string, string>();

const runnable = IS_LIVE || hasFixture(NAME);
let misses: readonly string[] = [];

describe(`public-address positions (${MODE})`, () => {
  it("has a recorded fixture (pnpm conformance:record --positions)", () => expect(runnable).toBe(true));
  it("every supporting venue has a replay address", () => {
    expect(VENUES.filter(v => DUMMY[v] === undefined)).toEqual([]);
  });
  if (!runnable) return;

  beforeAll(async () => {
    // Addresses first, with the real network (live / record), before the session stubs fetch.
    for (const v of VENUES) addressOf.set(v, IS_LIVE ? await liveAddress(v) : DUMMY[v]);
    const session = new Session(NAME, [], { trim: false, responseFilter });
    if (MODE === "record") for (const v of VENUES) session.redact(addressOf.get(v)!, DUMMY[v]);
    session.start();
    try {
      if (tools.size === 0) await import("../../mcp-server.js");
      for (const v of VENUES) {
        session.begin(`cli:${v}`);
        cli.set(v, await runCli(["-e", v, "account", "positions", "--address", addressOf.get(v)!]));
        session.begin(`mcp:${v}`);
        const r = await tools.get("get_positions_by_address")!({ exchange: v, address: addressOf.get(v)! });
        mcp.set(v, JSON.parse(r.content[0].text) as Envelope);
      }
      session.finalize();
    } finally {
      misses = session.misses;
      session.stop();
    }
  }, IS_LIVE ? 900_000 : 120_000);

  it("replay: every request is in the fixture", () => expectCheck("positions:replay:fixture-complete", missesFailure(misses)));

  type Row = { symbol: string; side: string; size: string; dex?: string | null; accountIndex?: number; [k: string]: unknown };
  const rows = (e: Envelope | undefined): Row[] => (e?.ok === true && Array.isArray(e.data) ? e.data as Row[] : []);

  for (const v of VENUES) {
    describe(v, () => {
      it("CLI: ok, one JSON document, the Position contract, meta.source public + the address", () => {
        const r = cli.get(v)!;
        const e = r.envelope;
        const fail = !e.ok ? `ok:false ${e.error?.code}: ${e.error?.message}`
          : r.docs !== 1 ? `${r.docs} JSON documents`
          : issues(PositionList, e.data) || (e.meta?.source !== "public" ? `meta.source ${String(e.meta?.source)}` : e.meta?.address !== addressOf.get(v) ? "meta.address is not the address read" : null);
        expectCheck(`positions:${v}:cli-contract`, fail || null);
      });
      it("MCP get_positions_by_address: ok and the Position contract", () => {
        const e = mcp.get(v)!;
        expectCheck(`positions:${v}:mcp-contract`, !e.ok ? `ok:false ${e.error?.code}: ${e.error?.message}` : (issues(PositionList, e.data) || null));
      });
      it("rows: open positions only (size > 0), plain symbols, venue tags (HL dex, Lighter accountIndex)", () => {
        const bad: string[] = [];
        for (const r of rows(cli.get(v)!.envelope)) {
          if (!(Number(r.size) > 0)) bad.push(`${r.symbol}: size ${r.size}`);
          if (/-PERP$/i.test(r.symbol)) bad.push(`${r.symbol}: not a plain symbol`);
          if (v === "hyperliquid") {
            if (!("dex" in r)) bad.push(`${r.symbol}: no dex tag`);
            else if (r.dex !== null && !r.symbol.startsWith(`${r.dex}:`)) bad.push(`${r.symbol}: HIP-3 row of ${r.dex} without the dex prefix`);
            else if (r.dex === null && r.symbol.includes(":")) bad.push(`${r.symbol}: native row with a dex prefix`);
          } else if ("dex" in r) bad.push(`${r.symbol}: dex tag on ${v}`);
          if (v === "lighter" || v === "lighter-rh") {
            if (!Number.isInteger(r.accountIndex)) bad.push(`${r.symbol}: no accountIndex`);
          } else if ("accountIndex" in r) bad.push(`${r.symbol}: accountIndex on ${v}`);
        }
        expectCheck(`positions:${v}:rows`, bad.length === 0 ? null : bad.slice(0, 5).join("; "));
      });
      it("CLI ⇄ MCP: the same positions (replay: every value; live: the same markets and sides)", () => {
        const key = (r: Row) => `${r.symbol}|${r.side}|${r.dex ?? ""}|${r.accountIndex ?? ""}`;
        const norm = (rs: Row[]) => (IS_LIVE ? rs.map(key) : rs.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).sort())))).sort();
        const c = norm(rows(cli.get(v)!.envelope));
        const m = norm(rows(mcp.get(v)!));
        const fail = JSON.stringify(c) === JSON.stringify(m) ? null : `cli ${c.length} rows, mcp ${m.length}; first difference: ${c.find(x => !m.includes(x)) ?? m.find(x => !c.includes(x))}`;
        expectCheck(`positions:${v}:parity`, fail);
      });
    });
  }

  it("lighter-rh: an address without an account is an empty answer with a note (never an error)", () => {
    const e = cli.get("lighter-rh")?.envelope;
    if (e === undefined || addressOf.get("lighter-rh") !== DUMMY["lighter-rh"]) return;
    expectCheck("positions:lighter-rh:no-account", e.ok && Array.isArray(e.data) && e.data.length === 0 && Array.isArray(e.meta?.notes) ? null : `got ${JSON.stringify(e).slice(0, 200)}`);
  });
});
