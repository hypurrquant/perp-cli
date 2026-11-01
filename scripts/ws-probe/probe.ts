/**
 * Phase 0 WS live probe (plan .omc/plans/ws-0.14.4.md §7 Phase 0). Node `ws`, sends an Origin header.
 *
 *   pnpm tsx scripts/ws-probe/probe.ts <scenario> --out <dir> [--secs n]
 *
 * Scenarios:
 *   origin                 open every venue socket with Origin https://trade.hypurrquant.com, with none,
 *                          and with https://evil.example; record accept / reject; close at once
 *   public:<venue>         public market + bbo channels, app ping at +5 s
 *   idle:<venue>           open, send nothing, record the close (code, seconds) — max --secs
 *   errors                 one invalid subscribe per venue (records the error frame shape)
 *   private:<venue>        READ-ONLY user channels of the `main` wallet, then fill unsubscribe/resubscribe
 *                          and a second connection (fill replay)
 *
 * READ-ONLY: only subscribe / unsubscribe / ping frames are ever sent. No orders, cancels or transfers.
 * Raw captures (JSONL) go to --out, which must be OUTSIDE the repository: they hold real public ids.
 * Fixtures are produced from them by make-fixtures.ts (anonymized). Outbound `auth` values are never
 * recorded. Not part of the CLI build.
 */
import WebSocket from "ws";
import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { resolveRealIds, type RealIds } from "./ids.js";

const ORIGIN = "https://trade.hypurrquant.com";
const REPO = resolve(import.meta.dirname, "../..");

const URLS = {
  hyperliquid: "wss://api.hyperliquid.xyz/ws",
  pacifica: "wss://ws.pacifica.fi/ws",
  lighter: "wss://mainnet.zklighter.elliot.ai/stream?readonly=true",
  "lighter-rh": "wss://api.rh.lighter.xyz/stream?readonly=true",
  aster: "wss://fstream.asterdex.com/ws",
  arcus: "wss://api.arcus.xyz/v1/ws",
} as const;
type Venue = keyof typeof URLS;

const args = process.argv.slice(2);
const scenario = args[0] ?? "";
const outIdx = args.indexOf("--out");
const OUT = outIdx > 0 ? resolve(args[outIdx + 1] ?? "") : "";
const secsIdx = args.indexOf("--secs");
const SECS = secsIdx > 0 ? Number(args[secsIdx + 1]) : 30;
if (!OUT) throw new Error("--out <dir> is required");
if (OUT.startsWith(REPO)) throw new Error("--out must be outside the repository (raw captures hold real ids)");
mkdirSync(OUT, { recursive: true });

const T0 = Date.now();
function stripAuth(s: string): string {
  return s.replace(/"auth"\s*:\s*"[^"]*"/g, '"auth":"<redacted>"');
}
function rec(file: string, dir: "in" | "out" | "event", data: unknown): void {
  const line = JSON.stringify({ t: Date.now() - T0, at: Date.now(), dir, data });
  appendFileSync(resolve(OUT, file), stripAuth(line) + "\n");
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Conn { ws: WebSocket; send(o: unknown): void; closed: Promise<{ code: number; reason: string }> }

function open(url: string, file: string, origin: string | null = ORIGIN): Promise<Conn> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : {});
    let closedRes: (v: { code: number; reason: string }) => void = () => {};
    const closed = new Promise<{ code: number; reason: string }>(r => { closedRes = r; });
    ws.on("unexpected-response", (_req, resp) => {
      rec(file, "event", { kind: "unexpected-response", status: resp.statusCode, headers: resp.headers });
      rej(new Error(`HTTP ${resp.statusCode}`));
    });
    ws.on("error", e => { rec(file, "event", { kind: "error", message: String(e.message) }); rej(e); });
    ws.on("ping", d => rec(file, "event", { kind: "server-ping", data: d.toString() }));
    ws.on("pong", d => rec(file, "event", { kind: "server-pong", data: d.toString() }));
    ws.on("message", raw => {
      const s = raw.toString();
      let data: unknown = s;
      try { data = JSON.parse(s); } catch { /* keep raw text */ }
      rec(file, "in", data);
    });
    ws.on("close", (code, reason) => {
      rec(file, "event", { kind: "close", code, reason: reason.toString() });
      closedRes({ code, reason: reason.toString() });
    });
    ws.on("open", () => {
      rec(file, "event", { kind: "open", url, origin });
      res({
        ws,
        send(o: unknown) { const s = JSON.stringify(o); rec(file, "out", JSON.parse(stripAuth(s))); ws.send(s); },
        closed,
      });
    });
  });
}

// ── origin ──
async function originProbe(): Promise<void> {
  for (const [venue, url] of Object.entries(URLS)) {
    for (const origin of [ORIGIN, null, "https://evil.example"]) {
      const file = "origin.jsonl";
      try {
        const c = await open(url, file, origin);
        rec(file, "event", { kind: "result", venue, origin, accepted: true });
        c.ws.close(1000);
        await c.closed;
      } catch (e) {
        rec(file, "event", { kind: "result", venue, origin, accepted: false, error: String((e as Error).message) });
      }
      await sleep(400);
    }
  }
}

