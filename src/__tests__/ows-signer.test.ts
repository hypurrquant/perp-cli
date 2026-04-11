import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Fake OWS native module ──
//
// `OwsEvmSigner`/`OwsSolanaSigner` both go through `signer/ows-loader.ts`
// to reach `@open-wallet-standard/core`. We mock the loader so no real vault
// or NAPI binding is touched during tests.

const fakeOws = {
  getWallet: vi.fn(),
  signTypedData: vi.fn(),
  signMessage: vi.fn(),
  signTransaction: vi.fn(),
};

vi.mock("../signer/ows-loader.js", () => ({
  loadOws: () => fakeOws,
}));

// Imports below must come AFTER the vi.mock so the mock is in place.
import { OwsEvmSigner } from "../signer/ows-evm.js";
import { OwsSolanaSigner } from "../signer/ows-solana.js";

const EVM_ADDRESS = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
const SOL_ADDRESS = "11111111111111111111111111111111";

beforeEach(() => {
  fakeOws.getWallet.mockReset();
  fakeOws.signTypedData.mockReset();
  fakeOws.signMessage.mockReset();
  fakeOws.signTransaction.mockReset();
});

// ── OwsEvmSigner.create ──

describe("OwsEvmSigner.create", () => {
  it("picks the first eip155 account from the wallet", () => {
    fakeOws.getWallet.mockReturnValue({
      accounts: [
        { chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: SOL_ADDRESS },
        { chainId: "eip155:42161", address: EVM_ADDRESS },
      ],
    });
    const signer = OwsEvmSigner.create("my-wallet");
    expect(signer.getAddress()).toBe(EVM_ADDRESS);
    expect(fakeOws.getWallet).toHaveBeenCalledWith("my-wallet");
  });

  it("throws when the wallet has no EVM account", () => {
    fakeOws.getWallet.mockReturnValue({
      accounts: [{ chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: SOL_ADDRESS }],
    });
    expect(() => OwsEvmSigner.create("sol-only")).toThrow(/has no EVM account/);
  });
});

// ── OwsEvmSigner.signTypedData ──

