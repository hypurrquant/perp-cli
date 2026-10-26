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
 *      * trader identities (EVM addresses, account ids under user / maker / taker / account keys,
 *        and the suffixed spellings of those — `makerAddress`, `owner_account_index`,
 *        `ask_account_id`, `takerOrderId`) are remapped to stable dummies (equality between rows
 *        preserved). A public tape's own row ids (`tid`, `ask_id`) are not — see the criterion
 *        stated at `SIDE_ACCOUNT_ID` below;
 *      * transaction hashes are remapped to stable dummies.
 *    Prices, sizes and timestamps of public market data are NOT perturbed: the cross-venue
 *    invariants (price agreement, kline alignment) are checked against them. Private (account)
 *    responses are never recorded by the conformance suite — they go through
 *    scripts/ws-probe/make-fixtures.ts, which also perturbs amounts and shifts timestamps.
 *  - guards the written fixture: no secret field may remain (`guardFixtureText`), and no real
 *    trader identity may remain outside the classified fields — neither a wallet address nor a
 *    numeric account id (`guardFixtureIdentities`).
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** Keys whose string value names a market / instrument. */
const SYMBOL_KEY = /^(symbol|name|coin|s|market|ticker|instrument|instrument_name|instrumentName|asset|assetName|base|baseAsset|base_currency|underlying|pair|displayName|display_name|market_name|marketName|contract|contract_symbol)$/i;
/** Keys whose value is a venue-internal market id that other endpoints join on. */
const ID_KEY = /^(id|index|market_id|marketId|market_index|marketIndex|asset_id|assetId|instrument_id|instrumentId|instrument_hash|contract_id|contractId|symbol_id|pair_id|coin)$/;
const SECRET_KEY = /^(auth|token|authToken|listenKey|signature|sig|hmac|apiKey|api_key|secret|privateKey|private_key)$/i;

/**
 * A trader identity is named either by a bare party word (`user`, `maker`, `account`) or by a
 * party word carrying an identifier suffix (`makerAddress`, `owner_account_index`,
 * `sub_account_id_str`, `takerOrderId`). Listing only the bare words is what let 7 real Arcus
 * counterparty addresses reach `arcus.json`: the venue sends `makerAddress`, and `/^maker$/`
 * does not match it (HIK-10). Both families are matched now, so a venue that spells the same
 * thing differently cannot slip through again.
 */
const PARTY = "users?|maker|taker|buyer|seller|trader|owner|account|wallet|address|liquidator|sub_?account|counterparty|sender|receiver|recipient";
const ID_SUFFIX = "address|wallet|id|ids|index|indices|key|account|account_?id|account_?index|order_?id";
const BARE_PARTY = /^(users?|maker|taker|buyer|seller|trader|owner|account|wallet|address|liquidator|sub_?account)$/i;
const PARTY_ID = new RegExp(`^(?:${PARTY})[_-]?(?:${ID_SUFFIX})(?:[_-]?str)?$`, "i");
/**
 * Side-named account ids. `ask` / `bid` are NOT party words (they are price levels), so the
 * `PARTY` families above miss `ask_account_id` — which still names an account, hence this entry.
 *
 * The criterion for the whole scrubber, since the lines above cut across it: **a field is
 * remapped when its value names a party** (a wallet, or an account the venue assigns to one).
 * A public tape's own row ids — `tid`, `trade_id`, `ask_id` / `bid_id`, `ask_client_id` — are
 * NOT remapped: they name the trade or the order, not the person behind it, and the venue
 * publishes them to everyone.
 *
 * Two consequences worth stating plainly, so the next reader does not mistake this for more
 * than it is:
 *  - `makerOrderId` / `takerOrderId` ARE remapped, which looks inconsistent with `ask_id`. It is
 *    a naming artifact: those keys begin with a party word, so `PARTY_ID` catches them. Harmless
 *    either way (an order id identifies nobody on its own), so it is left as the regex falls.
 *  - None of this is an unlinkability guarantee. The market-data columns (`coin`, `px`, `sz`,
 *    `time`) are preserved ON PURPOSE — the cross-venue invariants are checked against them —
 *    and they already pin the row on the venue's public tape. What anonymization buys is that
 *    the repo does not itself publish a list of third-party wallets; it does not, and cannot,
 *    make a recorded public trade unfindable.
 */
const SIDE_ACCOUNT_ID = /^(ask|bid)_account_id$/i;
const isIdentityKey = (k: string): boolean => BARE_PARTY.test(k) || PARTY_ID.test(k) || SIDE_ACCOUNT_ID.test(k);

