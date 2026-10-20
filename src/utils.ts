import Table from "cli-table3";
import chalk from "chalk";
import { classifyError } from "./errors.js";
import type { OrderResult } from "./exchanges/venue-types.js";

export function symbolMatch(candidate: string, target: string): boolean {
  // Symmetric match: strip a trailing -PERP from BOTH sides before comparing.
  // Callers pass (venueSymbol, userInput); the venue may report "BTC" or
  // "BTC-PERP" and the user may type either form, so matching must not depend
  // on which side carries the suffix.
  const strip = (s: string) => s.toUpperCase().replace(/-PERP$/, "");
  const c = strip(candidate);
  const t = strip(target);
  if (c === t) return true;
  // A HIP-3 dex-scoped adapter reports "xyz:NVDA" while the user (with --dex xyz) types "NVDA".
  // One-way only: a dex-prefixed user input never matches a bare venue symbol.
  const colon = c.indexOf(":");
  return colon > 0 && !t.includes(":") && c.slice(colon + 1) === t;
}

export function formatUsd(value: string | number): string {
  const num = Number(value);
  if (isNaN(num)) return String(value);
  // Use more decimals for sub-cent values so they don't show as $0.00
  const absNum = Math.abs(num);
  const maxDecimals = absNum > 0 && absNum < 0.01 ? 6
    : absNum < 1 ? 4
    : 2;
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDecimals,
  });
}

/**
 * Symbol argument as typed, normalized for display and lookup: upper case, except a HIP-3 dex
 * prefix, which is lower case on the venue ("xyz:xyz100" / "XYZ:XYZ100" → "xyz:XYZ100").
 */
export function normalizeSymbolArg(symbol: string): string {
  const i = symbol.indexOf(":");
  return i === -1 ? symbol.toUpperCase() : `${symbol.slice(0, i).toLowerCase()}:${symbol.slice(i + 1).toUpperCase()}`;
}

export function formatPnl(value: string | number): string {
  const num = Number(value);
  if (isNaN(num)) return String(value);
  const formatted = formatUsd(Math.abs(num));
  if (num > 0) return chalk.green(`+$${formatted}`);
  if (num < 0) return chalk.red(`-$${formatted}`);
  return `$${formatted}`;
}

export function formatPercent(value: string | number): string {
  const num = Number(value);
  if (isNaN(num)) return String(value);
  const pct = (num * 100).toFixed(4);
  const prefix = num > 0 ? "+" : "";
  const color = num > 0 ? chalk.green : num < 0 ? chalk.red : chalk.white;
  return color(`${prefix}${pct}%`);
}

export function makeTable(head: string[], rows: string[][]): string {
  const table = new Table({
    head: head.map((h) => chalk.cyan.bold(h)),
    style: { head: [], border: [] },
    chars: {
      top: "─", "top-mid": "┬", "top-left": "┌", "top-right": "┐",
      bottom: "─", "bottom-mid": "┴", "bottom-left": "└", "bottom-right": "┘",
      left: "│", "left-mid": "├",
      mid: "─", "mid-mid": "┼",
      right: "│", "right-mid": "┤",
      middle: "│",
    },
  });
  rows.forEach((r) => table.push(r));
  return table.toString();
}

/** Pick only specified keys from an object (shallow). Supports nested paths via dot notation. */
function pickFields(obj: unknown, fields: string[]): unknown {
  if (obj == null || typeof obj !== "object") return obj;
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const parts = field.split(".");
    let src: unknown = obj;
    for (const p of parts) {
      if (src == null || typeof src !== "object") { src = undefined; break; }
      src = (src as Record<string, unknown>)[p];
    }
    if (src !== undefined) {
      result[field] = src;
    }
  }
  return result;
}

// ── Response Sanitization ──
// Strips control characters and potential prompt-injection patterns from all string values.
// Applied automatically to all JSON output to prevent agent confusion from external data.

