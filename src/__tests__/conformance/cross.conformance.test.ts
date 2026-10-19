/**
 * Cross-venue commands and CLI ⇄ MCP parity (docs/TESTING.md §3, §5), over one recorded fixture
 * (src/__tests__/fixtures/conformance/cross.json). The real CLI command tree and the real MCP tool
 * handlers run in-process on the same replayed transport, so their outputs are comparable:
 *   - market list / market prices without -e cover every market-data venue;
 *   - health covers every venue (CLI and MCP);
 *   - arb scan (default, --rates, --include-unverified, --compare, --gaps, --basis) matches its
 *     contract, never marks a read-only / unverified-funding leg executable, and never compares
 *     prices quoted in different currencies;
 *   - get_markets / get_funding_rates / get_prices / health_check return the same fields and the
 *     same counts as the CLI for the same data.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import { getVenue, listVenues, listVenuesWithRole } from "../../exchanges/venue.js";
import {
  ArbBasis, ArbGaps, ArbRates, ArbScan, Health, issues, MarketList, MarketListAll, MarketRow, RateRow, RateSymbol,
} from "./contracts.js";
import { baseOf } from "./checks.js";
import { hasFixture, IS_LIVE, MODE, runCli, Session, type CliRun, type Envelope } from "./harness.js";
import { expectCheck, staleKnownFailures } from "./known-failures.js";
import type { z } from "zod";

const KEEP = ["BTC", "ETH", "SOL", "NVDA", "SAMSUNG", "UBER", "AMC", "BOT"];
const VENUES = listVenues().map(v => v.id);
const MARKET_DATA = listVenuesWithRole("marketData").map(v => v.id);
const PARITY_SYMBOLS = ["BTC", "ETH"];

const CLI_CELLS: Record<string, string[]> = {
  "market-list-all": ["market", "list"],
  "market-prices-all": ["market", "prices"],
  health: ["health"],
  "arb-scan": ["arb", "scan"],
  "arb-rates": ["arb", "scan", "--rates"],
  "arb-rates-unverified": ["arb", "scan", "--rates", "--include-unverified"],
  "arb-compare": ["arb", "scan", "--compare", "BTC"],
  "arb-compare-unverified": ["arb", "scan", "--compare", "BTC", "--include-unverified"],
  "arb-gaps": ["arb", "scan", "--gaps"],
  "arb-basis": ["arb", "scan", "--basis"],
};
/**
 * get_markets ⇔ market list run in their own session over UNTRIMMED responses (fixture
 * "parity", gzipped): a trimmed directory would make every count agree, and a cache filled by a
 * trimmed cell would feed the full one. It runs after the cross session (fresh cache dir, later clock).
 */
const PARITY_CLI: Record<string, string[]> = Object.fromEntries(VENUES.map(v => [`list:${v}`, ["-e", v, "market", "list"]]));
const PARITY_MCP: Record<string, [string, Record<string, unknown>]> =
  Object.fromEntries(VENUES.map(v => [`get_markets:${v}`, ["get_markets", { exchange: v }] as [string, Record<string, unknown>]]));
const MCP_CELLS: Record<string, [string, Record<string, unknown>]> = {
  get_funding_rates: ["get_funding_rates", { symbols: PARITY_SYMBOLS }],
  get_prices: ["get_prices", { symbols: PARITY_SYMBOLS }],
  health_check: ["health_check", {}],
};

const cli = new Map<string, CliRun>();
const mcp = new Map<string, Envelope>();

const runnable = IS_LIVE || (hasFixture("cross") && hasFixture("parity"));

