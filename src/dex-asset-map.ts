/**
 * HIP-3 Deployed Dex Asset Mapping.
 *
 * Maps assets across Hyperliquid deployed dexes to their common underlying.
 * Assets with the same base name (e.g., xyz:TSLA and flx:TSLA) are auto-matched.
 * Known aliases (e.g., CL = OIL = crude oil) are explicitly mapped.
 *
 * Verified mismatches (NOT the same asset despite similar names):
 *   USAR ($17) ≠ US500 ($666) ≠ USA500 ($6646)
 *   SEMI ($319) ≠ SEMIS ($381)
 *   USOIL ($113) ≠ CL ($93)
 *   GOLDJM ≠ GOLD (different products)
 *   SILVERJM ≠ SILVER
 *   URNM ≠ URANIUM
 */

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

/** Known aliases: different symbol → same underlying */
const ALIASES: Record<string, string> = {
  // Crude oil (WTI benchmark)
  "CL": "CRUDE_OIL_WTI",
  "OIL": "CRUDE_OIL_WTI",
  // Meme token denominations
  "kPEPE": "1000PEPE",
  "1000PEPE": "1000PEPE",
  "kSHIB": "1000SHIB",
  "kBONK": "1000BONK",
  "kFLOKI": "1000FLOKI",
  "kLUNC": "1000LUNC",
  "kNEIRO": "1000NEIRO",
  "kDOGS": "1000DOGS",
};

/** Verified price-mismatch pairs — NEVER match these */
const BLACKLIST_PAIRS = new Set([
  "USAR:US500", "USAR:USA500", "US500:USA500",
  "SEMI:SEMIS",
  "USOIL:CL", "USOIL:OIL",
  "GOLDJM:GOLD", "GLDMINE:GOLD",
  "SILVERJM:SILVER",
  "URNM:URANIUM",
  "NUCLEAR:ENERGY", "NUCLEAR:USENERGY",
]);

function isBlacklisted(a: string, b: string): boolean {
  const key1 = `${a}:${b}`;
  const key2 = `${b}:${a}`;
  return BLACKLIST_PAIRS.has(key1) || BLACKLIST_PAIRS.has(key2);
}

export interface DexAsset {
  /** Full symbol as returned by API (e.g., "xyz:TSLA") */
  raw: string;
  /** Base name without prefix (e.g., "TSLA") */
  base: string;
  /** Dex name (e.g., "xyz") or "hl" for native */
  dex: string;
  /** Mark price */
  markPrice: number;
  /** Raw funding rate */
  fundingRate: number;
  /** Max leverage */
  maxLeverage: number;
  /** Open interest (USD notional) */
  openInterest: number;
  /** 24h volume (USD) */
  volume24h: number;
  /** Size decimals for order precision */
  szDecimals: number;
}

export interface DexArbPair {
  /** Canonical underlying name */
  underlying: string;
  /** Long side (lower funding rate) */
  long: DexAsset;
  /** Short side (higher funding rate) */
  short: DexAsset;
  /** Annualized funding spread % */
  annualSpread: number;
  /** Mark price difference % between the two sides */
  priceGapPct: number;
  /** Min OI (USD) across both legs — practical cap on position size */
  minOiUsd: number;
  /** Min 24h volume (USD) across both legs — liquidity indicator */
  minVolume24hUsd: number;
  /** Viability grade: "A" (>$1M OI), "B" (>$100K), "C" (>$10K), "D" (<$10K) */
  viability: "A" | "B" | "C" | "D";
}

