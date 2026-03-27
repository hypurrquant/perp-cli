/**
 * Shared utilities for funding arbitrage strategies (v1 + v2).
 * Extracted to keep individual strategy files under size limits.
 */

import type { StrategyContext } from "../strategy-types.js";
import type { ExchangeAdapter } from "../../exchanges/index.js";
import type { SpotAdapter } from "../../exchanges/spot-interface.js";
import { getFundingHours } from "../../funding.js";

// ── Type aliases ──

export type RateEntry = {
  rate: number;
  price: number;
  sizeDecimals?: number;
  maxLeverage?: number;
  fundingHours?: number;
};

export type RateMap = Map<string, Map<string, RateEntry>>;

// ── Adapter helpers ──

/** Build adapter map from primary adapter + extraAdapters in context state. */
export function buildAdapterMap(ctx: StrategyContext): Map<string, ExchangeAdapter> {
  const extraAdapters = ctx.state.get("extraAdapters") as Map<string, ExchangeAdapter> | undefined;
  const adapters = new Map<string, ExchangeAdapter>();
  adapters.set(ctx.adapter.name.toLowerCase(), ctx.adapter);
  if (extraAdapters) {
    for (const [name, a] of extraAdapters) adapters.set(name, a);
  }
  return adapters;
}

const spotAdapterCache = new Map<string, SpotAdapter>();

/** Get or create a spot adapter for a given exchange name + perp adapter instance. */
export async function getSpotAdapter(name: string, adapter: ExchangeAdapter): Promise<SpotAdapter | null> {
  const cached = spotAdapterCache.get(name);
  if (cached) return cached;
  try {
    let spot: SpotAdapter | null = null;
    if (name === "hyperliquid") {
      const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
      const { HyperliquidAdapter } = await import("../../exchanges/hyperliquid.js");
      if (adapter instanceof HyperliquidAdapter) {
        const instance = new HyperliquidSpotAdapter(adapter);
        await instance.init();
        spot = instance;
      }
    } else if (name === "lighter") {
      const { LighterSpotAdapter } = await import("../../exchanges/lighter-spot.js");
      const { LighterAdapter } = await import("../../exchanges/lighter.js");
      if (adapter instanceof LighterAdapter) {
        const instance = new LighterSpotAdapter(adapter);
        await instance.init();
        spot = instance;
      }
    }
    if (spot) spotAdapterCache.set(name, spot);
    return spot;
  } catch { /* not supported */ }
  return null;
}

// ── Transfer helpers ──

/** Transfer USDC from perp to spot account (exchange-specific). */
export async function transferUsdcToSpot(spotAdapter: SpotAdapter, exchangeName: string, amount: number): Promise<void> {
  if (exchangeName === "hyperliquid") {
    const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
    if (spotAdapter instanceof HyperliquidSpotAdapter) {
      await spotAdapter.transferUsdcToSpot(amount);
      return;
    }
  } else if (exchangeName === "lighter") {
    const { LighterSpotAdapter } = await import("../../exchanges/lighter-spot.js");
    if (spotAdapter instanceof LighterSpotAdapter) {
      await spotAdapter.transferUsdcToSpot(amount);
      return;
    }
  }
}

/** Transfer USDC from spot to perp account (exchange-specific). */
export async function transferUsdcToPerp(spotAdapter: SpotAdapter, exchangeName: string, amount: number): Promise<void> {
  if (exchangeName === "hyperliquid") {
    const { HyperliquidSpotAdapter } = await import("../../exchanges/hyperliquid-spot.js");
    if (spotAdapter instanceof HyperliquidSpotAdapter) {
      await spotAdapter.transferUsdcToPerp(amount);
      return;
    }
  } else if (exchangeName === "lighter") {
    const { LighterSpotAdapter } = await import("../../exchanges/lighter-spot.js");
    if (spotAdapter instanceof LighterSpotAdapter) {
      await spotAdapter.transferUsdcToPerp(amount);
      return;
    }
  }
}

// ── Rate / symbol helpers ──

/** Resolve perp symbol for a given base symbol on an exchange. */
export function getPerpSymbol(baseSymbol: string, _exchangeName: string): string {
  return baseSymbol.replace(/-PERP$/, "").toUpperCase();
}

/** Look up rate from ratesByExchange, trying symbol, symbol-PERP, and symbol without -PERP. */
export function findRate(ratesByExchange: RateMap, exchange: string, symbol: string): RateEntry | undefined {
  const map = ratesByExchange.get(exchange);
  if (!map) return undefined;
  const upper = symbol.toUpperCase();
  return map.get(upper) ?? map.get(upper + "-PERP") ?? map.get(upper.replace(/-PERP$/, ""));
}

/** Match a symbol against a target, accounting for -PERP suffix variations. */
export function matchSymbol(s: string, target: string): boolean {
  const u = s.toUpperCase();
  const t = target.toUpperCase();
  return u === t || u === t + "-PERP" || u.replace(/-PERP$/, "") === t;
}

/** Get a price estimate for a symbol from the perp adapter. */
export async function getPriceEstimate(perpAdapter: ExchangeAdapter, perpSymbol: string, fallbackSymbol: string): Promise<number> {
  try {
    const markets = await perpAdapter.getMarkets();
    const market = markets.find(m =>
      m.symbol.toUpperCase() === perpSymbol.toUpperCase() ||
      m.symbol.toUpperCase() === fallbackSymbol.toUpperCase() ||
      m.symbol.toUpperCase() === `${fallbackSymbol.toUpperCase()}-PERP`,
    );
    return market ? parseFloat(market.markPrice) : 0;
  } catch {
    return 0;
  }
}

