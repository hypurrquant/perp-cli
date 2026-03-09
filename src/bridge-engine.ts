/**
 * Unified bridge engine: Circle CCTP V2 (primary, $0 fee) + Relay + deBridge DLN (fallback).
 *
 * CCTP V2 routes (all tested with real TX):
 *   Sol→EVM:  Circle auto-relay (free)
 *   EVM→EVM:  attestation poll + manual receiveMessage on dest chain
 *   EVM→Sol:  attestation poll + Solana receiveMessage (ALT + 400k CU)
 *
 * Handles USDC bridging between Solana ↔ Arbitrum ↔ Base ↔ HyperCore
 * for cross-exchange rebalancing in funding arb.
 */

// ── Chain constants ──

export const CHAIN_IDS = {
  solana: 7565164,
  arbitrum: 42161,
  base: 8453,
} as const;

export const USDC_ADDRESSES: Record<string, string> = {
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

// Exchange → chain mapping
export const EXCHANGE_TO_CHAIN: Record<string, string> = {
  pacifica: "solana",
  hyperliquid: "hyperevm", // HyperCore CCTP: direct deposit to perps via CctpForwarder (domain 19)
  lighter: "arbitrum",
};

// Chain → RPC URLs
const RPC_URLS: Record<string, string> = {
  solana: "https://api.mainnet-beta.solana.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  base: "https://mainnet.base.org",
  hyperevm: "https://rpc.hyperliquid.xyz/evm",
};

// ── CCTP V2 Auto-Relay Fee Config ──
// Circle V2 relay: maxFee > 0 → Circle relayer calls receiveMessage automatically.
// Standard (finality=2000): minimumFee=0 (free relay), but we set a small fee for reliability.
// Fast (finality=1000): minimumFee=$1-1.3 depending on route.
const CCTP_RELAY_FEE_API = "https://iris-api.circle.com/v2/burn/USDC/fees";

/**
 * Get CCTP V2 relay fee for a route.
 * Returns maxFee in USDC subunits (6 decimals).
 */
async function getCctpRelayFee(
  srcDomain: number,
  dstDomain: number,
  finalityThreshold: number = 2000,
): Promise<{ maxFee: bigint; feeUsdc: number }> {
  try {
    const res = await fetch(`${CCTP_RELAY_FEE_API}/${srcDomain}/${dstDomain}`);
    if (res.ok) {
      const schedules = await res.json() as Array<{
        finalityThreshold: number;
        minimumFee: number;
      }>;
      const schedule = schedules.find(s => s.finalityThreshold === finalityThreshold) ?? schedules[0];
      if (schedule) {
        // minimumFee is in USDC (e.g. 0, 1.0, 1.3). Add 10% buffer for reliability.
        const feeUsdc = schedule.minimumFee > 0
          ? Math.ceil(schedule.minimumFee * 1.1 * 100) / 100  // round up to cents
          : 0.01; // $0.01 minimum to incentivize relay even for "free" routes
        return { maxFee: BigInt(Math.round(feeUsdc * 1e6)), feeUsdc };
      }
    }
  } catch {
    // fallback
  }
  // Default: $0.01 for standard, $1.50 for fast
  const fallback = finalityThreshold === 1000 ? 1.50 : 0.01;
  return { maxFee: BigInt(Math.round(fallback * 1e6)), feeUsdc: fallback };
}

// ── Balance Check ──

/**
 * Check USDC balance on an EVM chain.
 * Returns balance in USDC (human-readable).
 */
export async function getEvmUsdcBalance(chain: string, address: string): Promise<number> {
  const { ethers } = await import("ethers");
  const rpc = RPC_URLS[chain];
  const usdcAddr = USDC_ADDRESSES[chain];
  if (!rpc || !usdcAddr) throw new Error(`No RPC or USDC address for ${chain}`);

  const provider = new ethers.JsonRpcProvider(rpc);
  const usdc = new ethers.Contract(usdcAddr, [
    "function balanceOf(address) view returns (uint256)",
  ], provider);

  const balance = await usdc.balanceOf(address);
  return Number(balance) / 1e6;
}

/**
 * Check USDC balance on Solana.
 * Returns balance in USDC (human-readable).
 */
export async function getSolanaUsdcBalance(ownerPubkey: string): Promise<number> {
  const { Connection, PublicKey } = await import("@solana/web3.js");
  const connection = new Connection(RPC_URLS.solana, "confirmed");
  const owner = new PublicKey(ownerPubkey);
  const usdcMint = new PublicKey(USDC_ADDRESSES.solana);
  const tokenProgram = new PublicKey(SPL_TOKEN_PROGRAM);

  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), usdcMint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  );

  try {
    const info = await connection.getTokenAccountBalance(ata);
    return Number(info.value.uiAmount ?? 0);
  } catch {
    return 0; // ATA doesn't exist
  }
}

/**
 * Check USDC balance for a bridge source chain + address.
 */
export async function checkBridgeBalance(
  srcChain: string,
  senderAddress: string,
  requiredAmount: number,
): Promise<{ balance: number; sufficient: boolean }> {
  const balance = srcChain === "solana"
    ? await getSolanaUsdcBalance(senderAddress)
    : await getEvmUsdcBalance(srcChain, senderAddress);
  return { balance, sufficient: balance >= requiredAmount };
}

/**
 * Get native gas token balance (ETH for EVM, SOL for Solana).
 * Returns balance in human-readable units.
 */
