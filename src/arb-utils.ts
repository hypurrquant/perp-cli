/**
 * Arb utilities: settlement timing strategy, basis risk monitoring, and webhook notifications.
 */

import { toHourlyRate, getFundingHours } from "./funding.js";
import type { ExchangeAdapter } from "./exchanges/interface.js";

// ── Settlement Timing Strategy ──

/** Settlement schedules per exchange (UTC hours when settlement occurs) */
const SETTLEMENT_SCHEDULES: Record<string, number[]> = {
  hyperliquid: Array.from({ length: 24 }, (_, i) => i), // every hour
  pacifica: Array.from({ length: 24 }, (_, i) => i),    // every hour
  lighter: Array.from({ length: 24 }, (_, i) => i),     // every hour
};

export type SettleStrategy = "block" | "aggressive" | "off";

/**
 * Get the most recent settlement time for an exchange.
 * @returns Date of the most recent past settlement
 */
export function getLastSettlement(exchange: string, now: Date = new Date()): Date {
  const schedule = SETTLEMENT_SCHEDULES[exchange.toLowerCase()];
  if (!schedule || schedule.length === 0) {
    return getLastSettlement("pacifica", now);
  }

  const currentHour = now.getUTCHours();
  const currentMinutes = now.getUTCMinutes();
  const currentSeconds = now.getUTCSeconds();

  // Find the most recent settlement hour at or before now
  for (let i = schedule.length - 1; i >= 0; i--) {
    const hour = schedule[i];
    if (hour < currentHour || (hour === currentHour && (currentMinutes > 0 || currentSeconds > 0))) {
      const last = new Date(now);
      last.setUTCHours(hour, 0, 0, 0);
      return last;
    }
    // Exactly at settlement time
    if (hour === currentHour && currentMinutes === 0 && currentSeconds === 0) {
      const last = new Date(now);
      last.setUTCHours(hour, 0, 0, 0);
      return last;
    }
  }

  // Wrap to previous day's last settlement
  const last = new Date(now);
  last.setUTCDate(last.getUTCDate() - 1);
  last.setUTCHours(schedule[schedule.length - 1], 0, 0, 0);
  return last;
}

/**
 * Get minutes since the most recent settlement for an exchange.
 */
export function getMinutesSinceSettlement(exchange: string, now: Date = new Date()): number {
  const lastSettle = getLastSettlement(exchange, now);
  return (now.getTime() - lastSettle.getTime()) / (1000 * 60);
}

/**
 * Compute a score boost for aggressive settlement mode.
 * Returns a multiplier > 1.0 if within the post-settlement window, else 1.0.
 * The boost decays linearly from 1.5x (right after settlement) to 1.0x (at windowMinutes).
 */
export function aggressiveSettleBoost(
  longExchange: string,
  shortExchange: string,
  windowMinutes: number = 10,
  now: Date = new Date(),
): number {
  const longMinutes = getMinutesSinceSettlement(longExchange, now);
  const shortMinutes = getMinutesSinceSettlement(shortExchange, now);
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
 * Check basis risk (mark price divergence) for open arb positions.
 * Fetches current mark prices from each exchange and computes divergence.
 */
export async function checkBasisRisk(
  positions: Array<{
    symbol: string;
    longExchange: string;
    shortExchange: string;
  }>,
  adapters: Map<string, ExchangeAdapter>,
  maxDivergencePct: number = 3,
): Promise<BasisRisk[]> {
  const results: BasisRisk[] = [];

  for (const pos of positions) {
    const longAdapter = adapters.get(pos.longExchange);
    const shortAdapter = adapters.get(pos.shortExchange);
    if (!longAdapter || !shortAdapter) continue;

    try {
      const [longMarkets, shortMarkets] = await Promise.all([
        longAdapter.getMarkets(),
        shortAdapter.getMarkets(),
      ]);

      const longMarket = longMarkets.find(
        m => m.symbol.replace("-PERP", "").toUpperCase() === pos.symbol.toUpperCase()
      );
      const shortMarket = shortMarkets.find(
        m => m.symbol.replace("-PERP", "").toUpperCase() === pos.symbol.toUpperCase()
      );

      if (!longMarket || !shortMarket) continue;

      const longPrice = Number(longMarket.markPrice);
      const shortPrice = Number(shortMarket.markPrice);
      if (longPrice <= 0 || shortPrice <= 0) continue;

      const avgPrice = (longPrice + shortPrice) / 2;
      const divergencePct = Math.abs(longPrice - shortPrice) / avgPrice * 100;

      results.push({
        symbol: pos.symbol,
        longExchange: pos.longExchange,
        shortExchange: pos.shortExchange,
        longMarkPrice: longPrice,
        shortMarkPrice: shortPrice,
        divergencePct,
        warning: divergencePct >= maxDivergencePct,
      });
    } catch {
      // Skip positions where we can't fetch prices
    }
  }

  return results;
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
