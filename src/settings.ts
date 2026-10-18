import type { VenueId } from "./exchanges/venue-types.js";
import { isVenueId } from "./exchanges/venue-types.js";
import { PerpError } from "./errors.js";
import { parseBuilderSettings, type BuilderSettings } from "./exchanges/builder-fee.js";
import { existsSync, readFileSync, mkdirSync } from "fs";
import { writeKeystoreAtomic } from "./agent-wallet/venue-keystore.js";
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
  /**
   * canWithdraw null = unknown: a key imported from the exchange website (its withdraw
   * permission is set there and cannot be read back). Never treated as true (rotate does not
   * inherit it; Aster withdraw requires === true).
   */
  permissions: { canPerpTrade: boolean; canSpotTrade: boolean; canWithdraw: boolean | null };
  asterApprovalNonce: string;
  status?: "active" | "partial";
  /**
   * Network the agent was registered on. Every approve/rotate writes it.
   * Records written before network tagging lack it — see agentNetworkOf()
   * in agent-wallet/store.ts for how those are classified.
   */
  network?: "mainnet" | "testnet";
  /**
   * How the key got here: "approved" = this CLI signed the approval with a master wallet on this
   * machine; "imported" = created on the exchange website and imported with
   * `perp wallet agent import` (the master is known only by its public address and
   * `masterWalletName` is ""). Records written before this field are "approved" — see
   * agentSourceOf() in agent-wallet/store.ts.
   */
  source?: AgentSource;
}

/** See AgentMeta.source. */
export type AgentSource = "approved" | "imported";

/** Ondo Perps API key (HMAC). The secret lives only in ~/.perp/ondo-agents/<keyId>.json (SSOT Rule #3). */
export interface OndoAgentMeta {
  kind: "ondo";
  agentName: string;
  keyId: string;
  keystorePath: string;
  scopes: string[] | null;
  /** Network the key was verified against at approve time; adapters refuse a mismatch. */
  network: "mainnet" | "testnet";
  approvedAt: string;
  /** Ondo keys are always created in the Ondo Perps web app; absent on records written before this field. */
  source?: AgentSource;
}

/** Arcus Ed25519 API key. The private key lives only in OWS wallet `agentWalletName` (SSOT Rule #3). */
export interface ArcusAgentMeta {
  kind: "arcus";
  agentName: string;
  agentWalletName: string;
  /** 64-hex Ed25519 public key registered via createApiKey. */
  apiKeyHex: string;
  /** Subaccount index 0–9, or 255 for all subaccounts. */
  accountIndex: number;
  ownerAddress: `0x${string}`;
  /** ISO timestamp; Arcus keys expire after at most 180 days. */
  validUntil: string;
  /** Network the key was registered on at approve time; adapters refuse a mismatch. */
  network: "mainnet" | "testnet";
  approvedAt: string;
  /** See AgentMeta.source; absent = "approved" (records written before this field). */
  source?: AgentSource;
}

/**
 * QFEX API key (HMAC), created on the QFEX website (2FA) and imported. The secret lives only in
 * ~/.perp/qfex-agents/<publicKey>.json (SSOT Rule #3).
 */
export interface QfexAgentMeta {
  kind: "qfex";
  agentName: string;
  publicKey: string;
  keystorePath: string;
  /**
   * The concrete account UUID this key trades (resolved and confirmed at import: the primary
   * account's id, or the chosen subaccount). Never null — every request names it explicitly.
   */
  accountId: string;
  /** Whether accountId is the user's primary account (deposits / withdrawals are primary-only). */
  isPrimaryAccount: boolean;
  /**
   * What the import-time read checks showed. INFORMATIONAL ONLY: never used as a gate and never
   * updated from a runtime denial (which may be KYC, terms, region or scope). null = not checked.
   */
  permissions: {
    viewPositions: boolean | null; viewBalance: boolean | null; viewOrders: boolean | null;
    executeOrders: boolean | null; depositWithdraw: boolean | null;
  };
  /** Network the key was verified against at import; the adapter refuses a mismatch. */
  network: "mainnet" | "testnet";
  approvedAt: string;
  source: "imported";
}

