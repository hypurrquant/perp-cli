/**
 * edgeX DEX adapter — StarkEx-based perpetual futures exchange.
 * Base: https://pro.edgex.exchange
 */

import { randomBytes } from "node:crypto";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { pedersen, Point } from "@scure/starknet";
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

// ── StarkEx ECDSA helpers ──

const EC_ORDER = Point.Fn.ORDER;
const MAX_STARK_VALUE = 1n << 251n;
const LIMIT_ORDER_WITH_FEES = 3n;
const ONE_HOUR_MS = 3_600_000;
const ORDER_EXPIRY_HOURS = 4320; // ~180 days

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const b of bytes) result = (result << 8n) | BigInt(b);
  return result;
}

function starkEcdsaSign(msgHash: bigint, privKey: bigint): { r: bigint; s: bigint } {
  const Fn = Point.Fn;
  for (let attempt = 0; attempt < 256; attempt++) {
    const kBig = bytesToBigInt(randomBytes(32)) % EC_ORDER;
    if (kBig === 0n) continue;
    const R = Point.BASE.multiply(kBig);
    const r = R.x;
    if (r === 0n || r >= MAX_STARK_VALUE) continue;
    const sum = (msgHash + (r * privKey) % EC_ORDER) % EC_ORDER;
    if (sum === 0n) continue;
    const w = (kBig * Fn.inv(sum)) % EC_ORDER;
    if (w === 0n || w >= MAX_STARK_VALUE) continue;
    const s = Fn.inv(w);
    return { r, s };
  }
  throw new Error("Failed to generate valid StarkEx ECDSA signature");
}

