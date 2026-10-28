/**
 * `perp wallet agent import <venue>` — register an agent wallet / API key that was CREATED ON THE
 * EXCHANGE WEBSITE, so the master wallet does not have to be on this computer. The master is
 * identified only by its public address.
 *
 * Every venue verifies the key against the venue BEFORE anything is stored, where the venue
 * offers a way to (a mismatch / unknown key is refused). A venue without a read-only check is
 * imported as explicitly "unverified" — never reported as verified.
 *
 *   venue        secret (hidden prompt / stdin)       public inputs                 live check
 *   hyperliquid  API wallet private key (EVM)          [--master-address]           info userRole(agent) = agent of master; extraAgents → validUntil
 *   aster        API wallet (signer) private key (EVM) --master-address (user)      signed GET /fapi/v3/balance (user=master, signer=agent)
 *   pacifica     agent wallet private key (Solana)     --master-address (account)   none (bindings are listed only via master-signed /agent/list) → unverified
 *   lighter(-rh) API key private key (hex)             --account-index --api-key-index  account exists; slot holds a key; auth token signed by the key accepted by GET /accountActiveOrders
 *   arcus        API key private key (Ed25519)         --master-address [--account-index]  derived public key listed ACTIVE by GET /v1/apiKeys?address=<owner>
 *   ondo         API key id + secret                   —                            authenticated GET /v1/account (same as approve)
 *   qfex         API public key + secret               [--account-id <uuid>]        signed reads as the resolved account + Trade WebSocket auth; the account UUID is shown and must be confirmed
 *   txflow       agent (API wallet) private key (EVM)  [--master-address]           info agentOwner(agent) = an account (= --master-address when given); approvedAgents → its label
 *
 * Storage (SSOT Rule #3): EVM / Solana / Ed25519 keys → OWS vault wallet
 * `agent-<venue>-import-<agentName>` (empty passphrase, like approved agent wallets); Lighter-family
 * keys → network-tagged lighter keystore; Ondo → ~/.perp/ondo-agents/; QFEX → ~/.perp/qfex-agents/. Never argv, never .env,
 * never printed (errors are passed through redactSecrets).
 */
import chalk from "chalk";
import { PerpError, classifyError } from "../errors.js";
import type { AgentMeta, ArcusAgentMeta, OndoAgentMeta, QfexAgentMeta, TxflowAgentMeta } from "../settings.js";
import {
  acquireLock, releaseLock, getAgent, setAgent, deleteAgent, listAgents, agentNetworkOf, agentSourceOf,
  getVenueAgent, setVenueAgent, deleteVenueAgent,
} from "../agent-wallet/store.js";
import { getVenue, networkConfig, roleUnsupported } from "../exchanges/venue.js";
import { unsupported } from "../exchanges/trading-v2.js";
import type { Network, VenueId } from "../exchanges/venue-types.js";
import { LIGHTER_RH_RESERVED_KEY_INDEXES, type LighterVenueId } from "../exchanges/venues/lighter-family.js";
import { loadOws } from "../signer/ows-loader.js";
import { defaultAgentName, isLighterFamilyVenue, parseExpiresIn, promptHidden, qfexWithdrawKeyWarning } from "./agent.js";
import { importOwsWallet, normalizeSolanaKey } from "./wallet.js";

/** Shown wherever an import is offered: what the imported key can and cannot do. */
export const IMPORT_SCOPE_NOTE =
  "Trading works with the imported key. Deposits, withdrawals, transfers, referral and agent approvals need the master wallet — do them on the exchange website, or add the master with `perp wallet import`.";

/**
 * Printed on every import: an imported key is held in a local file protected only by file
 * permissions (empty passphrase), and what it may do (withdraw, transfer) is decided on the
 * exchange website when the key is created.
 */
export const IMPORT_KEY_WARNING =
  "The imported key is stored with an empty passphrase — it is protected by file permissions only. Its permissions (trade / withdraw) are set on the exchange website: create API keys WITHOUT withdraw permission.";

export type ImportSecret =
  | { kind: "key"; key: string }
  | { kind: "ondo"; keyId: string; secret: string }
  | { kind: "qfex"; publicKey: string; secret: string };

/** The account a QFEX key was resolved to at import, shown for confirmation before anything is stored. */
export interface ImportAccountBinding { accountId: string; isPrimaryAccount: boolean; method: string }

export interface ImportAgentParams {
  venue: VenueId;
  network: Network;
  /** null → defaultImportAgentName(venue, network). */
  agentName: string | null;
  /** Master / owner public address. Required for aster, pacifica, arcus; optional (cross-checked) for hyperliquid. */
  masterAddress: string | null;
  /** Lighter-family account index (required) / Arcus subaccount (optional, cross-checked). */
  accountIndex: number | null;
  /** Lighter-family API key slot (required). */
  apiKeyIndex: number | null;
  /** Expiry shown on the website, recorded when the venue does not report it (30d / 1y / ISO). null = unknown. */
  expiresIn: string | null;
  /** Replace an existing IMPORTED record of the same name (its local key is deleted first). */
  replace: boolean;
  secret: ImportSecret;
  /** QFEX: the account UUID the key should trade (--account-id); null = the user's primary account. Other venues: null. */
  accountId: string | null;
  /**
   * QFEX: confirms the RESOLVED account before anything is stored (interactive y/N, or — without
   * a terminal — only an explicit --account-id that equals it). Other venues never call it.
   */
  confirmAccount: ((binding: ImportAccountBinding) => Promise<boolean>) | null;
}

export interface ImportVerification {
  status: "verified" | "unverified";
  /** How the key was checked (or why it could not be). */
  method: string;
}

export interface ImportAgentOutcome {
  venue: VenueId;
  network: Network;
  agentName: string;
  source: "imported";
  masterAddress: string;
  agentAddress: string | null;
  publicKey: string | null;
  accountIndex: number | null;
  apiKeyIndex: number | null;
  /** QFEX: the account UUID the key is bound to; null for every other venue. */
  accountId: string | null;
  /** ISO expiry, or null when neither the venue nor --expires-in gave one. */
  expiresAt: string | null;
  /** Where the secret now lives (OWS wallet name / keystore path) — never the secret. */
  storage: string;
  verification: ImportVerification;
  /** Shown with every import (IMPORT_KEY_WARNING). */
  warnings: string[];
}

/** Default record name for an imported key (distinct from the approve default `perp-cli-*`). */
export function defaultImportAgentName(venue: VenueId, network: Network): string {
  return defaultAgentName(venue, network).replace(/^perp-cli-/, "web-");
}

/** OWS wallet holding an imported EVM / Solana / Ed25519 agent key. */
export function importedAgentWalletName(venue: "hyperliquid" | "aster" | "pacifica" | "arcus" | "txflow", agentName: string): string {
  const prefix = venue === "hyperliquid" ? "hl" : venue === "pacifica" ? "pac" : venue;
  return `agent-${prefix}-import-${agentName}`;
}

