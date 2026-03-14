import { describe, it, expect } from "vitest";
import { LocalEvmSigner } from "../signer/evm-local.js";
import { LocalSolanaSigner } from "../signer/solana-local.js";

// Deterministic test key (DO NOT use in production)
const TEST_EVM_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

describe("LocalEvmSigner", () => {
  it("should derive correct address from private key", async () => {
    const signer = await LocalEvmSigner.create(TEST_EVM_PRIVATE_KEY);
    // Hardhat account #0
    expect(signer.getAddress()).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("should produce same signTypedData result as ethers.Wallet", async () => {
    const signer = await LocalEvmSigner.create(TEST_EVM_PRIVATE_KEY);
    const { ethers } = await import("ethers");
    const wallet = new ethers.Wallet(TEST_EVM_PRIVATE_KEY);

    const domain = {
      name: "Exchange",
      version: "1",
      chainId: 1337,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    };
    const types = {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    };
    const value = {
      source: "a",
      connectionId: "0x" + "ab".repeat(32),
    };

    const [signerResult, walletResult] = await Promise.all([
      signer.signTypedData(domain, types, value),
      wallet.signTypedData(domain, types, value),
    ]);

    expect(signerResult).toBe(walletResult);
  });

  it("should produce same signMessage result as ethers.Wallet", async () => {
    const signer = await LocalEvmSigner.create(TEST_EVM_PRIVATE_KEY);
    const { ethers } = await import("ethers");
    const wallet = new ethers.Wallet(TEST_EVM_PRIVATE_KEY);

    const message = "Hello, Lighter!";

    const [signerResult, walletResult] = await Promise.all([
      signer.signMessage(message),
      wallet.signMessage(message),
    ]);

    expect(signerResult).toBe(walletResult);
  });
});

describe("LocalSolanaSigner", () => {
  it("should return correct public key", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const keypair = Keypair.generate();
    const signer = new LocalSolanaSigner(keypair);

    expect(signer.getPublicKeyBase58()).toBe(keypair.publicKey.toBase58());
  });

  it("should produce same signature as nacl.sign.detached", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const nacl = await import("tweetnacl");
    const keypair = Keypair.generate();
    const signer = new LocalSolanaSigner(keypair);

    const message = new Uint8Array([1, 2, 3, 4, 5]);
    const signerResult = await signer.signMessage(message);
    const naclResult = nacl.default.sign.detached(message, keypair.secretKey);

    expect(Buffer.from(signerResult)).toEqual(Buffer.from(naclResult));
  });

  it("should delegate signTransaction to keypair", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const keypair = Keypair.generate();
    const signer = new LocalSolanaSigner(keypair);

    let signedWith: unknown = null;
    const mockTx = { sign(kp: unknown) { signedWith = kp; } };
    signer.signTransaction(mockTx);

    expect(signedWith).toBe(keypair);
  });

  it("should delegate partialSignTransaction to keypair", async () => {
    const { Keypair } = await import("@solana/web3.js");
    const keypair = Keypair.generate();
    const signer = new LocalSolanaSigner(keypair);

    let signedWith: unknown = null;
    const mockTx = { partialSign(kp: unknown) { signedWith = kp; } };
    signer.partialSignTransaction(mockTx);

    expect(signedWith).toBe(keypair);
  });
});
