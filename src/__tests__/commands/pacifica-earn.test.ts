/**
 * `perp print …` / `perp vault …` end to end with a stubbed fetch (no network, a throwaway key):
 *  - --dry-run prints the exact canonical message + body, signs nothing and POSTs nothing;
 *  - reads never POST (no signing on read paths);
 *  - unknown send outcome (timeout / 5xx / 409 / ambiguous 2xx) → ORDER_PENDING, sent once, never retried;
 *  - venue 4xx refusal → ACTION_REJECTED; success → address / shares in the result;
 *  - --account plans without a key and is refused on a live write; -e <other venue> is refused.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { addRootSafetyOptions, installDryRunGuard } from "../../cli-flags.js";
import { registerPacificaEarnCommands } from "../../commands/pacifica-earn.js";
import { PacificaAdapter } from "../../exchanges/pacifica.js";
import { PerpError } from "../../errors.js";

const FX = resolve(__dirname, "../fixtures/pacifica-earn");
const fixture = (n: string): unknown => JSON.parse(readFileSync(resolve(FX, n), "utf8"));
const env = (data: unknown) => ({ success: true, data, error: null, code: null });

const KP = Keypair.generate();
const ACCOUNT = KP.publicKey.toBase58();
const HATCH = "9GN1GztuBJWWRC1q39P4fFtiN341ZbqC5FNXkL1MAxUh";

type PostReply = () => Response | Promise<Response>;
let postReply: PostReply;
let posts: Array<{ path: string; body: Record<string, unknown> }>;
let out: string[];

function json(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function lakeListWithShares(): unknown {
  const l = fixture("lake-list.json") as { data: { lakes: Record<string, unknown>[] } };
  return { ...l, data: { lakes: l.data.lakes.map((x) => (x.address === HATCH ? { ...x, user_share: "100" } : x)) } };
}

beforeEach(() => {
  posts = [];
  out = [];
  postReply = () => json(200, env({ game_account_address: "NewPrint1111111111111111111111111111111111" }));
  vi.spyOn(console, "log").mockImplementation((s: unknown) => { out.push(String(s)); });
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v1/, "");
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
      return postReply();
    }
    switch (path) {
      case "/game/config": return json(200, fixture("game-config.json"));
      case "/game/accounts": return json(200, fixture("game-accounts.json"));
      case "/info/prices": return json(200, env([{ symbol: "BTC", mark: "70000" }]));
      case "/info": return json(200, env([{ symbol: "BTC", tick_size: "1" }]));
      case "/account": return json(200, env({ available_to_withdraw: "1000", account_equity: "1000" }));
      case "/positions": return json(200, env([]));
      case "/lake/list": return json(200, lakeListWithShares());
      case "/lake/get_deposit_whitelist": return json(200, fixture("lake-deposit-whitelist.json"));
      default: throw new Error(`unexpected GET ${path}`);
    }
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function run(argv: string[]): Promise<{ data?: Record<string, unknown>; error?: PerpError }> {
  const prog = addRootSafetyOptions(new Command());
  prog.exitOverride();
  prog.option("-e, --exchange <venue>", "venue", "hyperliquid").option("--json");
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const adapter = new PacificaAdapter(KP, "mainnet", true);
  registerPacificaEarnCommands(prog, async () => adapter, () => true);
  installDryRunGuard(prog);
  try {
    await prog.parseAsync(["node", "perp", ...argv]);
  } catch (e) {
    if (e instanceof PerpError) return { error: e };
    throw e;
  }
  const last = out.at(-1);
  return last === undefined ? {} : { data: (JSON.parse(last) as { data: Record<string, unknown> }).data };
}

const DEPOSIT = ["print", "deposit", "BTC_24H", "long", "100", "--strike", "69000", "--leverage", "10", "--cycles", "7"];

describe("print deposit", () => {
  it("--dry-run: exact message + body, nothing signed or sent", async () => {
    const r = await run(["--dry-run", ...DEPOSIT]);
    expect(posts).toHaveLength(0);
    const req = r.data?.request as { signedMessage: string; body: Record<string, unknown>; signer: string; path: string };
    expect(r.data).toMatchObject({ dryRun: true, sent: false, plan: { leverage: "10", cycles: 7, maxLoss: "100", docsLiquidationPrice: "62100" } });
    expect(req.path).toBe("POST /api/v1/game/deposit");
    expect(req.signer).toBe("pk");
    expect(req.body).toMatchObject({ account: ACCOUNT, game: "BTC_24H", deposit_amount: "100", direction: 0, strike_price: "69000", leverage: "10", total_segments: 7, signature: null });
    const msg = JSON.parse(req.signedMessage) as { type: string; data: Record<string, unknown>; timestamp: number };
    expect(msg.type).toBe("deposit_to_game");
    expect(msg.timestamp).toBe(req.body.timestamp);
    expect(msg.data.idempotency_key).toBe(req.body.idempotency_key);
  });

  it("--dry-run --account: plans for any address without loading a key", async () => {
    const r = await run(["--dry-run", ...DEPOSIT, "--account", HATCH]);
    expect((r.data?.request as { signer: string; body: { account: string } })).toMatchObject({ signer: "not loaded (--account plan)", body: { account: HATCH } });
  });

  it("--account on a live write is refused before anything is sent", async () => {
    const r = await run([...DEPOSIT, "--account", HATCH]);
    expect(r.error?.structured.code).toBe("INVALID_PARAMS");
    expect(posts).toHaveLength(0);
  });

  it("live: one signed POST whose signature verifies; returns the Print address", async () => {
    const r = await run(DEPOSIT);
    expect(posts).toHaveLength(1);
    const body = posts[0].body;
    expect(r.data).toMatchObject({ placed: true, printAddress: "NewPrint1111111111111111111111111111111111", idempotencyKey: body.idempotency_key });
    const { signature, account, agent_wallet: _a, ...rest } = body as Record<string, unknown>;
    const { timestamp, expiry_window, ...payload } = rest;
    const message = JSON.stringify({ data: Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))), expiry_window, timestamp, type: "deposit_to_game" });
    expect(account).toBe(ACCOUNT);
    expect(nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(signature as string), KP.publicKey.toBytes())).toBe(true);
  });

  it.each([
    ["timeout", () => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); }],
    ["HTTP 500", () => json(500, "internal")],
    ["HTTP 409 duplicate idempotency key", () => json(409, { success: false, error: "Duplicate idempotency key", code: 409 })],
    ["2xx without data", () => json(200, { success: true, data: null })],
    ["unreadable 2xx", () => new Response("<html>", { status: 200 })],
  ])("unknown outcome (%s) → ORDER_PENDING, sent exactly once, remediation says do not resubmit", async (_n, reply) => {
    postReply = reply as PostReply;
    const r = await run(DEPOSIT);
    expect(r.error?.structured.code).toBe("ORDER_PENDING");
    expect(r.error?.structured.remediation).toMatch(/Do NOT resubmit.*print positions/);
    expect(r.error?.structured.details?.idempotencyKey).toBe(posts[0].body.idempotency_key);
    expect(posts).toHaveLength(1);
  });

  it("venue 4xx refusal → ACTION_REJECTED (nothing executed); 429 → RATE_LIMITED", async () => {
    postReply = () => json(400, { success: false, data: null, error: "total_segments must be between 1 and 1000", code: 400 });
    const r = await run(DEPOSIT);
    expect(r.error?.structured).toMatchObject({ code: "ACTION_REJECTED", message: expect.stringMatching(/total_segments must be between 1 and 1000/) });
    postReply = () => json(429, { success: false, error: "rate limited" });
    expect((await run(DEPOSIT)).error?.structured.code).toBe("RATE_LIMITED");
  });

  it("validation refuses before anything is sent (and in --dry-run too)", async () => {
    for (const argv of [
      ["print", "deposit", "BTC_24H", "long", "9", "--strike", "69000", "--leverage", "10"],
      ["print", "deposit", "BTC_24H", "long", "100", "--strike", "71000", "--leverage", "10"],
      ["--dry-run", "print", "deposit", "BTC_24H", "long", "100", "--strike", "69000", "--leverage", "41"],
      ["--dry-run", "print", "deposit", "BTC_24H", "long", "2000", "--strike", "69000", "--leverage", "10"],
    ]) {
      const r = await run(argv);
      expect(["INVALID_PARAMS", "INSUFFICIENT_BALANCE"]).toContain(r.error?.structured.code);
    }
    expect(posts).toHaveLength(0);
  });
});

describe("print reads never sign or POST", () => {
  it.each([
    [["print", "games"]],
    [["print", "quote", "BTC_24H", "short", "50", "--strike", "71000", "--leverage", "5"]],
    [["print", "positions"]],
    [["print", "positions", "--account", HATCH]],
  ])("%j", async (argv) => {
    const r = await run(argv as string[]);
    expect(r.error).toBeUndefined();
    expect(posts).toHaveLength(0);
  });
});

describe("print cancel", () => {
  it("refuses an order that is already cancelling (fixture) — nothing sent", async () => {
    const accounts = fixture("game-accounts.json") as { data: { game_accounts: Array<{ address: string }> } };
    const r = await run(["print", "cancel", accounts.data.game_accounts[0].address]);
    expect(r.error?.structured.code).toBe("INVALID_PARAMS");
    expect(posts).toHaveLength(0);
  });
});

describe("vault", () => {
  it("deposit --dry-run: deposit_to_lake body for the own account, nothing sent", async () => {
    const r = await run(["--dry-run", "vault", "deposit", "The Hatch", "25"]);
    expect(posts).toHaveLength(0);
    expect(r.data?.request).toMatchObject({ type: "deposit_to_lake", body: { account: ACCOUNT, lake: HATCH, amount: "25", signature: null } });
  });

  it("withdraw --all --dry-run: redeems the held shares to the own account", async () => {
    const r = await run(["--dry-run", "vault", "withdraw", HATCH, "--all"]);
    expect(r.data).toMatchObject({ plan: { shares: "100", destination: ACCOUNT, role: "lp" }, request: { type: "withdraw_from_lake", body: { account: ACCOUNT, lake: HATCH, shares: "100" } } });
    expect(posts).toHaveLength(0);
  });

  it("withdraw: more than held → refused; neither shares nor --all → INVALID_PARAMS", async () => {
    expect((await run(["vault", "withdraw", HATCH, "100.5"])).error?.structured.code).toBe("SIZE_TOO_LARGE");
    expect((await run(["vault", "withdraw", HATCH])).error?.structured.code).toBe("INVALID_PARAMS");
    expect(posts).toHaveLength(0);
  });

  it("live withdraw: unknown outcome → ORDER_PENDING once; success → amount_withdrawn", async () => {
    postReply = () => { throw new Error("socket hang up"); };
    expect((await run(["vault", "withdraw", HATCH, "10"])).error?.structured.code).toBe("ORDER_PENDING");
    expect(posts).toHaveLength(1);
    postReply = () => json(200, env({ amount_withdrawn: "12.31" }));
    const r = await run(["vault", "withdraw", HATCH, "10"]);
    expect(r.data).toMatchObject({ withdrawn: true, amountWithdrawn: "12.31", destination: ACCOUNT });
    expect(posts[1]).toMatchObject({ path: "/lake/withdraw", body: { account: ACCOUNT, lake: HATCH, shares: "10" } });
  });

  it("list / info / positions never POST", async () => {
    for (const argv of [["vault", "list"], ["vault", "info", "The Hatch"], ["vault", "positions"]]) {
      expect((await run(argv)).error).toBeUndefined();
    }
    expect(posts).toHaveLength(0);
    const p = await run(["vault", "positions"]);
    expect(p.data?.positions).toEqual([expect.objectContaining({ vault: HATCH, shares: "100", role: "lp" })]);
  });
});

describe("venue guard", () => {
  it("-e hyperliquid is refused for Pacifica-only commands", async () => {
    const r = await run(["-e", "hyperliquid", "print", "games"]);
    expect(r.error?.structured.code).toBe("INVALID_PARAMS");
    expect((await run(["-e", "pac", "print", "games"])).error).toBeUndefined();
  });
});
