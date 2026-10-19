/**
 * Conformance harness: one runner for three modes (docs/TESTING.md §3).
 *
 *  - replay (default, `pnpm test`): global `fetch` and the `ws` WebSocket are replaced by a player
 *    that serves the recorded responses of src/__tests__/fixtures/conformance/<name>.json. A request
 *    that is not in the fixture fails the cell (never a silent fallback to the network).
 *  - live (`PERP_LIVE=1`, vitest.conformance.live.config.ts): the real network, read-only public
 *    endpoints only (the suite runs with an isolated HOME — no keys exist).
 *  - record (`PERP_RECORD=1`, scripts/conformance/record.ts): live, and every exchange is captured,
 *    trimmed + anonymized (fixture-tools.ts) and written as the fixture.
 *  - prune (`PERP_CONFORMANCE_PRUNE=1`, run by record.ts right after recording): replay, then
 *    rewrite the fixture with only the exchanges the replay used.
 *
 * The code under test is the REAL command / adapter / cache / limiter code: only the transport is
 * replaced. In replay the clock (Date only) starts at the fixture's capture time and advances in real
 * time, so "now"-relative requests and checks (kline windows, future candles) see the recorded now.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { collectIds, domainOf, guardFixtureText, PublicScrubber, symbolMatcher, trimResponse, type Json } from "./fixture-tools.js";

export type Mode = "replay" | "live" | "record" | "prune";
export const MODE: Mode = process.env.PERP_RECORD === "1" ? "record"
  : process.env.PERP_LIVE === "1" ? "live"
  : process.env.PERP_CONFORMANCE_PRUNE === "1" ? "prune"
  : "replay";
export const IS_LIVE = MODE === "live" || MODE === "record";

export const FIXTURE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "conformance");

/** Optional venue filter for record / live runs (comma-separated ids). */
export const VENUE_FILTER: ReadonlySet<string> | null = process.env.PERP_CONFORMANCE_VENUES
  ? new Set(process.env.PERP_CONFORMANCE_VENUES.split(",").map(s => s.trim()).filter(Boolean))
  : null;

export interface HttpExchange {
  cell: string;
  method: string;
  url: string;
  body: string | null;
  status: number;
  contentType: string | null;
  /** Parsed JSON body; null with `text` set when the body is not JSON. */
  response: Json;
  text: string | null;
}

export interface WsExchange {
  cell: string;
  url: string;
  sent: string[];
  frames: Json[];
}

export interface ConformanceFixture {
  schema: 1;
  /** Response bodies shared by several exchanges, by content hash (an exchange's response is {"$body": hash}). */
  bodies?: Record<string, Json>;
  name: string;
  capturedAt: number;
  recordedWith: string;
  keep: string[];
  /** Cells recorded whole (row-cap evidence: full page + next-page probes) — never pruned. */
  full?: string[];
  http: HttpExchange[];
  ws: WsExchange[];
}

/** Frames kept per recorded socket (trimmed to the keep-symbols afterwards). */
const WS_MAX_FRAMES = 2000;

/**
 * `<name>.json` (trimmed, indented for review) or `<name>.json.gz` (untrimmed full directories /
 * full server pages — compressed, they are MBs of JSON).
 */
export function fixturePath(name: string): string {
  const gz = join(FIXTURE_DIR, `${name}.json.gz`);
  return existsSync(gz) ? gz : join(FIXTURE_DIR, `${name}.json`);
}

export function hasFixture(name: string): boolean {
  return existsSync(fixturePath(name));
}

