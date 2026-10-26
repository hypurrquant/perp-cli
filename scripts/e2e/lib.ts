/**
 * E2E runner helpers: CLI execution + JSON envelope parsing, prompts, decimal
 * rounding, kill switch and report writing. No venue logic here.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_ENTRY = join(REPO_ROOT, "dist", "index.js");
export const REPORT_DIR = join(homedir(), ".perp", "e2e-reports");
/** Kill switch: while this file exists the runner refuses to start and stops before the next step. */
export const KILL_FILE = join(homedir(), ".perp", "e2e-kill");

// ── CLI execution ──────────────────────────────────────────────────────────

export interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; retryable?: boolean; remediation?: string; details?: Record<string, unknown> };
  meta?: Record<string, unknown>;
}

export interface CliResult {
  argv: string[];
  command: string;
  exitCode: number | null;
  /** true = killed by the runner's timeout (the outcome of a write is then UNKNOWN). */
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  envelope: Envelope | null;
}

/** Last parsable top-level JSON object in stdout (printJson pretty-prints one envelope). */
export function parseEnvelope(stdout: string): Envelope | null {
  const text = stdout.trim();
  if (text === "") return null;
  try {
    const v = JSON.parse(text) as unknown;
    return isEnvelope(v) ? v : null;
  } catch { /* fall through: noise before the JSON */ }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith("{")) continue;
    try {
      const v = JSON.parse(lines.slice(i).join("\n")) as unknown;
      if (isEnvelope(v)) return v;
    } catch { /* keep scanning upward */ }
  }
  return null;
}

function isEnvelope(v: unknown): v is Envelope {
  return typeof v === "object" && v !== null && typeof (v as { ok?: unknown }).ok === "boolean";
}

export function shellQuote(a: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
}

/** Human-readable command an operator can paste (uses the `perp` bin name). */
export function displayCommand(argv: string[]): string {
  return ["perp", ...argv].map(shellQuote).join(" ");
}

export async function runCli(argv: string[], opts: { timeoutMs: number; env: Record<string, string> }): Promise<CliResult> {
  const started = Date.now();
  return await new Promise<CliResult>(resolvePromise => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...argv], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...opts.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString(); });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, opts.timeoutMs);
    child.on("close", code => {
      clearTimeout(timer);
      resolvePromise({
        argv, command: displayCommand(argv), exitCode: code, timedOut,
        durationMs: Date.now() - started, stdout, stderr, envelope: parseEnvelope(stdout),
      });
    });
  });
}

// ── Prompts ────────────────────────────────────────────────────────────────

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirmYesNo(question: string): Promise<boolean> {
  return /^y(es)?$/i.test(await ask(`${question} [y/N]: `));
}

// ── Decimal helpers (venue step / tick grids) ──────────────────────────────

