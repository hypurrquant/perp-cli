import { Command } from "commander";
import chalk from "chalk";
import { printJson, jsonOk, jsonError, withJsonErrors } from "../utils.js";
import { loadSettings, saveSettings, type Settings, type ExchangeFees } from "../settings.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { ENV_FILE, loadEnvFile, setEnvVar, EXCHANGE_ENV_MAP, validateKey } from "./init.js";

// Resolve exchange alias → env var key
function resolveEnvKey(nameOrKey: string): { envKey: string; chain: "solana" | "evm" | "apikey" } | null {
  // Direct env var name
  const upper = nameOrKey.toUpperCase();
  for (const info of Object.values(EXCHANGE_ENV_MAP)) {
    if (info.envKey === upper) return { envKey: info.envKey, chain: info.chain };
  }
  // Exchange name alias
  const info = EXCHANGE_ENV_MAP[nameOrKey.toLowerCase()];
  if (info) return { envKey: info.envKey, chain: info.chain };
  // Common aliases
  const aliases: Record<string, string> = { hl: "hyperliquid", pac: "pacifica", lt: "lighter", ast: "aster" };
  const aliased = aliases[nameOrKey.toLowerCase()];
  if (aliased) return resolveEnvKey(aliased);
  return null;
}

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
          if (isJson()) return printJson(jsonError("INVALID_ARGS", `Invalid action "${action}". Usage: perp settings referrals <on|off>`));
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

  // ── settings env ──
  const env = settings.command("env").description("Manage ~/.perp/.env configuration");

  // ── settings env show ──
  env
    .command("show")
    .description("Show current configuration")
    .action(async () => {
      const stored = loadEnvFile();
      const entries: { name: string; chain: "solana" | "evm" | "apikey"; key: string; source: string }[] = [];

      for (const [exchange, info] of Object.entries(EXCHANGE_ENV_MAP)) {
        const fromFile = stored[info.envKey];
        const fromEnv = process.env[info.envKey];
        if (fromFile) {
          entries.push({ name: exchange, chain: info.chain, key: fromFile, source: "~/.perp/.env" });
        } else if (fromEnv) {
          entries.push({ name: exchange, chain: info.chain, key: fromEnv, source: "environment" });
        }
      }

      // Derive addresses
      const results: { name: string; address: string; source: string }[] = [];
      for (const entry of entries) {
        const { valid, address } = await validateKey(entry.chain, entry.key);
        results.push({ name: entry.name, address: valid ? address : "(invalid key)", source: entry.source });
      }

      if (isJson()) {
        const data = results.map((r) => ({ exchange: r.name, address: r.address, source: r.source }));
        return printJson(jsonOk({ envFile: ENV_FILE, exchanges: data }));
      }

      console.log(chalk.cyan.bold("\n  perp-cli Configuration\n"));
      console.log(`  File: ${chalk.gray(ENV_FILE)}\n`);

      if (results.length === 0) {
        console.log(chalk.gray("  No keys configured. Run 'perp init' or 'perp settings env set <exchange> <key>'\n"));
        return;
      }

      for (const { name, address, source } of results) {
        console.log(`  ${chalk.cyan(name.padEnd(14))} ${chalk.green(address)}  ${chalk.gray(source)}`);
      }
      console.log();
    });

  // ── settings env set <exchange|key> <value> ──
  env
    .command("set <name> <value>")
    .description("Set a key (exchange name or env var name)")
    .action(async (name: string, value: string) => {
      const resolved = resolveEnvKey(name);

      if (resolved) {
        // Validate the key
        const { valid, address } = await validateKey(resolved.chain, value);
        if (!valid) {
          if (isJson()) {
            const { jsonError } = await import("../utils.js");
            return printJson(jsonError("INVALID_PARAMS", `Invalid ${resolved.chain} private key`));
          }
          console.error(chalk.red(`\n  Invalid ${resolved.chain} private key.\n`));
          process.exit(1);
        }

        const normalized = resolved.chain === "evm"
          ? (value.startsWith("0x") ? value : `0x${value}`)
          : value;

        setEnvVar(resolved.envKey, normalized);

        if (isJson()) return printJson(jsonOk({ key: resolved.envKey, address, file: ENV_FILE }));
        console.log(chalk.green(`\n  ${resolved.envKey} set.`));
        console.log(`  Address: ${chalk.gray(address)}`);
        console.log(`  File:    ${chalk.gray("~/.perp/.env")}\n`);
      } else {
        // Raw env var (e.g. LIGHTER_API_KEY, custom vars)
        setEnvVar(name, value);

        if (isJson()) return printJson(jsonOk({ key: name, file: ENV_FILE }));
        console.log(chalk.green(`\n  ${name} set.`));
        console.log(`  File: ${chalk.gray("~/.perp/.env")}\n`);
      }
    });

  // ── settings env remove <name> ──
  env
    .command("remove <name>")
    .description("Remove a key from ~/.perp/.env")
    .action(async (name: string) => {
      const resolved = resolveEnvKey(name);
      const envKey = resolved?.envKey || name;

      const env = loadEnvFile();
      if (!(envKey in env)) {
        if (isJson()) {
          const { jsonError } = await import("../utils.js");
          return printJson(jsonError("NOT_FOUND", `${envKey} not found in ~/.perp/.env`));
        }
        console.log(chalk.gray(`\n  ${envKey} not found in ~/.perp/.env\n`));
        return;
      }

      delete env[envKey];
      // Rewrite file
      const { writeFileSync } = await import("fs");
      const lines = ["# perp-cli configuration", "# Generated by 'perp init' — edit freely", ""];
      for (const [k, v] of Object.entries(env)) lines.push(`${k}=${v}`);
      lines.push("");
      writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });

      if (isJson()) return printJson(jsonOk({ removed: envKey }));
      console.log(chalk.yellow(`\n  ${envKey} removed from ~/.perp/.env\n`));
    });

  // ── settings env path ──
  env
    .command("path")
    .description("Print env file path")
    .action(() => {
      if (isJson()) return printJson(jsonOk({ path: ENV_FILE }));
      console.log(ENV_FILE);
    });

  // ── Deprecated top-level `env` command ──
  const deprecatedEnv = program
    .command("env")
    .description("[deprecated] Use 'perp settings env'")
    .allowUnknownOption()
    .action(() => {
      console.log(chalk.yellow("\n  'perp env' is deprecated. Use 'perp settings env' instead.\n"));
      console.log(chalk.gray("  Examples:"));
      console.log(chalk.gray("    perp settings env show"));
      console.log(chalk.gray("    perp settings env set <exchange> <key>"));
      console.log(chalk.gray("    perp settings env remove <name>"));
      console.log(chalk.gray("    perp settings env path\n"));
    });
  (deprecatedEnv as any)._hidden = true;
}
