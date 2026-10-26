/**
 * Pacifica Spot Adapter.
 *
 * Spot is a different `symbol` ("SOL-USDC") on the same Pacifica order
 * endpoints as perps, signed by the same Solana signer (incl. agent_wallet).
 * Account model is unified: spot BUYs spend the shared USDC perp margin and
 * spot holdings are cross-margin collateral — there is no transfer.
 *
 * Venue constraints: reduce_only must be false, no TP/SL, no builder code.
 *
 * Unverifiable without a funded live account (documented, not guessed):
 *  - whether GET /orders lists spot orders (assumed: it covers all markets;
 *    we filter by spot symbol);
 *  - the exact shape of /orders/history_by_id rows (fill price field), so
 *    avgPrice is reported only when the row exposes `average_filled_price`.
 */

import type {
  SpotAdapter,
  SpotMarketInfo,
  SpotBalance,
  SpotOrderResult,
  SpotOpenOrdersCapable,
  SpotCancelAllCapable,
} from "./spot-interface.js";
import type { ResolvedSlippage } from "./slippage.js";
import { pacificaCreateRejection, pacificaLatestHistoryRow, pacificaTif, type PacificaAdapter } from "./pacifica.js";
import type { IocOutcome } from "./ioc-outcome.js";
import { PerpError, orderNotSent } from "../errors.js";
import { floorSize, requireOnTick, requirePositive, subDecimal } from "./precision.js";
import type { MarketInfo } from "../pacifica/types/market.js";

type Settled = Pick<SpotOrderResult, "status" | "filledSize" | "avgPrice" | "finality" | "remediation">;

const QUOTE = "USDC";

let buyWarned = false;
function warnSharedMarginOnce(): void {
  if (buyWarned) return;
  buyWarned = true;
  console.error(
    "[pacifica-spot] Warning: spot buys on Pacifica spend the shared USDC perp margin (unified account) and reduce perp available margin.",
  );
}

/** Required venue field as a string (Rule #2: a missing field is an error, not "0"). */
function reqField(row: Record<string, unknown>, field: string): string {
  const v = row[field];
  if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) return String(v);
  throw new PerpError("EXCHANGE_ERROR", `Pacifica order row ${String(row.order_id)} has no "${field}"`, { exchange: "pacifica" });
}

function decimalsOf(step: string): number {
  const frac = step.split(".")[1];
  return frac ? frac.replace(/0+$/, "").length : 0;
}

/**
 * Spot balances from Pacifica GET /account (USDC = the shared perp collateral, then
 * `spot_balances`) — the one mapper behind the keyed spot adapter and the keyless
 * `account balance --address`.
 */
export function pacificaSpotBalanceRows(info: Record<string, unknown>): SpotBalance[] {
  const rows = info.spot_balances;
  if (!Array.isArray(rows)) {
    throw new PerpError("INVALID_PARAMS", "Pacifica /account response has no spot_balances array", { exchange: "pacifica" });
  }
  const out: SpotBalance[] = [];
  // USDC = the shared perp collateral (same money as perp equity).
  const total = String(info.balance);
  const available = String(info.available_to_spend);
  out.push({ token: QUOTE, total, available, held: subDecimal(total, available), shared: true });
  for (const r of rows as Array<Record<string, unknown>>) {
    const t = String(r.amount);
    const a = String(r.available_to_withdraw);
    out.push({ token: String(r.symbol), total: t, available: a, held: subDecimal(t, a), shared: false });
  }
  return out;
}

export class PacificaSpotAdapter implements SpotAdapter, SpotOpenOrdersCapable, SpotCancelAllCapable {
  readonly name = "pacifica";
  private _perp: PacificaAdapter;
  /** base ("SOL") → /info spot row */
  private _spot = new Map<string, MarketInfo>();
  private _initialized = false;
  /** Venue-final IOC outcomes keyed by the SpotOrderResult returned (see iocOutcomeOf). */
  private readonly _iocOutcomes = new WeakMap<object, IocOutcome>();

  constructor(perp: PacificaAdapter) {
    this._perp = perp;
  }

  async init(): Promise<void> {
    if (this._initialized) return;
    await this._loadSpotInfo();
    this._initialized = true;
  }

  private async _loadSpotInfo(): Promise<MarketInfo[]> {
    const rows = (await this._perp.sdk.getInfo()).filter((m) => m.instrument_type === "spot");
    this._spot.clear();
    for (const m of rows) this._spot.set(m.base_asset.toUpperCase(), m);
    return rows;
  }

