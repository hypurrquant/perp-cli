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
  // Lighter: CLI lists a market MCP get_markets drops (BOT), and a KRW-quoted mark differs (SAMSUNG).
  "parity:get_markets:lighter:count": FIX_0151,
  "parity:get_markets:lighter:symbols": FIX_0151,
  // get_prices covers every market-data venue; `market prices` without -e omits four (same root as all-venues).
  "parity:get_prices:same": FIX_0151,
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
export function staleKnownFailures(prefixes: readonly string[]): string[] {
  return Object.keys(KNOWN_FAILURES).filter(id => prefixes.some(p => id.startsWith(p)) && !seen.has(id));
}
