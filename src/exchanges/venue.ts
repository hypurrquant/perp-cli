/**
 * Venue definitions — the single source of truth for "which venue, on which
 * network, signed how, funded how, supporting what".
 *
 * One adapter class may serve several
 * venues (LighterAdapter serves `lighter` and `lighter-rh`).
 *
 * Venue definition modules must load adapter code lazily (`import()` inside
 * `create`) so that public-data paths never pull in heavy SDKs (lighter WASM).
 */

import { PerpError } from "../errors.js";
import type { ExchangeAdapter } from "./interface.js";
import type { SpotAdapter } from "./spot-interface.js";
import type {
  FundingRateBasis, LegacyVenueId, Network, TimeInForce, VenueFundingRate, VenueId, VenueMarket,
} from "./venue-types.js";
import { isVenueId } from "./venue-types.js";
import { optionsVenueWords } from "./options-venues.js";
import type { AnyAgentMeta } from "../settings.js";
import type { BuilderFeeCapability } from "./builder-fee.js";

export type {
  VenueId, LegacyVenueId, Network, FundingRateBasis, VenueMarket, VenueFundingRate,
} from "./venue-types.js";

// ── Keys ──

/** Kind of the user's master (owner) key. Replaces the overloaded legacy `chain` field. */
export type MasterKeyKind = "evm" | "solana" | "none";
/** Kind of the delegated hot-path key. */
export type AgentKeyKind = "evm" | "solana" | "lighter-l2" | "ed25519" | "hmac" | "none";

export interface SecretStorage {
  /** ows-wallet: OWS vault wallet; perp-keystore: ~/.perp/<dir>/ AES-256-GCM files (SSOT Rule #3). */
  kind: "ows-wallet" | "perp-keystore" | "none";
  /** Directory name under ~/.perp/ for perp-keystore, e.g. "lighter-rh-agents". */
  dir: string | null;
}

// ── Network ──

export interface VenueNetworkConfig {
  restUrl: string;
  wsUrl: string | null;
  explorerUrl: string | null;
  /** Chain id mixed into signatures (Lighter 304 / RH 466324 / Arcus 4663). */
  signingChainId: number | null;
  /** Where the funds live: "ethereum" | "robinhood" | "arbitrum" | "solana" | "bnb" | "hyperliquid" | "offchain". */
  settlementChain: string;
  collateral: string[];
  /** Lighter-family collateral asset index (USDC on Lighter, USDG on RH — both 3). */
  collateralAssetIndex: number | null;
  /** EVM JSON-RPC for on-chain reads/txs (Arcus spot on Robinhood Chain). null = not needed by this venue. */
  rpcUrl: string | null;
  /**
   * Pinned L1 deposit identifiers (chain id, deposit contract, collateral token) verified
   * against official docs. A deposit refuses (EXCHANGE_ERROR) when the venue API disagrees.
   * null = the CLI has no pinned contract deposit for this venue/network.
   */
  depositPins: VenueDepositPins | null;
}

export interface VenueDepositPins {
  chainId: number;
  contract: string;
  token: string;
  /** Where the pinned values were verified (for audits / re-verification). */
  sources: readonly string[];
}

// ── Capabilities ──

export type MarketOrderMode = "native" | "slippageBounded" | "rfq";
export type TpSlMode = "attached" | "separateOrders" | "batchGroup" | "positionLevel";

export interface VenueCapabilities {
  marketOrder: MarketOrderMode;
  timeInForce: readonly TimeInForce[];
  /**
   * Time-in-force values a reduce-only LIMIT order may carry; null = any offered TIF.
   * Ondo: ["IOC"] — a resting reduce-only order is refused by the venue.
   */
  reduceOnlyTif: readonly TimeInForce[] | null;
  clientOrderId: boolean;
  orderAck: "sync" | "async";
  tpsl: TpSlMode | null;
  amend: "native" | "cancelReplace" | null;
  batchPlaceMax: number | null;
  marginModes: ReadonlyArray<"cross" | "isolated">;
  withdrawAssets: string[] | null;
}

// ── Spot ──

export type SpotAccountModel =
  | "unified"   // spot shares the perp account/margin (Pacifica)
  | "separate"  // separate spot balance + explicit spot↔perp transfer (Aster, Ondo)
  | "runtime"   // decided per user at runtime via the perp adapter's isUnifiedAccount (Hyperliquid abstraction mode, Lighter account_trading_mode)
  | "wallet";   // on-chain wallet balances, no exchange account (Arcus router)

/** Per-process spot adapter options (CLI flags). */
export interface SpotCreateOptions {
  /** Allow on-chain approve txs (Arcus Permit2 approve; CLI --yes). */
  confirmOnchainApprove: boolean;
}

