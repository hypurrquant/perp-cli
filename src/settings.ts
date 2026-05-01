import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const SETTINGS_FILE = resolve(PERP_DIR, "settings.json");

export interface ExchangeFees {
  taker: number;  // fraction, e.g. 0.00035 = 0.035%
  maker: number;
}

export interface AlertRule {
  id: string;
  symbol: string;      // "*" = all symbols
  exchange: string;     // "*" = all exchanges
  threshold: number;    // annualized funding rate %
  direction: "above" | "below";
  enabled: boolean;
}

export interface AlertSettings {
  discord?: {
    botToken: string;
    userId: string;
    channelId?: string; // cached DM channel ID for faster sends
  };
  telegram?: {
    botToken: string;
    chatId: string;
  };
  rules: AlertRule[];
  /** Check interval in seconds (default: 300 = 5 min) */
  intervalSec: number;
  /** Cooldown per symbol in minutes after alert fires (default: 60) */
  cooldownMin: number;
}

export interface AgentMeta {
  agentName: string;
  agentWalletName: string;
  /**
   * EVM address of the agent wallet (required for Aster + Hyperliquid).
   * For Pacifica (Phase 2c): kept as a sentinel zero-address since the
   * curve is Solana/Ed25519; the canonical address lives in
   * `agentSolanaAddress`. For Lighter (Phase 2d): populated with the master
   * EVM address (since L1 ChangePubKey is signed by the master EVM key); the
   * canonical agent identity lives in `publicKey + apiKeyIndex`.
   * The `0x${string}` literal is preserved to avoid disrupting Aster/HL strict typing.
   */
  agentEvmAddress: `0x${string}`;
  /** EVM address of the master/owner wallet — required as `user` field in Aster/HL requests. Populated by `agent approve` (Step 4). */
  userEvmAddress: `0x${string}`;
  /**
   * Solana base58 public key of the agent wallet (Phase 2c — Pacifica only).
   * Optional for Aster/HL since they live on EVM curves.
   */
  agentSolanaAddress?: string;
  /**
   * Solana base58 public key of the master/owner wallet (Phase 2c — Pacifica only).
   * Optional for Aster/HL.
   */
  userSolanaAddress?: string;
  /**
   * Lighter slot index (Phase 2d — Lighter only).
   * Range: [4, 254] inclusive. Slots 0-3 are reserved by the Lighter frontend.
   * Selected at approve time as `max(existing slots) + 1`.
   */
  apiKeyIndex?: number;
  /**
   * Lighter agent secp256k1 public key (hex, no `0x` prefix) (Phase 2d — Lighter only).
   * Canonical identity for the Lighter L2 hot-path. Cross-checked against
   * `GET /api/v1/apikeys?account_index=N` during `wallet agent verify lighter`.
   */
  publicKey?: string;
  /**
   * Lighter L2 account index (Phase 2d — Lighter only).
   * Resolved at approve time from L1 EVM address via the Lighter REST API
   * and cached so subsequent verify/trade calls don't need to re-query.
   */
  accountIndex?: number;
  masterWalletName: string;
  owsApiKeyId: string;
  owsPolicyId: string;
  expiresAt: string;
  approvedAt: string;
  permissions: { canPerpTrade: boolean; canSpotTrade: boolean; canWithdraw: boolean };
  asterApprovalNonce: string;
  status?: "active" | "partial";
}

export interface AgentsByExchange {
  aster?: Record<string, AgentMeta>;
  hyperliquid?: Record<string, AgentMeta>;  // NEW v3.4
  pacifica?: Record<string, AgentMeta>;     // NEW v3.5
  lighter?: Record<string, AgentMeta>;      // NEW v3.6
}