const CONTROL_CHAR_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const PROMPT_INJECTION_RE = /(?:^|\n)\s*(?:SYSTEM:|ASSISTANT:|HUMAN:|<\/?(?:system|prompt|instruction|tool_use)>|ignore (?:previous|above|all) instructions?)/gi;

function sanitizeValue(val: unknown): unknown {
  if (typeof val === "string") {
    let s = val.replace(CONTROL_CHAR_RE, "");
    if (PROMPT_INJECTION_RE.test(s)) {
      s = s.replace(PROMPT_INJECTION_RE, "[SANITIZED]");
    }
    return s;
  }
  if (Array.isArray(val)) return val.map(sanitizeValue);
  if (val && typeof val === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = sanitizeValue(v);
    }
    return out;
  }
  return val;
}

// ── Sparkline ──

// Density-based shading — renders consistently across all terminal fonts
// (height-based ▁▂▃▄▅▆▇█ looks identical in many monospace fonts)
const SPARK_CHARS = [" ", "░", "▒", "▓", "█"];

/** Render a sparkline from numeric values. Returns unicode bar chart string. */
export function sparkline(values: number[], width?: number): string {
  if (values.length === 0) return "";
  const data = width && values.length > width ? downsample(values, width) : values;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min;
  if (range === 0) return SPARK_CHARS[2].repeat(data.length);
  return data.map(v => {
    const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
    return SPARK_CHARS[idx];
  }).join("");
}

function downsample(values: number[], targetLen: number): number[] {
  const bucketSize = values.length / targetLen;
  const result: number[] = [];
  for (let i = 0; i < targetLen; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let sum = 0;
    for (let j = start; j < end; j++) sum += values[j];
    result.push(sum / (end - start));
  }
  return result;
}

// ── JSON Output ──

const _isNdjson = () => process.argv.includes("--ndjson");

export function printJson(data: unknown): void {
  // An error envelope always means a non-zero exit (scripts / agents key on the exit code too):
  // commands that print `jsonError(...)` and return would otherwise exit 0 with ok:false.
  if (data !== null && typeof data === "object" && (data as { ok?: unknown }).ok === false) process.exitCode = 1;
  // Sanitize all string values in output
  let output = sanitizeValue(data);

  // Apply --fields filter
  const fieldsArg = process.argv.indexOf("--fields");
  if (fieldsArg !== -1 && process.argv[fieldsArg + 1] && output && typeof output === "object") {
    const fields = process.argv[fieldsArg + 1].split(",").map(f => f.trim());
    const envelope = output as Record<string, unknown>;
    if (envelope.ok && envelope.data && typeof envelope.data === "object") {
      // If data is an array, apply pickFields to each element
      if (Array.isArray(envelope.data)) {
        envelope.data = envelope.data.map((item: unknown) => pickFields(item, fields));
      } else {
        envelope.data = pickFields(envelope.data, fields);
      }
    }
    output = envelope;
  }

  // NDJSON mode: if data.data is an array, emit one JSON line per element
  if (_isNdjson() && output && typeof output === "object") {
    const envelope = output as Record<string, unknown>;
    if (envelope.ok && Array.isArray(envelope.data)) {
      const meta = envelope.meta;
      for (const item of envelope.data) {
        console.log(JSON.stringify({ ok: true, data: item, meta }));
      }
      return;
    }
  }

  console.log(JSON.stringify(output, null, _isNdjson() ? undefined : 2));
}

export function errorAndExit(msg: string): never {
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(jsonError("INVALID_PARAMS", msg)));
  } else {
    console.error(chalk.red(`Error: ${msg}`));
  }
  process.exit(1);
}

// ── Structured Output for Agents ──

