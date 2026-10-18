/**
 * Pacifica credit rate limit, read from the venue's own response headers.
 *
 * docs.pacifica.fi api-documentation/api/rate-limits (read 2026-10-19): credit-based, rolling
 * 60 s window; 100 credits / 60 s per unidentified IP, 300 with a valid API Config Key (more for
 * higher fee tiers); standard request 1, cancel 0.5, heavy GET 3-12 (1-4 with a key). Exhausted →
 * HTTP 429. "All credit values are multiplied by 10 to support fractional costs":
 *
 *   ratelimit: "credits";r=1200;t=32        r = remaining (×10), t = seconds until refresh
 *   ratelimit-policy: "credits";q=1250;w=60 q = quota per window (×10), w = window seconds
 *
 * Live mainnet GET /info/prices (2026-10-19, no key): `ratelimit: "credits";r=980;t=22`,
 * `ratelimit-policy: "credits";q=1000;w=60`. Values below stay in those ×10 units.
 *
 * CloudFront caches some GETs (/info: `x-cache: Hit from cloudfront`, `age: 16`): a cache hit
 * replays the headers of whoever filled the cache (live: q=3000, a keyed caller) — not this
 * caller's quota, so a hit carries no information.
 *
 * Scope: one state per REST base URL (mainnet / testnet) and credential tier (no key = IP quota;
 * an API Config Key has its own). Process-local: other perp-cli processes (CLI + MCP + bots) on the
 * same IP spend the same quota unseen, so a 429 can still happen — it is then surfaced as
 * RATE_LIMITED, never retried here.
 */

import { createHash } from "crypto";
import { PerpError } from "../errors.js";

/** One parsed `ratelimit` (+ optional `ratelimit-policy`) observation, in credits ×10. */
export interface PacificaRateLimitInfo {
  remaining: number;
  resetSec: number;
  /** null = `ratelimit-policy` absent or malformed. */
  quota: number | null;
  windowSec: number | null;
}

/** `"credits";k=v;k=v` with non-negative integer values; null on any deviation. */
function parseCreditsItem(raw: string | null): Map<string, number> | null {
  if (raw === null) return null;
  const parts = raw.trim().split(";").map((p) => p.trim());
  if (parts[0] !== '"credits"') return null;
  const out = new Map<string, number>();
  for (const p of parts.slice(1)) {
    const m = /^([a-z][a-z0-9_-]*)=(\d{1,12})$/.exec(p);
    if (m === null || out.has(m[1])) return null;
    out.set(m[1], Number(m[2]));
  }
  return out;
}

/**
 * Strict parse of the `ratelimit` / `ratelimit-policy` header values. `ratelimit` absent or
 * malformed (no `"credits"` item, missing / non-integer / duplicate r or t) → null: no info, never
 * a guessed value. A malformed policy only nulls quota / windowSec.
 */
export function parsePacificaRateLimit(ratelimit: string | null, policy: string | null): PacificaRateLimitInfo | null {
  const rl = parseCreditsItem(ratelimit);
  const r = rl?.get("r");
  const t = rl?.get("t");
  if (r === undefined || t === undefined) return null;
  const pol = parseCreditsItem(policy);
  const q = pol?.get("q");
  const w = pol?.get("w");
  const policyOk = q !== undefined && w !== undefined && w > 0;
  return { remaining: r, resetSec: t, quota: policyOk ? q : null, windowSec: policyOk ? w : null };
}

/** `Retry-After` in delta-seconds → ms; absent / HTTP-date / malformed → null. */
export function parseRetryAfterMs(raw: string | null): number | null {
  if (raw === null || !/^\d{1,9}$/.test(raw.trim())) return null;
  return Number(raw.trim()) * 1000;
}

type HeaderSource = { headers?: { get(name: string): string | null } } | null | undefined;

function header(res: HeaderSource, name: string): string | null {
  // Every real fetch Response has headers; a value without them carries no rate-limit info.
  const h = res?.headers;
  return h !== undefined && typeof h.get === "function" ? h.get(name) : null;
}

/** A CloudFront cache hit replays someone else's headers (see module doc). */
function isCacheHit(res: HeaderSource): boolean {
  const xc = header(res, "x-cache");
  return (xc !== null && /^(Hit|RefreshHit)\b/i.test(xc.trim())) || header(res, "age") !== null;
}

/** Parsed rate-limit info of a response this caller's request produced; null = no info. */
export function pacificaRateLimitOf(res: HeaderSource): PacificaRateLimitInfo | null {
  if (isCacheHit(res)) return null;
  return parsePacificaRateLimit(header(res, "ratelimit"), header(res, "ratelimit-policy"));
}

/** Keep this many credits (×10) unspent: the largest documented heavy-GET cost (12 credits). */
export const PACIFICA_RATE_RESERVE = 120;
/** Credits (×10) a request is assumed to cost until the next header says otherwise (standard = 1). */
const ASSUMED_COST = 10;
/** Slack after the venue's `t` (whole seconds) before the window is treated as refreshed. */
const RESET_MARGIN_MS = 250;
/** Longest pre-send wait before failing fast with RATE_LIMITED. */
export const PACIFICA_MAX_THROTTLE_WAIT_MS = 15_000;
/** Longest wait between signing and sending (signed bodies expire after expiry_window = 5 s). */
export const PACIFICA_SIGNED_MAX_WAIT_MS = 2_000;

export interface RateClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: RateClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

interface Observation {
  remaining: number;
  resetInMs: number;
  observedAt: number;
  /** Requests sent since this observation (each assumed ASSUMED_COST). */
  sentSince: number;
}

