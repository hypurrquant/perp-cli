/**
 * TxFlow signing (docs.txflow.com/api/signing) and the POST /exchange outcome classes.
 *
 * The byte-level vectors below are the docs' own "Test vectors" (throwaway key 0xabab…ab,
 * testnet domain): the order msgpack bytes, connectionId, signingHash and r / s / v, and the
 * approveAgent structHash / signingHash / r / s / v. The domain separators are the docs' table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet, TypedDataEncoder, hexlify } from "ethers";
import { PerpError } from "../../errors.js";
import {
  nextTxflowNonce, signTxflowAgentAction, signTxflowApproveAgent, txflowActionPack, txflowApproveAgentAction, txflowConnectionId,
  txflowDomain, txflowOrderBody, TXFLOW_AGENT_TYPES, TXFLOW_APPROVE_AGENT_TYPES, type TxflowAgentAction, type TxflowOrderAction,
} from "../../exchanges/txflow/signing.js";
import { TxflowClient, TxflowSendUnknown, TXFLOW_APPLY_URL } from "../../exchanges/txflow/client.js";
import { TXFLOW_API_VERSION } from "../../exchanges/venues/txflow.js";
import type { EvmSigner } from "../../signer/interface.js";

/** The docs' throwaway key (address 0xe239cdc5fbe977a8a141b72194d3cf8c41bc5bc6). */
const DOC_KEY = `0x${"ab".repeat(32)}`;

function walletSigner(key: string): EvmSigner {
  const w = new Wallet(key);
  return {
    getAddress: () => w.address,
    signTypedData: (d, t, v) => w.signTypedData(d, t, v),
    signMessage: m => w.signMessage(m),
  };
}

const DOC_ORDER: TxflowOrderAction = {
  type: "order",
  grouping: "na",
  orders: [{ a: 1, b: true, p: "50000.0", s: "0.01", r: false, t: { limit: { tif: "Gtc" } } } as unknown as TxflowOrderAction["orders"][number]],
};

describe("domain (docs: Signing § Domain)", () => {
  it("mainnet / testnet domain separators match the docs table", () => {
    expect(TypedDataEncoder.hashDomain(txflowDomain("mainnet"))).toBe("0x878a21f7c464d592bad925771b5ab6f52897c4321b30eb6cfdf4ea55c749ad8d");
    expect(TypedDataEncoder.hashDomain(txflowDomain("testnet"))).toBe("0x839dd579adc05b1545a37213db5dd3dc6928532ddf73dfa1b53f647421060a8f");
    expect(txflowDomain("mainnet")).toEqual({ name: "TxFlow-Mainnet", version: "1", chainId: 869, verifyingContract: "0x0000000000000000000000000000000000000000" });
    expect(txflowDomain("testnet")).toEqual({ name: "TxFlow-Testnet", version: "1", chainId: 2511, verifyingContract: "0x0000000000000000000000000000000000000000" });
  });
});

describe("agent signing — the docs' order vector", () => {
  it("msgpack drops `type`, keeps the node's key order, compact ints, strings as written", async () => {
    expect(hexlify(await txflowActionPack(DOC_ORDER))).toBe(
      "0x82a867726f7570696e67a26e61a66f72646572739186a16101a162c3a170a735303030302e30a173a4302e3031a172c2a17481a56c696d697481a3746966a3477463");
  });

  it("connectionId = keccak(msgpack ‖ nonce BE8 ‖ 0x00)", async () => {
    expect(await txflowConnectionId(DOC_ORDER, 1_700_000_000_000)).toBe("0x6546d1c3acf430a28a0b2552c66e985f6543646660874734732ae9e9daf4d806");
  });

  it("Agent signingHash and r / s / v", async () => {
    const signer = walletSigner(DOC_KEY);
    expect(signer.getAddress().toLowerCase()).toBe("0xe239cdc5fbe977a8a141b72194d3cf8c41bc5bc6");
    const connectionId = await txflowConnectionId(DOC_ORDER, 1_700_000_000_000);
    const digest = TypedDataEncoder.hash(txflowDomain("testnet"), TXFLOW_AGENT_TYPES, { txflowNetwork: "TxFlow-Testnet", chainId: 2511, apiVersion: 1, connectionId });
    expect(digest).toBe("0xeae1ae63709636fb9567accd33bc5dd2717bfac4d97e9a853f91c7fb391e1cc6");
    const sig = await signTxflowAgentAction(signer, "testnet", DOC_ORDER, 1_700_000_000_000);
    expect(sig).toEqual({
      r: "0x4064848dd881985c52dacdc00f7046f1010f7f370e34620d36fcf3b2d1ecb3e0",
      s: "0x25c45ad67b9506ac653fc3658f47aa8b6002bfa86a31ae619b334d71aa8b4f6f",
      v: 27,
    });
  });

  it("a price written differently signs differently (\"50000.0\" ≠ \"50000\")", async () => {
    const other = { ...DOC_ORDER, orders: [{ ...DOC_ORDER.orders[0], p: "50000" }] };
    expect(await txflowConnectionId(other, 1_700_000_000_000)).not.toBe(await txflowConnectionId(DOC_ORDER, 1_700_000_000_000));
  });
});