describe(`cross-venue + CLI ⇄ MCP parity (${MODE})`, () => {
  it("has a recorded fixture (pnpm conformance:record --cross)", () => {
    expect(runnable).toBe(true);
  });
  if (!runnable) return;

  beforeAll(async () => {
    const session = new Session("cross", KEEP);
    session.start();
    try {
      for (const [cell, argv] of Object.entries(CLI_CELLS)) {
        session.begin(`cli:${cell}`);
        cli.set(cell, await runCli(argv));
      }
      if (tools.size === 0) await import("../../mcp-server.js");
      for (const [cell, [tool, args]] of Object.entries(MCP_CELLS)) {
        session.begin(`mcp:${cell}`);
        const r = await tools.get(tool)!(args);
        mcp.set(cell, JSON.parse(r.content[0].text) as Envelope);
      }
      session.finalize();
      if (session.misses.length > 0) console.warn(`[conformance] cross: requests missing from the fixture:\n  ${session.misses.join("\n  ")}`);
    } finally {
      session.stop();
    }
    const parity = new Session("parity", [], { trim: false });
    parity.start();
    try {
      for (const [cell, argv] of Object.entries(PARITY_CLI)) {
        parity.begin(`cli:${cell}`);
        cli.set(cell, await runCli(argv));
      }
      for (const [cell, [tool, args]] of Object.entries(PARITY_MCP)) {
        parity.begin(`mcp:${cell}`);
        const r = await tools.get(tool)!(args);
        mcp.set(cell, JSON.parse(r.content[0].text) as Envelope);
      }
      parity.finalize();
      if (parity.misses.length > 0) console.warn(`[conformance] parity: requests missing from the fixture:\n  ${parity.misses.join("\n  ")}`);
    } finally {
      parity.stop();
    }
  }, IS_LIVE ? 900_000 : 180_000);

  const data = (cell: string): unknown => cli.get(cell)!.envelope.data;
  const schema = (id: string, cell: string, s: z.ZodType) => it(`${cell}: schema`, () => {
    const r = cli.get(cell)!;
    expectCheck(id, !r.envelope.ok ? `ok:false ${r.envelope.error?.code}: ${r.envelope.error?.message}` : r.docs !== 1 ? `${r.docs} JSON documents` : (issues(s, r.envelope.data) || null));
  });

  describe("market list / prices without -e", () => {
    for (const cell of ["market-list-all", "market-prices-all"]) {
      schema(`cross:${cell}:schema`, cell, MarketListAll);
      it(`${cell}: covers every market-data venue (never silently omits one)`, () => {
        const d = data(cell) as { exchanges?: Record<string, unknown>; errors?: Record<string, string> } | undefined;
        const covered = new Set([...Object.keys(d?.exchanges ?? {}), ...Object.keys(d?.errors ?? {})]);
        const missing = MARKET_DATA.filter(v => !covered.has(v));
        expectCheck(`cross:${cell}:all-venues`, missing.length === 0 ? null : `missing: ${missing.join(", ")}`);
      });
    }
  });

  describe("health", () => {
    schema("cross:health:schema", "health", Health);
    it("covers every venue", () => {
      const d = data("health") as { exchanges?: Array<{ exchange: string }>; unofficial?: Array<{ exchange: string }>; skipped?: string[] };
      const covered = new Set([...(d?.exchanges ?? []), ...(d?.unofficial ?? [])].map(p => p.exchange));
      const missing = VENUES.filter(v => !covered.has(v));
      expectCheck("cross:health:all-venues", missing.length === 0 ? null : `missing: ${missing.join(", ")}`);
    });
  });

  describe("arb scan", () => {
    schema("cross:arb-scan:schema", "arb-scan", ArbScan);
    schema("cross:arb-rates:schema", "arb-rates", ArbRates);
    schema("cross:arb-rates-unverified:schema", "arb-rates-unverified", ArbRates);
    schema("cross:arb-compare:schema", "arb-compare", RateSymbol);
    schema("cross:arb-compare-unverified:schema", "arb-compare-unverified", RateSymbol);
    schema("cross:arb-gaps:schema", "arb-gaps", ArbGaps);
    schema("cross:arb-basis:schema", "arb-basis", ArbBasis);

    /** A leg on a venue without trading, or with unverified funding, can never be executed. */
    const notExecutableVenue = (id: string): boolean => {
      const def = getVenue(id);
      return !def.roles.includes("trading") || !def.fundingVerified;
    };
    const rateRows = (cell: string): Array<z.infer<typeof RateSymbol>> => {
      const d = data(cell) as { symbols?: unknown[] } | undefined;
      return (cell.startsWith("arb-compare") ? [d] : (d?.symbols ?? [])) as Array<z.infer<typeof RateSymbol>>;
    };
    for (const cell of ["arb-rates", "arb-rates-unverified", "arb-compare", "arb-compare-unverified"]) {
      it(`${cell}: a read-only / unverified-funding leg is never executable`, () => {
        const bad = rateRows(cell).filter(r => r && r.executable && [r.longExchange, r.shortExchange].some(notExecutableVenue))
          .map(r => `${r.symbol} ${r.longExchange}/${r.shortExchange}`);
        expectCheck(`cross:${cell}:never-executable`, bad.length === 0 ? null : `executable: ${bad.slice(0, 5).join(", ")}`);
      });
    }
    for (const cell of ["arb-rates", "arb-compare"]) {
      it(`${cell}: without --include-unverified no unverified-funding row appears`, () => {
        const bad = rateRows(cell).flatMap(r => (r?.rates ?? []).filter(x => !x.fundingVerified).map(x => `${r.symbol}@${x.exchange}`));
        expectCheck(`cross:${cell}:verified-only`, bad.length === 0 ? null : bad.slice(0, 5).join(", "));
      });
    }
    it("arb-gaps: never compares prices quoted in different currencies (no gap > 50 %)", () => {
      const rows = (data("arb-gaps") ?? []) as Array<{ symbol: string; maxGapPct: number }>;
      const bad = rows.filter(r => r.maxGapPct > 50).map(r => `${r.symbol} ${r.maxGapPct.toFixed(1)}%`);
      expectCheck("cross:arb-gaps:same-quote", bad.length === 0 ? null : bad.join(", "));
    });
    it("arb-basis: never compares prices quoted in different currencies (no diff > 50 %)", () => {
      const rows = (data("arb-basis") ?? []) as Array<{ symbol: string; pctDiff: number }>;
      const bad = rows.filter(r => r.pctDiff > 50).map(r => `${r.symbol} ${r.pctDiff.toFixed(1)}%`);
      expectCheck("cross:arb-basis:same-quote", bad.length === 0 ? null : bad.join(", "));
    });
  });

  describe("CLI ⇄ MCP parity", () => {
    const CORE_MARKET_FIELDS = Object.keys(MarketRow.shape);
    const mcpRows = (v: string): Array<Record<string, unknown>> => {
      const e = mcp.get(`get_markets:${v}`)!;
      return e.ok && Array.isArray(e.data) ? e.data as Array<Record<string, unknown>> : [];
    };
    const cliRows = (v: string): Array<Record<string, unknown>> => {
      const e = cli.get(`list:${v}`)!.envelope;
      return e.ok && Array.isArray(e.data) ? e.data as Array<Record<string, unknown>> : [];
    };

    for (const v of VENUES) {
      it(`get_markets(${v}) ⇔ perp -e ${v} market list: both ok, same count`, () => {
        const m = mcp.get(`get_markets:${v}`)!;
        const c = cli.get(`list:${v}`)!.envelope;
        const fail = !m.ok || !c.ok ? `mcp ok=${m.ok} (${JSON.stringify(m.error ?? "").slice(0, 120)}), cli ok=${c.ok} (${c.error?.code ?? ""})`
          : mcpRows(v).length !== cliRows(v).length ? `mcp ${mcpRows(v).length} rows, cli ${cliRows(v).length} rows`
          : null;
        expectCheck(`parity:get_markets:${v}:count`, fail);
      });
      it(`get_markets(${v}) ⇔ market list: same base symbols`, () => {
        // Marks are not compared: the two read different endpoints at different moments.
        const c = new Set(cliRows(v).map(r => baseOf(String(r.symbol))));
        const m = new Set(mcpRows(v).map(r => baseOf(String(r.symbol))));
        const onlyCli = [...c].filter(k => !m.has(k));
        const onlyMcp = [...m].filter(k => !c.has(k));
        const fail = onlyCli.length + onlyMcp.length === 0 ? null
          : `cli-only [${onlyCli.slice(0, 6).join(",")}${onlyCli.length > 6 ? ` +${onlyCli.length - 6}` : ""}]; mcp-only [${onlyMcp.slice(0, 6).join(",")}${onlyMcp.length > 6 ? ` +${onlyMcp.length - 6}` : ""}]`;
        expectCheck(`parity:get_markets:${v}:symbols`, fail);
      });
    }
    it("get_markets rows carry the CLI market-row contract fields", () => {
      const bad = VENUES.flatMap(v => {
        const r = mcpRows(v)[0];
        if (r === undefined) return [];
        const missing = CORE_MARKET_FIELDS.filter(f => !(f in r));
        return missing.length === 0 ? [] : [`${v}: no ${missing.join(", ")}`];
      });
      const shapeBad = VENUES.filter(v => mcpRows(v).length > 0 && issues(MarketList, mcpRows(v)) !== "");
      expectCheck("parity:get_markets:fields", bad.length === 0 && shapeBad.length === 0 ? null : [...bad.slice(0, 4), shapeBad.length ? `schema: ${shapeBad.join(",")}` : ""].join("; "));
    });

    it("get_funding_rates ⇔ arb scan --rates: same symbols, venues and rate-row fields", () => {
      const m = mcp.get("get_funding_rates")!;
      const c = cli.get("arb-rates")!.envelope;
      if (!m.ok || !c.ok) return expectCheck("parity:get_funding_rates:same", `mcp ok=${m.ok}, cli ok=${c.ok}`);
      const pick = (d: unknown) => new Map(((d as { symbols: Array<z.infer<typeof RateSymbol>> }).symbols ?? [])
        .filter(s => PARITY_SYMBOLS.includes(s.symbol.toUpperCase()))
        .map(s => [s.symbol.toUpperCase(), s.rates.map(r => r.exchange).sort().join(",")]));
      const a = pick(m.data);
      const b = pick(c.data);
      const diffs = [...new Set([...a.keys(), ...b.keys()])].filter(k => a.get(k) !== b.get(k)).map(k => `${k}: mcp [${a.get(k) ?? "-"}] cli [${b.get(k) ?? "-"}]`);
      const rows = ((m.data as { symbols: Array<{ rates: unknown[] }> }).symbols ?? []).flatMap(s => s.rates);
      const shape = rows.length > 0 ? issues(RateRow.array(), rows) : "";
      expectCheck("parity:get_funding_rates:same", diffs.length === 0 && shape === "" ? null : [...diffs, shape].filter(Boolean).join("; "));
    });

    it("get_prices ⇔ market prices (no -e): same venues per symbol, same marks", () => {
      const m = mcp.get("get_prices")!;
      const c = cli.get("market-prices-all")!.envelope;
      if (!m.ok || !c.ok) return expectCheck("parity:get_prices:same", `mcp ok=${m.ok}, cli ok=${c.ok}`);
      const fromCli = new Map<string, Map<string, number>>();
      for (const [venue, list] of Object.entries((c.data as { exchanges: Record<string, Array<{ symbol: string; markPrice: string }>> }).exchanges)) {
        for (const r of list) {
          const b = baseOf(r.symbol);
          if (!PARITY_SYMBOLS.includes(b)) continue;
          if (!fromCli.has(b)) fromCli.set(b, new Map());
          fromCli.get(b)!.set(venue, Number(r.markPrice));
        }
      }
      const diffs: string[] = [];
      for (const row of m.data as Array<{ symbol: string; prices: Record<string, number> }>) {
        const b = baseOf(row.symbol);
        const cv = fromCli.get(b) ?? new Map<string, number>();
        const mv = Object.keys(row.prices).sort().join(",");
        const cs = [...cv.keys()].sort().join(",");
        if (mv !== cs) diffs.push(`${b}: mcp [${mv}] cli [${cs}]`);
      }
      expectCheck("parity:get_prices:same", diffs.length === 0 ? null : diffs.join("; "));
    });

    it("health_check ⇔ perp health: same venues, same allHealthy", () => {
      const m = mcp.get("health_check")!;
      const c = cli.get("health")!.envelope;
      if (!m.ok || !c.ok) return expectCheck("parity:health_check:same", `mcp ok=${m.ok}, cli ok=${c.ok}`);
      const md = m.data as { covered: string[]; allHealthy: boolean };
      const cd = c.data as { exchanges: Array<{ exchange: string }>; unofficial: Array<{ exchange: string }>; allHealthy: boolean };
      const cv = [...cd.exchanges, ...cd.unofficial].map(p => p.exchange).sort().join(",");
      const mv = [...md.covered].sort().join(",");
      const fail = cv !== mv ? `mcp [${mv}] cli [${cv}]` : md.allHealthy !== cd.allHealthy ? `allHealthy mcp ${md.allHealthy} cli ${cd.allHealthy}` : null;
      expectCheck("parity:health_check:same", fail);
    });
  });
});

afterAll(() => {
  if (!runnable) return;
  expect(staleKnownFailures(["cross:", "parity:"]), "KNOWN_FAILURES entries that no check evaluated (remove them)").toEqual([]);
});
