/**
 * Hyperliquid Outcome Adapter (HIP-4).
 *
 * Composes with HyperliquidAdapter for signing. Asset id encoding:
 *   100,000,000 + (10 * outcome + side)
 *
 * Coin name conventions:
 *   - l2Book/candle/allMids: `#<encoding>` (e.g., `#10`)
 *   - spotClearinghouseState balance: `+<encoding>` (e.g., `+10`)
 *
 * Outcome trades draw collateral from the spot USDH balance (token index 360),
 * NOT USDC. Min order notional: $10 USDH.
 */

import { PerpError } from "../errors.js";
import type {
  OutcomeAdapter,
  OutcomeMarketInfo,
  OutcomeOrderbook,
  OutcomePosition,
  OutcomeSideInfo,
  OutcomeView,
  OutcomeViewSide,
  OutcomeViewUnderlying,
} from "./outcome-interface.js";
import type { HyperliquidAdapter } from "./hyperliquid.js";

const OUTCOME_ASSET_OFFSET = 100_000_000;
const MIN_ORDER_USDH = 10;
/** Outcome encoding `10*outcome + side` keeps side as the units digit, so
 *  side must be 0..9 to avoid overflow into the next outcome's id space. */
const MAX_SIDE = 9;
/** Asset id offset spans `[100_000_000, 200_000_000)`, so encoding < 100M. */
const MAX_ENCODING = 99_999_999;

type RawOutcomeMeta = {
  outcomes: Array<{
    outcome: number;
    name: string;
    description: string;
    sideSpecs: Array<{ name: string }>;
  }>;
  questions: unknown[];
};

export class HyperliquidOutcomeAdapter implements OutcomeAdapter {
  readonly name = "hyperliquid";
  private _hl: HyperliquidAdapter;
  private _outcomeMeta: RawOutcomeMeta | null = null;
  private _initialized = false;

  constructor(hlAdapter: HyperliquidAdapter) {
    this._hl = hlAdapter;
  }

  async init(): Promise<void> {
    if (this._initialized) return;
    await this._loadOutcomeMeta();
    this._initialized = true;
  }

  static encoding(outcome: number, side: number): number {
    return 10 * outcome + side;
  }

  static assetId(outcome: number, side: number): number {
    return OUTCOME_ASSET_OFFSET + HyperliquidOutcomeAdapter.encoding(outcome, side);
  }

  static mintCoin(outcome: number, side: number): string {
    return `#${HyperliquidOutcomeAdapter.encoding(outcome, side)}`;
  }

  static balanceCoin(outcome: number, side: number): string {
    return `+${HyperliquidOutcomeAdapter.encoding(outcome, side)}`;
  }

  /**
   * Decode a balance coin name like `+10` back to (outcome, side).
   * Returns null if the name does not match the outcome scheme.
   */
  static decodeBalanceCoin(coin: string): { outcome: number; side: number } | null {
    if (!coin.startsWith("+")) return null;
    const enc = Number(coin.slice(1));
    if (!Number.isFinite(enc) || enc < 0) return null;
    return { outcome: Math.floor(enc / 10), side: enc % 10 };
  }

  static parseDescription(description: string): {
    class?: string;
    underlying?: string;
    expiryMs?: number;
    targetPrice?: number;
    period?: string;
  } {
    const parts = description.split("|");
    const out: { class?: string; underlying?: string; expiryMs?: number; targetPrice?: number; period?: string } = {};
    for (const p of parts) {
      const idx = p.indexOf(":");
      if (idx < 0) continue;
      const key = p.slice(0, idx).trim();
      const val = p.slice(idx + 1).trim();
      if (key === "class") out.class = val;
      else if (key === "underlying") out.underlying = val;
      else if (key === "expiry") out.expiryMs = HyperliquidOutcomeAdapter._parseExpiry(val);
      else if (key === "targetPrice") out.targetPrice = Number(val);
      else if (key === "period") out.period = val;
    }
    return out;
  }