// ── Position recovery ──

export interface RecoveredPosition {
  symbol: string;
  mode: "spot-perp" | "perp-perp";
  longExchange: string;
  shortExchange: string;
  size: string;
}

/** Recover arb positions from exchange state (perp-perp + spot-perp, same + cross exchange). */
export async function recoverArbPositions(
  adapters: Map<string, ExchangeAdapter>,
  log: (msg: string) => void,
): Promise<RecoveredPosition[]> {
  const positionsByExchange = new Map<string, { symbol: string; side: string; size: string }[]>();
  for (const [name, a] of adapters) {
    try {
      const positions = await a.getPositions();
      positionsByExchange.set(name, positions.map(p => ({ symbol: p.symbol.toUpperCase(), side: p.side, size: p.size })));
    } catch { /* skip */ }
  }

  const recovered: RecoveredPosition[] = [];
  const used = new Set<string>();

  // Cross-exchange perp-perp
  for (const [exA, posA] of positionsByExchange) {
    for (const pA of posA) {
      const keyA = `${exA}:${pA.symbol}`;
      if (used.has(keyA)) continue;
      for (const [exB, posB] of positionsByExchange) {
        if (exA === exB) continue;
        for (const pB of posB) {
          const keyB = `${exB}:${pB.symbol}`;
          if (used.has(keyB) || pA.symbol !== pB.symbol || pA.side === pB.side) continue;
          const longEx = pA.side === "long" ? exA : exB;
          const shortEx = pA.side === "short" ? exA : exB;
          recovered.push({ symbol: pA.symbol, mode: "perp-perp", longExchange: longEx, shortExchange: shortEx, size: pA.side === "long" ? pA.size : pB.size });
          used.add(keyA); used.add(keyB); break;
        }
        if (used.has(keyA)) break;
      }
    }
  }

  // Same-exchange spot-perp hedges
  for (const [name, a] of adapters) {
    try {
      const spotAdapter = await getSpotAdapter(name, a);
      if (!spotAdapter) continue;
      const bals = await spotAdapter.getSpotBalances();
      const nonUsdc = bals.filter(b => Number(b.total) > 0 && !b.token.toUpperCase().startsWith("USDC"));
      if (nonUsdc.length === 0) continue;
      for (const perp of positionsByExchange.get(name) ?? []) {
        const perpKey = `${name}:${perp.symbol}`;
        if (used.has(perpKey)) continue;
        const base = perp.symbol.replace(/-PERP$/, "").toUpperCase();
        const spotBal = nonUsdc.find(b => b.token.toUpperCase().replace(/-SPOT$/, "") === base);
        if (spotBal && perp.side === "short") {
          recovered.push({ symbol: base, mode: "spot-perp", longExchange: `${name}-spot`, shortExchange: name, size: perp.size });
          used.add(perpKey);
          log(`  Recovered spot-perp: ${base} ${name}-spot<>${name}`);
        }
      }
    } catch { /* no spot */ }
  }

  // Cross-exchange spot-perp
  for (const [spotExName, spotExAdapter] of adapters) {
    try {
      const spotAdapter = await getSpotAdapter(spotExName, spotExAdapter);
      if (!spotAdapter) continue;
      const bals = await spotAdapter.getSpotBalances();
      const nonUsdc = bals.filter(b => Number(b.total) > 0 && !b.token.toUpperCase().startsWith("USDC"));
      for (const bal of nonUsdc) {
        const base = bal.token.toUpperCase().replace(/-SPOT$/, "");
        for (const [perpExName, perpPositions] of positionsByExchange) {
          if (perpExName === spotExName) continue;
          for (const perp of perpPositions) {
            const perpKey = `${perpExName}:${perp.symbol}`;
            if (used.has(perpKey)) continue;
            if (perp.symbol.replace(/-PERP$/, "").toUpperCase() === base && perp.side === "short") {
              recovered.push({ symbol: base, mode: "spot-perp", longExchange: `${spotExName}-spot`, shortExchange: perpExName, size: perp.size });
              used.add(perpKey);
              log(`  Recovered cross spot-perp: ${base} ${spotExName}-spot<>${perpExName}`);
            }
          }
        }
      }
    } catch { /* no spot */ }
  }

  return recovered;
}

/** Fetch funding rates from an exchange adapter. */
export async function fetchRates(
  adapter: ExchangeAdapter,
  exchangeName: string,
): Promise<{ symbol: string; rate: number; price: number; sizeDecimals?: number; maxLeverage?: number; fundingHours?: number }[]> {
  try {
    const markets = await adapter.getMarkets();
    const withRates = markets.filter(m => m.fundingRate != null);

    // Bootstrap aster funding hours lazily
    if (exchangeName === "aster" && "getFundingHours" in adapter) {
      const aster = adapter as unknown as { getFundingHours(sym: string): Promise<number> };
      const uncached = withRates.filter(m => {
        const c = (adapter as any)?._fundingHoursCache?.get?.(m.symbol);
        return c === undefined;
      });
      for (const m of uncached.slice(0, 20)) {
        m.fundingHours = await aster.getFundingHours(m.symbol);
      }
    }

    return withRates.map(m => ({
      symbol: m.symbol,
      rate: parseFloat(m.fundingRate!),
      price: parseFloat(m.markPrice),
      sizeDecimals: m.sizeDecimals,
      maxLeverage: m.maxLeverage,
      fundingHours: m.fundingHours,
    }));
  } catch {
    return [];
  }
}