export async function getNativeGasBalance(chain: string, address: string): Promise<number> {
  if (chain === "solana") {
    const { Connection, PublicKey, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
    const connection = new Connection(RPC_URLS.solana, "confirmed");
    const balance = await connection.getBalance(new PublicKey(address));
    return balance / LAMPORTS_PER_SOL;
  }

  const { ethers } = await import("ethers");
  const rpc = RPC_URLS[chain];
  if (!rpc) throw new Error(`No RPC for ${chain}`);
  const provider = new ethers.JsonRpcProvider(rpc);
  const balance = await provider.getBalance(address);
  return Number(ethers.formatEther(balance));
}

// Minimum gas thresholds for bridge transactions
const MIN_GAS: Record<string, { amount: number; symbol: string }> = {
  solana:   { amount: 0.01,   symbol: "SOL" },
  arbitrum: { amount: 0.0001, symbol: "ETH" },
  base:     { amount: 0.0001, symbol: "ETH" },
  hyperevm: { amount: 0.0001, symbol: "ETH" },
};

/**
 * Check gas balance on source (and optionally destination) chains before bridging.
 * Returns errors for any chain with insufficient gas.
 */
export async function checkBridgeGasBalance(
  srcChain: string,
  srcAddress: string,
  dstChain: string,
  dstAddress: string,
  needsDstGas: boolean,
): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  const srcMin = MIN_GAS[srcChain];
  if (srcMin) {
    const srcGas = await getNativeGasBalance(srcChain, srcAddress);
    if (srcGas < srcMin.amount) {
      errors.push(
        `Source ${srcChain}: ${srcGas.toFixed(6)} ${srcMin.symbol} (need ≥${srcMin.amount} ${srcMin.symbol})`
      );
    }
  }

  if (needsDstGas) {
    const dstMin = MIN_GAS[dstChain];
    if (dstMin) {
      const dstGas = await getNativeGasBalance(dstChain, dstAddress);
      if (dstGas < dstMin.amount) {
        errors.push(
          `Destination ${dstChain}: ${dstGas.toFixed(6)} ${dstMin.symbol} (need ≥${dstMin.amount} ${dstMin.symbol})`
        );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── HyperCore CCTP (Solana/EVM → Hyperliquid perps via CctpForwarder) ──

const HYPERCORE_CCTP_DOMAIN = 19; // HyperEVM domain in CCTP
const HYPERCORE_CCTP_FORWARDER = "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757";
const HYPERCORE_FEES_API = "https://iris-api.circle.com/v2/burn/USDC/fees";
const HYPERCORE_DEX_PERPS = 0;
// const HYPERCORE_DEX_SPOT = 4294967295;

/**
 * Encode hook data for CctpForwarder → HyperCore deposit.
 * Format: magic(24) + version(4) + dataLength(4) + [address(20) + dexId(4)]
 */
function encodeHyperCoreHookData(
  recipientAddress?: string,
  dexId: number = HYPERCORE_DEX_PERPS,
): string {
  const magic = Buffer.from("cctp-forward", "utf-8").toString("hex").padEnd(48, "0");
  const version = "00000000";

  if (!recipientAddress) {
    return `0x${magic}${version}00000000`;
  }

  const addr = recipientAddress.replace("0x", "").toLowerCase();
  const dex = (dexId >>> 0).toString(16).padStart(8, "0");
  return `0x${magic}${version}00000018${addr}${dex}`;
}

/**
 * Get CCTP fees for a Solana/EVM → HyperCore transfer.
 */
async function getHyperCoreCctpFees(
  srcDomain: number,
  amount: number,
): Promise<{ protocolFee: number; forwardingFee: number; totalFee: number; maxFee: number }> {
  const url = `${HYPERCORE_FEES_API}/${srcDomain}/${HYPERCORE_CCTP_DOMAIN}?forward=true&hyperCoreDeposit=true`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      // API returns array: [{finalityThreshold, minimumFee, forwardFee: {low, med, high}}, ...]
      const schedules = await res.json() as Array<{
        finalityThreshold: number;
        minimumFee: number;
        feeRate?: number;
        forwardFee?: { low: number; med: number; high: number };
      }>;
      // Use fast transfer schedule (threshold=1000) if available, else first
      const fast = schedules.find(s => s.finalityThreshold === 1000) ?? schedules[0];
      if (fast) {
        const bps = Number(fast.feeRate ?? 1); // basis points, default 1bp
        const forwardFee = Number(fast.forwardFee?.med ?? fast.forwardFee?.low ?? 200000); // subunits
        const protocolFee = Math.ceil(amount * 1e6 * bps / 10000);
        return {
          protocolFee: protocolFee / 1e6,
          forwardingFee: forwardFee / 1e6,
          totalFee: (protocolFee + forwardFee) / 1e6,
          maxFee: protocolFee + forwardFee, // in subunits for instruction
        };
      }
    }
  } catch {
    // fallback to defaults
  }
  // Default: 1bp + $0.20
  const protocolFee = Math.ceil(amount * 1e6 / 10000);
  const forwardingFee = 200000;
  return {
    protocolFee: protocolFee / 1e6,
    forwardingFee: 0.20,
    totalFee: (protocolFee + forwardingFee) / 1e6,
    maxFee: protocolFee + forwardingFee,
  };
}

// ── deBridge DLN API ──

const DLN_API = "https://dln.debridge.finance/v1.0/dln/order";

// Builder/affiliate config — set via env vars or defaults
const DEBRIDGE_REFERRAL_CODE = process.env.DEBRIDGE_REFERRAL_CODE ?? "";
const DEBRIDGE_AFFILIATE_FEE_PERCENT = process.env.DEBRIDGE_AFFILIATE_FEE_PERCENT ?? ""; // e.g. "0.1" for 0.1%
const DEBRIDGE_AFFILIATE_FEE_RECIPIENT = process.env.DEBRIDGE_AFFILIATE_FEE_RECIPIENT ?? "";

export interface BridgeQuote {
  provider: "debridge" | "cctp" | "relay";
  srcChain: string;
  dstChain: string;
  amountIn: number;      // USDC
  amountOut: number;      // USDC received
  fee: number;            // total cost (including relay/gas)
  estimatedTime: number;  // seconds
  gasIncluded: boolean;   // true = auto-relay (no dst gas needed), false = manual (user pays dst gas)
  gasNote?: string;       // human-readable note about gas/relay
  raw: unknown;           // raw API response for execution
}

export interface BridgeResult {
  provider: string;
  txHash: string;
  srcChain: string;
  dstChain: string;
  amountIn: number;
  amountOut: number;
  receiveTxHash?: string; // destination receiveMessage tx hash (CCTP)
}

/**
 * Get a bridge quote via deBridge DLN.
 */
export async function getDebridgeQuote(
  srcChain: string,
  dstChain: string,
  amountUsdc: number,
  senderAddress: string,
  recipientAddress: string,
): Promise<BridgeQuote> {
  const srcChainId = CHAIN_IDS[srcChain as keyof typeof CHAIN_IDS];
  const dstChainId = CHAIN_IDS[dstChain as keyof typeof CHAIN_IDS];
  if (!srcChainId || !dstChainId) throw new Error(`Unsupported chain: ${srcChain} or ${dstChain}`);

  const srcToken = USDC_ADDRESSES[srcChain];
  const dstToken = USDC_ADDRESSES[dstChain];
  if (!srcToken || !dstToken) throw new Error(`No USDC address for ${srcChain} or ${dstChain}`);

  const amountRaw = String(Math.round(amountUsdc * 1e6));

  // Step 1: Get quote
  const quoteParams = new URLSearchParams({
    srcChainId: String(srcChainId),
    srcChainTokenIn: srcToken,
    srcChainTokenInAmount: amountRaw,
    dstChainId: String(dstChainId),
    dstChainTokenOut: dstToken,
    prependOperatingExpenses: "true",
  });
  appendDebridgeBuilderParams(quoteParams);

  const quoteRes = await fetch(`${DLN_API}/quote?${quoteParams}`);
  if (!quoteRes.ok) throw new Error(`deBridge quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = await quoteRes.json() as Record<string, unknown>;

  const estimation = quote.estimation as Record<string, unknown>;
  const dstOut = estimation?.dstChainTokenOut as Record<string, unknown>;
  const amountOut = Number(dstOut?.recommendedAmount ?? dstOut?.amount ?? 0) / 1e6;
  const fulfillDelay = Number((quote.order as Record<string, unknown>)?.approximateFulfillmentDelay ?? 10);

  return {
    provider: "debridge",
    srcChain,
    dstChain,
    amountIn: amountUsdc,
    amountOut,
    fee: amountUsdc - amountOut,
    estimatedTime: fulfillDelay,
    gasIncluded: true,
    gasNote: "DLN market maker fulfills on destination",
    raw: { quote, senderAddress, recipientAddress, amountRaw },
  };
}

/**
 * Execute a deBridge bridge transaction.
 * Returns the TX hash after signing and submitting.
 */
export async function executeDebridgeBridge(
  bridgeQuote: BridgeQuote,
  signerKey: string, // EVM private key or Solana private key (base58)
): Promise<BridgeResult> {
  const { srcChain, dstChain, amountIn, amountOut } = bridgeQuote;
  const { senderAddress, recipientAddress, amountRaw } = bridgeQuote.raw as {
    senderAddress: string; recipientAddress: string; amountRaw: string;
  };

  const srcChainId = CHAIN_IDS[srcChain as keyof typeof CHAIN_IDS];
  const dstChainId = CHAIN_IDS[dstChain as keyof typeof CHAIN_IDS];
  const srcToken = USDC_ADDRESSES[srcChain];
  const dstToken = USDC_ADDRESSES[dstChain];

  // Get recommended amount from quote
  const quote = (bridgeQuote.raw as Record<string, unknown>).quote as Record<string, unknown>;
  const estimation = quote.estimation as Record<string, unknown>;
  const dstOut = estimation?.dstChainTokenOut as Record<string, unknown>;
  const dstAmount = String(dstOut?.recommendedAmount ?? dstOut?.amount ?? "0");

  // Step 2: Create TX
  const createParams = new URLSearchParams({
    srcChainId: String(srcChainId),
    srcChainTokenIn: srcToken,
    srcChainTokenInAmount: amountRaw,
    dstChainId: String(dstChainId),
    dstChainTokenOut: dstToken,
    dstChainTokenOutAmount: dstAmount,
    dstChainTokenOutRecipient: recipientAddress,
    srcChainOrderAuthorityAddress: senderAddress,
    dstChainOrderAuthorityAddress: recipientAddress,
    prependOperatingExpenses: "true",
  });
  appendDebridgeBuilderParams(createParams);

  const createRes = await fetch(`${DLN_API}/create-tx?${createParams}`);
  if (!createRes.ok) throw new Error(`deBridge create-tx failed: ${createRes.status} ${await createRes.text()}`);
  const createTx = await createRes.json() as Record<string, unknown>;

  const tx = createTx.tx as Record<string, unknown>;
  if (!tx) throw new Error("deBridge returned no transaction data");

  // Step 3: Sign and submit
  let txHash: string;

  if (srcChain === "solana") {
    txHash = await submitSolanaTransaction(tx, signerKey);
  } else {
    txHash = await submitEvmTransaction(tx, signerKey, srcChain);
  }

  return {
    provider: "debridge",
    txHash,
    srcChain,
    dstChain,
    amountIn,
    amountOut,
  };
}

/**
 * Submit a Solana transaction from deBridge create-tx response.
 */
async function submitSolanaTransaction(tx: Record<string, unknown>, signerKey: string): Promise<string> {
  const { Connection, VersionedTransaction, Keypair } = await import("@solana/web3.js");
  const bs58 = await import("bs58");

  const connection = new Connection(RPC_URLS.solana, "confirmed");

  // Decode the keypair
  let keypair: InstanceType<typeof Keypair>;
  try {
    // Try base58 first (standard Solana private key format)
    keypair = Keypair.fromSecretKey(bs58.default.decode(signerKey));
  } catch {
    // Try JSON array (Solana CLI format)
    try {
      keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(signerKey)));
    } catch {
      throw new Error("Invalid Solana private key format");
    }
  }

  // deBridge returns hex-encoded VersionedTransaction for Solana
  const txData = String(tx.data);
  const txBytes = hexToBytes(txData.startsWith("0x") ? txData.slice(2) : txData);
  const transaction = VersionedTransaction.deserialize(txBytes);

  // Update blockhash and sign
  const { blockhash } = await connection.getLatestBlockhash();
  transaction.message.recentBlockhash = blockhash;
  transaction.sign([keypair]);

  const signature = await connection.sendTransaction(transaction, { skipPreflight: false });
  await connection.confirmTransaction(signature, "confirmed");

  return signature;
}

/**
 * Submit an EVM transaction from deBridge create-tx response.
 */
async function submitEvmTransaction(tx: Record<string, unknown>, privateKey: string, chain: string): Promise<string> {
  const { ethers } = await import("ethers");

  const rpc = RPC_URLS[chain] ?? RPC_URLS.arbitrum;
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(privateKey, provider);

  // Check and approve USDC allowance if needed
  const usdcAddr = USDC_ADDRESSES[chain];
  const spenderAddr = String(tx.to);
  const value = BigInt(String(tx.value ?? "0"));

  if (usdcAddr && spenderAddr) {
    const usdc = new ethers.Contract(usdcAddr, [
      "function allowance(address,address) view returns (uint256)",
      "function approve(address,uint256) returns (bool)",
    ], wallet);

    const allowance = await usdc.allowance(wallet.address, spenderAddr);
    // Approve max if allowance insufficient
    if (allowance < ethers.parseUnits("1000000", 6)) {
      const approveTx = await usdc.approve(spenderAddr, ethers.MaxUint256);
      await approveTx.wait();
    }
  }

  // Send the bridge transaction
  const txResponse = await wallet.sendTransaction({
    to: String(tx.to),
    data: String(tx.data),
    value,
  });
  const receipt = await txResponse.wait();

  return receipt!.hash;
}

// ── Circle CCTP V2 (EVM + Solana) ──

export const CCTP_DOMAINS: Record<string, number> = {
  arbitrum: 3,
  solana: 5,
  base: 6,
  hyperevm: 19,
};

// EVM V2 contracts — ALL EVM chains use the same V2 proxy addresses (per Circle docs)
const EVM_TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const EVM_MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
export const EVM_TOKEN_MINTER_V2 = "0xfd78EE919681417d192449715b2594ab58f5D002";

// Populate per-chain lookups (all EVM chains share identical V2 addresses)
const EVM_CCTP_CHAINS = Object.keys(CCTP_DOMAINS).filter(c => c !== "solana");
const CCTP_TOKEN_MESSENGER: Record<string, string> = Object.fromEntries(
  EVM_CCTP_CHAINS.map(c => [c, EVM_TOKEN_MESSENGER_V2]),
);
const CCTP_MESSAGE_TRANSMITTER: Record<string, string> = Object.fromEntries(
  EVM_CCTP_CHAINS.map(c => [c, EVM_MESSAGE_TRANSMITTER_V2]),
);

// Solana CCTP V2 programs (mainnet)
const CCTP_SOLANA_TOKEN_MESSENGER_MINTER = "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe";
const CCTP_SOLANA_MESSAGE_TRANSMITTER = "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC";

// Solana constants
const USDC_MINT_SOLANA = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/**
 * Check if CCTP is supported for a given chain.
 */
function isCctpSupported(chain: string): boolean {
  return chain in CCTP_DOMAINS;
}

/**
 * Get a CCTP V2 bridge quote. Supports EVM ↔ EVM, Solana ↔ EVM, and → HyperCore.
 *
 * @param fast - If true, use fast finality (1000): ~1-2 min, auto-relay, $1-1.3 fee.
 *               If false (default), use standard finality (2000): ~13-20 min, manual relay, $0.01 fee.
 */
export async function getCctpQuote(
  srcChain: string,
  dstChain: string,
  amountUsdc: number,
  fast: boolean = false,
): Promise<BridgeQuote> {
  if (!isCctpSupported(srcChain)) throw new Error(`CCTP not supported on ${srcChain}`);
  if (!isCctpSupported(dstChain)) throw new Error(`CCTP not supported on ${dstChain}`);

  // HyperCore → EVM: HL withdrawal + CCTP forwarding (~0.20 USDC fee)
  if (srcChain === "hyperevm") {
    const forwardingFee = 0.20; // CCTP forwarding fee for Arbitrum
    return {
      provider: "cctp",
      srcChain,
      dstChain,
      amountIn: amountUsdc,
      amountOut: amountUsdc - forwardingFee,
      fee: forwardingFee,
      estimatedTime: 60, // ~1 min with fast finality
      gasIncluded: true,
      gasNote: "HyperCore handles forwarding",
      raw: { type: "cctp-hypercore-withdraw", fast },
    };
  }

  const isHyperCore = dstChain === "hyperevm";

  // HyperCore route has protocol fee + forwarding fee
  if (isHyperCore) {
    const srcDomain = CCTP_DOMAINS[srcChain];
    if (srcDomain === undefined) throw new Error(`No CCTP domain for ${srcChain}`);
    const fees = await getHyperCoreCctpFees(srcDomain, amountUsdc);
    const estimatedTime = srcChain === "solana" ? 65 : 60;
    return {
      provider: "cctp",
      srcChain,
      dstChain,
      amountIn: amountUsdc,
      amountOut: amountUsdc - fees.totalFee,
      fee: fees.totalFee,
      estimatedTime,
      gasIncluded: true,
      gasNote: "CctpForwarder auto-deposits to HyperCore",
      raw: { type: "cctp-hypercore", maxFee: fees.maxFee, fast },
    };
  }

  // Standard CCTP V2
  const finality = fast ? 1000 : 2000;

  // Fetch relay fee from Circle API
  const srcDomain = CCTP_DOMAINS[srcChain];
  const dstDomain = CCTP_DOMAINS[dstChain];
  const { maxFee, feeUsdc } = await getCctpRelayFee(srcDomain!, dstDomain!, finality);

  // fast (1000): Circle relayer auto-relays, ~1-2 min, $1-1.3 fee
  // standard (2000): manual receiveMessage needed, ~13-20 min, $0.01 fee
  const estimatedTime = fast
    ? ((srcChain === "solana" || dstChain === "solana") ? 90 : 60)
    : ((srcChain === "solana" || dstChain === "solana") ? 180 : 900);

  return {
    provider: "cctp",
    srcChain,
    dstChain,
    amountIn: amountUsdc,
    amountOut: amountUsdc - feeUsdc,
    fee: feeUsdc,
    estimatedTime,
    gasIncluded: fast, // fast = Circle auto-relay, standard = manual receiveMessage
    gasNote: fast
      ? `Fast auto-relay (maxFee $${feeUsdc.toFixed(2)}, ~1-2 min)`
      : `Standard relay (maxFee $${feeUsdc.toFixed(2)}, ~13-20 min, manual receiveMessage on dst)`,
    raw: { type: "cctp", maxFee: Number(maxFee), fast },
  };
}

/**
 * Execute a CCTP V2 bridge. Routes to the appropriate implementation.
 *
 * @param fast - If true, use fast finality (1000): Circle auto-relays, no manual receiveMessage.
 *               If false (default), use standard finality (2000): cheaper but requires manual relay.
 */
export async function executeCctpBridge(
  srcChain: string,
  dstChain: string,
  amountUsdc: number,
  signerKey: string,
  recipientAddress: string,
  dstSignerKey?: string, // EVM key for receiveMessage (Solana→EVM) or Solana key for receiveMessage (EVM→Solana)
  fast: boolean = false,
): Promise<BridgeResult> {
  // HyperCore route: depositForBurnWithHook via CctpForwarder
  if (dstChain === "hyperevm") {
    if (srcChain === "solana") {
      return executeCctpSolanaToHyperCore(amountUsdc, signerKey, recipientAddress);
    }
    return executeCctpEvmToHyperCore(srcChain, amountUsdc, signerKey, recipientAddress);
  }
  // HyperCore → EVM: sendToEvmWithData via HL exchange API
  if (srcChain === "hyperevm") {
    return executeCctpHyperCoreToEvm(dstChain, amountUsdc, signerKey, recipientAddress);
  }
  if (srcChain === "solana") {
    return executeCctpSolanaToEvm(dstChain, amountUsdc, signerKey, recipientAddress, dstSignerKey, fast);
  }
  if (dstChain === "solana") {
    return executeCctpEvmToSolana(srcChain, amountUsdc, signerKey, recipientAddress, dstSignerKey, fast);
  }
  return executeCctpEvmToEvm(srcChain, dstChain, amountUsdc, signerKey, recipientAddress, fast);
}

// ── CCTP: Solana → HyperCore (depositForBurnWithHook) ──

async function executeCctpSolanaToHyperCore(
  amountUsdc: number,
  signerKey: string,
  recipientAddress: string, // EVM address for HyperCore perps
): Promise<BridgeResult> {
  const { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, SystemProgram } = await import("@solana/web3.js");
  const bs58 = await import("bs58");
  const { createHash } = await import("crypto");

  const connection = new Connection(RPC_URLS.solana, "confirmed");

  // Decode Solana keypair
  let keypair: InstanceType<typeof Keypair>;
  try {
    keypair = Keypair.fromSecretKey(bs58.default.decode(signerKey));
  } catch {
    try { keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(signerKey))); }
    catch { throw new Error("Invalid Solana private key format"); }
  }

  const tokenMessengerMinter = new PublicKey(CCTP_SOLANA_TOKEN_MESSENGER_MINTER);
  const messageTransmitterProgram = new PublicKey(CCTP_SOLANA_MESSAGE_TRANSMITTER);
  const usdcMint = new PublicKey(USDC_MINT_SOLANA);
  const tokenProgram = new PublicKey(SPL_TOKEN_PROGRAM);

  // Calculate fees
  const fees = await getHyperCoreCctpFees(CCTP_DOMAINS.solana, amountUsdc);

  // Derive PDAs — TMM = TokenMessengerMinter, MT = MessageTransmitter
  const [senderAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("sender_authority")], tokenMessengerMinter,
  );
  const [tokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_messenger")], tokenMessengerMinter,
  );
  // Circle uses domain as UTF-8 string seed (e.g., "19"), NOT binary buffer
  const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("remote_token_messenger"), Buffer.from(String(HYPERCORE_CCTP_DOMAIN))], tokenMessengerMinter,
  );
  const [tokenMinter] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_minter")], tokenMessengerMinter,
  );
  const [localToken] = PublicKey.findProgramAddressSync(
    [Buffer.from("local_token"), usdcMint.toBuffer()], tokenMessengerMinter,
  );
  // MessageTransmitter state PDA (owned by MT program)
  const [messageTransmitterAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("message_transmitter")], messageTransmitterProgram,
  );
  // Denylist account PDA: ["denylist_account", owner] from TMM — may not exist (not denylisted)
  const [denylistAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("denylist_account"), keypair.publicKey.toBuffer()], tokenMessengerMinter,
  );
  const [burnTokenAccount] = PublicKey.findProgramAddressSync(
    [keypair.publicKey.toBuffer(), tokenProgram.toBuffer(), usdcMint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  );
  const eventDataKeypair = Keypair.generate();
  // Event authority PDAs — TMM and MT each have their own (for Anchor CPI events)
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")], tokenMessengerMinter,
  );
  const [mtEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")], messageTransmitterProgram,
  );

  // Build instruction data for depositForBurnWithHook
  // Anchor discriminator: sha256("global:deposit_for_burn_with_hook")[0..8]
  const discriminator = createHash("sha256").update("global:deposit_for_burn_with_hook").digest().subarray(0, 8);

  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(Math.round(amountUsdc * 1e6)));

  // Domain as u32 LE for instruction data (different from PDA seed which uses string)
  const domainBuf = Buffer.alloc(4);
  domainBuf.writeUInt32LE(HYPERCORE_CCTP_DOMAIN);

  // mintRecipient: CctpForwarder address (left-padded to 32 bytes)
  const mintRecipient = Buffer.alloc(32);
  Buffer.from(HYPERCORE_CCTP_FORWARDER.replace("0x", ""), "hex").copy(mintRecipient, 12);

  // destinationCaller: same as CctpForwarder (required by docs)
  const destinationCaller = Buffer.alloc(32);
  Buffer.from(HYPERCORE_CCTP_FORWARDER.replace("0x", ""), "hex").copy(destinationCaller, 12);

  // maxFee
  const maxFeeBuf = Buffer.alloc(8);
  maxFeeBuf.writeBigUInt64LE(BigInt(fees.maxFee));

  // minFinalityThreshold: 1000 (fast transfer)
  const minFinalityBuf = Buffer.alloc(4);
  minFinalityBuf.writeUInt32LE(1000);

  // hookData: encode for HyperCore perps deposit
  const hookDataHex = encodeHyperCoreHookData(recipientAddress, HYPERCORE_DEX_PERPS);
  const hookDataBytes = Buffer.from(hookDataHex.replace("0x", ""), "hex");
  // Borsh-style: 4-byte length prefix + data
  const hookLenBuf = Buffer.alloc(4);
  hookLenBuf.writeUInt32LE(hookDataBytes.length);

  const data = Buffer.concat([
    discriminator, amountBuf, domainBuf, mintRecipient,
    destinationCaller, maxFeeBuf, minFinalityBuf,
    hookLenBuf, hookDataBytes,
  ]);

  const instruction = {
    programId: tokenMessengerMinter,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },           // 0: owner
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },           // 1: eventRentPayer
      { pubkey: senderAuthority, isSigner: false, isWritable: false },           // 2: senderAuthorityPda
      { pubkey: burnTokenAccount, isSigner: false, isWritable: true },           // 3: burnTokenAccount
      { pubkey: denylistAccount, isSigner: false, isWritable: false },           // 4: denylistAccount
      { pubkey: messageTransmitterAccount, isSigner: false, isWritable: true },  // 5: messageTransmitter (MT state)
      { pubkey: tokenMessenger, isSigner: false, isWritable: false },            // 6: tokenMessenger
      { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },      // 7: remoteTokenMessenger
      { pubkey: tokenMinter, isSigner: false, isWritable: false },               // 8: tokenMinter
      { pubkey: localToken, isSigner: false, isWritable: true },                 // 9: localToken
      { pubkey: usdcMint, isSigner: false, isWritable: true },                   // 10: burnTokenMint
      { pubkey: eventDataKeypair.publicKey, isSigner: true, isWritable: true },  // 11: messageSentEventData
      { pubkey: messageTransmitterProgram, isSigner: false, isWritable: false }, // 12: messageTransmitterProgram
      { pubkey: tokenMessengerMinter, isSigner: false, isWritable: false },      // 13: tokenMessengerMinterProgram
      { pubkey: tokenProgram, isSigner: false, isWritable: false },              // 14: tokenProgram
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },   // 15: systemProgram
      { pubkey: eventAuthority, isSigner: false, isWritable: false },            // 16: TMM eventAuthority
      { pubkey: tokenMessengerMinter, isSigner: false, isWritable: false },      // 17: TMM program (self)
      { pubkey: mtEventAuthority, isSigner: false, isWritable: false },          // 18: MT eventAuthority
      { pubkey: messageTransmitterProgram, isSigner: false, isWritable: false }, // 19: MT program
    ],
    data,
  };

  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([keypair, eventDataKeypair]);

  const signature = await connection.sendTransaction(transaction, { skipPreflight: false });
  await connection.confirmTransaction(signature, "confirmed");

  return {
    provider: "cctp (HyperCore)",
    txHash: signature,
    srcChain: "solana",
    dstChain: "hyperevm",
    amountIn: amountUsdc,
    amountOut: amountUsdc - fees.totalFee,
  };
}

// ── CCTP: EVM → HyperCore (CctpExtension.batchDepositForBurnWithAuth) ──
// Uses EIP-3009 ReceiveWithAuthorization — no separate approve TX needed.
// CctpExtension contract: 0xA95d9c1F655341597C94393fDdc30cf3c08E4fcE (Arbitrum mainnet)

const CCTP_EXTENSION: Record<string, string> = {
  arbitrum: "0xA95d9c1F655341597C94393fDdc30cf3c08E4fcE",
};

// USDC EIP-712 domain names per chain (for ReceiveWithAuthorization)
const USDC_EIP712_NAME: Record<string, string> = {
  arbitrum: "USD Coin",
  base: "USD Coin",
};
const USDC_EIP712_VERSION: Record<string, string> = {
  arbitrum: "2",
  base: "2",
};

// ── CCTP: HyperCore → EVM (sendToEvmWithData via HL exchange API) ──

async function executeCctpHyperCoreToEvm(
  dstChain: string,
  amountUsdc: number,
  signerKey: string,
  recipientAddress: string,
): Promise<BridgeResult> {
  const { ethers, Signature: EthSig } = await import("ethers");

  const wallet = new ethers.Wallet(signerKey);
  const dstDomain = CCTP_DOMAINS[dstChain];
  if (dstDomain === undefined) throw new Error(`No CCTP domain for ${dstChain}`);

  const dstChainId = CHAIN_IDS[dstChain as keyof typeof CHAIN_IDS];
  if (!dstChainId) throw new Error(`No chain ID for ${dstChain}`);

  const signatureChainId = "0x" + dstChainId.toString(16);
  const timestamp = Date.now();

  // Build action payload
  const action = {
    type: "sendToEvmWithData",
    hyperliquidChain: "Mainnet",
    signatureChainId,
    token: "USDC",
    amount: String(amountUsdc),
    sourceDex: "spot", // unified accounts hold funds in spot
    destinationRecipient: recipientAddress,
    addressEncoding: "hex",
    destinationChainId: dstDomain,
    gasLimit: 200000,
    data: "0x", // empty = automatic forwarding
    nonce: timestamp,
  };

  // EIP-712 signing
  const domain = {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: dstChainId,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };

  const types = {
    "HyperliquidTransaction:SendToEvmWithData": [
      { name: "hyperliquidChain", type: "string" },
      { name: "token", type: "string" },
      { name: "amount", type: "string" },
      { name: "sourceDex", type: "string" },
      { name: "destinationRecipient", type: "string" },
      { name: "addressEncoding", type: "string" },
      { name: "destinationChainId", type: "uint32" },
      { name: "gasLimit", type: "uint64" },
      { name: "data", type: "bytes" },
      { name: "nonce", type: "uint64" },
    ],
  };

  const message = {
    hyperliquidChain: "Mainnet",
    token: "USDC",
    amount: String(amountUsdc),
    sourceDex: "spot",
    destinationRecipient: recipientAddress,
    addressEncoding: "hex",
    destinationChainId: dstDomain,
    gasLimit: BigInt(200000),
    data: "0x",
    nonce: BigInt(timestamp),
  };

  const sigHex = await wallet.signTypedData(domain, types, message);
  const sig = EthSig.from(sigHex);

  // Submit to HL exchange API
  const resp = await fetch("https://api.hyperliquid.xyz/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action,
      nonce: timestamp,
      signature: { r: sig.r, s: sig.s, v: sig.v },
    }),
  });

  const result = await resp.json() as Record<string, unknown>;
  if (result.status !== "ok") {
    throw new Error(`HyperCore withdrawal failed: ${JSON.stringify(result)}`);
  }

  return {
    provider: "cctp (HyperCore → EVM via sendToEvmWithData)",
    txHash: typeof result.response === "string" ? result.response : JSON.stringify(result.response ?? result.data ?? "submitted"),
    srcChain: "hyperevm",
    dstChain,
    amountIn: amountUsdc,
    amountOut: amountUsdc, // forwarding fee deducted on-chain
  };
}

// ── CCTP: EVM → HyperCore (CctpExtension batchDepositForBurnWithAuth) ──

async function executeCctpEvmToHyperCore(
  srcChain: string,
  amountUsdc: number,
  signerKey: string,
  recipientAddress: string,
): Promise<BridgeResult> {
  const { ethers } = await import("ethers");
  const { randomBytes } = await import("crypto");

  const srcRpc = RPC_URLS[srcChain] ?? RPC_URLS.arbitrum;
  const srcProvider = new ethers.JsonRpcProvider(srcRpc);
  const srcWallet = new ethers.Wallet(signerKey, srcProvider);

  const usdcAddr = USDC_ADDRESSES[srcChain];
  const cctpExtensionAddr = CCTP_EXTENSION[srcChain];
  if (!usdcAddr) throw new Error(`No USDC address for ${srcChain}`);
  if (!cctpExtensionAddr) throw new Error(`CctpExtension not configured for ${srcChain}`);

  const srcDomain = CCTP_DOMAINS[srcChain];
  if (srcDomain === undefined) throw new Error(`No CCTP domain for ${srcChain}`);
  const chainId = CHAIN_IDS[srcChain as keyof typeof CHAIN_IDS];
  if (!chainId) throw new Error(`No chain ID for ${srcChain}`);

  const fees = await getHyperCoreCctpFees(srcDomain, amountUsdc);
  const amountRaw = BigInt(Math.round(amountUsdc * 1e6));

  // ── Step 1: Sign EIP-3009 ReceiveWithAuthorization ──
  // This authorizes CctpExtension to pull USDC from the sender (no approve TX needed)
  const authNonce = "0x" + randomBytes(32).toString("hex");
  const validAfter = 0;
  const validBefore = Math.floor(Date.now() / 1000) + 3600; // 1 hour

  const usdcDomain = {
    name: USDC_EIP712_NAME[srcChain] ?? "USD Coin",
    version: USDC_EIP712_VERSION[srcChain] ?? "2",
    chainId,
    verifyingContract: usdcAddr,
  };

  const receiveAuthTypes = {
    ReceiveWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  };

  const receiveAuthValue = {
    from: srcWallet.address,
    to: cctpExtensionAddr,
    value: amountRaw,
    validAfter,
    validBefore,
    nonce: authNonce,
  };

  const sig = await srcWallet.signTypedData(usdcDomain, receiveAuthTypes, receiveAuthValue);
  const { v, r, s } = ethers.Signature.from(sig);

  // ── Step 2: Build burn params ──
  // mintRecipient & destinationCaller = CctpForwarder (bytes32)
  const forwarderBytes32 = ethers.zeroPadValue(HYPERCORE_CCTP_FORWARDER, 32);

  // hookData for HyperCore perps deposit
  const hookData = encodeHyperCoreHookData(recipientAddress, HYPERCORE_DEX_PERPS);

  // Auth tuple: (value, validAfter, validBefore, nonce, v, r, s)
  const authParams = [amountRaw, validAfter, validBefore, authNonce, v, r, s];

  // Burn tuple: (amount, destinationDomain, mintRecipient, destinationCaller, maxFee, minFinalityThreshold, hookData)
  const burnParams = [amountRaw, HYPERCORE_CCTP_DOMAIN, forwarderBytes32, forwarderBytes32, BigInt(fees.maxFee), 1000, hookData];

  // ── Step 3: Call CctpExtension.batchDepositForBurnWithAuth ──
  const cctpExtension = new ethers.Contract(cctpExtensionAddr, [
    "function batchDepositForBurnWithAuth(tuple(uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) authParams, tuple(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData) burnParams)",
  ], srcWallet);

  const depositTx = await cctpExtension.batchDepositForBurnWithAuth(authParams, burnParams);
  const receipt = await depositTx.wait();

  return {
    provider: "cctp (HyperCore via CctpExtension)",
    txHash: receipt.hash,
    srcChain,
    dstChain: "hyperevm",
    amountIn: amountUsdc,
    amountOut: amountUsdc - fees.totalFee,
  };
}

// ── CCTP: EVM → EVM ──

async function executeCctpEvmToEvm(
  srcChain: string,
  dstChain: string,
  amountUsdc: number,
  signerKey: string,
  recipientAddress: string,
  fast: boolean = false,
): Promise<BridgeResult> {
  const { ethers } = await import("ethers");

  const srcRpc = RPC_URLS[srcChain] ?? RPC_URLS.arbitrum;
  const srcProvider = new ethers.JsonRpcProvider(srcRpc);
  const srcWallet = new ethers.Wallet(signerKey, srcProvider);

  const usdcAddr = USDC_ADDRESSES[srcChain];
  const tokenMessengerAddr = CCTP_TOKEN_MESSENGER[srcChain];
  const dstDomain = CCTP_DOMAINS[dstChain];
  const srcDomain = CCTP_DOMAINS[srcChain];

  if (!usdcAddr || !tokenMessengerAddr || dstDomain === undefined || srcDomain === undefined) {
    throw new Error(`CCTP not configured for ${srcChain} → ${dstChain}`);
  }

  // Step 0: Check USDC balance
  const balance = await getEvmUsdcBalance(srcChain, srcWallet.address);
  if (balance < amountUsdc) {
    throw new Error(`Insufficient USDC on ${srcChain}: have ${balance.toFixed(2)}, need ${amountUsdc}`);
  }

  const amountRaw = BigInt(Math.round(amountUsdc * 1e6));

  // Step 1: Approve USDC
  const usdc = new ethers.Contract(usdcAddr, [
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], srcWallet);

  const allowance = await usdc.allowance(srcWallet.address, tokenMessengerAddr);
  if (allowance < amountRaw) {
    const approveTx = await usdc.approve(tokenMessengerAddr, ethers.MaxUint256);
    await approveTx.wait();
  }

  // Step 2: Get relay fee
  const finality = fast ? 1000 : 2000;
  const { maxFee } = await getCctpRelayFee(srcDomain, dstDomain, finality);

  // Step 3: depositForBurn (V2: 7-parameter signature)
  const mintRecipient = ethers.zeroPadValue(recipientAddress, 32);
  const destinationCaller = ethers.ZeroHash; // permissionless relay
  const tokenMessenger = new ethers.Contract(tokenMessengerAddr, [
    "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64 nonce)",
  ], srcWallet);

  const depositTx = await tokenMessenger.depositForBurn(
    amountRaw, dstDomain, mintRecipient, usdcAddr,
    destinationCaller, maxFee, finality,
  );
  const receipt = await depositTx.wait();
  const txHash = receipt.hash;

  // Fast finality (1000): Circle auto-relays — done, no manual relay needed.
  if (fast) {
    return { provider: "cctp (fast)", txHash, srcChain, dstChain, amountIn: amountUsdc, amountOut: amountUsdc - Number(maxFee) / 1e6 };
  }

  // Standard finality (2000): poll attestation + manual receiveMessage on dst chain.
  const attestationUrl = `https://iris-api.circle.com/v2/messages/${srcDomain}?transactionHash=${txHash}`;
  let messageBytes = "";
  let attestationBytes = "";

  // Poll for attestation (up to ~20 min, every 15s)
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 15000));
    try {
      const res = await fetch(attestationUrl);
      if (res.ok) {
        const body = await res.json() as { messages?: Array<{ status: string; attestation: string; message: string }> };
        const msg = body.messages?.[0];
        if (msg?.status === "complete" && msg.attestation && msg.attestation !== "PENDING") {
          messageBytes = msg.message;
          attestationBytes = msg.attestation;
          break;
        }
      }
    } catch { /* retry */ }
  }

  if (!messageBytes) {
    // Attestation not ready within timeout — return TX hash, user can relay later
    return { provider: "cctp", txHash, srcChain, dstChain, amountIn: amountUsdc, amountOut: amountUsdc - Number(maxFee) / 1e6 };
  }

  // Call receiveMessage on destination chain
  let receiveTxHash: string | undefined;
  try {
    const dstRpc = RPC_URLS[dstChain];
    const dstProvider = new ethers.JsonRpcProvider(dstRpc);
    const dstWallet = new ethers.Wallet(signerKey, dstProvider);
    const messageTransmitter = new ethers.Contract(
      CCTP_MESSAGE_TRANSMITTER[dstChain],
      ["function receiveMessage(bytes message, bytes attestation) returns (bool success)"],
      dstWallet,
    );
    const relayTx = await messageTransmitter.receiveMessage(messageBytes, attestationBytes);
    const relayReceipt = await relayTx.wait();
    receiveTxHash = relayReceipt.hash;
  } catch {
    // May fail if already relayed — that's fine
  }

  return { provider: "cctp", txHash, srcChain, dstChain, amountIn: amountUsdc, amountOut: amountUsdc - Number(maxFee) / 1e6, receiveTxHash };
}

