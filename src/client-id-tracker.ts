import { existsSync, appendFileSync, readFileSync, mkdirSync } from "fs";
import { perpDir, perpPath } from "./paths.js";
import { randomUUID } from "crypto";

function clientIdsFile(): string { return perpPath("client-ids.jsonl"); }

export interface ClientIdRecord {
  clientOrderId: string;
  exchange: string;
  symbol: string;
  side: string;
  size: string;
  price?: string;
  type: "market" | "limit" | "stop";
  exchangeOrderId?: string;
  status: "pending" | "submitted" | "filled" | "cancelled" | "failed";
  createdAt: string;
  updatedAt: string;
}

function ensureDir() {
  if (!existsSync(perpDir())) mkdirSync(perpDir(), { recursive: true, mode: 0o700 });
}

/** Generate a unique client order ID */
export function generateClientId(prefix?: string): string {
  const uuid = randomUUID().replace(/-/g, "").slice(0, 16);
  const ts = Date.now().toString(36);
  return prefix ? `${prefix}-${ts}-${uuid}` : `perp-${ts}-${uuid}`;
}

/** Log a client order ID record */
export function logClientId(record: ClientIdRecord): void {
  try {
    ensureDir();
    appendFileSync(clientIdsFile(), JSON.stringify(record) + "\n", { mode: 0o600 });
  } catch (e) {
    // Before the order is sent ("pending") a failed write stops the order. Afterwards the order
    // already has an outcome: a tracking-file failure is warned, never thrown as an order failure.
    if (record.status === "pending") throw e;
    process.stderr.write(`[perp] Warning: could not record client id ${record.clientOrderId} as "${record.status}" (${e instanceof Error ? e.message : String(e)})\n`);
  }
}

/** Look up a client order ID */
export function lookupClientId(clientOrderId: string): ClientIdRecord | null {
  if (!existsSync(clientIdsFile())) return null;
  const lines = readFileSync(clientIdsFile(), "utf-8").trim().split("\n").filter(Boolean);
  // Reverse to find latest status for this ID
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = JSON.parse(lines[i]) as ClientIdRecord;
      if (record.clientOrderId === clientOrderId) return record;
    } catch { continue; }
  }
  return null;
}

/** Check if a client order ID has already been submitted (duplicate detection) */
export function isOrderDuplicate(clientOrderId: string): boolean {
  const existing = lookupClientId(clientOrderId);
  if (!existing) return false;
  // Duplicate if status is not "failed" (failed orders can be retried)
  return existing.status !== "failed";
}

/** Update a client order ID record status */
export function updateClientId(clientOrderId: string, update: Partial<ClientIdRecord>): void {
  const existing = lookupClientId(clientOrderId);
  if (!existing) return;
  const updated: ClientIdRecord = {
    ...existing,
    ...update,
    updatedAt: new Date().toISOString(),
  };
  logClientId(updated);
}

/** Read all client ID records (most recent N) */
export function readClientIds(limit = 100): ClientIdRecord[] {
  if (!existsSync(clientIdsFile())) return [];
  const lines = readFileSync(clientIdsFile(), "utf-8").trim().split("\n").filter(Boolean);
  const records: ClientIdRecord[] = [];
  // Take the last `limit` lines
  const start = Math.max(0, lines.length - limit);
  for (let i = start; i < lines.length; i++) {
    try { records.push(JSON.parse(lines[i])); } catch { continue; }
  }
  return records;
}
