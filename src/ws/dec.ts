/** Dec helpers (§3): a venue's JSON value as a string, never substituted. */

import type { Dec } from "./types.js";

const DECIMAL_RE = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * A JSON string verbatim (when it is a decimal number), a finite JSON number via String(value);
 * null for null/absent. Anything else → undefined (the caller reports WS_PROTOCOL_ERROR).
 */
export function toDec(v: unknown): Dec | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const m = DECIMAL_RE.exec(v);
    return m !== null && (m[2] !== "" || (m[3] !== undefined && m[3] !== "")) ? v : undefined;
  }
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : undefined;
  return undefined;
}

/**
 * Exact decimal shift: value × 10^places, on the digit string (no float). Lighter percent → fraction
 * is shiftDecimal(x, -2). Returns undefined for a non-decimal input.
 */
export function shiftDecimal(s: string, places: number): string | undefined {
  const m = DECIMAL_RE.exec(s);
  if (m === null || (m[2] === "" && (m[3] === undefined || m[3] === ""))) return undefined;
  const sign = m[1] === "-" ? "-" : "";
  const intPart = m[2];
  const fracPart = m[3] === undefined ? "" : m[3];
  const exp = (m[4] === undefined ? 0 : parseInt(m[4], 10)) + places;
  let digits = intPart + fracPart;
  let point = intPart.length + exp; // position of the decimal point within `digits`
  if (point <= 0) { digits = "0".repeat(1 - point) + digits; point = 1; }
  if (point > digits.length) digits = digits + "0".repeat(point - digits.length);
  let int = digits.slice(0, point).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(point).replace(/0+$/, "");
  if (int === "") int = "0";
  const out = frac === "" ? int : `${int}.${frac}`;
  return /^0(\.0*)?$/.test(out) ? "0" : sign + out;
}

/**
 * Exact value × integer × 10^shift on decimal strings (BigInt, no float). Lighter trade fees:
 * usd_amount × fee × 1e-6. Undefined for a non-decimal input or a non-integer multiplier.
 */
export function mulDecimalInt(s: string, n: number, shift: number): string | undefined {
  if (!Number.isInteger(n)) return undefined;
  const m = DECIMAL_RE.exec(s);
  if (m === null || m[4] !== undefined || (m[2] === "" && (m[3] === undefined || m[3] === ""))) return undefined;
  const frac = m[3] === undefined ? "" : m[3];
  const digits = `${m[2]}${frac}`.replace(/^0+(?=\d)/, "");
  const product = BigInt(digits === "" ? "0" : digits) * BigInt(n) * (m[1] === "-" ? -1n : 1n);
  const neg = product < 0n;
  const abs = (neg ? -product : product).toString();
  return shiftDecimal(`${neg ? "-" : ""}${abs}`, shift - frac.length);
}

/**
 * Exact sum of decimal strings (BigInt, no float). Undefined when any input is not a plain decimal
 * (no exponent). [] → "0".
 */
export function sumDecimals(values: readonly string[]): string | undefined {
  let scale = 0;
  const parts: Array<{ int: bigint; scale: number }> = [];
  for (const v of values) {
    const m = DECIMAL_RE.exec(v);
    if (m === null || m[4] !== undefined || (m[2] === "" && (m[3] === undefined || m[3] === ""))) return undefined;
    const frac = m[3] === undefined ? "" : m[3];
    const digits = `${m[2]}${frac}`.replace(/^0+(?=\d)/, "");
    parts.push({ int: BigInt(digits === "" ? "0" : digits) * (m[1] === "-" ? -1n : 1n), scale: frac.length });
    if (frac.length > scale) scale = frac.length;
  }
  let total = 0n;
  for (const p of parts) total += p.int * 10n ** BigInt(scale - p.scale);
  const neg = total < 0n;
  const abs = (neg ? -total : total).toString();
  return shiftDecimal(`${neg ? "-" : ""}${abs}`, -scale);
}
