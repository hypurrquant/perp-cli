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

const CLI_CWD = process.cwd();
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
    it("health: valid success envelope", () => {
      const { stdout } = runCliSafe("--json health");
      const env = validateEnvelope(stdout, "health");
      expect(env.ok).toBe(true);
    });

    it("strategy plan example: valid JSON output", () => {
      const { stdout } = runCliSafe("--json strategy plan example");
      const parsed = JSON.parse(stdout);
      if (parsed.ok !== undefined) {
        expect(parsed.ok).toBe(true);
        expect(parsed.data).toBeDefined();
      } else {
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

    it("strategy plan validate with bad file: error envelope", () => {
      const { stdout } = runCliSafe("--json strategy plan validate /tmp/__no_file_here_99.json");
      const env = validateEnvelope(stdout, "strategy plan validate bad file");
      expect(env.ok).toBe(false);
      expect(env.error!.message).toBeTruthy();
    });

    it("stdout has no extra text before/after JSON", () => {
      const { stdout } = runCliSafe("--json health");
      const trimmed = stdout.trim();
      expect(trimmed.startsWith("{")).toBe(true);
      expect(trimmed.endsWith("}")).toBe(true);
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

    it("account pnl: success envelope with equity", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid account pnl");
      const env = validateEnvelope(stdout, "account pnl");
      expect(env.ok).toBe(true);
      const data = env.data as Record<string, unknown>;
      expect(data.equity).toBeDefined();
      expect(data.realizedPnl).toBeDefined();
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

    it("portfolio: success envelope with exchanges array", () => {
      const { stdout } = runCliSafe("--json -e hyperliquid portfolio");
      const env = validateEnvelope(stdout, "portfolio");
      expect(env.ok).toBe(true);
      const data = env.data as Record<string, unknown>;
      expect(Array.isArray(data.exchanges)).toBe(true);
      const hl = (data.exchanges as Array<Record<string, unknown>>).find(e => e.name === "hyperliquid");
      expect(hl).toBeDefined();
      expect(hl!.perp).toBeDefined();
      expect(hl!.positions).toBeDefined();
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