export function loadFixture(name: string): ConformanceFixture {
  const file = fixturePath(name);
  const raw = readFileSync(file);
  const f = JSON.parse((file.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8")) as ConformanceFixture;
  const bodies = f.bodies ?? {};
  const deref = (j: Json): Json => {
    const ref = j !== null && typeof j === "object" && !Array.isArray(j) ? (j as { $body?: unknown }).$body : undefined;
    if (typeof ref !== "string") return j;
    if (!(ref in bodies)) throw new Error(`conformance fixture ${name}: unknown body ${ref}`);
    return bodies[ref];
  };
  return { ...f, http: f.http.map(x => ({ ...x, response: deref(x.response) })) };
}

/** Bodies that occur more than once are stored once (fixture size). */
function dedupe(f: ConformanceFixture): ConformanceFixture {
  const count = new Map<string, number>();
  const texts = f.http.map(x => JSON.stringify(x.response));
  for (const t of texts) if (t.length > 200) count.set(t, (count.get(t) ?? 0) + 1);
  const bodies: Record<string, Json> = {};
  const http = f.http.map((x, i) => {
    const t = texts[i];
    if ((count.get(t) ?? 0) < 2) return x;
    const h = createHash("sha256").update(t).digest("hex").slice(0, 16);
    bodies[h] = x.response;
    return { ...x, response: { $body: h } };
  });
  const { bodies: _old, ...rest } = f;
  return Object.keys(bodies).length > 0 ? { ...rest, bodies, http } : { ...rest, http };
}

/** Timestamps (10–19 digit epochs, ISO-8601 UTC) differ between runs: matched as a placeholder. */
const norm = (s: string): string => s
  .replace(/\d{4}-\d{2}-\d{2}T\d{2}(?:%3A|:)\d{2}(?:%3A|:)\d{2}(?:\.\d+)?Z/g, "<t>")
  .replace(/(?<![0-9.])\d{10,19}(?![0-9])/g, "<n>");
const keyOf = (method: string, url: string, body: string | null): string => `${method.toUpperCase()} ${norm(url)}\n${norm(body ?? "")}`;

function requestParts(input: unknown, init?: { method?: string; body?: unknown }): { method: string; url: string; body: string | null } {
  let url: string;
  let method = init?.method ?? "GET";
  if (typeof input === "string") url = input;
  else if (input instanceof URL) url = input.toString();
  else if (input && typeof input === "object" && "url" in input) {
    url = String((input as { url: string }).url);
    method = init?.method ?? (input as { method?: string }).method ?? "GET";
  } else url = String(input);
  const b = init?.body;
  const body = b === undefined || b === null ? null : typeof b === "string" ? b : b instanceof URLSearchParams ? b.toString() : String(b);
  return { method: method.toUpperCase(), url, body };
}

type RealWsCtor = new (url: string, opts?: unknown) => {
  on(ev: string, cb: (...a: unknown[]) => void): unknown;
  send(d: string): void;
  close(): void;
};

/**
 * A recording / replaying session for one fixture. Activated globally (globalThis) so the `ws`
 * mock factory — evaluated in the module graph of the code under test — finds it.
 */
export class Session {
  readonly name: string;
  readonly keep: string[];
  readonly fixture: ConformanceFixture | null;
  readonly capturedAt: number;
  private cell = "";
  private http: HttpExchange[] = [];
  private ws: WsExchange[] = [];
  private usedHttp = new Set<number>();
  private usedWs = new Set<number>();
  readonly misses: string[] = [];
  private realFetch: typeof fetch = globalThis.fetch.bind(globalThis);

  /**
   * trim: false keeps every response whole (still anonymized and pruned) — for fixtures whose point
   * is the FULL set (directory parity, eligibility) or a full server page (row caps).
   */
  readonly trim: boolean;

  constructor(name: string, keep: string[], opts: { trim?: boolean } = {}) {
    this.name = name;
    this.keep = keep;
    this.trim = opts.trim ?? true;
    if (MODE === "replay" || MODE === "prune") {
      if (!hasFixture(name)) throw new Error(`no conformance fixture "${name}" — record it: pnpm conformance:record --venue ${name}`);
      this.fixture = loadFixture(name);
      this.capturedAt = this.fixture.capturedAt;
    } else {
      this.fixture = null;
      this.capturedAt = Date.now();
    }
  }

  /** Install: fetch stub, Date clock (replay), cache dir reset, global handle for the ws mock. */
  start(): void {
    (globalThis as { __perpConformance?: Session }).__perpConformance = this;
    rmSync(join(tmpdir(), "perp-cli-cache"), { recursive: true, force: true });
    if (!IS_LIVE) vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true, now: this.capturedAt });
    vi.stubGlobal("fetch", (input: unknown, init?: { method?: string; body?: unknown }) => this.fetch(input, init));
  }

  stop(): void {
    vi.unstubAllGlobals();
    if (!IS_LIVE) vi.useRealTimers();
    delete (globalThis as { __perpConformance?: Session }).__perpConformance;
  }

  /** Requests (HTTP + WebSocket) issued per cell — "refused before any I/O" checks read it. */
  readonly calls = new Map<string, number>();
  private untrimmed = new Set<string>();

  /** Start a cell. `full`: keep this cell's responses whole (a full server page at a row cap). */
  begin(cell: string, opts: { full?: boolean } = {}): void {
    this.cell = cell;
    if (opts.full === true) this.untrimmed.add(cell);
    if (process.env.PERP_CONFORMANCE_DEBUG === "1") process.stderr.write(`[conformance] ${this.name} ${cell} @${new Date().toISOString()}\n`);
  }

  /** Current "now" of the session (capture time in replay, the clock in live). */
  now(): number {
    return Date.now();
  }

  private async fetch(input: unknown, init?: { method?: string; body?: unknown }): Promise<Response> {
    const req = requestParts(input, init);
    this.calls.set(this.cell, (this.calls.get(this.cell) ?? 0) + 1);
    if (process.env.PERP_CONFORMANCE_DEBUG === "1") process.stderr.write(`[conformance]   ${req.method} ${req.url}\n`);
    if (IS_LIVE) {
      const res = await this.realFetch(input as string, init as RequestInit);
      if (MODE === "record") {
        const text = await res.clone().text();
        let response: Json = null;
        let rawText: string | null = null;
        try { response = JSON.parse(text) as Json; } catch { rawText = text; }
        this.http.push({ cell: this.cell, ...req, status: res.status, contentType: res.headers.get("content-type"), response, text: rawText });
      }
      return res;
    }
    const all = this.fixture!.http;
    const key = keyOf(req.method, req.url, req.body);
    const same = (x: HttpExchange) => keyOf(x.method, x.url, x.body) === key;
    let idx = all.findIndex((x, i) => !this.usedHttp.has(i) && x.cell === this.cell && same(x));
    if (idx < 0) idx = all.findIndex((x, i) => !this.usedHttp.has(i) && same(x));
    if (idx < 0) idx = all.findIndex(same);
    if (idx < 0) {
      this.misses.push(`${this.cell}: ${req.method} ${req.url}${req.body ? ` ${req.body.slice(0, 200)}` : ""}`);
      throw new Error(`conformance replay: request not in fixture "${this.name}" (cell ${this.cell}): ${req.method} ${req.url} — re-record: pnpm conformance:record --venue ${this.name}`);
    }
    this.usedHttp.add(idx);
    const x = all[idx];
    const body = x.text !== null ? x.text : JSON.stringify(x.response);
    return new Response(x.status === 204 ? null : body, { status: x.status, headers: x.contentType ? { "content-type": x.contentType } : {} });
  }

  /**
   * The `ws` WebSocket class for the code under test: live → the real socket, with its sent and
   * received frames captured (record); replay → an EventEmitter that answers each send() with the
   * recorded frames of that socket.
   */
  wrapWs(Real: RealWsCtor): RealWsCtor {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const session = this;
    if (IS_LIVE) {
      return function RecordingWs(url: string, opts?: unknown) {
        session.calls.set(session.cell, (session.calls.get(session.cell) ?? 0) + 1);
        const ws = new Real(url, opts) as InstanceType<RealWsCtor> & { send(d: unknown, ...rest: unknown[]): void };
        const rec: WsExchange = { cell: session.cell, url, sent: [], frames: [] };
        if (MODE === "record") session.ws.push(rec);
        ws.on("message", (d: unknown) => {
          if (rec.frames.length >= WS_MAX_FRAMES) return;
          try { rec.frames.push(JSON.parse(String(d)) as Json); } catch { /* non-JSON frame */ }
        });
        const send = ws.send.bind(ws);
        ws.send = (d: unknown, ...rest: unknown[]) => { rec.sent.push(String(d)); send(d, ...rest); };
        return ws;
      } as unknown as RealWsCtor;
    }
    return class ReplayWs extends EventEmitter {
      readyState = 0;
      private rec: WsExchange | null;
      private replayed = false;
      constructor(url: string) {
        super();
        session.calls.set(session.cell, (session.calls.get(session.cell) ?? 0) + 1);
        const all = session.fixture!.ws;
        let idx = all.findIndex((x, i) => !session.usedWs.has(i) && x.cell === session.cell && norm(x.url) === norm(url));
        if (idx < 0) idx = all.findIndex(x => norm(x.url) === norm(url));
        this.rec = idx >= 0 ? all[idx] : null;
        if (idx >= 0) session.usedWs.add(idx);
        else session.misses.push(`${session.cell}: WS ${url}`);
        setTimeout(() => {
          if (this.rec === null) { this.emit("error", new Error(`conformance replay: WebSocket ${url} not in fixture "${session.name}"`)); return; }
          this.readyState = 1;
          this.emit("open");
          // A socket that never sends (push-only feed) gets its frames right after open.
          if (this.rec.sent.length === 0) this.replay();
        }, 0);
      }
      private replay() {
        if (this.replayed || this.rec === null) return;
        this.replayed = true;
        const frames = this.rec.frames;
        setTimeout(() => { for (const f of frames) if (this.readyState === 1) this.emit("message", Buffer.from(JSON.stringify(f)), false); }, 0);
      }
      send(_d: unknown) { this.replay(); }
      ping() { /* keep-alive: nothing to replay */ }
      close() {
        if (this.readyState >= 2) return;
        this.readyState = 3;
        setTimeout(() => this.emit("close", 1000, Buffer.from("")), 0);
      }
      terminate() { this.close(); }
    } as unknown as RealWsCtor;
  }

  /** The last HTTP exchange recorded in `cell` whose URL contains `needle` (record mode). */
  lastHttp(cell: string, needle: string): HttpExchange | null {
    for (let i = this.http.length - 1; i >= 0; i--) if (this.http[i].cell === cell && (this.http[i].url + (this.http[i].body ?? "")).includes(needle)) return this.http[i];
    return null;
  }

  /** A WebSocket opened directly by the test (perp-cli/ws transport): record mode logs it. */
  wsRecord(url: string): WsExchange {
    const rec: WsExchange = { cell: this.cell, url, sent: [], frames: [] };
    if (MODE === "record") this.ws.push(rec);
    return rec;
  }

  /** The recorded socket for `url` in the current cell (replay); null = not recorded. */
  wsReplay(url: string): WsExchange | null {
    const all = this.fixture?.ws ?? [];
    const idx = all.findIndex((x, i) => !this.usedWs.has(i) && x.cell === this.cell && norm(x.url) === norm(url));
    if (idx < 0) { this.misses.push(`${this.cell}: WS ${url}`); return null; }
    this.usedWs.add(idx);
    return all[idx];
  }

  /** record: trim + scrub + write the fixture. prune: rewrite with the used exchanges only. */
  finalize(): void {
    if (MODE === "record") {
      const ids = new Map<string, Set<string>>();
      const match = symbolMatcher(this.keep);
      const idsFor = (url: string) => {
        const d = domainOf(url.replace(/^ws/, "http"));
        if (!ids.has(d)) ids.set(d, new Set());
        return ids.get(d)!;
      };
      for (const x of this.http) collectIds(x.response, match, idsFor(x.url));
      for (const w of this.ws) for (const f of w.frames) collectIds(f, match, idsFor(w.url));
      const scrub = new PublicScrubber();
      const http = this.http.map(x => ({
        ...x,
        response: scrub.walk(this.trim && !this.untrimmed.has(x.cell) ? trimResponse(x.response, this.keep, idsFor(x.url)) : x.response) ?? null,
        text: x.text !== null && x.text.length > 2000 ? x.text.slice(0, 2000) : x.text,
      }));
      const ws = this.ws.map(w => ({ ...w, frames: (scrub.walk(this.trim ? trimResponse(w.frames, this.keep, idsFor(w.url)) : w.frames) ?? []) as Json[] }));
      // capturedAt = END of the recording: replay's clock never runs behind a recorded response.
      this.write({ schema: 1, name: this.name, capturedAt: Date.now(), recordedWith: "scripts/conformance/record.ts (live public mainnet, read-only)", keep: this.trim ? this.keep : [], full: [...this.untrimmed], http, ws });
    } else if (MODE === "prune" && this.fixture !== null) {
      const full = new Set(this.fixture.full ?? []);
      const http = this.fixture.http.filter((x, i) => this.usedHttp.has(i) || full.has(x.cell));
      const ws = this.fixture.ws.filter((_, i) => this.usedWs.has(i));
      this.write({ ...this.fixture, http, ws });
    }
  }

  private write(f: ConformanceFixture): void {
    // Untrimmed fixtures (full directories / full pages) are written compact + gzipped; trimmed ones
    // as indented JSON for review.
    const whole = !this.trim || (f.full ?? []).length > 0;
    const plain = join(FIXTURE_DIR, `${this.name}.json`);
    const file = whole ? `${plain}.gz` : plain;
    const text = JSON.stringify(dedupe(f), null, whole ? undefined : 1) + "\n";
    guardFixtureText(text, file);
    mkdirSync(FIXTURE_DIR, { recursive: true });
    rmSync(whole ? plain : `${plain}.gz`, { force: true });
    writeFileSync(file, whole ? gzipSync(text, { level: 9 }) : text);
  }
}

