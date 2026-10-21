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
import { getVenue, listVenuesWithRole, roleUnsupported, tryResolveVenueId } from "../exchanges/venue.js";
import { PerpError } from "../errors.js";
import "../exchanges/venues/index.js";
import { listConfiguredAccountVenues } from "../config.js";
import { HYPERLIQUID_API_URL } from "../api/public/urls.js";
import { fetchValuedSpotBalances, getSpotAdapter, spotSharesPerpMargin, withSpotTimeout } from "../exchanges/spot-factory.js";
import { scrubSecretEnv } from "../secret-env.js";
import { networkOf } from "../cli-flags.js";
import type { Network } from "../exchanges/venue-types.js";
import { probeVenueHealth, type VenueProbe } from "../venue-health.js";

// ── Types ──────────────────────────────────────────────────────────────────

/** Venues with an account API (market-data-only venues are excluded). */
function accountVenueIds(): string[] {
  return listVenuesWithRole("account").map(v => v.id);
}

type Mode = "snapshot" | "health" | "watch" | "serve";

interface SpotHolding {
  token: string;
  total: string;
  available: string;
  held?: string;
  valueUsd: number;
  /** true = same money as perp equity (Pacifica USDC, HL unified USDC) — not added to totals. */
  shared: boolean;
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
  liquidationPrice: string | null;
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
  /** Funding paid / received in the last 24 h; null = the venue's funding history could not be read. */
  funding24h: number | null;
  fundingError: string | null;
  totalAccountValueUsd: number;
  error: string | null;
}

interface Totals {
  equity: number;
  spotValueUsd: number;
  accountValueUsd: number;
  marginUsed: number;
  marginPct: number;
  /** Sum over the venues whose funding was read (see fundingIncomplete). */
  funding24h: number;
  /** true = at least one venue's funding24h is null and is left out of the sum. */
  fundingIncomplete: boolean;
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
  /** Per-venue probe detail (latency, HTTP status, error, probe kind, apiStatus) — src/venue-health.ts. */
  probes: VenueProbe[];
  /** Requested venues with no environment on the network: not probed. */
  skipped: Array<{ venue: string; reason: string }>;
}

interface ServeBlock {
  url: string;
  port: number;
  exchanges: string[];
  /** Venue (or hl:<dex>) adapters that could not be initialized and are NOT monitored. */
  errors: Record<string, string>;
}

/**
 * `--health` is connectivity only: no balance / position is read, so there are no exchange
 * entries, totals or risk to report — they are null (unknown), never zero-filled.
 */
interface PortfolioHealthEnvelopeData {
  version: string;
  scope: "all" | "single";
  mode: "health";
  exchanges: null;
  totals: null;
  risk: null;
  health: HealthBlock;
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
  exchangeList: string[];      // account-role venue ids to fetch
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
  /** Validated root -n network (health probes hit this network's endpoints). */
  network: Network;
}

// ── CLI flags type ─────────────────────────────────────────────────────────

