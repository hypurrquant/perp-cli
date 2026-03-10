import { Command } from "commander";
import chalk from "chalk";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { formatUsd, printJson, jsonOk } from "../utils.js";
import { computeAnnualSpread } from "../funding.js";
import {
  fetchPacificaPricesRaw, parsePacificaRaw,
  fetchHyperliquidAllMidsRaw,
  fetchHyperliquidMetaRaw, parseHyperliquidMetaRaw,
} from "../shared-api.js";

// ── Alert Store ───────────────────────────────────

interface Alert {
  id: string;
  type: "price" | "funding" | "pnl" | "liquidation";
  symbol: string;
  condition: string; // "above 100000", "below 50", "spread > 30", etc.
  value: number;
  channels: string[]; // ["telegram", "discord"]
  active: boolean;
  createdAt: string;
}

interface NotifyConfig {
  telegramBotToken: string;
  telegramChatId: string;
  discordWebhook: string;
  slackWebhook: string;
}

interface AlertStore {
  alerts: Alert[];
  config: NotifyConfig;
}

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const ALERTS_FILE = resolve(PERP_DIR, "alerts.json");

function loadAlerts(): AlertStore {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(ALERTS_FILE)) return { alerts: [], config: { telegramBotToken: "", telegramChatId: "", discordWebhook: "", slackWebhook: "" } };
  try {
    return JSON.parse(readFileSync(ALERTS_FILE, "utf-8"));
  } catch {
    return { alerts: [], config: { telegramBotToken: "", telegramChatId: "", discordWebhook: "", slackWebhook: "" } };
  }
}

function saveAlerts(store: AlertStore) {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(ALERTS_FILE, JSON.stringify(store, null, 2), { mode: 0o600 });
}

function genId(): string {
  return Math.random().toString(36).slice(2, 8);
}

// ── Notification Senders ──────────────────────────

async function sendTelegram(token: string, chatId: string, message: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
  });
}

async function sendDiscord(webhookUrl: string, message: string) {
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message }),
  });
}

async function sendSlack(webhookUrl: string, message: string) {
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });
}

async function notify(store: AlertStore, alert: Alert, message: string) {
  const promises: Promise<void>[] = [];

  for (const ch of alert.channels) {
    if (ch === "telegram" && store.config.telegramBotToken && store.config.telegramChatId) {
      promises.push(sendTelegram(store.config.telegramBotToken, store.config.telegramChatId, message));
    }
    if (ch === "discord" && store.config.discordWebhook) {
      promises.push(sendDiscord(store.config.discordWebhook, message));
    }
    if (ch === "slack" && store.config.slackWebhook) {
      promises.push(sendSlack(store.config.slackWebhook, message));
    }
  }

  await Promise.allSettled(promises);
}

// ── Alert Daemon ──────────────────────────────────

async function fetchPrices(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const [pacRes, hlRes] = await Promise.all([
      fetchPacificaPricesRaw(),
      fetchHyperliquidAllMidsRaw(),
    ]);

    const { prices: pacPrices } = parsePacificaRaw(pacRes);
    for (const [sym, price] of pacPrices) map.set(`pac:${sym}`, price);

    if (hlRes && typeof hlRes === "object") {
      for (const [symbol, price] of Object.entries(hlRes as Record<string, string>)) {
        map.set(`hl:${symbol}`, Number(price));
      }
    }

    // Merge into bare symbol keys: prefer pac price, fallback to hl
    const allSymbols = new Set<string>();
    for (const k of map.keys()) {
      if (k.includes(":")) allSymbols.add(k.split(":")[1]);
    }
    for (const sym of allSymbols) {
      const pacPrice = map.get(`pac:${sym}`);
      const hlPrice = map.get(`hl:${sym}`);
      map.set(sym, pacPrice ?? hlPrice ?? 0);
    }
  } catch {}
  return map;
}

async function fetchFundingRates(): Promise<Map<string, { pac: number; hl: number; spread: number }>> {
  const map = new Map<string, { pac: number; hl: number; spread: number }>();
  try {
    const [pacRes, hlRes] = await Promise.all([
      fetchPacificaPricesRaw(),
      fetchHyperliquidMetaRaw(),
    ]);

    const { rates: pacRates } = parsePacificaRaw(pacRes);
    const { rates: hlRates } = parseHyperliquidMetaRaw(hlRes);

    const allSymbols = new Set([...pacRates.keys(), ...hlRates.keys()]);
    for (const sym of allSymbols) {
      const pac = pacRates.get(sym) ?? 0;
      const hl = hlRates.get(sym) ?? 0;
      const spread = computeAnnualSpread(pac, "pacifica", hl, "hyperliquid");
      map.set(sym, { pac, hl, spread });
    }
  } catch {}
  return map;
}

