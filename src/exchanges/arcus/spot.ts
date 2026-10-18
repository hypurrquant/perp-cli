/**
 * Arcus spot = Stock Token swaps through the Arcus Spot Router. Not an exchange account: balances are the master wallet's
 * ERC-20 balances on Robinhood Chain, and every trade is an exact-input swap
 * settled on-chain (Permit2 `PermitWitnessTransferFrom` + `TakerIntent`).
 *
 * - Markets: every `/tokens` entry vs USDG ("BASE/USDG"); wire = token address.
 * - Orderbook / limit / cancel: CAPABILITY_UNSUPPORTED (router has no book, nothing rests).
 * - Signer: master EVM key (OWS --wallet or pk) from ArcusAdapter; absent → NO_SIGNER_AVAILABLE.
 * - allowWrapped=false is requested and verified in the signed intent.
 * - Permit2 allowance: EIP-2612 permit when the token supports it, else an
 *   on-chain approve tx that requires `confirmOnchainApprove` and RH ETH for gas.
 *
 * Signing/submit flow ported from @arcus-xyz/arcus-spot-sdk@1.0.2
 * (src/signing.ts) — Copyright Arcus, Apache License 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0).
 */

import { PerpError, orderNotSent } from "../../errors.js";
import type { ResolvedSlippage } from "../slippage.js";
import type { EvmSigner } from "../../signer/interface.js";
import { requirePositive, toUnitsExact, unitsToString } from "../precision.js";
import type { SpotAdapter, SpotBalance, SpotMarketInfo, SpotOrderResult, SpotPricesCapable } from "../spot-interface.js";
import { networkConfig } from "../venue.js";
import { unsupported } from "../trading-v2.js";
import type { ArcusAdapter } from "./adapter.js";
import { ArcusSpotChain, MAX_UINT256 } from "./spot-chain.js";
import {
  ARCUS_SPOT_DEPLOYMENTS, ArcusSpotRouter, NATIVE_TOKEN_ADDRESS, PERMIT2_ADDRESS, RouterHttpError,
  type ArcusQuoteEntry, type ArcusSubmitResponse, type Eip712TypedData, type Permit, type PriceResponse,
  type RouterToken, type StatusResponse,
} from "./spot-router.js";

const QUOTE = "USDG";
/** /status polling: total wait before returning finality "pending". */
export const ARCUS_SPOT_STATUS_TIMEOUT_MS = 90_000;
const STATUS_POLL_INTERVAL_MS = 2_000;
/** USDG notional of the /price probe behind SpotMarketInfo.markPrice. */
const MARK_PROBE_USDG = "100";
/** Parallel /price calls in getSpotMarkets (router rate-limits bursts). */
const MARKET_PRICE_CONCURRENCY = 4;
/** EIP-2612 permit validity. */
const PERMIT_TTL_S = 30 * 60;
/** avgPrice / markPrice decimals. */
const PRICE_STEP = "0.0000000001";
/** Refuse to sign an intent whose deadline is further ahead than this (router intents live ~60 s). */
const MAX_INTENT_DEADLINE_AHEAD_S = 5 * 60;
/**
 * Pinned EIP-712 types of the router's Permit2 witness intent. Permit2 canonical
 * `PermitWitnessTransferFrom` / `TokenPermissions`; `TakerIntent` field order per
 * @arcus-xyz/arcus-spot-sdk@1.0.2 `TakerIntent` (types.d.ts). The router-supplied
 * types must match exactly (EIP712Domain aside), else nothing is signed.
 */
