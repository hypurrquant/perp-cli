import { Command } from "commander";
import { QFEX_WITHDRAW_ENABLED } from "../exchanges/venues/qfex.js";
import { unsupported } from "../exchanges/trading-v2.js";
import chalk from "chalk";
import { printJson, jsonOk, withJsonErrors } from "../utils.js";
import { loadSettings, saveSettings, SHIPPED_DEFAULT_SLIPPAGE_BPS, type Settings, type ExchangeFees } from "../settings.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import { envFile, loadEnvFile, setEnvVar, EXCHANGE_ENV_MAP, validateKey } from "./init.js";
import { getVenue, resolveVenueId } from "../exchanges/venue.js";
import "../exchanges/venues/index.js";
import { maxDefaultSlippageBps, parseSlippageSettingBps } from "../exchanges/slippage.js";
import { PerpError } from "../errors.js";
import { isSecretEnvName } from "../secret-env.js";
import { BUILDER_FEE_CAPABILITIES, parseBuilderEntry, requireBuilderCapability } from "../exchanges/builder-fee.js";
import { validateDebridgeAffiliate, validateWithdrawGate, WITHDRAW_GATE_VENUES, type WithdrawGate, type WithdrawGateVenue } from "../settings.js";
import { confirmWithdrawGateChange } from "../withdraw-gate.js";

const invalidParam = (problem: string) => new PerpError("INVALID_PARAMS", problem, {
  remediation: "perp settings set builder.<venue> <address|code>,<feeBps> (e.g. builder.hyperliquid 0xabc…,1)",
});

/** `builder.<venue>` value "<address|code>,<feeBps>" → validated settings entry. */
function builderEntryOf(key: string, value: string): { venue: string; entry: Record<string, unknown> } {
  const venue = getVenue(key.slice("builder.".length)).id;
  const cap = requireBuilderCapability(venue);
  if (cap.feeKind === "share") {
    // Fee share (QFEX): the code only — there is no user-paid fee to configure.
    const entry: Record<string, unknown> = { code: value.trim() };
    parseBuilderEntry(venue, entry, problem => new PerpError("INVALID_PARAMS", problem, {
      remediation: `perp settings set builder.${venue} <uuid> (the builder code only — ${venue} builder codes share the venue fee; no feeBps)`,
    }));
    return { venue, entry };
  }
  const parts = value.split(",");
  if (parts.length !== 2) throw invalidParam(`${key} value must be "<${cap.identity}>,<feeBps>" (got "${value}")`);
  const fee = Number(parts[1].trim());
  const entry: Record<string, unknown> = { [cap.identity]: parts[0].trim(), feeBps: parts[1].trim() === "" ? NaN : fee };
  parseBuilderEntry(venue, entry, invalidParam); // strict: identity format, fee > 0, ≤ venue cap, venue increment
  return { venue, entry };
}

/**
 * L5: a builder.<venue> value charges the USER on every perp order, so setting one needs an
 * explicit y/N (or --yes) that shows the fee. Non-interactive / --json without --yes is refused.
 */
async function confirmBuilderSetting(venue: string, entry: Record<string, unknown>, yes: boolean, json: boolean): Promise<void> {
  if (yes) return;
  const cap = requireBuilderCapability(getVenue(venue).id);
  const fee = `${cap.feeKind === "max" ? "up to " : ""}${String(entry.feeBps)} bps`;
  const share = cap.feeKind === "share";
  const what = share
    ? `builder.${venue} = ${String(entry.code)}: your ${venue} fills are attributed to ${String(entry.code)}; you pay the normal fee (the venue shares part of it with the builder — no extra charge; attached to the trading connection from the next order)`
    : `builder.${venue} = ${String(entry[cap.identity])} charges ${fee} on YOUR ${venue} perp orders (paid by you, to the builder${cap.approval === "none" ? "; no venue approval step — attached from the next order" : ""})`;
  if (json || process.stdin.isTTY !== true) {
    throw new PerpError("INVALID_PARAMS", `Setting a builder ${share ? "code" : "fee"} needs explicit confirmation: ${what}`, {
      remediation: `Re-run with --yes to confirm: perp settings set builder.${venue} ${share ? "<uuid>" : `<${cap.identity}>,<feeBps>`} --yes`,
    });
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`  ${what}. Save? [y/N]: `)).trim().toLowerCase();
    if (a !== "y" && a !== "yes") throw new PerpError("INVALID_PARAMS", `builder.${venue} not set — cancelled, nothing was saved`);
  } finally {
    rl.close();
  }
}