describe("OwsEvmSigner.signTypedData", () => {
  function makeSigner(): OwsEvmSigner {
    fakeOws.getWallet.mockReturnValue({
      accounts: [{ chainId: "eip155:42161", address: EVM_ADDRESS }],
    });
    return OwsEvmSigner.create("w", "passphrase-xyz");
  }

  it("serializes EIP712Domain with inferred types and calls OWS", async () => {
    fakeOws.signTypedData.mockReturnValue({
      signature: "0x" + "aa".repeat(64),
      recoveryId: 0,
    });
    const signer = makeSigner();

    await signer.signTypedData(
      { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
      { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
      { source: "a", connectionId: "0x" + "ab".repeat(32) },
    );

    expect(fakeOws.signTypedData).toHaveBeenCalledTimes(1);
    const [walletName, chain, typedDataJson, passphrase] = fakeOws.signTypedData.mock.calls[0];
    expect(walletName).toBe("w");
    expect(chain).toBe("evm");
    expect(passphrase).toBe("passphrase-xyz");

    const parsed = JSON.parse(typedDataJson as string);
    expect(parsed.primaryType).toBe("Agent");
    expect(parsed.domain.chainId).toBe(1337);
    // EIP712Domain entries use the inferred type map
    const domainTypes = parsed.types.EIP712Domain as Array<{ name: string; type: string }>;
    expect(domainTypes).toEqual([
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
    ]);
  });

  it("assembles a 65-byte signature: hex(sig) + hex(recoveryId+27)", async () => {
    fakeOws.signTypedData.mockReturnValue({
      signature: "aa".repeat(64), // no 0x prefix
      recoveryId: 1,
    });
    const signer = makeSigner();
    const sig = await signer.signTypedData({}, { Agent: [] }, {});
    // prefix added automatically, and v = 1 + 27 = 28 = 0x1c
    expect(sig).toBe("0x" + "aa".repeat(64) + "1c");
    // "0x" (2) + r+s hex (128) + v hex (2) = 132 chars = 65 raw bytes
    expect(sig.length).toBe(2 + 128 + 2);
  });

  it("defaults v to 27 when recoveryId is undefined", async () => {
    fakeOws.signTypedData.mockReturnValue({ signature: "0x" + "bb".repeat(64) });
    const signer = makeSigner();
    const sig = await signer.signTypedData({}, { Agent: [] }, {});
    expect(sig.endsWith("1b")).toBe(true); // 27 → 0x1b
  });
});

// ── OwsEvmSigner.signMessage ──

describe("OwsEvmSigner.signMessage", () => {
  function makeSigner(): OwsEvmSigner {
    fakeOws.getWallet.mockReturnValue({
      accounts: [{ chainId: "eip155:42161", address: EVM_ADDRESS }],
    });
    return OwsEvmSigner.create("w");
  }

  it("uses utf8 encoding for string messages", async () => {
    fakeOws.signMessage.mockReturnValue({ signature: "0x" + "cc".repeat(64), recoveryId: 0 });
    const signer = makeSigner();
    await signer.signMessage("hello");
    const [, , payload, , encoding] = fakeOws.signMessage.mock.calls[0];
    expect(payload).toBe("hello");
    expect(encoding).toBe("utf8");
  });

  it("uses hex encoding for Uint8Array messages", async () => {
    fakeOws.signMessage.mockReturnValue({ signature: "0x" + "dd".repeat(64), recoveryId: 0 });
    const signer = makeSigner();
    await signer.signMessage(new Uint8Array([0x01, 0x02, 0xfe]));
    const [, , payload, , encoding] = fakeOws.signMessage.mock.calls[0];
    expect(payload).toBe("0102fe");
    expect(encoding).toBe("hex");
  });
});

// ── OwsSolanaSigner.create ──

describe("OwsSolanaSigner.create", () => {
  it("picks the first solana account from the wallet", () => {
    fakeOws.getWallet.mockReturnValue({
      accounts: [
        { chainId: "eip155:42161", address: EVM_ADDRESS },
        { chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: SOL_ADDRESS },
      ],
    });
    const signer = OwsSolanaSigner.create("my-wallet");
    expect(signer.getPublicKeyBase58()).toBe(SOL_ADDRESS);
  });

  it("throws when the wallet has no Solana account", () => {
    fakeOws.getWallet.mockReturnValue({
      accounts: [{ chainId: "eip155:42161", address: EVM_ADDRESS }],
    });
    expect(() => OwsSolanaSigner.create("evm-only")).toThrow(/has no Solana account/);
  });
});

// ── OwsSolanaSigner.signMessage ──

describe("OwsSolanaSigner.signMessage", () => {
  it("passes a hex-encoded payload to OWS and returns bytes", async () => {
    fakeOws.getWallet.mockReturnValue({
      accounts: [{ chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: SOL_ADDRESS }],
    });
    fakeOws.signMessage.mockReturnValue({
      signature: "0102030405060708090a0b0c0d0e0f10" + "1112131415161718191a1b1c1d1e1f20" + "2122232425262728292a2b2c2d2e2f30" + "3132333435363738393a3b3c3d3e3f40",
    });
    const signer = OwsSolanaSigner.create("w");
    const sig = await signer.signMessage(new Uint8Array([0xaa, 0xbb, 0xcc]));

    const [, chain, payload, , encoding] = fakeOws.signMessage.mock.calls[0];
    expect(chain).toBe("solana");
    expect(payload).toBe("aabbcc");
    expect(encoding).toBe("hex");
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    expect(sig[0]).toBe(0x01);
    expect(sig[63]).toBe(0x40);
  });

  it("strips a leading 0x from the returned signature hex", async () => {
    fakeOws.getWallet.mockReturnValue({
      accounts: [{ chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: SOL_ADDRESS }],
    });
    fakeOws.signMessage.mockReturnValue({
      signature: "0x" + "ff".repeat(64),
    });
    const signer = OwsSolanaSigner.create("w");
    const sig = await signer.signMessage(new Uint8Array([1]));
    expect(sig.length).toBe(64);
    expect(sig.every(b => b === 0xff)).toBe(true);
  });
});

// ── OwsSolanaSigner.signTransactionBytes ──

describe("OwsSolanaSigner.signTransactionBytes", () => {
  it("hex-encodes tx bytes and calls ows.signTransaction", () => {
    fakeOws.getWallet.mockReturnValue({
      accounts: [{ chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: SOL_ADDRESS }],
    });
    fakeOws.signTransaction.mockReturnValue({ signature: "0x" + "12".repeat(64) });
    const signer = OwsSolanaSigner.create("w");
    const out = signer.signTransactionBytes(new Uint8Array([0x0a, 0x0b]));

    const [, chain, hex] = fakeOws.signTransaction.mock.calls[0];
    expect(chain).toBe("solana");
    expect(hex).toBe("0a0b");
    expect(out.length).toBe(64);
    expect(out[0]).toBe(0x12);
  });

  it("rejects in-place sign/partialSign because OWS does not expose raw keypairs", () => {
    fakeOws.getWallet.mockReturnValue({
      accounts: [{ chainId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", address: SOL_ADDRESS }],
    });
    const signer = OwsSolanaSigner.create("w");
    expect(() => signer.signTransaction({ sign: () => {} })).toThrow(/does not support in-place tx\.sign/);
    expect(() => signer.partialSignTransaction({ partialSign: () => {} })).toThrow(/does not support in-place tx\.partialSign/);
  });
});
