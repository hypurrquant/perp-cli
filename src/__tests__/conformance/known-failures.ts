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

// Owned by fix/0.15.1-pacifica-lighter (not merged yet): its entries stay until it lands.
const FIX_PL = "0.15.1 fix in progress (fix/0.15.1-pacifica-lighter)";
const NEW = "new finding of the conformance suite (2026-10-19), not yet triaged";

export const KNOWN_FAILURES: Readonly<Record<string, string>> = {
  // Lighter RH `market book` returns individual resting orders, not price levels (repeated prices).
  // (Lighter mainnet passes on the recorded book: its first --depth 10 levels hold no repeated price
  // since the JSON book is cut to --depth; the aggregation fix is the same branch.)
  "lighter-rh:book:ordered": `${FIX_PL}: book levels are not aggregated`,
  // Lighter `market kline` sends count_back=100 and ignores the default 24 h window.
  "lighter:kline:window": `${FIX_PL}: count_back=100 ignores the 24 h window`,
  "lighter-rh:kline:window": `${FIX_PL}: count_back=100 ignores the 24 h window`,
  // MCP get_markets rows are VenueMarket (venueSymbol, fundingRateBasis, …), CLI rows ExchangeMarketInfo
  // — documented as different by design in 0.15.1 (CHANGELOG "MCP get_markets row counts vs the CLI").
  "parity:get_markets:fields": `${NEW}: MCP keyless rows are VenueMarket, CLI rows ExchangeMarketInfo (row shape differs by design — contract decision pending)`,
  // MCP get_markets and `market list` disagree on the market set (re-recorded 2026-10-19): the public
  // directory behind keyless MCP leaves out markets whose asset class is ambiguous, documented in
  // 0.15.1 — cli-only: pacifica BP, CHIP; hyperliquid SPX; aster SPX; lighter QNT, BOT, WEN, SPX, BB;
  // lighter-rh USELESS. Contract decision pending (allowlist the documented exclusions).
  ...Object.fromEntries(["pacifica", "hyperliquid", "aster", "lighter-rh", "lighter"].flatMap(v => [
    [`parity:get_markets:${v}:count`, `${NEW}: MCP leaves out ambiguous-class markets the CLI lists (documented in 0.15.1)`],
    [`parity:get_markets:${v}:symbols`, `${NEW}: MCP leaves out ambiguous-class markets the CLI lists (documented in 0.15.1)`],
  ])),
  // ── Row caps / ranges / intervals (ranges.conformance.test.ts) ──
  // No interval table: an unknown interval is sent to the venue and fails after I/O.
  ...Object.fromEntries(["pacifica", "lighter", "lighter-rh"].map(v => [`${v}:kline-unsupported:refused-before-io`, `${FIX_PL}: no interval table — an unknown interval reaches the venue`])),
  // The interval IS refused before the candles request, but the adapter's own start-up request
  // (Hyperliquid info "meta", Aster /fapi/v3/time) runs first and the cell counts every request.
  ...Object.fromEntries(["hyperliquid", "aster"].map(v => [`${v}:kline-unsupported:refused-before-io`, `${NEW}: adapter start-up request precedes the interval check (no candles request is sent)`])),
  // ── WS library (perp-cli/ws, @hypurrquant/perp-ws) ──
  "ws:aster:directory-parity": `${NEW}: WS-only BTCU, ETHU, GPRO, BNC, … (10) — the CLI lists USDT-quoted perps only, the WS keeps USD1 / U-quoted ones with canonical null (by design in 0.15.1; allowlist pending)`,
  "ws:lighter:eligibility-cli": `${FIX_PL}: CLI market list includes Lighter inactive markets`,
  "ws:lighter:eligibility-ws": `${FIX_PL}: WS directory streams Lighter inactive markets`,
  "ws:lighter:directory-parity": `${FIX_PL}: Lighter WS directory 235 vs CLI 238 (cli-only DOLO, MYX, RESOLV)`,
  ...Object.fromEntries(["pacifica", "lighter", "lighter-rh"].map(v => [`ws:${v}:ratekind-parity`, `${v === "pacifica" ? FIX_PL : NEW}: CLI fundingRateKind ${v === "pacifica" ? "(predicted / lastSettled per row)" : "null (REST field not verified)"} vs the WS funding rateKind`])),
  "ws:lighter:stream-no-zero-placeholder": `${FIX_PL}: Lighter market_stats last_trade_price "0" for markets without trades`,
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
