/**
 * Aster DEX adapter — EIP-712 agent-only signer routing (v3.3).
 *
 * Signer policy:
 *   Tier 1 — Agent OWS wallet  (registered + not expired + no --no-agent) — REQUIRED
 *   Tier 2 — OWS master        — NOT_SUPPORTED (venue rejects master self-signing)
 *   Tier 3 — PK direct         — NOT_SUPPORTED (venue rejects master self-signing)
 *
 * Aster V3 spec requires `signer` to be a registered API_WALLET (agent). The
 * master wallet is never a valid signer — venue returns
 * `code:-1000 msg:"Signature check failed"` when user==signer==master, even
 * though the EIP-712 envelope is well-formed. Master/PK signers are still
 * accepted via setMasterSigner/setPkSigner (used during approveAgent flow),
 * but signed read/trade requests must use Tier 1.
 *
 * HMAC paths fully removed (see Step 3 plan — all Binance-compat HMAC code deleted).
 *
 * Docs: https://docs.asterdex.com/product/aster-perpetuals/api/api-documentation
 * Base: https://fapi.asterdex.com
 */

import { nonEmptyOrListed } from "./unknown-symbol.js";
import { isAsterListedPerpetual } from "../ws/aster-market.js";
import { accountCacheEpoch } from "../cache.js";
import type {
  ExchangeAdapter,
  ExchangeMarketInfo,
  ExchangePosition,
  ExchangeOrder,
  ExchangeBalance,
  ExchangeTrade,
  ExchangePublicTrade,
  ExchangeFundingPayment,
  ExchangeKline,
  FundingHistoryRow
} from "./interface.js";
import type { ResolvedSlippage } from "./slippage.js";
import type { EvmSigner } from "../signer/interface.js";
import type { AgentMeta } from "../settings.js";
import type { AgentSigningStrategy } from "../agent-wallet/signing-strategy.js";
import { isExpired } from "../agent-wallet/expiry.js";
import { classifyError, DEFINITE_ORDER_FAILURE_CODES, isTransportFailure, orderNotSent, orderOutcomeUnknown, PerpError, sendFailure, type ErrorCode } from "../errors.js";
import { parseFiniteVenueNumber, venueRateField } from "../utils/numeric.js";
import { buildOrderTypedData, buildWithdrawTypedData } from "./aster-typed-data.js";
import { alignProtectionPrice, requireOnTick, requirePositive, slippagePrice, subDecimal } from "./precision.js";
import { unsupported } from "./trading-v2.js";
import { networkConfig } from "./venue.js";
import { approvalFromMax, bpsToRate, builderGateOf, NO_BUILDER, rateToBps, requireFeeBps, type BuilderApproval, type BuilderDecision, type BuilderFeeGate, type BuilderTarget } from "./builder-fee.js";
import { ASTER_CLIENT_ID_RE, ASTER_FUNDS_CHAINS, asterVenue, type AsterFundsChain } from "./venues/aster.js";
import {
  assertAsterWithdrawAmount, assertAsterWithdrawSignature, parseAsterWithdrawLimits, requireAsterFundsNetwork,
  type AsterWithdrawLimits, type AsterWithdrawResult,
} from "./aster-funds.js";
import { nextAsterNonce } from "./aster-nonce.js";

/** Per-symbol price filters from GET /fapi/v3/exchangeInfo (loaded with LOT_SIZE). */
interface AsterPriceFilters {
  /** PRICE_FILTER.tickSize */
  tickSize: string;
  /** PRICE_FILTER.minPrice / maxPrice ("0" = no bound, Binance-compatible convention) */
  minPrice: string;
  maxPrice: string;
  /**
   * PERCENT_PRICE (mark-price based per the V3 futures docs:
   * BUY price <= mark × multiplierUp, SELL price >= mark × multiplierDown).
   * null = the symbol carries no PERCENT_PRICE filter.
   */
  percent: { up: number; down: number } | null;
}

/** Common TIF → Aster perp timeInForce. Live exchangeInfo lists GTC/IOC/GTX/HIDDEN — no FOK. */
function asterTif(raw: string): "GTC" | "IOC" | "GTX" {
  const t = raw.toUpperCase();
  if (t === "GTC" || t === "IOC" || t === "GTX") return t;
  if (t === "ALO") return "GTX";
  if (t === "FOK") {
    throw unsupported("Aster", "fok", "perp symbols offer timeInForce GTC/IOC/GTX only (exchangeInfo has no FOK)", "Use --tif IOC, GTC or ALO (post-only)");
  }
  throw new PerpError("INVALID_PARAMS", `Unsupported time-in-force "${raw}" for Aster`, {
    exchange: "aster",
    remediation: "Use --tif GTC, IOC or ALO (post-only)",
  });
}

/** Plain non-negative decimal string of a venue quantity field, or null when absent/unreadable. */
function plainQty(v: unknown): string | null {
  const s = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
  if (typeof s !== "string" || !/^\d+(\.\d+)?$/.test(s)) return null;
  return subDecimal(s, "0");
}

/**
 * Definite IOC outcome of a raw Aster order response (perp and spot share the
 * Binance-compatible shape) — contract in ./ioc-outcome.ts. Final only for a terminal
 * status (FILLED / EXPIRED / CANCELED) with a reported executedQty, on an IOC (or
 * MARKET) order; anything else → null (caller measures).
 */
export function asterIocOutcome(raw: unknown): { filledSize: string; final: true } | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status.toUpperCase() : "";
  if (status !== "FILLED" && status !== "EXPIRED" && status !== "CANCELED") return null;
  const tif = typeof r.timeInForce === "string" ? r.timeInForce.toUpperCase() : null;
  const type = typeof r.type === "string" ? r.type.toUpperCase() : null;
  if (tif !== null && tif !== "IOC" && type !== "MARKET") return null;
  const filledSize = plainQty(r.executedQty);
  return filledSize === null ? null : { filledSize, final: true };
}

/** The numeric `code` of an Aster error body ({"code":-1121,"msg":"Invalid symbol."}); null when absent. */
function asterErrorCode(body: string): number | null {
  try {
    const j = JSON.parse(body) as { code?: unknown };
    return typeof j.code === "number" ? j.code : null;
  } catch {
    return null; // not JSON (e.g. an HTML error page): no venue code
  }
}

/**
 * Order-placement refusals by documented venue code (asterdex/api-docs V3 futures "Error
 * Codes"; "Codes are universal,but messages can vary"). [PerpError code, docs name, remediation].
 * A documented code that is not listed here is a plain ORDER_REJECTED.
 */
const ASTER_ORDER_REJECTIONS: Readonly<Record<number, readonly [ErrorCode, string, string | null]>> = {
  [-1003]: ["ORDER_REJECTED", "TOO_MANY_REQUESTS", "The order was not placed. Wait, then place it again at a lower request rate"],
  [-1015]: ["ORDER_REJECTED", "TOO_MANY_ORDERS", "The order was not placed. Wait, then place it again at a lower order rate"],
  [-1121]: ["SYMBOL_NOT_FOUND", "BAD_SYMBOL", "Check the symbol: perp market list -e aster"],
  [-2010]: ["ORDER_REJECTED", "NEW_ORDER_REJECTED", null],
  [-2018]: ["INSUFFICIENT_BALANCE", "BALANCE_NOT_SUFFICIENT", "Check the balance: perp account balance -e aster"],
  [-2019]: ["MARGIN_INSUFFICIENT", "MARGIN_NOT_SUFFICIEN", "Reduce the size, raise the leverage or add margin: perp account balance -e aster"],
  [-2020]: ["ORDER_REJECTED", "UNABLE_TO_FILL", null],
  [-2021]: ["ORDER_REJECTED", "ORDER_WOULD_IMMEDIATELY_TRIGGER", "Use a trigger price on the other side of the current mark / last price"],
  [-2022]: ["ORDER_REJECTED", "REDUCE_ONLY_REJECT", "A reduce-only order needs an open position on the opposite side (and no larger than it): perp account positions -e aster"],
  [-2024]: ["ORDER_REJECTED", "POSITION_NOT_SUFFICIENT", "Check the position size: perp account positions -e aster"],
  [-2025]: ["ORDER_REJECTED", "MAX_OPEN_ORDER_EXCEEDED", "Cancel open orders first: perp account orders -e aster"],
  [-2027]: ["ORDER_REJECTED", "MAX_LEVERAGE_RATIO", "Lower the leverage or the position size for this market"],
  [-4004]: ["SIZE_TOO_SMALL", "QTY_LESS_THAN_MIN_QTY", "Increase the size: perp market info <symbol> -e aster"],
  [-4005]: ["SIZE_TOO_LARGE", "QTY_GREATER_THAN_MAX_QTY", "Reduce the size: perp market info <symbol> -e aster"],
  [-4014]: ["INVALID_TICK", "PRICE_NOT_INCREASED_BY_TICK_SIZE", "Use a price on the market's tick size"],
  [-4023]: ["ORDER_REJECTED", "QTY_NOT_INCREASED_BY_STEP_SIZE", "Use a size on the market's lot step"],
  [-4050]: ["MARGIN_INSUFFICIENT", "CROSS_BALANCE_INSUFFICIENT", "Check the balance: perp account balance -e aster"],
  [-4051]: ["MARGIN_INSUFFICIENT", "ISOLATED_BALANCE_INSUFFICIENT", "Check the balance: perp account balance -e aster"],
  [-4164]: ["SIZE_TOO_SMALL", "MIN_NOTIONAL", "Increase the order notional (size × price)"],
  [-5050]: ["DEPOSIT_REQUIRED", "DEPOSIT_REQUIRED", "Deposit first: perp funds deposit aster <amount>"],
};

/**
 * Codes whose docs text says the request may still have been processed — never a definite
 * refusal: -1000 UNKNOWN "An unknown error occured while processing the request." · -1001
 * DISCONNECTED "Internal error; unable to process your request." · -1006 UNEXPECTED_RESP
 * "Execution status unknown." · -1007 TIMEOUT "Send status unknown; execution status unknown."
 */
const ASTER_UNKNOWN_OUTCOME_CODES: ReadonlySet<number> = new Set([-1000, -1001, -1006, -1007]);

/** The docs' error-code sections: 10xx / 11xx, 20xx, 40xx (incl. 41xx), 50xx. */
function asterDocumentedCode(code: number): boolean {
  return Number.isInteger(code) && ((code <= -1000 && code >= -1199) || (code <= -2000 && code >= -2099)
    || (code <= -4000 && code >= -4199) || (code <= -5000 && code >= -5099));
}

/**
 * Verdict of a failed POST / PUT /fapi/v3/order that the venue ANSWERED with an HTTP 4xx and a
 * documented error code: the order was refused — a definite, non-retryable PerpError (never the
 * retryable EXCHANGE_ERROR, which callers must treat as an unknown write outcome). Live mainnet
 * 2026-10-05: a reduce-only order without a position → 400 {"code":-2022,"msg":"ReduceOnly Order
 * is rejected."}. Unchanged: HTTP 5xx, no / undocumented code, and the "status unknown" codes —
 * those become ORDER_PENDING unless the error was already classified definite (e.g. the venue's
 * -1000 "Signature check failed" → SIGNATURE_FAILED).
 */
export function asterOrderRejection(e: PerpError): PerpError {
  const d = e.structured.details;
  const http = typeof d?.httpStatus === "number" ? d.httpStatus : null;
  const code = typeof d?.venueCode === "number" ? d.venueCode : null;
  if (http === null || http < 400 || http >= 500 || code === null || !asterDocumentedCode(code)) return e;
  const definite = DEFINITE_ORDER_FAILURE_CODES.has(e.structured.code);
  if (ASTER_UNKNOWN_OUTCOME_CODES.has(code)) return definite ? e : orderOutcomeUnknown("aster", "order", e);
  const known = ASTER_ORDER_REJECTIONS[code];
  if (known === undefined && definite) return e;
  const [perpCode, name, remediation] = known ?? ["ORDER_REJECTED", null, null];
  return new PerpError(perpCode, `Aster rejected the order (${code}${name !== null ? ` ${name}` : ""}): ${e.message}`, {
    exchange: "aster", httpStatus: http, venueCode: code,
    ...(remediation !== null ? { remediation } : e.structured.remediation !== undefined ? { remediation: e.structured.remediation } : {}),
  });
}

/**
 * An Aster client order id as sent / queried. V3 futures "New Order" `newClientOrderId`: "A unique
 * id among open orders. Automatically generated if not sent. Can only be string following the
 * rule: ^[\.A-Z\:/a-z0-9_-]{1,36}$". Anything else → INVALID_PARAMS, nothing sent.
 */
export function requireAsterClientOrderId(id: string): string {
  if (!ASTER_CLIENT_ID_RE.test(id)) {
    throw new PerpError("INVALID_PARAMS", `Aster client order id "${id}" must be 1-36 chars of A-Z a-z 0-9 . : / _ -`, {
      exchange: "aster", remediation: "Pass a shorter id of that charset as --client-id, or use --auto-id",
    });
  }
  return id;
}