/**
 * Keys whose value is a party's venue-assigned ACCOUNT NUMBER (Lighter's `owner_account_index`,
 * Arcus's `accountIndex`). These need their own family because the value-shape test that finds a
 * leaked wallet (`ADDRESS_SHAPED`) is blind to them: any integer could be a price, a sequence
 * number or a timestamp, so there is no shape to match. The only workable test is the KEY.
 *
 * It is therefore deliberately WIDER than `isIdentityKey`: `operator_account_index` and
 * `insurance_fund_account_index` match here and are then excused by `PUBLIC_ACCOUNT_KEY` below.
 * A venue-owned account stays readable because it is listed, not because a regex happened to miss
 * it — which is the mistake that let `makerAddress` through in the first place (HIK-10).
 */
const ACCOUNT_WORD = /(users?|owner|trader|maker|taker|buyer|seller|wallet|account|liquidator|counterparty|sender|receiver|recipient)/i;
const ACCOUNT_NUMBER_SUFFIX = /(index|indices|id|ids|no|num|number)$/i;
const isAccountNumberKey = (k: string): boolean => ACCOUNT_WORD.test(k) && ACCOUNT_NUMBER_SUFFIX.test(k);
/**
 * Account numbers the VENUE owns and publishes to everyone in its market config: the matching
 * engine operator, the insurance fund, and the fee collectors of a registered integrator. They
 * name no trader, and the CLI prints market config, so they stay readable. A venue-owned account
 * under a new key name is a failure until it is added here.
 */
const PUBLIC_ACCOUNT_KEY = /^(operator_account_index|insurance_fund_account_index|integrator_(?:maker|taker)_fee_collector_index)$/i;
/**
 * `PublicScrubber.next` maps a numeric identity to `900_000 + k`, with k counting from 1 within
 * one fixture (the widest, conformance/cross.json, reaches k ≈ 34_000). That band is the dummy
 * space for account numbers.
 *
 * Unlike a wallet dummy, this is a BAND test and not a shape guarantee, so state its one blind
 * spot plainly (docs/TESTING.md §7.3 repeats it): a real venue account index that falls inside
 * (900_000, 1_000_000) would be read here as a dummy. Lighter hands out six-digit indices — the
 * highest real one in any committed fixture was 762_067 — so the band sits above the live space
 * today, and it has to move before the venue's space grows into it.
 */
const isDummyAccountId = (n: number): boolean => Number.isInteger(n) && n > 900_000 && n < 1_000_000;
/**
 * Numeric account placeholders written by the OTHER recorder and by the protocol itself, so the
 * tree-wide sweep does not read the `ws/**` fixtures as leaks:
 *  - `scripts/ws-probe/make-fixtures.ts:25-26` substitutes the real Lighter account indices with
 *    1_000_001 / 1_000_002;
 *  - Arcus subscribes by address and `accountIndex` defaults to 0 for every address
 *    (`make-fixtures.ts:335` writes the literal), so 0 names nobody.
 * As with `PLACEHOLDER_ADDRESS`, these are NOT accepted by `guardFixtureIdentities`: a conformance
 * recording has to produce scrubber-shaped dummies.
 */
const PLACEHOLDER_ACCOUNT_IDS: ReadonlySet<number> = new Set([0, 1_000_001, 1_000_002]);

const HASH_KEY = /^(hash|tx_hash|txHash|transaction_hash|txn_hash)$/i;

const ADDRESS_SHAPED = /^0x[0-9a-fA-F]{40}$/;
const DUMMY_ADDRESS = /^0x0{32}[0-9a-f]{8}$/;
/**
 * The hand-picked placeholder wallets of the OTHER fixture recorder,
 * `scripts/ws-probe/make-fixtures.ts:22-23` (`evm` / `evmOther`): the burn address and `…bEEF`.
 * They are not `DUMMY_ADDRESS` (that shape is this scrubber's own output), but they name no
 * person either, so the tree-wide sweep in `fixture-anonymization.test.ts` must not read the
 * `ws/**` fixtures as leaks. Deliberately NOT accepted by `guardFixtureIdentities`: a conformance
 * recording has to produce scrubber-shaped dummies, and a burn address appearing in one would
 * mean the venue sent it, which is worth a failure.
 */
const PLACEHOLDER_ADDRESS = /^0x0{36}(?:dEaD|bEEF)$/;
/**
 * Address-shaped values that identify no person and must stay readable: token / market contracts
 * and the publicly advertised operators of a venue (HIP-3 dex deployers, the CLI prints them).
 * Every other address-shaped value has to be an anonymized identity — `guardFixtureIdentities`
 * refuses the write otherwise, so a new venue field is a loud failure, not a silent leak.
 */
