import { describe, it, expect, vi } from "vitest";
import { LighterAdapter } from "../../exchanges/lighter.js";
import type { AgentMeta } from "../../settings.js";

describe("LighterAdapter.withdraw — USDC 6-decimal scaling (P0 under-scale regression)", () => {
  function makeAdapter() {
    const a = new LighterAdapter("0xabc", true);
    const signWithdraw = vi.fn().mockResolvedValue({ txType: 13, txInfo: "{}", txHash: "0x" });
    (a as unknown as { ensureSigner: () => void }).ensureSigner = () => {};
    (a as unknown as { getNextNonce: () => Promise<number> }).getNextNonce = async () => 7;
    (a as unknown as { _signer: { signWithdraw: typeof signWithdraw } })._signer = { signWithdraw } as never;
    (a as unknown as { sendTx: (s: unknown) => Promise<unknown> }).sendTx = async () => ({ ok: true });
    return { a, signWithdraw };
  }

  it("scales human USDC to smallest units (100 → 100_000_000) for the low-level signer", async () => {
    const { a, signWithdraw } = makeAdapter();
    await a.withdraw("100", "");
    expect(signWithdraw).toHaveBeenCalledTimes(1);
    const params = signWithdraw.mock.calls[0][0] as { usdcAmount: number; assetIndex: number };
    expect(params.usdcAmount).toBe(100_000_000);
    expect(params.assetIndex).toBe(3); // USDC default
  });

  it("throws rather than signing a sub-unit (dust) withdrawal", async () => {
    const { a, signWithdraw } = makeAdapter();
    await expect(a.withdraw("0.0000001", "")).rejects.toThrow(/below the minimum unit/);
    expect(signWithdraw).not.toHaveBeenCalled();
  });
});

// These cover the pure / state-machine surface of LighterAdapter that does not
// require the WASM signer or any REST call: the constructor only assigns
// fields, so an instance can be built with a dummy key and its market maps
// injected directly. The hot signing/order paths still rely on live API and
// are exercised by the integration suite.

describe("LighterAdapter.getMarketIndex", () => {
  function makeAdapter(): LighterAdapter {
    const a = new LighterAdapter("0xabc", true);
    (a as unknown as { _marketMap: Map<string, number> })._marketMap = new Map([
      ["BTC", 1],
      ["ETH", 2],
    ]);
    return a;
  }

  it("returns the market index for a known symbol", () => {
    expect(makeAdapter().getMarketIndex("BTC")).toBe(1);
    expect(makeAdapter().getMarketIndex("ETH")).toBe(2);
  });

  it("upcases the symbol before lookup (case-insensitive)", () => {
    expect(makeAdapter().getMarketIndex("btc")).toBe(1);
    expect(makeAdapter().getMarketIndex("eth")).toBe(2);
  });

  it("throws for an unknown market", () => {
    expect(() => makeAdapter().getMarketIndex("DOGE")).toThrow(/Unknown Lighter market: DOGE/);
  });
});