/** Parse `slippageBps.<venue>` → venue id (aliases accepted). Throws UNKNOWN_VENUE. */
function slippageVenueOf(key: string) {
  const venue = getVenue(key.slice("slippageBps.".length));
  if (venue.capabilities === null) {
    throw unsupported(venue.displayName, "trading", "no trading API, so slippageBps does not apply", "Set slippageBps only for trading venues");
  }
  return venue.id;
}

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
        const defaultSlippageShipped = s.defaultSlippageBps === SHIPPED_DEFAULT_SLIPPAGE_BPS;
        if (isJson()) return printJson(jsonOk({ ...s, defaultSlippageBpsSource: defaultSlippageShipped ? "shipped default" : "user" }));

        console.log(chalk.cyan.bold("\n  CLI Settings\n"));
        console.log(`  Default Exchange: ${s.defaultExchange ? chalk.cyan(s.defaultExchange) : chalk.gray("pacifica (built-in)")}`);
        console.log(chalk.white.bold("\n  Referral Codes (bound only by an explicit `wallet manage referral set`):"));
        console.log(`    Hyperliquid:   ${s.referralCodes.hyperliquid || chalk.gray("(none)")}`);
        console.log(`    Lighter:       ${s.referralCodes.lighter || chalk.gray("(none)")}`);
        console.log(chalk.white.bold("\n  Builder fees (off unless set; attached only after venue approval):"));
        const builderEntries = Object.entries(s.builder);
        if (builderEntries.length === 0) console.log(chalk.gray("    (none — no builder fee is attached on any venue)"));
        for (const [v, e] of builderEntries) {
          const id = "address" in e ? e.address : e.code;
          const fee = "feeBps" in e ? `${e.feeBps} bps` : "fee share (you pay the normal fee)";
          console.log(`    ${v.padEnd(14)} ${id}  ${fee}${BUILDER_FEE_CAPABILITIES[v as keyof typeof BUILDER_FEE_CAPABILITIES]?.feeKind === "max" ? " (max)" : ""}`);
        }
        console.log(chalk.white.bold(`\n  Withdraw gate (qfex: API-key withdrawals${QFEX_WITHDRAW_ENABLED ? "" : " — currently disabled in perp-cli"}; hyperliquid: withdraw / transfer to a non-owner address; off unless set):`));
        const gates = Object.entries(s.withdraw) as [WithdrawGateVenue, WithdrawGate][];
        if (gates.length === 0) console.log(chalk.gray(`    (none — gated withdrawals on ${WITHDRAW_GATE_VENUES.join(", ")} are refused; Hyperliquid to the owner's own address is always allowed)`));
        for (const [v, g] of gates) console.log(`    ${v.padEnd(14)} max ${g.maxPerTx}/tx, ${g.maxPerDay}/day → ${g.allowlist.join(", ")}`);
        const aff = s.bridge.debridgeAffiliate;
        console.log(`  deBridge affiliate: ${aff === null ? chalk.gray("(none)") : `referral ${aff.referralCode ?? "-"} · fee ${aff.feePercent === null ? "none" : `${aff.feePercent}% → ${aff.feeRecipient}`}`}`);
        console.log(chalk.white.bold("\n  Slippage bound (bps) — market / close / trigger orders:"));
        console.log(`    ${"default".padEnd(14)} ${s.defaultSlippageBps}${defaultSlippageShipped ? chalk.gray(" (shipped default)") : ""}`);
        for (const [v, bps] of Object.entries(s.slippageBps)) console.log(`    ${v.padEnd(14)} ${bps}`);
        console.log(chalk.gray("    precedence: --slippage-bps → slippageBps.<venue> → default"));
        console.log(chalk.white.bold("\n  Fee Tiers:"));
        for (const [ex, fee] of Object.entries(s.fees)) {
          const tPct = (fee.taker * 100).toFixed(4);
          const mPct = (fee.maker * 100).toFixed(4);
          console.log(`    ${ex.padEnd(14)} taker: ${tPct}%  maker: ${mPct}%`);
        }
        console.log(chalk.gray(`\n  Config: ~/.perp/settings.json\n`));
      });
    });

  // HL / Lighter referral codes are applied only by the explicit
  // `perp -e <hyperliquid|lighter> wallet manage referral set [code]` (never on
  // adapter creation). referralCodes.<venue> is that command's default code.

  // ── settings fees ──
  // Bare `settings fees` shows current tiers (same as `settings fees show`).
  const showFees = async () => {
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
  };

  const fees = settings
    .command("fees")
    .description("Show or sync exchange fee tiers (default action: show)")
    .action(showFees);

  fees
    .command("show")
    .description("Show current fee tiers")
    .action(showFees);

  fees
    .command("sync")
    .description("Fetch fee tiers from exchange APIs and save (-e <exchange> to sync only one)")
    .action(async () => {
      await withJsonErrors(isJson(), async () => {
        // -e/--exchange is the root option: read it there only when it was passed on the command
        // line (never the root's default venue — no flag means "all").
        const only = program.getOptionValueSource("exchange") === "cli" ? String(program.opts().exchange) : undefined;
        if (!getAdapterForExchange) {
          console.error(chalk.red("  Fee sync requires exchange adapters. Set up keys first with `perp setup`."));
          return;
        }

        const s = loadSettings();
        const exchanges = only !== undefined ? [only.toLowerCase()] : ["hyperliquid", "pacifica", "lighter"];
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
    .option("--yes", "Confirm a builder.<venue> fee without the y/N prompt")
    .action(async (key: string, value: string, opts: { yes?: boolean }) => {
      await withJsonErrors(isJson(), async () => {
        const s = loadSettings();

        if (key === "default-exchange" || key === "defaultExchange") {
          s.defaultExchange = resolveVenueId(value);
        } else if (key === "defaultSlippageBps") {
          s.defaultSlippageBps = parseSlippageSettingBps(key, value, maxDefaultSlippageBps());
        } else if (key.startsWith("slippageBps.")) {
          const venue = slippageVenueOf(key);
          s.slippageBps[venue] = parseSlippageSettingBps(key, value, getVenue(venue).maxSlippageBps);
        } else if (key.startsWith("builder.")) {
          const { venue, entry } = builderEntryOf(key, value);
          await confirmBuilderSetting(venue, entry, opts.yes === true, isJson());
          (s.builder as Record<string, unknown>)[venue] = entry;
        } else if (key.startsWith("withdraw.")) {
          // settings.withdraw.<venue> = "<address[+address…]>,<maxPerTx>,<maxPerDay>". Changing the
          // allowlist / limits needs an interactive terminal confirmation — no --yes, never --json.
          const venue = getVenue(key.slice("withdraw.".length)).id;
          const parts = value.split(",");
          if (parts.length !== 3) {
            throw new PerpError("INVALID_PARAMS", `${key} value must be "<address[+address…]>,<maxPerTx>,<maxPerDay>" (got "${value}")`, {
              remediation: `e.g. perp settings set withdraw.${venue} 0xYourWallet,100,500`,
            });
          }
          const num = (raw: string): number => (raw.trim() === "" ? NaN : Number(raw.trim()));
          const gate = validateWithdrawGate(venue, {
            allowlist: parts[0].split("+").map(a => a.trim()).filter(a => a !== ""), maxPerTx: num(parts[1]), maxPerDay: num(parts[2]),
          }, problem => new PerpError("INVALID_PARAMS", problem));
          await confirmWithdrawGateChange(venue, gate, isJson());
          s.withdraw[venue as WithdrawGateVenue] = gate;
        } else if (key === "bridge.debridgeAffiliate.referralCode" || key === "bridge.debridgeAffiliate.fee") {
          const cur = s.bridge.debridgeAffiliate ?? { referralCode: null, feePercent: null, feeRecipient: null };
          let next: Record<string, unknown>;
          if (key.endsWith(".referralCode")) {
            next = { ...cur, referralCode: value };
          } else {
            const parts = value.split(",");
            if (parts.length !== 2) throw invalidParam(`${key} value must be "<percent>,<recipient>" (got "${value}")`);
            next = { ...cur, feePercent: parts[0].trim() === "" ? NaN : Number(parts[0].trim()), feeRecipient: parts[1].trim() };
          }
          s.bridge.debridgeAffiliate = validateDebridgeAffiliate(next, invalidParam);
        } else if (key.startsWith("referralCodes.")) {
          const exchange = key.split(".")[1] as keyof Settings["referralCodes"];
          if (exchange in s.referralCodes) {
            s.referralCodes[exchange] = value;
          } else {
            console.error(chalk.red(`  Unknown exchange: ${exchange}`));
            return;
          }
        } else if (key.startsWith("referralApplied.")) {
          // Bookkeeping only (set by `wallet manage referral set`).
          const exchange = key.split(".")[1] as keyof Settings["referralApplied"];
          if (exchange in s.referralApplied) {
            s.referralApplied[exchange] = value === "true" || value === "on";
          } else {
            console.error(chalk.red(`  Unknown exchange: ${exchange}`));
            return;
          }
        } else {
          console.error(chalk.red(`  Unknown key: ${key}`));
          console.log(chalk.gray("  Valid keys: default-exchange, referralCodes.{hyperliquid,lighter}, referralApplied.{hyperliquid,lighter}, defaultSlippageBps, slippageBps.<venue>, builder.<venue>, withdraw.<venue>, bridge.debridgeAffiliate.{referralCode,fee}\n"));
          return;
        }

        saveSettings(s);
        if (isJson()) return printJson(jsonOk({ key, value }));
        console.log(chalk.green(`\n  ${key} = ${value}\n`));
        if (key.startsWith("builder.")) {
          const venue = getVenue(key.slice("builder.".length)).id;
          const cap = requireBuilderCapability(venue);
          if (cap.feeKind === "share") {
            console.log(chalk.yellow(`  Your ${venue} fills are attributed to this builder code; you pay the normal fee (no extra charge).`));
            console.log(chalk.gray(`  Attribution cannot be confirmed from the trader side. Disable per command with --no-builder; remove with: perp settings unset builder.${venue}\n`));
            return;
          }
          console.log(chalk.yellow(`  This adds a builder fee to YOUR ${venue} perp orders (paid by you, to the builder).`));
          console.log(chalk.gray(cap.approval === "master"
            ? `  Nothing is attached until the venue approval is confirmed: perp wallet builder approve ${venue}\n  Disable per command with --no-builder; remove with: perp settings unset builder.${venue}\n`
            : `  ${venue} needs no approval — the fee is attached from the next order.\n  Disable per command with --no-builder; remove with: perp settings unset builder.${venue}\n`));
        }
      });
    });

  // ── settings unset ──
  settings
    .command("unset")
    .description("Remove a setting (slippageBps.<venue>, builder.<venue>, withdraw.<venue>, bridge.debridgeAffiliate; defaultSlippageBps restores the shipped default)")
    .argument("<key>", "Setting key (e.g. slippageBps.ondo)")
    .action(async (key: string) => {
      await withJsonErrors(isJson(), async () => {
        if (key === "defaultSlippageBps") {
          const s = loadSettings();
          s.defaultSlippageBps = SHIPPED_DEFAULT_SLIPPAGE_BPS;
          saveSettings(s);
          if (isJson()) return printJson(jsonOk({ key, value: SHIPPED_DEFAULT_SLIPPAGE_BPS, source: "shipped default" }));
          console.log(chalk.green(`\n  defaultSlippageBps = ${SHIPPED_DEFAULT_SLIPPAGE_BPS} (shipped default)\n`));
          return;
        }
        if (key.startsWith("builder.")) {
          const venue = getVenue(key.slice("builder.".length)).id;
          const s = loadSettings();
          const existed = (s.builder as Record<string, unknown>)[venue] !== undefined;
          delete (s.builder as Record<string, unknown>)[venue];
          saveSettings(s);
          if (isJson()) return printJson(jsonOk({ key: `builder.${venue}`, removed: existed }));
          console.log(existed ? chalk.green(`\n  builder.${venue} removed — no builder fee is attached on ${venue}\n`) : chalk.gray(`\n  builder.${venue} was not set\n`));
          return;
        }
        if (key.startsWith("withdraw.")) {
          // Removing the gate turns API-key withdrawals OFF for that venue — no confirmation needed.
          const venue = getVenue(key.slice("withdraw.".length)).id as WithdrawGateVenue;
          const s = loadSettings();
          const existed = s.withdraw[venue] !== undefined;
          delete s.withdraw[venue];
          saveSettings(s);
          if (isJson()) return printJson(jsonOk({ key: `withdraw.${venue}`, removed: existed }));
          console.log(existed ? chalk.green(`\n  withdraw.${venue} removed — withdrawals on ${venue} are refused until it is set again\n`) : chalk.gray(`\n  withdraw.${venue} was not set\n`));
          return;
        }
        if (key === "bridge.debridgeAffiliate") {
          const s = loadSettings();
          const existed = s.bridge.debridgeAffiliate !== null;
          s.bridge.debridgeAffiliate = null;
          saveSettings(s);
          if (isJson()) return printJson(jsonOk({ key, removed: existed }));
          console.log(existed ? chalk.green(`\n  ${key} removed\n`) : chalk.gray(`\n  ${key} was not set\n`));
          return;
        }
        if (!key.startsWith("slippageBps.")) {
          throw new PerpError("INVALID_PARAMS", `Cannot unset "${key}"`, { remediation: "Unsettable keys: defaultSlippageBps, slippageBps.<venue>, builder.<venue>, withdraw.<venue>, bridge.debridgeAffiliate" });
        }
        const venue = slippageVenueOf(key);
        const s = loadSettings();
        const existed = s.slippageBps[venue] !== undefined;
        delete s.slippageBps[venue];
        saveSettings(s);
        if (isJson()) return printJson(jsonOk({ key: `slippageBps.${venue}`, removed: existed }));
        console.log(existed ? chalk.green(`\n  slippageBps.${venue} removed\n`) : chalk.gray(`\n  slippageBps.${venue} was not set\n`));
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
        return printJson(jsonOk({ envFile: envFile(), exchanges: data }));
      }

      console.log(chalk.cyan.bold("\n  perp-cli Configuration\n"));
      console.log(`  File: ${chalk.gray(envFile())}\n`);

      if (results.length === 0) {
        console.log(chalk.gray("  No legacy keys in ~/.perp/.env. Import keys into the OWS vault: 'perp wallet set <exchange>'\n"));
        return;
      }

      for (const { name, address, source } of results) {
        console.log(`  ${chalk.cyan(name.padEnd(14))} ${chalk.green(address)}  ${chalk.gray(source)}`);
      }
      console.log();
    });

  // ── settings env set <name> <value> ──
  // Non-secret values only (e.g. LIGHTER_REFERRAL_CODE). SSOT Rule #3: key material is never
  // written to ~/.perp/.env nor accepted on argv — exchange keys go to the OWS vault.
  env
    .command("set <name> <value>")
    .description("Set a non-secret env value in ~/.perp/.env (private keys are refused: use 'perp wallet set <exchange>')")
    .action(async (name: string, value: string) => {
      await withJsonErrors(isJson(), async () => {
        const resolved = resolveEnvKey(name);
        if (resolved !== null || isSecretEnvName(name)) {
          throw new PerpError("INVALID_PARAMS", `Refusing to write ${resolved?.envKey ?? name} to ~/.perp/.env: key material is never stored in plaintext or accepted on the command line`, {
            remediation: resolved !== null
              ? "Import the key into the OWS vault: perp wallet set <exchange> (hidden prompt or stdin). Clear the key from your shell history."
              : "Secrets live in the OWS vault (perp wallet set / perp wallet import) or agent keystores (perp wallet agent approve <venue>). Clear the value from your shell history.",
          });
        }
        // Raw non-secret env var (e.g. LIGHTER_REFERRAL_CODE, custom vars)
        setEnvVar(name, value);

        if (isJson()) return printJson(jsonOk({ key: name, file: envFile() }));
        console.log(chalk.green(`\n  ${name} set.`));
        console.log(`  File: ${chalk.gray("~/.perp/.env")}\n`);
      });
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
      // Atomic write with an explicit 0600 (writeFileSync's mode only applies when creating the file:
      // a rewrite would keep looser permissions of an existing .env).
      const { writeKeystoreAtomic } = await import("../agent-wallet/venue-keystore.js");
      const lines = ["# perp-cli configuration", "# Generated by 'perp setup' — edit freely", ""];
      for (const [k, v] of Object.entries(env)) lines.push(`${k}=${v}`);
      lines.push("");
      writeKeystoreAtomic(envFile(), lines.join("\n"));

      if (isJson()) return printJson(jsonOk({ removed: envKey }));
      console.log(chalk.yellow(`\n  ${envKey} removed from ~/.perp/.env\n`));
    });

  // ── settings env path ──
  env
    .command("path")
    .description("Print env file path")
    .action(() => {
      if (isJson()) return printJson(jsonOk({ path: envFile() }));
      console.log(envFile());
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
      console.log(chalk.gray("    perp settings env set <name> <value>   (non-secret values only)"));
      console.log(chalk.gray("    perp settings env remove <name>"));
      console.log(chalk.gray("    perp settings env path\n"));
    });
  (deprecatedEnv as any)._hidden = true;
}