export function decimalsOf(step: string): number {
  const s = /e/i.test(step) ? Number(step).toFixed(20).replace(/0+$/, "") : step;
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

/** Round `x` UP to a multiple of `step`, formatted with the step's decimals. */
export function ceilToStep(x: number, step: string): string {
  const st = Number(step);
  const d = decimalsOf(step);
  const n = Math.ceil(Number((x / st).toFixed(9))) * st;
  return n.toFixed(d);
}

/** Round `x` DOWN to a multiple of `step`. */
export function floorToStep(x: number, step: string): string {
  const st = Number(step);
  const d = decimalsOf(step);
  const n = Math.floor(Number((x / st).toFixed(9))) * st;
  return n.toFixed(d);
}

/** Round a price to the tick grid (`dir` = away from / toward the market as the caller needs). */
export function roundToTick(price: number, tick: string, dir: "down" | "up"): string {
  return dir === "down" ? floorToStep(price, tick) : ceilToStep(price, tick);
}

/** Hyperliquid price rule: ≤ 5 significant figures and ≤ (6 − szDecimals) decimals (perps). */
export function hlPrice(price: number, szDecimals: number, dir: "down" | "up"): string {
  const maxDec = Math.max(0, 6 - szDecimals);
  const intDigits = Math.max(1, Math.floor(Math.log10(Math.abs(price))) + 1);
  const dec = Math.min(maxDec, Math.max(0, 5 - intDigits));
  const f = 10 ** dec;
  const v = dir === "down" ? Math.floor(price * f) / f : Math.ceil(price * f) / f;
  return v.toFixed(dec);
}

// ── Kill switch / signals ──────────────────────────────────────────────────

export function killSwitchActive(): boolean {
  return existsSync(KILL_FILE);
}

// ── Report ─────────────────────────────────────────────────────────────────

export type StepOutcome = "pass" | "fail" | "skipped" | "planned" | "observed" | "stopped";

export interface StepRecord {
  id: string;
  title: string;
  phase: string;
  outcome: StepOutcome;
  /** Exact command (paste-able). null for runner-internal checks. */
  command: string | null;
  /** Worst-case open notional (USD) if this step executes as intended; null = not an exposure step. */
  worstCaseNotionalUsd: number | null;
  exitCode: number | null;
  durationMs: number | null;
  envelope: Envelope | null;
  stderrTail: string | null;
  assertions: Array<{ name: string; ok: boolean; detail: string }>;
  /** Observations recorded for later analysis (venue behaviour the design left open). */
  observations: Record<string, unknown>;
  settles: string[];
  note: string | null;
}

export interface RunReport {
  tool: "perp-e2e";
  version: 1;
  startedAt: string;
  finishedAt: string | null;
  venue: string;
  cliVenue: string;
  dex: string | null;
  network: string;
  phases: string[];
  dryRun: boolean;
  /** true = a mainnet run started with --operator-authorized <venue> (no typed venue-name confirmation; per-step prompts auto-confirmed and recorded). */
  operatorAuthorized: boolean;
  cliVersion: string | null;
  gitCommit: string | null;
  options: Record<string, unknown>;
  market: Record<string, unknown> | null;
  sizing: Record<string, unknown> | null;
  /** HIP-3 leg of a hyperliquid run (steps `hip3-*`), null when the run has none. */
  hip3: { dex: string; market: Record<string, unknown> | null; sizing: Record<string, unknown> | null } | null;
  capabilities: Record<string, unknown> | null;
  prerequisites: string[];
  steps: StepRecord[];
  /** Design items → outcome summary from the steps that settle them. */
  designItems: Record<string, { what: string; steps: string[]; status: string }>;
  stopReason: string | null;
  cleanup: string[];
  result: "pass" | "fail" | "stopped" | "dry-run" | "preflight-fail";
}

export function writeReport(report: RunReport): { json: string; md: string } {
  mkdirSync(REPORT_DIR, { recursive: true });
  const ts = report.startedAt.replace(/[:.]/g, "-");
  const base = join(REPORT_DIR, `${ts}-${report.venue}-${report.network}`);
  const json = `${base}.json`;
  const md = `${base}.md`;
  writeFileSync(json, JSON.stringify(report, null, 2));
  writeFileSync(md, renderMarkdown(report));
  return { json, md };
}

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderMarkdown(r: RunReport): string {
  const out: string[] = [];
  out.push(`# perp E2E — ${r.venue}${r.dex !== null ? ` (dex ${r.dex})` : ""}${r.hip3 !== null ? ` + HIP-3 dex ${r.hip3.dex}` : ""} / ${r.network}`);
  out.push("");
  out.push(`- Result: **${r.result}**${r.stopReason !== null ? ` — ${r.stopReason}` : ""}`);
  out.push(`- Started: ${r.startedAt} · Finished: ${r.finishedAt ?? "-"}`);
  out.push(`- Phases: ${r.phases.join(", ")} · dry-run: ${r.dryRun}`);
  if (r.operatorAuthorized) out.push("- **OPERATOR-AUTHORIZED mainnet run** (`operatorAuthorized: true`): no typed venue-name confirmation; deposit / withdraw / approve prompts auto-confirmed (steps `*-operator-confirm`)");
  out.push(`- CLI: ${r.cliVersion ?? "?"} · commit: ${r.gitCommit ?? "?"}`);
  out.push(`- Options: \`${JSON.stringify(r.options)}\``);
  if (r.market !== null) out.push(`- Market: \`${JSON.stringify(r.market)}\``);
  if (r.sizing !== null) out.push(`- Sizing: \`${JSON.stringify(r.sizing)}\``);
  if (r.hip3 !== null && r.hip3.market !== null) out.push(`- HIP-3 (${r.hip3.dex}) market: \`${JSON.stringify(r.hip3.market)}\``);
  if (r.hip3 !== null && r.hip3.sizing !== null) out.push(`- HIP-3 (${r.hip3.dex}) sizing: \`${JSON.stringify(r.hip3.sizing)}\``);
  if (r.capabilities !== null) out.push(`- Capabilities: \`${JSON.stringify(r.capabilities)}\``);
  if (r.prerequisites.length > 0) {
    out.push("", "## Prerequisites", ...r.prerequisites.map(p => `- ${p}`));
  }
  out.push("", "## Steps", "", "| # | phase | step | outcome | exit | ms | worst-case $ | settles | command |", "|---|---|---|---|---|---|---|---|---|");
  r.steps.forEach((s, i) => {
    out.push(`| ${i + 1} | ${s.phase} | ${cell(`${s.id}: ${s.title}`)} | ${s.outcome} | ${s.exitCode ?? "-"} | ${s.durationMs ?? "-"} | ${s.worstCaseNotionalUsd !== null ? s.worstCaseNotionalUsd.toFixed(2) : "-"} | ${s.settles.join(" ")} | ${s.command !== null ? `\`${cell(s.command)}\`` : "-"} |`);
  });
  out.push("", "## Step details");
  for (const s of r.steps) {
    out.push("", `### ${s.id} — ${s.title} (${s.outcome})`);
    if (s.command !== null) out.push("", "```", s.command, "```");
    if (s.note !== null) out.push("", `Note: ${s.note}`);
    for (const a of s.assertions) out.push(`- [${a.ok ? "x" : " "}] ${a.name}: ${a.detail}`);
    if (Object.keys(s.observations).length > 0) out.push("", "Observations:", "```json", JSON.stringify(s.observations, null, 2), "```");
    if (s.envelope !== null) out.push("", "<details><summary>envelope</summary>", "", "```json", JSON.stringify(s.envelope, null, 2), "```", "", "</details>");
    if (s.stderrTail !== null && s.stderrTail !== "") out.push("", "<details><summary>stderr (tail)</summary>", "", "```", s.stderrTail, "```", "", "</details>");
  }
  out.push("", "## Design items", "", "| item | what | steps | status |", "|---|---|---|---|");
  for (const [k, v] of Object.entries(r.designItems)) out.push(`| ${k} | ${cell(v.what)} | ${v.steps.join(", ")} | ${cell(v.status)} |`);
  if (r.cleanup.length > 0) out.push("", "## Cleanup / verify by hand", ...r.cleanup.map(c => `- \`${c}\``));
  out.push("");
  return out.join("\n");
}

// ── Write-outcome + exposure safety (M4/M5) ────────────────────────────────

/**
 * Error codes that PROVE a write was not executed (refused before sending or rejected by the
 * venue). EXCHANGE_ERROR / EXCHANGE_UNREACHABLE / TIMEOUT / UNKNOWN / ORDER_PENDING /
 * ORDER_PARTIAL are NOT definite: the write may have landed.
 */
export const DEFINITE_REJECTION_CODES: ReadonlySet<string> = new Set([
  "ORDER_REJECTED", "ACTION_REJECTED", "INVALID_PARAMS", "CAPABILITY_UNSUPPORTED", "SIZE_TOO_SMALL", "SIZE_TOO_LARGE",
  "INSUFFICIENT_BALANCE", "MARGIN_INSUFFICIENT", "RISK_VIOLATION", "INVALID_TICK", "TIF_REQUIRED",
  "ORDER_NOT_FOUND", "POSITION_NOT_FOUND", "SYMBOL_NOT_FOUND", "NOT_IMPLEMENTED",
]);

export function isDefiniteRejection(env: Envelope): boolean {
  return !env.ok && env.error !== undefined && DEFINITE_REJECTION_CODES.has(env.error.code);
}

/**
 * For a write step whose envelope is an error: null when the error is a definite rejection
 * (safe to continue), else the reason the run must stop (outcome unknown).
 */
export function unknownWriteOutcome(env: Envelope): string | null {
  if (env.ok || isDefiniteRejection(env)) return null;
  return `${env.error?.code ?? "?"} is not a definite rejection — the write may have executed: ${env.error?.message ?? ""}`;
}

/**
 * USD notional currently at risk: |size| × markPrice per open position plus unfilled size ×
 * price per resting order (reduce-only legs included — conservative). Throws when a row
 * cannot be valued (never guesses a price).
 */
export function openExposureUsd(
  positions: ReadonlyArray<{ symbol: string; size: string; markPrice?: string }>,
  orders: ReadonlyArray<{ symbol: string; size: string; price: string; filled?: string }>,
): number {
  let total = 0;
  for (const p of positions) {
    const size = Math.abs(Number(p.size));
    if (size === 0) continue;
    const mark = Number(p.markPrice);
    if (!Number.isFinite(size) || !Number.isFinite(mark) || mark <= 0) throw new Error(`cannot value position ${p.symbol} (size ${p.size}, markPrice ${String(p.markPrice)})`);
    total += size * mark;
  }
  for (const o of orders) {
    const open = Math.abs(Number(o.size)) - Math.abs(Number(o.filled ?? "0"));
    const price = Number(o.price);
    if (!Number.isFinite(open) || !Number.isFinite(price) || price <= 0) throw new Error(`cannot value open order on ${o.symbol} (size ${o.size}, price ${o.price})`);
    if (open > 0) total += open * price;
  }
  return total;
}

/**
 * Exposure if a write step executes: what is open now, minus what the step replaces or closes
 * (`offsetUsd`: the order an edit replaces; the long a resting sell would close), plus the step's
 * own worst case. The runner skips the step when this exceeds --max-usd.
 */
export function projectedExposureUsd(openUsd: number, worstCaseUsd: number, offsetUsd: number): number {
  for (const [k, v] of [["open", openUsd], ["worstCase", worstCaseUsd], ["offset", offsetUsd]] as const) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`projectedExposureUsd: ${k} is not a notional (${v})`);
  }
  return Math.max(openUsd - offsetUsd, 0) + worstCaseUsd;
}