describe("direct EIP-712 — the docs' approveAgent vector", () => {
  it("structHash, signingHash and r / s / v", async () => {
    const action = txflowApproveAgentAction("testnet", "0x0202020202020202020202020202020202020202", "my-trading-bot", 2000);
    expect(action).toEqual({
      type: "approveAgent", txflowNetwork: "TxFlow-Testnet", chainId: 2511, apiVersion: 1,
      agentAddress: "0x0202020202020202020202020202020202020202", agentName: "my-trading-bot", nonce: 2000,
    });
    const message = { txflowNetwork: "TxFlow-Testnet", chainId: 2511, apiVersion: 1, agentAddress: action.agentAddress, agentName: action.agentName, nonce: 2000 };
    expect(TypedDataEncoder.from(TXFLOW_APPROVE_AGENT_TYPES).hash(message)).toBe("0xbb5293971660f3252f455b6debbda781841fb23bd45cbbf0199c4de5250573b9");
    expect(TypedDataEncoder.hash(txflowDomain("testnet"), TXFLOW_APPROVE_AGENT_TYPES, message)).toBe("0x1df22801b48ae1402ad36b244aa245fd6e842fa5fef2c40819b1e6c661cd2212");
    expect(await signTxflowApproveAgent(walletSigner(DOC_KEY), "testnet", action)).toEqual({
      r: "0x4431d4afb9fcd0dcd619afd55a7044cc26cb0ee1d436a1b06d836da217842ead",
      s: "0x54a0755ee3d8c241235a1828a2be732d72e9c152b5de25fc7c169966de4210f7",
      v: 27,
    });
  });

  it("mainnet approveAgent carries TxFlow-Mainnet / 869; a label over 64 characters is refused", () => {
    const a = txflowApproveAgentAction("mainnet", "0x0202020202020202020202020202020202020202", "x", 5);
    expect([a.txflowNetwork, a.chainId, a.apiVersion]).toEqual(["TxFlow-Mainnet", 869, 1]);
    expect(() => txflowApproveAgentAction("mainnet", a.agentAddress, "y".repeat(65), 5)).toThrow(/at most 64/);
  });
});

describe("signature checks before anything is sent", () => {
  it("a high-S signature is refused (SIGNATURE_FAILED)", async () => {
    const real = walletSigner(DOC_KEY);
    const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highS: EvmSigner = {
      ...real,
      async signTypedData(d, t, v) {
        const { Signature } = await import("ethers");
        const s = Signature.from(await real.signTypedData(d, t, v));
        const flipped = (n - BigInt(s.s)).toString(16).padStart(64, "0");
        return `${s.r}${flipped}${(s.v === 27 ? 28 : 27).toString(16)}`;
      },
    };
    await expect(signTxflowAgentAction(highS, "testnet", DOC_ORDER, 1)).rejects.toMatchObject({ structured: { code: "SIGNATURE_FAILED" } });
  });

  it("a signature that does not recover to the signer is refused", async () => {
    const other = walletSigner(`0x${"cd".repeat(32)}`);
    const liar: EvmSigner = { ...walletSigner(DOC_KEY), signTypedData: (d, t, v) => other.signTypedData(d, t, v) };
    await expect(signTxflowAgentAction(liar, "testnet", DOC_ORDER, 1)).rejects.toMatchObject({ structured: { code: "SIGNATURE_FAILED" } });
  });
});