async function fetchPositionData(
  getAdapterFor?: (exchange: string) => Promise<import("../exchanges/interface.js").ExchangeAdapter>,
): Promise<{ positions: Array<{ exchange: string; symbol: string; pnl: number; side: string; size: string }>; accounts: Array<{ exchange: string; equity: number; marginUsed: number; available: number }> }> {
  const positions: Array<{ exchange: string; symbol: string; pnl: number; side: string; size: string }> = [];
  const accounts: Array<{ exchange: string; equity: number; marginUsed: number; available: number }> = [];
  if (!getAdapterFor) return { positions, accounts };

  for (const exName of ["pacifica", "hyperliquid", "lighter"]) {
    try {
      const adapter = await getAdapterFor(exName);
      const [pos, bal] = await Promise.all([
        adapter.getPositions(),
        adapter.getBalance(),
      ]);
      for (const p of pos) {
        positions.push({ exchange: exName, symbol: p.symbol, pnl: parseFloat(p.unrealizedPnl || "0"), side: p.side, size: p.size });
      }
      accounts.push({
        exchange: exName,
        equity: Number(bal.equity ?? 0),
        marginUsed: Number(bal.marginUsed ?? 0),
        available: Number(bal.available ?? 0),
      });
    } catch { /* exchange not configured or unreachable */ }
  }
  return { positions, accounts };
}

async function runDaemonCycle(
  store: AlertStore,
  getAdapterFor?: (exchange: string) => Promise<import("../exchanges/interface.js").ExchangeAdapter>,
): Promise<string[]> {
  const triggered: string[] = [];
  const activeAlerts = store.alerts.filter(a => a.active);
  if (activeAlerts.length === 0) return triggered;

  const prices = await fetchPrices();
  const fundingRates = await fetchFundingRates();

  // Only fetch position data if there are pnl/liquidation alerts
  const hasPosAlerts = activeAlerts.some(a => a.type === "pnl" || a.type === "liquidation");
  const posData = hasPosAlerts ? await fetchPositionData(getAdapterFor) : null;

  for (const alert of activeAlerts) {
    let fire = false;
    let message = "";

    if (alert.type === "price") {
      const price = prices.get(alert.symbol.toUpperCase());
      if (price === undefined) continue;

      if (alert.condition === "above" && price >= alert.value) {
        fire = true;
        message = `🔔 *${alert.symbol}* price above $${formatUsd(alert.value)}\nCurrent: $${formatUsd(price)}`;
      } else if (alert.condition === "below" && price <= alert.value) {
        fire = true;
        message = `🔔 *${alert.symbol}* price below $${formatUsd(alert.value)}\nCurrent: $${formatUsd(price)}`;
      }
    }

    if (alert.type === "funding") {
      const rate = fundingRates.get(alert.symbol.toUpperCase());
      if (!rate) continue;

      if (rate.spread >= alert.value) {
        fire = true;
        message = `📊 *${alert.symbol}* funding spread: ${rate.spread.toFixed(1)}% annual\nPacifica: ${(rate.pac * 100).toFixed(4)}% | HL: ${(rate.hl * 100).toFixed(4)}%\nThreshold: ${alert.value}%`;
      }
    }

    if (alert.type === "pnl" && posData) {
      const sym = alert.symbol.toUpperCase();
      const relevantPos = sym === "ALL"
        ? posData.positions
        : posData.positions.filter(p => p.symbol.toUpperCase() === sym);
      const totalPnl = relevantPos.reduce((s, p) => s + p.pnl, 0);

      if (alert.condition === "loss" && totalPnl <= -alert.value) {
        fire = true;
        const posInfo = relevantPos.map(p => `${p.exchange} ${p.side} ${p.size}: $${p.pnl.toFixed(2)}`).join("\n");
        message = `🔴 *${sym}* uPnL: $${totalPnl.toFixed(2)} (threshold: -$${formatUsd(alert.value)})\n${posInfo}`;
      } else if (alert.condition === "profit" && totalPnl >= alert.value) {
        fire = true;
        const posInfo = relevantPos.map(p => `${p.exchange} ${p.side} ${p.size}: $${p.pnl.toFixed(2)}`).join("\n");
        message = `🟢 *${sym}* uPnL: +$${totalPnl.toFixed(2)} (threshold: $${formatUsd(alert.value)})\n${posInfo}`;
      }
    }

    if (alert.type === "liquidation" && posData) {
      for (const acct of posData.accounts) {
        if (acct.equity <= 0 || acct.marginUsed <= 0) continue;
        const marginRatio = ((acct.equity - acct.marginUsed) / acct.equity) * 100;
        if (marginRatio <= alert.value) {
          fire = true;
          message = `⚠️ *${acct.exchange}* margin ratio: ${marginRatio.toFixed(1)}% (threshold: ${alert.value}%)\nEquity: $${formatUsd(acct.equity)} | Margin: $${formatUsd(acct.marginUsed)} | Available: $${formatUsd(acct.available)}`;
          break; // one exchange triggering is enough
        }
      }
    }

    if (fire) {
      triggered.push(alert.id);
      await notify(store, alert, message);
    }
  }

  return triggered;
}

