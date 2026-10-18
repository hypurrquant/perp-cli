/**
 * Spot adapter factory — the only place spot adapters are created.
 *
 * - `getSpotAdapter` returns null iff the venue has no spot (`def.spot === null`).
 *   Creation / init / network errors propagate (SSOT Rule #2 — no catch).
 * - `createSpot` (venue definition) constructs and init()s the adapter.
 * - Cached per perp adapter instance (each instance is bound to one venue + network,
 *   so the key is the adapter's own network, not the process-wide one) and per
 *   on-chain-approve option. Read-only and signed perp adapters keep separate entries.
 *
 * Bot scope: bots only trade spot on venues where `isBotSpotVenue(def)`.
 * Quote/base detection goes through `def.spot.quoteAssets`.
 */

import { classifyError, extractErrorMessage, PerpError } from "../errors.js";
import { unsupported } from "./trading-v2.js";
import { sharedApiNetwork } from "../api/public/urls.js";
import { canonicalFor, isNeverMatch } from "./canonical-symbols.js";
import { floorSize } from "./precision.js";
import type { AssetClass, Network, VenueId, VenueMarket } from "./venue-types.js";
import type { ExchangeAdapter } from "./interface.js";
import { isSpotFreshBalancesCapable, isSpotHoldingPricesCapable, isSpotPricesCapable, isSpotTransferCapable, MAX_PRICE_DEVIATION_PCT, type SpotAdapter, type SpotBalance, type SpotMarketInfo } from "./spot-interface.js";
import { getVenue, listVenues, tryResolveVenueId, type SpotCreateOptions, type VenueDefinition, type VenueSpotDefinition } from "./venue.js";
import "./venues/index.js";


/** Options for every non-CLI caller: on-chain approve txs are never sent implicitly. */
export const NO_ONCHAIN_APPROVE: SpotCreateOptions = { confirmOnchainApprove: false };

/** perp adapter → `${venueId}:${confirmOnchainApprove}` → spot adapter. */
const _cache = new WeakMap<ExchangeAdapter, Map<string, Promise<SpotAdapter>>>();
/**
 * spot adapter → (venue, perp adapter, network) it was created for; used by the transfer /
 * quote helpers. `net` is the process's selected network (sharedApiNetwork — the -n the perp
 * adapter was created with) and decides the spot quote (spotQuoteAssets).
 */
const _owner = new WeakMap<SpotAdapter, { def: VenueDefinition & { spot: VenueSpotDefinition }; perp: ExchangeAdapter; net: Network }>();

function hasSpot(def: VenueDefinition): def is VenueDefinition & { spot: VenueSpotDefinition } {
  return def.spot !== null;
}

/** Venues with spot support, for remediation text. */
export function listSpotVenues(): VenueDefinition[] {
  return listVenues().filter(hasSpot);
}

/**
 * Get (or create + init) the spot adapter for a venue. null iff the venue has no spot.
 * `opts` defaults to NO_ONCHAIN_APPROVE (the safe deny); only the CLI passes --yes.
 */
export async function getSpotAdapter(venue: string, perp: ExchangeAdapter, opts: SpotCreateOptions = NO_ONCHAIN_APPROVE): Promise<SpotAdapter | null> {
  const def = getVenue(venue);
  if (!hasSpot(def)) return null;
  let perPerp = _cache.get(perp);
  if (perPerp === undefined) {
    perPerp = new Map();
    _cache.set(perp, perPerp);
  }
  const key = `${def.id}:${opts.confirmOnchainApprove}`;
  const hit = perPerp.get(key);
  if (hit !== undefined) return hit;
  const net = sharedApiNetwork();
  const spot = def.spot.createSpot(perp, opts).then(s => {
    _owner.set(s, { def, perp, net });
    return s;
  });
  perPerp.set(key, spot);
  try {
    return await spot;
  } catch (e) {
    // Do not cache a failed creation; the error itself propagates.
    if (perPerp.get(key) === spot) perPerp.delete(key);
    throw e;
  }
}

