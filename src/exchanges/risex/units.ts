/**
 * RISEx unit conversions — all exact (BigInt / string), never float maths.
 *
 *  - WAD: on-chain style 1e18-scaled integers (`/v1/positions` size / prices, IOC
 *    `filled_quantity`) → plain decimal strings.
 *  - ns: every RISEx timestamp and `funding_interval` is in NANOseconds → ms.
 *  - steps / ticks: orders are sent as integers — size_steps = size / step_size (uint32),
 *    price_ticks = price / step_price (uint24, max 16 777 215). Off-grid values are refused,
 *    never rounded.
 */

import { PerpError } from "../../errors.js";
import { exactUnits } from "../precision.js";

export const UINT24_MAX = 16_777_215n;
export const UINT32_MAX = 4_294_967_295n;
export const UINT64_MAX = 18_446_744_073_709_551_615n;

/** 1e18-scaled integer string ("1143307000000000000", "-2905…") → decimal string ("1.143307"). */
export function wadToDecimal(wad: string): string {
  const s = wad.trim();
  if (!/^-?\d+$/.test(s)) throw new PerpError("EXCHANGE_ERROR", `RISEx: "${wad}" is not a WAD integer`, { exchange: "risex" });
  const neg = s.startsWith("-");
  const digits = (neg ? s.slice(1) : s).replace(/^0+(?=\d)/, "");
  const padded = digits.padStart(19, "0");
  const int = padded.slice(0, padded.length - 18).replace(/^0+(?=\d)/, "");
  const frac = padded.slice(padded.length - 18).replace(/0+$/, "");
  const out = frac.length > 0 ? `${int}.${frac}` : int;
  return neg && out !== "0" ? `-${out}` : out;
}

/** Nanosecond decimal string → unix ms (integer division; exact for ms-aligned values). */
export function nsToMs(ns: string | number): number {
  const s = String(ns).trim();
  if (!/^\d+$/.test(s)) throw new PerpError("EXCHANGE_ERROR", `RISEx: "${ns}" is not a nanosecond timestamp`, { exchange: "risex" });
  return Number(BigInt(s) / 1_000_000n);
}

/** ns timestamp or null for "0" / "" / absent (RISEx sends "0" for "no value"). */
export function nsToMsOrNull(ns: unknown): number | null {
  if (typeof ns !== "string" && typeof ns !== "number") return null;
  const s = String(ns).trim();
  if (s === "" || s === "0") return null;
  return nsToMs(s);
}

/** Integer size in steps; refused when off the step grid, zero, or above uint32. */
export function toSizeSteps(size: string, stepSize: string): bigint {
  const u = exactUnits(size, stepSize);
  if (u === null) {
    throw new PerpError("INVALID_PARAMS", `RISEx size ${size} is not a multiple of the step size ${stepSize}`, {
      exchange: "risex", remediation: `Use a size that is a multiple of ${stepSize}`,
    });
  }
  if (u <= 0n) throw new PerpError("SIZE_TOO_SMALL", `RISEx size ${size} is below one step (${stepSize})`, { exchange: "risex" });
  if (u > UINT32_MAX) {
    throw new PerpError("SIZE_TOO_LARGE", `RISEx size ${size} is ${u} steps, above the uint32 limit`, {
      exchange: "risex", remediation: "Split the order",
    });
  }
  return u;
}

/** Integer price in ticks; refused (INVALID_TICK) when off-grid, INVALID_PARAMS when above uint24. */
export function toPriceTicks(price: string, stepPrice: string): bigint {
  const u = exactUnits(price, stepPrice);
  if (u === null) {
    throw new PerpError("INVALID_TICK", `RISEx price ${price} is not a multiple of the tick ${stepPrice}`, {
      exchange: "risex", remediation: `Use a price that is a multiple of ${stepPrice}`,
    });
  }
  if (u <= 0n) throw new PerpError("INVALID_PARAMS", `RISEx price ${price} must be positive`, { exchange: "risex" });
  if (u > UINT24_MAX) {
    throw new PerpError("INVALID_PARAMS", `RISEx price ${price} is ${u} ticks, above the uint24 order limit (${UINT24_MAX})`, { exchange: "risex" });
  }
  return u;
}

/** A RISEx decimal field, or null when absent / empty (RISEx sends "" for "not set"). */
export function decOrNull(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return /^-?\d+(\.\d+)?$/.test(s) ? s : null;
}

/**
 * Positive decimal → null for "0" (RISEx publishes "0" for "none": liquidation_price, avg_price, and
 * — live 2026-10-28 — the mark / index price of the three newest markets).
 */
export function positiveOrNull(v: unknown): string | null {
  const d = decOrNull(v);
  return d === null || !(Number(d) > 0) ? null : trimDecimal(d);
}

/** Exact comparison of two plain decimal strings: -1 | 0 | 1. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const parse = (s: string) => {
    if (!/^-?\d+(\.\d+)?$/.test(s)) throw new PerpError("EXCHANGE_ERROR", `RISEx: "${s}" is not a decimal`, { exchange: "risex" });
    const neg = s.startsWith("-");
    const [ip, fp = ""] = (neg ? s.slice(1) : s).split(".");
    return { int: BigInt(ip + fp) * (neg ? -1n : 1n), scale: fp.length };
  };
  const x = parse(a), y = parse(b);
  const scale = Math.max(x.scale, y.scale);
  const xi = x.int * 10n ** BigInt(scale - x.scale), yi = y.int * 10n ** BigInt(scale - y.scale);
  return xi < yi ? -1 : xi > yi ? 1 : 0;
}

/** Strip trailing zeros of a plain decimal ("83425.5900" → "83425.59"). */
export function trimDecimal(s: string): string {
  if (!s.includes(".")) return s;
  const out = s.replace(/0+$/, "").replace(/\.$/, "");
  return out === "-0" ? "0" : out;
}