// ── Secret input (hidden prompt / stdin only) ────────────────────────────────

function readPipedStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c: string | Buffer) => chunks.push(typeof c === "string" ? c : c.toString("utf-8")));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

/** Prompt label for the venue's secret. */
export function importSecretLabel(venue: VenueId): string {
  switch (venue) {
    case "hyperliquid": return "Hyperliquid API wallet private key";
    case "aster": return "Aster API wallet (signer) private key";
    case "pacifica": return "Pacifica agent wallet private key";
    case "lighter": return "Lighter API key private key";
    case "lighter-rh": return "Lighter RH API key private key";
    case "arcus": return "Arcus API key private key (Ed25519)";
    case "ondo": return "Ondo API secret";
    case "qfex": return "QFEX API secret";
    case "risex": return "RISEx signer private key";
    case "txflow": return "TxFlow agent (API wallet) private key";
    case "variational": return "Variational key (not supported)";
    case "grvt": return "GRVT key (not supported)";
    case "extended": return "Extended key (not supported)";
  }
}

/**
 * Number of stdin lines the venue's secret takes (ondo: key id + secret; qfex: public key + secret; others: the key).
 * Used by `perp setup --non-interactive --import-agents` to split stdin.
 */
export function importSecretLineCount(venue: VenueId): number {
  return venue === "ondo" || venue === "qfex" ? 2 : 1;
}

/** Turn the venue's stdin lines into an ImportSecret. */
export function importSecretFromLines(venue: VenueId, lines: string[]): ImportSecret {
  if (venue === "ondo") return { kind: "ondo", keyId: lines[0], secret: lines[1] };
  if (venue === "qfex") return { kind: "qfex", publicKey: lines[0], secret: lines[1] };
  return { kind: "key", key: lines[0] };
}

/** Read the secret: hidden TTY prompt, else piped stdin (ondo: 2 lines key id + secret; others: 1 line). */
export async function readImportSecret(venue: VenueId): Promise<ImportSecret> {
  if (process.stdin.isTTY === true) {
    if (venue === "ondo") {
      const keyId = (await promptHidden("Ondo API key id (hidden): ")).trim();
      const secret = (await promptHidden("Ondo API secret (hidden): ")).trim();
      return { kind: "ondo", keyId, secret };
    }
    if (venue === "qfex") {
      const publicKey = (await promptHidden("QFEX API public key (hidden): ")).trim();
      const secret = (await promptHidden("QFEX API secret (hidden): ")).trim();
      return { kind: "qfex", publicKey, secret };
    }
    return { kind: "key", key: (await promptHidden(`${importSecretLabel(venue)} (hidden): `)).trim() };
  }
  const lines = (await readPipedStdin()).split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const want = importSecretLineCount(venue);
  if (lines.length !== want) {
    throw new PerpError("INVALID_PARAMS", `Expected ${want} line${want === 1 ? "" : "s"} on stdin (${venue === "ondo" ? "key id, then secret" : venue === "qfex" ? "public key, then secret" : importSecretLabel(venue)}); got ${lines.length}`, {
      remediation: venue === "ondo"
        ? "printf '%s\\n%s\\n' \"$KEY_ID\" \"$SECRET\" | perp wallet agent import ondo"
        : venue === "qfex"
          ? "printf '%s\\n%s\\n' \"$PUBLIC_KEY\" \"$SECRET\" | perp wallet agent import qfex --account-id <uuid>"
          : `pbpaste | perp wallet agent import ${venue} ... (or run in a terminal for a hidden prompt)`,
    });
  }
  return importSecretFromLines(venue, lines);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function secretsOf(s: ImportSecret): string[] {
  // A QFEX public key is not a secret (it is in the WebSocket URL), but an empty one is still refused.
  return s.kind === "key" ? [s.key] : s.kind === "ondo" ? [s.keyId, s.secret] : [s.publicKey, s.secret];
}

/** Every textual form a secret may take in an error: as given, without 0x, lower case, and the normalized Ed25519 seed. */
function secretForms(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const raw of secrets) {
    const t = raw.trim();
    if (t.length === 0) continue;
    for (const v of [t, t.replace(/^0x/i, "")]) { out.add(v); out.add(v.toLowerCase()); }
    try { out.add(normalizeSolanaKey(t)); } catch { /* not an Ed25519 key form */ }
  }
  return [...out].filter(v => v.length >= 8);
}

/**
 * Strip key material from text (Rule #3): every form of the given secrets, plus any hex run of
 * private-key length (≥ 64). Public addresses (40 hex / base58) stay readable.
 */
function scrub(text: string, forms: readonly string[]): string {
  let out = text;
  for (const f of forms) out = out.split(f).join("[redacted]");
  return out.replace(/(0x)?[0-9a-fA-F]{64,}/g, "[redacted]");
}

/** Re-throw any error with key material stripped from message and remediation. */
function redacted(err: unknown, secrets: readonly string[], venue: VenueId): PerpError {
  const e = classifyError(err, venue);
  const forms = secretForms(secrets);
  const details: Record<string, unknown> = { ...(e.details ?? {}), exchange: venue };
  if (e.remediation !== undefined) details.remediation = scrub(e.remediation, forms);
  return new PerpError(e.code, scrub(e.message, forms), details);
}

/**
 * Venues whose keys cannot be imported. RISEx: perp-cli trades only with a signer it registered itself and then restricted ON-CHAIN to
 * the trading permission; a signer created in the RISEx app keeps every permission (including
 * deposit / withdraw), so it is never stored here.
 */
export function assertImportSupported(venue: VenueId, network: Network): void {
  const def = getVenue(venue);
  if (!def.roles.includes("trading")) throw roleUnsupported(def, "agentImport");
  if (venue === "risex") {
    throw unsupported("risex", "agentImport",
      "perp-cli only uses RISEx signers it registered and restricted on-chain to trading-only permissions; an app-created signer keeps deposit / withdraw permissions",
      `Register a restricted signer with your master wallet: perp${network === "testnet" ? " -n testnet" : ""} wallet agent approve risex --master <ows-wallet>`);
  }
}

/** Venues whose import cannot be checked against the venue (stored as "unverified"). */
export const UNVERIFIED_IMPORT_VENUES: readonly VenueId[] = ["pacifica"];

/**
 * M3: a batch import (perp setup --import-agents) must not carry the same key for two venues
 * (a mis-ordered paste). Compares every textual form (0x / case / Ed25519 seed). The error
 * names venues only — never the key.
 */
export function assertDistinctImportSecrets(entries: ReadonlyArray<readonly [VenueId, ImportSecret]>): void {
  const seen = new Map<string, VenueId>();
  for (const [venue, secret] of entries) {
    for (const f of new Set(secretForms(secretsOf(secret)))) {
      const other = seen.get(f);
      if (other !== undefined && other !== venue) {
        throw new PerpError("INVALID_PARAMS", `The same key was given for ${other} and ${venue} — nothing was imported`, {
          remediation: "Each venue needs its own key created on that venue's website; pipe one key line per --import-agents venue, in order",
        });
      }
      seen.set(f, venue);
    }
  }
}

