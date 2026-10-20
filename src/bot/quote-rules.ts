/**
 * Venue order rules for bot quotes (engine executeActions): every limit price is aligned to the
 * market tick in the passive direction (bid DOWN, ask UP — never more aggressive than the
 * strategy asked), every size floored to the lot, and an order under the venue's published
 * minimum size / order value is refused before sending (SIZE_TOO_SMALL).
 *
 * Live 2026-10-12 (Aster SOL, tick 0.01): simple-mm / avellaneda-mm / grid-mm / liquidation-mm /
 * regime-mm / rfq-agent quoted "108.861840" and never placed an order (requireOnTick refusal);
 * engine-mm on Pacifica was refused by the venue ("not a multiple of tick size 0.01").
 */
import { PerpError } from "../errors.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import { adapterNetworkOf } from "../exchanges/adapter-network.js";
import { alignProtectionPrice, floorSize, lotStepOf } from "../exchanges/precision.js";
import { getVenue } from "../exchanges/venue.js";
import { symbolMatch } from "../utils.js";

export interface QuoteRules {
  /** Market tick; null = the venue publishes none on this data path (the adapter itself rounds / validates, e.g. HL). */
  tickSize: string | null;
  stepSize: string;
  minSize: string | null;
  minNotional: string | null;
}

/** The market's tick / lot / minimums (venue public market list + the adapter's lot step). Failed read → throws. */
export async function quoteRulesOf(adapter: ExchangeAdapter, symbol: string): Promise<QuoteRules> {
  const network = adapterNetworkOf(adapter);
  if (network === null) {
    throw new PerpError("EXCHANGE_ERROR", `${adapter.name}: the adapter's network is unknown, so the ${symbol} tick / minimums cannot be read; nothing was sent`, { exchange: adapter.name });
  }
  const [markets, stepSize] = await Promise.all([getVenue(adapter.name).publicData.fetchMarkets(network, { funding: false }), lotStepOf(adapter, symbol)]);
  const vm = markets.find(m => symbolMatch(m.symbol, symbol));
  return { tickSize: vm?.tickSize ?? null, stepSize, minSize: vm?.minSize ?? null, minNotional: vm?.minNotional ?? null };
}

/**
 * A plain decimal for a strategy-computed number (strategies pass toFixed() strings; an exponent
 * form is refused by the decimal helpers).
 */
function plain(v: string, what: string): string {
  if (/^\d+(\.\d+)?$/.test(v)) return v;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new PerpError("INVALID_PARAMS", `${what} ${v} is not a positive number; nothing was sent`);
  return n.toFixed(12).replace(/\.?0+$/, "");
}

/** Limit quote on the venue grid: price aligned passively (buy ↓, sell ↑), size floored to the lot, minimums checked. */
export function prepareLimitQuote(rules: QuoteRules, venue: string, symbol: string, side: "buy" | "sell", price: string, size: string): { price: string; size: string } {
  const px = rules.tickSize === null ? plain(price, "price") : alignProtectionPrice(plain(price, "price"), rules.tickSize, side === "buy" ? "sell" : "buy");
  const sz = floorSize(plain(size, "size"), rules.stepSize);
  requireMinimums(rules, venue, symbol, sz, px);
  return { price: px, size: sz };
}

/**
 * A COMPUTED limit price aligned to the venue's own price grid when the venue publishes no tick
 * (Hyperliquid: 5 significant figures / szDecimals rule, `alignComputedPrice`), passively for
 * `side` (buy ↓, sell ↑). Venues with a tick are already aligned by the callers; returned as is.
 */
export async function alignComputedLimitPrice(adapter: ExchangeAdapter, symbol: string, side: "buy" | "sell", price: string): Promise<string> {
  const a = adapter as ExchangeAdapter & { alignComputedPrice?: (symbol: string, side: "buy" | "sell", price: string) => Promise<string> };
  return typeof a.alignComputedPrice === "function" ? a.alignComputedPrice(symbol, side, price) : price;
}

/** Market order size floored to the lot; the minimum order value is checked against `refPrice` (null = size minimum only). */
export function prepareMarketSize(rules: QuoteRules, venue: string, symbol: string, size: string, refPrice: number | null): string {
  const sz = floorSize(plain(size, "size"), rules.stepSize);
  requireMinimums(rules, venue, symbol, sz, refPrice !== null && refPrice > 0 ? String(refPrice) : null);
  return sz;
}

function requireMinimums(rules: QuoteRules, venue: string, symbol: string, size: string, price: string | null): void {
  if (rules.minSize !== null && Number(size) < Number(rules.minSize)) {
    throw new PerpError("SIZE_TOO_SMALL", `${venue} ${symbol}: size ${size} is below the venue minimum ${rules.minSize}; nothing was sent`, { exchange: venue, minSize: rules.minSize });
  }
  if (price !== null && rules.minNotional !== null && Number(size) * Number(price) < Number(rules.minNotional)) {
    throw new PerpError("SIZE_TOO_SMALL", `${venue} ${symbol}: ${size} @ ${price} = $${(Number(size) * Number(price)).toFixed(2)} is below the venue minimum order value $${rules.minNotional}; nothing was sent`, {
      exchange: venue, minNotional: rules.minNotional, remediation: "Raise the strategy's order size",
    });
  }
}