describe("action building (node key order, null fields omitted)", () => {
  it("limit body: a, b, p, s, r, t, c — no m / expiresAt", () => {
    const b = txflowOrderBody({ asset: 1, isBuy: false, price: "79000", size: "0.01", reduceOnly: true, type: { limit: { tif: "Alo" } }, cloid: "p1" });
    expect(Object.keys(b)).toEqual(["a", "b", "p", "s", "r", "t", "c"]);
    expect(b).toEqual({ a: 1, b: false, p: "79000", s: "0.01", r: true, t: { limit: { tif: "Alo" } }, c: "p1" });
  });

  it("trigger body keeps isMarket, triggerPx, tpsl; tpsl omitted when absent", () => {
    const withTag = txflowOrderBody({ asset: 2, isBuy: false, price: "60000", size: "1", reduceOnly: true, type: { trigger: { isMarket: true, triggerPx: "60000", tpsl: "sl" } }, cloid: "p2" });
    expect(Object.keys((withTag.t as { trigger: object }).trigger)).toEqual(["isMarket", "triggerPx", "tpsl"]);
    const noTag = txflowOrderBody({ asset: 2, isBuy: false, price: "60000", size: "1", reduceOnly: true, type: { trigger: { isMarket: false, triggerPx: "60000" } }, cloid: "p2" });
    expect(Object.keys((noTag.t as { trigger: object }).trigger)).toEqual(["isMarket", "triggerPx"]);
  });

  it("cancel / modify2 / leverage / margin-mode packs are deterministic (throwaway-key vectors, NOT venue-validated)", async () => {
    const signer = walletSigner(Wallet.createRandom().privateKey);
    const actions: TxflowAgentAction[] = [
      { type: "cancel", cancels: [{ a: 1, o: 123456789 }, { a: 1, o: 5, grouping: "trigger" }] },
      { type: "modify2", order: { o: 444555666, p: "52000.0", s: "0.03" } },
      { type: "updateLeverage", asset: 1, leverage: 20, marginMode: "cross" },
      { type: "updateMarginMode", asset: 1, isCross: true },
    ];
    // Hand-decoded: the docs' request examples' key order is kept, `type` is dropped, ints are
    // compact (fixint 1 / 5 / 20, uint32 0xce for 123456789 and 444555666), bools native.
    expect(hexlify(await txflowActionPack(actions[0]))).toBe(
      "0x81a763616e63656c739282a16101a16fce075bcd1583a16101a16f05a867726f7570696e67a774726967676572");
    expect(hexlify(await txflowActionPack(actions[1]))).toBe("0x81a56f7264657283a16fce1a7f6192a170a735323030302e30a173a4302e3033");
    expect(hexlify(await txflowActionPack(actions[2]))).toBe("0x83a5617373657401a86c6576657261676514aa6d617267696e4d6f6465a563726f7373");
    expect(hexlify(await txflowActionPack(actions[3]))).toBe("0x82a5617373657401a7697343726f7373c3");
    for (const a of actions) {
      const s1 = await signTxflowAgentAction(signer, "testnet", a, 1_757_992_743_994);
      const s2 = await signTxflowAgentAction(signer, "testnet", a, 1_757_992_743_994);
      expect(s1).toEqual(s2);
      expect([27, 28]).toContain(s1.v);
    }
  });

  it("nonces are millisecond timestamps, strictly increasing in-process", () => {
    const a = nextTxflowNonce(1_000);
    const b = nextTxflowNonce(1_000);
    expect(b).toBeGreaterThan(a);
    expect(nextTxflowNonce(Date.now())).toBeGreaterThan(b);
  });
});

// ── POST /exchange outcome classes ──

const RL = { capacity: 100, refillPerSec: 100, weights: null };
const REQ = { action: { type: "order" }, signature: { r: "0x1", s: "0x2", v: 27 }, nonce: 1 };

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers });
}