  /**
   * Compute the underlying mark-price view (gap / inTheMoney) for an outcome
   * from a parsed description and the live allMids map.
   *
   * Pure helper — extracted from getView so the settlement-status logic is
   * directly unit-testable.
   *
   * - HL `allMids` keys perps by bare symbol (e.g. "BTC"). HIP-3 perps use
   *   "@dexIdx:SYMBOL" but those aren't referenced in HIP-4 outcomes yet.
   * - For `class:priceBinary` the convention is Yes = "underlying >= target".
   *   When `class` is missing or non-binary, `inTheMoney` stays null rather
   *   than guessing (Rule #2 — no silent classification fallback).
   * - Returns null when there is no underlying field to look up.
   */
  static _computeUnderlying(
    parsed: { class?: string; underlying?: string; targetPrice?: number },
    allMids: Record<string, string>,
  ): OutcomeViewUnderlying | null {
    if (!parsed.underlying) return null;
    const sym = parsed.underlying.toUpperCase();
    const markPrice = allMids[sym];
    const target = parsed.targetPrice;
    let gap: number | undefined;
    let gapPct: number | undefined;
    let inTheMoney: "yes" | "no" | null = null;
    if (markPrice !== undefined && target !== undefined) {
      gap = Number(markPrice) - target;
      gapPct = (gap / target) * 100;
      if (parsed.class === "priceBinary" && Number.isFinite(gap)) {
        inTheMoney = gap >= 0 ? "yes" : "no";
      }
    }
    return {
      symbol: sym,
      source: sym,
      markPrice,
      targetPrice: target,
      gap,
      gapPct,
      inTheMoney,
    };
  }

  /**
   * Sum of `impliedProb` across sides — for fair binary markets the sum
   * should converge to ~1.0. Deviation hints at arbitrage or stale mids.
   *
   * Returns undefined when any side is missing impliedProb OR when any
   * impliedProb is non-finite (NaN, Infinity). This means "we don't have a
   * trustworthy view of the symmetry right now" rather than emitting NaN
   * downstream (Rule #2 — no silent garbage propagation).
   */
  static _computeMidSum(sides: Array<{ impliedProb?: number }>): number | undefined {
    if (sides.length === 0) return undefined;
    for (const s of sides) {
      if (s.impliedProb === undefined) return undefined;
      if (!Number.isFinite(s.impliedProb)) return undefined;
    }
    return sides.reduce((acc, s) => acc + (s.impliedProb ?? 0), 0);
  }

  /**
   * Compute the time-status pair (`serverTime`, `msToExpiry`) for a view.
   * Pure helper — takes `nowMs` as an argument so callers can inject a
   * deterministic clock under test.
   *
   * `msToExpiry` is the raw signed delta `expiryMs - nowMs`:
   *   positive  = unexpired
   *   zero      = at expiry
   *   negative  = already settled (caller decides UX)
   *   undefined = unknown expiry
   *
   * Does NOT clamp negatives or treat them as "expired" — that
   * classification is the caller's job (Rule #2 — no silent classification
   * fallback in a low-level helper).
   */
  static _computeTimeStatus(expiryMs: number | undefined, nowMs: number): {
    serverTime: number;
    msToExpiry?: number;
  } {
    return {
      serverTime: nowMs,
      msToExpiry: expiryMs !== undefined ? expiryMs - nowMs : undefined,
    };
  }

  /**
   * Pure arithmetic gate for the (outcome, side) pair.
   *
   * Rejects NaN / non-integer / negative values immediately so the
   * encoding formula `10 * outcome + side` never produces a garbage
   * asset id silently. Does NOT consult outcomeMeta — that lookup is in
   * the instance-level `_validateOutcomeSide` which composes this
   * helper with the live registry check.
   *
   * Boundary: outcome=9_999_999, side=9 → encoding=99_999_999 = MAX_ENCODING (valid).
   *           outcome=10_000_000, side=0 → encoding=100_000_000 > MAX_ENCODING (rejected).
   */
  static _assertOutcomeRange(outcome: number, side: number): void {
    if (!Number.isInteger(outcome) || outcome < 0) {
      throw new PerpError("INVALID_PARAMS", `Outcome id must be a non-negative integer, got: ${outcome}`, { exchange: "hyperliquid" });
    }
    if (!Number.isInteger(side) || side < 0 || side > MAX_SIDE) {
      throw new PerpError("INVALID_PARAMS", `Side must be an integer 0..${MAX_SIDE} (encoding scheme is single digit), got: ${side}`, { exchange: "hyperliquid" });
    }
    const encoding = HyperliquidOutcomeAdapter.encoding(outcome, side);
    if (encoding > MAX_ENCODING) {
      throw new PerpError("INVALID_PARAMS", `Encoding ${encoding} overflows the outcome asset block (max ${MAX_ENCODING})`, { exchange: "hyperliquid" });
    }
  }

