import type { ExchangeAdapter } from "../exchanges/index.js";

/**
 * Calculate the exact same size for both legs of an arb position,
 * respecting both exchanges' minimum order and size precision constraints.
 *
 * @returns size string that works for both exchanges, or null if not viable
 */
export function computeMatchedSize(
  sizeUsd: number,
  price: number,
  longExchange: string,
  shortExchange: string,
  opts?: { longSizeDecimals?: number; shortSizeDecimals?: number },
): { size: string; notional: number } | null {
  if (price <= 0) return null;

  const rawSize = sizeUsd / price;

  // Use explicitly provided decimals if available, else conservative defaults
  const szDecimals = Math.min(
    opts?.longSizeDecimals ?? getSizeDecimals(longExchange),
    opts?.shortSizeDecimals ?? getSizeDecimals(shortExchange),
  );

  // Round DOWN to the least precise exchange's decimals
  const factor = Math.pow(10, szDecimals);
  const roundedSize = Math.floor(rawSize * factor) / factor;
  if (roundedSize <= 0) return null;

  // Verify notional meets minimum for both exchanges
  const notional = roundedSize * price;
  const minNotional = Math.max(
    getMinNotional(longExchange),
    getMinNotional(shortExchange),
  );

  if (notional < minNotional) {
    // Try rounding UP instead
    const roundedUp = Math.ceil(rawSize * factor) / factor;
    const notionalUp = roundedUp * price;
    // Only round up if the increase is small (< 20% over requested)
    if (notionalUp <= sizeUsd * 1.2) {
      return { size: roundedUp.toFixed(szDecimals), notional: notionalUp };
    }
    return null; // Can't meet minimum
  }

  return { size: roundedSize.toFixed(szDecimals), notional };
}

/** Size decimal precision by exchange (conservative fallbacks — prefer explicit decimals via opts) */
function getSizeDecimals(exchange: string): number {
  switch (exchange.toLowerCase()) {
    case "hyperliquid": return 2; // HL perps range 0-5; 2 is safe middle ground
    case "lighter": return 2;
    case "pacifica": return 4;
    // Spot exchanges
    case "spot:hyperliquid": return 2;
    case "spot:lighter": return 2;
    default: return 2;
  }
}

/** Minimum notional (USD) per exchange */
function getMinNotional(exchange: string): number {
  switch (exchange.toLowerCase()) {
    case "hyperliquid": return 10;
    case "lighter": return 10;
    case "pacifica": return 1;
    case "spot:hyperliquid": return 10;
    case "spot:lighter": return 10;
    default: return 10;
  }
}

/**
 * Compute matched size for spot-perp arb.
 * Uses spot exchange's size decimals for the spot leg.
 */
export function computeSpotPerpMatchedSize(
  sizeUsd: number,
  price: number,
  spotExchange: string,
  perpExchange: string,
  spotSizeDecimals?: number,
): { size: string; notional: number } | null {
  if (price <= 0) return null;

  // If explicit spot decimals provided, use them; otherwise derive from exchange
  const spotDec = spotSizeDecimals ?? getSizeDecimals(`spot:${spotExchange}`);
  const perpDec = getSizeDecimals(perpExchange);
  const szDecimals = Math.min(spotDec, perpDec);

  const rawSize = sizeUsd / price;
  const factor = Math.pow(10, szDecimals);
  const roundedSize = Math.floor(rawSize * factor) / factor;
  if (roundedSize <= 0) return null;

  const notional = roundedSize * price;
  const minNotional = Math.max(
    getMinNotional(`spot:${spotExchange}`),
    getMinNotional(perpExchange),
  );

  if (notional < minNotional) {
    const roundedUp = Math.ceil(rawSize * factor) / factor;
    const notionalUp = roundedUp * price;
    if (notionalUp <= sizeUsd * 1.2) {
      return { size: roundedUp.toFixed(szDecimals), notional: notionalUp };
    }
    return null;
  }

  return { size: roundedSize.toFixed(szDecimals), notional };
}

/**
 * After both legs are submitted, verify actual fills match.
 * If there's a size mismatch, place a correction order on the larger side.
 *
 * @returns the corrected size, or null if already matched
 */
export async function reconcileArbFills(
  longAdapter: ExchangeAdapter,
  shortAdapter: ExchangeAdapter,
  symbol: string,
  log?: (msg: string) => void,
): Promise<{ matched: boolean; longSize: number; shortSize: number; correction?: string }> {
  const [longPositions, shortPositions] = await Promise.all([
    longAdapter.getPositions(),
    shortAdapter.getPositions(),
  ]);

  const longPos = longPositions.find(p =>
    p.symbol.replace("-PERP", "").toUpperCase() === symbol.toUpperCase() && p.side === "long"
  );
  const shortPos = shortPositions.find(p =>
    p.symbol.replace("-PERP", "").toUpperCase() === symbol.toUpperCase() && p.side === "short"
  );

  const longSize = longPos ? Math.abs(Number(longPos.size)) : 0;
  const shortSize = shortPos ? Math.abs(Number(shortPos.size)) : 0;

  if (longSize === 0 && shortSize === 0) {
    return { matched: true, longSize: 0, shortSize: 0 };
  }

  const diff = Math.abs(longSize - shortSize);
  const maxSize = Math.max(longSize, shortSize);
  const diffPct = maxSize > 0 ? (diff / maxSize) * 100 : 0;

  // Allow 1% tolerance (rounding differences)
  if (diffPct <= 1) {
    return { matched: true, longSize, shortSize };
  }

  log?.(`[ARB] Size mismatch: long ${longSize} vs short ${shortSize} (diff: ${diff.toFixed(4)}, ${diffPct.toFixed(1)}%)`);

  // Correct the larger side by reducing it
  const correctionSize = diff.toFixed(6);
  try {
    if (longSize > shortSize) {
      log?.(`[ARB] Correcting: sell ${correctionSize} ${symbol} on ${longAdapter.name} to match`);
      await longAdapter.marketOrder(symbol, "sell", correctionSize);
    } else {
      log?.(`[ARB] Correcting: buy ${correctionSize} ${symbol} on ${shortAdapter.name} to match`);
      await shortAdapter.marketOrder(symbol, "buy", correctionSize);
    }
    log?.(`[ARB] Sizes reconciled`);
    return { matched: true, longSize: Math.min(longSize, shortSize), shortSize: Math.min(longSize, shortSize), correction: correctionSize };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.(`[ARB] Correction failed: ${msg}`);
    return { matched: false, longSize, shortSize };
  }
}
