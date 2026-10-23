import { PACIFICA_API_URL, PACIFICA_INFO_URL, sharedApiNetwork } from "./urls.js";
import { PerpError } from "../../errors.js";
import { isPacificaPerpetual } from "../../ws/pacifica-instrument.js";
import { assertOk } from "./_http.js";
import { withCache, TTL_MARKET } from "../../cache.js";
import { getNetworkConfig } from "../../pacifica/constants.js";
import { PACIFICA_COST_STANDARD, PACIFICA_READ_NEED, pacificaRateLimiter } from "../../pacifica/rate-limit.js";

// ── Types ──

interface PacificaAsset {
  symbol: string;
  funding: number;
  mark: number;
}

// ── Fetchers ──

const publicRate = () => pacificaRateLimiter(getNetworkConfig(sharedApiNetwork()).restUrl, undefined, "unsigned");

/**
 * Unauthenticated GET through the shared Pacifica credit limiter (the IP quota the adapter's
 * keyless client also spends): headers recorded, HTTP 429 → RATE_LIMITED. Never waits
 * (maxWaitMs 0): arb / dashboard callers settle venues with allSettled, so a nearly spent quota
 * fails this leg fast (RATE_LIMITED, nothing sent) instead of stalling the scan.
 */
async function pacificaPublicGet(url: string, what: string): Promise<Response> {
  const rate = publicRate();
  const ticket = await rate.acquire(what, { ...PACIFICA_READ_NEED, maxWaitMs: 0 });
  let res: Response;
  try {
    res = await fetch(url);
  } finally {
    ticket.release();
  }
  rate.observe(res);
  if (res.status === 429) throw rate.rateLimitedError(what, res, await res.text());
  return res;
}

const INFO_REMEDIATION = "The Pacifica /info response shape changed; retry, and report it if it persists";

/**
 * Symbols of GET /info rows with instrument_type "perpetual". `/info/prices` also lists spot
 * markets (SOL-USDC) — they must not reach arb / funding-arb as perps. A row without the field
 * cannot be classified → EXCHANGE_ERROR (same rule as the adapter's getMarkets).
 * Cached as a string[] (the file cache is JSON: a Set would come back as `{}`); the Set is built
 * outside withCache.
 */
async function fetchPacificaPerpSymbols(): Promise<Set<string>> {
  const symbols = await withCache(`pub:pac:${sharedApiNetwork()}:perps:list`, TTL_MARKET, async (): Promise<string[]> => {
    const res = await pacificaPublicGet(PACIFICA_INFO_URL, "GET /info");
    await assertOk(res, "Pacifica info");
    const json = (await res.json()) as unknown;
    if (json === null || typeof json !== "object" || !Array.isArray((json as Record<string, unknown>).data)) {
      throw new PerpError("EXCHANGE_ERROR", "Pacifica GET /info has no data array", { exchange: "pacifica", remediation: INFO_REMEDIATION });
    }
    const out: string[] = [];
    for (const m of (json as { data: unknown[] }).data) {
      if (m === null || typeof m !== "object" || Array.isArray(m)) {
        throw new PerpError("EXCHANGE_ERROR", `Pacifica GET /info row is not an object: ${JSON.stringify(m)}`, { exchange: "pacifica", remediation: INFO_REMEDIATION });
      }
      const row = m as Record<string, unknown>;
      if (typeof row.instrument_type !== "string") {
        throw new PerpError("EXCHANGE_ERROR", `Pacifica /info row ${String(row.symbol)} has no instrument_type`, { exchange: "pacifica", remediation: INFO_REMEDIATION });
      }
      if (isPacificaPerpetual(row)) out.push(String(row.symbol));
    }
    return out;
  });
  if (!Array.isArray(symbols)) {
    // A cache entry from before the string[] format (or a corrupt one) is not trusted.
    throw new PerpError("EXCHANGE_ERROR", "Pacifica /info perp list cache entry is not a list", { exchange: "pacifica", remediation: INFO_REMEDIATION });
  }
  return new Set(symbols);
}