describe("TxflowClient.exchange — accepted / rejected / unknown", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => { fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const client = () => new TxflowClient("https://rpc.example", RL);
  const send = (net: "mainnet" | "testnet" = "testnet") => client().exchange(REQ, "place order", "ORDER_REJECTED", net);

  it("sends the envelope with confirm: executed and x-api-version; an executed success resolves", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: "ok", code: 0, data: { type: "PlaceOrder", data: { statuses: ["success"] } } }));
    await expect(send()).resolves.toEqual({ type: "PlaceOrder" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://rpc.example/exchange");
    expect((init.headers as Record<string, string>)["x-api-version"]).toBe(TXFLOW_API_VERSION);
    expect(JSON.parse(init.body as string)).toEqual({ ...REQ, vaultAddress: null, signatureChainId: null, confirm: "executed" });
  });

  it("status err → ORDER_REJECTED, sent:false, with the venue message and code", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: "err", code: 10000, message: "Price precision does not match the tick size: 0.1" }));
    const e = await send().catch(x => x) as PerpError;
    expect(e.structured.code).toBe("ORDER_REJECTED");
    expect(e.message).toMatch(/tick size: 0\.1/);
    expect(e.structured.details).toMatchObject({ sent: false, venueCode: 10000 });
  });

  it("an executed failure (statuses [{error}]) is a definite rejection", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: "ok", code: 0, data: { type: "PlaceOrder", data: { statuses: [{ error: "Insufficient margin in account" }] } } }));
    await expect(send()).rejects.toMatchObject({ structured: { code: "ORDER_REJECTED", details: { sent: false } } });
  });

  it("mainnet whitelist refusal → POLICY_DENIED with the apply link (message, gateway `response`, HTTP 403)", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: "err", code: 10000, message: "User not in whitelist" }));
    const e1 = await send("mainnet").catch(x => x) as PerpError;
    expect(e1.structured.code).toBe("POLICY_DENIED");
    expect(e1.structured.remediation).toContain(TXFLOW_APPLY_URL);
    fetchMock.mockResolvedValueOnce(respond(403, { status: "err", code: 10000, response: "This action is not allowed." }));
    expect((await send("mainnet").catch(x => x) as PerpError).structured.code).toBe("POLICY_DENIED");
    fetchMock.mockResolvedValueOnce(respond(403, "<html>Forbidden</html>"));
    const e3 = await send("mainnet").catch(x => x) as PerpError;
    expect(e3.structured.code).toBe("POLICY_DENIED");
    expect(e3.structured.details).toMatchObject({ sent: false });
  });

  it("an unfunded account → DEPOSIT_REQUIRED; an unapproved agent → AGENT_NOT_REGISTERED", async () => {
    fetchMock.mockResolvedValueOnce(respond(200, { status: "err", code: 1, message: "No trading account found. Please deposit first." }));
    expect((await send().catch(x => x) as PerpError).structured.code).toBe("DEPOSIT_REQUIRED");
    fetchMock.mockResolvedValueOnce(respond(200, { status: "err", code: 1, message: "Agent 0xabc is not authorized by any account" }));
    expect((await send().catch(x => x) as PerpError).structured.code).toBe("AGENT_NOT_REGISTERED");
  });

  it("HTTP 429 → RATE_LIMITED, sent:false (a rate-limited action did not execute)", async () => {
    fetchMock.mockResolvedValueOnce(respond(429, { status: "err", code: 1, response: "rate limit exceeded" }, { "retry-after": "1" }));
    await expect(send()).rejects.toMatchObject({ structured: { code: "RATE_LIMITED", details: { sent: false } } });
  });

  it("HTTP 202 pending, async traceId ack, 5xx, malformed success, transport reset → TxflowSendUnknown", async () => {
    const cases: Array<() => unknown> = [
      () => respond(202, { status: "pending", txHash: "0xfeed" }),
      () => respond(200, { status: "ok", traceId: "t-1" }),
      () => respond(502, "<html>bad gateway</html>"),
      () => respond(200, { status: "ok", code: 0, data: { type: "PlaceOrder", data: { statuses: [] } } }),
      () => respond(200, { status: "ok", code: 0, data: { type: "PlaceOrder", data: { statuses: ["queued"] } } }),
      () => respond(200, "not json"),
    ];
    for (const c of cases) {
      fetchMock.mockResolvedValueOnce(c());
      await expect(send()).rejects.toBeInstanceOf(TxflowSendUnknown);
    }
    fetchMock.mockResolvedValueOnce(respond(202, { status: "pending", txHash: "0xfeed" }));
    expect((await send().catch(x => x) as TxflowSendUnknown).txHash).toBe("0xfeed");
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    await expect(send()).rejects.toBeInstanceOf(TxflowSendUnknown);
  });

  it("no connection at all → EXCHANGE_UNREACHABLE, sent:false (nothing was sent)", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) }));
    await expect(send()).rejects.toMatchObject({ structured: { code: "EXCHANGE_UNREACHABLE", details: { sent: false } } });
  });
});
