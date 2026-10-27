/**
 * TxFlow adapter — official API (Beta), docs https://docs.txflow.com/api.
 *
 * Market data (markets, orderbook, trades, klines) is public. Market funding history is not
 * readable (the API documents no such read and refuses `fundingHistory` with HTTP 403).
 *
 * Account reads are public by address (`user` = the ACCOUNT address, never the agent's):
 * clearinghouseState (balance / positions), frontendOpenOrders + triggerOrders (open orders),
 * historicalOrders / orderDetails / historicalTriggerOrders (order status and history), userFills,
 * userFundings. Rows of other instrument types (spot, Outcome) are left out.
 *
 * Trading is signed by the approved AGENT key (signing.ts, Agent flow) and sent to POST /exchange
 * with `confirm: "executed"` (client.ts). The response is ONE status for the whole action and never
 * carries an order id, a fill or a resting state, so:
 *  - every order carries a client order id (`c`), and its state is read back by that id
 *    (open orders → trigger orders → order history); the venue capability is orderAck "async";
 *  - executed-but-not-yet-visible → "accepted" / finality "pending" (never a guessed fill);
 *  - an unknown send outcome → one read-only reconciliation by client id; otherwise ORDER_PENDING
 *    ("do NOT resubmit");
 *  - a cancel is only reported cancelled when the order is gone from the open-order reads.
 * Filled size is `origSz − sz` (the remaining size): live rows show `filledAmount` is the filled
 * QUOTE notional (origSz 0.0071, sz 0, avgFillPrice 79611.7 → filledAmount 565.24307), not a size.
 *
 * Refused (CAPABILITY_UNSUPPORTED): hedge position mode (perp-cli trades one-way accounts),
 * FOK / GTD (FOK is not offered; GTD is Outcome-only per the order-types table), entry-attached
 * TP/SL groupings (legs are placed as separate reduce-only triggers after the verified fill),
 * TWAP, and unattended automation until the trading path is verified live.
 */

import { PerpError, extractErrorMessage } from "../../errors.js";
import type { TxflowAgentMeta } from "../../settings.js";
import type { EvmSigner } from "../../signer/interface.js";
import type {
  ExchangeAdapter, ExchangeBalance, ExchangeFundingPayment, ExchangeKline, ExchangeMarketInfo, ExchangeOrder,
  ExchangePosition, ExchangeTrade, ExchangePublicTrade,
  FundingHistoryRow
} from "../interface.js";
import { assertCandleInterval } from "../interface.js";
import { addDecimal, alignProtectionPrice, requireOnTick, slippagePrice, subDecimal, toUnitsExact, unitsToString } from "../precision.js";
import type { ResolvedSlippage } from "../slippage.js";
import { unsupported, validateLegacyTif, validateOrderRequest, type TradingV2 } from "../trading-v2.js";
import { networkConfig, requireCapabilities, type VenueCapabilities, type VenueCreateContext, type VenueDefinition } from "../venue.js";
import {
  parseOrderRef, toLegacyMarketInfo, withExecution,
  type AmendRequest, type CancelResult, type LeverageResult, type Network, type OrderExecution, type OrderRef, type OrderRequest,
  type OrderResult, type OrderStatus, type VenueMarket,
} from "../venue-types.js";
import { txflowShapeError, TxflowClient, TxflowSendUnknown } from "./client.js";
import { fetchTxflowDirectory, fetchTxflowMarkets, resolveTxflowMarket, type TxflowMarketMeta } from "./public.js";
import { TXFLOW_AUTOMATION_GATE } from "../venues/txflow.js";
import {
  nextTxflowNonce, signTxflowAgentAction, txflowOrderBody,
  type TxflowAgentAction, type TxflowOrderBody, type TxflowTif,
} from "./signing.js";

/**
 * Candle intervals the docs list for candleSnapshot (1m … 1d; verified live 2026-10-19, coin 1).
 * 3d / 1w / 1M are accepted by the API but answer [] for every window, so they are not offered.
 */
export const TXFLOW_KLINE_MS: Readonly<Record<string, number>> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1h": 3_600_000,
  "2h": 7_200_000, "4h": 14_400_000, "8h": 28_800_000, "12h": 43_200_000, "1d": 86_400_000,
};
export const TXFLOW_KLINE_INTERVALS: ReadonlySet<string> = new Set(Object.keys(TXFLOW_KLINE_MS));
/**
 * candleSnapshot answers an empty list (no error) when the window spans more than 3000 bars (docs;
 * measured 2026-10-19: 3000 bars OK, 3050 → [] at 1h; same at 1m / 5m / 1d), so ranges are read
 * in windows of at most 2900 bars and merged.
 */
export const TXFLOW_KLINE_WINDOW_BARS = 2900;
export const TXFLOW_KLINE_MAX_WINDOWS = 50;
/** History reads: docs `limit` default 300, max 2000 (clamped above) — refused above, never clamped. */
export const TXFLOW_HISTORY_MAX = 2000;
/** `cancel` takes at most 200 bodies per action (docs). */
export const TXFLOW_CANCEL_BATCH_MAX = 200;
/** The order-history code of `orderDetails` for an unknown id (live 2026-10-27: {code: 21001, "order not found"}). */
export const TXFLOW_ORDER_NOT_FOUND_CODE = 21001;
/** Read-back after an executed order: the open-order / history reads can lag the block briefly. */
const READ_BACK_ATTEMPTS = 3;
const READ_BACK_DELAY_MS = 700;
/** Cancel verification: re-lists of the open orders after an executed cancel. */
const CANCEL_VERIFY_ATTEMPTS = 3;
const CANCEL_VERIFY_DELAY_MS = 700;

/** Legacy market row plus the label every TxFlow row carries in JSON output. */
export type TxflowMarketInfo = ExchangeMarketInfo & { fundingVerified: false };

export interface TxflowAdapterDeps {
  /** The account (master address) reads are for; null = public market data only. */
  account: string | null;
  /** The approved agent key; null = no trading. */
  signer: EvmSigner | null;
  meta: TxflowAgentMeta | null;
  /** Why trading is unavailable when `signer` is null. */
  noSignerReason: PerpError | null;
  sleep?: (ms: number) => Promise<void>;
}

const NO_DEPS: TxflowAdapterDeps = { account: null, signer: null, meta: null, noSignerReason: null };

type Rec = Record<string, unknown>;

function dec(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^-?\d+(\.\d+)?$/.test(v)) throw txflowShapeError(`${what} is not a decimal string`);
  return v;
}

/** Plain decimal, trailing zeros dropped ("0.0071" stays, "565.240" → "565.24", "0.0000" → "0"). */
function trim(v: string): string {
  return addDecimal(v, "0");
}

function positiveOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d+(\.\d+)?$/.test(v)) return null;
  return Number(v) > 0 ? trim(v) : null;
}

function rec(v: unknown, what: string): Rec {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw txflowShapeError(`${what} is not an object`);
  return v as Rec;
}

function arr(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw txflowShapeError(`${what} is not an array`);
  return v;
}

