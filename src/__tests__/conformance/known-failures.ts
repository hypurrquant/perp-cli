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

// Empty: every check passes (0.15.1). A new failure is fixed, or registered here with its reason.
export const KNOWN_FAILURES: Readonly<Record<string, string>> = {};

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