// ── ResolvedSigner type ────────────────────────────────────────────────────────

type ResolvedSigner = {
  tier: "agent" | "master" | "pk";
  signer: EvmSigner | AgentSigningStrategy;
  /** EVM address that will appear in the `signer` field of Aster requests */
  signerAddress: string;
  /** EVM address of the owner/master — used as `user` field in Aster requests */
  userAddress: string;
};

// ── AsterAdapter ──────────────────────────────────────────────────────────────

/**
 * Max GET /fapi/v3/income requests for one 7-day read (7 daily slices + splits of full slices).
 * The endpoint weighs 30 against Aster's 2400/min request weight, so 60 requests = 1800 — inside
 * one minute's budget with room for the per-symbol fan-out. Enough for ~2000 fills/day; beyond
 * that the read refuses (EXCHANGE_ERROR) rather than returning a partial history.
 */
export const ASTER_INCOME_MAX_PAGES = 60;

/** GET /fapi/v3/klines maximum rows per request (docs: limit max 1500). */
const ASTER_KLINE_PAGE = 1500;
/** Page cap for one range (150 000 bars). */
const ASTER_KLINE_MAX_PAGES = 100;

export class AsterAdapter implements ExchangeAdapter {
  readonly name = "aster";
  readonly chain = "bnb";
  readonly aliases = ["ast"] as const;

  private _baseUrl: string;
  private _testnet: boolean;

  // Signer tiers
  private _agentMeta?: AgentMeta;
  private _agentSigner?: AgentSigningStrategy; // Tier 1
  private _masterSigner?: EvmSigner;           // Tier 2
  private _pkSigner?: EvmSigner;               // Tier 3
  private _useNoAgent = false;
  /** PK held between ctor and init() since LocalEvmSigner.create() is async */
  private _pendingPk?: string;

  // Cache
  private _marketsCache: ExchangeMarketInfo[] | null = null;
  private _marketsCacheTime = 0;
  private _fundingHoursCache = new Map<string, number>();
  /** When the venue-wide funding-interval table was last loaded (0 = never). */
  private _fundingInfoLoadedAt = 0;
  /** API symbol → price filters; null = listed but PRICE_FILTER / PERCENT_PRICE unreadable. */
  private _priceFilters = new Map<string, AsterPriceFilters | null>();
  private _priceFiltersLoadedAt = 0;
  private _accountCache: { data: unknown; time: number; epoch: number } | null = null;
  private _positionsCache: { data: unknown; time: number; epoch: number } | null = null;
  private _ordersCache: { data: unknown; time: number; epoch: number } | null = null;
  private static readonly CACHE_TTL = 30_000;
  private static readonly ACCOUNT_CACHE_TTL = 5_000;

  /**
   * Builder-fee gate (settings builder.aster + confirmed master approveBuilder); null = not
   * configured. Set by createAster — the adapter never reads settings.
   */
  builderFee: BuilderFeeGate | null = null;

  constructor(privateKey?: string, testnet = false) {
    this._testnet = testnet;
    // SSOT: REST host from the venue definition (venues/aster.ts networks).
    this._baseUrl = networkConfig(asterVenue, testnet ? "testnet" : "mainnet").restUrl;
    if (privateKey) {
      this._pendingPk = privateKey;
    }
  }

  // ── Lifecycle ──

  async init(): Promise<void> {
    // Verify connectivity by fetching server time
    await this._publicGet("/fapi/v3/time");

    // Build LocalEvmSigner from ctor PK now that we're in an async context
    if (this._pendingPk) {
      const { LocalEvmSigner } = await import("../signer/index.js");
      this._pkSigner = await LocalEvmSigner.create(this._pendingPk);
      this._pendingPk = undefined;
    }
  }

  // ── Signer injection ──

  setAgent(meta: AgentMeta, strategy: AgentSigningStrategy): void {
    this._agentMeta = meta;
    this._agentSigner = strategy;
  }

  setMasterSigner(signer: EvmSigner): void {
    this._masterSigner = signer;
  }

  setPkSigner(signer: EvmSigner): void {
    this._pkSigner = signer;
  }

  setNoAgent(noAgent: boolean): void {
    this._useNoAgent = noAgent;
  }

  // ── Builder fee ──

  /** Builder decision for the next perp order (cached approval read; never throws). */
  async builderDecision(): Promise<BuilderDecision> {
    const gate = builderGateOf(this);
    return gate === null ? NO_BUILDER : gate.decide({ hip3: false });
  }

  /** `builder` + `feeRate` (decimal) order params, or none (not configured / not approved). */
  private async _builderParams(): Promise<Record<string, string>> {
    const d = await this.builderDecision();
    return d.applied === null ? {} : { builder: d.applied.identity, feeRate: bpsToRate(requireFeeBps(d.applied)) };
  }

  /** Owner (`user`) address of the active signer — the account a builder approval belongs to. */
  get userAddress(): string {
    return this._resolveSigner().userAddress;
  }

  /**
   * Builder approvals of this account: GET /fapi/v3/builder (asterdex/api-docs demo
   * `getBuilders`, signed by the API wallet). The response shape is not documented, so
   * anything but a list of rows carrying an address + maxFeeRate is "unknown" (never guessed).
   */
  async builderApprovalOf(target: BuilderTarget): Promise<BuilderApproval> {
    const raw = await this.signedRequest(this._baseUrl, "GET", "/fapi/v3/builder", {});
    const rec = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    const list = Array.isArray(raw) ? raw : rec !== null && Array.isArray(rec.rows) ? rec.rows : rec !== null && Array.isArray(rec.data) ? rec.data : null;
    if (list === null) return { status: "unknown", reason: `unrecognized GET /fapi/v3/builder response ${JSON.stringify(raw).slice(0, 120)}` };
    for (const r of list) {
      if (r === null || typeof r !== "object") return { status: "unknown", reason: "GET /fapi/v3/builder row is not an object" };
      const row = r as Record<string, unknown>;
      const addr = typeof row.builder === "string" ? row.builder : typeof row.builderAddress === "string" ? row.builderAddress : null;
      if (addr === null) return { status: "unknown", reason: "GET /fapi/v3/builder row has no builder address" };
      if (addr.toLowerCase() !== target.identity.toLowerCase()) continue;
      const max = rateToBps(row.maxFeeRate);
      if (max === null) return { status: "unknown", reason: `unreadable maxFeeRate ${JSON.stringify(row.maxFeeRate)}` };
      return approvalFromMax(max, requireFeeBps(target));
    }
    return approvalFromMax(null, requireFeeBps(target));
  }

  // ── Status accessors ──

  get isReadOnly(): boolean {
    return !this._agentSigner && !this._masterSigner && !this._pkSigner;
  }

  get activeSignerTier(): "agent" | "master" | "pk" | null {
    try {
      return this._resolveSigner().tier;
    } catch {
      return null;
    }
  }

  // ── Spot host access (used by AsterSpotAdapter) ──

  /**
   * Aster spot REST host. Spot shares the perp EIP-712 Domain B signing
   * (chainId 1666 mainnet / 714 testnet) and the per-agent nonce space.
   * Hosts per the official spot V3 docs (mainnet + testnet variants).
   */
  get spotBaseUrl(): string {
    return this._testnet ? "https://sapi.asterdex-testnet.com" : "https://sapi.asterdex.com";
  }

  /**
   * Signed request against an arbitrary Aster host with the active signer.
   * POST is single-shot; GET/DELETE use the same 429 retry loop as perp.
   */
  async signedRequest(
    host: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean>,
  ): Promise<unknown> {
    const r = this._resolveSigner();
    if (method === "POST") return this._signedPostTo(host, path, params, r);
    return this._signedRequestWithRetry(host, method, path, params, r);
  }

  /**
   * Agent meta of the active signer, or null when the active signer is not an
   * agent. Throws exactly like signed calls when no signer is usable.
   */
  activeAgentMeta(): AgentMeta | null {
    const r = this._resolveSigner();
    if (r.tier !== "agent") return null;
    if (!this._agentMeta) {
      throw new PerpError("AGENT_NOT_REGISTERED", "Aster agent signer is active but its metadata is missing", { exchange: "aster" });
    }
    return this._agentMeta;
  }

  // ── Symbol helpers ──

  /** CLI symbol → Aster API symbol (ETH → ETHUSDT) */
  private _toApi(symbol: string): string {
    const s = symbol.toUpperCase().replace(/-PERP$/, "");
    if (s.endsWith("USDT") || s.endsWith("BUSD")) return s;
    return `${s}USDT`;
  }

  /** Aster API symbol → CLI symbol (ETHUSDT → ETH) */
  private _fromApi(symbol: string): string {
    return symbol.replace(/USDT$/, "").replace(/BUSD$/, "");
  }

  // ── Market Data ──

  /**
   * Get funding interval for a symbol.
   *
   * Source of truth is `GET /fapi/v3/fundingInfo` (weight 1), which states
   * `fundingIntervalHours` per symbol for the whole venue in a single call.
   * This previously inferred the interval by differencing the last two
   * `fundingRate` timestamps and bucketing to 1/4/8h — an estimate that is
   * wrong for a newly listed symbol (fewer than two settlements), across a
   * schedule change, or whenever a settlement is skipped/delayed, and Aster
   * really does mix 1h, 4h and 8h symbols. Funding-interval misconfiguration is
   * exactly what produced the v0.7.23 Aster funding bug, so it is read, not
   * guessed.
   */
  async getFundingHours(symbol: string): Promise<number | undefined> {
    const key = symbol.toUpperCase();
    const cached = this._fundingHoursCache.get(key);
    if (cached !== undefined) return cached;
    await this._loadFundingInfo();
    return this._fundingHoursCache.get(key);
  }

  /** Populate the funding-interval cache for every symbol in one call. */
  private async _loadFundingInfo(): Promise<void> {
    if (this._fundingInfoLoadedAt && Date.now() - this._fundingInfoLoadedAt < AsterAdapter.CACHE_TTL) return;
    const rows = await this._publicGet("/fapi/v3/fundingInfo", {}) as Array<{
      symbol?: string; fundingIntervalHours?: number;
    }>;
    if (!Array.isArray(rows)) {
      throw new PerpError("EXCHANGE_ERROR", "Aster /fapi/v3/fundingInfo did not return an array", { exchange: "aster" });
    }
    for (const row of rows) {
      const hours = Number(row?.fundingIntervalHours);
      if (!row?.symbol || !Number.isFinite(hours) || hours <= 0) continue;
      this._fundingHoursCache.set(this._fromApi(String(row.symbol)), hours);
    }
    this._fundingInfoLoadedAt = Date.now();
  }

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    if (this._marketsCache && Date.now() - this._marketsCacheTime < AsterAdapter.CACHE_TTL) {
      return this._marketsCache;
    }

    const [info, tickers] = await Promise.all([
      this._publicGet("/fapi/v3/exchangeInfo") as Promise<{ symbols?: Array<Record<string, unknown>> }>,
      this._publicGet("/fapi/v3/ticker/24hr") as Promise<Array<Record<string, unknown>>>,
      // Populate the funding-interval table (weight 1, whole venue in one call).
      // The per-symbol read below consulted this cache but nothing ever filled
      // it during getMarkets, so `fundingHours` came back undefined for every
      // market — and Aster genuinely mixes 1h / 4h / 8h symbols, which funding
      // math depends on.
      this._loadFundingInfo(),
    ]);

    if (!Array.isArray(info?.symbols)) {
      throw new PerpError("EXCHANGE_ERROR", `Aster exchangeInfo has no symbol list (${JSON.stringify(info).slice(0, 120)})`, { exchange: "aster" });
    }
    if (!Array.isArray(tickers)) {
      throw new PerpError("EXCHANGE_ERROR", `Aster 24h ticker is not a list (${JSON.stringify(tickers).slice(0, 120)})`, { exchange: "aster" });
    }
    const tickerMap = new Map<string, Record<string, unknown>>();
    for (const t of tickers) {
      tickerMap.set(String(t.symbol), t);
    }

    // The mark price comes from premiumIndex only: a failed read throws (never a "0" / last-trade
    // stand-in), and a symbol missing from it is left out of the list below.
    const premiums = await this._publicGet("/fapi/v3/premiumIndex");
    if (!Array.isArray(premiums)) {
      throw new PerpError("EXCHANGE_ERROR", `Aster premiumIndex is not a list (${JSON.stringify(premiums).slice(0, 120)})`, { exchange: "aster" });
    }
    const premiumMap = new Map((premiums as Array<Record<string, unknown>>).map(p => [String(p.symbol), p]));

    this._ingestPriceFilters(info.symbols);

    // USDT-quoted perps only: the CLI symbol mapping (ETH ↔ ETHUSDT) cannot address the USD1 / U
    // quoted markets (live 2026-10-13: 22 USD1 + 2 U), so listing them would offer untradeable rows.
    const tradingSymbols = info.symbols
      .filter((s) => isAsterListedPerpetual(s) && String(s.quoteAsset) === "USDT");