// ── public ──
async function publicProbe(venue: Venue): Promise<void> {
  const file = `public-${venue}.jsonl`;
  if (venue === "aster") {
    const url = "wss://fstream.asterdex.com/stream?streams=!markPrice@arr@1s/!ticker@arr/btcusdt@bookTicker";
    await open(url, file);
    await sleep(SECS * 1000);
    process.exit(0);
  }
  const c = await open(URLS[venue], file);
  switch (venue) {
    case "hyperliquid":
      c.send({ method: "subscribe", subscription: { type: "allDexsAssetCtxs" } });
      c.send({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: "BTC" } });
      c.send({ method: "subscribe", subscription: { type: "activeAssetCtx", coin: "xyz:XYZ100" } });
      c.send({ method: "subscribe", subscription: { type: "bbo", coin: "BTC" } });
      c.send({ method: "subscribe", subscription: { type: "bbo", coin: "xyz:XYZ100" } });
      break;
    case "pacifica":
      c.send({ method: "subscribe", params: { source: "prices" } });
      c.send({ method: "subscribe", params: { source: "bbo", symbol: "BTC" } });
      break;
    case "lighter":
    case "lighter-rh":
      c.send({ type: "subscribe", channel: "market_stats/all" });
      c.send({ type: "subscribe", channel: "ticker/1" });
      break;
    case "arcus":
      c.send({ type: "subscribe", channel: "markets" });
      c.send({ type: "subscribe", channel: "bbo", id: "BTC-USD" });
      c.send({ type: "subscribe", channel: "oraclePrices" });
      c.send({ type: "subscribe", channel: "predictedFunding", id: "BTC-USD" });
      break;
  }
  await sleep(5000);
  sendAppPing(venue, c);
  await sleep(Math.max(0, SECS * 1000 - 5000));
  c.ws.close(1000);
  await c.closed;
}

function sendAppPing(venue: Venue, c: Conn): void {
  if (venue === "hyperliquid" || venue === "pacifica") c.send({ method: "ping" });
  else if (venue === "lighter" || venue === "lighter-rh") c.send({ type: "ping" });
  else if (venue === "arcus") { c.send({ type: "ping" }); c.ws.ping("probe"); }
}

// ── idle ──
async function idleProbe(venue: Venue): Promise<void> {
  const file = `idle-${venue}.jsonl`;
  const c = await open(URLS[venue], file);
  const timer = setTimeout(() => { rec(file, "event", { kind: "idle-max-reached", secs: SECS }); c.ws.close(1000); }, SECS * 1000);
  const r = await c.closed;
  clearTimeout(timer);
  rec(file, "event", { kind: "idle-result", closedAfterMs: Date.now() - T0, ...r });
}

// ── private (READ-ONLY) ──
async function lighterAuthToken(venue: "lighter" | "lighter-rh"): Promise<string | null> {
  // Same path as createLighterFamily (no-master branch): agent meta → keystore ("" passphrase) → WASM signer.
  const { getAgentForNetwork } = await import("../../src/agent-wallet/store.js");
  const { loadLighterFamilyKey } = await import("../../src/agent-wallet/lighter-keystore.js");
  const { LighterAdapter } = await import("../../src/exchanges/lighter.js");
  const meta = getAgentForNetwork(venue, "mainnet");
  if (!meta || typeof meta.accountIndex !== "number" || typeof meta.apiKeyIndex !== "number") return null;
  let key: string;
  try { key = loadLighterFamilyKey(venue, "mainnet", meta.accountIndex, meta.apiKeyIndex, ""); }
  catch { return null; } // would need a passphrase → skip (reported)
  const adapter = LighterAdapter.forVenue(venue, "", false);
  adapter.setAgentSigner(meta, key);
  if (meta.userEvmAddress) adapter.setAddress(meta.userEvmAddress);
  await adapter.init();
  return (adapter as unknown as { getAuthToken(): Promise<string> }).getAuthToken();
}