function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    if (value.length === 0) return "";
    return value.map((v) => serializeValue(v)).join("&");
  }
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${k}=${serializeValue((value as Record<string, unknown>)[k])}`)
      .join("&");
  }
  return String(value);
}

function buildSignContent(timestamp: string, method: string, path: string, params?: Record<string, unknown>): string {
  const m = method.toUpperCase();
  if (!params || Object.keys(params).length === 0) return `${timestamp}${m}${path}`;
  let paramStr: string;
  if (m === "GET") {
    paramStr = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
  } else {
    paramStr = serializeValue(params);
  }
  return `${timestamp}${m}${path}${paramStr}`;
}

// ── Contract metadata ──

interface ContractMeta {
  contractId: string;
  symbol: string;          // e.g. "BTCUSD"
  tickSize: string;
  stepSize: string;
  starkExSyntheticAssetId: string;
  starkExResolution: string;
  starkExCollateralAssetId: string;
  starkExCollateralResolution: string;
  maxLeverage: number;
}

// ── Adapter ──

export class EdgeXAdapter implements ExchangeAdapter {
  readonly name = "edgex";
  readonly chain = "starkex";
  readonly aliases = ["ex"] as const;

  private _accountId: string;
  private _starkPrivateKey: string;
  private _baseUrl = "https://pro.edgex.exchange";
  private _contracts = new Map<string, ContractMeta>();
  private _contractById = new Map<string, ContractMeta>();
  private _marketsCache: { data: ExchangeMarketInfo[]; ts: number } | null = null;
  private static CACHE_TTL = 60_000; // 60s cache

  constructor(accountId?: string, starkPrivateKey?: string) {
    this._accountId = accountId || process.env.EDGEX_ACCOUNT_ID || "";
    this._starkPrivateKey = starkPrivateKey || process.env.EDGEX_STARK_PRIVATE_KEY || "";
  }

  get isReadOnly(): boolean {
    return !this._accountId || !this._starkPrivateKey;
  }

  /** CLI symbol -> API symbol: ETH -> ETHUSD */
  private _toApi(symbol: string): string {
    const s = symbol.toUpperCase().replace(/-PERP$/, "");
    if (s.endsWith("USD") || s.endsWith("2USD")) return s;
    // Try exact USD suffix first, then 2USD (edgeX uses BNB2USD, XRP2USD, etc.)
    if (this._contracts.has(`${s}USD`)) return `${s}USD`;
    if (this._contracts.has(`${s}2USD`)) return `${s}2USD`;
    return `${s}USD`;
  }

  /** API symbol -> CLI symbol: ETHUSD -> ETH, DOGE2USD -> DOGE2 */
  private _fromApi(symbol: string): string {
    // BNB2USD → BNB, XRP2USD → XRP, BTCUSD → BTC, 1000PEPE2USD → 1000PEPE
    return symbol.replace(/2USD$/, "").replace(/USD$/, "");
  }

  private _getContract(symbol: string): ContractMeta {
    const apiSym = this._toApi(symbol);
    const c = this._contracts.get(apiSym);
    if (!c) throw new Error(`Unknown edgeX contract: ${symbol} (${apiSym})`);
    return c;
  }

  // ── Init ──

  async init(): Promise<void> {
    const res = (await this._publicGet("/api/v1/public/meta/getMetaData")) as {
      contractList?: Array<Record<string, unknown>>;
      global?: Record<string, unknown>;
    };
    const contracts = res?.contractList ?? [];
    for (const c of contracts) {
      const symbol = String(c.contractName ?? "");
      const meta: ContractMeta = {
        contractId: String(c.contractId ?? ""),
        symbol,
        tickSize: String(c.tickSize ?? "0.01"),
        stepSize: String(c.stepSize ?? "0.001"),
        starkExSyntheticAssetId: String(c.starkExSyntheticAssetId ?? ""),
        starkExResolution: String(c.starkExResolution ?? ""),
        starkExCollateralAssetId: String(c.starkExCollateralAssetId ?? ""),
        starkExCollateralResolution: String(c.starkExCollateralResolution ?? ""),
        maxLeverage: Number(c.maxLeverage ?? 20),
      };
      this._contracts.set(symbol, meta);
      this._contractById.set(meta.contractId, meta);
    }
  }

  // ── Market Data ──

  async getMarkets(): Promise<ExchangeMarketInfo[]> {
    // Return cached data if fresh
    if (this._marketsCache && Date.now() - this._marketsCache.ts < EdgeXAdapter.CACHE_TTL) {
      return this._marketsCache.data;
    }
    // edgeX requires contractId per ticker call (bulk returns empty).
    // Fetch top 5 popular + metadata-only for the rest to avoid Cloudflare rate limiting.
    const allContracts = [...this._contractById.values()];
    const TOP_IDS = ["10000001","10000002","10000003","10000004","10000005"]; // BTC,ETH,SOL,BNB,LTC
    const results: ExchangeMarketInfo[] = [];

    // Fetch real-time data for top contracts (sequential to avoid rate limit)
    for (const id of TOP_IDS) {
      const c = this._contractById.get(id);
      if (!c) continue;
      try {
        const [tArr, fArr] = await Promise.all([
          this._publicGet("/api/v1/public/quote/getTicker", { contractId: c.contractId }),
          this._publicGet("/api/v1/public/funding/getLatestFundingRate", { contractId: c.contractId }),
        ]);
        const t = (Array.isArray(tArr) ? tArr[0] : null) as Record<string, unknown> | null;
        const f = (Array.isArray(fArr) ? fArr[0] : null) as Record<string, unknown> | null;
        results.push({
          symbol: this._fromApi(c.symbol),
          markPrice: String(t?.lastPrice ?? t?.oraclePrice ?? "0"),
          indexPrice: String(t?.indexPrice ?? "0"),
          fundingRate: String(f?.fundingRate ?? "0"),
          volume24h: String(t?.value ?? "0"),
          openInterest: String(t?.openInterest ?? "0"),
          maxLeverage: c.maxLeverage,
        });
      } catch { /* skip on rate limit */ }
    }

    // Add remaining contracts with metadata only (no API calls)
    const fetched = new Set(results.map(r => r.symbol));
    for (const c of allContracts) {
      const sym = this._fromApi(c.symbol);
      if (fetched.has(sym)) continue;
      results.push({
        symbol: sym,
        markPrice: "0",
        indexPrice: "0",
        fundingRate: "0",
        volume24h: "0",
        openInterest: "0",
        maxLeverage: c.maxLeverage,
      });
    }

    this._marketsCache = { data: results, ts: Date.now() };
    return results;
  }

  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const c = this._getContract(symbol);
    const res = (await this._publicGet("/api/v1/public/quote/getDepth", {
      contractId: c.contractId,
      level: "15",
    })) as Array<{ bids?: Array<[string, string]>; asks?: Array<[string, string]> }>;
    const depth = Array.isArray(res) ? res[0] : res;
    return {
      bids: (depth as Record<string, unknown>)?.bids as [string, string][] ?? [],
      asks: (depth as Record<string, unknown>)?.asks as [string, string][] ?? [],
    };
  }

  async getRecentTrades(symbol: string, limit = 20): Promise<ExchangeTrade[]> {
    const c = this._getContract(symbol);
    const res = (await this._publicGet("/api/v1/public/quote/getKline", {
      contractId: c.contractId,
      klineType: "1",
      size: String(limit),
    })) as Array<Record<string, unknown>>;
    return (res as Array<Record<string, unknown>> ?? []).map((k) => ({
      time: Number(k.time ?? 0),
      symbol: this._fromApi(c.symbol),
      side: "buy" as const,
      price: String(k.close ?? "0"),
      size: String(k.volume ?? "0"),
      fee: "0",
    }));
  }

  async getFundingHistory(symbol: string, _limit = 10): Promise<{ time: number; rate: string; price: string | null }[]> {
    const c = this._getContract(symbol);
    const res = (await this._publicGet("/api/v1/public/funding/getLatestFundingRate")) as Array<Record<string, unknown>>;
    return (res ?? [])
      .filter((f) => String(f.contractId) === c.contractId)
      .map((f) => ({
        time: Number(f.fundingTime ?? Date.now()),
        rate: String(f.fundingRate ?? "0"),
        price: f.price ? String(f.price) : null,
      }));
  }

  async getKlines(symbol: string, _interval: string, _startTime: number, _endTime: number): Promise<ExchangeKline[]> {
    const c = this._getContract(symbol);
    const klineTypeMap: Record<string, string> = {
      "1m": "1", "5m": "5", "15m": "15", "30m": "30",
      "1h": "60", "4h": "240", "1d": "1440",
    };
    const klineType = klineTypeMap[_interval] ?? "60";
    const res = (await this._publicGet("/api/v1/public/quote/getKline", {
      contractId: c.contractId,
      klineType,
      size: "100",
    })) as Array<Record<string, unknown>>;
    return (res as Array<Record<string, unknown>> ?? []).map((k) => ({
      time: Number(k.time ?? 0),
      open: String(k.open ?? "0"),
      high: String(k.high ?? "0"),
      low: String(k.low ?? "0"),
      close: String(k.close ?? "0"),
      volume: String(k.volume ?? "0"),
      trades: 0,
    }));
  }

  // ── Account ──

  async getBalance(): Promise<ExchangeBalance> {
    const res = (await this._authGet("/api/v1/private/account/getAccountAsset", {
      accountId: this._accountId,
    })) as Record<string, unknown>;
    const d = res ?? {};
    const collaterals = (d.collateralAssetModelList ?? []) as Array<Record<string, unknown>>;
    const usdt = collaterals.find((c) => String(c.coinId) === "1000") ?? {};
    const totalEquity = String(d.totalEquity ?? (usdt as Record<string, unknown>).equity ?? "0");
    const available = String(d.available ?? (usdt as Record<string, unknown>).available ?? "0");
    const marginUsed = String(d.initialMargin ?? "0");
    const unrealizedPnl = String(d.unrealizedPnl ?? "0");
    return { equity: totalEquity, available, marginUsed, unrealizedPnl };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    const res = (await this._authGet("/api/v1/private/account/getAccountAsset", {
      accountId: this._accountId,
    })) as { positionList?: Array<Record<string, unknown>>; positionAssetList?: Array<Record<string, unknown>> };
    const positions = res?.positionList ?? [];
    const posAssets = res?.positionAssetList ?? [];
    const assetMap = new Map<string, Record<string, unknown>>();
    for (const pa of posAssets) assetMap.set(String(pa.contractId ?? ""), pa);

    return positions
      .filter((p) => Number(p.size ?? 0) !== 0)
      .map((p) => {
        const contractId = String(p.contractId ?? "");
        const meta = this._contractById.get(contractId);
        const pa = assetMap.get(contractId) ?? {};
        const size = Math.abs(Number(p.size ?? 0));
        const side = String(p.side ?? "").toUpperCase() === "SHORT" ? "short" as const : "long" as const;
        return {
          symbol: this._fromApi(meta?.symbol ?? ""),
          side,
          size: String(size),
          entryPrice: String(p.entryPrice ?? "0"),
          markPrice: String(p.markPrice ?? pa.markPrice ?? "0"),
          liquidationPrice: String(p.liquidationPrice ?? "0"),
          unrealizedPnl: String(p.unrealizedPnl ?? pa.unrealizedPnl ?? "0"),
          leverage: Number(p.leverage ?? 1),
        };
      });
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    const res = (await this._authGet("/api/v1/private/order/getActiveOrderPage", {
      accountId: this._accountId,
      size: "200",
    })) as { dataList?: Array<Record<string, unknown>> };
    return (res?.dataList ?? []).map((o) => ({
      orderId: String(o.orderId ?? ""),
      symbol: this._fromApi(this._contractById.get(String(o.contractId ?? ""))?.symbol ?? ""),
      side: String(o.side ?? "").toLowerCase() as "buy" | "sell",
      price: String(o.price ?? "0"),
      size: String(o.size ?? "0"),
      filled: String(o.filledSize ?? "0"),
      status: String(o.status ?? ""),
      type: String(o.type ?? ""),
    }));
  }

  async getOrderHistory(_limit = 30): Promise<ExchangeOrder[]> {
    // edgeX doesn't have a dedicated history endpoint easily; return open orders as fallback
    return this.getOpenOrders();
  }

  async getTradeHistory(_limit = 30): Promise<ExchangeTrade[]> {
    return [];
  }

  async getFundingPayments(_limit = 200): Promise<ExchangeFundingPayment[]> {
    return [];
  }

  // ── Trading ──

  async marketOrder(symbol: string, side: "buy" | "sell", size: string): Promise<unknown> {
    const c = this._getContract(symbol);
    // Fetch oracle price for L2 fields
    const ticker = (await this._publicGet("/api/v1/public/quote/getTicker", {
      contractId: c.contractId,
    })) as { data?: Record<string, unknown> };
    const oraclePrice = String(ticker?.data?.oraclePrice ?? ticker?.data?.lastPrice ?? "0");
    const worstPrice = side === "buy"
      ? String(Number(oraclePrice) * 1.05)
      : String(Number(oraclePrice) * 0.95);

    const l2Fields = this._computeL2OrderFields(c, side, worstPrice, size);
    return this._authPost("/api/v1/private/order/createOrder", {
      accountId: this._accountId,
      contractId: c.contractId,
      side: side.toUpperCase(),
      type: "MARKET",
      size,
      price: worstPrice,
      timeInForce: "IMMEDIATE_OR_CANCEL",
      ...l2Fields,
    });
  }

  async limitOrder(
    symbol: string,
    side: "buy" | "sell",
    price: string,
    size: string,
    opts?: { reduceOnly?: boolean; tif?: string },
  ): Promise<unknown> {
    const c = this._getContract(symbol);
    const l2Fields = this._computeL2OrderFields(c, side, price, size);
    return this._authPost("/api/v1/private/order/createOrder", {
      accountId: this._accountId,
      contractId: c.contractId,
      side: side.toUpperCase(),
      type: "LIMIT",
      size,
      price,
      timeInForce: opts?.tif?.toUpperCase() || "GOOD_TIL_CANCEL",
      reduceOnly: opts?.reduceOnly ? true : undefined,
      ...l2Fields,
    });
  }

  async editOrder(symbol: string, orderId: string, price: string, size: string): Promise<unknown> {
    const openOrders = await this.getOpenOrders();
    const existing = openOrders.find((o) => o.orderId === orderId);
    const side = existing?.side ?? "buy";
    await this.cancelOrder(symbol, orderId);
    return this.limitOrder(symbol, side, price, size);
  }

  async cancelOrder(_symbol: string, orderId: string): Promise<unknown> {
    return this._authPost("/api/v1/private/order/cancelOrderById", {
      accountId: this._accountId,
      orderIdList: [orderId],
    });
  }

  async cancelAllOrders(symbol?: string): Promise<unknown> {
    const body: Record<string, unknown> = { accountId: this._accountId };
    if (symbol) {
      const c = this._getContract(symbol);
      body.contractId = c.contractId;
    }
    return this._authPost("/api/v1/private/order/cancelAllOrder", body);
  }

  // ── Risk ──

  async setLeverage(symbol: string, leverage: number, _marginMode?: "cross" | "isolated"): Promise<unknown> {
    const c = this._getContract(symbol);
    return this._authPost("/api/v1/private/account/updateLeverageSetting", {
      accountId: this._accountId,
      contractId: c.contractId,
      leverage: String(leverage),
    });
  }

  async stopOrder(
    symbol: string,
    side: "buy" | "sell",
    size: string,
    triggerPrice: string,
    opts?: { limitPrice?: string; reduceOnly?: boolean },
  ): Promise<unknown> {
    const c = this._getContract(symbol);
    const price = opts?.limitPrice ?? triggerPrice;
    const l2Fields = this._computeL2OrderFields(c, side, price, size);
    return this._authPost("/api/v1/private/order/createOrder", {
      accountId: this._accountId,
      contractId: c.contractId,
      side: side.toUpperCase(),
      type: opts?.limitPrice ? "STOP_LIMIT" : "STOP_MARKET",
      size,
      price,
      triggerPrice,
      timeInForce: "GOOD_TIL_CANCEL",
      reduceOnly: opts?.reduceOnly ? true : undefined,
      ...l2Fields,
    });
  }

  async withdraw(_amount: string, _destination: string): Promise<unknown> {
    throw new Error("edgeX withdrawal not supported via API. Use the edgeX web UI.");
  }

  // ── L2 Order Signing (Pedersen hash chain + StarkEx ECDSA) ──

  private _computeL2OrderFields(
    contract: ContractMeta,
    side: "buy" | "sell",
    price: string,
    size: string,
  ): Record<string, string> {
    const syntheticResolution = BigInt(contract.starkExResolution || "1");
    const collateralResolution = BigInt(contract.starkExCollateralResolution || "1");
    const syntheticAssetId = contract.starkExSyntheticAssetId;
    const collateralAssetId = contract.starkExCollateralAssetId;

    const sizeNum = Math.abs(parseFloat(size));
    const priceNum = parseFloat(price);
    const quantumsAmountSynthetic = BigInt(Math.round(sizeNum * Number(syntheticResolution)));
    const quantumsAmountCollateral = BigInt(Math.round(sizeNum * priceNum * Number(collateralResolution)));
    const quantumsAmountFee = quantumsAmountCollateral / 1000n; // 0.1% fee cap

    const nonce = BigInt("0x" + randomBytes(4).toString("hex"));
    const expirationTimestamp = BigInt(Math.floor((Date.now() + ORDER_EXPIRY_HOURS * ONE_HOUR_MS) / ONE_HOUR_MS));

    let assetIdSell: string, assetIdBuy: string;
    let quantumsSell: bigint, quantumsBuy: bigint;
    if (side === "buy") {
      assetIdSell = collateralAssetId;
      assetIdBuy = syntheticAssetId;
      quantumsSell = quantumsAmountCollateral;
      quantumsBuy = quantumsAmountSynthetic;
    } else {
      assetIdSell = syntheticAssetId;
      assetIdBuy = collateralAssetId;
      quantumsSell = quantumsAmountSynthetic;
      quantumsBuy = quantumsAmountCollateral;
    }
    const feeAssetId = collateralAssetId;

    // Pedersen hash chain: hash(hash(hash(assetIdSell, assetIdBuy), feeAssetId), packed)
    const h0 = pedersen(BigInt(assetIdSell), BigInt(assetIdBuy));
    const h1 = pedersen(BigInt(h0), BigInt(feeAssetId));

    // Pack amounts: sell(63 bits) | buy(63 bits) | fee(63 bits) | nonce(32 bits)
    const packed1 = (quantumsSell << 64n) | quantumsBuy;
    const h2 = pedersen(BigInt(h1), packed1);

    // Pack: LIMIT_ORDER_WITH_FEES | positionId(64) | positionId(64) | positionId(64) | expirationTimestamp(32) | nonce(32)
    const positionId = BigInt(this._accountId || "0");
    const packed2 =
      (LIMIT_ORDER_WITH_FEES << 192n) |
      (positionId << 128n) |
      (positionId << 64n) |
      (positionId);
    const packed2Full = (packed2 << 64n) | (expirationTimestamp << 32n) | nonce;
    const h3Interim = pedersen(BigInt(h2), quantumsAmountFee);
    const msgHash = BigInt(pedersen(h3Interim, packed2Full));

    const privKeyRaw = this._starkPrivateKey.startsWith("0x")
      ? this._starkPrivateKey.slice(2)
      : this._starkPrivateKey;
    const privKeyBig = BigInt("0x" + privKeyRaw);
    const { r, s } = starkEcdsaSign(msgHash % EC_ORDER, privKeyBig);

    return {
      l2Nonce: nonce.toString(),
      l2ExpirationTimestamp: expirationTimestamp.toString(),
      l2SignatureR: "0x" + r.toString(16).padStart(64, "0"),
      l2SignatureS: "0x" + s.toString(16).padStart(64, "0"),
      l2QuantumsAmountSynthetic: quantumsAmountSynthetic.toString(),
      l2QuantumsAmountCollateral: quantumsAmountCollateral.toString(),
      l2QuantumsAmountFee: quantumsAmountFee.toString(),
    };
  }

  // ── Auth signing ──

  private _signRequest(method: string, path: string, params?: Record<string, unknown>): { timestamp: string; signature: string } {
    const timestamp = String(Date.now());
    const signContent = buildSignContent(timestamp, method, path, params);
    const hashBytes = keccak_256(new TextEncoder().encode(signContent));
    const msgHash = bytesToBigInt(hashBytes) % EC_ORDER;
    const privKeyRaw = this._starkPrivateKey.startsWith("0x")
      ? this._starkPrivateKey.slice(2)
      : this._starkPrivateKey;
    const privKeyBig = BigInt("0x" + privKeyRaw);
    const { r, s } = starkEcdsaSign(msgHash, privKeyBig);
    return {
      timestamp,
      signature:
        r.toString(16).padStart(64, "0") +
        s.toString(16).padStart(64, "0"),
    };
  }

  // ── HTTP helpers ──

  private async _publicGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const url = `${this._baseUrl}${path}${qs ? `?${qs}` : ""}`;

    // edgeX has Cloudflare protection that blocks Node.js fetch on /quote/ and /funding/ paths.
    // Use curl as fallback for those endpoints.
    let json: { code?: string; data?: unknown; msg?: string };
    try {
      const res = await fetch(url, {
        headers: { "Accept": "application/json", "User-Agent": "perp-cli/0.7.1" },
      });
      if (res.status === 403) throw new Error("cf-blocked");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = (await res.json()) as typeof json;
    } catch {
      // Fallback to curl (bypasses Cloudflare)
      const { execSync } = await import("node:child_process");
      const out = execSync(`curl -s '${url}'`, { encoding: "utf-8", timeout: 10_000 });
      json = JSON.parse(out);
    }

    if (json.code && json.code !== "0" && json.code !== "SUCCESS") {
      throw new Error(`${path}: ${json.msg ?? json.code}`);
    }
    return json.data;
  }

  private async _authGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
    if (this.isReadOnly) throw new Error("No credentials configured for edgeX. Set EDGEX_ACCOUNT_ID and EDGEX_STARK_PRIVATE_KEY.");
    const { timestamp, signature } = this._signRequest("GET", path, params);
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join("&");
    const url = `${this._baseUrl}${path}${qs ? `?${qs}` : ""}`;
    const res = await fetch(url, {
      headers: {
        "X-edgeX-Api-Timestamp": timestamp,
        "X-edgeX-Api-Signature": signature,
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { code?: string; data?: unknown; msg?: string };
    if (json.code && json.code !== "0" && json.code !== "SUCCESS") {
      throw new Error(`${path}: ${json.msg ?? json.code}`);
    }
    return json.data;
  }

  private async _authPost(path: string, body: Record<string, unknown>): Promise<unknown> {
    if (this.isReadOnly) throw new Error("No credentials configured for edgeX. Set EDGEX_ACCOUNT_ID and EDGEX_STARK_PRIVATE_KEY.");
    const { timestamp, signature } = this._signRequest("POST", path, body);
    const res = await fetch(`${this._baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-edgeX-Api-Timestamp": timestamp,
        "X-edgeX-Api-Signature": signature,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST ${path} failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { code?: string; data?: unknown; msg?: string };
    if (json.code && json.code !== "0" && json.code !== "SUCCESS") {
      throw new Error(`${path}: ${json.msg ?? json.code}`);
    }
    return json.data;
  }
}
