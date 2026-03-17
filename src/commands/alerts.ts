import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { loadSettings, saveSettings, type AlertRule, type AlertSettings } from "../settings.js";
import { validateBotToken as validateDiscordBot, sendDiscordDM, openDMChannel, type DiscordConfig } from "../discord.js";
import { validateTelegramBot, sendTelegramMessage, getRecentChatId, type TelegramConfig } from "../telegram.js";
import { printJson, jsonOk } from "../utils.js";
import { fetchAllFundingRates } from "../funding-rates.js";

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

function askChoice(rl: ReturnType<typeof createInterface>, question: string, choices: string[]): Promise<string> {
  return new Promise((resolve) => {
    const choiceStr = choices.map((c, i) => `${i + 1}) ${c}`).join("  ");
    rl.question(`${question} [${choiceStr}]: `, (answer) => {
      const trimmed = answer.trim();
      const idx = parseInt(trimmed) - 1;
      if (idx >= 0 && idx < choices.length) return resolve(choices[idx]);
      const match = choices.find((c) => c.toLowerCase().startsWith(trimmed.toLowerCase()));
      resolve(match || choices[0]);
    });
  });
}

/** Send alert message to all configured channels (Telegram and/or Discord) */
async function sendAlert(alerts: AlertSettings, message: string): Promise<void> {
  const errors: string[] = [];

  if (alerts.telegram?.botToken && alerts.telegram?.chatId) {
    try {
      await sendTelegramMessage(alerts.telegram, message);
    } catch (err) {
      errors.push(`Telegram: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (alerts.discord?.botToken && alerts.discord?.userId) {
    try {
      await sendDiscordDM(alerts.discord, message);
    } catch (err) {
      errors.push(`Discord: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (errors.length > 0 && !alerts.telegram && !alerts.discord) {
    throw new Error("No messaging service configured");
  }
}

function hasAnyService(alerts: AlertSettings): boolean {
  return !!(alerts.telegram?.botToken || alerts.discord?.botToken);
}

function serviceStatus(alerts: AlertSettings): string[] {
  const parts: string[] = [];
  if (alerts.telegram?.botToken) parts.push(`Telegram (${alerts.telegram.chatId})`);
  if (alerts.discord?.botToken) parts.push(`Discord (${alerts.discord.userId})`);
  return parts;
}

export function registerAlertCommands(program: Command, isJson: () => boolean) {
  const alerts = program.command("alerts").description("Funding rate alerts (Telegram / Discord)");

  // ── alerts setup ──

  alerts
    .command("setup")
    .description("Interactive alert setup (Telegram or Discord)")
    .action(async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const settings = loadSettings();

        console.log(chalk.cyan.bold("\n  Alert Setup\n"));

        // Show existing config
        const services = serviceStatus(settings.alerts);
        if (services.length > 0) {
          console.log(chalk.gray(`  Configured: ${services.join(", ")}\n`));
        }

        const service = await askChoice(rl, "  Service", ["Telegram", "Discord"]);

        if (service === "Telegram") {
          await setupTelegram(rl, settings);
        } else {
          await setupDiscord(rl, settings);
        }

        saveSettings(settings);

        console.log(chalk.green.bold("\n  Setup complete!"));
        console.log(chalk.gray("  Config saved to ~/.perp/settings.json\n"));
        console.log(chalk.white("  Next steps:"));
        console.log(chalk.gray(`    perp alerts add ETH 30       # ETH funding > 30% alert`));
        console.log(chalk.gray(`    perp alerts add --all 50     # Any symbol > 50%`));
        console.log(chalk.gray(`    perp alerts start            # Start monitoring\n`));

        rl.close();
      } catch (err) {
        rl.close();
        throw err;
      }
    });

  // ── alerts test ──

  alerts
    .command("test")
    .description("Send a test message to verify connection")
    .action(async () => {
      const settings = loadSettings();
      if (!hasAnyService(settings.alerts)) {
        console.log(chalk.red("  Not configured. Run: perp alerts setup\n"));
        return;
      }
      const msg = `[TEST] perp-cli alert system is working. ${new Date().toISOString()}`;
      try {
        await sendAlert(settings.alerts, msg);
        if (isJson()) return printJson(jsonOk({ status: "sent", services: serviceStatus(settings.alerts) }));
        console.log(chalk.green(`  Test message sent! (${serviceStatus(settings.alerts).join(", ")})\n`));
      } catch (err) {
        if (isJson()) return printJson(jsonOk({ error: String(err) }));
        console.log(chalk.red(`  Failed: ${err instanceof Error ? err.message : err}\n`));
      }
    });

  // ── alerts add ──

  alerts
    .command("add")
    .description("Add a funding rate alert rule")
    .argument("[symbol]", "Symbol to monitor (e.g. ETH, BTC)")
    .argument("[threshold]", "Annual funding rate % threshold")
    .option("--all", "Monitor all symbols")
    .option("--exchange <ex>", "Filter by exchange (hl, pac, lt)")
    .option("--below", "Alert when rate drops below threshold (default: above)")
    .action((symbol: string | undefined, thresholdStr: string | undefined, opts: { all?: boolean; exchange?: string; below?: boolean }) => {
      const sym = opts.all ? "*" : symbol?.toUpperCase();
      const rawThreshold = opts.all && symbol && !thresholdStr ? symbol : thresholdStr;
      const threshold = parseFloat(rawThreshold || "30");

      if (!sym) {
        console.log(chalk.red("  Specify a symbol or use --all\n"));
        return;
      }
      if (isNaN(threshold) || threshold <= 0) {
        console.log(chalk.red("  Threshold must be a positive number (annual %)\n"));
        return;
      }

      const aliasMap: Record<string, string> = { hl: "hyperliquid", pac: "pacifica", lt: "lighter" };
      const exchange = opts.exchange ? (aliasMap[opts.exchange.toLowerCase()] || opts.exchange.toLowerCase()) : "*";

      const settings = loadSettings();
      const rule: AlertRule = {
        id: `${sym}-${exchange}-${Date.now()}`,
        symbol: sym,
        exchange,
        threshold,
        direction: opts.below ? "below" : "above",
        enabled: true,
      };

      settings.alerts.rules.push(rule);
      saveSettings(settings);

      if (isJson()) return printJson(jsonOk(rule));
      const exLabel = exchange === "*" ? "all exchanges" : exchange;
      const dirLabel = opts.below ? "below" : "above";
      console.log(chalk.green(`  Alert added: ${sym === "*" ? "ALL" : sym} on ${exLabel} — ${dirLabel} ${threshold}% annual\n`));
    });

  // ── alerts list ──

  alerts
    .command("list")
    .description("List configured alert rules")
    .action(() => {
      const settings = loadSettings();
      const rules = settings.alerts.rules;
      const tg = settings.alerts.telegram;
      const dc = settings.alerts.discord;

      if (isJson()) {
        return printJson(jsonOk({
          telegram: tg ? { configured: true, chatId: tg.chatId } : { configured: false },
          discord: dc ? { configured: true, userId: dc.userId } : { configured: false },
          rules,
          intervalSec: settings.alerts.intervalSec,
          cooldownMin: settings.alerts.cooldownMin,
        }));
      }

      console.log(chalk.cyan.bold("\n  Alert Configuration\n"));

      if (tg?.botToken) {
        console.log(`  Telegram: ${chalk.green("configured")} (Chat: ${tg.chatId})`);
      } else {
        console.log(`  Telegram: ${chalk.gray("not configured")}`);
      }
      if (dc?.botToken) {
        console.log(`  Discord:  ${chalk.green("configured")} (User: ${dc.userId})`);
      } else {
        console.log(`  Discord:  ${chalk.gray("not configured")}`);
      }
      if (!tg?.botToken && !dc?.botToken) {
        console.log(chalk.yellow(`  Run: perp alerts setup`));
      }
      console.log(`  Interval: ${settings.alerts.intervalSec}s | Cooldown: ${settings.alerts.cooldownMin}min\n`);

      if (rules.length === 0) {
        console.log(chalk.gray("  No alert rules. Add one: perp alerts add ETH 30\n"));
        return;
      }

      console.log(chalk.white("  Rules:"));
      for (const r of rules) {
        const sym = r.symbol === "*" ? "ALL" : r.symbol;
        const ex = r.exchange === "*" ? "all" : r.exchange;
        const dir = r.direction === "above" ? ">" : "<";
        const status = r.enabled ? chalk.green("ON") : chalk.gray("OFF");
        console.log(`    ${status}  ${chalk.white.bold(sym.padEnd(6))} ${ex.padEnd(12)} ${dir} ${r.threshold}% annual`);
      }
      console.log();
    });

  // ── alerts remove ──

  alerts
    .command("remove")
    .description("Remove an alert rule")
    .argument("<symbol>", "Symbol to remove (or 'all')")
    .action((symbol: string) => {
      const settings = loadSettings();
      const sym = symbol.toUpperCase();
      const before = settings.alerts.rules.length;

      if (sym === "ALL") {
        settings.alerts.rules = [];
      } else {
        settings.alerts.rules = settings.alerts.rules.filter(r => r.symbol !== sym);
      }

      const removed = before - settings.alerts.rules.length;
      saveSettings(settings);

      if (isJson()) return printJson(jsonOk({ removed, remaining: settings.alerts.rules.length }));
      if (removed > 0) {
        console.log(chalk.green(`  Removed ${removed} rule(s) for ${sym}\n`));
      } else {
        console.log(chalk.gray(`  No rules found for ${sym}\n`));
      }
    });

  // ── alerts start ──

  alerts
    .command("start")
    .description("Start funding rate alert daemon")
    .option("--interval <sec>", "Check interval in seconds")
    .option("--cooldown <min>", "Cooldown per symbol after alert fires (minutes)")
    .option("--background", "Run in background (tmux)")
    .action(async (opts: { interval?: string; cooldown?: string; background?: boolean }) => {
      const settings = loadSettings();

      if (!hasAnyService(settings.alerts)) {
        console.log(chalk.red("  No messaging service configured. Run: perp alerts setup\n"));
        return;
      }

      const rules = settings.alerts.rules.filter(r => r.enabled);
      if (rules.length === 0) {
        console.log(chalk.red("  No active alert rules. Add one: perp alerts add ETH 30\n"));
        return;
      }

      const intervalSec = parseInt(opts.interval || String(settings.alerts.intervalSec)) || 300;
      const cooldownMin = parseInt(opts.cooldown || String(settings.alerts.cooldownMin)) || 60;

      // ── Background mode: launch in tmux ──
      if (opts.background) {
        const { execSync } = await import("child_process");
        try { execSync("which tmux", { stdio: "ignore" }); } catch {
          console.log(chalk.red("  tmux required for --background. Install: brew install tmux\n"));
          return;
        }

        const session = `perp-alerts-${Date.now().toString(36)}`;
        const nodeCmd = process.argv[0];
        const cliPath = process.argv[1];
        const args = [
          "alerts", "start",
          "--interval", String(intervalSec),
          "--cooldown", String(cooldownMin),
        ].join(" ");

        // Pass through env vars for keys
        const envKeys = ["LIGHTER_PRIVATE_KEY", "LIGHTER_API_KEY", "LIGHTER_ACCOUNT_INDEX", "HL_PRIVATE_KEY", "PACIFICA_PRIVATE_KEY", "PRIVATE_KEY"];
        const envStr = envKeys.filter(k => process.env[k]).map(k => `${k}='${process.env[k]}'`).join(" ");

        const cmd = `${envStr} ${nodeCmd} ${cliPath} ${args}`;
        execSync(`tmux new-session -d -s ${session} '${cmd.replace(/'/g, "'\\''")}'`);

        if (isJson()) return printJson(jsonOk({ status: "started", session, rules: rules.length, interval: intervalSec }));
        console.log(chalk.green(`\n  Alert daemon started in background.`));
        console.log(`  Session: ${chalk.white.bold(session)}`);
        console.log(`  Rules:   ${rules.length} active, ${intervalSec}s interval`);
        console.log(`  Attach:  ${chalk.gray(`tmux attach -t ${session}`)}`);
        console.log(`  Stop:    ${chalk.gray(`tmux kill-session -t ${session}`)}\n`);
        return;
      }

      // ── Foreground mode ──
      const cooldowns = new Map<string, number>();
      const services = serviceStatus(settings.alerts);
      console.log(chalk.cyan.bold("\n  Funding Rate Alert Daemon\n"));
      console.log(chalk.gray(`  Rules:     ${rules.length} active`));
      console.log(chalk.gray(`  Interval:  ${intervalSec}s`));
      console.log(chalk.gray(`  Cooldown:  ${cooldownMin}min`));
      console.log(chalk.gray(`  Send via:  ${services.join(", ")}`));
      console.log(chalk.gray(`  Press Ctrl+C to stop\n`));

      try {
        await sendAlert(settings.alerts, `Alert daemon started — ${rules.length} rule(s), ${intervalSec}s interval`);
      } catch { /* non-critical */ }

      let cycle = 0;

      const check = async () => {
        cycle++;
        const ts = new Date().toLocaleTimeString();
        try {
          const snapshot = await fetchAllFundingRates();
          let alertCount = 0;

          for (const comparison of snapshot.symbols) {
            for (const rate of comparison.rates) {
              const annualPct = Math.abs(rate.annualizedPct);

              for (const rule of rules) {
                if (rule.symbol !== "*" && rule.symbol !== comparison.symbol) continue;
                if (rule.exchange !== "*" && rule.exchange !== rate.exchange) continue;

                const triggered = rule.direction === "above"
                  ? annualPct >= rule.threshold
                  : annualPct <= rule.threshold;
                if (!triggered) continue;

                const cooldownKey = `${comparison.symbol}:${rate.exchange}:${rule.id}`;
                const lastAlert = cooldowns.get(cooldownKey) ?? 0;
                if (Date.now() - lastAlert < cooldownMin * 60_000) continue;

                cooldowns.set(cooldownKey, Date.now());
                alertCount++;

                const exAbbr = rate.exchange === "pacifica" ? "PAC" : rate.exchange === "hyperliquid" ? "HL" : "LT";
                const sign = rate.annualizedPct > 0 ? "+" : "";
                const msg = [
                  `${comparison.symbol} funding alert`,
                  `${exAbbr}: ${sign}${rate.annualizedPct.toFixed(1)}% annual (raw: ${(rate.fundingRate * 100).toFixed(4)}%)`,
                  `Threshold: ${rule.direction} ${rule.threshold}%`,
                  `Price: $${comparison.bestMarkPrice.toLocaleString()}`,
                ].join("\n");

                try {
                  await sendAlert(settings.alerts, msg);
                } catch (err) {
                  console.log(chalk.red(`  [${ts}] Send failed: ${err instanceof Error ? err.message : err}`));
                }
              }
            }
          }

          console.log(chalk.gray(`  [${ts}] Cycle ${cycle} — ${snapshot.symbols.length} symbols, ${alertCount} alert(s)`));
        } catch (err) {
          console.log(chalk.red(`  [${ts}] Error: ${err instanceof Error ? err.message : err}`));
        }
      };

      await check();
      const timer = setInterval(check, intervalSec * 1000);
      process.on("SIGINT", () => {
        clearInterval(timer);
        console.log(chalk.gray("\n  Alert daemon stopped.\n"));
        process.exit(0);
      });
      await new Promise(() => {});
    });

  // ── alerts stop ──

  alerts
    .command("stop")
    .description("Stop background alert daemon")
    .action(async () => {
      const { execSync } = await import("child_process");
      try {
        const sessions = execSync("tmux list-sessions -F '#{session_name}'", { encoding: "utf-8" })
          .trim().split("\n").filter(s => s.startsWith("perp-alerts-"));

        if (sessions.length === 0) {
          if (isJson()) return printJson(jsonOk({ status: "none" }));
          console.log(chalk.gray("  No alert daemon running.\n"));
          return;
        }

        for (const session of sessions) {
          try { execSync(`tmux kill-session -t ${session}`); } catch { /* already dead */ }
        }

        if (isJson()) return printJson(jsonOk({ status: "stopped", sessions }));
        console.log(chalk.green(`  Stopped ${sessions.length} alert daemon(s): ${sessions.join(", ")}\n`));
      } catch {
        if (isJson()) return printJson(jsonOk({ status: "no_tmux" }));
        console.log(chalk.gray("  No tmux sessions found.\n"));
      }
    });
}

// ── Setup flows ──

async function setupTelegram(rl: ReturnType<typeof createInterface>, settings: ReturnType<typeof loadSettings>) {
  console.log(chalk.cyan.bold("\n  Telegram Setup\n"));
  console.log(chalk.white("  Step 1: Create a bot"));
  console.log(chalk.gray("    1. Open Telegram, search @BotFather"));
  console.log(chalk.gray("    2. Send /newbot, follow prompts"));
  console.log(chalk.gray("    3. Copy the bot token\n"));

  const botToken = await ask(rl, "  Bot Token: ");
  if (!botToken) {
    console.log(chalk.red("  No token provided."));
    return;
  }

  console.log(chalk.gray("  Validating..."));
  const { valid, username } = await validateTelegramBot(botToken);
  if (!valid) {
    console.log(chalk.red("  Invalid bot token.\n"));
    return;
  }
  console.log(chalk.green(`  Bot: ${username}\n`));

  console.log(chalk.white("  Step 2: Get your Chat ID"));
  console.log(chalk.gray(`    1. Open Telegram, search ${username}`));
  console.log(chalk.gray("    2. Send /start to the bot"));
  console.log(chalk.gray("    3. Come back here\n"));

  const method = await askChoice(rl, "  How to get Chat ID?", ["auto-detect", "manual"]);

  let chatId = "";
  if (method === "auto-detect") {
    console.log(chalk.gray(`\n  Make sure you sent /start to ${username}, then press Enter...`));
    await ask(rl, "  ");

    console.log(chalk.gray("  Checking..."));
    const recent = await getRecentChatId(botToken);
    if (recent) {
      chatId = recent.chatId;
      console.log(chalk.green(`  Found: ${recent.firstName} (${chatId})\n`));
    } else {
      console.log(chalk.yellow("  No messages found. Enter Chat ID manually.\n"));
    }
  }

  if (!chatId) {
    console.log(chalk.gray("  You can find your Chat ID at @userinfobot or @RawDataBot\n"));
    chatId = await ask(rl, "  Chat ID: ");
  }

  if (!chatId) {
    console.log(chalk.red("  No Chat ID provided.\n"));
    return;
  }

  // Test message
  console.log(chalk.gray("  Sending test message..."));
  const config: TelegramConfig = { botToken, chatId };
  try {
    await sendTelegramMessage(config, "perp-cli alert setup complete. Funding rate alerts will be sent here.");
    console.log(chalk.green("  Test message sent! Check Telegram."));
  } catch (err) {
    console.log(chalk.red(`  Failed: ${err instanceof Error ? err.message : err}`));
    console.log(chalk.gray("  Make sure you sent /start to the bot first.\n"));
    return;
  }

  settings.alerts.telegram = { botToken, chatId };
}

async function setupDiscord(rl: ReturnType<typeof createInterface>, settings: ReturnType<typeof loadSettings>) {
  console.log(chalk.cyan.bold("\n  Discord Setup\n"));
  console.log(chalk.white("  Step 1: Create a bot"));
  console.log(chalk.gray("    1. Go to https://discord.com/developers/applications"));
  console.log(chalk.gray("    2. New Application → Bot → Reset Token → Copy"));
  console.log(chalk.gray("    3. Enable MESSAGE CONTENT intent"));
  console.log(chalk.gray("    4. OAuth2 → bot scope → Send Messages → Invite\n"));

  const botToken = await ask(rl, "  Bot Token: ");
  if (!botToken) {
    console.log(chalk.red("  No token provided."));
    return;
  }

  console.log(chalk.gray("  Validating..."));
  const { valid, username } = await validateDiscordBot(botToken);
  if (!valid) {
    console.log(chalk.red("  Invalid bot token.\n"));
    return;
  }
  console.log(chalk.green(`  Bot: ${username}\n`));

  console.log(chalk.white("  Step 2: Your User ID"));
  console.log(chalk.gray("    Settings → Advanced → Developer Mode → Right-click → Copy ID\n"));

  const userId = await ask(rl, "  User ID: ");
  if (!userId || !/^\d{17,20}$/.test(userId)) {
    console.log(chalk.red("  Invalid User ID.\n"));
    return;
  }

  console.log(chalk.gray("  Sending test DM..."));
  const config: DiscordConfig = { botToken, userId };
  try {
    const channelId = await openDMChannel(config);
    config.channelId = channelId;
    await sendDiscordDM(config, "perp-cli alert setup complete. Funding rate alerts will be sent here.");
    console.log(chalk.green("  Test DM sent! Check Discord."));
  } catch (err) {
    console.log(chalk.red(`  Failed: ${err instanceof Error ? err.message : err}`));
    return;
  }

  settings.alerts.discord = { botToken, userId, channelId: config.channelId };
}