/**
 * Units of `base` held, from a `trade spot-balance` envelope's data (`{ balances: SpotBalance[] }`,
 * non-zero rows only — an absent token is a zero holding). Uses `total` (includes amounts held
 * in open orders — conservative). Throws when the data cannot be read (never guesses).
 */
export function spotHoldingOf(data: unknown, base: string): number {
  const rows = Array.isArray(data) ? data : (data as { balances?: unknown } | null)?.balances;
  if (!Array.isArray(rows)) throw new Error("spot-balance returned no balances array");
  const b = base.toUpperCase();
  // Exact token match: a prefix match would read ETHFI as ETH.
  const row = (rows as Array<{ token?: unknown; total?: unknown }>).find(r => String(r.token ?? "").toUpperCase() === b);
  if (row === undefined) return 0;
  const total = Number(row.total);
  if (!Number.isFinite(total) || total < 0) throw new Error(`cannot read spot ${base} total (${String(row.total)})`);
  return total;
}

/**
 * USD value of the spot `base` acquired during the run (current − baseline holding, floored at 0)
 * at the public mid. Throws when something acquired cannot be valued.
 */
export function spotAcquiredUsd(baseline: number, current: number, mid: number | null): number {
  const acquired = current - baseline;
  if (!(acquired > 0)) return 0;
  if (mid === null || !Number.isFinite(mid) || mid <= 0) throw new Error(`cannot value ${acquired} spot units acquired this run: no public mid`);
  return acquired * mid;
}

