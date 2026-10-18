/**
 * Lighter RH deposit: plan from the venue API + RPC, approve only when
 * the allowance is short, deposit(_to, 3, route, amount), master raw-digest signing.
 * Venue API (fetch) and Robinhood Chain RPC (ethers JsonRpcProvider) are mocked — nothing is sent.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Interface, SigningKey, Transaction, Wallet, parseUnits } from "ethers";

const KEY = `0x${"42".repeat(32)}`;
const DEPOSITOR = new Wallet(KEY).address;
const CONTRACT = "0x94bAB9693Ba2f6358507eFfcbd372b0660AFfF9d";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const erc20 = new Interface([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const zk = new Interface(["function deposit(address _to, uint16 _assetIndex, uint8 _routeType, uint256 _amount) payable"]);

const rpc = {
  chainId: 4663n,
  balance: parseUnits("100", 6),
  allowance: 0n,
  broadcasts: [] as Transaction[],
};

vi.mock("ethers", async (orig) => {
  const actual = await orig<typeof import("ethers")>();
  class FakeProvider {
    async send(method: string, params?: string[]): Promise<string> {
      if (method === "eth_sendRawTransaction") return (await this.broadcastTransaction(params![0])).hash;
      if (method === "eth_chainId") return `0x${rpc.chainId.toString(16)}`;
      throw new Error(`unexpected rpc ${method}`);
    }
    async call(tx: { to: string; data: string }): Promise<string> {
      const sel = tx.data.slice(0, 10);
      if (sel === erc20.getFunction("balanceOf")!.selector) return erc20.encodeFunctionResult("balanceOf", [rpc.balance]);
      if (sel === erc20.getFunction("allowance")!.selector) return erc20.encodeFunctionResult("allowance", [rpc.allowance]);
      throw new Error(`unexpected call ${sel}`);
    }
    async estimateGas(): Promise<bigint> { return 100_000n; }
    async getFeeData(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> { return { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }; }
    async getBalance(): Promise<bigint> { return 10n ** 18n; }
    async getTransactionCount(): Promise<number> { return rpc.broadcasts.length; }
    async broadcastTransaction(raw: string): Promise<{ hash: string }> {
      const tx = actual.Transaction.from(raw);
      rpc.broadcasts.push(tx);
      return { hash: tx.hash as string };
    }
    async waitForTransaction(): Promise<{ status: number }> { return { status: 1 }; }
  }
  return { ...actual, JsonRpcProvider: FakeProvider };
});

const { planLighterRhDeposit, executeLighterRhDeposit } = await import("../../exchanges/lighter-rh-deposit.js");

function apiFetch(overrides: { symbol?: string; contracts?: unknown; chainId?: number; token?: string } = {}) {
  return vi.fn(async (url: string) => {
    const u = String(url);
    if (u.startsWith("https://api.rh.lighter.xyz/api/v1/layer1BasicInfo")) {
      return new Response(JSON.stringify({
        code: 200, l1_providers: [{ chainId: overrides.chainId ?? 4663, networkId: overrides.chainId ?? 4663 }],
        contract_addresses: overrides.contracts ?? [{ name: "ZkLighterContract", address: CONTRACT }, { name: "USDCContract", address: USDG }],
      }));
    }
    if (u.startsWith("https://api.rh.lighter.xyz/api/v1/assetDetails?asset_id=3")) {
      return new Response(JSON.stringify({
        code: 200, asset_details: [{ asset_id: 3, symbol: overrides.symbol ?? "USDG", l1_decimals: 6, decimals: 6, l1_address: overrides.token ?? USDG }],
      }));
    }
    throw new Error(`unexpected fetch ${u}`);
  });
}

const sign = async (tx: Transaction): Promise<string> => new SigningKey(KEY).sign(tx.unsignedHash).serialized;

beforeEach(() => {
  rpc.chainId = 4663n; rpc.balance = parseUnits("100", 6); rpc.allowance = 0n; rpc.broadcasts = [];
  vi.stubGlobal("fetch", apiFetch());
});
afterEach(() => vi.unstubAllGlobals());

describe("planLighterRhDeposit", () => {
  it("resolves contract / USDG / chain from the venue API and needs an approve when allowance is short", async () => {
    const plan = await planLighterRhDeposit({ network: "mainnet", amount: "5", depositor: DEPOSITOR, routeType: 0 });
    expect(plan).toMatchObject({
      chainId: 4663, contract: CONTRACT, token: USDG, asset: "USDG", assetIndex: 3, decimals: 6,
      amountRaw: 5_000_000n, needsApprove: true, rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    });
  });

  it("testnet → CAPABILITY_UNSUPPORTED without touching the network", async () => {
    const f = apiFetch();
    vi.stubGlobal("fetch", f);
    await expect(planLighterRhDeposit({ network: "testnet", amount: "5", depositor: DEPOSITOR, routeType: 0 }))
      .rejects.toMatchObject({ structured: { code: "CAPABILITY_UNSUPPORTED" } });
    expect(f).not.toHaveBeenCalled();
  });

  it("below the 1 USDG minimum → SIZE_TOO_SMALL", async () => {
    await expect(planLighterRhDeposit({ network: "mainnet", amount: "0.5", depositor: DEPOSITOR, routeType: 0 }))
      .rejects.toMatchObject({ structured: { code: "SIZE_TOO_SMALL" } });
  });

  it("an amount with more decimals than the token has → INVALID_PARAMS (not a raw ethers error); nothing is read from the chain", async () => {
    const err = await planLighterRhDeposit({ network: "mainnet", amount: "5.1234567", depositor: DEPOSITOR, routeType: 0 }).catch(e => e);
    expect(err.structured).toMatchObject({ code: "INVALID_PARAMS", details: { exchange: "lighter-rh" } });
    expect(err.message).toMatch(/at most 6 decimals/);
    // The exact maximum precision still plans.
    await expect(planLighterRhDeposit({ network: "mainnet", amount: "5.123456", depositor: DEPOSITOR, routeType: 0 })).resolves.toMatchObject({ amountRaw: 5_123_456n });
  });

  it("no master address → NO_SIGNER_AVAILABLE", async () => {
    await expect(planLighterRhDeposit({ network: "mainnet", amount: "5", depositor: "", routeType: 0 }))
      .rejects.toMatchObject({ structured: { code: "NO_SIGNER_AVAILABLE" } });
  });

  it("collateral asset mismatch / missing contract / RPC chain mismatch → EXCHANGE_ERROR", async () => {
    vi.stubGlobal("fetch", apiFetch({ symbol: "USDC" }));
    await expect(planLighterRhDeposit({ network: "mainnet", amount: "5", depositor: DEPOSITOR, routeType: 0 }))
      .rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    vi.stubGlobal("fetch", apiFetch({ contracts: [] }));
    await expect(planLighterRhDeposit({ network: "mainnet", amount: "5", depositor: DEPOSITOR, routeType: 0 }))
      .rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    vi.stubGlobal("fetch", apiFetch());
    rpc.chainId = 1n;
    await expect(planLighterRhDeposit({ network: "mainnet", amount: "5", depositor: DEPOSITOR, routeType: 0 }))
      .rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
  });

  it("pinned addresses (H4): the venue definition pins contract, USDG token and chainId 4663", async () => {
    const { getVenue } = await import("../../exchanges/venue.js");
    await import("../../exchanges/venues/index.js");
    expect(getVenue("lighter-rh").networks.mainnet.depositPins).toMatchObject({ chainId: 4663, contract: CONTRACT, token: USDG });
  });

  it("API disagrees with the pinned contract / token / chain → EXCHANGE_ERROR before any RPC read", async () => {
    const OTHER = `0x${"66".repeat(20)}`;
    for (const o of [
      { contracts: [{ name: "ZkLighterContract", address: OTHER }] },
      { token: OTHER },
      { chainId: 1 },
    ]) {
      vi.stubGlobal("fetch", apiFetch(o));
      await expect(planLighterRhDeposit({ network: "mainnet", amount: "5", depositor: DEPOSITOR, routeType: 0 }))
        .rejects.toMatchObject({ structured: { code: "EXCHANGE_ERROR" } });
    }
  });

  it("insufficient USDG on the wallet → INSUFFICIENT_BALANCE", async () => {
    rpc.balance = parseUnits("1", 6);
    await expect(planLighterRhDeposit({ network: "mainnet", amount: "5", depositor: DEPOSITOR, routeType: 0 }))
      .rejects.toMatchObject({ structured: { code: "INSUFFICIENT_BALANCE" } });
  });
});

describe("executeLighterRhDeposit", () => {
  it("approve(exact amount) then deposit(_to, 3, route, amount), signed by the depositor", async () => {
    const plan = await planLighterRhDeposit({ network: "mainnet", amount: "5", depositor: DEPOSITOR, routeType: 0 });
    const res = await executeLighterRhDeposit(plan, sign);
    expect(rpc.broadcasts).toHaveLength(2);
    const [approve, dep] = rpc.broadcasts;
    expect(approve.to).toBe(USDG);
    expect(approve.from).toBe(DEPOSITOR);
    expect(approve.chainId).toBe(4663n);
    const [spender, amt] = erc20.decodeFunctionData("approve", approve.data);
    expect(spender).toBe(CONTRACT);
    expect(amt).toBe(5_000_000n);
    expect(dep.to).toBe(CONTRACT);
    const [to, assetIndex, route, amount] = zk.decodeFunctionData("deposit", dep.data);
    expect([to, Number(assetIndex), Number(route), amount]).toEqual([DEPOSITOR, 3, 0, 5_000_000n]);
    expect(res.approveTxHash).toBe(approve.hash);
    expect(res.depositTxHash).toBe(dep.hash);
  });

  it("skips the approve when the allowance already covers the amount", async () => {
    rpc.allowance = parseUnits("10", 6);
    const plan = await planLighterRhDeposit({ network: "mainnet", amount: "5", depositor: DEPOSITOR, routeType: 1 });
    expect(plan.needsApprove).toBe(false);
    const res = await executeLighterRhDeposit(plan, sign);
    expect(res.approveTxHash).toBeNull();
    expect(rpc.broadcasts).toHaveLength(1);
    expect(Number(zk.decodeFunctionData("deposit", rpc.broadcasts[0].data)[2])).toBe(1);
  });

  it("a signature from another key is refused before broadcast", async () => {
    const plan = await planLighterRhDeposit({ network: "mainnet", amount: "5", depositor: DEPOSITOR, routeType: 0 });
    const wrong = async (tx: Transaction): Promise<string> => new SigningKey(`0x${"07".repeat(32)}`).sign(tx.unsignedHash).serialized;
    await expect(executeLighterRhDeposit(plan, wrong)).rejects.toMatchObject({ structured: { code: "SIGNATURE_FAILED" } });
    expect(rpc.broadcasts).toHaveLength(0);
  });
});

describe("OwsEvmSigner.signTransaction (L9: no raw-digest API)", () => {
  const unsigned = (): Transaction => Transaction.from({
    type: 2, chainId: 4663n, nonce: 0, to: CONTRACT, data: "0x", value: 0n, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n,
  });

  it("hashes the unsigned tx itself and signs that digest via OWS signHash", async () => {
    const signHash = vi.fn(() => ({ signature: "ab".repeat(64), recoveryId: 1 }));
    vi.doMock("../../signer/ows-loader.js", () => ({
      loadOws: () => ({
        getWallet: () => ({ accounts: [{ chainId: "eip155:1", address: DEPOSITOR }] }),
        signHash,
      }),
    }));
    const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
    const s = OwsEvmSigner.create("master", "pp");
    const tx = unsigned();
    expect(await s.signTransaction(tx)).toBe(`0x${"ab".repeat(64)}1c`);
    expect(signHash).toHaveBeenCalledWith("master", "ethereum", tx.unsignedHash, "pp");
    expect("signDigest" in s).toBe(false);
    vi.doUnmock("../../signer/ows-loader.js");
  });

  it("refuses an already-signed tx and a tx without chainId", async () => {
    const { unsignedTxDigest } = await import("../../signer/ows-evm.js");
    const signed = unsigned();
    signed.signature = new SigningKey(KEY).sign(signed.unsignedHash);
    expect(() => unsignedTxDigest(signed)).toThrow(/already signed/);
    const noChain = Transaction.from({ type: 2, nonce: 0, to: CONTRACT, data: "0x", value: 0n, gasLimit: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    expect(() => unsignedTxDigest(noChain)).toThrow(/chainId/);
  });
});

describe("deposit selector (apidocs.lighter.xyz: \"the `deposit` method (0x8a857083)\")", () => {
  it("the ABI encodes the documented selector — _assetIndex is uint16", () => {
    expect(zk.getFunction("deposit")!.selector).toBe("0x8a857083");
  });
});
