import { Command } from "commander";
import chalk from "chalk";
import { printJson, jsonOk, withJsonErrors } from "../utils.js";
import { loadSettings, saveSettings, type Settings, type ExchangeFees } from "../settings.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";

export function registerSettingsCommands(
  program: Command,
  isJson: () => boolean,
  getAdapterForExchange?: (exchange: string) => Promise<ExchangeAdapter>,
) {
  const settings = program.command("settings").description("CLI settings (referrals, defaults, fees)");

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
        console.log(chalk.white.bold("\n  Fee Tiers:"));
        for (const [ex, fee] of Object.entries(s.fees)) {
          const tPct = (fee.taker * 100).toFixed(4);
          const mPct = (fee.maker * 100).toFixed(4);
          console.log(`    ${ex.padEnd(14)} taker: ${tPct}%  maker: ${mPct}%`);
        }
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

  // ── settings fees ──
  const fees = settings
    .command("fees")
    .description("Show or sync exchange fee tiers");

  fees
    .command("show")
    .description("Show current fee tiers")
    .action(async () => {
      await withJsonErrors(isJson(), async () => {
        const s = loadSettings();
        if (isJson()) return printJson(jsonOk(s.fees));

        console.log(chalk.cyan.bold("\n  Exchange Fee Tiers\n"));
        for (const [ex, fee] of Object.entries(s.fees)) {
          const tPct = (fee.taker * 100).toFixed(4);
          const mPct = (fee.maker * 100).toFixed(4);
          console.log(`  ${ex.padEnd(14)} taker: ${chalk.yellow(tPct + "%")}  maker: ${chalk.green(mPct + "%")}`);
        }
        console.log(chalk.gray(`\n  Sync from exchanges: perp settings fees sync`));
        console.log(chalk.gray(`  Manual set: perp settings fees set <exchange> <taker> <maker>\n`));
      });
    });

  fees
    .command("sync")
    .description("Fetch fee tiers from exchange APIs and save")
    .option("--exchange <name>", "Sync only a specific exchange")
    .action(async (opts: { exchange?: string }) => {
      await withJsonErrors(isJson(), async () => {
        if (!getAdapterForExchange) {
          console.error(chalk.red("  Fee sync requires exchange adapters. Set up keys first with `perp init`."));
          return;
        }

        const s = loadSettings();
        const exchanges = opts.exchange ? [opts.exchange.toLowerCase()] : ["hyperliquid", "pacifica", "lighter"];
        const results: Record<string, ExchangeFees & { source: string }> = {};

        for (const ex of exchanges) {
          try {
            if (ex === "lighter") {
              // Lighter has 0% fees
              s.fees.lighter = { taker: 0, maker: 0 };
              results.lighter = { taker: 0, maker: 0, source: "known (0% fee exchange)" };
              if (!isJson()) console.log(chalk.green(`  ✓ lighter: taker 0% / maker 0% (no fees)`));
              continue;
            }

            if (ex === "hyperliquid") {
              const adapter = await getAdapterForExchange("hyperliquid");
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const hlAdapter = adapter as any;
              if (typeof hlAdapter.getUserFees === "function") {
                const feeData = await hlAdapter.getUserFees();
                // HL returns: { activeReferralDiscount, dailyUserVlm, feeSchedule: { ... }, userCrossRate, userAddRate }
                // userCrossRate is the effective taker fee, userAddRate is the maker fee
                const taker = parseFloat(feeData?.userCrossRate ?? feeData?.takerRate ?? "0.00035");
                const maker = parseFloat(feeData?.userAddRate ?? feeData?.makerRate ?? "0.00002");
                s.fees.hyperliquid = { taker: Math.abs(taker), maker };
                results.hyperliquid = { taker: Math.abs(taker), maker, source: "API (getUserFees)" };
                if (!isJson()) {
                  console.log(chalk.green(
                    `  ✓ hyperliquid: taker ${(Math.abs(taker) * 100).toFixed(4)}% / maker ${(maker * 100).toFixed(4)}%`
                  ));
                }
              } else {
                if (!isJson()) console.log(chalk.yellow(`  ⚠ hyperliquid: getUserFees not available, keeping current`));
              }
              continue;
            }

            if (ex === "pacifica") {
              const adapter = await getAdapterForExchange("pacifica");
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const pacAdapter = adapter as any;
              if (typeof pacAdapter.sdk?.getAccount === "function" && pacAdapter.publicKey) {
                const info = await pacAdapter.sdk.getAccount(pacAdapter.publicKey);
                const taker = parseFloat(info?.taker_fee ?? "0.00035");
                const maker = parseFloat(info?.maker_fee ?? "0.0001");
                s.fees.pacifica = { taker, maker };
                results.pacifica = { taker, maker, source: "API (getAccount)" };
                if (!isJson()) {
                  console.log(chalk.green(
                    `  ✓ pacifica: taker ${(taker * 100).toFixed(4)}% / maker ${(maker * 100).toFixed(4)}%`
                  ));
                }
              } else {
                if (!isJson()) console.log(chalk.yellow(`  ⚠ pacifica: account API not available, keeping current`));
              }
              continue;
            }

            if (!isJson()) console.log(chalk.yellow(`  ⚠ ${ex}: unknown exchange, skipped`));
          } catch (err) {
            if (!isJson()) {
              console.log(chalk.red(`  ✗ ${ex}: ${err instanceof Error ? err.message : String(err)}`));
            }
          }
        }

        saveSettings(s);

        if (isJson()) return printJson(jsonOk(results));
        console.log(chalk.gray("\n  Fees saved to ~/.perp/settings.json\n"));
      });
    });

  fees
    .command("set")
    .description("Manually set fee tier for an exchange")
    .argument("<exchange>", "Exchange name")
    .argument("<taker>", "Taker fee as percentage (e.g. 0.035 for 0.035%)")
    .argument("<maker>", "Maker fee as percentage (e.g. 0.01 for 0.01%)")
    .action(async (exchange: string, takerStr: string, makerStr: string) => {
      await withJsonErrors(isJson(), async () => {
        const s = loadSettings();
        const ex = exchange.toLowerCase();
        const taker = parseFloat((parseFloat(takerStr) / 100).toPrecision(10));
        const maker = parseFloat((parseFloat(makerStr) / 100).toPrecision(10));

        if (isNaN(taker) || isNaN(maker)) {
          console.error(chalk.red("  Invalid fee values. Use percentages, e.g.: perp settings fees set hyperliquid 0.035 0.002"));
          return;
        }

        s.fees[ex] = { taker, maker };
        saveSettings(s);

        if (isJson()) return printJson(jsonOk({ exchange: ex, taker, maker }));
        console.log(chalk.green(`\n  ${ex}: taker ${takerStr}% / maker ${makerStr}%\n`));
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
