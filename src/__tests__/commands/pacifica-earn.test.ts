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
import { LocalSolanaSigner } from "../../signer/solana-local.js";
import { registerWalletManageCommands } from "../../commands/manage.js";
import type { AgentMeta } from "../../settings.js";
import { pacificaRateLimiter, resetPacificaRateLimiters } from "../../pacifica/rate-limit.js";
import { MAINNET_REST } from "../../pacifica/constants.js";
import { PacificaClient } from "../../pacifica/client.js";

const FX = resolve(__dirname, "../fixtures/pacifica-earn");
const fixture = (n: string): unknown => JSON.parse(readFileSync(resolve(FX, n), "utf8"));
const env = (data: unknown) => ({ success: true, data, error: null, code: null });

const KP = Keypair.generate();
const ACCOUNT = KP.publicKey.toBase58();
const HATCH = "9GN1GztuBJWWRC1q39P4fFtiN341ZbqC5FNXkL1MAxUh";

type PostReply = () => Response | Promise<Response>;
let postReply: PostReply;
let gameAccounts: () => unknown;
let lakeList: () => unknown;
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
  gameAccounts = () => fixture("game-accounts.json");
  lakeList = lakeListWithShares;
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
      case "/game/accounts": return json(200, gameAccounts());
      case "/game/history_summary": return json(200, fixture("game-history-summary-page.json"));
      case "/info/prices": return json(200, env([{ symbol: "BTC", mark: "70000" }]));
      case "/info": return json(200, env([{ symbol: "BTC", tick_size: "1" }]));
      case "/account": return json(200, env({ available_to_withdraw: "1000", account_equity: "1000" }));
      case "/positions": return json(200, env([]));
      case "/lake/list": return json(200, lakeList());
      case "/lake/get_deposit_whitelist": return json(200, fixture("lake-deposit-whitelist.json"));
      default: throw new Error(`unexpected GET ${path}`);
    }
  }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); adapterKind = "master"; adapterBuilds = 0; resetPacificaRateLimiters(); });

const AGENT_KP = Keypair.generate();
const AGENT = AGENT_KP.publicKey.toBase58();
function agentMeta(): AgentMeta {
  return {
    agentName: "t", agentWalletName: "t", agentEvmAddress: "0x0000000000000000000000000000000000000000", userEvmAddress: "0x0000000000000000000000000000000000000000",
    agentSolanaAddress: AGENT, userSolanaAddress: ACCOUNT, masterWalletName: "", owsApiKeyId: "", owsPolicyId: "", expiresAt: "2099-01-01T00:00:00.000Z",
    approvedAt: "2026-10-19T00:00:00.000Z", permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false }, asterApprovalNonce: "", status: "active", network: "mainnet",
  } as AgentMeta;
}
/** master = the account key only; agent = master + approved agent; agentOnly = agent key, no master on this machine. */
function makeAdapter(kind: "master" | "agent" | "agentOnly"): PacificaAdapter {
  const a = kind === "agentOnly" ? new PacificaAdapter(Keypair.generate(), "mainnet", false) : new PacificaAdapter(KP, "mainnet", true);
  if (kind !== "master") a.setAgentSigner(agentMeta(), new LocalSolanaSigner(AGENT_KP));
  return a;
}
let adapterKind: "master" | "agent" | "agentOnly" = "master";
let adapterBuilds = 0;

function verify(body: Record<string, unknown>, type: string, kp: Keypair): boolean {
  const { signature, account: _a, agent_wallet: _w, timestamp, expiry_window, ...payload } = body;
  const sort = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  const message = JSON.stringify({ data: sort(payload), expiry_window, timestamp, type });
  return nacl.sign.detached.verify(new TextEncoder().encode(message), bs58.decode(signature as string), kp.publicKey.toBytes());
}