    const result = tradingSymbols.flatMap((s) => {
      const sym = String(s.symbol);
      const ticker = tickerMap.get(sym);
      const premium = premiumMap.get(sym);
      const mark = Number(premium?.markPrice);
      if (premium === undefined || !(mark > 0)) return []; // no published mark price → not listed at 0
      // Public exchangeInfo carries no leverage (the bracket endpoint is signed) → unknown.
      const maxLev = null;

      const lotFilter = (s.filters as Array<Record<string, unknown>> | undefined)
        ?.find(f => f.filterType === "LOT_SIZE");

      const fundingHours = this._fundingHoursCache.get(this._fromApi(sym));

      return [{
        symbol: this._fromApi(sym),
        markPrice: String(premium.markPrice),
        indexPrice: premium?.indexPrice != null ? String(premium.indexPrice) : null,
        fundingRate: premium?.lastFundingRate != null ? String(premium.lastFundingRate) : null,
        volume24h: ticker?.quoteVolume != null ? String(ticker.quoteVolume) : null,
        // /fapi/v3/exchangeInfo and ticker/24hr carry no open interest.
        openInterest: null,
        maxLeverage: maxLev,
        sizeDecimals: s.quantityPrecision != null ? Number(s.quantityPrecision) : null,
        stepSize: lotFilter?.stepSize != null ? String(lotFilter.stepSize) : null,
        fundingHours: fundingHours ?? null,
        marginTiers: null,
      }];
    });

