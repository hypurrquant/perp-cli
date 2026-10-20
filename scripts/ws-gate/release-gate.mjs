#!/usr/bin/env node
// perp-cli/ws 0.15.0 release gate (plan ws-0.14.4 Phase 4). Required steps, output recorded to
// .omc/research/ws-0.15.0-release-gate.md (gitignored):
//   1. build (tsc + tsup) and the ws unit tests (incl. bundle purity: no Node built-ins / ws / Buffer /
//      process, no top-level await, no load-time globals, ES2020 syntax, API snapshot)
//   2. pnpm pack → tarball contents
//   3. install the tarball in a clean consumer: import perp-cli/ws + perp-cli/ws/node in Node; typecheck a
//      consumer with moduleResolution bundler / node16 / node10; typecheck every ```ts block of
//      skills/perp-cli/references/ws-library.md (taken from the installed package)
//   4. @arethetypeswrong/cli on the tarball
//   5. Next 13.5 (webpack, transpilePackages) build of examples/ws-funding-compare-browser via
//      examples/ws-next-smoke against the tarball; the client chunk carrying perp-cli/ws has no Node-only
//      references
//   6. Node example smoke: examples/ws-node-stream (public data, 15 s)
//   7. @hypurrquant/perp-ws (packages/perp-ws, built from the same src/ws): version lockstep, npm pack →
//      contents + byte-identical to perp-cli's dist/ws, clean install has 0 transitive deps, the /node
//      entry fails clearly without `ws` and streams live with it, consumer tsc bundler / node16 / node10,
//      the skill ```ts blocks (they import @hypurrquant/perp-ws), attw, Next 13.5 build + chunk purity
// Usage: node scripts/ws-gate/release-gate.mjs   (network: npm registry + venue WebSockets)
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "../..");
const OUT = join(REPO, ".omc/research/ws-0.15.0-release-gate.md");
const WORK = mkdtempSync(join(tmpdir(), "perp-ws-gate-"));
const steps = [];

