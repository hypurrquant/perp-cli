#!/usr/bin/env node
// MUST be first import — installs a stderr filter for --json mode so SDK
// startup banners don't leak into machine output. ESM hoists all static
// imports to the top, but executes them in source order, so this side-effect
// import runs before any DEX SDK is loaded.
import "./_stderr-filter.js";

// Save original process.exit before any SDK (Go WASM) can patch it
const _origExit = process.exit.bind(process);
import { config } from "dotenv";
import { resolve } from "path";
import { createRequire } from "node:module";

// SSOT Rule #3: load only ~/.perp/.env. The CWD .env auto-load was removed
// because it caused master-address pollution when run from a project tree
// containing leftover dev keys (`wallet show` returned env-derived addresses
// instead of the OWS active wallet's). If you need ad-hoc env overrides,
// export them in your shell — keystore is the canonical source.
config({ path: resolve(process.env.HOME || "~", ".perp", ".env") });
import chalk from "chalk";
import { listVenues } from "./exchanges/venue.js";
import { optionsVenueWords } from "./exchanges/options-venues.js";
import { PerpError } from "./errors.js";
import { loadSettings } from "./settings.js";
import { jsonError, jsonOk, printCliError, printJson } from "./utils.js";
import { LANDING_EXCHANGES, asterAgentMissing as getAsterAgentMissing, renderLandingExchangeLine, type LandingExchangeStatus } from "./landing.js";
import { buildProgram, landingData, numericNetworkFlagError } from "./cli-program.js";

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

// Resolve default exchange from settings (fallback: "pacifica").
// A malformed settings.json is a hard stop (SSOT Rule #2): report it cleanly and exit.
function loadStartupSettings(): ReturnType<typeof loadSettings> {
  try {
    return loadSettings();
  } catch (err) {
    const s = err instanceof PerpError ? err.structured : null;
    const msg = err instanceof Error ? err.message : String(err);
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(jsonError(s?.code ?? "INVALID_PARAMS", msg, { status: s?.status ?? 400, retryable: false, remediation: s?.remediation })));
    } else {
      console.error(chalk.red(`Error: ${msg}`));
      if (s?.remediation) console.error(chalk.yellow(`  ${s.remediation}`));
    }
    process.exit(1);
  }
}
const _settings = loadStartupSettings();
const _defaultExchange = _settings.defaultExchange || "pacifica";

const { program, getAdapterForExchange, isJson } = buildProgram({ defaultExchange: _defaultExchange, version: _pkg.version });

// Smart landing page: `perp` with no subcommand
const rawArgs = process.argv.slice(2);
const _venueWords = [...listVenues().flatMap(v => [v.id, ...v.aliases]), ...optionsVenueWords()];
const hasSubcommand = rawArgs.some((a) => !a.startsWith("-") && ![..._venueWords, "mainnet", "testnet"].includes(a));

// `history list -n 5` (old record-count flag) → INVALID_PARAMS with the --limit migration, before
// Commander turns it into a bare "invalid network" usage error.
const _numericNetwork = numericNetworkFlagError(rawArgs);
if (_numericNetwork !== null) {
  printCliError(_numericNetwork, rawArgs.includes("--json"));
  _origExit(1);
}

