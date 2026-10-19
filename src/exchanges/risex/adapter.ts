/**
 * RISEx adapter — market data (public), account reads (public by address) and trading through the
 * registered, trading-only session signer (EIP-712 VerifyWitness permits; the server submits the
 * on-chain transaction and pays gas).
 *
 * Account address: the signer's account (agent meta), else the master wallet's address (reads
 * only, nothing is signed with it here). Writes need the signer.
 *
 * Order safety:
 *  - every refusal (market flags, maintenance, precision, pins) happens before a nonce is
 *    allocated or anything is signed;
 *  - every permit consumes a fresh (anchor, bit) pair that is persisted BEFORE the send, so a
 *    pair is never reused, even when the outcome is unknown;
 *  - a client order id is always attached (generated uint64 when the caller gives none);
 *  - an unknown send outcome → one read-only reconciliation (permit nonce consumed on-chain? the
 *    client order id in open orders / order history?) → a proven result carries notes
 *    ["reconciled"]; otherwise ORDER_PENDING ("do NOT resubmit") and the symbol is quarantined.
 *    The permit deadline is short (RISEX_PERMIT_TTL_S), so an unproven permit expires quickly.
 */

import { PerpError, extractErrorMessage } from "../../errors.js";
import { quarantineSymbol } from "../../bot/quarantine.js";
import type { RisexAgentMeta } from "../../settings.js";
import type { EvmSigner } from "../../signer/interface.js";
import type {
  ExchangeAdapter, ExchangeBalance, ExchangeFundingPayment, ExchangeKline, ExchangeMarketInfo, ExchangeOrder,
  ExchangePosition, ExchangeTrade, ExchangePublicTrade,
  FundingHistoryRow
} from "../interface.js";
import { assertCandleInterval } from "../interface.js";
import { alignProtectionPrice, exactUnits, mulDecimal, slippagePrice, subDecimal } from "../precision.js";
import type { ResolvedSlippage } from "../slippage.js";
import {
  newVenueClientOrderId, unsupported, validateLegacyTif, validateOrderRequest, type TradingV2,
} from "../trading-v2.js";
import type { VenueCapabilities, VenueCreateContext, VenueDefinition } from "../venue.js";
import { networkConfig, requireCapabilities, roleUnsupported } from "../venue.js";
import {
  parseOrderRef, toLegacyMarketInfo, withExecution,
  type AmendRequest, type CancelResult, type LeverageResult, type Network, type OrderRef, type OrderRequest,
  type OrderResult, type OrderStatus, type VenueMarket,
} from "../venue-types.js";
import { RisexClient, RisexSendUnknown } from "./client.js";
import { fetchRisexRawMarkets, isListedRisexMarket, risexSymbolOf, toRisexVenueMarkets, type RisexRawMarket } from "./public.js";
import { allocateAccountNonce, assertTradingOnlyOnChain, chainReader, loadSigningContext, type RisexChainReader } from "./session.js";
import {
  cancelAllHash, cancelOrderHash, leverageHash, marginModeHash, MARGIN_MODE_CODE, ORDER_TYPE, packOrder, placeOrderHash,
  SIDE, signPermit, STP_EXPIRE_MAKER, TIF_CODE, type NonceSlot, type RisexPermit,
} from "./typed-data.js";
import { compareDecimal, decOrNull, nsToMs, toPriceTicks, toSizeSteps, trimDecimal, UINT64_MAX, wadToDecimal } from "./units.js";

const MARKETS_TTL_MS = 30_000;
/** Permit lifetime: long enough for the server to submit, short enough that an unproven permit expires soon. */
export const RISEX_PERMIT_TTL_S = 120;
/** How long a successful on-chain trading-only proof is trusted before the next permit re-checks it. */
export const RISEX_TRADING_ONLY_TTL_MS = 60_000;
const ORDER_READ_ATTEMPTS = 3;
const ORDER_READ_DELAY_MS = 700;

export interface RisexAdapterDeps {
  /** Account the reads and permits are for; null = public market data only. */
  account: string | null;
  /** Trading-only session signer; null = no trading. */
  signer: EvmSigner | null;
  /** Agent meta the signer came from (for messages); null when none. */
  meta: RisexAgentMeta | null;
  /** Why trading is unavailable when `signer` is null (the uniform refusal). */
  noSignerReason: PerpError | null;
  nonceDir?: string;
  chain?: RisexChainReader;
  sleep?: (ms: number) => Promise<void>;
  /** Quarantine hook for unknown outcomes (default: bot/quarantine.ts). */
  quarantine?: (symbol: string, reason: string, remediation: string) => void;
}

function isRisexMeta(a: unknown): a is RisexAgentMeta {
  return !!a && typeof a === "object" && (a as { kind?: unknown }).kind === "risex";
}

function lower(s: string): string { return s.toLowerCase(); }

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "") throw new PerpError("EXCHANGE_ERROR", `RISEx: missing ${what}`, { exchange: "risex" });
  return v;
}

function decReq(v: unknown, what: string): string {
  const d = decOrNull(v);
  if (d === null) throw new PerpError("EXCHANGE_ERROR", `RISEx: ${what} is not a decimal (${JSON.stringify(v)})`, { exchange: "risex" });
  return trimDecimal(d);
}

/** Positive decimal → null for "0" (RISEx publishes "0" for "none", e.g. liquidation_price, avg_price). */
function positiveOrNull(v: unknown): string | null {
  const d = decOrNull(v);
  return d === null || !(Number(d) > 0) ? null : trimDecimal(d);
}

interface HistoryOrder {
  id: string; price: string; size: string; market_id: string; side: string; type: string; time_in_force: string;
  post_only: boolean; reduce_only: boolean; filled_size: string; status: string; avg_price: string; client_order_id: string;
  created_at: string; stop_type?: string;
}

interface OpenOrder {
  order_id: string; resting_order_id: string; market_id: number; side: number; size_steps: number; price_ticks: number;
  order_type: number; time_in_force: number; post_only: boolean; reduce_only: boolean; client_order_id: string;
}

export class RisexAdapter implements ExchangeAdapter, TradingV2 {
  readonly name = "risex" as const;
  readonly aliases = ["rise"] as const;
  readonly venue: VenueDefinition;
  readonly network: Network;
  private readonly client: RisexClient;
  private readonly deps: RisexAdapterDeps;
  private markets: { at: number; raw: RisexRawMarket[] } | null = null;

