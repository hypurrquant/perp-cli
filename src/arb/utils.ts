/**
 * Arb utilities: settlement timing strategy, basis risk monitoring, and webhook notifications.
 */

import { PerpError } from "../errors.js";
import { listVenues, settlementIntervalOf } from "../exchanges/venue.js";
import { ensureVenuesRegistered } from "../exchanges/venues/index.js";

// ── Settlement Timing Strategy ──

ensureVenuesRegistered();

/**
 * Settlement schedules per venue (UTC hours when settlement occurs), generated
 * from `VenueDefinition.settlementIntervalHours`, anchored at 00:00 UTC. Venues whose interval is per-market (Aster)
 * have no entry — pass the market's interval to getLastSettlement().
 */
export const SETTLEMENT_SCHEDULES: Record<string, number[]> = Object.fromEntries(
  listVenues()
    .filter(v => v.settlementIntervalHours !== "perMarket")
    .map(v => [v.id, scheduleFor(v.settlementIntervalHours as number)]),
);

function scheduleFor(intervalHours: number): number[] {
  if (!(intervalHours > 0) || 24 % intervalHours !== 0) {
    throw new PerpError("INVALID_PARAMS", `Settlement interval ${intervalHours}h does not divide a UTC day`);
  }
  return Array.from({ length: 24 / intervalHours }, (_, i) => i * intervalHours);
}

export type SettleStrategy = "block" | "aggressive" | "off";

/**
 * Settlement interval in hours for a venue ref. `marketIntervalHours` (the
 * market's `settlementIntervalHours`) takes precedence; it is required for
 * per-market venues. Unknown venues throw UNKNOWN_VENUE.
 */
export function settlementIntervalHours(exchange: string, marketIntervalHours: number | null = null): number {
  if (marketIntervalHours !== null) {
    if (!(marketIntervalHours > 0)) {
      throw new PerpError("INVALID_PARAMS", `Invalid settlement interval ${marketIntervalHours}h for ${exchange}`);
    }
    return marketIntervalHours;
  }
  return settlementIntervalOf(exchange);
}

/**
 * Get the most recent settlement time for an exchange (anchored at 00:00 UTC).
 * @param marketIntervalHours market settlement interval; required for per-market venues
 * @returns Date of the most recent past settlement (== now when exactly on a settlement)
 */
export function getLastSettlement(exchange: string, now: Date = new Date(), marketIntervalHours: number | null = null): Date {
  const intervalMs = settlementIntervalHours(exchange, marketIntervalHours) * 3_600_000;
  return new Date(Math.floor(now.getTime() / intervalMs) * intervalMs);
}

/**
 * Get minutes since the most recent settlement for an exchange.
 */
export function getMinutesSinceSettlement(exchange: string, now: Date = new Date(), marketIntervalHours: number | null = null): number {
  const lastSettle = getLastSettlement(exchange, now, marketIntervalHours);
  return (now.getTime() - lastSettle.getTime()) / (1000 * 60);
}

/**
 * Compute a score boost for aggressive settlement mode.
 * Returns a multiplier > 1.0 if within the post-settlement window, else 1.0.
 * The boost decays linearly from 1.5x (right after settlement) to 1.0x (at windowMinutes).
 * `marketIntervalFor` returns the market's settlement interval per exchange;
 * it must return a number for per-market venues (Aster).
 */
export function aggressiveSettleBoost(
  longExchange: string,
  shortExchange: string,
  windowMinutes: number = 10,
  now: Date = new Date(),
  marketIntervalFor: (exchange: string) => number | null = () => null,
): number {
  const longMinutes = getMinutesSinceSettlement(longExchange, now, marketIntervalFor(longExchange));
  const shortMinutes = getMinutesSinceSettlement(shortExchange, now, marketIntervalFor(shortExchange));
  // Use the minimum of the two — we want BOTH exchanges to have recently settled
  const minMinutes = Math.min(longMinutes, shortMinutes);

  if (minMinutes <= windowMinutes) {
    // Linear decay from 1.5 to 1.0
    const factor = 1.0 + 0.5 * (1 - minMinutes / windowMinutes);
    return factor;
  }
  return 1.0;
}

/**
 * Estimate cumulative funding between now and the next settlement.
 *
 * Since all three exchanges (HL, PAC, LT) settle every hour, both sides
 * accumulate funding at the same frequency. The function estimates
 * cumulative funding over the given time horizon.
 *
 * @param hlHourlyRate - HL per-hour funding rate (raw, not %)
 * @param pacHourlyRate - PAC per-hour funding rate (raw, not %)
 * @param positionSize - position notional in USD
 * @param hoursUntilSettlement - hours until next settlement
 * @returns { hlCumulative, pacPayment, netFunding } in USD (positive = you receive)
 */
export function estimateFundingUntilSettlement(
  hlHourlyRate: number,
  pacHourlyRate: number,
  positionSize: number,
  hoursUntilSettlement: number,
): { hlCumulative: number; pacPayment: number; netFunding: number } {
  // Both exchanges settle every hour, so we accumulate over the same period
  const hlCumulative = Math.abs(hlHourlyRate) * positionSize * hoursUntilSettlement;

  // PAC also settles every hour, so cumulative over same period
  const pacPayment = Math.abs(pacHourlyRate) * positionSize * hoursUntilSettlement;

  // Net assumes: short high-rate exchange (receive), long low-rate (pay less)
  // In a typical arb, we short the high-rate and long the low-rate
  // The net is the difference we collect
  const netFunding = hlCumulative - pacPayment;

  return { hlCumulative, pacPayment, netFunding };
}

// ── Basis Risk Monitoring ──

