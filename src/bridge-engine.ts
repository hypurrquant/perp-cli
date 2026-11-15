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

import { PerpError, isConnectFailure, isTransportFailure, orderOutcomeUnknown, parsePositiveDecimal, sendFailure } from "./errors.js";
import { loadSettings } from "./settings.js";
import { getVenue, networkConfig } from "./exchanges/venue.js";
import "./exchanges/venues/index.js";
import { HL_USER_SIGNED } from "./exchanges/venues/hyperliquid.js";
import type { Network } from "./exchanges/venue-types.js";
import type { JsonRpcProvider } from "ethers";
import type { Connection, VersionedTransaction } from "@solana/web3.js";
import type { SolanaSigner } from "./signer/interface.js";
import { ERC20, assertRpcChainId, erc20Allowance, evmProvider, sendMasterTx } from "./evm-master-tx.js";
import {
  isBridgeEvmSigner, isSolanaSigner, pkEvmSigner, pkSolanaSigner, signTypedDataChecked, signVersionedSolanaTx,
  type BridgeEvmSigner,
} from "./bridge-signers.js";
import { fetchWithTimeout } from "./http.js";
import { HyperliquidAdapter } from "./exchanges/hyperliquid.js";

/**
 * What signs a bridge leg: a master-wallet signer (OWS vault signer or raw-key signer from
 * bridge-signers.ts), or — for legacy callers — a raw private key string (EVM 0x hex, Solana
 * base58 / JSON). An "ows:<name>" reference is not a key and is refused.
 */
export type BridgeSignerInput = string | BridgeEvmSigner | SolanaSigner;

/**
 * A USDC amount: preferably the user's decimal string (exact), or a number (legacy callers).
 * Signed amounts are always derived from the exact decimal via usdcUnits() — never from float
 * math. A number is read as its shortest round-trip decimal (String(n)); one with an exponent or
 * more than 6 decimals is refused.
 */
export type UsdcAmount = string | number;

/**
 * Canonical USDC decimal string ("5", "5.25") of `amount`. INVALID_PARAMS for anything that is
 * not a positive plain decimal with at most 6 decimals (USDC has 6).
 */
export function parseUsdcAmount(amount: UsdcAmount, what: string = "USDC amount"): string {
  const raw = typeof amount === "number" ? (Number.isFinite(amount) ? String(amount) : "NaN") : amount;
  const s = parsePositiveDecimal(raw, what);
  const frac = s.includes(".") ? s.slice(s.indexOf(".") + 1) : "";
  if (frac.length > 6) {
    throw new PerpError("INVALID_PARAMS", `${what} ${s} has more than 6 decimals (USDC has 6) — nothing was sent`, {
      remediation: "Pass the amount with at most 6 decimals, e.g. 10.123456",
    });
  }
  return formatUnitsPlain(usdcUnitsOf(s), 6);
}

/** Exact USDC base units (6 decimals) of a validated decimal string. */
function usdcUnitsOf(s: string): bigint {
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole === "" ? "0" : whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
}

/** Exact USDC base units of `amount` (validated by parseUsdcAmount). */
export function usdcUnits(amount: UsdcAmount, what?: string): bigint {
  return usdcUnitsOf(parseUsdcAmount(amount, what));
}

/** Display-only number of `amount` (never used to build a signed amount). */
function usdcDisplay(amount: UsdcAmount): number {
  return Number(parseUsdcAmount(amount));
}

function evmSignerOf(k: BridgeSignerInput): BridgeEvmSigner {
  if (typeof k === "string") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
      throw new PerpError("NO_SIGNER_AVAILABLE", "This bridge leg is signed on an EVM chain, and no EVM master signer was supplied", {
        remediation: "Select the master wallet (perp wallet use <name> or --ows <name>) and run perp funds bridge send / exchange",
      });
    }
    return pkEvmSigner(k);
  }
  if (isBridgeEvmSigner(k)) return k;
  throw new PerpError("NO_SIGNER_AVAILABLE", "This bridge leg is signed on an EVM chain, but a Solana signer was supplied", {
    remediation: "Pass the master wallet's EVM signer for EVM source chains",
  });
}

async function solanaSignerOf(k: BridgeSignerInput): Promise<SolanaSigner> {
  if (typeof k === "string") {
    if (k.startsWith("ows:")) {
      throw new PerpError("NO_SIGNER_AVAILABLE", "This bridge leg is signed on Solana, and an OWS wallet reference (not a signer) was supplied", {
        remediation: "Select the master wallet (perp wallet use <name> or --ows <name>) and run perp funds bridge send / exchange",
      });
    }
    return pkSolanaSigner(k);
  }
  if (isSolanaSigner(k)) return k;
  throw new PerpError("NO_SIGNER_AVAILABLE", "This bridge leg is signed on Solana, but an EVM signer was supplied", {
    remediation: "Pass the master wallet's Solana signer for Solana source chains",
  });
}

/** The signer's address must be the address the quote / order was built for. */
function assertSignerIs(chain: string, signerAddress: string, expected: string): void {
  const same = chain === "solana" ? signerAddress === expected : signerAddress.toLowerCase() === expected.toLowerCase();
  if (same) return;
  throw new PerpError("INVALID_PARAMS", `The bridge order was built for sender ${expected}, not the signing wallet's ${chain} address ${signerAddress} — nothing was sent`, {
    remediation: "Omit --sender (the master wallet's own address is used)",
  });
}

/** Chain-checked RPC for an EVM source chain (a wrong endpoint never receives a signed tx). */
async function bridgeEvmRpc(chain: string): Promise<{ rpc: JsonRpcProvider; chainId: number }> {
  const chainId = chain === "solana" ? undefined : CHAIN_IDS[chain as keyof typeof CHAIN_IDS];
  if (chainId === undefined) {
    throw new PerpError("NO_BRIDGE_ROUTE", `No EVM chain id configured for "${chain}" — nothing was sent`, {
      remediation: "List supported chains with: perp funds bridge chains",
    });
  }
  const url = requireRpcUrl(chain);
  const rpc = evmProvider(url, chainId);
  await assertRpcChainId(rpc, url, chainId, "bridge");
  return { rpc, chainId };
}

/**
 * One master-wallet EVM transaction through sendMasterTx: simulate → gas check → sign → verify
 * sender → broadcast → receipt. An unreadable outcome after the broadcast is ORDER_PENDING.
 */
async function sendBridgeEvmTx(
  rpc: JsonRpcProvider, chainId: number, chain: string, signer: BridgeEvmSigner, provider: string, label: string,
  to: string, data: string, value: bigint = 0n,
): Promise<string> {
  const { txHash } = await sendMasterTx(rpc, {
    venue: provider, chainLabel: chain, chainId, from: signer.getAddress(), to, data, value, label,
  }, tx => signer.signTransaction(tx));
  return txHash;
}

/**
 * Approve the pinned `spender` for EXACTLY `amount` USDC when the current allowance is below it.
 * Never an unlimited approval: a compromised / mis-targeted spender can take at most this transfer.
 */
async function ensureUsdcAllowance(
  rpc: JsonRpcProvider, chainId: number, chain: string, signer: BridgeEvmSigner, provider: string, spender: string, amount: bigint,
): Promise<void> {
  const usdc = USDC_ADDRESSES[chain];
  if (!usdc) throw new PerpError("NO_BRIDGE_ROUTE", `No USDC address for ${chain} — nothing was sent`);
  const allowance = await erc20Allowance(rpc, usdc, signer.getAddress(), spender);
  if (allowance >= amount) return;
  await sendBridgeEvmTx(rpc, chainId, chain, signer, provider, "USDC approve", usdc, usdcApproveData(spender, amount));
}

/** Calldata of the exact USDC approval ensureUsdcAllowance sends (exported for tests). */
export function usdcApproveData(spender: string, amount: bigint): string {
  return ERC20.encodeFunctionData("approve", [spender, amount]);
}

function solanaOutcomeUnknown(signature: string, what: string, e: unknown): PerpError {
  const pending = orderOutcomeUnknown("bridge", `${what} transaction ${signature}`, e,
    `Do NOT resend — the transaction was broadcast and may still confirm. Check signature ${signature} on a Solana explorer, then the balances, before doing anything else`);
  return new PerpError("ORDER_PENDING", pending.message, { exchange: "bridge", signature, txHash: signature, remediation: pending.structured.remediation });
}

/**
 * Broadcast a fully signed Solana transaction and wait for confirmation. The signature is known
 * before the send: a transport failure after the request left, or any confirmation failure, is
 * ORDER_PENDING carrying it (never "failed", never resubmitted).
 */
async function sendBridgeSolanaTx(connection: Connection, tx: VersionedTransaction, what: string): Promise<string> {
  const bs58 = (await import("bs58")).default;
  const signature = bs58.encode(tx.signatures[0]);
  try {
    await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
  } catch (e) {
    if (isConnectFailure(e)) {
      throw new PerpError("EXCHANGE_UNREACHABLE", `${what}: could not connect to the Solana RPC — nothing was sent`, { exchange: "bridge" });
    }
    if (isTransportFailure(e)) throw solanaOutcomeUnknown(signature, what, e);
    throw new PerpError("ACTION_REJECTED", `${what}: the Solana RPC refused the transaction (${e instanceof Error ? e.message : String(e)}) — nothing was sent`, { exchange: "bridge" });
  }
  let confirmation: { value: { err: unknown } };
  try {
    confirmation = await connection.confirmTransaction(signature, "confirmed");
  } catch (e) {
    throw solanaOutcomeUnknown(signature, what, e);
  }
  if (confirmation.value.err !== null && confirmation.value.err !== undefined) {
    throw new PerpError("ACTION_REJECTED", `${what}: transaction ${signature} failed on-chain (${JSON.stringify(confirmation.value.err)}) — nothing was moved`, {
      exchange: "bridge", signature, txHash: signature,
    });
  }
  return signature;
}

/**
 * Every route in this module is mainnet-only: the RPCs, USDC / CCTP contract
 * addresses, Circle Iris, Relay and deBridge endpoints below are mainnet
 * deployments with no testnet equivalent wired in. A testnet run must never
 * sign or send through them (it would move real mainnet funds), so it throws
 * NO_BRIDGE_ROUTE before any key is used.
 */
