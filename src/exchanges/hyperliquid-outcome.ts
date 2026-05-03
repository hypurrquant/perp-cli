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
} from "./outcome-interface.js";
import type { HyperliquidAdapter } from "./hyperliquid.js";

const OUTCOME_ASSET_OFFSET = 100_000_000;
const MIN_ORDER_USDH = 10;

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
    const userAddress = this._hl.address;
    if (!userAddress) {
      throw new PerpError("NO_SIGNER_AVAILABLE", "Hyperliquid address not resolved — cannot fetch outcome positions in read-only mode", { exchange: "hyperliquid" });
    }
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

  async getOrderbook(outcome: number, side: number): Promise<OutcomeOrderbook> {
    await this.init();
    this._validateOutcomeSide(outcome, side);
    const coin = HyperliquidOutcomeAdapter.mintCoin(outcome, side);
    const book = await this._infoPost({ type: "l2Book", coin }) as {
      coin?: string; time?: number; levels?: [Array<Record<string, string>>, Array<Record<string, string>>];
    };
    const levels = book?.levels ?? [[], []];
    return {
      outcome,
      side,
      time: Number(book?.time ?? 0),
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
    return this._hl.exchangeAction(action);
  }

  async cancelOrder(outcome: number, side: number, oid: number): Promise<unknown> {
    await this.init();
    this._validateOutcomeSide(outcome, side);
    const assetId = HyperliquidOutcomeAdapter.assetId(outcome, side);
    return this._hl.exchangeAction({
      type: "cancel",
      cancels: [{ a: assetId, o: oid }],
    });
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
    const o = this._outcomeMeta?.outcomes.find((x) => x.outcome === outcome);
    if (!o) {
      throw new PerpError("SYMBOL_NOT_FOUND", `Unknown outcome id: ${outcome}`, {
        exchange: "hyperliquid",
        remediation: "Run: perp outcome list",
      });
    }
    if (side < 0 || side >= o.sideSpecs.length) {
      throw new PerpError("INVALID_PARAMS", `Invalid side ${side} for outcome ${outcome} (valid: 0..${o.sideSpecs.length - 1})`, {
        exchange: "hyperliquid",
        remediation: "Run: perp outcome list",
      });
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
