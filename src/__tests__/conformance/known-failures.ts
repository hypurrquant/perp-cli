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

/**
 * Every remaining entry is a documented, by-design difference between two read paths (0.15.1
 * CHANGELOG), not an open bug: the contract decision — allowlist it in the check, or align the
 * paths — is pending. Re-triage at the next release.
 */
const BY_DESIGN = "by design in 0.15.1 (documented), contract decision pending";

export const KNOWN_FAILURES: Readonly<Record<string, string>> = {
  // MCP keyless get_markets rows are the public directory's VenueMarket rows (venueSymbol,
  // fundingRateBasis, no sizeDecimals / fundingHours), CLI rows ExchangeMarketInfo.
  "parity:get_markets:fields": `${BY_DESIGN}: MCP keyless rows are VenueMarket, CLI rows ExchangeMarketInfo`,
  // The public directory behind keyless MCP leaves out markets whose asset class is ambiguous, so a
  // same-name ticker is never matched across venues (recorded 2026-10-19, cli-only: pacifica BP,
  // CHIP; hyperliquid SPX; aster SPX; lighter QNT, BOT, WEN, SPX, BB; lighter-rh USELESS).
  ...Object.fromEntries(["pacifica", "hyperliquid", "aster", "lighter-rh", "lighter"].flatMap(v => [
    [`parity:get_markets:${v}:count`, `${BY_DESIGN}: MCP leaves out ambiguous-class markets the CLI lists`],
    [`parity:get_markets:${v}:symbols`, `${BY_DESIGN}: MCP leaves out ambiguous-class markets the CLI lists`],
  ])),
  // ── WS library (perp-cli/ws, @hypurrquant/perp-ws) ──
  // The CLI lists USDT-quoted Aster perps only (its symbol mapping cannot address USD1 / U); the WS
  // directory keeps those with canonical null (WS-only BTCU, ETHU, GPRO, BNC, POLYMARKET, … — 10).
  "ws:aster:directory-parity": `${BY_DESIGN}: WS keeps USD1 / U-quoted Aster perps the CLI does not list`,
  "ws:aster:canonical-parity": `${BY_DESIGN}: the USD1 / U-quoted BTCU / ETHU carry canonical null on purpose`,
  // CLI and WS read different funding fields: Pacifica CLI rows show next_funding_rate ("predicted"),
  // the WS prices channel the settled rate; Lighter / Lighter RH REST rates are not verified against
  // settled prints (null) while the WS market_stats rate is labelled lastSettled.
  "ws:pacifica:ratekind-parity": `${BY_DESIGN}: CLI predicted (next_funding_rate) vs WS lastSettled — different fields, each labelled`,
  "ws:lighter:ratekind-parity": `${BY_DESIGN}: CLI null (REST rate unverified) vs WS lastSettled`,
  "ws:lighter-rh:ratekind-parity": `${BY_DESIGN}: CLI null (REST rate unverified) vs WS lastSettled`,
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
