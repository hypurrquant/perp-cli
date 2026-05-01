/**
 * Unified `perp portfolio` command — replaces:
 *   - `perp account balance` (single-exchange detail)  → `perp portfolio -e <ex>`
 *   - prior `perp portfolio`                            → `perp portfolio` (rebuilt)
 *   - `perp status`                                     → `perp portfolio --arb`
 *   - `perp status --health`                            → `perp portfolio --health`
 *   - `perp dashboard`                                  → `perp portfolio --serve`
 *
 * Modes (mutually exclusive, picked by flag):
 *   snapshot (default) | health | watch | serve
 *
 * I/O contract:
 *   - Text mode  → human-friendly tables + side-by-side panels (status-like)
 *   - JSON mode  → canonical envelope (see spec); arb / health / serve keys conditional
 *   - --stdin    → read JSON args from stdin, overrides CLI flags
 */
import type { Command } from "commander";
import chalk from "chalk";
import type { ExchangeAdapter, ExchangeBalance, ExchangePosition } from "../exchanges/index.js";
import { makeTable, formatUsd, formatPnl, printJson, jsonOk, jsonError, withJsonErrors } from "../utils.js";
import { isDexCapable } from "../exchanges/capabilities.js";
import type { DashboardExchange } from "../dashboard/index.js";

// ── Types ──────────────────────────────────────────────────────────────────

const EXCHANGES = ["pacifica", "hyperliquid", "lighter", "aster"] as const;
type ExchangeName = typeof EXCHANGES[number];

type Mode = "snapshot" | "health" | "watch" | "serve";

interface SpotHolding {
  token: string;
  total: string;
  available: string;
  held?: string;
  valueUsd: number;
}

interface PerpSummary {
  equity: string;
  available: string;
  marginUsed: string;
  unrealizedPnl: string;
}

interface PositionEntry {
  symbol: string;
  side: "long" | "short";
  size: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  leverage: number;
}

interface ExchangeEntry {
  name: string;
  connected: boolean;
  isUnified: boolean;
  perp: PerpSummary | null;
  spot: SpotHolding[];
  positions: PositionEntry[];
  openOrders: number;
  funding24h: number;
  totalAccountValueUsd: number;
  error: string | null;
}

interface Totals {
  equity: number;
  spotValueUsd: number;
  accountValueUsd: number;
  marginUsed: number;
  marginPct: number;
  funding24h: number;
}

interface RiskBlock {
  level: "LOW" | "MEDIUM" | "HIGH";
  marginPct: number;
}

interface ArbOpportunityOut {
  symbol: string;
  spreadAnnual: number;
  direction: string;
  longExchange: string;
  shortExchange: string;
  avg24h: number | null;
  avg7d: number | null;
}

interface HealthBlock {
  exchanges: Record<string, "ok" | "error">;
  anyDown: boolean;
}

interface ServeBlock {
  url: string;
  port: number;
  exchanges: string[];
}

interface PortfolioEnvelopeData {
  version: string;
  scope: "all" | "single";
  mode: Mode;
  exchanges: ExchangeEntry[];
  totals: Totals;
  risk: RiskBlock;
  arb?: { topOpportunities: ArbOpportunityOut[] };
  health?: HealthBlock;
  serve?: ServeBlock;
}

// ── stdin JSON spec ────────────────────────────────────────────────────────

interface StdinOptions {
  exchanges?: string[];
  exchange?: string;
  arb?: boolean;
  health?: boolean;
  watch?: boolean | { intervalMs?: number };
  serve?: boolean | { port?: number; intervalMs?: number };
  dex?: string[];
  autoDex?: boolean;
}

interface ResolvedOptions {
  exchangeList: string[];      // exchanges to fetch (1-4 of EXCHANGES)
  scope: "all" | "single";
  arb: boolean;
  health: boolean;
  watch: boolean;
  watchIntervalMs: number;
  serve: boolean;
  servePort: number;
  pollIntervalMs: number;
  dexList: string[];
  autoDex: boolean;
}

// ── CLI flags type ─────────────────────────────────────────────────────────