/** Max allowed deviation of an operator-supplied --spot-ref-price from the public reference. */
export const SPOT_REF_MAX_DEVIATION = 0.05;

/** null when `ref` is within 5% of the public price, else the refusal reason. A missing public price refuses. */
export function spotRefPriceProblem(ref: number, publicPrice: number | null): string | null {
  if (publicPrice === null || !Number.isFinite(publicPrice) || publicPrice <= 0) {
    return "no public reference price to cross-check --spot-ref-price against — refusing on mainnet";
  }
  const dev = Math.abs(ref / publicPrice - 1);
  if (dev > SPOT_REF_MAX_DEVIATION) {
    return `--spot-ref-price ${ref} is ${(dev * 100).toFixed(1)}% off the public price ${publicPrice} (max ${SPOT_REF_MAX_DEVIATION * 100}%)`;
  }
  return null;
}

// ── Spot market auto-selection (spot phase without --spot-symbol / --spot-size) ──

/** One public spot market as the runner reads it (per-venue fetchers in run.ts). */
export interface SpotCandidate {
  /** Symbol passed to the CLI (`trade spot-buy <symbol>`): the base token. */
  symbol: string;
  quote: string;
  /** Public mark / last price; null = none published. */
  mark: number | null;
  /** true = a two-sided book exists, false = one-sided / empty, null = the venue data does not say. */
  twoSided: boolean | null;
  /** Book mid when published (checked against the mark: a mid > 2% off means a thin / broken book). */
  mid: number | null;
  /** 24h quote volume (USD); null = not published. Ranking key ("most liquid"). */
  volume24hUsd: number | null;
  /** Size grid. */
  step: string;
  /** Venue minimums; null = not published. */
  minSize: number | null;
  minNotional: number | null;
  /** Venue key the runner reads the live book with (HL l2Book coin, Lighter market_id, Pacifica symbol). */
  bookRef: string;
}

export interface SpotPick { symbol: string; size: string; mark: number; notional: number; volume24hUsd: number | null; minSize: number | null; minNotional: number | null; bookRef: string }

/** pickSpotMarket rejection reason for an empty / one-sided book (the runner SKIPs spot when every market has it). */
export const NO_TWO_SIDED_BOOK = "no two-sided book";

/** Rejection reason prefix for a book whose mid is > 2% off the mark (thin / broken book). */
export const BOOK_MID_OFF = "book mid";

/** pickSpotMarket rejection reason for a market without a public price (no trades / no book). */
export const NO_PUBLIC_PRICE = "no public price";