/** Standard JSON response envelope */
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    status?: number;
    retryable?: boolean;
    retryAfterMs?: number;
    /** Actionable hint for automated callers (Codex v0.12.12 final QA #2). */
    remediation?: string;
    details?: Record<string, unknown>;
  };
  meta?: { exchange?: string; timestamp: string; duration_ms?: number; skippedRows?: { count: number; reason: string }; /** Why a value is null / degraded (e.g. a venue's funding rate unavailable). */ warnings?: string[]; /** `arb scan --rates`: the --min threshold (annualized %) and how many pairs it hid. */ minSpread?: number; belowMinSpread?: number; /** Public-address reads (`account positions --address`): the address read, "public", the sub-reads that failed and notes on an empty answer. */ address?: string; source?: "public"; errors?: Record<string, { code: string; message: string }>; notes?: string[] };
}

/** Wrap successful result in standard envelope */
export function jsonOk<T>(data: T, meta?: Partial<ApiResponse['meta']>): ApiResponse<T> {
  return {
    ok: true,
    data,
    meta: { timestamp: new Date().toISOString(), ...meta },
  };
}

/** Wrap error in standard envelope */
export function jsonError(
  code: string,
  message: string,
  meta?: Partial<ApiResponse['meta']> & {
    status?: number;
    retryable?: boolean;
    retryAfterMs?: number;
    details?: Record<string, unknown>;
    remediation?: string;
  },
): ApiResponse<never> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(meta?.status !== undefined ? { status: meta.status } : {}),
      ...(meta?.retryable !== undefined ? { retryable: meta.retryable } : {}),
      ...(meta?.retryAfterMs !== undefined ? { retryAfterMs: meta.retryAfterMs } : {}),
      ...(meta?.remediation !== undefined ? { remediation: meta.remediation } : {}),
      ...(meta?.details ? { details: meta.details } : {}),
    },
    meta: { timestamp: new Date().toISOString(), ...meta },
  };
}

/** Execute a command action with structured error handling.
 *  In JSON mode, errors are returned as JSON instead of crashing.
 *
 *  PerpError-typed throws are preserved end-to-end: their `code`,
 *  `remediation`, and other StructuredError fields surface in the JSON
 *  envelope's `error` block so machine consumers (agents / MCP / automation)
 *  receive actionable hints. Codex v0.12.12 final QA #2.
 */
export async function withJsonErrors<T>(
  isJson: boolean,
  fn: () => Promise<T>,
  exchange?: string,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    printCliError(err, isJson, exchange);
    process.exitCode = 1; // printed, not swallowed: the command still exits non-zero
    return undefined;
  }
}

/**
 * Central CLI error printer. JSON: the structured envelope incl. details and
 * remediation. Human: the uniform "not supported" line for CAPABILITY_UNSUPPORTED
 * — `✗ <Venue>: <feature> not supported — <reason>. Alternative: <remediation>` —
 * otherwise `Error: <message>` plus the remediation.
 */
export function printCliError(err: unknown, isJson: boolean, exchange?: string): void {
  const classified = classifyError(err, exchange);
  if (isJson) {
    console.log(JSON.stringify(jsonError(classified.code, classified.message, {
      status: classified.status,
      retryable: classified.retryable,
      retryAfterMs: classified.retryAfterMs,
      remediation: classified.remediation,
      details: classified.details,
    })));
    return;
  }
  const d = classified.details;
  if (classified.code === "CAPABILITY_UNSUPPORTED" && d && typeof d.venue === "string" && typeof d.feature === "string" && typeof d.reason === "string") {
    const alt = classified.remediation !== undefined ? ` Alternative: ${classified.remediation}` : "";
    console.error(chalk.red(`✗ ${d.venue}: ${d.feature} not supported — ${d.reason}.`) + chalk.yellow(alt));
    return;
  }
  console.error(chalk.red(`Error: ${classified.message}`));
  if (classified.remediation) {
    console.error(chalk.yellow(`Remediation: ${classified.remediation}`));
  }
}

/**
 * JSON payload of an order result: the uniform OrderResult (+ execution)
 * with the venue's raw response duplicated under `legacy` for one release.
 */