  constructor(def: VenueDefinition, network: Network, deps: RisexAdapterDeps) {
    this.venue = def;
    this.network = network;
    this.client = new RisexClient(networkConfig(def, network).restUrl, def.rateLimit, `risex:${network}`);
    this.deps = deps;
  }

  /** Resolve the account and the trading-only signer from the create context (OWS only). */
  static async create(def: VenueDefinition, ctx: VenueCreateContext): Promise<RisexAdapter> {
    networkConfig(def, ctx.network);
    const net = ctx.network === "testnet" ? " -n testnet" : "";
    const approveHint = `perp${net} wallet agent approve risex --master <ows-wallet>`;
    if (ctx.readOnly) {
      return new RisexAdapter(def, ctx.network, { account: null, signer: null, meta: null, noSignerReason: null });
    }
    // Master address (for reads): OWS wallet or raw key; nothing is signed with it here.
    let masterAddress: string | null = null;
    if (ctx.credentials.owsWallet !== null) {
      const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
      masterAddress = OwsEvmSigner.create(ctx.credentials.owsWallet, ctx.credentials.owsPassphrase ?? "").getAddress();
    } else if (ctx.credentials.pk !== null) {
      const { Wallet } = await import("ethers");
      masterAddress = new Wallet(ctx.credentials.pk).address;
    }
    const meta = ctx.noAgent ? null : ctx.credentials.agent;
    // Read-only release (trading role gated): reads need only an account address — the master's, else
    // the one recorded with a stored signer. The signer's key is never opened.
    if (!def.roles.includes("trading")) {
      const recorded = meta !== null && isRisexMeta(meta) && meta.network === ctx.network ? meta.accountAddress : null;
      return new RisexAdapter(def, ctx.network, { account: masterAddress ?? recorded, signer: null, meta: null, noSignerReason: null });
    }
    if (meta === null || !isRisexMeta(meta)) {
      return new RisexAdapter(def, ctx.network, {
        account: masterAddress, signer: null, meta: null,
        noSignerReason: new PerpError("AGENT_NOT_REGISTERED", "No RISEx trading signer is registered on this computer", { exchange: "risex", remediation: approveHint }),
      });
    }
    let reason: PerpError | null = null;
    if (meta.network !== ctx.network) {
      reason = new PerpError("AGENT_NOT_REGISTERED", `RISEx signer "${meta.agentName}" was registered on ${meta.network}, not ${ctx.network}`, { exchange: "risex", remediation: approveHint });
    } else if (!(Date.parse(meta.expiresAt) > Date.now())) {
      reason = new PerpError("AGENT_EXPIRED", `RISEx signer "${meta.agentName}" expired at ${meta.expiresAt}`, { exchange: "risex", remediation: `${approveHint} --rotate` });
    } else if (meta.permissions?.tradingOnly !== true) {
      reason = new PerpError("POLICY_DENIED", `RISEx signer "${meta.agentName}" is not recorded as restricted to trading-only`, { exchange: "risex", remediation: `${approveHint} --rotate` });
    } else if (masterAddress !== null && lower(masterAddress) !== lower(meta.accountAddress)) {
      reason = new PerpError("AGENT_NOT_REGISTERED", `RISEx signer "${meta.agentName}" belongs to ${meta.accountAddress}, not the selected master ${masterAddress}`, { exchange: "risex", remediation: approveHint });
    }
    if (reason !== null) {
      return new RisexAdapter(def, ctx.network, { account: masterAddress ?? meta.accountAddress, signer: null, meta, noSignerReason: reason });
    }
    const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
    const signer = OwsEvmSigner.create(meta.agentWalletName, "");
    if (lower(signer.getAddress()) !== lower(meta.signerAddress)) {
      throw new PerpError("KEY_NOT_FOUND", `OWS wallet "${meta.agentWalletName}" does not hold RISEx signer ${meta.signerAddress}`, { exchange: "risex", remediation: `${approveHint} --rotate` });
    }
    return new RisexAdapter(def, ctx.network, { account: meta.accountAddress, signer, meta, noSignerReason: null });
  }

  // ── Internals ──

  /**
   * Trading capabilities — also the adapter-level release gate: while the trading role is gated
   * (risex-release.ts) this throws CAPABILITY_UNSUPPORTED before any validation, nonce or
   * signature. Read paths never touch it, so the adapter still serves market data / account reads.
   */
  private get caps(): VenueCapabilities {
    return requireCapabilities(this.venue);
  }

  private requireAccount(): string {
    if (this.deps.account === null) {
      const tradingOn = this.venue.roles.includes("trading");
      throw new PerpError("NO_SIGNER_AVAILABLE", `RISEx account reads need an account address: select a master wallet (perp wallet use <name> / --ows <name>)${tradingOn ? " or register a signer" : ""}`, {
        exchange: "risex",
        remediation: tradingOn
          ? `perp${this.network === "testnet" ? " -n testnet" : ""} wallet agent approve risex --master <ows-wallet>`
          : "Select the wallet that owns the RISEx account: perp wallet use <name> (or pass --ows <name>)",
      });
    }
    return this.deps.account;
  }

  private requireSigner(): { account: string; signer: EvmSigner } {
    requireCapabilities(this.venue); // release gate first: refuses before the signer is looked at
    if (this.deps.signer === null) {
      throw this.deps.noSignerReason ?? new PerpError("AGENT_NOT_REGISTERED", "No RISEx trading signer", {
        exchange: "risex", remediation: "perp wallet agent approve risex --master <ows-wallet>",
      });
    }
    return { account: this.requireAccount(), signer: this.deps.signer };
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise(r => setTimeout(r, ms));
  }

  private async rawMarkets(fresh: boolean): Promise<RisexRawMarket[]> {
    if (!fresh && this.markets && Date.now() - this.markets.at < MARKETS_TTL_MS) return this.markets.raw;
    const raw = await fetchRisexRawMarkets(this.client);
    this.markets = { at: Date.now(), raw };
    return raw;
  }

  /** Active market by symbol ("BTC", "BTC/USDC", "BTC-PERP") or market id. */
  private async market(symbol: string, fresh = false): Promise<RisexRawMarket> {
    const up = symbol.trim().toUpperCase().replace(/-PERP$/, "");
    const find = (raw: RisexRawMarket[]) => raw.find(m => isListedRisexMarket(m) && (risexSymbolOf(m) === up || m.config.name.toUpperCase() === up || m.market_id === up));
    let m = find(await this.rawMarkets(fresh));
    if (m === undefined && !fresh) m = find(await this.rawMarkets(true));
    if (m === undefined) {
      throw new PerpError("SYMBOL_NOT_FOUND", `RISEx has no active market ${symbol}`, { exchange: "risex", remediation: "List markets: perp -e risex market list" });
    }
    return m;
  }