export function assertBridgeNetwork(network: Network): void {
  if (network === "mainnet") return;
  throw new PerpError("NO_BRIDGE_ROUTE", `Cross-chain bridging has no ${network} route — every bridge provider here (CCTP, Relay, deBridge) is wired to mainnet chains only`, {
    remediation: "Run without -n testnet to bridge on mainnet, or fund testnet accounts from each venue's testnet faucet",
  });
}

/**
 * A bridge moves funds between two different chains. Same source and destination is a caller
 * error, refused before any quote API is called or any key is used.
 */
export function assertDistinctBridgeChains(srcChain: string, dstChain: string): void {
  if (srcChain !== dstChain) return;
  throw new PerpError("INVALID_PARAMS", `Bridge source and destination chain are the same (${srcChain}) — nothing to bridge`, {
    remediation: "Pick two different chains with --from / --to (list them with: perp funds bridge chains)",
  });
}

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
  hyperliquid: "hyperliquid", // HyperCore CCTP: direct deposit to perps via CctpForwarder (domain 19)
  lighter: "arbitrum",
};

// Chain → RPC URLs
const RPC_URLS: Record<string, string> = {
  solana: "https://api.mainnet-beta.solana.com",
  arbitrum: "https://arb1.arbitrum.io/rpc",
  base: "https://mainnet.base.org",
  hyperliquid: "https://rpc.hyperliquid.xyz/evm",
};

/**
 * Look up an RPC URL for a chain. SSOT rule #2: refuse to silently fall
 * through to the Arbitrum RPC for unknown chain names — that masked routing
 * bugs that sent transactions to the wrong network.
 */
function requireRpcUrl(chain: string): string {
  const url = RPC_URLS[chain];
  if (!url) {
    throw new Error(
      `No RPC URL configured for chain="${chain}". ` +
      `Known chains: ${Object.keys(RPC_URLS).join(", ")}. ` +
      `Refusing to silently fall through to the Arbitrum RPC.`,
    );
  }
  return url;
}

// ── CCTP V2 Forwarding Service ──
// Circle Forwarding Service: Circle handles dst chain mint for you.
// Use depositForBurnWithHook + forward hook data → no manual receiveMessage needed.
// Service fee: $0.20 (non-Ethereum), $1.25 (Ethereum).
// Note: Forwarding NOT supported when dst=Solana (EVM→Solana must use manual relay).
const CCTP_FEE_API = "https://iris-api.circle.com/v2/burn/USDC/fees";

// Static forward hook data: magic bytes ("cctp-forward") + version(0) + empty data length(0)
const CCTP_FORWARD_HOOK_DATA = "0x636374702d666f72776172640000000000000000000000000000000000000000";

/**
 * Get CCTP V2 fee for a route.
 *
 * Fee structure (from Circle docs):
 * - minimumFee: in basis points (e.g. 1.3 = 0.013%). Protocol fee = amount × bps / 10000.
 * - Standard (finality=2000): minimumFee=0 → FREE protocol fee.
 * - Fast (finality=1000): minimumFee=0-14 bps → e.g. $0.13 per $1000 at 1.3 bps.
 * - forwardFee: in USDC subunits (6 decimals). Covers dst gas + Circle service (~$0.20).
 *
 * @param amountUsdc - Transfer amount in USDC (needed to calculate bps-based fee).
 * Returns maxFee in USDC subunits (6 decimals).
 */
async function getCctpRelayFee(
  srcDomain: number,
  dstDomain: number,
  finalityThreshold: number = 2000,
  useForwarding: boolean = false,
  amountUsdc: UsdcAmount = "100",
): Promise<{ maxFee: bigint; feeUsdc: number; forwardingAvailable: boolean }> {
  // SSOT rule #2: Circle's CCTP fee schedule is the SSOT for bridge cost.
  // Previously a fetch failure returned a hardcoded $0.50 / $0.25 fallback —
  // that silently set maxFee at a guess, which can either burn user dollars
  // (over-fee) or get the bridge stuck (under-fee). Errors must propagate so
  // the caller can decide whether to retry or abort.
  const qs = useForwarding ? "?forward=true" : "";
  const res = await fetchWithTimeout(`${CCTP_FEE_API}/${srcDomain}/${dstDomain}${qs}`);
  if (!res.ok) {
    throw new Error(`CCTP fee API ${srcDomain}→${dstDomain} returned HTTP ${res.status}`);
  }
  const body = await res.json();
  // Check for forwarding error response — caller can request without forwarding
  if (body && typeof body === "object" && "error" in body) {
    if (useForwarding) return getCctpRelayFee(srcDomain, dstDomain, finalityThreshold, false, amountUsdc);
    throw new Error(`CCTP fee API ${srcDomain}→${dstDomain} returned error: ${JSON.stringify(body)}`);
  }
  const schedules = body as Array<{
    finalityThreshold: number;
    minimumFee: number; // basis points (e.g. 1.3 = 0.013%)
    forwardFee?: { low: number; med: number; high: number }; // USDC subunits
  }>;
  // Prefer exact finalityThreshold match; otherwise pick the first scheduled
  // tier (Circle returns Standard + Fast in one envelope). The "first" choice
  // is documented behavior, not error fallback.
  const schedule = schedules.find(s => s.finalityThreshold === finalityThreshold) ?? schedules[0];
  if (!schedule) {
    throw new Error(`CCTP fee API ${srcDomain}→${dstDomain} returned no fee schedule`);
  }
  // Protocol fee: minimumFee is in basis points → actual fee = amount × bps / 10000
  const amountSubunits = usdcUnits(amountUsdc);
  const bpsRounded = BigInt(Math.round(schedule.minimumFee * 100));
  const protocolFee = (amountSubunits * bpsRounded) / 1_000_000n;
  // Add 20% buffer per Circle docs recommendation
  const protocolFeeBuffered = (protocolFee * 120n) / 100n;

  if (schedule.forwardFee) {
    // Forwarding: protocol fee + forwarding service fee
    const forwardFeeSubunits = BigInt(schedule.forwardFee.high);
    const totalMaxFee = protocolFeeBuffered + forwardFeeSubunits;
    const totalFeeUsdc = Number(totalMaxFee) / 1e6;
    return { maxFee: totalMaxFee, feeUsdc: totalFeeUsdc, forwardingAvailable: true };
  }

  // No forwarding — protocol fee only (or minimal for standard to incentivize relay)
  if (protocolFeeBuffered > 0n) {
    return { maxFee: protocolFeeBuffered, feeUsdc: Number(protocolFeeBuffered) / 1e6, forwardingAvailable: false };
  }
  // Standard (free): set small maxFee to incentivize relay (documented Circle pattern)
  return { maxFee: 10000n, feeUsdc: 0.01, forwardingAvailable: false }; // $0.01
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

  let info: Awaited<ReturnType<typeof connection.getTokenAccountBalance>>;
  try {
    info = await connection.getTokenAccountBalance(ata);
  } catch (e) {
    // Only a missing USDC token account is a real 0 balance. Any other RPC failure is unknown:
    // reporting it as 0 would read as "no USDC" (or, inverted, mask a balance check).
    if (isSolanaAccountNotFound(e)) return 0;
    throw new PerpError("EXCHANGE_UNREACHABLE", `Solana USDC balance of ${ownerPubkey} could not be read: ${e instanceof Error ? e.message : String(e)}`, {
      remediation: "Retry, or set a working Solana RPC (settings rpc.solana) — the balance is unknown, not 0",
    });
  }
  // Raw amount / decimals (uiAmount may be null) — a malformed answer is an error, not 0.
  const raw = Number(info.value.amount);
  if (!Number.isFinite(raw) || !Number.isInteger(info.value.decimals)) {
    throw new PerpError("EXCHANGE_ERROR", `Solana RPC returned a malformed USDC balance for ${ownerPubkey}: ${JSON.stringify(info.value)}`, {
      remediation: "Retry, or set a different Solana RPC (settings rpc.solana)",
    });
  }
  return raw / 10 ** info.value.decimals;
}