async function hlInfoPost(body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(HL_INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL API error: ${res.status}`);
  return res.json();
}

/**
 * Fetch all assets from all Hyperliquid dexes (native + deployed).
 */
export async function fetchAllDexAssets(): Promise<DexAsset[]> {
  const { withCache, TTL_MARKET } = await import("./cache.js");
  return withCache("pub:hl:allDexAssets", TTL_MARKET, () => _fetchAllDexAssetsLive());
}

async function _fetchAllDexAssetsLive(): Promise<DexAsset[]> {
  const allMetas = await hlInfoPost({ type: "allPerpMetas" }) as Record<string, unknown>[];
  if (!Array.isArray(allMetas)) return [];

  // Collect dex names (index 0 = native "hl", rest = deployed dexes)
  const dexNames: string[] = [];
  for (let i = 0; i < allMetas.length; i++) {
    const universe = (allMetas[i].universe ?? []) as { name: string }[];
    if (universe.length === 0) { dexNames.push(""); continue; }
    if (i === 0) { dexNames.push("hl"); continue; }
    const first = universe[0].name;
    const colon = first.indexOf(":");
    dexNames.push(colon > 0 ? first.slice(0, colon) : `dex-${i}`);
  }

  // Fetch metaAndAssetCtxs for each dex in batches of 3 to avoid 429 rate limits
  const BATCH_SIZE = 3;
  const allAssets: DexAsset[] = [];

  const tasks = dexNames.map((dex, i) => ({ dex, i })).filter(t => t.dex !== "");

  for (let b = 0; b < tasks.length; b += BATCH_SIZE) {
    const batch = tasks.slice(b, b + BATCH_SIZE);
    const results = await Promise.all(batch.map(async ({ dex, i }) => {
      try {
        const body = i === 0
          ? { type: "metaAndAssetCtxs" }
          : { type: "metaAndAssetCtxs", dex };
        const data = await hlInfoPost(body) as [
          { universe: { name: string; maxLeverage: number; szDecimals: number; isDelisted?: boolean }[] },
          { markPx: string; funding: string; openInterest: string; dayNtlVlm: string }[],
        ];
        const universe = data[0]?.universe ?? [];
        const ctxs = data[1] ?? [];
        return universe
          .map((asset, j): DexAsset | null => {
            if (asset.isDelisted) return null;
            const ctx = ctxs[j];
            const raw = asset.name;
            const colon = raw.indexOf(":");
            return {
              raw,
              base: colon > 0 ? raw.slice(colon + 1) : raw,
              dex,
              markPrice: Number(ctx?.markPx ?? 0),
              fundingRate: Number(ctx?.funding ?? 0),
              maxLeverage: asset.maxLeverage,
              openInterest: Number(ctx?.openInterest ?? 0),
              volume24h: Number(ctx?.dayNtlVlm ?? 0),
              szDecimals: asset.szDecimals,
            };
          })
          .filter((a): a is DexAsset => a !== null && a.markPrice > 0);
      } catch {
        return [];
      }
    }));
    allAssets.push(...results.flat());
  }

  return allAssets;
}

/**
 * Normalize a base name to its canonical underlying.
 */
function toCanonical(base: string): string {
  return ALIASES[base] ?? base;
}

/**
 * Find all cross-dex arb pairs.
 *
 * Groups assets by canonical underlying, then finds pairs across different dexes
 * with a funding rate spread. Validates by checking mark price similarity (< maxGapPct).
 */
export function findDexArbPairs(
  assets: DexAsset[],
  opts: {
    /** Max price gap % to consider same underlying (default: 5%) */
    maxPriceGapPct?: number;
    /** Min annual spread % to include (default: 0 = all) */
    minAnnualSpread?: number;
    /** Include native HL perps in comparison? (default: true) */
    includeNative?: boolean;
  } = {},
): DexArbPair[] {
  const maxGap = opts.maxPriceGapPct ?? 5;
  const minSpread = opts.minAnnualSpread ?? 0;
  const includeNative = opts.includeNative ?? true;

  // Group by canonical underlying
  const groups = new Map<string, DexAsset[]>();
  for (const asset of assets) {
    if (!includeNative && asset.dex === "hl") continue;
    const canonical = toCanonical(asset.base);
    if (!groups.has(canonical)) groups.set(canonical, []);
    groups.get(canonical)!.push(asset);
  }

  const pairs: DexArbPair[] = [];

  for (const [underlying, group] of groups) {
    if (group.length < 2) continue;

    // Compare all combinations of different dexes
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (a.dex === b.dex) continue; // same dex, skip

        // Blacklist check
        if (isBlacklisted(a.base, b.base)) continue;

        // Price gap validation
        const avgPrice = (a.markPrice + b.markPrice) / 2;
        const gapPct = Math.abs(a.markPrice - b.markPrice) / avgPrice * 100;
        if (gapPct > maxGap) continue;

        // All dexes (including HIP-3 deployed) settle funding every 1h
        const hourlyA = a.fundingRate;
        const hourlyB = b.fundingRate;
        const annualSpread = Math.abs(hourlyA - hourlyB) * 8760 * 100;

        if (annualSpread < minSpread) continue;

        // Long the lower-funding side, short the higher-funding side
        const [long, short] = hourlyA < hourlyB ? [a, b] : [b, a];

        // Liquidity metrics: OI in USD, min across both legs
        const longOiUsd = long.openInterest * long.markPrice;
        const shortOiUsd = short.openInterest * short.markPrice;
        const minOiUsd = Math.min(longOiUsd, shortOiUsd);
        const minVolume24hUsd = Math.min(long.volume24h, short.volume24h);
        const viability: "A" | "B" | "C" | "D" =
          minOiUsd >= 1_000_000 ? "A" :
          minOiUsd >= 100_000 ? "B" :
          minOiUsd >= 10_000 ? "C" : "D";

        pairs.push({ underlying, long, short, annualSpread, priceGapPct: gapPct, minOiUsd, minVolume24hUsd, viability });
      }
    }
  }

  return pairs.sort((a, b) => b.annualSpread - a.annualSpread);
}

/**
 * Fetch and return arb opportunities across all HIP-3 dexes.
 * Single convenience function for CLI commands.
 */
export async function scanDexArb(opts?: {
  minAnnualSpread?: number;
  maxPriceGapPct?: number;
  includeNative?: boolean;
}): Promise<DexArbPair[]> {
  const assets = await fetchAllDexAssets();
  return findDexArbPairs(assets, opts);
}
