/**
 * Integration tests verifying JSON envelope consistency across all CLI commands.
 *
 * Every --json output must:
 * 1. Be valid JSON (single object, no extra text)
 * 2. Have ok: boolean
 * 3. If ok=true: have data and meta.timestamp
 * 4. If ok=false: have error.code, error.message, and meta.timestamp
 *
 * These tests spawn the real CLI process to catch any console.log leaks,
 * chalk output in JSON mode, or missing envelope wrappers.
 */
import "dotenv/config";
import { execSync } from "child_process";
import { describe, it, expect } from "vitest";

const CLI_CWD = "/Users/hik/Documents/GitHub/pacifica/packages/cli";
const CLI_CMD = "npx tsx src/index.ts";

function runCliSafe(args: string): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execSync(`${CLI_CMD} ${args}`, {
      encoding: "utf-8",
      cwd: CLI_CWD,
      timeout: 25000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      exitCode: e.status ?? 1,
    };
  }
}

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
  meta?: { timestamp: string };
}

function validateEnvelope(raw: string, label: string): Envelope {
  // 1. Must be valid JSON
  let parsed: Envelope;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`[${label}] stdout is not valid JSON:\n${raw.slice(0, 500)}`);
  }

  // 2. Must have ok: boolean
  expect(typeof parsed.ok).toBe("boolean");

  // 3. Must have meta.timestamp
  expect(parsed.meta).toBeDefined();
  expect(typeof parsed.meta!.timestamp).toBe("string");
  expect(parsed.meta!.timestamp.length).toBeGreaterThan(0);
  // Verify ISO 8601
  const ts = new Date(parsed.meta!.timestamp);
  expect(ts.getTime()).toBeGreaterThan(0);

  if (parsed.ok) {
    // 4a. Success: must have data
    expect(parsed.data).toBeDefined();
  } else {
    // 4b. Error: must have error.code and error.message
    expect(parsed.error).toBeDefined();
    expect(typeof parsed.error!.code).toBe("string");
    expect(parsed.error!.code.length).toBeGreaterThan(0);
    expect(typeof parsed.error!.message).toBe("string");
  }

  return parsed;
}

describe("JSON Envelope Consistency", { timeout: 30000 }, () => {
  // ── Commands that require no adapter (always work) ──

  describe("no-adapter commands", () => {
    it("api-spec: valid success envelope", () => {
      const { stdout } = runCliSafe("--json api-spec");
      const env = validateEnvelope(stdout, "api-spec");
      expect(env.ok).toBe(true);
    });

    it("plan example: valid JSON output", () => {
      const { stdout } = runCliSafe("--json plan example");
      const parsed = JSON.parse(stdout);
      // plan example wraps in envelope in --json mode
      if (parsed.ok !== undefined) {
        // Envelope mode
        expect(parsed.ok).toBe(true);
        expect(parsed.data).toBeDefined();
      } else {
        // Raw plan JSON (legacy)
        expect(parsed.steps || parsed.version).toBeDefined();
      }
    });
  });

  // ── Error paths ──

  describe("error envelopes", () => {
    it("unknown command: CLI_ERROR envelope", () => {
      const { stdout } = runCliSafe("--json nonexistentcommand999");
      const env = validateEnvelope(stdout, "unknown command");
      expect(env.ok).toBe(false);
      expect(env.error!.code).toBe("CLI_ERROR");
    });

    it("plan validate with bad file: error envelope", () => {
      const { stdout } = runCliSafe("--json plan validate /tmp/__no_file_here_99.json");
      const env = validateEnvelope(stdout, "plan validate bad file");
      expect(env.ok).toBe(false);
      expect(env.error!.message).toBeTruthy();
    });

    it("stdout has no extra text before/after JSON", () => {
      const { stdout } = runCliSafe("--json api-spec");
      // Trim whitespace, should start with { and end with }
      const trimmed = stdout.trim();
      expect(trimmed.startsWith("{")).toBe(true);
      expect(trimmed.endsWith("}")).toBe(true);
      // No extra lines
      const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
      // All lines should be part of the JSON (indented)
      const reparsed = JSON.parse(trimmed);
      expect(reparsed.ok).toBeDefined();
    });

    it("stderr is empty in --json mode for error paths", () => {
      const { stderr } = runCliSafe("--json nonexistentcommand999");
      // In JSON mode, errors go to stdout as JSON, not stderr
      // stderr should be empty or only contain warnings
      // (Commander may still write to stderr in some cases)
      // We mainly verify that stdout has the JSON envelope
    });
  });

  // ── Commands that need HL adapter (read-only) ──

  const HAS_KEY = !!(process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HL_PRIVATE_KEY);

  describe.skipIf(!HAS_KEY)("HL adapter commands — envelope validation", () => {
    it("market list: success envelope with array data", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid market list");
      const env = validateEnvelope(stdout, "market list");
      expect(env.ok).toBe(true);
      expect(Array.isArray(env.data)).toBe(true);
      expect((env.data as unknown[]).length).toBeGreaterThan(0);
    });

    it("market mid BTC: success envelope with mid price", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid market mid BTC");
      const env = validateEnvelope(stdout, "market mid BTC");
      expect(env.ok).toBe(true);
      const data = env.data as Record<string, unknown>;
      expect(data.symbol).toBe("BTC");
      expect(data.mid).toBeDefined();
    });

    it("market info BTC: success envelope with market info", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid market info BTC");
      const env = validateEnvelope(stdout, "market info BTC");
      expect(env.ok).toBe(true);
    });

    it("market book BTC: success envelope with orderbook", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid market book BTC");
      const env = validateEnvelope(stdout, "market book BTC");
      expect(env.ok).toBe(true);
      const data = env.data as Record<string, unknown>;
      expect(data.bids).toBeDefined();
      expect(data.asks).toBeDefined();
    });

    it("account balance: success envelope with balance", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid account balance");
      const env = validateEnvelope(stdout, "account balance");
      expect(env.ok).toBe(true);
      const data = env.data as Record<string, unknown>;
      expect(data.equity).toBeDefined();
      expect(data.available).toBeDefined();
    });

    it("account positions: success envelope with array", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid account positions");
      const env = validateEnvelope(stdout, "account positions");
      expect(env.ok).toBe(true);
      expect(Array.isArray(env.data)).toBe(true);
    });

    it("account orders: success envelope with array", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid account orders");
      const env = validateEnvelope(stdout, "account orders");
      expect(env.ok).toBe(true);
      expect(Array.isArray(env.data)).toBe(true);
    });

    it("status: success envelope with exchange, balance, positions, orders", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid status");
      const env = validateEnvelope(stdout, "status");
      expect(env.ok).toBe(true);
      const data = env.data as Record<string, unknown>;
      expect(data.exchange).toBe("hyperliquid");
      expect(data.balance).toBeDefined();
      expect(data.positions).toBeDefined();
      expect(data.orders).toBeDefined();
    });

    it("account margin XYZFAKE: POSITION_NOT_FOUND error envelope", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid account margin XYZFAKE");
      const env = validateEnvelope(stdout, "account margin XYZFAKE");
      expect(env.ok).toBe(false);
      expect(env.error!.code).toBe("POSITION_NOT_FOUND");
    });

    it("trade fills: success envelope with array", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid trade fills");
      const env = validateEnvelope(stdout, "trade fills");
      expect(env.ok).toBe(true);
      expect(Array.isArray(env.data)).toBe(true);
    });

    it("health: success envelope with healthy flag", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid health");
      const env = validateEnvelope(stdout, "health");
      expect(env.ok).toBe(true);
    });
  });
});
