#!/usr/bin/env node
import { config } from "dotenv";
import { resolve } from "path";
import { createRequire } from "node:module";

// Load ~/.perp/.env first (global), then CWD .env (overrides)
config({ path: resolve(process.env.HOME || "~", ".perp", ".env") });
config();
import { Command } from "commander";
import chalk from "chalk";
import type { Network } from "./pacifica/index.js";
import { Keypair } from "@solana/web3.js";
import { tryLoadPrivateKey, parseSolanaKeypair, type Exchange } from "./config.js";
import { PacificaAdapter } from "./exchanges/pacifica.js";
import { HyperliquidAdapter } from "./exchanges/hyperliquid.js";
// LighterAdapter is lazy-imported to avoid CJS/ESM issues at startup
import type { LighterAdapter } from "./exchanges/lighter.js";
import type { ExchangeAdapter } from "./exchanges/interface.js";
import { resolveExchangeName } from "./exchanges/registry.js";
import { registerMarketCommands } from "./commands/market.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerTradeCommands } from "./commands/trade.js";
import { registerManageCommands } from "./commands/manage.js";
// stream commands removed — WS feeds still used by dashboard/event-stream internally
import { registerArbCommands } from "./commands/arb.js";
import { registerWalletCommands } from "./commands/wallet.js";
import { registerBridgeCommands } from "./commands/bridge.js";
// deposit + withdraw merged into funds
import { registerFundsCommands } from "./commands/funds.js";
// alert commands removed
import { registerArbAutoCommands } from "./commands/arb-auto.js";
import { registerArbManageCommands } from "./commands/arb/index.js";
import { registerAgentCommands } from "./commands/agent.js";
import { registerRebalanceCommands } from "./commands/rebalance.js";
import { registerBotCommands } from "./commands/bot.js";
import { registerRiskCommands } from "./commands/risk.js";
import { registerHistoryCommands } from "./commands/history.js";
import { registerSettingsCommands } from "./commands/settings.js";
// dex commands merged into market (hip3) — use --dex flag for markets/balance
import { registerPlanCommands } from "./commands/plan.js";
// funding merged into arb.ts
import { registerBacktestCommands } from "./commands/backtest.js";
import { registerDashboardCommands } from "./commands/dashboard.js";
import { registerInitCommand, EXCHANGE_ENV_MAP, validateKey } from "./commands/init.js";
import { registerAlertCommands } from "./commands/alerts.js";
import { loadSettings, saveSettings } from "./settings.js";
import { setSharedApiNetwork } from "./shared-api.js";

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

const program = new Command();

// Resolve default exchange from settings (fallback: "pacifica")
const _settings = loadSettings();
const _defaultExchange = _settings.defaultExchange || "pacifica";

program
  .name("perp")
  .description("Multi-DEX Perpetual Futures CLI (Pacifica, Hyperliquid, Lighter)")
  .version(_pkg.version)
  .option("-e, --exchange <exchange>", `Exchange: pacifica, hyperliquid, lighter, aster (default: ${_defaultExchange})`, _defaultExchange)
  .option("-n, --network <network>", "Network: mainnet or testnet", "mainnet")
  .option("-k, --private-key <key>", "Private key")
  .option("--json", "Output raw JSON (for piping)")
  .option("--fields <fields>", "Comma-separated fields to include in JSON output (e.g. totalEquity,positions)")
  .option("--ndjson", "Output newline-delimited JSON (one object per line for streaming)")
  .option("--dry-run", "Simulate trades without executing (log as simulated)")
  .option("-w, --wallet <name>", "Use a specific wallet by name (from 'perp wallet list')")
  .option("--dex <name>", "HIP-3 deployed perp dex name (Hyperliquid only)")
  .configureOutput({
    writeErr: (str) => {
      if (process.argv.includes("--json")) {
        const msg = str.replace(/^error:\s*/i, "").trim();
        // Use inline envelope (jsonError import not available in sync context)
        console.log(JSON.stringify({
          ok: false,
          error: { code: "CLI_ERROR", message: msg },
          meta: { timestamp: new Date().toISOString() },
        }));
      } else {
        process.stderr.write(str);
      }
    },
  });

let _adapter: ExchangeAdapter | null = null;
let _pacificaAdapter: PacificaAdapter | null = null;
let _hlAdapter: HyperliquidAdapter | null = null;
let _lighterAdapter: LighterAdapter | null = null;

/** Map short aliases to canonical exchange names. Full names pass through. */
function resolveExchangeAlias(name: string): string {
  return resolveExchangeName(name);
}

function getExchange(): Exchange {
  return resolveExchangeAlias(program.opts().exchange) as Exchange;
}

