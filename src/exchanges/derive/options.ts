/**
 * Derive options — read-only `OptionsVenue` over the v3 public API (official, no auth).
 *
 * Reads (docs.derive.xyz/openapi.json, shapes checked live 2026-10-18):
 *  - `get_all_currencies` → currencies with an `option` asset (underlyings).
 *  - `get_all_instruments {instrument_type:"option", currency, expired:false, page_size:1000, page}`
 *    → instruments; `option_details {expiry (unix s), strike, option_type "C"|"P"}`. Paginated
 *    (`pagination.num_pages`, page_size ≤ 1000). `is_active:false` = listed for a future activation
 *    (`scheduled_activation`), not tradable and with no ticker — left out of expiries / chains.
 *    An unknown currency is RPC 12001.
 *  - `get_tickers {instrument_type:"option", currency, expiry_date:"YYYYMMDD"}` → `{tickers: {name: TickerSlim}}`;
 *    expiry_date is required for options. ONE call per chain (never one per instrument).
 *  - `get_instrument` + `get_ticker` for a single quote (unknown instrument = RPC 12001).
 *
 * Ticker encoding (live): an empty book side is price "0" / size "0" → `null` side; an IV the
 * pricer could not compute (no quote, or a quote below intrinsic) is "0" → `null`; 24 h high / low
 * are "0" when there were no trades → `null`. Greeks are passed through verbatim (a delta of 0 is real).
 */

import { PerpError } from "../../errors.js";
import type { Network } from "../venue-types.js";
import {
  OPTIONS_SCHEMA,
  type OptionChain, type OptionChainQuery, type OptionChainRow, type OptionExpiries, type OptionExpiry,
  type OptionKind, type OptionQuote, type OptionsVenue, type OptionUnderlyings,
} from "../options-interface.js";
import { DERIVE_INSTRUMENT_NOT_FOUND, DERIVE_INVALID_PARAMS, DeriveClient, deriveRpcCode, deriveShapeError } from "./client.js";

const VENUE = "derive";
const PAGE_SIZE = 1000;

/** One option instrument, as perp-cli uses it. */
export interface DeriveOptionInstrument {
  name: string;
  underlying: string;
  quoteCurrency: string;
  kind: OptionKind;
  strike: string;
  expiryMs: number;
  /** UTC YYYY-MM-DD of the expiry. */
  expiry: string;
  isActive: boolean;
  /** ms epoch of `scheduled_activation`. */
  activationMs: number;
}

// ── field readers (shape drift → EXCHANGE_ERROR, never a guess) ──

type Obj = Record<string, unknown>;

function obj(v: unknown, what: string): Obj {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw deriveShapeError(`${what} is not an object`);
  return v as Obj;
}

function str(o: Obj, key: string, what: string): string {
  const v = o[key];
  if (typeof v !== "string") throw deriveShapeError(`${what}.${key} is not a string`);
  return v;
}

/** A decimal string (checked to parse as a finite number; returned verbatim). */
function dec(o: Obj, key: string, what: string): string {
  const v = str(o, key, what);
  if (v.trim() === "" || !Number.isFinite(Number(v))) throw deriveShapeError(`${what}.${key} is not a decimal ("${v}")`);
  return v;
}

function int(o: Obj, key: string, what: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isInteger(v)) throw deriveShapeError(`${what}.${key} is not an integer`);
  return v;
}

/** Derive's "0" placeholder → null; anything else verbatim. */
function nonZero(v: string): string | null {
  return Number(v) === 0 ? null : v;
}

// ── dates ──

/** ms epoch → UTC YYYY-MM-DD. */
export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** User expiry, exactly "2026-12-25" or "20261225" (not mixed) → YYYY-MM-DD; anything else INVALID_PARAMS. */
export function normalizeExpiry(input: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.trim()) ?? /^(\d{4})(\d{2})(\d{2})$/.exec(input.trim());
  const iso = m !== null ? `${m[1]}-${m[2]}-${m[3]}` : null;
  if (iso === null || Number.isNaN(Date.parse(`${iso}T00:00:00Z`)) || utcDate(Date.parse(`${iso}T00:00:00Z`)) !== iso) {
    throw new PerpError("INVALID_PARAMS", `Invalid expiry "${input}" — expected YYYY-MM-DD (UTC)`, {
      remediation: `List expiries: perp -e ${VENUE} options expiries <UNDERLYING>`,
    });
  }
  return iso;
}

/** User underlying → venue currency (upper case); INVALID_PARAMS for anything that is not a ticker. */
export function normalizeUnderlying(input: string): string {
  const u = input.trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,20}$/.test(u)) {
    throw new PerpError("INVALID_PARAMS", `Invalid underlying "${input}"`, {
      remediation: `List underlyings: perp -e ${VENUE} options underlyings`,
    });
  }
  return u;
}

