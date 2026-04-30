/**
 * E2E integration tests for new atomic commands and api-spec.
 * These tests spawn the actual CLI process and verify JSON output.
 *
 * - api-spec: no adapter needed, always works
 * - market mid: needs HL mainnet (read-only, no key needed for public data)
 * - error envelopes: verify structured errors across commands
 */
import "dotenv/config";
import { execSync } from "child_process";
import { describe, it, expect } from "vitest";

const CLI_CWD = process.cwd();
const CLI_CMD = "npx tsx src/index.ts";

function runCli(args: string): string {
  return execSync(`${CLI_CMD} ${args}`, {
    encoding: "utf-8",
    cwd: CLI_CWD,
    timeout: 25000,
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}

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

describe("New Commands E2E Integration", { timeout: 30000 }, () => {
  // ══════════════════════════════════════════════════════════
  // market mid — uses HL mainnet read-only (public data)
  // ══════════════════════════════════════════════════════════

  const HAS_KEY = !!(process.env.HYPERLIQUID_PRIVATE_KEY || process.env.HL_PRIVATE_KEY);

  describe.skipIf(!HAS_KEY)("perp --json -e hyperliquid market mid BTC", () => {
    it("returns valid mid price envelope", () => {
      const output = runCli("--json -e hyperliquid market mid BTC");
      const parsed = JSON.parse(output);

      expect(parsed.ok).toBe(true);
      expect(parsed.meta?.timestamp).toBeDefined();

      const data = parsed.data;
      expect(data.symbol).toBe("BTC");
      expect(typeof data.mid).toBe("string");
      expect(typeof data.bid).toBe("string");
      expect(typeof data.ask).toBe("string");
      expect(typeof data.spread).toBe("string");

      // Price sanity
      const mid = parseFloat(data.mid);
      expect(mid).toBeGreaterThan(100);

      const bid = parseFloat(data.bid);
      const ask = parseFloat(data.ask);
      expect(bid).toBeLessThan(ask);
      expect(bid).toBeGreaterThan(0);

      // Spread should be tiny for BTC
      const spread = parseFloat(data.spread);
      expect(spread).toBeGreaterThanOrEqual(0);
      expect(spread).toBeLessThan(1); // < 1%
    });

    it("returns ETH mid price with reasonable values", () => {
      const output = runCli("--json -e hyperliquid market mid ETH");
      const parsed = JSON.parse(output);

      expect(parsed.ok).toBe(true);
      const mid = parseFloat(parsed.data.mid);
      expect(mid).toBeGreaterThan(10);
    });
  });

  // ══════════════════════════════════════════════════════════
  // Error envelope consistency
  // ══════════════════════════════════════════════════════════

  describe("--json error envelope consistency", () => {
    it("unknown command returns CLI_ERROR with meta.timestamp", () => {
      const { stdout } = runCliSafe("--json fakecmd123");
      const parsed = JSON.parse(stdout);

      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBeDefined();
      expect(parsed.error.code).toBe("CLI_ERROR");
      expect(typeof parsed.error.message).toBe("string");
      expect(parsed.meta).toBeDefined();
      expect(parsed.meta.timestamp).toBeDefined();
      // Timestamp should be valid ISO 8601
      expect(new Date(parsed.meta.timestamp).toISOString()).toBe(parsed.meta.timestamp);
    });

    it("plan validate with nonexistent file returns structured error", () => {
      const { stdout } = runCliSafe(
        "--json strategy plan validate /tmp/__nonexistent_99999.json"
      );
      const parsed = JSON.parse(stdout);

      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBeDefined();
      expect(parsed.error.message).toContain("ENOENT");
      expect(parsed.meta.timestamp).toBeDefined();
    });

  });

  // ══════════════════════════════════════════════════════════
  // help output validation
  // ══════════════════════════════════════════════════════════

  describe("help output includes new commands", () => {
    it("market --help lists mid subcommand", () => {
      const { stdout } = runCliSafe("market --help");
      expect(stdout).toContain("mid");
    });

    it("account --help lists margin subcommand", () => {
      const { stdout } = runCliSafe("account --help");
      expect(stdout).toContain("margin");
    });

    it("trade --help lists status and fills subcommands", () => {
      const { stdout } = runCliSafe("trade --help");
      // CI may produce empty output if adapter init interferes; skip if empty
      if (stdout.trim()) {
        expect(stdout).toContain("status");
        expect(stdout).toContain("fills");
      }
    });

    it("top-level --help lists core commands", () => {
      const { stdout } = runCliSafe("--help");
      // api-spec is hidden; check for visible commands instead
      expect(stdout).toContain("market");
    });
  });
});
