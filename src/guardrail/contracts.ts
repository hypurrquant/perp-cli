/**
 * DEX contract whitelist for perp-guardrail policy executable.
 * Keyed by CAIP-2 chain ID → array of allowed contract/program addresses.
 */

// ── Pacifica (Solana) ──
const PACIFICA_MAINNET = [
  "PCFA5iYgmqK6MqPhWNKg7Yv7auX7VZ4Cx7T1eJyrAMH",  // Pacifica program
  "9Gdmhq4Gv1LnNMp7aiS1HSVd7pNnXNMsbuXALCQRmGjY",  // Central state
  "72R843XwZxqWhsJceARQQTTbYtWy6Zw9et2YV4FpRHTa",    // Vault
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",    // USDC mint
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",      // SPL Token
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",     // Associated Token
  "11111111111111111111111111111111",                    // System Program
  "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe",     // CCTP V2 Token Messenger
  "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC",     // CCTP V2 Message Transmitter
];

const PACIFICA_TESTNET = [
  "peRPsYCcB1J9jvrs29jiGdjkytxs8uHLmSPLKKP9ptm",     // Testnet program
  "2zPRq1Qvdq5A4Ld6WsH7usgCge4ApZRYfhhf5VAjfXxv",    // Testnet central state
  "5SDFdHZGTZbyRYu54CgmRkCGnPHC5pYaN27p7XGLqnBs",    // Testnet vault
  "USDPqRbLidFGufty2s3oizmDEKdqx7ePTqzDMbf5ZKM",      // Testnet USDC
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "11111111111111111111111111111111",
];

// ── Hyperliquid (Arbitrum + HyperCore) ──
const HYPERLIQUID_CONTRACTS = [
  "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757",  // CctpForwarder (HyperCore)
];

// ── CCTP V2 (shared across EVM chains) ──
const CCTP_V2_EVM = [
  "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",  // TokenMessengerV2
  "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",  // MessageTransmitterV2
];

// ── USDC addresses ──
export const USDC_ADDRESSES: Record<string, string> = {
  "eip155:1":     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",  // Ethereum
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",  // Arbitrum
  "eip155:8453":  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",  // Base
};

// ── Complete whitelist by CAIP-2 chain ──
export const ALLOWED_CONTRACTS: Record<string, string[]> = {
  // Solana mainnet
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": PACIFICA_MAINNET,
  // Solana devnet
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": PACIFICA_TESTNET,
  // Arbitrum (Hyperliquid deposits + CCTP)
  "eip155:42161": [...HYPERLIQUID_CONTRACTS, ...CCTP_V2_EVM, USDC_ADDRESSES["eip155:42161"]],
  // Hyperliquid signing domain (phantom chain for typed data)
  "eip155:1337": [],  // no contract calls, only typed data signing
  // Base (CCTP bridge + USDC)
  "eip155:8453": [...CCTP_V2_EVM, USDC_ADDRESSES["eip155:8453"]],
  // Lighter (ZK rollup)
  "eip155:304": [],   // signing-based, no direct contract interaction
  "eip155:300": [],   // Lighter testnet
  // Ethereum mainnet (CCTP + USDC)
  "eip155:1": [...CCTP_V2_EVM, USDC_ADDRESSES["eip155:1"]],
};

// ── Allowed chain IDs (all chains our DEXes operate on) ──
export const ALLOWED_CHAINS: string[] = Object.keys(ALLOWED_CONTRACTS);

// ── Default guardrail limits ──
export const DEFAULT_LIMITS = {
  max_tx_usd: 1000,
  max_daily_usd: 5000,
};