    this._marketsCache = result;
    this._marketsCacheTime = Date.now();
    return result;
  }

  /** Parse PRICE_FILTER + PERCENT_PRICE for every exchangeInfo symbol into the cache. */
  private _ingestPriceFilters(symbols: Array<Record<string, unknown>>): void {
    this._priceFilters.clear();
    for (const s of symbols) {
      const filters = (Array.isArray(s.filters) ? s.filters : []) as Array<Record<string, unknown>>;
      const pf = filters.find(f => f.filterType === "PRICE_FILTER");
      const pp = filters.find(f => f.filterType === "PERCENT_PRICE");
      let entry: AsterPriceFilters | null = null;
      const tick = pf?.tickSize, minP = pf?.minPrice, maxP = pf?.maxPrice;
      if (typeof tick === "string" && Number(tick) > 0 && typeof minP === "string" && typeof maxP === "string") {
        if (!pp) {
          entry = { tickSize: tick, minPrice: minP, maxPrice: maxP, percent: null };
        } else {
          const up = Number(pp.multiplierUp), down = Number(pp.multiplierDown);
          if (up > 0 && down > 0 && Number.isFinite(up) && Number.isFinite(down)) {
            entry = { tickSize: tick, minPrice: minP, maxPrice: maxP, percent: { up, down } };
          }
        }
      }
      this._priceFilters.set(String(s.symbol), entry);
    }
    this._priceFiltersLoadedAt = Date.now();
  }

  /** PRICE_FILTER / PERCENT_PRICE of an API symbol (exchangeInfo, cached CACHE_TTL). */
  private async _symbolPriceFilters(apiSymbol: string): Promise<AsterPriceFilters> {
    if (!this._priceFiltersLoadedAt || Date.now() - this._priceFiltersLoadedAt >= AsterAdapter.CACHE_TTL) {
      const info = await this._publicGet("/fapi/v3/exchangeInfo") as { symbols?: Array<Record<string, unknown>> };
      if (!Array.isArray(info?.symbols)) {
        throw new PerpError("EXCHANGE_ERROR", "Aster /fapi/v3/exchangeInfo returned no symbols", { exchange: "aster" });
      }
      this._ingestPriceFilters(info.symbols);
    }
    if (!this._priceFilters.has(apiSymbol)) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Aster market ${apiSymbol} not found in exchangeInfo`, { exchange: "aster", remediation: "List markets: perp -e aster market list" });
    }
    const f = this._priceFilters.get(apiSymbol);
    if (!f) {
      throw new PerpError("EXCHANGE_ERROR", `Aster ${apiSymbol}: PRICE_FILTER or PERCENT_PRICE missing/unreadable in exchangeInfo`, { exchange: "aster" });
    }
    return f;
  }

  /**
   * Declared protection-price reference: the venue mark price from
   * GET /fapi/v3/premiumIndex — the same price PERCENT_PRICE is evaluated against.
   * No runtime substitute (no mid / last fallback): unavailable → PRICE_STALE.
   */
  async referencePrice(symbol: string): Promise<string> {
    const apiSymbol = this._toApi(symbol);
    let mark: unknown;
    try {
      const res = await this._publicGet("/fapi/v3/premiumIndex", { symbol: apiSymbol }) as { markPrice?: unknown };
      mark = res?.markPrice;
    } catch (e) {
      throw new PerpError("PRICE_STALE", `Aster ${apiSymbol} mark price unavailable: ${e instanceof Error ? e.message : String(e)}`, { exchange: "aster" });
    }
    const str = typeof mark === "number" ? String(mark) : mark;
    if (typeof str !== "string" || !(Number(str) > 0) || !Number.isFinite(Number(str))) {
      throw new PerpError("PRICE_STALE", `Aster ${apiSymbol} premiumIndex returned no usable markPrice (${String(mark)})`, { exchange: "aster" });
    }
    return str;
  }

  /**
   * Reject (never clamp) a price outside PRICE_FILTER min/max or the side's PERCENT_PRICE
   * bound around `mark` — checked before anything is sent.
   */
  private _checkPriceBand(apiSymbol: string, f: AsterPriceFilters, price: string, side: "buy" | "sell", mark: string): void {
    const p = Number(price);
    if (Number(f.minPrice) > 0 && p < Number(f.minPrice)) {
      throw new PerpError("INVALID_PARAMS", `Aster ${apiSymbol}: price ${price} below PRICE_FILTER minPrice ${f.minPrice}`, { exchange: "aster" });
    }
    if (Number(f.maxPrice) > 0 && p > Number(f.maxPrice)) {
      throw new PerpError("INVALID_PARAMS", `Aster ${apiSymbol}: price ${price} above PRICE_FILTER maxPrice ${f.maxPrice}`, { exchange: "aster" });
    }
    if (f.percent === null) return;
    const m = Number(mark);
    const bound = side === "buy" ? m * f.percent.up : m * f.percent.down;
    if (side === "buy" ? p > bound : p < bound) {
      const bandBps = Math.round(Math.abs((side === "buy" ? f.percent.up : f.percent.down) - 1) * 10_000);
      throw new PerpError("INVALID_PARAMS", `Aster ${apiSymbol}: ${side} protection price ${price} is outside PERCENT_PRICE (${side === "buy" ? "≤" : "≥"} mark ${mark} × ${side === "buy" ? f.percent.up : f.percent.down})`, {
        exchange: "aster",
        remediation: `Use --slippage-bps below ${bandBps} for ${this._fromApi(apiSymbol)} (PERCENT_PRICE band)`,
      });
    }
  }

  /**
   * Protection price an IOC market order on `symbol` would be sent with now:
   * mark ± slippage.bps, aligned toward crossing on PRICE_FILTER.tickSize, validated
   * against PRICE_FILTER / PERCENT_PRICE. appliedBps = the bound after tick alignment.
   */
  async computeProtectionPrice(symbol: string, side: "buy" | "sell", slippage: ResolvedSlippage): Promise<{ referencePrice: string; protectionPrice: string; appliedBps: number }> {
    const apiSymbol = this._toApi(symbol);
    const f = await this._symbolPriceFilters(apiSymbol);
    const ref = await this.referencePrice(symbol);
    const protectionPrice = alignProtectionPrice(slippagePrice(ref, side, slippage.bps), f.tickSize, side);
    this._checkPriceBand(apiSymbol, f, protectionPrice, side, ref);
    const appliedBps = Math.abs(Number(protectionPrice) - Number(ref)) / Number(ref) * 10_000;
    return { referencePrice: ref, protectionPrice, appliedBps };
  }

  /** Definite IOC outcome of a raw order response (see asterIocOutcome). */
  iocOutcomeOf(raw: unknown): { filledSize: string; final: true } | null {
    return asterIocOutcome(raw);
  }

  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const res = await this._publicGet("/fapi/v3/depth", { symbol: this._toApi(symbol), limit: "50" }) as {
      bids?: [string, string][];
      asks?: [string, string][];
    };
    return {
      bids: res?.bids ?? [],
      asks: res?.asks ?? [],
    };
  }

  async getRecentTrades(symbol: string, limit = 20): Promise<ExchangePublicTrade[]> {
    const trades = await this._publicGet("/fapi/v3/trades", {
      symbol: this._toApi(symbol),
      limit: String(limit),
    }) as Array<Record<string, unknown>>;

    if (!Array.isArray(trades)) throw new PerpError("EXCHANGE_ERROR", `Aster trades is not a list (${JSON.stringify(trades).slice(0, 120)})`, { exchange: "aster" });
    // The tape rows carry no symbol: the normalized venue symbol (was the raw argument, "BTC-PERP").
    const sym = this._fromApi(this._toApi(symbol));
    return trades.map((t) => {
      if (typeof t.time !== "number" || typeof t.price !== "string" || typeof t.qty !== "string" || typeof t.isBuyerMaker !== "boolean") {
        throw new PerpError("EXCHANGE_ERROR", `Aster trade row without time / price / qty / isBuyerMaker: ${JSON.stringify(t).slice(0, 160)}`, { exchange: "aster" });
      }
      return { time: t.time, symbol: sym, side: t.isBuyerMaker ? "sell" as const : "buy" as const, price: t.price, size: t.qty, fee: null }; // the public tape carries no fee
    });
  }

  async getFundingHistory(symbol: string, limit = 10): Promise<FundingHistoryRow[]> {
    const data = await this._publicGet("/fapi/v3/fundingRate", {
      symbol: this._toApi(symbol),
      limit: String(limit),
    });
    if (!Array.isArray(data)) {
      throw new PerpError("EXCHANGE_ERROR", `Aster fundingRate history is not a list (${JSON.stringify(data).slice(0, 120)})`, { exchange: "aster" });
    }
    // Per-market interval (/fapi/v3/fundingInfo); null when the venue lists none for the symbol.
    const hours = await this.getFundingHours(symbol);
    const intervalHours = hours === undefined ? null : hours;
    // `200 []` for an unlisted symbol (live 2026-10-14): checked against the market directory.
    return nonEmptyOrListed(this, symbol, (data as Array<Record<string, unknown>>).map((d) => {
      const time = Number(d.fundingTime);
      if (d.fundingTime === undefined || d.fundingTime === null || !Number.isFinite(time) || time <= 0) {
        throw new PerpError("EXCHANGE_ERROR", `Aster fundingRate row without a numeric fundingTime: ${JSON.stringify(d).slice(0, 160)}`, { exchange: "aster" });
      }
      return {
        time,
        rate: venueRateField(d.fundingRate, "fundingRate fundingRate", "aster"),
        price: d.markPrice ? String(d.markPrice) : null,
        intervalHours,
        rateKind: "lastSettled" as const,
      };
    }), this._fromApi(this._toApi(symbol)));
  }

  /**
   * Candles over [startTime, endTime]. GET /fapi/v3/klines returns at most 1500 bars per request
   * (1501 → -1130), so the range is read in pages that start after the last bar returned — a long
   * range is never cut to the first page. More than ASTER_KLINE_MAX_PAGES pages → INVALID_PARAMS.
   */
  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    if (!(startTime <= endTime)) {
      throw new PerpError("INVALID_PARAMS", `Aster klines: start ${startTime} is after end ${endTime}`, {
        remediation: "Pass a --start that is before --end",
      });
    }
    const out: ExchangeKline[] = [];
    let from = startTime;
    for (let page = 0; from <= endTime; page++) {
      if (page >= ASTER_KLINE_MAX_PAGES) {
        throw new PerpError("INVALID_PARAMS", `Aster: ${interval} candles over this range need more than ${ASTER_KLINE_MAX_PAGES} requests`, {
          remediation: "Narrow --start / --end or use a longer interval",
        });
      }
      const data = await this._publicGet("/fapi/v3/klines", {
        symbol: this._toApi(symbol), interval,
        startTime: String(from), endTime: String(endTime), limit: String(ASTER_KLINE_PAGE),
      });
      if (!Array.isArray(data)) {
        throw new PerpError("EXCHANGE_ERROR", `Aster klines is not a list (${JSON.stringify(data).slice(0, 120)})`, { exchange: "aster" });
      }
      for (const k of data as unknown[][]) {
        const time = Number(k[0]);
        const trades = Number(k[8]);
        const numeric = (v: unknown) => (typeof v === "string" || typeof v === "number") && String(v).trim() !== "" && Number.isFinite(Number(v));
        if (!Number.isFinite(time) || !Number.isFinite(trades) || !numeric(k[5]) || !numeric(k[7])) {
          throw new PerpError("EXCHANGE_ERROR", `Aster kline row without open time / volume / quote volume / trade count: ${JSON.stringify(k).slice(0, 120)}`, { exchange: "aster" });
        }
        out.push({ time, open: String(k[1]), high: String(k[2]), low: String(k[3]), close: String(k[4]), volume: String(k[5]), quoteVolume: String(k[7]), trades });
      }
      if (data.length < ASTER_KLINE_PAGE) break;
      const next = Number((data[data.length - 1] as unknown[])[0]) + 1;
      if (next <= from) {
        throw new PerpError("EXCHANGE_ERROR", `Aster klines page did not advance past ${from}`, { exchange: "aster" });
      }
      from = next;
    }
    return out;
  }

  // ── Account ──

  async getBalance(): Promise<ExchangeBalance> {
    if (this._accountCache && this._accountCache.epoch === accountCacheEpoch() && Date.now() - this._accountCache.time < AsterAdapter.ACCOUNT_CACHE_TTL) {
      return this._accountCache.data as ExchangeBalance;
    }
    const r = this._resolveSigner();
    // v3 EIP-712 account endpoint. (The legacy /fapi/v2/account was HMAC-only and
    // is no longer documented in the Aster V3 spec.)
    const account = await this._signedGetEip712("/fapi/v3/accountWithJoinMargin", {}, r) as Record<string, unknown>;

    const totalWallet = parseFiniteVenueNumber(account.totalWalletBalance, "totalWalletBalance", "aster");
    const unrealizedPnl = parseFiniteVenueNumber(account.totalUnrealizedProfit, "totalUnrealizedProfit", "aster");
    const available = parseFiniteVenueNumber(account.availableBalance, "availableBalance", "aster");
    const marginUsed = parseFiniteVenueNumber(account.totalInitialMargin, "totalInitialMargin", "aster");

    const result = {
      equity: String(totalWallet + unrealizedPnl),
      available: String(available),
      marginUsed: String(marginUsed),
      unrealizedPnl: String(unrealizedPnl),
    };
    this._accountCache = { data: result, time: Date.now(), epoch: accountCacheEpoch() };
    return result;
  }

  /**
   * How much of ONE asset the perp account can transfer out: that asset's row of
   * GET /fapi/v3/accountWithJoinMargin `assets[]` — `maxWithdrawAmount` ("maximum amount for
   * transfer out", Aster futures API v3 "Account Information v3"). The account-level
   * `availableBalance` (getBalance) is margin across ALL collateral assets in multi-asset mode
   * and is not an amount of any one asset. Read uncached. A missing row / field is an error,
   * never 0.
   */
  async getPerpAssetTransferable(asset: string): Promise<number> {
    const r = this._resolveSigner();
    const account = await this._signedGetEip712("/fapi/v3/accountWithJoinMargin", {}, r) as Record<string, unknown>;
    if (!Array.isArray(account.assets)) {
      throw new PerpError("EXCHANGE_ERROR", "aster /fapi/v3/accountWithJoinMargin: response has no assets list", { exchange: "aster" });
    }
    const row = (account.assets as Array<Record<string, unknown>>).find(a => a.asset === asset);
    if (row === undefined || row.maxWithdrawAmount === undefined || row.maxWithdrawAmount === null) {
      throw new PerpError("EXCHANGE_ERROR", `aster /fapi/v3/accountWithJoinMargin: no ${asset} maxWithdrawAmount in the assets list`, { exchange: "aster" });
    }
    return parseFiniteVenueNumber(row.maxWithdrawAmount, `assets[${asset}].maxWithdrawAmount`, "aster");
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (this._positionsCache && this._positionsCache.epoch === accountCacheEpoch() && Date.now() - this._positionsCache.time < AsterAdapter.ACCOUNT_CACHE_TTL) {
      return this._positionsCache.data as ExchangePosition[];
    }
    const r = this._resolveSigner();
    // Positions are enumerated from /fapi/v3/accountWithJoinMargin (`positions`
    // array); that payload omits both mark and liquidation price. The signed
    // Position Information v3 endpoint (GET /fapi/v3/positionRisk) supplies both
    // per open symbol, so it replaces the older public premiumIndex mark-price probe.
    const account = await this._signedGetEip712("/fapi/v3/accountWithJoinMargin", {}, r) as Record<string, unknown>;
    const positions = (account.positions as Array<Record<string, unknown>> | undefined) ?? [];

    const open = positions.filter((p) => parseFiniteVenueNumber(p.positionAmt, "position.positionAmt", "aster") !== 0);

    // Hedge mode returns TWO rows per symbol (LONG and SHORT). This adapter
    // keys everything by symbol alone — the riskMap below, and the mapped
    // result — so the two legs collide and one silently inherits the other's
    // mark/liquidation price. Orders are safe (the venue rejects them with
    // -4061 because we never send positionSide), but positions and liquidation
    // distance would be quietly wrong, so fail honestly instead.
    const bySymbol = new Map<string, number>();
    for (const p of open) {
      const k = String(p.symbol ?? "");
      bySymbol.set(k, (bySymbol.get(k) ?? 0) + 1);
    }
    const dupes = [...bySymbol.entries()].filter(([, n]) => n > 1).map(([s]) => s);
    if (dupes.length > 0) {
      throw new PerpError(
        "NOT_IMPLEMENTED",
        `Aster hedge mode is not supported: ${dupes.join(", ")} has both LONG and SHORT positions, which this adapter cannot represent (positions are keyed by symbol).`,
        {
          exchange: "aster",
          remediation: "Switch the account to One-way Mode (POST /fapi/v3/positionSide/dual with dualSidePosition=false) or close one side, then retry.",
        },
      );
    }

    // Enrich open positions with mark + liquidation price from /fapi/v3/positionRisk
    // (best-effort; a transient failure leaves them "0" rather than failing the whole
    // positions read). Response fields per Aster V3 spec: markPrice, liquidationPrice.
    const riskMap = new Map<string, { mark: string; liq: string | null }>();
    if (open.length > 0) {
      try {
        const risk = await this._signedGetEip712("/fapi/v3/positionRisk", {}, r) as Array<Record<string, unknown>>;
        for (const pr of risk ?? []) {
          // Aster V3 spec (userPositionRisk notes, same field): "`liquidationPrice` is reported as `0`
          // whenever the underlying value would be negative" — i.e. the position has no liquidation
          // price (e.g. a small cross long the margin fully covers). 0 is not a price → null.
          const liq = pr.liquidationPrice != null ? String(pr.liquidationPrice) : null;
          riskMap.set(String(pr.symbol), {
            mark: String(pr.markPrice ?? "0"),
            liq: liq !== null && liq.trim() !== "" && Number(liq) === 0 ? null : liq,
          });
        }
      } catch (e) {
        // NOT non-critical. A "0" liquidation price is not a neutral default:
        // risk.ts filters positions on `liquidationPrice !== null && > 0` and
        // event-stream.ts gates the liquidation warning on `liq > 0`, so a
        // silent "0" drops EVERY Aster position out of liquidation monitoring —
        // and the likeliest cause of this call failing (rate limiting)
        // correlates with the volatility that makes those alerts matter most.
        // Surface it, and report the values as unknown rather than as a price.
        process.stderr.write(
          `[aster] positionRisk fetch failed — mark and liquidation prices are UNAVAILABLE this cycle, ` +
          `so liquidation warnings are suppressed for Aster positions: ` +
          `${e instanceof Error ? e.message : String(e)}\n`,
        );
      }
    }

    const result = open.map((p) => {
      const amt = parseFiniteVenueNumber(p.positionAmt, "position.positionAmt", "aster");
      const apiSym = String(p.symbol ?? "");
      const risk = riskMap.get(apiSym);
      return {
        symbol: this._fromApi(apiSym),
        side: amt > 0 ? "long" as const : "short" as const,
        size: String(Math.abs(amt)),
        entryPrice: String(p.entryPrice ?? "0"),
        // Unknown mark is "N/A" (markPrice is a required string); unknown liq is null. Never "0" — a zero reads downstream as a real price.
        // Matches the Pacifica adapter's convention for an absent liq price.
        markPrice: risk?.mark ?? "N/A",
        liquidationPrice: risk ? risk.liq : null,
        unrealizedPnl: String(p.unrealizedProfit ?? "0"),
        leverage: parseFiniteVenueNumber(p.leverage, "position.leverage", "aster", { defaultValue: 1 }),
      };
    });
    this._positionsCache = { data: result, time: Date.now(), epoch: accountCacheEpoch() };
    return result;
  }

  /**
   * Drop the in-process open-orders snapshot (after any order write, or before a verifying
   * re-list). An order write also changes positions and balances, so those snapshots go too.
   */
  invalidateOpenOrdersCache(): void {
    this._ordersCache = null;
    this._positionsCache = null;
    this._accountCache = null;
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    if (this._ordersCache && this._ordersCache.epoch === accountCacheEpoch() && Date.now() - this._ordersCache.time < AsterAdapter.ACCOUNT_CACHE_TTL) {
      return this._ordersCache.data as ExchangeOrder[];
    }
    const r = this._resolveSigner();
    const orders = await this._signedGetEip712("/fapi/v3/openOrders", {}, r) as Array<Record<string, unknown>>;

    const result = (orders ?? []).map((o) => ({
      orderId: String(o.orderId ?? ""),
      symbol: this._fromApi(String(o.symbol ?? "")),
      side: String(o.side).toLowerCase() as "buy" | "sell",
      price: String(o.price ?? "0"),
      size: String(o.origQty ?? "0"),
      filled: String(o.executedQty ?? "0"),
      status: String(o.status ?? ""),
      type: String(o.type ?? ""),
      triggerPrice: Number(o.stopPrice) > 0 ? String(o.stopPrice) : null,
    }));
    this._ordersCache = { data: result, time: Date.now(), epoch: accountCacheEpoch() };
    return result;
  }

  /**
   * Every income row of `incomeType` in the last 7 days. The response order of GET /fapi/v3/income
   * is not documented, so nothing assumes it: the window is read as disjoint [start, end] slices
   * (startTime / endTime inclusive; one day each) and a slice that comes back full (1000 rows, the
   * endpoint max) is split in half and re-read. More than ASTER_INCOME_MAX_PAGES requests, or a
   * full slice of one millisecond → EXCHANGE_ERROR, never a partial list.
   */
  private async _incomeRows(incomeType: "COMMISSION" | "FUNDING_FEE", r: ReturnType<AsterAdapter["_resolveSigner"]>): Promise<Array<Record<string, unknown>>> {
    const end = Date.now();
    const start = end - 7 * 86_400_000;
    const slices: Array<[number, number]> = [];
    for (let s = start; s < end; s += 86_400_000) slices.push([s, Math.min(s + 86_400_000 - 1, end)]);
    slices[slices.length - 1][1] = end; // last slice ends exactly at `end` (inclusive), no extra 1-ms request
    const rows: Array<Record<string, unknown>> = [];
    let requests = 0;
    while (slices.length > 0) {
      const [s, e] = slices.shift()!;
      if (++requests > ASTER_INCOME_MAX_PAGES) {
        throw new PerpError("EXCHANGE_ERROR", `Aster ${incomeType} history needs more than ${ASTER_INCOME_MAX_PAGES} requests for 7 days — the result would be incomplete`, {
          exchange: "aster", remediation: "Check the history per symbol in the Aster web app",
        });
      }
      const page = await this._signedGetEip712("/fapi/v3/income", { incomeType, startTime: String(s), endTime: String(e), limit: "1000" }, r);
      if (!Array.isArray(page)) {
        throw new PerpError("EXCHANGE_ERROR", `Aster income history is not a list (${JSON.stringify(page).slice(0, 120)})`, { exchange: "aster" });
      }
      if (page.length >= 1000) {
        if (e <= s) {
          throw new PerpError("EXCHANGE_ERROR", `Aster returned 1000+ ${incomeType} rows at one millisecond (${s}) — the list cannot be read completely`, {
            exchange: "aster", remediation: "Check the history per symbol in the Aster web app",
          });
        }
        const mid = Math.floor((s + e) / 2);
        slices.unshift([s, mid], [mid + 1, e]);
        continue;
      }
      for (const row of page as Array<Record<string, unknown>>) {
        if (!Number.isFinite(Number(row.time))) {
          throw new PerpError("EXCHANGE_ERROR", `Aster income row without a numeric time: ${JSON.stringify(row).slice(0, 160)}`, { exchange: "aster" });
        }
        rows.push(row);
      }
    }
    return rows;
  }

  /**
   * Symbols with account activity: open positions, open orders, and every symbol with a
   * COMMISSION income row in the last 7 days (see _incomeRows). Aster's userTrades / allOrders
   * both require `symbol`, so this is the per-symbol fan-out set. Orders on a symbol that never
   * filled, is not open and has no position cannot be found (allOrders needs it).
   */
  private async _tradedApiSymbols(r: ReturnType<AsterAdapter["_resolveSigner"]>): Promise<Set<string>> {
    // Raw venue symbols (no _fromApi → _toApi round trip, which would invent a USDT suffix for a
    // non-USDT market): open positions of GET /fapi/v3/accountWithJoinMargin.
    const account = await this._signedGetEip712("/fapi/v3/accountWithJoinMargin", {}, r) as Record<string, unknown>;
    if (!Array.isArray(account?.positions)) {
      throw new PerpError("EXCHANGE_ERROR", "Aster accountWithJoinMargin has no positions list", { exchange: "aster" });
    }
    const apiSymbols = new Set<string>();
    for (const p of account.positions as Array<Record<string, unknown>>) {
      if (typeof p.symbol === "string" && p.symbol !== "" && parseFiniteVenueNumber(p.positionAmt, "position.positionAmt", "aster") !== 0) apiSymbols.add(p.symbol);
    }
    const open = await this._signedGetEip712("/fapi/v3/openOrders", {}, r);
    if (!Array.isArray(open)) {
      throw new PerpError("EXCHANGE_ERROR", `Aster open orders is not a list (${JSON.stringify(open).slice(0, 120)})`, { exchange: "aster" });
    }
    for (const o of open as Array<Record<string, unknown>>) {
      if (typeof o.symbol === "string" && o.symbol !== "") apiSymbols.add(o.symbol);
    }
    for (const row of await this._incomeRows("COMMISSION", r)) {
      if (typeof row.symbol === "string" && row.symbol !== "") apiSymbols.add(row.symbol);
    }
    return apiSymbols;
  }

  /**
   * Recent orders across the symbols with account activity (see _tradedApiSymbols), newest first.
   * A failed read throws (never an empty list); a row without a readable field → EXCHANGE_ERROR.
   */
  async getOrderHistory(limit = 30): Promise<ExchangeOrder[]> {
    const r = this._resolveSigner();
    const apiSymbols = await this._tradedApiSymbols(r);
    const field = (o: Record<string, unknown>, k: string): string => {
      const v = o[k];
      if ((typeof v === "string" && v !== "") || typeof v === "number") return String(v);
      throw new PerpError("EXCHANGE_ERROR", `Aster allOrders row without a readable ${k}: ${JSON.stringify(o).slice(0, 160)}`, { exchange: "aster" });
    };
    const rows: Array<{ time: number; order: ExchangeOrder }> = [];
    for (const sym of apiSymbols) {
      const orders = await this._signedGetEip712("/fapi/v3/allOrders", { symbol: sym, limit: String(limit) }, r);
      if (!Array.isArray(orders)) {
        throw new PerpError("EXCHANGE_ERROR", `Aster allOrders for ${sym} is not a list (${JSON.stringify(orders).slice(0, 120)})`, { exchange: "aster" });
      }
      for (const o of orders as Array<Record<string, unknown>>) {
        const side = field(o, "side").toLowerCase();
        if (side !== "buy" && side !== "sell") {
          throw new PerpError("EXCHANGE_ERROR", `Aster allOrders row with unknown side "${side}"`, { exchange: "aster" });
        }
        const time = Number(field(o, "time"));
        if (!Number.isFinite(time)) throw new PerpError("EXCHANGE_ERROR", `Aster allOrders row with a non-numeric time`, { exchange: "aster" });
        rows.push({
          time,
          order: {
            orderId: field(o, "orderId"),
            symbol: this._fromApi(field(o, "symbol")),
            side,
            price: field(o, "price"),
            size: field(o, "origQty"),
            filled: field(o, "executedQty"),
            status: field(o, "status"),
            type: field(o, "type"),
            triggerPrice: Number(o.stopPrice) > 0 ? String(o.stopPrice) : null,
          },
        });
      }
    }
    return rows.sort((x, y) => y.time - x.time).slice(0, limit).map(x => x.order);
  }


  /**
   * Recent fills. `GET /fapi/v3/userTrades` requires a symbol (asterdex/api-docs V3), so the
   * symbols come from the open positions plus every symbol with a COMMISSION income row in the
   * venue's default window (`GET /fapi/v3/income`: "the recent 7-day data" when no time is sent).
   * A failed read throws (never an empty list); a row without a readable field → EXCHANGE_ERROR.
   */
  async getTradeHistory(limit = 30): Promise<ExchangeTrade[]> {
    const r = this._resolveSigner();
    const apiSymbols = await this._tradedApiSymbols(r);
    const field = (t: Record<string, unknown>, k: string): string => {
      const v = t[k];
      if ((typeof v === "string" && v !== "") || typeof v === "number") return String(v);
      throw new PerpError("EXCHANGE_ERROR", `Aster userTrades row without a readable ${k}: ${JSON.stringify(t).slice(0, 160)}`, { exchange: "aster" });
    };
    const allTrades: ExchangeTrade[] = [];
    for (const sym of apiSymbols) {
      const trades = await this._signedGetEip712("/fapi/v3/userTrades", { symbol: sym, limit: String(limit) }, r);
      if (!Array.isArray(trades)) {
        throw new PerpError("EXCHANGE_ERROR", `Aster userTrades for ${sym} is not a list (${JSON.stringify(trades).slice(0, 120)})`, { exchange: "aster" });
      }
      for (const t of trades as Array<Record<string, unknown>>) {
        if (typeof t.buyer !== "boolean") {
          throw new PerpError("EXCHANGE_ERROR", `Aster userTrades row without a boolean buyer: ${JSON.stringify(t).slice(0, 160)}`, { exchange: "aster" });
        }
        const time = Number(field(t, "time"));
        if (!Number.isFinite(time)) throw new PerpError("EXCHANGE_ERROR", `Aster userTrades row with a non-numeric time`, { exchange: "aster" });
        allTrades.push({
          time,
          symbol: this._fromApi(field(t, "symbol")),
          side: t.buyer ? "buy" as const : "sell" as const,
          price: field(t, "price"),
          size: field(t, "qty"),
          fee: field(t, "commission"),
        });
      }
    }
    return allTrades.sort((a, b) => b.time - a.time).slice(0, limit);
  }

  /** FUNDING_FEE income of the last 7 days (see _incomeRows), newest first, at most `limit` rows. */
  async getFundingPayments(limit = 200): Promise<ExchangeFundingPayment[]> {
    const rows = await this._incomeRows("FUNDING_FEE", this._resolveSigner());
    return rows.map((f) => {
      const time = Number(f.time);
      if (typeof f.symbol !== "string" || f.symbol === "" || (typeof f.income !== "string" && typeof f.income !== "number") || f.income === "") {
        throw new PerpError("EXCHANGE_ERROR", `Aster funding income row without symbol / income: ${JSON.stringify(f).slice(0, 160)}`, { exchange: "aster" });
      }
      return { time, symbol: this._fromApi(f.symbol), payment: String(f.income) };
    }).sort((x, y) => y.time - x.time).slice(0, limit);
  }

  /**
   * Per-market leverage / margin mode: every row of GET /fapi/v3/positionRisk ("Position
   * Information v3", one row per symbol, position or not — docs example:
   * `"marginType": "isolated"`, `"leverage": "10"`, `"positionAmt": "0.000"`; rows[].marginType
   * "Margin type: `isolated` or `cross`"). An unreadable row throws — never a default.
   */
  async getMarketSettings(): Promise<Array<{ symbol: string; leverage: number; marginMode: "cross" | "isolated" }>> {
    const rows = await this._signedGetEip712("/fapi/v3/positionRisk", {}, this._resolveSigner());
    if (!Array.isArray(rows)) {
      throw new PerpError("EXCHANGE_ERROR", "Aster /fapi/v3/positionRisk did not return an array — per-market settings unknown", { exchange: "aster" });
    }
    const seen = new Map<string, { symbol: string; leverage: number; marginMode: "cross" | "isolated" }>();
    for (const row of rows as Array<Record<string, unknown>>) {
      const leverage = Number(row.leverage);
      const type = typeof row.marginType === "string" ? row.marginType.toLowerCase() : "";
      // "crossed" is the request enum spelling (CROSSED); the documented read value is "cross".
      const marginMode = type === "isolated" ? "isolated" : type === "cross" || type === "crossed" ? "cross" : null;
      if (typeof row.symbol !== "string" || !(leverage > 0) || marginMode === null) {
        throw new PerpError("EXCHANGE_ERROR", `Aster positionRisk row without a readable symbol / leverage / marginType: ${JSON.stringify(row).slice(0, 160)}`, { exchange: "aster" });
      }
      // Hedge mode lists a symbol once per position side; leverage / margin type are per symbol.
      seen.set(row.symbol, { symbol: this._fromApi(row.symbol), leverage, marginMode });
    }
    return [...seen.values()];
  }

  // ── Trading ──

  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { reduceOnly: boolean; slippage: ResolvedSlippage; clientOrderId?: string }): Promise<unknown> {
    // Never native MARKET (no price cap) — an IOC LIMIT at the
    // protection price (mark ± opts.slippage.bps, tick-aligned toward crossing, inside
    // PRICE_FILTER / PERCENT_PRICE). newOrderRespType=RESULT makes the response carry the
    // final IOC status (FILLED / EXPIRED) and executedQty.
    const r = this._resolveSigner();
    const apiSymbol = this._toApi(symbol);
    const clientOrderId = opts.clientOrderId === undefined ? null : requireAsterClientOrderId(opts.clientOrderId);
    let protectionPrice: string;
    let protection: { referencePrice: string; protectionPrice: string; appliedBps: number };
    try {
      protection = await this.computeProtectionPrice(symbol, side, opts.slippage);
      ({ protectionPrice } = protection);
    } catch (e) {
      throw orderNotSent("aster", `market ${side} ${size} ${symbol}`, e);
    }
    const params: Record<string, string | number | boolean> = {
      symbol: apiSymbol,
      side: side.toUpperCase(),
      type: "LIMIT",
      timeInForce: "IOC",
      price: protectionPrice,
      quantity: size,
      newOrderRespType: "RESULT",
    };
    if (clientOrderId !== null) params.newClientOrderId = clientOrderId;
    if (opts.reduceOnly) params.reduceOnly = "true";
    Object.assign(params, await this._builderParams());

    const result = await this._signedPostEip712("/fapi/v3/order", params, r);
    const ro = result as Record<string, unknown>;
    const executedQty = Number(ro.executedQty ?? 0);
    const orderId = String(ro.orderId ?? "");

    // The protection actually sent rides along with the venue response (`protection`), read by
    // the TradingV2 wrapper's execution record (the venue does not echo the reference).
    if (executedQty > 0 && ro.status === "FILLED") return { ...ro, protection };

    if (ro.status === "NEW" && orderId) {
      for (let i = 0; i < 3; i++) {
        await new Promise(res => setTimeout(res, 1000));
        try {
          const check = await this._signedGetEip712("/fapi/v3/order", {
            symbol: apiSymbol,
            orderId,
          }, r) as Record<string, unknown>;
          const filledQty = Number(check.executedQty ?? 0);
          if (filledQty > 0) return { ...check, protection };
          if ((check.status === "CANCELED" || check.status === "EXPIRED" || check.status === "REJECTED") && check.executedQty !== undefined && check.executedQty !== null) {
            // Terminal status with a REPORTED 0 executed: nothing traded (definite).
            throw new PerpError("ORDER_REJECTED", `Market ${side} ${symbol}: order ${check.status} (orderId: ${orderId})`, { exchange: "aster", orderId });
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("Market ")) throw e;
        }
      }
      let cancelledQty: number | null = null;
      let cancelRow: Record<string, unknown> | null = null;
      try {
        const c = await this._signedDeleteEip712("/fapi/v3/order", { symbol: apiSymbol, orderId }, r) as Record<string, unknown>;
        const q = Number(c?.executedQty);
        cancelledQty = Number.isFinite(q) ? q : null;
        cancelRow = c;
      } catch { /* cancel failed: the order may still be live — outcome stays unknown below */ }
      // The cancel answered with executedQty > 0: the order PARTIALLY filled before the cancel —
      // report that fill (the cancel row carries executedQty / status CANCELED; asterIocOutcome
      // reads it), never "not filled".
      if (cancelledQty !== null && cancelledQty > 0 && cancelRow !== null) {
        console.error(`[aster] market ${side} ${symbol}: order ${orderId} partially filled (${String(cancelRow.executedQty)}) before the remainder was cancelled`);
        return { ...cancelRow, protection };
      }
      const msg = `Market ${side} ${symbol}: order not filled after 3s, cancelled (orderId: ${orderId})`;
      // Definite only when the cancel was confirmed with 0 executed; otherwise it may have filled / be live.
      if (cancelledQty === 0) throw new PerpError("ORDER_REJECTED", msg, { exchange: "aster", orderId });
      throw new Error(msg);
    }

    if (executedQty === 0) {
      const msg = `Market ${side} ${symbol}: order accepted but 0 filled (status: ${ro.status}, orderId: ${orderId})`;
      // A terminal status (EXPIRED IOC / CANCELED / REJECTED) with 0 executed is a definite no-fill.
      if ((ro.status === "EXPIRED" || ro.status === "CANCELED" || ro.status === "REJECTED") && ro.executedQty !== undefined && ro.executedQty !== null) {
        throw new PerpError("ORDER_REJECTED", msg, { exchange: "aster", orderId });
      }
      throw new Error(msg);
    }
    return { ...ro, protection };
  }

  async limitOrder(
    symbol: string,
    side: "buy" | "sell",
    price: string,
    size: string,
    opts?: { reduceOnly?: boolean; tif?: string; clientOrderId?: string },
  ): Promise<unknown> {
    const r = this._resolveSigner();
    const apiSymbol = this._toApi(symbol);
    const clientOrderId = opts?.clientOrderId === undefined ? null : requireAsterClientOrderId(opts.clientOrderId);
    let params: Record<string, string | number | boolean>;
    try {
      // Common TIF names: GTC / IOC / ALO→GTX (GTX accepted as alias); FOK unsupported.
      const tif = asterTif(opts?.tif ?? "GTC");
      // Price must already be on PRICE_FILTER.tickSize — validated, never rounded (INVALID_TICK).
      const px = requireOnTick(price, (await this._symbolPriceFilters(apiSymbol)).tickSize);
      params = {
        symbol: apiSymbol,
        side: side.toUpperCase(),
        type: "LIMIT",
        price: px,
        quantity: size,
        timeInForce: tif,
      };
      // IOC / GTX: ask for the final status + executedQty in the response (iocOutcomeOf). Docs (futures
      // V3, New Order): with `newOrderRespType` RESULT, "`LIMIT` order with special `timeInForce`: the
      // final status result of the order(FILLED or EXPIRED) will be returned directly". The default ACK
      // answers NEW for a post-only order that then expires because it would cross (live mainnet 2026-10-05).
      if (tif === "IOC" || tif === "GTX") params.newOrderRespType = "RESULT";
      if (clientOrderId !== null) params.newClientOrderId = clientOrderId;
      if (opts?.reduceOnly) params.reduceOnly = "true";
      Object.assign(params, await this._builderParams());
    } catch (e) {
      throw orderNotSent("aster", `limit ${side} ${size} ${symbol} @ ${price}`, e);
    }
    return this._signedPostEip712("/fapi/v3/order", params, r);
  }

  /**
   * Native modify (PUT /fapi/v3/order, V3 futures docs "Modify Order"): LIMIT orders
   * only; TIF (incl. GTX) and reduceOnly stay on the order. `size` is the NEW UNFILLED
   * quantity; the venue's `quantity` is the order total, so
   * quantity = size + executedQty (read just before). A fill landing between the read
   * and the PUT can only shrink the remainder, never over-size it. A venue rejection
   * leaves the original order untouched (docs).
   */
  async editOrder(symbol: string, orderId: string, price: string, size: string): Promise<unknown> {
    const r = this._resolveSigner();
    const apiSymbol = this._toApi(symbol);
    const rawOrders = await this._signedGetEip712("/fapi/v3/openOrders", {}, r) as Array<Record<string, unknown>>;
    const existing = (rawOrders ?? []).find(o => String(o.orderId ?? "") === orderId);
    if (!existing) {
      // Rule #2: never guess the order — fail honestly if it is no longer open.
      throw new PerpError("ORDER_NOT_FOUND", `Aster order ${orderId} is not among the open orders; refusing to edit (cannot guess its side).`, { exchange: "aster" });
    }
    const type = String(existing.type ?? "").toUpperCase();
    if (type !== "LIMIT") {
      // Venue modify supports LIMIT only; a STOP/TP must be cancelled and re-placed explicitly.
      throw new PerpError("INVALID_PARAMS", `Aster editOrder only supports plain LIMIT orders (order ${orderId} is ${type || "unknown"}). Cancel and re-place it explicitly.`, { exchange: "aster" });
    }
    const executed = plainQty(existing.executedQty);
    if (executed === null) {
      throw new PerpError("EXCHANGE_ERROR", `Aster order ${orderId}: openOrders row has no readable executedQty (${String(existing.executedQty)})`, { exchange: "aster" });
    }
    requirePositive(size, "size");
    const px = requireOnTick(price, (await this._symbolPriceFilters(apiSymbol)).tickSize);
    return this._perpWrite("PUT /fapi/v3/order", () => this._signedPostTo(this._baseUrl, "/fapi/v3/order", {
      symbol: apiSymbol,
      orderId,
      side: String(existing.side ?? "").toUpperCase(),
      quantity: subDecimal(size, `-${executed}`),
      price: px,
    }, r, "PUT"), true);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<unknown> {
    return this._cancelOne(symbol, { orderId }, orderId);
  }

  /**
   * Cancel one order by client order id — V3 futures "Cancel Order" (DELETE /fapi/v3/order):
   * "Either `orderId` or `origClientOrderId` must be sent."
   */
  async cancelOrderByClientId(symbol: string, clientOrderId: string): Promise<unknown> {
    const id = requireAsterClientOrderId(clientOrderId);
    return this._cancelOne(symbol, { origClientOrderId: id }, `c:${id}`);
  }

  /**
   * One order's row — V3 futures "Query Order" (GET /fapi/v3/order, symbol + orderId or
   * origClientOrderId). Docs: CANCELED / EXPIRED orders with no fill older than 7 days "will not
   * be found". -2013 NO_SUCH_ORDER → ORDER_NOT_FOUND; any other failure throws as is.
   */
  async queryOrderRow(symbol: string, ref: { kind: "orderId" | "clientOrderId"; value: string }): Promise<Record<string, unknown>> {
    const key: Record<string, string> = ref.kind === "orderId" ? { orderId: ref.value } : { origClientOrderId: requireAsterClientOrderId(ref.value) };
    const label = ref.kind === "orderId" ? ref.value : `c:${ref.value}`;
    let row: unknown;
    try {
      row = await this._signedGetEip712("/fapi/v3/order", { symbol: this._toApi(symbol), ...key }, this._resolveSigner());
    } catch (e) {
      if (e instanceof PerpError && e.structured.details?.venueCode === -2013) {
        throw new PerpError("ORDER_NOT_FOUND", `Aster has no order ${label} on ${symbol.toUpperCase()} (-2013 NO_SUCH_ORDER)`, {
          exchange: "aster", venueCode: -2013, remediation: "List orders: perp account orders -e aster / perp history orders -e aster",
        });
      }
      throw e;
    }
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new PerpError("EXCHANGE_ERROR", `Aster GET /fapi/v3/order ${label}: unexpected response shape`, { exchange: "aster" });
    }
    return row as Record<string, unknown>;
  }

  private async _cancelOne(symbol: string, key: { orderId: string } | { origClientOrderId: string }, orderId: string): Promise<unknown> {
    const r = this._resolveSigner();
    try {
      return await this._signedDeleteEip712("/fapi/v3/order", {
        symbol: this._toApi(symbol),
        ...key,
      }, r);
    } catch (e) {
      // Docs (futures V3 error codes): "-2011 CANCEL_REJECTED" — the venue refused the cancel; the
      // order is not open (already filled / cancelled, or unknown). Live mainnet 2026-10-05, cancel of
      // a filled order: 400 {"code":-2011,"msg":"Unknown order sent."}. Definite: nothing was cancelled.
      if (e instanceof PerpError && e.structured.details?.venueCode === -2011) {
        throw new PerpError("ORDER_REJECTED", `Aster refused to cancel order ${orderId} on ${symbol} (-2011 CANCEL_REJECTED): it is not an open order`, {
          exchange: "aster", orderId, venueCode: -2011,
          remediation: `Check its final state: perp trade status ${orderId} --symbol ${symbol} -e aster`,
        });
      }
      throw e;
    }
  }

  async cancelAllOrders(symbol?: string): Promise<unknown> {
    const r = this._resolveSigner();
    if (!symbol) {
      const orders = await this.getOpenOrders();
      const apiSymbols = new Set(orders.map(o => this._toApi(o.symbol)));
      const results = [];
      for (const sym of apiSymbols) {
        results.push(await this._signedDeleteEip712("/fapi/v3/allOpenOrders", { symbol: sym }, r));
      }
      return results;
    }
    return this._signedDeleteEip712("/fapi/v3/allOpenOrders", { symbol: this._toApi(symbol) }, r);
  }

  // ── Risk ──

  async setLeverage(symbol: string, leverage: number, marginMode?: "cross" | "isolated"): Promise<unknown> {
    const r = this._resolveSigner();
    if (marginMode) {
      try {
        await this._signedPostEip712("/fapi/v3/marginType", {
          symbol: this._toApi(symbol),
          marginType: marginMode === "cross" ? "CROSSED" : "ISOLATED",
        }, r);
      } catch (e) {
        // Rule #2: only -4046 NO_NEED_TO_CHANGE_MARGIN_TYPE ("No need to change
        // margin type") is a benign no-op. Every other rejection — notably a
        // refusal because the symbol has an open position or open orders —
        // means the account is STILL on the previous margin mode. Swallowing
        // those left the user believing they had switched to isolated while the
        // position stayed cross, and the leverage change below then applied to
        // a cross position.
        const msg = e instanceof Error ? e.message : String(e);
        const benign = msg.includes("-4046") || /no need to change margin type/i.test(msg);
        if (benign) { /* already on the requested margin type */ }
        else if (e instanceof PerpError && typeof e.structured.details?.venueCode === "number" && [-4047, -4048, -4050, -4051].includes(e.structured.details.venueCode)) {
          // The venue refused the margin-type change; the leverage request below is NOT sent, so
          // nothing changed. Docs ("Error Codes"): -4047 "Margin type cannot be changed if there
          // exists open orders." · -4048 "Margin type cannot be changed if there exists position."
          // · -4050 "Cross balance insufficient." · -4051 "Isolated balance insufficient." The
          // "Change Margin Type" section states no balance or Multi-Assets-mode condition, so
          // for -4050 / -4051 the venue's own text is reported as is (live mainnet 2026-10-05:
          // ISOLATED on a flat SOL → 400 -4050) with the two account facts to check.
          const code = e.structured.details.venueCode;
          const why: Record<number, [string, string]> = {
            [-4047]: ["THERE_EXISTS_OPEN_ORDERS", `Cancel the ${symbol} open orders first: perp trade cancel ${symbol} -e aster`],
            [-4048]: ["THERE_EXISTS_QUANTITY", `Close the ${symbol} position first: perp trade close ${symbol} -e aster`],
            [-4050]: ["CROSS_BALANCE_INSUFFICIENT", `The venue docs do not state the condition. Check the account's margin-asset balance (perp account balance -e aster) and whether it is in Multi-Assets mode (GET /fapi/v3/multiAssetsMargin; set in the Aster app) — or keep cross: perp trade leverage ${symbol} ${leverage} -e aster`],
            [-4051]: ["ISOLATED_BALANCE_INSUFFICIENT", `The venue docs do not state the condition. Check the account's margin-asset balance: perp account balance -e aster`],
          };
          throw new PerpError("ACTION_REJECTED", `Aster refused to switch ${symbol} to ${marginMode} margin (${code} ${why[code][0]}: ${msg}) — margin mode and leverage are unchanged`, {
            exchange: "aster", venueCode: code, httpStatus: e.structured.details.httpStatus, remediation: why[code][1],
          });
        } else throw e;
      }
    }
    return this._signedPostEip712("/fapi/v3/leverage", {
      symbol: this._toApi(symbol),
      leverage: String(leverage),
    }, r);
  }

  /**
   * Trigger order. Type follows the venue trigger rules (V3 docs, "Condition orders"):
   * STOP*: BUY fires at price >= stopPrice, SELL at <= ; TAKE_PROFIT*: the reverse. So the
   * type is chosen from the trigger vs the current trigger-source price and the order side
   * (the side closing a long is SELL): BUY above / SELL below → STOP, otherwise
   * TAKE_PROFIT. (Always STOP_MARKET made every TP fail with -2021.)
   * Trigger source: workingType MARK_PRICE compared with the premiumIndex mark (default),
   * or CONTRACT_PRICE with the last price when triggerType is "last".
   * size "0" = whole position → closePosition=true (STOP_MARKET / TAKE_PROFIT_MARKET only;
   * the venue forbids quantity and reduceOnly with it).
   * `opts.kind` (TP/SL legs): sl → STOP(_MARKET), tp → TAKE_PROFIT(_MARKET) as given, with
   * no price read; a trigger already crossed is rejected by the venue (-2021).
   */
  async stopOrder(
    symbol: string,
    side: "buy" | "sell",
    size: string,
    triggerPrice: string,
    opts?: { limitPrice?: string; reduceOnly?: boolean; triggerType?: "mark" | "last" | "mid"; kind?: "tp" | "sl" },
  ): Promise<unknown> {
    const r = this._resolveSigner();
    const apiSymbol = this._toApi(symbol);
    const what = `stop ${side} ${size} ${symbol} @ ${triggerPrice}`;
    let params: Record<string, string | number | boolean>;
    try {
      if (opts?.triggerType === "mid") {
        throw unsupported("Aster", "triggerType", "stop orders trigger on MARK_PRICE or CONTRACT_PRICE only", "Use triggerType mark or last");
      }
      const f = await this._symbolPriceFilters(apiSymbol);
      const stopPrice = requireOnTick(triggerPrice, f.tickSize);
      const useLast = opts?.triggerType === "last";
      let isStop: boolean;
      if (opts?.kind !== undefined) {
        isStop = opts.kind === "sl";
      } else {
        const ref = useLast ? await this._lastPrice(apiSymbol) : await this.referencePrice(symbol);
        const t = Number(stopPrice), p = Number(ref);
        if (t === p) {
          throw new PerpError("INVALID_PARAMS", `Aster ${apiSymbol}: trigger ${stopPrice} equals the current ${useLast ? "last" : "mark"} price — it would trigger immediately`, { exchange: "aster" });
        }
        isStop = side === "buy" ? t > p : t < p;
      }
      const closeAll = Number(size) === 0;
      if (!closeAll) requirePositive(size, "size");
      params = {
        symbol: apiSymbol,
        side: side.toUpperCase(),
        stopPrice,
        workingType: useLast ? "CONTRACT_PRICE" : "MARK_PRICE",
      };
      if (opts?.limitPrice) {
        if (closeAll) {
          throw new PerpError("INVALID_PARAMS", "Aster closePosition (whole-position trigger) only exists for market triggers — pass an explicit size with a limit price", { exchange: "aster" });
        }
        params.type = isStop ? "STOP" : "TAKE_PROFIT";
        params.price = requireOnTick(opts.limitPrice, f.tickSize);
        params.timeInForce = "GTC";
      } else {
        params.type = isStop ? "STOP_MARKET" : "TAKE_PROFIT_MARKET";
      }
      if (closeAll) {
        params.closePosition = "true";
      } else {
        params.quantity = size;
        if (opts?.reduceOnly) params.reduceOnly = "true";
      }
      Object.assign(params, await this._builderParams());
    } catch (e) {
      throw orderNotSent("aster", what, e);
    }
    return this._signedPostEip712("/fapi/v3/order", params, r);
  }

  /** Last traded price (GET /fapi/v3/ticker/price) — the CONTRACT_PRICE trigger source. */
  private async _lastPrice(apiSymbol: string): Promise<string> {
    let price: unknown;
    try {
      price = (await this._publicGet("/fapi/v3/ticker/price", { symbol: apiSymbol }) as { price?: unknown })?.price;
    } catch (e) {
      throw new PerpError("PRICE_STALE", `Aster ${apiSymbol} last price unavailable: ${e instanceof Error ? e.message : String(e)}`, { exchange: "aster" });
    }
    const str = typeof price === "number" ? String(price) : price;
    if (typeof str !== "string" || !(Number(str) > 0) || !Number.isFinite(Number(str))) {
      throw new PerpError("PRICE_STALE", `Aster ${apiSymbol} ticker/price returned no usable price (${String(price)})`, { exchange: "aster" });
    }
    return str;
  }

  // ── Withdraw (mainnet only): POST /fapi/v3/aster/user-withdraw ──

  /** Asset withdrawn by `withdraw`: `requested` (must be in capabilities.withdrawAssets), else withdrawAssets[0]. */
  private _withdrawAsset(requested?: string): string {
    const assets = asterVenue.capabilities?.withdrawAssets;
    if (assets === null || assets === undefined || assets.length === 0) throw new Error("aster venue definition declares no withdrawAssets");
    if (requested === undefined) return assets[0];
    const a = requested.toUpperCase();
    if (!assets.includes(a)) {
      throw new PerpError("INVALID_PARAMS", `Aster withdraws ${assets.join(" / ")} only (got "${requested}")`, { exchange: "aster", remediation: `Use --asset ${assets.join(" or --asset ")}` });
    }
    return a;
  }

  /**
   * Withdrawable perp balance + fee for the withdraw asset on `chain`
   * (POST /fapi/v3/aster/user-withdraw-info, signed by the API wallet). Read-only.
   */
  async withdrawLimits(chain: AsterFundsChain, asset?: string): Promise<AsterWithdrawLimits> {
    requireAsterFundsNetwork(this._testnet ? "testnet" : "mainnet", "withdraw");
    const raw = await this.signedRequest(this._baseUrl, "POST", "/fapi/v3/aster/user-withdraw-info", {});
    return parseAsterWithdrawLimits(raw, this._withdrawAsset(asset), ASTER_FUNDS_CHAINS[chain].chainId);
  }

  /** Deposit / withdraw history (POST /fapi/v3/aster/deposit-withdraw-history, signed by the API wallet). Read-only. */
  async depositWithdrawHistory(): Promise<unknown> {
    return this.signedRequest(this._baseUrl, "POST", "/fapi/v3/aster/deposit-withdraw-history", {});
  }

  /**
   * Withdraw the venue collateral (USDT) from the perp account to the account owner's OWN address
   * on BNB Chain (default) or Arbitrum. Two signatures (asterdex/api-docs
   * demo/aster-deposit-withdrawal.md, API-demo futures-v3-demo/58_withdrawEvm.js):
   *   1. `userSignature` — the master wallet's EIP-712 "Aster" Action over receiver / chain / token /
   *      amount / fee / nonce, recovered locally and compared to the account owner before sending;
   *   2. the V3 envelope signed by the API wallet, which must have canWithdraw (and an IP whitelist).
   * The fee and the maximum come from user-withdraw-info; the identical amount / fee strings go
   * into the signature and the request. Once the request left, an unreadable result is
   * ORDER_PENDING (never resubmit).
   */
  async withdraw(amount: string, destination: string, opts?: { assetId?: number; routeType?: number; chain?: AsterFundsChain; asset?: string }): Promise<AsterWithdrawResult> {
    requireAsterFundsNetwork(this._testnet ? "testnet" : "mainnet", "withdraw");
    if (opts?.assetId !== undefined || opts?.routeType !== undefined) {
      throw new PerpError("INVALID_PARAMS", "Aster withdraw takes no assetId/routeType (use --asset USDT|USDC and --chain bsc|arbitrum)");
    }
    const chain: AsterFundsChain = opts?.chain === undefined ? "bsc" : opts.chain;
    const pins = ASTER_FUNDS_CHAINS[chain];
    const asset = this._withdrawAsset(opts?.asset);
    const r = this._resolveSigner();
    if (this._agentMeta === undefined || this._agentMeta.permissions.canWithdraw !== true) {
      throw new PerpError("POLICY_DENIED", "The active Aster API wallet was approved without the withdraw permission", {
        exchange: "aster",
        remediation: "Re-approve it with withdraw + a mandatory IP whitelist: perp wallet agent approve aster --can-withdraw --ip-whitelist <your public ip> --rotate — or withdraw in the Aster web app",
      });
    }
    const user = r.userAddress;
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination) || destination.toLowerCase() !== user.toLowerCase()) {
      throw new PerpError("INVALID_PARAMS", `Aster only withdraws to the account's own address ${user} (got "${destination}")`, {
        exchange: "aster", remediation: `Omit --to (defaults to ${user})`,
      });
    }
    const master = this._masterSigner ?? this._pkSigner;
    if (master === undefined) {
      throw new PerpError("NO_SIGNER_AVAILABLE", "Aster withdraw needs the master wallet to sign the withdraw message; only the API wallet is loaded", {
        exchange: "aster", remediation: "Run with the master wallet: perp --ows <wallet> funds withdraw aster <amount> — or withdraw in the Aster web app",
      });
    }
    if (master.getAddress().toLowerCase() !== user.toLowerCase()) {
      throw new PerpError("INVALID_PARAMS", `The loaded master wallet ${master.getAddress()} is not the Aster account owner ${user}`, {
        exchange: "aster", remediation: "Select the wallet that owns the Aster account (--ows <wallet>)",
      });
    }

    const limits = await this.withdrawLimits(chain, asset);
    assertAsterWithdrawAmount(amount, limits, asset);

    const userNonce = (BigInt(Date.now()) * 1000n).toString();
    const typed = buildWithdrawTypedData({
      chainId: pins.chainId, chainName: pins.withdrawChainName, receiver: user, asset, amount, fee: limits.fee, userNonce,
    });
    let userSignature: string;
    try {
      userSignature = await master.signTypedData(
        typed.domain as Record<string, unknown>,
        typed.types as unknown as Record<string, Array<{ name: string; type: string }>>,
        typed.message,
      );
    } catch (e) {
      throw orderNotSent("aster", "withdraw", e);
    }
    assertAsterWithdrawSignature(typed, userSignature, user);

    const path = "/fapi/v3/aster/user-withdraw";
    const raw = await this._perpWrite(`POST ${path}`, () => this._signedPostTo(this._baseUrl, path, {
      chainId: String(pins.chainId), asset, amount, fee: limits.fee, receiver: user, userNonce, userSignature,
    }, r));
    const res = (raw !== null && typeof raw === "object" ? raw : {}) as { withdrawId?: unknown; hash?: unknown };
    if (typeof res.withdrawId !== "string" && typeof res.withdrawId !== "number") {
      // 2xx without the documented withdrawId: the request was accepted on the wire — outcome unknown.
      throw orderOutcomeUnknown("aster", `POST ${path}`, new Error(`unrecognized response ${JSON.stringify(raw).slice(0, 160)}`),
        "Do NOT resubmit — the withdrawal may have been accepted. Check the Aster app → Assets → History");
    }
    return {
      withdrawId: String(res.withdrawId), hash: typeof res.hash === "string" ? res.hash : "",
      chain, chainId: pins.chainId, asset, amount, fee: limits.fee, receiver: user,
    };
  }

  // ── Private: signer resolution ────────────────────────────────────────────

  /**
   * Resolve the active signer per the three-tier policy.
   *
   * Exposed (leading underscore) for unit-test access only — do not call
   * from production code outside this class.
   */
  _resolveSigner(): ResolvedSigner {
    // Tier 1: agent (when registered, not expired, --no-agent NOT set)
    if (!this._useNoAgent && this._agentSigner && this._agentMeta) {
      // An expired agent record is an explicit error — never a fall-through to the master tier
      // (as on Hyperliquid / Pacifica; the master cannot sign Aster requests anyway).
      if (isExpired(this._agentMeta)) {
        throw new PerpError("AGENT_EXPIRED", `Aster agent wallet ${this._agentMeta.agentEvmAddress} expired at ${this._agentMeta.expiresAt}`, {
          exchange: "aster",
          remediation: "perp wallet agent approve aster --rotate",
        });
      }
      return {
        tier: "agent",
        signer: this._agentSigner,
        signerAddress: this._agentMeta.agentEvmAddress,
        userAddress: this._agentMeta.userEvmAddress,
      };
    }

    // Tier 2/3: master self-signing is not supported by the venue. Per Aster
    // V3 spec the `signer` field MUST be a registered API_WALLET (agent);
    // sending `user==signer==master` is rejected with
    // `code:-1000 msg:"Signature check failed"` even though the EIP-712
    // envelope is well-formed. SSOT Rule #2: throw with remediation rather
    // than silently dispatching a request the venue will reject.
    //
    // Reference: HypurrQuant_FE AsterPerpAdapter.ts throws if agent isn't
    // configured; never attempts master self-signing.
    if (this._masterSigner || this._pkSigner) {
      throw new PerpError(
        "NOT_IMPLEMENTED",
        "Aster requires a registered agent — master self-signing is not supported by venue",
        {
          remediation: "perp wallet agent approve aster --master <wallet>",
        },
      );
    }

    // No signer at any tier
    throw new PerpError(
      "NO_SIGNER_AVAILABLE",
      "No signing path configured for Aster",
      {
        remediation: "Run one of: (a) perp wallet agent approve aster --master <wallet>; (b) perp wallet generate && perp -e aster --ows <wallet>; (c) export ASTER_PRIVATE_KEY=0x...",
      },
    );
  }

  // ── Private: nonce ────────────────────────────────────────────────────────

  /** Monotonic µs nonce per signer, persisted across processes (aster-nonce.ts). */
  private _nextNonce(signer: string): string {
    return nextAsterNonce(signer);
  }

  // ── Private: EIP-712 signed HTTP helpers ─────────────────────────────────

  /**
   * Build the canonical signed-request URL per Aster v3 spec.
   *
   * Reference: https://github.com/asterdex/api-docs (V3, EN, send_by_url).
   * The Python reference adds keys to the dict in this exact order:
   *   nonce, user, signer
   * then URL-encodes the dict to form the EIP-712 `msg`. After signing,
   * `&signature=` is appended to the same query string. Authority verification
   * reconstructs `msg` from the URL query params minus `signature`, so the
   * signed dict and the URL query string must be byte-identical except for
   * the appended signature.
   *
   * Both `user` and `signer` are ALWAYS emitted as distinct query fields.
   * In production (Tier 1 only), `user` is the master and `signer` is the
   * registered agent address. Aster's authority server checks both fields.
   *
   * `signatureChainId` is NOT a v3 parameter — it's an artifact of an older
   * scheme; including it breaks signature verification on every call.
   *
   * Exposed (with leading underscore) for unit-test access only — do not call
   * from production code outside this class.
   */
  async _buildSignedQueryString(
    params: Record<string, string | number | boolean>,
    resolved: ResolvedSigner,
  ): Promise<string> {
    // Insertion order (matches Python reference: nonce, user, signer last).
    const fullParams: Record<string, string | number | boolean> = {
      ...params,
      nonce: this._nextNonce(resolved.signerAddress),
      user: resolved.userAddress,
      signer: resolved.signerAddress,
    };

    const typed = buildOrderTypedData(fullParams, this._testnet);

    // Sign via the appropriate signer type
    const sigRaw = await (resolved.signer as AgentSigningStrategy & EvmSigner).signTypedData(
      typed.domain as Record<string, unknown>,
      typed.types as unknown as Record<string, Array<{ name: string; type: string }>>,
      typed.message as Record<string, unknown>,
    );

    // Normalize: AgentSigningStrategy returns { signature, r, s, v }; EvmSigner returns string
    const sigHex = typeof sigRaw === "string" ? sigRaw : (sigRaw as { signature: string }).signature;

    // typed.message.msg is the URL-encoded dict in the same order; reuse it
    // to guarantee the byte-identical query string is sent on the wire.
    return `${typed.message.msg}&signature=${sigHex}`;
  }

  /**
   * Sign and POST to a path using EIP-712 Domain B.
   */
  private async _signedPostEip712(
    path: string,
    params: Record<string, string | number | boolean>,
    resolved: ResolvedSigner,
  ): Promise<unknown> {
    return this._perpWrite(`POST ${path}`, () => this._signedPostTo(this._baseUrl, path, params, resolved), path === "/fapi/v3/order");
  }

  /**
   * A perp account WRITE (order / modify / cancel / margin type / leverage). Once the request is
   * on the wire, a transport failure, an HTTP 5xx or an unreadable 2xx body leaves the outcome
   * unknown → ORDER_PENDING (never the retryable EXCHANGE_ERROR / EXCHANGE_UNREACHABLE); no
   * connection at all → not sent. Venue refusals (4xx, error envelopes) pass through unchanged.
   */
  private async _perpWrite(what: string, send: () => Promise<unknown>, orderPlacement = false): Promise<unknown> {
    try {
      return await send();
    } catch (e) {
      if (e instanceof PerpError) {
        const d = e.structured.details;
        const http = typeof d?.httpStatus === "number" ? d.httpStatus : null;
        if (d?.responseUnreadable === true || (http !== null && http >= 500)) throw orderOutcomeUnknown("aster", what, e);
        // Order placement / modify: a documented 4xx business code is a definite refusal (asterOrderRejection).
        throw orderPlacement ? asterOrderRejection(e) : e;
      }
      throw isTransportFailure(e) ? sendFailure("aster", what, e) : e;
    }
  }

  /** Sign and POST (or PUT) to `host + path` (perp `fapi` or spot `sapi` — same Domain B signing). */
  private async _signedPostTo(
    host: string,
    path: string,
    params: Record<string, string | number | boolean>,
    resolved: ResolvedSigner,
    method: "POST" | "PUT" = "POST",
  ): Promise<unknown> {
    let qs: string;
    try {
      qs = await this._buildSignedQueryString(params, resolved);
    } catch (e) {
      // Signing failed before the request was sent: definitely not placed (never ORDER_PENDING).
      throw orderNotSent("aster", `${method} ${path}`, e);
    }
    const url = `${host}${path}?${qs}`;
    // Any order write (place / modify) makes the open-orders snapshot stale — before and after the request.
    this.invalidateOpenOrdersCache();
    try {
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      });
      return await this._handleAsterResponse(res, method, path);
    } finally {
      this.invalidateOpenOrdersCache();
    }
  }

  /**
   * Sign and GET from a path using EIP-712 Domain B.
   *
   * Unlike public GETs, signed GETs route through _handleAsterResponse so
   * venue JSON error envelopes ({code, msg}) are not silently treated as
   * success (SSOT Rule #2).
   *
   * Retries up to 3 attempts with exponential backoff (2s/4s/8s) on HTTP 429
   * rate-limit. Each retry rebuilds a fresh signed query string (new nonce
   * + signature) — Aster reuses recent nonces strictly, so reusing a stale
   * one would itself be rejected. Non-429 venue errors throw immediately.
   */
  private async _signedGetEip712(
    path: string,
    params: Record<string, string | number | boolean>,
    resolved: ResolvedSigner,
  ): Promise<unknown> {
    return this._signedRequestWithRetry(this._baseUrl, "GET", path, params, resolved);
  }

  /**
   * Sign and DELETE from a path using EIP-712 Domain B.
   * Same retry behavior as _signedGetEip712.
   */
  private async _signedDeleteEip712(
    path: string,
    params: Record<string, string | number | boolean>,
    resolved: ResolvedSigner,
  ): Promise<unknown> {
    return this._perpWrite(`DELETE ${path}`, () => this._signedRequestWithRetry(this._baseUrl, "DELETE", path, params, resolved));
  }

  /** Shared GET/DELETE retry loop with fresh-nonce per attempt.
   *
   *  Total 4 attempts: initial + 3 retries with backoffs 2s, 4s, 8s.
   *  Codex v0.12.12 final QA #3: previously MAX_ATTEMPTS = 3 truncated the
   *  documented curve so the 8s backoff was never reachable in practice. */
  private async _signedRequestWithRetry(
    host: string,
    method: "GET" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean>,
    resolved: ResolvedSigner,
  ): Promise<unknown> {
    if (method === "DELETE") {
      // A cancel makes the open-orders snapshot stale — before and after the request.
      this.invalidateOpenOrdersCache();
      try {
        return await this._signedRequestLoop(host, method, path, params, resolved);
      } finally {
        this.invalidateOpenOrdersCache();
      }
    }
    return this._signedRequestLoop(host, method, path, params, resolved);
  }

  private async _signedRequestLoop(
    host: string,
    method: "GET" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean>,
    resolved: ResolvedSigner,
  ): Promise<unknown> {
    const MAX_ATTEMPTS = 4;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Rebuild signed query string with fresh nonce on each attempt.
      const qs = await this._buildSignedQueryString(params, resolved);
      const url = `${host}${path}?${qs}`;
      const res = await fetch(url, method === "DELETE" ? { method: "DELETE" } : undefined);
      // 429 → backoff + retry. All other paths (including non-429 venue
      // errors wrapped in HTTP 200 with code≠0) throw immediately via
      // _handleAsterResponse — no silent fallback (Rule #2).
      if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
        const backoffMs = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      try {
        return await this._handleAsterResponse(res, method, path);
      } catch (e) {
        lastErr = e;
        if (res.status === 429 && attempt < MAX_ATTEMPTS - 1) {
          const backoffMs = 2000 * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  // ── Private: HTTP response handling ──────────────────────────────────────

  /**
   * Unified response validator for ALL signed Aster requests.
   *
   * Validates BOTH HTTP status AND the venue JSON error envelope. Aster's
   * API commonly returns HTTP 200 + `{code, msg: "Signature check failed"}`
   * for signing or auth failures — checking only HTTP status would silently
   * accept these as success and cause callers (e.g., getBalance) to cache
   * zero balances or empty arrays. SSOT Rule #2: failures throw with
   * remediation; never substitute a default.
   *
   * Used by signed POST/GET/DELETE. Public unsigned GETs use _handleResponse.
   */
  private async _handleAsterResponse(res: Response, method: string, path: string): Promise<unknown> {
    if (res.status === 429) {
      // HTTP 429 = refused before processing: the request was definitely NOT executed
      // (details.sent === false → isDefiniteOrderFailure), and RATE_LIMITED stays retryable —
      // after Retry-After (carried as retryAfterMs when the venue sends it).
      const retryAfterSec = Number(res.headers.get("Retry-After"));
      throw new PerpError("RATE_LIMITED", `Aster ${method} ${path} rate limited (HTTP 429); nothing was executed`, {
        exchange: "aster", httpStatus: 429, sent: false,
        ...(Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? { retryAfterMs: retryAfterSec * 1000 } : {}),
        remediation: "Nothing was sent to the book. Wait and retry, or reduce request frequency",
      });
    }
    if (!res.ok) {
      const text = await res.text();
      // Aster returns non-2xx with a JSON {code, msg} body for venue errors (e.g. HTTP 401
      // -2015 / -1002). Carry the venue code so callers (spot permission mapping) can key on it.
      let venueCode: string | number | null = null;
      try {
        const j = JSON.parse(text) as { code?: unknown };
        if (typeof j.code === "string" || typeof j.code === "number") venueCode = j.code;
      } catch {
        // Non-JSON body (HTML error page): no venue code — the HTTP status + text are reported.
      }
      const s = classifyError(new Error(`${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`), "aster");
      if (res.status >= 500) {
        // A 5xx can arrive after the venue accepted the request: never a definite code
        // (substring classification could otherwise yield e.g. SIGNATURE_FAILED / INSUFFICIENT_BALANCE).
        throw new PerpError("EXCHANGE_ERROR", s.message, {
          exchange: "aster",
          httpStatus: res.status,
          ...(venueCode !== null ? { venueCode } : {}),
        });
      }
      throw new PerpError(s.code, s.message, {
        exchange: s.exchange,
        httpStatus: res.status,
        ...(venueCode !== null ? { venueCode } : {}),
        ...(s.remediation ? { remediation: s.remediation } : {}),
      });
    }
    // Parse JSON, then validate venue error envelope. Aster success returns an array
    // (e.g., GET /fapi/v3/openOrders, GET /fapi/v3/userTrades) or an object whose `code`
    // is absent or one of the documented success values (asterdex/api-docs):
    //   200      — futures/spot V3, e.g. Change Margin Type: {"code": 200, "msg": "success"}
    //   "200"    — futures V3 "Cancel All Open Orders (TRADE)":
    //              {"code": "200", "msg": "The operation of cancel all open order is done."}
    //   "000000" — bapi envelope (bapi/aster-bapi-en.md): {"code": "000000", "message": null, ...}
    // Anything else (incl. 0, which the docs only list as a WebSocket error code) is an error.
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // httpStatus + responseUnreadable: the request WAS accepted (2xx) — order callers map this to "pending".
      throw new PerpError("EXCHANGE_ERROR", `${method} ${path}: malformed JSON: ${text.slice(0, 200)}`, { exchange: "aster", httpStatus: res.status, responseUnreadable: true });
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const json = parsed as { code?: string | number; msg?: string };
      if (json.code !== undefined && json.code !== 200 && json.code !== "200" && json.code !== "000000") {
        const rawMsg = typeof json.msg === "string" ? json.msg : JSON.stringify(json);
        // Classify on the venue code AND the message: Aster's terse messages
        // ("This function can only be used after deposit.") are the only signal
        // for some codes, but the numeric code is the stable key — feed both so
        // a message reword upstream does not silently drop the mapping.
        const s = classifyError(new Error(`[${json.code}] ${rawMsg}`), "aster");
        throw new PerpError(s.code, rawMsg, {
          exchange: s.exchange,
          venueCode: json.code,
          ...(s.remediation ? { remediation: s.remediation } : {}),
        });
      }
    }
    return parsed;
  }

  /** Handle 429 rate limit with retry — used by public unsigned GET multi-attempt loops */
  private async _handleResponse(res: Response, method: string, path: string, attempt = 0): Promise<unknown> {
    if (res.status === 429) {
      if (attempt >= 2) throw new Error(`${method} ${path} rate limited after ${attempt + 1} attempts`);
      const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
      const waitMs = Math.min(retryAfter * 1000, 30000);
      await new Promise(r => setTimeout(r, waitMs));
      return null; // signal retry
    }
    if (!res.ok) {
      const text = await res.text();
      const clean = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      // -1121 BAD_SYMBOL ("Invalid symbol.", live on /fapi/v3/depth for an unlisted symbol): the
      // symbol does not exist — SYMBOL_NOT_FOUND, not an UNKNOWN 500.
      if (asterErrorCode(text) === -1121) {
        throw new PerpError("SYMBOL_NOT_FOUND", `Aster: ${clean} [${method} ${path}]`, { exchange: "aster", remediation: "List markets: perp -e aster market list" });
      }
      throw new Error(`${method} ${path} failed (${res.status}): ${clean}`);
    }
    return res.json();
  }

  private async _publicGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const url = `${this._baseUrl}${path}${qs ? `?${qs}` : ""}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url);
      const result = await this._handleResponse(res, "GET", path, attempt);
      // A parameter rejection arrives as HTTP 200 with an error body (live 2026-10-19,
      // fundingRate limit=1001: {"status":"ERROR","type":"VALID","code":"000002","errorData":{"limit":"…"}}).
      if (result !== null && typeof result === "object" && !Array.isArray(result) && (result as { status?: unknown }).status === "ERROR") {
        const r = result as { type?: unknown; code?: unknown; errorData?: unknown };
        const detail = JSON.stringify(r.errorData ?? r).slice(0, 200);
        throw new PerpError(r.type === "VALID" ? "INVALID_PARAMS" : "EXCHANGE_ERROR", `Aster ${path} rejected the request: ${detail}`, {
          exchange: "aster", venueCode: r.code, remediation: "Check the request parameters (e.g. --limit 1..1000)",
        });
      }
      if (result !== null) return result;
    }
    throw new Error(`GET ${path} failed: max retries exceeded`);
  }
}