/**
 * A market-quality rejection (no public price, empty / one-sided book, or mid off the mark) — a
 * venue limitation the operator cannot fix, unlike a cap or a missing minimum.
 */
export function isBookRejection(reason: string): boolean {
  return reason === NO_TWO_SIDED_BOOK || reason === NO_PUBLIC_PRICE || reason.startsWith(BOOK_MID_OFF);
}

/** Max mid deviation from the mark for a usable spot book. */
export const SPOT_BOOK_MAX_MID_DEV = 0.02;

/** Size headroom over the venue minimum notional so a tick move / slippage cannot drop the order under it. */
export const SPOT_MIN_NOTIONAL_BUFFER = 1.1;

/**
 * Smallest order notional (USD) the runner sends, perp and spot: the $10 venue minimums plus a
 * buffer for price moves between sizing and the fill, step rounding and fees (`--min-usd`).
 */
export const MIN_ORDER_USD = 15;

/**
 * Most liquid `quote` spot market whose minimum order fits the cap: size = the venue minimum
 * (max of min size, min notional × SPOT_MIN_NOTIONAL_BUFFER and `minOrderUsd` at the mark, rounded
 * up to the size grid); worst case = size × mark × (1 + slippage) must be ≤ maxUsd. Markets without a
 * price, without a two-sided book, with a mid > 2% off the mark, or with no published minimum
 * are rejected (never sized on a guess). Ranking: the `preferred` base (a liquid major — the
 * venue profile's spotSymbol) first, then 24h volume (unpublished last), then the smaller
 * notional. `ranked` = every acceptable market in that order; `pick` = ranked[0]. No candidate
 * → pick null with every rejection reason. The live book is checked by pickSpotMarketWithBook.
 */
export function pickSpotMarket(cands: SpotCandidate[], quote: string, maxUsd: number, slippageBps: number, preferred: string | null, minOrderUsd = MIN_ORDER_USD): { pick: SpotPick | null; ranked: SpotPick[]; rejected: Array<{ symbol: string; reason: string }> } {
  const ok: SpotPick[] = [];
  const rejected: Array<{ symbol: string; reason: string }> = [];
  for (const c of cands) {
    const no = (reason: string) => { rejected.push({ symbol: c.symbol, reason }); };
    if (c.quote.toUpperCase() !== quote.toUpperCase()) { no(`quote ${c.quote} (need ${quote})`); continue; }
    if (c.mark === null || !Number.isFinite(c.mark) || c.mark <= 0) { no(NO_PUBLIC_PRICE); continue; }
    if (c.twoSided === false) { no(NO_TWO_SIDED_BOOK); continue; }
    if (c.mid !== null && Math.abs(c.mid / c.mark - 1) > SPOT_BOOK_MAX_MID_DEV) { no(`${BOOK_MID_OFF} ${c.mid} is > 2% off the mark ${c.mark}`); continue; }
    if (c.minSize === null && c.minNotional === null) { no("no published minimum order"); continue; }
    const bySize = c.minSize !== null ? Number(ceilToStep(c.minSize, c.step)) : 0;
    const floorUsd = c.minNotional !== null ? Math.max(minOrderUsd, c.minNotional * SPOT_MIN_NOTIONAL_BUFFER) : minOrderUsd;
    const byNotional = Number(ceilToStep(floorUsd / c.mark, c.step));
    const size = ceilToStep(Math.max(bySize, byNotional, Number(c.step)), c.step);
    const notional = Number(size) * c.mark;
    const worst = notional * (1 + slippageBps / 10_000);
    if (worst > maxUsd) { no(`minimum order ${size} ≈ $${worst.toFixed(2)} worst case > cap $${maxUsd}`); continue; }
    ok.push({ symbol: c.symbol, size, mark: c.mark, notional, volume24hUsd: c.volume24hUsd, minSize: c.minSize, minNotional: c.minNotional, bookRef: c.bookRef });
  }
  const pref = preferred?.toUpperCase().split("/")[0] ?? null;
  const isPref = (p: SpotPick) => (pref !== null && p.symbol.toUpperCase() === pref ? 1 : 0);
  ok.sort((a, b) => isPref(b) - isPref(a) || (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1) || a.notional - b.notional);
  return { pick: ok[0] ?? null, ranked: ok, rejected };
}

/** Best bid / ask of a live spot book (null = that side is empty). */
export interface SpotBook { bestBid: number | null; bestAsk: number | null }