async function getAdapter(): Promise<ExchangeAdapter> {
  const opts = program.opts();
  const walletName = opts.wallet as string | undefined;

  // Skip cache when --wallet is specified (different wallet = different account)
  if (!walletName && _adapter) return _adapter;

  const exchange = resolveExchangeAlias(opts.exchange) as Exchange;
  const network = opts.network as string;
  const isTestnet = network === "testnet";

  // Try to load key — null means no key configured (read-only mode)
  const pk = await tryLoadPrivateKey(exchange, opts.privateKey, walletName);

  switch (exchange) {
    case "pacifica": {
      const keypair = pk ? parseSolanaKeypair(pk) : Keypair.generate();
      const pacNetwork = (isTestnet ? "testnet" : "mainnet") as Network;
      const settings = loadSettings();
      const builderCode = process.env.PACIFICA_BUILDER_CODE || settings.referralCodes.pacifica || "PERPCLI";
      _pacificaAdapter = new PacificaAdapter(keypair, pacNetwork, builderCode, !!pk);
      _adapter = _pacificaAdapter;
      break;
    }
    case "hyperliquid": {
      _hlAdapter = new HyperliquidAdapter(pk ?? undefined, isTestnet);
      if (opts.dex) _hlAdapter.setDex(opts.dex);
      await _hlAdapter.init();
      if (pk) {
        const hlSettings = loadSettings();
        if (hlSettings.referrals && !hlSettings.referralApplied.hyperliquid) {
          const hlRef = process.env.HL_REFERRAL_CODE || hlSettings.referralCodes.hyperliquid;
          if (hlRef) {
            _hlAdapter.autoSetReferrer(hlRef).then(() => {
              const s = loadSettings();
              s.referralApplied.hyperliquid = true;
              saveSettings(s);
            }).catch(() => {
              const s = loadSettings();
              s.referralApplied.hyperliquid = true;
              saveSettings(s);
            });
          }
        }
      }
      _adapter = _hlAdapter;
      break;
    }
    case "lighter": {
      const { LighterAdapter } = await import("./exchanges/lighter.js");
      _lighterAdapter = new LighterAdapter(pk ?? "", isTestnet);
      await _lighterAdapter.init();
      if (pk) {
        const ltSettings = loadSettings();
        if (ltSettings.referrals && !ltSettings.referralApplied.lighter) {
          const ltRef = process.env.LIGHTER_REFERRAL_CODE || ltSettings.referralCodes.lighter;
          if (ltRef) {
            _lighterAdapter.useReferralCode(ltRef).then(() => {
              const s = loadSettings();
              s.referralApplied.lighter = true;
              saveSettings(s);
            }).catch(() => {
              const s = loadSettings();
              s.referralApplied.lighter = true;
              saveSettings(s);
            });
          }
        }
      }
      _adapter = _lighterAdapter;
      break;
    }
    case "aster": {
      const { AsterAdapter } = await import("./exchanges/aster.js");
      const ast = new AsterAdapter(undefined, undefined, isTestnet);
      await ast.init();
      _adapter = ast;
      break;
    }
    default:
      throw new Error(`Unknown exchange: ${exchange}`);
  }

  return _adapter;
}

// Sync wrapper for commands that need adapter (lazy init)
function getAdapterSync(): ExchangeAdapter {
  if (!_adapter) throw new Error("Adapter not initialized");
  return _adapter;
}

function isJson(): boolean {
  return !!program.opts().json || process.argv.includes("--ndjson");
}

function isDryRun(): boolean {
  return !!program.opts().dryRun;
}

// Helper to get PacificaAdapter specifically (for Pacifica-only commands)
function getPacificaAdapter(): PacificaAdapter {
  if (!_pacificaAdapter) throw new Error("This command requires --exchange pacifica");
  return _pacificaAdapter;
}

function getHLAdapter(): HyperliquidAdapter {
  if (!_hlAdapter) throw new Error("This command requires --exchange hyperliquid");
  return _hlAdapter;
}

// Register command groups with async adapter getter
registerMarketCommands(program, getAdapter, isJson, getAdapterForExchange);
registerAccountCommands(program, getAdapter, isJson, getAdapterForExchange);
registerTradeCommands(program, getAdapter, isJson, isDryRun, getAdapterForExchange);
registerManageCommands(program, getAdapter, isJson, getPacificaAdapter);
// stream commands removed
registerArbCommands(program, isJson, getAdapterForExchange);
registerWalletCommands(program, isJson);
registerBridgeCommands(program, isJson);
registerFundsCommands(
  program,
  getAdapter,
  isJson,
  () => program.opts().network as Network
);
// alert commands removed

