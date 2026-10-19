/**
 * Conformance fixtures: trimming + anonymization of RECORDED public responses (docs/TESTING.md §3).
 *
 * Fixtures are never hand-written. scripts/conformance/record.ts records live public mainnet
 * responses through the conformance harness, then this module:
 *  - trims them to a small, real-shaped subset that still drives the real adapter code:
 *      * arrays of market-like objects (an element has a symbol-ish key such as `symbol` / `name` /
 *        `coin`) keep only the elements of the fixture's keep-symbols (BTC, ETH, SOL, …);
 *      * the ids of those kept elements (`market_id`, `index`, `instrument_id`, …) are collected
 *        per venue domain, and id-keyed arrays elsewhere (TxFlow ctxs, Lighter funding rows) keep
 *        the matching elements — so joins between endpoints stay intact;
 *      * a positional array parallel to a trimmed one (same length in the same response —
 *        Hyperliquid `metaAndAssetCtxs` universe ↔ ctxs) keeps the same indices;
 *      * any other long array (book levels, candles, funding history, trades) keeps its first
 *        and last `EDGE` elements (so an out-of-range newest candle survives);
 *      * objects keyed by symbol keep the keep-symbol keys;
 *  - anonymizes them with the scripts/ws-probe approach, reduced to what PUBLIC data carries:
 *      * secret-looking fields (auth / token / signature / hmac / apiKey / secret) are removed;
 *      * trader identities (EVM addresses, account ids under user / maker / taker / account keys)
 *        are remapped to stable dummies (equality between rows preserved);
 *      * transaction hashes are remapped to stable dummies.
 *    Prices, sizes and timestamps of public market data are NOT perturbed: the cross-venue
 *    invariants (price agreement, kline alignment) are checked against them. Private (account)
 *    responses are never recorded by the conformance suite — they go through
 *    scripts/ws-probe/make-fixtures.ts, which also perturbs amounts and shifts timestamps.
 *  - guards the written text: no secret field may remain.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Keys whose string value names a market / instrument. */
const SYMBOL_KEY = /^(symbol|name|coin|s|market|ticker|instrument|instrument_name|instrumentName|asset|assetName|base|baseAsset|base_currency|underlying|pair|displayName|display_name|market_name|marketName|contract|contract_symbol)$/i;
/** Keys whose value is a venue-internal market id that other endpoints join on. */
const ID_KEY = /^(id|index|market_id|marketId|market_index|marketIndex|asset_id|assetId|instrument_id|instrumentId|instrument_hash|contract_id|contractId|symbol_id|pair_id|coin)$/;
const SECRET_KEY = /^(auth|token|authToken|listenKey|signature|sig|hmac|apiKey|api_key|secret|privateKey|private_key)$/i;
const IDENTITY_KEY = /^(users|user|maker|taker|buyer|seller|trader|owner|account|accountId|account_id|account_index|ask_account_id|bid_account_id|maker_account_id|taker_account_id|address|wallet|wallet_address|liquidator|subaccount|sub_account_id)$/i;
const HASH_KEY = /^(hash|tx_hash|txHash|transaction_hash|txn_hash)$/i;

const EDGE = 6;
const MAP_MIN_KEYS = 20;

const SUFFIX = "(?:[-_/. ]?(?:USDT|USDC|USD1|USDE|USDG|USD|KRW|PERP|P))*";
export function symbolMatcher(keep: readonly string[]): (s: string) => boolean {
  const res = keep.map(k => new RegExp(`^(?:[A-Z0-9]+:)?${k.toUpperCase()}${SUFFIX}$`));
  return (s: string) => {
    const u = s.toUpperCase();
    return res.some(r => r.test(u));
  };
}

const isObj = (j: Json): j is { [k: string]: Json } => j !== null && typeof j === "object" && !Array.isArray(j);

function symbolValues(o: { [k: string]: Json }, depth = 0): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    // A numeric string under a symbol-ish key is an id (TxFlow ctx `coin: "12"`), not a symbol.
    if (typeof v === "string" && SYMBOL_KEY.test(k) && !/^\d+$/.test(v)) out.push(v);
    else if (depth === 0 && isObj(v)) out.push(...symbolValues(v, 1));
  }
  return out;
}

function idValues(o: { [k: string]: Json }): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (ID_KEY.test(k) && (typeof v === "number" || typeof v === "string")) out.push(String(v));
  }
  return out;
}

/** Ids of every keep-symbol element in a response (for joins across endpoints of one venue). */
export function collectIds(j: Json, match: (s: string) => boolean, into: Set<string>): void {
  if (Array.isArray(j)) {
    for (const x of j) {
      if (isObj(x) && symbolValues(x).some(match)) for (const id of idValues(x)) into.add(id);
      collectIds(x, match, into);
    }
  } else if (isObj(j)) {
    for (const [k, v] of Object.entries(j)) {
      if (match(k) && isObj(v)) for (const id of idValues(v)) into.add(id);
      collectIds(v, match, into);
    }
  }
}