const PUBLIC_ADDRESS_KEY = /^(quote|base|collateral|contractAddress|contract_address|baseAssetAddress|base_asset_address|quoteAssetAddress|quote_asset_address|tokenAddress|token_address|marketAddress|vaultAddress|deployer|subDeployers|market_deployer|feeRecipient|oracleUpdater|syntheticId)$/i;

const EDGE = 6;
const MAP_MIN_KEYS = 20;

const SUFFIX = "(?:[-_/ ]?(?:USDT|USDC|USD1|USDE|USDG|USD|KRW|PERP)|\\.P)*";
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
    if (isIdentityKey(key) && (typeof j === "string" || typeof j === "number") && j !== "") return this.next(j);
    if (HASH_KEY.test(key) && typeof j === "string" && j !== "") return this.next(j);
    return j;
  }
}

/** Refuse to write a fixture that still carries a secret-looking field. */
export function guardFixtureText(text: string, file: string): void {
  const m = /"(auth|token|authToken|listenKey|signature|hmac|apiKey|api_key|secret|privateKey|private_key)"\s*:/i.exec(text);
  if (m) throw new Error(`refusing to write ${file}: contains secret-looking field "${m[1]}"`);
}

/** True for a key the scrubber remaps to a dummy (a trader / account identity). */
export const isTraderIdentityKey = isIdentityKey;
/** True for an address-shaped field that is a protocol constant, not a person. */
export const isPublicAddressKey = (k: string): boolean => PUBLIC_ADDRESS_KEY.test(k);
/** True for a value the scrubber already replaced with a dummy address. */
export const isDummyAddress = (v: string): boolean => DUMMY_ADDRESS.test(v);
/** True for a placeholder wallet written by scripts/ws-probe/make-fixtures.ts (see above). */
export const isPlaceholderAddress = (v: string): boolean => PLACEHOLDER_ADDRESS.test(v);
/** True for a wallet-address-shaped string. */
export const isAddressShaped = (v: string): boolean => ADDRESS_SHAPED.test(v);
/** True for a key whose value is a party's numeric account id (see `ACCOUNT_WORD`). */
export const isAccountIdKey = isAccountNumberKey;
/** True for a numeric account id the venue owns and publishes (operator, insurance fund, …). */
export const isPublicAccountKey = (k: string): boolean => PUBLIC_ACCOUNT_KEY.test(k);
/** True for a numeric account id already inside the scrubber's dummy band (see above). */
export const isDummyAccountNumber = isDummyAccountId;
/** True for a numeric account placeholder of scripts/ws-probe/make-fixtures.ts (see above). */
export const isPlaceholderAccountNumber = (n: number): boolean => PLACEHOLDER_ACCOUNT_IDS.has(n);

/**
 * Refuse to write a fixture that still carries a real trader identity. Unlike `guardFixtureText`
 * this is key-aware, and it checks both kinds of identity a public response carries:
 *  - a wallet-shaped string survives only under a `PUBLIC_ADDRESS_KEY` (token contract, dex
 *    deployer);
 *  - an integer under an `isAccountNumberKey` key survives only inside the scrubber's dummy band
 *    or under a `PUBLIC_ACCOUNT_KEY` (the venue's own operator / insurance / integrator accounts).
 * Anything else means the recording met a venue field the scrubber does not classify yet, and the
 * fixture must not be committed until it is classified.
 */
export function guardFixtureIdentities(body: Json, file: string): void {
  const refuse = (key: string, what: string, how: string): never => {
    throw new Error(
      `refusing to write ${file}: "${key}" still holds ${what}. ` +
      `Classify it in src/__tests__/conformance/fixture-tools.ts — ${how}`,
    );
  };
  const walk = (j: Json, key: string): void => {
    if (Array.isArray(j)) { for (const x of j) walk(x, key); return; }
    if (isObj(j)) { for (const [k, v] of Object.entries(j)) walk(v, k); return; }
    if (typeof j === "number") {
      if (!isAccountNumberKey(key) || isDummyAccountId(j) || PUBLIC_ACCOUNT_KEY.test(key)) return;
      refuse(key, "a real-looking account number", "PARTY/ID_SUFFIX if it names a trader, PUBLIC_ACCOUNT_KEY if the venue owns it.");
    }
    if (typeof j !== "string" || !ADDRESS_SHAPED.test(j) || DUMMY_ADDRESS.test(j)) return;
    if (PUBLIC_ADDRESS_KEY.test(key)) return;
    refuse(key, "a real-looking wallet address", "PARTY/ID_SUFFIX if it names a trader, PUBLIC_ADDRESS_KEY if it is a protocol constant.");
  };
  walk(body, "");
}

/** Registrable domain (last two labels) — ids are collected per venue domain. */
export function domainOf(url: string): string {
  const host = new URL(url).hostname.split(".");
  return host.slice(-2).join(".");
}