/** The venue's spot definition, or CAPABILITY_UNSUPPORTED. */
export function requireSpotDefinition(def: VenueDefinition): VenueSpotDefinition {
  if (!hasSpot(def)) {
    throw unsupported(def.displayName, "spot", "the venue has no spot trading", `Spot venues: ${listSpotVenues().map(v => v.id).join(", ")}`);
  }
  return def.spot;
}

/** CLI form: throws CAPABILITY_UNSUPPORTED when the venue has no spot. */
export async function requireSpotAdapter(venue: string, perp: ExchangeAdapter, opts: SpotCreateOptions = NO_ONCHAIN_APPROVE): Promise<SpotAdapter> {
  requireSpotDefinition(getVenue(venue));
  const spot = await getSpotAdapter(venue, perp, opts);
  if (spot === null) throw new Error(`unreachable: ${venue} spot definition present but no adapter`);
  return spot;
}

// ── Bot scope ──

/**
 * Bots (funding-arb*, spot-perp-*, arb-auto, arb/index) only use spot venues with a
 * separate (or runtime-decided) spot balance and a spot↔perp transfer. Pacifica
 * (shared margin) and Arcus (on-chain swap) are excluded.
 */
export function isBotSpotVenue(def: VenueDefinition): boolean {
  return def.spot !== null
    && (def.spot.accountModel === "separate" || def.spot.accountModel === "runtime")
    && def.spot.capabilities.transfer;
}

export function listBotSpotVenues(): VenueDefinition[] {
  return listVenues().filter(isBotSpotVenue);
}

/** Bot form: throws CAPABILITY_UNSUPPORTED for venues outside the bot spot scope. */
export function requireBotSpotVenue(venue: string): VenueDefinition & { spot: VenueSpotDefinition } {
  const def = getVenue(venue);
  if (!hasSpot(def) || !isBotSpotVenue(def)) {
    throw unsupported(def.displayName, "botSpot", "bots/arb need a separate spot balance with spot↔perp transfer",
      `Bot spot venues: ${listBotSpotVenues().map(v => v.id).join(", ")}. Trade ${def.id} spot manually: perp -e ${def.id} trade spot-buy ...`);
  }
  return def;
}

/**
 * Bot spot adapter for an adapter-map name. null when the name is not a venue, or the
 * venue is outside the bot spot scope. Creation errors propagate.
 */
export async function getBotSpotAdapter(name: string, perp: ExchangeAdapter): Promise<SpotAdapter | null> {
  const id = tryResolveVenueId(name);
  if (id === null || !isBotSpotVenue(getVenue(id))) return null;
  return getSpotAdapter(id, perp);
}

// ── Quote / base helpers ──

/** Upper-cased token with venue balance suffixes removed ("USDC_SPOT" / "PURR-SPOT" → base). */
export function spotTokenBase(token: string): string {
  return token.toUpperCase().replace(/[-_]SPOT$/, "");
}

/** The venue's spot quote assets on `net` (network-keyed: Lighter RH quotes USDG on mainnet, USDC on testnet). */
export function spotQuoteAssets(def: VenueDefinition, net: Network): readonly string[] {
  return requireSpotDefinition(def).quoteAssets[net];
}

/** Default quote on `net` (bare-base symbols, transfers). */
export function defaultSpotQuote(def: VenueDefinition, net: Network): string {
  const quote = spotQuoteAssets(def, net)[0];
  if (quote === undefined) throw new Error(`${def.id} spot definition has no ${net} quoteAssets`);
  return quote;
}

/** The network a spot adapter was created for (getSpotAdapter). */
export function spotNetworkOf(spot: SpotAdapter): Network {
  return ownerOf(spot).net;
}

export function isSpotQuoteAsset(def: VenueDefinition, net: Network, token: string): boolean {
  return spotQuoteAssets(def, net).includes(spotTokenBase(token));
}

/** "BASE/QUOTE" for a bare base on this venue (quoteAssets[net][0]). */
export function spotPairSymbol(def: VenueDefinition, net: Network, base: string): string {
  return `${base.toUpperCase()}/${defaultSpotQuote(def, net)}`;
}