function venueHint(venue: VenueId, network: Network): string {
  const n = network === "testnet" ? "-n testnet " : "";
  return `Create the key on the ${getVenue(venue).displayName} ${network} website, then: perp ${n}wallet agent import ${venue}`;
}

/** H1: the master (account owner) key is never stored as an agent / API key. */
function masterKeyRefused(venue: VenueId, network: Network): PerpError {
  return new PerpError("INVALID_PARAMS", `${getVenue(venue).displayName}: that is the master key — create an API wallet on the website`, {
    remediation: `${venueHint(venue, network)}. The master key is never stored as an agent; to use the master on this computer: perp wallet import`,
  });
}

async function evmFromKey(key: string, label: string): Promise<{ address: `0x${string}`; wallet: import("ethers").Wallet }> {
  const { ethers } = await import("ethers");
  const hex = key.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new PerpError("INVALID_PARAMS", `${label} must be 32 bytes of hex (64 characters, optional 0x) — input not shown`);
  }
  const wallet = new ethers.Wallet(`0x${hex}`);
  return { address: wallet.address as `0x${string}`, wallet };
}

async function requireEvmAddress(addr: string | null, what: string, venue: VenueId): Promise<`0x${string}`> {
  if (addr === null) {
    throw new PerpError("INVALID_PARAMS", `${getVenue(venue).displayName} import needs the master (${what}) address`, {
      remediation: `Pass --master-address 0x… (the wallet you log in with on the ${getVenue(venue).displayName} website)`,
    });
  }
  const { ethers } = await import("ethers");
  if (!ethers.isAddress(addr)) throw new PerpError("INVALID_PARAMS", `--master-address "${addr}" is not an EVM address`);
  return ethers.getAddress(addr) as `0x${string}`;
}

async function ed25519FromKey(key: string, label: string): Promise<{ seedHex: string; publicKey: Uint8Array }> {
  let seedHex: string;
  try {
    seedHex = normalizeSolanaKey(key);
  } catch {
    throw new PerpError("INVALID_PARAMS", `${label} must be base58, hex, or a JSON byte array (32-byte seed or 64-byte keypair) — input not shown`);
  }
  const { Keypair } = await import("@solana/web3.js");
  const kp = Keypair.fromSeed(Uint8Array.from(Buffer.from(seedHex, "hex")));
  return { seedHex, publicKey: kp.publicKey.toBytes() };
}

function owsWalletNames(): Set<string> {
  return new Set(loadOws().listWallets().map((w: { name: string }) => w.name));
}

function resolveExpiry(fromVenue: string | null, expiresIn: string | null): string | null {
  if (fromVenue !== null) return fromVenue;
  if (expiresIn === null) return null;
  try {
    return parseExpiresIn(expiresIn).toISOString();
  } catch (e) {
    throw new PerpError("INVALID_PARAMS", e instanceof Error ? e.message : String(e), { remediation: "Use: 30d, 90d, 180d, 1y, or ISO-8601 datetime" });
  }
}

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Name checks shared by every venue. Returns the record being replaced (an imported record of the
 * same venue / network / name, only with `replace`), or null.
 */
function checkName(venue: VenueId, network: Network, agentName: string, replace: boolean): AgentMeta | OndoAgentMeta | ArcusAgentMeta | QfexAgentMeta | TxflowAgentMeta | null {
  if (!NAME_RE.test(agentName)) {
    throw new PerpError("INVALID_PARAMS", `Agent name "${agentName}" must be 1-64 letters, digits, '.', '_' or '-'`);
  }
  const existing = venue === "ondo" || venue === "arcus" || venue === "qfex" || venue === "txflow" ? getVenueAgent(venue, agentName) : getAgent(venue, agentName);
  if (existing === null) return null;
  const existingNetwork = "kind" in existing ? existing.network : agentNetworkOf(venue, existing);
  if (existingNetwork !== network) {
    throw new PerpError("INVALID_PARAMS", `${venue} agent "${agentName}" is already registered on ${existingNetwork}`, {
      remediation: `Choose another --agent-name for the ${network} key (default: ${defaultImportAgentName(venue, network)})`,
    });
  }
  if (!replace) {
    throw new PerpError("INVALID_PARAMS", `${venue} agent "${agentName}" already exists on ${network}`, {
      remediation: "Pass --replace to replace this imported key, or choose another --agent-name",
    });
  }
  if (agentSourceOf(venue, existing) !== "imported") {
    throw new PerpError("INVALID_PARAMS", `${venue} agent "${agentName}" was approved by this CLI — --replace only replaces imported keys`, {
      remediation: `Revoke it first (perp wallet agent revoke ${venue} ${agentName}) or choose another --agent-name`,
    });
  }
  return existing;
}

/** Delete the local key + record of an imported agent (the key stays authorized on the venue). */
export async function deleteImportedAgentLocal(venue: VenueId, network: Network, meta: AgentMeta | OndoAgentMeta | ArcusAgentMeta | QfexAgentMeta | TxflowAgentMeta): Promise<{ keyRemoved: boolean }> {
  let keyRemoved = false;
  if ("kind" in meta) {
    if (meta.kind === "ondo") {
      const { revokeOndoAgentLocal } = await import("../exchanges/ondo/agent.js");
      keyRemoved = revokeOndoAgentLocal(meta.keyId);
      deleteVenueAgent("ondo", meta.agentName);
    } else if (meta.kind === "qfex") {
      const { revokeQfexAgentLocal } = await import("../exchanges/qfex/agent.js");
      keyRemoved = revokeQfexAgentLocal(meta.publicKey);
      deleteVenueAgent("qfex", meta.agentName);
    } else if (meta.kind === "txflow") {
      keyRemoved = deleteOwsWalletIfPresent(meta.agentWalletName);
      deleteVenueAgent("txflow", meta.agentName);
    } else {
      keyRemoved = deleteOwsWalletIfPresent(meta.agentWalletName);
      deleteVenueAgent("arcus", meta.agentName);
    }
    return { keyRemoved };
  }
  if (isLighterFamilyVenue(venue)) {
    if (typeof meta.accountIndex === "number" && typeof meta.apiKeyIndex === "number") {
      const { deleteLighterFamilyKey } = await import("../agent-wallet/lighter-keystore.js");
      keyRemoved = deleteLighterFamilyKey(venue, network, meta.accountIndex, meta.apiKeyIndex);
    }
  } else {
    keyRemoved = deleteOwsWalletIfPresent(meta.agentWalletName);
  }
  deleteAgent(venue, meta.agentName);
  return { keyRemoved };
}

function deleteOwsWalletIfPresent(name: string): boolean {
  if (!name || !owsWalletNames().has(name)) return false;
  loadOws().deleteWallet(name);
  return true;
}