function num(v: unknown, what: string): number {
  const n = typeof v === "string" && /^\d+$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw txflowShapeError(`${what} is not an integer`);
  return n;
}

function sideOf(v: unknown, what: string): "buy" | "sell" {
  if (v === "B") return "buy";
  if (v === "A") return "sell";
  throw txflowShapeError(`${what} side ${JSON.stringify(v)}`);
}

/** Filled base size = original − remaining (exact decimals). */
function filledOf(origSz: unknown, sz: unknown, what: string): string {
  const f = subDecimal(dec(origSz, `${what} origSz`), dec(sz, `${what} sz`));
  if (f.startsWith("-")) throw txflowShapeError(`${what} remaining size exceeds its original size`);
  return f;
}

function marginModeOf(v: unknown, what: string): "cross" | "isolated" {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  if (s === "cross") return "cross";
  if (s === "isolated") return "isolated";
  throw txflowShapeError(`${what} margin mode ${JSON.stringify(v)}`);
}

/** CLI TIF → the venue's order tif. */
const TIF_SENT: Readonly<Record<string, TxflowTif>> = { GTC: "Gtc", IOC: "Ioc", ALO: "Alo" };

/**
 * Terminal / history status (historicalOrders `status`; vocabulary seen live 2026-10-27:
 * filled, partialFilled, partialCanceled, canceled) → OrderStatus. "rejected" is mapped too. An
 * unknown value is EXCHANGE_ERROR, never a guess. partialCanceled rows always carried a fill
 * (1865 of 1865 sampled), reported as a final partial fill with its filled size.
 */
export function txflowHistoryStatus(status: unknown, filled: string): OrderStatus {
  switch (status) {
    case "filled": return "filled";
    case "partialFilled": return "partiallyFilled";
    // Cancelled with a fill (IOC remainder, user cancel after a partial fill): a final partial fill.
    case "partialCanceled": return Number(filled) > 0 ? "partiallyFilled" : "cancelled";
    case "canceled": return "cancelled";
    case "rejected": return "rejected";
    case "open": return Number(filled) > 0 ? "partiallyFilled" : "open";
    default: throw txflowShapeError(`order status ${JSON.stringify(status)}`);
  }
}

/** A client order id the venue accepts: 1–64 bytes, not starting with the reserved "0x". */
export function assertTxflowCloid(id: string): void {
  if (Buffer.byteLength(id, "utf8") < 1 || Buffer.byteLength(id, "utf8") > 64 || /^0x/i.test(id)) {
    throw new PerpError("INVALID_PARAMS", `TxFlow client order id must be 1-64 bytes and must not start with "0x" (got "${id}")`);
  }
}

interface OpenRow { row: Rec; trigger: boolean }

export class TxflowAdapter implements ExchangeAdapter, TradingV2 {
  readonly name = "txflow" as const;
  readonly aliases = ["txf"] as const;
  private readonly client: TxflowClient;
  private readonly deps: TxflowAdapterDeps;
  private dir: Promise<TxflowMarketMeta[]> | null = null;

  constructor(readonly venue: VenueDefinition, readonly network: Network, deps: TxflowAdapterDeps = NO_DEPS) {
    this.client = new TxflowClient(networkConfig(venue, network).restUrl, venue.rateLimit);
    this.deps = deps;
  }

  /** Resolve the account and the agent signer from the create context (OWS only). */
  static async create(def: VenueDefinition, ctx: VenueCreateContext): Promise<TxflowAdapter> {
    networkConfig(def, ctx.network);
    const net = ctx.network === "testnet" ? " -n testnet" : "";
    const approveHint = `perp${net} wallet agent approve txflow --master <ows-wallet> (or import one created in the TxFlow web app: perp${net} wallet agent import txflow)`;
    if (ctx.readOnly) return new TxflowAdapter(def, ctx.network);
    // Master address (reads only — the venue accepts trading signatures from an approved agent only).
    let masterAddress: string | null = null;
    if (ctx.credentials.owsWallet !== null) {
      const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
      masterAddress = OwsEvmSigner.create(ctx.credentials.owsWallet, ctx.credentials.owsPassphrase ?? "").getAddress();
    } else if (ctx.credentials.pk !== null) {
      const { Wallet } = await import("ethers");
      masterAddress = new Wallet(ctx.credentials.pk).address;
    }
    const raw = ctx.noAgent ? null : ctx.credentials.agent;
    const meta = raw !== null && (raw as { kind?: unknown }).kind === "txflow" ? raw as TxflowAgentMeta : null;
    if (meta === null) {
      return new TxflowAdapter(def, ctx.network, {
        account: masterAddress, signer: null, meta: null,
        noSignerReason: new PerpError("AGENT_NOT_REGISTERED", ctx.noAgent
          ? "TxFlow accepts trading actions only from an approved agent key (--no-agent was given)"
          : "No TxFlow agent is registered on this computer", { exchange: "txflow", remediation: approveHint }),
      });
    }
    let reason: PerpError | null = null;
    if (meta.network !== ctx.network) {
      reason = new PerpError("AGENT_NOT_REGISTERED", `TxFlow agent "${meta.agentName}" was registered on ${meta.network}, not ${ctx.network}`, { exchange: "txflow", remediation: approveHint });
    } else if (masterAddress !== null && masterAddress.toLowerCase() !== meta.accountAddress.toLowerCase()) {
      reason = new PerpError("AGENT_NOT_REGISTERED", `TxFlow agent "${meta.agentName}" trades for ${meta.accountAddress}, not the selected master ${masterAddress}`, { exchange: "txflow", remediation: approveHint });
    }
    if (reason !== null) {
      return new TxflowAdapter(def, ctx.network, { account: masterAddress ?? meta.accountAddress, signer: null, meta, noSignerReason: reason });
    }
    const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
    const signer = OwsEvmSigner.create(meta.agentWalletName, "");
    if (signer.getAddress().toLowerCase() !== meta.agentAddress.toLowerCase()) {
      throw new PerpError("KEY_NOT_FOUND", `OWS wallet "${meta.agentWalletName}" does not hold TxFlow agent ${meta.agentAddress}`, { exchange: "txflow", remediation: approveHint });
    }
    return new TxflowAdapter(def, ctx.network, { account: meta.accountAddress, signer, meta, noSignerReason: null });
  }

  // ── Internals ──

  private get caps(): VenueCapabilities {
    return requireCapabilities(this.venue);
  }

  private netFlag(): string {
    return this.network === "testnet" ? " -n testnet" : "";
  }

  private requireAccount(): string {
    if (this.deps.account === null) {
      throw new PerpError("NO_SIGNER_AVAILABLE", "TxFlow account reads need the account address: select the master wallet (perp wallet use <name> / --ows <name>) or register an agent", {
        exchange: "txflow", remediation: `perp${this.netFlag()} wallet agent approve txflow --master <ows-wallet> (or select the master wallet: perp wallet use <name>)`,
      });
    }
    return this.deps.account;
  }