  private async symbolOfId(marketId: string | number): Promise<string> {
    const id = String(marketId);
    let m = (await this.rawMarkets(false)).find(x => x.market_id === id);
    if (m === undefined) m = (await this.rawMarkets(true)).find(x => x.market_id === id);
    if (m === undefined) throw new PerpError("EXCHANGE_ERROR", `RISEx: unknown market id ${id}`, { exchange: "risex" });
    return risexSymbolOf(m);
  }

  /**
   * The on-chain trading-only proof, re-checked at most every RISEX_TRADING_ONLY_TTL_MS before a
   * permit (long-lived adapters — perp-mcp, bots — must notice a contract upgrade). A failed proof
   * (refusal or RPC error) is never cached.
   */
  private tradingOnlyProof: { at: number; proof: Promise<unknown> } | null = null;

  private async permit(account: string, signer: EvmSigner, actionHash: string): Promise<{ permit: RisexPermit; slot: NonceSlot }> {
    if (this.tradingOnlyProof === null || Date.now() - this.tradingOnlyProof.at > RISEX_TRADING_ONLY_TTL_MS) {
      const entry = { at: Date.now(), proof: assertTradingOnlyOnChain(this.chainRead(), this.network, account, signer.getAddress()) };
      this.tradingOnlyProof = entry;
      entry.proof.catch(() => { if (this.tradingOnlyProof === entry) this.tradingOnlyProof = null; });
    }
    await this.tradingOnlyProof.proof;
    const ctx = await loadSigningContext(this.client, this.network);
    const slot = await allocateAccountNonce(this.client, this.network, account, this.deps.nonceDir);
    const deadline = Math.floor(Date.now() / 1000) + RISEX_PERMIT_TTL_S;
    const permit = await signPermit({ signer, account, router: ctx.router, domain: ctx.domain, actionHash, slot, deadline });
    return { permit, slot };
  }

  private chainRead(): RisexChainReader {
    return this.deps.chain ?? chainReader(this.network);
  }

  private quarantine(symbol: string, reason: string, remediation: string): void {
    if (this.deps.quarantine) return this.deps.quarantine(symbol, reason, remediation);
    // Synchronous: persisted (or logged CRITICAL and held in memory) before the error is thrown.
    quarantineSymbol("risex-adapter", symbol, reason, remediation, m => process.stderr.write(`${m}\n`));
  }

  /** The account reads / permits are for (signer's account, else the master address). */
  accountAddress(): string {
    return this.requireAccount();
  }

  /** Testnet faucet: 1000 test USDC, once per wallet (also registers the account). Refused on mainnet. */
  async testnetFaucet(): Promise<{ txHash: string | null }> {
    requireCapabilities(this.venue); // a write (registers the account): gated with trading
    if (this.network !== "testnet") {
      throw unsupported(this.venue.displayName, "faucet", "the test-USDC faucet exists only on testnet", "Run with -n testnet");
    }
    try {
      const res = await this.client.post<{ transaction_hash?: unknown; tx_hash?: unknown }>("/v1/account/deposit", { account: this.requireAccount(), amount: "1000" }, "testnet faucet");
      const h = typeof res.transaction_hash === "string" ? res.transaction_hash : typeof res.tx_hash === "string" ? res.tx_hash : "";
      return { txHash: h === "" ? null : h };
    } catch (e) {
      if (e instanceof RisexSendUnknown) {
        throw new PerpError("ORDER_PENDING", `RISEx testnet faucet: outcome unknown — ${extractErrorMessage(e.cause)}`, {
          exchange: "risex", remediation: "Check the balance (perp -n testnet -e risex account balance) before requesting again",
        });
      }
      throw e;
    }
  }

  // ── Market data ──

  async getVenueMarkets(): Promise<VenueMarket[]> {
    return toRisexVenueMarkets(await this.rawMarkets(true), m => process.stderr.write(`${m}\n`));
  }