export interface VenueSpotDefinition {
  accountModel: SpotAccountModel;
  /**
   * Quote assets per network; [0] is the default quote for a bare base symbol and the transfer
   * asset. Network-keyed because a venue's collateral can differ by network (Lighter RH: USDG on
   * mainnet, USDC on testnet — networks.<net>.collateral). Read through spotQuoteAssets(def, net).
   */
  quoteAssets: Readonly<Record<Network, readonly string[]>>;
  capabilities: { limitOrder: boolean; orderbook: boolean; cancel: boolean; transfer: boolean };
  /** Creates and init()s the spot adapter around an already-created perp adapter (lazy import). */
  createSpot(perp: ExchangeAdapter, opts: SpotCreateOptions): Promise<SpotAdapter>;
}

// ── Rate limit ──

export interface RateLimitPolicy {
  /** Bucket capacity (weight units). */
  capacity: number;
  /** Refill rate (weight units per second). */
  refillPerSec: number;
  /** Per-endpoint weights; endpoints not listed cost 1. null = uniform weight 1. */
  weights: Record<string, number> | null;
}

// ── Public data ──

export interface VenuePublicData {
  fetchFundingRates(net: Network): Promise<VenueFundingRate[]>;
  fetchMarkets(net: Network): Promise<VenueMarket[]>;
}

// ── Creation ──

export interface VenueCredentials {
  /** Raw private key from --private-key or (legacy venues only) env. */
  pk: string | null;
  owsWallet: string | null;
  owsPassphrase: string | null;
  owsKeyToken: string | null;
  agent: AnyAgentMeta | null;
}

export interface VenueCreateContext {
  network: Network;
  credentials: VenueCredentials;
  noAgent: boolean;
  /** Hyperliquid HIP-3 dex; null for all other venues. */
  hlDex: string | null;
  /** true → public reads only; credentials are ignored. */
  readOnly: boolean;
  /** --no-builder: never attach a configured builder fee on this adapter's orders. */
  noBuilder: boolean;
}

export const READ_ONLY_CREDENTIALS: VenueCredentials = {
  pk: null, owsWallet: null, owsPassphrase: null, owsKeyToken: null, agent: null,
};

export type VenueRole = "marketData" | "account" | "trading";

export type SymbolIdentity = "baseTicker" | "explicit";

/**
 * How perp-cli reaches the venue. "official" = a documented public API. "unofficial" = an
 * undocumented API (e.g. the one the venue's own web app uses) that may change or be blocked
 * without notice; every user-facing surface (JSON `venueApi` / `apiStatus`, human footnotes,
 * MCP output, the landing screen, the skill docs) labels data read through it.
 */
export type VenueApiStatus =
  | { kind: "official" }
  | { kind: "unofficial"; note: string; docs: string | null };

export const OFFICIAL_API: VenueApiStatus = { kind: "official" };

/** "official" | "unofficial" — the per-row label for mixed-venue tables and JSON. */
export function apiStatusOf(venue: VenueId): VenueApiStatus["kind"] {
  return getVenue(venue).apiStatus.kind;
}

/** Human footnote for an unofficial-API venue; null for an official one. */
export function unofficialApiNote(def: VenueDefinition): string | null {
  return def.apiStatus.kind === "unofficial"
    ? `${def.displayName}: UNOFFICIAL API — ${def.apiStatus.note}`
    : null;
}

