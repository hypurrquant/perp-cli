/**
 * Public `market` commands must not resolve credentials.
 *
 * Repro of the E2E finding: an OWS master wallet is configured (settings.owsActiveWallet)
 * but no Ondo API key → the credentialed adapter throws NO_SIGNER_AVAILABLE. `market list`
 * must instead build the read-only adapter and go to the network. Runs the real CLI entry in
 * a child process with the isolated HOME and `fetch` blocked by a preload (no network).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../../..");
const HOME = process.env.HOME as string;
const PRELOAD = join(HOME, "block-fetch.mjs");

function runCli(args: string[]): { code: number | null; json: { ok: boolean; error?: { code: string; message: string } } } {
  const r = spawnSync(process.execPath, ["--import", "tsx", "--import", PRELOAD, join(REPO, "src/index.ts"), ...args], {
    cwd: REPO,
    env: { ...process.env, HOME, NO_COLOR: "1" },
    encoding: "utf8",
    timeout: 60_000,
  });
  const start = r.stdout.indexOf("{");
  if (start < 0) throw new Error(`CLI printed no JSON (exit ${r.status}). stderr:\n${r.stderr.slice(0, 2000)}`);
  return { code: r.status, json: JSON.parse(r.stdout.slice(start)) as { ok: boolean; error?: { code: string; message: string } } };
}

beforeAll(() => {
  // HOME is the per-file temp dir from helpers/isolate-home.ts — never the real ~/.perp.
  expect(HOME).not.toBe(process.env.PERP_TEST_REAL_HOME);
  mkdirSync(join(HOME, ".perp"), { recursive: true });
  writeFileSync(join(HOME, ".perp", "settings.json"), JSON.stringify({ owsActiveWallet: "test-master-no-ondo-key" }));
  writeFileSync(PRELOAD, "globalThis.fetch = async (u) => { throw new Error(`FETCH_BLOCKED ${u}`); };\n");
});

describe("market commands use the read-only adapter", () => {
  it("ondo market list goes to the network instead of failing NO_SIGNER_AVAILABLE", () => {
    const { json } = runCli(["-e", "ondo", "--json", "market", "list"]);
    expect(json.ok).toBe(false);
    expect(json.error?.code).not.toBe("NO_SIGNER_AVAILABLE");
    expect(json.error?.message).toContain("FETCH_BLOCKED");
  }, 90_000);

  it("a credentialed ondo command with the same config still fails on credential resolution (contrast)", () => {
    const { json } = runCli(["-e", "ondo", "--json", "account", "positions"]);
    expect(json.ok).toBe(false);
    // The OWS wallet does not exist in the isolated HOME → KEY_NOT_FOUND; with a real wallet
    // but no Ondo key it is NO_SIGNER_AVAILABLE. Either way it never reaches the network.
    expect(["KEY_NOT_FOUND", "NO_SIGNER_AVAILABLE"]).toContain(json.error?.code);
    expect(json.error?.message).not.toContain("FETCH_BLOCKED");
  }, 90_000);
});