/** The active session, for the `ws` mock factory: `vi.mock("ws", wsMockFactory)`. */
export function activeSession(): Session {
  const s = (globalThis as { __perpConformance?: Session }).__perpConformance;
  if (s === undefined) throw new Error("conformance: no active session (WebSocket opened outside a cell)");
  return s;
}

// ── CLI runner ──

export interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; remediation?: string; [k: string]: unknown };
  meta?: Record<string, unknown>;
}

export interface CliRun {
  argv: string[];
  envelope: Envelope;
  /** Number of JSON documents printed on stdout (must be exactly 1 in --json mode). */
  docs: number;
  stderr: string;
}

/** Parse every top-level JSON document printed on stdout. */
function parseDocs(out: string): unknown[] {
  const docs: unknown[] = [];
  let i = 0;
  while (i < out.length) {
    const start = out.indexOf("{", i);
    if (start < 0) break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = start; j < out.length; j++) {
      const c = out[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === "\"") inStr = false;
        continue;
      }
      if (c === "\"") inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) { end = j; break; }
    }
    if (end < 0) break;
    docs.push(JSON.parse(out.slice(start, end + 1)));
    i = end + 1;
  }
  return docs;
}

/**
 * PERP_CONFORMANCE_BIN=<path to an installed perp bin> (live mode only): run the PUBLISHED package
 * as a child process instead of the in-repo command tree — scripts/release-qa/run.mjs uses it to
 * hold the npm tarball to the same contracts.
 */
