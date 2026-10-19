#!/usr/bin/env node
// Pre-release live QA against the PUBLISHED npm tarball (docs/TESTING.md §3.8 — required before a
// release is announced, and nightly in .github/workflows/conformance-nightly.yml).
//
//   node scripts/release-qa/run.mjs --version 0.15.0 [--out <dir>] [--ws-seconds 12]
//   pnpm release-qa --version latest
//
// Steps (read-only public mainnet; no keys — every child runs with an empty temp HOME):
//   1. install perp-cli@<v> + @hypurrquant/perp-ws@<v> (+ ws) into a temp dir; check both versions
//   2. read matrix: the conformance suite (venues + ranges) in live mode against the INSTALLED CLI
//      (PERP_CONFORMANCE_BIN) — same contracts, invariants and KNOWN_FAILURES as `pnpm test`
//   3. WS checks against the installed @hypurrquant/perp-ws (ws-check.mjs)
//   4. MCP checks against the installed perp-mcp, incl. get_markets ⇔ market list counts (mcp-check.mjs)
// A failing check that is not in KNOWN_FAILURES fails the run. Report: <out>/release-qa.{json,md}.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
let version = opt("--version", null);
if (!version) { console.error("usage: node scripts/release-qa/run.mjs --version <x.y.z|latest> [--out dir]"); process.exit(2); }
const WORK = mkdtempSync(join(tmpdir(), "perp-release-qa-"));
const HOME = join(WORK, "home");
mkdirSync(HOME);
const OUT = resolve(opt("--out", join(WORK, "out")));
mkdirSync(OUT, { recursive: true });
const WS_SECONDS = opt("--ws-seconds", "12");
const env = { ...process.env, HOME, USERPROFILE: HOME, NO_COLOR: "1", CI: "1" };
for (const k of Object.keys(env)) if (/KEY|SECRET|PRIVATE|MNEMONIC|PASSPHRASE|TOKEN/i.test(k) && k !== "GITHUB_TOKEN") delete env[k];

const steps = [];
function run(name, cmd, argv, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, argv, { cwd: opts.cwd ?? WORK, env: opts.env ?? env, encoding: "utf8", maxBuffer: 256 << 20, timeout: opts.timeout ?? 1_800_000 });
  const step = { name, code: r.status, ms: Date.now() - t0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  steps.push(step);
  console.log(`${r.status === 0 ? "PASS" : "FAIL"} ${name} (${step.ms} ms)`);
  return step;
}

// 1. install
if (version === "latest") version = spawnSync("npm", ["view", "perp-cli", "version"], { encoding: "utf8" }).stdout.trim();
writeFileSync(join(WORK, "package.json"), JSON.stringify({ name: "perp-release-qa", private: true, type: "module" }));
run("npm install", "npm", ["install", "--no-audit", "--no-fund", `perp-cli@${version}`, `@hypurrquant/perp-ws@${version}`, "ws@^8"]);
const installed = (p) => JSON.parse(readFileSync(join(WORK, "node_modules", p, "package.json"), "utf8")).version;
const versionProblems = [];
for (const p of ["perp-cli", "@hypurrquant/perp-ws"]) {
  try { if (installed(p) !== version) versionProblems.push(`${p} installed ${installed(p)} ≠ ${version}`); } catch { versionProblems.push(`${p} not installed`); }
}
const BIN = join(WORK, "node_modules/perp-cli/dist/index.js");
const MCP = join(WORK, "node_modules/perp-cli/dist/mcp-server.js");
const v = run("perp --version", process.execPath, [BIN, "--version"]);
if (v.stdout.trim() !== version) versionProblems.push(`perp --version printed "${v.stdout.trim()}"`);

// 2. read matrix through the conformance suite (live, installed binary)
const vitestJson = join(OUT, "conformance-live.json");
const matrix = run("conformance (live, installed CLI)", "pnpm", [
  "exec", "vitest", "run", "-c", "vitest.conformance.live.config.ts",
  "src/__tests__/conformance/venues.conformance.test.ts", "src/__tests__/conformance/ranges.conformance.test.ts",
  "--reporter=default", "--reporter=json", `--outputFile.json=${vitestJson}`,
], { cwd: REPO, env: { ...process.env, PERP_LIVE: "1", PERP_CONFORMANCE_BIN: BIN, NO_COLOR: "1" } });

// 3 + 4. WS and MCP against the installed packages (scripts copied next to node_modules).
for (const f of ["ws-check.mjs", "mcp-check.mjs"]) copyFileSync(join(REPO, "scripts/release-qa", f), join(WORK, f));
const ws = run("ws checks (installed @hypurrquant/perp-ws)", process.execPath, [join(WORK, "ws-check.mjs"), WS_SECONDS]);
const mcp = run("mcp checks (installed perp-mcp)", process.execPath, [join(WORK, "mcp-check.mjs"), MCP, BIN]);

const known = JSON.parse(run("load KNOWN_FAILURES", "pnpm", ["exec", "tsx", "-e",
  "import('./src/__tests__/conformance/known-failures.ts').then(m => console.log(JSON.stringify(Object.keys(m.KNOWN_FAILURES))))"],
{ cwd: REPO, env: process.env }).stdout.trim() || "[]");
const parse = (s) => { try { return JSON.parse(s.slice(s.indexOf("{"))).checks; } catch { return [{ id: "report", ok: false, detail: "no JSON report" }]; } };
const scripted = [...parse(ws.stdout), ...parse(mcp.stdout)];
const newFailures = scripted.filter(c => !c.ok && !known.includes(c.id));
const fixedKnown = scripted.filter(c => c.ok && known.includes(c.id)).map(c => c.id);

const failed = versionProblems.length > 0 || steps.find(s => s.name === "npm install").code !== 0 || matrix.code !== 0 || newFailures.length > 0;
const report = { version, at: new Date().toISOString(), failed, versionProblems, matrixExit: matrix.code, newFailures, fixedKnown, checks: scripted };
writeFileSync(join(OUT, "release-qa.json"), JSON.stringify(report, null, 1));
writeFileSync(join(OUT, "release-qa.md"), [
  `# perp-cli ${version} release QA — ${failed ? "FAIL" : "PASS"}`, "",
  `Run ${report.at} against the published npm packages (keyless, mainnet public reads).`, "",
  "## Steps", ...steps.map(s => `- ${s.code === 0 ? "PASS" : "FAIL"} ${s.name} (${s.ms} ms)`), "",
  "## Version", ...(versionProblems.length ? versionProblems.map(p => `- ${p}`) : ["- perp-cli and @hypurrquant/perp-ws match"]), "",
  "## New failures (not in KNOWN_FAILURES)", ...(newFailures.length ? newFailures.map(c => `- \`${c.id}\`: ${c.detail}`) : ["- none"]), "",
  "## Known failures that now pass (remove them)", ...(fixedKnown.length ? fixedKnown.map(id => `- \`${id}\``) : ["- none"]), "",
  "## Conformance (live, installed CLI)", "```", matrix.stdout.split("\n").filter(l => /✓|×|FAIL|Tests|passed|failed/.test(l)).slice(-60).join("\n"), "```", "",
].join("\n"));
console.log(`\nrelease QA ${version}: ${failed ? "FAIL" : "PASS"} — report ${join(OUT, "release-qa.md")}`);
process.exit(failed ? 1 : 0);
