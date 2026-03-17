import { Command } from "commander";
import chalk from "chalk";
import { createInterface } from "readline";
import { loadSettings, saveSettings, type AlertRule } from "../settings.js";
import { validateBotToken, sendDiscordDM, openDMChannel, type DiscordConfig } from "../discord.js";
import { printJson, jsonOk, formatPercent } from "../utils.js";
import { fetchAllFundingRates } from "../funding-rates.js";
import { annualizeRate } from "../funding.js";

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

export function registerAlertCommands(program: Command, isJson: () => boolean) {
  const alerts = program.command("alerts").description("Funding rate alert system (Discord DM)");

  // ── alerts setup ──

  alerts
    .command("setup")
    .description("Interactive Discord bot setup")
    .action(async () => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const settings = loadSettings();

        console.log(chalk.cyan.bold("\n  Discord Alert Setup\n"));

        // Check existing config
        if (settings.alerts.discord?.botToken) {
          const masked = settings.alerts.discord.botToken.slice(0, 10) + "...";
          console.log(chalk.gray(`  Current bot token: ${masked}`));
          console.log(chalk.gray(`  User ID: ${settings.alerts.discord.userId}\n`));
          const action = await ask(rl, "  Reconfigure? (y/N): ");
          if (action.toLowerCase() !== "y") {
            rl.close();
            return;
          }
        }

        console.log(chalk.white("  Step 1: Create a Discord bot"));
        console.log(chalk.gray("    1. Go to https://discord.com/developers/applications"));
        console.log(chalk.gray("    2. New Application → Bot → Reset Token → Copy"));
        console.log(chalk.gray("    3. Enable MESSAGE CONTENT intent"));
        console.log(chalk.gray("    4. OAuth2 → URL Generator → bot scope → Send Messages"));
        console.log(chalk.gray("    5. Invite the bot to any server you share\n"));

        const botToken = await ask(rl, "  Bot Token: ");
        if (!botToken) {
          console.log(chalk.red("  No token provided."));
          rl.close();
          return;
        }

        // Validate bot token
        console.log(chalk.gray("  Validating..."));
        const { valid, username } = await validateBotToken(botToken);
        if (!valid) {
          console.log(chalk.red("  Invalid bot token. Check and try again.\n"));
          rl.close();
          return;
        }
        console.log(chalk.green(`  Bot: ${username}\n`));

        console.log(chalk.white("  Step 2: Your Discord User ID"));
        console.log(chalk.gray("    Settings → Advanced → Developer Mode ON"));
        console.log(chalk.gray("    Right-click yourself → Copy User ID\n"));

        const userId = await ask(rl, "  User ID: ");
        if (!userId || !/^\d{17,20}$/.test(userId)) {
          console.log(chalk.red("  Invalid User ID (should be 17-20 digits).\n"));
          rl.close();
          return;
        }

        // Test DM
        console.log(chalk.gray("\n  Sending test DM..."));
        const config: DiscordConfig = { botToken, userId };
        try {
          const channelId = await openDMChannel(config);
          config.channelId = channelId;
          await sendDiscordDM(config, "perp-cli alert setup complete. You will receive funding rate alerts here.");
          console.log(chalk.green("  Test DM sent! Check your Discord.\n"));
        } catch (err) {
          console.log(chalk.red(`  Failed to send DM: ${err instanceof Error ? err.message : err}`));
          console.log(chalk.gray("  Make sure you share a server with the bot.\n"));
          rl.close();
          return;
        }

        // Save
        settings.alerts.discord = {
          botToken,
          userId,
          channelId: config.channelId,
        };
        saveSettings(settings);

        console.log(chalk.green.bold("  Setup complete!"));
        console.log(chalk.gray("  Config saved to ~/.perp/settings.json\n"));
        console.log(chalk.white("  Next steps:"));
        console.log(chalk.gray(`    perp alerts add ETH 30       # Alert when ETH funding > 30%`));
        console.log(chalk.gray(`    perp alerts add --all 50     # Alert any symbol > 50%`));
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
    .description("Send a test DM to verify Discord connection")
    .action(async () => {
      const settings = loadSettings();
      const dc = settings.alerts.discord;
      if (!dc?.botToken || !dc?.userId) {
        console.log(chalk.red("  Discord not configured. Run: perp alerts setup\n"));
        return;
      }
      try {
        await sendDiscordDM(dc, `[TEST] perp-cli alert system is working. ${new Date().toISOString()}`);
        if (isJson()) return printJson(jsonOk({ status: "sent" }));
        console.log(chalk.green("  Test DM sent!\n"));
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
      // When --all is used, the first positional becomes the threshold
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
      const dc = settings.alerts.discord;

      if (isJson()) {
        return printJson(jsonOk({
          discord: dc ? { configured: true, userId: dc.userId } : { configured: false },
          rules,
          intervalSec: settings.alerts.intervalSec,
          cooldownMin: settings.alerts.cooldownMin,
        }));
      }

      console.log(chalk.cyan.bold("\n  Alert Configuration\n"));

      // Discord status
      if (dc?.botToken) {
        console.log(`  Discord: ${chalk.green("configured")} (User: ${dc.userId})`);
      } else {
        console.log(`  Discord: ${chalk.red("not configured")} — run: perp alerts setup`);
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
    .action(async (opts: { interval?: string; cooldown?: string }) => {
      const settings = loadSettings();
      const dc = settings.alerts.discord;

      if (!dc?.botToken || !dc?.userId) {
        console.log(chalk.red("  Discord not configured. Run: perp alerts setup\n"));
        return;
      }

      const rules = settings.alerts.rules.filter(r => r.enabled);
      if (rules.length === 0) {
        console.log(chalk.red("  No active alert rules. Add one: perp alerts add ETH 30\n"));
        return;
      }

      const intervalSec = parseInt(opts.interval || String(settings.alerts.intervalSec)) || 300;
      const cooldownMin = parseInt(opts.cooldown || String(settings.alerts.cooldownMin)) || 60;

      // Track cooldowns per symbol to avoid spam
      const cooldowns = new Map<string, number>(); // symbol → last alert timestamp ms

      console.log(chalk.cyan.bold("\n  Funding Rate Alert Daemon\n"));
      console.log(chalk.gray(`  Rules:     ${rules.length} active`));
      console.log(chalk.gray(`  Interval:  ${intervalSec}s`));
      console.log(chalk.gray(`  Cooldown:  ${cooldownMin}min`));
      console.log(chalk.gray(`  Discord:   ${dc.userId}`));
      console.log(chalk.gray(`  Press Ctrl+C to stop\n`));

      // Send startup DM
      try {
        await sendDiscordDM(dc, `Alert daemon started — monitoring ${rules.length} rule(s) every ${intervalSec}s`);
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
                // Match symbol
                if (rule.symbol !== "*" && rule.symbol !== comparison.symbol) continue;
                // Match exchange
                if (rule.exchange !== "*" && rule.exchange !== rate.exchange) continue;

                // Check threshold
                const triggered = rule.direction === "above"
                  ? annualPct >= rule.threshold
                  : annualPct <= rule.threshold;

                if (!triggered) continue;

                // Check cooldown
                const cooldownKey = `${comparison.symbol}:${rate.exchange}:${rule.id}`;
                const lastAlert = cooldowns.get(cooldownKey) ?? 0;
                if (Date.now() - lastAlert < cooldownMin * 60_000) continue;

                // Fire alert
                cooldowns.set(cooldownKey, Date.now());
                alertCount++;

                const exAbbr = rate.exchange === "pacifica" ? "PAC" : rate.exchange === "hyperliquid" ? "HL" : "LT";
                const sign = rate.annualizedPct > 0 ? "+" : "";
                const msg = [
                  `**${comparison.symbol}** funding alert`,
                  `${exAbbr}: ${sign}${rate.annualizedPct.toFixed(1)}% annual (raw: ${(rate.fundingRate * 100).toFixed(4)}%)`,
                  `Threshold: ${rule.direction} ${rule.threshold}%`,
                  `Price: $${comparison.bestMarkPrice.toLocaleString()}`,
                ].join("\n");

                try {
                  await sendDiscordDM(dc, msg);
                } catch (err) {
                  console.log(chalk.red(`  [${ts}] Discord send failed: ${err instanceof Error ? err.message : err}`));
                }
              }
            }
          }

          const symbolCount = snapshot.symbols.length;
          console.log(chalk.gray(`  [${ts}] Cycle ${cycle} — ${symbolCount} symbols checked, ${alertCount} alert(s) fired`));
        } catch (err) {
          console.log(chalk.red(`  [${ts}] Error: ${err instanceof Error ? err.message : err}`));
        }
      };

      // Initial check
      await check();

      // Loop
      const timer = setInterval(check, intervalSec * 1000);
      process.on("SIGINT", () => {
        clearInterval(timer);
        console.log(chalk.gray("\n  Alert daemon stopped.\n"));
        process.exit(0);
      });

      // Keep alive
      await new Promise(() => {});
    });
}
