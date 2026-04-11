/**
 * HIP-3 dynamic market screener.
 *
 * Pure scoring + orchestration + market rotation logic extracted from the
 * `outcome/src/hip3_mm.py` research bot. The core MM lesson from that bot:
 * don't statically pick a symbol to market-make — screen the entire HIP-3
 * universe periodically, rank by spread × sqrt(depth), and rotate MM
 * activity into whichever markets currently clear a minimum quality bar.
 *
 * This module has no side effects of its own: candidate discovery and book
 * fetching are injected so unit tests can run without network access and so
 * multiple MM strategies can share the same screener.
 *
 * Future self-BBO detection (Option B #3) is prepared via `MmHooks.isSelfOrder`.
 * A downstream MM strategy implements the hook by tracking its own open
 * orders and returning `true` when (coin, side, price) matches one of them,
 * so the strategy can skip requoting against its own BBO. The rotation
 * machine itself never calls the hook — it exists as a stable signature
 * for quoting-layer code.
 */

import type { ExchangeAdapter } from "../../exchanges/interface.js";

// ────────────────────────────────────────────────────────────────────
//  Types
// ────────────────────────────────────────────────────────────────────

/** A HIP-3 market discovered via `allPerpMetas`. No book yet. */
export interface Hip3Candidate {
  /** Full symbol as returned by the API, e.g. "xyz:TSLA". */
  coin: string;
  /** Base name without dex prefix, e.g. "TSLA". */
  base: string;
  /** Dex prefix, e.g. "xyz". */
  dex: string;
  /** Latest mid from discovery. */
  markPrice: number;
  /** Size decimals for order precision. */
  szDecimals: number;
  /** Max leverage advertised by the dex. */
  maxLeverage: number;
  /**
   * Open interest in base units (not USD) as reported by `metaAndAssetCtxs`.
   * Multiply by `markPrice` for USD notional. Used by future HIP-3 MM code
   * for liquidity-aware position sizing.
   */
  openInterest: number;
  /** 24-hour USD volume from `metaAndAssetCtxs.dayNtlVlm`. */
  volume24h: number;
}

/** Pure scoring result for a single orderbook snapshot. */
export interface BookScore {
  /** Spread in basis points of the mid: (ba - bb) / mid * 10000 */
  spreadBps: number;
  /** USD notional across top-5 levels on both sides. */
  depthUsd: number;
  /** Combined quality: spreadBps * sqrt(max(depthUsd, 1)). */
  score: number;
  /** (bb + ba) / 2. */
  mid: number;
  /** Top-of-book bid. */
  bestBid: number;
  /** Top-of-book ask. */
  bestAsk: number;
}

/** A candidate plus its current score. */
export interface ScoredMarket extends Hip3Candidate {
  score: BookScore;
}

/** Orderbook snapshot shape (matches `ExchangeAdapter.getOrderbook`). */
export type OrderbookSide = Array<[string, string]>;
export interface OrderbookSnapshot {
  bids: OrderbookSide;
  asks: OrderbookSide;
}

/** Screener configuration knobs. */
export interface ScreenerConfig {
  /** Floor for `spreadBps` — any market tighter than this is dropped. */
  minSpreadBps: number;
  /** Floor for `depthUsd` — any book thinner than this is dropped. */
  minDepthUsd: number;
  /** Floor for `score` — belt-and-suspenders on top of spread/depth filters. */
  minScore: number;
  /**
   * Maximum number of `fetchBook` calls per screen pass. This is the
   * rate-limit budget — `hip3_mm.py` learned the hard way that blowing
   * past this triggers Hyperliquid's 1200 weight/min cap.
   */
  maxL2Calls: number;
  /** Optional whitelist of dex prefixes (e.g. ["xyz", "flx"]). */
  dexes?: string[];
  /** Optional whitelist of bare coin names (e.g. ["TSLA", "NVDA"]). */
  coins?: string[];
  /**
   * Per-symbol `minSpreadBps` overrides, keyed by full coin string
   * (e.g. "vntl:SPACEX"). Values tighter than the global floor are
   * ignored — overrides can only raise, never lower.
   */
  symbolMinSpreadBps?: Record<string, number>;
}