/** The balance row of the venue's default quote asset (transfer asset), or null. */
export function findSpotQuoteBalance(def: VenueDefinition, net: Network, balances: readonly SpotBalance[]): SpotBalance | null {
  const quote = defaultSpotQuote(def, net);
  return balances.find(b => spotTokenBase(b.token) === quote) ?? null;
}

/** Non-quote balances with a positive total (the "holdings" side of spot-perp hedges). */
export function nonQuoteSpotBalances(def: VenueDefinition, net: Network, balances: readonly SpotBalance[]): SpotBalance[] {
  return balances.filter(b => Number(b.total) > 0 && !isSpotQuoteAsset(def, net, b.token));
}

/**
 * true when spot quote balance is the same money as perp margin for this perp
 * adapter: accountModel "unified", or "runtime" with a unified perp account (HL).
 */
export function spotSharesPerpMargin(def: VenueDefinition, perp: ExchangeAdapter): boolean {
  const spot = requireSpotDefinition(def);
  if (spot.accountModel === "unified") return true;
  if (spot.accountModel === "runtime") return perp.isUnifiedAccount === true;
  return false;
}

export interface ValuedSpotBalance extends SpotBalance {
  valueUsd: number;
}

/**
 * USD value of positive spot balances. Quote assets (stablecoins) are 1:1; other
 * tokens use the venue's spot mark price. Tokens without a usable price are
 * EXCLUDED and reported via `warn` — never valued at 0 (SSOT Rule #2).
 * `shared` is carried through so aggregators can skip money already in perp equity.
 */
export function valueSpotBalances(
  def: VenueDefinition,
  net: Network,
  balances: readonly SpotBalance[],
  markets: readonly SpotValuationPrice[],
  warn: (msg: string) => void,
): ValuedSpotBalance[] {
  // markPrice null = no usable price (SpotMarketInfo) → the token is excluded below.
  const prices = new Map(markets.flatMap(m => (m.markPrice === null ? [] : [[m.baseToken.toUpperCase(), Number(m.markPrice)] as const])));
  const out: ValuedSpotBalance[] = [];
  for (const b of balances) {
    const total = Number(b.total);
    if (!(total > 0)) continue;
    if (isSpotQuoteAsset(def, net, b.token)) {
      out.push({ ...b, valueUsd: total });
      continue;
    }
    const px = prices.get(spotTokenBase(b.token));
    if (px === undefined || !Number.isFinite(px) || px <= 0) {
      warn(`${def.displayName} spot ${b.token}: no market price — excluded from value totals`);
      continue;
    }
    out.push({ ...b, valueUsd: px * total });
  }
  return out;
}

/** Timeout for one venue's spot valuation (balances + prices) in aggregate views (portfolio, landing). */
export const SPOT_VALUATION_TIMEOUT_MS = 5_000;

/** The price fields valuation reads (a spot market, or a held token's price — SpotHoldingPrice). */
export type SpotValuationPrice = Pick<SpotMarketInfo, "baseToken" | "markPrice">;

/**
 * Prices used to value `balances`. Wallet-model venues (Arcus) price only the held
 * non-quote tokens (`getSpotPrices`); exchange venues use `getSpotMarkets()`, plus — when the
 * adapter is SpotHoldingPricesCapable — `getHoldingPrices()` for held tokens that are not a spot
 * market (Hyperliquid HIP-4 outcome tokens). A holding price counts only when it is quoted in one of
 * the venue's spot quote assets (valued 1:1 like the quote balance); any other quote (or an unknown
 * one) → markPrice null → the token stays unpriced (never 0).
 */
export async function spotMarketsForValuation(def: VenueDefinition, spot: SpotAdapter, balances: readonly SpotBalance[], net: Network): Promise<SpotValuationPrice[]> {
  if (requireSpotDefinition(def).accountModel !== "wallet") {
    const markets = await spot.getSpotMarkets();
    if (!isSpotHoldingPricesCapable(spot)) return markets;
    const listed = new Set(markets.map(m => m.baseToken.toUpperCase()));
    const unlisted = nonQuoteSpotBalances(def, net, balances).map(b => spotTokenBase(b.token)).filter(t => !listed.has(t));
    if (unlisted.length === 0) return markets;
    const quotes = spotQuoteAssets(def, net);
    const held = (await spot.getHoldingPrices(unlisted)).map(p => ({
      baseToken: p.token,
      markPrice: p.quoteToken !== null && quotes.includes(p.quoteToken.toUpperCase()) ? p.markPrice : null,
    }));
    return [...markets, ...held];
  }
  if (!isSpotPricesCapable(spot)) {
    throw new Error(`${def.id} is a wallet-model spot venue but its adapter has no getSpotPrices()`);
  }
  const held = nonQuoteSpotBalances(def, net, balances).map(b => spotTokenBase(b.token));
  return held.length === 0 ? [] : spot.getSpotPrices(held);
}

