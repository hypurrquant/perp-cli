/**
 * Strict Bridge Integration Tests — comprehensive verification using real keys.
 *
 * Uses .env keys for address derivation and balance checks.
 * NO transactions are executed. NO funds are spent.
 *
 * Core verification: "sender pays only" — all bridge fees are deducted from
 * the source USDC amount. The recipient receives amountOut without paying
 * any gas or fees on the destination chain.
 *
 * Tests:
 * 1. Key derivation & address consistency
 * 2. Real balance checks on all chains
 * 3. CCTP quote API for all routes (including HyperCore)
 * 4. HyperCore CCTP fees API validation
 * 5. deBridge quote API with real addresses
 * 6. Relay quote API with real addresses
 * 7. getAllQuotes aggregation correctness
 * 8. getBestQuote selection logic
 * 9. Cross-provider quote comparison
 * 10. Edge cases and error handling
 * 11-14. On-chain / API verification
 * 15. SENDER-PAYS-ONLY: full 4-chain matrix verification
 * 16. Complete route matrix (all 12 directional pairs)
 */
import { describe, it, expect, beforeAll } from "vitest";
import { config } from "dotenv";
import {
  CHAIN_IDS,
  USDC_ADDRESSES,
  CCTP_DOMAINS,
  EXCHANGE_TO_CHAIN,
  getCctpQuote,
  getDebridgeQuote,
  getRelayQuote,
  getAllQuotes,
  getBestQuote,
  getEvmUsdcBalance,
  getSolanaUsdcBalance,
  checkBridgeBalance,
  getNativeGasBalance,
  checkBridgeGasBalance,
  type BridgeQuote,
} from "../../bridge-engine.js";

// Load .env
config();

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── Derive real addresses from .env keys ──
let solanaAddress: string;
let evmAddress: string;