  private requireSigner(): { account: string; signer: EvmSigner } {
    requireCapabilities(this.venue);
    if (this.deps.signer === null) {
      throw this.deps.noSignerReason ?? new PerpError("AGENT_NOT_REGISTERED", "No TxFlow agent key", {
        exchange: "txflow", remediation: `perp${this.netFlag()} wallet agent approve txflow --master <ows-wallet>`,
      });
    }
    return { account: this.requireAccount(), signer: this.deps.signer };
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise(r => setTimeout(r, ms));
  }

  private directory(): Promise<TxflowMarketMeta[]> {
    if (this.dir === null) {
      this.dir = fetchTxflowDirectory(this.client);
      this.dir.catch(() => { this.dir = null; });
    }
    return this.dir;
  }

  private async market(symbol: string): Promise<TxflowMarketMeta> {
    return resolveTxflowMarket(await this.directory(), symbol);
  }

  /** Symbol of a perp instrument id; an id the directory does not list is EXCHANGE_ERROR (never guessed). */
  private async symbolOfIndex(id: number): Promise<string> {
    const m = (await this.directory()).find(x => x.index === id);
    if (m === undefined) throw txflowShapeError(`instrument id ${id} is not a listed perp market`);
    return m.symbol;
  }

  /** The account's address (reads / the agent's owner). */
  accountAddress(): string {
    return this.requireAccount();
  }

  // ── Market data ──

  async getVenueMarkets(): Promise<VenueMarket[]> {
    return fetchTxflowMarkets(this.network);
  }