/**
 * OWS wallet name for a new imported key. While the record being replaced (--replace) still holds
 * the standard name, the new key is staged under a fresh name, so the old key + record stay intact
 * until the new key is verified and stored (commitOwsImport swaps them).
 */
function stagedImportWalletName(venue: "hyperliquid" | "aster" | "pacifica" | "arcus" | "txflow", agentName: string, replacing: { agentWalletName: string } | null): string {
  const std = importedAgentWalletName(venue, agentName);
  return replacing !== null && replacing.agentWalletName === std ? `${std}-${Date.now().toString(36)}` : std;
}

/**
 * Swap in a verified + stored key: write the record, then delete the replaced record's key. If the
 * record write fails, the new key is removed and the old record + key are untouched.
 */
function commitOwsImport(walletName: string, writeRecord: () => void, replacedWallet: string | null): void {
  try {
    writeRecord();
  } catch (e) {
    deleteOwsWalletIfPresent(walletName);
    throw e;
  }
  if (replacedWallet !== null && replacedWallet !== walletName) deleteOwsWalletIfPresent(replacedWallet);
}

/** Store an EVM / Solana / Ed25519 agent key in the OWS vault (empty passphrase, like approved agent wallets). */
async function storeOwsAgentKey(walletName: string, key: string, chain: "evm" | "solana"): Promise<{ evm: string | null; solana: string | null }> {
  if (owsWalletNames().has(walletName)) {
    throw new PerpError("INVALID_PARAMS", `OWS wallet "${walletName}" already exists (no agent record uses it)`, {
      remediation: `Remove it (perp wallet remove ${walletName}) or choose another --agent-name`,
    });
  }
  const w = await importOwsWallet(walletName, "", { kind: "single", key, chain });
  const evm = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("eip155:"));
  const sol = w.accounts.find((a: { chainId: string }) => a.chainId.startsWith("solana:"));
  return { evm: evm ? evm.address : null, solana: sol ? sol.address : null };
}

function baseMeta(agentName: string, network: Network, expiresAt: string | null): Omit<AgentMeta, "agentWalletName" | "agentEvmAddress" | "userEvmAddress"> {
  return {
    agentName,
    masterWalletName: "",
    owsApiKeyId: "",
    owsPolicyId: "",
    // "" = expiry unknown (the venue does not report it and no --expires-in was given); list shows "unknown".
    expiresAt: expiresAt ?? "",
    approvedAt: new Date().toISOString(),
    // Set on the website; not readable for every venue — perp trading is what the CLI uses it for.
    // canWithdraw null = unknown (never assumed false or true).
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: null },
    asterApprovalNonce: "",
    status: "active",
    network,
    source: "imported",
  };
}

