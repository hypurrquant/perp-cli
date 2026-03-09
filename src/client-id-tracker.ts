import { existsSync, appendFileSync, readFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const CLIENT_IDS_FILE = resolve(PERP_DIR, "client-ids.jsonl");

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
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
}

/** Generate a unique client order ID */
export function generateClientId(prefix?: string): string {
  const uuid = randomUUID().replace(/-/g, "").slice(0, 16);
  const ts = Date.now().toString(36);
  return prefix ? `${prefix}-${ts}-${uuid}` : `perp-${ts}-${uuid}`;
}

/** Log a client order ID record */
export function logClientId(record: ClientIdRecord): void {
  ensureDir();
  appendFileSync(CLIENT_IDS_FILE, JSON.stringify(record) + "\n", { mode: 0o600 });
}

/** Look up a client order ID */
export function lookupClientId(clientOrderId: string): ClientIdRecord | null {
  if (!existsSync(CLIENT_IDS_FILE)) return null;
  const lines = readFileSync(CLIENT_IDS_FILE, "utf-8").trim().split("\n").filter(Boolean);
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
  if (!existsSync(CLIENT_IDS_FILE)) return [];
  const lines = readFileSync(CLIENT_IDS_FILE, "utf-8").trim().split("\n").filter(Boolean);
  const records: ClientIdRecord[] = [];
  // Take the last `limit` lines
  const start = Math.max(0, lines.length - limit);
  for (let i = start; i < lines.length; i++) {
    try { records.push(JSON.parse(lines[i])); } catch { continue; }
  }
  return records;
}