async function run(argv: string[]): Promise<{ data?: Record<string, unknown>; error?: PerpError }> {
  const prog = addRootSafetyOptions(new Command());
  prog.exitOverride();
  prog.option("-e, --exchange <venue>", "venue", "hyperliquid").option("--json");
  prog.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const getter = async () => { adapterBuilds++; return makeAdapter(adapterKind); };
  registerPacificaEarnCommands(prog, getter, () => true);
  registerWalletManageCommands(prog.command("wallet"), getter, () => true, () => null);
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
    expect(r.error?.structured.remediation).toMatch(/Do NOT resubmit.*print positions — look for a new BTC_24H long order with strikePrice 69000 and deposit 100 \(1 current order\(s\) before/);
    expect(r.error?.structured.remediation).toContain(`--idempotency-key ${String(posts[0].body.idempotency_key)}`);
    expect(r.error?.structured.remediation).toMatch(/dedupe window is unverified/);
    expect(r.error?.structured.details?.before).toEqual({ printOrders: 1 });
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

describe("print cancel (unofficial /game/end)", () => {
  const running = () => {
    const f = fixture("game-accounts.json") as { data: { game_accounts: Record<string, unknown>[] } };
    return { ...f, data: { game_accounts: f.data.game_accounts.map((g) => ({ ...g, user_initiated_game_end: false })) } };
  };
  const ADDR = () => String((running().data.game_accounts[0] as Record<string, unknown>).address);

  it("live run without --unverified-endpoint → INVALID_PARAMS (apiStatus unofficial), nothing sent", async () => {
    gameAccounts = running;
    const r = await run(["print", "cancel", ADDR()]);
    expect(r.error?.structured).toMatchObject({ code: "INVALID_PARAMS", details: { apiStatus: "unofficial" } });
    expect(posts).toHaveLength(0);
  });

  it("--dry-run is labelled apiStatus: unofficial; nothing sent", async () => {
    gameAccounts = running;
    const r = await run(["--dry-run", "print", "cancel", ADDR()]);
    expect(r.data).toMatchObject({ dryRun: true, sent: false, apiStatus: "unofficial", request: { type: "end_game", body: { game_account: ADDR() } } });
    expect(posts).toHaveLength(0);
  });

  it("with --unverified-endpoint and an agent: one POST, agent_wallet set, signature by the agent key", async () => {
    gameAccounts = running;
    adapterKind = "agent";
    postReply = () => json(200, env({ scheduled_end_at_ms: 1792421813444 }));
    const r = await run(["print", "cancel", ADDR(), "--unverified-endpoint"]);
    expect(r.data).toMatchObject({ endRequested: true, apiStatus: "unofficial", scheduledEndAt: 1792421813444 });
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ account: ACCOUNT, agent_wallet: AGENT, game_account: ADDR() });
    expect(verify(posts[0].body, "end_game", AGENT_KP)).toBe(true);
  });

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

describe("signer policy", () => {
  it("print deposit with an approved agent: agent_wallet in the body, signature verifies against the AGENT key", async () => {
    adapterKind = "agent";
    await run(DEPOSIT);
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({ account: ACCOUNT, agent_wallet: AGENT });
    expect(verify(posts[0].body, "deposit_to_game", AGENT_KP)).toBe(true);
    expect(verify(posts[0].body, "deposit_to_game", KP)).toBe(false);
  });

  it("vault withdraw with an agent: agent-signed, pays the own account", async () => {
    adapterKind = "agent";
    postReply = () => json(200, env({ amount_withdrawn: "1" }));
    await run(["vault", "withdraw", HATCH, "10"]);
    expect(posts[0].body).toMatchObject({ account: ACCOUNT, agent_wallet: AGENT, lake: HATCH });
    expect(verify(posts[0].body, "withdraw_from_lake", AGENT_KP)).toBe(true);
  });

  it("vault deposit is master-only: master + agent → signed by the MASTER (no agent_wallet)", async () => {
    adapterKind = "agent";
    postReply = () => json(200, env({ shares_minted: "20" }));
    const r = await run(["vault", "deposit", HATCH, "25"]);
    expect(r.data).toMatchObject({ deposited: true, sharesMinted: "20" });
    expect(posts[0].body).not.toHaveProperty("agent_wallet");
    expect(verify(posts[0].body, "deposit_to_lake", KP)).toBe(true);
  });

  it("vault deposit with only an agent key → NO_SIGNER_AVAILABLE, nothing signed or sent (also in --dry-run)", async () => {
    adapterKind = "agentOnly";
    const sign = vi.spyOn(LocalSolanaSigner.prototype, "signMessage");
    for (const argv of [["vault", "deposit", HATCH, "25"], ["--dry-run", "vault", "deposit", HATCH, "25"]]) {
      const r = await run(argv);
      expect(r.error?.structured).toMatchObject({ code: "NO_SIGNER_AVAILABLE", remediation: expect.stringMatching(/master wallet/) });
    }
    expect(sign).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it("vault deposit unknown outcome: ORDER_PENDING names the pre-write shares and the key retry", async () => {
    postReply = () => json(502, "bad gateway");
    const r = await run(["vault", "deposit", HATCH, "25"]);
    expect(r.error?.structured.code).toBe("ORDER_PENDING");
    expect(r.error?.structured.details?.before).toEqual({ shares: "100" });
    expect(r.error?.structured.remediation).toMatch(/vault positions — shares in vault 9GN1.* \(100 before this request\).*--idempotency-key/);
    expect(posts).toHaveLength(1);
  });

  it("--idempotency-key re-sends the given key; a non-UUID is refused before anything is sent", async () => {
    const key = "550e8400-e29b-41d4-a716-446655440000";
    await run([...DEPOSIT, "--idempotency-key", key.toUpperCase()]);
    expect(posts[0].body.idempotency_key).toBe(key);
    const r = await run([...DEPOSIT, "--idempotency-key", "abc"]);
    expect(r.error?.structured.code).toBe("INVALID_PARAMS");
    expect(posts).toHaveLength(1);
  });

  it("every --dry-run write never calls signMessage", async () => {
    const sign = vi.spyOn(LocalSolanaSigner.prototype, "signMessage");
    adapterKind = "agent";
    gameAccounts = () => {
      const f = fixture("game-accounts.json") as { data: { game_accounts: Record<string, unknown>[] } };
      return { ...f, data: { game_accounts: f.data.game_accounts.map((g) => ({ ...g, user_initiated_game_end: false })) } };
    };
    const end = (fixture("game-accounts.json") as { data: { game_accounts: Array<{ address: string }> } }).data.game_accounts[0].address;
    for (const argv of [["--dry-run", ...DEPOSIT], ["--dry-run", "print", "cancel", end], ["--dry-run", "vault", "deposit", HATCH, "25"], ["--dry-run", "vault", "withdraw", HATCH, "--all"]]) {
      const r = await run(argv);
      expect(r.data?.sent).toBe(false);
    }
    expect(sign).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it("--account reads and --account dry-runs never build the adapter (no key loaded)", async () => {
    for (const argv of [["print", "positions", "--account", HATCH], ["print", "history", "--account", HATCH], ["vault", "positions", "--account", HATCH],
      ["--dry-run", ...DEPOSIT, "--account", HATCH], ["--dry-run", "vault", "deposit", "Growi HF", "25", "--account", HATCH]]) {
      expect((await run(argv)).error).toBeUndefined();
    }
    expect(adapterBuilds).toBe(0);
  });
});

describe("ambiguous vault nickname", () => {
  beforeEach(() => {
    lakeList = () => {
      const l = lakeListWithShares() as { data: { lakes: Record<string, unknown>[] } };
      const hatch = l.data.lakes.find((x) => x.address === HATCH) as Record<string, unknown>;
      const copy = { ...hatch, address: "CopyCatVau1t111111111111111111111111111111", nickname: "the hatch", manager: "Attacker1111111111111111111111111111111111" };
      return { ...l, data: { lakes: [copy, ...l.data.lakes] } };
    };
  });
  it.each([
    [["vault", "deposit", "The Hatch", "25"]],
    [["--dry-run", "vault", "deposit", "The Hatch", "25"]],
    [["vault", "withdraw", "The Hatch", "10"]],
    [["vault", "info", "The Hatch"]],
  ])("%j → INVALID_PARAMS listing both candidates; nothing sent", async (argv) => {
    const r = await run(argv as string[]);
    expect(r.error?.structured.code).toBe("INVALID_PARAMS");
    const c = (r.error?.structured.details?.candidates as Array<{ address: string; manager: string }>).map((x) => x.address).sort();
    expect(c).toEqual(["CopyCatVau1t111111111111111111111111111111", HATCH].sort());
    expect(posts).toHaveLength(0);
  });
  it("the address still resolves; the plan names the resolved vault and manager", async () => {
    const r = await run(["--dry-run", "vault", "deposit", HATCH, "25"]);
    expect(r.data?.plan).toMatchObject({ vault: HATCH, manager: expect.any(String) });
  });
});

describe("wallet manage lake (legacy)", () => {
  it.each([[["wallet", "manage", "lake", "deposit", HATCH, "25"]], [["wallet", "manage", "lake", "withdraw", HATCH, "1"]]])("%j → refused with a pointer to the validated command; no adapter, nothing signed", async (argv) => {
    const r = await run(argv as string[]);
    expect(r.error?.structured).toMatchObject({ code: "INVALID_PARAMS", message: expect.stringMatching(/perp -e pacifica vault (deposit|withdraw)/) });
    expect(adapterBuilds).toBe(0);
    expect(posts).toHaveLength(0);
  });
  it("lake create --initial-deposit with an agent signer → NO_SIGNER_AVAILABLE before anything is sent", async () => {
    adapterKind = "agent";
    const r = await run(["wallet", "manage", "lake", "create", "--initial-deposit", "100"]);
    expect(r.error?.structured.code).toBe("NO_SIGNER_AVAILABLE");
    expect(posts).toHaveLength(0);
  });
});

describe("venue guard", () => {
  it("-e hyperliquid is refused for Pacifica-only commands", async () => {
    const r = await run(["-e", "hyperliquid", "print", "games"]);
    expect(r.error?.structured.code).toBe("INVALID_PARAMS");
    expect((await run(["-e", "pac", "print", "games"])).error).toBeUndefined();
  });
});

/** A response carrying Pacifica rate-limit headers (credits ×10). */
const limited = (r: number, t: number, status = 200, body = "{}") => new Response(body, { status, headers: { ratelimit: `"credits";r=${r};t=${t}`, "ratelimit-policy": '"credits";q=1000;w=60' } });

describe("rate limiter integration (PR #35)", () => {
  it("getEnvelope 429 → RATE_LIMITED sent:false (structural), headers recorded, in-flight back to 0; the next read fails fast without a fetch", async () => {
    let gets = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { gets++; return limited(0, 40, 429, JSON.stringify({ success: false, error: "Rate limit exceeded", code: 429 })); }));
    const c = new PacificaClient({ network: "mainnet" });
    await expect(c.getEnvelope("/game/config")).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { exchange: "pacifica", sent: false, httpStatus: 429 } } });
    const snap = pacificaRateLimiter(MAINNET_REST, undefined, "unsigned").snapshot();
    expect(snap).toMatchObject({ remaining: 0, inFlight: 0 });
    await expect(c.getEnvelope("/lake/list")).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { sent: false } } });
    expect(gets).toBe(1);
  });

  it("getEnvelope records the headers of a 200 and leaves nothing in flight", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => limited(800, 30, 200, JSON.stringify({ success: true, data: { configs: [] } }))));
    await new PacificaClient({ network: "mainnet" }).getEnvelope("/game/config");
    expect(pacificaRateLimiter(MAINNET_REST, undefined, "unsigned").snapshot()).toMatchObject({ remaining: 800, inFlight: 0 });
  });

  it("a presigned write waits for credits BEFORE signing, then signs with a fresh timestamp and sends once", async () => {
    pacificaRateLimiter(MAINNET_REST, undefined, "signed").observe(limited(0, 1));
    const original = LocalSolanaSigner.prototype.signMessage;
    let signedAt = 0;
    const sign = vi.spyOn(LocalSolanaSigner.prototype, "signMessage").mockImplementation(function (this: LocalSolanaSigner, m: Uint8Array) { signedAt = Date.now(); return original.call(this, m); });
    postReply = () => json(200, env({ amount_withdrawn: "1" }));
    const start = Date.now();
    const r = await run(["vault", "withdraw", HATCH, "10"]);
    expect(r.data).toMatchObject({ withdrawn: true });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(signedAt - start).toBeGreaterThanOrEqual(1000); // the ~1.25 s window wait happened before signing
    expect(posts).toHaveLength(1);
    expect(Number(posts[0].body.timestamp)).toBeGreaterThanOrEqual(start + 1000); // re-stamped after the wait
  }, 10_000);

  it("pre-sign capacity exhausted → RATE_LIMITED sent:false: nothing signed, nothing sent", async () => {
    pacificaRateLimiter(MAINNET_REST, undefined, "signed").observe(limited(0, 59));
    const sign = vi.spyOn(LocalSolanaSigner.prototype, "signMessage");
    const r = await run(DEPOSIT);
    expect(r.error?.structured).toMatchObject({ code: "RATE_LIMITED", details: { sent: false } });
    expect(sign).not.toHaveBeenCalled();
    expect(posts).toHaveLength(0);
  });

  it("HTTP 429 on a presigned write → RATE_LIMITED (not executed), sent exactly once, never retried, never ORDER_PENDING", async () => {
    postReply = () => limited(0, 30, 429, JSON.stringify({ success: false, error: "Rate limit exceeded", code: 429 }));
    for (const argv of [DEPOSIT, ["vault", "deposit", HATCH, "25"], ["vault", "withdraw", HATCH, "10"]]) {
      resetPacificaRateLimiters();
      const before = posts.length;
      const r = await run(argv);
      expect(r.error?.structured).toMatchObject({ code: "RATE_LIMITED", details: { exchange: "pacifica", sent: false, httpStatus: 429 } });
      expect(posts.length - before).toBe(1);
    }
  });
});