/**
 * RISEx session signer (EVM key). Registered by the master with RegisterSigner (+ the signer's
 * VerifySigner) and then restricted ON-CHAIN to the trading permission (DisablePermission for every
 * other permission, signed by the signer and sent by the master). The private key lives only in OWS wallet `agentWalletName`
 * (SSOT Rule #3).
 */
export interface RisexAgentMeta {
  kind: "risex";
  agentName: string;
  agentWalletName: string;
  /** Signer (session key) address. */
  signerAddress: `0x${string}`;
  /** The RISEx account (master wallet address) the signer trades for. */
  accountAddress: `0x${string}`;
  /** ISO timestamp of the on-chain expiration signed in RegisterSigner. */
  expiresAt: string;
  /**
   * On-chain permission state proven after registration (Authorization.hasPermission):
   * trading-only = only the router permission enabled. Never written from a guess.
   */
  permissions: { tradingOnly: boolean; disabled: number[]; verifiedAt: string | null };
  network: "mainnet" | "testnet";
  approvedAt: string;
  source: "approved";
}

export type AnyAgentMeta = AgentMeta | OndoAgentMeta | ArcusAgentMeta | QfexAgentMeta | RisexAgentMeta;

export interface AgentsByExchange {
  aster?: Record<string, AgentMeta>;
  hyperliquid?: Record<string, AgentMeta>;  // NEW v3.4
  pacifica?: Record<string, AgentMeta>;     // NEW v3.5
  lighter?: Record<string, AgentMeta>;      // NEW v3.6
  "lighter-rh"?: Record<string, AgentMeta>;
  ondo?: Record<string, OndoAgentMeta>;
  arcus?: Record<string, ArcusAgentMeta>;
  qfex?: Record<string, QfexAgentMeta>;
  risex?: Record<string, RisexAgentMeta>;
}

export interface Settings {
  /** Default exchange when -e flag is omitted */
  defaultExchange: string;
  /** Active OWS wallet name (used when no --ows or --wallet flag) */
  owsActiveWallet: string;
  /** HL / Lighter referral code: the default for the explicit, one-time
   *  `wallet manage referral set` (never applied implicitly on adapter creation).
   *  Referral = a one-time referrer binding only — per-order builder fees live in `builder`. */
  referralCodes: {
    hyperliquid: string;
    lighter: string;
  };
  /** Which exchanges `wallet manage referral set` has applied a referral code on */
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
  /**
   * Per-venue slippage bound override (basis points) for market-type orders. Absent key = use `defaultSlippageBps`.
   * Resolved only by resolveSlippage() (src/exchanges/slippage.ts).
   */
  slippageBps: { [K in VenueId]?: number };
  /**
   * Slippage bound (bps) for every market-type order (entry, close, trigger) when
   * neither --slippage-bps nor slippageBps[venue] is set. Shipped default 50 —
   * a documented, user-visible configuration value (`perp settings show` marks it
   * "(shipped default)", `perp settings set defaultSlippageBps <n>` changes it),
   * not a hidden fallback: see docs/SSOT_RULES.md Rule #2 (shipped defaults).
   */
  defaultSlippageBps: number;
  /**
   * Per-venue builder fee (src/exchanges/builder-fee.ts). Absent venue = OFF; ships
   * empty. A fee is attached only when the venue approval is also confirmed.
   */
  builder: BuilderSettings;
  /** Bridge integrations. */
  bridge: BridgeSettings;
  /**
   * Withdraw gate: qfex (API-key withdrawals; absent = refused) and hyperliquid (withdrawals /
   * transfers to a non-owner address; absent = only the owner's own address). Ships empty. See WithdrawGate.
   */
  withdraw: WithdrawSettings;
}

/**
 * Local limits a key-authorized withdrawal must pass before anything is sent. It guards against
 * mistakes and misdirected automation; it is NOT a defence against key theft (a thief does not
 * use this CLI) — that defence is a trading key WITHOUT the withdraw permission.
 */
export interface WithdrawGate {
  /** Destination addresses (EVM, lowercase) withdrawals may go to. Changed only with an interactive confirmation. */
  allowlist: string[];
  /** Largest single withdrawal (USDC). */
  maxPerTx: number;
  /** Largest total withdrawn per UTC day (USDC), counted from this machine's withdraw log. */
  maxPerDay: number;
}

