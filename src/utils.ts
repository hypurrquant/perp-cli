import Table from "cli-table3";
import chalk from "chalk";
import { classifyError } from "./errors.js";

export function symbolMatch(candidate: string, target: string): boolean {
  const c = candidate.toUpperCase();
  const t = target.toUpperCase();
  return c === t || c === `${t}-PERP` || c.replace(/-PERP$/, "") === t;
}

export function formatUsd(value: string | number): string {
  const num = Number(value);
  if (isNaN(num)) return String(value);
  return num.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
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
      // Set at top level for flat access
      result[field] = src;
    }
  }
  return result;
}

export function printJson(data: unknown): void {
  const fieldsArg = process.argv.indexOf("--fields");
  if (fieldsArg !== -1 && process.argv[fieldsArg + 1] && data && typeof data === "object") {
    const fields = process.argv[fieldsArg + 1].split(",").map(f => f.trim());
    const envelope = data as Record<string, unknown>;
    // Apply field filter to data payload, keep ok/error/meta intact
    if (envelope.ok && envelope.data && typeof envelope.data === "object") {
      envelope.data = pickFields(envelope.data, fields);
    }
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
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
    details?: Record<string, unknown>;
  };
  meta?: { exchange?: string; timestamp: string; duration_ms?: number };
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
      ...(meta?.details ? { details: meta.details } : {}),
    },
    meta: { timestamp: new Date().toISOString(), ...meta },
  };
}

/** Execute a command action with structured error handling.
 *  In JSON mode, errors are returned as JSON instead of crashing.
 */
export async function withJsonErrors<T>(
  isJson: boolean,
  fn: () => Promise<T>,
  exchange?: string,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const classified = classifyError(err, exchange);
    if (isJson) {
      console.log(JSON.stringify(jsonError(classified.code, classified.message, {
        status: classified.status,
        retryable: classified.retryable,
        retryAfterMs: classified.retryAfterMs,
      })));
    } else {
      console.error(chalk.red(`Error: ${classified.message}`));
    }
    return undefined;
  }
}
