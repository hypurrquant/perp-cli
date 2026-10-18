/**
 * Exact decimal-string helpers for Print / vault math (scaled BigInt, no float drift). Venue
 * values carry up to ~28 fractional digits (lake balances), so Number() is not enough.
 */
import { PerpError } from "../errors.js";
import { subDecimal } from "./precision.js";

const PLAIN = /^-?\d+(\.\d+)?$/;

function scaled(s: string): { int: bigint; scale: number } {
  if (!PLAIN.test(s)) throw new PerpError("INVALID_PARAMS", `Not a plain decimal number: "${s}"`);
  const neg = s.startsWith("-");
  const [ip, fp = ""] = (neg ? s.slice(1) : s).split(".");
  return { int: BigInt(ip + fp) * (neg ? -1n : 1n), scale: fp.length };
}

/** True when `s` is a plain decimal string ("12", "-0.5"). */
export function isPlainDecimal(s: unknown): s is string {
  return typeof s === "string" && PLAIN.test(s);
}

/** Sign of a − b: -1, 0, 1. */
export function cmpDecimal(a: string, b: string): -1 | 0 | 1 {
  const d = subDecimal(a, b);
  if (/^-?0(\.0+)?$/.test(d)) return 0;
  return d.startsWith("-") ? -1 : 1;
}

/** Number of fractional digits written ("1.50" → 2). */
export function fractionDigits(s: string): number {
  return scaled(s).scale;
}

/** a ÷ b truncated toward zero at `scale` fractional digits, trailing zeros dropped. b = 0 → null. */
export function divDecimal(a: string, b: string, scale = 18): string | null {
  const x = scaled(a);
  const y = scaled(b);
  if (y.int === 0n) return null;
  // (x.int / 10^xs) / (y.int / 10^ys) = x.int * 10^(ys + scale - xs) / y.int, at `scale` digits
  const shift = y.scale + scale - x.scale;
  const num = shift >= 0 ? x.int * 10n ** BigInt(shift) : x.int;
  const den = shift >= 0 ? y.int : y.int * 10n ** BigInt(-shift);
  const q = num / den;
  const neg = q < 0n;
  let s = (neg ? -q : q).toString().padStart(scale + 1, "0");
  if (scale > 0) s = `${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`.replace(/\.?0+$/, "");
  return (neg && s !== "0" ? "-" : "") + s;
}

/** Trailing fractional zeros dropped ("20.190000000000" → "20.19", "10.000" → "10"). */
export function trimDecimal(s: string): string {
  scaled(s);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}