describe("LighterAdapter.toTicks — size/price → integer ticks", () => {
  type ToTicks = (symbol: string, size: number, price: number) => { baseAmount: number; priceTicks: number };
  function makeAdapter(): LighterAdapter {
    const a = new LighterAdapter("0xabc", true);
    // BTC: 5 size decimals (min size 0.00001), 1 price decimal (min price 0.1)
    (a as unknown as { _marketDecimals: Map<string, { size: number; price: number }> })._marketDecimals =
      new Map([["BTC", { size: 5, price: 1 }]]);
    return a;
  }
  const toTicks = (a: LighterAdapter): ToTicks =>
    (a as unknown as { toTicks: ToTicks }).toTicks.bind(a);

  it("converts size and price using the market's decimals", () => {
    const { baseAmount, priceTicks } = toTicks(makeAdapter())("BTC", 0.001, 76000);
    expect(baseAmount).toBe(100);    // 0.001 * 1e5
    expect(priceTicks).toBe(760000); // 76000 * 1e1
  });

  it("is case-insensitive on the symbol lookup", () => {
    const { baseAmount } = toTicks(makeAdapter())("btc", 0.001, 76000);
    expect(baseAmount).toBe(100);
  });

  it("rounds to the nearest integer tick", () => {
    // 0.000014 * 1e5 = 1.4 → round → 1
    const { baseAmount } = toTicks(makeAdapter())("BTC", 0.000014, 76000);
    expect(baseAmount).toBe(1);
  });

  it("throws when market decimals are not loaded for the symbol", () => {
    const a = new LighterAdapter("0xabc", true);
    expect(() => toTicks(a)("BTC", 0.001, 76000)).toThrow(/No market decimals loaded for BTC/);
  });

  it("throws when the size is below the market's precision (baseAmount rounds to 0)", () => {
    // 0.000001 * 1e5 = 0.1 → round → 0, but size > 0 → dust guard
    expect(() => toTicks(makeAdapter())("BTC", 0.000001, 76000))
      .toThrow(/Order size 0\.000001 too small for BTC \(sizeDecimals=5/);
  });

  it("throws when the price is below the market's precision (priceTicks rounds to 0)", () => {
    const a = new LighterAdapter("0xabc", true);
    (a as unknown as { _marketDecimals: Map<string, { size: number; price: number }> })._marketDecimals =
      new Map([["TINY", { size: 2, price: 1 }]]);
    // size 1 * 1e2 = 100 (ok); price 0.04 * 1e1 = 0.4 → round → 0 → guard
    expect(() => toTicks(a)("TINY", 1, 0.04))
      .toThrow(/Order price 0\.04 too small for TINY \(priceDecimals=1/);
  });
});

describe("LighterAdapter._resolveSigner / activeSignerTier — 3-tier priority", () => {
  const future = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();

  function makeMeta(expiresAt: string): AgentMeta {
    return {
      agentName: "agent1",
      agentWalletName: "wallet1",
      agentEvmAddress: "0x0000000000000000000000000000000000000000",
      userEvmAddress: "0x0000000000000000000000000000000000000000",
      expiresAt,
      apiKeyIndex: 5,
      accountIndex: 42,
    } as AgentMeta;
  }
  type ResolveSigner = () => { tier: "agent" | "master" | "pk" };
  const resolveSigner = (a: LighterAdapter): ResolveSigner =>
    (a as unknown as { _resolveSigner: ResolveSigner })._resolveSigner.bind(a);

  it("resolves 'pk' when only a constructor evmKey is supplied", () => {
    const a = new LighterAdapter("0xpk", true);
    expect(a.activeSignerTier).toBe("pk");
  });

  it("resolves 'master' (over pk) when an EVM signer was injected via setSigner", () => {
    const a = new LighterAdapter("0xpk", true);
    a.setSigner({ getAddress: () => "0xMaster" } as unknown as Parameters<LighterAdapter["setSigner"]>[0]);
    expect(a.activeSignerTier).toBe("master");
  });

  it("resolves 'agent' when a non-expired agent meta + key are set", () => {
    const a = new LighterAdapter("0xpk", true);
    a.setAgentSigner(makeMeta(future), "deadbeef");
    expect(a.activeSignerTier).toBe("agent");
  });

  it("falls back to 'pk' when the agent is expired but an evmKey exists", () => {
    const a = new LighterAdapter("0xpk", true);
    a.setAgentSigner(makeMeta(past), "deadbeef");
    expect(a.activeSignerTier).toBe("pk");
  });

  it("ignores the agent tier when the --no-agent bypass is set", () => {
    const a = new LighterAdapter("0xpk", true);
    a.setAgentSigner(makeMeta(future), "deadbeef");
    a.setNoAgent(true);
    expect(a.activeSignerTier).toBe("pk");
  });

  it("activeSignerTier returns null (no throw) for an expired agent with no master/pk fallback", () => {
    const a = new LighterAdapter("", true); // no evmKey
    a.setAgentSigner(makeMeta(past), "deadbeef");
    expect(a.activeSignerTier).toBeNull();
  });

  it("_resolveSigner throws AGENT_EXPIRED for an expired agent with no fallback", () => {
    const a = new LighterAdapter("", true);
    a.setAgentSigner(makeMeta(past), "deadbeef");
    expect(() => resolveSigner(a)()).toThrow(/expired/i);
  });

  it("_resolveSigner throws NO_SIGNER_AVAILABLE when nothing is configured", () => {
    const a = new LighterAdapter("", true);
    expect(() => resolveSigner(a)()).toThrow(/No signing path/i);
    expect(a.activeSignerTier).toBeNull();
  });
});

/**
 * Non-USDC withdrawals must refuse rather than mis-scale.
 *
 * `_withdrawRaw` hardcodes the 1e6 factor, which is USDC's scale specifically
 * (assetDetails id 3: decimals 6, l1_decimals 6). ETH (id 1) and LIT (id 2)
 * report decimals 8 with l1_decimals 18, so the same factor would sign a
 * withdrawal ~100x too small — the exact class of defect 966ffc0 fixed for USDC.
 * The correct factor is not determinable here (the docs say "the ERC20's
 * decimals" while the L2 registry carries a different `decimals`), so this is a
 * Rule #2 refusal, not a guess.
 */
describe("LighterAdapter.withdraw — non-USDC assets refuse instead of mis-scaling", () => {
  const buildAdapter = async () => {
    const mod = await import("../../exchanges/lighter.js");
    const adapter = Object.create(mod.LighterAdapter.prototype);
    adapter.ensureSigner = vi.fn();
    adapter.getNextNonce = vi.fn().mockResolvedValue(1);
    adapter.sendTx = vi.fn().mockResolvedValue({ ok: true });
    adapter._apiKeyIndex = 4;
    adapter._accountIndex = 42;
    adapter._signer = { signWithdraw: vi.fn().mockResolvedValue({ txType: 13, txInfo: "{}" }) };
    return adapter;
  };

  it("refuses asset id 1 (ETH)", async () => {
    const adapter = await buildAdapter();
    await expect(adapter.withdraw("1", "", { assetId: 1 })).rejects.toThrow(/only supports USDC/);
    expect(adapter._signer.signWithdraw).not.toHaveBeenCalled();
  });

  it("refuses asset id 2 (LIT)", async () => {
    const adapter = await buildAdapter();
    await expect(adapter.withdraw("1", "", { assetId: 2 })).rejects.toThrow(/only supports USDC/);
    expect(adapter._signer.signWithdraw).not.toHaveBeenCalled();
  });

  it("still signs USDC (asset id 3) scaled by 1e6", async () => {
    const adapter = await buildAdapter();
    await adapter.withdraw("100", "", { assetId: 3 });
    expect(adapter._signer.signWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ usdcAmount: 100_000_000, assetIndex: 3 }),
    );
  });

  it("defaults to USDC when no assetId is supplied", async () => {
    const adapter = await buildAdapter();
    await adapter.withdraw("5", "");
    expect(adapter._signer.signWithdraw).toHaveBeenCalledWith(
      expect.objectContaining({ usdcAmount: 5_000_000, assetIndex: 3 }),
    );
  });
});