export interface Settings {
  /** Default exchange when -e flag is omitted */
  defaultExchange: string;
  /** Active OWS wallet name (used when no --ows or --wallet flag) */
  owsActiveWallet: string;
  /** Per-exchange referral / builder codes (always applied per SSOT Rule #3:
   *  no opt-out — Pacifica builder code has always been mandatory; HL/LT
   *  aligned 2026-05-01). */
  referralCodes: {
    pacifica: string;   // builder code (sent per-order, not one-time)
    hyperliquid: string;
    lighter: string;
  };
  /** Track which exchanges have had referral codes applied (one-time) */
  referralApplied: {
    hyperliquid: boolean;
    lighter: boolean;
  };
  /** Per-exchange fee tiers (fetched from exchange APIs) */
  fees: Record<string, ExchangeFees>;
  /** Alert configuration */
  alerts: AlertSettings;
  /** OWS-native agent wallets registered per exchange (Phase 2a: Aster only) */
  agents?: AgentsByExchange;
}

const DEFAULTS: Settings = {
  defaultExchange: "",
  owsActiveWallet: "",
  referralCodes: {
    pacifica: "",
    hyperliquid: "HYPERCASH",
    lighter: "718585MY",
  },
  referralApplied: {
    hyperliquid: false,
    lighter: false,
  },
  fees: {
    hyperliquid: { taker: 0.00035, maker: 0.00002 },
    pacifica: { taker: 0.00035, maker: 0.0001 },
    lighter: { taker: 0, maker: 0 },
  },
  alerts: {
    rules: [],
    intervalSec: 300,
    cooldownMin: 60,
  },
};

export function loadSettings(): Settings {
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULTS, referralCodes: { ...DEFAULTS.referralCodes }, fees: { ...DEFAULTS.fees }, alerts: { ...DEFAULTS.alerts } };
  try {
    const stored = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
    // Merge stored fees with defaults (so new exchanges get defaults)
    const fees: Record<string, ExchangeFees> = { ...DEFAULTS.fees };
    if (stored.fees && typeof stored.fees === "object") {
      for (const [ex, f] of Object.entries(stored.fees)) {
        const fee = f as Partial<ExchangeFees>;
        if (fee && typeof fee.taker === "number" && typeof fee.maker === "number") {
          fees[ex] = { taker: fee.taker, maker: fee.maker };
        }
      }
    }
    return {
      defaultExchange: stored.defaultExchange ?? DEFAULTS.defaultExchange,
      owsActiveWallet: stored.owsActiveWallet ?? DEFAULTS.owsActiveWallet,
      referralCodes: {
        pacifica: stored.referralCodes?.pacifica ?? DEFAULTS.referralCodes.pacifica,
        hyperliquid: stored.referralCodes?.hyperliquid ?? DEFAULTS.referralCodes.hyperliquid,
        lighter: stored.referralCodes?.lighter ?? DEFAULTS.referralCodes.lighter,
      },
      referralApplied: {
        hyperliquid: stored.referralApplied?.hyperliquid ?? DEFAULTS.referralApplied.hyperliquid,
        lighter: stored.referralApplied?.lighter ?? DEFAULTS.referralApplied.lighter,
      },
      alerts: {
        discord: stored.alerts?.discord ?? DEFAULTS.alerts.discord,
        telegram: stored.alerts?.telegram ?? DEFAULTS.alerts.telegram,
        rules: Array.isArray(stored.alerts?.rules) ? stored.alerts.rules : DEFAULTS.alerts.rules,
        intervalSec: stored.alerts?.intervalSec ?? DEFAULTS.alerts.intervalSec,
        cooldownMin: stored.alerts?.cooldownMin ?? DEFAULTS.alerts.cooldownMin,
      },
      fees,
      agents: stored.agents && typeof stored.agents === "object" ? stored.agents : undefined,
    };
  } catch {
    return { ...DEFAULTS, referralCodes: { ...DEFAULTS.referralCodes }, fees: { ...DEFAULTS.fees }, alerts: { ...DEFAULTS.alerts } };
  }
}

export function saveSettings(settings: Settings): void {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
}