async function postJson(url: string, body: unknown, what: string): Promise<unknown> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new PerpError("EXCHANGE_ERROR", `${what} failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new PerpError("EXCHANGE_ERROR", `${what} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

// ── Per-venue imports ────────────────────────────────────────────────────────

async function importHyperliquid(p: ImportAgentParams, agentName: string, key: string, replacing: AgentMeta | null): Promise<ImportAgentOutcome> {
  const { address: agentAddress } = await evmFromKey(key, "Hyperliquid API wallet private key");
  if (p.masterAddress !== null && p.masterAddress.toLowerCase() === agentAddress.toLowerCase()) throw masterKeyRefused("hyperliquid", p.network);
  const infoUrl = `${networkConfig(getVenue("hyperliquid"), p.network).restUrl}/info`;
  // Official info endpoint: userRole of an API wallet = { role: "agent", data: { user: <master> } }.
  const role = await postJson(infoUrl, { type: "userRole", user: agentAddress.toLowerCase() }, "Hyperliquid userRole") as { role?: unknown; data?: { user?: unknown } };
  // userRole "user" = the address is an account itself (its key is a master key, not an API wallet).
  if (role?.role === "user") throw masterKeyRefused("hyperliquid", p.network);
  if (role?.role !== "agent" || typeof role.data?.user !== "string") {
    throw new PerpError("AGENT_NOT_REGISTERED", `${agentAddress} is not an authorized API wallet on Hyperliquid ${p.network} (userRole: ${String(role?.role)})`, {
      remediation: `${venueHint("hyperliquid", p.network)} — and authorize it there (More → API). A mainnet key is not valid on testnet and vice versa.`,
    });
  }
  const { ethers } = await import("ethers");
  const master = ethers.getAddress(role.data.user) as `0x${string}`;
  if (master.toLowerCase() === agentAddress.toLowerCase()) throw masterKeyRefused("hyperliquid", p.network);
  if (p.masterAddress !== null && p.masterAddress.toLowerCase() !== master.toLowerCase()) {
    throw new PerpError("AGENT_NOT_REGISTERED", `API wallet ${agentAddress} is authorized for ${master}, not ${p.masterAddress}`, {
      remediation: "Pass the master address the key was created for, or omit --master-address",
    });
  }
  const extra = await postJson(infoUrl, { type: "extraAgents", user: master.toLowerCase() }, "Hyperliquid extraAgents");
  const entry = Array.isArray(extra)
    ? (extra as Array<{ address?: unknown; validUntil?: unknown }>).find(a => typeof a.address === "string" && a.address.toLowerCase() === agentAddress.toLowerCase())
    : undefined;
  const validUntil = entry !== undefined && typeof entry.validUntil === "number" ? entry.validUntil : null;
  if (validUntil !== null && validUntil < Date.now()) {
    throw new PerpError("AGENT_EXPIRED", `Hyperliquid API wallet ${agentAddress} expired at ${new Date(validUntil).toISOString()}`, { remediation: venueHint("hyperliquid", p.network) });
  }
  const expiresAt = resolveExpiry(validUntil !== null ? new Date(validUntil).toISOString() : null, p.expiresIn);

  const walletName = stagedImportWalletName("hyperliquid", agentName, replacing);
  const stored = await storeOwsAgentKey(walletName, key, "evm");
  if (stored.evm === null || stored.evm.toLowerCase() !== agentAddress.toLowerCase()) {
    deleteOwsWalletIfPresent(walletName);
    throw new PerpError("SIGNATURE_FAILED", `OWS stored a different address (${stored.evm}) than the key's ${agentAddress}; nothing was saved`);
  }
  commitOwsImport(walletName,
    () => setAgent("hyperliquid", { ...baseMeta(agentName, p.network, expiresAt), agentWalletName: walletName, agentEvmAddress: agentAddress, userEvmAddress: master }),
    replacing?.agentWalletName ?? null);
  return {
    venue: "hyperliquid", network: p.network, agentName, source: "imported", masterAddress: master, agentAddress, publicKey: null,
    accountIndex: null, apiKeyIndex: null, accountId: null, expiresAt, storage: `OWS wallet ${walletName}`,
    verification: { status: "verified", method: `Hyperliquid info userRole: ${agentAddress} is an agent of ${master}${validUntil !== null ? "; extraAgents validUntil" : ""}` },
    warnings: [IMPORT_KEY_WARNING],
  };
}

async function importTxflow(p: ImportAgentParams, agentName: string, key: string, replacing: TxflowAgentMeta | null): Promise<ImportAgentOutcome> {
  const { address: agentAddress } = await evmFromKey(key, "TxFlow agent private key");
  if (p.masterAddress !== null && p.masterAddress.toLowerCase() === agentAddress.toLowerCase()) throw masterKeyRefused("txflow", p.network);
  const { txflowAgentOwner, txflowApprovedAgents, txflowClient } = await import("../exchanges/txflow/agent.js");
  const client = txflowClient(p.network);
  // Official info endpoint: agentOwner(agent) = the account it is authorized for; null = none.
  const owner = await txflowAgentOwner(client, agentAddress);
  if (owner === null) {
    throw new PerpError("AGENT_NOT_REGISTERED", `${agentAddress} is not an authorized agent of any TxFlow ${p.network} account (agentOwner: null)`, {
      remediation: `${venueHint("txflow", p.network)} — approve it there first. A mainnet key is not valid on testnet and vice versa. (Pasted the master key? Never import it: use perp wallet import.)`,
    });
  }
  if (owner.toLowerCase() === agentAddress.toLowerCase()) throw masterKeyRefused("txflow", p.network);
  const master = p.masterAddress !== null ? await requireEvmAddress(p.masterAddress, "account", "txflow") : owner as `0x${string}`;
  if (master.toLowerCase() !== owner.toLowerCase()) {
    throw new PerpError("AGENT_NOT_REGISTERED", `TxFlow agent ${agentAddress} is authorized for ${owner}, not ${master}`, {
      remediation: "Pass the master address the key was approved for, or omit --master-address",
    });
  }
  const label = (await txflowApprovedAgents(client, owner)).find(a => a.agentAddress.toLowerCase() === agentAddress.toLowerCase())?.agentName ?? null;
  const walletName = stagedImportWalletName("txflow", agentName, replacing);
  const stored = await storeOwsAgentKey(walletName, key, "evm");
  if (stored.evm === null || stored.evm.toLowerCase() !== agentAddress.toLowerCase()) {
    deleteOwsWalletIfPresent(walletName);
    throw new PerpError("SIGNATURE_FAILED", `OWS stored a different address (${stored.evm}) than the key's ${agentAddress}; nothing was saved`);
  }
  commitOwsImport(walletName, () => setVenueAgent("txflow", {
    kind: "txflow", agentName, agentWalletName: walletName, agentAddress, accountAddress: owner as `0x${string}`,
    network: p.network, approvedAt: new Date().toISOString(), source: "imported",
  }), replacing?.agentWalletName ?? null);
  return {
    venue: "txflow", network: p.network, agentName, source: "imported", masterAddress: owner, agentAddress, publicKey: null,
    accountIndex: null, apiKeyIndex: null, accountId: null, expiresAt: null, storage: `OWS wallet ${walletName}`,
    verification: { status: "verified", method: `TxFlow info agentOwner: ${agentAddress} is an agent of ${owner}${label !== null ? ` (label "${label}")` : ""}` },
    warnings: [IMPORT_KEY_WARNING],
  };
}

async function importAster(p: ImportAgentParams, agentName: string, key: string, replacing: AgentMeta | null): Promise<ImportAgentOutcome> {
  const { address: agentAddress, wallet } = await evmFromKey(key, "Aster API wallet private key");
  const master = await requireEvmAddress(p.masterAddress, "user", "aster");
  if (master.toLowerCase() === agentAddress.toLowerCase()) throw masterKeyRefused("aster", p.network);
  const expiresAt = resolveExpiry(null, p.expiresIn);
  const meta: AgentMeta = { ...baseMeta(agentName, p.network, expiresAt), agentWalletName: "", agentEvmAddress: agentAddress, userEvmAddress: master };

  // Live check: a read-only USER_DATA request signed by the agent for user = master. Aster
  // verifies that the signer is an API wallet of that user — an unbound key is refused.
  const { AsterAdapter } = await import("../exchanges/aster.js");
  const adapter = new AsterAdapter(undefined, p.network === "testnet");
  adapter.setAgent(meta, {
    getAddress: () => agentAddress,
    async signTypedData(domain, types, message) {
      const signature = await wallet.signTypedData(domain, types, message);
      const sig = signature.slice(2);
      return { signature, r: `0x${sig.slice(0, 64)}`, s: `0x${sig.slice(64, 128)}`, v: parseInt(sig.slice(128, 130), 16) };
    },
  });
  try {
    await adapter.signedRequest(networkConfig(getVenue("aster"), p.network).restUrl, "GET", "/fapi/v3/balance", {});
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PerpError("AGENT_NOT_REGISTERED", `Aster ${p.network} refused a read signed by API wallet ${agentAddress} for user ${master}: ${msg}`, {
      remediation: `${venueHint("aster", p.network)} (Pro API → API wallet) and pass the address you log in with as --master-address. Aster may also require a completed deposit before authenticated requests.`,
    });
  }

  const walletName = stagedImportWalletName("aster", agentName, replacing);
  const stored = await storeOwsAgentKey(walletName, key, "evm");
  if (stored.evm === null || stored.evm.toLowerCase() !== agentAddress.toLowerCase()) {
    deleteOwsWalletIfPresent(walletName);
    throw new PerpError("SIGNATURE_FAILED", `OWS stored a different address (${stored.evm}) than the key's ${agentAddress}; nothing was saved`);
  }
  commitOwsImport(walletName, () => setAgent("aster", { ...meta, agentWalletName: walletName }), replacing?.agentWalletName ?? null);
  return {
    venue: "aster", network: p.network, agentName, source: "imported", masterAddress: master, agentAddress, publicKey: null,
    accountIndex: null, apiKeyIndex: null, accountId: null, expiresAt, storage: `OWS wallet ${walletName}`,
    verification: { status: "verified", method: `signed GET /fapi/v3/balance accepted (user ${master}, signer ${agentAddress})` },
    warnings: [IMPORT_KEY_WARNING],
  };
}

async function importPacifica(p: ImportAgentParams, agentName: string, key: string, replacing: AgentMeta | null): Promise<ImportAgentOutcome> {
  const { publicKey } = await ed25519FromKey(key, "Pacifica agent wallet private key");
  const bs58 = (await import("bs58")).default;
  const agentAddress = bs58.encode(publicKey);
  if (p.masterAddress === null) {
    throw new PerpError("INVALID_PARAMS", "Pacifica import needs the master (account) address", {
      remediation: "Pass --master-address <Solana address you log in with on Pacifica>",
    });
  }
  let masterBytes: Uint8Array;
  try {
    masterBytes = bs58.decode(p.masterAddress);
  } catch {
    masterBytes = new Uint8Array();
  }
  if (masterBytes.length !== 32) throw new PerpError("INVALID_PARAMS", `--master-address "${p.masterAddress}" is not a Solana address`);
  if (p.masterAddress === agentAddress) throw masterKeyRefused("pacifica", p.network);
  const expiresAt = resolveExpiry(null, p.expiresIn);

  const walletName = stagedImportWalletName("pacifica", agentName, replacing);
  const stored = await storeOwsAgentKey(walletName, key, "solana");
  if (stored.solana !== agentAddress) {
    deleteOwsWalletIfPresent(walletName);
    throw new PerpError("SIGNATURE_FAILED", `OWS stored a different address (${stored.solana}) than the key's ${agentAddress}; nothing was saved`);
  }
  const masterAddress = p.masterAddress;
  commitOwsImport(walletName, () => setAgent("pacifica", {
    ...baseMeta(agentName, p.network, expiresAt),
    agentWalletName: walletName,
    agentEvmAddress: "0x0000000000000000000000000000000000000000",
    userEvmAddress: "0x0000000000000000000000000000000000000000",
    agentSolanaAddress: agentAddress,
    userSolanaAddress: masterAddress,
  }), replacing?.agentWalletName ?? null);
  return {
    venue: "pacifica", network: p.network, agentName, source: "imported", masterAddress: p.masterAddress, agentAddress, publicKey: null,
    accountIndex: null, apiKeyIndex: null, accountId: null, expiresAt, storage: `OWS wallet ${walletName}`,
    verification: {
      status: "unverified",
      method: "Pacifica lists agent bindings only through a master-signed request (POST /agent/list), and has no read-only agent-signed call — the binding is NOT checked. The first order fails if the key is not bound to this account.",
    },
    warnings: [IMPORT_KEY_WARNING],
  };
}

async function importLighter(p: ImportAgentParams, venue: LighterVenueId, agentName: string, key: string, replacing: AgentMeta | null): Promise<ImportAgentOutcome> {
  const name = getVenue(venue).displayName;
  const hex = key.trim().replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{80}$/.test(hex)) {
    throw new PerpError("INVALID_PARAMS", `${name} API key private key must be 40 bytes of hex (80 characters, optional 0x) — input not shown`);
  }
  const accountIndex = p.accountIndex;
  const slot = p.apiKeyIndex;
  if (accountIndex === null || !Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new PerpError("INVALID_PARAMS", `${name} import needs --account-index <n> (shown with the API key on the website)`);
  }
  if (slot === null || !Number.isInteger(slot) || slot < 0 || slot > 254) {
    throw new PerpError("INVALID_PARAMS", `${name} import needs --api-key-index <0-254> (the key's slot, shown on the website)`);
  }
  if (venue === "lighter-rh" && LIGHTER_RH_RESERVED_KEY_INDEXES.includes(slot)) {
    throw new PerpError("INVALID_PARAMS", `${name} API key index ${slot} is reserved (${LIGHTER_RH_RESERVED_KEY_INDEXES.join(", ")})`);
  }
  // Keystore files are per network+account+slot; never share a slot with another local record.
  for (const { meta } of listAgents(venue)) {
    if (meta.accountIndex === accountIndex && meta.apiKeyIndex === slot && meta.agentName !== replacing?.agentName) {
      throw new PerpError("INVALID_PARAMS", `${name} slot ${slot} of account ${accountIndex} is already held by local ${agentNetworkOf(venue, meta)} agent "${meta.agentName}"`, {
        remediation: `Remove that record first (perp${agentNetworkOf(venue, meta) === "testnet" ? " -n testnet" : ""} wallet agent revoke ${venue} ${meta.agentName} --local-only) or import another slot`,
      });
    }
  }

  // 1) the account exists on this network → owner L1 address
  const restUrl = networkConfig(getVenue(venue), p.network).restUrl;
  const res = await fetch(`${restUrl}/api/v1/account?by=index&value=${accountIndex}`);
  const text = await res.text();
  let acct: { accounts?: Array<{ account_index?: unknown; index?: unknown; l1_address?: unknown }> } | null = null;
  try { acct = JSON.parse(text); } catch { /* handled below */ }
  const row = res.ok && acct !== null && Array.isArray(acct.accounts) ? acct.accounts[0] : undefined;
  if (row === undefined || typeof row.l1_address !== "string") {
    throw new PerpError("AGENT_NOT_REGISTERED", `${name} ${p.network} has no account ${accountIndex} (HTTP ${res.status}: ${text.slice(0, 160)})`, {
      remediation: `${venueHint(venue, p.network)} --account-index <your account index>`,
    });
  }
  const { ethers } = await import("ethers");
  const owner = ethers.getAddress(row.l1_address) as `0x${string}`;
  if (p.masterAddress !== null && p.masterAddress.toLowerCase() !== owner.toLowerCase()) {
    throw new PerpError("AGENT_NOT_REGISTERED", `${name} account ${accountIndex} belongs to ${owner}, not ${p.masterAddress}`);
  }

  // 2) the slot holds a key, and 3) the key signs an auth token the venue accepts for that slot.
  const expiresAt = resolveExpiry(null, p.expiresIn);
  const meta: AgentMeta = {
    ...baseMeta(agentName, p.network, expiresAt), agentWalletName: "", agentEvmAddress: owner, userEvmAddress: owner,
    accountIndex, apiKeyIndex: slot,
  };
  const { LighterAdapter } = await import("../exchanges/lighter.js");
  const adapter = LighterAdapter.forVenue(venue, "", p.network === "testnet");
  adapter.setAgentSigner(meta, hex);
  adapter.setAddress(owner);
  await adapter.init();
  const keys = await adapter.listApiKeys();
  const onSlot = keys.find(k => k.apiKeyIndex === slot);
  if (onSlot === undefined || /^(0x)?0*$/.test(onSlot.publicKey.trim())) {
    throw new PerpError("AGENT_NOT_REGISTERED", `${name} account ${accountIndex} has no API key in slot ${slot} on ${p.network}`, {
      remediation: `${venueHint(venue, p.network)} --account-index ${accountIndex} --api-key-index <the key's slot>`,
    });
  }
  try {
    await adapter.assertAgentKeyAccepted();
  } catch (e) {
    throw new PerpError("AGENT_NOT_REGISTERED", `${name} did not accept the key for account ${accountIndex} slot ${slot}: ${e instanceof Error ? e.message : String(e)}`, {
      remediation: "Check that --api-key-index is the slot the website shows for this key (a key that does not match the slot's public key is refused)",
    });
  }
  const publicKey = onSlot.publicKey.replace(/^0x/i, "");

  // Swap: the new key is stored (atomic write — the same slot is overwritten in place, as the venue
  // slot now holds this key), then the record, then the replaced record's key if it was another slot.
  const { saveLighterFamilyKey, deleteLighterFamilyKey } = await import("../agent-wallet/lighter-keystore.js");
  const path = saveLighterFamilyKey(venue, p.network, accountIndex, slot, hex, "");
  const old = replacing !== null && typeof replacing.accountIndex === "number" && typeof replacing.apiKeyIndex === "number"
    ? { account: replacing.accountIndex, slot: replacing.apiKeyIndex } : null;
  const sameFile = old !== null && old.account === accountIndex && old.slot === slot;
  try {
    setAgent(venue, { ...meta, publicKey });
  } catch (e) {
    if (!sameFile) deleteLighterFamilyKey(venue, p.network, accountIndex, slot);
    throw e;
  }
  if (old !== null && !sameFile) deleteLighterFamilyKey(venue, p.network, old.account, old.slot);
  return {
    venue, network: p.network, agentName, source: "imported", masterAddress: owner, agentAddress: null, publicKey,
    accountIndex, apiKeyIndex: slot, accountId: null, expiresAt, storage: path,
    verification: { status: "verified", method: `account ${accountIndex} exists (owner ${owner}); slot ${slot} holds a key; an auth token signed by the imported key was accepted by GET /api/v1/accountActiveOrders` },
    warnings: [IMPORT_KEY_WARNING],
  };
}

