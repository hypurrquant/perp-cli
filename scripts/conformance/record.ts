/**
 * Record conformance fixtures from LIVE public mainnet endpoints (read-only; no keys — the suite
 * runs with an isolated HOME). Writes src/__tests__/fixtures/conformance/<name>.json.
 *
 *   pnpm conformance:record --venue ondo            one venue (comma-separated list allowed)
 *   pnpm conformance:record --all                   every registered venue
 *   pnpm conformance:record --cross                 the cross-venue / CLI ⇄ MCP fixture (cross.json)
 *
 * Steps (docs/TESTING.md §3.2):
 *   1. record  — the conformance suite runs live with PERP_RECORD=1; every HTTP / WebSocket exchange
 *                is captured, trimmed to the keep-symbols (real shapes, small) and anonymized
 *                (src/__tests__/conformance/fixture-tools.ts — the scripts/ws-probe scrub approach);
 *   2. prune   — the suite replays the new fixture with PERP_CONFORMANCE_PRUNE=1 and rewrites it
 *                with only the exchanges the replay used;
 *   3. verify  — a plain replay; its result is printed (known failures are asserted, so a red run
 *                here means a contract change or a fixture problem — read it before committing).
 * Never commit a fixture you did not inspect. Not part of the CLI build.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : null;
};

const venues = flag("--venue");
const all = args.includes("--all");
const cross = args.includes("--cross");
if (venues === null && !all && !cross) {
  console.error("usage: pnpm conformance:record (--venue <id[,id]> | --all | --cross)");
  process.exit(2);
}

const files: string[] = [];
if (venues !== null || all) files.push("src/__tests__/conformance/venues.conformance.test.ts");
if (cross) files.push("src/__tests__/conformance/cross.conformance.test.ts");

function vitest(env: Record<string, string>, config: string | null): number {
  const r = spawnSync("pnpm", ["exec", "vitest", "run", ...(config ? ["-c", config] : []), ...files], {
    cwd: REPO, stdio: "inherit", env: { ...process.env, ...env },
  });
  return r.status ?? 1;
}

const filter: Record<string, string> = venues !== null ? { PERP_CONFORMANCE_VENUES: venues } : {};
console.log(`\n== 1/3 record (live public mainnet) ${venues ?? (all ? "all venues" : "")}${cross ? " + cross" : ""}`);
vitest({ ...filter, PERP_RECORD: "1" }, "vitest.conformance.live.config.ts");
console.log("\n== 2/3 prune (keep only the exchanges the replay uses)");
vitest({ ...filter, PERP_CONFORMANCE_PRUNE: "1" }, null);
console.log("\n== 3/3 verify (offline replay)");
const code = vitest(filter, null);
console.log(code === 0 ? "\nfixtures recorded and replay is green" : "\nreplay is RED — inspect the failures above before committing the fixtures");
process.exit(code);