// Helper to get adapter for a specific exchange (used by arb-auto)
async function getAdapterForExchange(rawExchange: string): Promise<ExchangeAdapter> {
  const exchange = resolveExchangeAlias(rawExchange);
  const opts = program.opts();
  const network = opts.network as string;
  const isTestnet = network === "testnet";
  const walletName = opts.wallet as string | undefined;
  const pk = await tryLoadPrivateKey(exchange as Exchange, opts.privateKey, walletName);

  switch (exchange) {
    case "pacifica": {
      if (_pacificaAdapter) return _pacificaAdapter;
      const keypair = pk ? parseSolanaKeypair(pk) : Keypair.generate();
      const pacNetwork = (isTestnet ? "testnet" : "mainnet") as Network;
      const s1 = loadSettings();
      const builderCode = process.env.PACIFICA_BUILDER_CODE || s1.referralCodes.pacifica || "PERPCLI";
      _pacificaAdapter = new PacificaAdapter(keypair, pacNetwork, builderCode, !!pk);
      if (!_adapter) _adapter = _pacificaAdapter;
      return _pacificaAdapter;
    }
    case "hyperliquid": {
      if (_hlAdapter) return _hlAdapter;
      _hlAdapter = new HyperliquidAdapter(pk ?? undefined, isTestnet);
      if (opts.dex) _hlAdapter.setDex(opts.dex);
      await _hlAdapter.init();
      if (pk) {
        const s2 = loadSettings();
        if (s2.referrals && !s2.referralApplied.hyperliquid) {
          const hlRef = process.env.HL_REFERRAL_CODE || s2.referralCodes.hyperliquid;
          if (hlRef) {
            _hlAdapter.autoSetReferrer(hlRef).then(() => {
              const s = loadSettings();
              s.referralApplied.hyperliquid = true;
              saveSettings(s);
            }).catch(() => {
              const s = loadSettings();
              s.referralApplied.hyperliquid = true;
              saveSettings(s);
            });
          }
        }
      }
      if (!_adapter) _adapter = _hlAdapter;
      return _hlAdapter;
    }
    case "lighter": {
      if (_lighterAdapter) return _lighterAdapter;
      const { LighterAdapter } = await import("./exchanges/lighter.js");
      _lighterAdapter = new LighterAdapter(pk ?? "", isTestnet);
      await _lighterAdapter.init();
      if (pk) {
        const s3 = loadSettings();
        if (s3.referrals && !s3.referralApplied.lighter) {
          const ltRef = process.env.LIGHTER_REFERRAL_CODE || s3.referralCodes.lighter;
          if (ltRef) {
            _lighterAdapter.useReferralCode(ltRef).then(() => {
              const s = loadSettings();
              s.referralApplied.lighter = true;
              saveSettings(s);
            }).catch(() => {
              const s = loadSettings();
              s.referralApplied.lighter = true;
              saveSettings(s);
            });
          }
        }
      }
      if (!_adapter) _adapter = _lighterAdapter;
      return _lighterAdapter;
    }
    case "aster": {
      const { AsterAdapter } = await import("./exchanges/aster.js");
      const ast = new AsterAdapter(undefined, undefined, isTestnet);
      await ast.init();
      return ast;
    }
    default:
      throw new Error(`Unknown exchange: ${exchange}`);
  }
}

// Helper to get an HL adapter configured for a specific HIP-3 dex
const _dexAdapters = new Map<string, HyperliquidAdapter>();
async function getHLAdapterForDex(dex: string): Promise<HyperliquidAdapter> {
  if (_dexAdapters.has(dex)) return _dexAdapters.get(dex)!;
  const opts = program.opts();
  const walletName = opts.wallet as string | undefined;
  const pk = await tryLoadPrivateKey("hyperliquid", opts.privateKey, walletName);
  const adapter = new HyperliquidAdapter(pk ?? undefined, opts.network === "testnet");
  if (dex !== "hl") adapter.setDex(dex);
  await adapter.init();
  _dexAdapters.set(dex, adapter);
  return adapter;
}

registerArbAutoCommands(program, getAdapterForExchange, isJson, getHLAdapterForDex);
registerArbManageCommands(program, getAdapterForExchange, isJson);
registerAgentCommands(program, getAdapter, isJson);
// withdraw merged into funds
registerRebalanceCommands(program, getAdapterForExchange, isJson);

// Jobs & strategies
import { registerJobsCommands } from "./commands/jobs.js";
registerJobsCommands(program, isJson);
registerBotCommands(program, getAdapter, getAdapterForExchange, isJson);

// Agent-friendly commands
registerRiskCommands(program, getAdapterForExchange, isJson);
registerHistoryCommands(program, isJson, getAdapterForExchange);
registerSettingsCommands(program, isJson, getAdapterForExchange);
// dex commands removed — use 'market hip3' + --dex flag
registerPlanCommands(program, getAdapter, isJson);
// funding merged into arb — registerFundingCommands removed
registerBacktestCommands(program, isJson);
registerDashboardCommands(program, getAdapterForExchange, isJson, getHLAdapterForDex);
registerInitCommand(program);
registerAlertCommands(program, isJson);