function edges<T>(xs: T[]): number[] {
  if (xs.length <= 2 * EDGE) return xs.map((_, i) => i);
  return [...Array(EDGE).keys(), ...Array.from({ length: EDGE }, (_, i) => xs.length - EDGE + i)];
}

/** Index selection for one array, or null = not a selective (symbol / id keyed) array. */
function selectiveIndices(xs: Json[], match: (s: string) => boolean, ids: ReadonlySet<string>): number[] | null {
  const objs = xs.filter(isObj);
  if (objs.length === 0) return null;
  const symbolBearing = objs.some(o => symbolValues(o).length > 0);
  if (symbolBearing) {
    const hit = xs.map((x, i) => (isObj(x) && symbolValues(x).some(match) ? i : -1)).filter(i => i >= 0);
    if (hit.length === xs.length) return null; // single-market response (trades / candles of BTC) → edge trim
    return hit.length > 0 ? hit : xs.slice(0, 3).map((_, i) => i);
  }
  const byId = xs.map((x, i) => (isObj(x) && idValues(x).some(v => ids.has(v)) ? i : -1)).filter(i => i >= 0);
  return byId.length > 0 && byId.length < xs.length ? byId : null;
}

/** Trim one response body (see the module comment). */
export function trimResponse(body: Json, keep: readonly string[], ids: ReadonlySet<string>): Json {
  const match = symbolMatcher(keep);
  // Pass 1: selections of selective arrays, by original length (for parallel positional arrays).
  const byLength = new Map<number, number[]>();
  const scan = (j: Json): void => {
    if (Array.isArray(j)) {
      const sel = selectiveIndices(j, match, ids);
      if (sel !== null && !byLength.has(j.length)) byLength.set(j.length, sel);
      j.forEach(scan);
    } else if (isObj(j)) Object.values(j).forEach(scan);
  };
  scan(body);
  const walk = (j: Json): Json => {
    if (Array.isArray(j)) {
      const own = selectiveIndices(j, match, ids);
      const sel = own ?? byLength.get(j.length) ?? edges(j);
      return sel.map(i => walk(j[i]));
    }
    if (isObj(j)) {
      const entries = Object.entries(j);
      const keyed = entries.length >= MAP_MIN_KEYS && entries.some(([k]) => match(k) || ids.has(k));
      const kept = keyed ? entries.filter(([k]) => match(k) || ids.has(k)) : entries;
      return Object.fromEntries(kept.map(([k, v]) => [k, walk(v)]));
    }
    return j;
  };
  return walk(body);
}

/** Stable dummy remapping of public trader identities and tx hashes. */
export class PublicScrubber {
  private map = new Map<string, Json>();
  private next(v: string | number): Json {
    const key = `${typeof v}:${v}`;
    const hit = this.map.get(key);
    if (hit !== undefined) return hit;
    const k = this.map.size + 1;
    let out: Json;
    if (typeof v === "number") out = 900_000 + k;
    else if (/^0x[0-9a-fA-F]{40}$/.test(v)) out = `0x${"0".repeat(32)}${k.toString(16).padStart(8, "0")}`;
    else if (/^0x[0-9a-fA-F]{64}$/.test(v)) out = `0x${"d0".repeat(28)}${k.toString(16).padStart(8, "0")}`;
    else if (/^[0-9]+$/.test(v)) out = String(900_000 + k);
    else out = `dummy-${k}`;
    this.map.set(key, out);
    return out;
  }
  walk(j: Json, key = ""): Json | undefined {
    if (SECRET_KEY.test(key)) return undefined;
    if (Array.isArray(j)) return j.map(x => this.walk(x, key)).filter((x): x is Json => x !== undefined);
    if (isObj(j)) {
      const o: { [k: string]: Json } = {};
      for (const [k, v] of Object.entries(j)) {
        const w = this.walk(v, k);
        if (w !== undefined) o[k] = w;
      }
      return o;
    }
    if (IDENTITY_KEY.test(key) && (typeof j === "string" || typeof j === "number") && j !== "") return this.next(j);
    if (HASH_KEY.test(key) && typeof j === "string" && j !== "") return this.next(j);
    return j;
  }
}

/** Refuse to write a fixture that still carries a secret-looking field. */
export function guardFixtureText(text: string, file: string): void {
  const m = /"(auth|token|authToken|listenKey|signature|hmac|apiKey|api_key|secret|privateKey|private_key)"\s*:/i.exec(text);
  if (m) throw new Error(`refusing to write ${file}: contains secret-looking field "${m[1]}"`);
}

/** Registrable domain (last two labels) — ids are collected per venue domain. */
export function domainOf(url: string): string {
  const host = new URL(url).hostname.split(".");
  return host.slice(-2).join(".");
}
