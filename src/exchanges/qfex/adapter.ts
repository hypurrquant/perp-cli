/**
 * QFEX adapter — native TradingV2 + legacy ExchangeAdapter shim
 *
 * Signer: imported HMAC API key only (QfexAgentMeta → ~/.perp/qfex-agents/<publicKey>.json).
 * Orders go over the Trade WebSocket (ws-transport.ts); account reads, leverage and transfers
 * over REST; deposit address / withdraw over the banker host.
 *
 * Order entry:
 *   - market orders: IOC LIMIT at alignProtectionPrice(slippagePrice(mark, side, bps), tick,
 *     side) — the venue's native MARKET has no user bound. The reference is the MDS
 *     market_stats mark of THAT symbol, refused (PRICE_STALE) when its own `time` is older than
 *     QFEX_MARK_MAX_AGE_MS; nothing else is substituted.
 *   - limit: GTC | IOC | FOK as LIMIT; ALO as order_type ALO + GTC.
 *   - precision, bands, status, allowed order types / TIFs: /refdata only. Off-tick prices and
 *     out-of-band prices are refused, never rounded or clamped; sizes are floored to the lot.
 *   - client order ids are generated (UUID); a GTC / ALO order is returned as acknowledged
 *     (pending) after its ACK — "open" comes only from getOrderStatus (a get_user_orders row).
 *     An ALO order the venue cancels right after the ACK (it would cross) is ORDER_REJECTED
 *     { reason: "postOnlyWouldCross" }.
 *   - IOC / FOK / market: final only on a venue terminal frame; a terminal frame with zero
 *     fill is ORDER_REJECTED { reason: "iocNoFill" }; no terminal frame in time → pending.
 *
 *   - reduce-only (close / reduce / flatten, reduce-only IOC limits): `reduce_only: true`, and —
 *     because the venue accepts a reduce-only order larger than the position (Q2, signing.ts) —
 *     the adapter's own rule before every send (requireReducible) and an echo check after it.
 *
 * Refused for now (uniform CAPABILITY_UNSUPPORTED, see signing.ts constants):
 *   - a RESTING reduce-only order (GTC / ALO; capability reduceOnlyTif, and so `trade scale-tp`)
 *     until QFEX_RESTING_REDUCE_ONLY_VERIFIED;
 *   - unattended automation — bots, plans, TWAP, DCA, grid, funding-arb, trailing stop,
 *     background jobs (automationGate) — until QFEX_AUTOMATION_VERIFIED;
 *   - stop-limit and stops that open (the venue offers neither); reduce-only stop-MARKET orders
 *     (TAKE_PROFIT / STOP_LOSS, Q21 passed — placeStop) are placed;
 *   - amend of a reduce-only order (a plain LIMIT / ALO is amended — Q5 passed);
 *   - attached TP/SL (Q7);
 *   - markets not quoted in USD (sizing / risk / notional code assumes USD);
 *   - user-supplied client order ids (not unique on the venue).
 *
 * Funding: unverified (Q4) → getVenueMarkets()/getMarkets() report fundingRate null.
 */

import { randomUUID } from "node:crypto";
import { PerpError, orderNotSent } from "../../errors.js";
import type { QfexAgentMeta, WithdrawGate } from "../../settings.js";
import { assertWithdrawAllowed, forgetWithdrawAttempt, recordWithdrawAttempt } from "../../withdraw-gate.js";
import { builderGateOf, NO_BUILDER, type BuilderDecision, type BuilderFeeGate } from "../builder-fee.js";
import type {
  ExchangeAdapter, ExchangeBalance, ExchangeFundingPayment, ExchangeKline, ExchangeMarketInfo, ExchangeOrder,
  ExchangePosition, ExchangeTrade, ExchangePublicTrade,
  FundingHistoryRow
} from "../interface.js";
import type { IocOutcome } from "../ioc-outcome.js";
import { alignProtectionPrice, floorSize, requireOnTick, slippagePrice, subDecimal } from "../precision.js";
import type { ResolvedSlippage } from "../slippage.js";
import type { TradingV2 } from "../trading-v2.js";
import { unsupported, validateLegacyTif, validateOrderRequest } from "../trading-v2.js";
import type { VenueCapabilities, VenueCreateContext, VenueDefinition } from "../venue.js";
import { requireCapabilities } from "../venue.js";
import type {
  AmendRequest, CancelResult, LeverageResult, Network, OrderExecution, OrderRef, OrderRequest, OrderResult,
  OrderStatus, VenueMarket,
} from "../venue-types.js";
import { parseOrderRef, toLegacyMarketInfo } from "../venue-types.js";
import { QFEX_BANKER_NETWORK, QFEX_ENDPOINTS, QFEX_WITHDRAW_DISABLED, QFEX_WITHDRAW_ENABLED } from "../venues/qfex.js";
import { loadQfexCredentials, QFEX_IMPORT_REMEDIATION } from "./agent.js";
import { QfexClient } from "./client.js";
import { qfexStatusClass } from "./errors.js";
import {
  buildQfexFundingRates, buildQfexMarkets, fetchQfexInstruments, fetchQfexMarketsWithInstruments, qfexFundingWindowClosed, qfexIndexPrices, qfexPlainSymbol, qfexPublicData, qfexTradable, qfexVenueSymbol,
  type QfexContractRow, type QfexInstrument,
} from "./public.js";
import {
  QFEX_AUTOMATION_VERIFIED, QFEX_MODIFY_KEEPS_CLIENT_ID, QFEX_REDUCE_ONLY_WIRE, QFEX_STOP_CLIENT_ID_ECHO, decimalsEqual, fromWireNumber, isZeroDecimal,
  qfexAutomationGate, qfexReduceOnlyGate, reduceOnlyWireValue, subDecimals, sumDecimals, toWireNumber, weightedAveragePrice, type QfexCredentials,
  type QfexReduceOnlyWire,
} from "./signing.js";
import {
  QFEX_IDLE_CLOSE_MS, QFEX_MDS_TIMEOUT_MS, QFEX_TIMEOUTS, fetchQfexMarketStats, qfexPendingRemediation,
  qfexTradeSession, type QfexAddResult, type QfexOrderResponse, type QfexTradeSession,
} from "./ws-transport.js";

/** A mark price entry older than this (its own venue `time`) is not used as an order reference. */
export const QFEX_MARK_MAX_AGE_MS = 10_000;
/** /refdata cache: bands move with the session, so it is short. */
const INSTRUMENTS_TTL_MS = 30_000;
/** settledByHistory: historic-orders reads (and the wait between them) for an order that left the open list. */
const HISTORY_SETTLE_TRIES = 4;
const HISTORY_SETTLE_DELAY_MS = 1_000;

/**
 * A stop order's history verdict. Observed 2026-10-13: stop orders never appear in
 * /user/historic-orders and /user/trade rows carry no order id, so a vanished stop cannot be
 * proven cancelled — "not indexed" becomes a reason that says so (the cancel stays pending).
 */