export interface VenueDefinition {
  id: VenueId;
  aliases: readonly string[];
  displayName: string;
  family: "pacifica" | "hyperliquid" | "lighter" | "aster" | "ondo" | "arcus" | "qfex" | "risex" | "txflow" | "variational" | "grvt" | "extended";
  masterKeyKind: MasterKeyKind;
  agentKeyKind: AgentKeyKind;
  secretStorage: SecretStorage;
  networks: { mainnet: VenueNetworkConfig; testnet: VenueNetworkConfig | null };
  fundingRateBasis: FundingRateBasis | "perMarket";
  settlementIntervalHours: number | "perMarket";
  /**
   * false = the unit / meaning of the venue's published funding rate is not verified against
   * settled funding payments yet. Such a venue is left out of cross-venue
   * funding comparison (fetchVenuesRates drops it unless includeUnverified is passed), its
   * adapter reports fundingRate null to bots, and funding-arb strategies refuse it as a leg.
   */
  fundingVerified: boolean;
  roles: readonly VenueRole[];
  /**
   * Roles that are implemented but switched off in this release (phased venue rollout, e.g.
   * RISEx trading in 0.15.0). They are NOT in `roles`; roleUnsupported() uses `reason` /
   * `remediation` for them. null = nothing held back.
   */
  gatedRoles: { roles: readonly VenueRole[]; reason: string; remediation: string } | null;
  /** null when the venue has no trading role. */
  capabilities: VenueCapabilities | null;
  rateLimit: RateLimitPolicy;
  /** ISO-3166 alpha-2 codes; shown as a warning, never enforced. */
  restrictedRegions: readonly string[];
  /** How cross-venue canonical symbols are derived for crypto markets (equity is always explicit). */
  symbolIdentity: SymbolIdentity;
  publicData: VenuePublicData;
  /** null when the venue cannot produce an adapter (public data only). */
  create: ((ctx: VenueCreateContext) => Promise<ExchangeAdapter>) | null;
  /** null = venue has no spot trading. */
  spot: VenueSpotDefinition | null;
  /**
   * Largest slippage bound (bps) a market-type order may carry on this venue. resolveSlippage() rejects anything above it with
   * INVALID_PARAMS before sending — never clamps.
   */
  maxSlippageBps: number;
  /**
   * Builder-fee support (src/exchanges/builder-fee.ts BUILDER_FEE_CAPABILITIES — the single
   * source); null = unsupported (CAPABILITY_UNSUPPORTED). Attached only when the user set
   * settings.builder.<venue> and the approval is confirmed.
   */
  builderFee: BuilderFeeCapability | null;
  /** Official documented API, or an unofficial one that is labelled everywhere (VenueApiStatus). */
  apiStatus: VenueApiStatus;
  /**
   * Remediation of every role refusal (roleUnsupported) on a venue that is read-only in this
   * version (Variational, GRVT, Extended). Absent = the generic market-data-only remediation.
   */
  readOnlyRemediation?: string;
}

// ── Registry ──

const _venues = new Map<VenueId, VenueDefinition>();
const _aliases = new Map<string, VenueId>();

export function registerVenue(def: VenueDefinition): void {
  if (_venues.has(def.id)) throw new Error(`venue already registered: ${def.id}`);
  _venues.set(def.id, def);
  _aliases.set(def.id, def.id);
  for (const a of def.aliases) {
    const prev = _aliases.get(a);
    if (prev && prev !== def.id) throw new Error(`venue alias "${a}" already used by ${prev}`);
    _aliases.set(a, def.id);
  }
}

function unknownVenue(input: string): PerpError {
  // An options venue (e.g. derive) is not a perp venue: say where it works instead.
  const optionsOnly = optionsVenueWords().includes(input.toLowerCase())
    ? ` — ${input} is options-only: perp -e ${input} options …`
    : "";
  return new PerpError("UNKNOWN_VENUE", `Unknown venue: "${input}"`, {
    remediation: `Use one of: ${[..._venues.keys()].join(", ")}${optionsOnly}`,
  });
}

/** Resolve a venue id or alias. Throws UNKNOWN_VENUE. */
export function resolveVenueId(nameOrAlias: string): VenueId {
  const id = _aliases.get(nameOrAlias.toLowerCase());
  if (!id) throw unknownVenue(nameOrAlias);
  return id;
}

export function tryResolveVenueId(nameOrAlias: string): VenueId | null {
  return _aliases.get(nameOrAlias.toLowerCase()) ?? null;
}

export function getVenue(nameOrAlias: string): VenueDefinition {
  const id = resolveVenueId(nameOrAlias);
  const def = _venues.get(id);
  if (!def) throw unknownVenue(nameOrAlias);
  return def;
}

export function listVenues(): VenueDefinition[] {
  return [..._venues.values()];
}

export function listVenuesWithRole(role: VenueRole): VenueDefinition[] {
  return listVenues().filter(v => v.roles.includes(role));
}

export function networkConfig(def: VenueDefinition, net: Network): VenueNetworkConfig {
  const cfg = def.networks[net];
  if (!cfg) {
    throw new PerpError("NOT_IMPLEMENTED", `${def.displayName} has no ${net} environment`, {
      remediation: `Run without --testnet for ${def.id}`,
    });
  }
  return cfg;
}

/**
 * The uniform refusal for any account / trading / funds / agent / builder / bot action on a venue
 * whose roles do not include `role` (a market-data-only venue such as TxFlow). Raised before any
 * credential is resolved or any request is sent.
 */