async function privateProbe(venue: Venue, ids: RealIds): Promise<void> {
  const file = `private-${venue}.jsonl`;
  const half = Math.max(8, Math.floor(SECS / 2)) * 1000;
  if (venue === "hyperliquid") {
    const user = ids.evm;
    const subs = [
      { type: "clearinghouseState", user },
      { type: "clearinghouseState", user, dex: "xyz" },
      { type: "openOrders", user },
      { type: "orderUpdates", user },
      { type: "userFills", user },
    ];
    const c = await open(URLS.hyperliquid, file);
    for (const s of subs) c.send({ method: "subscribe", subscription: s });
    await sleep(half);
    rec(file, "event", { kind: "marker", step: "fills-resubscribe-same-conn" });
    c.send({ method: "unsubscribe", subscription: { type: "userFills", user } });
    await sleep(1500);
    c.send({ method: "subscribe", subscription: { type: "userFills", user } });
    await sleep(4000);
    c.ws.close(1000); await c.closed;
    rec(file, "event", { kind: "marker", step: "fills-new-conn" });
    const c2 = await open(URLS.hyperliquid, file);
    c2.send({ method: "subscribe", subscription: { type: "userFills", user } });
    await sleep(4000);
    c2.ws.close(1000); await c2.closed;
  } else if (venue === "pacifica") {
    const account = ids.solana;
    const sources = ["account_info", "account_positions", "account_order_updates", "account_trades"];
    const c = await open(URLS.pacifica, file);
    for (const source of sources) c.send({ method: "subscribe", params: { source, account } });
    await sleep(half);
    rec(file, "event", { kind: "marker", step: "fills-resubscribe-same-conn" });
    c.send({ method: "unsubscribe", params: { source: "account_trades", account } });
    await sleep(1500);
    c.send({ method: "subscribe", params: { source: "account_trades", account } });
    await sleep(4000);
    c.ws.close(1000); await c.closed;
  } else if (venue === "lighter" || venue === "lighter-rh") {
    const idx = venue === "lighter" ? ids.lighterAccountIndex : ids.lighterRhAccountIndex;
    if (idx === null) { rec(file, "event", { kind: "skipped", reason: "no mainnet agent accountIndex" }); return; }
    const chans = [`user_stats/${idx}`, `account_all_positions/${idx}`, `account_all_trades/${idx}`, `account_all_orders/${idx}`];
    const c = await open(URLS[venue], file);
    rec(file, "event", { kind: "marker", step: "no-auth" });
    for (const channel of chans) c.send({ type: "subscribe", channel });
    await sleep(6000);
    const token = await lighterAuthToken(venue);
    if (token === null) {
      rec(file, "event", { kind: "skipped", reason: "auth token unavailable without passphrase / agent meta" });
    } else {
      rec(file, "event", { kind: "marker", step: "with-auth" });
      for (const channel of chans) c.send({ type: "unsubscribe", channel });
      await sleep(1500);
      for (const channel of chans) c.send({ type: "subscribe", channel, auth: token });
    }
    await sleep(half);
    rec(file, "event", { kind: "marker", step: "fills-resubscribe-same-conn" });
    c.send({ type: "unsubscribe", channel: `account_all_trades/${idx}` });
    await sleep(1500);
    c.send(token === null ? { type: "subscribe", channel: `account_all_trades/${idx}` } : { type: "subscribe", channel: `account_all_trades/${idx}`, auth: token });
    await sleep(4000);
    c.ws.close(1000); await c.closed;
  } else if (venue === "arcus") {
    const id = ids.arcusOwner ?? ids.evm;
    const c = await open(URLS.arcus, file);
    for (const channel of ["account", "positions", "orders", "userFills"]) c.send({ type: "subscribe", channel, id });
    await sleep(half);
    rec(file, "event", { kind: "marker", step: "fills-resubscribe-same-conn" });
    c.send({ type: "unsubscribe", channel: "userFills", id });
    await sleep(1500);
    c.send({ type: "subscribe", channel: "userFills", id });
    await sleep(4000);
    c.ws.close(1000); await c.closed;
  } else {
    throw new Error(`no private probe for ${venue}`);
  }
}

// ── errors: one invalid subscribe per venue, to record the error frame shape ──
async function errorsProbe(): Promise<void> {
  const bad: Record<Exclude<Venue, "aster">, unknown> = {
    hyperliquid: { method: "subscribe", subscription: { type: "bbo", coin: "NOPE_PROBE" } },
    pacifica: { method: "subscribe", params: { source: "bbo", symbol: "NOPE_PROBE" } },
    lighter: { type: "subscribe", channel: "ticker/999999" },
    "lighter-rh": { type: "subscribe", channel: "ticker/999999" },
    arcus: { type: "subscribe", channel: "bbo", id: "NOPE-PROBE" },
  };
  for (const [venue, msg] of Object.entries(bad)) {
    const c = await open(URLS[venue as Venue], "errors.jsonl");
    c.send(msg);
    await sleep(2500);
    c.ws.close(1000);
    await c.closed;
  }
  const a = await open("wss://fstream.asterdex.com/ws", "errors.jsonl");
  a.send({ method: "SUBSCRIBE", params: ["nopeprobe@bookTicker", "btcusdt@bookTicker"], id: 1 });
  await sleep(1500);
  a.send({ method: "LIST_SUBSCRIPTIONS", id: 2 });
  a.send({ method: "UNSUBSCRIBE", params: ["btcusdt@bookTicker"], id: 3 });
  await sleep(1500);
  a.ws.close(1000);
  await a.closed;
}

async function main(): Promise<void> {
  const [kind, venue] = scenario.split(":") as [string, Venue | undefined];
  if (kind === "origin") return originProbe();
  if (kind === "errors") return errorsProbe();
  if (!venue || !(venue in URLS)) throw new Error(`unknown venue in scenario "${scenario}"`);
  if (kind === "public") return publicProbe(venue);
  if (kind === "idle") return idleProbe(venue);
  if (kind === "private") return privateProbe(venue, resolveRealIds());
  throw new Error(`unknown scenario "${scenario}"`);
}

main().then(() => process.exit(0), e => { console.error(String((e as Error).message)); process.exit(1); });