// ── Commands ──────────────────────────────────────

export function registerAlertCommands(
  program: Command,
  isJson: () => boolean,
  getAdapterFor?: (exchange: string) => Promise<import("../exchanges/interface.js").ExchangeAdapter>,
) {
  const alert = program.command("alert").description("Price & funding rate alerts (Telegram/Discord/Slack)");

  // ── configure notification channels ──

  alert
    .command("config")
    .description("Configure notification channels")
    .option("--telegram-token <token>", "Telegram bot token")
    .option("--telegram-chat <chatId>", "Telegram chat ID")
    .option("--discord <webhookUrl>", "Discord webhook URL")
    .option("--slack <webhookUrl>", "Slack webhook URL")
    .action(async (opts: { telegramToken?: string; telegramChat?: string; discord?: string; slack?: string }) => {
      const store = loadAlerts();

      if (opts.telegramToken) store.config.telegramBotToken = opts.telegramToken;
      if (opts.telegramChat) store.config.telegramChatId = opts.telegramChat;
      if (opts.discord) store.config.discordWebhook = opts.discord;
      if (opts.slack) store.config.slackWebhook = opts.slack;
      saveAlerts(store);

      if (isJson()) return printJson(jsonOk(store.config));

      console.log(chalk.green("\n  Notification config updated.\n"));
      if (store.config.telegramBotToken) console.log(`  Telegram: ${chalk.green("configured")}`);
      if (store.config.discordWebhook) console.log(`  Discord:  ${chalk.green("configured")}`);
      if (store.config.slackWebhook) console.log(`  Slack:    ${chalk.green("configured")}`);
      console.log();
    });

  // ── add alert ──

  alert
    .command("add")
    .description("Add a new alert")
    .requiredOption("-t, --type <type>", "Alert type: price, funding, pnl, liquidation")
    .requiredOption("-s, --symbol <symbol>", "Symbol (e.g., BTC, ETH, SOL) or 'ALL' for portfolio-wide")
    .option("--above <price>", "Price above threshold")
    .option("--below <price>", "Price below threshold")
    .option("--spread <pct>", "Funding spread threshold (annual %)")
    .option("--loss <usd>", "PnL loss threshold in USD (triggers when uPnL drops below -N)")
    .option("--profit <usd>", "PnL profit threshold in USD (triggers when uPnL exceeds N)")
    .option("--margin-pct <pct>", "Liquidation proximity: alert when margin ratio below N%")
    .option("--exchange <name>", "Exchange for pnl/liquidation alerts (default: all)")
    .option("--telegram", "Send to Telegram")
    .option("--discord", "Send to Discord")
    .option("--slack", "Send to Slack")
    .action(async (opts: {
      type: string; symbol: string;
      above?: string; below?: string; spread?: string;
      loss?: string; profit?: string; marginPct?: string; exchange?: string;
      telegram?: boolean; discord?: boolean; slack?: boolean;
    }) => {
      const channels: string[] = [];
      if (opts.telegram) channels.push("telegram");
      if (opts.discord) channels.push("discord");
      if (opts.slack) channels.push("slack");
      if (channels.length === 0) channels.push("telegram", "discord"); // default both

      let condition = "";
      let value = 0;

      if (opts.type === "price") {
        if (opts.above) { condition = "above"; value = parseFloat(opts.above); }
        else if (opts.below) { condition = "below"; value = parseFloat(opts.below); }
        else { console.error(chalk.red("  Price alert needs --above or --below")); process.exit(1); }
      } else if (opts.type === "funding") {
        value = parseFloat(opts.spread || "30");
        condition = "spread";
      } else if (opts.type === "pnl") {
        if (opts.loss) { condition = "loss"; value = parseFloat(opts.loss); }
        else if (opts.profit) { condition = "profit"; value = parseFloat(opts.profit); }
        else { console.error(chalk.red("  PnL alert needs --loss or --profit")); process.exit(1); }
      } else if (opts.type === "liquidation") {
        value = parseFloat(opts.marginPct || "20");
        condition = "margin_low";
      }

      const store = loadAlerts();
      const alert: Alert = {
        id: genId(),
        type: opts.type as Alert["type"],
        symbol: opts.symbol.toUpperCase(),
        condition,
        value,
        channels,
        active: true,
        createdAt: new Date().toISOString(),
      };
      store.alerts.push(alert);
      saveAlerts(store);

      if (isJson()) return printJson(jsonOk(alert));

      console.log(chalk.green(`\n  Alert added: ${alert.id}`));
      console.log(`  Type:      ${alert.type}`);
      console.log(`  Symbol:    ${alert.symbol}`);
      console.log(`  Condition: ${condition} ${value}`);
      console.log(`  Channels:  ${channels.join(", ")}\n`);
    });

  // ── list ──

  alert
    .command("list")
    .description("List all alerts")
    .action(async () => {
      const store = loadAlerts();
      if (isJson()) return printJson(jsonOk(store.alerts));

      if (store.alerts.length === 0) {
        console.log(chalk.gray("\n  No alerts configured. Use 'perp alert add' to create one.\n"));
        return;
      }

      console.log(chalk.cyan.bold("\n  Alerts\n"));
      for (const a of store.alerts) {
        const status = a.active ? chalk.green("ON") : chalk.gray("OFF");
        const desc = a.type === "price"
          ? `${a.symbol} ${a.condition} $${formatUsd(a.value)}`
          : a.type === "funding"
          ? `${a.symbol} spread > ${a.value}%`
          : a.type === "pnl"
          ? `${a.symbol} ${a.condition === "loss" ? "loss > -" : "profit >"} $${formatUsd(a.value)}`
          : `margin ratio < ${a.value}%`;
        console.log(`  ${status}  ${chalk.white.bold(a.id)}  ${desc}  → ${a.channels.join(", ")}`);
      }
      console.log();
    });

  // ── remove ──

  alert
    .command("remove <id>")
    .description("Remove an alert")
    .action(async (id: string) => {
      const store = loadAlerts();
      store.alerts = store.alerts.filter(a => a.id !== id);
      saveAlerts(store);
      if (isJson()) return printJson(jsonOk({ removed: id }));
      console.log(chalk.yellow(`\n  Alert ${id} removed.\n`));
    });

  // ── test ──

  alert
    .command("test")
    .description("Send a test notification to all configured channels")
    .action(async () => {
      const store = loadAlerts();
      const testAlert: Alert = {
        id: "test", type: "price", symbol: "TEST", condition: "test", value: 0,
        channels: ["telegram", "discord", "slack"], active: true, createdAt: "",
      };

      if (!isJson()) console.log(chalk.cyan("\n  Sending test notification...\n"));
      await notify(store, testAlert, "🧪 *perp-cli* test alert — notifications working!");
      if (isJson()) return printJson(jsonOk({ sent: true }));
      console.log(chalk.green("  Sent! Check your Telegram/Discord/Slack.\n"));
    });

  // ── daemon ──

  alert
    .command("daemon")
    .description("Run alert monitoring daemon (Ctrl+C to stop)")
    .option("--interval <seconds>", "Check interval in seconds", "30")
    .action(async (opts: { interval: string }) => {
      const intervalMs = parseInt(opts.interval) * 1000;
      const store = loadAlerts();
      const activeCount = store.alerts.filter(a => a.active).length;

      if (!isJson()) {
        console.log(chalk.cyan.bold("\n  Alert Daemon Started\n"));
        console.log(`  Active alerts: ${activeCount}`);
        console.log(`  Check interval: ${opts.interval}s`);
        console.log(`  Telegram: ${store.config.telegramBotToken ? chalk.green("yes") : chalk.gray("no")}`);
        console.log(`  Discord:  ${store.config.discordWebhook ? chalk.green("yes") : chalk.gray("no")}`);
        console.log(`  Slack:    ${store.config.slackWebhook ? chalk.green("yes") : chalk.gray("no")}`);
        console.log(chalk.gray("\n  Monitoring... (Ctrl+C to stop)\n"));
      }

      const run = async () => {
        try {
          const fresh = loadAlerts(); // re-read in case alerts were added
          const triggered = await runDaemonCycle(fresh, getAdapterFor);
          if (triggered.length > 0) {
            console.log(`  ${chalk.yellow("⚡")} ${new Date().toLocaleTimeString()} — Triggered: ${triggered.join(", ")}`);
          }
        } catch (err) {
          console.error(chalk.gray(`  Error: ${err instanceof Error ? err.message : String(err)}`));
        }
      };

      await run();
      setInterval(run, intervalMs);
      await new Promise(() => {}); // keep alive
    });
}