/** `/info/prices` envelope reduced to perp rows (`{ data }`, the shape parsePacificaRaw reads). */
async function fetchPacificaPerpPrices(): Promise<{ data: Record<string, unknown>[] }> {
  const [res, perps] = await Promise.all([pacificaPublicGet(PACIFICA_API_URL, "GET /info/prices"), fetchPacificaPerpSymbols()]);
  await assertOk(res, "Pacifica prices");
  const json = await res.json();
  const data = (json as Record<string, unknown>).data ?? json;
  if (!Array.isArray(data)) return { data: [] };
  return { data: (data as Record<string, unknown>[]).filter((p) => perps.has(String(p.symbol))) };
}

export function fetchPacificaPrices(): Promise<PacificaAsset[]> {
  // SSOT rule #2: error must propagate. Row-level skipping is applied for
  // missing/invalid mark or funding so a 0 doesn't reach downstream paths.
  return withCache(`pub:pac:${sharedApiNetwork()}:prices:perp`, TTL_MARKET, async () => {
    const { data } = await fetchPacificaPerpPrices();
    const out: PacificaAsset[] = [];
    for (const p of data) {
      const symbol = String(p.symbol ?? "");
      const fundingRaw = p.funding; // last settled hourly rate (the market row / WS `funding`), not next_funding
      const funding = Number(fundingRaw);
      const mark = Number(p.mark);
      if (!symbol || fundingRaw === undefined || !Number.isFinite(funding) || !Number.isFinite(mark) || mark <= 0) {
        continue;
      }
      out.push({ symbol, funding, mark });
    }
    return out;
  });
}

export function fetchPacificaPricesRaw(): Promise<unknown> {
  // SSOT rule #2: caller is responsible for error handling. Removed silent
  // `.catch(() => null)` so a network failure surfaces as a rejected Promise.
  // Callers should wrap with Promise.allSettled to keep multi-DEX comparisons
  // running when one DEX is down. Non-2xx responses are also rejected so a
  // 5xx JSON body cannot fulfill as if it were valid data.
  // Perp rows only (spot SOL-USDC dropped via /info instrument_type).
  return withCache(`pub:pac:${sharedApiNetwork()}:prices:raw:perp`, TTL_MARKET, fetchPacificaPerpPrices);
}

export function parsePacificaRaw(raw: unknown): { rates: Map<string, number>; prices: Map<string, number> } {
  const rates = new Map<string, number>();
  const prices = new Map<string, number>();
  const data = (raw as Record<string, unknown>)?.data ?? raw;
  if (!Array.isArray(data)) return { rates, prices };
  for (const p of data as Record<string, unknown>[]) {
    const sym = String(p.symbol ?? "");
    if (!sym) continue;
    // SSOT rule #2: skip rows missing real funding/mark; never publish 0.
    const fundingRaw = p.funding; // last settled hourly rate (the market row / WS `funding`), not next_funding
    const fundingNumber = Number(fundingRaw);
    if (fundingRaw !== undefined && Number.isFinite(fundingNumber)) {
      rates.set(sym, fundingNumber);
    }
    const markCandidates = [Number(p.mark), Number(p.price)];
    const mark = markCandidates.find(v => Number.isFinite(v) && v > 0);
    if (mark !== undefined) prices.set(sym, mark);
  }
  return { rates, prices };
}

// ── Health check ──

export async function pingPacifica(): Promise<{ ok: boolean; latencyMs: number; status: number }> {
  const start = Date.now();
  // A health probe asks the venue itself (never throttled locally — an exhausted quota shows as the
  // venue's HTTP 429), but its cost and headers go through the shared limiter.
  const rate = publicRate();
  const ticket = rate.track(PACIFICA_COST_STANDARD);
  try {
    const res = await fetch(PACIFICA_API_URL);
    ticket.settle(res);
    return { ok: res.ok, latencyMs: Date.now() - start, status: res.status };
  } catch {
    ticket.release();
    return { ok: false, latencyMs: Date.now() - start, status: 0 };
  }
}