export const DEFAULT_SCREENER_CONFIG: ScreenerConfig = {
  minSpreadBps: 10,
  minDepthUsd: 1000,
  // 500 matches the production floor in outcome/src/hip3_mm.py (MIN_SCORE).
  // Callers that want every market that passes spread/depth can lower it to 0.
  minScore: 500,
  maxL2Calls: 20,
};

/**
 * Merge caller overrides onto the default screener config. Caller-provided
 * values always win, so passing `{ minSpreadBps: 25 }` yields a config with
 * `minSpreadBps: 25` while leaving the rest at defaults.
 */
export function resolveScreenerConfig(overrides?: Partial<ScreenerConfig>): ScreenerConfig {
  return { ...DEFAULT_SCREENER_CONFIG, ...(overrides ?? {}) };
}

// ────────────────────────────────────────────────────────────────────
//  Pure scoring
// ────────────────────────────────────────────────────────────────────

/**
 * Score an orderbook snapshot. Pure — no network, no I/O.
 *
 * Returns `null` when the book is unusable:
 *   - empty bids or asks
 *   - crossed book (bestAsk <= bestBid)
 *   - any parsed price or size is non-finite
 *
 * The formula matches `outcome/src/hip3_mm.py::compute_book_score`:
 *   spreadBps = (bestAsk - bestBid) / mid * 10000
 *   depthUsd  = Σ top5(px * sz) on both sides
 *   score     = spreadBps * sqrt(max(depthUsd, 1))
 */
export function computeBookScore(bids: OrderbookSide, asks: OrderbookSide): BookScore | null {
  if (!Array.isArray(bids) || !Array.isArray(asks)) return null;
  if (bids.length === 0 || asks.length === 0) return null;

  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  if (!Number.isFinite(bestBid) || !Number.isFinite(bestAsk)) return null;
  if (bestAsk <= bestBid) return null;

  const mid = (bestBid + bestAsk) / 2;
  if (!(mid > 0)) return null;

  const spreadBps = ((bestAsk - bestBid) / mid) * 10_000;

  const sumLevels = (side: OrderbookSide): number => {
    let total = 0;
    const top = side.slice(0, 5);
    for (const [pxStr, szStr] of top) {
      const px = Number(pxStr);
      const sz = Number(szStr);
      if (!Number.isFinite(px) || !Number.isFinite(sz)) continue;
      total += px * sz;
    }
    return total;
  };

  const depthUsd = sumLevels(bids) + sumLevels(asks);
  const score = spreadBps * Math.sqrt(Math.max(depthUsd, 1));

  return { spreadBps, depthUsd, score, mid, bestBid, bestAsk };
}

// ────────────────────────────────────────────────────────────────────
//  Orchestrator
// ────────────────────────────────────────────────────────────────────

/** Callback that returns a book for a given coin, or null to skip. */
export type FetchBook = (coin: string) => Promise<OrderbookSnapshot | null>;

export interface ScreenInput {
  candidates: Hip3Candidate[];
  fetchBook: FetchBook;
  config?: Partial<ScreenerConfig>;
}

/**
 * Run one screening pass over `candidates`. For each candidate (subject to
 * the `maxL2Calls` budget) fetches a book via the injected `fetchBook`
 * callback, scores it, filters against the config thresholds, and returns
 * the survivors sorted by score descending.
 *
 * This function does NOT throw on individual book failures — a rejected
 * `fetchBook` promise for one coin is logged against the budget (to match
 * outcome's rate-limit accounting) but does not abort the rest of the pass.
 */