export interface BasisRisk {
  symbol: string;
  longExchange: string;
  shortExchange: string;
  longMarkPrice: number;
  shortMarkPrice: number;
  divergencePct: number; // |longPrice - shortPrice| / avgPrice * 100
  warning: boolean;
}

/**
 * Compute basis risk from pre-fetched prices (no async, for use in tests and monitor).
 */
export function computeBasisRisk(
  longPrice: number,
  shortPrice: number,
  maxDivergencePct: number = 3,
): { divergencePct: number; warning: boolean } {
  if (longPrice <= 0 || shortPrice <= 0) {
    return { divergencePct: 0, warning: false };
  }
  const avgPrice = (longPrice + shortPrice) / 2;
  const divergencePct = Math.abs(longPrice - shortPrice) / avgPrice * 100;
  return { divergencePct, warning: divergencePct >= maxDivergencePct };
}

// ── Webhook Notification System ──

export type ArbNotifyEvent = "entry" | "exit" | "reversal" | "margin" | "basis" | "heartbeat";

/**
 * Format a notification message for an arb event.
 */
export function formatNotifyMessage(event: ArbNotifyEvent, data: Record<string, unknown>): string {
  switch (event) {
    case "entry": {
      const symbol = data.symbol ?? "???";
      const longExch = data.longExchange ?? "?";
      const shortExch = data.shortExchange ?? "?";
      const size = data.size ?? "?";
      const netSpread = typeof data.netSpread === "number" ? data.netSpread.toFixed(1) : "?";
      return `Entered ${symbol} arb: Long ${longExch} / Short ${shortExch}, $${size}/leg, spread ${netSpread}% net`;
    }
    case "exit": {
      const symbol = data.symbol ?? "???";
      const pnl = typeof data.pnl === "number" ? (data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`) : "?";
      const duration = data.duration ?? "?";
      return `Closed ${symbol} arb: ${pnl} net, held ${duration}`;
    }
    case "reversal": {
      const symbol = data.symbol ?? "???";
      return `REVERSAL: ${symbol} spread reversed, emergency close triggered`;
    }
    case "margin": {
      const exchange = data.exchange ?? "?";
      const marginPct = typeof data.marginPct === "number" ? data.marginPct.toFixed(1) : "?";
      const threshold = typeof data.threshold === "number" ? data.threshold.toFixed(1) : "?";
      return `LOW MARGIN: ${exchange} margin at ${marginPct}%, below ${threshold}% threshold`;
    }
    case "basis": {
      const symbol = data.symbol ?? "???";
      const divergence = typeof data.divergencePct === "number" ? data.divergencePct.toFixed(1) : "?";
      const longExch = data.longExchange ?? "?";
      const shortExch = data.shortExchange ?? "?";
      return `BASIS RISK: ${symbol} price divergence ${divergence}% between ${longExch}/${shortExch}`;
    }
    case "heartbeat": {
      const lastScan = data.lastScanTime ?? "unknown";
      const minutesAgo = typeof data.minutesAgo === "number" ? data.minutesAgo.toFixed(0) : "?";
      return `HEARTBEAT: No successful scan in ${minutesAgo} minutes (last: ${lastScan})`;
    }
    default:
      return `Arb event: ${event} - ${JSON.stringify(data)}`;
  }
}

/**
 * Detect if a URL is a Discord webhook, Telegram bot API, or generic webhook.
 */
function detectWebhookType(url: string): "discord" | "telegram" | "generic" {
  if (url.includes("discord.com/api/webhooks") || url.includes("discordapp.com/api/webhooks")) {
    return "discord";
  }
  if (url.includes("api.telegram.org/bot")) {
    return "telegram";
  }
  return "generic";
}

/**
 * Extract Telegram chat_id from a URL like:
 *   https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<CHAT_ID>
 * or from the data parameter if the URL just has the bot token.
 */
function parseTelegramUrl(url: string): { apiUrl: string; chatId: string } {
  const urlObj = new URL(url);
  const chatId = urlObj.searchParams.get("chat_id") || "";
  // Remove chat_id from URL params to build clean API URL
  urlObj.searchParams.delete("chat_id");
  // Ensure path ends with /sendMessage
  if (!urlObj.pathname.endsWith("/sendMessage")) {
    urlObj.pathname = urlObj.pathname.replace(/\/$/, "") + "/sendMessage";
  }
  return { apiUrl: urlObj.toString(), chatId };
}

/**
 * Send a notification to a webhook URL (Discord, Telegram, or generic).
 *
 * @param webhookUrl - The webhook URL
 * @param event - The event type
 * @param data - Event data
 * @param fetchFn - Optional fetch function for testing
 */
export async function sendNotification(
  webhookUrl: string,
  event: ArbNotifyEvent,
  data: Record<string, unknown>,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<void> {
  const message = formatNotifyMessage(event, data);
  const type = detectWebhookType(webhookUrl);

  try {
    if (type === "discord") {
      await fetchFn(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
    } else if (type === "telegram") {
      const { apiUrl, chatId } = parseTelegramUrl(webhookUrl);
      await fetchFn(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      });
    } else {
      // Generic webhook: POST with JSON body
      await fetchFn(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, message, data }),
      });
    }
  } catch {
    // Silently fail — notifications should never crash the bot
  }
}

/**
 * Helper to send notification only if the event is in the allowed list.
 */
export async function notifyIfEnabled(
  webhookUrl: string | undefined,
  enabledEvents: ArbNotifyEvent[],
  event: ArbNotifyEvent,
  data: Record<string, unknown>,
  fetchFn?: typeof fetch,
): Promise<void> {
  if (!webhookUrl) return;
  if (enabledEvents.length > 0 && !enabledEvents.includes(event)) return;
  await sendNotification(webhookUrl, event, data, fetchFn);
}
