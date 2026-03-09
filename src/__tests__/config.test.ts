import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadPrivateKey, parseSolanaKeypair, isEvmPrivateKey } from "../config.js";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

describe("isEvmPrivateKey", () => {
  it("returns true for valid EVM private key", () => {
    const key = "0x" + "a".repeat(64);
    expect(isEvmPrivateKey(key)).toBe(true);
  });

  it("returns false without 0x prefix", () => {
    expect(isEvmPrivateKey("a".repeat(64))).toBe(false);
  });

  it("returns false for wrong length", () => {
    expect(isEvmPrivateKey("0x" + "a".repeat(32))).toBe(false);
  });
});

describe("parseSolanaKeypair", () => {
  it("parses base58-encoded private key", () => {
    const kp = Keypair.generate();
    const b58 = bs58.encode(kp.secretKey);
    const parsed = parseSolanaKeypair(b58);
    expect(parsed.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("parses JSON byte array format", () => {
    const kp = Keypair.generate();
    const jsonArr = JSON.stringify(Array.from(kp.secretKey));
    const parsed = parseSolanaKeypair(jsonArr);
    expect(parsed.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it("throws for invalid input", () => {
    expect(() => parseSolanaKeypair("not-a-valid-key")).toThrow("Invalid Solana private key");
  });
});

describe("loadPrivateKey", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars
    delete process.env.PACIFICA_PRIVATE_KEY;
    delete process.env.pk;
    delete process.env.HYPERLIQUID_PRIVATE_KEY;
    delete process.env.HL_PRIVATE_KEY;
    delete process.env.LIGHTER_PRIVATE_KEY;
    delete process.env.PRIVATE_KEY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns pkOverride when provided", async () => {
    const result = await loadPrivateKey("pacifica", "my-override-key");
    expect(result).toBe("my-override-key");
  });

  it("reads exchange-specific env var for pacifica", async () => {
    process.env.PACIFICA_PRIVATE_KEY = "pac-key-123";
    const result = await loadPrivateKey("pacifica");
    expect(result).toBe("pac-key-123");
  });

  it("reads exchange-specific env var for hyperliquid", async () => {
    process.env.HYPERLIQUID_PRIVATE_KEY = "hl-key-456";
    const result = await loadPrivateKey("hyperliquid");
    expect(result).toBe("hl-key-456");
  });

  it("reads HL_PRIVATE_KEY for hyperliquid", async () => {
    process.env.HL_PRIVATE_KEY = "hl-alt-key";
    const result = await loadPrivateKey("hyperliquid");
    expect(result).toBe("hl-alt-key");
  });

  it("reads LIGHTER_PRIVATE_KEY for lighter", async () => {
    process.env.LIGHTER_PRIVATE_KEY = "lighter-key-789";
    const result = await loadPrivateKey("lighter");
    expect(result).toBe("lighter-key-789");
  });

  it("falls back to PRIVATE_KEY", async () => {
    process.env.PRIVATE_KEY = "generic-key";
    const result = await loadPrivateKey("pacifica");
    expect(result).toBe("generic-key");
  });

  it("throws when no key is found", async () => {
    await expect(loadPrivateKey("pacifica")).rejects.toThrow("No private key found");
  });

  it("prefers exchange-specific over generic", async () => {
    process.env.PACIFICA_PRIVATE_KEY = "specific";
    process.env.PRIVATE_KEY = "generic";
    const result = await loadPrivateKey("pacifica");
    expect(result).toBe("specific");
  });
});
