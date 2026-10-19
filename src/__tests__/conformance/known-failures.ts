/**
 * KNOWN_FAILURES — the ONE explicit list of conformance checks that fail today.
 *
 * A listed check is still run and ASSERTED TO FAIL (replay mode): the fix of the bug makes the
 * assertion fail, which forces the entry's removal in the same PR. A check that is not listed must
 * pass. Nothing is skipped silently. A stale id (no check of that id ran) fails the suite too.
 *
 * Live mode (PERP_LIVE=1): live data can make a data-dependent known failure pass on a given night;
 * that is reported as a warning, not a failure. New failures fail the live run.
 *
 * Id format: `<venue>:<command>:<check>` (venues.conformance.test.ts), `cross:<cell>:<check>` and
 * `parity:<tool>:<check>` (cross.conformance.test.ts), `ws:<venue>:<check>` (ws.conformance.test.ts).
 */
import { expect } from "vitest";
import { IS_LIVE } from "./harness.js";

const FIX_0151 = "0.15.1 fix in progress (perp-cli-fix)";
const NEW = "new finding of the conformance suite (2026-10-19), not yet triaged";
const FUNDING_FIELDS = `${FIX_0151}: funding history rows lack intervalHours / rateKind`;

export const KNOWN_FAILURES: Readonly<Record<string, string>> = {
  // Lighter family funding "history" is one current row.
  "lighter:funding:history": FIX_0151,
  "lighter-rh:funding:history": FIX_0151,
  // Pacifica `market prices` prints the raw venue rows (mark / oracle / funding / …).
  "pacifica:prices:schema": FIX_0151,
  // Funding history rows without intervalHours / rateKind (9 venues).
  "pacifica:funding:fields": FUNDING_FIELDS,
  "hyperliquid:funding:fields": FUNDING_FIELDS,
  "lighter:funding:fields": FUNDING_FIELDS,
  "aster:funding:fields": FUNDING_FIELDS,
  "lighter-rh:funding:fields": FUNDING_FIELDS,
  "ondo:funding:fields": FUNDING_FIELDS,
  "arcus:funding:fields": FUNDING_FIELDS,
  "qfex:funding:fields": FUNDING_FIELDS,
  "risex:funding:fields": FUNDING_FIELDS,
  // New findings of this suite (not in the 0.15.1 list yet — triage, then fix or reclassify).
  // Lighter `market book` returns individual resting orders, not price levels (repeated prices).
  "lighter:book:ordered": NEW,
  "lighter-rh:book:ordered": NEW,
  // Lighter `market kline` sends count_back=100 and ignores the default 24 h window.
  "lighter:kline:window": NEW,
  "lighter-rh:kline:window": NEW,
  // `arb scan --rates --include-unverified` marks a row with an unverified-funding leg (QFEX) executable.
  "cross:arb-rates-unverified:never-executable": FIX_0151,
  // `arb scan --gaps` compares a KRW-quoted price with USD prices (a ~200 % "gap").
  "cross:arb-gaps:same-quote": FIX_0151,
  // `market list` / `market prices` without -e omit the market-data-only venues.
  "cross:market-list-all:all-venues": FIX_0151,
  "cross:market-prices-all:all-venues": FIX_0151,
  // MCP get_markets rows are VenueMarket (venueSymbol, fundingRateBasis, …), CLI rows ExchangeMarketInfo.
  "parity:get_markets:fields": FIX_0151,
  // MCP get_markets and `market list` disagree on the market set (full recorded directories, 2026-10-19):
  // pacifica 75 vs 77 (BP, CHIP), hyperliquid 177 vs 178 (SPX), aster 600 vs 578 (MCP lists
  // SETTLING / PENDING symbols, CLI lists SPX), lighter-rh 57 vs 58 (USELESS), lighter.
  ...Object.fromEntries(["pacifica", "hyperliquid", "aster", "lighter-rh", "lighter"].flatMap(v => [
    [`parity:get_markets:${v}:count`, `${FIX_0151}: MCP vs CLI market counts`],
    [`parity:get_markets:${v}:symbols`, `${FIX_0151}: MCP vs CLI market sets`],
  ])),
  // get_prices covers every market-data venue; `market prices` without -e omits four (same root as all-venues).
  "parity:get_prices:same": FIX_0151,
  // ── Row caps / ranges / intervals (ranges.conformance.test.ts; fix agent items F / G / H / K / L) ──
  "risex:kline-30m:spacing": `${FIX_0151} (F): RISEx answers an interval it does not serve with 1m bars`,
  "txflow:cap:kline:1m:3500:limit-honoured": `${FIX_0151} (G): TxFlow candleSnapshot over ~3000 bars → HTTP 200 []`,
  "txflow:kline-3d:no-silent-empty": `${FIX_0151} (H): TxFlow advertises 3d / 1w / 1M, always empty`,
  "txflow:kline-1w:no-silent-empty": `${FIX_0151} (H): TxFlow advertises 3d / 1w / 1M, always empty`,
  "txflow:kline-1M:no-silent-empty": `${FIX_0151} (H): TxFlow advertises 3d / 1w / 1M, always empty`,
  "extended:cap:kline:1m:3000:limit-honoured": `${FIX_0151} (K): Extended candles cap at 2800 rows (docs: 10000), no paging`,
  "extended:cap:funding:1500:limit-honoured": `${FIX_0151} (L): Extended funding history caps at 1000 rows (docs: 10000), no paging`,
  // New findings (ranges).
  ...Object.fromEntries(["pacifica", "hyperliquid", "lighter", "lighter-rh", "aster"].map(v => [`${v}:kline-unsupported:refused-before-io`, `${NEW}: an unknown interval is sent to the venue (no interval table) and fails after I/O`])),
  ...Object.fromEntries(["3m", "5m", "15m", "30m", "2h", "4h", "6h", "8h", "12h", "3d", "5d", "1w", "2w", "3w", "4w"].map(iv => [`grvt:kline-${iv}:spacing`, `${NEW}: GRVT's oldest bar is clipped to --start (open not aligned to the interval)`])),
  // ── WS library (perp-cli/ws, @hypurrquant/perp-ws 0.15.0) ──
  // A rejected `ready` carries the code only as .structured.code (fix: expose .code).
  ...Object.fromEntries(["hyperliquid", "pacifica", "lighter", "lighter-rh", "aster", "arcus"].map(v => [`ws:${v}:ready-code`, `${FIX_0151}: WsError .code`])),
  // Arcus OFFLINE markets stream mark / index "0" instead of null.
  "ws:arcus:stream-no-zero-placeholder": `${FIX_0151}: Arcus OFFLINE "0"`,
  // CLI ⇄ WS directory + eligibility (fix agent items N / O / P / Q).
  "ws:aster:directory-parity": `${FIX_0151} (N): WS streams Aster SETTLING / PENDING symbols the CLI filters`,
  "ws:aster:eligibility-ws": `${FIX_0151} (N): WS directory lists non-TRADING Aster symbols`,
  "ws:arcus:directory-parity": `${FIX_0151} (O): WS streams Arcus OFFLINE markets the CLI filters`,
  "ws:arcus:eligibility-ws": `${FIX_0151} (O): WS directory lists OFFLINE Arcus markets`,
  "ws:lighter:eligibility-cli": `${FIX_0151} (P): CLI market list includes Lighter inactive markets`,
  "ws:lighter:eligibility-ws": `${FIX_0151} (P): WS directory streams Lighter inactive markets`,
  "ws:lighter:directory-parity": `${FIX_0151} (Q): Lighter WS directory 235 vs REST / CLI 238`,
  // New findings (WS).
  ...Object.fromEntries(["hyperliquid", "pacifica", "lighter", "lighter-rh", "aster", "arcus"].map(v => [`ws:${v}:ratekind-parity`, `${NEW}: CLI market rows carry no fundingRateKind to compare with the WS rateKind`])),
  "ws:lighter:stream-no-zero-placeholder": `${NEW}: Lighter market_stats last_trade_price "0" for markets without trades`,
  "ws:aster:canonical-parity": `${NEW}: Aster WS directory entries BTCU / ETHU without canonical`,
};

const seen = new Set<string>();

/** Assert one check against the registry (see the module comment). */
export function expectCheck(id: string, failure: string | null): void {
  seen.add(id);
  const known = KNOWN_FAILURES[id];
  if (known === undefined) {
    expect(failure, `${id}: ${failure}`).toBeNull();
    return;
  }
  if (failure === null) {
    const msg = `${id} is a KNOWN_FAILURE ("${known}") but now passes — remove it from src/__tests__/conformance/known-failures.ts`;
    if (IS_LIVE) { console.warn(`[conformance] ${msg} (live data; not failing the live run)`); return; }
    expect.fail(msg);
  }
}

/** Ids of KNOWN_FAILURES with one of `prefixes` that no check evaluated in this file (stale entries). */
export function staleKnownFailures(prefixes: readonly string[], exclude: RegExp | null = null): string[] {
  return Object.keys(KNOWN_FAILURES).filter(id => prefixes.some(p => id.startsWith(p)) && (exclude === null || !exclude.test(id)) && !seen.has(id));
}