/** Why a live spot book is unusable for a market buy + sell at `mark`, or null when it is fine. */
export function spotBookProblem(book: SpotBook, mark: number): string | null {
  const { bestBid: bid, bestAsk: ask } = book;
  if (bid === null || ask === null || !(bid > 0) || !(ask > 0) || !Number.isFinite(bid) || !Number.isFinite(ask)) return NO_TWO_SIDED_BOOK;
  const mid = (bid + ask) / 2;
  if (Math.abs(mid / mark - 1) > SPOT_BOOK_MAX_MID_DEV) return `${BOOK_MID_OFF} ${mid} is > 2% off the mark ${mark}`;
  return null;
}

/** Live books read per spot pick at most (ranked order); the rest are reported unchecked. */
export const SPOT_BOOK_CHECK_LIMIT = 10;

/**
 * pickSpotMarket, then the LIVE book of each ranked market in order (`readBook(bookRef)`, the
 * venue's own spot book) until one is two-sided with a mid within 2% of the mark — the same
 * requirement on every venue (live testnet 2026-10-02: HL PUCKY passed the ctx midPx but its
 * l2Book had one side → PRICE_STALE; Lighter RH ETH/USDC listed a last price but had no asks →
 * ORDER_REJECTED). A failed book read throws (never treated as a usable or an empty book).
 */
export async function pickSpotMarketWithBook(
  cands: SpotCandidate[], quote: string, maxUsd: number, slippageBps: number, preferred: string | null,
  readBook: (bookRef: string) => Promise<SpotBook>,
  minOrderUsd = MIN_ORDER_USD,
): Promise<{ pick: SpotPick | null; rejected: Array<{ symbol: string; reason: string }> }> {
  const { ranked, rejected } = pickSpotMarket(cands, quote, maxUsd, slippageBps, preferred, minOrderUsd);
  for (const [i, p] of ranked.entries()) {
    if (i >= SPOT_BOOK_CHECK_LIMIT) { rejected.push({ symbol: p.symbol, reason: `book not checked (limit ${SPOT_BOOK_CHECK_LIMIT})` }); continue; }
    const problem = spotBookProblem(await readBook(p.bookRef), p.mark);
    if (problem === null) return { pick: p, rejected };
    rejected.push({ symbol: p.symbol, reason: problem });
  }
  return { pick: null, rejected };
}

/** Bounded wait for a read-after-write check (venue account reads can lag a fill by seconds). */
export const SETTLE_TIMEOUT_MS = 10_000;
export const SETTLE_INTERVAL_MS = 1_500;

/**
 * Poll `read` until `done(value)` or `timeoutMs` elapsed (the first read is immediate; at least
 * one read always happens). Returns the last value and how many reads were made. Never retries
 * a write — only re-reads state. `read(attempt)` gets the 0-based attempt number.
 */