  /** Legacy rows plus the venue's market-level order restrictions. */
  async getMarkets(): Promise<Array<ExchangeMarketInfo & { marketId: string; reduceOnlyMarket: boolean; postOnlyMarket: boolean; tradable: boolean }>> {
    const raw = await this.rawMarkets(true);
    const byId = new Map(raw.map(r => [r.market_id, r]));
    return toRisexVenueMarkets(raw, m => process.stderr.write(`${m}\n`)).map(m => {
      const r = byId.get(m.venueSymbol) as RisexRawMarket;
      return { ...toLegacyMarketInfo(m), marketId: m.venueSymbol, reduceOnlyMarket: r.reduce_only, postOnlyMarket: r.post_only, tradable: m.tradable };
    });
  }

  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const m = await this.market(symbol);
    const d = await this.client.get<{ bids?: unknown; asks?: unknown }>("/v1/orderbook", { market_id: m.market_id, limit: 50 });
    const side = (rows: unknown, what: string): [string, string][] => {
      if (!Array.isArray(rows)) throw new PerpError("EXCHANGE_ERROR", `RISEx /v1/orderbook: no ${what}`, { exchange: "risex" });
      return rows.map(r => [decReq((r as { price?: unknown }).price, `${what} price`), decReq((r as { quantity?: unknown }).quantity, `${what} quantity`)]);
    };
    return { bids: side(d.bids, "bids"), asks: side(d.asks, "asks") };
  }

  async getRecentTrades(symbol: string, limit = 50): Promise<ExchangePublicTrade[]> {
    const m = await this.market(symbol);
    const d = await this.client.get<{ trades?: unknown }>(`/v1/markets/id/${m.market_id}/trade-history`, { limit: Math.min(limit, 1000) });
    if (!Array.isArray(d.trades)) throw new PerpError("EXCHANGE_ERROR", "RISEx trade-history: no trades array", { exchange: "risex" });
    const sym = risexSymbolOf(m);
    return d.trades.map(t => {
      const x = t as { maker_side?: unknown; price?: unknown; size?: unknown; time?: unknown };
      if (x.maker_side !== "BUY" && x.maker_side !== "SELL") throw new PerpError("EXCHANGE_ERROR", `RISEx trade maker_side ${String(x.maker_side)}`, { exchange: "risex" });
      // The tape side is the taker's: a SELL maker means a buy took it.
      // Public tape carries no fee; "0" follows the legacy ExchangeTrade convention for public trades.
      return { time: nsToMs(str(x.time, "trade time")), symbol: sym, side: x.maker_side === "SELL" ? "buy" : "sell", price: decReq(x.price, "trade price"), size: decReq(x.size, "trade size"), fee: null };
    });
  }

  async getFundingHistory(symbol: string, limit = 100): Promise<FundingHistoryRow[]> {
    const m = await this.market(symbol);
    const d = await this.client.get<{ records?: unknown }>(`/v1/markets/id/${m.market_id}/funding-rate-history`, { limit: Math.min(limit, 1000) });
    if (!Array.isArray(d.records)) throw new PerpError("EXCHANGE_ERROR", "RISEx funding-rate-history: no records", { exchange: "risex" });
    return d.records.map(r => {
      const x = r as { funding_rate?: unknown; end_time?: unknown; index_price?: unknown };
      return { time: nsToMs(str(x.end_time, "funding end_time")), rate: decReq(x.funding_rate, "funding_rate"), price: positiveOrNull(x.index_price), intervalHours: 1, rateKind: "lastSettled" as const };
    });
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const ms = KLINE_INTERVAL_MS[interval];
    if (ms === undefined) {
      throw new PerpError("INVALID_PARAMS", `RISEx: unsupported candle interval "${interval}"`, { remediation: `Use one of: ${Object.keys(KLINE_INTERVAL_MS).join(", ")}` });
    }
    const m = await this.market(symbol);
    const toNs = (t: number) => (BigInt(Math.floor(t)) * 1_000_000n).toString();
    const res = await this.client.get<{ data?: unknown }>(`/v1/markets/id/${m.market_id}/trading-view-data`, {
      interval: (BigInt(ms) * 1_000_000n).toString(), from: toNs(startTime), to: toNs(endTime),
    });
    const d = res.data;
    if (!Array.isArray(d)) throw new PerpError("EXCHANGE_ERROR", "RISEx trading-view-data: not an array", { exchange: "risex" });
    return d.map(c => {
      const x = c as Record<string, unknown>;
      // The venue answers an interval it does not serve with 1m bars: a row of another interval
      // is never returned as the requested one.
      // Required on every row here (the field is always sent; null/absent would skip the check).
      assertCandleInterval("risex", interval, x.interval === undefined ? null : x.interval, `Use one of: ${Object.keys(KLINE_INTERVAL_MS).join(", ")}`);
      return {
        time: nsToMs(str(x.time, "candle time")),
        open: decReq(x.open, "open"), high: decReq(x.high, "high"), low: decReq(x.low, "low"), close: decReq(x.close, "close"),
        volume: decReq(x.volume, "volume"), quoteVolume: null, trades: null,
      };
    });
  }

  // ── Account (public by address) ──

  private async portfolio(): Promise<{ summary: Record<string, unknown>; positions: Array<Record<string, unknown>> }> {
    const d = await this.client.get<{ summary?: unknown; positions?: unknown }>("/v1/portfolio/details", { account: lower(this.requireAccount()) });
    if (d.summary === null || typeof d.summary !== "object" || !Array.isArray(d.positions)) {
      throw new PerpError("EXCHANGE_ERROR", "RISEx /v1/portfolio/details: missing summary / positions", { exchange: "risex" });
    }
    return { summary: d.summary as Record<string, unknown>, positions: d.positions as Array<Record<string, unknown>> };
  }

  async getBalance(): Promise<ExchangeBalance> {
    const { summary: s } = await this.portfolio();
    return {
      equity: decReq(s.total_account_value, "total_account_value"),
      available: decReq(s.free_collateral, "free_collateral"),
      marginUsed: decReq(s.total_initial_margin, "total_initial_margin"),
      unrealizedPnl: decReq(s.total_unrealized_pnl, "total_unrealized_pnl"),
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    const { positions } = await this.portfolio();
    const out: ExchangePosition[] = [];
    for (const p of positions) {
      const size = decReq(p.size, "position size");
      if (Number(size) === 0) continue;
      const lev = Number(decReq(p.leverage, "position leverage"));
      out.push({
        symbol: await this.symbolOfId(str(p.market_id, "position market_id")),
        side: size.startsWith("-") ? "short" : "long",
        size: size.replace(/^-/, ""),
        entryPrice: decReq(p.avg_entry_price, "avg_entry_price"),
        markPrice: decReq(p.mark_price, "mark_price"),
        liquidationPrice: positiveOrNull(p.liquidation_price),
        unrealizedPnl: decReq(p.unrealized_pnl, "unrealized_pnl"),
        leverage: lev,
        marginMode: marginModeOf(p.margin_mode),
      });
    }
    return out;
  }

  private async openOrdersRaw(marketId: string | null): Promise<OpenOrder[]> {
    const d = await this.client.get<{ orders?: unknown }>("/v1/orders/open", { account: lower(this.requireAccount()), market_id: marketId, limit: 1000 });
    if (!Array.isArray(d.orders)) throw new PerpError("EXCHANGE_ERROR", "RISEx /v1/orders/open: no orders array", { exchange: "risex" });
    return d.orders as OpenOrder[];
  }

  private async historyOrders(q: { marketId?: string | null; orderIds?: string[]; limit?: number }): Promise<HistoryOrder[]> {
    const u = new URLSearchParams({ account: lower(this.requireAccount()), limit: String(q.limit ?? 100) });
    if (q.marketId) u.set("market_id", q.marketId);
    for (const id of q.orderIds ?? []) u.append("order_ids", id);
    const d = await this.client.get<{ orders?: unknown }>(`/v1/orders?${u.toString()}`);
    if (!Array.isArray(d.orders)) throw new PerpError("EXCHANGE_ERROR", "RISEx /v1/orders: no orders array", { exchange: "risex" });
    return d.orders as HistoryOrder[];
  }

  private async toExchangeOrder(o: HistoryOrder): Promise<ExchangeOrder> {
    return {
      orderId: str(o.id, "order id"),
      symbol: await this.symbolOfId(o.market_id),
      side: o.side === "SELL" ? "sell" : "buy",
      price: decReq(o.price, "order price"),
      size: decReq(o.size, "order size"),
      filled: decReq(o.filled_size, "order filled_size"),
      status: historyStatus(o),
      type: `${String(o.type).toLowerCase()}${o.post_only ? " post-only" : ""}${o.reduce_only ? " reduce-only" : ""}`,
      triggerPrice: null,
    };
  }

  /** On-chain open orders, enriched with the indexer's decimals / fills (one retry for indexer lag). */
  async getOpenOrders(): Promise<ExchangeOrder[]> {
    const open = await this.openOrdersRaw(null);
    if (open.length === 0) return [];
    const ids = open.map(o => o.order_id);
    const found = new Map<string, HistoryOrder>();
    for (let attempt = 0; attempt < 2; attempt++) {
      const missing = ids.filter(id => !found.has(id));
      for (let i = 0; i < missing.length; i += 100) {
        for (const h of await this.historyOrders({ orderIds: missing.slice(i, i + 100), limit: 100 })) found.set(h.id, h);
      }
      if (ids.every(id => found.has(id))) break;
      if (attempt === 0) await this.sleep(1_000);
    }
    const stillMissing = ids.filter(id => !found.has(id));
    if (stillMissing.length > 0) {
      throw new PerpError("EXCHANGE_ERROR", `RISEx: ${stillMissing.length} open order(s) are not indexed yet (${stillMissing.join(", ")})`, {
        exchange: "risex", remediation: "Retry in a few seconds",
      });
    }
    return Promise.all(ids.map(id => this.toExchangeOrder(found.get(id) as HistoryOrder)));
  }

  async getOrderHistory(limit = 50): Promise<ExchangeOrder[]> {
    return Promise.all((await this.historyOrders({ limit: Math.min(limit, 1000) })).map(o => this.toExchangeOrder(o)));
  }

  async getTradeHistory(limit = 50): Promise<ExchangeTrade[]> {
    const d = await this.client.get<{ trades?: unknown }>("/v1/trade-history", { account: lower(this.requireAccount()), limit: Math.min(limit, 1000) });
    if (!Array.isArray(d.trades)) throw new PerpError("EXCHANGE_ERROR", "RISEx /v1/trade-history: no trades array", { exchange: "risex" });
    return Promise.all(d.trades.map(async t => {
      const x = t as Record<string, unknown>;
      return {
        time: nsToMs(str(x.time, "fill time")), symbol: await this.symbolOfId(str(x.market_id, "fill market_id")),
        side: x.side === "SELL" ? "sell" as const : "buy" as const,
        price: decReq(x.price, "fill price"), size: decReq(x.size, "fill size"), fee: decReq(x.fee, "fill fee"),
      };
    }));
  }

  /** `payment` is positive when RECEIVED (RISEx `funding_payment` is positive when paid — negated here). */
  async getFundingPayments(limit = 100): Promise<ExchangeFundingPayment[]> {
    const d = await this.client.get<{ records?: unknown }>("/v1/account/funding-payments", { account: lower(this.requireAccount()), limit: Math.min(limit, 1000) });
    if (!Array.isArray(d.records)) throw new PerpError("EXCHANGE_ERROR", "RISEx funding-payments: no records", { exchange: "risex" });
    const out: ExchangeFundingPayment[] = [];
    for (const r of d.records as Array<Record<string, unknown>>) {
      if (r.entry_type !== undefined && r.entry_type !== "funding") continue;
      const paid = decReq(r.funding_payment, "funding_payment");
      out.push({
        time: nsToMs(str(r.block_time, "funding block_time")),
        symbol: await this.symbolOfId(str(r.market_id, "funding market_id")),
        payment: paid.startsWith("-") ? paid.slice(1) : (paid === "0" ? "0" : `-${paid}`),
      });
    }
    return out;
  }

  // ── TradingV2 ──

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    validateOrderRequest(this.venue, this.caps, req);
    if (req.type !== "market" && req.type !== "limit") {
      throw unsupported(this.venue.displayName, "stopOrders", "TP/SL and stop orders are not implemented for RISEx yet", "Use market / limit orders; set protection in the RISEx app");
    }
    const { account, signer } = this.requireSigner();
    const m = await this.market(req.symbol, true);
    const sym = risexSymbolOf(m);
    if (!m.config.unlocked) throw new PerpError("ORDER_REJECTED", `RISEx ${sym} is locked for trading`, { exchange: "risex", sent: false });
    if (m.reduce_only && !req.reduceOnly) {
      throw new PerpError("ORDER_REJECTED", `RISEx ${sym} is in reduce-only mode — only reduce-only orders are accepted`, { exchange: "risex", sent: false, remediation: "Close with a reduce-only order, or wait until the market reopens" });
    }
    if (m.post_only && req.tif !== "ALO") {
      throw new PerpError("ORDER_REJECTED", `RISEx ${sym} is in post-only mode — only post-only (ALO) limit orders are accepted`, { exchange: "risex", sent: false, remediation: "Use --tif ALO" });
    }
    const sizeSteps = toSizeSteps(req.size, m.config.step_size);
    const minSteps = toSizeSteps(m.config.min_order_size, m.config.step_size);
    if (sizeSteps < minSteps) {
      throw new PerpError("SIZE_TOO_SMALL", `RISEx ${sym} size ${req.size} is below the minimum ${m.config.min_order_size}`, { exchange: "risex", remediation: `Use a size of at least ${m.config.min_order_size}` });
    }

    let price: string;
    let referencePrice: string | null = null;
    if (req.type === "market") {
      const slip = req.slippage as ResolvedSlippage;
      referencePrice = decOrNull(m.mark_price);
      if (referencePrice === null) throw new PerpError("PRICE_STALE", `RISEx ${sym}: no mark price to bound the market order`, { exchange: "risex" });
      price = alignProtectionPrice(slippagePrice(referencePrice, req.side, slip.bps), m.config.step_price, req.side);
      // The venue's match band applies to the price actually sent (after tick alignment).
      const band = decOrNull(m.config.match_price_band);
      if (band === null) throw new PerpError("EXCHANGE_ERROR", `RISEx ${sym}: market config has no match_price_band — nothing was sent`, { exchange: "risex" });
      const dev = subDecimal(price, referencePrice).replace(/^-/, "");
      if (compareDecimal(dev, mulDecimal(band, referencePrice)) > 0) {
        throw new PerpError("INVALID_PARAMS", `slippage ${slip.bps} bps puts the ${sym} limit ${price} outside RISEx's match price band (${band} of mark ${referencePrice})`, {
          exchange: "risex", remediation: `Use a smaller --slippage-bps (the band is ${mulDecimal(band, "10000")} bps)`,
        });
      }
    } else {
      price = req.price as string;
    }
    const priceTicks = toPriceTicks(price, m.config.step_price);
    const tif = req.type === "market" ? "IOC" : (req.tif as string);
    const tifCode = tif === "ALO" ? TIF_CODE.GTC : TIF_CODE[tif as keyof typeof TIF_CODE];
    if (tifCode === undefined) throw unsupported(this.venue.displayName, "timeInForce", `time-in-force ${tif} is not offered`, `Use one of: ${this.caps.timeInForce.join(", ")}`);

    // The single client-id generator (trading-v2.ts newVenueClientOrderId, crypto randomness).
    const clientOrderId = req.clientOrderId ?? newVenueClientOrderId(this.venue);
    if (!/^[1-9]\d{0,19}$/.test(clientOrderId) || BigInt(clientOrderId) > UINT64_MAX) {
      throw new PerpError("INVALID_PARAMS", `RISEx client order id must be a decimal integer 1..2^64-1 (got "${clientOrderId}")`);
    }
    const fields = {
      marketId: Number(m.market_id), sizeSteps, priceTicks, side: SIDE[req.side], postOnly: tif === "ALO", reduceOnly: req.reduceOnly,
      stpMode: STP_EXPIRE_MAKER, orderType: req.type === "market" ? ORDER_TYPE.market : ORDER_TYPE.limit, tif: tifCode,
    } as const;
    const actionHash = placeOrderHash(packOrder(fields), BigInt(clientOrderId));
    const { permit, slot } = await this.permit(account, signer, actionHash);

    const { logClientId } = await import("../../client-id-tracker.js");
    const now = new Date().toISOString();
    logClientId({ clientOrderId, exchange: "risex", symbol: sym, side: req.side, size: req.size, price, type: req.type, status: "pending", createdAt: now, updatedAt: now });

    const exec = {
      slippageBps: req.slippage?.bps ?? null, slippageSource: req.slippage?.source ?? null,
      protectionPrice: req.type === "market" ? price : null, referencePrice,
      tifRequested: req.tif, tifSent: tif === "ALO" ? "GTC+post_only" : tif,
    };
    const method = req.type === "market" ? "protectedIoc" : "limit";
    let res: { order_id?: unknown; block_number?: unknown; filled_quantity?: unknown; tx_hash?: unknown };
    try {
      res = await this.client.post("/v1/orders/place", {
        market_id: fields.marketId, size_steps: Number(sizeSteps), price_ticks: Number(priceTicks), side: fields.side,
        post_only: fields.postOnly, reduce_only: fields.reduceOnly, stp_mode: fields.stpMode, order_type: fields.orderType,
        time_in_force: fields.tif, builder_id: 0, client_order_id: clientOrderId, ttl_units: 0, no_retry: true, permit,
      }, "place order");
    } catch (e) {
      if (!(e instanceof RisexSendUnknown)) {
        logClientId({ clientOrderId, exchange: "risex", symbol: sym, side: req.side, size: req.size, price, type: req.type, status: "failed", createdAt: now, updatedAt: new Date().toISOString() });
        throw e;
      }
      return this.reconcilePlace(sym, m.market_id, clientOrderId, slot, account, e, method, exec);
    }
    const orderId = typeof res.order_id === "string" && res.order_id !== "" ? res.order_id : null;
    logClientId({ clientOrderId, exchange: "risex", symbol: sym, side: req.side, size: req.size, price, type: req.type, ...(orderId !== null ? { exchangeOrderId: orderId } : {}), status: "submitted", createdAt: now, updatedAt: new Date().toISOString() });
    const notes = [`block ${String(res.block_number)}`];
    if (tif === "IOC" || tif === "FOK") {
      const filledRaw = typeof res.filled_quantity === "string" ? res.filled_quantity : "";
      const filledSize = filledRaw === "" ? null : wadToDecimal(filledRaw);
      const filledSteps = filledSize === null ? null : exactUnits(filledSize, m.config.step_size);
      const status: OrderStatus = filledSize === null ? "accepted"
        : filledSteps === 0n ? "cancelled"
        : filledSteps !== null && filledSteps >= sizeSteps ? "filled" : "partiallyFilled";
      if (status === "partiallyFilled") notes.push(`${tif}: the unfilled remainder was cancelled`);
      return withExecution({
        venue: "risex", symbol: sym, status, finality: filledSize === null ? "pending" : "final", orderId, clientOrderId,
        filledSize, avgPrice: null, venueRaw: res,
      }, method, { ...exec, notes });
    }
    // Resting TIF: read the order back (status / immediate fills).
    if (orderId !== null) {
      for (let i = 0; i < ORDER_READ_ATTEMPTS; i++) {
        try {
          const r = await this.getOrderStatus(sym, { kind: "orderId", value: orderId });
          return { ...r, clientOrderId, execution: { ...r.execution, ...exec, method, notes: [...notes, ...r.execution.notes] } };
        } catch (e) {
          if (!(e instanceof PerpError && e.structured.code === "ORDER_NOT_FOUND")) break;
          await this.sleep(ORDER_READ_DELAY_MS);
        }
      }
    }
    return withExecution({
      venue: "risex", symbol: sym, status: "accepted", finality: "pending", orderId, clientOrderId, filledSize: null, avgPrice: null, venueRaw: res,
    }, method, { ...exec, notes: [...notes, "included on-chain; status not read back yet"] });
  }

  /** One read-only reconciliation of an unknown place outcome. */
  private async reconcilePlace(
    sym: string, marketId: string, clientOrderId: string, slot: NonceSlot, account: string, cause: RisexSendUnknown,
    method: string, exec: Record<string, unknown>,
  ): Promise<OrderResult> {
    const statusHint = `perp -e risex${this.network === "testnet" ? " -n testnet" : ""} trade status c:${clientOrderId} --symbol ${sym}`;
    let consumed: boolean | null = null;
    let reconcileError: string | null = null;
    try { consumed = await this.chainRead().isNonceUsed(account, slot); } catch (e) { consumed = null; reconcileError = `nonce read: ${extractErrorMessage(e)}`; }
    if (consumed === true) {
      try {
        const r = await this.getOrderStatus(sym, { kind: "clientOrderId", value: clientOrderId });
        return { ...r, execution: { ...r.execution, ...exec, method, notes: [...r.execution.notes, "reconciled"] } };
      } catch (e) { reconcileError = `order read: ${extractErrorMessage(e)}`; }
    }
    const remediation = `Do NOT resubmit — the order may have been placed (client id ${clientOrderId}). Check: ${statusHint}. Its permit expires ${RISEX_PERMIT_TTL_S}s after signing`;
    this.quarantine(sym, `RISEx order c:${clientOrderId} outcome unknown (${extractErrorMessage(cause.cause)})`, remediation);
    throw new PerpError("ORDER_PENDING", `RISEx place order: outcome unknown — ${extractErrorMessage(cause.cause)}`, {
      exchange: "risex", clientOrderId, nonce: { anchor: slot.anchor.toString(), bit: slot.bit }, nonceConsumed: consumed, reconcileError, remediation,
    });
  }

  async amendOrder(_req: AmendRequest): Promise<OrderResult> {
    throw unsupported(this.venue.displayName, "amend", "RISEx has no order amend", "Cancel the order and place a new one");
  }

  async cancelByRef(symbol: string, ref: OrderRef): Promise<CancelResult> {
    const { account, signer } = this.requireSigner();
    const m = await this.market(symbol);
    const open = await this.openOrdersRaw(m.market_id);
    const o = open.find(x => (ref.kind === "orderId" ? lower(x.order_id) === lower(ref.value) : x.client_order_id === ref.value));
    if (o === undefined) {
      throw new PerpError("ORDER_NOT_FOUND", `RISEx: no open ${risexSymbolOf(m)} order ${ref.kind === "clientOrderId" ? "c:" : ""}${ref.value}`, {
        exchange: "risex", remediation: `List open orders: perp -e risex account orders`,
      });
    }
    const { permit } = await this.permit(account, signer, cancelOrderHash(Number(m.market_id), BigInt(o.resting_order_id)));
    try {
      const res = await this.client.post<{ success?: unknown }>("/v1/orders/cancel", { market_id: Number(m.market_id), order_id: o.order_id, permit }, "cancel order");
      return res.success === true
        ? { venue: "risex", cancelled: [{ kind: "orderId", value: o.order_id }], failed: [], venueRaw: res }
        : { venue: "risex", cancelled: [], failed: [{ ref, error: `venue answered success=${String(res.success)}` }], venueRaw: res };
    } catch (e) {
      if (!(e instanceof RisexSendUnknown)) throw e;
      return {
        venue: "risex", cancelled: [], failed: [],
        pending: [{ ref, reason: extractErrorMessage(e.cause), remediation: "Do NOT resend blindly — check perp -e risex account orders" }],
        venueRaw: null,
      };
    }
  }

  async cancelAllV2(symbol: string | null): Promise<CancelResult> {
    const { account, signer } = this.requireSigner();
    const before = await this.openOrdersRaw(symbol === null ? null : (await this.market(symbol)).market_id);
    const marketIds = [...new Set(before.map(o => String(o.market_id)))];
    const result: CancelResult = { venue: "risex", cancelled: [], failed: [], pending: [], venueRaw: [] };
    for (const id of marketIds) {
      const refs = before.filter(o => String(o.market_id) === id).map(o => ({ kind: "orderId" as const, value: o.order_id }));
      const { permit } = await this.permit(account, signer, cancelAllHash(Number(id)));
      try {
        const res = await this.client.post<{ success?: unknown }>("/v1/orders/cancel-all", { market_id: Number(id), permit }, "cancel all");
        (result.venueRaw as unknown[]).push(res);
        if (res.success !== true) {
          for (const r of refs) result.failed.push({ ref: r, error: `cancel-all answered success=${String(res.success)}` });
          continue;
        }
        const still = new Set((await this.openOrdersRaw(id)).map(o => lower(o.order_id)));
        for (const r of refs) {
          if (still.has(lower(r.value))) (result.pending as NonNullable<CancelResult["pending"]>).push({ ref: r, reason: "still listed after cancel-all", remediation: "Check perp -e risex account orders" });
          else result.cancelled.push(r);
        }
      } catch (e) {
        if (!(e instanceof RisexSendUnknown)) {
          for (const r of refs) result.failed.push({ ref: r, error: extractErrorMessage(e) });
          continue;
        }
        for (const r of refs) (result.pending as NonNullable<CancelResult["pending"]>).push({ ref: r, reason: extractErrorMessage(e.cause), remediation: "Do NOT resend blindly — check perp -e risex account orders" });
      }
    }
    return result;
  }

  async applyLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" | null): Promise<LeverageResult> {
    const { account, signer } = this.requireSigner();
    const m = await this.market(symbol, true);
    const max = Number(decReq(m.config.max_leverage, "max_leverage"));
    if (!Number.isInteger(max) || max < 1) throw new PerpError("EXCHANGE_ERROR", `RISEx ${risexSymbolOf(m)}: max_leverage "${m.config.max_leverage}" is not a positive integer — nothing was sent`, { exchange: "risex" });
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > max) {
      throw new PerpError("INVALID_PARAMS", `RISEx ${risexSymbolOf(m)} leverage must be an integer 1..${max} (got ${leverage})`, { exchange: "risex" });
    }
    // The on-chain position slot of this market (also for a market never traded: size 0 + its mode).
    const pos = await this.client.get<{ position?: Record<string, unknown> }>("/v1/account/position", { account: lower(account), market_id: m.market_id });
    if (pos.position === undefined || pos.position === null) throw new PerpError("EXCHANGE_ERROR", "RISEx /v1/account/position: no position object", { exchange: "risex" });
    const hasPosition = Number(decReq(pos.position.size, "position size")) !== 0;
    const currentMode = marginModeOf(pos.position.margin_mode);
    const raw: unknown[] = [];
    if (marginMode !== null && marginMode !== currentMode) {
      if (hasPosition) {
        throw new PerpError("INVALID_PARAMS", `RISEx cannot switch ${risexSymbolOf(m)} to ${marginMode} margin while a position is open`, {
          exchange: "risex", remediation: "Close the position first",
        });
      }
      const { permit } = await this.permit(account, signer, marginModeHash(Number(m.market_id), MARGIN_MODE_CODE[marginMode]));
      raw.push(await this.sendAccountAction("/v1/account/margin-mode", { market_id: m.market_id, margin_mode: MARGIN_MODE_CODE[marginMode], permit_params: permit }, "margin mode"));
    }
    const { permit } = await this.permit(account, signer, leverageHash(Number(m.market_id), leverage));
    raw.push(await this.sendAccountAction("/v1/account/leverage", { market_id: m.market_id, leverage: String(leverage), permit_params: permit }, "leverage"));
    return { venue: "risex", symbol: risexSymbolOf(m), leverage, marginMode: marginMode ?? currentMode, venueRaw: raw };
  }

  private async sendAccountAction(path: string, body: unknown, what: string): Promise<unknown> {
    let res: { receipt?: { status?: unknown } };
    try {
      res = await this.client.post(path, body, what);
    } catch (e) {
      if (e instanceof RisexSendUnknown) {
        throw new PerpError("ORDER_PENDING", `RISEx ${what} update: outcome unknown — ${extractErrorMessage(e.cause)}`, {
          exchange: "risex", remediation: "Do NOT resubmit blindly — check perp -e risex account positions / settings first",
        });
      }
      throw e;
    }
    if (res.receipt !== undefined && res.receipt.status !== 1) {
      throw new PerpError("ACTION_REJECTED", `RISEx ${what} update reverted (receipt status ${String(res.receipt.status)})`, { exchange: "risex" });
    }
    return res;
  }

  async getOrderStatus(symbol: string, ref: OrderRef): Promise<OrderResult> {
    const m = await this.market(symbol);
    const sym = risexSymbolOf(m);
    let o: HistoryOrder | undefined;
    if (ref.kind === "orderId") {
      try {
        const d = await this.client.get<{ order?: HistoryOrder }>(`/v1/orders/by-id/${encodeURIComponent(ref.value)}`, { market_id: m.market_id });
        o = d.order;
      } catch (e) {
        if (!(e instanceof PerpError && e.structured.details?.status === 404)) throw e;
      }
    } else {
      o = (await this.historyOrders({ marketId: m.market_id, limit: 200 })).find(x => x.client_order_id === ref.value);
      if (o === undefined) {
        const open = (await this.openOrdersRaw(m.market_id)).find(x => x.client_order_id === ref.value);
        if (open !== undefined) {
          return withExecution({
            venue: "risex", symbol: sym, status: "open", finality: "final", orderId: open.order_id, clientOrderId: ref.value,
            filledSize: null, avgPrice: null, venueRaw: open,
          }, "read", { notes: ["on-chain open order (not indexed yet)"] });
        }
      }
    }
    if (o === undefined || o === null) {
      throw new PerpError("ORDER_NOT_FOUND", `RISEx: order ${ref.kind === "clientOrderId" ? "c:" : ""}${ref.value} not found on ${sym}`, { exchange: "risex" });
    }
    const status = historyStatus(o);
    const filled = decOrNull(o.filled_size);
    return withExecution({
      venue: "risex", symbol: sym, status, finality: "final", orderId: o.id,
      clientOrderId: typeof o.client_order_id === "string" && o.client_order_id !== "" && o.client_order_id !== "0" ? o.client_order_id : null,
      filledSize: filled === null ? null : trimDecimal(filled), avgPrice: positiveOrNull(o.avg_price), venueRaw: o,
    }, "read", { tifSent: o.time_in_force ?? null });
  }

  // ── Legacy trading shims ──

  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { reduceOnly: boolean; slippage: ResolvedSlippage; clientOrderId?: string }): Promise<unknown> {
    return this.placeOrder({
      symbol, side, type: "market", size, price: null, triggerPrice: null, triggerSource: null, tif: null,
      reduceOnly: opts.reduceOnly, clientOrderId: opts.clientOrderId ?? null, slippage: opts.slippage, tpsl: null,
    });
  }

  async limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string; clientOrderId?: string }): Promise<unknown> {
    const tif = opts?.tif !== undefined ? validateLegacyTif(this.venue, this.caps, opts.tif) : "GTC";
    return this.placeOrder({
      symbol, side, type: "limit", size, price, triggerPrice: null, triggerSource: null, tif,
      reduceOnly: opts?.reduceOnly === true, clientOrderId: opts?.clientOrderId ?? null, slippage: null, tpsl: null,
    });
  }

  async editOrder(): Promise<unknown> {
    return this.amendOrder({ symbol: "", ref: { kind: "orderId", value: "" }, price: "0", size: "0", tif: null });
  }

  async cancelOrder(symbol: string, orderId: string): Promise<unknown> {
    return this.cancelByRef(symbol, parseOrderRef(orderId));
  }

  async cancelAllOrders(symbol?: string): Promise<unknown> {
    return this.cancelAllV2(symbol ?? null);
  }

  async setLeverage(symbol: string, leverage: number, marginMode?: "cross" | "isolated"): Promise<unknown> {
    return this.applyLeverage(symbol, leverage, marginMode ?? null);
  }

  async stopOrder(): Promise<unknown> {
    throw unsupported(this.venue.displayName, "stopOrders", "TP/SL and stop orders are not implemented for RISEx yet", "Set TP/SL in the RISEx app");
  }

  /** TP/SL entries are refused before the entry is sent (not implemented yet). */
  stopOrderGate(): PerpError {
    return unsupported(this.venue.displayName, "stopOrders", "TP/SL and stop orders are not implemented for RISEx yet", "Set TP/SL in the RISEx app");
  }

  /** Bots / TWAP / grid / funding-arb legs stay off until RISEx trading is verified on mainnet. */
  automationGate(): PerpError {
    if (!this.venue.roles.includes("trading")) return roleUnsupported(this.venue, "automation");
    return unsupported(this.venue.displayName, "automation", "unattended trading on RISEx is not enabled until its trading path is verified on mainnet (and it has no TP/SL yet)", "Trade RISEx manually with perp trade …");
  }
}

