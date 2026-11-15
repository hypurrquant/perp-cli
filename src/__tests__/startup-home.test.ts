/**
 * Entry-point startup without a usable home (src/paths.ts): the real `perp` / `perp-mcp`
 * entries in a child process, cwd = a temp dir, isolated HOME (helpers/isolate-home.ts) or
 * none, `fetch` blocked by a preload (no network).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(__dirname, "../..");
const HOME = process.env.HOME as string;
const PRELOAD = join(HOME, "block-fetch.mjs");
// The cwd is a temp dir, so tsx is loaded by URL (a bare "tsx" resolves from the cwd).
const TSX = pathToFileURL(join(REPO, "node_modules", "tsx", "dist", "loader.mjs")).href;
const VERSION = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }).version;
let cwd: string;

function run(entry: string, args: string[], home: string | null): { code: number | null; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.HOME;
  delete env.USERPROFILE;
  if (home !== null) env.HOME = home;
  const r = spawnSync(process.execPath, ["--import", TSX, "--import", PRELOAD, join(REPO, "src", entry), ...args], {
    cwd, env, encoding: "utf8", timeout: 60_000, input: "",
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

beforeAll(() => {
  expect(HOME).not.toBe(process.env.PERP_TEST_REAL_HOME);
  writeFileSync(PRELOAD, "globalThis.fetch = async (u) => { throw new Error(`FETCH_BLOCKED ${u}`); };\n");
});

beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "perp-startup-cwd-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe("perp CLI startup", () => {
  it("a legacy ./~/.perp in the cwd is refused with INVALID_PARAMS naming it", () => {
    mkdirSync(join(cwd, "~", ".perp"), { recursive: true });
    const r = run("index.ts", ["--json", "settings", "show"], HOME);
    expect(r.code).toBe(1);
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf("{"))) as { ok: boolean; error: { code: string; remediation: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("INVALID_PARAMS");
    expect(json.error.remediation).toContain(join("~", ".perp"));
  });

  it("--version works with HOME unset", () => {
    const r = run("index.ts", ["--version"], null);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(VERSION);
  });

  it("--help works with HOME unset", () => {
    const r = run("index.ts", ["--help"], null);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });
});

describe("perp-mcp startup", () => {
  it("HOME unset → one stderr line (no stack trace), exit 1", () => {
    const r = run("mcp-server.ts", [], null);
    expect(r.code).toBe(1);
    const lines = r.stderr.trim().split("\n").filter((l) => l.startsWith("perp-mcp:") || /^\s+at /.test(l));
    expect(lines).toEqual([expect.stringMatching(/^perp-mcp: HOME is not set; .* — Set HOME/)]);
  });
});
