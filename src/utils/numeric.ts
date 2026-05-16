import { PerpError } from "../errors.js";

/**
 * Coerce a venue payload value to a finite number — or throw.
 *
 * Shared across all 4 exchange adapters (Lighter / Hyperliquid / Aster /
 * Pacifica) to enforce Rule #2 ("no fallback") on venue-returned strings
 * and numbers. Previously each adapter inlined `Number(x ?? 0)` which
 * silently coerced NaN / Infinity / non-numeric strings to 0, masking
 * stale-cache / partial-response corruption as legitimate "$0 balance".
 *
 * Rules:
 *  - `undefined` / `null` → returns `defaultValue` (default 0). Venues
 *    legitimately omit a field for an empty account or zero position;
 *    that is "no data, treat as zero", not a parsing failure.
 *  - empty string `""` → throws. Strict policy (qa/2026-05-16): an
 *    empty string is indistinguishable from a stale-cache partial
 *    response, so `Number("") === 0` would land back in the same
 *    silent-substitution hole. A truly absent field must surface as
 *    `undefined`/`null` at the adapter layer, not `""`.
 *  - finite number / parseable numeric string → returned as-is.
 *  - NaN / ±Infinity / non-numeric string → throws `EXCHANGE_ERROR`
 *    tagged with `exchange` so triage can attribute the failure to the
 *    exact venue endpoint.
 *
 * @param value Raw payload value (untyped — venues lie about SDK types).
 * @param fieldName Field path for the error message (e.g.
 *   `"available_balance"`, `"position.unrealized_pnl"`).
 * @param exchange Exchange tag for the PerpError details payload
 *   (`hyperliquid` / `pacifica` / `aster` / `lighter`).
 * @param opts.defaultValue Value returned for null/undefined. Default `0`.
 */
export function parseFiniteVenueNumber(
  value: unknown,
  fieldName: string,
  exchange: string,
  opts: { defaultValue?: number } = {},
): number {
  const defaultValue = opts.defaultValue ?? 0;
  if (value === undefined || value === null) return defaultValue;
  if (value === "") {
    throw new PerpError(
      "EXCHANGE_ERROR",
      `${exchange} response field \`${fieldName}\` is an empty string (use null for missing data)`,
      { exchange },
    );
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new PerpError(
      "EXCHANGE_ERROR",
      `${exchange} response field \`${fieldName}\` is not a finite number: ${JSON.stringify(value)}`,
      { exchange },
    );
  }
  return n;
}