/** RISEx margin_mode code → mode; anything else is an error, never a default. */
function marginModeOf(v: unknown): "cross" | "isolated" {
  if (v === 0) return "cross";
  if (v === 1) return "isolated";
  throw new PerpError("EXCHANGE_ERROR", `RISEx: unknown margin_mode ${JSON.stringify(v)}`, { exchange: "risex" });
}

function historyStatus(o: Pick<HistoryOrder, "status" | "filled_size">): OrderStatus {
  const filled = Number(decReq(o.filled_size, "order filled_size"));
  switch (o.status) {
    case "ORDER_STATUS_OPEN": return filled > 0 ? "partiallyFilled" : "open";
    case "ORDER_STATUS_FILLED": return "filled";
    case "ORDER_STATUS_CANCELLED": return "cancelled";
    default:
      throw new PerpError("EXCHANGE_ERROR", `RISEx: unknown order status ${String(o.status)}`, { exchange: "risex" });
  }
}

/** Candle intervals → ms (the venue takes the interval in ns). */
/**
 * Candle intervals verified live (2026-10-19, market 1): each returns rows labelled with that
 * interval. 3m / 30m / 2h / 8h / 12h / 3d are answered with 1m bars (no error), so they are not
 * listed — getKlines refuses them with INVALID_PARAMS instead of returning 1m candles.
 */
export const KLINE_INTERVAL_MS: Readonly<Record<string, number>> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000, "1w": 604_800_000,
};