interface CliFlags {
  exchanges?: string;       // --exchanges <list> (sub-command, comma list; plural to avoid collision with global -e/--exchange)
  arb?: boolean;
  health?: boolean;
  watch?: string | boolean;
  serve?: string | boolean;
  interval?: string;
  dex?: string;
  autoDex?: boolean;
  stdin?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function exAbbr(e: string): string {
  return e === "pacifica" ? "PAC"
    : e === "hyperliquid" ? "HL"
    : e === "lighter" ? "LT"
    : e === "aster" ? "AST"
    : e.toUpperCase().slice(0, 3);
}

async function readStdinJson(): Promise<StdinOptions> {
  return new Promise<StdinOptions>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", chunk => { data += chunk; });
    process.stdin.on("end", () => {
      const trimmed = data.trim();
      if (!trimmed) return resolve({});
      try {
        const parsed = JSON.parse(trimmed) as StdinOptions;
        resolve(parsed);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    process.stdin.on("error", reject);
  });
}

function parseList(input: string | undefined): string[] {
  if (!input) return [];
  return input.split(",").map(s => s.trim()).filter(Boolean);
}

function validateExchanges(list: string[]): string[] {
  const lower = list.map(s => s.toLowerCase());
  const unknown = lower.filter(e => !EXCHANGES.includes(e as ExchangeName));
  if (unknown.length > 0) {
    throw new Error(`Unknown exchange: ${unknown.join(", ")}. Valid: ${EXCHANGES.join(", ")}`);
  }
  return lower;
}

/** Resolve global -e flag from program (only counts when the user typed it). */
function explicitExchange(program: Command): string | undefined {
  if (program.getOptionValueSource?.("exchange") === "cli") {
    const ex = program.opts().exchange as string | undefined;
    return ex ? ex.toLowerCase() : undefined;
  }
  return undefined;
}

function resolveOptions(
  program: Command,
  flags: CliFlags,
  stdinOpts: StdinOptions,
): ResolvedOptions {
  // 1) Build exchange list. Precedence: stdin > --exchanges > -e > all.
  let exchangeList: string[];
  let scope: "all" | "single" = "all";

  if (stdinOpts.exchanges && stdinOpts.exchanges.length > 0) {
    exchangeList = validateExchanges(stdinOpts.exchanges);
  } else if (stdinOpts.exchange) {
    exchangeList = validateExchanges([stdinOpts.exchange]);
    scope = "single";
  } else if (flags.exchanges) {
    exchangeList = validateExchanges(parseList(flags.exchanges));
  } else {
    const ex = explicitExchange(program);
    if (ex) {
      exchangeList = validateExchanges([ex]);
      scope = "single";
    } else {
      exchangeList = [...EXCHANGES];
    }
  }
  // If only 1 entry and we got there via -e or stdin.exchange, scope is single.
  // Otherwise multi-exchange aggregate.
  if (exchangeList.length === 1 && scope === "all" && (stdinOpts.exchange || explicitExchange(program))) {
    scope = "single";
  }

  // 2) Mode flags. stdin overrides CLI.
  const arb = stdinOpts.arb ?? !!flags.arb;
  const health = stdinOpts.health ?? !!flags.health;

  let watch = false;
  let watchIntervalMs = 5000;
  if (stdinOpts.watch !== undefined) {
    if (typeof stdinOpts.watch === "object" && stdinOpts.watch !== null) {
      watch = true;
      if (typeof stdinOpts.watch.intervalMs === "number") watchIntervalMs = stdinOpts.watch.intervalMs;
    } else if (stdinOpts.watch === true) {
      watch = true;
    }
  } else if (flags.watch !== undefined && flags.watch !== false) {
    watch = true;
    if (typeof flags.watch === "string" && flags.watch.length > 0) {
      const n = Number(flags.watch);
      if (Number.isFinite(n) && n > 0) watchIntervalMs = n;
    }
  }

  let serve = false;
  let servePort = 3456;
  let pollIntervalMs = 5000;
  if (stdinOpts.serve !== undefined) {
    if (typeof stdinOpts.serve === "object" && stdinOpts.serve !== null) {
      serve = true;
      if (typeof stdinOpts.serve.port === "number") servePort = stdinOpts.serve.port;
      if (typeof stdinOpts.serve.intervalMs === "number") pollIntervalMs = stdinOpts.serve.intervalMs;
    } else if (stdinOpts.serve === true) {
      serve = true;
    }
  } else if (flags.serve !== undefined && flags.serve !== false) {
    serve = true;
    if (typeof flags.serve === "string" && flags.serve.length > 0) {
      const n = parseInt(flags.serve, 10);
      if (Number.isFinite(n) && n > 0) servePort = n;
    }
  }
  if (flags.interval !== undefined) {
    const n = parseInt(flags.interval, 10);
    if (Number.isFinite(n) && n > 0) {
      pollIntervalMs = n;
      if (watchIntervalMs === 5000) watchIntervalMs = n;
    }
  }

  const dexList = stdinOpts.dex ?? parseList(flags.dex);
  const autoDex = stdinOpts.autoDex ?? (flags.autoDex !== false);

  return {
    exchangeList,
    scope,
    arb,
    health,
    watch,
    watchIntervalMs,
    serve,
    servePort,
    pollIntervalMs,
    dexList,
    autoDex,
  };
}

// ── Per-exchange snapshot fetch ────────────────────────────────────────────

async function fetchExchangeEntry(
  exName: string,
  getAdapter: (exchange: string) => Promise<ExchangeAdapter>,
): Promise<ExchangeEntry> {
  try {
    const adapter = await getAdapter(exName);
    const [bal, positionsRaw, orders, fundingPayments] = await Promise.all([
      adapter.getBalance(),
      adapter.getPositions(),
      adapter.getOpenOrders(),
      adapter.getFundingPayments(200).catch(() => [] as { time: number; symbol: string; payment: string }[]),
    ]);

    // Spot balances (only HL + LT). Pacifica/Aster are perp-only.
    let spot: SpotHolding[] = [];
    let isUnified = false;
    try {
      if (exName === "hyperliquid") {
        const { HyperliquidSpotAdapter } = await import("../exchanges/hyperliquid-spot.js");
        const { HyperliquidAdapter } = await import("../exchanges/hyperliquid.js");
        const hlSpot = new HyperliquidSpotAdapter(adapter as InstanceType<typeof HyperliquidAdapter>);
        await hlSpot.init();
        const [raw, markets] = await Promise.all([hlSpot.getSpotBalances(), hlSpot.getSpotMarkets()]);
        const priceMap = new Map(markets.map(m => [m.baseToken.toUpperCase(), Number(m.markPrice)]));
        const strip = (t: string) => t.replace(/-SPOT$/i, "").toUpperCase();
        spot = raw.filter(b => Number(b.total) > 0).map(b => {
          const base = strip(b.token);
          return {
            token: b.token,
            total: b.total,
            available: b.available,
            held: b.held,
            valueUsd: base === "USDC" ? Number(b.total) : (priceMap.get(base) ?? 0) * Number(b.total),
          };
        });
        // Read the actual abstraction mode (populated during init()) instead
        // of assuming all main HL accounts are unified. Standard/default mode
        // accounts must include spot USDC in totalAccountValueUsd because
        // perp equity does NOT contain it. HIP-3 dex accounts always run
        // standard semantics. Codex v0.12.12 final QA #1.
        const hlAdapter = adapter as InstanceType<typeof HyperliquidAdapter>;
        const dexScoped = isDexCapable(adapter) && !!adapter.dex;
        isUnified = !dexScoped && hlAdapter.isUnifiedAccount === true;
      } else if (exName === "lighter") {
        const { LighterAdapter } = await import("../exchanges/lighter.js");
        const { LighterSpotAdapter } = await import("../exchanges/lighter-spot.js");
        const ltSpot = new LighterSpotAdapter(adapter as InstanceType<typeof LighterAdapter>);
        await ltSpot.init();
        const [raw, markets] = await Promise.all([ltSpot.getSpotBalances(), ltSpot.getSpotMarkets()]);
        const priceMap = new Map(markets.map(m => [m.baseToken.toUpperCase(), Number(m.markPrice)]));
        spot = raw.filter(b => Number(b.total) > 0).map(b => ({
          token: b.token,
          total: b.total,
          available: b.available,
          held: b.held,
          valueUsd: b.token === "USDC" || b.token === "USDC_SPOT"
            ? Number(b.total)
            : (priceMap.get(b.token.toUpperCase()) ?? 0) * Number(b.total),
        }));
      }
    } catch { /* spot not available */ }

    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    const recent = fundingPayments.filter(f => f.time >= cutoff24h);
    const funding24h = recent.reduce((sum, f) => sum + Number(f.payment), 0);

    // For unified accounts (HL), USDC spot is already in perp equity.
    // Account value = perp equity + non-USDC spot; for non-unified, equity + all spot.
    const nonUsdcSpotValue = isUnified
      ? spot.filter(b => b.token.replace(/-SPOT$/i, "").toUpperCase() !== "USDC").reduce((s, b) => s + b.valueUsd, 0)
      : spot.reduce((s, b) => s + b.valueUsd, 0);

    return {
      name: exName,
      connected: true,
      isUnified,
      perp: {
        equity: bal.equity,
        available: bal.available,
        marginUsed: bal.marginUsed,
        unrealizedPnl: bal.unrealizedPnl,
      },
      spot,
      positions: positionsRaw.map(p => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        unrealizedPnl: p.unrealizedPnl,
        leverage: p.leverage,
      })),
      openOrders: orders.length,
      funding24h,
      totalAccountValueUsd: Number(bal.equity) + nonUsdcSpotValue,
      error: null,
    };
  } catch (err) {
    return {
      name: exName,
      connected: false,
      isUnified: false,
      perp: null,
      spot: [],
      positions: [],
      openOrders: 0,
      funding24h: 0,
      totalAccountValueUsd: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildTotals(entries: ExchangeEntry[]): { totals: Totals; risk: RiskBlock } {
  let equity = 0;
  let spotValueUsd = 0;
  let marginUsed = 0;
  let funding24h = 0;
  let accountValueUsd = 0;

  for (const e of entries) {
    if (e.perp) {
      equity += Number(e.perp.equity);
      marginUsed += Number(e.perp.marginUsed);
    }
    funding24h += e.funding24h;

    // Non-USDC spot value (for unified accounts USDC is already in equity)
    const exSpot = e.isUnified
      ? e.spot.filter(b => b.token.replace(/-SPOT$/i, "").toUpperCase() !== "USDC")
      : e.spot;
    const exSpotVal = exSpot.reduce((s, b) => s + b.valueUsd, 0);
    spotValueUsd += exSpotVal;
    accountValueUsd += e.totalAccountValueUsd;
  }

  // Use accountValueUsd (equity + non-USDC spot) as the denominator so risk
  // matches what the legacy `status` command reported.
  const denom = accountValueUsd > 0 ? accountValueUsd : equity;
  const marginPct = denom > 0 ? (marginUsed / denom) * 100 : 0;
  const level: RiskBlock["level"] = marginPct < 30 ? "LOW" : marginPct < 60 ? "MEDIUM" : "HIGH";

  return {
    totals: { equity, spotValueUsd, accountValueUsd, marginUsed, marginPct, funding24h },
    risk: { level, marginPct },
  };
}

// ── Health check (no balance fetches) ──────────────────────────────────────

async function runHealth(exchangeList: string[]): Promise<HealthBlock> {
  const { pingPacifica, pingHyperliquid, pingLighter } = await import("../shared-api.js");

  const pingAster = async (): Promise<{ ok: boolean; latencyMs: number; status: number }> => {
    const start = Date.now();
    try {
      const res = await fetch("https://fapi.asterdex.com/fapi/v1/time");
      return { ok: res.ok, latencyMs: Date.now() - start, status: res.status };
    } catch {
      return { ok: false, latencyMs: Date.now() - start, status: 0 };
    }
  };

  const pingMap: Record<string, () => Promise<{ ok: boolean; latencyMs: number; status: number }>> = {
    pacifica: pingPacifica,
    hyperliquid: pingHyperliquid,
    lighter: pingLighter,
    aster: pingAster,
  };

  const exchanges: Record<string, "ok" | "error"> = {};
  await Promise.all(exchangeList.map(async (ex) => {
    const fn = pingMap[ex];
    if (!fn) {
      exchanges[ex] = "error";
      return;
    }
    try {
      const r = await fn();
      exchanges[ex] = r.ok ? "ok" : "error";
    } catch {
      exchanges[ex] = "error";
    }
  }));

  const anyDown = Object.values(exchanges).some(v => v === "error");
  return { exchanges, anyDown };
}

// ── Arb top-5 ──────────────────────────────────────────────────────────────

async function fetchArbTop(): Promise<ArbOpportunityOut[]> {
  const { fetchAllFundingRates, TOP_SYMBOLS } = await import("../funding-rates.js");
  const { saveFundingSnapshot, getHistoricalAverages } = await import("../funding-history.js");

  let snapshot: Awaited<ReturnType<typeof fetchAllFundingRates>> | null;
  try {
    snapshot = await fetchAllFundingRates({ symbols: TOP_SYMBOLS, minSpread: 0 });
  } catch {
    snapshot = null;
  }
  if (!snapshot) return [];

  // Save snapshot for sparkline history (matches old status behavior).
  try {
    const allRates = snapshot.symbols.flatMap(s => s.rates);
    if (allRates.length > 0) saveFundingSnapshot(allRates);
  } catch { /* ignore */ }

  const top = snapshot.symbols
    .filter(s => s.maxSpreadAnnual >= 5)
    .sort((a, b) => b.maxSpreadAnnual - a.maxSpreadAnnual)
    .slice(0, 5);

  const syms = top.map(a => a.symbol);
  const avgs = syms.length > 0 ? getHistoricalAverages(syms, ["hyperliquid", "pacifica", "lighter"]) : new Map();

  return top.map(a => {
    const bestEx = a.rates.find(r => r.exchange === "hyperliquid")?.exchange ?? a.rates[0]?.exchange ?? "hyperliquid";
    const avg = avgs.get(`${a.symbol}:${bestEx}`);
    return {
      symbol: a.symbol,
      spreadAnnual: a.maxSpreadAnnual,
      direction: `${exAbbr(a.shortExchange)}>${exAbbr(a.longExchange)}`,
      longExchange: a.longExchange,
      shortExchange: a.shortExchange,
      avg24h: avg?.avg24h != null ? Math.abs(avg.avg24h) * 8760 * 100 : null,
      avg7d: avg?.avg7d != null ? Math.abs(avg.avg7d) * 8760 * 100 : null,
    };
  });
}

// ── Snapshot envelope builder ──────────────────────────────────────────────

async function buildSnapshotEnvelope(
  resolved: ResolvedOptions,
  version: string,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  mode: Mode = "snapshot",
): Promise<PortfolioEnvelopeData> {
  const entries = await Promise.all(
    resolved.exchangeList.map(ex => fetchExchangeEntry(ex, getAdapterForExchange)),
  );
  const { totals, risk } = buildTotals(entries);

  const data: PortfolioEnvelopeData = {
    version,
    scope: resolved.scope,
    mode,
    exchanges: entries,
    totals,
    risk,
  };

  if (resolved.arb) {
    data.arb = { topOpportunities: await fetchArbTop() };
  }

  return data;
}

// ── Text rendering ─────────────────────────────────────────────────────────

function renderSnapshotText(data: PortfolioEnvelopeData): void {
  const v = data.version;
  console.log(chalk.cyan.bold(`\n  perp-cli v${v}`) + chalk.gray(` — ${data.exchanges.filter(e => e.connected).length} exchanges connected\n`));

  // Balances column (per-exchange equity bars)
  const balLines: string[] = [];
  balLines.push(chalk.white.bold(" Balances"));
  for (const e of data.exchanges) {
    if (!e.connected) {
      balLines.push(` ${chalk.gray(exAbbr(e.name).padEnd(4))} ${chalk.red("disconnected")}`);
      continue;
    }
    const equity = e.perp ? Number(e.perp.equity) : 0;
    const margin = e.perp ? Number(e.perp.marginUsed) : 0;
    const exSpot = e.isUnified
      ? e.spot.filter(b => b.token.replace(/-SPOT$/i, "").toUpperCase() !== "USDC")
      : e.spot;
    const exSpotVal = exSpot.reduce((s, b) => s + b.valueUsd, 0);
    const total = equity + exSpotVal;
    const usagePct = equity > 0 ? (margin / equity) * 100 : 0;
    const barFull = Math.min(20, Math.round(usagePct / 5));
    const usageColor = usagePct < 30 ? chalk.green : usagePct < 60 ? chalk.yellow : chalk.red;
    const bar = usageColor("█".repeat(barFull)) + chalk.gray("░".repeat(20 - barFull));
    balLines.push(` ${chalk.white.bold(exAbbr(e.name).padEnd(4))} $${formatUsd(total).padEnd(9)} ${bar} ${usagePct.toFixed(0)}% used`);
  }

  // Spot holdings (non-USDC tokens with value across all exchanges)
  const allSpot: { exchange: string; token: string; total: string; valueUsd: number }[] = [];
  for (const e of data.exchanges) {
    const exSpot = e.isUnified
      ? e.spot.filter(b => b.token.replace(/-SPOT$/i, "").toUpperCase() !== "USDC")
      : e.spot;
    for (const b of exSpot) {
      const tk = b.token.replace(/[-_]SPOT$/i, "").toUpperCase();
      if (tk === "USDC") continue;
      allSpot.push({ exchange: e.name, token: b.token, total: b.total, valueUsd: b.valueUsd });
    }
  }
  if (allSpot.length > 0) {
    balLines.push("");
    balLines.push(chalk.white.bold(" Spot Holdings"));
    for (const b of allSpot) {
      const token = b.token.replace(/-SPOT$/i, "");
      balLines.push(` ${chalk.gray(exAbbr(b.exchange).padEnd(4))} ${chalk.white.bold(token.padEnd(6))} ${b.total.padEnd(12)} ${chalk.gray(`$${formatUsd(b.valueUsd)}`)}`);
    }
  }

  const riskColor = data.risk.level === "LOW" ? chalk.green : data.risk.level === "MEDIUM" ? chalk.yellow : chalk.red;
  balLines.push(` ${"─".repeat(44)}`);
  balLines.push(` ${chalk.cyan.bold("Total")} ${chalk.cyan.bold(`$${formatUsd(data.totals.accountValueUsd)}`.padEnd(9))}    Risk: ${riskColor(data.risk.level)}`);

  // Arb column (only when --arb passed)
  const arbLines: string[] = [];
  if (data.arb) {
    arbLines.push(chalk.white.bold(" Top Arb Opportunities"));
    if (data.arb.topOpportunities.length > 0) {
      arbLines.push(chalk.gray(" " + "".padEnd(8) + "now".padEnd(9) + "24h".padEnd(7) + "7d".padEnd(7)));
      for (const a of data.arb.topOpportunities) {
        const spreadColor = a.spreadAnnual >= 100 ? chalk.green.bold : a.spreadAnnual >= 30 ? chalk.green : chalk.yellow;
        const avg24h = a.avg24h != null ? `${a.avg24h.toFixed(0)}%` : "-";
        const avg7d = a.avg7d != null ? `${a.avg7d.toFixed(0)}%` : "-";
        arbLines.push(` ${chalk.white.bold(a.symbol.padEnd(8))} ${spreadColor(`${a.spreadAnnual.toFixed(1)}%`.padEnd(9))}${chalk.gray(avg24h.padEnd(7))}${chalk.gray(avg7d.padEnd(7))}${chalk.gray(a.direction)}`);
      }
    } else {
      arbLines.push(chalk.gray(" No opportunities above 5%"));
    }
  }

  // Layout: side-by-side if wide enough AND we have arb data, else stacked.
  const stripAnsi = (s: string) => s.replace(/\[[0-9;]*m/g, "");
  const termW = process.stdout.columns || 80;
  const SIDE_BY_SIDE_MIN = 100;

  if (data.arb && termW >= SIDE_BY_SIDE_MIN) {
    const LEFT_W = 46;
    const RIGHT_W = 48;
    const maxLines = Math.max(balLines.length, arbLines.length);
    console.log(`  ${"┌"}${"─".repeat(LEFT_W)}${"┬"}${"─".repeat(RIGHT_W)}${"┐"}`);
    for (let i = 0; i < maxLines; i++) {
      const left = balLines[i] ?? "";
      const right = arbLines[i] ?? "";
      const leftPad = LEFT_W - stripAnsi(left).length;
      const rightPad = RIGHT_W - stripAnsi(right).length;
      console.log(`  │${left}${" ".repeat(Math.max(0, leftPad))}│${right}${" ".repeat(Math.max(0, rightPad))}│`);
    }
    console.log(`  ${"└"}${"─".repeat(LEFT_W)}${"┴"}${"─".repeat(RIGHT_W)}${"┘"}`);
  } else {
    const boxW = Math.min(termW - 4, 74);
    const printBox = (lines: string[]) => {
      console.log(`  ${"┌"}${"─".repeat(boxW)}${"┐"}`);
      for (const line of lines) {
        const pad = boxW - stripAnsi(line).length;
        console.log(`  │${line}${" ".repeat(Math.max(0, pad))}│`);
      }
      console.log(`  ${"└"}${"─".repeat(boxW)}${"┘"}`);
    };
    printBox(balLines);
    if (arbLines.length > 0) {
      console.log();
      printBox(arbLines);
    }
  }

  // Positions table
  const allPositions: (PositionEntry & { exchange: string })[] = [];
  for (const e of data.exchanges) {
    for (const p of e.positions) allPositions.push({ ...p, exchange: e.name });
  }
  if (allPositions.length > 0) {
    console.log(chalk.white.bold("\n  Positions"));
    const posRows = allPositions.map(p => {
      const sideColor = p.side === "long" ? chalk.green : chalk.red;
      const notional = Math.abs(Number(p.size) * Number(p.markPrice));
      const levStr = p.leverage > 0 ? `${p.leverage}x` : "-";
      const warn = p.leverage >= 5 ? chalk.red(" ⚠") : "";
      return [
        chalk.white.bold(p.symbol.replace("-PERP", "")),
        chalk.gray(exAbbr(p.exchange)),
        sideColor(p.side.toUpperCase()),
        p.size,
        `$${formatUsd(p.entryPrice)}→$${formatUsd(p.markPrice)}`,
        formatPnl(p.unrealizedPnl),
        `$${formatUsd(notional)}`,
        levStr + warn,
      ];
    });
    console.log(makeTable(["Symbol", "Ex", "Side", "Size", "Entry→Mark", "uPnL", "Notional", "Lev"], posRows));
  } else {
    console.log(chalk.gray("\n  No open positions.\n"));
  }
}

function renderHealthText(h: HealthBlock): void {
  console.log(chalk.cyan.bold("\n  Exchange Health Check\n"));
  const rows = Object.entries(h.exchanges).map(([ex, status]) => {
    const statusIcon = status === "ok" ? chalk.green("OK") : chalk.red("DOWN");
    return [chalk.white.bold(ex), statusIcon];
  });
  console.log(makeTable(["Exchange", "Status"], rows));
  const overall = h.anyDown ? chalk.red("ISSUES DETECTED") : chalk.green("ALL HEALTHY");
  console.log(`\n  Overall: ${overall}\n`);
}

// ── Watch mode ─────────────────────────────────────────────────────────────

async function runWatch(
  resolved: ResolvedOptions,
  version: string,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJsonMode: boolean,
): Promise<void> {
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
    process.exit(0);
  });

  while (!stopped) {
    const data = await buildSnapshotEnvelope(resolved, version, getAdapterForExchange, "watch");
    if (isJsonMode) {
      // NDJSON-style: one envelope per tick, no padding.
      console.log(JSON.stringify(jsonOk(data)));
    } else {
      // Clear screen + redraw.
      process.stdout.write("[2J[H");
      renderSnapshotText(data);
      if (resolved.health) renderHealthText(await runHealth(resolved.exchangeList));
    }
    await new Promise<void>(r => setTimeout(r, resolved.watchIntervalMs));
  }
}

// ── Serve mode (delegates to dashboard infra) ──────────────────────────────

const KNOWN_HIP3_DEXES = ["xyz", "flx", "hyna", "km", "cash", "vntl"];
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

async function checkDexPositions(address: string, dex: string): Promise<number> {
  try {
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: address, dex }),
    });
    const state = await res.json() as Record<string, unknown>;
    const positions = (state?.assetPositions ?? []) as Record<string, unknown>[];
    return positions.filter(p => {
      const pos = (p.position ?? p) as Record<string, unknown>;
      return Number(pos.szi ?? 0) !== 0;
    }).length;
  } catch {
    return 0;
  }
}

