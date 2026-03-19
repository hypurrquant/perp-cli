import { HYPERLIQUID_API_URL } from "./urls.js";
import { withCache, TTL_MARKET } from "../../cache.js";

// ── Types ──

interface HyperliquidAsset {
  symbol: string;
  funding: number;
  markPx: number;
}

// ── Internal ──

function hlPost(type: string): Promise<unknown> {
  return fetch(HYPERLIQUID_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type }),
  }).then(r => r.json());
}

// ── Fetchers ──

export function fetchHyperliquidMeta(): Promise<HyperliquidAsset[]> {
  return withCache("pub:hl:metaAndAssetCtxs", TTL_MARKET, async () => {
    try {
      const json = await hlPost("metaAndAssetCtxs") as unknown[];
      const universe = ((json[0] ?? {}) as Record<string, unknown>).universe ?? [];
      const ctxs = (json[1] ?? []) as Record<string, unknown>[];
      return (universe as Record<string, unknown>[]).map((asset, i) => {
        const ctx = (ctxs[i] ?? {}) as Record<string, unknown>;
        return {
          symbol: String(asset.name ?? ""),
          funding: Number(ctx.funding ?? 0),
          markPx: Number(ctx.markPx ?? 0),
        };
      });
    } catch {
      return [];
    }
  });
}

export function fetchHyperliquidMetaRaw(): Promise<unknown> {
  return withCache("pub:hl:metaAndAssetCtxs:raw", TTL_MARKET, () =>
    hlPost("metaAndAssetCtxs").catch(() => null),
  );
}

export function parseHyperliquidMetaRaw(raw: unknown): { rates: Map<string, number>; prices: Map<string, number> } {
  const rates = new Map<string, number>();
  const prices = new Map<string, number>();
  if (!raw || !Array.isArray(raw)) return { rates, prices };
  const universe = (raw as Record<string, unknown>[])[0] as Record<string, unknown> | undefined;
  const ctxs = ((raw as unknown[])[1] ?? []) as Record<string, unknown>[];
  const assets = (universe?.universe ?? []) as Record<string, unknown>[];
  assets.forEach((a, i) => {
    const ctx = (ctxs[i] ?? {}) as Record<string, unknown>;
    const sym = String(a.name ?? "");
    if (!sym) return;
    rates.set(sym, Number(ctx.funding ?? 0));
    const mp = Number(ctx.markPx ?? 0);
    if (mp > 0) prices.set(sym, mp);
  });
  return { rates, prices };
}

export function fetchHyperliquidAllMidsRaw(): Promise<unknown> {
  return withCache("pub:hl:allMids:raw", TTL_MARKET, () =>
    hlPost("allMids").catch(() => null),
  );
}

// ── Health check ──

export async function pingHyperliquid(): Promise<{ ok: boolean; latencyMs: number; status: number }> {
  const start = Date.now();
  try {
    const res = await fetch(HYPERLIQUID_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "allMids" }),
    });
    return { ok: res.ok, latencyMs: Date.now() - start, status: res.status };
  } catch {
    return { ok: false, latencyMs: Date.now() - start, status: 0 };
  }
}