// ── CCTP: Solana → EVM ──

async function executeCctpSolanaToEvm(
  dstChain: string,
  amountUsdc: number,
  signerKey: string,
  recipientAddress: string,
  _dstSignerKey?: string, // EVM key for manual receiveMessage (standard finality only)
  fast: boolean = false,
): Promise<BridgeResult> {
  const { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, SystemProgram } = await import("@solana/web3.js");
  const bs58 = await import("bs58");
  const { createHash } = await import("crypto");

  const connection = new Connection(RPC_URLS.solana, "confirmed");
  const dstDomain = CCTP_DOMAINS[dstChain];
  if (dstDomain === undefined) throw new Error(`Unknown CCTP domain for ${dstChain}`);

  // Decode Solana keypair
  let keypair: InstanceType<typeof Keypair>;
  try {
    keypair = Keypair.fromSecretKey(bs58.default.decode(signerKey));
  } catch {
    try { keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(signerKey))); }
    catch { throw new Error("Invalid Solana private key format"); }
  }

  // Check USDC balance
  const balance = await getSolanaUsdcBalance(keypair.publicKey.toBase58());
  if (balance < amountUsdc) {
    throw new Error(`Insufficient USDC on Solana: have ${balance.toFixed(2)}, need ${amountUsdc}`);
  }

  const tokenMessengerMinter = new PublicKey(CCTP_SOLANA_TOKEN_MESSENGER_MINTER);
  const messageTransmitterProgram = new PublicKey(CCTP_SOLANA_MESSAGE_TRANSMITTER);
  const usdcMint = new PublicKey(USDC_MINT_SOLANA);
  const tokenProgram = new PublicKey(SPL_TOKEN_PROGRAM);

  // Derive PDAs — Circle uses domain as UTF-8 string seed (e.g., "0", "3"), NOT binary
  const [senderAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("sender_authority")], tokenMessengerMinter,
  );
  const [tokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_messenger")], tokenMessengerMinter,
  );
  const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("remote_token_messenger"), Buffer.from(String(dstDomain))], tokenMessengerMinter,
  );
  const [tokenMinter] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_minter")], tokenMessengerMinter,
  );
  const [localToken] = PublicKey.findProgramAddressSync(
    [Buffer.from("local_token"), usdcMint.toBuffer()], tokenMessengerMinter,
  );

  // MessageTransmitter state PDA (owned by MT program)
  const [messageTransmitterAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("message_transmitter")], messageTransmitterProgram,
  );

  // Denylist account PDA: ["denylist_account", owner] from TMM — may not exist (not denylisted)
  const [denylistAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("denylist_account"), keypair.publicKey.toBuffer()], tokenMessengerMinter,
  );

  // Owner's USDC ATA (computed without @solana/spl-token)
  const [burnTokenAccount] = PublicKey.findProgramAddressSync(
    [keypair.publicKey.toBuffer(), tokenProgram.toBuffer(), usdcMint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  );

  // Event data account — client-generated keypair, assigned to MessageTransmitter
  const eventDataKeypair = Keypair.generate();

  // Event authority PDAs — TMM and MT each have their own (for Anchor CPI events)
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")], tokenMessengerMinter,
  );
  const [mtEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")], messageTransmitterProgram,
  );

  // Build instruction data: Anchor discriminator + V2 params
  const discriminator = createHash("sha256").update("global:deposit_for_burn").digest().subarray(0, 8);

  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(BigInt(Math.round(amountUsdc * 1e6)));

  // Domain as u32 LE for instruction data (different from PDA seed which uses string)
  const domainBuf = Buffer.alloc(4);
  domainBuf.writeUInt32LE(dstDomain);

  // mintRecipient: EVM address left-padded to 32 bytes
  const recipientBytes = Buffer.alloc(32);
  const addrBytes = Buffer.from(recipientAddress.replace("0x", ""), "hex");
  addrBytes.copy(recipientBytes, 32 - addrBytes.length); // left-pad

  // destinationCaller: all zeros (permissionless relay)
  const destinationCaller = Buffer.alloc(32);

  const finality = fast ? 1000 : 2000;
  const { maxFee: relayFee } = await getCctpRelayFee(CCTP_DOMAINS.solana, dstDomain, finality);
  const maxFeeBuf = Buffer.alloc(8);
  maxFeeBuf.writeBigUInt64LE(relayFee);

  const minFinalityBuf = Buffer.alloc(4);
  minFinalityBuf.writeUInt32LE(finality);

  const data = Buffer.concat([
    discriminator, amountBuf, domainBuf, recipientBytes,
    destinationCaller, maxFeeBuf, minFinalityBuf,
  ]);

  const instruction = {
    programId: tokenMessengerMinter,
    keys: [
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },           // 0: owner
      { pubkey: keypair.publicKey, isSigner: true, isWritable: true },           // 1: eventRentPayer
      { pubkey: senderAuthority, isSigner: false, isWritable: false },           // 2: senderAuthorityPda
      { pubkey: burnTokenAccount, isSigner: false, isWritable: true },           // 3: burnTokenAccount
      { pubkey: denylistAccount, isSigner: false, isWritable: false },           // 4: denylistAccount
      { pubkey: messageTransmitterAccount, isSigner: false, isWritable: true },  // 5: messageTransmitter (MT state)
      { pubkey: tokenMessenger, isSigner: false, isWritable: false },            // 6: tokenMessenger
      { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },      // 7: remoteTokenMessenger
      { pubkey: tokenMinter, isSigner: false, isWritable: false },               // 8: tokenMinter
      { pubkey: localToken, isSigner: false, isWritable: true },                 // 9: localToken
      { pubkey: usdcMint, isSigner: false, isWritable: true },                   // 10: burnTokenMint
      { pubkey: eventDataKeypair.publicKey, isSigner: true, isWritable: true },  // 11: messageSentEventData
      { pubkey: messageTransmitterProgram, isSigner: false, isWritable: false }, // 12: messageTransmitterProgram
      { pubkey: tokenMessengerMinter, isSigner: false, isWritable: false },      // 13: tokenMessengerMinterProgram
      { pubkey: tokenProgram, isSigner: false, isWritable: false },              // 14: tokenProgram
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },   // 15: systemProgram
      { pubkey: eventAuthority, isSigner: false, isWritable: false },            // 16: TMM eventAuthority
      { pubkey: tokenMessengerMinter, isSigner: false, isWritable: false },      // 17: TMM program (self)
      { pubkey: mtEventAuthority, isSigner: false, isWritable: false },          // 18: MT eventAuthority
      { pubkey: messageTransmitterProgram, isSigner: false, isWritable: false }, // 19: MT program
    ],
    data,
  };

  // Build and send transaction
  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [instruction],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([keypair, eventDataKeypair]);

  const signature = await connection.sendTransaction(transaction, { skipPreflight: false });
  await connection.confirmTransaction(signature, "confirmed");

  const feeUsdc = Number(relayFee) / 1e6;

  // Fast finality (1000): Circle auto-relays — done.
  if (fast) {
    return { provider: "cctp (fast)", txHash: signature, srcChain: "solana", dstChain, amountIn: amountUsdc, amountOut: amountUsdc - feeUsdc };
  }

  // Standard finality (2000): poll attestation + manual receiveMessage on dst EVM chain
  if (dstChain !== "solana" && _dstSignerKey) {
    const solanaDomain = CCTP_DOMAINS.solana;
    const attestationUrl = `https://iris-api.circle.com/v2/messages/${solanaDomain}?transactionHash=${signature}`;
    let messageBytes = "";
    let attestationBytes = "";

    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 15000));
      try {
        const res = await fetch(attestationUrl);
        if (res.ok) {
          const body = await res.json() as { messages?: Array<{ status: string; attestation: string; message: string }> };
          const msg = body.messages?.[0];
          if (msg?.status === "complete" && msg.attestation && msg.attestation !== "PENDING") {
            messageBytes = msg.message;
            attestationBytes = msg.attestation;
            break;
          }
        }
      } catch { /* retry */ }
    }

    if (messageBytes && attestationBytes) {
      try {
        const { ethers } = await import("ethers");
        const dstRpc = RPC_URLS[dstChain];
        const dstProvider = new ethers.JsonRpcProvider(dstRpc);
        const dstWallet = new ethers.Wallet(_dstSignerKey, dstProvider);
        const mt = new ethers.Contract(
          CCTP_MESSAGE_TRANSMITTER[dstChain],
          ["function receiveMessage(bytes message, bytes attestation) returns (bool success)"],
          dstWallet,
        );
        const relayTx = await mt.receiveMessage(messageBytes, attestationBytes);
        const relayReceipt = await relayTx.wait();
        return { provider: "cctp", txHash: signature, receiveTxHash: relayReceipt.hash, srcChain: "solana", dstChain, amountIn: amountUsdc, amountOut: amountUsdc - feeUsdc };
      } catch { /* may fail if already relayed */ }
    }
  }

  return { provider: "cctp", txHash: signature, srcChain: "solana", dstChain, amountIn: amountUsdc, amountOut: amountUsdc - feeUsdc };
}