// ── parsing ──

export function parseDeriveInstrument(raw: unknown): DeriveOptionInstrument {
  const o = obj(raw, "instrument");
  const name = str(o, "instrument_name", "instrument");
  const what = `instrument ${name}`;
  if (str(o, "instrument_type", what) !== "option") throw deriveShapeError(`${what} is not an option`);
  const d = obj(o.option_details, `${what}.option_details`);
  const t = str(d, "option_type", `${what}.option_details`);
  if (t !== "C" && t !== "P") throw deriveShapeError(`${what}.option_details.option_type "${t}" is not C / P`);
  const expiryMs = int(d, "expiry", `${what}.option_details`) * 1000;
  const isActive = o.is_active;
  if (typeof isActive !== "boolean") throw deriveShapeError(`${what}.is_active is not a boolean`);
  return {
    name,
    underlying: str(o, "base_currency", what),
    quoteCurrency: str(o, "quote_currency", what),
    kind: t === "C" ? "call" : "put",
    strike: dec(d, "strike", `${what}.option_details`),
    expiryMs,
    expiry: utcDate(expiryMs),
    isActive,
    activationMs: int(o, "scheduled_activation", what) * 1000,
  };
}

/** A ticker_slim snapshot (get_ticker / get_tickers value) of `inst` → OptionQuote. */
export function parseDeriveOptionTicker(raw: unknown, inst: DeriveOptionInstrument): OptionQuote {
  const what = `ticker ${inst.name}`;
  const t = obj(raw, what);
  const bidPx = dec(t, "b", what), bidSz = dec(t, "B", what);
  const askPx = dec(t, "a", what), askSz = dec(t, "A", what);
  const bid = Number(bidPx) === 0 ? null : { price: bidPx, size: bidSz };
  const ask = Number(askPx) === 0 ? null : { price: askPx, size: askSz };
  const s = obj(t.stats, `${what}.stats`);
  const trades = int(s, "n", `${what}.stats`);
  const pr = t.option_pricing;
  let p: Obj | null = null;
  if (pr !== null && pr !== undefined) p = obj(pr, `${what}.option_pricing`);
  const pw = `${what}.option_pricing`;
  return {
    schema: OPTIONS_SCHEMA,
    venue: VENUE,
    instrument: inst.name,
    underlying: inst.underlying,
    quoteCurrency: inst.quoteCurrency,
    kind: inst.kind,
    strike: inst.strike,
    expiry: inst.expiry,
    expiryMs: inst.expiryMs,
    bid,
    ask,
    mark: dec(t, "M", what),
    index: dec(t, "I", what),
    forward: p === null ? null : dec(p, "f", pw),
    discountFactor: p === null ? null : dec(p, "df", pw),
    iv: {
      mark: p === null ? null : nonZero(dec(p, "i", pw)),
      bid: p === null || bid === null ? null : nonZero(dec(p, "bi", pw)),
      ask: p === null || ask === null ? null : nonZero(dec(p, "ai", pw)),
    },
    greeks: p === null ? null : {
      delta: dec(p, "d", pw), gamma: dec(p, "g", pw), theta: dec(p, "t", pw), vega: dec(p, "v", pw), rho: dec(p, "r", pw),
    },
    openInterest: dec(s, "oi", `${what}.stats`),
    stats24h: {
      contracts: dec(s, "c", `${what}.stats`),
      notional: dec(s, "v", `${what}.stats`),
      premium: dec(s, "pr", `${what}.stats`),
      trades,
      high: trades === 0 ? null : dec(s, "h", `${what}.stats`),
      low: trades === 0 ? null : dec(s, "l", `${what}.stats`),
    },
    timestampMs: int(t, "t", what),
  };
}

/** Distinct active expiries of `instruments`, soonest first. */
export function expiriesOf(instruments: readonly DeriveOptionInstrument[]): OptionExpiry[] {
  const by = new Map<number, { strikes: Set<string>; n: number }>();
  for (const i of instruments) {
    if (!i.isActive) continue;
    const e = by.get(i.expiryMs) ?? { strikes: new Set<string>(), n: 0 };
    e.strikes.add(i.strike);
    e.n++;
    by.set(i.expiryMs, e);
  }
  return [...by.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, e]) => ({ expiry: utcDate(ms), expiryMs: ms, strikes: e.strikes.size, instruments: e.n }));
}

/** The `n` strikes closest to `price` (ties → lower strike), returned ascending. */
export function strikesAround(strikes: readonly string[], price: string, n: number): string[] {
  const p = Number(price);
  const nearest = [...strikes].sort((a, b) => (Math.abs(Number(a) - p) - Math.abs(Number(b) - p)) || (Number(a) - Number(b)));
  return nearest.slice(0, n).sort((a, b) => Number(a) - Number(b));
}

