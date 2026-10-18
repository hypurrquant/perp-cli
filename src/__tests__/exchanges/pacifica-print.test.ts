/**
 * Pacifica Print: request building / signing payloads against the docs example
 * (api-documentation/api/rest-api/print/create-print-order), parsing of live public responses
 * (fixtures captured from api.pacifica.fi 2026-10-19), validation against the documented limits,
 * and the docs liquidation / size formulas (print/examples, print/margin-and-liquidation).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { buildPresigned, signPresigned } from "../../exchanges/pacifica-presigned.js";
import { buildAgentSignedRequest } from "../../pacifica/signing.js";
import {
  buildPrintDepositRequest, buildPrintEndRequest, parsePrintAccounts, parsePrintEvent, parsePrintGames, parsePrintPosition,
  printLiquidationPrice, quotePrintOrder, requireEndable, findPrintGame, envelopeData, PRINT_LIQUIDATION_NOTE,
  type PrintGame, type PrintOrderInput,
} from "../../exchanges/pacifica-print.js";

const FX = resolve(__dirname, "../fixtures/pacifica-earn");
const fx = (n: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(FX, n), "utf8")) as Record<string, unknown>;

const games = parsePrintGames(envelopeData(fx("game-config.json"), "/game/config"));
const btc24 = findPrintGame(games, "BTC_24H");
const MARKET = { mark: "70000", tickSize: "1" };
const order = (o: Partial<PrintOrderInput> = {}): PrintOrderInput => ({ game: "BTC_24H", direction: "long", deposit: "100", strikePrice: "69000", leverage: "10", cycles: null, ...o });

describe("docs example: POST /game/deposit (deposit_to_game)", () => {
  // Docs request example, minus signature / builder_code (perp-cli attaches no builder code to Print).
  const DOC = {
    account: "42trU9A5...", timestamp: 1716200000000, game: "BTC_24H", deposit_amount: "1000.00", direction: 1,
    strike_price: "95000.00", leverage: "2.0", total_segments: 7, idempotency_key: "550e8400-e29b-41d4-a716-446655440000",
    agent_wallet: "69trU9A5...", expiry_window: 30000,
  };
  const req = buildPresigned({
    type: "deposit_to_game", path: "/game/deposit", identity: { account: DOC.account, agentWallet: DOC.agent_wallet }, timestamp: DOC.timestamp, expiryWindow: DOC.expiry_window,
    payload: { game: DOC.game, deposit_amount: DOC.deposit_amount, direction: DOC.direction, strike_price: DOC.strike_price, leverage: DOC.leverage, total_segments: DOC.total_segments, idempotency_key: DOC.idempotency_key },
  });

  it("canonical message: header + payload under data, keys sorted, compact", () => {
    expect(req.message).toBe(
      '{"data":{"deposit_amount":"1000.00","direction":1,"game":"BTC_24H","idempotency_key":"550e8400-e29b-41d4-a716-446655440000","leverage":"2.0","strike_price":"95000.00","total_segments":7},"expiry_window":30000,"timestamp":1716200000000,"type":"deposit_to_game"}',
    );
  });

  it("body = the docs example fields (signature added at send)", () => {
    expect(req.body).toEqual(DOC);
    expect(req.idempotencyKey).toBe(DOC.idempotency_key);
  });

  it("matches the repo's production signer (buildAgentSignedRequest) byte for byte", async () => {
    const kp = Keypair.generate();
    const sign = async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey);
    const realNow = Date.now;
    Date.now = () => DOC.timestamp;
    try {
      const payload = { game: DOC.game, deposit_amount: DOC.deposit_amount, direction: DOC.direction, strike_price: DOC.strike_price, leverage: DOC.leverage, total_segments: DOC.total_segments, idempotency_key: DOC.idempotency_key };
      const ref = await buildAgentSignedRequest("deposit_to_game", payload, DOC.account, DOC.agent_wallet, sign, DOC.expiry_window);
      const mine = await signPresigned(req, sign);
      expect(mine).toEqual(ref);
    } finally { Date.now = realNow; }
  });

  it("the signature verifies over the canonical message with the signer's key", async () => {
    const kp = Keypair.generate();
    const body = await signPresigned(req, async (m) => nacl.sign.detached(m, kp.secretKey));
    expect(nacl.sign.detached.verify(new TextEncoder().encode(req.message), bs58.decode(body.signature as string), kp.publicKey.toBytes())).toBe(true);
  });
});

describe("buildPrintDepositRequest / buildPrintEndRequest", () => {
  it("deposit: direction 0 = long, total_segments only when cycles is set, idempotency key always", () => {
    const q = quotePrintOrder(btc24, order({ cycles: 3 }), MARKET);
    const r = buildPrintDepositRequest(q, { account: "ACC", agentWallet: null }, { timestamp: 1, idempotencyKey: "k-1" });
    expect(r.path).toBe("/game/deposit");
    expect(r.type).toBe("deposit_to_game");
    expect(r.body).toEqual({ account: "ACC", timestamp: 1, expiry_window: 5000, game: "BTC_24H", deposit_amount: "100", direction: 0, strike_price: "69000", leverage: "10", total_segments: 3, idempotency_key: "k-1" });
    const noCycles = buildPrintDepositRequest(quotePrintOrder(btc24, order({ direction: "short", strikePrice: "71000" }), MARKET), { account: "ACC", agentWallet: "AG" }, { timestamp: 1, idempotencyKey: "k" });
    expect(noCycles.body).not.toHaveProperty("total_segments");
    expect(noCycles.body).toMatchObject({ direction: 1, agent_wallet: "AG" });
  });

  it("end: end_game with {game_account}", () => {
    const r = buildPrintEndRequest("PrintAcc", { account: "ACC", agentWallet: null }, { timestamp: 5 });
    expect(r.message).toBe('{"data":{"game_account":"PrintAcc"},"expiry_window":5000,"timestamp":5,"type":"end_game"}');
    expect(r.body).toEqual({ account: "ACC", timestamp: 5, expiry_window: 5000, game_account: "PrintAcc" });
    expect(r.idempotencyKey).toBeNull();
  });

  it("an undefined payload field is refused (it would be signed but not sent)", () => {
    expect(() => buildPresigned({ type: "x", path: "/game/end", identity: { account: "A", agentWallet: null }, timestamp: 1, payload: { a: undefined } })).toThrow(/undefined/);
  });
});

describe("live /game/config parsing", () => {
  it("parses every product; cycle days and documented target ranges", () => {
    expect(games.length).toBeGreaterThan(0);
    const byId = new Map(games.map((g) => [g.game, g]));
    expect(byId.get("BTC_24H")).toMatchObject({ schema: 1, asset: "BTC", cycleDays: 1, maxLeverage: "40", minDeposit: "10", targetDistancePct: { min: "0.5", max: "10" } });
    expect(byId.get("BTC_7D")).toMatchObject({ cycleDays: 7, targetDistancePct: { max: "20" } });
    expect(byId.get("BTC_1M")).toMatchObject({ cycleDays: 30, targetDistancePct: { max: "40" } });
    expect(byId.get("BTC_24H")?.depositCap).toBe("250000");
    expect(byId.get("BTC_24H")?.poolAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  it("an undocumented cycle kind → cycleDays / max distance null (never a guessed range)", () => {
    const [g] = parsePrintGames({ configs: [{ game: "X_2H", target_asset: "X", segment_kind: "fixed_hours", segment_value: 2, max_leverage: "5" }] });
    expect(g).toMatchObject({ cycleDays: null, targetDistancePct: { max: null }, depositCap: null });
    expect(() => quotePrintOrder(g, order({ game: "X_2H" }), MARKET)).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }) }));
  });

  it("a refused envelope is EXCHANGE_ERROR", () => {
    expect(() => envelopeData({ success: false, error: "boom" }, "/game/config")).toThrow(/boom/);
  });

  it("unknown game → SYMBOL_NOT_FOUND listing the products", () => {
    expect(() => findPrintGame(games, "DOGE_24H")).toThrow(expect.objectContaining({
      structured: expect.objectContaining({ code: "SYMBOL_NOT_FOUND", remediation: expect.stringMatching(/Available: .*BTC_24H/) }),
    }));
    expect(findPrintGame(games, "btc_7d").game).toBe("BTC_7D");
  });
});

describe("live /game/accounts, /game/history_summary, /game/history parsing", () => {
  it("a cancelling order (end requested, not ended)", () => {
    const [p] = parsePrintAccounts(envelopeData(fx("game-accounts.json"), "/game/accounts"));
    expect(p).toMatchObject({ schema: 1, game: "BTC_24H", direction: "long", deposit: "1094.99", leverage: "10", strikePrice: "78703", cancelRequested: true, status: "cancelling", endedAt: null });
    expect(p.maxLoss).toBe("1098.269068"); // deposit + premium
    expect(p.notional).toBe("10949.9");
  });

  it("an ended order whose end_reason is null is 'ended' — never guessed as filled", () => {
    const [p] = parsePrintAccounts(envelopeData(fx("game-accounts-ended-no-reason.json"), "/game/accounts"));
    expect(p.endedAt).not.toBeNull();
    expect(p.endReason).toBeNull();
    expect(p.status).toBe("ended");
  });

  it("history_summary rows map end_reason → status", () => {
    const rows = (envelopeData(fx("game-history-summary.json"), "/game/history_summary") as unknown[]).map(parsePrintPosition);
    const status = new Map(rows.map((r) => [r.endReason, r.status]));
    expect(status.get("filled")).toBe("filled");
    expect(status.get("liquidated")).toBe("liquidated");
    expect(status.get("user_requested")).toBe("cancelled");
  });

  it("history pages keep has_more / next_cursor", () => {
    const env = fx("game-history-summary-page.json");
    expect(env.has_more).toBe(true);
    expect(typeof env.next_cursor).toBe("string");
  });

  it("event log: created / premium / end_requested / liquidated; position_opened carries size", () => {
    const liq = (envelopeData(fx("game-history-liquidated.json"), "/game/history") as unknown[]).map(parsePrintEvent);
    expect(liq.map((e) => e.event)).toEqual(["liquidated", "end_requested", "premium", "created"]);
    expect(liq.find((e) => e.event === "premium")?.amount).toBe("23.797135");
    expect(liq.find((e) => e.event === "end_requested")).toMatchObject({ amount: null, strikePrice: null, cycleStartedAt: null });
    const filled = (envelopeData(fx("game-history-filled.json"), "/game/history") as unknown[]).map(parsePrintEvent);
    expect(filled.find((e) => e.event === "position_opened")?.size).toBe("6.3");
  });

  it("unknown direction / missing deposit → EXCHANGE_ERROR (no default)", () => {
    const base = (fx("game-accounts.json").data as { game_accounts: Record<string, unknown>[] }).game_accounts[0];
    expect(() => parsePrintPosition({ ...base, direction: 2 })).toThrow(/unknown direction/);
    expect(() => parsePrintPosition({ ...base, initial_deposit: null })).toThrow(/initial_deposit/);
  });

  it("documents the live evidence that the venue liquidates before the docs formula", () => {
    // ZEC_24H short 10x: the docs formula gives ≈1269 while the venue liquidated at mark 1216.836.
    const ev = (envelopeData(fx("game-history-liquidated.json"), "/game/history") as unknown[]).map(parsePrintEvent);
    const liqMark = Number(ev[0].markPrice);
    const docs = Number(printLiquidationPrice("short", "1150.95", "922.93", "10", "23.797135"));
    expect(docs).toBeGreaterThan(liqMark);
    expect(PRINT_LIQUIDATION_NOTE).toMatch(/earlier/);
  });
});

describe("docs formulas (print/examples)", () => {
  it("Example 3 liquidation prices for a $100, 69,000 long", () => {
    const liq = (lev: string) => printLiquidationPrice("long", "69000", "100", lev, "0");
    expect(liq("2")).toBe("34500");
    expect(liq("10")).toBe("62100");
    expect(liq("20")).toBe("65550");
    expect(liq("40")).toBe("67275");
  });

  it("Example 1/2 size and short liquidation", () => {
    const q = quotePrintOrder(btc24, order(), MARKET);
    expect(q.notional).toBe("1000");
    expect(q.size).toBe("0.01449275"); // 100 × 10 ÷ 69,000 ≈ 0.0145
    const s = quotePrintOrder(btc24, order({ direction: "short", deposit: "200", leverage: "5", strikePrice: "71500" }), MARKET);
    expect(s.size).toBe("0.01398601"); // ≈ 0.014
    expect(s.docsLiquidationPrice).toBe("85800"); // 71,500 + 71,500 / 5
  });

  it("premium earned moves the liquidation price away; leverage 1 long has none", () => {
    expect(Number(printLiquidationPrice("long", "69000", "100", "10", "5"))).toBeLessThan(62100);
    expect(printLiquidationPrice("long", "69000", "100", "1", "0")).toBeNull();
  });
});

describe("quotePrintOrder validation (documented limits)", () => {
  const code = (f: () => unknown): string | undefined => {
    try { f(); } catch (e) { return (e as { structured?: { code: string } }).structured?.code; }
    return undefined;
  };
  const q = (o: Partial<PrintOrderInput>, g: PrintGame = btc24, m = MARKET) => () => quotePrintOrder(g, order(o), m);

  it("preview shows cycles, leverage, max loss and the lock", () => {
    const r = quotePrintOrder(btc24, order({ cycles: 7 }), MARKET);
    expect(r).toMatchObject({ schema: 1, leverage: "10", cycles: 7, maxDurationDays: 7, maxLoss: "100", cancelSettlesWithinDays: 1, estimatedPremium: null, targetDistancePct: "1.4285" });
    expect(r.notes.join(" ")).toMatch(/Max loss/);
    expect(quotePrintOrder(btc24, order(), MARKET).maxDurationDays).toBeNull();
  });

  it("deposit: min 10, USDC decimals, product cap", () => {
    expect(code(q({ deposit: "9.99" }))).toBe("INVALID_PARAMS");
    expect(code(q({ deposit: "10" }))).toBeUndefined();
    expect(code(q({ deposit: "10.1234567" }))).toBe("INVALID_PARAMS");
    expect(code(q({ deposit: "1e3" }))).toBe("INVALID_PARAMS");
    expect(code(q({ deposit: "250000.01", leverage: "1" }))).toBe("INVALID_PARAMS");
  });

  it("leverage: whole number 1 … product max", () => {
    expect(code(q({ leverage: "0" }))).toBe("INVALID_PARAMS");
    expect(code(q({ leverage: "40" }))).toBeUndefined();
    expect(code(q({ leverage: "41" }))).toBe("INVALID_PARAMS");
    expect(code(q({ leverage: "2.5" }))).toBe("INVALID_PARAMS");
    expect(code(q({ leverage: "26", game: "ETH_24H" }, findPrintGame(games, "ETH_24H"), { mark: "2000", tickSize: "0.1" }))).toBe("INVALID_PARAMS");
  });

  it("target: side of the mark, 0.5% … cycle max, on tick", () => {
    expect(code(q({ strikePrice: "70000" }))).toBe("INVALID_PARAMS"); // at mark
    expect(code(q({ strikePrice: "71000" }))).toBe("INVALID_PARAMS"); // long above mark
    expect(code(q({ direction: "short", strikePrice: "69000" }))).toBe("INVALID_PARAMS");
    expect(code(q({ strikePrice: "69650" }))).toBeUndefined(); // exactly 0.5%
    expect(code(q({ strikePrice: "69651" }))).toBe("INVALID_PARAMS"); // < 0.5%
    expect(code(q({ strikePrice: "63000" }))).toBeUndefined(); // exactly 10% on 24h
    expect(code(q({ strikePrice: "62999" }))).toBe("INVALID_PARAMS");
    expect(code(q({ strikePrice: "62999" }, findPrintGame(games, "BTC_7D")))).toBeUndefined(); // 20% on 7d
    expect(code(q({ strikePrice: "42000" }, findPrintGame(games, "BTC_1M")))).toBeUndefined(); // 40% on 30d
    expect(code(q({ strikePrice: "41999" }, findPrintGame(games, "BTC_1M")))).toBe("INVALID_PARAMS");
    expect(code(q({ strikePrice: "69000.5" }))).toBe("INVALID_TICK");
  });

  it("cycles: 1 … 1000", () => {
    expect(code(q({ cycles: 0 }))).toBe("INVALID_PARAMS");
    expect(code(q({ cycles: 1000 }))).toBeUndefined();
    expect(code(q({ cycles: 1001 }))).toBe("INVALID_PARAMS");
  });
});

describe("requireEndable", () => {
  const rows = parsePrintAccounts(envelopeData(fx("game-accounts.json"), "/game/accounts"));
  it("refuses an order that is already cancelling / unknown", () => {
    expect(() => requireEndable(rows, rows[0].address)).toThrow(/cancelling/);
    expect(() => requireEndable(rows, "Nope")).toThrow(expect.objectContaining({ structured: expect.objectContaining({ code: "POSITION_NOT_FOUND" }) }));
  });
  it("accepts a printing order", () => {
    const running = parsePrintPosition({ ...(fx("game-accounts.json").data as { game_accounts: Record<string, unknown>[] }).game_accounts[0], user_initiated_game_end: false });
    expect(requireEndable([running], running.address).status).toBe("printing");
  });
});
