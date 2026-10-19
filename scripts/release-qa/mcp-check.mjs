// Live MCP checks of an INSTALLED perp-cli (perp-mcp over stdio, keyless env), adapted from the
// 0.15.0 live QA script qa-cli/mcp-call.mjs. Prints { checks: [{ id, ok, detail }] } on stdout:
// every read tool answers ok, and get_markets has the same row count as the CLI market list
// (conformance ids parity:get_markets:<venue>:count).
//   node mcp-check.mjs <path to installed perp-mcp js> <path to installed perp js>
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [, , MCP, CLI] = process.argv;
const env = {};
for (const [k, v] of Object.entries(process.env)) if (!/KEY|SECRET|PRIVATE|MNEMONIC|PASSPHRASE|TOKEN/i.test(k)) env[k] = v;
const checks = [];
const check = (id, failure) => checks.push({ id, ok: failure === null, detail: failure });

const t = new StdioClientTransport({ command: process.execPath, args: [MCP], env, stderr: "pipe" });
const c = new Client({ name: "release-qa", version: "1" });
await c.connect(t);
const call = async (name, args) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 180_000 });
  return JSON.parse((r.content ?? []).map(x => x.text ?? "").join(""));
};

const health = await call("health_check", {});
check("mcp:health_check:ok", health.ok ? null : JSON.stringify(health.error));
const venues = health.ok ? health.data.covered : [];
for (const v of venues) {
  const m = await call("get_markets", { exchange: v });
  const cli = spawnSync(process.execPath, [CLI, "--json", "-e", v, "market", "list"], { encoding: "utf8", env, maxBuffer: 64 << 20 });
  let rows = -1;
  try { const j = JSON.parse(cli.stdout); rows = j.ok && Array.isArray(j.data) ? j.data.length : -1; } catch { /* reported below */ }
  check(`mcp:get_markets:${v}:ok`, m.ok ? null : JSON.stringify(m.error).slice(0, 200));
  check(`parity:get_markets:${v}:count`, m.ok && rows >= 0 && m.data.length === rows ? null : `mcp ${m.ok ? m.data.length : "error"} rows, cli ${rows}`);
}
for (const [name, args] of [["get_funding_rates", { symbols: ["BTC", "ETH"] }], ["get_prices", { symbols: ["BTC", "ETH"] }]]) {
  const r = await call(name, args);
  check(`mcp:${name}:ok`, r.ok && (Array.isArray(r.data) ? r.data.length : r.data.symbols.length) > 0 ? null : JSON.stringify(r.error ?? "empty").slice(0, 200));
}
await c.close();
console.log(JSON.stringify({ checks }, null, 1));
