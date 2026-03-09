import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync, mkdirSync } from "fs";
import { resolve } from "path";
import {
  generateClientId,
  logClientId,
  lookupClientId,
  isOrderDuplicate,
  updateClientId,
  readClientIds,
  type ClientIdRecord,
} from "../client-id-tracker.js";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const CLIENT_IDS_FILE = resolve(PERP_DIR, "client-ids.jsonl");

// Backup and restore any existing file to avoid test pollution
let backupContent: string | null = null;

beforeEach(() => {
  if (existsSync(CLIENT_IDS_FILE)) {
    backupContent = require("fs").readFileSync(CLIENT_IDS_FILE, "utf-8");
    rmSync(CLIENT_IDS_FILE);
  }
});

afterEach(() => {
  if (existsSync(CLIENT_IDS_FILE)) rmSync(CLIENT_IDS_FILE);
  if (backupContent !== null) {
    if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true });
    require("fs").writeFileSync(CLIENT_IDS_FILE, backupContent);
    backupContent = null;
  }
});

function makeRecord(overrides?: Partial<ClientIdRecord>): ClientIdRecord {
  return {
    clientOrderId: generateClientId(),
    exchange: "test",
    symbol: "BTC",
    side: "buy",
    size: "0.1",
    type: "market",
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("generateClientId", () => {
  it("generates unique IDs", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateClientId());
    }
    expect(ids.size).toBe(100);
  });

  it("uses prefix when provided", () => {
    const id = generateClientId("test");
    expect(id.startsWith("test-")).toBe(true);
  });

  it("defaults to 'perp-' prefix", () => {
    const id = generateClientId();
    expect(id.startsWith("perp-")).toBe(true);
  });
});

describe("logClientId + lookupClientId", () => {
  it("logs and retrieves a record", () => {
    const record = makeRecord({ clientOrderId: "test-lookup-1" });
    logClientId(record);

    const found = lookupClientId("test-lookup-1");
    expect(found).not.toBeNull();
    expect(found!.clientOrderId).toBe("test-lookup-1");
    expect(found!.exchange).toBe("test");
    expect(found!.symbol).toBe("BTC");
  });

  it("returns null for non-existent ID", () => {
    expect(lookupClientId("nonexistent")).toBeNull();
  });

  it("returns latest record for duplicate IDs", () => {
    const id = "test-latest";
    logClientId(makeRecord({ clientOrderId: id, status: "pending" }));
    logClientId(makeRecord({ clientOrderId: id, status: "filled" }));

    const found = lookupClientId(id);
    expect(found!.status).toBe("filled");
  });
});

describe("isOrderDuplicate", () => {
  it("returns false for unknown ID", () => {
    expect(isOrderDuplicate("unknown-123")).toBe(false);
  });

  it("returns true for pending order", () => {
    const id = "test-dup-pending";
    logClientId(makeRecord({ clientOrderId: id, status: "pending" }));
    expect(isOrderDuplicate(id)).toBe(true);
  });

  it("returns true for submitted order", () => {
    const id = "test-dup-submitted";
    logClientId(makeRecord({ clientOrderId: id, status: "submitted" }));
    expect(isOrderDuplicate(id)).toBe(true);
  });

  it("returns true for filled order", () => {
    const id = "test-dup-filled";
    logClientId(makeRecord({ clientOrderId: id, status: "filled" }));
    expect(isOrderDuplicate(id)).toBe(true);
  });

  it("returns false for failed order (can be retried)", () => {
    const id = "test-dup-failed";
    logClientId(makeRecord({ clientOrderId: id, status: "failed" }));
    expect(isOrderDuplicate(id)).toBe(false);
  });
});

describe("updateClientId", () => {
  it("appends updated record", () => {
    const id = "test-update-1";
    logClientId(makeRecord({ clientOrderId: id, status: "pending" }));
    updateClientId(id, { status: "filled", exchangeOrderId: "ex-123" });

    const found = lookupClientId(id);
    expect(found!.status).toBe("filled");
    expect(found!.exchangeOrderId).toBe("ex-123");
  });

  it("no-ops for nonexistent ID", () => {
    updateClientId("ghost-id", { status: "filled" });
    expect(lookupClientId("ghost-id")).toBeNull();
  });
});

describe("readClientIds", () => {
  it("returns empty array when no file", () => {
    expect(readClientIds()).toEqual([]);
  });

  it("returns all records", () => {
    logClientId(makeRecord({ clientOrderId: "r1" }));
    logClientId(makeRecord({ clientOrderId: "r2" }));
    logClientId(makeRecord({ clientOrderId: "r3" }));

    const records = readClientIds();
    expect(records.length).toBe(3);
  });

  it("respects limit parameter", () => {
    for (let i = 0; i < 10; i++) {
      logClientId(makeRecord({ clientOrderId: `batch-${i}` }));
    }
    const records = readClientIds(3);
    expect(records.length).toBe(3);
    // Should be the last 3
    expect(records[0].clientOrderId).toBe("batch-7");
    expect(records[2].clientOrderId).toBe("batch-9");
  });
});
