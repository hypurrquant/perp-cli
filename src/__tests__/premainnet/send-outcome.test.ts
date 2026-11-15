/**
 * Pre-mainnet review H1 / M7: once an order / cancel / withdraw / transfer / leverage change is
 * SENT, a lost response (connection reset, timeout, 5xx, unreadable body) is ORDER_PENDING
 * (non-retryable) — never the retryable EXCHANGE_UNREACHABLE / TIMEOUT / EXCHANGE_ERROR. A request
 * that never connected stays "not sent".
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { PerpError, classifyError, isConnectFailure, sendFailure } from "../../errors.js";
import { HyperliquidAdapter } from "../../exchanges/hyperliquid.js";
import { LocalEvmSigner } from "../../signer/index.js";
import { PacificaClient } from "../../pacifica/client.js";
import { lighterPostSendTx, lighterSendTxCodeIsDefinite } from "../../exchanges/lighter.js";
import { AsterAdapter } from "../../exchanges/aster.js";

const KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function caught(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error("expected a rejection");
}
const codeOf = (e: unknown) => (e as PerpError).structured?.code;

function fetchFailed(code: string): TypeError {
  const e = new TypeError("fetch failed");
  (e as { cause?: unknown }).cause = Object.assign(new Error(code), { code });
  return e;
}
const reply = (status: number, body: string) => ({ ok: status >= 200 && status < 300, status, text: async () => body, json: async () => JSON.parse(body) });

describe("errors: sendFailure", () => {
  it("connection never established → not sent (definite); anything else → ORDER_PENDING", () => {
    expect(isConnectFailure(fetchFailed("ENOTFOUND"))).toBe(true);
    expect(isConnectFailure(fetchFailed("ECONNREFUSED"))).toBe(true);
    expect(isConnectFailure(fetchFailed("ECONNRESET"))).toBe(false);
    expect(sendFailure("v", "order", fetchFailed("ENOTFOUND")).structured.code).toBe("ORDER_REJECTED");
    const pending = sendFailure("v", "order", fetchFailed("ECONNRESET"));
    expect(pending.structured.code).toBe("ORDER_PENDING");
    expect(pending.structured.retryable).toBe(false);
    expect(sendFailure("v", "order", Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })).structured.code).toBe("ORDER_PENDING");
    // the bug: the same errors classified generically are RETRYABLE
    expect(classifyError(fetchFailed("ECONNRESET")).retryable).toBe(true);
  });
});

describe("Hyperliquid POST /exchange", () => {
  async function hl(): Promise<HyperliquidAdapter> {
    const a = new HyperliquidAdapter(undefined, true);
    a.setSigner(await LocalEvmSigner.create(KEY));
    return a;
  }
  const cancel = { type: "cancel", cancels: [{ a: 1, o: 5 }] };

  it("connection reset after send → ORDER_PENDING, with a fetch timeout set", async () => {
    const f = vi.fn().mockRejectedValue(fetchFailed("ECONNRESET"));
    vi.stubGlobal("fetch", f);
    const e = await caught((await hl()).exchangeAction(cancel));
    expect(codeOf(e)).toBe("ORDER_PENDING");
    expect((e as PerpError).structured.remediation).toMatch(/Do NOT resubmit/);
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("timeout → ORDER_PENDING", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "TimeoutError" })));
    expect(codeOf(await caught((await hl()).exchangeAction(cancel)))).toBe("ORDER_PENDING");
  });

  it("5xx (readable or not) and an unreadable 2xx body → ORDER_PENDING", async () => {
    for (const r of [reply(502, "<html>Bad Gateway</html>"), reply(500, "{\"status\":\"err\",\"response\":\"x\"}"), reply(200, "<html>")]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(r));
      expect(codeOf(await caught((await hl()).exchangeAction(cancel)))).toBe("ORDER_PENDING");
    }
  });

  it("withdraw3 (user-signed) with a lost response → ORDER_PENDING, not a retryable network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed("ECONNRESET")));
    const e = await caught((await hl()).withdraw("5", "0x5e9ee1089755c3435139848e47e6635505d5a13a"));
    expect(codeOf(e)).toBe("ORDER_PENDING");
  });

  it("DNS failure (never connected) → not sent; a 4xx text body and an err envelope stay refusals", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed("ENOTFOUND")));
    const notSent = await caught((await hl()).exchangeAction(cancel));
    expect(codeOf(notSent)).toBe("ORDER_REJECTED");
    expect((notSent as Error).message).toMatch(/not sent/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(422, "Failed to deserialize the JSON body")));
    const refused = await caught((await hl()).exchangeAction(cancel));
    expect(refused).not.toBeInstanceOf(PerpError);
    expect((refused as Error).message).toMatch(/^HL exchange API error \(422\)/);
    // A top-level err envelope on an L1 action is a DEFINITE refusal (never the retryable EXCHANGE_ERROR).
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, "{\"status\":\"err\",\"response\":\"Insufficient margin\"}")));
    expect(codeOf(await caught((await hl()).exchangeAction(cancel)))).toBe("MARGIN_INSUFFICIENT");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, "{\"status\":\"err\",\"response\":\"Invalid cancel request\"}")));
    const rejected = await caught((await hl()).exchangeAction(cancel)) as PerpError;
    expect(rejected.structured).toMatchObject({ code: "ACTION_REJECTED", retryable: false });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, "{\"status\":\"err\",\"response\":\"Order has invalid price.\"}")));
    expect(codeOf(await caught((await hl()).exchangeAction({ type: "order", orders: [], grouping: "na" })))).toBe("ORDER_REJECTED");
  });
});

describe("Pacifica signed POST", () => {
  const post = (path: string) => (new PacificaClient({ network: "testnet" }) as unknown as { post(p: string, b: object): Promise<unknown> }).post(path, {});

  it("connection reset / 5xx / unreadable 2xx on a write → ORDER_PENDING", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed("ECONNRESET")));
    expect(codeOf(await caught(post("/orders/create_market")))).toBe("ORDER_PENDING");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(503, "upstream")));
    expect(codeOf(await caught(post("/account/withdraw")))).toBe("ORDER_PENDING");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, "not json")));
    expect(codeOf(await caught(post("/account/leverage")))).toBe("ORDER_PENDING");
  });

  it("never connected → not sent; a 4xx keeps the plain refusal the adapters map; reads are not orders", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed("ECONNREFUSED")));
    expect(codeOf(await caught(post("/orders/cancel")))).toBe("ORDER_REJECTED");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(422, "{\"success\":false,\"error\":\"x\",\"code\":5}")));
    const refused = await caught(post("/orders/cancel"));
    expect(refused).not.toBeInstanceOf(PerpError);
    expect((refused as Error).message).toMatch(/^POST \/orders\/cancel failed \(422\)/);
    // The three signed listing POSTs are reads: a transport failure is a retryable read error
    // (PerpError EXCHANGE_UNREACHABLE / TIMEOUT), never ORDER_PENDING and never a raw TimeoutError.
    for (const path of ["/agent/list", "/account/subaccount/list", "/account/api_keys"]) {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed("ECONNRESET")));
      expect((await caught(post(path)) as PerpError).structured).toMatchObject({ code: "EXCHANGE_UNREACHABLE", retryable: true });
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })));
      const timedOut = await caught(post(path));
      expect(timedOut).toBeInstanceOf(PerpError);
      expect((timedOut as PerpError).structured).toMatchObject({ code: "TIMEOUT", retryable: true, details: { exchange: "pacifica" } });
    }
  });
});

describe("Lighter /sendTx (perp + spot share lighterPostSendTx) — M7", () => {
  const send = (kind: "order" | "action" = "order") => lighterPostSendTx("https://x", { txType: 14, txInfo: "{}" }, "lighter", kind, "order sendTx");

  it("code 200 → the ack", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, "{\"code\":200,\"tx_hash\":\"ab\"}")));
    await expect(send()).resolves.toMatchObject({ tx_hash: "ab" });
  });

  it("transport failure, 5xx, unreadable body → ORDER_PENDING", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed("ECONNRESET")));
    expect(codeOf(await caught(send()))).toBe("ORDER_PENDING");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(504, "gateway timeout")));
    expect(codeOf(await caught(send()))).toBe("ORDER_PENDING");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, "<html>")));
    expect(codeOf(await caught(send()))).toBe("ORDER_PENDING");
  });

  it("missing code and 29500 / 29501 (process timeout) → ORDER_PENDING, never a rejection", async () => {
    for (const body of ["{}", "{\"message\":\"x\"}", "{\"code\":29500,\"message\":\"internal server error\"}", "{\"code\":29501,\"message\":\"process timeout\"}", "{\"code\":99999}"]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, body)));
      expect(codeOf(await caught(send()))).toBe("ORDER_PENDING");
    }
    expect(lighterSendTxCodeIsDefinite(29501)).toBe(false);
    expect(lighterSendTxCodeIsDefinite(undefined)).toBe(false);
  });

  // docs.lighter.xyz data-structures-constants-and-errors — these were ORDER_PENDING (outcome unknown).
  it.each([
    [52001, "Unauthorized use of the API, contact our team if you think you got this in error."],
    [52002, "You've reached the limit of Standard trading and can now only close or reduce positions."],
    [62007, "maker-only api key can only send 0ms delay transactions"],
  ])("account-level refusal %i is a definite rejection (ORDER_REJECTED), never ORDER_PENDING", async (code, message) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, JSON.stringify({ code, message }))));
    expect(codeOf(await caught(send()))).toBe("ORDER_REJECTED");
  });

  it.each([[21507, "maintenance"], [21508, "initial"]])("%i (below %s margin) → MARGIN_INSUFFICIENT", async (code, which) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(200, JSON.stringify({ code, message: `account is below ${which} margin, can't execute transaction` }))));
    expect(codeOf(await caught(send()))).toBe("MARGIN_INSUFFICIENT");
  });

  it("documented validation codes are definite: ORDER_REJECTED / ACTION_REJECTED / balance", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(400, "{\"code\":21104,\"message\":\"invalid nonce\"}")));
    expect(codeOf(await caught(send()))).toBe("ORDER_REJECTED");
    expect(codeOf(await caught(send("action")))).toBe("ACTION_REJECTED");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply(400, "{\"code\":21739,\"message\":\"not enough margin to create the order\"}")));
    expect(["MARGIN_INSUFFICIENT", "INSUFFICIENT_BALANCE"]).toContain(codeOf(await caught(send())));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(fetchFailed("ENOTFOUND")));
    expect((await caught(send()) as Error).message).toMatch(/not sent/);
  });
});

describe("Aster perp writes", () => {
  const write = (e: unknown) => (Object.create(AsterAdapter.prototype) as unknown as { _perpWrite(w: string, f: () => Promise<unknown>): Promise<unknown> })
    ._perpWrite("POST /fapi/v3/order", async () => { throw e; });

  it("5xx / unreadable 2xx / connection reset → ORDER_PENDING; 4xx and venue envelopes unchanged", async () => {
    expect(codeOf(await caught(write(new PerpError("EXCHANGE_ERROR", "POST failed (502)", { httpStatus: 502 }))))).toBe("ORDER_PENDING");
    expect(codeOf(await caught(write(new PerpError("EXCHANGE_ERROR", "malformed JSON", { httpStatus: 200, responseUnreadable: true }))))).toBe("ORDER_PENDING");
    expect(codeOf(await caught(write(fetchFailed("ECONNRESET"))))).toBe("ORDER_PENDING");
    expect(codeOf(await caught(write(fetchFailed("ENOTFOUND"))))).toBe("ORDER_REJECTED");
    expect(codeOf(await caught(write(new PerpError("INSUFFICIENT_BALANCE", "x", { httpStatus: 400 }))))).toBe("INSUFFICIENT_BALANCE");
  });
});
