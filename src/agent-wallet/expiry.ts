import type { AgentMeta } from "../settings.js";

/**
 * Returns true if the agent's expiry timestamp is in the past.
 */
export function isExpired(meta: AgentMeta): boolean {
  return Date.now() >= new Date(meta.expiresAt).getTime();
}

/**
 * Returns the number of days (float) until the agent expires.
 * Negative if already expired.
 */
export function daysUntilExpiry(meta: AgentMeta): number {
  const ms = new Date(meta.expiresAt).getTime() - Date.now();
  return ms / (1000 * 60 * 60 * 24);
}

/**
 * Returns a human-readable expiry string, e.g.
 * "expires in 7 days (2026-05-05)" or "expired 3 days ago (2026-04-25)".
 */
export function formatExpiry(meta: AgentMeta): string {
  const days = daysUntilExpiry(meta);
  const dateStr = new Date(meta.expiresAt).toISOString().slice(0, 10);
  if (days < 0) {
    return `expired ${Math.abs(days).toFixed(0)} days ago (${dateStr})`;
  }
  return `expires in ${days.toFixed(0)} days (${dateStr})`;
}