  async getMarkets(): Promise<TxflowMarketInfo[]> {
    return (await this.getVenueMarkets()).map(m => ({ ...toLegacyMarketInfo(m), fundingVerified: false }));
  }

  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    const m = await this.market(symbol);
    const res = await this.client.info<{ levels?: unknown }>({ type: "l2Book", coin: String(m.index) });
    const levels = res?.levels;
    if (!Array.isArray(levels) || levels.length !== 2 || !Array.isArray(levels[0]) || !Array.isArray(levels[1])) {
      throw txflowShapeError("l2Book has no [bids, asks] levels");
    }
    const side = (rows: unknown[]): [string, string][] => rows.map(r => {
      const x = r as { px?: unknown; sz?: unknown };
      return [dec(x.px, "l2Book px"), dec(x.sz, "l2Book sz")];
    });
    return { bids: side(levels[0] as unknown[]), asks: side(levels[1] as unknown[]) };
  }

  async getRecentTrades(symbol: string, limit = 50): Promise<ExchangePublicTrade[]> {
    const m = await this.market(symbol);
    const res = await this.client.info<unknown>({ type: "trades", coin: String(m.index) });
    if (!Array.isArray(res)) throw txflowShapeError("trades is not an array");
    return res.slice(0, limit).map(t => {
      const x = t as { side?: unknown; px?: unknown; sz?: unknown; time?: unknown };
      if (x.side !== "B" && x.side !== "A") throw txflowShapeError(`trade side ${String(x.side)}`);
      if (typeof x.time !== "number") throw txflowShapeError("trade without time");
      // Public tape: no fee applies to the viewer → null (ExchangePublicTrade), never "0".
      return { time: x.time, symbol: m.symbol, side: x.side === "B" ? "buy" : "sell", price: dec(x.px, "trade px"), size: dec(x.sz, "trade sz"), fee: null };
    });
  }

  async getFundingHistory(): Promise<FundingHistoryRow[]> {
    throw unsupported("txflow", "fundingHistory", "TxFlow publishes no market funding-history read (its API refuses fundingHistory with HTTP 403)",
      "Current TxFlow funding (unverified, per hour): perp -e txflow market info <symbol>, or perp arb scan --rates --include-unverified");
  }

  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<ExchangeKline[]> {
    const ms = TXFLOW_KLINE_MS[interval];
    if (ms === undefined) {
      throw new PerpError("INVALID_PARAMS", `TxFlow: unsupported candle interval "${interval}"`, {
        remediation: `Use one of: ${[...TXFLOW_KLINE_INTERVALS].join(", ")}`,
      });
    }
    const span = TXFLOW_KLINE_WINDOW_BARS * ms;
    const windows = Math.max(1, Math.ceil((endTime - startTime) / span));
    if (windows > TXFLOW_KLINE_MAX_WINDOWS) {
      throw new PerpError("INVALID_PARAMS", `TxFlow: ${interval} candles over this range need ${windows} requests (max ${TXFLOW_KLINE_MAX_WINDOWS})`, {
        remediation: "Narrow --start / --end or use a longer interval",
      });
    }
    const m = await this.market(symbol);
    const byTime = new Map<number, ExchangeKline>();
    // Disjoint windows [from, to), each within the venue's silent ~3000-bar cap; merged by open time.
    for (let from = startTime; ; from += span) {
      const to = Math.min(from + span, endTime);
      const res = await this.client.info<unknown>({ type: "candleSnapshot", req: { coin: String(m.index), interval, startTime: from, endTime: to } });
      if (!Array.isArray(res)) throw txflowShapeError("candleSnapshot is not an array");
      for (const c of res) {
        const x = c as Record<string, unknown>;
        if (typeof x.t !== "number") throw txflowShapeError("candle without t");
        assertCandleInterval("txflow", interval, x.i);
        byTime.set(x.t, {
          time: x.t,
          open: dec(x.o, "candle o"), high: dec(x.h, "candle h"), low: dec(x.l, "candle l"), close: dec(x.c, "candle c"),
          volume: dec(x.v, "candle v"),
          quoteVolume: null,
          trades: typeof x.n === "number" ? x.n : null,
        });
      }
      if (to >= endTime) break;
    }
    return [...byTime.values()].sort((a, b) => a.time - b.time);
  }

  // ── Account (public by address) ──

  private async clearinghouse(): Promise<Rec> {
    return rec(await this.client.info<unknown>({ type: "clearinghouseState", user: this.requireAccount(), accountType: "perp" }), "clearinghouseState");
  }

  private positionRows(state: Rec): Rec[] {
    return arr(state.assetPositions, "clearinghouseState assetPositions").map(r => rec(rec(r, "assetPositions row").position, "assetPositions position"));
  }

  async getBalance(): Promise<ExchangeBalance> {
    const state = await this.clearinghouse();
    const ms = rec(state.marginSummary, "clearinghouseState marginSummary");
    let upnl = "0";
    for (const p of this.positionRows(state)) upnl = addDecimal(upnl, dec(p.unrealizedPnl, "position unrealizedPnl"));
    return {
      equity: trim(dec(ms.accountValue, "marginSummary accountValue")),
      available: trim(dec(state.withdrawable, "clearinghouseState withdrawable")),
      marginUsed: trim(dec(ms.totalMarginUsed, "marginSummary totalMarginUsed")),
      unrealizedPnl: upnl,
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    const out: ExchangePosition[] = [];
    for (const p of this.positionRows(await this.clearinghouse())) {
      const szi = dec(p.szi, "position szi");
      if (Number(szi) === 0) continue;
      const lev = rec(p.leverage, "position leverage");
      if (typeof lev.value !== "number" || !(lev.value > 0)) throw txflowShapeError("position leverage value");
      out.push({
        symbol: await this.symbolOfIndex(num(p.asset, "position asset")),
        side: szi.startsWith("-") ? "short" : "long",
        size: trim(szi.replace(/^-/, "")),
        entryPrice: trim(dec(p.entryPx, "position entryPx")),
        markPrice: trim(dec(p.markPx, "position markPx")),
        liquidationPrice: positiveOrNull(p.liquidationPx),
        unrealizedPnl: trim(dec(p.unrealizedPnl, "position unrealizedPnl")),
        leverage: lev.value,
        marginMode: marginModeOf(lev.type, "position leverage"),
      });
    }
    return out;
  }

  /** Perp open orders (frontendOpenOrders, instrumentType Perps) plus untriggered triggers (triggerOrders). */
  private async openRows(asset: number | null): Promise<OpenRow[]> {
    const user = this.requireAccount();
    const filter = asset === null ? {} : { asset: String(asset) };
    const [front, triggers] = await Promise.all([
      this.client.info<unknown>({ type: "frontendOpenOrders", user, ...filter }),
      this.client.info<unknown>({ type: "triggerOrders", user, ...filter }),
    ]);
    const out: OpenRow[] = [];
    const seen = new Set<number>();
    for (const r of arr(front, "frontendOpenOrders")) {
      const x = rec(r, "frontendOpenOrders row");
      if (x.instrumentType !== "Perps") continue;
      seen.add(num(x.oid, "open order oid"));
      out.push({ row: x, trigger: x.isTrigger === true });
    }
    for (const r of arr(triggers, "triggerOrders")) {
      const x = rec(r, "triggerOrders row");
      if (seen.has(num(x.oid, "trigger order oid"))) continue;
      out.push({ row: x, trigger: true });
    }
    return out;
  }

  private async toOpenOrder(o: OpenRow): Promise<ExchangeOrder> {
    const x = o.row;
    if ("triggerState" in x && !("origSz" in x)) {
      // triggerOrders row: an untriggered stop / TP / SL.
      const kind = typeof x.orderType === "string" ? x.orderType.toLowerCase() : "trigger";
      return {
        orderId: String(num(x.oid, "trigger oid")), symbol: await this.symbolOfIndex(num(x.asset, "trigger asset")),
        side: sideOf(x.side, "trigger"), price: trim(dec(x.limitPx, "trigger limitPx")), size: trim(dec(x.sz, "trigger sz")),
        filled: "0", status: typeof x.triggerState === "string" && x.triggerState !== "" ? x.triggerState : "untriggered",
        type: `trigger ${kind}${x.reduceOnly === true ? " reduce-only" : ""}`, triggerPrice: trim(dec(x.triggerPx, "trigger triggerPx")),
      };
    }
    const state = x.state === "Open" ? "open" : x.state === "PartialFilled" ? "partiallyFilled" : String(x.state);
    const kind = typeof x.orderType === "string" ? x.orderType.toLowerCase() : "order";
    return {
      orderId: String(num(x.oid, "open order oid")), symbol: await this.symbolOfIndex(num(x.asset, "open order asset")),
      side: sideOf(x.side, "open order"), price: trim(dec(x.limitPx, "open order limitPx")), size: trim(dec(x.origSz, "open order origSz")),
      filled: filledOf(x.origSz, x.sz, "open order"), status: state,
      type: `${kind}${typeof x.tif === "string" && x.tif !== "" ? ` ${x.tif}` : ""}${x.reduceOnly === true ? " reduce-only" : ""}`,
      triggerPrice: o.trigger ? positiveOrNull(x.triggerPx) : null,
    };
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    return Promise.all((await this.openRows(null)).map(o => this.toOpenOrder(o)));
  }

  private historyLimit(limit: number): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > TXFLOW_HISTORY_MAX) {
      throw new PerpError("INVALID_PARAMS", `TxFlow: history limit must be 1..${TXFLOW_HISTORY_MAX} (got ${limit})`, { remediation: `TxFlow serves at most ${TXFLOW_HISTORY_MAX} rows per request` });
    }
    return limit;
  }

  private async historyRows(q: { coin?: number; limit: number }): Promise<Rec[]> {
    const d = rec(await this.client.info<unknown>({
      type: "historicalOrders", user: this.requireAccount(), accountType: ["perp"], limit: q.limit, ...(q.coin !== undefined ? { coin: String(q.coin) } : {}),
    }), "historicalOrders");
    return arr(d.data, "historicalOrders data").map(r => rec(r, "historicalOrders row"));
  }

  private async toHistoryOrder(r: Rec): Promise<ExchangeOrder> {
    const o = rec(r.order, "historicalOrders order");
    return {
      orderId: String(num(o.oid, "history oid")), symbol: await this.symbolOfIndex(num(o.instrumentId, "history instrumentId")),
      side: sideOf(o.side, "history order"), price: trim(dec(o.limitPx, "history limitPx")), size: trim(dec(o.origSz, "history origSz")),
      filled: filledOf(o.origSz, o.sz, "history order"), status: typeof r.status === "string" ? r.status : String(o.status),
      type: `${String(o.orderType).toLowerCase()} ${String(o.tif)}${o.reduceOnly === true ? " reduce-only" : ""}`,
      triggerPrice: o.isTrigger === true ? positiveOrNull(o.triggerPx) : null,
    };
  }

  async getOrderHistory(limit = 50): Promise<ExchangeOrder[]> {
    return Promise.all((await this.historyRows({ limit: this.historyLimit(limit) })).map(r => this.toHistoryOrder(r)));
  }

  async getTradeHistory(limit = 50): Promise<ExchangeTrade[]> {
    const d = rec(await this.client.info<unknown>({ type: "userFills", user: this.requireAccount(), accountType: ["perp"], limit: this.historyLimit(limit) }), "userFills");
    return Promise.all(arr(d.data, "userFills data").map(async r => {
      const x = rec(r, "userFills row");
      if (typeof x.time !== "number") throw txflowShapeError("fill without time");
      return {
        time: x.time, symbol: await this.symbolOfIndex(num(x.instrumentId, "fill instrumentId")), side: sideOf(x.side, "fill"),
        price: trim(dec(x.px, "fill px")), size: trim(dec(x.sz, "fill sz")), fee: trim(dec(x.fee, "fill fee")),
      };
    }));
  }

  /**
   * `payment` positive = RECEIVED (userFundings `amount`: collected > 0, paid < 0). The row names
   * the market by its display `coin` ("BTC") only — the venue's own name, kept as the symbol.
   */
  async getFundingPayments(limit = 100): Promise<ExchangeFundingPayment[]> {
    const d = rec(await this.client.info<unknown>({ type: "userFundings", user: this.requireAccount(), accountType: ["perp"], limit: this.historyLimit(limit) }), "userFundings");
    return arr(d.data, "userFundings data").map(r => {
      const x = rec(r, "userFundings row");
      if (typeof x.time !== "number" || typeof x.coin !== "string" || x.coin === "") throw txflowShapeError("funding row without time / coin");
      return { time: x.time, symbol: x.coin.toUpperCase().replace(/-USDC$/, ""), payment: trim(dec(x.amount, "funding amount")) };
    });
  }

  // ── TradingV2 ──

  /** Mark price of one market (activeAssetCtx) — the reference of market-order protection prices. */
  private async markOf(m: TxflowMarketMeta): Promise<string> {
    const d = rec(await this.client.info<unknown>({ type: "activeAssetCtx", coin: String(m.index) }), "activeAssetCtx");
    const mark = positiveOrNull(d.markPx);
    if (mark === null) throw new PerpError("PRICE_STALE", `TxFlow ${m.symbol}: no mark price to bound the order — nothing was sent`, { exchange: "txflow" });
    return mark;
  }

  /** The account's position mode + margin mode on one market (activeAssetData). Hedge mode is refused. */
  private async assetSettings(account: string, m: TxflowMarketMeta): Promise<{ marginMode: "cross" | "isolated"; leverage: number }> {
    const d = rec(await this.client.info<unknown>({ type: "activeAssetData", user: account, coin: String(m.index) }), "activeAssetData");
    const lev = rec(d.leverage, "activeAssetData leverage");
    if (lev.mode === "hedge") {
      throw unsupported(this.venue.displayName, "hedgeMode", "the account is in hedge position mode; perp-cli trades TxFlow accounts in one-way mode only",
        "Switch the account to one-way mode in the TxFlow web app, then retry");
    }
    if (lev.mode !== "oneWay") throw txflowShapeError(`activeAssetData position mode ${JSON.stringify(lev.mode)}`);
    if (typeof lev.value !== "number") throw txflowShapeError("activeAssetData leverage value");
    return { marginMode: marginModeOf(lev.type, "activeAssetData leverage"), leverage: lev.value };
  }

  /** Sign + send one agent action. Definite refusals throw; an unknown outcome throws TxflowSendUnknown. */
  private async send(signer: EvmSigner, action: TxflowAgentAction, what: string, rejectCode: "ORDER_REJECTED" | "ACTION_REJECTED"): Promise<void> {
    const nonce = nextTxflowNonce();
    const signature = await signTxflowAgentAction(signer, this.network, action, nonce);
    await this.client.exchange({ action: action as unknown as Record<string, unknown>, signature, nonce }, what, rejectCode, this.network);
  }

  async placeOrder(req: OrderRequest): Promise<OrderResult> {
    const caps = this.caps;
    validateOrderRequest(this.venue, caps, req);
    const { account, signer } = this.requireSigner();
    const cloid = req.clientOrderId as string; // orderAck "async": validateOrderRequest requires it
    assertTxflowCloid(cloid);
    const m = await this.market(req.symbol);
    const sym = m.symbol;
    if (m.halted) throw new PerpError("ORDER_REJECTED", `TxFlow ${sym} is halted — nothing was sent`, { exchange: "txflow", sent: false });
    const sizeUnits = toUnitsExact(req.size, m.stepSize, "size");
    if (sizeUnits <= 0n) throw new PerpError("SIZE_TOO_SMALL", `TxFlow ${sym} size must be at least ${m.stepSize}`, { exchange: "txflow" });
    const size = unitsToString(sizeUnits, m.stepSize);
    const settings = await this.assetSettings(account, m);

    const isStop = req.type === "stopMarket" || req.type === "stopLimit";
    let price: string;
    let t: TxflowOrderBody["t"];
    let referencePrice: string | null = null;
    let tifSent: string | null = null;
    const notes: string[] = [`margin mode: the account's current ${settings.marginMode} mode on ${sym} (m omitted — the node routes to it)`];
    let method: string;
    if (req.type === "market") {
      const slip = req.slippage as ResolvedSlippage;
      referencePrice = await this.markOf(m);
      price = alignProtectionPrice(slippagePrice(referencePrice, req.side, slip.bps), m.tickSize, req.side);
      t = { limit: { tif: "Ioc" } };
      tifSent = "Ioc";
      method = "protectedIoc";
      notes.push("the venue also caps market fills at oracle ± 5% (docs: Position & Order Limits)");
    } else if (req.type === "limit") {
      price = requireOnTick(req.price as string, m.tickSize);
      const tif = TIF_SENT[req.tif as string];
      if (tif === undefined) throw unsupported(this.venue.displayName, "timeInForce", `time-in-force ${String(req.tif)} is not offered`, `Use one of: ${caps.timeInForce.join(", ")}`);
      t = { limit: { tif } };
      tifSent = tif;
      method = "limit";
    } else {
      const trigger = requireOnTick(req.triggerPrice as string, m.tickSize);
      if (req.triggerSource !== null && req.triggerSource !== "mark") {
        throw unsupported(this.venue.displayName, "triggerType", "TP / SL / stop triggers fire on the MARK price only (docs: Orders & Time-in-Force)", "Omit --trigger-type (or pass mark)");
      }
      const kind = await this.stopKind(m, req.side, trigger, (req as OrderRequest & { kind?: "tp" | "sl" }).kind ?? null, notes);
      // A market trigger carries the trigger price as `p` (the docs do not say how `p` is used once
      // a market trigger fires); a stop-limit carries its limit price.
      price = req.type === "stopLimit" ? requireOnTick(req.price as string, m.tickSize) : trigger;
      t = { trigger: { isMarket: req.type === "stopMarket", triggerPx: trigger, tpsl: kind } };
      referencePrice = trigger;
      method = req.type === "stopLimit" ? "triggerLimit" : "trigger";
      notes.push("trigger fires on the mark price; a fired order is not guaranteed to fill (docs: Triggered is not filled)");
    }
    const body = txflowOrderBody({ asset: m.index, isBuy: req.side === "buy", price, size, reduceOnly: req.reduceOnly, type: t, cloid });
    const action: TxflowAgentAction = { type: "order", grouping: isStop ? "normalTrigger" : "na", orders: [body] };

    const { logClientId } = await import("../../client-id-tracker.js");
    const now = new Date().toISOString();
    const logType = req.type === "market" || req.type === "limit" ? req.type : "stop";
    logClientId({ clientOrderId: cloid, exchange: "txflow", symbol: sym, side: req.side, size, price, type: logType, status: "pending", createdAt: now, updatedAt: now });
    const exec: Partial<Omit<OrderExecution, "method">> = {
      slippageBps: req.type === "market" ? (req.slippage as ResolvedSlippage).bps : null,
      slippageSource: req.type === "market" ? (req.slippage as ResolvedSlippage).source : null,
      protectionPrice: req.type === "market" ? price : null, referencePrice, tifRequested: req.tif, tifSent,
    };
    try {
      await this.send(signer, action, `place ${req.type} order`, "ORDER_REJECTED");
    } catch (e) {
      if (!(e instanceof TxflowSendUnknown)) {
        logClientId({ clientOrderId: cloid, exchange: "txflow", symbol: sym, side: req.side, size, price, type: logType, status: "failed", createdAt: now, updatedAt: new Date().toISOString() });
        throw e;
      }
      return this.reconcilePlace(sym, cloid, e, method, { ...exec, notes });
    }
    logClientId({ clientOrderId: cloid, exchange: "txflow", symbol: sym, side: req.side, size, price, type: logType, status: "submitted", createdAt: now, updatedAt: new Date().toISOString() });
    notes.push("executed (confirm: executed); the venue response carries no order id or fill — read back by client order id");
    for (let i = 0; i < READ_BACK_ATTEMPTS; i++) {
      try {
        const r = await this.getOrderStatus(sym, { kind: "clientOrderId", value: cloid });
        return { ...r, clientOrderId: cloid, execution: { ...r.execution, ...exec, method, notes: [...notes, ...r.execution.notes] } };
      } catch (e) {
        if (!(e instanceof PerpError && e.structured.code === "ORDER_NOT_FOUND")) {
          notes.push(`read-back failed: ${extractErrorMessage(e)}`);
          break;
        }
        if (i < READ_BACK_ATTEMPTS - 1) await this.sleep(READ_BACK_DELAY_MS);
      }
    }
    return withExecution({
      venue: "txflow", symbol: sym, status: "accepted", finality: "pending", orderId: null, clientOrderId: cloid, filledSize: null, avgPrice: null,
      venueRaw: { action: action.type, grouping: action.grouping, cloid },
    }, method, { ...exec, notes: [...notes, "executed, but not visible on the order reads yet"] });
  }

  /**
   * The tp / sl tag of a trigger: given explicitly (TP/SL legs), else classified from the trigger
   * vs the mark like a protective order — a sell trigger below the mark (or a buy above it) is a
   * stop-loss, the other side a take-profit. A trigger equal to the mark is refused.
   */
  private async stopKind(m: TxflowMarketMeta, side: "buy" | "sell", trigger: string, given: "tp" | "sl" | null, notes: string[]): Promise<"tp" | "sl"> {
    if (given !== null) return given;
    const mark = await this.markOf(m);
    const cmp = Number(subDecimal(trigger, mark));
    if (cmp === 0) throw new PerpError("INVALID_PARAMS", `TxFlow ${m.symbol}: trigger ${trigger} equals the mark ${mark} — cannot tell stop-loss from take-profit; not sent`);
    const below = cmp < 0;
    const kind = (side === "sell") === below ? "sl" : "tp";
    notes.push(`sent as ${kind}: trigger ${trigger} is ${below ? "below" : "above"} the mark ${mark}`);
    return kind;
  }

  /** One read-only reconciliation of an unknown place outcome by client order id. */
  private async reconcilePlace(sym: string, cloid: string, cause: TxflowSendUnknown, method: string, exec: Partial<Omit<OrderExecution, "method">>): Promise<OrderResult> {
    let reconcileError: string | null = null;
    try {
      const r = await this.getOrderStatus(sym, { kind: "clientOrderId", value: cloid });
      return { ...r, clientOrderId: cloid, execution: { ...r.execution, ...exec, method, notes: [...(exec.notes ?? []), ...r.execution.notes, "reconciled"] } };
    } catch (e) {
      reconcileError = extractErrorMessage(e);
    }
    throw new PerpError("ORDER_PENDING", `TxFlow place order: outcome unknown — ${extractErrorMessage(cause.cause)}`, {
      exchange: "txflow", clientOrderId: cloid, ...(cause.txHash !== null ? { txHash: cause.txHash } : {}), reconcileError,
      remediation: `Do NOT resubmit — the order may have been placed (client id ${cloid}). Check: perp${this.netFlag()} -e txflow trade status c:${cloid} --symbol ${sym}`,
    });
  }

  async amendOrder(req: AmendRequest): Promise<OrderResult> {
    requireCapabilities(this.venue);
    if (req.ref.kind !== "orderId") {
      throw unsupported(this.venue.displayName, "amendByClientOrderId", "orders are amended by venue order id (modify2 `o`)", `Look up the order id: perp${this.netFlag()} account orders -e txflow`);
    }
    if (req.tif !== null) {
      throw unsupported(this.venue.displayName, "amendTimeInForce", "modify2 amends price and size only; side, reduce-only, margin mode and time-in-force stay as they were", "Omit --tif");
    }
    const { signer } = this.requireSigner();
    const m = await this.market(req.symbol);
    const open = (await this.openRows(m.index)).find(o => String(num(o.row.oid, "open order oid")) === req.ref.value);
    if (open === undefined) {
      throw new PerpError("ORDER_NOT_FOUND", `TxFlow: no open ${m.symbol} order ${req.ref.value}`, { exchange: "txflow", remediation: `List open orders: perp${this.netFlag()} account orders -e txflow` });
    }
    if (open.trigger) {
      throw unsupported(this.venue.displayName, "amendTrigger", "modify2 amends resting limit orders; trigger orders are not amended by perp-cli", "Cancel the trigger and place a new one");
    }
    const price = requireOnTick(req.price, m.tickSize);
    const sizeUnits = toUnitsExact(req.size, m.stepSize, "size");
    if (sizeUnits <= 0n) throw new PerpError("SIZE_TOO_SMALL", `TxFlow ${m.symbol} size must be at least ${m.stepSize}`, { exchange: "txflow" });
    const size = unitsToString(sizeUnits, m.stepSize);
    const oid = num(open.row.oid, "open order oid");
    try {
      await this.send(signer, { type: "modify2", order: { o: oid, p: price, s: size } }, "amend order", "ORDER_REJECTED");
    } catch (e) {
      if (!(e instanceof TxflowSendUnknown)) throw e;
      throw new PerpError("ORDER_PENDING", `TxFlow amend order ${oid}: outcome unknown — ${extractErrorMessage(e.cause)}`, {
        exchange: "txflow", orderId: String(oid), remediation: `Do NOT resend blindly — check: perp${this.netFlag()} -e txflow trade status ${oid} --symbol ${m.symbol}`,
      });
    }
    const notes = ["size = new TOTAL size (modify2; already-filled quantity is kept)", "the order keeps its id, queue priority, TIF, reduce-only and margin mode"];
    try {
      const r = await this.getOrderStatus(m.symbol, { kind: "orderId", value: String(oid) });
      return { ...r, execution: { ...r.execution, method: "nativeAmend", notes: [...notes, ...r.execution.notes] } };
    } catch (e) {
      return withExecution({
        venue: "txflow", symbol: m.symbol, status: "accepted", finality: "pending", orderId: String(oid), clientOrderId: null, filledSize: null, avgPrice: null, venueRaw: null,
      }, "nativeAmend", { notes: [...notes, `executed; read-back failed: ${extractErrorMessage(e)}`] });
    }
  }

  /**
   * Cancel `rows` (one market) in batches of ≤200, then prove each cancel by re-listing the open
   * orders: gone → cancelled; still listed → pending (never reported cancelled).
   */
  private async cancelRows(signer: EvmSigner, asset: number, rows: OpenRow[], result: CancelResult): Promise<void> {
    const refOf = (o: OpenRow): OrderRef => ({ kind: "orderId", value: String(num(o.row.oid, "open order oid")) });
    const pending = result.pending as NonNullable<CancelResult["pending"]>;
    const sent: OpenRow[] = [];
    for (let i = 0; i < rows.length; i += TXFLOW_CANCEL_BATCH_MAX) {
      const batch = rows.slice(i, i + TXFLOW_CANCEL_BATCH_MAX);
      const cancels = batch.map(o => (o.trigger
        ? { a: asset, o: num(o.row.oid, "open order oid"), grouping: "trigger" as const }
        : { a: asset, o: num(o.row.oid, "open order oid") }));
      try {
        await this.send(signer, { type: "cancel", cancels }, "cancel", "ACTION_REJECTED");
        sent.push(...batch);
      } catch (e) {
        if (e instanceof TxflowSendUnknown) {
          for (const o of batch) pending.push({ ref: refOf(o), reason: extractErrorMessage(e.cause), remediation: `Do NOT resend blindly — check: perp${this.netFlag()} account orders -e txflow` });
          continue;
        }
        for (const o of batch) result.failed.push({ ref: refOf(o), error: extractErrorMessage(e) });
      }
    }
    if (sent.length === 0) return;
    let still = new Set<string>();
    for (let attempt = 0; attempt < CANCEL_VERIFY_ATTEMPTS; attempt++) {
      if (attempt > 0) await this.sleep(CANCEL_VERIFY_DELAY_MS);
      still = new Set((await this.openRows(asset)).map(o => String(num(o.row.oid, "open order oid"))));
      if (sent.every(o => !still.has(String(num(o.row.oid, "open order oid"))))) break;
    }
    for (const o of sent) {
      const ref = refOf(o);
      if (still.has(ref.value)) pending.push({ ref, reason: "the cancel executed but the order is still listed open", remediation: `Check: perp${this.netFlag()} account orders -e txflow` });
      else result.cancelled.push(ref);
    }
  }

  async cancelByRef(symbol: string, ref: OrderRef): Promise<CancelResult> {
    const { signer } = this.requireSigner();
    const m = await this.market(symbol);
    const open = (await this.openRows(m.index)).find(o => (ref.kind === "orderId"
      ? String(num(o.row.oid, "open order oid")) === ref.value
      : o.row.cloid === ref.value));
    if (open === undefined) {
      throw new PerpError("ORDER_NOT_FOUND", `TxFlow: no open ${m.symbol} order ${ref.kind === "clientOrderId" ? "c:" : ""}${ref.value}`, {
        exchange: "txflow", remediation: `List open orders: perp${this.netFlag()} account orders -e txflow`,
      });
    }
    const result: CancelResult = { venue: "txflow", cancelled: [], failed: [], pending: [], venueRaw: null };
    await this.cancelRows(signer, m.index, [open], result);
    return result;
  }

  async cancelAllV2(symbol: string | null): Promise<CancelResult> {
    const { signer } = this.requireSigner();
    const asset = symbol === null ? null : (await this.market(symbol)).index;
    const rows = await this.openRows(asset);
    const result: CancelResult = { venue: "txflow", cancelled: [], failed: [], pending: [], venueRaw: null };
    const byAsset = new Map<number, OpenRow[]>();
    for (const o of rows) {
      const a = num(o.row.asset, "open order asset");
      byAsset.set(a, [...(byAsset.get(a) ?? []), o]);
    }
    for (const [a, list] of byAsset) await this.cancelRows(signer, a, list, result);
    return result;
  }

  async applyLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" | null): Promise<LeverageResult> {
    const { account, signer } = this.requireSigner();
    const m = await this.market(symbol);
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > m.maxLeverage) {
      throw new PerpError("INVALID_PARAMS", `TxFlow ${m.symbol} leverage must be an integer 1..${m.maxLeverage} (got ${leverage})`, { exchange: "txflow" });
    }
    const current = await this.assetSettings(account, m);
    const raw: string[] = [];
    const unknown = (what: string, e: TxflowSendUnknown): PerpError => new PerpError("ORDER_PENDING", `TxFlow ${what}: outcome unknown — ${extractErrorMessage(e.cause)}`, {
      exchange: "txflow", remediation: `Do NOT resubmit blindly — check the setting first: perp${this.netFlag()} -e txflow account positions`,
    });
    if (marginMode !== null && marginMode !== current.marginMode) {
      try {
        await this.send(signer, { type: "updateMarginMode", asset: m.index, isCross: marginMode === "cross" }, "margin mode update", "ACTION_REJECTED");
      } catch (e) {
        if (e instanceof TxflowSendUnknown) throw unknown("margin mode update", e);
        throw e;
      }
      raw.push("updateMarginMode");
    }
    const mode = marginMode ?? current.marginMode;
    try {
      await this.send(signer, { type: "updateLeverage", asset: m.index, leverage, marginMode: mode }, "leverage update", "ACTION_REJECTED");
    } catch (e) {
      if (e instanceof TxflowSendUnknown) throw unknown("leverage update", e);
      throw e;
    }
    raw.push("updateLeverage");
    // The settings read back (activeAssetData) must show what was set — never assumed.
    const after = await this.assetSettings(account, m);
    if (after.leverage !== leverage || after.marginMode !== mode) {
      throw new PerpError("ORDER_PENDING", `TxFlow ${m.symbol}: the update executed, but activeAssetData shows ${after.leverage}x ${after.marginMode} (expected ${leverage}x ${mode})`, {
        exchange: "txflow", remediation: `Check again in a moment: perp${this.netFlag()} -e txflow account positions`,
      });
    }
    return { venue: "txflow", symbol: m.symbol, leverage, marginMode: mode, venueRaw: { executed: raw } };
  }

  /** Open order → trigger order → history (orderDetails by id, historicalOrders / historicalTriggerOrders by client id). */
  async getOrderStatus(symbol: string, ref: OrderRef): Promise<OrderResult> {
    const m = await this.market(symbol);
    const sym = m.symbol;
    const match = (x: Rec): boolean => (ref.kind === "orderId" ? String(x.oid) === ref.value : x.cloid === ref.value);
    const cloidOf = (x: Rec): string | null => (typeof x.cloid === "string" && x.cloid !== "" ? x.cloid : null);
    const open = (await this.openRows(m.index)).find(o => match(o.row));
    if (open !== undefined) {
      const x = open.row;
      const oid = String(num(x.oid, "open order oid"));
      if (!("origSz" in x)) {
        return withExecution({
          venue: "txflow", symbol: sym, status: "open", finality: "final", orderId: oid, clientOrderId: cloidOf(x), filledSize: "0", avgPrice: null, venueRaw: x,
        }, "read", { notes: [`untriggered ${String(x.orderType)} trigger @ ${String(x.triggerPx)} (triggerOrders)`] });
      }
      const filled = filledOf(x.origSz, x.sz, "open order");
      return withExecution({
        venue: "txflow", symbol: sym, status: Number(filled) > 0 ? "partiallyFilled" : "open", finality: "final", orderId: oid, clientOrderId: cloidOf(x),
        filledSize: filled, avgPrice: positiveOrNull(x.avgFillPx), venueRaw: x,
      }, "read", { tifSent: typeof x.tif === "string" ? x.tif : null, notes: open.trigger ? ["untriggered trigger order (frontendOpenOrders)"] : [] });
    }
    let row: Rec | undefined;
    if (ref.kind === "orderId") {
      try {
        const d = rec(await this.client.info<unknown>({ type: "orderDetails", orderId: num(ref.value, "order id") }), "orderDetails");
        row = rec(d.orderDetails, "orderDetails orderDetails");
      } catch (e) {
        if (!(e instanceof PerpError && e.structured.details?.venueCode === TXFLOW_ORDER_NOT_FOUND_CODE)) throw e;
      }
    } else {
      row = (await this.historyRows({ coin: m.index, limit: 200 })).find(r => rec(r.order, "historicalOrders order").cloid === ref.value);
      if (row === undefined) {
        const d = rec(await this.client.info<unknown>({ type: "historicalTriggerOrders", user: this.requireAccount(), coin: String(m.index), limit: 200 }), "historicalTriggerOrders");
        const t = arr(d.data, "historicalTriggerOrders data").map(r => rec(r, "historicalTriggerOrders row")).find(r => r.cloid === ref.value);
        if (t !== undefined) {
          const state = typeof t.triggerState === "string" ? t.triggerState : "";
          const status: OrderStatus = /cancel/i.test(state) ? "cancelled" : /reject/i.test(state) ? "rejected" : "accepted";
          return withExecution({
            venue: "txflow", symbol: sym, status, finality: status === "accepted" ? "pending" : "final", orderId: String(num(t.oid, "trigger oid")), clientOrderId: ref.value,
            filledSize: null, avgPrice: null, venueRaw: t,
          }, "read", { notes: [`trigger state ${JSON.stringify(state)} (historicalTriggerOrders) — a fired trigger's fill is a separate order`] });
        }
      }
    }
    if (row === undefined) {
      throw new PerpError("ORDER_NOT_FOUND", `TxFlow: order ${ref.kind === "clientOrderId" ? "c:" : ""}${ref.value} not found on ${sym}`, { exchange: "txflow" });
    }
    const o = rec(row.order, "order");
    if (num(o.instrumentId, "order instrumentId") !== m.index) {
      throw new PerpError("ORDER_NOT_FOUND", `TxFlow: order ${ref.value} is not a ${sym} order`, { exchange: "txflow" });
    }
    const filled = filledOf(o.origSz, o.sz, "order");
    return withExecution({
      venue: "txflow", symbol: sym, status: txflowHistoryStatus(row.status, filled), finality: "final", orderId: String(num(o.oid, "order oid")),
      clientOrderId: cloidOf(o), filledSize: filled, avgPrice: positiveOrNull(o.avgFillPrice), venueRaw: row,
    }, "read", { tifSent: typeof o.tif === "string" ? o.tif : null, notes: typeof o.cancelReason === "string" && o.cancelReason !== "" ? [o.cancelReason] : [] });
  }

  /** A TP / SL leg (separateOrders: legacy-trading-v2 placeTpSlLeg dispatches here): a reduce-only trigger. */
  async placeTpSlLeg(leg: { symbol: string; closeSide: "buy" | "sell"; size: string; trigger: string; kind: "tp" | "sl"; limitPrice: string | null; slippage: ResolvedSlippage }): Promise<OrderResult> {
    const { newVenueClientOrderId } = await import("../trading-v2.js");
    const req: OrderRequest & { kind: "tp" | "sl" } = {
      symbol: leg.symbol, side: leg.closeSide, type: leg.limitPrice === null ? "stopMarket" : "stopLimit", size: leg.size,
      price: leg.limitPrice, triggerPrice: leg.trigger, triggerSource: null, tif: leg.limitPrice === null ? null : "GTC",
      reduceOnly: true, clientOrderId: newVenueClientOrderId(this.venue), slippage: leg.limitPrice === null ? leg.slippage : null, tpsl: null, kind: leg.kind,
    };
    return this.placeOrder(req);
  }

  /** Bots / TWAP / grid / funding-arb legs stay off until the TxFlow trading path is verified live. */
  automationGate(): PerpError {
    return unsupported(this.venue.displayName, "automation", TXFLOW_AUTOMATION_GATE.reason, TXFLOW_AUTOMATION_GATE.remediation);
  }

  // ── Legacy trading shims ──

  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { reduceOnly: boolean; slippage: ResolvedSlippage; clientOrderId?: string }): Promise<unknown> {
    const { newVenueClientOrderId } = await import("../trading-v2.js");
    return this.placeOrder({
      symbol, side, type: "market", size, price: null, triggerPrice: null, triggerSource: null, tif: null,
      reduceOnly: opts.reduceOnly, clientOrderId: opts.clientOrderId ?? newVenueClientOrderId(this.venue), slippage: opts.slippage, tpsl: null,
    });
  }

  async limitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string; clientOrderId?: string }): Promise<unknown> {
    const { newVenueClientOrderId } = await import("../trading-v2.js");
    const tif = opts?.tif !== undefined ? validateLegacyTif(this.venue, this.caps, opts.tif) : "GTC";
    return this.placeOrder({
      symbol, side, type: "limit", size, price, triggerPrice: null, triggerSource: null, tif,
      reduceOnly: opts?.reduceOnly === true, clientOrderId: opts?.clientOrderId ?? newVenueClientOrderId(this.venue), slippage: null, tpsl: null,
    });
  }

  async editOrder(symbol: string, orderId: string, price: string, size: string): Promise<unknown> {
    return this.amendOrder({ symbol, ref: parseOrderRef(orderId), price, size, tif: null });
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

  async stopOrder(symbol: string, side: "buy" | "sell", size: string, triggerPrice: string, opts?: { limitPrice?: string; reduceOnly?: boolean; triggerType?: "mark" | "last" | "mid"; slippage?: ResolvedSlippage; kind?: "tp" | "sl" }): Promise<unknown> {
    const { newVenueClientOrderId } = await import("../trading-v2.js");
    const isLimit = opts?.limitPrice !== undefined;
    const req: OrderRequest & { kind?: "tp" | "sl" } = {
      symbol, side, type: isLimit ? "stopLimit" : "stopMarket", size, price: opts?.limitPrice ?? null, triggerPrice,
      triggerSource: opts?.triggerType ?? null, tif: isLimit ? "GTC" : null, reduceOnly: opts?.reduceOnly !== false,
      clientOrderId: newVenueClientOrderId(this.venue), slippage: isLimit ? null : opts?.slippage ?? null, tpsl: null,
      ...(opts?.kind !== undefined ? { kind: opts.kind } : {}),
    };
    return this.placeOrder(req);
  }
}