/**
 * Chain for one expiry from its instruments and the `get_tickers` map. Rows come from the listed
 * instruments; a listed instrument without a ticker leaves its side null and is named in
 * `missingTickers`. Index / forward are those of the newest ticker (largest `t`) — one ticker's values,
 * not an average over the expiry.
 */
export function buildChain(
  underlying: string,
  expiry: OptionExpiry,
  selection: OptionChain["expirySelection"],
  instruments: readonly DeriveOptionInstrument[],
  tickersRaw: unknown,
  strikesAroundAtm: number | null,
): OptionChain {
  const tickers = obj(tickersRaw, "get_tickers result.tickers");
  const rowsByStrike = new Map<string, OptionChainRow>();
  const missingTickers: string[] = [];
  let latest: OptionQuote | null = null;
  for (const inst of instruments) {
    const row = rowsByStrike.get(inst.strike) ?? { strike: inst.strike, call: null, put: null };
    rowsByStrike.set(inst.strike, row);
    if (!(inst.name in tickers)) {
      missingTickers.push(inst.name);
      continue;
    }
    const q = parseDeriveOptionTicker(tickers[inst.name], inst);
    row[inst.kind] = q;
    if (latest === null || q.timestampMs > latest.timestampMs) latest = q;
  }
  const strikes = [...rowsByStrike.keys()];
  let atm: OptionChain["atm"] = null;
  if (latest !== null) {
    const reference = latest.forward !== null ? "forward" : "index";
    const price = latest.forward !== null ? latest.forward : latest.index;
    atm = { strike: strikesAround(strikes, price, 1)[0], reference, price };
  }
  let keep = strikes;
  if (strikesAroundAtm !== null) {
    if (atm === null) {
      throw new PerpError("EXCHANGE_ERROR", `Derive returned no ticker for ${underlying} ${expiry.expiry}; the ATM strike for --strikes is unknown`, {
        exchange: VENUE, remediation: `Run without --strikes to see the listed strikes`,
      });
    }
    keep = strikesAround(strikes, atm.price, strikesAroundAtm);
  }
  const rows = keep
    .sort((a, b) => Number(a) - Number(b))
    .map(k => rowsByStrike.get(k) as OptionChainRow);
  return {
    schema: OPTIONS_SCHEMA,
    venue: VENUE,
    underlying,
    expiry: expiry.expiry,
    expiryMs: expiry.expiryMs,
    expirySelection: selection,
    index: latest === null ? null : latest.index,
    forward: latest === null ? null : latest.forward,
    atm,
    strikesListed: strikes.length,
    rows,
    missingTickers: missingTickers.sort(),
  };
}

// ── venue ──

function noOptions(underlying: string): PerpError {
  return new PerpError("SYMBOL_NOT_FOUND", `Derive has no ${underlying} options`, {
    exchange: VENUE, remediation: `List underlyings: perp -e ${VENUE} options underlyings`,
  });
}

export class DeriveOptionsVenue implements OptionsVenue {
  readonly id = VENUE;
  readonly displayName = "Derive";

  constructor(private readonly client: DeriveClient) {}

  static forNetwork(network: Network): DeriveOptionsVenue {
    return new DeriveOptionsVenue(new DeriveClient(network));
  }

  async listUnderlyings(): Promise<OptionUnderlyings> {
    const raw = await this.client.call<unknown>("get_all_currencies", {});
    if (!Array.isArray(raw)) throw deriveShapeError("get_all_currencies result is not a list");
    const underlyings = raw
      .map((c, i) => obj(c, `currency #${i}`))
      .filter(c => c.option !== null && c.option !== undefined)
      .map(c => {
        const what = `currency ${String(c.currency)}`;
        return { underlying: str(c, "currency", what), spotPrice: c.spot_price === null ? null : dec(c, "spot_price", what) };
      })
      .sort((a, b) => a.underlying.localeCompare(b.underlying));
    return { schema: OPTIONS_SCHEMA, venue: VENUE, underlyings };
  }

  /** Every non-expired option instrument of `underlying` (all pages). 12001 → SYMBOL_NOT_FOUND. */
  async instruments(underlying: string): Promise<DeriveOptionInstrument[]> {
    const out: DeriveOptionInstrument[] = [];
    for (let page = 1, pages = 1; page <= pages; page++) {
      let res: unknown;
      try {
        res = await this.client.call<unknown>("get_all_instruments", {
          instrument_type: "option", currency: underlying, expired: false, page_size: PAGE_SIZE, page,
        });
      } catch (e) {
        if (deriveRpcCode(e) === DERIVE_INSTRUMENT_NOT_FOUND) throw noOptions(underlying);
        throw e;
      }
      const r = obj(res, "get_all_instruments result");
      if (!Array.isArray(r.instruments)) throw deriveShapeError("get_all_instruments result.instruments is not a list");
      pages = int(obj(r.pagination, "get_all_instruments result.pagination"), "num_pages", "pagination");
      for (const i of r.instruments) out.push(parseDeriveInstrument(i));
    }
    return out;
  }