  /**
   * Trim a raw orderbook to `depth` levels and surface best bid/ask.
   *
   * Throws (rather than silently coercing) when:
   *  - `book.bids` or `book.asks` is missing/non-array (venue payload
   *    malformed — Rule #2: don't fabricate an empty book)
   *  - `depth` is not a non-negative integer (NaN, negative, Infinity,
   *    fractional are all caller bugs that previously silently produced
   *    `slice(0, NaN) === []` or `slice(0, -1)` = "all but last")
   */
  static _trimBook(
    book: { bids: [string, string][]; asks: [string, string][] } | { bids: unknown; asks: unknown } | null | undefined,
    depth: number,
  ): { bids: [string, string][]; asks: [string, string][]; bestBid?: string; bestAsk?: string } {
    if (!book || !Array.isArray((book as { bids?: unknown }).bids) || !Array.isArray((book as { asks?: unknown }).asks)) {
      throw new PerpError("EXCHANGE_ERROR", "Outcome orderbook response is missing bids/asks array", { exchange: "hyperliquid" });
    }
    if (!Number.isInteger(depth) || depth < 0) {
      throw new PerpError("INVALID_PARAMS", `Depth must be a non-negative integer, got: ${depth}`, { exchange: "hyperliquid" });
    }
    const bids = (book as { bids: [string, string][] }).bids.slice(0, depth);
    const asks = (book as { asks: [string, string][] }).asks.slice(0, depth);
    return {
      bids,
      asks,
      bestBid: bids[0]?.[0],
      bestAsk: asks[0]?.[0],
    };
  }

  /** Parse "20260504-0600" → ms-epoch (UTC). Returns undefined for malformed. */
  private static _parseExpiry(s: string): number | undefined {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(s);
    if (!m) return undefined;
    const [, y, mo, d, h, mi] = m;
    const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
    return Number.isFinite(ms) ? ms : undefined;
  }

  private async _loadOutcomeMeta(): Promise<void> {
    const meta = await this._infoPost({ type: "outcomeMeta" }) as RawOutcomeMeta | { error?: string };
    if (!meta || typeof meta !== "object" || !("outcomes" in meta)) {
      throw new PerpError(
        "EXCHANGE_ERROR",
        `Hyperliquid outcomeMeta returned unexpected shape: ${JSON.stringify(meta).slice(0, 200)}`,
        { exchange: "hyperliquid" },
      );
    }
    this._outcomeMeta = meta as RawOutcomeMeta;
  }

  async getMarkets(): Promise<OutcomeMarketInfo[]> {
    await this.init();
    if (!this._outcomeMeta) return [];
    const allMids = await this._infoPost({ type: "allMids" }) as Record<string, string>;

    return this._outcomeMeta.outcomes.map((o) => {
      const parsed = HyperliquidOutcomeAdapter.parseDescription(o.description);
      const sides: OutcomeSideInfo[] = o.sideSpecs.map((s, i) => {
        const encoding = HyperliquidOutcomeAdapter.encoding(o.outcome, i);
        return {
          side: i,
          name: s.name,
          encoding,
          assetId: OUTCOME_ASSET_OFFSET + encoding,
          mid: allMids[`#${encoding}`],
        };
      });
      return {
        outcome: o.outcome,
        name: o.name,
        description: o.description,
        ...parsed,
        sides,
      };
    });
  }