async function importArcus(p: ImportAgentParams, agentName: string, key: string, replacing: ArcusAgentMeta | null): Promise<ImportAgentOutcome> {
  const { seedHex, publicKey } = await ed25519FromKey(key, "Arcus API key private key");
  const apiKeyHex = Buffer.from(publicKey).toString("hex");
  const owner = (await requireEvmAddress(p.masterAddress, "owner", "arcus")).toLowerCase() as `0x${string}`;
  // The same 32 bytes pasted as the "API key" would be the owner's EVM private key itself.
  const { ethers } = await import("ethers");
  let asEvm: string | null = null;
  try { asEvm = new ethers.Wallet(`0x${seedHex}`).address.toLowerCase(); } catch { /* not a secp256k1 scalar → cannot be the owner's EVM key */ }
  if (asEvm === owner) throw masterKeyRefused("arcus", p.network);
  const { listArcusApiKeys } = await import("../exchanges/arcus/agent.js");
  const keys = await listArcusApiKeys(p.network, owner);
  const hit = keys.find(k => k.apiKey.toLowerCase() === apiKeyHex);
  if (hit === undefined || hit.status !== "ACTIVE") {
    throw new PerpError("AGENT_NOT_REGISTERED", `Arcus ${p.network} lists no ACTIVE API key ${apiKeyHex} for ${owner}${hit !== undefined ? ` (status ${hit.status})` : ""}`, {
      remediation: `${venueHint("arcus", p.network)} --master-address <owner address>`,
    });
  }
  const venueIndex = hit.allSubaccounts === true ? 255 : typeof hit.accountIndex === "number" ? hit.accountIndex : null;
  if (venueIndex === null) throw new PerpError("EXCHANGE_ERROR", `Arcus /v1/apiKeys entry for ${apiKeyHex} has no accountIndex`);
  if (p.accountIndex !== null && p.accountIndex !== venueIndex) {
    throw new PerpError("INVALID_PARAMS", `Arcus key ${apiKeyHex} is scoped to account index ${venueIndex}, not ${p.accountIndex}`);
  }
  const validUntil = typeof hit.validUntil === "number" && hit.validUntil > 0 ? new Date(hit.validUntil).toISOString() : null;
  const expiresAt = resolveExpiry(validUntil, p.expiresIn);

  const walletName = stagedImportWalletName("arcus", agentName, replacing);
  const stored = await storeOwsAgentKey(walletName, key, "solana");
  const bs58 = (await import("bs58")).default;
  if (stored.solana === null || Buffer.from(bs58.decode(stored.solana)).toString("hex") !== apiKeyHex) {
    deleteOwsWalletIfPresent(walletName);
    throw new PerpError("SIGNATURE_FAILED", "OWS stored a different Ed25519 key than the one verified; nothing was saved");
  }
  const meta: ArcusAgentMeta = {
    kind: "arcus", agentName, agentWalletName: walletName, apiKeyHex, accountIndex: venueIndex, ownerAddress: owner,
    validUntil: expiresAt ?? "", network: p.network, approvedAt: new Date().toISOString(), source: "imported",
  };
  commitOwsImport(walletName, () => setVenueAgent("arcus", meta), replacing?.agentWalletName ?? null);
  return {
    venue: "arcus", network: p.network, agentName, source: "imported", masterAddress: owner, agentAddress: null, publicKey: apiKeyHex,
    accountIndex: venueIndex, apiKeyIndex: null, accountId: null, expiresAt, storage: `OWS wallet ${walletName}`,
    verification: { status: "verified", method: `GET /v1/apiKeys?address=${owner} lists the key's public key as ACTIVE` },
    warnings: [IMPORT_KEY_WARNING],
  };
}