/** RPC "account not found" for getTokenAccountBalance (the ATA was never created ⇒ balance 0). */
export function isSolanaAccountNotFound(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /could not find account|account not found|AccountNotFound/i.test(msg);
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
  hyperliquid: { amount: 0.0001, symbol: "ETH" },
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

  // HyperCore → EVM uses HL exchange API (no on-chain gas needed on src)
  if (srcChain !== "hyperliquid") {
    const srcMin = MIN_GAS[srcChain];
    if (srcMin) {
      const srcGas = await getNativeGasBalance(srcChain, srcAddress);
      if (srcGas < srcMin.amount) {
        errors.push(
          `Source ${srcChain}: ${srcGas.toFixed(6)} ${srcMin.symbol} (need ≥${srcMin.amount} ${srcMin.symbol})`
        );
      }
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
  // SSOT rule #2 (same as getCctpRelayFee): the burn's maxFee comes from Circle's fee schedule.
  // A hardcoded default (formerly 1bp + $0.20) could under-fee (transfer stuck) or over-fee —
  // so an unreadable schedule is an error, never a silently-used guess.
  const url = `${HYPERCORE_FEES_API}/${srcDomain}/${HYPERCORE_CCTP_DOMAIN}?forward=true&hyperCoreDeposit=true`;
  const fail = (why: string) => new PerpError("EXCHANGE_UNREACHABLE", `CCTP HyperCore fee schedule ${srcDomain}→${HYPERCORE_CCTP_DOMAIN} unavailable: ${why} — nothing was sent`, {
    remediation: "Retry shortly (Circle iris-api); the bridge fee cannot be set without it",
  });
  let res: Response;
  try {
    res = await fetchWithTimeout(url);
  } catch (e) {
    throw fail(e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw fail(`HTTP ${res.status}`);
  // API returns array: [{finalityThreshold, minimumFee, forwardFee: {low, med, high}}, ...]
  const schedules = await res.json().catch((e: unknown) => { throw fail(`invalid JSON (${e instanceof Error ? e.message : String(e)})`); }) as Array<{
    finalityThreshold: number;
    minimumFee: number;
    feeRate?: number;
    forwardFee?: { low: number; med: number; high: number };
  }>;
  if (!Array.isArray(schedules)) throw fail(`unexpected response ${JSON.stringify(schedules).slice(0, 200)}`);
  // Use fast transfer schedule (threshold=1000) if available, else the first published tier
  const fast = schedules.find(s => s.finalityThreshold === 1000) ?? schedules[0];
  if (!fast) throw fail("no fee schedule");
  // Protocol fee rate in basis points: feeRate when published, else minimumFee (Circle's bps field).
  const bps = Number(fast.feeRate ?? fast.minimumFee);
  const forwardFee = Number(fast.forwardFee?.med ?? fast.forwardFee?.low); // subunits
  if (!Number.isFinite(bps) || bps < 0) throw fail("schedule without a protocol fee rate");
  if (!Number.isFinite(forwardFee) || forwardFee < 0) throw fail("schedule without a forwarding fee");
  const protocolFee = Math.ceil(amount * 1e6 * bps / 10000);
  return {
    protocolFee: protocolFee / 1e6,
    forwardingFee: forwardFee / 1e6,
    totalFee: (protocolFee + forwardFee) / 1e6,
    maxFee: protocolFee + forwardFee, // in subunits for instruction
  };
}

// ── deBridge DLN API ──

const DLN_API = "https://dln.debridge.finance/v1.0/dln/order";

// Affiliate / referral parameters: settings bridge.debridgeAffiliate only (ships absent → none sent).

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
  /**
   * A fee paid in the source chain's NATIVE token on top of the USDC amount (deBridge `fixFee`,
   * sent as the tx value). `usd` is null when no price was read. null = the provider charges none.
   */
  nativeFee?: { amount: string; symbol: string; usd: number | null } | null;
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

// deBridge DLN pinned contracts. Source: https://docs.debridge.com/dln-details/overview/deployed-contracts
// (read 2026-10-13): DlnSource is 0xeF4fB24aD0916217251F553c0596F8Edc630EB66 on Arbitrum and Base;
// Solana DlnSource program src5qyZHqTqecJV4aY6Cb6zDZLMDzrDKKezs22MPHr4. The create-tx transaction
// must target this contract; it is also the only spender ever approved (exact amount).
const DLN_SOURCE_EVM: Record<string, string> = {
  arbitrum: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66",
  base: "0xeF4fB24aD0916217251F553c0596F8Edc630EB66",
};

// DlnSource ABI (github.com/debridge-finance/dln-contracts, contracts/DLN/DlnSource.sol and
// contracts/libraries/DlnOrderLib.sol, read 2026-10-13). The contract pulls exactly
// OrderCreation.giveAmount of giveTokenAddress from msg.sender (_pullTokens, before the protocol
// and affiliate fees are deducted from it), requires msg.value == globalFixedNativeFee for an
// ERC-20 give token, and decodes _affiliateFee as 52 bytes: beneficiary (20) ‖ amount (32).
const DLN_ORDER_CREATION = "tuple(address giveTokenAddress, uint256 giveAmount, bytes takeTokenAddress, uint256 takeAmount, uint256 takeChainId, bytes receiverDst, address givePatchAuthoritySrc, bytes orderAuthorityAddressDst, bytes allowedTakerDst, bytes externalCall, bytes allowedCancelBeneficiarySrc)";
const DLN_SOURCE_ABI = [
  `function createOrder(${DLN_ORDER_CREATION} _orderCreation, bytes _affiliateFee, uint32 _referralCode, bytes _permitEnvelope) payable returns (bytes32)`,
  `function createSaltedOrder(${DLN_ORDER_CREATION} _orderCreation, uint64 _salt, bytes _affiliateFee, uint32 _referralCode, bytes _permitEnvelope, bytes _metadata) payable returns (bytes32)`,
];

function debridgeRefused(msg: string): PerpError {
  return new PerpError("POLICY_DENIED", `deBridge transaction refused: ${msg}. Nothing was signed or sent.`, {
    exchange: "debridge",
    remediation: "Use another provider: --provider cctp | relay",
  });
}

/**
 * Solana-origin deBridge is refused: the create-tx answer is a full VersionedTransaction (lookup
 * tables, several instructions) that this CLI cannot decode and check against the order it asked
 * for, and SSOT forbids signing a payload blindly.
 */
export function assertDebridgeSourceSupported(srcChain: string): void {
  if (srcChain !== "solana") return;
  throw new PerpError("NO_BRIDGE_ROUTE", "deBridge from Solana is not supported: its Solana transaction cannot be verified locally before signing — nothing was sent", {
    exchange: "debridge",
    remediation: "Use Circle CCTP from Solana: perp funds bridge send --from solana --to <chain> --amount <n> --provider cctp",
  });
}

/** Raw bytes of an address on `chain` as DLN encodes it (EVM: 20 bytes, Solana: the 32-byte key). */
async function dlnAddressBytes(chain: string, address: string): Promise<string> {
  if (chain === "solana") {
    const { PublicKey } = await import("@solana/web3.js");
    return "0x" + Buffer.from(new PublicKey(address).toBytes()).toString("hex");
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw debridgeRefused(`${JSON.stringify(address)} is not an EVM address`);
  return address.toLowerCase();
}

export interface DebridgeTxExpectation {
  srcChain: string;
  dstChain: string;
  sender: string;
  recipient: string;
  /** USDC units that must leave the wallet (OrderCreation.giveAmount). */
  giveAmount: bigint;
  /** USDC units asked for on the destination (create-tx dstChainTokenOutAmount). */
  takeAmount: bigint;
  /** Quoted fixFee (native wei): tx.value may not exceed it. */
  fixFee: bigint;
  /** settings bridge.debridgeAffiliate fee, or null (then no affiliate fee may be attached). */
  affiliate: { feePercent: number; feeRecipient: string } | null;
}

/**
 * Verify a deBridge create-tx EVM transaction before anything is signed: pinned DlnSource target,
 * createOrder / createSaltedOrder decoded, the give token / amount, take token / chain / amount,
 * the receiver and destination order authority (the user's own address), source patch authority,
 * no external call / permit / taker restriction, the affiliate fee, and value ≤ the quoted fixFee.
 * Returns the verified { to, data, value }.
 */
export async function verifyDebridgeEvmTx(tx: Record<string, unknown>, x: DebridgeTxExpectation): Promise<{ to: string; data: string; value: bigint }> {
  const pinned = DLN_SOURCE_EVM[x.srcChain];
  if (pinned === undefined) throw debridgeRefused(`no pinned DlnSource contract for ${x.srcChain}`);
  const to = typeof tx.to === "string" ? tx.to : "";
  if (to.toLowerCase() !== pinned.toLowerCase()) throw debridgeRefused(`the transaction targets ${JSON.stringify(tx.to)}, not the pinned DlnSource ${pinned} on ${x.srcChain}`);
  const data = typeof tx.data === "string" ? tx.data : "";
  if (!/^0x[0-9a-fA-F]+$/.test(data)) throw debridgeRefused("the transaction has no calldata");
  const valueRaw = tx.value === undefined || tx.value === null ? "0" : String(tx.value);
  if (!/^\d+$/.test(valueRaw)) throw debridgeRefused(`unreadable tx value ${JSON.stringify(tx.value)}`);
  const value = BigInt(valueRaw);
  if (value > x.fixFee) throw debridgeRefused(`the transaction sends ${value} wei, more than the quoted fixFee ${x.fixFee}`);

  const { Interface } = await import("ethers");
  const iface = new Interface(DLN_SOURCE_ABI);
  let parsed: ReturnType<typeof iface.parseTransaction>;
  try {
    parsed = iface.parseTransaction({ data, value });
  } catch {
    parsed = null;
  }
  if (parsed === null) throw debridgeRefused("the calldata is neither DlnSource.createOrder nor createSaltedOrder");
  const salted = parsed.name === "createSaltedOrder";
  const oc = parsed.args[0] as unknown as {
    giveTokenAddress: string; giveAmount: bigint; takeTokenAddress: string; takeAmount: bigint; takeChainId: bigint;
    receiverDst: string; givePatchAuthoritySrc: string; orderAuthorityAddressDst: string; allowedTakerDst: string;
    externalCall: string; allowedCancelBeneficiarySrc: string;
  };
  const affiliateFee = String(parsed.args[salted ? 2 : 1]).toLowerCase();
  const permitEnvelope = String(parsed.args[salted ? 4 : 3]);

  const usdcSrc = USDC_ADDRESSES[x.srcChain];
  const usdcDst = USDC_ADDRESSES[x.dstChain];
  const takeChainId = CHAIN_IDS[x.dstChain as keyof typeof CHAIN_IDS];
  if (usdcSrc === undefined || usdcDst === undefined || takeChainId === undefined) throw debridgeRefused(`no pinned USDC / chain id for ${x.srcChain} → ${x.dstChain}`);
  if (oc.giveTokenAddress.toLowerCase() !== usdcSrc.toLowerCase()) throw debridgeRefused(`the order gives token ${oc.giveTokenAddress}, not USDC ${usdcSrc}`);
  if (oc.giveAmount !== x.giveAmount) throw debridgeRefused(`the order takes ${oc.giveAmount} USDC units, not the requested ${x.giveAmount}`);
  if (oc.takeChainId !== BigInt(takeChainId)) throw debridgeRefused(`the order pays out on chain ${oc.takeChainId}, not ${x.dstChain} (${takeChainId})`);
  if (oc.takeTokenAddress.toLowerCase() !== await dlnAddressBytes(x.dstChain, usdcDst)) throw debridgeRefused(`the order pays out token ${oc.takeTokenAddress}, not USDC on ${x.dstChain}`);
  if (oc.takeAmount < x.takeAmount) throw debridgeRefused(`the order pays out ${oc.takeAmount} USDC units, less than the requested ${x.takeAmount}`);
  const recipientBytes = await dlnAddressBytes(x.dstChain, x.recipient);
  if (oc.receiverDst.toLowerCase() !== recipientBytes) throw debridgeRefused(`the order pays ${oc.receiverDst}, not the recipient ${x.recipient}`);
  if (oc.orderAuthorityAddressDst.toLowerCase() !== recipientBytes) throw debridgeRefused(`the destination order authority is ${oc.orderAuthorityAddressDst}, not the recipient ${x.recipient}`);
  if (oc.givePatchAuthoritySrc.toLowerCase() !== x.sender.toLowerCase()) throw debridgeRefused(`the source patch authority is ${oc.givePatchAuthoritySrc}, not the sender ${x.sender}`);
  const cancel = oc.allowedCancelBeneficiarySrc.toLowerCase();
  if (cancel !== "0x" && cancel !== x.sender.toLowerCase()) throw debridgeRefused(`a cancelled order refunds ${oc.allowedCancelBeneficiarySrc}, not the sender ${x.sender}`);
  if (oc.externalCall !== "0x") throw debridgeRefused("the order carries a destination external call");
  if (oc.allowedTakerDst !== "0x") throw debridgeRefused("the order restricts the destination taker");
  if (permitEnvelope !== "0x") throw debridgeRefused("the order carries a permit envelope (only an exact approve is signed)");
  if (x.affiliate === null) {
    if (affiliateFee !== "0x") throw debridgeRefused("the order attaches an affiliate fee, but none is configured (settings bridge.debridgeAffiliate)");
  } else if (affiliateFee !== "0x") {
    // 52 bytes: beneficiary (20) ‖ amount (32) — see the ABI note above.
    if (affiliateFee.length !== 2 + 104) throw debridgeRefused("the affiliate fee is not 52 bytes");
    const beneficiary = "0x" + affiliateFee.slice(2, 42);
    const feeAmount = BigInt("0x" + affiliateFee.slice(42));
    if (beneficiary !== x.affiliate.feeRecipient.toLowerCase()) throw debridgeRefused(`the affiliate fee goes to ${beneficiary}, not the configured ${x.affiliate.feeRecipient}`);
    // feePercent of the give amount (+1 unit rounding).
    const cap = (x.giveAmount * BigInt(Math.round(x.affiliate.feePercent * 1e6))) / 100_000_000n + 1n;
    if (feeAmount > cap) throw debridgeRefused(`the affiliate fee ${feeAmount} exceeds ${x.affiliate.feePercent}% of the amount`);
  }
  return { to: pinned, data, value };
}

/**
 * Get a bridge quote via deBridge DLN.
 */
export async function getDebridgeQuote(
  srcChain: string,
  dstChain: string,
  amountUsdc: UsdcAmount,
  senderAddress: string,
  recipientAddress: string,
): Promise<BridgeQuote> {
  assertDistinctBridgeChains(srcChain, dstChain);
  assertDebridgeSourceSupported(srcChain);
  const srcChainId = CHAIN_IDS[srcChain as keyof typeof CHAIN_IDS];
  const dstChainId = CHAIN_IDS[dstChain as keyof typeof CHAIN_IDS];
  if (!srcChainId || !dstChainId) throw new Error(`Unsupported chain: ${srcChain} or ${dstChain}`);

  const srcToken = USDC_ADDRESSES[srcChain];
  const dstToken = USDC_ADDRESSES[dstChain];
  if (!srcToken || !dstToken) throw new Error(`No USDC address for ${srcChain} or ${dstChain}`);

  const amountRaw = usdcUnits(amountUsdc).toString();
  const amountIn = usdcDisplay(amountUsdc);

  // Step 1: Get quote
  const quoteParams = new URLSearchParams({
    srcChainId: String(srcChainId),
    srcChainTokenIn: srcToken,
    srcChainTokenInAmount: amountRaw,
    dstChainId: String(dstChainId),
    dstChainTokenOut: dstToken,
    // false: the operating expenses come out of the amount, so exactly --amount USDC leaves the
    // wallet. "true" ADDS them to the input (live 2026-10-13: --amount 5 spent 5.939652 USDC while
    // the quote reported amountIn 5 / fee $0.004).
    prependOperatingExpenses: "false",
  });
  appendDebridgeBuilderParams(quoteParams);

  const quoteRes = await fetchWithTimeout(`${DLN_API}/quote?${quoteParams}`);
  if (!quoteRes.ok) throw new Error(`deBridge quote failed: ${quoteRes.status} ${await quoteRes.text()}`);
  const quote = await quoteRes.json() as Record<string, unknown>;

  const estimation = quote.estimation as Record<string, unknown>;
  const dstOut = estimation?.dstChainTokenOut as Record<string, unknown>;
  // SSOT rule #2: bridge quote drives the user's expected amount-out. A
  // missing/malformed dstChainTokenOut.amount must surface as a thrown error,
  // never coerce silently to 0 (which would back-fill amountIn as fee and
  // silently misrepresent the cost).
  const dstAmountRaw = dstOut?.recommendedAmount ?? dstOut?.amount;
  const dstAmountNumber = Number(dstAmountRaw);
  if (dstAmountRaw === undefined || !Number.isFinite(dstAmountNumber)) {
    throw new Error(
      `deBridge quote missing dstChainTokenOut.recommendedAmount/amount ` +
      `(received ${JSON.stringify(dstAmountRaw)}); refusing silent 0 fallback. ` +
      `Raw estimation=${JSON.stringify(estimation)}`,
    );
  }
  const amountOut = dstAmountNumber / 1e6;
  // The USDC actually taken from the wallet must equal the request (prependOperatingExpenses=false).
  const srcInRaw = (estimation?.srcChainTokenIn as Record<string, unknown> | undefined)?.amount;
  if (String(srcInRaw) !== amountRaw) {
    throw new PerpError("EXCHANGE_ERROR", `deBridge quote takes ${JSON.stringify(srcInRaw)} USDC units, not the requested ${amountRaw}`, {
      remediation: "Use another provider: --provider cctp | relay",
    });
  }
  // fixFee: the protocol's flat fee in the source chain's native token (wei / lamports), paid as tx value.
  const fixFeeRaw = quote.fixFee;
  if (typeof fixFeeRaw !== "string" || !/^\d+$/.test(fixFeeRaw)) {
    throw new PerpError("EXCHANGE_ERROR", `deBridge quote has no readable fixFee (${JSON.stringify(fixFeeRaw)})`);
  }
  const nativeSymbol = srcChain === "solana" ? "SOL" : "ETH";
  const nativeDecimals = srcChain === "solana" ? 9 : 18;
  const nativeFee = BigInt(fixFeeRaw) === 0n ? null : { amount: formatUnitsPlain(BigInt(fixFeeRaw), nativeDecimals), symbol: nativeSymbol, usd: null };
  const order = quote.order as Record<string, unknown> | undefined;
  const fulfillDelayRaw = Number(order?.approximateFulfillmentDelay);
  // approximateFulfillmentDelay is documented as nice-to-have telemetry;
  // when omitted, default to 10 (deBridge's published median for healthy
  // routes). This is a documented telemetry default, NOT an error fallback —
  // it does not affect the user's bridge amount/fee math.
  const fulfillDelay = Number.isFinite(fulfillDelayRaw) ? fulfillDelayRaw : 10;

  return {
    provider: "debridge",
    srcChain,
    dstChain,
    amountIn,
    amountOut,
    fee: amountIn - amountOut,
    estimatedTime: fulfillDelay,
    gasIncluded: true,
    gasNote: nativeFee === null ? "DLN market maker fulfills on destination" : `DLN market maker fulfills on destination; plus a flat ${nativeFee.amount} ${nativeFee.symbol} protocol fee (tx value)`,
    nativeFee,
    raw: { quote, senderAddress, recipientAddress, amountRaw, fixFee: fixFeeRaw },
  };
}

/**
 * Execute a deBridge bridge transaction (EVM origin only). The create-tx answer is verified
 * against the request (verifyDebridgeEvmTx) before the exact USDC approval and the order are
 * signed. Returns the TX hash after signing and submitting.
 */
export async function executeDebridgeBridge(
  network: Network,
  bridgeQuote: BridgeQuote,
  signerKey: BridgeSignerInput, // master signer for the source chain (or a raw key)
): Promise<BridgeResult> {
  assertBridgeNetwork(network);
  assertDistinctBridgeChains(bridgeQuote.srcChain, bridgeQuote.dstChain);
  const { srcChain, dstChain, amountIn, amountOut } = bridgeQuote;
  assertDebridgeSourceSupported(srcChain);
  const { senderAddress, recipientAddress, amountRaw, fixFee } = bridgeQuote.raw as {
    senderAddress: string; recipientAddress: string; amountRaw: string; fixFee: string;
  };
  // Resolve the signer before any create-tx call: the order is built for senderAddress only.
  const evmSigner = evmSignerOf(signerKey);
  assertSignerIs(srcChain, evmSigner.getAddress(), senderAddress);
  if (!/^\d+$/.test(String(amountRaw)) || !/^\d+$/.test(String(fixFee))) {
    throw new PerpError("EXCHANGE_ERROR", "deBridge quote is missing its amount / fixFee — nothing was sent", { remediation: "Fetch a fresh quote" });
  }

  const srcChainId = CHAIN_IDS[srcChain as keyof typeof CHAIN_IDS];
  const dstChainId = CHAIN_IDS[dstChain as keyof typeof CHAIN_IDS];
  const srcToken = USDC_ADDRESSES[srcChain];
  const dstToken = USDC_ADDRESSES[dstChain];

  // Get recommended amount from quote
  const quote = (bridgeQuote.raw as Record<string, unknown>).quote as Record<string, unknown>;
  const estimation = quote.estimation as Record<string, unknown>;
  const dstOut = estimation?.dstChainTokenOut as Record<string, unknown>;
  const dstAmountRaw = dstOut?.recommendedAmount ?? dstOut?.amount;
  if (dstAmountRaw === undefined || !/^\d+$/.test(String(dstAmountRaw))) {
    throw new PerpError("EXCHANGE_ERROR", `deBridge quote has no readable dstChainTokenOut amount (${JSON.stringify(dstAmountRaw)}) — nothing sent`);
  }
  const dstAmount = String(dstAmountRaw);

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
    prependOperatingExpenses: "false", // same mode as the quote: exactly amountRaw leaves the wallet
  });
  appendDebridgeBuilderParams(createParams);

  const createRes = await fetchWithTimeout(`${DLN_API}/create-tx?${createParams}`);
  if (!createRes.ok) throw new Error(`deBridge create-tx failed: ${createRes.status} ${await createRes.text()}`);
  const createTx = await createRes.json() as Record<string, unknown>;

  const tx = createTx.tx as Record<string, unknown>;
  if (!tx) throw new Error("deBridge returned no transaction data");

  // Step 3: verify the payload against the request, then approve (exact) + sign + submit.
  const aff = loadSettings().bridge.debridgeAffiliate;
  const verified = await verifyDebridgeEvmTx(tx, {
    srcChain, dstChain, sender: senderAddress, recipient: recipientAddress,
    giveAmount: BigInt(amountRaw), takeAmount: BigInt(dstAmount), fixFee: BigInt(fixFee),
    affiliate: aff !== null && aff.feePercent !== null && aff.feeRecipient !== null ? { feePercent: aff.feePercent, feeRecipient: aff.feeRecipient } : null,
  });
  const txHash = await submitEvmTransaction(verified, BigInt(amountRaw), evmSigner, srcChain);

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
 * Submit a verified deBridge DlnSource order: exact USDC approval of the pinned DlnSource, then
 * the order transaction.
 */
async function submitEvmTransaction(tx: { to: string; data: string; value: bigint }, giveAmount: bigint, signer: BridgeEvmSigner, chain: string): Promise<string> {
  const { rpc, chainId } = await bridgeEvmRpc(chain);
  await ensureUsdcAllowance(rpc, chainId, chain, signer, "debridge", tx.to, giveAmount);
  return sendBridgeEvmTx(rpc, chainId, chain, signer, "debridge", "deBridge order", tx.to, tx.data, tx.value);
}

// ── Circle CCTP V2 (EVM + Solana) ──

export const CCTP_DOMAINS: Record<string, number> = {
  arbitrum: 3,
  solana: 5,
  base: 6,
  hyperliquid: 19,
};

// EVM V2 contracts — ALL EVM chains use the same V2 proxy addresses (per Circle docs)
const EVM_TOKEN_MESSENGER_V2 = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const EVM_MESSAGE_TRANSMITTER_V2 = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
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
 * HyperCore → Solana is refused. The sendToEvmWithData action built below is EVM-only: it sends
 * the recipient with addressEncoding "hex" and signs with signatureChainId = the destination's
 * chain id. Hyperliquid documents addressEncoding "hex" | "base58" and signatureChainId as "the id
 * of the chain used when signing" (hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/
 * exchange-endpoint, read 2026-10-13) — a base58 Solana recipient sent as "hex", signed for the
 * deBridge pseudo chain id 7565164, would not be what HyperCore expects. The Solana encoding is
 * not implemented against documentation, so the route is refused before anything is signed.
 */
export function assertCctpRouteSupported(srcChain: string, dstChain: string): void {
  if (!(srcChain === "hyperliquid" && dstChain === "solana")) return;
  throw new PerpError("NO_BRIDGE_ROUTE", "HyperCore → Solana (CCTP sendToEvmWithData) is not supported: the Solana recipient encoding is not implemented — nothing was sent", {
    exchange: "bridge",
    remediation: "Go through Arbitrum: perp funds bridge exchange --from hyperliquid --to lighter (HyperCore → Arbitrum), then perp funds bridge send --from arbitrum --to solana --amount <n> --provider cctp",
  });
}

/**
 * Check if CCTP is supported for a given chain.
 */
function isCctpSupported(chain: string): boolean {
  return chain in CCTP_DOMAINS;
}

/**
 * Get a CCTP V2 bridge quote. Supports EVM ↔ EVM, Solana ↔ EVM, and → HyperCore.
 *
 * Uses Circle Forwarding Service when available (all routes except →Solana):
 * - Circle handles dst chain mint automatically, no manual receiveMessage needed.
 * - Service fee ~$0.20 (included in maxFee).
 *
 * @param fast - If true, use fast finality (1000): ~1-2 min, $1-1.3 + $0.20 forwarding.
 *               If false (default), use standard finality (2000): ~2-5 min, ~$0.20 forwarding.
 */
export async function getCctpQuote(
  srcChain: string,
  dstChain: string,
  amount: UsdcAmount,
  fast: boolean = false,
): Promise<BridgeQuote> {
  const amountUsdc = usdcDisplay(amount); // display / fee estimates only — signed amounts use usdcUnits(amount)
  assertDistinctBridgeChains(srcChain, dstChain);
  if (!isCctpSupported(srcChain)) throw new Error(`CCTP not supported on ${srcChain}`);
  if (!isCctpSupported(dstChain)) throw new Error(`CCTP not supported on ${dstChain}`);
  assertCctpRouteSupported(srcChain, dstChain);

  // HyperCore → EVM: HL withdrawal + CCTP forwarding (~0.20 USDC fee)
  if (srcChain === "hyperliquid") {
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

  const isHyperCore = dstChain === "hyperliquid";

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
  const srcDomain = CCTP_DOMAINS[srcChain];
  const dstDomain = CCTP_DOMAINS[dstChain];

  // Use Forwarding Service when dst is NOT Solana (Solana dst doesn't support forwarding)
  const canForward = dstChain !== "solana";
  const { maxFee, feeUsdc, forwardingAvailable } = await getCctpRelayFee(srcDomain!, dstDomain!, finality, canForward, amount);

  const estimatedTime = fast
    ? ((srcChain === "solana" || dstChain === "solana") ? 90 : 60)
    : (forwardingAvailable
      ? ((srcChain === "solana" || dstChain === "solana") ? 120 : 90)  // forwarding: Circle handles dst
      : ((srcChain === "solana" || dstChain === "solana") ? 180 : 900) // manual relay
    );

  return {
    provider: "cctp",
    srcChain,
    dstChain,
    amountIn: amountUsdc,
    amountOut: amountUsdc - feeUsdc,
    fee: feeUsdc,
    estimatedTime,
    gasIncluded: fast || forwardingAvailable, // forwarding = Circle handles dst mint
    gasNote: forwardingAvailable
      ? `Forwarding Service (maxFee $${feeUsdc.toFixed(2)}, Circle handles dst mint)`
      : fast
        ? `Fast auto-relay (maxFee $${feeUsdc.toFixed(2)}, ~1-2 min)`
        : `Standard relay → Solana (maxFee $${feeUsdc.toFixed(2)}, manual receiveMessage)`,
    raw: { type: "cctp", maxFee: Number(maxFee), fast, forwarding: forwardingAvailable },
  };
}

/**
 * Execute a CCTP V2 bridge. Routes to the appropriate implementation.
 *
 * @param fast - If true, use fast finality (1000): Circle auto-relays, no manual receiveMessage.
 *               If false (default), use standard finality (2000): cheaper but requires manual relay.
 */
export async function executeCctpBridge(
  network: Network,
  srcChain: string,
  dstChain: string,
  amount: UsdcAmount,
  signerKey: BridgeSignerInput,
  recipientAddress: string,
  dstSignerKey?: BridgeSignerInput, // destination-chain signer for receiveMessage (EVM→Solana standard finality)
  fast: boolean = false,
): Promise<BridgeResult> {
  usdcUnits(amount); // INVALID_PARAMS for a malformed / over-precise amount before anything else
  assertBridgeNetwork(network);
  assertDistinctBridgeChains(srcChain, dstChain);
  assertCctpRouteSupported(srcChain, dstChain);
  // HyperCore route: depositForBurnWithHook via CctpForwarder
  if (dstChain === "hyperliquid") {
    if (srcChain === "solana") {
      return executeCctpSolanaToHyperCore(amount, signerKey, recipientAddress);
    }
    return executeCctpEvmToHyperCore(srcChain, amount, signerKey, recipientAddress);
  }
  // HyperCore → EVM: sendToEvmWithData via HL exchange API
  if (srcChain === "hyperliquid") {
    return executeCctpHyperCoreToEvm(network, dstChain, amount, signerKey, recipientAddress);
  }
  if (srcChain === "solana") {
    return executeCctpSolanaToEvm(dstChain, amount, signerKey, recipientAddress, dstSignerKey, fast);
  }
  if (dstChain === "solana") {
    return executeCctpEvmToSolana(srcChain, amount, signerKey, recipientAddress, dstSignerKey, fast);
  }
  return executeCctpEvmToEvm(srcChain, dstChain, amount, signerKey, recipientAddress, fast);
}

// ── CCTP: Solana → HyperCore (depositForBurnWithHook) ──

async function executeCctpSolanaToHyperCore(
  amount: UsdcAmount,
  signerKey: BridgeSignerInput,
  recipientAddress: string, // EVM address for HyperCore perps
): Promise<BridgeResult> {
  const amountUsdc = usdcDisplay(amount); // display / fee estimates only — signed amounts use usdcUnits(amount)
  const { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, SystemProgram } = await import("@solana/web3.js");
  const { createHash } = await import("crypto");

  const connection = new Connection(RPC_URLS.solana, "confirmed");

  const signer = await solanaSignerOf(signerKey);
  const keypair = { publicKey: new PublicKey(signer.getPublicKeyBase58()) };

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
  amountBuf.writeBigUInt64LE(usdcUnits(amount));

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
  await signVersionedSolanaTx(signer, transaction, [eventDataKeypair]);

  const signature = await sendBridgeSolanaTx(connection, transaction, "CCTP depositForBurnWithHook (Solana → HyperCore)");

  return {
    provider: "cctp (HyperCore)",
    txHash: signature,
    srcChain: "solana",
    dstChain: "hyperliquid",
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
  network: Network,
  dstChain: string,
  amount: UsdcAmount,
  signerKey: BridgeSignerInput,
  recipientAddress: string,
): Promise<BridgeResult> {
  const amountUsdc = usdcDisplay(amount); // display / fee estimates only — signed amounts use usdcUnits(amount)
  assertBridgeNetwork(network);
  const { Signature: EthSig } = await import("ethers");
  // HL environment + /exchange host from the venue definition (never a hardcoded "Mainnet").
  const { hyperliquidChain } = HL_USER_SIGNED[network];
  const hlExchangeUrl = `${networkConfig(getVenue("hyperliquid"), network).restUrl}/exchange`;

  const signer = evmSignerOf(signerKey);
  const dstDomain = CCTP_DOMAINS[dstChain];
  if (dstDomain === undefined) throw new Error(`No CCTP domain for ${dstChain}`);

  const dstChainId = CHAIN_IDS[dstChain as keyof typeof CHAIN_IDS];
  if (!dstChainId) throw new Error(`No chain ID for ${dstChain}`);

  const signatureChainId = "0x" + dstChainId.toString(16);
  const timestamp = Date.now();

  // Build action payload
  const action = {
    type: "sendToEvmWithData",
    hyperliquidChain,
    signatureChainId,
    token: "USDC",
    amount: parseUsdcAmount(amount),
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
    hyperliquidChain,
    token: "USDC",
    amount: parseUsdcAmount(amount),
    sourceDex: "spot",
    destinationRecipient: recipientAddress,
    addressEncoding: "hex",
    destinationChainId: dstDomain,
    // Plain numbers (not BigInt): the OWS signer serializes typed data as JSON. Both are safe integers.
    gasLimit: 200000,
    data: "0x",
    nonce: timestamp,
  };

  const sigHex = await signTypedDataChecked(signer, domain, types, message, "HyperCore sendToEvmWithData");
  const sig = EthSig.from(sigHex);

  // Submit to HL exchange API. A failure after the request left (incl. a timeout) is an unknown outcome.
  let result: Record<string, unknown>;
  try {
    const resp = await fetchWithTimeout(hlExchangeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        nonce: timestamp,
        signature: { r: sig.r, s: sig.s, v: sig.v },
      }),
    }, HyperliquidAdapter.EXCHANGE_TIMEOUT_MS); // a timeout here is sendFailure → ORDER_PENDING
    result = await resp.json() as Record<string, unknown>;
  } catch (e) {
    throw sendFailure("hyperliquid", "sendToEvmWithData (HyperCore → EVM bridge)", e,
      "Do NOT resend — the withdrawal may have been accepted. Check the Hyperliquid account history and the destination balance first");
  }
  if (result.status !== "ok") {
    throw new PerpError("ACTION_REJECTED", `HyperCore withdrawal rejected: ${JSON.stringify(result)}`, { exchange: "hyperliquid" });
  }

  return {
    provider: "cctp (HyperCore → EVM via sendToEvmWithData)",
    txHash: typeof result.response === "string" ? result.response
      : ((result.response as Record<string, unknown>)?.data as Record<string, unknown>)?.hash as string ?? `hl-withdrawal-${timestamp}`,
    srcChain: "hyperliquid",
    dstChain,
    amountIn: amountUsdc,
    amountOut: amountUsdc, // forwarding fee deducted on-chain
  };
}

// ── CCTP: EVM → HyperCore ──
// Arbitrum: CctpExtension.batchDepositForBurnWithAuth (1-TX, no approve)
// Other EVM chains: approve + TokenMessengerV2.depositForBurnWithHook (2-TX fallback)

async function executeCctpEvmToHyperCore(
  srcChain: string,
  amount: UsdcAmount,
  signerKey: BridgeSignerInput,
  recipientAddress: string,
): Promise<BridgeResult> {
  const amountUsdc = usdcDisplay(amount); // display / fee estimates only — signed amounts use usdcUnits(amount)
  const { ethers } = await import("ethers");

  const signer = evmSignerOf(signerKey);
  const { rpc, chainId: rpcChainId } = await bridgeEvmRpc(srcChain);

  const usdcAddr = USDC_ADDRESSES[srcChain];
  if (!usdcAddr) throw new Error(`No USDC address for ${srcChain}`);

  const srcDomain = CCTP_DOMAINS[srcChain];
  if (srcDomain === undefined) throw new Error(`No CCTP domain for ${srcChain}`);
  const chainId = CHAIN_IDS[srcChain as keyof typeof CHAIN_IDS];
  if (!chainId) throw new Error(`No chain ID for ${srcChain}`);

  const fees = await getHyperCoreCctpFees(srcDomain, amountUsdc);
  const amountRaw = usdcUnits(amount);

  // mintRecipient & destinationCaller = CctpForwarder (bytes32)
  const forwarderBytes32 = ethers.zeroPadValue(HYPERCORE_CCTP_FORWARDER, 32);
  const hookData = encodeHyperCoreHookData(recipientAddress, HYPERCORE_DEX_PERPS);

  const cctpExtensionAddr = CCTP_EXTENSION[srcChain];

  let txHash: string;
  let providerLabel: string;

  if (cctpExtensionAddr) {
    // ── Path A: CctpExtension (Arbitrum) — single TX, no approve ──
    const { randomBytes } = await import("crypto");
    const authNonce = "0x" + randomBytes(32).toString("hex");
    const validAfter = 0;
    const validBefore = Math.floor(Date.now() / 1000) + 3600;

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
      from: signer.getAddress(),
      to: cctpExtensionAddr,
      // Decimal string (not BigInt): the OWS signer serializes typed data as JSON.
      value: amountRaw.toString(),
      validAfter,
      validBefore,
      nonce: authNonce,
    };

    const sig = await signTypedDataChecked(signer, usdcDomain, receiveAuthTypes, receiveAuthValue, "USDC ReceiveWithAuthorization");
    const { v, r, s } = ethers.Signature.from(sig);

    const authParams = [amountRaw, validAfter, validBefore, authNonce, v, r, s];
    const burnParams = [amountRaw, HYPERCORE_CCTP_DOMAIN, forwarderBytes32, forwarderBytes32, BigInt(fees.maxFee), 1000, hookData];

    const cctpExtension = new ethers.Interface([
      "function batchDepositForBurnWithAuth(tuple(uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) authParams, tuple(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData) burnParams)",
    ]);

    txHash = await sendBridgeEvmTx(rpc, rpcChainId, srcChain, signer, "cctp", "CCTP batchDepositForBurnWithAuth",
      cctpExtensionAddr, cctpExtension.encodeFunctionData("batchDepositForBurnWithAuth", [authParams, burnParams]));
    providerLabel = "cctp (HyperCore via CctpExtension)";
  } else {
    // ── Path B: approve + depositForBurnWithHook (Base, other EVM chains) ──
    const tokenMessengerAddr = CCTP_TOKEN_MESSENGER[srcChain];
    if (!tokenMessengerAddr) throw new PerpError("NO_BRIDGE_ROUTE", `CCTP not configured for ${srcChain}`);

    await ensureUsdcAllowance(rpc, rpcChainId, srcChain, signer, "cctp", tokenMessengerAddr, amountRaw);

    const tokenMessenger = new ethers.Interface([
      "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData) returns (uint64 nonce)",
    ]);

    txHash = await sendBridgeEvmTx(rpc, rpcChainId, srcChain, signer, "cctp", "CCTP depositForBurnWithHook", tokenMessengerAddr,
      tokenMessenger.encodeFunctionData("depositForBurnWithHook", [
        amountRaw, HYPERCORE_CCTP_DOMAIN, forwarderBytes32, usdcAddr,
        forwarderBytes32, BigInt(fees.maxFee), 1000, hookData,
      ]));
    providerLabel = "cctp (HyperCore via depositForBurnWithHook)";
  }

  return {
    provider: providerLabel,
    txHash,
    srcChain,
    dstChain: "hyperliquid",
    amountIn: amountUsdc,
    amountOut: amountUsdc - fees.totalFee,
  };
}

// ── CCTP: EVM → EVM ──

async function executeCctpEvmToEvm(
  srcChain: string,
  dstChain: string,
  amount: UsdcAmount,
  signerKey: BridgeSignerInput,
  recipientAddress: string,
  fast: boolean = false,
): Promise<BridgeResult> {
  const amountUsdc = usdcDisplay(amount); // display / fee estimates only — signed amounts use usdcUnits(amount)
  const { ethers } = await import("ethers");

  const signer = evmSignerOf(signerKey);

  const usdcAddr = USDC_ADDRESSES[srcChain];
  const tokenMessengerAddr = CCTP_TOKEN_MESSENGER[srcChain];
  const dstDomain = CCTP_DOMAINS[dstChain];
  const srcDomain = CCTP_DOMAINS[srcChain];

  if (!usdcAddr || !tokenMessengerAddr || dstDomain === undefined || srcDomain === undefined) {
    throw new PerpError("NO_BRIDGE_ROUTE", `CCTP not configured for ${srcChain} → ${dstChain}`);
  }
  const { rpc, chainId } = await bridgeEvmRpc(srcChain);

  // Step 0: Check USDC balance
  const balance = await getEvmUsdcBalance(srcChain, signer.getAddress());
  if (balance < amountUsdc) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Insufficient USDC on ${srcChain}: have ${balance.toFixed(2)}, need ${amountUsdc} — nothing was sent`, {
      remediation: `Fund ${signer.getAddress()} with USDC on ${srcChain}, or lower --amount`,
    });
  }

  const amountRaw = usdcUnits(amount);

  // Step 1: Approve USDC
  await ensureUsdcAllowance(rpc, chainId, srcChain, signer, "cctp", tokenMessengerAddr, amountRaw);

  // Step 2: Get fee (with forwarding — Circle handles dst mint)
  const finality = fast ? 1000 : 2000;
  const { maxFee } = await getCctpRelayFee(srcDomain, dstDomain, finality, true, amount);

  // Step 3: depositForBurnWithHook + Forwarding Service
  // Circle Forwarding: include forward hook data → Circle broadcasts receiveMessage on dst.
  // No manual relay needed. No dst chain gas needed.
  const mintRecipient = ethers.zeroPadValue(recipientAddress, 32);
  const destinationCaller = ethers.ZeroHash; // must be zero for forwarding
  const tokenMessenger = new ethers.Interface([
    "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData) returns (uint64 nonce)",
  ]);

  const txHash = await sendBridgeEvmTx(rpc, chainId, srcChain, signer, "cctp", "CCTP depositForBurnWithHook", tokenMessengerAddr,
    tokenMessenger.encodeFunctionData("depositForBurnWithHook", [
      amountRaw, dstDomain, mintRecipient, usdcAddr,
      destinationCaller, maxFee, finality, CCTP_FORWARD_HOOK_DATA,
    ]));
  const feeUsdc = Number(maxFee) / 1e6;
  const providerLabel = fast ? "cctp (fast+forward)" : "cctp (forward)";

  return { provider: providerLabel, txHash, srcChain, dstChain, amountIn: amountUsdc, amountOut: amountUsdc - feeUsdc };
}

// ── CCTP: Solana → EVM ──

async function executeCctpSolanaToEvm(
  dstChain: string,
  amount: UsdcAmount,
  signerKey: BridgeSignerInput,
  recipientAddress: string,
  _dstSignerKey?: BridgeSignerInput, // unused: Circle forwarding handles the destination mint
  fast: boolean = false,
): Promise<BridgeResult> {
  const amountUsdc = usdcDisplay(amount); // display / fee estimates only — signed amounts use usdcUnits(amount)
  const { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction, SystemProgram } = await import("@solana/web3.js");
  const { createHash } = await import("crypto");

  const connection = new Connection(RPC_URLS.solana, "confirmed");
  const dstDomain = CCTP_DOMAINS[dstChain];
  if (dstDomain === undefined) throw new PerpError("NO_BRIDGE_ROUTE", `Unknown CCTP domain for ${dstChain}`);

  const signer = await solanaSignerOf(signerKey);
  const keypair = { publicKey: new PublicKey(signer.getPublicKeyBase58()) };

  // Check USDC balance
  const balance = await getSolanaUsdcBalance(keypair.publicKey.toBase58());
  if (balance < amountUsdc) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Insufficient USDC on Solana: have ${balance.toFixed(2)}, need ${amountUsdc} — nothing was sent`, {
      remediation: `Fund ${keypair.publicKey.toBase58()} with USDC on Solana, or lower --amount`,
    });
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
  // Use deposit_for_burn_with_hook for Forwarding Service (Circle handles dst mint)
  const discriminator = createHash("sha256").update("global:deposit_for_burn_with_hook").digest().subarray(0, 8);

  const amountBuf = Buffer.alloc(8);
  amountBuf.writeBigUInt64LE(usdcUnits(amount));

  // Domain as u32 LE for instruction data (different from PDA seed which uses string)
  const domainBuf = Buffer.alloc(4);
  domainBuf.writeUInt32LE(dstDomain);

  // mintRecipient: EVM address left-padded to 32 bytes
  const recipientBytes = Buffer.alloc(32);
  const addrBytes = Buffer.from(recipientAddress.replace("0x", ""), "hex");
  addrBytes.copy(recipientBytes, 32 - addrBytes.length); // left-pad

  // destinationCaller: all zeros (required for forwarding)
  const destinationCaller = Buffer.alloc(32);

  const finality = fast ? 1000 : 2000;
  const { maxFee: relayFee } = await getCctpRelayFee(CCTP_DOMAINS.solana, dstDomain, finality, true, amount);
  const maxFeeBuf = Buffer.alloc(8);
  maxFeeBuf.writeBigUInt64LE(relayFee);

  const minFinalityBuf = Buffer.alloc(4);
  minFinalityBuf.writeUInt32LE(finality);

  // Forward hook data: "cctp-forward" magic bytes + version(0) + empty data length(0)
  const hookData = Buffer.from(CCTP_FORWARD_HOOK_DATA.replace("0x", ""), "hex");
  // Borsh-encode hook data as Vec<u8>: 4-byte LE length prefix + data
  const hookLenBuf = Buffer.alloc(4);
  hookLenBuf.writeUInt32LE(hookData.length);

  const data = Buffer.concat([
    discriminator, amountBuf, domainBuf, recipientBytes,
    destinationCaller, maxFeeBuf, minFinalityBuf,
    hookLenBuf, hookData,
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
  await signVersionedSolanaTx(signer, transaction, [eventDataKeypair]);

  const signature = await sendBridgeSolanaTx(connection, transaction, "CCTP depositForBurnWithHook (Solana → EVM)");

  const feeUsdc = Number(relayFee) / 1e6;
  const providerLabel = fast ? "cctp (fast+forward)" : "cctp (forward)";

  // Forwarding Service: Circle handles dst chain mint — no manual relay needed.
  return { provider: providerLabel, txHash: signature, srcChain: "solana", dstChain, amountIn: amountUsdc, amountOut: amountUsdc - feeUsdc };
}

// ── CCTP: EVM → Solana ──
// NOTE: Circle Forwarding Service does NOT support Solana as destination.
// Must use depositForBurn + manual receiveMessage (or fast finality for auto-relay).

async function executeCctpEvmToSolana(
  srcChain: string,
  amount: UsdcAmount,
  signerKey: BridgeSignerInput,
  recipientAddress: string, // Solana base58 pubkey
  solanaPayerKey?: BridgeSignerInput, // Solana signer for the receiveMessage relay (standard finality)
  fast: boolean = false,
): Promise<BridgeResult> {
  const amountUsdc = usdcDisplay(amount); // display / fee estimates only — signed amounts use usdcUnits(amount)
  const { ethers } = await import("ethers");

  const signer = evmSignerOf(signerKey);

  const usdcAddr = USDC_ADDRESSES[srcChain];
  const tokenMessengerAddr = CCTP_TOKEN_MESSENGER[srcChain];
  const solanaDomain = CCTP_DOMAINS.solana; // 5

  if (!usdcAddr || !tokenMessengerAddr) throw new PerpError("NO_BRIDGE_ROUTE", `CCTP not configured for ${srcChain}`);
  // Standard finality needs our own Solana receiveMessage after the burn: without the Solana
  // signer the burn would leave the USDC unminted. Refused before anything is sent.
  if (!fast && solanaPayerKey === undefined) {
    throw new PerpError("NO_SIGNER_AVAILABLE", `CCTP ${srcChain} → Solana (standard finality) mints with a Solana receiveMessage signed by the master's Solana key, and none was supplied — nothing was sent`, {
      exchange: "bridge",
      remediation: "Select a master wallet that has a Solana account (perp wallet use <name> / --ows <name>), or pass --fast",
    });
  }
  const { rpc, chainId } = await bridgeEvmRpc(srcChain);

  // Step 0: Check USDC balance
  const balance = await getEvmUsdcBalance(srcChain, signer.getAddress());
  if (balance < amountUsdc) {
    throw new PerpError("INSUFFICIENT_BALANCE", `Insufficient USDC on ${srcChain}: have ${balance.toFixed(2)}, need ${amountUsdc} — nothing was sent`, {
      remediation: `Fund ${signer.getAddress()} with USDC on ${srcChain}, or lower --amount`,
    });
  }

  const amountRaw = usdcUnits(amount);

  // Step 1: Approve USDC
  await ensureUsdcAllowance(rpc, chainId, srcChain, signer, "cctp", tokenMessengerAddr, amountRaw);

  // Step 2: Get relay fee (no forwarding — Solana dst not supported)
  const finality = fast ? 1000 : 2000;
  const srcDomain = CCTP_DOMAINS[srcChain];
  const { maxFee: relayFee, feeUsdc } = await getCctpRelayFee(srcDomain!, solanaDomain, finality, false, amount);

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
  const tokenMessenger = new ethers.Interface([
    "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold) returns (uint64 nonce)",
  ]);

  const txHash = await sendBridgeEvmTx(rpc, chainId, srcChain, signer, "cctp", "CCTP depositForBurn", tokenMessengerAddr,
    tokenMessenger.encodeFunctionData("depositForBurn", [
      amountRaw, solanaDomain, mintRecipient, usdcAddr,
      destinationCaller, relayFee, finality,
    ]));

  // Fast finality (1000): Circle auto-relays — done.
  if (fast) {
    return { provider: "cctp (fast)", txHash, srcChain, dstChain: "solana", amountIn: amountUsdc, amountOut: amountUsdc - feeUsdc };
  }

  // Standard finality (2000): poll attestation + manual Solana receiveMessage. The burn is final:
  // anything short of a confirmed mint is ORDER_PENDING (never a normal result, never a resend).
  const receiveTxHash = await completeEvmToSolanaMint(srcDomain!, txHash, recipientAddress, solanaPayerKey!);
  return { provider: "cctp", txHash, receiveTxHash, srcChain, dstChain: "solana", amountIn: amountUsdc, amountOut: amountUsdc - feeUsdc };
}

/** Circle Iris V2 message lookup for a source-chain burn. */
function irisMessageUrl(srcDomain: number, txHash: string): string {
  return `https://iris-api.circle.com/v2/messages/${srcDomain}?transactionHash=${txHash}`;
}

function burnedMintUnconfirmed(srcDomain: number, burnTxHash: string, why: string): PerpError {
  const iris = irisMessageUrl(srcDomain, burnTxHash);
  return new PerpError("ORDER_PENDING", `CCTP: USDC burned (tx ${burnTxHash}); mint on Solana not confirmed — ${why}`, {
    exchange: "bridge", txHash: burnTxHash, attestationUrl: iris,
    remediation: `Do NOT resend the bridge — the USDC is already burned. Check the attestation at ${iris}; once it is complete the mint can be claimed with a Solana receiveMessage (CCTP is idempotent per message nonce). Then check the Solana USDC balance.`,
  });
}

/**
 * After an EVM → Solana standard-finality burn: wait for Circle's attestation, then mint on
 * Solana with receiveMessage. Returns the mint signature. Timeout or a failed / unconfirmed
 * receiveMessage throws ORDER_PENDING carrying the burn tx hash and the Iris URL.
 * `opts` exists for tests (poll count / interval, receiveMessage implementation).
 */
export async function completeEvmToSolanaMint(
  srcDomain: number, burnTxHash: string, recipientAddress: string, payer: BridgeSignerInput,
  opts: { attempts: number; intervalMs: number; receive: typeof executeSolanaReceiveMessage } = { attempts: 80, intervalMs: 15_000, receive: executeSolanaReceiveMessage },
): Promise<string> {
  const url = irisMessageUrl(srcDomain, burnTxHash);
  let message: string | null = null;
  let attestation: string | null = null;
  for (let i = 0; i < opts.attempts && message === null; i++) {
    await sleep(opts.intervalMs);
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) continue; // 404 until Iris indexes the burn: keep polling (read-only)
      const body = await res.json() as { messages?: Array<{ status?: string; attestation?: string; message?: string }> };
      const msg = body.messages?.[0];
      if (msg?.status === "complete" && msg.message && msg.attestation && msg.attestation !== "PENDING") {
        message = msg.message;
        attestation = msg.attestation;
      }
    } catch {
      // A failed read of the attestation is retried until the poll budget ends (read-only).
    }
  }
  if (message === null || attestation === null) {
    throw burnedMintUnconfirmed(srcDomain, burnTxHash, `no complete attestation after ${Math.round(opts.attempts * opts.intervalMs / 1000)}s`);
  }
  try {
    return await opts.receive(message, attestation, recipientAddress, payer);
  } catch (e) {
    throw burnedMintUnconfirmed(srcDomain, burnTxHash, `receiveMessage did not confirm (${e instanceof Error ? e.message : String(e)})`);
  }
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
  payerKey: BridgeSignerInput, // Solana master signer (or raw base58 / JSON key)
): Promise<string> {
  const { Connection, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram, ComputeBudgetProgram } = await import("@solana/web3.js");
  const { createHash } = await import("crypto");

  const connection = new Connection(RPC_URLS.solana, "confirmed");

  const payerSigner = await solanaSignerOf(payerKey);
  const payer = { publicKey: new PublicKey(payerSigner.getPublicKeyBase58()) };

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
  await signVersionedSolanaTx(payerSigner, transaction);

  return sendBridgeSolanaTx(connection, transaction, "CCTP receiveMessage (Solana)");
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
      const res = await fetchWithTimeout(url);
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
// Quote verification, step validation and execution live in ./relay-swap.ts (generic assets,
// EVM-origin deposits). These two functions are the USDC → USDC entry used by getAllQuotes /
// executeBestBridge.

export async function getRelayQuote(
  srcChain: string,
  dstChain: string,
  amount: UsdcAmount,
  senderAddress: string,
  recipientAddress: string,
): Promise<BridgeQuote> {
  const amountUsdc = usdcDisplay(amount); // display / fee estimates only — signed amounts use usdcUnits(amount)
  assertDistinctBridgeChains(srcChain, dstChain);
  const { quoteRelaySwap } = await import("./relay-swap.js");
  // Verified locally (order id, depository, amounts, recipient) — see relay-swap.ts.
  const q = await quoteRelaySwap({
    from: srcChain, to: dstChain, fromAsset: "USDC", toAsset: "USDC",
    amount: parseUsdcAmount(amount), sender: senderAddress, recipient: recipientAddress,
  });
  return {
    provider: "relay",
    srcChain,
    dstChain,
    amountIn: amountUsdc,
    amountOut: Number(q.expectedOut),
    fee: Number(q.fees.relayerUsd),
    // timeEstimate is telemetry only; 30s is the documented Relay median for healthy routes.
    estimatedTime: q.timeEstimateSec === null ? 30 : q.timeEstimateSec,
    gasIncluded: true,
    gasNote: "Relay solver handles destination execution",
    raw: q,
  };
}

/**
 * Execute a verified Relay USDC quote with the master's EVM signer (OWS vault signer or a raw
 * key). Only the verified approve (exact amount, pinned depository) + deposit are signed — never
 * an unlimited approval, never an unchecked target.
 */
export async function executeRelayBridge(
  network: Network,
  bridgeQuote: BridgeQuote,
  signerKey: BridgeSignerInput,
): Promise<BridgeResult> {
  assertBridgeNetwork(network);
  assertDistinctBridgeChains(bridgeQuote.srcChain, bridgeQuote.dstChain);
  const { executeRelaySwap, assertRelayMinOut } = await import("./relay-swap.js");
  const q = bridgeQuote.raw as import("./relay-swap.js").RelaySwapQuote;
  assertRelayMinOut(q, null);
  const signer = evmSignerOf(signerKey);
  if (signer.getAddress().toLowerCase() !== q.sender.toLowerCase()) {
    throw new PerpError("INVALID_PARAMS", `The Relay quote was built for sender ${q.sender}, not the signing wallet's address ${signer.getAddress()} — nothing was sent`);
  }
  const res = await executeRelaySwap(network, q, tx => signer.signTransaction(tx));
  return {
    provider: "relay",
    txHash: res.depositTxHash,
    srcChain: bridgeQuote.srcChain,
    dstChain: bridgeQuote.dstChain,
    amountIn: bridgeQuote.amountIn,
    amountOut: bridgeQuote.amountOut,
    ...(res.destinationTxHashes.length > 0 ? { receiveTxHash: res.destinationTxHashes[0] } : {}),
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
/** Plain decimal string of `raw` / 10^decimals (no exponent, trailing zeros trimmed). */
function formatUnitsPlain(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac === "" ? whole.toString() : `${whole}.${frac}`;
}

/** USD mid of native tokens (ETH / SOL) from Hyperliquid allMids; a failed read leaves them unpriced. */
async function nativeUsdPrices(symbols: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const res = await fetchWithTimeout("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) });
    if (!res.ok) return out;
    const mids = await res.json() as Record<string, unknown>;
    for (const sym of symbols) {
      const px = Number(mids[sym]);
      if (Number.isFinite(px) && px > 0) out.set(sym, px);
    }
  } catch {
    // Unpriced is reported as usd: null and ranks the quote last — never treated as a zero fee.
  }
  return out;
}

export async function getAllQuotes(
  srcChain: string,
  dstChain: string,
  amount: UsdcAmount,
  senderAddress: string,
  recipientAddress: string,
): Promise<BridgeQuote[]> {
  usdcUnits(amount); // INVALID_PARAMS before the fan-out (allSettled would hide it as "no route")
  assertDistinctBridgeChains(srcChain, dstChain);
  const results = await Promise.allSettled([
    getCctpQuote(srcChain, dstChain, amount),
    getRelayQuote(srcChain, dstChain, amount, senderAddress, recipientAddress),
    getDebridgeQuote(srcChain, dstChain, amount, senderAddress, recipientAddress),
  ]);

  const quotes: BridgeQuote[] = [];
  const failures: string[] = [];
  const providers = ["cctp", "relay", "debridge"] as const;
  results.forEach((r, i) => {
    if (r.status === "fulfilled") quotes.push(r.value);
    else failures.push(`${providers[i]}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });
  // A provider without this route is normal; still say which ones were left out and why, and
  // never answer "no quotes" without the reasons.
  if (quotes.length === 0) {
    throw new PerpError("NO_BRIDGE_ROUTE", `No bridge quote for ${srcChain} → ${dstChain} (${failures.join("; ")})`, {
      remediation: "Check the chains / amount, or retry if a provider was unreachable",
    });
  }
  if (failures.length > 0) process.stderr.write(`[bridge] providers without a quote: ${failures.join("; ")}\n`);

  // Price native fees (deBridge fixFee) so quotes compare on the same basis; an unpriced native
  // fee ranks that quote last (its total cost is unknown), never as free.
  const symbols = [...new Set(quotes.flatMap(q => (q.nativeFee ? [q.nativeFee.symbol] : [])))];
  if (symbols.length > 0) {
    const prices = await nativeUsdPrices(symbols);
    for (const q of quotes) {
      if (!q.nativeFee) continue;
      const px = prices.get(q.nativeFee.symbol);
      q.nativeFee = { ...q.nativeFee, usd: px === undefined ? null : Number(q.nativeFee.amount) * px };
    }
  }
  const net = (q: BridgeQuote): number | null => (q.nativeFee ? (q.nativeFee.usd === null ? null : q.amountOut - q.nativeFee.usd) : q.amountOut);
  quotes.sort((a, b) => {
    const na = net(a), nb = net(b);
    if (na === null && nb === null) return b.amountOut - a.amountOut;
    if (na === null) return 1;
    if (nb === null) return -1;
    return nb - na;
  });
  return quotes;
}

/**
 * Get the best quote across all providers.
 */
export async function getBestQuote(
  srcChain: string,
  dstChain: string,
  amount: UsdcAmount,
  senderAddress: string,
  recipientAddress: string,
): Promise<BridgeQuote> {
  const quotes = await getAllQuotes(srcChain, dstChain, amount, senderAddress, recipientAddress);
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
  network: Network,
  srcChain: string,
  dstChain: string,
  amount: UsdcAmount,
  signerKey: BridgeSignerInput,
  senderAddress: string,
  recipientAddress: string,
  dstSignerKey?: BridgeSignerInput, // Optional destination-chain signer for manual receiveMessage (standard finality)
  provider?: "cctp" | "relay" | "debridge",
  fast: boolean = false,
): Promise<BridgeResult> {
  // Before quoting: a testnet run must not even look up mainnet routes to sign.
  assertBridgeNetwork(network);
  assertDistinctBridgeChains(srcChain, dstChain);
  usdcUnits(amount); // INVALID_PARAMS (> 6 decimals, malformed) before any quote
  // Specific refusals (the quote fan-out below would only report "not available").
  assertCctpRouteSupported(srcChain, dstChain);
  if (provider === "debridge") assertDebridgeSourceSupported(srcChain);
  let quote: BridgeQuote;

  if (provider) {
    // User specified a provider — get that specific quote
    const quotes = await getAllQuotes(srcChain, dstChain, amount, senderAddress, recipientAddress);
    const match = quotes.find(q => q.provider === provider);
    if (!match) {
      throw new PerpError("NO_BRIDGE_ROUTE", `Provider "${provider}" not available for ${srcChain} → ${dstChain} — nothing was sent`, {
        remediation: "Drop --provider to use the best available route (see: perp funds bridge quote)",
      });
    }
    quote = match;
  } else {
    // Default: prefer deBridge DLN (fastest, ~2s), fallback to best available
    const quotes = await getAllQuotes(srcChain, dstChain, amount, senderAddress, recipientAddress);
    if (quotes.length === 0) {
      throw new PerpError("NO_BRIDGE_ROUTE", `No bridge available for ${srcChain} → ${dstChain} — nothing was sent`, {
        remediation: "Check supported routes: perp funds bridge chains",
      });
    }
    quote = quotes.find(q => q.provider === "debridge") ?? quotes[0];
  }

  if (quote.provider === "cctp") {
    return executeCctpBridge(network, srcChain, dstChain, amount, signerKey, recipientAddress, dstSignerKey, fast);
  }

  if (quote.provider === "relay") {
    return executeRelayBridge(network, quote, signerKey);
  }

  return executeDebridgeBridge(network, quote, signerKey);
}

/**
 * Check bridge order status via deBridge.
 */
export async function checkDebridgeStatus(orderId: string): Promise<Record<string, unknown>> {
  const res = await fetchWithTimeout(`${DLN_API}/${orderId}/status`);
  if (!res.ok) throw new Error(`Status check failed: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>>;
}

// ── Helpers ──

/**
 * Append deBridge referral / affiliate params when the user configured them in
 * settings `bridge.debridgeAffiliate` (`perp settings set bridge.debridgeAffiliate.*`).
 * Absent (the shipped state) → nothing is sent. No env var is read.
 */
function appendDebridgeBuilderParams(params: URLSearchParams): void {
  const aff = loadSettings().bridge.debridgeAffiliate;
  if (aff === null) return;
  if (aff.referralCode !== null) params.set("referralCode", aff.referralCode);
  if (aff.feePercent !== null && aff.feeRecipient !== null) {
    params.set("affiliateFeePercent", String(aff.feePercent));
    params.set("affiliateFeeRecipient", aff.feeRecipient);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