async function autoDetectHip3Dexes(
  address: string,
  getHLAdapterForDex: (dex: string) => Promise<ExchangeAdapter>,
  verbose: boolean,
): Promise<DashboardExchange[]> {
  const checks = await Promise.all(
    KNOWN_HIP3_DEXES.map(async (dex) => ({
      dex,
      count: await checkDexPositions(address, dex),
    })),
  );
  const activeDexes = checks.filter(c => c.count > 0);
  const results: DashboardExchange[] = [];
  for (const { dex, count } of activeDexes) {
    try {
      const adapter = await getHLAdapterForDex(dex);
      results.push({ name: `hl:${dex}`, adapter });
      if (verbose) console.log(chalk.green(`  ✓ hl:${dex} (HIP-3, ${count} position${count > 1 ? "s" : ""})`));
    } catch { /* skip */ }
  }
  return results;
}

async function runServe(
  resolved: ResolvedOptions,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJsonMode: boolean,
  getHLAdapterForDex?: (dex: string) => Promise<ExchangeAdapter>,
): Promise<void> {
  const { startDashboard } = await import("../dashboard/index.js");

  if (isJsonMode) {
    const exchanges: DashboardExchange[] = [];
    for (const name of resolved.exchangeList) {
      try {
        const adapter = await getAdapterForExchange(name);
        exchanges.push({ name, adapter });
      } catch { /* skip */ }
    }
    if (getHLAdapterForDex) {
      for (const dex of resolved.dexList) {
        try {
          const adapter = await getHLAdapterForDex(dex);
          exchanges.push({ name: `hl:${dex}`, adapter });
        } catch { /* skip */ }
      }
      if (resolved.autoDex && !resolved.dexList.length && resolved.exchangeList.includes("hyperliquid")) {
        const hlEx = exchanges.find(e => e.name === "hyperliquid");
        const hlAddr = hlEx ? (hlEx.adapter as { address?: string }).address ?? "" : "";
        if (hlAddr) {
          const detected = await autoDetectHip3Dexes(hlAddr, getHLAdapterForDex, false);
          exchanges.push(...detected);
        }
      }
    }
    if (!exchanges.length) {
      console.log(JSON.stringify(jsonError("NO_EXCHANGES", "No exchange adapters could be initialized. Check your keys.")));
      process.exit(1);
    }
    const dashboard = await startDashboard(exchanges, { port: resolved.servePort, pollInterval: resolved.pollIntervalMs });
    const data: PortfolioEnvelopeData = {
      version: "",
      scope: resolved.scope,
      mode: "serve",
      exchanges: [],
      totals: { equity: 0, spotValueUsd: 0, accountValueUsd: 0, marginUsed: 0, marginPct: 0, funding24h: 0 },
      risk: { level: "LOW", marginPct: 0 },
      serve: {
        url: `http://localhost:${dashboard.port}`,
        port: dashboard.port,
        exchanges: exchanges.map(e => e.name),
      },
    };
    printJson(jsonOk(data));
    await new Promise(() => {});
    return;
  }

  console.log(chalk.cyan.bold("\n  perp-cli Live Dashboard\n"));
  console.log(chalk.gray(`  Initializing exchanges: ${resolved.exchangeList.join(", ")}${resolved.dexList.length ? ` + HIP-3: ${resolved.dexList.join(", ")}` : ""}...\n`));

  const exchanges: DashboardExchange[] = [];
  for (const name of resolved.exchangeList) {
    try {
      const adapter = await getAdapterForExchange(name);
      exchanges.push({ name, adapter });
      console.log(chalk.green(`  ✓ ${name}`));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(chalk.yellow(`  ✗ ${name}: ${msg.slice(0, 80)}`));
    }
  }

  if (getHLAdapterForDex) {
    for (const dex of resolved.dexList) {
      try {
        const adapter = await getHLAdapterForDex(dex);
        exchanges.push({ name: `hl:${dex}`, adapter });
        console.log(chalk.green(`  ✓ hl:${dex} (HIP-3)`));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.yellow(`  ✗ hl:${dex}: ${msg.slice(0, 80)}`));
      }
    }
    if (resolved.autoDex && !resolved.dexList.length && resolved.exchangeList.includes("hyperliquid")) {
      const hlEx = exchanges.find(e => e.name === "hyperliquid");
      const hlAddr = hlEx ? (hlEx.adapter as { address?: string }).address ?? "" : "";
      if (hlAddr) {
        console.log(chalk.gray("  Scanning HIP-3 dexes for active positions..."));
        const detected = await autoDetectHip3Dexes(hlAddr, getHLAdapterForDex, true);
        exchanges.push(...detected);
        if (!detected.length) console.log(chalk.gray("  No active HIP-3 dex positions found"));
      }
    }
  }

  if (!exchanges.length) {
    console.error(chalk.red("\n  No exchanges available. Check your private keys in .env\n"));
    process.exit(1);
  }

  console.log(chalk.gray(`\n  Starting server on port ${resolved.servePort}...`));

  const dashboard = await startDashboard(exchanges, { port: resolved.servePort, pollInterval: resolved.pollIntervalMs });

  console.log(chalk.cyan.bold("\n  Dashboard running at: ") + chalk.white.bold(`http://localhost:${dashboard.port}`));
  console.log(chalk.gray(`  Monitoring: ${exchanges.map(e => e.name).join(", ")}`));
  console.log(chalk.gray(`  Poll interval: ${resolved.pollIntervalMs}ms`));
  console.log(chalk.gray("  Press Ctrl+C to stop\n"));

  // Open browser automatically (best-effort)
  try {
    const { exec } = await import("child_process");
    const url = `http://localhost:${dashboard.port}`;
    if (process.platform === "darwin") exec(`open ${url}`);
    else if (process.platform === "linux") exec(`xdg-open ${url}`);
  } catch { /* user can open manually */ }

  const ac = new AbortController();
  process.on("SIGINT", () => {
    console.log(chalk.gray("\n  Shutting down dashboard..."));
    dashboard.close();
    ac.abort();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    dashboard.close();
    ac.abort();
    process.exit(0);
  });

  await new Promise(() => {});
}

