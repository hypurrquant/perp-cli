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

import type {
  ExchangeAdapter,
  ExchangeMarketInfo,
  ExchangePosition,
  ExchangeOrder,
  ExchangeBalance,
  ExchangeTrade,
  ExchangeFundingPayment,
  ExchangeKline,
} from "./interface.js";
import type { EvmSigner } from "../signer/interface.js";
import type { AgentMeta } from "../settings.js";
import type { AgentSigningStrategy } from "../agent-wallet/signing-strategy.js";
import { isExpired } from "../agent-wallet/expiry.js";
import { classifyError, PerpError } from "../errors.js";
import { buildOrderTypedData } from "./aster-typed-data.js";

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
  private _accountCache: { data: unknown; time: number } | null = null;
  private _positionsCache: { data: unknown; time: number } | null = null;
  private _ordersCache: { data: unknown; time: number } | null = null;
  private static readonly CACHE_TTL = 30_000;
  private static readonly ACCOUNT_CACHE_TTL = 5_000;

  // Nonce counter — ensures microsecond-precision uniqueness within process
  private _nonceCounter = 0;

  constructor(privateKey?: string, testnet = false) {
    this._testnet = testnet;
    this._baseUrl = testnet
      ? (process.env.ASTER_TESTNET_URL || "https://testnet.asterdex.com")
      : "https://fapi.asterdex.com";
    if (privateKey) {
      this._pendingPk = privateKey;
    }
  }

  // ── Lifecycle ──

  async init(): Promise<void> {
    // Verify connectivity by fetching server time
    await this._publicGet("/fapi/v1/time");

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

  /** Get funding interval for a symbol (lazy bootstrap). */
  async getFundingHours(symbol: string): Promise<number | undefined> {
    const key = symbol.toUpperCase();
    const cached = this._fundingHoursCache.get(key);
    if (cached !== undefined) return cached;

    try {
      const apiSym = this._toApi(key);
      const data = await this._publicGet("/fapi/v1/fundingRate", { symbol: apiSym, limit: "2" }) as Array<{ fundingTime: number }>;
      if (Array.isArray(data) && data.length >= 2) {
        const hours = Math.abs(data[1].fundingTime - data[0].fundingTime) / 3600000;
        const rounded = hours <= 1.5 ? 1 : hours <= 5 ? 4 : 8;
        this._fundingHoursCache.set(key, rounded);
        return rounded;
      }
    } catch { /* non-critical */ }

    return undefined;
  }

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    if (this._marketsCache && Date.now() - this._marketsCacheTime < AsterAdapter.CACHE_TTL) {
      return this._marketsCache;
    }

    const [info, tickers] = await Promise.all([
      this._publicGet("/fapi/v1/exchangeInfo") as Promise<{ symbols?: Array<Record<string, unknown>> }>,
      this._publicGet("/fapi/v1/ticker/24hr") as Promise<Array<Record<string, unknown>>>,
    ]);

    const tickerMap = new Map<string, Record<string, unknown>>();
    for (const t of tickers ?? []) {
      tickerMap.set(String(t.symbol), t);
    }

    let premiumMap = new Map<string, Record<string, unknown>>();
    try {
      const premiums = await this._publicGet("/fapi/v1/premiumIndex") as Array<Record<string, unknown>>;
      premiumMap = new Map(premiums.map(p => [String(p.symbol), p]));
    } catch { /* non-critical */ }

    const tradingSymbols = (info?.symbols ?? [])
      .filter((s) => String(s.contractType) === "PERPETUAL" && String(s.status) === "TRADING");

    const result = tradingSymbols.map((s) => {
      const sym = String(s.symbol);
      const ticker = tickerMap.get(sym);
      const premium = premiumMap.get(sym);
      const maxLev = Number(s.maxLeverage ?? 50);

      const lotFilter = (s.filters as Array<Record<string, unknown>> | undefined)
        ?.find(f => f.filterType === "LOT_SIZE");

      const fundingHours = this._fundingHoursCache.get(this._fromApi(sym));

      return {
        symbol: this._fromApi(sym),
        markPrice: String(premium?.markPrice ?? ticker?.lastPrice ?? "0"),
        indexPrice: String(premium?.indexPrice ?? "0"),
        fundingRate: premium?.lastFundingRate != null ? String(premium.lastFundingRate) : null,
        volume24h: String(ticker?.quoteVolume ?? ticker?.volume ?? "0"),
        openInterest: "0",
        maxLeverage: maxLev,
        sizeDecimals: s.quantityPrecision != null ? Number(s.quantityPrecision) : undefined,
        stepSize: lotFilter?.stepSize != null ? String(lotFilter.stepSize) : undefined,
        fundingHours,
      };
    });

    this._marketsCache = result;
    this._marketsCacheTime = Date.now();
    return result;
  }

  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const res = await this._publicGet("/fapi/v1/depth", { symbol: this._toApi(symbol), limit: "50" }) as {
      bids?: [string, string][];
      asks?: [string, string][];
    };
    return {
      bids: res?.bids ?? [],
      asks: res?.asks ?? [],
    };
  }

  async getRecentTrades(symbol: string, limit = 20): Promise<ExchangeTrade[]> {
    const trades = await this._publicGet("/fapi/v1/trades", {
      symbol: this._toApi(symbol),
      limit: String(limit),
    }) as Array<Record<string, unknown>>;

    return (trades ?? []).map((t) => ({
      time: Number(t.time ?? 0),
      symbol: this._fromApi(String(t.symbol ?? symbol)),
      side: t.isBuyerMaker ? "sell" as const : "buy" as const,
      price: String(t.price ?? "0"),
      size: String(t.qty ?? "0"),
      fee: "0",
    }));
  }

  async getFundingHistory(symbol: string, limit = 10): Promise<{ time: number; rate: string; price: string | null }[]> {
    const data = await this._publicGet("/fapi/v1/fundingRate", {
      symbol: this._toApi(symbol),
      limit: String(limit),
    }) as Array<Record<string, unknown>>;

    return (data ?? []).map((d) => ({
      time: Number(d.fundingTime ?? 0),
      rate: String(d.fundingRate ?? "0"),
      price: d.markPrice ? String(d.markPrice) : null,
    }));
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const data = await this._publicGet("/fapi/v1/klines", {
      symbol: this._toApi(symbol),
      interval,
      startTime: String(startTime),
      endTime: String(endTime),
      limit: "500",
    }) as Array<unknown[]>;

    return (data ?? []).map((k) => ({
      time: Number(k[0]),
      open: String(k[1]),
      high: String(k[2]),
      low: String(k[3]),
      close: String(k[4]),
      volume: String(k[5]),
      trades: Number(k[8] ?? 0),
    }));
  }

  // ── Account ──

  async getBalance(): Promise<ExchangeBalance> {
    if (this._accountCache && Date.now() - this._accountCache.time < AsterAdapter.ACCOUNT_CACHE_TTL) {
      return this._accountCache.data as ExchangeBalance;
    }
    const r = this._resolveSigner();
    // v3: /fapi/v2/account is HMAC-only; v3 EIP-712 uses /fapi/v3/accountWithJoinMargin.
    const account = await this._signedGetEip712("/fapi/v3/accountWithJoinMargin", {}, r) as Record<string, unknown>;

    const totalWallet = Number(account.totalWalletBalance ?? 0);
    const unrealizedPnl = Number(account.totalUnrealizedProfit ?? 0);
    const available = Number(account.availableBalance ?? 0);
    const marginUsed = Number(account.totalInitialMargin ?? 0);

    const result = {
      equity: String(totalWallet + unrealizedPnl),
      available: String(available),
      marginUsed: String(marginUsed),
      unrealizedPnl: String(unrealizedPnl),
    };
    this._accountCache = { data: result, time: Date.now() };
    return result;
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (this._positionsCache && Date.now() - this._positionsCache.time < AsterAdapter.ACCOUNT_CACHE_TTL) {
      return this._positionsCache.data as ExchangePosition[];
    }
    const r = this._resolveSigner();
    // v3: /fapi/v2/positionRisk has no v3 equivalent. Positions live inside
    // /fapi/v3/accountWithJoinMargin under `positions`. Mark price + liquidation
    // price are NOT included there — fetch from the public premiumIndex.
    const account = await this._signedGetEip712("/fapi/v3/accountWithJoinMargin", {}, r) as Record<string, unknown>;
    const positions = (account.positions as Array<Record<string, unknown>> | undefined) ?? [];

    const open = positions.filter((p) => Number(p.positionAmt ?? 0) !== 0);

    // Fetch mark prices for the open symbols (best-effort; non-fatal on failure)
    const markMap = new Map<string, string>();
    if (open.length > 0) {
      try {
        const premiums = await this._publicGet("/fapi/v1/premiumIndex") as Array<Record<string, unknown>>;
        for (const p of premiums ?? []) {
          markMap.set(String(p.symbol), String(p.markPrice ?? "0"));
        }
      } catch { /* non-critical */ }
    }

    const result = open.map((p) => {
      const amt = Number(p.positionAmt ?? 0);
      const apiSym = String(p.symbol ?? "");
      return {
        symbol: this._fromApi(apiSym),
        side: amt > 0 ? "long" as const : "short" as const,
        size: String(Math.abs(amt)),
        entryPrice: String(p.entryPrice ?? "0"),
        markPrice: markMap.get(apiSym) ?? "0",
        liquidationPrice: "0", // v3 accountWithJoinMargin does not expose this
        unrealizedPnl: String(p.unrealizedProfit ?? "0"),
        leverage: Number(p.leverage ?? 1),
      };
    });
    this._positionsCache = { data: result, time: Date.now() };
    return result;
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    if (this._ordersCache && Date.now() - this._ordersCache.time < AsterAdapter.ACCOUNT_CACHE_TTL) {
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
    }));
    this._ordersCache = { data: result, time: Date.now() };
    return result;
  }

  async getOrderHistory(limit = 30): Promise<ExchangeOrder[]> {
    const positions = await this.getPositions();
    const apiSymbols = new Set(positions.map(p => this._toApi(p.symbol)));
    if (apiSymbols.size === 0) {
      for (const s of ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]) {
        apiSymbols.add(s);
      }
    }

    const r = this._resolveSigner();
    const allOrders: ExchangeOrder[] = [];
    for (const sym of apiSymbols) {
      try {
        const orders = await this._signedGetEip712("/fapi/v3/allOrders", {
          symbol: sym,
          limit: String(limit),
        }, r) as Array<Record<string, unknown>>;

        for (const o of orders ?? []) {
          allOrders.push({
            orderId: String(o.orderId ?? ""),
            symbol: this._fromApi(String(o.symbol ?? "")),
            side: String(o.side).toLowerCase() as "buy" | "sell",
            price: String(o.price ?? "0"),
            size: String(o.origQty ?? "0"),
            filled: String(o.executedQty ?? "0"),
            status: String(o.status ?? ""),
            type: String(o.type ?? ""),
          });
        }
      } catch { /* skip */ }
    }
    return allOrders.slice(0, limit);
  }

  async getTradeHistory(limit = 30): Promise<ExchangeTrade[]> {
    const positions = await this.getPositions();
    const apiSymbols = new Set(positions.map(p => this._toApi(p.symbol)));
    if (apiSymbols.size === 0) apiSymbols.add("BTCUSDT");

    const r = this._resolveSigner();
    const allTrades: ExchangeTrade[] = [];
    for (const sym of apiSymbols) {
      try {
        const trades = await this._signedGetEip712("/fapi/v3/userTrades", {
          symbol: sym,
          limit: String(limit),
        }, r) as Array<Record<string, unknown>>;

        for (const t of trades ?? []) {
          allTrades.push({
            time: Number(t.time ?? 0),
            symbol: this._fromApi(String(t.symbol ?? "")),
            side: t.buyer ? "buy" as const : "sell" as const,
            price: String(t.price ?? "0"),
            size: String(t.qty ?? "0"),
            fee: String(t.commission ?? "0"),
          });
        }
      } catch { /* skip */ }
    }
    return allTrades.sort((a, b) => b.time - a.time).slice(0, limit);
  }

  async getFundingPayments(limit = 200): Promise<ExchangeFundingPayment[]> {
    const r = this._resolveSigner();
    const data = await this._signedGetEip712("/fapi/v3/income", {
      incomeType: "FUNDING_FEE",
      limit: String(limit),
    }, r) as Array<Record<string, unknown>>;

    return (data ?? []).map((f) => ({
      time: Number(f.time ?? 0),
      symbol: this._fromApi(String(f.symbol ?? "")),
      payment: String(f.income ?? "0"),
    }));
  }

  // ── Trading ──

  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts?: { reduceOnly?: boolean }): Promise<unknown> {
    const r = this._resolveSigner();
    const apiSymbol = this._toApi(symbol);
    const params: Record<string, string | number | boolean> = {
      symbol: apiSymbol,
      side: side.toUpperCase(),
      type: "MARKET",
      quantity: size,
    };
    if (opts?.reduceOnly) params.reduceOnly = "true";

    const result = await this._signedPostEip712("/fapi/v3/order", params, r);
    const ro = result as Record<string, unknown>;
    const executedQty = Number(ro.executedQty ?? 0);
    const orderId = String(ro.orderId ?? "");

    if (executedQty > 0 && ro.status === "FILLED") return result;

    if (ro.status === "NEW" && orderId) {
      for (let i = 0; i < 3; i++) {
        await new Promise(res => setTimeout(res, 1000));
        try {
          const check = await this._signedGetEip712("/fapi/v3/order", {
            symbol: apiSymbol,
            orderId,
          }, r) as Record<string, unknown>;
          const filledQty = Number(check.executedQty ?? 0);
          if (filledQty > 0) return check;
          if (check.status === "CANCELED" || check.status === "EXPIRED" || check.status === "REJECTED") {
            throw new Error(`Market ${side} ${symbol}: order ${check.status} (orderId: ${orderId})`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("Market ")) throw e;
        }
      }
      try {
        await this._signedDeleteEip712("/fapi/v3/order", { symbol: apiSymbol, orderId }, r);
      } catch { /* best effort cancel */ }
      throw new Error(`Market ${side} ${symbol}: order not filled after 3s, cancelled (orderId: ${orderId})`);
    }

    if (executedQty === 0) {
      throw new Error(`Market ${side} ${symbol}: order accepted but 0 filled (status: ${ro.status}, orderId: ${orderId})`);
    }
    return result;
  }

  async limitOrder(
    symbol: string,
    side: "buy" | "sell",
    price: string,
    size: string,
    opts?: { reduceOnly?: boolean; tif?: string },
  ): Promise<unknown> {
    const r = this._resolveSigner();
    const params: Record<string, string | number | boolean> = {
      symbol: this._toApi(symbol),
      side: side.toUpperCase(),
      type: "LIMIT",
      price,
      quantity: size,
      timeInForce: opts?.tif?.toUpperCase() || "GTC",
    };
    if (opts?.reduceOnly) params.reduceOnly = "true";
    return this._signedPostEip712("/fapi/v3/order", params, r);
  }

  async editOrder(symbol: string, orderId: string, price: string, size: string): Promise<unknown> {
    // Aster has no atomic edit — cancel + replace
    const openOrders = await this.getOpenOrders();
    const existing = openOrders.find(o => o.orderId === orderId);
    const side = existing?.side ?? "buy";

    await this.cancelOrder(symbol, orderId);
    return this.limitOrder(symbol, side, price, size);
  }

  async cancelOrder(symbol: string, orderId: string): Promise<unknown> {
    const r = this._resolveSigner();
    return this._signedDeleteEip712("/fapi/v3/order", {
      symbol: this._toApi(symbol),
      orderId,
    }, r);
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
      } catch { /* may fail if already set */ }
    }
    return this._signedPostEip712("/fapi/v3/leverage", {
      symbol: this._toApi(symbol),
      leverage: String(leverage),
    }, r);
  }

  async stopOrder(
    symbol: string,
    side: "buy" | "sell",
    size: string,
    triggerPrice: string,
    opts?: { limitPrice?: string; reduceOnly?: boolean },
  ): Promise<unknown> {
    const r = this._resolveSigner();
    const params: Record<string, string | number | boolean> = {
      symbol: this._toApi(symbol),
      side: side.toUpperCase(),
      quantity: size,
      stopPrice: triggerPrice,
      type: opts?.limitPrice ? "STOP" : "STOP_MARKET",
    };
    if (opts?.limitPrice) {
      params.price = opts.limitPrice;
      params.timeInForce = "GTC";
    }
    if (opts?.reduceOnly) params.reduceOnly = "true";
    return this._signedPostEip712("/fapi/v3/order", params, r);
  }

  // ── Withdraw (master-only: never delegates to agent or PK) ──

  async withdraw(amount: string, _destination: string, _opts?: { assetId?: number; routeType?: number }): Promise<unknown> {
    if (!this._masterSigner) {
      throw new PerpError(
        "NO_SIGNER_AVAILABLE",
        "Aster withdrawal requires OWS master wallet (--ows). Agent and PK signers cannot authorize withdrawals.",
        {
          remediation: "Use: perp -e aster --ows <walletName> funds withdraw",
        },
      );
    }
    // Aster withdrawal via spot/wallet API (not futures API) — not yet implemented.
    throw new Error("Aster withdrawal requires the spot API (not available in futures mode). Use the Aster web UI to withdraw.");
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
      if (isExpired(this._agentMeta)) {
        // Skip Tier 1 only if Tier 2/3 available; otherwise throw AGENT_EXPIRED
        if (!this._masterSigner && !this._pkSigner) {
          throw new PerpError("AGENT_EXPIRED", "Agent wallet has expired", {
            remediation: "perp wallet agent approve aster --rotate",
          });
        }
        // fall through to Tier 2/3
      } else {
        return {
          tier: "agent",
          signer: this._agentSigner,
          signerAddress: this._agentMeta.agentEvmAddress,
          userAddress: this._agentMeta.userEvmAddress,
        };
      }
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

  private _nextNonce(): string {
    const ms = Date.now() * 1000 + (++this._nonceCounter % 1000);
    return String(ms);
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
      nonce: this._nextNonce(),
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
    const qs = await this._buildSignedQueryString(params, resolved);
    const url = `${this._baseUrl}${path}?${qs}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });

    return this._handleAsterResponse(res, "POST", path);
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
    return this._signedRequestWithRetry("GET", path, params, resolved);
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
    return this._signedRequestWithRetry("DELETE", path, params, resolved);
  }

  /** Shared GET/DELETE retry loop with fresh-nonce per attempt. */
  private async _signedRequestWithRetry(
    method: "GET" | "DELETE",
    path: string,
    params: Record<string, string | number | boolean>,
    resolved: ResolvedSigner,
  ): Promise<unknown> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // Rebuild signed query string with fresh nonce on each attempt.
      const qs = await this._buildSignedQueryString(params, resolved);
      const url = `${this._baseUrl}${path}?${qs}`;
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
      const retryAfter = parseInt(res.headers.get("Retry-After") || "5", 10);
      await new Promise(r => setTimeout(r, Math.min(retryAfter * 1000, 30000)));
      throw new Error(`${method} ${path} rate limited`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const s = classifyError(new Error(`${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`), "aster");
      throw new PerpError(s.code, s.message, { exchange: s.exchange });
    }
    // Parse JSON, then validate venue error envelope. Aster success returns
    // either an object whose `code` is "000000"/200 (or absent) or an array
    // (e.g., GET /fapi/v3/openOrders, GET /fapi/v3/userTrades).
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new PerpError("EXCHANGE_ERROR", `${method} ${path}: malformed JSON: ${text.slice(0, 200)}`, { exchange: "aster" });
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      const json = parsed as { code?: string | number; msg?: string };
      if (json.code !== undefined && json.code !== "000000" && json.code !== 200 && json.code !== 0) {
        const rawMsg = typeof json.msg === "string" ? json.msg : JSON.stringify(json);
        const s = classifyError(new Error(rawMsg), "aster");
        throw new PerpError(s.code, s.message, { exchange: s.exchange });
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
      if (result !== null) return result;
    }
    throw new Error(`GET ${path} failed: max retries exceeded`);
  }
}