/** settledByHistory verdict prefix for a row that partially filled and then was cancelled (never reported as "filled"). */
const QFEX_PARTIAL_PREFIX = "partially filled";
function stopHistoryVerdict(settled: string): string {
  return settled === "not indexed"
    ? "no longer listed open, but QFEX keeps no record of stop orders (not in /user/historic-orders), so the cancel cannot be proven — if perp account orders/positions -e qfex both show nothing for the symbol, it is gone"
    : settled;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STOP_TYPES: ReadonlySet<string> = new Set(["TAKE_PROFIT", "STOP_LOSS"]);
const KLINE_RESOLUTION: Readonly<Record<string, string>> = {
  "1m": "1MIN", "5m": "5MINS", "15m": "15MINS", "30m": "30MINS", "1h": "1HOUR", "4h": "4HOURS", "1d": "1DAY",
};

// ── Raw REST shapes (OpenAPI) ──

interface QfexRestBalance {
  available_balance: number; deposit: number; net_funding: number; order_margin: number; position_margin: number;
  realised_pnl: number; unrealised_pnl: number;
}
interface QfexRestPosition {
  symbol: string; position: number; average_price: number; leverage: number; unrealised_pnl: number;
}
interface QfexHistoricOrder {
  order_id: string; client_order_id: string; symbol: string; side: string; type: string; time_in_force: string;
  price: number; quantity: number; filled_qty: number; avg_price: number | null; terminal_status: string;
  execution_state: string; status_ts: string;
}
interface QfexUserTrade {
  symbol: string; side: string; price: number; quantity: number; fee: number; order_timestamp: number;
}
interface QfexCandle { startedAt: string; open: string; high: string; low: string; close: string; baseTokenVolume: string; usdVolume: string }

/**
 * Candle volumes. GET /candles returns `usdVolume` (populated) and `baseTokenVolume`, which the
 * venue leaves "0" on traded candles (live 2026-10-14, CL-USD 1HOUR: baseTokenVolume "0" with
 * usdVolume "52534.48506" on every row; startingOpenInterest / orderbookMidPrice* are "0" too).
 * A base "0" next to a non-zero USD volume is a placeholder → null (unknown), never 0; when
 * both are zero the candle really had no volume.
 */
export function qfexCandleVolumes(c: { baseTokenVolume: unknown; usdVolume: unknown }): { volume: string | null; quoteVolume: string } {
  const decimal = (v: unknown, what: string): string => {
    if (typeof v !== "string" || v.trim() === "" || !Number.isFinite(Number(v))) {
      throw new PerpError("EXCHANGE_ERROR", `QFEX candles: ${what} is not a decimal string (${JSON.stringify(v)})`, { exchange: "qfex" });
    }
    return v;
  };
  const quoteVolume = decimal(c.usdVolume, "usdVolume");
  const base = decimal(c.baseTokenVolume, "baseTokenVolume");
  return { volume: Number(base) === 0 && Number(quoteVolume) !== 0 ? null : base, quoteVolume };
}

/** Client order id sent to the venue: a fresh UUID (the format the venue itself generates). */
export function qfexClientOrderId(): string {
  return randomUUID();
}

/**
 * JSON number → plain decimal string (never exponent notation). The venue sends decimals as
 * JSON numbers, i.e. binary doubles, and some carry the venue's own float noise (live
 * 2026-10-05 `/user/positions` average_price 4142.099999999999 for a 4142.1 entry). A double
 * represents every decimal of up to 15 significant digits exactly-once (IEEE 754 binary64
 * DBL_DIG = 15), so the value is read at 15 significant digits: noise in the 16th/17th digit
 * is dropped and no real venue decimal is altered. Fields with a known grid (order price /
 * quantity) are quantized to the instrument tick / lot instead (fromWireNumber).
 */
export function plainNumber(n: unknown, what: string): string {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new PerpError("EXCHANGE_ERROR", `QFEX: ${what} is not a number (${JSON.stringify(n)})`);
  if (Number.isInteger(n)) return String(n);
  return Number(n.toPrecision(15)).toFixed(12).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * A QFEX `market list` / `market info` row: the legacy shape plus listing state and quote currency.
 * Prices are in `quoteAsset`; `volume24h` is USD (null for a non-USD quote — no FX rate published),
 * `volume24hQuote` the venue's 24h notional in `quoteAsset`.
 */
export type QfexMarketRow = ExchangeMarketInfo & { tradable: boolean; status: QfexListedStatus; quoteAsset: string; volume24hQuote: string | null };

/**
 * Why a LISTED (ACTIVE) market is or is not tradable through perp-cli: "active" = tradable;
 * "nonUsdQuote" = quoted in KRW / JPY / CNY / SEK / HKD — readable, never ordered (USD sizing).
 */
export type QfexListedStatus = "active" | "nonUsdQuote";

function qfexListedStatus(i: QfexInstrument): QfexListedStatus {
  if (i.status !== "ACTIVE") throw new PerpError("EXCHANGE_ERROR", `QFEX ${i.venueSymbol} is ${i.status}; it is not listed`, { exchange: "qfex" });
  return qfexTradable(i) ? "active" : "nonUsdQuote";
}

function listOf<T>(v: unknown, what: string): T[] {
  if (v === null || v === undefined) return []; // the venue encodes an empty list as JSON null
  if (!Array.isArray(v)) throw new PerpError("EXCHANGE_ERROR", `QFEX: ${what} is not a list`);
  return v as T[];
}

function execution(method: string, partial: Partial<Omit<OrderExecution, "method">>): OrderExecution {
  return {
    method,
    slippageBps: partial.slippageBps ?? null,
    slippageSource: partial.slippageSource ?? null,
    protectionPrice: partial.protectionPrice ?? null,
    referencePrice: partial.referencePrice ?? null,
    tifRequested: partial.tifRequested ?? null,
    tifSent: partial.tifSent ?? null,
    expiresAt: partial.expiresAt ?? null,
    builderFee: partial.builderFee ?? null,
    notes: partial.notes ?? [],
  };
}

/** a < b for plain decimals. */
function lessThan(a: string, b: string): boolean {
  return subDecimal(a, b).startsWith("-");
}

export interface QfexAddOrderWire {
  symbol: string;
  side: "BUY" | "SELL";
  order_type: "LIMIT" | "ALO";
  order_time_in_force: "GTC" | "IOC" | "FOK";
  quantity: number;
  price: number;
  client_order_id: string;
  reduce_only?: boolean | number;
  [k: string]: unknown;
}

/**
 * The frame of a reduce-only order that fails the echo check, or null when the order is confirmed
 * as reduce-only. The rule, from production frames (2026-10-05, signing.ts Q2):
 *  - the ACK and every other NON-FILL status frame (CANCELLED, IOC_CANCELLED, MODIFIED, a
 *    post-ACK rejection, …) describes the ORDER and must carry `reduce_only: true`;
 *  - a fill-carrying frame (status FILLED) describes the TRADE and is NOT judged: the venue sends
 *    `reduce_only: false` on it for an order whose ACK and CANCELLED frames both carry `true`;
 *  - an order with no non-fill frame at all has nothing that confirms the flag, so its frames are
 *    judged as they are (a missing confirmation is never read as confirmed).
 */
export function reduceOnlyUnconfirmedFrame(responses: readonly QfexOrderResponse[]): QfexOrderResponse | null {
  const orderFrames = responses.filter(r => qfexStatusClass(r.status) !== "fill");
  const judged = orderFrames.length > 0 ? orderFrames : responses;
  return judged.find(r => r.reduce_only !== true) ?? null;
}

/**
 * add_order params. `take_profit` / `stop_loss` are never sent (no attached TP/SL). `reduce_only`
 * is sent only for a reduce-only order, in the verified wire format — with the format unset a
 * reduce-only order is refused here.
 */
export function buildAddOrderParams(o: {
  venueSymbol: string; side: "buy" | "sell"; orderType: "LIMIT" | "ALO"; tif: "GTC" | "IOC" | "FOK";
  quantity: string; price: string; clientOrderId: string; reduceOnly: boolean;
}, reduceOnlyWire: QfexReduceOnlyWire | null): QfexAddOrderWire {
  const params: QfexAddOrderWire = {
    symbol: o.venueSymbol,
    side: o.side === "buy" ? "BUY" : "SELL",
    order_type: o.orderType,
    order_time_in_force: o.tif,
    quantity: toWireNumber(o.quantity, "quantity"),
    price: toWireNumber(o.price, "price"),
    client_order_id: o.clientOrderId,
  };
  if (o.reduceOnly) {
    const gate = qfexReduceOnlyGate(reduceOnlyWire);
    if (gate !== null) throw gate;
    params.reduce_only = reduceOnlyWireValue(reduceOnlyWire as QfexReduceOnlyWire, true);
  }
  return params;
}

export class QfexAdapter implements ExchangeAdapter, TradingV2 {
  readonly name = "qfex" as const;
  readonly aliases = ["qf"] as const;
  readonly venue: VenueDefinition;
  readonly network: Network;

  private readonly caps: VenueCapabilities;
  private readonly client: QfexClient;
  private readonly meta: QfexAgentMeta | null;
  private readonly credentials: QfexCredentials | null;
  private instruments: { at: number; bySymbol: Map<string, QfexInstrument> } | null = null;
  /**
   * Builder-code gate (settings builder.qfex; no approval step); null = not configured. Set by
   * the venue definition's create — the adapter never reads settings.
   */
  builderFee: BuilderFeeGate | null = null;
  /**
   * settings.withdraw.qfex, set by the venue definition's create; null = not configured →
   * withdraw() refuses. Enforced inside withdraw() so no caller can skip it.
   */
  withdrawGate: WithdrawGate | null = null;

  constructor(def: VenueDefinition, ctx: VenueCreateContext) {
    this.venue = def;
    this.network = ctx.network;
    this.caps = requireCapabilities(def);

    let meta: QfexAgentMeta | null = null;
    let credentials: QfexCredentials | null = null;
    if (!ctx.readOnly) {
      if (ctx.noAgent) {
        throw new PerpError("NO_SIGNER_AVAILABLE", "QFEX signs only with an imported API key; --no-agent leaves no signer", {
          remediation: `Drop --no-agent, or import a key: ${QFEX_IMPORT_REMEDIATION}`,
        });
      }
      const agent = ctx.credentials.agent;
      if (agent === null || !("kind" in agent) || agent.kind !== "qfex") {
        throw new PerpError("NO_SIGNER_AVAILABLE", "No QFEX API key imported", {
          remediation: `Create a key in QFEX Developer Settings, then: ${QFEX_IMPORT_REMEDIATION}`,
        });
      }
      if (agent.network !== ctx.network) {
        throw new PerpError("AGENT_NOT_REGISTERED", `QFEX API key ${agent.publicKey} was imported for ${String(agent.network)}, not ${ctx.network}`, {
          remediation: `Import a ${ctx.network} key: perp${ctx.network === "testnet" ? " -n testnet" : ""} wallet agent import qfex`,
        });
      }
      if (typeof agent.accountId !== "string" || !UUID_RE.test(agent.accountId)) {
        throw new PerpError("AGENT_NOT_REGISTERED", `QFEX API key ${agent.publicKey} has no bound account id`, {
          remediation: `Re-import it so the account is resolved and confirmed: ${QFEX_IMPORT_REMEDIATION} --replace`,
        });
      }
      meta = agent;
      credentials = loadQfexCredentials(agent.publicKey);
    }
    this.meta = meta;
    this.credentials = credentials;
    const ep = QFEX_ENDPOINTS[ctx.network];
    this.client = new QfexClient({
      restUrl: ep.rest, bankerUrl: ep.banker, network: ctx.network, credentials,
      accountId: meta === null ? null : meta.accountId,
    });
  }

  /** The account UUID every request of this adapter acts as. */
  get accountId(): string {
    return this.requireMeta().accountId;
  }

  private requireMeta(): QfexAgentMeta {
    if (this.meta === null) {
      throw new PerpError("NO_SIGNER_AVAILABLE", "QFEX: this action needs an imported API key (read-only adapter)", { remediation: QFEX_IMPORT_REMEDIATION });
    }
    return this.meta;
  }

  // ── Helpers ──

  /** The builder decision for the connection (the code rides on the session's auth, never per order). */
  private async builderDecision(): Promise<BuilderDecision> {
    const gate = builderGateOf(this);
    return gate === null ? NO_BUILDER : gate.decide({ hip3: false });
  }

  private async session(): Promise<{ session: QfexTradeSession; builder: BuilderDecision }> {
    const meta = this.requireMeta();
    const builder = await this.builderDecision();
    const session = qfexTradeSession({
      url: QFEX_ENDPOINTS[this.network].tradeWs,
      network: this.network,
      credentials: this.credentials as QfexCredentials,
      accountId: meta.accountId,
      builderCode: builder.applied === null ? null : builder.applied.identity,
      rateLimit: this.venue.rateLimit,
      timeouts: QFEX_TIMEOUTS,
      idleCloseMs: QFEX_IDLE_CLOSE_MS,
    });
    return { session, builder };
  }

  private async instrumentMap(): Promise<Map<string, QfexInstrument>> {
    if (this.instruments === null || Date.now() - this.instruments.at > INSTRUMENTS_TTL_MS) {
      const list = await fetchQfexInstruments(this.client);
      this.instruments = { at: Date.now(), bySymbol: new Map(list.map(i => [i.venueSymbol, i])) };
    }
    return this.instruments.bySymbol;
  }

  private async instrumentOf(symbol: string): Promise<QfexInstrument> {
    const venueSymbol = qfexVenueSymbol(symbol);
    const i = (await this.instrumentMap()).get(venueSymbol);
    if (i === undefined) {
      throw new PerpError("SYMBOL_NOT_FOUND", `QFEX has no market ${venueSymbol}`, { exchange: "qfex", remediation: "List markets: perp -e qfex market list" });
    }
    return i;
  }

  /**
   * Instrument of a per-symbol read (book / funding / kline / info). Unknown → SYMBOL_NOT_FOUND; a
   * listed market whose /refdata status is not ACTIVE (DELISTED, INACTIVE) → SYMBOL_NOT_FOUND with
   * that status: it is not a live market. A non-USD ACTIVE market is readable (only orders refuse it).
   */
  private async readableInstrument(symbol: string): Promise<QfexInstrument> {
    const i = await this.instrumentOf(symbol);
    if (i.status !== "ACTIVE") {
      throw new PerpError("SYMBOL_NOT_FOUND", `QFEX ${i.venueSymbol} is ${i.status.toLowerCase()} (status ${i.status}) — not a live market`, {
        exchange: "qfex", status: i.status, remediation: "List tradable markets with: perp market list -e qfex",
      });
    }
    return i;
  }

  /** Refuse a market perp-cli must not send orders to, and an order type / TIF the symbol does not list. */
  private requireOrderable(i: QfexInstrument, orderType: string, tif: string): void {
    if (i.status !== "ACTIVE") {
      throw new PerpError("SYMBOL_NOT_FOUND", `QFEX ${i.venueSymbol} is ${i.status}, not ACTIVE`, { exchange: "qfex", status: i.status, remediation: "List tradable markets with: perp market list -e qfex" });
    }
    if (i.quoteAsset !== "USD") {
      throw unsupported("qfex", "nonUsdQuote",
        `${i.venueSymbol} is quoted in ${i.quoteAsset}; perp-cli sizes orders, risk limits and notionals in USD and would mis-size it`,
        `Trade ${i.venueSymbol} on the QFEX web app, or use a USD-quoted market (perp market list -e qfex)`);
    }
    if (!i.orderTypes.includes(orderType)) {
      throw unsupported("qfex", "orderType", `${i.venueSymbol} does not list order type ${orderType} (allowed: ${i.orderTypes.join(", ")})`, `Use one of: ${i.orderTypes.join(", ")}`);
    }
    if (!i.timeInForce.includes(tif)) {
      throw unsupported("qfex", "timeInForce", `${i.venueSymbol} does not list time-in-force ${tif} (allowed: ${i.timeInForce.join(", ")})`, `Use one of: ${i.timeInForce.join(", ")}`);
    }
    if (!qfexTradable(i)) throw new PerpError("SYMBOL_NOT_FOUND", `QFEX ${i.venueSymbol} is not tradable`, { exchange: "qfex" });
  }

  /** Mark of ONE symbol from a single-symbol MDS subscription; PRICE_STALE when absent or older than QFEX_MARK_MAX_AGE_MS. */
  private async referenceMark(venueSymbol: string): Promise<string> {
    const snap = await fetchQfexMarketStats(QFEX_ENDPOINTS[this.network].mdsWs, venueSymbol, QFEX_MDS_TIMEOUT_MS);
    const mark = snap.marks.get(venueSymbol);
    const remediation = "Retry shortly, or place a limit order (perp trade limit …) — no other price is substituted for the mark";
    if (mark === undefined) throw new PerpError("PRICE_STALE", `QFEX: the market data snapshot has no mark price for ${venueSymbol}`, { exchange: "qfex", remediation });
    const age = Date.now() - mark.time;
    if (age > QFEX_MARK_MAX_AGE_MS) {
      throw new PerpError("PRICE_STALE", `QFEX: mark price of ${venueSymbol} is ${Math.round(age / 1000)}s old (limit ${QFEX_MARK_MAX_AGE_MS / 1000}s)`, { exchange: "qfex", markTime: new Date(mark.time).toISOString(), remediation });
    }
    return mark.price;
  }

  private checkBand(i: QfexInstrument, side: "buy" | "sell", price: string, protection: boolean): void {
    const outside = side === "buy" ? lessThan(i.band.upper, price) : lessThan(price, i.band.lower);
    if (!outside) return;
    throw new PerpError("INVALID_PARAMS",
      `QFEX ${i.venueSymbol}: ${protection ? "protection price" : `${side} price`} ${price} is outside the price band ${i.band.lower}–${i.band.upper}`, {
        exchange: "qfex", band: i.band, price,
        remediation: protection
          ? "Lower --slippage-bps so the protection price stays inside the band, or place a limit order inside it"
          : `Use a price inside the band (${side === "buy" ? `≤ ${i.band.upper}` : `≥ ${i.band.lower}`}); it is never clamped`,
      });
  }

  /**
   * `minimum: "deferred"` — a reduce-only order: its minimum is checked in requireReducible, once
   * the position is known (a full close of a sub-minimum residual is not refused here).
   */
  private checkSize(i: QfexInstrument, size: string, minimum: "enforced" | "deferred"): void {
    if (minimum === "enforced" && lessThan(size, i.minQuantity)) {
      throw new PerpError("SIZE_TOO_SMALL", `QFEX ${i.venueSymbol}: size ${size} is below the minimum ${i.minQuantity}`, { exchange: "qfex", remediation: `Use a size of at least ${i.minQuantity}` });
    }
    if (lessThan(i.maxQuantity, size)) {
      throw new PerpError("SIZE_TOO_LARGE", `QFEX ${i.venueSymbol}: size ${size} is above the maximum ${i.maxQuantity}`, { exchange: "qfex", remediation: `Use a size of at most ${i.maxQuantity}` });
    }
  }

  /** The uniform refusal of every reduce-only order while the wire format is unset; null now that Q2 set it. */
  reduceOnlyGate(): PerpError | null {
    return qfexReduceOnlyGate(QFEX_REDUCE_ONLY_WIRE);
  }

  /**
   * The uniform refusal of every UNATTENDED flow (bots, plans, TWAP, DCA, grid, funding-arb,
   * trailing stop, background jobs) while stops are refused: an automated strategy would have no
   * protective exit on the venue. Manual commands never ask. Null once QFEX_AUTOMATION_VERIFIED.
   */
  automationGate(): PerpError | null {
    return qfexAutomationGate(QFEX_AUTOMATION_VERIFIED);
  }

  /**
   * The uniform refusal of every stop order while Q21 is unset — and so of `--tp/--sl` and
   * `trade tpsl`, whose legs are stops. Callers ask BEFORE an entry is sent (stopOrderGateOf).
   * Null now that Q21 passed (QFEX_STOP_CLIENT_ID_ECHO).
   */
  stopOrderGate(): PerpError | null {
    if (QFEX_STOP_CLIENT_ID_ECHO === true) return null;
    return unsupported("qfex", "stopOrder",
      "the stop order acknowledgement is not documented to echo a client order id, so a stop cannot be correlated safely (Q21)",
      "Set stops / TP / SL on the QFEX web app until QFEX item Q21 passes");
  }

  /**
   * One reduce-only stop-market order (add_order with order_type TAKE_PROFIT / STOP_LOSS).
   * Docs stop_add_order: "The direction given must be the eventual direction of the triggered
   * order", `price` = "Price for when the order is triggered", quantity "Must respect lot size
   * but not min/max limits", order_time_in_force "Required for legacy reasons, the value will
   * not be read", and "TAKE_PROFIT and STOP_LOSS orders cannot exceed your current position,
   * attempting to do this could cause your order to be rejected or other stop orders to be
   * cancelled". So, before sending (every refusal definite, nothing sent):
   *   - a non-zero position, the order side opposite to it;
   *   - size + Σ quantity of the other open stops of the SAME type on the symbol ≤ |position|
   *     (never makes the venue cancel another stop);
   *   - kind given (TP/SL legs) or, for a plain stop, from the trigger vs the MDS mark price
   *     (closing a long: below mark = STOP_LOSS, above = TAKE_PROFIT; a short: the mirror).
   * After the send: the ACK must carry our client id and reduce_only true (production 2026-10-12);
   * the row is then read back from get_user_orders (final "open" only with that row). The venue's
   * repeating `stop_order_response` frames are a heartbeat and never read as state.
   */
  private async placeStop(req: OrderRequest, kind: "tp" | "sl" | null): Promise<OrderResult> {
    const gate = this.stopOrderGate();
    if (gate !== null) throw gate;
    if (req.clientOrderId === null || !UUID_RE.test(req.clientOrderId)) {
      throw new PerpError("INVALID_PARAMS", "QFEX stop orders carry a perp-cli generated client order id (UUID)");
    }
    if (req.triggerPrice === null) throw new PerpError("INVALID_PARAMS", "stop order requires a trigger price");
    if (req.triggerSource !== null) {
      throw unsupported("qfex", "triggerSource", "QFEX stops trigger on the venue's own price source", "Omit --trigger-type");
    }
    const clientOrderId = req.clientOrderId;
    this.requireMeta();
    const i = await this.instrumentOf(req.symbol);
    const size = floorSize(req.size, i.lotSize);
    const trigger = requireOnTick(req.triggerPrice, i.tickSize);
    const what = `stop add_order ${i.venueSymbol}`;
    let session: QfexTradeSession;
    let exec: OrderExecution;
    let orderType: "TAKE_PROFIT" | "STOP_LOSS";
    try {
      const s = await this.session();
      session = s.session;
      exec = execution("trigger", { referencePrice: trigger, tifSent: "GTC (not read by the venue for stops)", builderFee: s.builder.applied, notes: ["reduce-only stop-market: executes as a market order when triggered (no slippage bound)"] });
      if (s.builder.note !== null) exec.notes.push(s.builder.note);
      const rows = (await this.userPositions()).positions.filter(p => p.symbol === i.venueSymbol);
      if (rows.length > 1) throw new PerpError("EXCHANGE_ERROR", `/user/positions lists ${rows.length} rows for ${i.venueSymbol}`);
      const position = rows.length === 0 ? 0 : rows[0].position;
      if (typeof position !== "number" || !Number.isFinite(position)) throw new PerpError("EXCHANGE_ERROR", `/user/positions reports position ${JSON.stringify(position)} for ${i.venueSymbol}`);
      if (position === 0) {
        throw new PerpError("POSITION_NOT_FOUND", `QFEX ${i.venueSymbol}: no open position — a stop order can only reduce one (docs: stops "cannot exceed your current position"); not sent`, {
          exchange: "qfex", sent: false, remediation: "Check positions: perp account positions -e qfex",
        });
      }
      const closeSide = position > 0 ? "sell" : "buy";
      if (req.side !== closeSide) {
        throw new PerpError("INVALID_PARAMS", `QFEX ${i.venueSymbol}: a ${req.side} stop cannot reduce the ${position > 0 ? "long" : "short"} position — not sent`, { exchange: "qfex", remediation: `Use side ${closeSide}` });
      }
      if (kind !== null) orderType = kind === "tp" ? "TAKE_PROFIT" : "STOP_LOSS";
      else {
        const mark = await this.referenceMark(i.venueSymbol);
        if (decimalsEqual(trigger, mark)) throw new PerpError("INVALID_PARAMS", `QFEX ${i.venueSymbol}: trigger ${trigger} equals the mark ${mark} — cannot tell stop-loss from take-profit; not sent`);
        const below = lessThan(trigger, mark);
        orderType = (closeSide === "sell") === below ? "STOP_LOSS" : "TAKE_PROFIT";
        exec.notes.push(`sent as ${orderType}: trigger ${trigger} is ${below ? "below" : "above"} the mark ${mark}`);
      }
      // Same gate as every other order (ACTIVE, USD-quoted, tradable). The refdata `order_types`
      // list only LIMIT / MARKET / ALO (no stop types — fixtures/qfex/refdata.json), and a stop
      // executes as a MARKET order when triggered, so MARKET + GTC (the TIF sent) is checked.
      this.requireOrderable(i, "MARKET", "GTC");
      const held = floorSize(plainNumber(Math.abs(position), "position"), i.lotSize);
      const sameType =(await session.getUserOrders(i.venueSymbol)).filter(o => o.symbol === i.venueSymbol && o.type === orderType);
      const reserved = sumDecimals(sameType.map(o => fromWireNumber(o.quantity, i.lotSize, "quantity")));
      const total = sumDecimals([reserved, size]);
      if (lessThan(held, total)) {
        throw new PerpError("SIZE_TOO_LARGE",
          `QFEX ${i.venueSymbol}: ${orderType} ${size} + ${reserved} in other open ${orderType} orders exceeds the ${held} position — not sent (the venue may reject it or cancel other stops)`, {
            exchange: "qfex", position: held, reservedByStops: reserved, stopOrderIds: sameType.map(o => o.order_id),
            remediation: sameType.length > 0 ? `Cancel a ${orderType} first: perp trade cancel ${i.symbol} <orderId> -e qfex (${sameType.map(o => o.order_id).join(", ")})` : `Use a size of at most ${held}`,
          });
      }
    } catch (e) {
      // The rule's own refusals keep their code (nothing was sent); read failures become "not sent".
      if (e instanceof PerpError && ["POSITION_NOT_FOUND", "INVALID_PARAMS", "SIZE_TOO_LARGE"].includes(e.structured.code)) throw e;
      throw orderNotSent("qfex", what, e);
    }
    const params: Record<string, unknown> & { symbol: string; client_order_id: string } = {
      symbol: i.venueSymbol, side: req.side === "buy" ? "BUY" : "SELL", order_type: orderType, order_time_in_force: "GTC",
      quantity: toWireNumber(size, "quantity"), price: toWireNumber(trigger, "price"), client_order_id: clientOrderId,
      reduce_only: reduceOnlyWireValue(QFEX_REDUCE_ONLY_WIRE as QfexReduceOnlyWire, true),
    };
    if (subDecimal(req.size, size) !== "0") exec.notes.push(`size ${req.size} floored to the lot ${i.lotSize} → ${size}`);
    const add = await session.addOrder({ params, immediate: false, postOnly: false, lotSize: i.lotSize, band: null });
    const unconfirmed = reduceOnlyUnconfirmedFrame(add.responses);
    if (unconfirmed !== null) throw this.reduceOnlyEchoError(i, add.orderId, clientOrderId, unconfirmed.reduce_only, { orderId: add.orderId, responses: add.responses });
    // Read back: "open" only with the get_user_orders row of THIS stop (by client id).
    let row: QfexOrderResponse | null = null;
    try {
      row = this.pick((await session.getUserOrders(i.venueSymbol)).filter(o => STOP_TYPES.has(o.type)), { kind: "clientOrderId", value: clientOrderId });
    } catch (e) {
      exec.notes.push(`read-back failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const venueRaw = { orderId: add.orderId, responses: add.responses, row };
    if (row === null) {
      exec.notes.push(`acknowledged (ACK); not listed by get_user_orders yet — verify: perp trade status c:${clientOrderId} --symbol ${i.symbol} -e qfex`);
      return { venue: "qfex", symbol: i.symbol, status: "accepted", finality: "pending", orderId: add.orderId, clientOrderId, filledSize: null, avgPrice: null, execution: exec, venueRaw };
    }
    exec.notes.push(`listed open as ${row.type} (untriggered)`);
    return { venue: "qfex", symbol: i.symbol, status: "open", finality: "final", orderId: row.order_id, clientOrderId, filledSize: "0", avgPrice: null, execution: exec, venueRaw };
  }

  /** A TP / SL leg (separateOrders: legacy-trading-v2 placeTpSlLeg dispatches here). Stop-market only. */
  async placeTpSlLeg(leg: { symbol: string; closeSide: "buy" | "sell"; size: string; trigger: string; kind: "tp" | "sl"; limitPrice: string | null }): Promise<OrderResult> {
    if (leg.limitPrice !== null) {
      throw unsupported("qfex", "stopLimit", "the venue's stop orders convert to market orders when triggered", "Omit --tp-limit on qfex");
    }
    return this.placeStop({
      symbol: leg.symbol, side: leg.closeSide, type: "stopMarket", size: leg.size, price: null, triggerPrice: leg.trigger,
      triggerSource: null, tif: null, reduceOnly: true, clientOrderId: qfexClientOrderId(), slippage: null, tpsl: null,
    }, leg.kind);
  }

  /**
   * Orders left on symbols where the account holds NO position: resting reduce-only LIMIT / ALO
   * orders and TAKE_PROFIT / STOP_LOSS stops. Production 2026-10-12 (Q2): the venue does NOT
   * cancel a resting reduce-only order when the position closes; whether one the market reaches
   * while flat would open a position is unproven. `symbol` null = every symbol.
   */
  async orphanedReduceOnlyOrders(symbol: string | null): Promise<Array<{ symbol: string; orderId: string; type: string; side: string; price: string; quantity: string }>> {
    const venueSymbol = symbol === null ? null : (await this.instrumentOf(symbol)).venueSymbol;
    const { session } = await this.session();
    const [orders, { positions }] = await Promise.all([session.getUserOrders(venueSymbol), this.userPositions()]);
    const held = new Set(positions.filter(p => typeof p.position === "number" && p.position !== 0).map(p => p.symbol));
    return orders
      .filter(o => !held.has(o.symbol) && (STOP_TYPES.has(o.type) || o.reduce_only === true))
      .map(o => ({ symbol: qfexPlainSymbol(o.symbol), orderId: o.order_id, type: o.type, side: o.side, price: String(o.price), quantity: String(o.quantity_remaining) }));
  }

  /**
   * The rule before EVERY reduce-only send. The venue accepts a reduce-only order larger than
   * the position (Q2, signing.ts), so the size is enforced here, on live reads:
   *   (a) GET /user/positions has a non-zero position on the symbol — none → POSITION_NOT_FOUND;
   *   (b) the order side is opposite to it (long → sell, short → buy);
   *   (c) size ≤ |position| − Σ quantity_remaining of ALL this account's other open LIMIT / ALO
   *       orders on that symbol and side (get_user_orders rows) — a plain SELL consumes a long
   *       exactly like a reduce-only one, so both are counted;
   *   (d) size ≥ min_quantity, unless the order closes the whole (floored) position.
   * A same-side open order whose row does not report `reduce_only` as a boolean is not in the
   * verified row format (Q2) → refused, with the cancel command. Stop rows (TAKE_PROFIT / STOP_LOSS) are not counted: the
   * venue's stops "act only to decrease position at the time of execution" (docs
   * /qfex/order-types); they are reported as an execution note instead.
   * Every refusal is definite — nothing was sent. The position is floored to the lot.
   * Returns the execution notes of the check.
   */
  private async requireReducible(i: QfexInstrument, session: QfexTradeSession, side: "buy" | "sell", size: string): Promise<string[]> {
    const what = `reduce-only add_order ${i.venueSymbol}`;
    const wireSide = side === "buy" ? "BUY" : "SELL";
    const cancelHint = (ids: string[]): string => `perp trade cancel ${i.symbol} <orderId> -e qfex (${ids.join(", ")})`;
    let position: number;
    let reserving: QfexOrderResponse[];
    let stops: QfexOrderResponse[];
    try {
      const rows = (await this.userPositions()).positions.filter(p => p.symbol === i.venueSymbol);
      if (rows.length > 1) throw new PerpError("EXCHANGE_ERROR", `/user/positions lists ${rows.length} rows for ${i.venueSymbol}`);
      if (rows.length === 1 && (typeof rows[0].position !== "number" || !Number.isFinite(rows[0].position))) {
        throw new PerpError("EXCHANGE_ERROR", `/user/positions reports position ${JSON.stringify(rows[0].position)} for ${i.venueSymbol}`);
      }
      position = rows.length === 0 ? 0 : rows[0].position;
      const open = (await session.getUserOrders(i.venueSymbol)).filter(o => o.symbol === i.venueSymbol);
      stops = open.filter(o => STOP_TYPES.has(o.type));
      reserving = open.filter(o => o.side === wireSide && !STOP_TYPES.has(o.type));
    } catch (e) {
      throw orderNotSent("qfex", what, e);
    }
    const unknown = reserving.filter(o => typeof o.reduce_only !== "boolean").map(o => o.order_id);
    if (unknown.length > 0) {
      throw new PerpError("ORDER_REJECTED",
        `qfex ${what} not sent: open ${wireSide} order(s) ${unknown.join(", ")} do not report reduce_only (every verified open-order row carries it as a boolean), so the open-order read is not trusted for sizing`, {
          exchange: "qfex", sent: false, unreadableOrderIds: unknown,
          remediation: `Cancel the order(s), then retry: ${cancelHint(unknown)} — or look at them first: perp account orders -e qfex`,
        });
    }
    if (position === 0) {
      throw new PerpError("POSITION_NOT_FOUND", `QFEX ${i.venueSymbol}: no open position to reduce — the reduce-only order was not sent`, {
        exchange: "qfex", sent: false, remediation: "Check positions: perp account positions -e qfex",
      });
    }
    const positionSide = position > 0 ? "long" : "short";
    if (side !== (position > 0 ? "sell" : "buy")) {
      throw new PerpError("INVALID_PARAMS", `QFEX ${i.venueSymbol}: a reduce-only ${side} cannot reduce a ${positionSide} position — not sent`, {
        exchange: "qfex", positionSide, remediation: `Reduce the ${positionSide} position with a ${position > 0 ? "sell" : "buy"} order`,
      });
    }
    const held = floorSize(plainNumber(Math.abs(position), "position"), i.lotSize);
    const reserved = sumDecimals(reserving.map(o => fromWireNumber(o.quantity_remaining, i.lotSize, "quantity_remaining")));
    const available = lessThan(held, reserved) ? "0" : subDecimals(held, reserved, "reducible size");
    if (lessThan(available, size)) {
      const orderIds = reserving.map(o => o.order_id);
      throw new PerpError("SIZE_TOO_LARGE",
        `QFEX ${i.venueSymbol}: reduce-only size ${size} exceeds what can still reduce the ${positionSide} position (${held} held − ${reserved} in other open ${wireSide} orders = ${available}) — not sent; the venue would accept the excess and it could open the opposite position`, {
          exchange: "qfex", position: held, positionSide, reservedByOpenOrders: reserved, available, reservingOrderIds: orderIds,
          remediation: orderIds.length === 0
            ? `Use a size of at most ${available}`
            : `Use a size of at most ${available}, or cancel the open ${wireSide} order(s) first: ${cancelHint(orderIds)}`,
        });
    }
    // A residual below min_quantity can only be closed whole. Whether the venue accepts a
    // sub-minimum reduce-only order is UNVERIFIED — it is sent and the venue answers.
    const closesAll = decimalsEqual(size, held);
    if (lessThan(size, i.minQuantity) && !closesAll) {
      throw new PerpError("SIZE_TOO_SMALL", `QFEX ${i.venueSymbol}: reduce-only size ${size} is below the minimum ${i.minQuantity} and is not the whole position (${held}) — not sent`, {
        exchange: "qfex", position: held, remediation: `Use a size of at least ${i.minQuantity}${lessThan(held, i.minQuantity) ? `, or close the whole position: ${held}` : ""}`,
      });
    }
    const notes: string[] = [];
    if (lessThan(size, i.minQuantity)) {
      notes.push(`size ${size} is below the venue minimum ${i.minQuantity}; sent because it closes the whole position (venue behaviour for a sub-minimum reduce-only order is unverified)`);
    }
    if (stops.length > 0) {
      notes.push(`${stops.length} open stop order(s) on ${i.venueSymbol} (${stops.map(o => o.order_id).join(", ")}) were not counted against the reducible size — a stop that triggers also reduces the position`);
    }
    return notes;
  }

  /**
   * A reduce-only order the venue did not confirm as reduce-only (`reduce_only` false or absent
   * on an order frame — reduceOnlyUnconfirmedFrame — or on a read-back row of THIS order). The order may be live as a normal order, so the outcome is
   * unknown (ORDER_PENDING, never re-sent). It is NOT cancelled here: a cancel
   * is a second mutating command with its own unknown outcome and cannot undo a fill.
   */
  private reduceOnlyEchoError(i: QfexInstrument, orderId: string | null, clientOrderId: string, echo: unknown, venueRaw: unknown): PerpError {
    const id = orderId === null ? `c:${clientOrderId}` : orderId;
    return new PerpError("ORDER_PENDING",
      `QFEX ${i.venueSymbol}: the venue did not confirm reduce_only on order ${id} (reduce_only ${echo === undefined ? "not reported" : `echoed as ${JSON.stringify(echo)}`}) — it may be live as a NORMAL order that can open or flip a position. It was NOT cancelled automatically`, {
        exchange: "qfex", alarm: "reduceOnlyNotEchoed", orderId, clientOrderId, reduceOnlyEcho: typeof echo === "boolean" ? echo : null, venueRaw,
        remediation: `Do NOT resubmit. Check it NOW: perp trade status c:${clientOrderId} --symbol ${i.symbol} -e qfex — if it is still open, cancel it: perp trade cancel ${i.symbol} ${id} -e qfex — then check the position: perp account positions -e qfex`,
      });
  }

  // ── TradingV2 ──

  async getVenueMarkets(): Promise<VenueMarket[]> {
    return qfexPublicData.fetchMarkets(this.network);
  }

  async placeOrder(input: OrderRequest): Promise<OrderResult> {
    // Wire-format gate first (null now that Q2 set the format).
    if (input.reduceOnly) {
      const gate = qfexReduceOnlyGate(QFEX_REDUCE_ONLY_WIRE);
      if (gate !== null) throw gate;
    }
    const tifRequested = input.tif;
    const req: OrderRequest = input.type === "limit" && input.tif === null ? { ...input, tif: "GTC" } : input;
    validateOrderRequest(this.venue, this.caps, req);
    if (req.type === "stopLimit") {
      throw unsupported("qfex", "stopLimit", "the venue's stop orders convert to market orders when triggered", "Use a stop-market order");
    }
    if (req.type === "stopMarket") {
      if (!req.reduceOnly) {
        throw unsupported("qfex", "openingStop", "QFEX stop orders only reduce a position (they cannot exceed it)", "Stop orders on qfex must be reduce-only");
      }
      return this.placeStop(req, null);
    }
    if (req.clientOrderId === null || !UUID_RE.test(req.clientOrderId)) {
      throw new PerpError("INVALID_PARAMS", "QFEX orders carry a perp-cli generated client order id (UUID); user-supplied ids are not accepted because ids are not unique on the venue", {
        remediation: "Omit --client-id on qfex; the generated id is reported with the result",
      });
    }
    const clientOrderId = req.clientOrderId;
    this.requireMeta(); // no key → refused before any market-data read

    const i = await this.instrumentOf(req.symbol);
    const size = floorSize(req.size, i.lotSize);
    this.checkSize(i, size, req.reduceOnly ? "deferred" : "enforced");

    let orderType: "LIMIT" | "ALO";
    let tif: "GTC" | "IOC" | "FOK";
    let price: string;
    let exec: OrderExecution;
    if (req.type === "limit") {
      if (req.price === null || req.tif === null) throw new PerpError("INVALID_PARAMS", "limit order requires price and tif");
      if (req.tif !== "GTC" && req.tif !== "IOC" && req.tif !== "FOK" && req.tif !== "ALO") {
        throw unsupported("qfex", "timeInForce", `time-in-force ${req.tif} is not offered`, "Use one of: GTC, IOC, FOK, ALO");
      }
      orderType = req.tif === "ALO" ? "ALO" : "LIMIT";
      tif = req.tif === "ALO" ? "GTC" : req.tif;
      price = requireOnTick(req.price, i.tickSize);
      this.requireOrderable(i, orderType, tif);
      this.checkBand(i, req.side, price, false);
      exec = execution("limit", {
        tifRequested, tifSent: req.tif === "ALO" ? "ALO (order_type ALO + GTC)" : tif,
        notes: tifRequested === null ? ["no time-in-force given; GTC (uniform default)"] : [],
      });
    } else {
      const slippage = req.slippage as ResolvedSlippage; // validateOrderRequest guarantees it for market orders
      orderType = "LIMIT";
      tif = "IOC";
      this.requireOrderable(i, orderType, tif);
      const mark = await this.referenceMark(i.venueSymbol);
      price = alignProtectionPrice(slippagePrice(mark, req.side, slippage.bps), i.tickSize, req.side);
      this.checkBand(i, req.side, price, true);
      const appliedBps = Math.abs(Number(price) - Number(mark)) / Number(mark) * 10_000;
      exec = execution("protectedIoc", {
        slippageBps: Number(appliedBps.toFixed(4)), slippageSource: slippage.source,
        protectionPrice: price, referencePrice: mark, tifSent: "IOC",
        notes: [
          `resolved bound ${slippage.bps} bps (${slippage.source}); protection price aligned to tick ${i.tickSize} on the mark price`,
          "sent as LIMIT IOC — subject to the venue's 500 ms speed bump, so it may fill less than a native market order would",
        ],
      });
    }
    if (subDecimal(req.size, size) !== "0") exec.notes.push(`size ${req.size} floored to the lot ${i.lotSize} → ${size}`);

    const params = buildAddOrderParams({ venueSymbol: i.venueSymbol, side: req.side, orderType, tif, quantity: size, price, clientOrderId, reduceOnly: req.reduceOnly }, QFEX_REDUCE_ONLY_WIRE);
    const immediate = tif !== "GTC";

    let session: QfexTradeSession;
    try {
      const s = await this.session();
      session = s.session;
      exec.builderFee = s.builder.applied;
      if (s.builder.note !== null) exec.notes.push(s.builder.note);
      if (s.builder.applied !== null) exec.notes.push("builder code attached to the connection (fee share: you pay the normal fee); attribution is not confirmable from the trader side");
    } catch (e) {
      throw orderNotSent("qfex", `add_order ${i.venueSymbol}`, e);
    }
    if (req.reduceOnly) exec.notes.push(...await this.requireReducible(i, session, req.side, size));

    let add: QfexAddResult;
    try {
      add = await session.addOrder({ params, immediate, postOnly: orderType === "ALO", lotSize: i.lotSize, band: i.band });
    } catch (e) {
      if (!(e instanceof PerpError) || e.structured.code !== "ORDER_PENDING") throw e;
      // Unknown outcome: ONE read-only lookup on a fresh connection. Absence is not "not placed"
      // (speed bump, indexing lag) — the pending error then stands.
      let found: { result: OrderResult; source: "open" | "historic" } | null = null;
      let lookupNote: string | null = null;
      try {
        found = await this.findOrder(i, { kind: "clientOrderId", value: clientOrderId });
      } catch (lookupErr) {
        lookupNote = `status lookup after the unknown outcome failed: ${lookupErr instanceof Error ? lookupErr.message : String(lookupErr)}`;
      }
      if (found === null) {
        if (lookupNote === null) throw e;
        throw new PerpError("ORDER_PENDING", e.message, { ...(e.structured.details ?? {}), lookup: lookupNote, remediation: e.structured.remediation });
      }
      const result = found.result;
      const notes = [...exec.notes, "placement outcome was unknown; this status was read back by the generated client order id"];
      if (req.reduceOnly) {
        const echo = (result.venueRaw as { reduce_only?: unknown }).reduce_only;
        // /user/historic-orders rows carry no reduce_only field, so a missing echo on a TERMINAL
        // historic row is not evidence of anything: the order is done and cannot open a position
        // any more. An explicit false, or an order that is still live without `true`, is the alarm.
        const doneWithoutEcho = echo === undefined && found.source === "historic" && result.finality === "final";
        if (echo !== true && !doneWithoutEcho) throw this.reduceOnlyEchoError(i, result.orderId, clientOrderId, echo, result.venueRaw);
        if (doneWithoutEcho) notes.push("reduce_only not reported on historic rows — the order is terminal; its reduce-only flag could not be confirmed from this row");
      }
      result.execution = { ...exec, notes };
      return result;
    }
    if (req.reduceOnly) {
      const unconfirmed = reduceOnlyUnconfirmedFrame(add.responses);
      if (unconfirmed !== null) {
        throw this.reduceOnlyEchoError(i, add.orderId, clientOrderId, unconfirmed.reduce_only, { orderId: add.orderId, responses: add.responses, fills: add.fills, terminal: add.terminal, ended: add.ended });
      }
    }
    const result = this.orderResultOf(i, add, { size, immediate, postOnly: orderType === "ALO", exec });
    if (req.reduceOnly && result.finality === "final" && result.status === "partiallyFilled") {
      // Production 2026-10-05 (signing.ts, Q2): the venue caps a reduce-only order at the position
      // size when it matches and cancels the rest. A remainder can also be plain missing liquidity.
      result.execution.notes.push(`reduce-only: the venue filled ${result.filledSize} and cancelled the remainder — it caps a reduce-only order at the position size at match time (or no more liquidity within the limit price)`);
    }
    return result;
  }

  /** Map a correlated add_order outcome to an OrderResult — fills from venue frames only, decimal math. */
  private orderResultOf(i: QfexInstrument, add: QfexAddResult, ctx: { size: string; immediate: boolean; postOnly: boolean; exec: OrderExecution }): OrderResult {
    const exec = ctx.exec;
    const qty = (n: unknown, what: string): string => fromWireNumber(n, i.lotSize, what);
    if (add.userIdMismatches.length > 0) {
      exec.notes.push(`order_response.user_id ${add.userIdMismatches.join(", ")} differs from the session account ${this.accountId} (unverified whether user_id is the account, Q22)`);
    }
    const venueRaw = { orderId: add.orderId, responses: add.responses, fills: add.fills, terminal: add.terminal, ended: add.ended };
    const base = { venue: "qfex" as const, symbol: i.symbol, orderId: add.orderId, clientOrderId: add.clientOrderId, execution: exec, venueRaw };

    if (add.terminal !== null) {
      const t = add.terminal;
      const filled = subDecimals(qty(t.quantity, "quantity"), qty(t.quantity_remaining, "quantity_remaining"), "filled quantity");
      const fills = add.fills.map(f => ({ price: fromWireNumber(f.price, i.tickSize, "fill price"), quantity: qty(f.quantity, "fill quantity") }));
      const fillSum = sumDecimals(fills.map(f => f.quantity));
      let avgPrice: string | null = null;
      if (!isZeroDecimal(filled)) {
        if (decimalsEqual(fillSum, filled)) avgPrice = weightedAveragePrice(fills);
        else exec.notes.push(`fill frames add up to ${fillSum}, the terminal order_response reports ${filled} filled — filledSize is the order_response value, average price unknown`);
      }
      if (isZeroDecimal(filled)) {
        if (ctx.immediate) {
          // A terminal frame with nothing filled — IOC_CANCELLED or CANCELLED alike.
          throw new PerpError("ORDER_REJECTED", `QFEX ${i.venueSymbol}: the ${t.time_in_force} order filled nothing and was cancelled (${t.status})`, {
            exchange: "qfex", reason: "iocNoFill", venueStatus: t.status, orderId: add.orderId, clientOrderId: add.clientOrderId, venueRaw,
            remediation: "Nothing was filled. Widen --slippage-bps (within the price band), reduce the size, or place a resting limit order",
          });
        }
        if (ctx.postOnly && t.status === "CANCELLED") {
          // docs.qfex.com "Order Entry": "If an ALO order would immediately match with an existing
          // order, it is **cancelled** instead." The venue ACKs the order, then sends CANCELLED
          // (live 2026-10-05) — a definite "not placed", like a crossing post-only on other venues.
          throw new PerpError("ORDER_REJECTED", `QFEX ${i.venueSymbol}: post-only order would cross — the venue cancelled the ALO order right after acknowledging it (${t.status}); nothing was placed`, {
            exchange: "qfex", reason: "postOnlyWouldCross", venueStatus: t.status, orderId: add.orderId, clientOrderId: add.clientOrderId, venueRaw,
            remediation: "Use a price that does not cross the book (buy below the best ask / sell above the best bid), or drop --tif ALO to take liquidity",
          });
        }
        if (t.status === "CANCELLED_STP") exec.notes.push("cancelled by self-trade prevention");
        return { ...base, status: "cancelled", finality: "final", filledSize: "0", avgPrice: null };
      }
      const full = decimalsEqual(filled, qty(t.quantity, "quantity"));
      if (!full) exec.notes.push(`${filled} of ${qty(t.quantity, "quantity")} filled; the remainder was cancelled (${t.status})`);
      return { ...base, status: full ? "filled" : "partiallyFilled", finality: "final", filledSize: filled, avgPrice };
    }

    // No terminal frame: acknowledged, never "open" (that needs a get_user_orders row).
    const last = add.responses[add.responses.length - 1];
    const partial = qfexStatusClass(last.status) === "fill";
    const filledSoFar = partial ? subDecimals(qty(last.quantity, "quantity"), qty(last.quantity_remaining, "quantity_remaining"), "filled quantity") : null;
    if (add.ended !== "resting") {
      exec.notes.push(`no terminal venue frame within the wait (${add.ended}) — the order may still execute; status must be read back`);
    }
    return { ...base, status: partial ? "partiallyFilled" : "accepted", finality: "pending", filledSize: filledSoFar, avgPrice: null };
  }

  /**
   * Final filled size of an order placed through the legacy shim — non-null ONLY when a venue
   * terminal frame was received. A pending result is never an outcome.
   */
  iocOutcomeOf(raw: unknown): IocOutcome | null {
    const r = raw as Partial<OrderResult> | null;
    if (r === null || typeof r !== "object" || r.venue !== "qfex" || r.finality !== "final") return null;
    const v = r.venueRaw as { terminal?: unknown } | null | undefined;
    if (v === null || v === undefined || typeof v !== "object" || v.terminal === null || v.terminal === undefined) return null;
    if (typeof r.filledSize !== "string") return null;
    return { filledSize: r.filledSize, final: true };
  }

  async amendOrder(req: AmendRequest): Promise<OrderResult> {
    const cancelHint = `Cancel it, then place a new order: perp trade cancel ${req.symbol} ${req.ref.kind === "clientOrderId" ? `c:${req.ref.value}` : req.ref.value} -e qfex`;
    if (QFEX_MODIFY_KEEPS_CLIENT_ID !== true) {
      throw unsupported("qfex", "amend",
        "modify_order returns a NEW order id and is not documented to keep the client order id, so the reply cannot be tied to this order (Q5)",
        cancelHint);
    }
    const i = await this.instrumentOf(req.symbol);
    const { session } = await this.session();
    const row = this.pick(await session.getUserOrders(i.venueSymbol), req.ref);
    if (row === null) throw new PerpError("ORDER_NOT_FOUND", `QFEX: no open order ${req.ref.value} on ${i.venueSymbol}`, { exchange: "qfex" });
    if (STOP_TYPES.has(row.type) || (row.type !== "LIMIT" && row.type !== "ALO")) {
      throw unsupported("qfex", "amend", `only open LIMIT / ALO orders can be amended (order is ${row.type})`, cancelHint);
    }
    if (typeof row.client_order_id !== "string" || row.client_order_id === "") {
      throw unsupported("qfex", "amend", "the order has no client order id to correlate the modify reply with", cancelHint);
    }
    if (row.reduce_only !== false) {
      throw unsupported("qfex", "amend", "a reduce-only order is sized against the live position when it is placed; a modify would skip that check", cancelHint);
    }
    const price = requireOnTick(req.price, i.tickSize);
    const size = floorSize(req.size, i.lotSize);
    this.checkSize(i, size, "enforced");
    this.checkBand(i, row.side === "BUY" ? "buy" : "sell", price, false);
    const params = {
      symbol: i.venueSymbol, order_id: row.order_id, side: row.side, order_type: row.type,
      price: toWireNumber(price, "price"), quantity: toWireNumber(size, "quantity"),
      // Only an order the venue reports as not reduce-only reaches here (checked above).
      reduce_only: false,
      // Re-send the order's current attached TP/SL: omitting them is documented as "0 = unused".
      take_profit: typeof row.take_profit === "number" ? row.take_profit : 0,
      stop_loss: typeof row.stop_loss === "number" ? row.stop_loss : 0,
    };
    // The MODIFIED frame carries a NEW order id and the SAME client id (Q5, production 2026-10-12):
    // modifyOrder correlates on that client id plus the sent symbol / side / type / price / quantity.
    const modified = await session.modifyOrder({ params, clientOrderId: row.client_order_id, lotSize: i.lotSize, tickSize: i.tickSize });
    const notes = [`replacedOrderId ${row.order_id}: the venue assigns a new order id on modify (client id ${modified.client_order_id} kept)`];
    let newRow: QfexOrderResponse | null = null;
    try {
      newRow = this.pick(await session.getUserOrders(i.venueSymbol), { kind: "orderId", value: modified.order_id });
    } catch (e) {
      notes.push(`read-back failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (newRow !== null) {
      const r = this.openOrderResult(i, newRow);
      return { ...r, execution: execution("nativeAmend", { tifSent: modified.time_in_force, notes: [...notes, "new order listed open (get_user_orders)"] }), venueRaw: { modified, row: newRow, replacedOrderId: row.order_id } };
    }
    notes.push(`the new order ${modified.order_id} is not listed open yet (it may have filled) — check: perp trade status ${modified.order_id} --symbol ${i.symbol} -e qfex`);
    return {
      venue: "qfex", symbol: i.symbol, status: "accepted", finality: "pending",
      orderId: modified.order_id, clientOrderId: modified.client_order_id, filledSize: null, avgPrice: null,
      execution: execution("nativeAmend", { tifSent: modified.time_in_force, notes }),
      venueRaw: { modified, replacedOrderId: row.order_id },
    };
  }

  /** The open-order row for a ref; a client id shared by several open orders is ambiguous and refused. */
  private pick(rows: QfexOrderResponse[], ref: OrderRef): QfexOrderResponse | null {
    const hits = rows.filter(r => (ref.kind === "orderId" ? r.order_id : r.client_order_id) === ref.value);
    if (hits.length > 1) {
      throw new PerpError("EXCHANGE_ERROR", `QFEX: ${hits.length} open orders share client order id ${ref.value}`, {
        exchange: "qfex", orderIds: hits.map(h => h.order_id), remediation: "Use the order id instead: perp account orders -e qfex",
      });
    }
    return hits.length === 1 ? hits[0] : null;
  }

  private openOrderResult(i: QfexInstrument, row: QfexOrderResponse): OrderResult {
    const filled = subDecimals(fromWireNumber(row.quantity, i.lotSize, "quantity"), fromWireNumber(row.quantity_remaining, i.lotSize, "quantity_remaining"), "filled quantity");
    return {
      venue: "qfex", symbol: i.symbol, status: isZeroDecimal(filled) ? "open" : "partiallyFilled", finality: "final",
      orderId: row.order_id, clientOrderId: row.client_order_id === "" ? null : row.client_order_id,
      filledSize: filled, avgPrice: null,
      execution: execution(STOP_TYPES.has(row.type) ? "trigger" : "limit", { tifSent: row.type === "ALO" ? "ALO (order_type ALO + GTC)" : row.time_in_force }),
      venueRaw: row,
    };
  }

  private historicResult(i: QfexInstrument, h: QfexHistoricOrder): OrderResult {
    const quantity = fromWireNumber(h.quantity, i.lotSize, "quantity");
    const filled = fromWireNumber(h.filled_qty, i.lotSize, "filled_qty");
    const cls = qfexStatusClass(h.terminal_status);
    let status: OrderStatus;
    let finality: "final" | "pending" = "final";
    const notes: string[] = [];
    if (cls === "unknown" || cls === "ack" || cls === "modified") {
      // No (known) terminal status on the row: it does not prove the order is done.
      status = isZeroDecimal(filled) ? "accepted" : "partiallyFilled";
      finality = "pending";
      notes.push(`historic-orders row has terminal_status ${JSON.stringify(h.terminal_status)} (execution_state ${JSON.stringify(h.execution_state)}) — not a known terminal status`);
    } else if (decimalsEqual(filled, quantity)) status = "filled";
    else if (!isZeroDecimal(filled)) status = "partiallyFilled";
    else status = cls === "reject" ? "rejected" : "cancelled";
    if (h.terminal_status === "CANCELLED_STP") notes.push("cancelled by self-trade prevention");
    return {
      venue: "qfex", symbol: i.symbol, status, finality,
      orderId: h.order_id, clientOrderId: h.client_order_id === "" ? null : h.client_order_id,
      filledSize: filled, avgPrice: typeof h.avg_price === "number" && !isZeroDecimal(filled) ? plainNumber(h.avg_price, "avg_price") : null,
      execution: execution(h.type === "LIMIT" || h.type === "ALO" ? "limit" : "trigger", { tifSent: h.time_in_force, notes }),
      venueRaw: h,
    };
  }

  /** Open orders first (get_user_orders), then the historic store; null when neither has it. `source` says which one answered. */
  private async findOrder(i: QfexInstrument, ref: OrderRef): Promise<{ result: OrderResult; source: "open" | "historic" } | null> {
    const { session } = await this.session();
    const row = this.pick(await session.getUserOrders(i.venueSymbol), ref);
    if (row !== null) return { result: this.openOrderResult(i, row), source: "open" };
    const query: Record<string, string | number | null> = ref.kind === "clientOrderId"
      ? { symbol: i.venueSymbol, client_order_id: ref.value, limit: 100 }
      : { symbol: i.venueSymbol, limit: 1000 };
    const body = await this.client.get<{ data?: unknown }>("/user/historic-orders", query);
    const rows = listOf<QfexHistoricOrder>(body.data, "/user/historic-orders data")
      .filter(h => (ref.kind === "orderId" ? h.order_id : h.client_order_id) === ref.value);
    if (rows.length > 1) {
      throw new PerpError("EXCHANGE_ERROR", `QFEX: ${rows.length} historic orders match ${ref.value}`, { exchange: "qfex", orderIds: rows.map(r => r.order_id) });
    }
    return rows.length === 1 ? { result: this.historicResult(i, rows[0]), source: "historic" } : null;
  }

  async getOrderStatus(symbol: string, ref: OrderRef): Promise<OrderResult> {
    const i = await this.instrumentOf(symbol);
    const found = await this.findOrder(i, ref);
    if (found === null) {
      throw new PerpError("ORDER_NOT_FOUND", `QFEX: order ${ref.kind === "clientOrderId" ? `c:${ref.value}` : ref.value} is neither open nor in the order history of ${i.venueSymbol}`, {
        exchange: "qfex", remediation: "A just-sent order may not be visible yet (speed bump / indexing) — retry shortly; do not resubmit",
      });
    }
    return found.result;
  }

  async cancelByRef(symbol: string, ref: OrderRef): Promise<CancelResult> {
    const i = await this.instrumentOf(symbol);
    const { session } = await this.session();
    // Read first: decides stop vs normal order and turns a client id into THE order id (a
    // client-id cancel on the venue would hit every order sharing that id).
    const row = this.pick(await session.getUserOrders(i.venueSymbol), ref);
    if (row === null) {
      throw new PerpError("ORDER_NOT_FOUND", `QFEX: no open order ${ref.kind === "clientOrderId" ? `c:${ref.value}` : ref.value} on ${i.venueSymbol}`, {
        exchange: "qfex", remediation: `Check its status: perp trade status ${ref.kind === "clientOrderId" ? `c:${ref.value}` : ref.value} --symbol ${i.symbol} -e qfex`,
      });
    }
    const outcome = STOP_TYPES.has(row.type) ? await session.cancelStopOrder(i.venueSymbol, row.order_id) : await session.cancelOrder(i.venueSymbol, row.order_id);
    const result: CancelResult = { venue: "qfex", cancelled: [], failed: [], pending: [], venueRaw: outcome };
    if (outcome.kind === "cancelled") result.cancelled.push(ref);
    else if (outcome.kind === "refused") result.failed.push({ ref, error: `venue answered ${outcome.status}` });
    else {
      const settled = STOP_TYPES.has(row.type) ? await this.settleUnknownStopCancel(i.venueSymbol, row.order_id) : null;
      if (settled === "cancelled") result.cancelled.push(ref);
      else if (settled === "filled") result.failed.push({ ref, error: `order ${row.order_id} triggered / filled before the cancel` });
      else if (settled !== null && settled.startsWith(QFEX_PARTIAL_PREFIX)) result.failed.push({ ref, error: `order ${row.order_id} ${settled}` });
      else (result.pending as NonNullable<CancelResult["pending"]>).push({ ref, reason: settled === null ? outcome.reason : `${outcome.reason}; re-check: ${settled}`, remediation: "Do NOT assume it was cancelled. Check: perp account orders -e qfex" });
    }
    return result;
  }

  async cancelAllV2(symbol: string | null): Promise<CancelResult> {
    const venueSymbol = symbol === null ? null : (await this.instrumentOf(symbol)).venueSymbol;
    const { session } = await this.session();
    const before = await session.getUserOrders(venueSymbol);
    const result: CancelResult = { venue: "qfex", cancelled: [], failed: [], pending: [], venueRaw: null };
    const pending = result.pending as NonNullable<CancelResult["pending"]>;
    if (before.length === 0) {
      result.venueRaw = { before: 0 };
      return result;
    }
    const normalIds = new Set(before.filter(o => !STOP_TYPES.has(o.type)).map(o => o.order_id));
    const sent = await session.cancelAll(venueSymbol, normalIds, new Set(before.map(o => o.order_id)));
    const proven = new Set(sent.cancelled);
    // Verifying re-list: the venue documents no completion signal for cancel_all_orders, and
    // whether it also removes stop orders is unverified (Q8).
    const after = await session.getUserOrders(venueSymbol);
    const stillOpen = new Set(after.map(o => o.order_id));
    const refOf = (id: string): OrderRef => ({ kind: "orderId", value: id });
    for (const o of before) {
      if (proven.has(o.order_id)) { result.cancelled.push(refOf(o.order_id)); continue; }
      if (!stillOpen.has(o.order_id)) {
        // Gone without a CANCELLED frame on this connection: settled from the order's own record
        // (/user/historic-orders, bounded retries for its indexing lag) — cancelled, filled /
        // triggered, or still unproven.
        const settled = STOP_TYPES.has(o.type) ? stopHistoryVerdict(await this.settledByHistory(o.symbol, o.order_id)) : await this.settledByHistory(o.symbol, o.order_id);
        if (settled === "cancelled") result.cancelled.push(refOf(o.order_id));
        else if (settled === "filled") result.failed.push({ ref: refOf(o.order_id), error: `order ${o.order_id} ${STOP_TYPES.has(o.type) ? "triggered / " : ""}filled before the cancel` });
        else if (settled.startsWith(QFEX_PARTIAL_PREFIX)) result.failed.push({ ref: refOf(o.order_id), error: `order ${o.order_id} ${settled} — check the position: perp account positions -e qfex` });
        else pending.push({ ref: refOf(o.order_id), reason: `no longer listed after cancel_all_orders, and its historic-orders row does not settle it yet (${settled})`, remediation: "Check: perp account orders -e qfex / perp account positions -e qfex" });
        continue;
      }
      if (STOP_TYPES.has(o.type)) {
        const one = await session.cancelStopOrder(o.symbol, o.order_id);
        if (one.kind === "cancelled") result.cancelled.push(refOf(o.order_id));
        else if (one.kind === "refused") result.failed.push({ ref: refOf(o.order_id), error: `venue answered ${one.status}` });
        else {
          // Observed on mainnet (2026-10-13): cancel_stop_order on a reduce-only stop whose position
          // was just closed answers "ServerError: unexpected error" while the venue removes the stop
          // itself. Unknown stays unknown unless a re-list AND the order's own record settle it.
          const settled = await this.settleUnknownStopCancel(o.symbol, o.order_id);
          if (settled === "cancelled") result.cancelled.push(refOf(o.order_id));
          else if (settled === "filled") result.failed.push({ ref: refOf(o.order_id), error: `order ${o.order_id} triggered / filled before the cancel` });
          else if (settled.startsWith(QFEX_PARTIAL_PREFIX)) result.failed.push({ ref: refOf(o.order_id), error: `order ${o.order_id} ${settled}` });
          else pending.push({ ref: refOf(o.order_id), reason: `${one.reason}; re-check: ${settled}`, remediation: "Check: perp account orders -e qfex" });
        }
        continue;
      }
      pending.push({
        ref: refOf(o.order_id),
        reason: "still listed open after cancel_all_orders",
        remediation: "Check: perp account orders -e qfex / perp account positions -e qfex",
      });
    }
    result.venueRaw = { before: before.length, cancelAll: sent, afterOpen: after.length, excluded: "TWAP orders are not cancelled by perp-cli" };
    return result;
  }

  /**
   * How an order that disappeared from the open orders ended, from its /user/historic-orders row
   * (Q6: the row may lag): "cancelled" / "filled" when the row proves it, else "not indexed" /
   * the unproven status after HISTORY_SETTLE_TRIES reads HISTORY_SETTLE_DELAY_MS apart.
   */
  /** After an unknown stop-cancel outcome: "cancelled"/"filled" only when the stop is no longer listed open
   *  AND its historic-orders row settles it; otherwise a reason string (the cancel stays pending). */
  private async settleUnknownStopCancel(venueSymbol: string, orderId: string): Promise<"cancelled" | "filled" | string> {
    const { session } = await this.session();
    await new Promise(r => setTimeout(r, HISTORY_SETTLE_DELAY_MS));
    let open: Awaited<ReturnType<typeof session.getUserOrders>>;
    try {
      open = await session.getUserOrders(venueSymbol);
    } catch (e) {
      // The cancel outcome stays unknown; the caller reports it pending (never thrown away).
      return `open-order re-list failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (open.some(o => o.order_id === orderId)) return "still listed open";
    return stopHistoryVerdict(await this.settledByHistory(venueSymbol, orderId));
  }

  private async settledByHistory(venueSymbol: string, orderId: string): Promise<"cancelled" | "filled" | string> {
    let last = "not indexed";
    for (let i = 0; i < HISTORY_SETTLE_TRIES; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, HISTORY_SETTLE_DELAY_MS));
      let rows: QfexHistoricOrder[];
      try {
        const body = await this.client.get<{ data?: unknown }>("/user/historic-orders", { symbol: venueSymbol, limit: 1000 });
        rows = listOf<QfexHistoricOrder>(body.data, "/user/historic-orders data").filter(h => h.order_id === orderId);
      } catch (e) {
        last = `historic-orders read failed: ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      if (rows.length !== 1) { last = rows.length === 0 ? "not indexed" : `${rows.length} rows`; continue; }
      const h = rows[0];
      const cancelledStatus = h.terminal_status === "CANCELLED" || h.terminal_status === "CANCELLED_STP" || h.terminal_status === "EXPIRED";
      // Filled qty on a CANCELLED row = partially filled, remainder cancelled — not "filled".
      if (Number(h.filled_qty) > 0) return cancelledStatus ? `${QFEX_PARTIAL_PREFIX} (${String(h.filled_qty)}) before the cancel; the remainder was cancelled` : "filled";
      const cls = qfexStatusClass(h.terminal_status);
      if (cancelledStatus) return "cancelled";
      last = `terminal_status ${JSON.stringify(h.terminal_status)} (${cls})`;
    }
    return last;
  }

  async applyLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" | null): Promise<LeverageResult> {
    if (marginMode === "isolated") {
      throw unsupported("qfex", "isolatedMargin", "every QFEX market is cross-margin", "Omit --isolated");
    }
    if (!Number.isFinite(leverage) || leverage < 1) throw new PerpError("INVALID_PARAMS", `QFEX leverage must be a number ≥ 1 (got ${leverage})`);
    const i = await this.instrumentOf(symbol);
    if (leverage > i.maxLeverage) {
      throw new PerpError("INVALID_PARAMS", `QFEX ${i.venueSymbol}: leverage ${leverage} exceeds the market maximum ${i.maxLeverage}`, { exchange: "qfex" });
    }
    this.requireMeta();
    const raw = await this.client.post<{ leverage?: unknown }>("/user/leverage", null, { symbol: i.venueSymbol, leverage });
    if (raw === null || typeof raw.leverage !== "number") {
      throw new PerpError("EXCHANGE_ERROR", "QFEX POST /user/leverage: response does not report the leverage", { exchange: "qfex", venueRaw: raw });
    }
    return { venue: "qfex", symbol: i.symbol, leverage: raw.leverage, marginMode: "cross", venueRaw: raw };
  }

  // ── Legacy ExchangeAdapter: market data ──

  /**
   * Legacy rows plus `tradable` (ACTIVE and USD-quoted, qfexTradable), the /refdata `status`
   * (ACTIVE / INACTIVE / DELISTED) and `quoteAsset` (prices of KRW / JPY / CNY / SEK / HKD markets
   * are in that currency, not USD).
   */
  async getMarkets(): Promise<QfexMarketRow[]> {
    const { markets, instruments, volumeNotional } = await fetchQfexMarketsWithInstruments(this.network);
    const bySymbol = new Map(instruments.map(i => [i.venueSymbol, i]));
    return markets.map(m => this.marketRow(m, bySymbol.get(m.venueSymbol), volumeNotional));
  }

  private marketRow(m: VenueMarket, i: QfexInstrument | undefined, volumeNotional: ReadonlyMap<string, string>): QfexMarketRow {
    if (i === undefined) throw new PerpError("EXCHANGE_ERROR", `QFEX ${m.venueSymbol} is missing from /refdata`, { exchange: "qfex" });
    return {
      ...toLegacyMarketInfo(m), tradable: m.tradable, status: qfexListedStatus(i), quoteAsset: i.quoteAsset,
      volume24hQuote: volumeNotional.get(i.venueSymbol) ?? null,
    };
  }

  /**
   * `market info` of one ACTIVE market. fundingRate is the CURRENT /md/contracts `funding_rate`
   * (the rate `market funding` / `perp funding` show), labelled fundingVerified false: QFEX funding
   * is unverified (Q4, display only). Market lists keep fundingRate null so no scan / bot reads it.
   */
  async getMarketInfo(symbol: string): Promise<QfexMarketRow & { fundingVerified: false; fundingNote: string; marketClosed: boolean | null }> {
    const i = await this.readableInstrument(symbol);
    const snap = await fetchQfexMarketStats(QFEX_ENDPOINTS[this.network].mdsWs, i.venueSymbol, QFEX_MDS_TIMEOUT_MS);
    const contracts = await this.client.publicGet<{ data?: unknown }>("/md/contracts", null);
    const { markets } = buildQfexMarkets([i], snap, Date.now(), qfexIndexPrices(listOf<QfexContractRow>(contracts.data, "/md/contracts data")));
    if (markets.length === 0) throw new PerpError("PRICE_STALE", `QFEX ${i.venueSymbol}: no mark price in the market_stats snapshot`, { exchange: "qfex" });
    const { rates } = buildQfexFundingRates([i], listOf<QfexContractRow>(contracts.data, "/md/contracts data").filter(c => c.ticker_id === i.venueSymbol), snap.marks, Date.now());
    return {
      ...this.marketRow(markets[0], i, snap.volumeNotional),
      fundingRate: rates.length === 0 ? null : rates[0].rate,
      // true = the window in progress is outside the market's funding hours (fundingRate null).
      marketClosed: rates.length === 0 ? null : rates[0].marketClosed === true,
      fundingVerified: false,
      fundingNote: "QFEX funding rate UNVERIFIED (not confirmed against settled payments) — display only, never a basis for trading",
    };
  }

  /** `quoteAsset`: level prices are in the market's quote currency (KRW for SAMSUNG-KRW). */
  async getOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][]; quoteAsset: string }> {
    // Resolved against refdata first: an unknown symbol is SYMBOL_NOT_FOUND, not the venue's
    // HTTP 404 surfacing as a retryable EXCHANGE_ERROR.
    const instrument = await this.readableInstrument(symbol);
    const venueSymbol = instrument.venueSymbol;
    const book = await this.client.publicGet<{ bids?: unknown; asks?: unknown }>(`/md/orderbook/${encodeURIComponent(venueSymbol)}`, null);
    // The venue lists empty price levels (quantity "0"); they are not part of the book.
    const side = (v: unknown, what: string): [string, string][] => listOf<string[]>(v, what)
      .filter(l => Array.isArray(l) && typeof l[0] === "string" && typeof l[1] === "string" && Number(l[1]) > 0)
      .map(l => [l[0], l[1]]);
    return { bids: side(book.bids, "orderbook bids"), asks: side(book.asks, "orderbook asks"), quoteAsset: instrument.quoteAsset };
  }

  async getRecentTrades(): Promise<ExchangePublicTrade[]> {
    throw unsupported("qfex", "recentTrades", "the documented public trade endpoint (GET /public/trades) answers 404", "Use the order book: perp market book <symbol> -e qfex");
  }

  /**
   * Hourly funding windows (GET /funding/{symbol}, intervalMinutes 60). `limit` = hours back (default 24).
   * A window outside the market's funding hours (qfexFundingWindowClosed) is `rate: null,
   * marketClosed: true` — the venue prints 0 there, which is "no funding", not a 0 rate.
   */
  async getFundingHistory(symbol: string, limit?: number): Promise<FundingHistoryRow[]> {
    const instrument = await this.readableInstrument(symbol);
    const venueSymbol = instrument.venueSymbol;
    const hours = limit === undefined ? 24 : limit;
    if (!Number.isInteger(hours) || hours < 1) throw new PerpError("INVALID_PARAMS", `funding history limit must be a positive integer of hours (got ${hours})`);
    const to = Date.now();
    const body = await this.client.publicGet<{ data?: unknown }>(`/funding/${encodeURIComponent(venueSymbol)}`, {
      intervalMinutes: 60, fromISO: new Date(to - hours * 3_600_000).toISOString(), toISO: new Date(to).toISOString(),
    });
    const out: FundingHistoryRow[] = [];
    for (const r of listOf<{ windowStart?: unknown; rate?: unknown }>(body.data, "funding data")) {
      if (r.rate === null) continue; // the venue computed no rate for that window
      const time = typeof r.windowStart === "string" ? Date.parse(r.windowStart) : NaN;
      if (!Number.isFinite(time)) throw new PerpError("EXCHANGE_ERROR", `QFEX funding history: invalid windowStart ${JSON.stringify(r.windowStart)}`);
      const rate = plainNumber(r.rate, "funding rate");
      const marketClosed = qfexFundingWindowClosed(instrument.marketHours, time, Number(rate));
      out.push({ time, rate: marketClosed ? null : rate, price: null, intervalHours: 1, rateKind: marketClosed ? null : "lastSettled", marketClosed });
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /** Rows carry `quoteAsset`: OHLC prices are in the market's quote currency (KRW for SAMSUNG-KRW). */
  async getKlines(symbol: string, interval: string, startTime: number, endTime: number): Promise<Array<ExchangeKline & { quoteAsset: string }>> {
    const resolution = KLINE_RESOLUTION[interval.trim()];
    if (resolution === undefined) {
      throw new PerpError("INVALID_PARAMS", `Unsupported kline interval "${interval}" on QFEX`, { remediation: `Use one of: ${Object.keys(KLINE_RESOLUTION).join(", ")}` });
    }
    const instrument = await this.readableInstrument(symbol);
    const venueSymbol = instrument.venueSymbol;
    const body = await this.client.publicGet<{ candles?: unknown }>(`/candles/${encodeURIComponent(venueSymbol)}`, {
      resolution, fromISO: new Date(startTime).toISOString(), toISO: new Date(endTime).toISOString(),
    });
    return listOf<QfexCandle>(body.candles, "candles").map(c => {
      const time = Date.parse(c.startedAt);
      if (!Number.isFinite(time)) throw new PerpError("EXCHANGE_ERROR", `QFEX candles: invalid startedAt "${c.startedAt}"`);
      const v = qfexCandleVolumes(c);
      // `usdVolume` is Σ price × qty in the QUOTE currency (live 2026-10-19: SAMSUNG-KRW 1m candles
      // equal the KRW trade tape exactly); quoteVolume is USD → null for a non-USD quote.
      return { time, open: c.open, high: c.high, low: c.low, close: c.close, ...v, quoteVolume: instrument.quoteAsset === "USD" ? v.quoteVolume : null, trades: null, quoteAsset: instrument.quoteAsset };
    }).sort((a, b) => a.time - b.time);
  }

  // ── Legacy ExchangeAdapter: account ──

  private async userPositions(): Promise<{ balance: QfexRestBalance; positions: QfexRestPosition[] }> {
    this.requireMeta();
    const body = await this.client.get<{ balance?: QfexRestBalance; positions?: unknown }>("/user/positions", null);
    if (body.balance === undefined || body.balance === null) throw new PerpError("EXCHANGE_ERROR", "QFEX /user/positions: response has no balance");
    return { balance: body.balance, positions: listOf<QfexRestPosition>(body.positions, "/user/positions positions") };
  }

  /** Equity is the venue's own figure (GET /user/subaccounts/equity) — never recomputed from balance fields. */
  async getBalance(): Promise<ExchangeBalance> {
    const meta = this.requireMeta();
    const { balance } = await this.userPositions();
    const eq = await this.client.getAs<{ accounts?: unknown }>("/user/subaccounts/equity", null, null);
    const row = listOf<{ account_id?: unknown; equity?: unknown }>(eq.accounts, "/user/subaccounts/equity accounts")
      .find(a => typeof a.account_id === "string" && a.account_id.toLowerCase() === meta.accountId);
    if (row === undefined) {
      throw new PerpError("EXCHANGE_ERROR", `QFEX /user/subaccounts/equity lists no account ${meta.accountId}`, {
        exchange: "qfex", remediation: "The key may no longer cover that account — re-import: perp wallet agent import qfex --replace",
      });
    }
    return {
      equity: plainNumber(row.equity, "equity"),
      available: plainNumber(balance.available_balance, "available_balance"),
      marginUsed: sumDecimals([plainNumber(balance.order_margin, "order_margin"), plainNumber(balance.position_margin, "position_margin")]),
      unrealizedPnl: plainNumber(balance.unrealised_pnl, "unrealised_pnl"),
    };
  }

  /**
   * `position` is a signed quantity: positive = long, negative = short (the response has no
   * side field; Q10). requireReducible reads the same sign for reduce-only orders. The mark
   * comes from the MDS snapshot; the venue reports no liquidation price.
   */
  async getPositions(): Promise<ExchangePosition[]> {
    const { positions } = await this.userPositions();
    const open = positions.filter(p => typeof p.position === "number" && p.position !== 0);
    if (open.length === 0) return [];
    const instruments = await this.instrumentMap();
    const snap = await fetchQfexMarketStats(QFEX_ENDPOINTS[this.network].mdsWs, "*", QFEX_MDS_TIMEOUT_MS);
    return open.map(p => {
      const i = instruments.get(p.symbol);
      if (i === undefined) throw new PerpError("EXCHANGE_ERROR", `QFEX position on ${p.symbol}, which /refdata does not list`, { exchange: "qfex" });
      const mark = snap.marks.get(p.symbol);
      if (mark === undefined) throw new PerpError("PRICE_STALE", `QFEX: no mark price for ${p.symbol} (open position)`, { exchange: "qfex" });
      return {
        symbol: i.symbol,
        side: p.position > 0 ? "long" as const : "short" as const,
        size: fromWireNumber(Math.abs(p.position), i.lotSize, "position"),
        entryPrice: plainNumber(p.average_price, "average_price"),
        markPrice: mark.price,
        liquidationPrice: null,
        unrealizedPnl: plainNumber(p.unrealised_pnl, "unrealised_pnl"),
        leverage: p.leverage,
      };
    });
  }

  async getOpenOrders(): Promise<ExchangeOrder[]> {
    const { session } = await this.session();
    const rows = await session.getUserOrders(null);
    const instruments = await this.instrumentMap();
    return rows.map(o => {
      const i = instruments.get(o.symbol);
      if (i === undefined) throw new PerpError("EXCHANGE_ERROR", `QFEX open order on ${o.symbol}, which /refdata does not list`, { exchange: "qfex" });
      const quantity = fromWireNumber(o.quantity, i.lotSize, "quantity");
      const price = fromWireNumber(o.price, i.tickSize, "price");
      const stop = STOP_TYPES.has(o.type);
      return {
        orderId: o.order_id,
        symbol: i.symbol,
        side: o.side === "BUY" ? "buy" as const : "sell" as const,
        price,
        size: quantity,
        filled: subDecimals(quantity, fromWireNumber(o.quantity_remaining, i.lotSize, "quantity_remaining"), "filled quantity"),
        status: stop ? "untriggered" : "open",
        type: o.type,
        triggerPrice: stop ? price : null,
      };
    });
  }

  async getOrderHistory(limit?: number): Promise<ExchangeOrder[]> {
    this.requireMeta();
    const body = await this.client.get<{ data?: unknown }>("/user/historic-orders", { limit: limit === undefined ? null : limit });
    return listOf<QfexHistoricOrder>(body.data, "/user/historic-orders data").map(h => ({
      orderId: h.order_id,
      symbol: qfexPlainSymbol(h.symbol),
      side: h.side === "BUY" ? "buy" as const : "sell" as const,
      price: plainNumber(h.price, "price"),
      size: plainNumber(h.quantity, "quantity"),
      filled: plainNumber(h.filled_qty, "filled_qty"),
      status: h.terminal_status,
      type: h.type,
      triggerPrice: null,
    }));
  }

  /** `order_timestamp` is unix seconds with a fraction (the same unit as order_response.update_time). */
  async getTradeHistory(limit?: number): Promise<ExchangeTrade[]> {
    this.requireMeta();
    const body = await this.client.get<{ data?: unknown }>("/user/trade", { limit: limit === undefined ? null : limit });
    return listOf<QfexUserTrade>(body.data, "/user/trade data").map(t => ({
      time: Math.round(Number(plainNumber(t.order_timestamp, "order_timestamp")) * 1000),
      symbol: qfexPlainSymbol(t.symbol),
      side: t.side === "BUY" ? "buy" as const : "sell" as const,
      price: plainNumber(t.price, "price"),
      size: plainNumber(t.quantity, "quantity"),
      fee: plainNumber(t.fee, "fee"),
    }));
  }

  async getFundingPayments(): Promise<ExchangeFundingPayment[]> {
    throw unsupported("qfex", "fundingPayments",
      "funding payments are GET /executions rows, but the execution_type that marks them is not documented (Q10)",
      "See funding in the QFEX web app; net funding per position is in: perp account positions -e qfex --json");
  }

  // ── Legacy ExchangeAdapter: trading (shim → TradingV2). Client ids are generated here. ──

  async marketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { reduceOnly: boolean; slippage: ResolvedSlippage }): Promise<OrderResult> {
    return this.placeOrder({
      symbol, side, type: "market", size, price: null, triggerPrice: null, triggerSource: null, tif: null,
      reduceOnly: opts.reduceOnly, clientOrderId: qfexClientOrderId(), slippage: opts.slippage, tpsl: null,
    });
  }

  async limitOrder(
    symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { reduceOnly?: boolean; tif?: string },
  ): Promise<OrderResult> {
    const tifInput = opts?.tif;
    const tif = tifInput === undefined || tifInput === "" ? null : validateLegacyTif(this.venue, this.caps, tifInput);
    return this.placeOrder({
      symbol, side, type: "limit", size, price, triggerPrice: null, triggerSource: null, tif,
      reduceOnly: opts?.reduceOnly === true, clientOrderId: qfexClientOrderId(), slippage: null, tpsl: null,
    });
  }

  async editOrder(symbol: string, orderId: string, price: string, size: string): Promise<OrderResult> {
    return this.amendOrder({ symbol, ref: parseOrderRef(orderId), price, size, tif: null });
  }

  async cancelOrder(symbol: string, orderId: string): Promise<CancelResult> {
    return this.cancelByRef(symbol, parseOrderRef(orderId));
  }

  async cancelAllOrders(symbol?: string): Promise<CancelResult> {
    return this.cancelAllV2(symbol === undefined ? null : symbol);
  }

  async setLeverage(symbol: string, leverage: number, marginMode?: "cross" | "isolated"): Promise<LeverageResult> {
    return this.applyLeverage(symbol, leverage, marginMode === undefined ? null : marginMode);
  }

  async stopOrder(
    symbol: string, side: "buy" | "sell", size: string, triggerPrice: string,
    opts?: { limitPrice?: string; reduceOnly?: boolean; triggerType?: "mark" | "last" | "mid" },
  ): Promise<OrderResult> {
    return this.placeOrder({
      symbol, side, type: opts?.limitPrice !== undefined ? "stopLimit" : "stopMarket", size,
      price: opts?.limitPrice === undefined ? null : opts.limitPrice, triggerPrice,
      triggerSource: opts?.triggerType === undefined ? null : opts.triggerType,
      tif: opts?.limitPrice !== undefined ? "GTC" : null,
      reduceOnly: opts?.reduceOnly === true, clientOrderId: qfexClientOrderId(), slippage: null, tpsl: null,
    });
  }

  // ── Funds ──

  /**
   * Deposit address for USDC on Arbitrum One (banker GET /address). The address is returned
   * only when the venue confirms exactly that network and asset — anything else is refused,
   * because funds sent on another network / asset are lost.
   */
  async depositAddress(): Promise<{ address: string; network: string; asset: string }> {
    this.requireMeta();
    const r = await this.client.bankerGet<{ address?: unknown; network?: unknown; asset?: unknown }>("/address", { network: QFEX_BANKER_NETWORK });
    if (r.network !== QFEX_BANKER_NETWORK || r.asset !== "USDC" || typeof r.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(r.address)) {
      throw new PerpError("EXCHANGE_ERROR", `QFEX returned a deposit address for network ${JSON.stringify(r.network)} / asset ${JSON.stringify(r.asset)}, not ${QFEX_BANKER_NETWORK} / USDC — it is not shown`, {
        exchange: "qfex", remediation: "Use the QFEX web app funding screen; sending another asset or network to a deposit address loses the funds",
      });
    }
    return { address: r.address, network: r.network, asset: r.asset };
  }

  /**
   * Withdraw USDC to an Arbitrum One address (banker POST /withdraw — NOT idempotent).
   * Authority is the API key alone, so the local withdraw gate (settings.withdraw.qfex:
   * allowlist, maxPerTx, maxPerDay) is enforced HERE; absent → refused. The venue may still
   * refuse: QFEX documents that withdrawals need 2FA on the web app.
   * No balance pre-check: the venue's Withdrawable Balance is not exposed by the API and
   * `available_balance` is a different quantity — the venue's own 400 is the answer.
   */
  async withdraw(amount: string, destination: string, opts?: { assetId?: number; routeType?: number }): Promise<{
    accepted: true; amount: string; address: string; network: string; asset: "USDC"; fee: null; note: string;
  }> {
    if (!QFEX_WITHDRAW_ENABLED) {
      throw unsupported("QFEX", "withdraw", QFEX_WITHDRAW_DISABLED.reason, QFEX_WITHDRAW_DISABLED.remediation);
    }
    const meta = this.requireMeta();
    if (opts?.assetId !== undefined || opts?.routeType !== undefined) {
      throw new PerpError("INVALID_PARAMS", "QFEX withdraw takes no assetId/routeType (USDC on Arbitrum One only)");
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(destination)) {
      throw new PerpError("INVALID_PARAMS", `QFEX withdraw destination must be an EVM (Arbitrum One) address (got "${destination}")`);
    }
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || !(Number(amount) > 0)) {
      throw new PerpError("INVALID_PARAMS", `Withdraw amount must be a positive decimal with at most 6 decimals (got "${amount}")`);
    }
    if (!meta.isPrimaryAccount) {
      throw new PerpError("INVALID_PARAMS", `QFEX withdrawals leave the primary account; key "${meta.agentName}" is bound to subaccount ${meta.accountId}`, {
        remediation: "Move funds to the primary account first (perp funds transfer <amount> primary -e qfex), then withdraw with a key bound to the primary account",
      });
    }
    const now = Date.now();
    assertWithdrawAllowed("qfex", this.network, amount, destination, this.withdrawGate, now);
    const body = { amount: toWireNumber(amount, "amount"), address: destination, network: QFEX_BANKER_NETWORK };
    const attempt = recordWithdrawAttempt("qfex", this.network, amount, destination, now);
    try {
      await this.client.bankerPost("/withdraw", body);
    } catch (e) {
      // Only an explicit venue answer (HTTP < 500) proves nothing left the account.
      const http = e instanceof PerpError ? e.structured.details?.httpStatus : undefined;
      if (e instanceof PerpError && e.structured.code !== "ORDER_PENDING" && typeof http === "number" && http < 500) forgetWithdrawAttempt(attempt);
      throw e;
    }
    return {
      accepted: true, amount, address: destination, network: QFEX_BANKER_NETWORK, asset: "USDC", fee: null,
      note: "Accepted and debited by QFEX. The network fee is taken from the amount (not published); on-chain completion may wait for a manual review.",
    };
  }

  /** The user's accounts (GET /user/subaccounts/balance): id, primary flag, available balance. */
  async listAccounts(): Promise<Array<{ accountId: string; isPrimary: boolean; available: string }>> {
    this.requireMeta();
    const body = await this.client.getAs<{ accounts?: unknown }>("/user/subaccounts/balance", null, null);
    return listOf<{ account_id?: unknown; is_master?: unknown; available_balance?: unknown }>(body.accounts, "/user/subaccounts/balance accounts").map(a => {
      if (typeof a.account_id !== "string") throw new PerpError("EXCHANGE_ERROR", "QFEX /user/subaccounts/balance: account without account_id");
      return { accountId: a.account_id.toLowerCase(), isPrimary: a.is_master === true, available: plainNumber(a.available_balance, "available_balance") };
    });
  }

  /**
   * Move USDC between two of the user's accounts (POST /user/transfer → 204). Idempotency and
   * the needed permission are unverified (Q16): an unknown outcome is ORDER_PENDING, never re-sent.
   */
  async transferBetweenAccounts(amount: string, fromAccountId: string, toAccountId: string): Promise<{ amount: string; from: string; to: string }> {
    this.requireMeta();
    if (!/^\d+(\.\d{1,6})?$/.test(amount) || !(Number(amount) > 0)) {
      throw new PerpError("INVALID_PARAMS", `Transfer amount must be a positive decimal with at most 6 decimals (got "${amount}")`);
    }
    if (!UUID_RE.test(fromAccountId) || !UUID_RE.test(toAccountId)) throw new PerpError("INVALID_PARAMS", "QFEX transfer accounts must be account UUIDs");
    if (fromAccountId.toLowerCase() === toAccountId.toLowerCase()) throw new PerpError("INVALID_PARAMS", "QFEX transfer: source and destination are the same account");
    await this.client.post("/user/transfer", { src_account_id: fromAccountId, dst_account_id: toAccountId }, { amount: toWireNumber(amount, "amount") });
    return { amount, from: fromAccountId, to: toAccountId };
  }
}

export { qfexPendingRemediation };