// ── Registration ───────────────────────────────────────────────────────────

export function registerPortfolioCommand(
  program: Command,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  version: string,
  getHLAdapterForDex?: (dex: string) => Promise<ExchangeAdapter>,
): void {
  program
    .command("portfolio")
    .description("Unified account view: balances, positions, risk (replaces account balance / status / dashboard)")
    .option("--exchanges <list>", "Comma-separated exchanges to include (default: all). Plural to avoid collision with global -e/--exchange.")
    .option("--arb", "Include top arb opportunities (replaces 'perp status')")
    .option("--health", "Connectivity-only mode (replaces 'perp status --health')")
    .option("--watch [interval]", "Poll mode: clear screen + redraw each tick (ms; default 5000)")
    .option("--serve [port]", "Serve web dashboard (replaces 'perp dashboard')")
    .option("--interval <ms>", "Poll interval for --watch / --serve (default 5000)")
    .option("--dex <list>", "Comma-separated HIP-3 dex names (only with --serve)")
    .option("--no-auto-dex", "Disable HIP-3 dex auto-detection")
    .option("--stdin", "Read JSON args from stdin (overrides flag args)")
    .action(async (flags: CliFlags) => {
      const json = isJson();
      let stdinOpts: StdinOptions = {};
      if (flags.stdin) {
        try {
          stdinOpts = await readStdinJson();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (json) {
            console.log(JSON.stringify(jsonError("INVALID_PARAMS", `Invalid stdin JSON: ${msg}`)));
          } else {
            console.error(chalk.red(`Error: invalid stdin JSON — ${msg}`));
          }
          process.exit(1);
        }
      }

      let resolved: ResolvedOptions;
      try {
        resolved = resolveOptions(program, flags, stdinOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          console.log(JSON.stringify(jsonError("INVALID_PARAMS", msg)));
        } else {
          console.error(chalk.red(`Error: ${msg}`));
        }
        process.exit(1);
      }

      // Mode dispatch (mutually exclusive — checked in priority order)
      if (resolved.serve) {
        return runServe(resolved, getAdapterForExchange, json, getHLAdapterForDex);
      }
      if (resolved.watch) {
        return runWatch(resolved, version, getAdapterForExchange, json);
      }

      await withJsonErrors(json, async () => {
        if (resolved.health) {
          const health = await runHealth(resolved.exchangeList);
          const data: PortfolioEnvelopeData = {
            version,
            scope: resolved.scope,
            mode: "health",
            exchanges: [],
            totals: { equity: 0, spotValueUsd: 0, accountValueUsd: 0, marginUsed: 0, marginPct: 0, funding24h: 0 },
            risk: { level: "LOW", marginPct: 0 },
            health,
          };
          if (json) return printJson(jsonOk(data));
          renderHealthText(health);
          return;
        }

        const data = await buildSnapshotEnvelope(resolved, version, getAdapterForExchange, "snapshot");
        if (json) return printJson(jsonOk(data));
        renderSnapshotText(data);
      });
    });
}
