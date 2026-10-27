import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import chalk from "chalk";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";
import { createRequire } from "node:module";
import { PerpError } from "./errors.js";
import type { LegacyVenueId, Network, VenueId } from "./exchanges/venue-types.js";
import { isLegacyVenueId } from "./exchanges/venue-types.js";
import type { VenueCredentials } from "./exchanges/venue.js";

const _require = createRequire(import.meta.url);


/** @deprecated alias — every venue id is an exchange id. */
export type Exchange = VenueId;

/**
 * Legacy env private-key variables. New venues have no env tier:
 * loadPrivateKey()/resolveCredentials() never read env keys for them.
 * v0.12.10 restored ASTER_PRIVATE_KEY so Aster Tier 3 env-PK loading works.
 */
const envMap: Partial<Record<LegacyVenueId, string[]>> = {
  pacifica: ["PACIFICA_PRIVATE_KEY", "pk"],
  hyperliquid: ["HYPERLIQUID_PRIVATE_KEY", "HL_PRIVATE_KEY"],
  lighter: ["LIGHTER_PRIVATE_KEY"],
  aster: ["ASTER_PRIVATE_KEY"],
};

/** CLI (and MCP) inputs that select credentials. Absent flag = null. */
export interface CliCredentialOpts {
  privateKey: string | null;
  /** --wallet <name>: OWS wallet, else local wallets.json entry */
  wallet: string | null;
  /** --ows <name> */
  ows: string | null;
  /** --ows-key <token> (or OWS_API_KEY env) */
  owsKey: string | null;
  /** --passphrase <pp> */
  passphrase: string | null;
}

export const NO_CLI_CREDENTIAL_OPTS: CliCredentialOpts = {
  privateKey: null, wallet: null, ows: null, owsKey: null, passphrase: null,
};

type MasterKey = { kind: "ows"; wallet: string } | { kind: "pk"; key: string };

/** True when the OWS vault holds a wallet with this name (no catch: a broken OWS install throws). */
export function owsWalletExists(walletName: string): boolean {
  const { listWallets } = _require("@open-wallet-standard/core") as typeof import("@open-wallet-standard/core");
  return listWallets().some((w: { name: string }) => w.name === walletName);
}

/**
 * Resolve an OWS wallet name to a signer-ready marker ("ows:<name>"), or null
 * when the vault has no such wallet.
 */
export function resolveOwsWallet(walletName: string): string | null {
  return owsWalletExists(walletName) ? `ows:${walletName}` : null;
}

/** Check if a key string represents an OWS wallet reference. */
export function isOwsKey(key: string): boolean {
  return key.startsWith("ows:");
}

/** Extract OWS wallet name from an ows: prefixed key string. */
export function getOwsWalletName(key: string): string {
  return key.slice(4);
}

function legacyKeyFile(venue: LegacyVenueId): string {
  return resolve(process.env.HOME || "~", ".perp", `${venue}.key`);
}

function envKeyOf(venue: LegacyVenueId): string | null {
  for (const envVar of envMap[venue] ?? []) {
    const v = process.env[envVar];
    if (v) return v;
  }
  // config.ts generic PRIVATE_KEY — out of scope (legacy venues only).
  const generic = process.env.PRIVATE_KEY;
  return generic ? generic : null;
}

/**
 * The master key source for a venue, in precedence order:
 *   --ows → --wallet (OWS, else local wallets.json) → --private-key →
 *   settings.owsActiveWallet → [legacy venues only] env → wallets.json active → ~/.perp/<venue>.key
 * Returns null only when no source is configured. A configured source that
 * cannot be resolved throws (SSOT Rule #2).
 */
