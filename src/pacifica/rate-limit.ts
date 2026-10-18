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
 * Scope: one state per REST base URL (mainnet / testnet), credential tier (no key = IP quota;
 * an API Config Key has its own) and request kind (signed POST vs unsigned GET). Process-local: other perp-cli processes (CLI + MCP + bots) on the
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


/** Read reserve (credits ×10): the largest documented heavy-GET cost (12 credits) stays unspent after a read. */
export const PACIFICA_READ_RESERVE = 120;
/** Cost (credits ×10) of a standard request / action (docs: 1 credit). */
export const PACIFICA_COST_STANDARD = 10;
/** Cost (credits ×10) of an order cancellation (docs: 0.5 credits). */
export const PACIFICA_COST_CANCEL = 5;
/** Slack after the venue's `t` (whole seconds) before the window is treated as refreshed. */
const RESET_MARGIN_MS = 250;
/** Documented window (docs: "60-second rolling window") — only an upper clamp for `t` / Retry-After. */
const DOC_WINDOW_SEC = 60;
/** A reset / Retry-After longer than the window + this is clamped (a bogus value must not stall). */
const RESET_CLAMP_MARGIN_MS = 1_000;
/** Longest pre-send wait before failing fast with RATE_LIMITED. */
export const PACIFICA_MAX_THROTTLE_WAIT_MS = 15_000;
/** Longest wait between signing and sending (signed bodies expire after expiry_window = 5 s). */
export const PACIFICA_SIGNED_MAX_WAIT_MS = 2_000;

export interface RateClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** Monotonic: elapsed time never follows a wall-clock step (NTP, VM resume). */
const realClock: RateClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

interface Observation {
  remaining: number;
  resetInMs: number;
  observedAt: number;
  /** Tracked policy quota; an observation with a different q is another quota's (dropped). */
  quota: number | null;
}

/** What a request needs before it may be sent. */
export interface RateNeed {
  /** Credits ×10 this request is assumed to cost (PACIFICA_COST_*). */
  cost: number;
  /**
   * Credits ×10 that must still be left after this request (observed remaining − in flight − cost):
   * reads keep the heavy-GET reserve (PACIFICA_READ_RESERVE); writes 0 — a write needs only its own
   * cost, so an amend's replacement leg is never blocked by the read reserve.
   */
  reserve: number;
  /** Longest pre-send wait; longer → RATE_LIMITED fail-fast (0 = never wait). */
  maxWaitMs: number;
}

export const PACIFICA_READ_NEED: RateNeed = { cost: PACIFICA_COST_STANDARD, reserve: PACIFICA_READ_RESERVE, maxWaitMs: PACIFICA_MAX_THROTTLE_WAIT_MS };

/** A reserved request: settle with its response (or release on a transport failure). Idempotent. */
export interface RateTicket {
  settle(res: HeaderSource): PacificaRateLimitInfo | null;
  release(): void;
}

function clampResetMs(ms: number, windowSec: number | null): number {
  const cap = (windowSec !== null ? windowSec : DOC_WINDOW_SEC) * 1000 + RESET_CLAMP_MARGIN_MS;
  return Math.min(ms, cap);
}

export class PacificaRateLimiter {
  private obs: Observation | null = null;
  /** Credits ×10 reserved by requests sent and not yet settled — not reset by observe(). */
  private inFlight = 0;
  private lastRaw = Number.NEGATIVE_INFINITY;
  private skew = 0;

  constructor(private readonly label: string, private readonly clock: RateClock = realClock) {}

  /** clock.now() made monotonic: a backwards step is absorbed instead of restarting elapsed time. */
  private now(): number {
    const raw = this.clock.now();
    if (raw < this.lastRaw) this.skew += this.lastRaw - raw;
    this.lastRaw = raw;
    return raw + this.skew;
  }

  /** ms until the observed window refreshes; null = no live observation. */
  private resetWaitMs(): number | null {
    if (this.obs === null) return null;
    const left = this.obs.resetInMs + RESET_MARGIN_MS - (this.now() - this.obs.observedAt);
    if (left <= 0) { this.obs = null; return null; } // window refreshed: the observation is spent
    return left;
  }

  /** Current state for diagnostics (credits ×10); null = no live observation. */
  snapshot(): { remaining: number; inFlight: number; effectiveRemaining: number; resetInMs: number } | null {
    const wait = this.resetWaitMs();
    if (wait === null || this.obs === null) return null;
    return { remaining: this.obs.remaining, inFlight: this.inFlight, effectiveRemaining: this.obs.remaining - this.inFlight, resetInMs: wait };
  }

  /** ms to wait before a request with `need` may be sent: 0 = now (no info, or enough credits left). */
  waitMs(need: Pick<RateNeed, "cost" | "reserve">): number {
    const wait = this.resetWaitMs();
    if (wait === null || this.obs === null) return 0;
    return this.obs.remaining - this.inFlight - need.cost >= need.reserve ? 0 : wait;
  }