if (rawArgs.length === 0 || (!hasSubcommand && !rawArgs.includes("-h") && !rawArgs.includes("--help") && !rawArgs.includes("-V") && !rawArgs.includes("--version"))) {
  // No subcommand — show smart landing instead of help dump.
  // Parse root options first so an invalid -n (e.g. "Testnet") is a usage error here too.
  program.parseOptions(rawArgs);
  if (isJson()) {
    // JSON mode: one landing / usage document on stdout — no banner, no venue reads.
    printJson(jsonOk(landingData(program, _pkg.version)));
    setTimeout(() => _origExit(0), 100);
  } else (async () => {
    try {
      const { getWalletSetupStatus } = await import("./commands/wallet.js");
      const status = getWalletSetupStatus();
      const settings = loadSettings();
      const hasEnvKey = !!(process.env.PRIVATE_KEY || process.env.PACIFICA_PRIVATE_KEY ||
        process.env.HL_PRIVATE_KEY || process.env.HYPERLIQUID_PRIVATE_KEY ||
        process.env.LIGHTER_PRIVATE_KEY || process.env.ASTER_PRIVATE_KEY);
      const hasOwsWallet = !!settings.owsActiveWallet;

      // ── ASCII banner ──
      const banner = [
        "",
        chalk.cyan("  ██████╗ ███████╗██████╗ ██████╗      ██████╗██╗     ██╗"),
        chalk.cyan("  ██╔══██╗██╔════╝██╔══██╗██╔══██╗    ██╔════╝██║     ██║"),
        chalk.cyan("  ██████╔╝█████╗  ██████╔╝██████╔╝    ██║     ██║     ██║"),
        chalk.cyan("  ██╔═══╝ ██╔══╝  ██╔══██╗██╔═══╝     ██║     ██║     ██║"),
        chalk.cyan("  ██║     ███████╗██║  ██║██║          ╚██████╗███████╗██║"),
        chalk.cyan("  ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝           ╚═════╝╚══════╝╚═╝"),
        "",
        chalk.gray(`  ${listVenues().length} exchanges · 19 strategies · v${_pkg.version}`),
      ];
      console.log(banner.join("\n"));

      if (!status.hasWallets && !hasEnvKey && !hasOwsWallet && !settings.defaultExchange) {
        // Fresh install — onboarding
        console.log(chalk.yellow.bold("\n  ⚡ Get started:\n"));
        console.log(`    ${chalk.cyan("perp wallet generate")}            create OWS encrypted wallet`);
        console.log(`    ${chalk.cyan("perp setup")}                      setup wizard`);
        console.log(chalk.gray(`\n  Explore without a wallet:`));
        console.log(`    ${chalk.green("perp market mid BTC")}            quick price check`);
        console.log(`    ${chalk.green("perp arb scan")}                  funding rate arbitrage`);
        console.log(`    ${chalk.green("perp market list")}               available markets`);
        console.log(`    ${chalk.green("perp --help")}                    all commands\n`);
      } else {
        // Configured — show exchange status + balance
        // Ping + balance in parallel (with 5s timeout to keep landing fast)
        const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
          Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

        // Aster venue ships only signed account endpoints — no public
        // address-based balance query exists (HL/PAC/LT all do). So when
        // a user has an env-PK but no Aster agent, every getBalance()
        // call throws NOT_SUPPORTED at venue. Detect that case here so
        // landing can surface a clear "agent required" hint instead of
        // a generic dash.
        const asterAgentMissing = getAsterAgentMissing();

        const { getVenue } = await import("./exchanges/venue.js");
        const { hasCredentials, NO_CLI_CREDENTIAL_OPTS } = await import("./config.js");
        // Market-data-only venues are listed as such; account venues are shown only when configured.
        const landingVenues: string[] = [];
        for (const ex of LANDING_EXCHANGES) {
          const def = getVenue(ex);
          if (!def.roles.includes("account") || await hasCredentials(def.id, NO_CLI_CREDENTIAL_OPTS)) landingVenues.push(ex);
        }
        const statusResults = await Promise.allSettled(landingVenues.map(async (ex): Promise<LandingExchangeStatus> => {
          if (!getVenue(ex).roles.includes("account")) {
            return { exchange: ex, marketDataOnly: true, unofficialApi: getVenue(ex).apiStatus.kind === "unofficial", ok: false, equity: 0, positions: 0 };
          }
          try {
            const adapter = await withTimeout(getAdapterForExchange(ex), 5000);
            const [balance, positions] = await withTimeout(Promise.all([adapter.getBalance(), adapter.getPositions()]), 5000);
            const posCount = positions.filter(p => Number(p.size) > 0).length;
            // Spot value on top of perp equity for venues with def.spot. Shared balances
            // (already in perp equity) are skipped; unpriced tokens are excluded + warned.
            let spotValue = 0;
            const spotDef = getVenue(ex);
            const warn = (msg: string) => process.stderr.write(`[warn] ${msg}\n`);
            try {
              const { getSpotAdapter, fetchValuedSpotBalances, SPOT_VALUATION_TIMEOUT_MS } = await import("./exchanges/spot-factory.js");
              const spot = await withTimeout(getSpotAdapter(spotDef.id, adapter), SPOT_VALUATION_TIMEOUT_MS);
              if (spot !== null) {
                for (const b of await fetchValuedSpotBalances(spotDef, spot, warn)) {
                  if (!b.shared) spotValue += b.valueUsd;
                }
              }
            } catch (e) {
              warn(`${spotDef.displayName} spot balances unavailable: ${e instanceof Error ? e.message : String(e)}`);
            }
            return { exchange: ex, ok: true, equity: Number(balance.equity) + spotValue, positions: posCount };
          } catch (err) {
            const { PerpError } = await import("./errors.js");
            const errorCode = err instanceof PerpError ? err.structured.code : undefined;
            return { exchange: ex, ok: false, equity: 0, positions: 0, errorCode };
          }
        }));

        console.log(chalk.white.bold("\n  Exchanges:"));
        let totalEquity = 0;
        let totalPositions = 0;
        for (const r of statusResults) {
          if (r.status !== "fulfilled") continue;
          const s = r.value;
          console.log(renderLandingExchangeLine(s, asterAgentMissing));
          if (s.ok) { totalEquity += s.equity; totalPositions += s.positions; }
        }

        if (totalEquity > 0) {
          console.log(chalk.gray("    ─".repeat(20)));
          console.log(`    ${chalk.white.bold("Total".padEnd(16))} ${chalk.white.bold(`$${totalEquity.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}${totalPositions > 0 ? chalk.yellow(` ${totalPositions} pos`) : ""}`);
        }

        console.log(chalk.white.bold("\n  Quick:"));
        console.log(`    ${chalk.green("perp portfolio")}             balances + positions + risk`);
        console.log(`    ${chalk.green("perp arb scan")}              funding arbitrage opportunities`);
        console.log(`    ${chalk.green("perp arb status")}            open arb positions + PnL`);
        console.log(`    ${chalk.green("perp portfolio --arb")}       full dashboard (balances + arb top 5)`);
        console.log(`    ${chalk.green("perp portfolio --serve")}     live web monitoring`);
        console.log(`    ${chalk.green("perp --help")}                all commands\n`);
      }
    } catch {
      program.help();
    }
    setTimeout(() => _origExit(0), 500);
  })();
} else {
program.parseAsync().then(() => {
  // Allow a short delay for any pending output, then exit cleanly.
  // Without this, HL SDK's WebSocket keeps the process alive indefinitely.
  // Keep a non-zero exitCode set by a command that printed its own failure (withJsonErrors).
  setTimeout(() => _origExit(Number(process.exitCode ?? 0)), 500);
}).catch(async (err) => {
  // Central printer (utils.printCliError): typed PerpError code / remediation / details
  // are preserved (Rule #2: stay loud, keep semantic envelope); generic Errors go
  // through classifyError; CAPABILITY_UNSUPPORTED prints the uniform line.
  const { printCliError } = await import("./utils.js");
  printCliError(err, isJson());
  _origExit(1);
});
}
