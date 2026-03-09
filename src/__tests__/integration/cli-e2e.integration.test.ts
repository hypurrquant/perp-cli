import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { describe, it, expect, afterAll } from "vitest";

const CLI_CWD = "/Users/hik/Documents/GitHub/pacifica/packages/cli";
const CLI_CMD = "npx tsx src/index.ts";

/** Temp files created during tests, cleaned up in afterAll */
const tempFiles: string[] = [];

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

function writeTempFile(name: string, content: string): string {
  const path = `/tmp/${name}`;
  writeFileSync(path, content, "utf-8");
  tempFiles.push(path);
  return path;
}

afterAll(() => {
  for (const f of tempFiles) {
    if (existsSync(f)) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
});

describe("CLI E2E Integration Tests", { timeout: 30000 }, () => {
  // ───────────────────── schema command ─────────────────────

  describe("perp schema --json", () => {
    let schema: Record<string, unknown>;

    /** schema may be wrapped in envelope { ok, data } or raw */
    function parseSchema(output: string): Record<string, unknown> {
      const parsed = JSON.parse(output);
      return (parsed.data ?? parsed) as Record<string, unknown>;
    }

    it("outputs valid JSON with expected top-level structure", () => {
      const output = runCli("schema");
      schema = parseSchema(output);

      expect(schema).toHaveProperty("schemaVersion");
      expect(schema).toHaveProperty("commands");
      expect(schema).toHaveProperty("errorCodes");
      expect(schema).toHaveProperty("exchanges");

      expect(Array.isArray(schema.commands)).toBe(true);
      expect(Array.isArray(schema.exchanges)).toBe(true);
      expect(typeof schema.errorCodes).toBe("object");
    });

    it("commands array contains known command names", () => {
      const output = runCli("schema");
      schema = parseSchema(output);

      const commandNames = (schema.commands as Array<{ name: string }>).map((c) => c.name);

      expect(commandNames).toContain("market");
      expect(commandNames).toContain("account");
      expect(commandNames).toContain("trade");
      expect(commandNames).toContain("arb");
      expect(commandNames).toContain("plan");
    });

    it("errorCodes contains key error types with retryable flags", () => {
      const output = runCli("schema");
      schema = parseSchema(output);

      const errorCodes = schema.errorCodes as Record<string, { status: number; retryable: boolean }>;

      expect(errorCodes).toHaveProperty("INSUFFICIENT_BALANCE");
      expect(errorCodes.INSUFFICIENT_BALANCE.retryable).toBe(false);

      expect(errorCodes).toHaveProperty("RATE_LIMITED");
      expect(errorCodes.RATE_LIMITED.retryable).toBe(true);

      expect(errorCodes).toHaveProperty("TIMEOUT");
      expect(errorCodes.TIMEOUT.retryable).toBe(true);

      expect(errorCodes).toHaveProperty("EXCHANGE_UNREACHABLE");
      expect(errorCodes.EXCHANGE_UNREACHABLE.retryable).toBe(true);

      expect(errorCodes).toHaveProperty("UNKNOWN");
      expect(errorCodes.UNKNOWN.retryable).toBe(false);
    });
  });

  // ───────────────────── plan commands ─────────────────────

  describe("perp plan example", () => {
    it("outputs valid JSON with version 1.0 and steps array", () => {
      const output = runCli("plan example");
      const parsed = JSON.parse(output);
      // plan example may be wrapped in envelope (ok/data) or raw
      const plan = parsed.data ?? parsed;

      expect(plan.version).toBe("1.0");
      expect(Array.isArray(plan.steps)).toBe(true);
      expect(plan.steps.length).toBeGreaterThan(0);

      // Each step should have id, action, params
      for (const step of plan.steps) {
        expect(step).toHaveProperty("id");
        expect(step).toHaveProperty("action");
        expect(step).toHaveProperty("params");
      }
    });
  });

  describe("perp plan validate", () => {
    it("succeeds for a valid plan (exit 0, output contains 'valid')", () => {
      const validPlan = {
        version: "1.0",
        description: "Test plan",
        steps: [
          {
            id: "step1",
            action: "check_balance",
            params: { minAvailable: 50 },
            onFailure: "abort",
          },
          {
            id: "step2",
            action: "market_order",
            params: { symbol: "ETH", side: "buy", size: "0.1" },
            onFailure: "abort",
            dependsOn: "step1",
          },
        ],
      };

      const filePath = writeTempFile("test-valid-plan.json", JSON.stringify(validPlan, null, 2));
      const { stdout, exitCode } = runCliSafe(`plan validate ${filePath}`);

      expect(exitCode).toBe(0);
      // The human-readable output says "valid" or the JSON output includes valid:true
      const lower = stdout.toLowerCase();
      expect(lower).toContain("valid");
    });

    it("reports errors for an invalid plan (wrong version) with --json", () => {
      const invalidPlan = {
        version: "999.0",
        steps: [
          {
            id: "bad",
            action: "market_order",
            params: {},
          },
        ],
      };

      const filePath = writeTempFile("test-invalid-plan.json", JSON.stringify(invalidPlan, null, 2));
      const { stdout, exitCode } = runCliSafe(`--json plan validate ${filePath}`);

      // Should still exit 0 because validation itself succeeds (reports errors in JSON)
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(true);
      // The data.valid should be false
      expect(parsed.data.valid).toBe(false);
      expect(Array.isArray(parsed.data.errors)).toBe(true);
      expect(parsed.data.errors.length).toBeGreaterThan(0);

      // Should mention version mismatch
      const allErrors = parsed.data.errors.join(" ");
      expect(allErrors).toContain("version");
    });
  });

  // ───────────────────── --json error wrapping ─────────────────────

  describe("--json structured error output", () => {
    it("outputs structured JSON error for a nonexistent plan file", () => {
      // Use plan validate with a file that does not exist — this triggers
      // withJsonErrors which wraps the ENOENT in the standard envelope.
      const { stdout, exitCode } = runCliSafe(
        "--json plan validate /tmp/__nonexistent_cli_test_file_99999.json"
      );

      expect(exitCode).toBe(0);

      const parsed = JSON.parse(stdout);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBeDefined();
      expect(typeof parsed.error.code).toBe("string");
      expect(typeof parsed.error.message).toBe("string");
      expect(parsed.error.message).toContain("ENOENT");
      expect(typeof parsed.error.retryable).toBe("boolean");
      expect(parsed).toHaveProperty("meta");
      expect(parsed.meta).toHaveProperty("timestamp");
    });
  });

  // ───────────────────── help output ─────────────────────

  describe("perp --help", () => {
    it("includes all major commands in help output", () => {
      const { stdout } = runCliSafe("--help");
      const helpText = stdout.toLowerCase();

      expect(helpText).toContain("schema");
      expect(helpText).toContain("plan");
      expect(helpText).toContain("trade");
      expect(helpText).toContain("stream");
      expect(helpText).toContain("market");
      expect(helpText).toContain("account");
      expect(helpText).toContain("arb");
    });
  });
});