// Agent discovery: perp api-spec — deprecated, use 'perp agent schema'
const apiSpecCmd = program
  .command("api-spec")
  .description("Use 'perp agent schema'")
  .action(async () => {
    const { jsonOk, printJson } = await import("./utils.js");
    const { getCliSpec } = await import("./cli-spec.js");
    printJson(jsonOk(getCliSpec(program)));
  });
(apiSpecCmd as any)._hidden = true;

// Unified dashboard: balances + positions + top arb opportunities
program.command("status")
  .description("Unified dashboard: balances, positions, and top arb opportunities")
  .option("--health", "Check connectivity only")
  .action(async (opts: { health?: boolean }) => {
    if (opts.health) { const { runHealthCheck } = await import("./commands/risk.js"); return runHealthCheck(isJson); }
    const json = isJson();
    const { formatUsd, formatPnl, makeTable, printJson, jsonOk, withJsonErrors } = await import("./utils.js");
    const { fetchAllFundingRates, TOP_SYMBOLS } = await import("./funding-rates.js");
    const { saveFundingSnapshot, getHistoricalRates } = await import("./funding-history.js");

    await withJsonErrors(json, async () => {
      const EX_LIST = ["pacifica", "hyperliquid", "lighter", "aster"] as const;
      const exAbbr = (e: string) => e === "pacifica" ? "PAC" : e === "hyperliquid" ? "HL" : e === "lighter" ? "LT" : "AST";

      // Fetch balances + positions + spot balances + arb scan in parallel
      type SpotHolding = { token: string; total: string; available: string; held: string; valueUsd: number };
      const snapshotPromises = EX_LIST.map(async (ex) => {
        try {
          const adapter = await getAdapterForExchange(ex);
          const [balance, positions, orders] = await Promise.all([
            adapter.getBalance(), adapter.getPositions(), adapter.getOpenOrders(),
          ]);
          // Fetch spot balances for HL and LT (Pacifica is perp-only)
          let spotHoldings: SpotHolding[] = [];
          let isUnified = false;
          try {
            if (ex === "hyperliquid") {
              const { HyperliquidSpotAdapter } = await import("./exchanges/hyperliquid-spot.js");
              const hlSpot = new HyperliquidSpotAdapter(adapter as HyperliquidAdapter);
              await hlSpot.init();
              const [raw, markets] = await Promise.all([hlSpot.getSpotBalances(), hlSpot.getSpotMarkets()]);
              const priceMap = new Map(markets.map(m => [m.baseToken.toUpperCase(), Number(m.markPrice)]));
              const strip = (t: string) => t.replace(/-SPOT$/i, "").toUpperCase();
              spotHoldings = raw.filter(b => Number(b.total) > 0).map(b => {
                const base = strip(b.token);
                return { ...b, valueUsd: base === "USDC" ? Number(b.total) : (priceMap.get(base) ?? 0) * Number(b.total) };
              });
              isUnified = !(adapter as HyperliquidAdapter).dex;
            } else if (ex === "lighter") {
              const { LighterAdapter } = await import("./exchanges/lighter.js");
              const { LighterSpotAdapter } = await import("./exchanges/lighter-spot.js");
              const ltSpot = new LighterSpotAdapter(adapter as InstanceType<typeof LighterAdapter>);
              await ltSpot.init();
              const [raw, markets] = await Promise.all([ltSpot.getSpotBalances(), ltSpot.getSpotMarkets()]);
              const priceMap = new Map(markets.map(m => [m.baseToken.toUpperCase(), Number(m.markPrice)]));
              spotHoldings = raw.filter(b => Number(b.total) > 0).map(b => ({
                ...b,
                valueUsd: b.token === "USDC" || b.token === "USDC_SPOT" ? Number(b.total) : (priceMap.get(b.token.toUpperCase()) ?? 0) * Number(b.total),
              }));
            }
          } catch { /* spot not available */ }
          return { exchange: ex, connected: true, balance, positions, openOrders: orders.length, spotHoldings, isUnified, error: undefined as string | undefined };
        } catch (err) {
          return { exchange: ex, connected: false, balance: null as null, positions: [] as never[], openOrders: 0, spotHoldings: [] as SpotHolding[], isUnified: false, error: err instanceof Error ? err.message : String(err) };
        }
      });

      const arbPromise = fetchAllFundingRates({ symbols: TOP_SYMBOLS, minSpread: 0 }).catch(() => null);
      const [snapshots, arbSnapshot] = await Promise.all([Promise.all(snapshotPromises), arbPromise]);

      // Save funding snapshot for sparkline history
      if (arbSnapshot) {
        try { const allRates = arbSnapshot.symbols.flatMap(s => s.rates); if (allRates.length > 0) saveFundingSnapshot(allRates); } catch { /* */ }
      }

      // Build totals (include non-USDC spot value for unified accounts)
      let totalEquity = 0;
      let totalSpotValue = 0;
      type PosWithEx = { symbol: string; exchange: string; side: string; size: string; entryPrice: string; markPrice: string; unrealizedPnl: string; leverage: number };
      const allPositions: PosWithEx[] = [];
      const allSpotHoldings: (SpotHolding & { exchange: string })[] = [];
      for (const s of snapshots) {
        if (s.balance) totalEquity += Number(s.balance.equity);
        for (const p of s.positions) allPositions.push({ ...p, exchange: s.exchange });
        // For unified accounts (HL), USDC is already in perp equity — only add non-USDC spot
        const displaySpot = s.isUnified
          ? s.spotHoldings.filter(b => b.token.replace(/-SPOT$/i, "").toUpperCase() !== "USDC")
          : s.spotHoldings;
        const spotVal = displaySpot.reduce((sum, b) => sum + b.valueUsd, 0);
        totalSpotValue += spotVal;
        totalEquity += spotVal;
        for (const b of displaySpot) allSpotHoldings.push({ ...b, exchange: s.exchange });
      }

      // Top arb
      const topArb = arbSnapshot
        ? arbSnapshot.symbols.filter(s => s.maxSpreadAnnual >= 5).sort((a, b) => b.maxSpreadAnnual - a.maxSpreadAnnual).slice(0, 5)
        : [];

      // Risk
      const marginUsed = snapshots.reduce((s, x) => s + (x.balance ? Number(x.balance.marginUsed) : 0), 0);
      const marginPct = totalEquity > 0 ? (marginUsed / totalEquity) * 100 : 0;
      const riskLevel = marginPct < 30 ? "LOW" : marginPct < 60 ? "MEDIUM" : "HIGH";

      if (json) {
        const now = new Date();
        const h24 = new Date(now.getTime() - 24 * 3600_000);
        return printJson(jsonOk({
          version: _pkg.version,
          totalEquity,
          riskLevel,
          exchanges: snapshots.map(s => ({
            name: s.exchange, connected: s.connected,
            equity: s.balance ? Number(s.balance.equity) : 0,
            available: s.balance ? Number(s.balance.available) : 0,
            spotHoldings: s.spotHoldings.filter(b => Number(b.total) > 0).map(b => ({
              token: b.token, total: b.total, available: b.available, valueUsd: b.valueUsd,
            })),
          })),
          totalSpotValue,
          positions: allPositions,
          topArbOpportunities: await (async () => {
            const { getHistoricalAverages: getAvgs } = await import("./funding-history.js");
            const syms = topArb.map(a => a.symbol);
            const avgs = syms.length > 0 ? getAvgs(syms, ["hyperliquid", "pacifica", "lighter"]) : new Map();
            return topArb.map(a => {
              const bestEx = a.rates.find(r => r.exchange === "hyperliquid")?.exchange ?? a.rates[0]?.exchange ?? "hyperliquid";
              const avg = avgs.get(`${a.symbol}:${bestEx}`);
              return {
                symbol: a.symbol, spreadAnnual: a.maxSpreadAnnual,
                direction: `${exAbbr(a.shortExchange)}>${exAbbr(a.longExchange)}`,
                avg24h: avg?.avg24h != null ? Math.abs(avg.avg24h) * 8760 * 100 : null,
                avg7d: avg?.avg7d != null ? Math.abs(avg.avg7d) * 8760 * 100 : null,
                rateHistory: getHistoricalRates(a.symbol, bestEx, h24, now).map(h => ({ ts: h.ts, hourlyRate: h.hourlyRate })),
              };
            });
          })(),
        }));
      }

      // ── Terminal UI ──
      console.log(chalk.cyan.bold(`\n  perp-cli v${_pkg.version}`) + chalk.gray(` — ${snapshots.filter(s => s.connected).length} exchanges connected\n`));

      // Balance bars + Top Arb side by side
      const now = new Date();
      const h24 = new Date(now.getTime() - 24 * 3600_000);

      // Left column: Balances (perp + spot per exchange)
      // Compute per-exchange totals: perp equity + non-USDC spot (unified) or all spot
      const exTotals = snapshots.map(s => {
        if (!s.connected || !s.balance) return { total: 0, margin: 0, equity: 0 };
        const equity = Number(s.balance.equity);
        const margin = Number(s.balance.marginUsed);
        const displaySpot = s.isUnified
          ? s.spotHoldings.filter(b => b.token.replace(/-SPOT$/i, "").toUpperCase() !== "USDC")
          : s.spotHoldings;
        const spotVal = displaySpot.reduce((sum, b) => sum + b.valueUsd, 0);
        return { total: equity + spotVal, margin, equity };
      });

      const balLines: string[] = [];
      balLines.push(chalk.white.bold(" Balances"));
      for (let i = 0; i < snapshots.length; i++) {
        const s = snapshots[i];
        if (!s.connected) { balLines.push(` ${chalk.gray(exAbbr(s.exchange).padEnd(4))} ${chalk.red("disconnected")}`); continue; }
        const { total, margin, equity } = exTotals[i];
        const usagePct = equity > 0 ? (margin / equity) * 100 : 0;
        const barFull = Math.min(20, Math.round(usagePct / 5));
        const usageColor = usagePct < 30 ? chalk.green : usagePct < 60 ? chalk.yellow : chalk.red;
        const bar = usageColor("\u2588".repeat(barFull)) + chalk.gray("\u2591".repeat(20 - barFull));
        balLines.push(` ${chalk.white.bold(exAbbr(s.exchange).padEnd(4))} $${formatUsd(total).padEnd(9)} ${bar} ${usagePct.toFixed(0)}% used`);
      }
      // Spot holdings (non-USDC tokens with value)
      const displaySpotHoldings = allSpotHoldings.filter(b => {
        const tk = b.token.replace(/[-_]SPOT$/i, "").toUpperCase();
        return tk !== "USDC";
      });
      if (displaySpotHoldings.length > 0) {
        balLines.push("");
        balLines.push(chalk.white.bold(" Spot Holdings"));
        for (const b of displaySpotHoldings) {
          const token = b.token.replace(/-SPOT$/i, "");
          const ex = exAbbr(b.exchange);
          balLines.push(` ${chalk.gray(ex.padEnd(4))} ${chalk.white.bold(token.padEnd(6))} ${b.total.padEnd(12)} ${chalk.gray(`$${formatUsd(b.valueUsd)}`)}`);
        }
      }

      const riskColor = riskLevel === "LOW" ? chalk.green : riskLevel === "MEDIUM" ? chalk.yellow : chalk.red;
      balLines.push(` ${"─".repeat(44)}`);
      balLines.push(` ${chalk.cyan.bold("Total")} ${chalk.cyan.bold(`$${formatUsd(totalEquity)}`.padEnd(9))}    Risk: ${riskColor(riskLevel)}`);

      // Right column: Top Arb Opportunities (with 24h/7d averages from local history — 0 API calls)
      const { getHistoricalAverages } = await import("./funding-history.js");
      const arbSymbols = topArb.map(a => a.symbol);
      const arbExchanges = ["hyperliquid", "pacifica", "lighter"];
      const histAvgs = arbSymbols.length > 0 ? getHistoricalAverages(arbSymbols, arbExchanges) : new Map();

      const arbLines: string[] = [];
      arbLines.push(chalk.white.bold(" Top Arb Opportunities"));
      if (topArb.length > 0) {
        //          SYMBOL   SPREAD   24h   TREND     7d     DIR
        arbLines.push(chalk.gray(" " + "".padEnd(8) + "now".padEnd(9) + "24h".padEnd(7) + "".padEnd(9) + "7d".padEnd(7)));
        for (const a of topArb) {
          const spreadColor = a.maxSpreadAnnual >= 100 ? chalk.green.bold : a.maxSpreadAnnual >= 30 ? chalk.green : chalk.yellow;
          const dir = `${exAbbr(a.shortExchange)}>${exAbbr(a.longExchange)}`;
          const bestEx = a.rates.find(r => r.exchange === "hyperliquid")?.exchange ?? a.rates[0]?.exchange ?? "hyperliquid";

          // 24h trend arrow
          const history = getHistoricalRates(a.symbol, bestEx, h24, now);
          let trend = "";
          if (history.length >= 2) {
            const oldAnn = Math.abs(history[0].hourlyRate) * 8760 * 100;
            const newAnn = Math.abs(history[history.length - 1].hourlyRate) * 8760 * 100;
            const delta = newAnn - oldAnn;
            const abs = Math.abs(delta);
            trend = abs < 1 ? chalk.gray(`\u2500${abs.toFixed(0)}%`)
              : delta > 0 ? chalk.red(`\u25B2+${abs.toFixed(0)}%`)
              : chalk.green(`\u25BC-${abs.toFixed(0)}%`);
          }

          // 24h and 7d averages (annualized from hourly)
          const avg = histAvgs.get(`${a.symbol}:${bestEx}`);
          const avg24h = avg?.avg24h != null ? `${(Math.abs(avg.avg24h) * 8760 * 100).toFixed(0)}%` : "-";
          const avg7d = avg?.avg7d != null ? `${(Math.abs(avg.avg7d) * 8760 * 100).toFixed(0)}%` : "-";

          arbLines.push(` ${chalk.white.bold(a.symbol.padEnd(8))} ${spreadColor(`${a.maxSpreadAnnual.toFixed(1)}%`.padEnd(9))}${chalk.gray(avg24h.padEnd(7))}${trend.padEnd(9)}${chalk.gray(avg7d.padEnd(7))}${chalk.gray(dir)}`);
        }
      } else {
        arbLines.push(chalk.gray(" No opportunities above 5%"));
      }

      // Print layout — side-by-side if terminal is wide enough, else stacked
      const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
      const termW = process.stdout.columns || 80;
      const SIDE_BY_SIDE_MIN = 100; // 2 indent + 1 + 46 + 1 + 48 + 1

      if (termW >= SIDE_BY_SIDE_MIN) {
        const LEFT_W = 46;
        const RIGHT_W = 48;
        const maxLines = Math.max(balLines.length, arbLines.length);
        console.log(`  ${"┌"}${"─".repeat(LEFT_W)}${"┬"}${"─".repeat(RIGHT_W)}${"┐"}`);
        for (let i = 0; i < maxLines; i++) {
          const left = balLines[i] ?? "";
          const right = arbLines[i] ?? "";
          const leftPad = LEFT_W - stripAnsi(left).length;
          const rightPad = RIGHT_W - stripAnsi(right).length;
          console.log(`  \u2502${left}${" ".repeat(Math.max(0, leftPad))}\u2502${right}${" ".repeat(Math.max(0, rightPad))}\u2502`);
        }
        console.log(`  ${"└"}${"─".repeat(LEFT_W)}${"┴"}${"─".repeat(RIGHT_W)}${"┘"}`);
      } else {
        // Stacked layout for narrow terminals
        const boxW = Math.min(termW - 4, 74); // 2 indent + 2 borders
        const printBox = (lines: string[]) => {
          console.log(`  ${"┌"}${"─".repeat(boxW)}${"┐"}`);
          for (const line of lines) {
            const pad = boxW - stripAnsi(line).length;
            console.log(`  \u2502${line}${" ".repeat(Math.max(0, pad))}\u2502`);
          }
          console.log(`  ${"└"}${"─".repeat(boxW)}${"┘"}`);
        };
        printBox(balLines);
        console.log();
        printBox(arbLines);
      }

      // Positions
      if (allPositions.length > 0) {
        console.log(chalk.white.bold("\n  Positions"));
        const posRows = allPositions.map(p => {
          const sideColor = p.side === "long" ? chalk.green : chalk.red;
          const notional = Math.abs(Number(p.size) * Number(p.markPrice));
          const levStr = p.leverage > 0 ? `${p.leverage}x` : "-";
          const warn = p.leverage >= 5 ? chalk.red(" \u26A0") : "";
          return [
            chalk.white.bold(p.symbol.replace("-PERP", "")),
            chalk.gray(exAbbr(p.exchange)),
            sideColor(p.side.toUpperCase()),
            p.size,
            `$${formatUsd(p.entryPrice)}\u2192$${formatUsd(p.markPrice)}`,
            formatPnl(p.unrealizedPnl),
            `$${formatUsd(notional)}`,
            levStr + warn,
          ];
        });
        console.log(makeTable(["Symbol", "Ex", "Side", "Size", "Entry\u2192Mark", "uPnL", "Notional", "Lev"], posRows));
      } else {
        console.log(chalk.gray("\n  No open positions.\n"));
      }
    });
  });