  async getPositions(): Promise<OutcomePosition[]> {
    await this.init();
    // Bypass HL adapter's cached spot state — outcome positions change at
    // every fill, and the spot cache TTL would surface stale data.
    const userAddress = await this._resolveUserAddress();
    const state = await this._infoPost({ type: "spotClearinghouseState", user: userAddress }) as { balances?: Array<Record<string, unknown>> };
    const balances = (state?.balances ?? []) as Array<Record<string, unknown>>;
    const allMidsPromise = this._infoPost({ type: "allMids" }) as Promise<Record<string, string>>;

    const positions: OutcomePosition[] = [];
    for (const b of balances) {
      const coin = String(b.coin ?? "");
      const decoded = HyperliquidOutcomeAdapter.decodeBalanceCoin(coin);
      if (!decoded) continue;
      const total = String(b.total ?? "0");
      if (Number(total) === 0) continue;

      const sideName = this._lookupSideName(decoded.outcome, decoded.side);
      positions.push({
        outcome: decoded.outcome,
        side: decoded.side,
        sideName,
        encoding: HyperliquidOutcomeAdapter.encoding(decoded.outcome, decoded.side),
        size: total,
        entryNotional: String(b.entryNtl ?? "0"),
      });
    }
    if (positions.length === 0) return [];

    const allMids = await allMidsPromise;
    for (const p of positions) {
      const mark = allMids[`#${p.encoding}`];
      if (mark) {
        p.markPrice = mark;
        p.unrealizedPnl = String(Number(mark) * Number(p.size) - Number(p.entryNotional));
      }
    }
    return positions;
  }

