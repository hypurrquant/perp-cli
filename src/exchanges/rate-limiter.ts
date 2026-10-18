/**
 * Per-process token-bucket rate limiter keyed by venue.
 *
 * Limitation (documented): this only coordinates requests inside one process.
 * CLI + MCP server + bots running at once can still exceed a venue's limit.
 */

import { PerpError } from "../errors.js";
import type { RateLimitPolicy } from "./venue.js";

class TokenBucket {
  private tokens: number;
  private last = Date.now();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly policy: RateLimitPolicy) {
    if (!(policy.capacity > 0) || !(policy.refillPerSec > 0)) {
      throw new Error(`invalid rate limit policy: ${JSON.stringify(policy)}`);
    }
    this.tokens = policy.capacity;
  }

  private refill(): void {
    const now = Date.now();
    // Clamped: a wall clock stepping backwards (NTP, VM resume, fake timers) must not drive the bucket
    // negative and stall every request until the clock catches up.
    const elapsedMs = Math.max(0, now - this.last);
    this.tokens = Math.min(this.policy.capacity, this.tokens + (elapsedMs / 1000) * this.policy.refillPerSec);
    this.last = now;
  }

  acquire(weight: number): Promise<void> {
    if (weight > this.policy.capacity) {
      throw new PerpError("RATE_LIMITED", `request weight ${weight} exceeds bucket capacity ${this.policy.capacity}`);
    }
    const run = async () => {
      for (;;) {
        this.refill();
        if (this.tokens >= weight) { this.tokens -= weight; return; }
        const waitMs = Math.ceil(((weight - this.tokens) / this.policy.refillPerSec) * 1000);
        await new Promise(r => setTimeout(r, waitMs));
      }
    };
    const p = this.queue.then(run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

const buckets = new Map<string, TokenBucket>();

/** Acquire capacity for one request. `endpoint` is looked up in policy.weights (unlisted = 1). */
export async function acquireRate(key: string, policy: RateLimitPolicy, endpoint: string): Promise<void> {
  let b = buckets.get(key);
  if (!b) { b = new TokenBucket(policy); buckets.set(key, b); }
  const weight = policy.weights?.[endpoint] ?? 1; // unlisted endpoints cost 1 by the policy's definition
  await b.acquire(weight);
}

/** Map an HTTP 429 into a structured RATE_LIMITED error. */
export function rateLimitedError(venue: string, retryAfterHeader: string | null, body: string): PerpError {
  const retryAfterSec = retryAfterHeader !== null ? Number(retryAfterHeader) : NaN;
  return new PerpError("RATE_LIMITED", `${venue}: rate limited (HTTP 429)`, {
    ...(Number.isFinite(retryAfterSec) ? { retryAfterMs: retryAfterSec * 1000 } : {}),
    body: body.slice(0, 500),
    remediation: `Reduce request frequency for ${venue} or request a higher API limit from the venue`,
  });
}
