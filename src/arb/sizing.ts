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
  opts?: {
    longSizeDecimals?: number; shortSizeDecimals?: number; lotSize?: number;
    /**
     * The pair's minimum order value in USD from the venues' published market info (the larger of
     * the two legs; 0 = neither venue publishes one). When given it is the ONLY minimum applied —
     * the per-venue table below is for callers that have no market info at hand.
     */
    minNotional?: number;
  },
): { size: string; notional: number } | null {
  // NaN / Infinity (e.g. a "-" mark parsed as a number) would size to "NaN": no size.
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(sizeUsd)) return null;

  const rawSize = sizeUsd / price;

  // Use explicitly provided decimals if available, else conservative defaults
  const szDecimals = Math.min(
    opts?.longSizeDecimals ?? getSizeDecimals(longExchange),
    opts?.shortSizeDecimals ?? getSizeDecimals(shortExchange),
  );

  // If lotSize is provided, round to nearest multiple of lotSize (floor). The 1e-9 guard keeps a
  // float quotient like 0.3 / 0.1 = 2.9999999999999996 from dropping a whole lot (as fillSizeString does).
  let roundedSize: number;
  if (opts?.lotSize && opts.lotSize > 0) {
    roundedSize = Math.floor(rawSize / opts.lotSize + 1e-9) * opts.lotSize;
  } else {
    // Round DOWN to the least precise exchange's decimals
    const factor = Math.pow(10, szDecimals);
    roundedSize = Math.floor(rawSize * factor) / factor;
  }
  if (roundedSize <= 0) return null;

  // Verify notional meets minimum for both exchanges
  const notional = roundedSize * price;
  const minNotional = opts?.minNotional !== undefined
    ? opts.minNotional
    : Math.max(getMinNotional(longExchange), getMinNotional(shortExchange));

  if (notional < minNotional) {
    // Try rounding UP instead
    let roundedUp: number;
    if (opts?.lotSize && opts.lotSize > 0) {
      roundedUp = Math.ceil(rawSize / opts.lotSize - 1e-9) * opts.lotSize;
    } else {
      const factor = Math.pow(10, szDecimals);
      roundedUp = Math.ceil(rawSize * factor) / factor;
    }
    const notionalUp = roundedUp * price;
    // Round up only if it both (a) clears the venue minimum and (b) does not
    // overshoot the requested size by more than 20%. Pre-fix this checked only
    // (b), so a ceil that still fell short of minNotional was returned and then
    // rejected by the venue — SSOT Rule #2: fail honestly with null instead.
    if (notionalUp >= minNotional && notionalUp <= sizeUsd * 1.2) {
      return sized(roundedUp, price, szDecimals, opts?.lotSize);
    }
    return null; // Can't meet minimum within tolerance
  }

  return sized(roundedSize, price, szDecimals, opts?.lotSize);
}

/**
 * The size string sent to both venues and the notional OF THAT STRING (never of the unformatted
 * float). With a lot, the lot's own decimals are used — formatting a 0.0001-lot size with the
 * venue default (e.g. 2) used to round 0.0157 UP to "0.02" or a 0.004 size to "0.00". A size that
 * formats to zero is not viable (null), never a zero-size order.
 */
function sized(size: number, price: number, szDecimals: number, lotSize?: number): { size: string; notional: number } | null {
  const str = formatSize(size, szDecimals, lotSize);
  const n = Number(str);
  if (!(n > 0)) return null;
  return { size: str, notional: n * price };
}

function formatSize(size: number, szDecimals: number, lotSize?: number): string {
  if (lotSize && lotSize > 0) return size.toFixed(decimalsOfLot(lotSize)); // whole lots (≥1) → 0 decimals; 2.5 → 1
  return size.toFixed(szDecimals);
}

/** Decimal places of a lot size (0.0001 → 4, 0.5 → 1, 1e-7 → 7). */
function decimalsOfLot(lot: number): number {
  const s = lot.toString();
  const exp = /e-(\d+)$/.exec(s);
  if (exp) return Number(exp[1]) + (s.split("e")[0].split(".")[1]?.length ?? 0);
  return s.includes(".") ? s.split(".")[1].length : 0;
}

/** Size decimal precision by exchange (conservative fallbacks — prefer explicit decimals via opts) */
function getSizeDecimals(exchange: string): number {
  switch (exchange.toLowerCase()) {
    case "hyperliquid": return 2; // HL perps range 0-5; 2 is safe middle ground
    case "lighter": return 2;
    case "pacifica": return 4;
    case "aster": return 0; // aster symbols mostly use integers; explicit sizeDecimals overrides this
    // Spot exchanges
    case "spot:hyperliquid": return 2;
    case "spot:lighter": return 2;
    default: return 0; // conservative: integers when unknown
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
  perpSizeDecimals?: number,
): { size: string; notional: number } | null {
  // NaN / Infinity (e.g. a "-" mark parsed as a number) would size to "NaN": no size.
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(sizeUsd)) return null;

  // If explicit decimals provided, use them; otherwise derive from exchange
  const spotDec = spotSizeDecimals ?? getSizeDecimals(`spot:${spotExchange}`);
  const perpDec = perpSizeDecimals ?? getSizeDecimals(perpExchange);
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
    // Same minNotional re-check as computeMatchedSize (SSOT Rule #2): a ceil
    // that is still under the venue minimum must fail, not be returned.
    if (notionalUp >= minNotional && notionalUp <= sizeUsd * 1.2) {
      return { size: roundedUp.toFixed(szDecimals), notional: notionalUp };
    }
    return null;
  }

  return { size: roundedSize.toFixed(szDecimals), notional };
}