  /**
   * Assemble a combined view of one outcome: all sides' books in parallel,
   * the underlying mark price (HL perp mid for `description.underlying`),
   * gap vs targetPrice, time-to-expiry, and per-side implied probability.
   *
   * Outcome markets have a symmetric (Yes / No) structure where the prices
   * sum to ~$1; this view exposes both sides in a single round-trip and
   * also surfaces the directional context for binary markets — what BTC
   * mark price would settle the contract right now.
   */
  async getView(outcome: number, depth: number = 10): Promise<OutcomeView> {
    await this.init();
    const meta = this._outcomeMeta?.outcomes.find((o) => o.outcome === outcome);
    if (!meta) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Unknown outcome id: ${outcome}`, {
        exchange: "hyperliquid",
        remediation: "Run: perp outcome list",
      });
    }
    const parsed = HyperliquidOutcomeAdapter.parseDescription(meta.description);

    // Fetch books for every side in parallel + allMids once for mids and
    // the underlying symbol's mark price.
    const allMidsPromise = this._infoPost({ type: "allMids" }) as Promise<Record<string, string>>;
    const bookPromises = meta.sideSpecs.map((_, i) => this.getOrderbook(outcome, i));
    const [allMids, ...books] = await Promise.all([allMidsPromise, ...bookPromises]);

    // Trim each book to `depth` levels and compute best bid/ask + implied prob.
    const sides: OutcomeViewSide[] = meta.sideSpecs.map((spec, i) => {
      const encoding = HyperliquidOutcomeAdapter.encoding(outcome, i);
      const trimmed = HyperliquidOutcomeAdapter._trimBook(books[i], depth);
      const mid = allMids[`#${encoding}`];
      return {
        side: i,
        name: spec.name,
        encoding,
        assetId: OUTCOME_ASSET_OFFSET + encoding,
        mid,
        bids: trimmed.bids,
        asks: trimmed.asks,
        bestBid: trimmed.bestBid,
        bestAsk: trimmed.bestAsk,
        impliedProb: mid !== undefined ? Number(mid) : undefined,
      };
    });

    const midSum = HyperliquidOutcomeAdapter._computeMidSum(sides);

    // Underlying: HL perp mid for the parsed underlying symbol.
    const underlying = HyperliquidOutcomeAdapter._computeUnderlying(parsed, allMids);

    const { serverTime, msToExpiry } = HyperliquidOutcomeAdapter._computeTimeStatus(
      parsed.expiryMs,
      Date.now(),
    );

    return {
      outcome,
      name: meta.name,
      description: meta.description,
      class: parsed.class,
      expiryMs: parsed.expiryMs,
      msToExpiry,
      period: parsed.period,
      underlying,
      sides,
      midSum,
      serverTime,
    };
  }

  async getOrderbook(outcome: number, side: number): Promise<OutcomeOrderbook> {
    await this.init();
    this._validateOutcomeSide(outcome, side);
    const coin = HyperliquidOutcomeAdapter.mintCoin(outcome, side);
    const book = await this._infoPost({ type: "l2Book", coin }) as {
      coin?: string; time?: number; levels?: [Array<Record<string, string>>, Array<Record<string, string>>];
    };
    // Rule #2: do NOT fabricate an empty book when the venue payload is
    // malformed. Caller (typically getView) has its own gates downstream
    // but a missing `levels` here is a venue contract break, not "no
    // resting orders".
    if (
      !book ||
      !Array.isArray((book as { levels?: unknown }).levels) ||
      !Array.isArray((book as { levels: unknown[] }).levels[0]) ||
      !Array.isArray((book as { levels: unknown[] }).levels[1])
    ) {
      throw new PerpError(
        "EXCHANGE_ERROR",
        `Hyperliquid l2Book returned malformed payload for ${coin}: missing or non-array \`levels\``,
        { exchange: "hyperliquid" },
      );
    }
    const levels = book.levels!;
    return {
      outcome,
      side,
      time: Number(book.time ?? 0),
      bids: levels[0].map((l) => [String(l.px ?? "0"), String(l.sz ?? "0")] as [string, string]),
      asks: levels[1].map((l) => [String(l.px ?? "0"), String(l.sz ?? "0")] as [string, string]),
    };
  }

  async placeOrder(opts: {
    outcome: number; side: number;
    isBuy: boolean;
    price: string; size: string;
    tif?: "Gtc" | "Ioc" | "Alo";
  }): Promise<unknown> {
    await this.init();
    this._validateOutcomeSide(opts.outcome, opts.side);

    const notional = Number(opts.price) * Number(opts.size);
    if (!Number.isFinite(notional) || notional < MIN_ORDER_USDH) {
      throw new PerpError(
        "INVALID_PARAMS",
        `Outcome order notional must be at least ${MIN_ORDER_USDH} USDH (got price=${opts.price} * size=${opts.size} = ${notional.toFixed(4)})`,
        {
          exchange: "hyperliquid",
          remediation: `Increase price or size so price*size >= ${MIN_ORDER_USDH}`,
        },
      );
    }

    // Pre-check USDH balance (only on buy — sell consumes outcome shares).
    if (opts.isBuy) {
      const usdh = await this._getUsdhAvailable();
      if (usdh < notional) {
        throw new PerpError(
          "INSUFFICIENT_BALANCE",
          `Insufficient USDH for outcome buy: need ${notional.toFixed(4)} USDH, have ${usdh.toFixed(4)}`,
          {
            exchange: "hyperliquid",
            remediation: "Bridge USDC→USDH on Hyperliquid (perp funds bridge) or buy USDH on HL spot",
          },
        );
      }
    }

    const assetId = HyperliquidOutcomeAdapter.assetId(opts.outcome, opts.side);
    const tif = opts.tif ?? "Gtc";
    const action = {
      type: "order",
      orders: [{
        a: assetId,
        b: opts.isBuy,
        p: this._trimZeros(opts.price),
        s: this._trimZeros(opts.size),
        r: false,
        t: { limit: { tif } },
      }],
      grouping: "na",
    };
    const result = await this._hl.exchangeAction(action);
    HyperliquidOutcomeAdapter._assertOrderStatusOk(result);
    await this._invalidateAccountCache();
    return result;
  }

  async cancelOrder(outcome: number, side: number, oid: number): Promise<unknown> {
    await this.init();
    this._validateOutcomeSide(outcome, side);
    const assetId = HyperliquidOutcomeAdapter.assetId(outcome, side);
    const result = await this._hl.exchangeAction({
      type: "cancel",
      cancels: [{ a: assetId, o: oid }],
    });
    HyperliquidOutcomeAdapter._assertCancelStatusOk(result);
    await this._invalidateAccountCache();
    return result;
  }

  /**
   * Throw if the venue rejected the order embedded inside a top-level
   * `status:"ok"` response (HL pattern). Returns silently for resting/filled.
   */
  static _assertOrderStatusOk(result: unknown): void {
    const r = result as { status?: string; response?: { type?: string; data?: { statuses?: Array<Record<string, unknown>> } } };
    const statuses = r?.response?.data?.statuses;
    if (!Array.isArray(statuses) || statuses.length === 0) {
      throw new PerpError("EXCHANGE_ERROR", `Outcome order: empty status response (${JSON.stringify(result).slice(0, 200)})`, { exchange: "hyperliquid" });
    }
    const st = statuses[0];
    if (st.error) {
      throw new PerpError("EXCHANGE_ERROR", `Outcome order rejected: ${String(st.error)}`, { exchange: "hyperliquid" });
    }
  }

  static _assertCancelStatusOk(result: unknown): void {
    const r = result as { status?: string; response?: { type?: string; data?: { statuses?: unknown[] } } };
    const statuses = r?.response?.data?.statuses;
    if (!Array.isArray(statuses) || statuses.length === 0) {
      throw new PerpError("EXCHANGE_ERROR", `Outcome cancel: empty status response`, { exchange: "hyperliquid" });
    }
    const st = statuses[0];
    if (typeof st === "object" && st !== null && "error" in st) {
      throw new PerpError("EXCHANGE_ERROR", `Outcome cancel rejected: ${String((st as { error: unknown }).error)}`, { exchange: "hyperliquid" });
    }
  }

  async getOpenOrders(): Promise<unknown[]> {
    await this.init();
    const orders = await this._hl.getOpenOrders();
    return orders.filter((o) => typeof o.symbol === "string" && o.symbol.startsWith("#"));
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private _lookupSideName(outcome: number, side: number): string {
    const o = this._outcomeMeta?.outcomes.find((x) => x.outcome === outcome);
    return o?.sideSpecs[side]?.name ?? `side${side}`;
  }

  private _validateOutcomeSide(outcome: number, side: number): void {
    HyperliquidOutcomeAdapter._assertOutcomeRange(outcome, side);
    const o = this._outcomeMeta?.outcomes.find((x) => x.outcome === outcome);
    if (!o) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Unknown outcome id: ${outcome}`, {
        exchange: "hyperliquid",
        remediation: "Run: perp outcome list",
      });
    }
    if (side >= o.sideSpecs.length) {
      throw new PerpError("INVALID_PARAMS", `Invalid side ${side} for outcome ${outcome} (valid: 0..${o.sideSpecs.length - 1})`, {
        exchange: "hyperliquid",
        remediation: "Run: perp outcome list",
      });
    }
  }

  /**
   * Resolve the master EVM address for spot-clearinghouse queries.
   * `HyperliquidAdapter._address` is populated only when a master/PK signer
   * is configured. Agent-only setups (no master pk in OWS) leave it empty
   * even though the agent meta knows the user's EVM address. Fall through
   * to the agent registry rather than treating empty as zero balance —
   * Rule #2: no silent fallback.
   */
  private async _resolveUserAddress(): Promise<string> {
    if (this._hl.address) return this._hl.address;
    const { getAgent } = await import("../agent-wallet/store.js");
    const agent = getAgent("hyperliquid");
    if (agent?.userEvmAddress) return agent.userEvmAddress;
    throw new PerpError(
      "NO_SIGNER_AVAILABLE",
      "Hyperliquid user address not resolved — cannot query spot/USDH state",
      { exchange: "hyperliquid", remediation: "Configure an OWS master wallet or register an HL agent" },
    );
  }

  private async _getUsdhAvailable(): Promise<number> {
    const userAddress = await this._resolveUserAddress();
    const state = await this._infoPost({ type: "spotClearinghouseState", user: userAddress }) as { balances?: Array<Record<string, unknown>> };
    const balances = state?.balances ?? [];
    const usdh = balances.find((b) => String(b.coin) === "USDH");
    if (!usdh) return 0;
    return Math.max(0, Number(usdh.total ?? 0) - Number(usdh.hold ?? 0));
  }

  private async _invalidateAccountCache(): Promise<void> {
    try {
      const { invalidateCache } = await import("../cache.js");
      invalidateCache("acct");
    } catch {
      // Cache module unavailable in test contexts; ignore.
    }
  }

  private _trimZeros(s: string): string {
    if (!s.includes(".")) return s;
    const n = s.replace(/\.?0+$/, "");
    return n === "" || n === "-0" ? "0" : n;
  }

  private async _infoPost(body: Record<string, unknown>): Promise<unknown> {
    const baseUrl = this._hl.isTestnet
      ? "https://api.hyperliquid-testnet.xyz"
      : "https://api.hyperliquid.xyz";
    const res = await fetch(`${baseUrl}/info`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new PerpError(
        "EXCHANGE_ERROR",
        `Hyperliquid /info HTTP ${res.status} for ${JSON.stringify(body)}`,
        { exchange: "hyperliquid", status: res.status },
      );
    }
    return res.json();
  }
}