// ── CCTP: EVM → Solana ──

async function executeCctpEvmToSolana(
  srcChain: string,
  amountUsdc: number,
  signerKey: string,
  recipientAddress: string, // Solana base58 pubkey
  solanaPayerKey?: string, // Solana private key for receiveMessage relay
  fast: boolean = false,
): Promise<BridgeResult> {
  const { ethers } = await import("ethers");

  const srcRpc = RPC_URLS[srcChain] ?? RPC_URLS.arbitrum;
  const srcProvider = new ethers.JsonRpcProvider(srcRpc);
  const srcWallet = new ethers.Wallet(signerKey, srcProvider);

  const usdcAddr = USDC_ADDRESSES[srcChain];
  const tokenMessengerAddr = CCTP_TOKEN_MESSENGER[srcChain];
  const solanaDomain = CCTP_DOMAINS.solana; // 5

  if (!usdcAddr || !tokenMessengerAddr) throw new Error(`CCTP not configured for ${srcChain}`);

  // Step 0: Check USDC balance
  const balance = await getEvmUsdcBalance(srcChain, srcWallet.address);
  if (balance < amountUsdc) {
    throw new Error(`Insufficient USDC on ${srcChain}: have ${balance.toFixed(2)}, need ${amountUsdc}`);
  }

  const amountRaw = BigInt(Math.round(amountUsdc * 1e6));

  // Step 1: Approve USDC
  const usdc = new ethers.Contract(usdcAddr, [
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], srcWallet);

  const allowance = await usdc.allowance(srcWallet.address, tokenMessengerAddr);
  if (allowance < amountRaw) {
    const approveTx = await usdc.approve(tokenMessengerAddr, ethers.MaxUint256);
    await approveTx.wait();
  }

  // Step 2: Get relay fee
  const finality = fast ? 1000 : 2000;
  const srcDomain = CCTP_DOMAINS[srcChain];
  const { maxFee: relayFee, feeUsdc } = await getCctpRelayFee(srcDomain!, solanaDomain, finality);

  // Step 3: depositForBurn — mintRecipient is the Solana ATA for the recipient
  const { PublicKey } = await import("@solana/web3.js");
  const recipientPubkey = new PublicKey(recipientAddress);
  const usdcMint = new PublicKey(USDC_MINT_SOLANA);
  const tokenProgramKey = new PublicKey(SPL_TOKEN_PROGRAM);

  // Compute the recipient's USDC ATA
  const [recipientAta] = PublicKey.findProgramAddressSync(
    [recipientPubkey.toBuffer(), tokenProgramKey.toBuffer(), usdcMint.toBuffer()],
    new PublicKey(ASSOCIATED_TOKEN_PROGRAM),
  );

  // Pad the Solana ATA (32 bytes) to bytes32 for EVM
  const mintRecipient = "0x" + Buffer.from(recipientAta.toBytes()).toString("hex");

  const destinationCaller = ethers.ZeroHash; // permissionless relay
  const tokenMessenger = new ethers.Contract(tokenMessengerAddr, [
    "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64 nonce)",
  ], srcWallet);

  const depositTx = await tokenMessenger.depositForBurn(
    amountRaw, solanaDomain, mintRecipient, usdcAddr,
    destinationCaller, relayFee, finality,
  );
  const receipt = await depositTx.wait();
  const txHash = receipt.hash;

  // Fast finality (1000): Circle auto-relays — done.
  if (fast) {
    return { provider: "cctp (fast)", txHash, srcChain, dstChain: "solana", amountIn: amountUsdc, amountOut: amountUsdc - feeUsdc };
  }

  // Standard finality (2000): poll attestation + manual Solana receiveMessage
  if (solanaPayerKey) {
    const attestationUrl = `https://iris-api.circle.com/v2/messages/${srcDomain}?transactionHash=${txHash}`;
    let messageBytes = "";
    let attestationBytes = "";

    for (let i = 0; i < 80; i++) {
      await new Promise(r => setTimeout(r, 15000));
      try {
        const res = await fetch(attestationUrl);
        if (res.ok) {
          const body = await res.json() as { messages?: Array<{ status: string; attestation: string; message: string }> };
          const msg = body.messages?.[0];
          if (msg?.status === "complete" && msg.attestation && msg.attestation !== "PENDING") {
            messageBytes = msg.message;
            attestationBytes = msg.attestation;
            break;
          }
        }
      } catch { /* retry */ }
    }

    if (messageBytes && attestationBytes) {
      try {
        const receiveSig = await executeSolanaReceiveMessage(messageBytes, attestationBytes, recipientAddress, solanaPayerKey);
        return { provider: "cctp", txHash, receiveTxHash: receiveSig, srcChain, dstChain: "solana", amountIn: amountUsdc, amountOut: amountUsdc - feeUsdc };
      } catch { /* may fail if already relayed */ }
    }
  }

  return {
    provider: "cctp",
    txHash,
    srcChain,
    dstChain: "solana",
    amountIn: amountUsdc,
    amountOut: amountUsdc - feeUsdc,
  };
}