const PINNED_INTENT_TYPES: Record<string, ReadonlyArray<{ name: string; type: string }>> = {
  PermitWitnessTransferFrom: [
    { name: "permitted", type: "TokenPermissions" },
    { name: "spender", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
    { name: "witness", type: "TakerIntent" },
  ],
  TokenPermissions: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  TakerIntent: [
    { name: "taker", type: "address" },
    { name: "takerSellToken", type: "address" },
    { name: "takerBuyToken", type: "address" },
    { name: "sellAmount", type: "uint256" },
    { name: "minBuyAmount", type: "uint256" },
    { name: "allowWrapped", type: "bool" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/** true iff the router's EIP-712 types (EIP712Domain excluded) equal PINNED_INTENT_TYPES field-for-field. */
function intentTypesMatch(types: Eip712TypedData["types"]): boolean {
  const names = Object.keys(types).filter(k => k !== "EIP712Domain");
  const pinned = Object.keys(PINNED_INTENT_TYPES);
  if (names.length !== pinned.length || !pinned.every(k => names.includes(k))) return false;
  return pinned.every(k => {
    const got = types[k];
    const want = PINNED_INTENT_TYPES[k];
    return Array.isArray(got) && got.length === want.length && want.every((f, i) => got[i]?.name === f.name && got[i]?.type === f.type);
  });
}

/** Router error codes meaning "no executable route for this pair/size right now". */
const NO_ROUTE_CODES = new Set(["NO_QUOTES", "TRADE_NOTIONAL_BELOW_MINIMUM", "TRADE_BELOW_MINIMUM_FEE"]);

const ROUTER_ONLY_REMEDIATION = "Arcus spot is a swap router: use `perp -e arcus trade spot-buy|spot-sell` (market swap) instead";

function stepOf(decimals: number): string {
  return decimals === 0 ? "1" : `0.${"0".repeat(decimals - 1)}1`;
}

function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** quote-units per base-unit, as a decimal string with PRICE_STEP precision (floored). */
function priceOf(quoteUnits: bigint, quoteDecimals: number, baseUnits: bigint, baseDecimals: number): string {
  if (baseUnits <= 0n) throw new PerpError("EXCHANGE_ERROR", "Arcus: zero base amount in price computation", { exchange: "arcus" });
  const scale = 10n ** 10n;
  const q = (quoteUnits * 10n ** BigInt(baseDecimals) * scale) / (baseUnits * 10n ** BigInt(quoteDecimals));
  return unitsToString(q, PRICE_STEP);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * EvmSigner-compatible view of router typed data: primary type first (OWS
 * signs `Object.keys(types)[0]`), EIP712Domain stripped, domain keys in
 * canonical order (OWS derives the domain type from key order), and uint
 * values hex-encoded (OWS rejects decimal strings above 2^128 — Permit2
 * nonces are 256-bit). Signature is identical to signing the original.
 */
function signable(td: Eip712TypedData): { domain: Record<string, unknown>; types: Eip712TypedData["types"]; message: Record<string, unknown> } {
  const { EIP712Domain: _omit, ...rest } = td.types;
  const primary = rest[td.primaryType];
  if (!primary) throw new PerpError("EXCHANGE_ERROR", `Typed data is missing primary type ${td.primaryType}`, { exchange: "arcus" });
  const types = { [td.primaryType]: primary, ...rest };
  const domain: Record<string, unknown> = {};
  for (const k of ["name", "version", "chainId", "verifyingContract", "salt"]) {
    if (td.domain[k] !== undefined) domain[k] = td.domain[k];
  }
  const encode = (type: string, v: unknown): unknown => {
    if (/^uint\d*$/.test(type)) return `0x${BigInt(v as string | number | bigint).toString(16)}`;
    const fields = types[type];
    if (!fields) return v;
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const f of fields) out[f.name] = encode(f.type, obj[f.name]);
    return out;
  };
  return { domain, types, message: encode(td.primaryType, td.message) as Record<string, unknown> };
}

async function signTyped(signer: EvmSigner, td: Eip712TypedData): Promise<string> {
  const s = signable(td);
  return signer.signTypedData(s.domain, s.types, s.message);
}

function splitSig(sig: string): { v: number; r: string; s: string } {
  const hex = sig.startsWith("0x") ? sig.slice(2) : sig;
  if (hex.length !== 130) throw new PerpError("SIGNATURE_FAILED", `Expected a 65-byte signature, got ${hex.length / 2} bytes`);
  const raw = Number.parseInt(hex.slice(128, 130), 16);
  const v = raw < 27 ? raw + 27 : raw;
  if (v !== 27 && v !== 28) throw new PerpError("SIGNATURE_FAILED", `Unsupported ECDSA recovery byte ${raw}`);
  return { v, r: `0x${hex.slice(0, 64)}`, s: `0x${hex.slice(64, 128)}` };
}

export interface ArcusSpotOptions {
  /** Allow sending the one-time on-chain `approve(Permit2)` tx (CLI: --yes). */
  confirmOnchainApprove: boolean;
}

export class ArcusSpotAdapter implements SpotAdapter, SpotPricesCapable {
  readonly name = "arcus";
  private readonly perp: ArcusAdapter;
  private opts: ArcusSpotOptions;
  private readonly router: ArcusSpotRouter;
  private readonly chain: ArcusSpotChain;
  /** upper-case symbol → token (native ETH sentinel excluded) */
  private tokens = new Map<string, RouterToken>();
  private usdg: RouterToken | null = null;

  /** opts default refuses the approve tx; the CLI enables it per invocation (--yes) via setConfirmOnchainApprove. */
  constructor(perp: ArcusAdapter, opts: ArcusSpotOptions = { confirmOnchainApprove: false }) {
    this.perp = perp;
    this.opts = opts;
    const cfg = networkConfig(perp.venue, perp.network);
    if (cfg.rpcUrl === null) throw new Error(`arcus ${perp.network} venue definition is missing rpcUrl`);
    const dep = ARCUS_SPOT_DEPLOYMENTS[perp.network];
    if (cfg.signingChainId !== dep.chainId) {
      throw new Error(`arcus ${perp.network}: signingChainId ${cfg.signingChainId} ≠ spot router chain ${dep.chainId}`);
    }
    this.router = new ArcusSpotRouter(dep);
    this.chain = new ArcusSpotChain(cfg.rpcUrl, dep.chainId);
  }

  /** CLI --yes: allow the one-time on-chain approve(Permit2) tx. */
  setConfirmOnchainApprove(confirm: boolean): void {
    this.opts = { ...this.opts, confirmOnchainApprove: confirm };
  }

  /** Loads the router's live token list (the canonical market universe). */
  async init(): Promise<void> {
    const rows = await this.router.tokens();
    const map = new Map<string, RouterToken>();
    let usdg: RouterToken | null = null;
    for (const t of rows) {
      if (t.chainId !== this.router.deployment.chainId) continue;
      if (sameAddr(t.address, NATIVE_TOKEN_ADDRESS)) continue; // native ETH: buying/selling it needs a user-broadcast tx (not supported)
      const key = t.symbol.toUpperCase();
      if (map.has(key)) throw new PerpError("EXCHANGE_ERROR", `Arcus /tokens lists symbol ${t.symbol} twice`, { exchange: "arcus" });
      map.set(key, t);
      if (key === QUOTE) usdg = t;
    }
    if (usdg === null) throw new PerpError("EXCHANGE_ERROR", `Arcus /tokens has no ${QUOTE}`, { exchange: "arcus" });
    this.tokens = map;
    this.usdg = usdg;
  }

  private quoteToken(): RouterToken {
    if (this.usdg === null) throw new Error("ArcusSpotAdapter.init() was not called");
    return this.usdg;
  }

  /** bare base or "BASE/USDG" → router token. */
  private resolve(symbol: string): RouterToken {
    const [base, quote, extra] = symbol.toUpperCase().split("/");
    if (extra !== undefined || (quote !== undefined && quote !== QUOTE)) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Arcus spot only quotes ${QUOTE} (got ${symbol})`, { exchange: "arcus" });
    }
    if (base === "ETH") {
      throw new PerpError("NOT_IMPLEMENTED", "Arcus spot: native ETH swaps need a user-broadcast tx and are not supported", {
        exchange: "arcus", remediation: "Trade WETH/USDG instead",
      });
    }
    const t = this.tokens.get(base);
    if (!t || base === QUOTE) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Arcus spot has no token ${base}`, {
        exchange: "arcus", remediation: "Use a symbol from the Arcus router token list (GET /v1/tokens)",
      });
    }
    return t;
  }

  private bestEntry(r: PriceResponse): PriceResponse["all"][number] {
    const e = r.all.find(x => x.venue === r.recommended);
    if (!e) throw new PerpError("EXCHANGE_ERROR", `Arcus router recommended venue ${r.recommended} is missing from all[]`, { exchange: "arcus" });
    return e;
  }

  // ── Market data ──

  /**
   * markPrice = all-in indicative price of a MARK_PROBE_USDG buy (/price,
   * USDG sellAmount ÷ net buyAmount, fees included) — the router has no mark.
   * volume24h = null: the router publishes no volume. Tokens the router
   * cannot route at the probe size (422 NO_QUOTES / below-minimum codes) are
   * omitted and listed on stderr; any other error propagates.
   */
  async getSpotMarkets(): Promise<SpotMarketInfo[]> {
    const usdg = this.quoteToken();
    return this.priceMarkets([...this.tokens.values()].filter(t => t !== usdg));
  }

  /**
   * SpotPricesCapable: markets (same pricing as getSpotMarkets) for the given base
   * tokens only — one /price call per token, for valuing wallet holdings without
   * pricing the whole universe. Tokens the router does not list (native ETH, wrapped
   * placeholders) are not returned; the caller reports them as unpriced.
   */
  async getSpotPrices(tokens: readonly string[]): Promise<SpotMarketInfo[]> {
    const usdg = this.quoteToken();
    const wanted = new Set(tokens.map(t => t.toUpperCase()));
    return this.priceMarkets([...this.tokens.values()].filter(t => t !== usdg && wanted.has(t.symbol.toUpperCase())));
  }

  private async priceMarkets(bases: RouterToken[]): Promise<SpotMarketInfo[]> {
    const usdg = this.quoteToken();
    const probe = toUnitsExact(MARK_PROBE_USDG, stepOf(usdg.decimals), "probe");
    const out: Array<SpotMarketInfo | null> = new Array(bases.length).fill(null);
    const omitted: string[] = [];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < bases.length) {
        const i = next++;
        const t = bases[i];
        let r: PriceResponse;
        try {
          r = await this.router.price(usdg.address, t.address, probe);
        } catch (e) {
          if (e instanceof RouterHttpError && e.status === 422 && e.routerCode !== null && NO_ROUTE_CODES.has(e.routerCode)) {
            omitted.push(`${t.symbol}(${e.routerCode})`);
            continue;
          }
          throw e;
        }
        const best = this.bestEntry(r);
        out[i] = {
          symbol: `${t.symbol}/${QUOTE}`,
          baseToken: t.symbol,
          quoteToken: QUOTE,
          markPrice: priceOf(BigInt(best.sellAmount), usdg.decimals, BigInt(best.buyAmount), t.decimals),
          volume24h: null,
          sizeDecimals: t.decimals,
          priceDecimals: usdg.decimals,
        };
      }
    };
    await Promise.all(Array.from({ length: MARKET_PRICE_CONCURRENCY }, worker));
    if (omitted.length > 0) {
      console.error(`[arcus-spot] no route at ${MARK_PROBE_USDG} ${QUOTE} for ${omitted.length} token(s), omitted: ${omitted.join(", ")}`);
    }
    return out.filter((m): m is SpotMarketInfo => m !== null);
  }

  async getSpotOrderbook(_symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    throw unsupported("Arcus spot", "spotOrderbook", "the router has no orderbook (AMM + RFQ)", ROUTER_ONLY_REMEDIATION);
  }

  // ── Account ──

  /**
   * Wallet balances on Robinhood Chain: native ETH, USDG, and every /tokens
   * token (plus its wrapped placeholder) with a non-zero balance. Wrapped
   * placeholders are reported as "<SYMBOL>(wrapped)" — awaiting maker
   * settlement, non-transferable. shared:false (not perp collateral).
   */
  async getSpotBalances(): Promise<SpotBalance[]> {
    const owner = (await this.perp.masterEvmSigner()).getAddress();
    const usdg = this.quoteToken();
    const list = [...this.tokens.values()];
    const targets: Array<{ token: string; label: string; decimals: number; wrapped: boolean }> = [];
    for (const t of list) {
      targets.push({ token: t.address, label: t.symbol, decimals: t.decimals, wrapped: false });
      if (t.wrappedTokenAddress) targets.push({ token: t.wrappedTokenAddress, label: `${t.symbol}(wrapped)`, decimals: t.decimals, wrapped: true });
    }
    const [eth, bals] = await Promise.all([
      this.chain.nativeBalance(owner),
      this.chain.erc20Balances(owner, targets.map(x => x.token)),
    ]);
    const row = (token: string, units: bigint, decimals: number): SpotBalance => {
      const total = unitsToString(units, stepOf(decimals));
      return { token, total, available: total, held: "0", shared: false };
    };
    const out: SpotBalance[] = [row("ETH", eth, 18)];
    targets.forEach((x, i) => {
      const b = bals[i];
      if (b === null) {
        // No contract at this address: only legitimate for a not-yet-deployed wrapped placeholder.
        if (!x.wrapped) throw new PerpError("EXCHANGE_ERROR", `Token ${x.label} (${x.token}) has no contract on chain ${this.router.deployment.chainId}`, { exchange: "arcus" });
        return;
      }
      if (b > 0n || sameAddr(x.token, usdg.address)) out.push(row(x.label, b, x.decimals));
    });
    return out;
  }

  // ── Trading ──

  /**
   * Market swap. `size` is in BASE units for both sides.
   * - sell: exact-input `size` BASE → USDG.
   * - buy: the router is exact-input only, so `size` BASE is converted to a
   *   USDG sellAmount: V = USDG out for selling `size` (/price), B = BASE out
   *   for selling V USDG (/price), sellAmount = ceil(size × V / B) — the
   *   all-in buy price at that notional. The signed intent must then carry
   *   minBuyAmount ≥ size × (1 − slippageBps), else nothing is signed.
   * Both sides also require minBuyAmount ≥ quote.buyAmount × (1 − slippageBps).
   * slippageBps = the caller's resolveSlippage() value; the router
   * takes an integer bound.
   */
  async spotMarketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { slippage: ResolvedSlippage }): Promise<SpotOrderResult> {
    // Failures before /submit (validation, pricing, allowance, quote, signing) are a
    // definite "not placed" (ORDER_REJECTED); /submit failures are typed by submitError().
    const progress = { submitted: false };
    try {
      return await this.swap(symbol, side, size, opts.slippage.bps, progress);
    } catch (e) {
      if (progress.submitted) throw e;
      // The swap was not submitted, but an approve(Permit2) tx sent on the way may still be
      // pending: keep its ORDER_PENDING ("Do NOT send another approve"), never re-typed as not sent.
      if (e instanceof PerpError && e.structured.code === "ORDER_PENDING") throw e;
      throw orderNotSent("arcus", `spot ${side} ${size} ${symbol}`, e);
    }
  }

  private async swap(
    symbol: string, side: "buy" | "sell", size: string, bps: number, progress: { submitted: boolean },
  ): Promise<SpotOrderResult> {
    if (!Number.isInteger(bps) || bps <= 0 || bps >= 10_000) {
      throw new PerpError("INVALID_PARAMS", `slippageBps must be an integer in 1..9999 (got ${bps})`, { exchange: "arcus" });
    }
    if (side !== "buy" && side !== "sell") throw new PerpError("INVALID_PARAMS", `side must be buy or sell (got ${String(side)})`);
    requirePositive(size, "size");
    const base = this.resolve(symbol);
    const usdg = this.quoteToken();
    const sizeUnits = toUnitsExact(size, stepOf(base.decimals), "size");
    const signer = await this.perp.masterEvmSigner();
    const taker = signer.getAddress();

    const sellToken = side === "buy" ? usdg : base;
    const buyToken = side === "buy" ? base : usdg;
    let sellAmount: bigint;
    if (side === "sell") {
      sellAmount = sizeUnits;
    } else {
      const v = BigInt(this.bestEntry(await this.router.price(base.address, usdg.address, sizeUnits)).buyAmount);
      if (v <= 0n) throw new PerpError("EXCHANGE_ERROR", `Arcus /price returned 0 ${QUOTE} for ${size} ${base.symbol}`, { exchange: "arcus" });
      const b = BigInt(this.bestEntry(await this.router.price(usdg.address, base.address, v)).buyAmount);
      if (b <= 0n) throw new PerpError("EXCHANGE_ERROR", `Arcus /price returned 0 ${base.symbol} for ${v} ${QUOTE} units`, { exchange: "arcus" });
      sellAmount = (sizeUnits * v + b - 1n) / b;
    }

    // Allowance first: an approve tx can outlive the ~60 s intent deadline.
    const permits = await this.ensurePermit2Allowance(sellToken, taker, sellAmount, signer);

    const q = await this.router.quote({ sellToken: sellToken.address, buyToken: buyToken.address, sellAmount, taker, slippageBps: bps });
    const entry = q.all.find(e => e.venue === "arcus") as ArcusQuoteEntry | undefined;
    if (!entry || !entry.toSign) {
      throw new PerpError("NOT_IMPLEMENTED", `Arcus router offered no arcus-venue intent (recommended: ${q.recommended}); only arcus-venue Permit2 intents are supported`, {
        exchange: "arcus", remediation: "Retry later or trade in the Arcus app",
      });
    }
    const minForSize = side === "buy" ? (sizeUnits * BigInt(10_000 - bps)) / 10_000n : null;
    this.verifyIntent(entry, { taker, sellToken, buyToken, sellAmount, bps, minForSize });

    // The USDG side of the signed intent, shown before signing and kept in venueRaw.
    const usdgStep = stepOf(usdg.decimals);
    const minOutUnits = BigInt(entry.toSign.message.witness.minBuyAmount);
    let intentUsdg: Record<string, string>;
    if (side === "buy") {
      intentUsdg = { usdgSpend: unitsToString(sellAmount, usdgStep) };
      console.error(`[arcus-spot] signing swap: spend ${intentUsdg.usdgSpend} ${QUOTE} for ≥ ${unitsToString(minOutUnits, stepOf(base.decimals))} ${base.symbol}`);
    } else {
      intentUsdg = { usdgMinReceive: unitsToString(minOutUnits, usdgStep) };
      console.error(`[arcus-spot] signing swap: sell ${size} ${base.symbol} for ≥ ${intentUsdg.usdgMinReceive} ${QUOTE}`);
    }

    const signature = await signTyped(signer, entry.toSign);
    const deadline = Number(entry.toSign.message.witness.deadline);
    let submitted: ArcusSubmitResponse;
    progress.submitted = true;
    try {
      submitted = await this.router.submit({
        venue: "arcus", chainId: this.router.deployment.chainId, taker, typedData: entry.toSign, signature,
        ...(permits.length > 0 ? { permits } : {}),
      });
    } catch (e) {
      throw this.submitError(e, deadline);
    }
    // From here the intent is submitted: nothing below may throw (a retry would
    // double-trade) — every failure becomes finality "pending" + do NOT resubmit.
    const marketSymbol = `${base.symbol}/${QUOTE}`;
    if (!submitted || typeof submitted.txHash !== "string") {
      const orderId = submitted && typeof submitted.orderId === "string" ? submitted.orderId : null;
      return this.pendingResult(marketSymbol, orderId, null,
        `/submit accepted but returned no txHash; the intent expires at ${new Date(deadline * 1000).toISOString()}`,
        { submit: submitted, ...intentUsdg });
    }
    try {
      return await this.awaitFinal(symbol, side, base, usdg, taker, submitted, intentUsdg);
    } catch (e) {
      return this.pendingResult(marketSymbol, submitted.orderId ?? submitted.txHash, submitted.txHash,
        `the outcome could not be read (${e instanceof Error ? e.message : String(e)})`,
        { submit: submitted, ...intentUsdg });
    }
  }

  /** Submitted-but-unconfirmed result: never a throw, always "do NOT resubmit". */
  private pendingResult(marketSymbol: string, orderId: string | null, txHash: string | null, why: string, raw: Record<string, unknown>): SpotOrderResult {
    const check = orderId !== null ? `; status: ${this.router.statusUrl(orderId)}` : "";
    return {
      venue: "arcus", symbol: marketSymbol, orderId, status: "pending", filledSize: null, avgPrice: null,
      finality: "pending", receivedToken: null,
      remediation: `Submitted${txHash !== null ? ` (tx ${txHash})` : ""} but ${why} — do NOT resubmit; check balances with: perp -e arcus trade spot-balance${check}`,
      venueRaw: { ...raw, txHash },
    };
  }

  private verifyIntent(e: ArcusQuoteEntry, x: {
    taker: string; sellToken: RouterToken; buyToken: RouterToken; sellAmount: bigint; bps: number; minForSize: bigint | null;
  }): void {
    const td = e.toSign;
    const m = td.message;
    const w = m.witness;
    const dep = this.router.deployment;
    const bad = (what: string): never => {
      throw new PerpError("EXCHANGE_ERROR", `Arcus quote rejected locally (not signed): ${what}`, { exchange: "arcus" });
    };
    if (td.primaryType !== "PermitWitnessTransferFrom") bad(`primaryType ${td.primaryType}`);
    if (!intentTypesMatch(td.types)) bad(`EIP-712 types differ from the pinned Permit2/TakerIntent definitions: ${JSON.stringify(td.types)}`);
    if (td.domain.name !== "Permit2" || Number(td.domain.chainId) !== dep.chainId || !sameAddr(String(td.domain.verifyingContract), PERMIT2_ADDRESS)) bad("domain is not Permit2 on this chain");
    if (!sameAddr(m.spender, dep.arcusSettlement)) bad(`spender ${m.spender} is not ArcusSettlement`);
    if (!sameAddr(m.permitted.token, x.sellToken.address) || BigInt(m.permitted.amount) !== x.sellAmount) bad("permitted token/amount mismatch");
    if (!sameAddr(w.taker, x.taker)) bad(`taker ${w.taker}`);
    if (!sameAddr(w.takerSellToken, x.sellToken.address) || !sameAddr(w.takerBuyToken, x.buyToken.address)) bad("token pair mismatch");
    if (BigInt(w.sellAmount) !== x.sellAmount) bad(`sellAmount ${w.sellAmount}`);
    if (w.allowWrapped !== false) bad("allowWrapped is not false");
    if (w.nonce !== m.nonce || w.deadline !== m.deadline) bad("witness nonce/deadline differ from the permit");
    const nowS = Math.floor(Date.now() / 1000);
    if (Number(w.deadline) <= nowS) bad("intent deadline already passed");
    if (Number(w.deadline) > nowS + MAX_INTENT_DEADLINE_AHEAD_S) bad(`intent deadline ${w.deadline} is more than ${MAX_INTENT_DEADLINE_AHEAD_S}s ahead`);
    const minOut = BigInt(w.minBuyAmount);
    if (minOut <= 0n) bad("minBuyAmount is 0");
    const keep = BigInt(10_000 - x.bps);
    if (minOut < (BigInt(e.buyAmount) * keep) / 10_000n) bad(`minBuyAmount ${minOut} is looser than ${x.bps} bps below the quoted ${e.buyAmount}`);
    if (x.minForSize !== null && minOut < x.minForSize) {
      throw new PerpError("EXCHANGE_ERROR", `Arcus quote rejected locally (not signed): minBuyAmount ${minOut} < requested size × (1 − ${x.bps} bps) = ${x.minForSize} base units — price moved`, {
        exchange: "arcus", remediation: "Retry, or widen --slippage-bps",
      });
    }
  }

  /**
   * Ensure the taker's sellToken→Permit2 allowance covers `amount`
   * (SDK buildArcusSellTokenPermitIfNeeded): none needed → []; EIP-2612 token →
   * one signed permit; otherwise an approve tx, only when confirmOnchainApprove.
   */
  private async ensurePermit2Allowance(token: RouterToken, owner: string, amount: bigint, signer: EvmSigner): Promise<Permit[]> {
    const allowance = await this.chain.permit2Allowance(token.address, owner);
    if (allowance >= amount) return [];
    const nonce = await this.chain.eip2612Nonce(token.address, owner);
    if (nonce === null) {
      if (!this.opts.confirmOnchainApprove) {
        throw new PerpError("INVALID_PARAMS", `approve tx required — ${token.symbol} has no EIP-2612 permit; a one-time on-chain approve(Permit2) costs Robinhood Chain ETH gas. Rerun with --yes`, {
          exchange: "arcus", remediation: "Rerun with --yes to send the approve tx",
        });
      }
      const hash = await this.chain.approvePermit2(token.address, owner, tx => this.perp.signMasterTransaction(tx));
      console.error(`[arcus-spot] approve(Permit2) for ${token.symbol} confirmed: ${hash}`);
      return [];
    }
    const { name, version } = await this.chain.eip2612Domain(token.address);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + PERMIT_TTL_S);
    const sig = await signTyped(signer, {
      domain: { name, version, chainId: this.router.deployment.chainId, verifyingContract: token.address },
      types: {
        Permit: [
          { name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "Permit",
      message: { owner, spender: PERMIT2_ADDRESS, value: MAX_UINT256.toString(), nonce: nonce.toString(), deadline: deadline.toString() },
    });
    return [{ token: token.address, value: MAX_UINT256.toString(), deadline: deadline.toString(), ...splitSig(sig) }];
  }

  private submitError(e: unknown, deadline: number): PerpError {
    const expires = new Date(deadline * 1000).toISOString();
    if (e instanceof RouterHttpError) {
      if (e.status === 401 || e.status === 403) {
        return new PerpError("NOT_IMPLEMENTED", `Arcus router /submit requires an API key (HTTP ${e.status}); perp-cli has no router key storage`, {
          exchange: "arcus", remediation: "Contact Arcus (vip@arcus.xyz) for a router API key; until supported, trade in the Arcus app",
        });
      }
      if (e.status === 429) return e; // rate-limited before processing
      if (e.status >= 400 && e.status < 500) {
        // Explicit router rejection: definitely not executed. Keep a definite code
        // (SIZE_TOO_SMALL stays); a generic one becomes ORDER_REJECTED.
        return e.structured.code === "EXCHANGE_ERROR"
          ? new PerpError("ORDER_REJECTED", e.message, { exchange: "arcus", httpStatus: e.status, routerCode: e.routerCode })
          : e;
      }
      // 5xx: the router may have forwarded the signed intent — the outcome is unknown.
      // ORDER_PENDING is non-retryable (a resend could double-execute).
      return new PerpError("ORDER_PENDING", `Arcus /submit outcome unknown: ${e.message}`, {
        exchange: "arcus",
        remediation: `Outcome unknown — do NOT resubmit before the intent expires (${expires}); then check: perp -e arcus trade spot-balance`,
      });
    }
    if (e instanceof PerpError && (e.structured.code === "TIMEOUT" || e.structured.code === "EXCHANGE_UNREACHABLE")) {
      // Same as 5xx: the intent may have reached the router. Non-retryable.
      return new PerpError("ORDER_PENDING", `Arcus /submit outcome unknown (${e.structured.code}): ${e.message}`, {
        exchange: "arcus",
        remediation: `Outcome unknown — do NOT resubmit before the intent expires (${expires}); then check: perp -e arcus trade spot-balance`,
      });
    }
    if (e instanceof PerpError) return e;
    // Not a PerpError: the request was sent (fetch resolved) but reading the response
    // body failed — the intent may have reached the router. Non-retryable.
    return new PerpError("ORDER_PENDING", `Arcus /submit outcome unknown: ${e instanceof Error ? e.message : String(e)}`, {
      exchange: "arcus",
      remediation: `Outcome unknown — do NOT resubmit before the intent expires (${expires}); then check: perp -e arcus trade spot-balance`,
    });
  }

  /**
   * Poll /status until confirmed/failed or ARCUS_SPOT_STATUS_TIMEOUT_MS; fills come from the
   * receipt's Transfer logs. Any inconsistency returns "pending" (never throws for a bad
   * outcome — the caller also converts thrown poll/RPC errors into "pending").
   */
  private async awaitFinal(
    symbol: string, side: "buy" | "sell", base: RouterToken, usdg: RouterToken, taker: string, sub: ArcusSubmitResponse,
    intentUsdg: Record<string, string>,
  ): Promise<SpotOrderResult> {
    const id = sub.orderId ?? sub.txHash;
    const marketSymbol = `${base.symbol}/${QUOTE}`;
    const until = Date.now() + ARCUS_SPOT_STATUS_TIMEOUT_MS;
    let st: StatusResponse | null = null;
    while (Date.now() < until) {
      st = await this.router.status(id);
      if (st.status === "confirmed" || st.status === "failed") break;
      await sleep(STATUS_POLL_INTERVAL_MS);
    }
    const raw = { submit: sub, status: st, ...intentUsdg };
    if (st === null || (st.status !== "confirmed" && st.status !== "failed")) {
      return this.pendingResult(marketSymbol, id, sub.txHash, `not final after ${ARCUS_SPOT_STATUS_TIMEOUT_MS / 1000}s`, raw);
    }
    if (st.status === "failed") {
      return {
        venue: "arcus", symbol: marketSymbol, orderId: id, status: "rejected", filledSize: null, avgPrice: null,
        finality: "final", receivedToken: null,
        remediation: `Swap failed${st.reason ? `: ${st.reason}` : ""}${st.errorCode ? ` (${st.errorCode})` : ""}; no funds moved by the settlement`,
        venueRaw: raw,
      };
    }

    const txHash = st.txHash ?? sub.txHash;
    const rec = await this.chain.transfersIn(txHash);
    if (rec === null) {
      return this.pendingResult(marketSymbol, id, txHash, "the router reports confirmed while the RPC has no receipt yet (fill amounts unknown)", raw);
    }
    if (rec.status !== 1) {
      return this.pendingResult(marketSymbol, id, txHash, `the router reports confirmed but the receipt status is ${rec.status}`, raw);
    }
    const buyTok = side === "buy" ? base : usdg;
    const sellTok = side === "buy" ? usdg : base;
    const wrapped = buyTok.wrappedTokenAddress ?? null;
    let gotReal = 0n;
    let gotWrapped = 0n;
    let paid = 0n;
    for (const t of rec.transfers) {
      if (sameAddr(t.to, taker) && sameAddr(t.token, buyTok.address)) gotReal += t.amount;
      if (wrapped !== null && sameAddr(t.to, taker) && sameAddr(t.token, wrapped)) gotWrapped += t.amount;
      if (sameAddr(t.from, taker) && sameAddr(t.token, sellTok.address)) paid += t.amount;
    }
    const got = gotReal + gotWrapped;
    if (got === 0n) {
      // Confirmed tx but nothing reached the taker: inconsistent — report, never claim a fill.
      return this.pendingResult(marketSymbol, id, txHash, `the confirmed tx shows no ${buyTok.symbol} transfer to the taker (paid ${paid} ${sellTok.symbol} units)`, raw);
    }
    const receivedToken = gotWrapped > 0n ? `${buyTok.symbol}(wrapped)` : buyTok.symbol;
    const baseUnits = side === "buy" ? got : paid;
    const quoteUnits = side === "buy" ? paid : got;
    const priced = baseUnits > 0n && quoteUnits > 0n;
    return {
      venue: "arcus",
      symbol: marketSymbol,
      orderId: id,
      status: "filled",
      filledSize: baseUnits > 0n ? unitsToString(baseUnits, stepOf(base.decimals)) : null,
      avgPrice: priced ? priceOf(quoteUnits, usdg.decimals, baseUnits, base.decimals) : null,
      finality: "final",
      receivedToken,
      remediation: gotWrapped > 0n
        ? `Received wrapped placeholder ${wrapped} despite allowWrapped=false — non-transferable until the maker settles it to ${buyTok.symbol}`
        : null,
      venueRaw: { ...raw, txHash, requestedSymbol: symbol },
    };
  }

  async spotLimitOrder(_symbol: string, _side: "buy" | "sell", _price: string, _size: string, _opts?: { tif?: string }): Promise<unknown> {
    throw unsupported("Arcus spot", "spotLimitOrder", "swaps settle atomically; nothing rests", ROUTER_ONLY_REMEDIATION);
  }

  async spotCancelOrder(_symbol: string, _orderId: string): Promise<unknown> {
    throw unsupported("Arcus spot", "spotCancel", "there are no resting orders to cancel", ROUTER_ONLY_REMEDIATION);
  }
}