export function roleUnsupported(def: VenueDefinition, feature: string, role: VenueRole = "trading"): PerpError {
  if (def.gatedRoles !== null && def.gatedRoles.roles.includes(role)) {
    const { reason, remediation } = def.gatedRoles;
    return new PerpError("CAPABILITY_UNSUPPORTED", `${def.id} does not support ${feature} — ${reason}`, {
      venue: def.id, feature, reason, remediation,
    });
  }
  const reason = def.apiStatus.kind === "unofficial"
    ? `${def.displayName} is integrated through an unofficial read-only API (market data only)`
    : `${def.displayName} is available for market data only (no ${role} role)`;
  // Precedence: gatedRoles (above: a role switched off this release, e.g. RISEx) → the venue's own
  // readOnlyRemediation (official read-only venues, e.g. Variational) → the generic text (TxFlow).
  const remediation = def.readOnlyRemediation !== undefined
    ? def.readOnlyRemediation
    : def.apiStatus.kind === "unofficial"
    ? `Trade on the ${def.displayName} website; perp-cli shows ${def.displayName} market data only (perp -e ${def.id} market list|info|funding|book|trades|kline)`
    : `Use the market-data commands for ${def.id} (perp -e ${def.id} market list|funding)`;
  return new PerpError("CAPABILITY_UNSUPPORTED", `${def.id} does not support ${feature} — ${reason}`, {
    venue: def.id, feature, reason, remediation,
  });
}

/** Throws roleUnsupported() unless the venue has `role`. */
export function requireRole(def: VenueDefinition, role: VenueRole, feature: string): void {
  if (!def.roles.includes(role)) throw roleUnsupported(def, feature, role);
}

export function requireCapabilities(def: VenueDefinition): VenueCapabilities {
  // A venue without the trading role is a definite capability refusal, not "not implemented yet".
  if (!def.roles.includes("trading")) throw roleUnsupported(def, "trading");
  if (!def.capabilities) {
    throw new PerpError("NOT_IMPLEMENTED", `${def.displayName} does not support trading via API`, {
      remediation: `${def.id} is available for market data only (funding/market commands)`,
    });
  }
  return def.capabilities;
}

/**
 * A venue reference as it appears in stored data and funding keys:
 * a venue id/alias, or "hl:<dex>" / "hyperliquid:<dex>" for HIP-3 dexes.
 */
export interface VenueRef {
  venue: VenueId;
  hlDex: string | null;
}

export function parseVenueRef(ref: string): VenueRef {
  const lower = ref.toLowerCase();
  const colon = lower.indexOf(":");
  if (colon > 0) {
    const head = lower.slice(0, colon);
    const dex = lower.slice(colon + 1);
    const venue = resolveVenueId(head);
    if (venue !== "hyperliquid" || dex.length === 0) throw unknownVenue(ref);
    return { venue, hlDex: dex };
  }
  return { venue: resolveVenueId(lower), hlDex: null };
}

/**
 * Funding basis for a venue ref. HIP-3 dexes use the Hyperliquid core basis
 * (current behavior preserved; verify against live data).
 * Throws for venues whose basis is per-market; callers must use the market's value.
 */
export function fundingBasisOf(ref: string): FundingRateBasis {
  const { venue } = parseVenueRef(ref);
  const def = getVenue(venue);
  if (def.fundingRateBasis === "perMarket") {
    throw new PerpError("INVALID_PARAMS", `${def.displayName} funding basis is per-market`, {
      remediation: "Use the market's fundingRateBasis (VenueMarket.fundingRateBasis)",
    });
  }
  return def.fundingRateBasis;
}

export function settlementIntervalOf(ref: string): number {
  const { venue } = parseVenueRef(ref);
  const def = getVenue(venue);
  if (def.settlementIntervalHours === "perMarket") {
    throw new PerpError("INVALID_PARAMS", `${def.displayName} settlement interval is per-market`, {
      remediation: "Use the market's settlementIntervalHours (VenueMarket.settlementIntervalHours)",
    });
  }
  return def.settlementIntervalHours;
}

/**
 * Refuse a venue whose funding rate is unverified (VenueDefinition.fundingVerified false) as a
 * leg of a funding strategy (arb scan ranking, arb exec / auto, funding bots). Uniform
 * CAPABILITY_UNSUPPORTED. Unknown venue refs throw UNKNOWN_VENUE.
 */
export function assertFundingArbVenue(ref: string): void {
  const def = getVenue(parseVenueRef(ref).venue);
  if (def.fundingVerified) return;
  const reason = "its funding rate is unverified (the unit and which published rate settles are not confirmed against funding payments, and annualizing it overstates venues whose funding accrues only part of the week)";
  throw new PerpError("CAPABILITY_UNSUPPORTED", `${def.id} does not support fundingArb — ${reason}`, {
    venue: def.id, feature: "fundingArb", reason,
    remediation: `Use venues with verified funding (${listVenues().filter(v => v.fundingVerified && v.roles.includes("trading")).map(v => v.id).join(", ")}). ${def.displayName} rates can still be viewed: perp arb scan --rates --include-unverified`,
  });
}

export function isLegacyVenue(def: VenueDefinition): def is VenueDefinition & { id: LegacyVenueId } {
  return def.id === "pacifica" || def.id === "hyperliquid" || def.id === "lighter" || def.id === "aster";
}

export { isVenueId };