// ── CCTP: Solana receiveMessage (for EVM→Solana relay) ──

/**
 * Call receiveMessage on Solana MessageTransmitter V2 to complete an EVM→Solana bridge.
 * This mints USDC on Solana after the attestation is ready.
 */
export async function executeSolanaReceiveMessage(
  messageHex: string,    // "0x..." CCTP message from Iris API
  attestationHex: string, // "0x..." attestation from Iris API
  recipientAddress: string, // Solana wallet pubkey (base58)
  payerKey: string,        // Solana private key (base58 or JSON array)
): Promise<string> {
  const { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, SystemProgram, ComputeBudgetProgram } = await import("@solana/web3.js");
  const bs58 = await import("bs58");
  const { createHash } = await import("crypto");

  const connection = new Connection(RPC_URLS.solana, "confirmed");

  // Decode payer keypair
  let payer: InstanceType<typeof Keypair>;
  try { payer = Keypair.fromSecretKey(bs58.default.decode(payerKey)); }
  catch { try { payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(payerKey))); }
  catch { throw new Error("Invalid Solana private key format"); } }

  // Parse raw bytes
  const messageBytes = Buffer.from(messageHex.replace("0x", ""), "hex");
  const attestationBytes = Buffer.from(attestationHex.replace("0x", ""), "hex");

  // Extract fields from CCTP V2 message
  // Layout: version(4) + srcDomain(4) + dstDomain(4) + nonce(32) + sender(32) + recipient(32) + destCaller(32) + minFinality(4) + finalityExecuted(4) + messageBody(var)
  const sourceDomain = messageBytes.readUInt32BE(4);
  const nonce = messageBytes.subarray(12, 44); // 32-byte nonce for used_nonce PDA

  // Extract burn token from message body (starts at offset 148)
  // BurnMessage: version(4) + burnToken(32) + ...
  const burnToken = messageBytes.subarray(152, 184); // body[4..36]

  // Program IDs
  const tokenMessengerMinter = new PublicKey(CCTP_SOLANA_TOKEN_MESSENGER_MINTER);
  const messageTransmitterProgram = new PublicKey(CCTP_SOLANA_MESSAGE_TRANSMITTER);
  const usdcMint = new PublicKey(USDC_MINT_SOLANA);
  const tokenProgram = new PublicKey(SPL_TOKEN_PROGRAM);
  const ataProg = new PublicKey(ASSOCIATED_TOKEN_PROGRAM);

  // ── MessageTransmitter accounts ──
  const [authorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("message_transmitter_authority"), tokenMessengerMinter.toBuffer()],
    messageTransmitterProgram,
  );
  const [messageTransmitter] = PublicKey.findProgramAddressSync(
    [Buffer.from("message_transmitter")], messageTransmitterProgram,
  );
  const [usedNonce] = PublicKey.findProgramAddressSync(
    [Buffer.from("used_nonce"), nonce], messageTransmitterProgram,
  );

  // ── TokenMessengerMinter handler accounts ──
  const [tokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_messenger")], tokenMessengerMinter,
  );
  const [remoteTokenMessenger] = PublicKey.findProgramAddressSync(
    [Buffer.from("remote_token_messenger"), Buffer.from(String(sourceDomain))],
    tokenMessengerMinter,
  );
  const [tokenMinter] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_minter")], tokenMessengerMinter,
  );
  const [localToken] = PublicKey.findProgramAddressSync(
    [Buffer.from("local_token"), usdcMint.toBuffer()], tokenMessengerMinter,
  );
  const [tokenPair] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_pair"), Buffer.from(String(sourceDomain)), burnToken],
    tokenMessengerMinter,
  );

  // Fee recipient ATA (read from on-chain token_messenger account)
  // V2 TokenMessenger layout: disc(8)+denylister(32)+owner(32)+pending_owner(32)+message_body_version(4)+authority_bump(1)+fee_recipient(32)
  // fee_recipient at byte offset 109
  const feeRecipient = new PublicKey("9s6qCkbhtYMpWuhPHiokWUUNjrDpKK4djzpKGhyizWGk");
  const feeRecipientAta = new PublicKey("BDPTEfR44oztkZgiFxpbjERm6XwFZYaT6GB37ofp53tj");

  // Recipient's USDC ATA
  const recipientPk = new PublicKey(recipientAddress);
  const [recipientAta] = PublicKey.findProgramAddressSync(
    [recipientPk.toBuffer(), tokenProgram.toBuffer(), usdcMint.toBuffer()], ataProg,
  );

  // Custody token account
  const [custodyTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("custody"), usdcMint.toBuffer()], tokenMessengerMinter,
  );

  // Event authority PDAs
  const [mtEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")], messageTransmitterProgram,
  );
  const [tmmEventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")], tokenMessengerMinter,
  );

  // ── Build instruction data ──
  // Anchor discriminator for "receive_message"
  const discriminator = createHash("sha256").update("global:receive_message").digest().subarray(0, 8);

  // Borsh-serialize params: message (Vec<u8>) + attestation (Vec<u8>)
  const msgLenBuf = Buffer.alloc(4);
  msgLenBuf.writeUInt32LE(messageBytes.length);
  const attLenBuf = Buffer.alloc(4);
  attLenBuf.writeUInt32LE(attestationBytes.length);

  const data = Buffer.concat([
    discriminator,
    msgLenBuf, messageBytes,
    attLenBuf, attestationBytes,
  ]);

  // ── Build accounts list ──
  const instruction = {
    programId: messageTransmitterProgram,
    keys: [
      // ReceiveMessageContext (7 accounts)
      { pubkey: payer.publicKey, isSigner: true, isWritable: true },           // 0: payer
      { pubkey: payer.publicKey, isSigner: true, isWritable: false },          // 1: caller
      { pubkey: authorityPda, isSigner: false, isWritable: false },            // 2: authority_pda
      { pubkey: messageTransmitter, isSigner: false, isWritable: false },      // 3: message_transmitter
      { pubkey: usedNonce, isSigner: false, isWritable: true },                // 4: used_nonce (init)
      { pubkey: tokenMessengerMinter, isSigner: false, isWritable: false },    // 5: receiver (TMM program)
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 6: system_program
      // MT event_cpi (2 accounts)
      { pubkey: mtEventAuthority, isSigner: false, isWritable: false },        // 7: MT event_authority
      { pubkey: messageTransmitterProgram, isSigner: false, isWritable: false }, // 8: MT program
      // Remaining accounts for CPI to TMM HandleReceiveMessageContext (11 accounts)
      // NOTE: authority_pda is NOT passed here — the MT program inserts it as
      // a PDA signer automatically during CPI. These are positions [1..11] of
      // the TMM IDL's handle_receive_unfinalized_message instruction.
      { pubkey: tokenMessenger, isSigner: false, isWritable: false },          //  9: token_messenger
      { pubkey: remoteTokenMessenger, isSigner: false, isWritable: false },    // 10: remote_token_messenger
      { pubkey: tokenMinter, isSigner: false, isWritable: false },             // 11: token_minter
      { pubkey: localToken, isSigner: false, isWritable: true },               // 12: local_token
      { pubkey: tokenPair, isSigner: false, isWritable: false },               // 13: token_pair
      { pubkey: feeRecipientAta, isSigner: false, isWritable: true },          // 14: fee_recipient_token_account
      { pubkey: recipientAta, isSigner: false, isWritable: true },             // 15: recipient_token_account
      { pubkey: custodyTokenAccount, isSigner: false, isWritable: true },      // 16: custody_token_account
      { pubkey: tokenProgram, isSigner: false, isWritable: false },            // 17: token_program
      // TMM event_cpi (2 accounts)
      { pubkey: tmmEventAuthority, isSigner: false, isWritable: false },       // 18: TMM event_authority
      { pubkey: tokenMessengerMinter, isSigner: false, isWritable: false },    // 19: TMM program
    ],
    data,
  };

  // Build and send transaction with ALT to stay under 1232-byte limit
  const CCTP_ALT = new PublicKey("7xfB7Yd2UXf6hXQnYEgt26SBPEyZC3rDgb1X7Wip2NEX");
  const altAccount = await connection.getAddressLookupTable(CCTP_ALT);
  const lookupTables = altAccount.value ? [altAccount.value] : [];

  const computeBudgetIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const { blockhash } = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [computeBudgetIx, instruction],
  }).compileToV0Message(lookupTables);

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([payer]);

  const signature = await connection.sendTransaction(transaction, { skipPreflight: false });
  await connection.confirmTransaction(signature, "confirmed");

  return signature;
}