  async listExpiries(underlyingInput: string): Promise<OptionExpiries> {
    const underlying = normalizeUnderlying(underlyingInput);
    const expiries = expiriesOf(await this.instruments(underlying));
    if (expiries.length === 0) throw noOptions(underlying);
    return { schema: OPTIONS_SCHEMA, venue: VENUE, underlying, expiries };
  }

  async getChain(q: OptionChainQuery): Promise<OptionChain> {
    const underlying = normalizeUnderlying(q.underlying);
    const wanted = q.expiry === null ? null : normalizeExpiry(q.expiry);
    if (q.strikesAroundAtm !== null && (!Number.isInteger(q.strikesAroundAtm) || q.strikesAroundAtm < 1)) {
      throw new PerpError("INVALID_PARAMS", `--strikes must be a positive integer (got ${q.strikesAroundAtm})`, {
        remediation: "Pass a positive integer, e.g. --strikes 10",
      });
    }
    const all = await this.instruments(underlying);
    const expiries = expiriesOf(all);
    if (expiries.length === 0) throw noOptions(underlying);
    const expiry = wanted === null ? expiries[0] : expiries.find(e => e.expiry === wanted);
    if (expiry === undefined) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Derive has no active ${underlying} option expiry ${wanted}`, {
        exchange: VENUE,
        remediation: `Active expiries: ${expiries.map(e => e.expiry).join(", ")} (perp -e ${VENUE} options expiries ${underlying})`,
      });
    }
    const listed = all.filter(i => i.isActive && i.expiryMs === expiry.expiryMs);
    const res = obj(await this.client.call<unknown>("get_tickers", {
      instrument_type: "option", currency: underlying, expiry_date: expiry.expiry.replace(/-/g, ""),
    }), "get_tickers result");
    return buildChain(underlying, expiry, wanted === null ? "nearest" : "requested", listed, res.tickers, q.strikesAroundAtm);
  }

  async getQuote(instrumentInput: string): Promise<OptionQuote> {
    const name = instrumentInput.trim().toUpperCase();
    // Both reads are needed (instrument facts + live ticker); issued together, judged instrument first.
    const [instR, tickR] = await Promise.allSettled([
      this.client.call<unknown>("get_instrument", { instrument_name: name }),
      this.client.call<unknown>("get_ticker", { instrument_name: name }),
    ]);
    if (instR.status === "rejected") {
      if (deriveRpcCode(instR.reason) === DERIVE_INSTRUMENT_NOT_FOUND) {
        throw new PerpError("SYMBOL_NOT_FOUND", `Derive has no instrument ${name}`, {
          exchange: VENUE, remediation: `Find option names: perp -e ${VENUE} options chain <UNDERLYING>`,
        });
      }
      throw instR.reason;
    }
    const o = obj(instR.value, "get_instrument result");
    if (o.instrument_type !== "option") {
      throw new PerpError("INVALID_PARAMS", `${name} is a Derive ${String(o.instrument_type)}, not an option`, {
        exchange: VENUE, remediation: `Find option names: perp -e ${VENUE} options chain <UNDERLYING>`,
      });
    }
    const inst = parseDeriveInstrument(o);
    if (!inst.isActive) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Derive option ${name} is listed but not active (activation ${new Date(inst.activationMs).toISOString()})`, {
        exchange: VENUE, remediation: `Active expiries: perp -e ${VENUE} options expiries ${inst.underlying}`,
      });
    }
    if (tickR.status === "rejected") {
      // An active instrument with no ticker (-32602 "Ticker not found for instrument", live): an
      // activation / expiry race on Derive's side — transient, never the user's INVALID_PARAMS.
      if (deriveRpcCode(tickR.reason) === DERIVE_INVALID_PARAMS) {
        throw new PerpError("EXCHANGE_ERROR", `Derive has no live ticker for active option ${name} (${tickR.reason instanceof Error ? tickR.reason.message : String(tickR.reason)})`, {
          exchange: VENUE, rpcCode: DERIVE_INVALID_PARAMS,
          remediation: `The option may be activating or expiring right now; retry in a moment, or list live instruments: perp -e ${VENUE} options chain ${inst.underlying} --expiry ${inst.expiry}`,
        });
      }
      throw tickR.reason;
    }
    return parseDeriveOptionTicker(tickR.value, inst);
  }
}