async function resolveMasterKey(venue: VenueId, opts: CliCredentialOpts): Promise<MasterKey | null> {
  if (opts.ows !== null) return { kind: "ows", wallet: opts.ows };

  if (opts.wallet !== null) {
    if (owsWalletExists(opts.wallet)) return { kind: "ows", wallet: opts.wallet };
    const { getWalletKeyByName } = await import("./commands/wallet.js");
    const key = getWalletKeyByName(opts.wallet);
    if (!key) throw new PerpError("KEY_NOT_FOUND", `Wallet "${opts.wallet}" not found`, { remediation: "Run: perp wallet list" });
    return { kind: "pk", key };
  }

  if (opts.privateKey !== null) return { kind: "pk", key: opts.privateKey };

  const { loadSettings } = await import("./settings.js");
  const active = loadSettings().owsActiveWallet;
  if (active) {
    if (!owsWalletExists(active)) {
      throw new PerpError("KEY_NOT_FOUND", `Active OWS wallet "${active}" is not in the OWS vault`, {
        remediation: "Run: perp wallet list, then select an existing wallet (perp wallet use <name>)",
      });
    }
    return { kind: "ows", wallet: active };
  }

  if (!isLegacyVenueId(venue)) return null;

  const envKey = envKeyOf(venue);
  if (envKey !== null) return { kind: "pk", key: envKey };

  const { getActiveWalletKey } = await import("./commands/wallet.js");
  const walletKey = getActiveWalletKey(venue);
  if (walletKey) return { kind: "pk", key: walletKey };

  const keyFile = legacyKeyFile(venue);
  if (existsSync(keyFile)) return { kind: "pk", key: readFileSync(keyFile, "utf-8").trim() };

  return null;
}

/** Registered agent meta for a venue (any network), or null — presence check only. */
async function agentOf(venue: VenueId): Promise<VenueCredentials["agent"]> {
  const store = await import("./agent-wallet/store.js");
  switch (venue) {
    case "ondo": return store.getVenueAgent("ondo");
    case "arcus": return store.getVenueAgent("arcus");
    case "qfex": return store.getVenueAgent("qfex");
    case "risex": return store.getVenueAgent("risex");
    case "txflow": return store.getVenueAgent("txflow");
    // Market-data-only venues: no agent.
    case "variational": return null;
    case "grvt": return null;
    case "extended": return null;
    case "pacifica":
    case "hyperliquid":
    case "lighter":
    case "lighter-rh":
    case "aster":
      return store.getAgent(venue);
  }
}

/**
 * Agent meta to sign with on `network`. Legacy-shaped agents are selected by
 * their recorded network (a mainnet agent is never handed to a testnet adapter).
 * Ondo / Arcus metas are selected by their `network` field the same way.
 */
async function agentForNetwork(venue: VenueId, network: Network): Promise<VenueCredentials["agent"]> {
  const store = await import("./agent-wallet/store.js");
  switch (venue) {
    case "ondo": return store.getVenueAgentForNetwork("ondo", network);
    case "arcus": return store.getVenueAgentForNetwork("arcus", network);
    case "qfex": return store.getVenueAgentForNetwork("qfex", network);
    case "risex": return store.getVenueAgentForNetwork("risex", network);
    case "txflow": return store.getVenueAgentForNetwork("txflow", network);
    case "variational": return null;
    case "grvt": return null;
    case "extended": return null;
    case "pacifica":
    case "hyperliquid":
    case "lighter":
    case "lighter-rh":
    case "aster":
      return store.getAgentForNetwork(venue, network);
  }
}

/**
 * Passphrase that opens an OWS master wallet. Precedence between explicit
 * user inputs: --ows-key token (routes through the OWS policy engine) →
 * --passphrase → OWS_PASSPHRASE env. None given → "" (the OWS empty
 * passphrase; this is what the pre-venue OWS path always used).
 */
function owsPassphraseOf(opts: CliCredentialOpts): string {
  if (opts.owsKey !== null) return opts.owsKey;
  if (opts.passphrase !== null) return opts.passphrase;
  if ("OWS_PASSPHRASE" in process.env) return process.env.OWS_PASSPHRASE ?? "";
  return "";
}