// ── Shared CCTP helpers ──

/**
 * Poll Circle V2 Iris API by transaction hash (for Solana→EVM).
 * Returns the CCTP message bytes and attestation signature.
 */
async function pollCctpV2Attestation(
  sourceDomain: number,
  txHash: string,
  maxAttempts: number,
): Promise<{ message: string | null; attestation: string | null }> {
  const url = `https://iris-api.circle.com/v2/messages/${sourceDomain}?transactionHash=${txHash}`;
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(15_000);
    try {
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as {
          messages?: Array<{ message?: string; attestation?: string; status?: string }>;
        };
        const msg = data.messages?.[0];
        if (msg?.status === "complete" && msg.message && msg.attestation) {
          return { message: msg.message, attestation: msg.attestation };
        }
      }
    } catch {
      // retry
    }
  }
  return { message: null, attestation: null };
}

// ── Relay Bridge API ──

const RELAY_API = "https://api.relay.link";

// Relay chain IDs (same as standard EVM chain IDs, Solana = 792703809)
const RELAY_CHAIN_IDS: Record<string, number> = {
  solana: 792703809,
  arbitrum: 42161,
  base: 8453,
};

export async function getRelayQuote(
  srcChain: string,
  dstChain: string,
  amountUsdc: number,
  senderAddress: string,
  recipientAddress: string,
): Promise<BridgeQuote> {
  const srcChainId = RELAY_CHAIN_IDS[srcChain];
  const dstChainId = RELAY_CHAIN_IDS[dstChain];
  if (!srcChainId || !dstChainId) throw new Error(`Relay: unsupported chain ${srcChain} or ${dstChain}`);

  const srcToken = USDC_ADDRESSES[srcChain];
  const dstToken = USDC_ADDRESSES[dstChain];
  if (!srcToken || !dstToken) throw new Error(`No USDC for ${srcChain} or ${dstChain}`);

  const amountRaw = String(Math.round(amountUsdc * 1e6));

  const body = {
    user: senderAddress,
    recipient: recipientAddress,
    originChainId: srcChainId,
    destinationChainId: dstChainId,
    originCurrency: srcToken,
    destinationCurrency: dstToken,
    amount: amountRaw,
    tradeType: "EXACT_INPUT",
  };

  const res = await fetch(`${RELAY_API}/quote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Relay quote failed: ${res.status} ${errText}`);
  }

  const data = await res.json() as Record<string, unknown>;
  const details = data.details as Record<string, unknown> | undefined;
  const fees = data.fees as Record<string, unknown> | undefined;

  const currencyOut = details?.currencyOut as Record<string, unknown> | undefined;
  const amountOut = Number(currencyOut?.amountFormatted ?? 0);

  const relayerFee = fees?.relayer as Record<string, unknown> | undefined;
  const feeUsd = Number(relayerFee?.amountUsd ?? 0);

  const timeEstimate = Number(details?.timeEstimate ?? 30);

  return {
    provider: "relay",
    srcChain,
    dstChain,
    amountIn: amountUsdc,
    amountOut: amountOut || (amountUsdc - feeUsd),
    fee: feeUsd || (amountUsdc - amountOut),
    estimatedTime: timeEstimate,
    gasIncluded: true,
    gasNote: "Relay solver handles destination execution",
    raw: data,
  };
}

