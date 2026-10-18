/**
 * Options market data — venue-agnostic model (READ-ONLY).
 *
 * An options venue implements `OptionsVenue`; the CLI (`perp options`) and the MCP tools
 * (`get_option_*`) only see these types. The first implementation is Derive
 * (`src/exchanges/derive/options.ts`).
 *
 * Contract (same rules as the perp JSON):
 *  - decimals are strings, passed through as the venue printed them (never re-rounded);
 *  - unknown is `null`, never `0` — an empty book side is `bid: null` / `ask: null`, an IV the venue
 *    could not compute is `null`, greeks are `null` when the venue publishes none;
 *  - every top-level object carries `schema: 1` (bumped on any breaking change of these types).
 *
 * Nothing here places orders or needs a key.
 */

/** Version of the options JSON shapes below. */
export const OPTIONS_SCHEMA = 1 as const;

export type OptionKind = "call" | "put";

/** One side of the top of book. */
export interface OptionBookSide {
  /** Premium per contract, in `quoteCurrency`. */
  price: string;
  /** Contracts available at `price`. */
  size: string;
}

export interface OptionGreeks {
  delta: string;
  gamma: string;
  /** Units as published by the venue (Derive documents none; magnitudes match theta per day, vega per 1 vol point). */
  theta: string;
  vega: string;
  rho: string;
}

export interface OptionIv {
  /** Implied volatility of the mark price (fraction: "0.55" = 55%). */
  mark: string | null;
  /** IV of the best bid; null when there is no bid or the venue could not compute it. */
  bid: string | null;
  /** IV of the best ask; null when there is no ask or the venue could not compute it. */
  ask: string | null;
}

export interface OptionStats24h {
  /** Contracts traded in the last 24 h. */
  contracts: string;
  /** Notional (underlying) volume in `quoteCurrency`. */
  notional: string;
  /** Premium volume in `quoteCurrency`. */
  premium: string;
  trades: number;
  /** null when there were no trades (the venue sends a "0" placeholder). */
  high: string | null;
  low: string | null;
}

/** A single option's quote: instrument facts + live market data. */
export interface OptionQuote {
  schema: typeof OPTIONS_SCHEMA;
  venue: string;
  /** Venue instrument name, e.g. "ETH-20261225-3500-P". */
  instrument: string;
  underlying: string;
  quoteCurrency: string;
  kind: OptionKind;
  strike: string;
  /** Expiry date (UTC, YYYY-MM-DD). */
  expiry: string;
  expiryMs: number;
  bid: OptionBookSide | null;
  ask: OptionBookSide | null;
  mark: string;
  /** Underlying index price. */
  index: string;
  /** Forward price used by the venue's pricer; null when the venue publishes no pricing. */
  forward: string | null;
  discountFactor: string | null;
  iv: OptionIv;
  greeks: OptionGreeks | null;
  /** Open interest in contracts. */
  openInterest: string;
  stats24h: OptionStats24h;
  /** Venue snapshot time (ms epoch). */
  timestampMs: number;
}

export interface OptionExpiry {
  /** UTC date, YYYY-MM-DD (the key for `chain --expiry`). */
  expiry: string;
  expiryMs: number;
  /** Distinct strikes listed for this expiry. */
  strikes: number;
  /** Listed instruments (calls + puts). */
  instruments: number;
}

export interface OptionExpiries {
  schema: typeof OPTIONS_SCHEMA;
  venue: string;
  underlying: string;
  /** Active (tradable) expiries, soonest first. */
  expiries: OptionExpiry[];
}

export interface OptionChainRow {
  strike: string;
  call: OptionQuote | null;
  put: OptionQuote | null;
}

export interface OptionChain {
  schema: typeof OPTIONS_SCHEMA;
  venue: string;
  underlying: string;
  expiry: string;
  expiryMs: number;
  /** "requested" = --expiry; "nearest" = the soonest active expiry (no --expiry given). */
  expirySelection: "requested" | "nearest";
  /** Underlying index of the newest ticker of the expiry (largest timestampMs); null when no ticker was returned. */
  index: string | null;
  /** Forward of the newest ticker of the expiry (one ticker's value, not an average); null when it carried no pricing. */
  forward: string | null;
  /**
   * At-the-money strike: the listed strike closest to `price` — the expiry's forward when the venue
   * publishes one (`reference: "forward"`), the index otherwise. null when neither is known.
   * `--strikes N` keeps the N strikes closest to `price`.
   */
  atm: { strike: string; reference: "forward" | "index"; price: string } | null;
  /** Total strikes listed for the expiry (before --strikes). */
  strikesListed: number;
  /** Rows sorted by strike ascending. */
  rows: OptionChainRow[];
  /** Listed instruments for which the venue returned no ticker (their side is null). */
  missingTickers: string[];
}

export interface OptionUnderlying {
  underlying: string;
  /** Venue spot price of the underlying; null when the venue publishes none. */
  spotPrice: string | null;
}

export interface OptionUnderlyings {
  schema: typeof OPTIONS_SCHEMA;
  venue: string;
  underlyings: OptionUnderlying[];
}

export interface OptionChainQuery {
  underlying: string;
  /** YYYY-MM-DD; null = the nearest active expiry. */
  expiry: string | null;
  /** Keep only the N strikes closest to the ATM reference; null = every strike. */
  strikesAroundAtm: number | null;
}

/** A read-only options venue. Every method throws a PerpError on failure. */
export interface OptionsVenue {
  readonly id: string;
  readonly displayName: string;
  listUnderlyings(): Promise<OptionUnderlyings>;
  listExpiries(underlying: string): Promise<OptionExpiries>;
  getChain(q: OptionChainQuery): Promise<OptionChain>;
  getQuote(instrument: string): Promise<OptionQuote>;
}