  private ticket(cost: number): RateTicket {
    this.inFlight += cost;
    let open = true;
    const release = () => { if (open) { open = false; this.inFlight -= cost; } };
    return {
      release,
      settle: (res) => { release(); return this.observe(res); },
    };
  }

  /**
   * Pre-send throttle + reservation. Enough credits (or no info) → the cost is reserved
   * synchronously, before any await, so concurrent callers see each other. Otherwise waits for the
   * window to refresh (total ≤ need.maxWaitMs) or fails fast with RATE_LIMITED (sent: false).
   */
  async acquire(what: string, need: RateNeed): Promise<RateTicket> {
    let budget = need.maxWaitMs;
    for (;;) {
      const wait = this.waitMs(need);
      if (wait === 0) return this.ticket(need.cost);
      if (wait > budget) throw this.throttled(what, wait);
      const waitedOn = this.obs;
      const start = this.now();
      await this.clock.sleep(wait);
      budget -= this.now() - start;
      // The window that observation described has refreshed; a newer one (a response that landed
      // meanwhile) is kept and re-checked.
      if (this.obs === waitedOn) this.obs = null;
    }
  }

  /** Like acquire but never waits or refuses (health probe): reserves and records only. */
  track(cost: number): RateTicket {
    return this.ticket(cost);
  }

  /** Wait (no reservation) until `need` would pass — used before signing, so the post-sign acquire finds credits. */
  async awaitCapacity(what: string, need: RateNeed): Promise<void> {
    (await this.acquire(what, need)).release();
  }

  private throttled(what: string, wait: number): PerpError {
    return new PerpError("RATE_LIMITED", `Pacifica ${what} not sent: rate-limit credits nearly exhausted (${this.label}), window refreshes in ${Math.ceil(wait / 1000)} s`, {
      exchange: "pacifica", sent: false, retryAfterMs: Math.ceil(wait),
      remediation: `Nothing was sent. Retry after ${Math.ceil(wait / 1000)} s; other perp-cli processes on this IP share the same Pacifica quota — reduce request frequency or use an API Config Key (300 credits / 60 s)`,
    });
  }

  /**
   * Record a response's headers (any status). No / malformed / cached headers → unchanged. Within
   * the live window an observation with a higher `r` (a late response from before others landed)
   * or a different `q` (another quota: account vs IP) is dropped.
   */
  observe(res: HeaderSource): PacificaRateLimitInfo | null {
    const info = pacificaRateLimitOf(res);
    if (info === null) return null;
    const live = this.resetWaitMs() !== null && this.obs !== null ? this.obs : null;
    if (live !== null) {
      if (info.remaining > live.remaining) return null;
      if (live.quota !== null && info.quota !== null && info.quota !== live.quota) return null;
    }
    this.obs = { remaining: info.remaining, resetInMs: clampResetMs(info.resetSec * 1000, info.windowSec), observedAt: this.now(), quota: info.quota };
    return info;
  }

  /**
   * HTTP 429 → RATE_LIMITED (structural, by status). retryAfterMs = `Retry-After`, else the
   * ratelimit reset `t`, else absent (clamped to the window). The quota is recorded as exhausted.
   *
   * `sent: false` ("not executed") is OUR reading of the docs — "When credits are exhausted,
   * requests return HTTP 429" — i.e. the request is refused before processing. Pacifica does not
   * state explicitly that a 429'd write was not executed.
   */
  rateLimitedError(what: string, res: HeaderSource & { status: number }, body: string): PerpError {
    const info = pacificaRateLimitOf(res);
    const fromHeader = parseRetryAfterMs(header(res, "retry-after"));
    const raw = fromHeader !== null ? fromHeader : info !== null ? info.resetSec * 1000 : null;
    const retryAfterMs = raw !== null ? clampResetMs(raw, info !== null ? info.windowSec : null) : null;
    if (retryAfterMs !== null) this.obs = { remaining: 0, resetInMs: retryAfterMs, observedAt: this.now(), quota: info !== null ? info.quota : null };
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

/**
 * The process-local limiter for a REST base URL + credential tier (no key = IP quota) + request
 * kind. Signed POSTs are kept apart from unsigned GETs: credits are shared per main account and
 * scale with its fee tier, so signed responses can report an account quota (e.g. q=3000) while
 * keyless GETs report the IP quota (q=1000).
 */
export function pacificaRateLimiter(baseUrl: string, apiKey: string | undefined, kind: "signed" | "unsigned"): PacificaRateLimiter {
  const tier = apiKey ? `key:${createHash("sha256").update(apiKey).digest("hex").slice(0, 12)}` : "ip";
  const key = `${baseUrl}|${tier}|${kind}`;
  let l = limiters.get(key);
  if (l === undefined) { l = new PacificaRateLimiter(`${baseUrl} ${apiKey ? "API Config Key" : "IP"} ${kind} quota`); limiters.set(key, l); }
  return l;
}

/** Test hook: forget every limiter's state. */
export function resetPacificaRateLimiters(): void {
  limiters.clear();
}