export async function executeRelayBridge(
  bridgeQuote: BridgeQuote,
  signerKey: string,
): Promise<BridgeResult> {
  const { srcChain, dstChain, amountIn, amountOut } = bridgeQuote;
  const data = bridgeQuote.raw as Record<string, unknown>;

  const steps = data.steps as Array<Record<string, unknown>> | undefined;
  if (!steps || steps.length === 0) throw new Error("Relay: no steps in quote");

  let txHash = "";

  for (const step of steps) {
    const kind = step.kind as string;
    const items = step.items as Array<Record<string, unknown>> | undefined;
    if (!items) continue;

    for (const item of items) {
      const itemData = item.data as Record<string, unknown> | undefined;
      if (!itemData) continue;

      if (kind === "transaction") {
        if (srcChain === "solana") {
          // Solana transaction
          const txData = String(itemData.data ?? "");
          if (txData) {
            txHash = await submitSolanaTransaction({ data: txData } as Record<string, unknown>, signerKey);
          }
        } else {
          // EVM transaction
          txHash = await submitEvmTransaction(
            { to: itemData.to, data: itemData.data, value: itemData.value ?? "0" },
            signerKey,
            srcChain,
          );
        }
      }
    }
  }

  if (!txHash) throw new Error("Relay: no transaction executed");

  return {
    provider: "relay",
    txHash,
    srcChain,
    dstChain,
    amountIn,
    amountOut,
  };
}

