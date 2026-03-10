import { Command } from "commander";
import chalk from "chalk";
import { printJson, jsonOk, withJsonErrors } from "../utils.js";
import { loadSettings, saveSettings, type Settings } from "../settings.js";

export function registerSettingsCommands(program: Command, isJson: () => boolean) {
  const settings = program.command("settings").description("CLI settings (referrals, defaults)");

  // ── settings show ──
  settings
    .command("show")
    .description("Show current settings")
    .action(async () => {
      await withJsonErrors(isJson(), async () => {
        const s = loadSettings();
        if (isJson()) return printJson(jsonOk(s));

        console.log(chalk.cyan.bold("\n  CLI Settings\n"));
        console.log(`  Default Exchange: ${s.defaultExchange ? chalk.cyan(s.defaultExchange) : chalk.gray("pacifica (built-in)")}`);
        console.log(`  Referrals:        ${s.referrals ? chalk.green("ON") : chalk.gray("OFF (opt-in)")}`);
        console.log(chalk.white.bold("\n  Referral Codes:"));
        console.log(`    Pacifica:      ${s.referralCodes.pacifica || chalk.gray("(none)")}`);
        console.log(`    Hyperliquid:   ${s.referralCodes.hyperliquid || chalk.gray("(none)")}`);
        console.log(`    Lighter:       ${s.referralCodes.lighter || chalk.gray("(none)")}`);
        console.log(chalk.gray(`\n  Config: ~/.perp/settings.json\n`));
      });
    });

  // ── settings referrals ──
  settings
    .command("referrals")
    .description("Enable or disable referral codes")
    .argument("<action>", "on | off")
    .action(async (action: string) => {
      await withJsonErrors(isJson(), async () => {
        const s = loadSettings();
        if (action === "on") {
          s.referrals = true;
          // Reset applied flags so referrals get re-sent on next connection
          s.referralApplied = { hyperliquid: false, lighter: false };
          saveSettings(s);
          if (isJson()) return printJson(jsonOk({ referrals: true }));
          console.log(chalk.green("\n  Referrals enabled. Codes will be sent on next connection.\n"));
          if (s.referralCodes.pacifica) console.log(`  Pacifica builder code: ${s.referralCodes.pacifica}`);
          if (s.referralCodes.hyperliquid) console.log(`  Hyperliquid referral:  ${s.referralCodes.hyperliquid}`);
          if (s.referralCodes.lighter) console.log(`  Lighter referral:      ${s.referralCodes.lighter}`);
          console.log();
        } else if (action === "off") {
          s.referrals = false;
          saveSettings(s);
          if (isJson()) return printJson(jsonOk({ referrals: false }));
          console.log(chalk.yellow("\n  Referrals disabled. No codes will be sent.\n"));
        } else {
          console.error(chalk.red(`\n  Usage: perp settings referrals <on|off>\n`));
        }
      });
    });

  // ── settings set ──
  settings
    .command("set")
    .description("Set a specific setting")
    .argument("<key>", "Setting key (e.g. referralCodes.hyperliquid)")
    .argument("<value>", "Setting value")
    .action(async (key: string, value: string) => {
      await withJsonErrors(isJson(), async () => {
        const s = loadSettings();

        if (key === "default-exchange" || key === "defaultExchange") {
          const valid = ["pacifica", "hyperliquid", "lighter"];
          if (!valid.includes(value.toLowerCase())) {
            console.error(chalk.red(`  Invalid exchange: ${value}. Use: ${valid.join(", ")}`));
            return;
          }
          s.defaultExchange = value.toLowerCase();
        } else if (key === "referrals") {
          s.referrals = value === "true" || value === "on";
        } else if (key.startsWith("referralCodes.")) {
          const exchange = key.split(".")[1] as keyof Settings["referralCodes"];
          if (exchange in s.referralCodes) {
            s.referralCodes[exchange] = value;
          } else {
            console.error(chalk.red(`  Unknown exchange: ${exchange}`));
            return;
          }
        } else {
          console.error(chalk.red(`  Unknown key: ${key}`));
          console.log(chalk.gray("  Valid keys: default-exchange, referrals, referralCodes.pacifica, referralCodes.hyperliquid, referralCodes.lighter\n"));
          return;
        }

        saveSettings(s);
        if (isJson()) return printJson(jsonOk({ key, value }));
        console.log(chalk.green(`\n  ${key} = ${value}\n`));
      });
    });
}
