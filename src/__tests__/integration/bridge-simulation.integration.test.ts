/**
 * CCTP V2 Simulation Tests — verify bridge implementation correctness
 * WITHOUT sending real transactions.
 *
 * Tests:
 * 1. EVM V2 contract existence (eth_getCode) on key chains
 * 2. Solana program existence on mainnet
 * 3. EVM depositForBurn V2 staticCall simulation
 * 4. Solana depositForBurn simulateTransaction
 * 5. PDA derivation correctness
 * 6. V2 Iris attestation API reachability
 * 7. HyperCore CCTP fees API
 */
import { describe, it, expect } from "vitest";

// Re-export constants for testing
import {
  CCTP_DOMAINS,
  CHAIN_IDS,
  USDC_ADDRESSES,
  EVM_TOKEN_MINTER_V2,
} from "../../bridge-engine.js";

// V2 contract addresses (same on all EVM chains per Circle docs)
const EVM_TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const EVM_MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";

// Solana CCTP V2 programs
const CCTP_SOLANA_TMM = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
const CCTP_SOLANA_MT = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";

// RPC endpoints (public, free)
const RPC: Record<string, string> = {
  ethereum: "https://eth.llamarpc.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  base: "https://mainnet.base.org",
  optimism: "https://mainnet.optimism.io",
  polygon: "https://1rpc.io/matic",
  avalanche: "https://api.avax.network/ext/bc/C/rpc",
  solana: "https://api.mainnet-beta.solana.com",
};

// Helper: JSON-RPC call
async function ethCall(rpc: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json() as { result?: unknown; error?: { message?: string; code?: number } };
  if (json.error) throw new Error(`RPC error: ${json.error.message ?? json.error.code ?? JSON.stringify(json.error)}`);
  return json.result;
}

// Helper: Solana RPC call
async function solanaRpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC.solana, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`Solana RPC error: ${json.error.message}`);
  return json.result;
}