async function importOndo(p: ImportAgentParams, agentName: string, s: { keyId: string; secret: string }, replacing: OndoAgentMeta | null): Promise<ImportAgentOutcome> {
  const { approveOndoAgent } = await import("../exchanges/ondo/agent.js");
  // approveOndoAgent authenticates GET /v1/account with the key before it writes the keystore
  // (keyed by key id). The replaced key's keystore is removed only after the new record is written.
  const meta = await approveOndoAgent({ agentName, keyId: s.keyId, secret: s.secret, network: p.network });
  const replacedKeyId = replacing !== null && replacing.keyId !== meta.keyId ? replacing.keyId : null;
  const { revokeOndoAgentLocal } = await import("../exchanges/ondo/agent.js");
  try {
    setVenueAgent("ondo", { ...meta, source: "imported" });
  } catch (e) {
    if (replacing === null || replacedKeyId !== null) revokeOndoAgentLocal(meta.keyId);
    throw e;
  }
  if (replacedKeyId !== null) revokeOndoAgentLocal(replacedKeyId);
  return {
    venue: "ondo", network: p.network, agentName, source: "imported", masterAddress: "", agentAddress: null, publicKey: null,
    accountIndex: null, apiKeyIndex: null, accountId: null, expiresAt: null, storage: meta.keystorePath,
    verification: { status: "verified", method: "authenticated GET /v1/account succeeded with the key (account open, perps / API keys enabled); key scopes are not readable with the key itself" },
    warnings: [IMPORT_KEY_WARNING],
  };
}

/** A probed QFEX read permission: null = it could not be told (a never-funded account has no balance record to read). */
export function qfexPermissionText(p: boolean | null): string {
  return p === true ? "ok" : p === false ? "denied" : "unknown (account not funded yet)";
}

