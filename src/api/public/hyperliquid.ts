import { HYPERLIQUID_API_URL } from "./urls.js";
import { assertOk } from "./_http.js";
import { withCache, TTL_MARKET } from "../../cache.js";

// ── Types ──

interface HyperliquidAsset {
  symbol: string;
  funding: number;
  markPx: number;
}

// ── Internal ──

async function hlPost(type: string): Promise<unknown> {
  // SSOT rule #2: a non-2xx response is a real failure, not "no rows" — see assertOk.
  const res = await fetch(HYPERLIQUID_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type }),
  });
  await assertOk(res, `Hyperliquid info ${type}`);
  return res.json();
}

// ── Fetchers ──

export function fetchHyperliquidMeta(): Promise<HyperliquidAsset[]> {
  // SSOT rule #2: error must propagate. Row-level skipping handles missing
  // markPx / funding so a 0 doesn't reach downstream comparisons.
  return withCache("pub:hl:metaAndAssetCtxs", TTL_MARKET, async () => {
    const json = await hlPost("metaAndAssetCtxs") as unknown[];
    const universe = ((json[0] ?? {}) as Record<string, unknown>).universe ?? [];
    const ctxs = (json[1] ?? []) as Record<string, unknown>[];
    const out: HyperliquidAsset[] = [];
    (universe as Record<string, unknown>[]).forEach((asset, i) => {
      const ctx = (ctxs[i] ?? {}) as Record<string, unknown>;
      const symbol = String(asset.name ?? "");
      const funding = Number(ctx.funding);
      const markPx = Number(ctx.markPx);
      if (!symbol || !Number.isFinite(funding) || !Number.isFinite(markPx) || markPx <= 0) return;
      out.push({ symbol, funding, markPx });
    });
    return out;
  });
}

export function fetchHyperliquidMetaRaw(): Promise<unknown> {
  // SSOT rule #2: caller is responsible for error handling. Removed silent
  // `.catch(() => null)` so a network failure surfaces as a rejected Promise.
  // Callers should wrap with Promise.allSettled to keep multi-DEX comparisons
  // running when one DEX is down.
  return withCache("pub:hl:metaAndAssetCtxs:raw", TTL_MARKET, () =>
    hlPost("metaAndAssetCtxs"),
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
    // SSOT rule #2: skip rows missing a real funding rate; never publish 0.
    const funding = Number(ctx.funding);
    if (Number.isFinite(funding)) rates.set(sym, funding);
    const mp = Number(ctx.markPx);
    if (Number.isFinite(mp) && mp > 0) prices.set(sym, mp);
  });
  return { rates, prices };
}

export function fetchHyperliquidAllMidsRaw(): Promise<unknown> {
  // SSOT rule #2: error must propagate; see fetchHyperliquidMetaRaw.
  return withCache("pub:hl:allMids:raw", TTL_MARKET, () =>
    hlPost("allMids"),
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