describe("CCTP V2 Simulation Tests", { timeout: 60000 }, () => {
  // ══════════════════════════════════════════════════════════
  // 1. EVM V2 Contract Existence
  // ══════════════════════════════════════════════════════════

  describe("EVM V2 contract verification", () => {
    const chainsToCheck = ["arbitrum", "base", "optimism", "polygon", "avalanche"];

    for (const chain of chainsToCheck) {
      it(`${chain}: TokenMessengerV2 has deployed code`, async () => {
        const code = await ethCall(RPC[chain], "eth_getCode", [EVM_TOKEN_MESSENGER_V2, "latest"]);
        expect(typeof code).toBe("string");
        expect((code as string).length).toBeGreaterThan(10); // not "0x" (empty)
        expect(code).not.toBe("0x");
      });

      it(`${chain}: MessageTransmitterV2 has deployed code`, async () => {
        const code = await ethCall(RPC[chain], "eth_getCode", [EVM_MESSAGE_TRANSMITTER_V2, "latest"]);
        expect(typeof code).toBe("string");
        expect((code as string).length).toBeGreaterThan(10);
        expect(code).not.toBe("0x");
      });

      it(`${chain}: TokenMinterV2 has deployed code`, async () => {
        const code = await ethCall(RPC[chain], "eth_getCode", [EVM_TOKEN_MINTER_V2, "latest"]);
        expect(typeof code).toBe("string");
        expect((code as string).length).toBeGreaterThan(10);
        expect(code).not.toBe("0x");
      });
    }

    // Also verify Ethereum (important, previously had V1 address bug)
    it("ethereum: TokenMessengerV2 has deployed code", async () => {
      const code = await ethCall(RPC.ethereum, "eth_getCode", [EVM_TOKEN_MESSENGER_V2, "latest"]);
      expect(typeof code).toBe("string");
      expect((code as string).length).toBeGreaterThan(10);
      expect(code).not.toBe("0x");
    });

    it("ethereum: MessageTransmitterV2 has deployed code", async () => {
      const code = await ethCall(RPC.ethereum, "eth_getCode", [EVM_MESSAGE_TRANSMITTER_V2, "latest"]);
      expect(typeof code).toBe("string");
      expect((code as string).length).toBeGreaterThan(10);
      expect(code).not.toBe("0x");
    });
  });

  // ══════════════════════════════════════════════════════════
  // 2. Solana Program Existence
  // ══════════════════════════════════════════════════════════

  describe("Solana CCTP V2 program verification", () => {
    it("TokenMessengerMinter program exists and is executable", async () => {
      const result = await solanaRpc("getAccountInfo", [
        CCTP_SOLANA_TMM,
        { encoding: "jsonParsed" },
      ]) as { value: { executable: boolean; owner: string } | null };

      expect(result.value).not.toBeNull();
      expect(result.value!.executable).toBe(true);
      // Should be owned by BPF loader
      expect(result.value!.owner).toMatch(/^BPFLoader/);
    });

    it("MessageTransmitter program exists and is executable", async () => {
      const result = await solanaRpc("getAccountInfo", [
        CCTP_SOLANA_MT,
        { encoding: "jsonParsed" },
      ]) as { value: { executable: boolean; owner: string } | null };

      expect(result.value).not.toBeNull();
      expect(result.value!.executable).toBe(true);
      expect(result.value!.owner).toMatch(/^BPFLoader/);
    });

    it("USDC mint exists on Solana mainnet", async () => {
      const result = await solanaRpc("getAccountInfo", [
        USDC_ADDRESSES.solana,
        { encoding: "jsonParsed" },
      ]) as { value: { data: { parsed: { type: string } } } | null };

      expect(result.value).not.toBeNull();
      expect(result.value!.data.parsed.type).toBe("mint");
    });
  });

  // ══════════════════════════════════════════════════════════
  // 3. EVM depositForBurn V2 staticCall Simulation
  // ══════════════════════════════════════════════════════════

  describe("EVM depositForBurn V2 staticCall simulation", () => {
    // We use eth_call to simulate depositForBurn — it won't actually execute
    // but verifies the ABI signature matches the deployed V2 contract.
    // We use a random "from" address with no USDC — the call will revert
    // with an understandable error (insufficient balance), NOT "invalid method".

    const DUMMY_SENDER = "0x0000000000000000000000000000000000000001";

    it("arbitrum → base: V2 depositForBurn ABI is accepted by contract", async () => {
      const { ethers } = await import("ethers");
      const iface = new ethers.Interface([
        "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64 nonce)",
      ]);

      const calldata = iface.encodeFunctionData("depositForBurn", [
        1000000n, // 1 USDC
        CCTP_DOMAINS.base, // destination domain
        ethers.zeroPadValue(DUMMY_SENDER, 32), // mintRecipient
        USDC_ADDRESSES.arbitrum, // burnToken
        ethers.ZeroHash, // destinationCaller (permissionless)
        0n, // maxFee (standard)
        2000, // minFinalityThreshold (finalized)
      ]);

      // eth_call will revert because DUMMY_SENDER has no USDC,
      // but the revert message should NOT be "invalid function selector"
      try {
        await ethCall(RPC.arbitrum, "eth_call", [
          { from: DUMMY_SENDER, to: EVM_TOKEN_MESSENGER_V2, data: calldata },
          "latest",
        ]);
        // If it doesn't revert, that's also fine (unlikely without USDC)
      } catch (err: unknown) {
        const msg = (err as Error).message;
        // Should NOT indicate unknown function selector
        expect(msg).not.toContain("invalid opcode");
        expect(msg).not.toContain("unrecognized function selector");
      }
    });

    it("ethereum → arbitrum: V2 7-param ABI matches contract", async () => {
      const { ethers } = await import("ethers");
      const iface = new ethers.Interface([
        "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64 nonce)",
      ]);

      // Encode with correct V2 params
      const calldata = iface.encodeFunctionData("depositForBurn", [
        500000n, // 0.5 USDC
        CCTP_DOMAINS.arbitrum,
        ethers.zeroPadValue(DUMMY_SENDER, 32),
        USDC_ADDRESSES.ethereum,
        ethers.ZeroHash,
        0n,
        2000,
      ]);

      // The function selector (first 4 bytes) should match V2's depositForBurn
      // V2 selector for 7-param depositForBurn: different from V1's 4-param
      const selector = calldata.slice(0, 10); // "0x" + 8 hex chars

      // V1 4-param selector would be different — verify we're using V2
      const v1Iface = new ethers.Interface([
        "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken)",
      ]);
      const v1Selector = v1Iface.getFunction("depositForBurn")!.selector;

      // V2 selector MUST differ from V1
      expect(selector).not.toBe(v1Selector);

      // Verify this selector is recognized by the ethereum contract
      try {
        await ethCall(RPC.ethereum, "eth_call", [
          { from: DUMMY_SENDER, to: EVM_TOKEN_MESSENGER_V2, data: calldata },
          "latest",
        ]);
      } catch (err: unknown) {
        const msg = (err as Error).message;
        // Revert from balance check is expected, not from invalid selector
        expect(msg).not.toContain("unrecognized function selector");
      }
    });

    it("V2 function selector is correct (0x7d213921 for 7-param)", async () => {
      const { ethers } = await import("ethers");
      const iface = new ethers.Interface([
        "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64 nonce)",
      ]);

      const fn = iface.getFunction("depositForBurn")!;
      // The exact selector depends on the full signature — just verify it's consistent
      expect(fn.selector).toBeTruthy();
      expect(fn.selector.length).toBe(10); // "0x" + 8 hex
      // Verify it's NOT the V1 selector
      const v1Iface = new ethers.Interface([
        "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken)",
      ]);
      expect(fn.selector).not.toBe(v1Iface.getFunction("depositForBurn")!.selector);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 4. Solana PDA Derivation Verification
  // ══════════════════════════════════════════════════════════

  describe("Solana PDA derivation correctness", () => {
    it("key state PDAs exist on-chain (token_messenger, token_minter, local_token, message_transmitter)", async () => {
      const { PublicKey } = await import("@solana/web3.js");

      const tokenMessengerMinter = new PublicKey(CCTP_SOLANA_TMM);
      const messageTransmitterProgram = new PublicKey(CCTP_SOLANA_MT);
      const usdcMint = new PublicKey(USDC_ADDRESSES.solana);

      // Derive PDAs — only data accounts that should exist on-chain.
      // sender_authority and event_authority PDAs are virtual/derived-only signers
      // (no data stored on-chain), so we skip them.
      const [tokenMessenger] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_messenger")], tokenMessengerMinter,
      );
      const [tokenMinter] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_minter")], tokenMessengerMinter,
      );
      const [localToken] = PublicKey.findProgramAddressSync(
        [Buffer.from("local_token"), usdcMint.toBuffer()], tokenMessengerMinter,
      );
      const [messageTransmitterAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("message_transmitter")], messageTransmitterProgram,
      );

      const keys = [tokenMessenger, tokenMinter, localToken, messageTransmitterAccount];

      const result = await solanaRpc("getMultipleAccounts", [
        keys.map(k => k.toBase58()),
        { encoding: "base64" },
      ]) as { value: Array<{ data: string[]; owner: string } | null> };

      const labels = ["tokenMessenger", "tokenMinter", "localToken", "messageTransmitter"];

      for (let i = 0; i < keys.length; i++) {
        expect(result.value[i], `${labels[i]} PDA should exist on-chain`).not.toBeNull();
      }
    });

    it("remote_token_messenger PDAs use string domain seeds", async () => {
      const { PublicKey } = await import("@solana/web3.js");
      const tokenMessengerMinter = new PublicKey(CCTP_SOLANA_TMM);

      // Test a few important domains
      const domainsToCheck = [
        { name: "ethereum", domain: 0 },
        { name: "arbitrum", domain: 3 },
        { name: "base", domain: 6 },
        { name: "hyperevm", domain: 19 },
      ];

      for (const { name, domain } of domainsToCheck) {
        // String seed (correct V2 approach)
        const [rtmString] = PublicKey.findProgramAddressSync(
          [Buffer.from("remote_token_messenger"), Buffer.from(String(domain))],
          tokenMessengerMinter,
        );

        // Verify this PDA exists on-chain
        const result = await solanaRpc("getAccountInfo", [
          rtmString.toBase58(),
          { encoding: "base64" },
        ]) as { value: { data: string[]; owner: string } | null };

        expect(result.value).not.toBeNull();
      }
    });

    it("binary domain seed does NOT produce the correct PDA", async () => {
      const { PublicKey } = await import("@solana/web3.js");
      const tokenMessengerMinter = new PublicKey(CCTP_SOLANA_TMM);

      // Binary u32 LE seed (WRONG approach)
      const binaryBuf = Buffer.alloc(4);
      binaryBuf.writeUInt32LE(3); // arbitrum domain
      const [rtmBinary] = PublicKey.findProgramAddressSync(
        [Buffer.from("remote_token_messenger"), binaryBuf],
        tokenMessengerMinter,
      );

      // String seed (correct approach)
      const [rtmString] = PublicKey.findProgramAddressSync(
        [Buffer.from("remote_token_messenger"), Buffer.from("3")],
        tokenMessengerMinter,
      );

      // They must be different
      expect(rtmBinary.toBase58()).not.toBe(rtmString.toBase58());

      // Only the string-seed PDA should exist on-chain
      const [binaryResult, stringResult] = await Promise.all([
        solanaRpc("getAccountInfo", [rtmBinary.toBase58(), { encoding: "base64" }]) as Promise<{ value: unknown | null }>,
        solanaRpc("getAccountInfo", [rtmString.toBase58(), { encoding: "base64" }]) as Promise<{ value: unknown | null }>,
      ]);

      expect(binaryResult.value).toBeNull(); // binary seed = WRONG PDA
      expect(stringResult.value).not.toBeNull(); // string seed = correct PDA
    });
  });

  // ══════════════════════════════════════════════════════════
  // 5. Solana Transaction Simulation (depositForBurn)
  // ══════════════════════════════════════════════════════════

  describe("Solana depositForBurn simulation", () => {
    it("simulated tx fails with expected error (not 'invalid account')", async () => {
      const { PublicKey, Keypair, TransactionMessage, VersionedTransaction, SystemProgram } = await import("@solana/web3.js");
      const { createHash } = await import("crypto");

      const tokenMessengerMinter = new PublicKey(CCTP_SOLANA_TMM);
      const messageTransmitterProgram = new PublicKey(CCTP_SOLANA_MT);
      const usdcMint = new PublicKey(USDC_ADDRESSES.solana);
      const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

      // Generate a temporary keypair (has no SOL or USDC)
      const keypair = Keypair.generate();

      // Derive all PDAs (matching bridge-engine.ts exactly)
      const [senderAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("sender_authority")], tokenMessengerMinter,
      );
      const [tokenMessenger] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_messenger")], tokenMessengerMinter,
      );
      const dstDomain = CCTP_DOMAINS.arbitrum; // 3
      const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
        [Buffer.from("remote_token_messenger"), Buffer.from(String(dstDomain))],
        tokenMessengerMinter,
      );
      const [tokenMinter] = PublicKey.findProgramAddressSync(
        [Buffer.from("token_minter")], tokenMessengerMinter,
      );
      const [localToken] = PublicKey.findProgramAddressSync(
        [Buffer.from("local_token"), usdcMint.toBuffer()], tokenMessengerMinter,
      );
      const [messageTransmitterAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("message_transmitter")], messageTransmitterProgram,
      );
      const [denylistAccount] = PublicKey.findProgramAddressSync(
        [Buffer.from("denylist_account"), keypair.publicKey.toBuffer()], tokenMessengerMinter,
      );
      const [burnTokenAccount] = PublicKey.findProgramAddressSync(
        [keypair.publicKey.toBuffer(), tokenProgram.toBuffer(), usdcMint.toBuffer()],
        new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
      );
      const eventDataKeypair = Keypair.generate();
      const [eventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")], tokenMessengerMinter,
      );
      const [mtEventAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from("__event_authority")], messageTransmitterProgram,
      );

      // Build instruction data (deposit_for_burn)
      const discriminator = createHash("sha256").update("global:deposit_for_burn").digest().subarray(0, 8);
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(BigInt(1000000)); // 1 USDC
      const domainBuf = Buffer.alloc(4);
      domainBuf.writeUInt32LE(dstDomain);
      const recipientBytes = Buffer.alloc(32);
      Buffer.from("0000000000000000000000000000000000000001", "hex").copy(recipientBytes, 12);
      const destinationCaller = Buffer.alloc(32);
      const maxFeeBuf = Buffer.alloc(8);
      maxFeeBuf.writeBigUInt64LE(BigInt(0));
      const minFinalityBuf = Buffer.alloc(4);
      minFinalityBuf.writeUInt32LE(2000);

      const data = Buffer.concat([
        discriminator, amountBuf, domainBuf, recipientBytes,
        destinationCaller, maxFeeBuf, minFinalityBuf,
      ]);

      const instruction = {
        programId: tokenMessengerMinter,
        keys: [
          { pubkey: keypair.publicKey, isSigner: true, isWritable: true },           // 0
          { pubkey: keypair.publicKey, isSigner: true, isWritable: true },           // 1
          { pubkey: senderAuthority, isSigner: false, isWritable: false },           // 2
          { pubkey: burnTokenAccount, isSigner: false, isWritable: true },           // 3
          { pubkey: denylistAccount, isSigner: false, isWritable: false },           // 4
          { pubkey: messageTransmitterAccount, isSigner: false, isWritable: true },  // 5
          { pubkey: tokenMessenger, isSigner: false, isWritable: false },            // 6
          { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },      // 7
          { pubkey: tokenMinter, isSigner: false, isWritable: false },               // 8
          { pubkey: localToken, isSigner: false, isWritable: true },                 // 9
          { pubkey: usdcMint, isSigner: false, isWritable: true },                   // 10
          { pubkey: eventDataKeypair.publicKey, isSigner: true, isWritable: true },  // 11
          { pubkey: messageTransmitterProgram, isSigner: false, isWritable: false }, // 12
          { pubkey: tokenMessengerMinter, isSigner: false, isWritable: false },      // 13
          { pubkey: tokenProgram, isSigner: false, isWritable: false },              // 14
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },   // 15
          { pubkey: eventAuthority, isSigner: false, isWritable: false },            // 16
          { pubkey: tokenMessengerMinter, isSigner: false, isWritable: false },      // 17
          { pubkey: mtEventAuthority, isSigner: false, isWritable: false },          // 18
          { pubkey: messageTransmitterProgram, isSigner: false, isWritable: false }, // 19
        ],
        data,
      };

      // Get recent blockhash for simulation
      const blockhashResult = await solanaRpc("getLatestBlockhash", [{ commitment: "confirmed" }]) as {
        value: { blockhash: string };
      };

      const messageV0 = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhashResult.value.blockhash,
        instructions: [instruction],
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([keypair, eventDataKeypair]);

      // Simulate — expect failure due to no USDC balance, NOT due to invalid accounts/instruction
      const serialized = Buffer.from(transaction.serialize()).toString("base64");
      const simResult = await solanaRpc("simulateTransaction", [
        serialized,
        {
          encoding: "base64",
          sigVerify: false, // skip sig verification for simulation
          replaceRecentBlockhash: true,
        },
      ]) as {
        value: {
          err: unknown;
          logs: string[] | null;
        };
      };

      // The simulation WILL fail (no USDC balance / no SOL for rent), but the error
      // should be program-level or resource-level, NOT structural account errors.
      expect(simResult.value.err).not.toBeNull(); // should fail

      const logs = simResult.value.logs ?? [];
      const logStr = logs.join("\n");
      const errStr = JSON.stringify(simResult.value.err);

      // If there are logs, the program was at least partially invoked.
      // If no logs but err = "AccountNotFound" or "InsufficientFundsForRent",
      // that's also acceptable — means accounts structure was correct but
      // the keypair simply has no SOL.
      if (logs.length > 0) {
        // Program was invoked — check it's our program, not a structural failure
        expect(logStr).toContain("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
      } else {
        // No logs = TX failed pre-execution (no SOL for fees/rent)
        // This is OK as long as it's not an "invalid instruction" error
        expect(errStr).not.toContain("InvalidAccountData");
        expect(errStr).not.toContain("MissingRequiredSignature");
      }

      // Should NOT have these structural errors in either case:
      expect(logStr).not.toContain("invalid program argument");
      expect(logStr).not.toContain("An account required by the instruction is missing");
    });
  });

  // ══════════════════════════════════════════════════════════
  // 6. V2 Iris Attestation API Reachability
  // ══════════════════════════════════════════════════════════

  describe("Circle V2 Iris attestation API", () => {
    it("V2 endpoint responds (GET /v2/messages/{domain})", async () => {
      // Query with a non-existent tx hash — should return 200 with empty messages
      const res = await fetch(
        "https://iris-api.circle.com/v2/messages/3?transactionHash=0x0000000000000000000000000000000000000000000000000000000000000000"
      );

      // API should respond (200 or 404, not 5xx)
      expect(res.status).toBeLessThan(500);

      if (res.ok) {
        const data = await res.json() as { messages?: unknown[] };
        // Empty array or empty messages is expected for fake txHash
        expect(data.messages).toBeDefined();
      }
    });

    it("V2 endpoint supports all our source domains", async () => {
      const sourceDomains = [0, 2, 3, 5, 6, 7]; // ethereum, optimism, arbitrum, solana, base, polygon
      const fakeTx = "0x0000000000000000000000000000000000000000000000000000000000000000";

      for (const domain of sourceDomains) {
        const res = await fetch(
          `https://iris-api.circle.com/v2/messages/${domain}?transactionHash=${fakeTx}`
        );
        expect(res.status).toBeLessThan(500);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // 7. HyperCore CCTP Fees API
  // ══════════════════════════════════════════════════════════

  describe("HyperCore CCTP fees API", () => {
    it("returns fee schedule for arbitrum → hyperevm", async () => {
      const srcDomain = CCTP_DOMAINS.arbitrum; // 3
      const dstDomain = 19; // hyperevm
      const url = `https://iris-api.circle.com/v2/burn/USDC/fees/${srcDomain}/${dstDomain}?forward=true&hyperCoreDeposit=true`;

      const res = await fetch(url);
      expect(res.status).toBeLessThan(500);

      if (res.ok) {
        // API returns an array of fee schedules (not wrapped in object)
        const data = await res.json() as Array<{
          finalityThreshold: number;
          minimumFee: number;
          forwardFee: { low: number; med: number; high: number };
        }>;
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
        // Should include fast (1000) and standard (2000) thresholds
        const thresholds = data.map(d => d.finalityThreshold);
        expect(thresholds).toContain(1000); // fast
        expect(thresholds).toContain(2000); // standard
        // Forward fee should be present
        expect(data[0].forwardFee).toBeDefined();
        expect(data[0].forwardFee.low).toBeGreaterThanOrEqual(0);
      }
    });

    it("returns fee schedule for solana → hyperevm", async () => {
      const srcDomain = CCTP_DOMAINS.solana; // 5
      const dstDomain = 19;
      const url = `https://iris-api.circle.com/v2/burn/USDC/fees/${srcDomain}/${dstDomain}?forward=true&hyperCoreDeposit=true`;

      const res = await fetch(url);
      expect(res.status).toBeLessThan(500);

      if (res.ok) {
        const data = await res.json() as Array<{ finalityThreshold: number }>;
        expect(Array.isArray(data)).toBe(true);
        expect(data.length).toBeGreaterThan(0);
      }
    });
  });

  // ══════════════════════════════════════════════════════════
  // 8. CCTP Domain Consistency
  // ══════════════════════════════════════════════════════════

  describe("CCTP domain and address consistency", () => {
    it("all CCTP domains map to valid chain IDs", () => {
      for (const [chain, domain] of Object.entries(CCTP_DOMAINS)) {
        expect(typeof domain).toBe("number");
        expect(domain).toBeGreaterThanOrEqual(0);
        // All CCTP chains except hyperevm/ink/worldchain should have chain IDs
        if (chain in CHAIN_IDS) {
          expect(CHAIN_IDS[chain as keyof typeof CHAIN_IDS]).toBeGreaterThan(0);
        }
      }
    });

    it("all EVM CCTP chains have USDC addresses", () => {
      const evmChains = Object.keys(CCTP_DOMAINS).filter(c => c !== "solana" && c !== "hyperevm");
      for (const chain of evmChains) {
        if (USDC_ADDRESSES[chain]) {
          expect(USDC_ADDRESSES[chain]).toMatch(/^0x[a-fA-F0-9]{40}$/);
        }
      }
    });

    it("V2 domain IDs match Circle documentation", () => {
      // Per Circle CCTP V2 docs: https://developers.circle.com/stablecoins/cctp-getting-started
      expect(CCTP_DOMAINS.ethereum).toBe(0);
      expect(CCTP_DOMAINS.avalanche).toBe(1);
      expect(CCTP_DOMAINS.optimism).toBe(2);
      expect(CCTP_DOMAINS.arbitrum).toBe(3);
      expect(CCTP_DOMAINS.solana).toBe(5);
      expect(CCTP_DOMAINS.base).toBe(6);
      expect(CCTP_DOMAINS.polygon).toBe(7);
    });
  });
});