function owsKeyTokenOf(opts: CliCredentialOpts): string | null {
  if (opts.owsKey !== null) return opts.owsKey;
  // OWS_API_KEY env: recorded as out of scope in (kept as before).
  const env = process.env.OWS_API_KEY;
  return env ? env : null;
}

/** CLI/MCP-shared credential resolution. */
export async function resolveCredentials(venue: VenueId, opts: CliCredentialOpts, network: Network): Promise<VenueCredentials> {
  const withToken: CliCredentialOpts = { ...opts, owsKey: owsKeyTokenOf(opts) };
  // Custodial venues (masterKeyKind "none": qfex) have no master key to resolve.
  const { ensureVenuesRegistered } = await import("./exchanges/venues/index.js");
  const { getVenue } = await import("./exchanges/venue.js");
  ensureVenuesRegistered();
  const master = getVenue(venue).masterKeyKind === "none" ? null : await resolveMasterKey(venue, withToken);
  return {
    pk: master?.kind === "pk" ? master.key : null,
    owsWallet: master?.kind === "ows" ? master.wallet : null,
    owsPassphrase: master?.kind === "ows" ? owsPassphraseOf(withToken) : null,
    owsKeyToken: withToken.owsKey,
    agent: await agentForNetwork(venue, network),
  };
}

/**
 * Whether any credential source is configured for the venue (explicit checks,
 * no catch). true does not mean the source is valid — creating the adapter
 * surfaces that error.
 */
export async function hasCredentials(venue: VenueId, opts: CliCredentialOpts): Promise<boolean> {
  // A venue without any owner-wallet signing path (qfex: custodial, API key only) is configured
  // only by an imported key — a master wallet / private key is not a credential for it.
  const { ensureVenuesRegistered } = await import("./exchanges/venues/index.js");
  const { getVenue } = await import("./exchanges/venue.js");
  ensureVenuesRegistered();
  if (getVenue(venue).masterKeyKind === "none") return (await agentOf(venue)) !== null;
  if (opts.ows !== null || opts.wallet !== null || opts.privateKey !== null) return true;
  if ((await agentOf(venue)) !== null) return true;
  const { loadSettings } = await import("./settings.js");
  if (loadSettings().owsActiveWallet) return true;
  if (!isLegacyVenueId(venue)) return false;
  if (envKeyOf(venue) !== null) return true;
  const { getActiveWalletKey } = await import("./commands/wallet.js");
  if (getActiveWalletKey(venue)) return true;
  return existsSync(legacyKeyFile(venue));
}

/**
 * Account-role venues (registry order) with a configured credential source —
 * the default set for "all exchanges" aggregate views. Market-data-only venues
 * never qualify.
 */
export async function listConfiguredAccountVenues(opts: CliCredentialOpts = NO_CLI_CREDENTIAL_OPTS): Promise<VenueId[]> {
  const { ensureVenuesRegistered } = await import("./exchanges/venues/index.js");
  const { listVenuesWithRole } = await import("./exchanges/venue.js");
  ensureVenuesRegistered();
  const venues = listVenuesWithRole("account").map(v => v.id);
  const configured = await Promise.all(venues.map(v => hasCredentials(v, opts)));
  return venues.filter((_, i) => configured[i]);
}

/**
 * Master key for a venue as a string: "ows:<name>" for OWS wallets, else the raw key.
 * Throws NO_ENV_TIER for venues without an env/PK tier when nothing else is configured,
 * and a setup hint when no source exists.
 */