/**
 * Get the best bridge quote. Strategy:
 * - CCTP primary ($0 fee) for all routes: Solana↔EVM, EVM↔EVM, →HyperCore
 * - Relay + deBridge DLN in parallel, pick cheapest
 */
/**
 * Get quotes from ALL available providers in parallel.
 * Returns sorted by amountOut (best first).
 */
export async function getAllQuotes(
  srcChain: string,
  dstChain: string,
  amountUsdc: number,
  senderAddress: string,
  recipientAddress: string,
): Promise<BridgeQuote[]> {
  const results = await Promise.allSettled([
    getCctpQuote(srcChain, dstChain, amountUsdc),
    getRelayQuote(srcChain, dstChain, amountUsdc, senderAddress, recipientAddress),
    getDebridgeQuote(srcChain, dstChain, amountUsdc, senderAddress, recipientAddress),
  ]);

  const quotes: BridgeQuote[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") quotes.push(r.value);
  }

  // Sort by best deal (highest amountOut)
  quotes.sort((a, b) => b.amountOut - a.amountOut);
  return quotes;
}

/**
 * Get the best quote across all providers.
 */
export async function getBestQuote(
  srcChain: string,
  dstChain: string,
  amountUsdc: number,
  senderAddress: string,
  recipientAddress: string,
): Promise<BridgeQuote> {
  const quotes = await getAllQuotes(srcChain, dstChain, amountUsdc, senderAddress, recipientAddress);
  if (quotes.length === 0) {
    throw new Error(`No bridge available for ${srcChain} → ${dstChain}`);
  }
  return quotes[0];
}

/**
 * Execute a bridge using the specified or best available provider.
 * @param provider - Optional: force a specific provider ("cctp" | "relay" | "debridge")
 */
export async function executeBestBridge(
  srcChain: string,
  dstChain: string,
  amountUsdc: number,
  signerKey: string,
  senderAddress: string,
  recipientAddress: string,
  dstSignerKey?: string, // Optional EVM key for manual receiveMessage (standard finality)
  provider?: "cctp" | "relay" | "debridge",
  fast: boolean = false,
): Promise<BridgeResult> {
  let quote: BridgeQuote;

  if (provider) {
    // User specified a provider — get that specific quote
    const quotes = await getAllQuotes(srcChain, dstChain, amountUsdc, senderAddress, recipientAddress);
    const match = quotes.find(q => q.provider === provider);
    if (!match) throw new Error(`Provider "${provider}" not available for ${srcChain} → ${dstChain}`);
    quote = match;
  } else {
    quote = await getBestQuote(srcChain, dstChain, amountUsdc, senderAddress, recipientAddress);
  }

  if (quote.provider === "cctp") {
    return executeCctpBridge(srcChain, dstChain, amountUsdc, signerKey, recipientAddress, dstSignerKey, fast);
  }

  if (quote.provider === "relay") {
    return executeRelayBridge(quote, signerKey);
  }

  return executeDebridgeBridge(quote, signerKey);
}

/**
 * Check bridge order status via deBridge.
 */
export async function checkDebridgeStatus(orderId: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${DLN_API}/${orderId}/status`);
  if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

// ── Helpers ──

/**
 * Append deBridge builder/affiliate params if configured via env vars:
 *   DEBRIDGE_REFERRAL_CODE, DEBRIDGE_AFFILIATE_FEE_PERCENT, DEBRIDGE_AFFILIATE_FEE_RECIPIENT
 */
function appendDebridgeBuilderParams(params: URLSearchParams): void {
  if (DEBRIDGE_REFERRAL_CODE) params.set("referralCode", DEBRIDGE_REFERRAL_CODE);
  if (DEBRIDGE_AFFILIATE_FEE_PERCENT && DEBRIDGE_AFFILIATE_FEE_RECIPIENT) {
    params.set("affiliateFeePercent", DEBRIDGE_AFFILIATE_FEE_PERCENT);
    params.set("affiliateFeeRecipient", DEBRIDGE_AFFILIATE_FEE_RECIPIENT);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