interface CliFlags {
  exchanges?: string;       // --exchanges <list> (sub-command, comma list; plural to avoid collision with global -e/--exchange)
  arb?: boolean;
  health?: boolean;
  watch?: string | boolean;
  serve?: string | boolean;
  interval?: string;
  dexes?: string;           // --dexes <list> (plural: the root --dex is swallowed by the root program)
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
  const valid = accountVenueIds();
  // Aliases (hl, pac, lt, lrh, ast, …) resolve through the venue registry, like every other command.
  const ids = list.map(s => tryResolveVenueId(s) ?? s.toLowerCase());
  // A registered market-data-only venue (TxFlow) is a capability refusal, not an unknown name.
  for (const id of ids) {
    const known = tryResolveVenueId(id);
    if (known !== null && !valid.includes(known)) throw roleUnsupported(getVenue(known), "account");
  }
  const unknown = ids.filter(e => !valid.includes(e));
  if (unknown.length > 0) {
    throw new PerpError("INVALID_PARAMS", `Unknown exchange: ${unknown.join(", ")}`, { remediation: `Use one of: ${valid.join(", ")} (or an alias such as hl, pac, lt, lrh, ast)` });
  }
  return ids;
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
  defaultExchanges: string[],
): ResolvedOptions {
  // 1) Build exchange list. Precedence: stdin > --exchanges > -e > all configured.
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
      exchangeList = [...defaultExchanges];
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

  // --dexes, or the root --dex when typed on the command line (backward compatible: `portfolio --serve --dex xyz`
  // reaches the root option, which used to swallow a subcommand --dex silently).
  const rootDex = program.getOptionValueSource("dex") === "cli" ? String(program.opts().dex) : undefined;
  const dexList = stdinOpts.dex ?? parseList(flags.dexes ?? rootDex);
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
    network: networkOf(program),
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
      adapter.getFundingPayments(200).then(
        (rows) => ({ rows, error: null as string | null }),
        (e: unknown) => ({ rows: null, error: e instanceof Error ? e.message : String(e) }),
      ),
    ]);

    // Spot balances for every venue with def.spot. Failures are surfaced on
    // stderr (the perp snapshot is still reported); unpriced tokens are excluded + warned.
    let spot: SpotHolding[] = [];
    let isUnified = false;
    const def = getVenue(exName);
    const warn = (msg: string) => process.stderr.write(`[warn] ${msg}\n`);
    try {
      const spotAdapter = await withSpotTimeout(getSpotAdapter(def.id, adapter), `${def.displayName} spot adapter`);
      if (spotAdapter !== null) {
        // Wallet-model venues (Arcus) price only held tokens; bounded by SPOT_VALUATION_TIMEOUT_MS.
        spot = (await fetchValuedSpotBalances(def, spotAdapter, warn)).map(b => ({
          token: b.token, total: b.total, available: b.available, held: b.held, valueUsd: b.valueUsd, shared: b.shared,
        }));
        // HIP-3 dex accounts always run standard (non-unified) semantics. Codex v0.12.12 final QA #1.
        const dexScoped = isDexCapable(adapter) && !!adapter.dex;
        isUnified = !dexScoped && spotSharesPerpMargin(def, adapter);
      }
    } catch (e) {
      warn(`${def.displayName} spot balances unavailable: ${e instanceof Error ? e.message : String(e)}`);
    }

    const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
    if (fundingPayments.error !== null) warn(`${def.displayName} funding history unavailable (funding24h null): ${fundingPayments.error}`);
    const funding24h = fundingPayments.rows === null
      ? null
      : fundingPayments.rows.filter(f => f.time >= cutoff24h).reduce((sum, f) => sum + Number(f.payment), 0);

    // Shared balances (Pacifica USDC, HL unified USDC) are already in perp equity.
    const nonUsdcSpotValue = spot.filter(b => !b.shared).reduce((s, b) => s + b.valueUsd, 0);

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
        liquidationPrice: p.liquidationPrice,
        unrealizedPnl: p.unrealizedPnl,
        leverage: p.leverage,
      })),
      openOrders: orders.length,
      funding24h,
      fundingError: fundingPayments.error,
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
      funding24h: null,
      // The whole venue was unreadable: funding is unknown for the same reason.
      fundingError: err instanceof Error ? err.message : String(err),
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
  let fundingIncomplete = false;
  let accountValueUsd = 0;

  for (const e of entries) {
    if (e.perp) {
      equity += Number(e.perp.equity);
      marginUsed += Number(e.perp.marginUsed);
    }
    if (e.funding24h === null) fundingIncomplete = true;
    else funding24h += e.funding24h;

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
    totals: { equity, spotValueUsd, accountValueUsd, marginUsed, marginPct, funding24h, fundingIncomplete },
    risk: { level, marginPct },
  };
}

// ── Health check (no balance fetches) ──────────────────────────────────────

async function runHealth(exchangeList: string[], network: Network): Promise<HealthBlock> {
  // The same probe as `perp health` and the MCP health_check, over the selected venues.
  const h = await probeVenueHealth(network, exchangeList);
  const exchanges: Record<string, "ok" | "error"> = {};
  for (const p of h.probes) exchanges[p.venue] = p.ok ? "ok" : "error";
  return { exchanges, anyDown: !h.allHealthy, probes: h.probes, skipped: h.skipped };
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
  const rows = h.probes.map((p) => [
    chalk.white.bold(p.venue),
    p.ok ? chalk.green("OK") : chalk.red("DOWN"),
    `${p.latencyMs}ms`,
    p.error !== null ? chalk.red(p.error) : chalk.gray("-"),
  ]);
  console.log(makeTable(["Exchange", "Status", "Latency", "Error"], rows));
  for (const s of h.skipped) console.log(chalk.gray(`  ${s.venue}: not probed — ${s.reason}`));
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
      if (resolved.health) renderHealthText(await runHealth(resolved.exchangeList, resolved.network));
    }
    await new Promise<void>(r => setTimeout(r, resolved.watchIntervalMs));
  }
}

// ── Serve mode (delegates to dashboard infra) ──────────────────────────────

export const KNOWN_HIP3_DEXES = ["xyz", "flx", "hyna", "km", "cash", "vntl", "abcd", "para", "mkts", "io"];

/**
 * Open-position count on a HIP-3 dex; null = the read failed (unknown — NOT "no positions").
 * The failure is warned on stderr; callers must treat null as "may hold positions".
 */