export async function pollUntil<T>(
  read: (attempt: number) => Promise<T>,
  done: (v: T) => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<{ value: T; reads: number; settled: boolean }> {
  const timeoutMs = opts.timeoutMs ?? SETTLE_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? SETTLE_INTERVAL_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let value = await read(0);
  let reads = 1;
  while (!done(value) && now() + intervalMs <= deadline) {
    await sleep(intervalMs);
    value = await read(reads);
    reads++;
  }
  return { value, reads, settled: done(value) };
}

/**
 * Spot fee allowance for "the buy landed in the balance": venues that charge the fee in the
 * bought asset (Hyperliquid spot: 3 PURR bought → 2.9979 credited) credit less than the filled
 * size. A credit ≥ filled × (1 − SPOT_FEE_ALLOWANCE) counts as landed.
 */
export const SPOT_FEE_ALLOWANCE = 0.01;

export function spotBuyLanded(baseline: number, current: number, filled: number): boolean {
  return current - baseline >= filled * (1 - SPOT_FEE_ALLOWANCE);
}

// ── Spot funding (round-5) ─────────────────────────────────────────────────

/** How the spot phase is funded: move `transfer` quote perp → spot (null = no move needed / possible), or skip the phase. */
export type SpotFundingPlan =
  | { kind: "fund"; transfer: string | null; note: string }
  | { kind: "skip"; reason: string };

/**
 * Plan the perp → spot quote move for the spot phase from live balances (separate spot account):
 * `need` = quote the spot steps use (spotQuoteNeed: the buy + headroom; the resting limit is placed after the sell and reuses its proceeds), `spotAvail` = spot quote available now,
 * `perpWithdrawable` = perp withdrawable (`portfolio` perp.available), `shared` = the spot quote row
 * is the perp balance itself (HL unified: the transfer is a no-op, nothing to add).
 * Short of `need` even after moving everything withdrawable → skip with "insufficient testnet funds".
 * Otherwise move the deficit (at least `exercise`, so the transfer step is exercised; capped at the
 * withdrawable amount), rounded to 0.01. Throws on a non-finite input (never guesses a balance).
 */
export function planSpotFunding(opts: { asset: string; need: number; spotAvail: number; perpWithdrawable: number; shared: boolean; exercise?: number }): SpotFundingPlan {
  const { asset, need, spotAvail, perpWithdrawable, shared } = opts;
  for (const [k, v] of [["need", need], ["spotAvail", spotAvail], ["perpWithdrawable", perpWithdrawable]] as const) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`planSpotFunding: ${k} is not a balance (${v})`);
  }
  const f = (x: number) => x.toFixed(2);
  if (shared) {
    if (spotAvail < need) return { kind: "skip", reason: `insufficient testnet funds: need ${f(need)} ${asset}, have ${f(spotAvail)} ${asset} (spot shares the perp balance)` };
    return { kind: "fund", transfer: null, note: `shared balance ${f(spotAvail)} ${asset} covers ${f(need)}` };
  }
  const deficit = need - spotAvail;
  if (deficit > perpWithdrawable) {
    return {
      kind: "skip",
      reason: `insufficient testnet funds: need ${f(need)} ${asset}, have ${f(spotAvail + perpWithdrawable)} ${asset} (spot ${f(spotAvail)} + perp withdrawable ${f(perpWithdrawable)})`,
    };
  }
  const cap = Number(floorToStep(perpWithdrawable, "0.01"));
  const amount = Math.min(Number(ceilToStep(Math.max(deficit, opts.exercise ?? 1), "0.01")), cap);
  if (amount < Number(ceilToStep(Math.max(deficit, 0), "0.01")) || amount <= 0) {
    // Spot already holds what is needed and nothing (≥ 0.01) is withdrawable: no move.
    if (deficit <= 0) return { kind: "fund", transfer: null, note: `spot ${f(spotAvail)} ${asset} covers ${f(need)}; perp withdrawable ${f(perpWithdrawable)} — no transfer` };
    return { kind: "skip", reason: `insufficient testnet funds: need ${f(need)} ${asset}, have ${f(spotAvail + perpWithdrawable)} ${asset} (spot ${f(spotAvail)} + perp withdrawable ${f(perpWithdrawable)})` };
  }
  return { kind: "fund", transfer: amount.toFixed(2), note: `spot ${f(spotAvail)} + transfer ${amount.toFixed(2)} ≥ need ${f(need)} ${asset}` };
}

/** Quote headroom over the spot buy notional (slippage + fees). */
export const SPOT_QUOTE_HEADROOM = 1.05;

/**
 * Quote the spot phase needs for a buy of `notional`: notional × SPOT_QUOTE_HEADROOM. The phase
 * runs buy → sell → resting far limit, so the far limit (below the market, ≤ 1 × notional) is
 * funded by the sell proceeds and needs no quote of its own. Throws on a non-positive input.
 */
export function spotQuoteNeed(notional: number): number {
  if (!Number.isFinite(notional) || notional <= 0) throw new Error(`spotQuoteNeed: notional is not a positive number (${notional})`);
  return notional * SPOT_QUOTE_HEADROOM;
}

// ── Mainnet start gate (operator-authorized mode) ──────────────────────────

/**
 * Outcome of the real-money start gate. `start`: `raiseCap` → the operator must type
 * RAISE-CAP-<N> first; `typeVenue` → then the venue name; `operatorAuthorized` → the typed
 * venue-name confirmation is replaced by `--operator-authorized <venue>`.
 */
export type MainnetGate =
  | { kind: "refuse"; message: string }
  | { kind: "start"; raiseCap: boolean; typeVenue: boolean; operatorAuthorized: boolean };

/**
 * Gate for a mainnet run that is not --dry-run. --confirm-real-money is always required. A cap
 * above `defaultCapUsd` always needs an interactive terminal (RAISE-CAP-<N> typing), so a
 * non-interactive run can never raise it. `--operator-authorized <id>` must equal the venue
 * exactly and replaces ONLY the typed venue-name confirmation (a TTY is then not needed).
 */