/**
 * Balances + valuation for aggregate views, bounded by `timeoutMs` (rejects with a
 * TIMEOUT error; the caller reports it — never a partial or zero value).
 */
export async function fetchValuedSpotBalances(
  def: VenueDefinition,
  spot: SpotAdapter,
  warn: (msg: string) => void,
  timeoutMs: number = SPOT_VALUATION_TIMEOUT_MS,
): Promise<ValuedSpotBalance[]> {
  return withSpotTimeout((async () => {
    const net = spotNetworkOf(spot);
    const balances = await spot.getSpotBalances();
    const markets = await spotMarketsForValuation(def, spot, balances, net);
    return valueSpotBalances(def, net, balances, markets, warn);
  })(), `${def.displayName} spot valuation`, timeoutMs);
}

/** Reject with TIMEOUT after `timeoutMs` (the timer is cleared either way). */
export async function withSpotTimeout<T>(p: Promise<T>, what: string, timeoutMs: number = SPOT_VALUATION_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new PerpError("TIMEOUT", `${what} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Transfers ──

function ownerOf(spot: SpotAdapter): { def: VenueDefinition & { spot: VenueSpotDefinition }; perp: ExchangeAdapter; net: Network } {
  const o = _owner.get(spot);
  if (!o) throw new Error(`spot adapter "${spot.name}" was not created by getSpotAdapter()`);
  return o;
}

async function transferQuote(spot: SpotAdapter, amount: number, to: "spot" | "perp"): Promise<boolean> {
  const { def, perp, net } = ownerOf(spot);
  if (spotSharesPerpMargin(def, perp)) return false;
  if (!def.spot.capabilities.transfer || !isSpotTransferCapable(spot)) {
    throw unsupported(def.displayName, "spotTransfer", `spot account model is "${def.spot.accountModel}"`, `${def.id}: fund spot directly`);
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PerpError("INVALID_PARAMS", `Transfer amount must be positive (got ${amount})`);
  }
  const asset = defaultSpotQuote(def, net);
  const wire = transferAmountString(amount);
  if (to === "spot") await spot.transferToSpot(wire, asset);
  else await spot.transferToPerp(wire, asset);
  return true;
}

/** Quote-asset transfer grid (USDC / USDT / USDG are 6-decimal tokens). */
const TRANSFER_STEP = "0.000001";

/**
 * Fixed-point decimal string for a transfer amount, floored to TRANSFER_STEP — never
 * `String(n)` (exponent "1e-7" or float artefacts "0.30000000000000004").
 */
export function transferAmountString(amount: number): string {
  // toFixed(12) is plain decimal for any amount below 1e21; floorSize re-checks the form.
  return floorSize(amount.toFixed(12), TRANSFER_STEP);
}

/**
 * Move the venue's quote asset (quoteAssets[0]) perp → spot.
 * Returns false (no-op, nothing moved) when spot and perp share margin; throws
 * CAPABILITY_UNSUPPORTED when the venue has no transfer. Callers log "Transferred" only on true.
 */
export function transferQuoteToSpot(spot: SpotAdapter, amount: number): Promise<boolean> {
  return transferQuote(spot, amount, "spot");
}

/**
 * A spot↔perp transfer the venue refused for lack of funds (classifyError → INSUFFICIENT_BALANCE,
 * e.g. HL "Insufficient balance for withdrawal.") → INSUFFICIENT_BALANCE that says how much the
 * SOURCE side can move OF THE TRANSFER ASSET (`readAvailable`: perp withdrawable for to-spot, spot
 * quote available for to-perp) — never an account-wide equity figure: a multi-asset margin
 * account can hold margin and none of the asset. A failed read is reported as such (never a
 * guessed figure). Any other error → unchanged.
 */
export async function transferShortfallError(
  e: unknown, opts: { venue: string; direction: "to-spot" | "to-perp"; amount: string; asset: string; readAvailable: () => Promise<number> },
): Promise<unknown> {
  if (classifyError(e).code !== "INSUFFICIENT_BALANCE") return e;
  const source = opts.direction === "to-spot" ? "perp" : "spot";
  const from = opts.direction === "to-spot" ? "perp withdrawable" : "spot available";
  let have: string;
  let available: string | null = null;
  try {
    const n = await opts.readAvailable();
    if (!Number.isFinite(n)) throw new Error(`venue reported a non-numeric balance (${String(n)})`);
    // transferAmountString refuses 0 (it formats an amount to SEND); nothing to move is "0".
    available = n >= Number(TRANSFER_STEP) ? transferAmountString(n) : "0";
    have = `${from} is ${available} ${opts.asset}`;
  } catch (re) {
    have = `${from} could not be read (${extractErrorMessage(re)})`;
  }
  return new PerpError("INSUFFICIENT_BALANCE", `${opts.venue} ${opts.direction} transfer of ${opts.amount} ${opts.asset} refused: ${extractErrorMessage(e)} — ${have}`, {
    exchange: opts.venue, requested: opts.amount, available, asset: opts.asset,
    remediation: available === null
      ? `Check balances: perp -e ${opts.venue} portfolio / trade spot-balance`
      : Number(available) > 0
        ? `Transfer at most ${available} ${opts.asset}, or fund the ${source} account first`
        : `The ${source} account holds no transferable ${opts.asset} — this command moves ${opts.asset} only (margin held in another asset is not ${opts.asset}). Fund the ${source} account with ${opts.asset} first; check: perp -e ${opts.venue} portfolio / trade spot-balance`,
  });
}

/** Spot → perp counterpart of transferQuoteToSpot. */
export function transferQuoteToPerp(spot: SpotAdapter, amount: number): Promise<boolean> {
  return transferQuote(spot, amount, "perp");
}

/**
 * Spot quote (quoteAssets[0]) `available` read UNCACHED; 0 when the venue holds no
 * quote row. Errors propagate. Used as the baseline for sweepSpotQuoteToPerp().
 */
export async function readSpotQuoteAvailableFresh(spot: SpotAdapter): Promise<number> {
  const { def, net } = ownerOf(spot);
  const bals = isSpotFreshBalancesCapable(spot) ? await spot.getSpotBalancesFresh() : await spot.getSpotBalances();
  const bal = findSpotQuoteBalance(def, net, bals);
  if (bal === null) return 0;
  const n = Number(bal.available);
  if (!Number.isFinite(n)) throw new PerpError("EXCHANGE_ERROR", `${spot.name} spot ${bal.token} available is not a number: ${bal.available}`, { exchange: spot.name });
  return n;
}

/**
 * Sweep back to perp ONLY the spot quote this trade produced / left over: the part of
 * the (uncached) available balance above `keep` (the quote that was there before the
 * trade — never touched), capped at `max` (e.g. what this trade transferred in; null =
 * no cap). Returns the amount moved; 0 when the balance is shared with perp or the
 * amount is ≤ minAmount. Errors propagate — callers surface them (funds remain in spot).
 */
export async function sweepSpotQuoteToPerp(spot: SpotAdapter, minAmount: number, opts: { keep: number; max: number | null }): Promise<number> {
  const { def, perp, net } = ownerOf(spot);
  if (spotSharesPerpMargin(def, perp)) return 0;
  const bals = isSpotFreshBalancesCapable(spot) ? await spot.getSpotBalancesFresh() : await spot.getSpotBalances();
  const bal = findSpotQuoteBalance(def, net, bals);
  if (bal === null || bal.shared) return 0;
  const available = Number(bal.available);
  if (!Number.isFinite(available)) throw new PerpError("EXCHANGE_ERROR", `${spot.name} spot ${bal.token} available is not a number: ${bal.available}`, { exchange: spot.name });
  let movable = available - opts.keep;
  if (opts.max !== null) movable = Math.min(movable, opts.max);
  const amount = Math.floor(movable * 100) / 100;
  if (!(amount > minAmount)) return 0;
  return (await transferQuoteToPerp(spot, amount)) ? amount : 0;
}

// ── Spot ↔ perp matching for bots ──

export interface SpotPerpMatch {
  /** Spot base as the spot adapter names it (bare base → quoteAssets[0]). */
  spotBase: string;
  /** Perp market symbol on the perp venue (VenueMarket.symbol). */
  perpSymbol: string;
  canonical: string;
  assetClass: AssetClass;
  spotPrice: number;
  perpPrice: number;
  /** |spot − perp| / perp × 100 */
  deviationPct: number;
}

/**
 * Match a spot venue's markets (default quote only) to a perp venue's markets by
 * canonical symbol — `canonicalFor(spotVenue, base, perp.assetClass)` must equal the
 * perp market's canonical (`null` never matches, NEVER_MATCH pairs excluded) — plus a
 * price guard: |spot − perp mark| ≤ MAX_PRICE_DEVIATION_PCT. Spot markets without a
 * price cannot be validated and are not matched. Bare-ticker equality is never enough.
 *
 * `perpMarkets` = the perp venue's public markets (`fetchPerpMarketsForMatching`).
 * Returns spot base (upper-case) → match.
 */
export function matchSpotPerp(
  spotVenue: string,
  spotMarkets: readonly SpotMarketInfo[],
  perpVenue: string,
  perpMarkets: readonly VenueMarket[],
  warn: (msg: string) => void,
  net: Network,
): Map<string, SpotPerpMatch> {
  const spotDef = getVenue(spotVenue);
  const perpDef = getVenue(perpVenue);
  const quote = defaultSpotQuote(spotDef, net);
  const classes = new Set(perpMarkets.map(m => m.assetClass));
  // (assetClass, canonical) → perp market
  const perpByKey = new Map<string, VenueMarket>();
  for (const m of perpMarkets) {
    if (m.canonical !== null) perpByKey.set(`${m.assetClass}|${m.canonical}`, m);
  }
  const out = new Map<string, SpotPerpMatch>();
  const deviating: string[] = [];
  for (const sm of spotMarkets) {
    if (sm.quoteToken.toUpperCase() !== quote || sm.markPrice === null) continue;
    const spotPrice = Number(sm.markPrice);
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) continue;
    const base = sm.baseToken.toUpperCase();
    for (const cls of classes) {
      const canonical = canonicalFor(spotDef.id as VenueId, base, cls);
      if (canonical === null) continue;
      const pm = perpByKey.get(`${cls}|${canonical}`);
      if (pm === undefined || isNeverMatch(base, pm.symbol.toUpperCase())) continue;
      const perpPrice = Number(pm.markPrice);
      if (!Number.isFinite(perpPrice) || perpPrice <= 0) continue;
      const deviationPct = Math.abs(spotPrice - perpPrice) / perpPrice * 100;
      if (deviationPct > MAX_PRICE_DEVIATION_PCT) {
        deviating.push(`${base}/${quote}↔${pm.symbol} ${deviationPct.toFixed(1)}%`);
        continue;
      }
      out.set(base, { spotBase: base, perpSymbol: pm.symbol, canonical, assetClass: cls, spotPrice, perpPrice, deviationPct });
      break;
    }
  }
  if (deviating.length > 0) {
    warn(`${spotDef.displayName} spot ↔ ${perpDef.displayName} perp: ${deviating.length} same-symbol pair(s) excluded, price deviation > ${MAX_PRICE_DEVIATION_PCT}%: ${deviating.join(", ")}`);
  }
  return out;
}

/** The perp venue's public markets (canonical + asset class + mark) on `net` (default: process network). */
export function fetchPerpMarketsForMatching(perpVenue: string, net: Network = sharedApiNetwork()): Promise<VenueMarket[]> {
  return getVenue(perpVenue).publicData.fetchMarkets(net);
}