export async function screenHip3Markets(input: ScreenInput): Promise<ScoredMarket[]> {
  const config = resolveScreenerConfig(input.config);
  if (input.candidates.length === 0) return [];

  // Apply dex + coin filters first so they don't eat into the call budget.
  const dexSet = config.dexes ? new Set(config.dexes) : null;
  const coinSet = config.coins ? new Set(config.coins) : null;
  const eligible = input.candidates.filter((c) => {
    if (dexSet && !dexSet.has(c.dex)) return false;
    if (coinSet && !coinSet.has(c.base)) return false;
    return true;
  });

  const budget = Math.max(0, Math.floor(config.maxL2Calls));
  const toScore = eligible.slice(0, budget);

  const scored: ScoredMarket[] = [];
  for (const candidate of toScore) {
    let book: OrderbookSnapshot | null = null;
    try {
      book = await input.fetchBook(candidate.coin);
    } catch {
      // Rate-limit / network hiccup — skip this coin, don't kill the pass.
      continue;
    }
    if (!book) continue;

    const score = computeBookScore(book.bids, book.asks);
    if (!score) continue;
    if (score.depthUsd < config.minDepthUsd) continue;
    if (score.score < config.minScore) continue;

    const globalFloor = config.minSpreadBps;
    const symbolOverride = config.symbolMinSpreadBps?.[candidate.coin] ?? 0;
    const effectiveFloor = Math.max(globalFloor, symbolOverride);
    if (score.spreadBps < effectiveFloor) continue;

    scored.push({ ...candidate, score });
  }

  scored.sort((a, b) => b.score.score - a.score.score);
  return scored;
}

// ────────────────────────────────────────────────────────────────────
//  Discovery + adapter glue
// ────────────────────────────────────────────────────────────────────

/**
 * Discover all HIP-3 candidates by reusing `src/dex-asset-map.ts`'s
 * `fetchAllDexAssets` helper. Filters out the native `hl` dex because
 * this screener is HIP-3 specific.
 *
 * Note: `fetchAllDexAssets` already drops rows with non-positive
 * `markPrice`, so we don't re-filter for that here.
 */
export async function discoverHip3Candidates(): Promise<Hip3Candidate[]> {
  const { fetchAllDexAssets } = await import("../../dex-asset-map.js");
  const assets = await fetchAllDexAssets();
  return assets
    .filter((a) => a.dex !== "hl")
    .map((a) => ({
      coin: a.raw,
      base: a.base,
      dex: a.dex,
      markPrice: a.markPrice,
      szDecimals: a.szDecimals,
      maxLeverage: a.maxLeverage,
      openInterest: a.openInterest,
      volume24h: a.volume24h,
    }));
}

/**
 * Convenience wrapper: discover + screen using an `ExchangeAdapter`.
 *
 * The adapter's `getOrderbook` is used as `fetchBook`, so this works
 * transparently on any exchange that implements the interface — though
 * in practice only the Hyperliquid adapter's HIP-3 routing is meaningful.
 */
export async function screenWithAdapter(
  adapter: ExchangeAdapter,
  config?: Partial<ScreenerConfig>,
): Promise<ScoredMarket[]> {
  const candidates = await discoverHip3Candidates();
  const fetchBook: FetchBook = async (coin) => {
    try {
      return await adapter.getOrderbook(coin);
    } catch {
      return null;
    }
  };
  return screenHip3Markets({ candidates, fetchBook, config });
}

// ────────────────────────────────────────────────────────────────────
//  MM rotation state machine + hooks
// ────────────────────────────────────────────────────────────────────

/**
 * Optional hooks that an MM strategy can register with the rotation.
 *
 * `isSelfOrder` is the scaffold for Option B #3 (self-BBO detection) — a
 * future MM strategy implements it by consulting its own open-order book.
 * It is unused inside the rotation today; it exists so strategy code
 * downstream of the screener can rely on a stable signature.
 */
export interface MmHooks {
  /** Called once when a market enters the active set. */
  onMarketEntered?: (market: ScoredMarket) => void;
  /** Called once when a market leaves the active set. */
  onMarketExited?: (coin: string) => void;
  /**
   * (Future Option B #3) Return true when (coin, side, price) matches
   * one of the strategy's own open orders, so the caller can skip
   * requoting against its own BBO.
   */
  isSelfOrder?: (coin: string, side: "buy" | "sell", price: number) => boolean;
}

export interface RotationConfig {
  /** Maximum concurrent active markets. */
  maxActive: number;
  /**
   * A market is dropped when its current score falls below
   * `entryScore * exitScoreRatio`. 0.5 means "half the original quality".
   */
  exitScoreRatio: number;
}

export const DEFAULT_ROTATION_CONFIG: RotationConfig = {
  maxActive: 5,
  exitScoreRatio: 0.5,
};

interface ActiveEntry {
  market: ScoredMarket;
  /** Score at the time of entry — anchor for degradation exit. */
  entryScore: number;
}