export function orderResultJson(r: OrderResult & { remediation?: string | null }, extra?: Record<string, unknown>): Record<string, unknown> {
  return { ...r, ...extra, legacy: r.venueRaw };
}

/** Human lines for an order result — one format for every venue. */
export function formatOrderResult(r: OrderResult & { remediation?: string | null }): string[] {
  const lines: string[] = [];
  const statusColor = r.status === "filled" ? chalk.green
    : r.status === "rejected" || r.status === "cancelled" ? chalk.red
    : r.status === "partiallyFilled" ? chalk.yellow : chalk.white;
  const fill = `filled ${r.filledSize ?? "unknown"}${r.avgPrice !== null ? ` @ ${r.avgPrice}` : ""}`;
  lines.push(`  Status:     ${statusColor(r.status)} (${r.finality === "final" ? "final" : chalk.yellow("pending")}) — ${fill}`);
  const ids: string[] = [];
  if (r.orderId !== null) ids.push(`order ${r.orderId}`);
  if (r.clientOrderId !== null) ids.push(`client id ${r.clientOrderId}`);
  if (ids.length > 0) lines.push(`  Order:      ${ids.join(" · ")}`);
  const e = r.execution;
  const exec: string[] = [e.method];
  if (e.slippageBps !== null) exec.push(`slippage ${Math.round(e.slippageBps * 100) / 100} bps${e.slippageSource !== null ? ` (${e.slippageSource})` : ""}`);
  if (e.protectionPrice !== null) exec.push(`protection ${e.protectionPrice}${e.referencePrice !== null ? ` (ref ${e.referencePrice})` : ""}`);
  else if (e.referencePrice !== null) exec.push(`ref ${e.referencePrice}`);
  lines.push(`  Execution:  ${exec.join(" · ")}`);
  if (e.tifRequested !== null || e.tifSent !== null) {
    const tif = e.tifRequested !== null && e.tifSent !== null && e.tifRequested !== e.tifSent
      ? `${e.tifRequested} → ${e.tifSent}` : (e.tifSent ?? e.tifRequested);
    lines.push(`  TIF:        ${tif}${e.expiresAt !== null ? ` (expires ${new Date(e.expiresAt).toISOString()})` : ""}`);
  }
  if (e.builderFee !== null) {
    const approved = e.builderFee.approvedMaxBps === null ? "" : `, approved max ${e.builderFee.approvedMaxBps} bps`;
    const fee = e.builderFee.feeKind === "share" ? "fee share (you pay the normal fee, nothing extra)"
      : e.builderFee.feeKind === "max" ? `up to ${e.builderFee.feeBps} bps (builder's own rate applies${approved})` : `${e.builderFee.feeBps} bps`;
    lines.push(`  Builder:    ${fee} → ${e.builderFee.identity}`);
  }
  for (const n of e.notes) lines.push(chalk.gray(`  Note:       ${n}`));
  if (r.remediation !== undefined && r.remediation !== null) lines.push(chalk.yellow(`  ${r.remediation}`));
  return lines;
}

/**
 * Log each rejected outcome from Promise.allSettled to stderr with a
 * per-source label. SSOT rule #2 helper: turn a quiet rejection inside a
 * multi-DEX comparison into an explicit one-line failure on stderr.
 *
 * @param settled  Outcomes from Promise.allSettled.
 * @param labels   Source label per index (e.g. ["pacifica", "hyperliquid", ...]).
 * @param prefix   Bracketed prefix prepended to each line (e.g. "arb-auto").
 */
export function logSettledRejections(
  settled: PromiseSettledResult<unknown>[],
  labels: string[],
  prefix: string,
): void {
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i];
    if (r.status === "rejected") {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      // eslint-disable-next-line no-console
      console.error(`[${prefix}] ${labels[i] ?? `index-${i}`} fetch failed: ${reason}`);
    }
  }
}