export async function checkDexPositions(address: string, dex: string): Promise<number | null> {
  try {
    // Selected network (review L7): follows -n via setSharedApiNetwork (live binding).
    const res = await fetch(HYPERLIQUID_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: address, dex }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = await res.json() as Record<string, unknown>;
    if (!state || !Array.isArray(state.assetPositions)) throw new Error("clearinghouseState without assetPositions");
    return (state.assetPositions as Record<string, unknown>[]).filter(p => {
      const pos = (p.position ?? p) as Record<string, unknown>;
      const szi = Number(pos.szi);
      if (!Number.isFinite(szi)) throw new Error(`position without a numeric szi (${String(pos.coin)})`);
      return szi !== 0;
    }).length;
  } catch (e) {
    process.stderr.write(`[warn] hl:${dex} positions unknown (HIP-3 dex read failed; included in the dashboard): ${e instanceof Error ? e.message : String(e)}\n`);
    return null;
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
  // Unknown (null) counts are included: a failed read must not hide a dex that may hold positions.
  const activeDexes = checks.filter(c => c.count === null || c.count > 0);
  const results: DashboardExchange[] = [];
  for (const { dex, count } of activeDexes) {
    try {
      const adapter = await getHLAdapterForDex(dex);
      results.push({ name: `hl:${dex}`, adapter });
      if (verbose) {
        console.log(count === null
          ? chalk.yellow(`  ⚠ hl:${dex} (HIP-3, positions unknown — read failed)`)
          : chalk.green(`  ✓ hl:${dex} (HIP-3, ${count} position${count > 1 ? "s" : ""})`));
      }
    } catch (e) {
      process.stderr.write(`[warn] hl:${dex} left out of the dashboard (adapter unavailable${count === null ? ", positions unknown" : `, ${count} position(s)`}): ${e instanceof Error ? e.message : String(e)}\n`);
    }
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
    // A venue whose adapter failed is not monitored — reported in serve.errors + stderr, not dropped silently.
    const errors: Record<string, string> = {};
    const noteError = (name: string, e: unknown) => {
      errors[name] = e instanceof Error ? e.message : String(e);
      process.stderr.write(`[warn] ${name} not monitored (adapter unavailable): ${errors[name]}\n`);
    };
    for (const name of resolved.exchangeList) {
      try {
        const adapter = await getAdapterForExchange(name);
        exchanges.push({ name, adapter });
      } catch (e) { noteError(name, e); }
    }
    if (getHLAdapterForDex) {
      for (const dex of resolved.dexList) {
        try {
          const adapter = await getHLAdapterForDex(dex);
          exchanges.push({ name: `hl:${dex}`, adapter });
        } catch (e) { noteError(`hl:${dex}`, e); }
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
      totals: { equity: 0, spotValueUsd: 0, accountValueUsd: 0, marginUsed: 0, marginPct: 0, funding24h: 0, fundingIncomplete: false },
      risk: { level: "LOW", marginPct: 0 },
      serve: {
        url: `http://localhost:${dashboard.port}`,
        port: dashboard.port,
        exchanges: exchanges.map(e => e.name),
        errors,
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
    if (process.platform === "darwin") exec(`open ${url}`, { env: scrubSecretEnv(process.env) });
    else if (process.platform === "linux") exec(`xdg-open ${url}`, { env: scrubSecretEnv(process.env) });
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
    .option("--exchanges <list>", "Comma-separated exchanges to include (default: all with configured credentials). Plural to avoid collision with global -e/--exchange.")
    .option("--arb", "Include top arb opportunities (replaces 'perp status')")
    .option("--health", "Connectivity-only mode (replaces 'perp status --health')")
    .option("--watch [interval]", "Poll mode: clear screen + redraw each tick (ms; default 5000)")
    .option("--serve [port]", "Serve web dashboard (replaces 'perp dashboard')")
    .option("--interval <ms>", "Poll interval for --watch / --serve (default 5000)")
    .option("--dexes <list>", "Comma-separated HIP-3 dex names (only with --serve; the root --dex <name> is also accepted)")
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
        resolved = resolveOptions(program, flags, stdinOpts, await listConfiguredAccountVenues());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (json) {
          // A typed refusal (CAPABILITY_UNSUPPORTED for a market-data-only venue) keeps its code.
          const s = err instanceof PerpError ? err.structured : null;
          console.log(JSON.stringify(s !== null
            ? jsonError(s.code, msg, { ...(s.details !== undefined ? { details: s.details } : {}), ...(s.remediation !== undefined ? { remediation: s.remediation } : {}) })
            : jsonError("INVALID_PARAMS", msg)));
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
          const health = await runHealth(resolved.exchangeList, resolved.network);
          const data: PortfolioHealthEnvelopeData = {
            version,
            scope: resolved.scope,
            mode: "health",
            exchanges: null,
            totals: null,
            risk: null,
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
