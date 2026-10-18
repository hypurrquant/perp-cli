/**
 * Decimal-string precision helpers for order entry.
 *
 * All math is done on scaled BigInt to avoid float drift. Rules:
 * - limit prices that are not on tick are REJECTED (INVALID_TICK), never rounded;
 * - slippage-bounded protection prices are aligned toward crossing
 *   (buy → up, sell → down);
 * - sizes are floored to the step; a result of zero is SIZE_TOO_SMALL.
 */

import { PerpError } from "../errors.js";
import type { ExchangeAdapter } from "./interface.js";

interface Scaled { int: bigint; scale: number }

/**
 * Strict plain-decimal parse ("123", "-0.5", "1.250"). Hex, exponent
 * ("1e-8"), Infinity/NaN, empty and whitespace-padded forms are rejected —
 * never coerced through Number().
 */
function parseDecimal(s: string): Scaled {
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new PerpError("INVALID_PARAMS", `Not a plain decimal number: "${s}"`, {
      remediation: "Use a plain decimal such as 123.45 (no exponent, hex or spaces)",
    });
  }
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [ip, fp = ""] = body.split(".");
  const int = BigInt(ip + fp) * (neg ? -1n : 1n);
  return { int, scale: fp.length };
}

function rescale(v: Scaled, scale: number): bigint {
  if (scale < v.scale) throw new Error("rescale: cannot reduce scale");
  return v.int * 10n ** BigInt(scale - v.scale);
}

function format(int: bigint, scale: number): string {
  const neg = int < 0n;
  const abs = neg ? -int : int;
  let s = abs.toString().padStart(scale + 1, "0");
  if (scale > 0) s = `${s.slice(0, s.length - scale)}.${s.slice(s.length - scale)}`.replace(/\.?0+$/, "");
  return (neg ? "-" : "") + s;
}

/** Number of ticks (integer) for a value exactly on the grid, or null when off-grid. */
export function exactUnits(value: string, step: string): bigint | null {
  const v = parseDecimal(value);
  const st = parseDecimal(step);
  if (st.int <= 0n) throw new PerpError("INVALID_PARAMS", `step must be positive (got ${step})`);
  const scale = Math.max(v.scale, st.scale);
  const vi = rescale(v, scale);
  const si = rescale(st, scale);
  if (vi % si !== 0n) return null;
  return vi / si;
}

/** Value → integer units; throws INVALID_TICK when off-grid. */
export function toUnitsExact(value: string, step: string, what: string): bigint {
  const u = exactUnits(value, step);
  if (u === null) {
    throw new PerpError("INVALID_TICK", `${what} ${value} is not a multiple of ${step}`, {
      remediation: `Use a ${what} that is a multiple of ${step}`,
    });
  }
  return u;
}

function alignUnits(value: string, step: string, mode: "floor" | "ceil"): bigint {
  const v = parseDecimal(value);
  const st = parseDecimal(step);
  if (st.int <= 0n) throw new PerpError("INVALID_PARAMS", `step must be positive (got ${step})`);
  const scale = Math.max(v.scale, st.scale);
  const vi = rescale(v, scale);
  const si = rescale(st, scale);
  let q = vi / si;
  const r = vi % si;
  if (r !== 0n) {
    if (mode === "floor" && vi < 0n) q -= 1n;
    if (mode === "ceil" && vi > 0n) q += 1n;
  }
  return q;
}

/** Integer units → decimal string on the step grid. */
export function unitsToString(units: bigint, step: string): string {
  const st = parseDecimal(step);
  return format(units * st.int, st.scale);
}

/** Floor a size to the step. Throws SIZE_TOO_SMALL if the result is zero. */
export function floorSize(size: string, stepSize: string): string {
  const u = alignUnits(size, stepSize, "floor");
  if (u <= 0n) {
    throw new PerpError("SIZE_TOO_SMALL", `Size ${size} is below the minimum step ${stepSize}`, {
      remediation: `Use a size of at least ${stepSize}`,
    });
  }
  return unitsToString(u, stepSize);
}

/** Align a slippage-bounded protection price toward crossing: buy → ceil, sell → floor. */
export function alignProtectionPrice(price: string, tickSize: string, side: "buy" | "sell"): string {
  const u = alignUnits(price, tickSize, side === "buy" ? "ceil" : "floor");
  if (u <= 0n) throw new PerpError("INVALID_PARAMS", `Protection price ${price} aligns to zero`);
  return unitsToString(u, tickSize);
}

/** Throws INVALID_PARAMS unless `value` is a plain decimal strictly greater than zero. */
export function requirePositive(value: string, what: string): void {
  if (parseDecimal(value).int <= 0n) {
    throw new PerpError("INVALID_PARAMS", `${what} must be positive (got ${value})`);
  }
}

/** Validate a limit price is positive and on tick; returns it unchanged (normalized). Throws INVALID_TICK. */
export function requireOnTick(price: string, tickSize: string): string {
  requirePositive(price, "price");
  return unitsToString(toUnitsExact(price, tickSize, "price"), tickSize);
}

/** Exact (a + b) / 2 of two plain decimal strings (no float arithmetic: 0.1 and 0.2 → "0.15"). */
export function midDecimal(a: string, b: string): string {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale) + 1; // one more digit holds the possible ".5"
  return format((rescale(x, scale) + rescale(y, scale)) / 2n, scale);
}

