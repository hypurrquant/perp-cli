/**
 * Per-cell invariants (docs/TESTING.md §5). Each check has a stable id
 * `<venue>:<command>:<check>` so a current failure can be registered in KNOWN_FAILURES.
 * A check returns null (holds) or a failure message.
 */
import { z } from "zod";
import {
  CurrentFundingTerms, ErrorEnvelope, FundingHistory, FundingRowFields, issues, Klines, MarketList, MarketRow, Orderbook,
  RfqQuotes, Trades,
} from "./contracts.js";
import { FUNDING_LIMIT, KLINE_INTERVAL_MS, TRADES_LIMIT, type Expect, type ReadCommand } from "./capabilities.js";
import type { CliRun } from "./harness.js";

export interface Check { name: string; run(): string | null }

const rows = (r: CliRun): Array<Record<string, unknown>> => (Array.isArray(r.envelope.data) ? r.envelope.data as Array<Record<string, unknown>> : []);

function envelopeChecks(r: CliRun): Check[] {
  return [{ name: "envelope", run: () => (r.docs === 1 ? null : `${r.docs} JSON documents on stdout (want exactly 1)`) }];
}

function okCheck(r: CliRun): Check {
  return { name: "ok", run: () => (r.envelope.ok ? null : `ok:false ${r.envelope.error?.code}: ${r.envelope.error?.message?.slice(0, 200)}`) };
}

function schemaCheck(r: CliRun, schema: z.ZodType): Check {
  return { name: "schema", run: () => (r.envelope.ok ? (issues(schema, r.envelope.data) || null) : "not ok") };
}

/** Distinct values of one numeric-string column, across ≥ 3 rows, are all exactly 0 → a "0" stand-in for unknown. */
function zeroStandIn(rs: Array<Record<string, unknown>>, fields: string[]): string | null {
  if (rs.length < 3) return null;
  const bad = fields.filter(f => rs.every(x => x[f] !== null && x[f] !== undefined && Number(x[f]) === 0));
  return bad.length === 0 ? null : `every row has ${bad.join(", ")} = 0 (unknown must be null, never 0)`;
}

function monotonic(ts: number[]): "asc" | "desc" | null {
  if (ts.every((t, i) => i === 0 || t >= ts[i - 1])) return "asc";
  if (ts.every((t, i) => i === 0 || t <= ts[i - 1])) return "desc";
  return null;
}

function marketListChecks(r: CliRun, symbol: string): Check[] {
  return [
    schemaCheck(r, MarketList),
    { name: "null-not-zero", run: () => zeroStandIn(rows(r), ["markPrice", "indexPrice", "volume24h", "openInterest"]) },
    { name: "lists-symbol", run: () => (rows(r).some(x => baseOf(String(x.symbol)) === symbol) ? null : `${symbol} not listed`) },
  ];
}

function fundingChecks(r: CliRun): Check[] {
  const ts = () => rows(r).map(x => Number(x.time));
  return [
    schemaCheck(r, FundingHistory),
    { name: "fields", run: () => {
      const bad = rows(r).map(x => issues(FundingRowFields, x)).filter(Boolean);
      return bad.length === 0 ? null : `${bad.length}/${rows(r).length} rows: ${bad[0]}`;
    } },
    { name: "sorted", run: () => (monotonic(ts()) !== null ? null : "rows are not sorted by time") },
    { name: "distinct", run: () => (new Set(ts()).size === ts().length ? null : "duplicate timestamps") },
    { name: "limit", run: () => (rows(r).length <= FUNDING_LIMIT ? null : `${rows(r).length} rows > --limit ${FUNDING_LIMIT}`) },
    { name: "history", run: () => (rows(r).length >= 2 ? null : `${rows(r).length} row(s) for --limit ${FUNDING_LIMIT}: a history of a listed market has ≥ 2 prints`) },
  ];
}

function bookChecks(r: CliRun): Check[] {
  const book = () => r.envelope.data as { bids: [string, string][]; asks: [string, string][] };
  return [
    schemaCheck(r, Orderbook),
    { name: "ordered", run: () => {
      const b = book().bids.map(l => Number(l[0]));
      const a = book().asks.map(l => Number(l[0]));
      const ok = b.every((p, i) => i === 0 || p < b[i - 1]) && a.every((p, i) => i === 0 || p > a[i - 1]);
      return ok ? null : "bids must be strictly descending and asks strictly ascending";
    } },
    { name: "uncrossed", run: () => {
      const { bids, asks } = book();
      if (bids.length === 0 || asks.length === 0) return "one side of the book is empty";
      return Number(bids[0][0]) < Number(asks[0][0]) ? null : `best bid ${bids[0][0]} ≥ best ask ${asks[0][0]}`;
    } },
  ];
}

function tradesChecks(r: CliRun, now: number): Check[] {
  return [
    schemaCheck(r, Trades),
    { name: "limit", run: () => (rows(r).length <= TRADES_LIMIT ? null : `${rows(r).length} rows > --limit ${TRADES_LIMIT}`) },
    { name: "not-future", run: () => (rows(r).every(x => Number(x.time) <= now + 5_000) ? null : "a trade is in the future") },
    { name: "sorted", run: () => (monotonic(rows(r).map(x => Number(x.time))) !== null ? null : "rows are not sorted by time") },
  ];
}