async function importQfex(p: ImportAgentParams, agentName: string, s: { publicKey: string; secret: string }, replacing: QfexAgentMeta | null): Promise<ImportAgentOutcome> {
  const confirm = p.confirmAccount;
  if (confirm === null) {
    throw new PerpError("INVALID_PARAMS", "QFEX import needs the account binding to be confirmed", {
      remediation: "Run in a terminal (y/N prompt), or pass the account explicitly: perp wallet agent import qfex --account-id <uuid>",
    });
  }
  const { importQfexAgent, revokeQfexAgentLocal } = await import("../exchanges/qfex/agent.js");
  const { QFEX_ENDPOINTS } = await import("../exchanges/venues/qfex.js");
  // importQfexAgent verifies with reads + a Trade WebSocket auth, resolves the concrete account
  // UUID, has it confirmed, and only then writes the keystore (keyed by public key). The replaced
  // key's keystore is removed only after the new record is written.
  const { meta, binding } = await importQfexAgent({
    agentName, publicKey: s.publicKey, secret: s.secret, network: p.network, accountId: p.accountId,
    endpoints: QFEX_ENDPOINTS[p.network], rateLimit: getVenue("qfex").rateLimit, confirmAccount: confirm,
  });
  const replacedKey = replacing !== null && replacing.publicKey !== meta.publicKey ? replacing.publicKey : null;
  try {
    setVenueAgent("qfex", meta);
  } catch (e) {
    if (replacing === null || replacedKey !== null) revokeQfexAgentLocal(meta.publicKey);
    throw e;
  }
  if (replacedKey !== null) revokeQfexAgentLocal(replacedKey);
  const perms = meta.permissions;
  return {
    venue: "qfex", network: p.network, agentName, source: "imported", masterAddress: "", agentAddress: null, publicKey: meta.publicKey,
    accountIndex: null, apiKeyIndex: null, accountId: meta.accountId, expiresAt: null, storage: meta.keystorePath,
    verification: {
      status: "verified",
      method: `account ${meta.accountId} (${meta.isPrimaryAccount ? "primary" : "subaccount"}) — ${binding.method}; signed reads as that account: positions/balance ${qfexPermissionText(perms.viewPositions)}, orders ${qfexPermissionText(perms.viewOrders)}; Trade WebSocket authentication accepted. Execute / withdraw permissions cannot be checked without acting`,
    },
    warnings: [
      IMPORT_KEY_WARNING,
      "QFEX withdrawals are authorized by the API key alone: keep a trading key WITHOUT the \"Deposit and withdraw\" permission, and import a separate key for funding if you need it.",
      ...((w => (w === null ? [] : [w]))(qfexWithdrawKeyWarning(meta))),
    ],
  };
}

/**
 * Import one website-created agent / API key. Verifies (where the venue allows) before storing;
 * a refused verification stores nothing. Holds the venue's agent lock. Key material never
 * appears in a thrown error.
 */
export async function importVenueAgent(p: ImportAgentParams): Promise<ImportAgentOutcome> {
  // Refused before the secret is even inspected (nothing read, stored or sent).
  assertImportSupported(p.venue, p.network);
  const secrets = secretsOf(p.secret);
  if (secrets.some(x => x.trim().length === 0)) throw new PerpError("INVALID_PARAMS", "Empty key — nothing was imported");
  const agentName = p.agentName ?? defaultImportAgentName(p.venue, p.network);
  networkConfig(getVenue(p.venue), p.network); // NOT_IMPLEMENTED when the venue has no such network
  acquireLock(p.venue);
  try {
    const replacing = checkName(p.venue, p.network, agentName, p.replace);
    if (p.venue === "ondo") {
      if (p.secret.kind !== "ondo") throw new PerpError("INVALID_PARAMS", "Ondo import needs the API key id and secret");
      return await importOndo(p, agentName, p.secret, replacing as OndoAgentMeta | null);
    }
    if (p.venue === "qfex") {
      if (p.secret.kind !== "qfex") throw new PerpError("INVALID_PARAMS", "QFEX import needs the API public key and secret");
      return await importQfex(p, agentName, p.secret, replacing as QfexAgentMeta | null);
    }
    if (p.secret.kind !== "key") throw new PerpError("INVALID_PARAMS", `${p.venue} import needs one private key`);
    const key = p.secret.key;
    switch (p.venue) {
      case "hyperliquid": return await importHyperliquid(p, agentName, key, replacing as AgentMeta | null);
      case "aster": return await importAster(p, agentName, key, replacing as AgentMeta | null);
      case "pacifica": return await importPacifica(p, agentName, key, replacing as AgentMeta | null);
      case "arcus": return await importArcus(p, agentName, key, replacing as ArcusAgentMeta | null);
      case "lighter":
      case "lighter-rh":
        return await importLighter(p, p.venue, agentName, key, replacing as AgentMeta | null);
      case "txflow": return await importTxflow(p, agentName, key, replacing as TxflowAgentMeta | null);
      case "risex":
      case "variational":
      case "grvt":
      case "extended":
        // Unreachable: assertImportSupported() refused these before the lock.
        throw new PerpError("CAPABILITY_UNSUPPORTED", `${p.venue} keys cannot be imported`);
    }
  } catch (err) {
    throw redacted(err, secrets, p.venue);
  } finally {
    releaseLock(p.venue);
  }
}

/** Human summary of an import (public data only). */
export function printImportOutcome(o: ImportAgentOutcome): void {
  const def = getVenue(o.venue);
  console.log(chalk.green.bold(`\n  ${def.displayName} key imported (${o.network})\n`));
  console.log(`  Name:          ${chalk.cyan(o.agentName)}`);
  if (o.masterAddress) console.log(`  Master:        ${chalk.cyan(o.masterAddress)} ${chalk.gray("(public address only — not on this computer)")}`);
  if (o.agentAddress !== null) console.log(`  Agent address: ${chalk.cyan(o.agentAddress)}`);
  if (o.publicKey !== null) console.log(`  Public key:    ${chalk.cyan(o.publicKey)}`);
  if (o.accountIndex !== null) console.log(`  Account index: ${chalk.cyan(String(o.accountIndex))}`);
  if (o.apiKeyIndex !== null) console.log(`  API key slot:  ${chalk.cyan(String(o.apiKeyIndex))}`);
  if (o.accountId !== null) console.log(`  Account id:    ${chalk.cyan(o.accountId)}`);
  console.log(`  Expires:       ${o.expiresAt !== null ? chalk.cyan(o.expiresAt) : chalk.gray("unknown (set on the website)")}`);
  console.log(`  Stored in:     ${chalk.gray(o.storage)}`);
  if (o.verification.status === "verified") console.log(`  Verified:      ${chalk.green("yes")} ${chalk.gray(`— ${o.verification.method}`)}`);
  else console.log(`  Verified:      ${chalk.yellow("NO")} ${chalk.yellow(`— ${o.verification.method}`)}`);
  for (const w of o.warnings) {
    // The withdraw-capable QFEX key warning is printed loudly (red); the rest as plain warnings.
    if (o.venue === "qfex" && w.includes("\"Deposit and withdraw\" permission and is stored with an EMPTY passphrase")) console.log(chalk.red.bold(`\n  [WARNING] ${w}`));
    else console.log(chalk.yellow(`\n  [warn] ${w}`));
  }
  console.log(chalk.gray(`\n  ${IMPORT_SCOPE_NOTE}\n`));
}