  /** bare base or "BASE/USDC" → /info spot row (wire symbol "BASE-USDC"). */
  private _resolve(symbol: string): MarketInfo {
    const [base, quote] = symbol.toUpperCase().split("/");
    if (quote !== undefined && quote !== QUOTE) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Pacifica spot only quotes ${QUOTE} (got ${symbol})`, { exchange: "pacifica" });
    }
    const m = this._spot.get(base);
    if (!m) {
      throw new PerpError("SYMBOL_NOT_FOUND", `No Pacifica spot market for ${symbol}`, {
        exchange: "pacifica",
        remediation: `Available: ${[...this._spot.keys()].map((b) => `${b}/${QUOTE}`).join(", ") || "none"}`,
      });
    }
    return m;
  }

  async getSpotMarkets(): Promise<SpotMarketInfo[]> {
    const [rows, prices] = await Promise.all([this._loadSpotInfo(), this._perp.sdk.getPrices()]);
    this._initialized = true;
    const priceMap = new Map(prices.map((p) => [p.symbol, p]));
    return rows.map((m) => {
      const p = priceMap.get(m.symbol);
      if (!p) throw new PerpError("PRICE_STALE", `No price for Pacifica spot market ${m.symbol}`, { exchange: "pacifica" });
      return {
        symbol: `${m.base_asset}/${QUOTE}`,
        baseToken: m.base_asset,
        quoteToken: QUOTE,
        markPrice: p.mark,
        volume24h: p.volume_24h,
        sizeDecimals: decimalsOf(m.lot_size),
        priceDecimals: decimalsOf(m.tick_size),
      };
    });
  }

  async getSpotOrderbook(symbol: string): Promise<{ bids: [string, string][]; asks: [string, string][] }> {
    await this.init();
    const m = this._resolve(symbol);
    const book = await this._perp.sdk.getBook(m.symbol);
    return {
      bids: book.l[0].map((e) => [e.p, e.a] as [string, string]),
      asks: book.l[1].map((e) => [e.p, e.a] as [string, string]),
    };
  }

  async getSpotBalances(): Promise<SpotBalance[]> {
    const info = (await this._perp.sdk.getAccount(this._perp.publicKey)) as unknown as Record<string, unknown>;
    return pacificaSpotBalanceRows(info);
  }

  /** Mark price for min-notional / slippage checks. */
  private async _mark(wire: string): Promise<string> {
    const p = (await this._perp.sdk.getPrices()).find((x) => x.symbol === wire);
    if (!p) throw new PerpError("PRICE_STALE", `No price for ${wire}`, { exchange: "pacifica" });
    return p.mark;
  }

  private _checkNotional(m: MarketInfo, price: string, size: string): void {
    if (Number(price) * Number(size) < Number(m.min_order_size)) {
      throw new PerpError("SIZE_TOO_SMALL", `Notional ${(Number(price) * Number(size)).toFixed(4)} USD is below Pacifica spot minimum ${m.min_order_size} USD`, {
        exchange: "pacifica",
        remediation: `Increase size so price x size >= ${m.min_order_size} USD`,
      });
    }
  }

  /** Throws unless the response is an accepted order; returns order_id when present. */
  private _accepted(res: unknown, what: string): { orderId: string | null } {
    const r = res as Record<string, unknown>;
    if (r.success === false || r.error) {
      throw new PerpError("EXCHANGE_ERROR", `${what}: ${String(r.error ?? "order rejected")}`, { exchange: "pacifica" });
    }
    const data = (r.data ?? r) as Record<string, unknown>;
    return { orderId: data.order_id != null ? String(data.order_id) : null };
  }

  /**
   * Poll history_by_id until a terminal state (or, for resting orders, the first
   * row) — otherwise finality "pending", never resubmit. The order is already
   * accepted, so a poll error is reported as pending (with the order id), not thrown.
   * `amount` = the placed size (a "filled" row without filled_amount filled all of it).
   * `finalFill` = the reported filled_amount of a terminal row (filled / cancelled /
   * rejected) when `wantTerminal` (IOC / market) — the venue-final fill for iocOutcomeOf;
   * null otherwise (no report, resting order, pending), never the placed amount.
   */
  private async _settle(
    orderId: string,
    amount: string,
    wantTerminal: boolean,
  ): Promise<{ result: Settled; finalFill: string | null }> {
    const pending = (why: string): { result: Settled; finalFill: null } => ({
      result: {
        status: "pending",
        filledSize: null,
        avgPrice: null,
        finality: "pending",
        remediation: `Order ${orderId} was accepted but ${why}; do NOT resubmit. Check: perp -e pacifica trade spot-orders / spot-balance`,
      },
      finalFill: null,
    });
    const done = (result: Settled, reported: string | null): { result: Settled; finalFill: string | null } =>
      ({ result, finalFill: wantTerminal ? reported : null });
    const attempts = wantTerminal ? 10 : 3;
    try {
      for (let i = 0; i < attempts; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const hist = await this._perp.sdk.getOrderHistoryById(Number(orderId));
        const latest = pacificaLatestHistoryRow((hist as Record<string, unknown>).data ?? hist, String(orderId));
        if (latest === null) continue;
        const st = String(latest.order_status);
        const filled = latest.filled_amount != null ? String(latest.filled_amount) : null;
        const avg = latest.average_filled_price != null ? String(latest.average_filled_price) : null;
        if (st === "filled") {
          // "filled" = the whole placed amount; filled_amount (when present) is authoritative.
          return done({ status: "filled", filledSize: filled !== null ? filled : amount, avgPrice: avg, finality: "final", remediation: null }, filled);
        }
        if (st === "rejected") return done({ status: "rejected", filledSize: filled, avgPrice: avg, finality: "final", remediation: null }, filled);
        if (st === "cancelled" || st === "canceled") {
          if (filled === null) return pending(`was cancelled without a reported filled_amount (a partial fill cannot be ruled out)`);
          return done({ status: Number(filled) > 0 ? "partial" : "cancelled", filledSize: filled, avgPrice: avg, finality: "final", remediation: null }, filled);
        }
        if (st === "open" && !wantTerminal) {
          if (filled === null) return done({ status: "open", filledSize: null, avgPrice: avg, finality: "final", remediation: null }, null);
          return done({ status: Number(filled) > 0 ? "partial" : "open", filledSize: filled, avgPrice: avg, finality: "final", remediation: null }, null);
        }
      }
    } catch (e) {
      return pending(`its status could not be read (${e instanceof Error ? e.message : String(e)})`);
    }
    // No terminal (or, for resting orders, no) history row within the poll window.
    return pending("its final state was not confirmed in time");
  }

  /** Assemble the result and remember its venue-final fill (when proven) for iocOutcomeOf. */
  private _withOutcome(
    base: Omit<SpotOrderResult, keyof Settled>,
    settled: { result: Settled; finalFill: string | null },
  ): SpotOrderResult {
    const out: SpotOrderResult = { ...base, ...settled.result };
    if (settled.finalFill !== null && settled.finalFill.trim() !== "" && Number.isFinite(Number(settled.finalFill))) {
      this._iocOutcomes.set(out, { filledSize: settled.finalFill.trim(), final: true });
    }
    return out;
  }

  /**
   * Venue-final outcome of a SpotOrderResult returned by spotMarketOrder / IOC
   * spotLimitOrder (IocOutcomeCapable): set only when the polled
   * history row was terminal and reported filled_amount. null for anything else.
   */
  iocOutcomeOf(raw: unknown): IocOutcome | null {
    if (raw === null || typeof raw !== "object") return null;
    return this._iocOutcomes.get(raw) ?? null;
  }

  async spotMarketOrder(symbol: string, side: "buy" | "sell", size: string, opts: { slippage: ResolvedSlippage }): Promise<SpotOrderResult> {
    // Pre-send (market resolution, mark read, notional check, signing setup): any failure here
    // is a definite "not sent" — never a retryable error that hides whether an order went out.
    let m: MarketInfo;
    let amount: string;
    const bps = opts.slippage.bps;
    try {
      await this.init();
      m = this._resolve(symbol);
      requirePositive(size, "size");
      amount = floorSize(size, m.lot_size);
      this._checkNotional(m, await this._mark(m.symbol), amount);
      this._perp.prepareSigning();
    } catch (e) {
      throw orderNotSent("pacifica", `spot market ${side} ${size} ${symbol}`, e);
    }
    if (side === "buy") warnSharedMarginOnce();
    const res = await this._perp.sdk.createMarketOrder(
      { symbol: m.symbol, amount, side: side === "buy" ? "bid" : "ask", reduce_only: false, slippage_percent: String(bps / 100) },
      this._perp.publicKey,
      this._perp.signer,
      null, // spot markets reject builder codes (Pacifica err 108) — never attached
    ).catch((e: unknown) => { throw pacificaCreateRejection(e, `spot market ${side} ${amount} ${m.symbol}`); });
    const { orderId } = this._accepted(res, `Spot market ${side} ${m.symbol}`);
    const base = { venue: "pacifica", symbol: `${m.base_asset}/${QUOTE}`, orderId, receivedToken: null, venueRaw: res };
    if (!orderId) {
      return { ...base, status: "pending", filledSize: null, avgPrice: null, finality: "pending", remediation: "Order accepted without order_id; do NOT resubmit. Check open orders and balances." };
    }
    return this._withOutcome(base, await this._settle(orderId, amount, true));
  }

  async spotLimitOrder(symbol: string, side: "buy" | "sell", price: string, size: string, opts?: { tif?: string }): Promise<SpotOrderResult> {
    let m: MarketInfo;
    let tif: ReturnType<typeof pacificaTif>;
    let px: string;
    let amount: string;
    try { // pre-send (see spotMarketOrder)
      await this.init();
      m = this._resolve(symbol);
      tif = pacificaTif(opts?.tif); // common mapping; FOK → CAPABILITY_UNSUPPORTED
      px = requireOnTick(price, m.tick_size);
      requirePositive(size, "size");
      amount = floorSize(size, m.lot_size);
      this._checkNotional(m, px, amount);
      this._perp.prepareSigning();
    } catch (e) {
      throw orderNotSent("pacifica", `spot limit ${side} ${size} ${symbol} @ ${price}`, e);
    }
    if (side === "buy") warnSharedMarginOnce();
    const res = await this._perp.sdk.createLimitOrder(
      { symbol: m.symbol, price: px, amount, side: side === "buy" ? "bid" : "ask", tif, reduce_only: false },
      this._perp.publicKey,
      this._perp.signer,
      null, // spot markets reject builder codes (Pacifica err 108) — never attached
    ).catch((e: unknown) => { throw pacificaCreateRejection(e, `spot limit ${tif} ${side} ${amount} ${m.symbol} @ ${px}`); });
    const { orderId } = this._accepted(res, `Spot limit ${side} ${m.symbol}`);
    const base = { venue: "pacifica", symbol: `${m.base_asset}/${QUOTE}`, orderId, receivedToken: null, venueRaw: res };
    if (!orderId) {
      return { ...base, status: "pending", filledSize: null, avgPrice: null, finality: "pending", remediation: "Order accepted without order_id; do NOT resubmit. Check open orders." };
    }
    // IOC resolves immediately (terminal); resting TIFs just report open/partial.
    return this._withOutcome(base, await this._settle(orderId, amount, tif === "IOC"));
  }

  async spotCancelOrder(symbol: string, orderId: string): Promise<SpotOrderResult> {
    await this.init();
    const m = this._resolve(symbol);
    this._perp.prepareSigning();
    const res = await this._perp.sdk.cancelOrder({ symbol: m.symbol, order_id: Number(orderId) }, this._perp.publicKey, this._perp.signer);
    this._accepted(res, `Spot cancel ${m.symbol} ${orderId}`);
    return {
      venue: "pacifica", symbol: `${m.base_asset}/${QUOTE}`, orderId, status: "cancelled",
      filledSize: null, avgPrice: null, finality: "final", receivedToken: null, remediation: null, venueRaw: res,
    };
  }

  async getSpotOpenOrders(symbol: string | null): Promise<Array<{ orderId: string; symbol: string; side: "buy" | "sell"; price: string; size: string; filled: string }>> {
    await this.init();
    const wire = symbol === null ? null : this._resolve(symbol).symbol;
    const spotWire = new Set([...this._spot.values()].map((m) => m.symbol));
    const orders = await this._perp.sdk.getOrders(this._perp.publicKey);
    return orders
      .map((o) => o as unknown as Record<string, unknown>)
      .filter((o) => spotWire.has(String(o.symbol)) && (wire === null || o.symbol === wire))
      .map((o) => {
        const w = String(o.symbol);
        return {
          orderId: String(o.order_id),
          symbol: `${w.split("-")[0]}/${QUOTE}`,
          side: o.side === "bid" ? ("buy" as const) : o.side === "ask" ? ("sell" as const) : (() => {
            throw new PerpError("EXCHANGE_ERROR", `Pacifica spot order ${String(o.order_id)} has an unrecognized side ${JSON.stringify(o.side ?? null)} (expected "bid" / "ask")`, {
              exchange: "pacifica", remediation: "Retry: perp spot orders -e pacifica",
            });
          })(),
          price: String(o.price),
          size: reqField(o, "initial_amount"),
          filled: reqField(o, "filled_amount"),
        };
      });
  }

  /**
   * Cancels spot orders one by one. The venue `cancel_all` with all_symbols
   * would also cancel perp orders, so it is never used here.
   */
  async spotCancelAllOrders(symbol: string | null): Promise<SpotOrderResult[]> {
    const open = await this.getSpotOpenOrders(symbol);
    const results: SpotOrderResult[] = [];
    for (const o of open) results.push(await this.spotCancelOrder(o.symbol, o.orderId));
    return results;
  }
}