function klineChecks(r: CliRun, now: number): Check[] {
  const ts = () => rows(r).map(x => Number(x.time));
  return [
    schemaCheck(r, Klines),
    { name: "alignment", run: () => {
      const bad = ts().filter(t => t % KLINE_INTERVAL_MS !== 0);
      return bad.length === 0 ? null : `${bad.length}/${ts().length} candle opens not aligned to 1h (e.g. ${new Date(bad[0]).toISOString()})`;
    } },
    { name: "not-future", run: () => {
      const bad = ts().filter(t => t > now);
      return bad.length === 0 ? null : `${bad.length} candle(s) open in the future (${new Date(bad[0]).toISOString()} > now ${new Date(now).toISOString()})`;
    } },
    { name: "sorted", run: () => (monotonic(ts()) === "asc" && new Set(ts()).size === ts().length ? null : "candles must be ascending with distinct opens") },
    { name: "window", run: () => {
      // Default window: the last 24 h. A candle opening before (now − 24 h − 1 interval) is outside it.
      const bad = ts().filter(t => t < now - 24 * 3_600_000 - KLINE_INTERVAL_MS);
      return bad.length === 0 ? null : `${bad.length}/${ts().length} candles open before the default 24 h window (${new Date(bad[0]).toISOString()})`;
    } },
    { name: "ohlc", run: () => {
      const bad = rows(r).filter(k => {
        const [o, h, l, c] = ["open", "high", "low", "close"].map(f => Number(k[f]));
        return !(l <= Math.min(o, c) && h >= Math.max(o, c));
      });
      return bad.length === 0 ? null : `${bad.length} candle(s) with low > min(open, close) or high < max(open, close)`;
    } },
    { name: "null-not-zero", run: () => zeroStandIn(rows(r), ["volume"]) },
  ];
}

/** Base asset of a CLI market symbol: "BTC-PERP" → BTC, "BTCUSDT" → BTC, "xyz:NVDA" → NVDA, "BTC-USD.P" → BTC. */
export function baseOf(symbol: string): string {
  let s = symbol.toUpperCase();
  if (s.includes(":")) s = s.split(":").pop() as string;
  for (;;) {
    const next = s.replace(/(?:[-_/ ]?(?:USDT|USDC|USD1|USDE|USDG|USD|PERP)|\.P)$/, "");
    if (next === s || next === "") return s;
    s = next;
  }
}

/** The checks of one supported / alternate / unsupported read cell. */
export function cellChecks(cmd: ReadCommand, exp: Expect, r: CliRun, ctx: { symbol: string; now: number }): Check[] {
  const env = envelopeChecks(r);
  if (exp.kind === "unsupported") {
    return [...env, { name: "unsupported", run: () => {
      if (r.envelope.ok) return "ok:true — the capability table declares this cell unsupported";
      const e = r.envelope.error!;
      if (e.code !== "CAPABILITY_UNSUPPORTED") return `code ${e.code} (want CAPABILITY_UNSUPPORTED)`;
      return issues(ErrorEnvelope, r.envelope) ? `refusal without remediation: ${issues(ErrorEnvelope, r.envelope)}` : null;
    } }];
  }
  if (exp.kind === "credentials") {
    return [...env, { name: "needs-credentials", run: () => {
      if (r.envelope.ok) return "ok:true without credentials — the capability table declares this cell credential-gated";
      const e = r.envelope.error!;
      if (!["NO_SIGNER_AVAILABLE", "KEY_NOT_FOUND", "AGENT_NOT_REGISTERED"].includes(e.code)) return `code ${e.code} (want NO_SIGNER_AVAILABLE)`;
      return issues(ErrorEnvelope, r.envelope) ? `refusal without remediation: ${issues(ErrorEnvelope, r.envelope)}` : null;
    } }];
  }
  if (exp.kind === "alt") {
    return [...env, okCheck(r), schemaCheck(r, exp.contract === "currentFunding" ? CurrentFundingTerms : RfqQuotes)];
  }
  // The capability table is derived from what the command answers: an "ok" cell that returns a
  // labelled alternate contract (kind currentFunding / rfqQuotes) means the table is stale.
  const base = [...env, okCheck(r), { name: "default-contract", run: () => {
    const kind = (r.envelope.data as { kind?: unknown } | undefined)?.kind;
    return kind === "currentFunding" || kind === "rfqQuotes" ? `answered kind ${String(kind)} — declare it in capabilities.ts` : null;
  } }];
  switch (cmd) {
    case "list":
    case "prices": return [...base, ...marketListChecks(r, ctx.symbol)];
    case "info": return [...base, schemaCheck(r, MarketRow), { name: "symbol", run: () => (baseOf(String((r.envelope.data as { symbol?: unknown })?.symbol)) === ctx.symbol ? null : `info returned ${(r.envelope.data as { symbol?: unknown })?.symbol}`) }];
    case "funding": return [...base, ...fundingChecks(r)];
    case "book": return [...base, ...bookChecks(r)];
    case "trades": return [...base, ...tradesChecks(r, ctx.now)];
    case "kline": return [...base, ...klineChecks(r, ctx.now)];
  }
}

/** Unknown symbol → SYMBOL_NOT_FOUND with a remediation (never ok:true with [] / an UNKNOWN code). */
export function unknownSymbolCheck(r: CliRun): Check {
  return { name: "unknown-symbol", run: () => {
    if (r.envelope.ok) return `ok:true (${JSON.stringify(r.envelope.data).slice(0, 80)}) — want SYMBOL_NOT_FOUND`;
    const e = r.envelope.error!;
    if (e.code !== "SYMBOL_NOT_FOUND") return `code ${e.code} (want SYMBOL_NOT_FOUND): ${e.message.slice(0, 120)}`;
    return issues(ErrorEnvelope, r.envelope) ? `no remediation: ${issues(ErrorEnvelope, r.envelope)}` : null;
  } };
}
