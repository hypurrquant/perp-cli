/**
 * Withdraw gate for venues whose withdrawals are authorized by an API key alone — no owner
 * signature (settings.withdraw.<venue>; today: qfex)..
 *
 * Before such a withdrawal is sent it must pass, locally:
 *   1. a gate is configured at all (absent → refused);
 *   2. the destination is on the allowlist;
 *   3. amount ≤ maxPerTx;
 *   4. today's total (UTC day, from this machine's ledger) + amount ≤ maxPerDay.
 * The adapter enforces it inside withdraw(), so no caller can skip it.
 *
 * What it is NOT: a defence against key theft. Someone holding the key file does not use this
 * CLI. That defence is a trading key WITHOUT the withdraw permission (a separate key for
 * funding). The gate limits mistakes and misdirected automation: its allowlist can only be
 * changed with an interactive terminal confirmation (confirmWithdrawGateChange), never under
 * --json, a pipe, the MCP server or a job.
 *
 * Ledger: ~/.perp/withdraw-ledger.json — amounts and addresses only (no secrets, Rule #3).
 * An attempt is recorded BEFORE it is sent and removed only on a definite refusal, so an
 * unknown outcome counts against the day.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeKeystoreAtomic } from "./agent-wallet/venue-keystore.js";
import { PerpError } from "./errors.js";
import type { WithdrawGate, WithdrawGateVenue } from "./settings.js";

export interface WithdrawLedgerEntry {
  id: string;
  venue: string;
  network: string;
  /** USDC, as sent. */
  amount: string;
  to: string;
  /** ISO timestamp of the attempt. */
  at: string;
}

function ledgerPath(): string {
  const home = process.env["HOME"];
  if (!home) throw new PerpError("INVALID_PARAMS", "HOME is not set; cannot locate ~/.perp/withdraw-ledger.json");
  return resolve(home, ".perp", "withdraw-ledger.json");
}

function readLedger(): WithdrawLedgerEntry[] {
  const path = ledgerPath();
  if (!existsSync(path)) return []; // nothing withdrawn from this machine yet
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new PerpError("INVALID_PARAMS", `Invalid ${path}: not valid JSON (${e instanceof Error ? e.message : String(e)})`, {
      remediation: `The daily withdraw total cannot be computed, so withdrawals are refused. Inspect ${path}; move it aside only after checking today's withdrawals on the venue`,
    });
  }
  if (!Array.isArray(parsed) || parsed.some(e => e === null || typeof e !== "object" || typeof e.id !== "string" || typeof e.venue !== "string"
    || typeof e.network !== "string" || typeof e.amount !== "string" || !Number.isFinite(Number(e.amount)) || typeof e.to !== "string" || !Number.isFinite(Date.parse(e.at)))) {
    throw new PerpError("INVALID_PARAMS", `Invalid ${path}: not a list of withdraw entries`, {
      remediation: `The daily withdraw total cannot be computed, so withdrawals are refused. Inspect ${path}`,
    });
  }
  return parsed as WithdrawLedgerEntry[];
}

function writeLedger(entries: WithdrawLedgerEntry[]): void {
  const path = ledgerPath();
  const dir = resolve(path, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeKeystoreAtomic(path, JSON.stringify(entries, null, 2));
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Sum of the amounts attempted for venue + network on the UTC day of `nowMs`. */
export function withdrawnOnDay(venue: string, network: string, nowMs: number): number {
  const day = utcDay(nowMs);
  return readLedger()
    .filter(e => e.venue === venue && e.network === network && e.at.slice(0, 10) === day)
    .reduce((sum, e) => sum + Number(e.amount), 0);
}

function denied(venue: string, why: string, remediation: string, details: Record<string, unknown>): PerpError {
  return new PerpError("POLICY_DENIED", `${venue} withdraw refused by the local withdraw gate: ${why}`, { exchange: venue, ...details, remediation });
}

/**
 * Throws POLICY_DENIED unless the withdrawal passes `gate`. Nothing is sent before this returns.
 * `gate` null = settings.withdraw.<venue> is not configured.
 */
export function assertWithdrawAllowed(
  venue: WithdrawGateVenue, network: string, amount: string, to: string, gate: WithdrawGate | null, nowMs: number,
): void {
  const setHint = `Configure it in an interactive terminal: perp settings set withdraw.${venue} <address[+address…]>,<maxPerTx>,<maxPerDay>`;
  if (gate === null) {
    throw denied(venue, `settings.withdraw.${venue} is not configured — API-key withdrawals are off until you set an allowlist and limits`, setHint, {});
  }
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) throw new PerpError("INVALID_PARAMS", `Withdraw amount must be a positive decimal (got "${amount}")`);
  if (!gate.allowlist.includes(to.toLowerCase())) {
    throw denied(venue, `destination ${to} is not on the allowlist`, `Withdraw to an allowlisted address, or change the allowlist yourself. ${setHint}`, { allowlist: gate.allowlist });
  }
  if (n > gate.maxPerTx) {
    throw denied(venue, `amount ${amount} exceeds maxPerTx ${gate.maxPerTx}`, `Withdraw at most ${gate.maxPerTx} USDC per transaction, or raise the limit. ${setHint}`, { maxPerTx: gate.maxPerTx });
  }
  const today = withdrawnOnDay(venue, network, nowMs);
  if (today + n > gate.maxPerDay) {
    throw denied(venue, `amount ${amount} plus ${today} already attempted today (UTC) exceeds maxPerDay ${gate.maxPerDay}`,
      `Wait for the next UTC day or raise the limit. ${setHint}`, { maxPerDay: gate.maxPerDay, withdrawnToday: today });
  }
}

/** Record an attempt (call BEFORE sending). Returns its id for forgetWithdrawAttempt. */
export function recordWithdrawAttempt(venue: string, network: string, amount: string, to: string, nowMs: number): string {
  const entries = readLedger();
  const id = randomUUID();
  entries.push({ id, venue, network, amount, to: to.toLowerCase(), at: new Date(nowMs).toISOString() });
  writeLedger(entries);
  return id;
}

/** Remove an attempt the venue DEFINITELY refused (nothing left the account). */
export function forgetWithdrawAttempt(id: string): void {
  writeLedger(readLedger().filter(e => e.id !== id));
}

/**
 * Confirmation for creating or changing settings.withdraw.<venue>. Only an interactive
 * terminal can confirm: --json, a non-TTY stdin/stdout (pipes, the MCP server, jobs) are
 * refused, and there is no --yes.
 */
export async function confirmWithdrawGateChange(venue: string, gate: WithdrawGate, json: boolean): Promise<void> {
  const what = `withdraw.${venue}: allow withdrawals to ${gate.allowlist.join(", ")} — up to ${gate.maxPerTx} USDC per transaction, ${gate.maxPerDay} USDC per UTC day`;
  if (json || process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new PerpError("POLICY_DENIED", `Changing the withdraw gate needs an interactive terminal confirmation (${what})`, {
      remediation: `Run it yourself in a terminal, without --json: perp settings set withdraw.${venue} <address[+address…]>,<maxPerTx>,<maxPerDay>`,
    });
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`  ${what}.\n  Anyone who can run perp on this machine can then withdraw to these addresses. Type the venue name (${venue}) to confirm: `)).trim().toLowerCase();
    if (a !== venue) throw new PerpError("INVALID_PARAMS", `withdraw.${venue} not changed — cancelled, nothing was saved`);
  } finally {
    rl.close();
  }
}