export interface RotationDelta {
  entered: ScoredMarket[];
  exited: string[];
}

/**
 * Stateful rotation machine. `update()` is idempotent and returns only
 * the delta against the previous state, so the caller can react to exactly
 * the changes without diffing themselves.
 *
 * The machine is pure apart from the hook invocations — no network, no
 * adapter calls. That keeps it trivially unit-testable and lets multiple
 * strategies share the same decision logic.
 */
export class Hip3MarketRotation {
  private readonly config: RotationConfig;
  private readonly hooks: MmHooks;
  private readonly active: Map<string, ActiveEntry> = new Map();

  constructor(config?: Partial<RotationConfig>, hooks?: MmHooks) {
    this.config = { ...DEFAULT_ROTATION_CONFIG, ...(config ?? {}) };
    this.hooks = hooks ?? {};
  }

  /** Snapshot of currently active coin names. */
  activeMarkets(): string[] {
    return Array.from(this.active.keys());
  }

  /**
   * Accept a freshly scored market list from the screener and compute
   * which markets should enter vs exit the active set.
   *
   * Algorithm:
   *   1. Exit: any active market that (a) disappeared from `scored` or
   *      (b) dropped below its `entryScore * exitScoreRatio` is exited.
   *   2. Refill: among remaining `scored` entries not already active,
   *      take the top (maxActive - active.size) by score as new entries.
   *   3. Replacement: if `active` is still at `maxActive` but a higher-
   *      scoring new candidate is available, evict the lowest-scoring
   *      active entry in its favour.
   */
  update(scored: ScoredMarket[]): RotationDelta {
    const delta: RotationDelta = { entered: [], exited: [] };
    const scoredByCoin = new Map(scored.map((s) => [s.coin, s]));
    // Coins exited during THIS pass are never re-entered in the same pass —
    // that prevents a freshly-degraded market from being immediately added
    // back by the refill loop, and prevents a replaced market from bouncing.
    const excludedThisPass = new Set<string>();

    // ── Step 1: exit degraded or disappeared markets ──
    for (const [coin, entry] of Array.from(this.active.entries())) {
      const current = scoredByCoin.get(coin);
      if (!current) {
        this.active.delete(coin);
        delta.exited.push(coin);
        excludedThisPass.add(coin);
        this.hooks.onMarketExited?.(coin);
        continue;
      }
      if (current.score.score < entry.entryScore * this.config.exitScoreRatio) {
        this.active.delete(coin);
        delta.exited.push(coin);
        excludedThisPass.add(coin);
        this.hooks.onMarketExited?.(coin);
      }
    }

    // ── Step 2 + 3: refill + replacement ──
    const sortedCandidates = [...scored].sort((a, b) => b.score.score - a.score.score);
    for (const candidate of sortedCandidates) {
      if (this.active.has(candidate.coin)) continue;
      if (excludedThisPass.has(candidate.coin)) continue;

      if (this.active.size < this.config.maxActive) {
        this.enter(candidate, delta);
        continue;
      }

      // Find the weakest active entry — if this candidate beats it, swap.
      let weakestCoin: string | null = null;
      let weakestScore = Infinity;
      for (const [coin, entry] of this.active) {
        if (entry.market.score.score < weakestScore) {
          weakestScore = entry.market.score.score;
          weakestCoin = coin;
        }
      }
      if (weakestCoin && candidate.score.score > weakestScore) {
        this.active.delete(weakestCoin);
        delta.exited.push(weakestCoin);
        excludedThisPass.add(weakestCoin);
        this.hooks.onMarketExited?.(weakestCoin);
        this.enter(candidate, delta);
      }
    }

    // Keep cached scores fresh for markets that stayed active but whose
    // current score changed. This lets the *next* update() apply
    // degradation using the latest seen score rather than the entry score.
    for (const [coin, entry] of this.active) {
      const current = scoredByCoin.get(coin);
      if (current) entry.market = current;
    }

    return delta;
  }

  private enter(market: ScoredMarket, delta: RotationDelta): void {
    this.active.set(market.coin, { market, entryScore: market.score.score });
    delta.entered.push(market);
    this.hooks.onMarketEntered?.(market);
  }
}