export async function loadPrivateKey(exchange: VenueId, pkOverride?: string, walletName?: string): Promise<string> {
  const opts: CliCredentialOpts = {
    ...NO_CLI_CREDENTIAL_OPTS,
    privateKey: pkOverride ?? null,
    ows: walletName?.startsWith("ows:") ? walletName.slice(4) : null,
    wallet: walletName && !walletName.startsWith("ows:") ? walletName : null,
  };
  const master = await resolveMasterKey(exchange, opts);
  if (master?.kind === "ows") return `ows:${master.wallet}`;
  if (master?.kind === "pk") return master.key;
  if (!isLegacyVenueId(exchange)) {
    throw new PerpError("NO_ENV_TIER", `${exchange} has no env/private-key tier`, {
      remediation: `Use an OWS wallet (perp wallet generate, then --ows <name>) or register an agent: perp wallet agent approve ${exchange}`,
    });
  }
  throw new PerpError("NO_SIGNER_AVAILABLE",
    `No wallet configured for ${exchange}.\n\n` +
      `  Quick start:  ${chalk.cyan("perp wallet generate")}\n\n` +
      `  Or manually:\n` +
      `    perp wallet import           Import key to OWS vault (hidden prompt / stdin)\n` +
      `    perp wallet set ${exchange}     Import key (hidden prompt / stdin) to OWS vault`,
    { exchange, remediation: masterMissingRemediation(exchange) },
  );
}

/** Root-program option values → credential selectors (shared by the CLI adapter factory and master-only commands). */
export function cliCredentialOptsFrom(rootOpts: Record<string, unknown>): CliCredentialOpts {
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    privateKey: str(rootOpts.privateKey),
    wallet: str(rootOpts.wallet),
    ows: str(rootOpts.ows),
    owsKey: str(rootOpts.owsKey),
    passphrase: str(rootOpts.passphrase),
  };
}

function masterMissingRemediation(venue: VenueId): string {
  const chain = venue === "pacifica" ? "solana" : "evm";
  return `Do this on the exchange website, or add the master wallet to this computer: perp wallet import --name <name> --chain ${chain} (hidden prompt / stdin), then perp wallet use <name> (or pass --ows <name>). An imported agent / API key can trade but cannot move funds.`;
}

/**
 * Commands that only the account owner can sign (deposit, withdraw, transfer, bridge, referral
 * set, agent approve/revoke): refuse up front with NO_SIGNER_AVAILABLE when no master wallet is
 * configured on this machine — e.g. only an agent / API key imported from the exchange website.
 * Never falls back to the agent key (it cannot sign these). A configured-but-missing master
 * (active wallet not in the vault) throws KEY_NOT_FOUND from resolveMasterKey.
 */
export async function requireMasterWallet(venue: VenueId, opts: CliCredentialOpts, action: string): Promise<void> {
  const master = await resolveMasterKey(venue, { ...opts, owsKey: owsKeyTokenOf(opts) });
  if (master !== null) return;
  throw new PerpError("NO_SIGNER_AVAILABLE", `${action} needs the ${venue} master wallet, which is not on this computer`, {
    exchange: venue,
    remediation: masterMissingRemediation(venue),
  });
}

/**
 * The OWS master wallet selected by the CLI flags / active wallet, with the passphrase that opens
 * it — for on-chain transactions the master signs itself (deposits, bridges). null when the
 * master source is not an OWS wallet (none configured, or a raw private key).
 */
export async function resolveOwsMaster(venue: VenueId, opts: CliCredentialOpts): Promise<{ wallet: string; passphrase: string } | null> {
  const withToken: CliCredentialOpts = { ...opts, owsKey: owsKeyTokenOf(opts) };
  const master = await resolveMasterKey(venue, withToken);
  if (master === null || master.kind !== "ows") return null;
  return { wallet: master.wallet, passphrase: owsPassphraseOf(withToken) };
}

export function parseSolanaKeypair(input: string): Keypair {
  // Try base58 first
  try {
    const bytes = bs58.decode(input);
    return Keypair.fromSecretKey(bytes);
  } catch {
    // noop
  }

  // Try JSON array (Solana CLI format)
  try {
    const arr = JSON.parse(input);
    if (Array.isArray(arr)) {
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
  } catch {
    // noop
  }

  throw new Error("Invalid Solana private key. Expected base58 or JSON byte array.");
}

export function isEvmPrivateKey(input: string): boolean {
  return input.startsWith("0x") && input.length === 66;
}