/**
 * Venues with a withdraw gate. qfex: API-key-authority withdrawals (every destination is gated).
 * hyperliquid: master-signed withdraw3 / usdSend to any address other than the account owner
 * (`funds withdraw hyperliquid --to`, `funds transfer`); the owner's own address needs no gate.
 * Follow-up: ondo.
 */
export const WITHDRAW_GATE_VENUES = ["qfex", "hyperliquid"] as const;
export type WithdrawGateVenue = typeof WITHDRAW_GATE_VENUES[number];

export type WithdrawSettings = { [K in WithdrawGateVenue]?: WithdrawGate };

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Validate one settings.withdraw.<venue> entry (also used by `perp settings set`). Never clamps. */
export function validateWithdrawGate(venue: string, raw: unknown, invalid: (problem: string) => Error): WithdrawGate {
  if (!(WITHDRAW_GATE_VENUES as readonly string[]).includes(venue)) {
    throw invalid(`withdraw: "${venue}" has no withdraw gate (venues: ${WITHDRAW_GATE_VENUES.join(", ")})`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid(`withdraw.${venue} must be { allowlist: [<0x address>…], maxPerTx: <USDC>, maxPerDay: <USDC> }`);
  }
  const g = raw as Record<string, unknown>;
  for (const k of Object.keys(g)) {
    if (k !== "allowlist" && k !== "maxPerTx" && k !== "maxPerDay") throw invalid(`withdraw.${venue}: unknown key "${k}" (expected allowlist, maxPerTx, maxPerDay)`);
  }
  if (!Array.isArray(g.allowlist) || g.allowlist.some(a => typeof a !== "string" || !EVM_ADDRESS_RE.test(a))) {
    throw invalid(`withdraw.${venue}.allowlist must be a list of 0x-prefixed 20-byte EVM addresses (got ${JSON.stringify(g.allowlist)})`);
  }
  const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (!positive(g.maxPerTx)) throw invalid(`withdraw.${venue}.maxPerTx must be a number of USDC > 0 (got ${JSON.stringify(g.maxPerTx)})`);
  if (!positive(g.maxPerDay)) throw invalid(`withdraw.${venue}.maxPerDay must be a number of USDC > 0 (got ${JSON.stringify(g.maxPerDay)})`);
  if (g.maxPerDay < g.maxPerTx) throw invalid(`withdraw.${venue}.maxPerDay (${g.maxPerDay}) is below maxPerTx (${g.maxPerTx})`);
  return { allowlist: [...new Set((g.allowlist as string[]).map(a => a.toLowerCase()))], maxPerTx: g.maxPerTx, maxPerDay: g.maxPerDay };
}

function parseWithdrawSettings(raw: unknown): WithdrawSettings {
  const out: WithdrawSettings = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalidSettings("withdraw must be an object of { venue: { allowlist, maxPerTx, maxPerDay } }");
  for (const [venue, entry] of Object.entries(raw as Record<string, unknown>)) {
    out[venue as WithdrawGateVenue] = validateWithdrawGate(venue, entry, invalidSettings);
  }
  return out;
}

/** deBridge DLN affiliate parameters — appended to quotes / create-tx only when set (ships absent). */
export interface DebridgeAffiliate {
  /** deBridge referral code (attribution only, no fee); null = not sent. */
  referralCode: string | null;
  /** Affiliate fee percent charged on the bridged amount (e.g. 0.1 = 0.1%); null = no fee. Requires feeRecipient. */
  feePercent: number | null;
  /** Address receiving the affiliate fee; null = no fee. Requires feePercent. */
  feeRecipient: string | null;
}

export interface BridgeSettings {
  /** null = no affiliate / referral parameters are sent to deBridge. */
  debridgeAffiliate: DebridgeAffiliate | null;
}

const DEFAULTS: Settings = {
  defaultExchange: "",
  owsActiveWallet: "",
  referralCodes: {
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
  slippageBps: {},
  defaultSlippageBps: 50,
  builder: {},
  bridge: { debridgeAffiliate: null },
  withdraw: {},
};

/** Shipped default slippage bound (bps); see Settings.defaultSlippageBps. */
export const SHIPPED_DEFAULT_SLIPPAGE_BPS = DEFAULTS.defaultSlippageBps;

function freshDefaults(): Settings {
  return {
    ...DEFAULTS,
    referralCodes: { ...DEFAULTS.referralCodes },
    referralApplied: { ...DEFAULTS.referralApplied },
    fees: { ...DEFAULTS.fees },
    alerts: { ...DEFAULTS.alerts, rules: [...DEFAULTS.alerts.rules] },
    slippageBps: {},
    builder: {},
    bridge: { debridgeAffiliate: null },
    withdraw: {},
  };
}

function invalidSettings(problem: string): PerpError {
  return new PerpError("INVALID_PARAMS", `Invalid ${SETTINGS_FILE}: ${problem}`, {
    remediation: `Fix the offending value in ${SETTINGS_FILE} (or move the file aside to start from defaults — it also holds agent registrations), then retry.`,
  });
}

/**
 * One-time migration (2026-10-02): `referralCodes.pacifica` used to be a builder code
 * attached to every Pacifica order (with an env / "PERPCLI" fallback). Builder fees are
 * now opt-in per venue (`builder.pacifica`), so the old key is dropped from the file and
 * never attached — the user is told once how to opt in explicitly.
 */
function migrateLegacyPacificaBuilderCode(stored: Record<string, any>): void {
  const rc = stored.referralCodes;
  if (rc === null || typeof rc !== "object" || !("pacifica" in rc)) return;
  const old = rc.pacifica;
  delete rc.pacifica;
  writeSettingsFile(stored);
  if (typeof old === "string" && old !== "") {
    process.stderr.write(
      `[notice] settings referralCodes.pacifica ("${old}") was a Pacifica builder code attached to every order. ` +
      `Builder fees are now opt-in and it is no longer attached. To keep attaching it, set it explicitly: ` +
      `perp settings set builder.pacifica ${old},<maxFeeBps>, ` +
      `then approve it: perp wallet builder approve pacifica\n`,
    );
  }
}

export function loadSettings(): Settings {
  // A missing file is not a failure: the user has not configured anything yet.
  if (!existsSync(SETTINGS_FILE)) return freshDefaults();
  let stored: any; // parsed JSON; validated field by field below
  try {
    stored = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
  } catch (e) {
    throw invalidSettings(`not valid JSON (${e instanceof Error ? e.message : String(e)})`);
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    throw invalidSettings("top level must be a JSON object");
  }
  migrateLegacyPacificaBuilderCode(stored);
  // Merge stored fees with defaults (so new exchanges get defaults)
  const fees: Record<string, ExchangeFees> = { ...DEFAULTS.fees };
  if (stored.fees !== undefined && stored.fees !== null) {
    if (typeof stored.fees !== "object" || Array.isArray(stored.fees)) throw invalidSettings("fees must be an object of { venue: { taker, maker } }");
    for (const [ex, f] of Object.entries(stored.fees)) {
      // Rule #2: a malformed entry is an error, never silently replaced by the built-in fee.
      const fee = f as Partial<ExchangeFees> | null;
      const ok = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > -1 && v < 1;
      if (fee === null || typeof fee !== "object" || Array.isArray(fee) || !ok(fee.taker) || !ok(fee.maker)) {
        throw invalidSettings(`fees.${ex} must be { taker: <fraction>, maker: <fraction> } (got ${JSON.stringify(f)})`);
      }
      fees[ex] = { taker: fee.taker, maker: fee.maker };
    }
  }
  return {
    defaultExchange: stored.defaultExchange ?? DEFAULTS.defaultExchange,
    owsActiveWallet: stored.owsActiveWallet ?? DEFAULTS.owsActiveWallet,
    referralCodes: {
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
    slippageBps: parseSlippageBps(stored.slippageBps),
    defaultSlippageBps: parseDefaultSlippageBps(stored.defaultSlippageBps),
    builder: parseBuilderSettings(stored.builder, invalidSettings),
    bridge: { debridgeAffiliate: parseDebridgeAffiliate(stored.bridge) },
    withdraw: parseWithdrawSettings(stored.withdraw),
  };
}

function parseDebridgeAffiliate(rawBridge: unknown): DebridgeAffiliate | null {
  if (rawBridge === undefined || rawBridge === null) return null;
  if (typeof rawBridge !== "object" || Array.isArray(rawBridge)) throw invalidSettings("bridge must be an object");
  for (const k of Object.keys(rawBridge)) {
    if (k !== "debridgeAffiliate") throw invalidSettings(`bridge: unknown key "${k}" (expected debridgeAffiliate)`);
  }
  const raw = (rawBridge as Record<string, unknown>).debridgeAffiliate;
  if (raw === undefined || raw === null) return null;
  return validateDebridgeAffiliate(raw, invalidSettings);
}

/** Validate bridge.debridgeAffiliate (also used by `perp settings set`). */
export function validateDebridgeAffiliate(raw: unknown, invalid: (problem: string) => Error): DebridgeAffiliate {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw invalid("bridge.debridgeAffiliate must be { referralCode, feePercent, feeRecipient } (each may be null)");
  }
  const a = raw as Record<string, unknown>;
  for (const k of Object.keys(a)) {
    if (k !== "referralCode" && k !== "feePercent" && k !== "feeRecipient") throw invalid(`bridge.debridgeAffiliate: unknown key "${k}"`);
  }
  const referralCode = a.referralCode ?? null;
  const feePercent = a.feePercent ?? null;
  const feeRecipient = a.feeRecipient ?? null;
  if (referralCode !== null && (typeof referralCode !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(referralCode))) {
    throw invalid(`bridge.debridgeAffiliate.referralCode must be 1-64 chars of A-Z a-z 0-9 _ - (got ${JSON.stringify(referralCode)})`);
  }
  if (feePercent !== null && (typeof feePercent !== "number" || !Number.isFinite(feePercent) || feePercent <= 0 || feePercent > 1)) {
    throw invalid(`bridge.debridgeAffiliate.feePercent must be a percent in (0, 1] (got ${JSON.stringify(feePercent)})`);
  }
  if (feeRecipient !== null && (typeof feeRecipient !== "string" || feeRecipient.trim() === "")) {
    throw invalid(`bridge.debridgeAffiliate.feeRecipient must be an address string (got ${JSON.stringify(feeRecipient)})`);
  }
  if ((feePercent === null) !== (feeRecipient === null)) {
    throw invalid("bridge.debridgeAffiliate: feePercent and feeRecipient must be set together");
  }
  return { referralCode: referralCode as string | null, feePercent: feePercent as number | null, feeRecipient: feeRecipient as string | null };
}

/** A slippage bound in bps: a finite number ≥ 1. Per-venue maxima are enforced by resolveSlippage(). */
export function isValidSlippageBps(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 1;
}

function parseDefaultSlippageBps(raw: unknown): number {
  if (raw === undefined) return DEFAULTS.defaultSlippageBps;
  if (!isValidSlippageBps(raw)) throw invalidSettings(`defaultSlippageBps must be a number of basis points ≥ 1 (got ${JSON.stringify(raw)})`);
  return raw;
}

function parseSlippageBps(raw: unknown): { [K in VenueId]?: number } {
  const out: { [K in VenueId]?: number } = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalidSettings("slippageBps must be an object of { venue: bps }");
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!isVenueId(k)) throw invalidSettings(`slippageBps: unknown venue "${k}"`);
    if (!isValidSlippageBps(v)) throw invalidSettings(`slippageBps.${k} must be a number of basis points ≥ 1 (got ${JSON.stringify(v)})`);
    out[k] = v;
  }
  return out;
}

export function saveSettings(settings: Settings): void {
  writeSettingsFile(settings);
}

/**
 * The one writer of settings.json: tmp file (0600) + fsync + rename over the target, so a crash
 * or full disk never leaves a truncated settings.json (which loadSettings would refuse).
 */
function writeSettingsFile(contents: unknown): void {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
  writeKeystoreAtomic(SETTINGS_FILE, JSON.stringify(contents, null, 2));
}