/** Exact decimal a − b (plain decimal strings). */
export function subDecimal(a: string, b: string): string {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  const scale = Math.max(x.scale, y.scale);
  return format(rescale(x, scale) - rescale(y, scale), scale);
}

/** Exact decimal a × b (plain decimal strings). */
export function mulDecimal(a: string, b: string): string {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  return format(x.int * y.int, x.scale + y.scale);
}

/** mark × (1 ± bps/10000), as a decimal string (not yet tick-aligned). */
export function slippagePrice(mark: string, side: "buy" | "sell", slippageBps: number): string {
  const m = Number(mark);
  if (!Number.isFinite(m) || m <= 0) throw new PerpError("PRICE_STALE", `Invalid mark price "${mark}"`);
  const f = side === "buy" ? 1 + slippageBps / 10_000 : 1 - slippageBps / 10_000;
  if (f <= 0) throw new PerpError("INVALID_PARAMS", `slippageBps ${slippageBps} is too large for a sell`);
  return (m * f).toFixed(12);
}

/** Significant digits kept for a computed price when the market tick is not at hand. */
const COMPUTED_PRICE_SIG_DIGITS = 8;

/**
 * A COMPUTED price (an average, a mid, notional / size) as a plain decimal string without binary
 * float noise ("2727.2000000000003" → "2727.2"): rounded to the market tick's decimals when
 * `tickSize` is given, else to 8 significant digits; trailing zeros dropped. A price the venue
 * reports as a string is passed through unchanged elsewhere — never run through this.
 * A non-finite value throws (Rule #2: no "0" / "NaN" price).
 */
export function formatComputedPrice(value: number, tickSize: string | null = null): string {
  if (!Number.isFinite(value)) {
    throw new PerpError("EXCHANGE_ERROR", `computed price is not a finite number (${value})`);
  }
  const abs = Math.abs(value);
  const decimals = tickSize !== null
    ? parseDecimal(tickSize).scale
    : abs === 0 ? 0 : Math.min(20, Math.max(0, COMPUTED_PRICE_SIG_DIGITS - 1 - Math.floor(Math.log10(abs))));
  const fixed = value.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Floor a non-negative measured amount (e.g. a verified fill) onto the lot grid; "0…" when below one lot. */
export function floorToStep(value: number, step: string): string {
  const dec = (step.split(".")[1] ?? "").length;
  const f = 10 ** dec;
  const plain = (Math.floor(Math.max(0, value) * f + 1e-9) / f).toFixed(dec);
  return unitsToString(alignUnits(plain, step, "floor"), step);
}

/**
 * The market's lot step from the venue market info (stepSize, else 10^-sizeDecimals).
 * Unknown market or unknown lot → throws (Rule #2: never size orders off the typed decimals).
 */
export async function lotStepOf(adapter: ExchangeAdapter, symbol: string): Promise<string> {
  // The adapter's own lot step from market metadata it already holds (Lighter: size decimals of
  // its loaded market list) — no full market-list read per order.
  const own = (adapter as { lotStepOf?: (s: string) => string }).lotStepOf;
  if (typeof own === "function") return own.call(adapter, symbol);
  const strip = (s: string) => s.toUpperCase().replace(/-PERP$/, "");
  // The adapter's own symbol resolution when it has one (HL "GOOGL" → "km:GOOGL" on a HIP-3 dex).
  const resolve = (adapter as { resolveSymbol?: (s: string) => string }).resolveSymbol;
  const wanted = new Set([strip(symbol), ...(typeof resolve === "function" ? [strip(resolve.call(adapter, symbol))] : [])]);
  const markets = await adapter.getMarkets();
  let m = markets.find(x => wanted.has(strip(x.symbol)));
  if (m === undefined) {
    // HIP-3: the dex adapter lists "xyz:XYZ100" while callers (and its asset map) also use the
    // bare "XYZ100". Only an unambiguous dex-prefixed match counts.
    const bare = markets.filter(x => x.symbol.includes(":") && wanted.has(strip(x.symbol.split(":").pop()!)));
    if (bare.length > 1) {
      throw new PerpError("SYMBOL_NOT_FOUND", `${adapter.name}: ${symbol} is ambiguous (${bare.map(x => x.symbol).join(", ")}) — lot step unknown`, { exchange: adapter.name });
    }
    m = bare[0];
  }
  if (m === undefined) {
    throw new PerpError("SYMBOL_NOT_FOUND", `${adapter.name}: market ${symbol} not found — lot step unknown`, { exchange: adapter.name, remediation: `List markets: perp -e ${adapter.name} market list` });
  }
  if (m.stepSize !== null) return m.stepSize;
  if (m.sizeDecimals !== null && Number.isInteger(m.sizeDecimals) && m.sizeDecimals >= 0) {
    return m.sizeDecimals === 0 ? "1" : `0.${"0".repeat(m.sizeDecimals - 1)}1`;
  }
  throw new PerpError("EXCHANGE_ERROR", `${adapter.name} ${symbol}: the venue market info has no lot step (stepSize / sizeDecimals) — cannot size the order to the lot`, {
    exchange: adapter.name,
    remediation: `Check the market: perp -e ${adapter.name} market info ${symbol}`,
  });
}