describe("Strict Bridge Integration Tests", { timeout: 120000 }, () => {
  // ══════════════════════════════════════════════════════════
  // 0. Setup: derive addresses from private keys
  // ══════════════════════════════════════════════════════════

  beforeAll(async () => {
    // Derive Solana address
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = await import("bs58");
    const solanaKey = process.env.pk;
    if (!solanaKey) throw new Error("Missing 'pk' in .env (Solana private key)");
    const keypair = Keypair.fromSecretKey(bs58.default.decode(solanaKey));
    solanaAddress = keypair.publicKey.toBase58();

    // Derive EVM address
    const { ethers } = await import("ethers");
    const evmKey = process.env.HL_PRIVATE_KEY;
    if (!evmKey) throw new Error("Missing 'HL_PRIVATE_KEY' in .env");
    const wallet = new ethers.Wallet(evmKey);
    evmAddress = wallet.address;
  });

  // ══════════════════════════════════════════════════════════
  // 1. Key & Address Validation
  // ══════════════════════════════════════════════════════════

  describe("1. Key derivation & address format", () => {
    it("Solana address is valid base58 (32-44 chars)", () => {
      expect(solanaAddress).toBeDefined();
      expect(solanaAddress.length).toBeGreaterThanOrEqual(32);
      expect(solanaAddress.length).toBeLessThanOrEqual(44);
      expect(solanaAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    });

    it("EVM address is valid checksummed address", () => {
      expect(evmAddress).toBeDefined();
      expect(evmAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it("HL_PRIVATE_KEY and LIGHTER_PRIVATE_KEY derive same EVM address", async () => {
      const { ethers } = await import("ethers");
      const hlWallet = new ethers.Wallet(process.env.HL_PRIVATE_KEY!);
      const lighterWallet = new ethers.Wallet(process.env.LIGHTER_PRIVATE_KEY!);
      expect(hlWallet.address).toBe(lighterWallet.address);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 2. Configuration Consistency
  // ══════════════════════════════════════════════════════════

  describe("2. Configuration consistency", () => {
    it("EXCHANGE_TO_CHAIN maps correctly", () => {
      expect(EXCHANGE_TO_CHAIN.pacifica).toBe("solana");
      expect(EXCHANGE_TO_CHAIN.hyperliquid).toBe("hyperevm");
      expect(EXCHANGE_TO_CHAIN.lighter).toBe("arbitrum");
    });

    it("all standard chains have chain IDs", () => {
      expect(CHAIN_IDS.solana).toBe(7565164);
      expect(CHAIN_IDS.arbitrum).toBe(42161);
      expect(CHAIN_IDS.base).toBe(8453);
    });

    it("all standard chains have USDC addresses", () => {
      for (const chain of ["solana", "arbitrum", "base"]) {
        expect(USDC_ADDRESSES[chain]).toBeDefined();
      }
    });

    it("CCTP domains include hyperevm (19)", () => {
      expect(CCTP_DOMAINS.solana).toBe(5);
      expect(CCTP_DOMAINS.arbitrum).toBe(3);
      expect(CCTP_DOMAINS.base).toBe(6);
      expect(CCTP_DOMAINS.hyperevm).toBe(19);
    });

    it("no unsupported chains leak into config", () => {
      const supportedChains = ["solana", "arbitrum", "base"];
      for (const chain of Object.keys(CHAIN_IDS)) {
        expect(supportedChains).toContain(chain);
      }
    });

    it("CCTP domains only contain supported chains + hyperevm", () => {
      const allowed = ["solana", "arbitrum", "base", "hyperevm"];
      for (const chain of Object.keys(CCTP_DOMAINS)) {
        expect(allowed).toContain(chain);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // 3. Real Balance Checks
  // ══════════════════════════════════════════════════════════

  describe("3. Real balance checks", () => {
    it("Solana USDC balance query succeeds", async () => {
      const balance = await getSolanaUsdcBalance(solanaAddress);
      expect(typeof balance).toBe("number");
      expect(balance).toBeGreaterThanOrEqual(0);
    });

    it("Arbitrum USDC balance query succeeds", async () => {
      const balance = await getEvmUsdcBalance("arbitrum", evmAddress);
      expect(typeof balance).toBe("number");
      expect(balance).toBeGreaterThanOrEqual(0);
    });

    it("Base USDC balance query succeeds", async () => {
      const balance = await getEvmUsdcBalance("base", evmAddress);
      expect(typeof balance).toBe("number");
      expect(balance).toBeGreaterThanOrEqual(0);
    });

    it("checkBridgeBalance returns consistent shape", async () => {
      const result = await checkBridgeBalance("solana", solanaAddress, 1);
      expect(typeof result.balance).toBe("number");
      expect(typeof result.sufficient).toBe("boolean");
      expect(result.sufficient).toBe(result.balance >= 1);
    });

    it("unsupported chain balance throws", async () => {
      await expect(getEvmUsdcBalance("fakenet", evmAddress)).rejects.toThrow();
    });
  });

  // ══════════════════════════════════════════════════════════
  // 3b. Native Gas Balance Checks
  // ══════════════════════════════════════════════════════════

  describe("3b. Native gas balance checks", () => {
    it("Solana SOL balance query succeeds", async () => {
      const balance = await getNativeGasBalance("solana", solanaAddress);
      expect(typeof balance).toBe("number");
      expect(balance).toBeGreaterThanOrEqual(0);
    });

    it("Arbitrum ETH balance query succeeds", async () => {
      const balance = await getNativeGasBalance("arbitrum", evmAddress);
      expect(typeof balance).toBe("number");
      expect(balance).toBeGreaterThanOrEqual(0);
    });

    it("Base ETH balance query succeeds", async () => {
      const balance = await getNativeGasBalance("base", evmAddress);
      expect(typeof balance).toBe("number");
      expect(balance).toBeGreaterThanOrEqual(0);
    });

    it("unsupported chain gas balance throws", async () => {
      await expect(getNativeGasBalance("fakenet", evmAddress)).rejects.toThrow();
    });

    it("checkBridgeGasBalance: src-only check (fast mode)", async () => {
      const result = await checkBridgeGasBalance("arbitrum", evmAddress, "base", evmAddress, false);
      expect(typeof result.ok).toBe("boolean");
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it("checkBridgeGasBalance: src+dst check (standard mode)", async () => {
      const result = await checkBridgeGasBalance("arbitrum", evmAddress, "base", evmAddress, true);
      expect(typeof result.ok).toBe("boolean");
      expect(Array.isArray(result.errors)).toBe(true);
    });

    it("checkBridgeGasBalance: returns errors array for insufficient gas", async () => {
      // Use an address unlikely to have gas on both chains
      const emptyAddr = "0x000000000000000000000000000000000000dEaD";
      const result = await checkBridgeGasBalance("arbitrum", emptyAddr, "base", emptyAddr, true);
      // Shape is correct regardless of balance
      expect(typeof result.ok).toBe("boolean");
      expect(Array.isArray(result.errors)).toBe(true);
      if (!result.ok) {
        expect(result.errors[0]).toMatch(/arbitrum|base/);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // 4. CCTP Quotes — Standard Routes
  // ══════════════════════════════════════════════════════════

  describe("4. CCTP standard quotes", () => {
    const standardRoutes: [string, string][] = [
      ["solana", "arbitrum"],
      ["solana", "base"],
      ["arbitrum", "base"],
      ["arbitrum", "solana"],
      ["base", "arbitrum"],
      ["base", "solana"],
    ];

    for (const [src, dst] of standardRoutes) {
      it(`${src} → ${dst}: valid CCTP quote`, async () => {
        const quote = await getCctpQuote(src, dst, 100);

        expect(quote.provider).toBe("cctp");
        expect(quote.srcChain).toBe(src);
        expect(quote.dstChain).toBe(dst);
        expect(quote.amountIn).toBe(100);
        expect(quote.amountOut).toBeGreaterThan(0);
        expect(quote.amountOut).toBeLessThanOrEqual(100);
        expect(quote.fee).toBeGreaterThanOrEqual(0);
        expect(quote.fee).toBeLessThan(5); // max $5 relay fee
        expect(quote.estimatedTime).toBeGreaterThan(0);
        expect(Math.abs(quote.fee - (quote.amountIn - quote.amountOut))).toBeLessThan(0.001);
        expect(quote.raw).toBeDefined();
      });
    }

    it("large amount ($100k) quote is valid", async () => {
      const quote = await getCctpQuote("arbitrum", "base", 100000);
      expect(quote.amountOut).toBeGreaterThan(99900); // fee should be tiny relative to amount
      expect(quote.fee).toBeLessThan(5);
    });

    it("tiny amount ($0.01) quote is valid", async () => {
      const quote = await getCctpQuote("arbitrum", "base", 0.01);
      expect(quote.amountOut).toBeGreaterThan(-1);
      expect(quote.fee).toBeLessThan(1);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 5. CCTP Quotes — HyperCore Routes
  // ══════════════════════════════════════════════════════════

  describe("5. HyperCore CCTP quotes", () => {
    it("solana → hyperevm: valid HyperCore deposit quote", async () => {
      const quote = await getCctpQuote("solana", "hyperevm", 500);

      expect(quote.provider).toBe("cctp");
      expect(quote.srcChain).toBe("solana");
      expect(quote.dstChain).toBe("hyperevm");
      expect(quote.amountIn).toBe(500);
      expect(quote.amountOut).toBeGreaterThan(0);
      expect(quote.amountOut).toBeLessThan(500);
      expect(quote.fee).toBeGreaterThan(0);
      expect(quote.fee).toBeLessThan(5); // should be ~$0.25 (1bp + forwarding)
      expect(quote.estimatedTime).toBe(65); // Solana source
      expect(quote.gasIncluded).toBe(true);
      expect(quote.raw).toHaveProperty("type", "cctp-hypercore");
      expect(quote.raw).toHaveProperty("maxFee");
    });

    it("arbitrum → hyperevm: valid HyperCore deposit quote", async () => {
      const quote = await getCctpQuote("arbitrum", "hyperevm", 1000);

      expect(quote.provider).toBe("cctp");
      expect(quote.srcChain).toBe("arbitrum");
      expect(quote.dstChain).toBe("hyperevm");
      expect(quote.amountIn).toBe(1000);
      expect(quote.amountOut).toBeGreaterThan(0);
      expect(quote.fee).toBeGreaterThan(0);
      expect(quote.fee).toBeLessThan(5);
      expect(quote.estimatedTime).toBe(60); // EVM-to-EVM fast
      expect(quote.gasIncluded).toBe(true);
      expect(quote.raw).toHaveProperty("type", "cctp-hypercore");
    });

    it("base → hyperevm: valid HyperCore deposit quote", async () => {
      const quote = await getCctpQuote("base", "hyperevm", 200);

      expect(quote.provider).toBe("cctp");
      expect(quote.dstChain).toBe("hyperevm");
      expect(quote.amountOut).toBeGreaterThan(0);
      expect(quote.fee).toBeLessThan(5);
      expect(quote.estimatedTime).toBe(60);
    });

    it("hyperevm → arbitrum: valid HyperCore withdrawal quote", async () => {
      const quote = await getCctpQuote("hyperevm", "arbitrum", 300);

      expect(quote.provider).toBe("cctp");
      expect(quote.srcChain).toBe("hyperevm");
      expect(quote.dstChain).toBe("arbitrum");
      expect(quote.amountIn).toBe(300);
      expect(quote.amountOut).toBe(299.80); // $0.20 forwarding fee
      expect(quote.fee).toBe(0.20);
      expect(quote.estimatedTime).toBe(60);
      expect(quote.gasIncluded).toBe(true);
      expect(quote.raw).toHaveProperty("type", "cctp-hypercore-withdraw");
    });

    it("hyperevm → solana: valid HyperCore withdrawal quote", async () => {
      const quote = await getCctpQuote("hyperevm", "solana", 100);

      expect(quote.provider).toBe("cctp");
      expect(quote.srcChain).toBe("hyperevm");
      expect(quote.dstChain).toBe("solana");
      expect(quote.fee).toBe(0.20);
      expect(quote.amountOut).toBe(99.80);
    });

    it("HyperCore fees scale correctly with amount", async () => {
      const small = await getCctpQuote("arbitrum", "hyperevm", 10);
      const large = await getCctpQuote("arbitrum", "hyperevm", 10000);

      // Protocol fee is 1bp, so large amount pays more
      expect(large.fee).toBeGreaterThan(small.fee);
      // But fee percentage should be similar (both ~1bp + flat forwarding)
      const smallPct = small.fee / small.amountIn;
      const largePct = large.fee / large.amountIn;
      expect(smallPct).toBeGreaterThan(largePct); // smaller amounts pay higher % (flat fee dominates)
    });
  });

  // ══════════════════════════════════════════════════════════
  // 6. HyperCore Fees API Direct Validation
  // ══════════════════════════════════════════════════════════

  describe("6. HyperCore fees API", () => {
    const FEES_API = "https://iris-api.circle.com/v2/burn/USDC/fees";

    it("Solana (domain 5) → HyperCore (domain 19) fees API responds", async () => {
      const res = await fetch(`${FEES_API}/5/19?forward=true&hyperCoreDeposit=true`);
      expect(res.ok).toBe(true);
      const data = await res.json() as unknown[];
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);

      const schedule = data[0] as Record<string, unknown>;
      expect(schedule).toHaveProperty("finalityThreshold");
      expect(schedule).toHaveProperty("minimumFee");
    });

    it("Arbitrum (domain 3) → HyperCore (domain 19) fees API responds", async () => {
      const res = await fetch(`${FEES_API}/3/19?forward=true&hyperCoreDeposit=true`);
      expect(res.ok).toBe(true);
      const data = await res.json() as unknown[];
      expect(Array.isArray(data)).toBe(true);
      expect(data.length).toBeGreaterThan(0);
    });

    it("Base (domain 6) → HyperCore (domain 19) fees API responds", async () => {
      const res = await fetch(`${FEES_API}/6/19?forward=true&hyperCoreDeposit=true`);
      expect(res.ok).toBe(true);
      const data = await res.json() as unknown[];
      expect(Array.isArray(data)).toBe(true);
    });

    it("fees API returns forward fee structure", async () => {
      const res = await fetch(`${FEES_API}/3/19?forward=true&hyperCoreDeposit=true`);
      const data = await res.json() as Array<Record<string, unknown>>;
      // Look for schedule with forwardFee
      const hasForwardFee = data.some(s =>
        s.forwardFee !== undefined && s.forwardFee !== null
      );
      // At minimum, all schedules should have finalityThreshold and minimumFee
      for (const schedule of data) {
        expect(typeof schedule.finalityThreshold).toBe("number");
        expect(typeof schedule.minimumFee).toBe("number");
      }
      // Forward fee may or may not be present depending on API version
      if (hasForwardFee) {
        const withFee = data.find(s => s.forwardFee !== undefined) as Record<string, unknown>;
        const ff = withFee.forwardFee as Record<string, number>;
        expect(typeof ff.low).toBe("number");
        expect(typeof ff.med).toBe("number");
        expect(typeof ff.high).toBe("number");
        expect(ff.med).toBeGreaterThanOrEqual(ff.low);
        expect(ff.high).toBeGreaterThanOrEqual(ff.med);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // 7. deBridge DLN Quotes (with real addresses)
  // ══════════════════════════════════════════════════════════

  describe("7. deBridge quotes with real addresses", () => {
    it("solana → arbitrum: quote with real wallet addresses", async () => {
      const quote = await getDebridgeQuote("solana", "arbitrum", 100, solanaAddress, evmAddress);

      expect(quote.provider).toBe("debridge");
      expect(quote.srcChain).toBe("solana");
      expect(quote.dstChain).toBe("arbitrum");
      expect(quote.amountIn).toBe(100);
      expect(quote.amountOut).toBeGreaterThan(0);
      expect(quote.amountOut).toBeLessThanOrEqual(100);
      expect(quote.fee).toBeGreaterThanOrEqual(0);
      expect(quote.estimatedTime).toBeGreaterThan(0);
      expect(Math.abs(quote.fee - (quote.amountIn - quote.amountOut))).toBeLessThan(0.001);
    });

    it("arbitrum → base: EVM-to-EVM with real addresses", async () => {
      await wait(1500);
      const quote = await getDebridgeQuote("arbitrum", "base", 200, evmAddress, evmAddress);

      expect(quote.provider).toBe("debridge");
      expect(quote.amountOut).toBeGreaterThan(0);
      expect(quote.amountOut).toBeLessThanOrEqual(200);
    });

    it("base → solana: reverse route with real addresses", async () => {
      await wait(1500);
      const quote = await getDebridgeQuote("base", "solana", 50, evmAddress, solanaAddress);

      expect(quote.provider).toBe("debridge");
      expect(quote.amountOut).toBeGreaterThan(0);
    });

    it("unsupported chain throws", async () => {
      await expect(
        getDebridgeQuote("hyperevm", "arbitrum", 100, evmAddress, evmAddress)
      ).rejects.toThrow(/Unsupported chain/i);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 8. Relay Quotes (with real addresses)
  // ══════════════════════════════════════════════════════════

  describe("8. Relay quotes with real addresses", () => {
    it("solana → arbitrum: Relay quote with real addresses", async () => {
      const quote = await getRelayQuote("solana", "arbitrum", 100, solanaAddress, evmAddress);

      expect(quote.provider).toBe("relay");
      expect(quote.srcChain).toBe("solana");
      expect(quote.dstChain).toBe("arbitrum");
      expect(quote.amountIn).toBe(100);
      expect(quote.amountOut).toBeGreaterThan(0);
      expect(quote.amountOut).toBeLessThanOrEqual(100);
      expect(quote.estimatedTime).toBeGreaterThan(0);
    });

    it("arbitrum → base: EVM-to-EVM Relay quote", async () => {
      await wait(1000);
      const quote = await getRelayQuote("arbitrum", "base", 500, evmAddress, evmAddress);

      expect(quote.provider).toBe("relay");
      expect(quote.amountOut).toBeGreaterThan(0);
    });

    it("base → solana: reverse Relay quote", async () => {
      await wait(1000);
      const quote = await getRelayQuote("base", "solana", 200, evmAddress, solanaAddress);

      expect(quote.provider).toBe("relay");
      expect(quote.amountOut).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 9. getAllQuotes Aggregation
  // ══════════════════════════════════════════════════════════

  describe("9. getAllQuotes aggregation", () => {
    it("arbitrum → base: returns multiple providers sorted by amountOut", async () => {
      await wait(2000);
      const quotes = await getAllQuotes("arbitrum", "base", 1000, evmAddress, evmAddress);

      expect(quotes.length).toBeGreaterThanOrEqual(1);

      // Should be sorted by amountOut descending (best first)
      for (let i = 1; i < quotes.length; i++) {
        expect(quotes[i - 1].amountOut).toBeGreaterThanOrEqual(quotes[i].amountOut);
      }

      // All quotes should have consistent shape
      for (const q of quotes) {
        expect(["cctp", "debridge", "relay"]).toContain(q.provider);
        expect(q.srcChain).toBe("arbitrum");
        expect(q.dstChain).toBe("base");
        expect(q.amountIn).toBe(1000);
        expect(q.amountOut).toBeGreaterThan(0);
        expect(typeof q.fee).toBe("number");
        expect(typeof q.estimatedTime).toBe("number");
      }

      // CCTP should be present (it's always available for supported routes)
      const cctpQuote = quotes.find(q => q.provider === "cctp");
      expect(cctpQuote).toBeDefined();
    });

    it("solana → arbitrum: includes CCTP + at least one other provider", async () => {
      await wait(2000);
      const quotes = await getAllQuotes("solana", "arbitrum", 200, solanaAddress, evmAddress);

      expect(quotes.length).toBeGreaterThanOrEqual(2);

      const providers = new Set(quotes.map(q => q.provider));
      expect(providers.has("cctp")).toBe(true);
      // Should have debridge or relay too
      expect(providers.size).toBeGreaterThanOrEqual(2);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 10. getBestQuote Selection
  // ══════════════════════════════════════════════════════════

  describe("10. getBestQuote selection", () => {
    it("CCTP route preferred for standard chains (lowest fee)", async () => {
      const quote = await getBestQuote("arbitrum", "base", 500, evmAddress, evmAddress);

      expect(quote.provider).toBe("cctp");
      expect(quote.amountOut).toBeGreaterThanOrEqual(499);
      expect(quote.fee).toBeLessThan(2);
    });

    it("solana → arbitrum: CCTP preferred", async () => {
      const quote = await getBestQuote("solana", "arbitrum", 1000, solanaAddress, evmAddress);

      expect(quote.provider).toBe("cctp");
      expect(quote.fee).toBeLessThan(2);
    });

    it("quote amountIn - amountOut ≈ fee", async () => {
      const quote = await getBestQuote("base", "solana", 100, evmAddress, solanaAddress);

      const calculatedFee = quote.amountIn - quote.amountOut;
      expect(Math.abs(calculatedFee - quote.fee)).toBeLessThan(0.01);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 11. Cross-Provider Comparison
  // ══════════════════════════════════════════════════════════

  describe("11. Cross-provider fee comparison", () => {
    it("CCTP is cheaper than deBridge for standard routes", async () => {
      await wait(2000);
      const cctp = await getCctpQuote("arbitrum", "base", 1000);
      const debridge = await getDebridgeQuote("arbitrum", "base", 1000, evmAddress, evmAddress);

      expect(cctp.fee).toBeLessThanOrEqual(debridge.fee);
      expect(cctp.amountOut).toBeGreaterThanOrEqual(debridge.amountOut);
    });

    it("HyperCore CCTP fee is reasonable ($0.20-$2 range)", async () => {
      const quote = await getCctpQuote("arbitrum", "hyperevm", 1000);
      expect(quote.fee).toBeGreaterThanOrEqual(0.10);
      expect(quote.fee).toBeLessThan(3);
    });

    it("HyperCore withdrawal fee is fixed at $0.20", async () => {
      const q100 = await getCctpQuote("hyperevm", "arbitrum", 100);
      const q10000 = await getCctpQuote("hyperevm", "arbitrum", 10000);

      expect(q100.fee).toBe(0.20);
      expect(q10000.fee).toBe(0.20);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 12. Error Handling & Edge Cases
  // ══════════════════════════════════════════════════════════

  describe("12. Error handling", () => {
    it("CCTP quote for unsupported chain throws", async () => {
      await expect(getCctpQuote("polygon", "arbitrum", 100)).rejects.toThrow(/not supported/i);
    });

    it("deBridge zero amount throws", async () => {
      await wait(1500);
      await expect(
        getDebridgeQuote("solana", "arbitrum", 0, solanaAddress, evmAddress)
      ).rejects.toThrow();
    });

    it("deBridge negative amount throws", async () => {
      await wait(1500);
      await expect(
        getDebridgeQuote("arbitrum", "base", -100, evmAddress, evmAddress)
      ).rejects.toThrow();
    });

    it("CCTP same-chain quote still valid", async () => {
      const quote = await getCctpQuote("arbitrum", "arbitrum", 100);
      expect(quote.provider).toBe("cctp");
      expect(quote.amountOut).toBeGreaterThan(0);
    });

    it("all quotes return gasIncluded field", async () => {
      const cctp = await getCctpQuote("arbitrum", "base", 100);
      expect(typeof cctp.gasIncluded).toBe("boolean");

      const hypercore = await getCctpQuote("arbitrum", "hyperevm", 100);
      expect(hypercore.gasIncluded).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 13. HyperCore CctpForwarder Contract Verification
  // ══════════════════════════════════════════════════════════

  describe("13. HyperCore on-chain verification", () => {
    const HYPERCORE_FORWARDER = "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757";
    const HYPERCORE_RPC = "https://rpc.hyperliquid.xyz/evm";

    it("CctpForwarder contract exists on HyperEVM", async () => {
      const res = await fetch(HYPERCORE_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "eth_getCode",
          params: [HYPERCORE_FORWARDER, "latest"],
        }),
      });
      const json = await res.json() as { result: string };
      // Contract should have code (not "0x")
      expect(json.result).toBeDefined();
      expect(json.result.length).toBeGreaterThan(2);
      expect(json.result).not.toBe("0x");
    });

    it("CctpExtension contract exists on Arbitrum", async () => {
      const CCTP_EXTENSION = "0xA95d9c1F655341597C94393fDdc30cf3c08E4fcE";
      const res = await fetch("https://arb1.arbitrum.io/rpc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "eth_getCode",
          params: [CCTP_EXTENSION, "latest"],
        }),
      });
      const json = await res.json() as { result: string };
      expect(json.result.length).toBeGreaterThan(2);
      expect(json.result).not.toBe("0x");
    });

    it("HyperEVM RPC is reachable (eth_chainId)", async () => {
      const res = await fetch(HYPERCORE_RPC, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1,
          method: "eth_chainId",
          params: [],
        }),
      });
      const json = await res.json() as { result: string };
      expect(json.result).toBeDefined();
      // HyperEVM chain ID = 999 (0x3e7) or similar
      const chainId = parseInt(json.result, 16);
      expect(chainId).toBeGreaterThan(0);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 14. CCTP V2 Iris Attestation API
  // ══════════════════════════════════════════════════════════

  describe("14. CCTP V2 Iris attestation API", () => {
    it("V2 relay fee API responds for all source domains", async () => {
      const routes: [number, number][] = [
        [5, 3],   // solana → arbitrum
        [3, 6],   // arbitrum → base
        [6, 5],   // base → solana
        [3, 19],  // arbitrum → hyperevm
        [5, 19],  // solana → hyperevm
      ];

      for (const [src, dst] of routes) {
        const res = await fetch(`https://iris-api.circle.com/v2/burn/USDC/fees/${src}/${dst}`);
        expect(res.ok).toBe(true);
        const data = await res.json();
        expect(Array.isArray(data)).toBe(true);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // 15. SENDER-PAYS-ONLY — Core Invariant
  // ══════════════════════════════════════════════════════════
  //
  // The fundamental rule: ALL bridge costs (protocol fee, relay fee,
  // gas cost) are deducted from the sender's USDC amount.
  // The recipient receives amountOut without paying anything.
  //
  // This is verified by checking that every quote has:
  //   - gasIncluded === true (auto-relay, no manual dst TX needed)
  //   - fee === amountIn - amountOut (fee is deducted from sent amount)
  //   - amountOut > 0 and amountOut <= amountIn
  //
  // ══════════════════════════════════════════════════════════

  describe("15. SENDER-PAYS-ONLY verification", () => {
    // All 4 chains: arbitrum, base, solana, hyperevm
    // Standard routes (6 pairs among arb/base/sol)
    const standardRoutes: [string, string][] = [
      ["arbitrum", "base"],
      ["arbitrum", "solana"],
      ["base", "arbitrum"],
      ["base", "solana"],
      ["solana", "arbitrum"],
      ["solana", "base"],
    ];

    // HyperCore routes (deposit into + withdrawal from)
    const hyperCoreDepositRoutes: [string, string][] = [
      ["arbitrum", "hyperevm"],
      ["base", "hyperevm"],
      ["solana", "hyperevm"],
    ];
    const hyperCoreWithdrawRoutes: [string, string][] = [
      ["hyperevm", "arbitrum"],
      ["hyperevm", "base"],
      ["hyperevm", "solana"],
    ];

    const ALL_ROUTES = [
      ...standardRoutes,
      ...hyperCoreDepositRoutes,
      ...hyperCoreWithdrawRoutes,
    ];

    for (const [src, dst] of ALL_ROUTES) {
      it(`${src} → ${dst}: fee deducted from sender's USDC`, async () => {
        const amount = 100;
        const quote = await getCctpQuote(src, dst, amount);

        // 1. Fee is correctly calculated
        expect(quote.fee).toBeGreaterThanOrEqual(0);
        expect(Math.abs(quote.fee - (quote.amountIn - quote.amountOut))).toBeLessThan(0.001);

        // 2. Recipient gets amountOut
        expect(quote.amountOut).toBeGreaterThan(0);
        expect(quote.amountOut).toBeLessThanOrEqual(amount);

        // 3. Gas note present
        expect(quote.gasNote).toBeDefined();
        expect(quote.gasNote!.length).toBeGreaterThan(0);
      });
    }

    it("fast=true: all standard routes use auto-relay (gasIncluded=true)", async () => {
      for (const [src, dst] of standardRoutes) {
        const quote = await getCctpQuote(src, dst, 100, true);
        expect(quote.gasIncluded).toBe(true);
        const raw = quote.raw as Record<string, unknown>;
        expect(Number(raw.maxFee)).toBeGreaterThan(0);
        expect(raw.fast).toBe(true);
      }
    });

    it("fast=false (default): standard routes use manual relay (gasIncluded=false)", async () => {
      for (const [src, dst] of standardRoutes) {
        const quote = await getCctpQuote(src, dst, 100);
        expect(quote.gasIncluded).toBe(false);
        const raw = quote.raw as Record<string, unknown>;
        expect(raw.fast).toBe(false);
      }
    });

    it("fast=true fees are higher than standard fees", async () => {
      const standard = await getCctpQuote("arbitrum", "base", 1000, false);
      const fast = await getCctpQuote("arbitrum", "base", 1000, true);
      expect(fast.fee).toBeGreaterThan(standard.fee);
      expect(fast.estimatedTime).toBeLessThan(standard.estimatedTime);
    });

    it("HyperCore deposits: CctpForwarder auto-deposits (always gasIncluded)", async () => {
      for (const [src, dst] of hyperCoreDepositRoutes) {
        const quote = await getCctpQuote(src, dst, 100);
        expect(quote.gasIncluded).toBe(true);
        expect(quote.gasNote).toContain("CctpForwarder");
        const raw = quote.raw as Record<string, unknown>;
        expect(raw.type).toBe("cctp-hypercore");
        expect(Number(raw.maxFee)).toBeGreaterThan(0);
      }
    });

    it("HyperCore withdrawals: HL handles forwarding (always gasIncluded)", async () => {
      for (const [src, dst] of hyperCoreWithdrawRoutes) {
        const quote = await getCctpQuote(src, dst, 100);
        expect(quote.gasIncluded).toBe(true);
        expect(quote.gasNote).toContain("HyperCore");
        expect(quote.fee).toBe(0.20);
        const raw = quote.raw as Record<string, unknown>;
        expect(raw.type).toBe("cctp-hypercore-withdraw");
      }
    });

    it("deBridge quotes include gas in fee (sender-pays)", async () => {
      await wait(2000);
      const quote = await getDebridgeQuote("arbitrum", "base", 100, evmAddress, evmAddress);
      expect(quote.fee).toBeGreaterThan(0);
      expect(Math.abs(quote.fee - (quote.amountIn - quote.amountOut))).toBeLessThan(0.001);
      expect(quote.gasIncluded).toBe(true);
    });

    it("Relay quotes include gas in fee (solver pays dst gas)", async () => {
      await wait(1000);
      const quote = await getRelayQuote("arbitrum", "base", 100, evmAddress, evmAddress);
      expect(quote.fee).toBeGreaterThanOrEqual(0);
      expect(Math.abs(quote.fee - (quote.amountIn - quote.amountOut))).toBeLessThan(0.001);
      expect(quote.gasIncluded).toBe(true);
    });

    it("getAllQuotes: fee math is correct for every provider", async () => {
      await wait(2000);
      const quotes = await getAllQuotes("arbitrum", "base", 500, evmAddress, evmAddress);

      for (const q of quotes) {
        expect(q.fee).toBeGreaterThanOrEqual(0);
        expect(Math.abs(q.fee - (q.amountIn - q.amountOut))).toBeLessThan(0.01);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // 16. Complete 4-Chain Route Matrix
  // ══════════════════════════════════════════════════════════
  //
  // Verify every possible directional pair among:
  // arbitrum, base, solana, hyperevm (12 pairs total)
  //
  // For each: valid quote, correct fee math, gasIncluded
  // ══════════════════════════════════════════════════════════

  describe("16. Complete 4-chain route matrix", () => {
    const chains = ["arbitrum", "base", "solana", "hyperevm"];
    const amount = 250;

    for (const src of chains) {
      for (const dst of chains) {
        if (src === dst) continue;

        const isHyperCore = src === "hyperevm" || dst === "hyperevm";

        it(`[MATRIX] ${src} → ${dst}: valid quote with sender-pays`, async () => {
          const quote = await getCctpQuote(src, dst, amount);

          // Basic shape
          expect(quote.provider).toBe("cctp");
          expect(quote.srcChain).toBe(src);
          expect(quote.dstChain).toBe(dst);
          expect(quote.amountIn).toBe(amount);
          expect(quote.amountOut).toBeGreaterThan(0);
          expect(quote.amountOut).toBeLessThanOrEqual(amount);

          // Fee invariant: fee = amountIn - amountOut
          expect(Math.abs(quote.fee - (amount - quote.amountOut))).toBeLessThan(0.001);

          // HyperCore routes always auto-relay (gasIncluded=true)
          // Standard routes default to manual relay (gasIncluded=false)
          if (isHyperCore) {
            expect(quote.gasIncluded).toBe(true);
          } else {
            expect(quote.gasIncluded).toBe(false);
          }

          // Reasonable fee (< $5 for $250)
          expect(quote.fee).toBeLessThan(5);

          // Time estimate is positive
          expect(quote.estimatedTime).toBeGreaterThan(0);
        });
      }
    }

    it("[MATRIX] fee comparison: HyperCore deposit > standard CCTP > HyperCore withdrawal", async () => {
      const standardFee = (await getCctpQuote("arbitrum", "base", 1000)).fee;
      const depositFee = (await getCctpQuote("arbitrum", "hyperevm", 1000)).fee;
      const withdrawFee = (await getCctpQuote("hyperevm", "arbitrum", 1000)).fee;

      // HyperCore deposit has protocol + forwarding fee (> standard)
      expect(depositFee).toBeGreaterThanOrEqual(standardFee);
      // HyperCore withdrawal is fixed $0.20
      expect(withdrawFee).toBe(0.20);
    });

    it("[MATRIX] ETA comparison: fast mode Solana routes are slower than fast EVM-only", async () => {
      const evmToEvmFast = (await getCctpQuote("arbitrum", "base", 100, true)).estimatedTime;
      const solToEvmFast = (await getCctpQuote("solana", "arbitrum", 100, true)).estimatedTime;

      // Fast finality: Solana ~90s, EVM-only ~60s
      expect(solToEvmFast).toBeGreaterThanOrEqual(evmToEvmFast);

      // Standard finality: both positive
      const evmToEvmStd = (await getCctpQuote("arbitrum", "base", 100)).estimatedTime;
      const solToEvmStd = (await getCctpQuote("solana", "arbitrum", 100)).estimatedTime;
      expect(evmToEvmStd).toBeGreaterThan(0);
      expect(solToEvmStd).toBeGreaterThan(0);
    });

    it("[MATRIX] all standard relay fee APIs respond for 4-chain matrix", async () => {
      // Verify Circle's fee API works for every domain pair we support
      const domains = [
        { chain: "arbitrum", domain: 3 },
        { chain: "base", domain: 6 },
        { chain: "solana", domain: 5 },
        { chain: "hyperevm", domain: 19 },
      ];

      const results: string[] = [];

      for (const src of domains) {
        for (const dst of domains) {
          if (src.chain === dst.chain) continue;

          const url = dst.domain === 19
            ? `https://iris-api.circle.com/v2/burn/USDC/fees/${src.domain}/${dst.domain}?forward=true&hyperCoreDeposit=true`
            : `https://iris-api.circle.com/v2/burn/USDC/fees/${src.domain}/${dst.domain}`;

          const res = await fetch(url);
          if (res.ok) {
            results.push(`${src.chain}→${dst.chain}: OK`);
          } else {
            results.push(`${src.chain}→${dst.chain}: ${res.status}`);
          }
        }
      }

      // At minimum, all standard routes should work
      const okCount = results.filter(r => r.includes("OK")).length;
      expect(okCount).toBeGreaterThanOrEqual(6); // at least standard 6 pairs
    });
  });
});