// Switch shared API URLs if --network testnet is used
program.hook("preAction", () => {
  const network = program.opts().network as string;
  if (network === "testnet") setSharedApiNetwork("testnet");
});

// Smart landing page: `perp` with no subcommand
const rawArgs = process.argv.slice(2);
const hasSubcommand = rawArgs.some((a) => !a.startsWith("-") && !["pacifica", "hyperliquid", "lighter", "aster", "hl", "lt", "pac", "ast", "mainnet", "testnet"].includes(a));

if (rawArgs.length === 0 || (!hasSubcommand && !rawArgs.includes("-h") && !rawArgs.includes("--help") && !rawArgs.includes("-V") && !rawArgs.includes("--version"))) {
  // No subcommand — show smart landing instead of help dump
  (async () => {
    try {
      const { getWalletSetupStatus } = await import("./commands/wallet.js");
      const status = getWalletSetupStatus();
      const settings = loadSettings();
      const hasEnvKey = !!(process.env.PRIVATE_KEY || process.env.PACIFICA_PRIVATE_KEY ||
        process.env.HL_PRIVATE_KEY || process.env.HYPERLIQUID_PRIVATE_KEY ||
        process.env.LIGHTER_PRIVATE_KEY);

      // ── ASCII banner ──
      const banner = [
        chalk.cyan("  ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓"),
        chalk.cyan("  ┃") + chalk.white.bold("  perp-cli ") + chalk.gray(`v${_pkg.version}`) + " ".repeat(Math.max(0, 32 - _pkg.version.length)) + chalk.cyan("┃"),
        chalk.cyan("  ┃") + chalk.gray("  Multi-DEX Perpetual Futures               ") + chalk.cyan("┃"),
        chalk.cyan("  ┃") + chalk.gray("  Pacifica · Hyperliquid · Lighter           ") + chalk.cyan("┃"),
        chalk.cyan("  ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛"),
      ];
      console.log("\n" + banner.join("\n"));

      if (!status.hasWallets && !hasEnvKey && !settings.defaultExchange) {
        // Fresh install — onboarding
        console.log(chalk.yellow.bold("\n  ⚡ Get started:\n"));
        console.log(`    ${chalk.cyan("perp wallet set <exchange> <key>")}`);
        console.log(chalk.gray(`\n  Or explore without a wallet:`));
        console.log(`    ${chalk.green("perp market list")}              available markets`);
        console.log(`    ${chalk.green("perp -e hl market list")}         Hyperliquid markets`);
        console.log(`    ${chalk.green("perp arb scan")}                 funding rate arbitrage`);
        console.log(`    ${chalk.green("perp --help")}                   all commands\n`);
      } else {
        // Configured — show exchange status + balance
        const EX_NAMES = ["pacifica", "hyperliquid", "lighter", "aster"] as const;
        const exLabel = (e: string) => e === "pacifica" ? "Pacifica" : e === "hyperliquid" ? "Hyperliquid" : e === "lighter" ? "Lighter" : "Aster";

        // Ping + balance in parallel (with 5s timeout to keep landing fast)
        const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
          Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

        const statusResults = await Promise.allSettled(EX_NAMES.map(async (ex) => {
          try {
            const adapter = await withTimeout(getAdapterForExchange(ex), 5000);
            const [balance, positions] = await withTimeout(Promise.all([adapter.getBalance(), adapter.getPositions()]), 5000);
            const posCount = positions.filter(p => Number(p.size) > 0).length;
            return { exchange: ex, ok: true, equity: Number(balance.equity), positions: posCount };
          } catch {
            return { exchange: ex, ok: false, equity: 0, positions: 0 };
          }
        }));

        console.log(chalk.white.bold("\n  Exchanges:"));
        let totalEquity = 0;
        let totalPositions = 0;
        for (const r of statusResults) {
          if (r.status !== "fulfilled") continue;
          const s = r.value;
          const icon = s.ok ? chalk.green("●") : chalk.red("○");
          const eq = s.ok ? chalk.white(`$${Number(s.equity).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`) : chalk.gray("—");
          const pos = s.ok && s.positions > 0 ? chalk.yellow(` ${s.positions} pos`) : "";
          console.log(`    ${icon} ${chalk.cyan(exLabel(s.exchange).padEnd(14))} ${eq}${pos}`);
          if (s.ok) { totalEquity += s.equity; totalPositions += s.positions; }
        }

        if (totalEquity > 0) {
          console.log(chalk.gray("    ─".repeat(20)));
          console.log(`    ${chalk.white.bold("Total".padEnd(16))} ${chalk.white.bold(`$${totalEquity.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}${totalPositions > 0 ? chalk.yellow(` ${totalPositions} pos`) : ""}`);
        }

        console.log(chalk.white.bold("\n  Commands:"));
        console.log(`    ${chalk.green("perp portfolio")}     balances + positions + risk`);
        console.log(`    ${chalk.green("perp status")}        full dashboard`);
        console.log(`    ${chalk.green("perp arb scan")}      funding rate arbitrage`);
        console.log(`    ${chalk.green("perp dashboard")}     live web monitoring`);
        console.log(`    ${chalk.green("perp --help")}        all commands\n`);
      }
    } catch {
      program.help();
    }
    setTimeout(() => process.exit(0), 500);
  })();
} else {
program.parseAsync().then(() => {
  // Allow a short delay for any pending output, then exit cleanly.
  // Without this, HL SDK's WebSocket keeps the process alive indefinitely.
  setTimeout(() => process.exit(0), 500);
}).catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (isJson()) {
    const { jsonError } = await import("./utils.js");
    console.log(JSON.stringify(jsonError("FATAL", msg)));
  } else {
    console.error(chalk.red(msg));
  }
  process.exit(1);
});
}