function run(name, cmd, args, opts = {}) {
  const t0 = Date.now();
  const r = spawnSync(cmd, args, { cwd: opts.cwd ?? REPO, encoding: "utf8", env: { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1" }, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeout ?? 600_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  const step = { name, cmd: `${cmd} ${args.join(" ")}`, cwd: opts.cwd ?? REPO, code: r.status, ms: Date.now() - t0, out };
  steps.push(step);
  console.log(`${r.status === 0 ? "PASS" : "FAIL"} ${name} (${step.ms} ms)`);
  return step;
}

function check(name, ok, detail) {
  steps.push({ name, cmd: "(check)", cwd: "", code: ok ? 0 : 1, ms: 0, out: detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  return ok;
}

const tail = (s, n = 40) => s.split("\n").slice(-n).join("\n");

/**
 * Node binaries for the perp-ws consumer matrix: this node, PATH, nvm, fnm, Homebrew node@N, plus
 * PERP_GATE_NODES (":"-separated paths). The newest binary per major ≥ 20 is used.
 */
function nodeMatrix() {
  const cands = new Set([process.execPath]);
  for (const p of (spawnSync("which", ["-a", "node"], { encoding: "utf8" }).stdout ?? "").split("\n")) if (p.trim() !== "") cands.add(p.trim());
  for (const p of (process.env.PERP_GATE_NODES ?? "").split(":")) if (p !== "") cands.add(p);
  const dirs = [
    [join(homedir(), ".nvm/versions/node"), "bin/node"],
    [join(homedir(), ".local/share/fnm/node-versions"), "installation/bin/node"],
    [join(homedir(), "Library/Application Support/fnm/node-versions"), "installation/bin/node"],
  ];
  for (const [d, rel] of dirs) if (existsSync(d)) for (const v of readdirSync(d)) cands.add(join(d, v, rel));
  for (const d of ["/opt/homebrew/opt", "/usr/local/opt"]) if (existsSync(d)) for (const v of readdirSync(d)) if (/^node(@\d+)?$/.test(v)) cands.add(join(d, v, "bin/node"));
  const byMajor = new Map();
  for (const bin of cands) {
    if (!existsSync(bin)) continue;
    const v = (spawnSync(bin, ["-v"], { encoding: "utf8" }).stdout ?? "").trim();
    const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(v);
    if (m === null || Number(m[1]) < 20) continue;
    const key = Number(m[1]);
    const cur = byMajor.get(key);
    const num = Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]);
    if (cur === undefined || num > cur.num) byMajor.set(key, { bin, version: v, num });
  }
  return [...byMajor.entries()].sort((a, b) => a[0] - b[0]).map(([major, x]) => ({ major, bin: x.bin, version: x.version }));
}

// 1. build + unit tests of the library
run("build (tsc + tsup)", "pnpm", ["-s", "run", "build"]);
run("ws unit tests (purity, parity, API snapshot, codecs, lifecycle)", "npx", ["vitest", "run", "src/__tests__/ws"]);

// 2. pack
const pack = run("pnpm pack", "pnpm", ["pack", "--pack-destination", WORK]);
const tgz = readdirSync(WORK).find(f => f.endsWith(".tgz"));
if (tgz === undefined) throw new Error("no tarball");
const TGZ = join(WORK, tgz);
const list = spawnSync("tar", ["-tzf", TGZ], { encoding: "utf8" }).stdout.split("\n");
const need = ["package/package.json", "package/dist/ws/index.js", "package/dist/ws/index.d.ts", "package/dist/ws/node.js", "package/dist/ws/node.d.ts", "package/skills/perp-cli/references/ws-library.md"];
// dist/ws/ holds only the two tsup bundles, plus tsc output of src/ws modules that the CLI itself
// imports (src/ws may only import within src/ws, so shared helpers live there). Those are not in
// the `exports` map, so `perp-cli/ws` consumers cannot reach them.
const CLI_SHARED_WS = /^package\/dist\/ws\/(?:index|node|pacifica-instrument|aster-market|arcus-market|lighter-market|unclassified)\.(?:js|d\.ts)$/;
check("tarball contents", need.every(f => list.includes(f)) && list.filter(f => f.startsWith("package/dist/ws/")).every(f => CLI_SHARED_WS.test(f)),
  `${tgz}: ${list.filter(f => f.startsWith("package/dist/ws/")).join(", ")}; required present: ${need.filter(f => list.includes(f)).length}/${need.length}`);
void pack;

// Shipped text never promises a version that is already out (≤ this version): the packed type
// declarations and the skill references, as consumers read them.
{
  const version = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version;
  const cmp = (a, b) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  const PROMISE = /(planned for|arrives? in|ships? in|coming in|lands? in|until|not in this release|read-only in|known gap in|reserved for)\s*\(?\*{0,2}v?(\d+\.\d+\.\d+)/gi;
  const shipped = list.filter(f => /^package\/(dist\/ws\/.*\.d\.ts|skills\/.*\.md|README\.md)$/.test(f));
  const stale = [];
  for (const f of shipped) {
    const text = spawnSync("tar", ["-xOzf", TGZ, f], { encoding: "utf8", maxBuffer: 64 << 20 }).stdout;
    for (const m of text.matchAll(PROMISE)) if (cmp(m[2], version) <= 0) stale.push(`${f}: "${m[0]}"`);
  }
  check(`no shipped text promises a version <= ${version}`, stale.length === 0, stale.length ? stale.join("\n") : `${shipped.length} file(s) clean`);
}

// 3. consumer install + imports + typecheck + skill code blocks
const C = join(WORK, "consumer");
mkdirSync(C, { recursive: true });
writeFileSync(join(C, "package.json"), JSON.stringify({ name: "ws-gate-consumer", private: true, type: "module" }));
run("consumer: npm install tarball + typescript", "npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", TGZ, "typescript@5", "@types/node@20"], { cwd: C });
writeFileSync(join(C, "imports.mjs"), `
const a = await import("perp-cli/ws"); const b = await import("perp-cli/ws/node");
for (const k of ["createVenueStream", "createFundingComparator", "toApr", "toHourly", "hyperliquid", "pacifica", "lighter", "lighterRh", "aster", "arcus"]) if (typeof a[k] === "undefined") throw new Error("missing export " + k);
if (typeof b.nodeTransport !== "function") throw new Error("missing nodeTransport");
delete globalThis.WebSocket;
try { a.createVenueStream(a.hyperliquid, { fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) }); throw new Error("expected INVALID_PARAMS"); }
catch (e) { if (e.structured?.code !== "INVALID_PARAMS") throw e; }
console.log("imports ok:", Object.keys(a).length, "exports; node extra:", Object.keys(b).filter(k => !(k in a)).join(","));
`);
run("consumer: import perp-cli/ws and perp-cli/ws/node (Node)", "node", ["imports.mjs"], { cwd: C });
writeFileSync(join(C, "consumer.ts"), `
import { createVenueStream, createFundingComparator, hyperliquid, toApr, type MarketUpdate, type UserUpdate } from "perp-cli/ws";
import { nodeTransport } from "perp-cli/ws/node";
const s = createVenueStream(hyperliquid, { transport: nodeTransport });
const apr = (u: MarketUpdate): number | null => toApr(u.funding.rate, u.funding.rateIntervalHours);
const onUser = (u: UserUpdate): string => u.type;
void s; void apr; void onUser; void createFundingComparator;
`);
for (const [mr, mod] of [["bundler", "esnext"], ["node16", "node16"], ["node10", "esnext"]]) {
  run(`consumer: tsc moduleResolution=${mr}`, "npx", ["tsc", "--noEmit", "--strict", "--target", "es2020", "--lib", "es2020,dom", "--types", "node", "--module", mod, "--moduleResolution", mr, "consumer.ts"], { cwd: C });
}
const md = readFileSync(join(C, "node_modules/perp-cli/skills/perp-cli/references/ws-library.md"), "utf8");
const blocks = [...md.matchAll(/```ts\n([\s\S]*?)```/g)].map(m => m[1]);
// The reference imports @hypurrquant/perp-ws; with perp-cli the same code is perp-cli/ws (same API).
const asPerpCli = (b) => b.replaceAll('"@hypurrquant/perp-ws/node"', '"perp-cli/ws/node"').replaceAll('"@hypurrquant/perp-ws"', '"perp-cli/ws"');
const files = blocks.map((b, i) => { const f = `skill-block-${i + 1}.ts`; writeFileSync(join(C, f), `${asPerpCli(b)}\nexport {};\n`); return f; });
run(`skill reference: typecheck ${files.length} ts code blocks as perp-cli/ws (strict, noUncheckedIndexedAccess)`, "npx", ["tsc", "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--target", "es2022", "--lib", "es2022,dom", "--types", "node", "--module", "esnext", "--moduleResolution", "bundler", ...files], { cwd: C });

// 4. attw
run("@arethetypeswrong/cli (esm-only profile)", "npx", ["-y", "@arethetypeswrong/cli@latest", TGZ, "--profile", "esm-only"], { cwd: WORK });

// 5. Next 13.5
const EX = join(WORK, "examples");
cpSync(join(REPO, "examples/ws-funding-compare-browser"), join(EX, "ws-funding-compare-browser"), { recursive: true });
cpSync(join(REPO, "examples/ws-next-smoke"), join(EX, "ws-next-smoke"), { recursive: true });
const N = join(EX, "ws-next-smoke");
run("next-smoke: npm install (next 13.5, react 18) + tarball", "npm", ["install", "--no-audit", "--no-fund", TGZ], { cwd: N, timeout: 900_000 });
const nv = spawnSync("node", ["-p", "require('next/package.json').version"], { cwd: N, encoding: "utf8" }).stdout.trim();
check("next version is 13.5.x", nv.startsWith("13.5."), `next ${nv}`);
run("next-smoke: next build (webpack, transpilePackages: [\"perp-cli\"])", "npx", ["next", "build"], { cwd: N, timeout: 900_000 });
const chunksDir = join(N, ".next/static/chunks");
let lib = null;
if (existsSync(chunksDir)) {
  const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".js") ? [join(d, e.name)] : []));
  for (const f of walk(chunksDir)) { const t = readFileSync(f, "utf8"); if (t.includes("connection refused before open")) { lib = { f, t }; break; } }
}
check("next client chunk carries perp-cli/ws without Node-only references", lib !== null && !/require\(["']ws["']\)|["']node:|\bBuffer\.from\b|createRequire|__dirname/.test(lib.t),
  lib === null ? "perp-cli/ws code not found in .next/static/chunks" : `chunk ${lib.f.slice(N.length + 1)} (${lib.t.length} B): no require("ws"), node:*, Buffer, createRequire, __dirname`);

// 6. Node example
run("node example smoke: examples/ws-node-stream (hyperliquid BTC, 15 s)", "node", ["examples/ws-node-stream/stream.mjs", "hyperliquid", "BTC", "--seconds", "15"], { timeout: 120_000 });

// 7. @hypurrquant/perp-ws
const PW = join(REPO, "packages/perp-ws");
const pwPkg = JSON.parse(readFileSync(join(PW, "package.json"), "utf8"));
const rootPkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
check("perp-ws: version lockstep + no dependencies + optional peer ws",
  pwPkg.version === rootPkg.version && Object.keys(pwPkg.dependencies ?? {}).length === 0 && pwPkg.peerDependenciesMeta?.ws?.optional === true && pwPkg.sideEffects === false,
  `@hypurrquant/perp-ws ${pwPkg.version} / perp-cli ${rootPkg.version}; dependencies ${JSON.stringify(pwPkg.dependencies)}; peer ws ${pwPkg.peerDependencies?.ws} optional=${pwPkg.peerDependenciesMeta?.ws?.optional}; sideEffects ${pwPkg.sideEffects}`);
const PWD = join(WORK, "perp-ws-pack");
mkdirSync(PWD, { recursive: true });
run("perp-ws: npm pack", "npm", ["pack", "--ignore-scripts", "--pack-destination", PWD], { cwd: PW });
const pwTgzName = readdirSync(PWD).find(f => f.endsWith(".tgz"));
if (pwTgzName === undefined) throw new Error("no perp-ws tarball");
const PWTGZ = join(PWD, pwTgzName);
const pwList = spawnSync("tar", ["-tzf", PWTGZ], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
const pwWant = ["package/LICENSE", "package/README.md", "package/dist/index.d.ts", "package/dist/index.js", "package/dist/node.d.ts", "package/dist/node.js", "package/package.json"];
const same = ["index.js", "index.d.ts", "node.js", "node.d.ts"].every(f => readFileSync(join(PW, "dist", f)).equals(readFileSync(join(REPO, "dist/ws", f))));
const pwSize = readFileSync(PWTGZ).length;
check("perp-ws: tarball contents (7 files) and dist byte-identical to perp-cli dist/ws",
  JSON.stringify(pwList) === JSON.stringify(pwWant) && same,
  `${pwTgzName} (${pwSize} B packed): ${pwList.join(", ")}; identical to dist/ws: ${same}`);

const P = join(WORK, "perp-ws-consumer");
mkdirSync(P, { recursive: true });
writeFileSync(join(P, "package.json"), JSON.stringify({ name: "perp-ws-gate-consumer", private: true, type: "module" }));
run("perp-ws consumer: npm install the tarball alone", "npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", PWTGZ], { cwd: P });
const nm = readdirSync(join(P, "node_modules")).filter(n => !n.startsWith("."))
  .flatMap(n => (n.startsWith("@") ? readdirSync(join(P, "node_modules", n)).map(x => `${n}/${x}`) : [n]));
check("perp-ws consumer: 0 transitive dependencies (node_modules holds only @hypurrquant/perp-ws)",
  JSON.stringify(nm) === JSON.stringify(["@hypurrquant/perp-ws"]), `node_modules: ${nm.join(", ")}`);
writeFileSync(join(P, "no-ws.mjs"), `
const a = await import("@hypurrquant/perp-ws");
const b = await import("@hypurrquant/perp-ws/node");
for (const k of ["createVenueStream", "createFundingComparator", "toApr", "toHourly", "hyperliquid", "pacifica", "lighter", "lighterRh", "aster", "arcus"]) if (typeof a[k] === "undefined") throw new Error("missing export " + k);
for (const k of ["nodeTransport", "createNodeTransport", "DEFAULT_MAX_PAYLOAD"]) if (typeof b[k] === "undefined") throw new Error("missing node export " + k);
const okErr = (e) => e?.structured?.code === "INVALID_PARAMS" && String(e.structured.remediation).includes("npm install ws");
// Every way a consumer can obtain the /node transport must fail fast (never a reconnect loop).
let err = null;
try { b.createVenueStream(b.hyperliquid); } catch (e) { err = e; }
if (!okErr(err)) throw new Error("/node createVenueStream(hyperliquid): expected INVALID_PARAMS + npm install ws, got " + (err?.stack ?? err));
const paths = {
  "/node createVenueStream + { transport: nodeTransport }": () => b.createVenueStream(b.hyperliquid, { transport: b.nodeTransport }),
  "browser createVenueStream + { transport: nodeTransport }": () => a.createVenueStream(a.hyperliquid, { transport: b.nodeTransport }),
  "/node createVenueStream + wrapper around nodeTransport": () => b.createVenueStream(b.hyperliquid, { transport: (u) => b.nodeTransport(u) }),
  "createNodeTransport()": () => b.createNodeTransport(),
};
const seen = [];
for (const [name, mk] of Object.entries(paths)) {
  let s;
  try { s = mk(); } catch (e) { if (!okErr(e)) throw new Error(name + ": wrong error " + (e?.stack ?? e)); seen.push(name + " → throws INVALID_PARAMS"); continue; }
  const states = [];
  s.onState((st) => states.push(st.status));
  const r = await Promise.race([
    s.subscribe({ kind: "allMarkets", symbols: ["BTC"] }).ready.then(() => "ready", (e) => e),
    new Promise((res) => setTimeout(() => res("timeout"), 10_000)),
  ]);
  if (!okErr(r) || s.state.status !== "closed" || states.includes("reconnecting")) {
    throw new Error(name + ": expected ready to reject INVALID_PARAMS and the stream to close without reconnecting; got " + (r?.message ?? r) + " states " + states.join(">"));
  }
  seen.push(name + " → subscribe rejects INVALID_PARAMS, closed, no reconnect");
}
console.log("browser entry:", Object.keys(a).length, "exports; /node without ws:", err.structured.code, "-", err.message, "|", err.structured.remediation);
for (const x of seen) console.log("  " + x);
process.exit(0);
`);
const NODES = nodeMatrix();
const missingMajors = [20, 22, 24].filter(m => !NODES.some(n => n.major === m));
check(`perp-ws consumer: Node matrix ${NODES.map(n => n.version).join(", ")}`, NODES.length > 0,
  `${NODES.map(n => `${n.version} (${n.bin})`).join("; ")}${missingMajors.length > 0 ? `; skipped (not installed): Node ${missingMajors.join(", ")}` : ""}`);
for (const n of NODES) run(`perp-ws consumer [${n.version}]: imports; /node without ws → INVALID_PARAMS on every transport path (incl. subscribe)`, n.bin, ["no-ws.mjs"], { cwd: P });
run("perp-ws consumer: npm install ws + typescript (dev tools)", "npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "ws@^8.21.0", "typescript@5", "@types/node@20"], { cwd: P });
writeFileSync(join(P, "with-ws.mjs"), `
import { createVenueStream, hyperliquid } from "@hypurrquant/perp-ws/node";
const stream = createVenueStream(hyperliquid);
const sub = stream.subscribe({ kind: "allMarkets", symbols: ["BTC"] });
const first = new Promise((resolve) => sub.on((e) => { if (e.type === "market") resolve(e); }));
const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("no market event in 30 s")), 30_000));
const e = await Promise.race([sub.ready.then(() => first), timeout]);
console.log("live via /node + ws:", e.venue, e.symbol, "mark", e.mark, "rate", e.funding.rate, e.funding.rateKind);
await stream.close();
process.exit(0);
`);
for (const n of NODES) run(`perp-ws consumer [${n.version}]: /node with ws streams live (hyperliquid BTC)`, n.bin, ["with-ws.mjs"], { cwd: P, timeout: 120_000 });
writeFileSync(join(P, "consumer.ts"), `
import { createVenueStream, createFundingComparator, hyperliquid, toApr, type MarketUpdate, type UserUpdate } from "@hypurrquant/perp-ws";
import { createNodeTransport, nodeTransport } from "@hypurrquant/perp-ws/node";
const s = createVenueStream(hyperliquid, { transport: nodeTransport });
const t = createNodeTransport({ maxPayload: 1 << 20 });
const apr = (u: MarketUpdate): number | null => toApr(u.funding.rate, u.funding.rateIntervalHours);
const onUser = (u: UserUpdate): string => u.type;
void s; void t; void apr; void onUser; void createFundingComparator;
`);
for (const [mr, mod] of [["bundler", "esnext"], ["node16", "node16"], ["node10", "esnext"]]) {
  run(`perp-ws consumer: tsc moduleResolution=${mr}`, "npx", ["tsc", "--noEmit", "--strict", "--target", "es2020", "--lib", "es2020,dom", "--types", "node", "--module", mod, "--moduleResolution", mr, "consumer.ts"], { cwd: P });
}
const pwFiles = blocks.map((b, i) => { const f = `skill-block-${i + 1}.ts`; writeFileSync(join(P, f), `${b}\nexport {};\n`); return f; });
run(`perp-ws: typecheck ${pwFiles.length} skill ts code blocks as published (strict, noUncheckedIndexedAccess)`, "npx", ["tsc", "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--target", "es2022", "--lib", "es2022,dom", "--types", "node", "--module", "esnext", "--moduleResolution", "bundler", ...pwFiles], { cwd: P });
run("perp-ws: @arethetypeswrong/cli (esm-only profile)", "npx", ["-y", "@arethetypeswrong/cli@latest", PWTGZ, "--profile", "esm-only"], { cwd: WORK });

const EX2 = join(WORK, "examples-perp-ws");
cpSync(join(REPO, "examples/ws-funding-compare-browser"), join(EX2, "ws-funding-compare-browser"), { recursive: true });
cpSync(join(REPO, "examples/ws-next-smoke"), join(EX2, "ws-next-smoke"), { recursive: true });
const appJs = join(EX2, "ws-funding-compare-browser/app.js");
writeFileSync(appJs, readFileSync(appJs, "utf8").replaceAll('from "perp-cli/ws"', 'from "@hypurrquant/perp-ws"'));
const N2 = join(EX2, "ws-next-smoke");
const cfg = join(N2, "next.config.js");
writeFileSync(cfg, readFileSync(cfg, "utf8").replace('transpilePackages: ["perp-cli"]', 'transpilePackages: ["@hypurrquant/perp-ws"]'));
check("perp-ws next-smoke: app.js imports @hypurrquant/perp-ws, transpilePackages set",
  readFileSync(appJs, "utf8").includes('from "@hypurrquant/perp-ws"') && !/from\s*["']perp-cli\/ws/.test(readFileSync(appJs, "utf8")) && readFileSync(cfg, "utf8").includes('["@hypurrquant/perp-ws"]'),
  "examples copied; specifier and transpilePackages rewritten");
run("perp-ws next-smoke: npm install (next 13.5, react 18) + tarball", "npm", ["install", "--no-audit", "--no-fund", PWTGZ], { cwd: N2, timeout: 900_000 });
run("perp-ws next-smoke: next build (webpack, transpilePackages: [\"@hypurrquant/perp-ws\"])", "npx", ["next", "build"], { cwd: N2, timeout: 900_000 });
const chunksDir2 = join(N2, ".next/static/chunks");
let lib2 = null;
if (existsSync(chunksDir2)) {
  const walk = d => readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".js") ? [join(d, e.name)] : []));
  for (const f of walk(chunksDir2)) { const t = readFileSync(f, "utf8"); if (t.includes("connection refused before open")) { lib2 = { f, t }; break; } }
}
check("perp-ws next client chunk carries the library without Node-only references", lib2 !== null && !/require\(["']ws["']\)|["']node:|\bBuffer\.from\b|createRequire|__dirname/.test(lib2.t),
  lib2 === null ? "library code not found in .next/static/chunks" : `chunk ${lib2.f.slice(N2.length + 1)} (${lib2.t.length} B): no require("ws"), node:*, Buffer, createRequire, __dirname`);

// report
const pass = steps.every(s => s.code === 0);
const lines = [
  "# perp-cli/ws + @hypurrquant/perp-ws 0.15.0 — release gate",
  "",
  `Date: ${new Date().toISOString()}  ·  Node ${process.version}  ·  repo ${spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout.trim()} (+ working tree)  ·  tarballs ${tgz}, ${pwTgzName} (${pwSize} B)`,
  "",
  `perp-ws consumer Node matrix: ${NODES.map(n => n.version).join(", ")}${missingMajors.length > 0 ? ` (not installed, skipped: Node ${missingMajors.join(", ")})` : ""}`,
  "",
  `**Result: ${pass ? "PASS" : "FAIL"}** (${steps.filter(s => s.code === 0).length}/${steps.length} steps)`,
  "",
  "| # | Step | Result | Time |",
  "|---|---|---|---|",
  ...steps.map((s, i) => `| ${i + 1} | ${s.name} | ${s.code === 0 ? "PASS" : `FAIL (${s.code})`} | ${(s.ms / 1000).toFixed(1)} s |`),
  "",
  ...steps.flatMap((s, i) => [`## ${i + 1}. ${s.name}`, "", `\`${s.cmd}\`${s.cwd && s.cwd !== REPO ? ` (in ${s.cwd.replace(WORK, "$WORK")})` : ""}`, "", "```", tail(s.out.replaceAll(WORK, "$WORK")), "```", ""]),
];
mkdirSync(join(REPO, ".omc/research"), { recursive: true });
writeFileSync(OUT, lines.join("\n"));
console.log(`\n${pass ? "GATE PASS" : "GATE FAIL"} → ${OUT}`);
process.exit(pass ? 0 : 1);