export class PacificaRateLimiter {
  private obs: Observation | null = null;

  constructor(private readonly label: string, private readonly clock: RateClock = realClock) {}

  /** ms until the observed window refreshes; null = no live observation. Clamped against backwards clock steps. */
  private resetWaitMs(): number | null {
    if (this.obs === null) return null;
    const elapsed = Math.max(0, this.clock.now() - this.obs.observedAt);
    const left = this.obs.resetInMs + RESET_MARGIN_MS - elapsed;
    if (left <= 0) { this.obs = null; return null; } // window refreshed: the observation is spent
    return left;
  }

  /** Current state for diagnostics (credits ×10); null = no live observation. */
  snapshot(): { remaining: number; effectiveRemaining: number; resetInMs: number } | null {
    const wait = this.resetWaitMs();
    if (wait === null || this.obs === null) return null;
    return { remaining: this.obs.remaining, effectiveRemaining: this.obs.remaining - this.obs.sentSince * ASSUMED_COST, resetInMs: wait };
  }

  /**
   * ms to wait before the next request may be sent: 0 = send now (no info, or above the reserve).
   * Below the reserve → until the observed window refreshes.
   */
  waitMs(): number {
    const wait = this.resetWaitMs();
    if (wait === null || this.obs === null) return 0;
    const effective = this.obs.remaining - this.obs.sentSince * ASSUMED_COST;
    return effective >= PACIFICA_RATE_RESERVE ? 0 : wait;
  }

  /**
   * Pre-send throttle: waits out a nearly spent window, or — when that wait exceeds
   * `maxWaitMs` — fails fast with RATE_LIMITED (details.sent === false: nothing was sent).
   */
  async throttle(what: string, maxWaitMs: number = PACIFICA_MAX_THROTTLE_WAIT_MS): Promise<void> {
    const wait = this.waitMs();
    if (wait === 0) return;
    if (wait > maxWaitMs) {
      throw new PerpError("RATE_LIMITED", `Pacifica ${what} not sent: rate-limit credits nearly exhausted (${this.label}), window refreshes in ${Math.ceil(wait / 1000)} s`, {
        exchange: "pacifica", sent: false, retryAfterMs: wait,
        remediation: `Nothing was sent. Retry after ${Math.ceil(wait / 1000)} s; other perp-cli processes on this IP share the same Pacifica quota — reduce request frequency or use an API Config Key (300 credits / 60 s)`,
      });
    }
    await this.clock.sleep(wait);
    this.obs = null; // the window the observation described has refreshed
  }

  /** Count a request that is about to be sent. */
  noteSent(): void {
    if (this.obs !== null) this.obs.sentSince++;
  }

  /** Record a response's headers (any status). No / malformed / cached headers → state unchanged. */
  observe(res: HeaderSource): PacificaRateLimitInfo | null {
    const info = pacificaRateLimitOf(res);
    if (info !== null) {
      this.obs = { remaining: info.remaining, resetInMs: info.resetSec * 1000, observedAt: this.clock.now(), sentSince: 0 };
    }
    return info;
  }

  /**
   * HTTP 429 → RATE_LIMITED (structural, by status). retryAfterMs = `Retry-After`, else the
   * ratelimit reset `t`, else absent. The quota is recorded as exhausted until then.
   * `sent: false`: Pacifica answers 429 when credits are exhausted, before processing.
   */
  rateLimitedError(what: string, res: HeaderSource & { status: number }, body: string): PerpError {
    const info = pacificaRateLimitOf(res);
    const fromHeader = parseRetryAfterMs(header(res, "retry-after"));
    const retryAfterMs = fromHeader !== null ? fromHeader : info !== null ? info.resetSec * 1000 : null;
    if (retryAfterMs !== null) this.obs = { remaining: 0, resetInMs: retryAfterMs, observedAt: this.clock.now(), sentSince: 0 };
    return new PerpError("RATE_LIMITED", `Pacifica ${what} rate limited (HTTP 429); nothing was executed: ${body.slice(0, 200)}`, {
      exchange: "pacifica", httpStatus: 429, sent: false,
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
      remediation: `${retryAfterMs !== null ? `Retry after ${Math.ceil(retryAfterMs / 1000)} s` : "Wait for the 60 s window to refresh, then retry"}; other perp-cli processes on this IP share the same Pacifica quota — reduce request frequency or use an API Config Key (300 credits / 60 s)`,
    });
  }
}

/** A Pacifica RATE_LIMITED that sent nothing (pre-send throttle or HTTP 429): a definite refusal. */
export function isPacificaRateLimited(e: unknown): boolean {
  return e instanceof PerpError && e.structured.code === "RATE_LIMITED"
    && e.structured.details?.exchange === "pacifica" && e.structured.details?.sent === false;
}

const limiters = new Map<string, PacificaRateLimiter>();

/** The process-local limiter for a REST base URL + credential tier (no key = IP quota). */
export function pacificaRateLimiter(baseUrl: string, apiKey: string | undefined): PacificaRateLimiter {
  const tier = apiKey ? `key:${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}` : "ip";
  const key = `${baseUrl}|${tier}`;
  let l = limiters.get(key);
  if (l === undefined) { l = new PacificaRateLimiter(`${baseUrl} ${apiKey ? "API Config Key" : "IP"} quota`); limiters.set(key, l); }
  return l;
}

/** Test hook: forget every limiter's state. */
export function resetPacificaRateLimiters(): void {
  limiters.clear();
}