export function mainnetStartGate(o: { venue: string; confirmRealMoney: boolean; operatorAuthorized: string | null; maxUsd: number; defaultCapUsd: number; interactive: boolean }): MainnetGate {
  if (!o.confirmRealMoney) return { kind: "refuse", message: "Mainnet run without --dry-run requires --confirm-real-money." };
  if (o.operatorAuthorized !== null && o.operatorAuthorized !== o.venue) {
    return { kind: "refuse", message: `--operator-authorized "${o.operatorAuthorized}" does not match --venue ${o.venue} — aborting.` };
  }
  const raiseCap = o.maxUsd > o.defaultCapUsd;
  if (raiseCap && !o.interactive) {
    return { kind: "refuse", message: `--max-usd ${o.maxUsd} is above the $${o.defaultCapUsd} real-money cap: raising it needs an interactive terminal (typed RAISE-CAP-${o.maxUsd}) — a non-interactive / operator-authorized run cannot raise the cap.` };
  }
  if (o.operatorAuthorized !== null) return { kind: "start", raiseCap, typeVenue: false, operatorAuthorized: true };
  if (!o.interactive) {
    return { kind: "refuse", message: `Mainnet run requires an interactive terminal (typed confirmation) — refusing on non-TTY stdin.` };
  }
  return { kind: "start", raiseCap, typeVenue: true, operatorAuthorized: false };
}

// ── Deposit / withdraw limits ──────────────────────────────────────────────

/**
 * Why a deposit / withdraw amount is refused before anything is sent, or null when it is fine:
 * not a positive number, above the cap, or below the route minimum (`belowMinLost`: the venue
 * does not credit a smaller deposit — Hyperliquid Bridge2 under 5 USDC).
 */
export function fundingAmountProblem(o: { phase: "deposit" | "withdraw"; amount: number; min: number | null; minSource: string | null; belowMinLost: boolean; maxUsd: number }): string | null {
  if (!Number.isFinite(o.amount) || o.amount <= 0) return `--${o.phase}-amount must be a positive number (got ${o.amount})`;
  if (o.amount > o.maxUsd) return `--${o.phase}-amount ${o.amount} > --max-usd ${o.maxUsd}`;
  if (o.min !== null && o.amount < o.min) {
    return `${o.phase} ${o.amount} is below the minimum ${o.min}${o.minSource !== null ? ` (${o.minSource})` : ""}${o.belowMinLost ? " — the venue does NOT credit a smaller deposit (funds are lost); refusing" : ""}`;
  }
  return null;
}

/** Collateral minimums of a Lighter-family venue from GET /api/v1/assetDetails?asset_id=<id>. Throws when a field is missing (never guesses). */
export function lighterAssetMinimums(body: unknown, assetId: number): { symbol: string; minTransfer: number; minWithdrawal: number } {
  const list = (body as { asset_details?: unknown } | null)?.asset_details;
  if (!Array.isArray(list)) throw new Error("assetDetails: missing asset_details");
  const a = (list as Array<Record<string, unknown>>).find(x => x.asset_id === assetId);
  if (a === undefined) throw new Error(`assetDetails: asset ${assetId} not listed`);
  const minTransfer = Number(a.min_transfer_amount);
  const minWithdrawal = Number(a.min_withdrawal_amount);
  if (typeof a.min_transfer_amount !== "string" || !Number.isFinite(minTransfer) || minTransfer < 0) throw new Error(`assetDetails: asset ${assetId} has no min_transfer_amount`);
  if (typeof a.min_withdrawal_amount !== "string" || !Number.isFinite(minWithdrawal) || minWithdrawal < 0) throw new Error(`assetDetails: asset ${assetId} has no min_withdrawal_amount`);
  return { symbol: String(a.symbol), minTransfer, minWithdrawal };
}

/** A JSON-RPC hex quantity (eth_getBalance / eth_call uint256) as a decimal number of `decimals`. Throws on anything else. */
export function unitsFromHex(hex: string, decimals: number): number {
  if (!/^0x[0-9a-fA-F]+$/.test(hex)) throw new Error(`not a hex quantity: "${hex}"`);
  return Number(BigInt(hex)) / 10 ** decimals;
}

/**
 * Why the wallet cannot make the deposit, or null: no gas asset at all / under `minGas` (the CLI
 * deposit's own gas check), or (when an amount is
 * requested) less of the deposit asset than the amount. Balances are on-chain reads.
 */
export function depositWalletProblem(o: { amount: number | null; asset: string; tokenBalance: number; gasAsset: string; gasBalance: number; minGas: number }): string | null {
  if (!Number.isFinite(o.tokenBalance) || !Number.isFinite(o.gasBalance)) return `wallet balance is not a number (${o.asset} ${o.tokenBalance}, ${o.gasAsset} ${o.gasBalance})`;
  if (!(o.gasBalance > 0)) return `the depositing wallet has 0 ${o.gasAsset} for gas`;
  if (o.gasBalance < o.minGas) return `the depositing wallet has ${o.gasBalance} ${o.gasAsset} for gas — the CLI deposit needs at least ${o.minGas}`;
  if (o.amount !== null && o.amount > o.tokenBalance) return `--deposit-amount ${o.amount} > wallet balance ${o.tokenBalance} ${o.asset}`;
  return null;
}