export const CLI_BIN: string | null = process.env.PERP_CONFORMANCE_BIN ?? null;
if (CLI_BIN !== null && !IS_LIVE) throw new Error("PERP_CONFORMANCE_BIN needs PERP_LIVE=1 (a child process cannot be replayed)");

async function runBin(argv: string[]): Promise<CliRun> {
  const { spawn } = await import("node:child_process");
  const full = ["--json", ...argv];
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI_BIN as string, ...full], { env: { ...process.env, NO_COLOR: "1" } });
    let out = "";
    let err = "";
    child.stdout.on("data", d => { out += String(d); });
    child.stderr.on("data", d => { err += String(d); });
    child.on("close", () => {
      const docs = parseDocs(out);
      const envelope = (docs[0] as Envelope | undefined) ?? { ok: false, error: { code: "NO_OUTPUT", message: `no JSON document; stderr: ${err.slice(0, 500)}` } };
      resolve({ argv, envelope, docs: docs.length, stderr: err });
    });
  });
}

/** Run `perp --json <argv>` in-process through the real command tree (src/cli-program.ts). */
export async function runCli(argv: string[]): Promise<CliRun> {
  if (CLI_BIN !== null) return runBin(argv);
  const { buildProgram } = await import("../../cli-program.js");
  const { PerpError } = await import("../../errors.js");
  const out: string[] = [];
  const err: string[] = [];
  const savedArgv = process.argv;
  const full = ["--json", ...argv];
  process.argv = ["node", "perp", ...full];
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(" ") + "\n"); }),
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(" ")); }),
    vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => { err.push(a.map(String).join(" ")); }),
    vi.spyOn(process.stdout, "write").mockImplementation(((m: unknown) => { out.push(String(m)); return true; }) as never),
    vi.spyOn(process.stderr, "write").mockImplementation(((m: unknown) => { err.push(String(m)); return true; }) as never),
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw Object.assign(new Error("__exit__"), { exitCode: code }); }) as never),
  ];
  let thrown: Envelope | null = null;
  try {
    const { program } = buildProgram({ defaultExchange: "hyperliquid", version: "conformance" });
    program.exitOverride();
    await program.parseAsync(["node", "perp", ...full]);
  } catch (e) {
    if (e instanceof PerpError) thrown = { ok: false, error: e.structured as unknown as Envelope["error"] };
    else if ((e as Error).message !== "__exit__") thrown = { ok: false, error: { code: "THROWN", message: e instanceof Error ? e.message : String(e) } };
  } finally {
    for (const s of spies) s.mockRestore();
    process.argv = savedArgv;
    process.exitCode = undefined;
  }
  const docs = parseDocs(out.join(""));
  const envelope = (docs[0] as Envelope | undefined) ?? thrown ?? { ok: false, error: { code: "NO_OUTPUT", message: `no JSON document; stderr: ${err.join("").slice(0, 500)}` } };
  return { argv, envelope, docs: docs.length + (docs.length === 0 && thrown !== null ? 1 : 0), stderr: err.join("") };
}
