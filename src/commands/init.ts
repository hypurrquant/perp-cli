import { Command } from "commander";
import { networkOf, parseNetwork } from "../cli-flags.js";
import chalk from "chalk";
import { createInterface } from "node:readline/promises";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { writeKeystoreAtomic } from "../agent-wallet/venue-keystore.js";
import { resolve } from "path";
import { loadSettings, saveSettings, SHIPPED_DEFAULT_SLIPPAGE_BPS, type Settings } from "../settings.js";
import { PerpError, classifyError, type StructuredError } from "../errors.js";
import { jsonOk, jsonError, printJson } from "../utils.js";
import { resolvePassphrase } from "../agent-wallet/passphrase.js";
import { loadOws } from "../signer/ows-loader.js";
import { getVenue, listVenuesWithRole, networkConfig, roleUnsupported, tryResolveVenueId, type VenueDefinition } from "../exchanges/venue.js";
import "../exchanges/venues/index.js";
import { VARIATIONAL_READ_ONLY_REMEDIATION } from "../exchanges/venues/variational.js";
import type { Network, VenueId } from "../exchanges/venue-types.js";
import { maxDefaultSlippageBps, parseSlippageSettingBps } from "../exchanges/slippage.js";
import {
  agentApproveUnsupportedReason, approveVenueAgent, assertLighterSlot, isLighterFamilyVenue,
  deprecatedPassphraseOption, printApproveOutcome, promptHidden, verifyVenueAgent, warnDeprecatedPassphrase, type ApproveAgentParams,
} from "./agent.js";
import { importOwsWallet, type OwsImportInput } from "./wallet.js";
import { agentNetworkOf, getAgent, listAgents } from "../agent-wallet/store.js";
import {
  IMPORT_KEY_WARNING, IMPORT_SCOPE_NOTE, UNVERIFIED_IMPORT_VENUES, assertDistinctImportSecrets, deleteImportedAgentLocal,
  importSecretFromLines, importSecretLabel, importSecretLineCount, importVenueAgent, printImportOutcome,
  type ImportAgentParams, type ImportSecret, type ImportVerification,
} from "./agent-import.js";

const PERP_DIR = resolve(process.env.HOME || "~", ".perp");
const ENV_FILE = resolve(PERP_DIR, ".env");

// ── .env helpers ──────────────────────────────────────────────
//
// Legacy read path only. `perp setup` never writes secrets here (SSOT Rule #3:
// master keys live in the OWS vault, agent keys in OWS / ~/.perp/<venue>-agents/).
// `settings env` still uses these for existing legacy-key users (`wallet set` imports into OWS).

export { ENV_FILE, loadEnvFile, setEnvVar };

function ensurePerpDir() {
  if (!existsSync(PERP_DIR)) mkdirSync(PERP_DIR, { recursive: true, mode: 0o700 });
}

function loadEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const lines = readFileSync(ENV_FILE, "utf-8").split("\n");
  const env: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
  return env;
}

function writeEnvFile(env: Record<string, string>) {
  ensurePerpDir();
  const lines = [
    "# perp-cli configuration",
    "# Legacy key file — prefer the OWS vault (perp wallet import)",
    "",
  ];
  for (const [key, value] of Object.entries(env)) {
    lines.push(`${key}=${value}`);
  }
  lines.push("");
  // Atomic, explicit 0600 (writeFileSync's mode is ignored when the file already exists).
  writeKeystoreAtomic(ENV_FILE, lines.join("\n"));
}

function setEnvVar(key: string, value: string) {
  ensurePerpDir();
  const env = loadEnvFile();
  env[key] = value;
  writeEnvFile(env);
  // Also set in current process
  process.env[key] = value;
}

// ── Exchange → env var mapping (legacy venues only) ───────────

// v0.12.4 retired the legacy HMAC ASTER_API_KEY/SECRET path (Plan v3.0).
// v0.12.6 restores Aster as a normal EVM exchange: `ASTER_PRIVATE_KEY`
// (Tier 3 PK direct path) is collected like HL/LT, and the agent flow
// (`wallet agent approve aster`) is the recommended Tier 1 onboarding.
// Removing Aster entirely was over-correction — the entry must exist so
// `wallet import` / `wallet set` treat all 4 legacy DEX uniformly.
export const EXCHANGE_ENV_MAP: Record<string, { envKey: string; envKeySecret?: string; chain: "solana" | "evm" | "apikey"; label: string }> = {
  pacifica: { envKey: "PACIFICA_PRIVATE_KEY", chain: "solana", label: "Pacifica (Solana)" },
  hyperliquid: { envKey: "HL_PRIVATE_KEY", chain: "evm", label: "Hyperliquid (EVM)" },
  lighter: { envKey: "LIGHTER_PRIVATE_KEY", chain: "evm", label: "Lighter (EVM)" },
  aster: { envKey: "ASTER_PRIVATE_KEY", chain: "evm", label: "Aster (BNB Chain)" },
};

// ── Validate keys ─────────────────────────────────────────────

export async function validateKey(chain: "solana" | "evm" | "apikey", key: string): Promise<{ valid: boolean; address: string }> {
  if (chain === "solana") {
    try {
      const { Keypair } = await import("@solana/web3.js");
      const bs58 = (await import("bs58")).default;
      try {
        const kp = Keypair.fromSecretKey(bs58.decode(key));
        return { valid: true, address: kp.publicKey.toBase58() };
      } catch {
        const arr = JSON.parse(key);
        const kp = Keypair.fromSecretKey(Uint8Array.from(arr));
        return { valid: true, address: kp.publicKey.toBase58() };
      }
    } catch {
      return { valid: false, address: "" };
    }
  } else if (chain === "apikey") {
    // API key validation: just check it's a non-empty hex-like string
    return { valid: key.length >= 16, address: key.slice(0, 8) + "..." + key.slice(-4) };
  } else {
    try {
      const { ethers } = await import("ethers");
      const pk = key.startsWith("0x") ? key : `0x${key}`;
      return { valid: true, address: new ethers.Wallet(pk).address };
    } catch {
      return { valid: false, address: "" };
    }
  }
}

// ── Setup building blocks (shared by interactive + non-interactive) ──────────

/** Names (never values) of legacy private-key variables present in ~/.perp/.env. */
export function legacyEnvKeyNames(): string[] {
  const env = loadEnvFile();
  return Object.values(EXCHANGE_ENV_MAP).map(i => i.envKey).filter(k => env[k] !== undefined && env[k] !== "");
}

/** Trading venues from the registry (no hardcoded list). */
export function setupVenues(): VenueDefinition[] {
  return listVenuesWithRole("trading");
}

/** Resolve one venue id/alias for setup: must be a trading venue with an environment on `network`. */
export function resolveSetupVenue(input: string, network: Network): VenueId {
  const id = tryResolveVenueId(input.trim());
  // A registered venue without the trading role (release-gated RISEx, market-data-only TxFlow /
  // Variational / GRVT) is a capability refusal, not an unknown name.
  if (id !== null && !getVenue(id).roles.includes("trading")) throw roleUnsupported(getVenue(id), "setup");
  if (id === null) {
    throw new PerpError("INVALID_PARAMS", `Unknown trading venue "${input}"`, {
      remediation: `Use one of: ${setupVenues().map(v => v.id).join(", ")}`,
    });
  }
  networkConfig(getVenue(id), network); // throws NOT_IMPLEMENTED when the venue has no such network
  return id;
}

/** Parse a comma-separated venue list (ids or aliases), de-duplicated in input order. */
export function parseVenueList(csv: string, network: Network): VenueId[] {
  const parts = csv.split(/[,\s]+/).filter(p => p.length > 0);
  if (parts.length === 0) {
    throw new PerpError("INVALID_PARAMS", "No venues given", {
      remediation: `Pass --venues <list>, e.g. --venues ${setupVenues().slice(0, 2).map(v => v.id).join(",")}`,
    });
  }
  return [...new Set(parts.map(p => resolveSetupVenue(p, network)))];
}

/** Parse `<venue>=<bps>` per-venue slippage overrides; each bps must fit that venue's maxSlippageBps. */
export function parseVenueSlippage(entries: string[], network: Network): { [K in VenueId]?: number } {
  const out: { [K in VenueId]?: number } = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new PerpError("INVALID_PARAMS", `Invalid slippage override "${entry}"`, {
        remediation: "Use <venue>=<bps>, e.g. --slippage arcus=100",
      });
    }
    const venue = resolveSetupVenue(entry.slice(0, eq), network);
    out[venue] = parseSlippageSettingBps(`slippageBps.${venue}`, entry.slice(eq + 1).trim(), getVenue(venue).maxSlippageBps);
  }
  return out;
}

export interface SetupSettingsChange {
  /** null = leave settings.owsActiveWallet unchanged (no master wallet on this computer). */
  owsActiveWallet: string | null;
  /** null = leave settings.defaultExchange unchanged. */
  defaultExchange: VenueId | null;
  /** null = leave settings.defaultSlippageBps unchanged. */
  defaultSlippageBps: number | null;
  /** Per-venue overrides to set (other venues' overrides are left alone). */
  slippageBps: { [K in VenueId]?: number };
}

/** Write the wizard's choices to ~/.perp/settings.json (metadata only — never secrets). */
export function applySetupSettings(change: SetupSettingsChange): Settings {
  const settings = loadSettings();
  if (change.owsActiveWallet !== null) settings.owsActiveWallet = change.owsActiveWallet;
  if (change.defaultExchange !== null) settings.defaultExchange = change.defaultExchange;
  if (change.defaultSlippageBps !== null) settings.defaultSlippageBps = change.defaultSlippageBps;
  for (const [venue, bps] of Object.entries(change.slippageBps) as [VenueId, number][]) {
    settings.slippageBps[venue] = bps;
  }
  saveSettings(settings);
  return settings;
}

/** Agent names already registered for `venue` on `network` in settings. */
function registeredAgentNames(venue: VenueId, network: Network): string[] {
  if (venue === "ondo" || venue === "arcus" || venue === "qfex" || venue === "risex") {
    const map = loadSettings().agents?.[venue];
    return map ? Object.values(map).filter(m => m.network === network).map(m => m.agentName) : [];
  }
  return listAgents(venue).filter(({ meta }) => agentNetworkOf(venue, meta) === network).map(({ meta }) => meta.agentName);
}

function rotateHint(venue: VenueId): string {
  if (venue === "qfex") return "perp wallet agent import qfex --replace";
  return venue === "ondo" || venue === "arcus" || venue === "risex"
    ? `perp wallet agent approve ${venue} --rotate`
    : `perp wallet agent rotate ${venue}`;
}

/** Why the wizard cannot register an agent for `venue` on `network`; null when it can (uniform wording). */
function approveBlocker(venue: VenueId, network: Network): string | null {
  const reason = agentApproveUnsupportedReason(venue, network, "approve");
  return reason === null ? null : `${getVenue(venue).displayName} agent management on ${network} not supported — ${reason}`;
}

/** Real follow-up commands for the configured venues (all exist in this CLI). */
export function nextStepCommands(venues: VenueId[], network: Network): string[] {
  const net = network === "testnet" ? " -n testnet" : "";
  const cmds = [
    `perp${net} wallet agent verify`,
    `perp${net} portfolio`,
    "perp funds info",
  ];
  // `funds deposit` has subcommands for these venues only.
  for (const v of venues) {
    if (v === "pacifica" || v === "hyperliquid") cmds.push(`perp${net} funds deposit ${v} <amount>`);
    if (v === "lighter") cmds.push(`perp${net} funds deposit lighter --help`);
  }
  for (const v of venues) cmds.push(`perp${net} -e ${v} market list`);
  cmds.push("perp settings show");
  return cmds;
}

/** Plain-language slippage explanation. */
export function slippageExplanation(venues: VenueId[]): string[] {
  const lines = [
    "Market orders are sent as immediate-or-cancel (IOC) limit orders. The limit price is the",
    "reference price moved by the slippage bound, so a market order never fills worse than that.",
    `The shipped default is ${SHIPPED_DEFAULT_SLIPPAGE_BPS} bps (${SHIPPED_DEFAULT_SLIPPAGE_BPS / 100}%). 1 bps = 0.01%.`,
    "The same bound applies to entries, closes, and TP/SL / stop triggers. Triggers use the trigger",
    "price as the reference, so in a fast move a stop may NOT fill if price gaps beyond the bound.",
    "A larger bound fills more reliably but can cost more; a smaller bound protects price but may",
    "leave orders unfilled. Precedence: --slippage-bps flag → per-venue setting → global default.",
  ];
  if (venues.length > 0) {
    lines.push(`Per-venue maximum: ${venues.map(v => `${v} ${getVenue(v).maxSlippageBps}`).join(", ")} bps.`);
  }
  lines.push(`The global default must be ≤ ${maxDefaultSlippageBps()} bps (the tightest venue maximum).`);
  return lines;
}

function owsWalletInfo(name: string): { name: string; evm: string | null; solana: string | null } | null {
  const w = loadOws().listWallets().find(x => x.name === name);
  if (!w) return null;
  const evm = w.accounts.find(a => a.chainId.startsWith("eip155:"));
  const sol = w.accounts.find(a => a.chainId.startsWith("solana:"));
  return { name: w.name, evm: evm ? evm.address : null, solana: sol ? sol.address : null };
}

/** Plain description of what approving `venue` signs (shown before confirmation). */
function signingSummary(p: ApproveAgentParams, master: { evm: string | null; solana: string | null }): string[] {
  const def = getVenue(p.venue);
  const expiry = `valid for ${p.expiresIn}`;
  switch (p.venue) {
    case "hyperliquid":
      return [`EIP-712 ApproveAgent signed by master EVM ${master.evm}: authorizes a new agent key to trade (${expiry}).`];
    case "aster":
      return [`EIP-712 ApproveAgent signed by master EVM ${master.evm}: perp=${p.canPerp ? "yes" : "no"}, spot=${p.canSpot ? "yes" : "no"}, withdraw=no (${expiry}).`];
    case "pacifica":
      return [`Ed25519 bind_agent_wallet message signed by master Solana ${master.solana}: binds a new agent key (${expiry}).`];
    case "lighter":
    case "lighter-rh":
      return [`${def.displayName} ChangePubKey (L1 EIP-712 + L2) signed by master EVM ${master.evm}: registers a new API key in slot ${p.apiKeyIndex === null ? "<next free>" : p.apiKeyIndex}.`];
    case "arcus":
      return [`EIP-712 createApiKey signed by master EVM ${master.evm}: registers an Ed25519 API key for account index ${p.accountIndex} (${expiry}).`];
    case "ondo":
      return ["No signature. Your Ondo API key is stored encrypted in ~/.perp/ondo-agents/ and checked with one read-only account request."];
    case "qfex":
      return ["No signature. Your QFEX API key is stored encrypted in ~/.perp/qfex-agents/ and checked with read-only requests."];
    case "risex":
      return [
        `EIP-712 RegisterSigner signed by master EVM ${master.evm} (+ VerifySigner by the new signer): registers a session signer (${expiry}).`,
        `Then the new signer signs DisablePermission for every permission except trading, and ${master.evm} sends those transactions ON-CHAIN on RISE chain (needs RISE-chain ETH for gas): the signer can trade but never move funds, and only the master could re-enable a permission.`,
      ];
    case "txflow":
      return ["Nothing — TxFlow is market data only (unofficial read-only API)."];
    case "variational":
      return [`Nothing — ${VARIATIONAL_READ_ONLY_REMEDIATION}.`];
    case "grvt":
      return ["Nothing — GRVT is read-only (market data) in this version; trading is planned for a later release."];
  }
}

// ── Agent registration step ──────────────────────────────────────────────────

export type AgentStepResult =
  | { venue: VenueId; status: "approved"; agentName: string }
  | { venue: VenueId; status: "imported"; agentName: string; verification: ImportVerification }
  | { venue: VenueId; status: "skipped"; reason: string }
  | { venue: VenueId; status: "failed"; error: StructuredError };

function failed(venue: VenueId, err: unknown): AgentStepResult {
  return { venue, status: "failed", error: classifyError(err, venue) };
}

// ── Interactive wizard ───────────────────────────────────────────────────────

/** Prompt I/O for the wizard (injectable for tests). askHidden never echoes. */
export interface Prompter {
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
}

function ttyPrompter(): Prompter {
  return {
    async ask(question: string) {
      // One readline per question so raw-mode hidden prompts never share stdin with it.
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await rl.question(question)).trim();
      } finally {
        rl.close();
      }
    },
    askHidden: (question: string) => promptHidden(question),
  };
}

async function askYesNo(p: Prompter, question: string, defaultYes: boolean): Promise<boolean> {
  for (;;) {
    const a = (await p.ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"}: `)).toLowerCase();
    if (a === "") return defaultYes;
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
    console.log(chalk.yellow("  Please answer y or n."));
  }
}

async function askNewPassphrase(p: Prompter): Promise<string> {
  for (;;) {
    const pp = await p.askHidden("  Vault passphrase (hidden; empty = unencrypted): ");
    const again = await p.askHidden("  Repeat passphrase: ");
    if (pp === again) return pp;
    console.log(chalk.yellow("  Passphrases do not match — try again."));
  }
}

/**
 * Step 1 — pick / create / import the master OWS wallet, or skip it (name null: no master on this
 * computer — every venue then uses an API key imported from the exchange website).
 */
async function stepMasterWallet(p: Prompter): Promise<{ name: string | null; passphrase: string | null }> {
  console.log(chalk.cyan.bold("\n  Step 1/7 — Master wallet (OWS encrypted vault)\n"));
  const ows = loadOws();
  const active = loadSettings().owsActiveWallet;
  // agent-<venue>-<master> wallets are delegated keys, never masters.
  const wallets = ows.listWallets().filter(w => !w.name.startsWith("agent-"));
  wallets.forEach((w, i) => {
    const evm = w.accounts.find(a => a.chainId.startsWith("eip155:"));
    const sol = w.accounts.find(a => a.chainId.startsWith("solana:"));
    const mark = w.name === active ? chalk.cyan(" (active)") : "";
    console.log(`    ${i + 1}) ${chalk.white.bold(w.name)}${mark}  ${chalk.gray(`EVM ${evm ? evm.address : "-"}  SOL ${sol ? sol.address : "-"}`)}`);
  });
  if (wallets.length === 0) console.log(chalk.gray("    (no wallets in the vault yet)"));
  console.log(`    c) create a new wallet`);
  console.log(`    i) import an existing key / mnemonic`);
  console.log(`    s) skip — no master wallet on this computer (use API keys created on the exchange websites)`);

  for (;;) {
    const a = (await p.ask("\n  Choose: ")).toLowerCase();
    const idx = Number(a);
    if (Number.isInteger(idx) && idx >= 1 && idx <= wallets.length) return { name: wallets[idx - 1].name, passphrase: null };
    if (a === "s") {
      console.log(chalk.gray(`    No master wallet: you will import API keys created on each exchange website. ${IMPORT_SCOPE_NOTE}`));
      return { name: null, passphrase: null };
    }
    if (a === "c" || a === "i") {
      const name = await p.ask("  New wallet name: ");
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || name.startsWith("agent-")) {
        console.log(chalk.yellow("  Use 1-64 letters, digits, '.', '_' or '-' (not starting with 'agent-')."));
        continue;
      }
      if (ows.listWallets().some(w => w.name === name)) {
        console.log(chalk.yellow(`  A wallet named "${name}" already exists.`));
        continue;
      }
      if (a === "c") {
        const pp = await askNewPassphrase(p);
        const w = ows.createWallet(name, pp);
        console.log(chalk.green(`  Created ${w.name}.`) + chalk.gray(" Back it up with: perp wallet backup"));
        return { name, passphrase: pp };
      }
      const kind = (await p.ask("  Import type — 1) EVM key  2) Solana key  3) EVM + Solana keys  4) mnemonic: ")).trim();
      let input: OwsImportInput;
      if (kind === "1") input = { kind: "single", chain: "evm", key: await p.askHidden("  EVM private key (hidden): ") };
      else if (kind === "2") input = { kind: "single", chain: "solana", key: await p.askHidden("  Solana private key (hidden): ") };
      else if (kind === "3") input = { kind: "dual", evm: await p.askHidden("  EVM private key (hidden): "), solana: await p.askHidden("  Solana private key (hidden): ") };
      else if (kind === "4") input = { kind: "mnemonic", mnemonic: await p.askHidden("  Mnemonic (hidden): ") };
      else {
        console.log(chalk.yellow("  Choose 1-4."));
        continue;
      }
      const pp = await askNewPassphrase(p);
      try {
        const w = await importOwsWallet(name, pp, input);
        console.log(chalk.green(`  Imported ${w.name} into the OWS vault.`));
        return { name, passphrase: pp };
      } catch (err) {
        // importOwsWallet throws a PerpError whose message is already redacted (redactSecrets);
        // anything else gets a fixed message — key material must never be echoed.
        console.log(chalk.red(err instanceof PerpError ? `  ${err.message}` : "  Import failed: the key / mnemonic was rejected (input not shown)."));
        continue;
      }
    }
    console.log(chalk.yellow(`  Enter ${wallets.length > 0 ? `1-${wallets.length}, ` : ""}c, i, or s.`));
  }
}

/** `preselected` is the global -n network: the blank answer keeps it. */
async function stepNetwork(p: Prompter, preselected: Network): Promise<Network> {
  console.log(chalk.cyan.bold("\n  Step 2/7 — Network\n"));
  const withTestnet = setupVenues().filter(v => v.networks.testnet !== null).map(v => v.id);
  console.log(chalk.gray(`    testnet is available for: ${withTestnet.join(", ")}`));
  const def = preselected === "mainnet" ? "1" : "2";
  for (;;) {
    const a = (await p.ask(`  1) mainnet  2) testnet [${def}]: `)).toLowerCase();
    if (a === "") return preselected;
    if (a === "1" || a === "mainnet") return "mainnet";
    if (a === "2" || a === "testnet") return "testnet";
  }
}

async function stepVenues(p: Prompter, network: Network): Promise<VenueId[]> {
  console.log(chalk.cyan.bold("\n  Step 3/7 — Venues\n"));
  const all = setupVenues();
  const offered = all.filter(v => v.networks[network] !== null);
  offered.forEach((v, i) => {
    const net = networkConfig(v, network);
    console.log(`    ${i + 1}) ${chalk.cyan(v.displayName.padEnd(12))} ${chalk.gray(`${v.id} — ${net.collateral[0]}${net.collateral.length > 1 ? " +" + (net.collateral.length - 1) : ""} collateral on ${net.settlementChain}`)}`);
    if (v.restrictedRegions.length > 0) {
      console.log(chalk.yellow(`       ⚠ not available to residents of: ${v.restrictedRegions.join(", ")}`));
    }
  });
  const missing = all.filter(v => v.networks[network] === null);
  if (missing.length > 0) console.log(chalk.gray(`    (no ${network}: ${missing.map(v => v.id).join(", ")})`));
  for (;;) {
    const a = (await p.ask("\n  Venues (e.g. 1,3 or 'all'): ")).toLowerCase();
    if (a === "all") return offered.map(v => v.id);
    const parts = a.split(/[,\s]+/).filter(x => x.length > 0);
    const picked: VenueId[] = [];
    let bad: string | null = null;
    for (const part of parts) {
      const n = Number(part);
      if (Number.isInteger(n) && n >= 1 && n <= offered.length) picked.push(offered[n - 1].id);
      else {
        const id = tryResolveVenueId(part);
        if (id !== null && offered.some(v => v.id === id)) picked.push(id);
        else bad = part;
      }
    }
    if (bad !== null) console.log(chalk.yellow(`  Unknown choice "${bad}".`));
    else if (picked.length === 0) console.log(chalk.yellow("  Pick at least one venue."));
    else return [...new Set(picked)];
  }
}

async function venueApproveParams(
  p: Prompter, venue: VenueId, network: Network, master: string,
): Promise<ApproveAgentParams | null> {
  const base: ApproveAgentParams = {
    venue, network, master, agentName: null, expiresIn: "90d",
    canPerp: true, canSpot: false, canWithdraw: false, rotate: false, passphrase: null,
    apiKeyIndex: null, forceSlot: false, accountIndex: 0, aster: {}, ondoKey: null,
  };
  if (venue === "aster") {
    base.canSpot = await askYesNo(p, "  Also allow the agent to trade Aster spot?", false);
  } else if (isLighterFamilyVenue(venue)) {
    const allowed = venue === "lighter-rh" ? "4-254 except 157" : "4-254";
    console.log(chalk.gray(`    API key slots 0-3${venue === "lighter-rh" ? " and 157" : ""} are reserved by the venue's frontend.`));
    for (;;) {
      const a = await p.ask(`  API key slot (${allowed}, blank = next free): `);
      if (a === "") break;
      try {
        assertLighterSlot(venue, Number(a));
        base.apiKeyIndex = Number(a);
        break;
      } catch (err) {
        console.log(chalk.yellow(`  ${err instanceof Error ? err.message : String(err)}`));
      }
    }
  } else if (venue === "arcus") {
    console.log(chalk.yellow("    Arcus API access is whitelist-gated: your master EVM address must be on the Arcus access"));
    console.log(chalk.yellow("    whitelist (request at https://arcus.xyz), otherwise registration is rejected."));
    for (;;) {
      const a = await p.ask("  Arcus account index (0-9, or 255 for all; trading needs 0-9) [0]: ");
      const n = a === "" ? 0 : Number(a);
      if (Number.isInteger(n) && ((n >= 0 && n <= 9) || n === 255)) {
        base.accountIndex = n;
        break;
      }
      console.log(chalk.yellow("  Enter 0-9 or 255."));
    }
  } else if (venue === "ondo") {
    console.log(chalk.gray("    Create an API key in the Ondo Perps web app first. The secret is read hidden and stored encrypted."));
    const keyId = await p.ask("  Ondo API key id (blank = skip): ");
    if (keyId === "") return null;
    const secret = await p.askHidden("  Ondo API secret (hidden): ");
    base.ondoKey = { keyId, secret };
  }
  return base;
}

/** Prompt for the public inputs + the hidden key of a website-created key (`wallet agent import`). */
async function venueImportParams(p: Prompter, venue: VenueId, network: Network): Promise<ImportAgentParams | null> {
  const def = getVenue(venue);
  console.log(chalk.gray(`    Create the key on the ${def.displayName} ${network} website first (API / agent wallet page).`));
  const params: Omit<ImportAgentParams, "secret"> = {
    venue, network, agentName: null, masterAddress: null, accountIndex: null, apiKeyIndex: null, expiresIn: null, replace: false,
    accountId: null,
    // QFEX: the resolved account UUID is shown and confirmed before the key is stored.
    confirmAccount: venue !== "qfex" ? null : async binding => {
      console.log(chalk.white(`    This key will trade QFEX account ${chalk.cyan(binding.accountId)} (${binding.isPrimaryAccount ? "primary" : "subaccount"}).`));
      return askYesNo(p, "  Store the key for this account?", false);
    },
  };
  const askInt = async (q: string, optional: boolean): Promise<number | null> => {
    for (;;) {
      const a = await p.ask(q);
      if (a === "" && optional) return null;
      const n = Number(a);
      if (a !== "" && Number.isInteger(n) && n >= 0) return n;
      console.log(chalk.yellow("  Enter a non-negative integer."));
    }
  };
  if (venue === "hyperliquid") {
    const a = await p.ask("  Master address (blank = read it from Hyperliquid): ");
    params.masterAddress = a === "" ? null : a;
  } else if (venue === "aster" || venue === "pacifica" || venue === "arcus") {
    for (;;) {
      const a = await p.ask(`  Master address you log in with on ${def.displayName} (${venue === "pacifica" ? "Solana" : "EVM"}; blank = skip venue): `);
      if (a === "") return null;
      params.masterAddress = a;
      break;
    }
    if (venue === "arcus") params.accountIndex = await askInt("  Account index the key is scoped to (blank = as registered): ", true);
  } else if (isLighterFamilyVenue(venue)) {
    params.accountIndex = await askInt("  Account index (shown with the API key): ", false);
    params.apiKeyIndex = await askInt("  API key index / slot of the key: ", false);
  }
  let secret: ImportSecret;
  if (venue === "ondo") {
    const keyId = await p.ask("  Ondo API key id (ondoKeyId_…; blank = skip): ");
    if (keyId === "") return null;
    secret = { kind: "ondo", keyId, secret: await p.askHidden("  Ondo API secret (hidden): ") };
  } else if (venue === "qfex") {
    console.log(chalk.gray("    No signature. Your QFEX API key is stored encrypted in ~/.perp/qfex-agents/ and checked with read-only requests."));
    console.log(chalk.gray("    Create it in QFEX Developer Settings (2FA). For trading, leave \"Deposit and withdraw\" OFF."));
    const publicKey = await p.ask("  QFEX public key (blank = skip): ");
    if (publicKey === "") return null;
    secret = { kind: "qfex", publicKey, secret: await p.askHidden("  QFEX secret (hidden): ") };
    const sub = await p.ask("  Subaccount id (blank = primary): ");
    params.accountId = sub === "" ? null : sub;
  } else {
    const key = await p.askHidden(`  ${importSecretLabel(venue)} (hidden; blank = skip): `);
    if (key === "") return null;
    secret = { kind: "key", key };
  }
  return { ...params, secret };
}

async function stepAgents(
  p: Prompter, venues: VenueId[], network: Network, master: string | null, getPassphrase: () => Promise<string>,
): Promise<AgentStepResult[]> {
  console.log(chalk.cyan.bold("\n  Step 4/7 — Agent wallets / API keys\n"));
  console.log(chalk.gray("    An agent is a separate trading key. perp-cli signs orders with it, so the master key is not"));
  console.log(chalk.gray("    needed for every trade. Two ways to get one per venue:"));
  console.log(chalk.gray("      approve — this computer's master wallet authorizes a new agent (one signature)"));
  console.log(chalk.gray("      import  — paste an agent / API key you created on the exchange website (no master needed here)"));
  console.log(chalk.gray(`    ${IMPORT_SCOPE_NOTE}`));
  console.log(chalk.gray("    Neither moves funds. Withdrawal permission is never granted here."));
  const info = master !== null ? owsWalletInfo(master) : null;
  if (master !== null && !info) throw new PerpError("KEY_NOT_FOUND", `OWS wallet "${master}" not found`, { remediation: "perp wallet list" });
  const results: AgentStepResult[] = [];
  for (const venue of venues) {
    const def = getVenue(venue);
    console.log(chalk.white.bold(`\n  ${def.displayName}`));
    const existing = registeredAgentNames(venue, network);
    if (existing.length > 0) {
      const reason = `already registered (${existing.join(", ")}); to replace: ${rotateHint(venue)}`;
      console.log(chalk.gray(`    Skipped: ${reason}.`));
      results.push({ venue, status: "skipped", reason });
      continue;
    }
    // Why "approve" is not offered for this venue (null = it is). Import is always offered.
    let approveBlocked: string | null = venue === "ondo" ? "Ondo keys are always created on the website"
      : venue === "qfex" ? "QFEX keys are always created on the website (2FA)"
        : approveBlocker(venue, network);
    if (approveBlocked === null && master === null) approveBlocked = "no master wallet on this computer";
    if (approveBlocked === null && info !== null && ((def.masterKeyKind === "solana" && info.solana === null) || (def.masterKeyKind === "evm" && info.evm === null))) {
      approveBlocked = `wallet "${master}" has no ${def.masterKeyKind} account`;
    }
    let method: "approve" | "import" | "skip";
    if (approveBlocked === null) {
      for (;;) {
        const a = (await p.ask("    1) approve with this computer's master wallet  2) import a key created on the website  3) skip [1]: ")).toLowerCase();
        if (a === "" || a === "1" || a === "y" || a === "yes") { method = "approve"; break; }
        if (a === "2" || a === "import") { method = "import"; break; }
        if (a === "3" || a === "n" || a === "no") { method = "skip"; break; }
        console.log(chalk.yellow("  Enter 1, 2 or 3."));
      }
    } else {
      console.log(chalk.gray(`    Approve here is not available (${approveBlocked}).`));
      method = (await askYesNo(p, `  Import a key created on the ${def.displayName} website?`, true)) ? "import" : "skip";
    }
    if (method === "skip") {
      results.push({ venue, status: "skipped", reason: approveBlocked ?? "skipped by user" });
      continue;
    }
    try {
      if (method === "import") {
        const params = await venueImportParams(p, venue, network);
        if (params === null) {
          results.push({ venue, status: "skipped", reason: "skipped by user" });
          continue;
        }
        const outcome = await importVenueAgent(params);
        printImportOutcome(outcome);
        results.push({ venue, status: "imported", agentName: outcome.agentName, verification: outcome.verification });
        continue;
      }
      const params = await venueApproveParams(p, venue, network, master as string);
      if (params === null) {
        results.push({ venue, status: "skipped", reason: "skipped by user" });
        continue;
      }
      console.log(chalk.white(`\n    ${network === "mainnet" ? chalk.red.bold("MAINNET") : "testnet"} — this will:`));
      for (const line of signingSummary(params, info as { evm: string | null; solana: string | null })) console.log(`      ${line}`);
      console.log(chalk.gray("      No deposit, withdrawal, or trade is made."));
      if (!(await askYesNo(p, "  Sign and submit?", false))) {
        results.push({ venue, status: "skipped", reason: "not confirmed" });
        continue;
      }
      params.passphrase = await getPassphrase();
      const outcome = await approveVenueAgent(params);
      printApproveOutcome(outcome);
      results.push({ venue, status: "approved", agentName: "meta" in outcome ? outcome.meta.agentName : outcome.agentName });
    } catch (err) {
      const r = failed(venue, err);
      if (r.status === "failed") {
        console.log(chalk.red(`    ✗ ${def.displayName}: [${r.error.code}] ${r.error.message}`));
        if (r.error.remediation) console.log(chalk.gray(`      ${r.error.remediation}`));
      }
      results.push(r);
    }
  }
  return results;
}

async function stepSlippage(p: Prompter, venues: VenueId[], network: Network): Promise<{ defaultSlippageBps: number | null; slippageBps: { [K in VenueId]?: number } }> {
  console.log(chalk.cyan.bold("\n  Step 5/7 — Slippage bound\n"));
  for (const line of slippageExplanation(venues)) console.log(chalk.gray(`    ${line}`));
  const s = loadSettings();
  const shipped = s.defaultSlippageBps === SHIPPED_DEFAULT_SLIPPAGE_BPS ? " (shipped default)" : "";
  console.log(`\n    Current default: ${chalk.cyan(String(s.defaultSlippageBps))} bps${chalk.gray(shipped)}`);
  for (const [v, bps] of Object.entries(s.slippageBps)) console.log(`    Current ${v}: ${chalk.cyan(String(bps))} bps`);

  let defaultSlippageBps: number | null = null;
  const max = maxDefaultSlippageBps();
  for (;;) {
    const a = await p.ask(`\n  Global default in bps (blank = keep ${s.defaultSlippageBps}): `);
    if (a === "") break;
    try {
      defaultSlippageBps = parseSlippageSettingBps("defaultSlippageBps", a, max);
      break;
    } catch (err) {
      console.log(chalk.yellow(`  ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  const slippageBps: { [K in VenueId]?: number } = {};
  for (;;) {
    const a = await p.ask("  Per-venue overrides as venue=bps, comma-separated (blank = none): ");
    if (a === "") break;
    try {
      Object.assign(slippageBps, parseVenueSlippage(a.split(/[,\s]+/).filter(x => x.length > 0), network));
      break;
    } catch (err) {
      console.log(chalk.yellow(`  ${err instanceof PerpError ? err.structured.message : String(err)}`));
    }
  }
  return { defaultSlippageBps, slippageBps };
}

async function stepDefaultVenue(p: Prompter, venues: VenueId[]): Promise<VenueId> {
  console.log(chalk.cyan.bold("\n  Step 6/7 — Default venue\n"));
  if (venues.length === 1) {
    console.log(`    ${chalk.cyan(venues[0])} (only selected venue)`);
    return venues[0];
  }
  venues.forEach((v, i) => console.log(`    ${i + 1}) ${v}`));
  for (;;) {
    const n = Number(await p.ask("  Default venue for commands without -e: "));
    if (Number.isInteger(n) && n >= 1 && n <= venues.length) return venues[n - 1];
  }
}

async function stepSummary(
  venues: VenueId[], network: Network, master: string | null, results: AgentStepResult[], getPassphrase: () => Promise<string>,
): Promise<void> {
  console.log(chalk.cyan.bold("\n  Step 7/7 — Summary\n"));
  const s = loadSettings();
  console.log(`    Wallet:   ${master !== null ? chalk.white.bold(s.owsActiveWallet) : chalk.gray("none on this computer (imported API keys only)")}`);
  console.log(`    Network:  ${network}`);
  console.log(`    Default:  ${chalk.cyan(s.defaultExchange)}`);
  console.log(`    Slippage: ${s.defaultSlippageBps} bps default${Object.entries(s.slippageBps).map(([v, b]) => `, ${v} ${b}`).join("")}`);
  for (const r of results) {
    const text = r.status === "approved" ? chalk.green(`agent ${r.agentName} registered`)
      : r.status === "imported" ? (r.verification.status === "verified"
        ? chalk.green(`key ${r.agentName} imported (verified)`)
        : chalk.yellow(`key ${r.agentName} imported — NOT verified: ${r.verification.method}`))
        : r.status === "skipped" ? chalk.gray(`skipped — ${r.reason}`)
          : chalk.red(`failed — [${r.error.code}] ${r.error.message}`);
    console.log(`    ${r.venue.padEnd(12)} ${text}`);
  }

  // Read-only live check for every venue whose agent was approved here (imported keys were
  // checked at import time — the result is shown above).
  const approvedHere = new Set(results.filter(r => r.status === "approved").map(r => r.venue));
  const toVerify = master === null ? [] : venues.filter(v => approvedHere.has(v) && registeredAgentNames(v, network).length > 0 && approveBlocker(v, network) === null);
  if (toVerify.length > 0) {
    console.log(chalk.white.bold("\n  Agent verification (read-only):"));
    for (const v of toVerify) {
      try {
        const r = await verifyVenueAgent(v, network, { master, passphrase: await getPassphrase() });
        const icon = r.registered ? chalk.green("✓") : chalk.yellow("○");
        console.log(`    ${icon} ${v}: ${r.count} key(s) on the venue`);
        for (const w of r.warnings ?? []) console.log(chalk.yellow(`      [warn] ${w}`));
      } catch (err) {
        const e = classifyError(err, v);
        console.log(chalk.gray(`    – ${v}: [${e.code}] ${e.message}`));
      }
    }
  }

  if (results.some(r => r.status === "imported")) console.log(chalk.gray(`\n    ${IMPORT_SCOPE_NOTE}`));
  console.log(chalk.white.bold("\n  Next steps:"));
  for (const c of nextStepCommands(venues, network)) console.log(`    ${chalk.green(c)}`);
  console.log();
}

/**
 * Optional builder-fee step — offered only when settings `builder.<venue>` already holds a
 * value for a chosen venue (builder fees ship off). Explains the fee and approves only after
 * an explicit "y" (default No). Never configures a builder itself.
 */
export async function stepBuilder(p: Prompter, venues: VenueId[], network: Network, master: string | null, getPassphrase: () => Promise<string>): Promise<void> {
  const { builderTargetOf } = await import("../exchanges/builder-fee.js");
  const builder = loadSettings().builder;
  const configured = venues.filter(v => builderTargetOf(builder, v) !== null);
  if (configured.length === 0) return;
  const { builderApprovalPlan, approveBuilderOnVenue } = await import("./builder.js");
  console.log(chalk.cyan.bold("\n  Optional — Builder fees\n"));
  console.log(chalk.gray("    A builder fee is an extra fee on YOUR perp orders, paid to the builder in settings builder.<venue>."));
  console.log(chalk.gray("    It is attached only after the venue approval is confirmed. Default: skip.\n"));
  for (const v of configured) {
    try {
      const plan = builderApprovalPlan(v, network, master);
      const fee = plan.feeKind === "share" ? "fee share (you pay the normal fee)" : `${plan.feeKind === "max" ? "up to " : ""}${plan.feeBps} bps`;
      if (plan.approval === "none") {
        console.log(`    ${v.padEnd(12)} ${plan.identity} ${fee} — no approval step; attached as configured (remove: perp settings unset builder.${v})`);
        continue;
      }
      if (plan.master === null) {
        console.log(`    ${v.padEnd(12)} ${chalk.yellow(`no master wallet here — approve builder ${plan.identity} (${fee}) on the ${getVenue(v).displayName} website`)}`);
        continue;
      }
      if (!(await askYesNo(p, `  Approve builder ${plan.identity} to charge ${fee} on your ${v} perp orders (cap ${plan.capBps} bps)?`, false))) {
        console.log(chalk.gray(`    ${v}: skipped — no fee is attached until approved (perp wallet builder approve ${v})`));
        continue;
      }
      await approveBuilderOnVenue(plan, await getPassphrase());
      console.log(chalk.green(`    ${v}: builder ${plan.identity} approved (${fee})`));
    } catch (err) {
      const e = classifyError(err, v);
      console.log(chalk.yellow(`    ${v}: builder approval not done — [${e.code}] ${e.message}`));
    }
  }
}

/** Interactive `perp setup`. All prompts go through `p`; nothing secret is printed or written to .env. */
export async function runInteractiveSetup(p: Prompter, passphraseFlag: string | undefined, preselectedNetwork: Network): Promise<void> {
  console.log(chalk.cyan.bold("\n  perp-cli Setup Wizard\n"));
  const legacy = legacyEnvKeyNames();
  if (legacy.length > 0) {
    console.log(chalk.yellow(`  ⚠ ${ENV_FILE} holds raw private keys (${legacy.join(", ")}).`));
    console.log(chalk.yellow("    They keep working, but consider moving them into the encrypted OWS vault:"));
    console.log(chalk.yellow("    perp wallet import --name <name> [--chain evm|solana|dual] (hidden prompt / stdin), then"));
    console.log(chalk.yellow("    perp settings env remove <NAME> for each entry. This wizard does not touch them.\n"));
  }

  const master = await stepMasterWallet(p);
  let passphrase: string | null = master.passphrase;
  const getPassphrase = async (): Promise<string> => {
    if (passphrase !== null) return passphrase;
    if (master.name === null) throw new PerpError("NO_SIGNER_AVAILABLE", "No master wallet on this computer");
    const resolved = await resolvePassphrase({ flag: passphraseFlag });
    passphrase = resolved !== null ? resolved : await p.askHidden(`  Passphrase for wallet "${master.name}" (hidden): `);
    return passphrase;
  };

  const network = await stepNetwork(p, preselectedNetwork);
  const venues = await stepVenues(p, network);
  const results = await stepAgents(p, venues, network, master.name, getPassphrase);
  const slip = await stepSlippage(p, venues, network);
  const defaultVenue = await stepDefaultVenue(p, venues);
  applySetupSettings({
    owsActiveWallet: master.name,
    defaultExchange: defaultVenue,
    defaultSlippageBps: slip.defaultSlippageBps,
    slippageBps: slip.slippageBps,
  });
  await stepBuilder(p, venues, network, master.name, getPassphrase);
  await stepSummary(venues, network, master.name, results, getPassphrase);
}

// ── Commands ──────────────────────────────────────────────────

function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}

export interface SetupOpts {
  nonInteractive?: boolean;
  wallet?: string;
  walletName?: string;
  passphrase?: string;
  /** Root -n/--network (validated by networkOf). */
  network: Network;
  venues?: string;
  defaultVenue?: string;
  defaultExchange?: string;
  slippageBps?: string;
  slippage: string[];
  approveAgents?: boolean;
  yes?: boolean;
  ondoSecretStdin?: boolean;
  asterCanSpot?: boolean;
  lighterApiKeyIndex?: string;
  lighterRhApiKeyIndex?: string;
  arcusAccountIndex?: string;
  /** QFEX account UUID the imported key trades (--import-agents); it is the non-interactive confirmation. */
  qfexAccountId?: string;
  /** Venues whose key was created on the exchange website (keys read from stdin, in this order). */
  importAgents?: string;
  /** `<venue>=<address>` master / owner public addresses for --import-agents (repeatable). */
  masterAddress: string[];
  /** --import-agents venues the user accepts storing UNVERIFIED (pacifica has no read-only check). */
  allowUnverified?: string;
  lighterAccountIndex?: string;
  lighterRhAccountIndex?: string;
}

export function registerInitCommand(program: Command) {
  program
    .command("setup")
    .alias("init")
    .description("Setup wizard — OWS wallet, venues, agent wallets, slippage, default venue (scriptable with --non-interactive)")
    .option("--non-interactive", "Run without prompts (scripts / CI)")
    .option("--wallet <name>", "Existing OWS wallet to use as master")
    .option("--wallet-name <name>", "Create a new OWS wallet with this name as master")
    .addOption(deprecatedPassphraseOption("OWS vault passphrase")).hook("preAction", warnDeprecatedPassphrase)
    .option("--venues <list>", "Comma-separated trading venues to configure")
    .option("--default-venue <venue>", "Default venue (settings.defaultExchange)")
    .option("--default-exchange <venue>", "Alias of --default-venue")
    .option("--slippage-bps <n>", "Global default slippage bound in bps (settings.defaultSlippageBps)")
    .option("--slippage <venue=bps>", "Per-venue slippage bound (repeatable)", collect, [])
    .option("--approve-agents", "Register an agent wallet / API key on each --venues venue (requires --yes)")
    .option("--yes", "Confirm signing for --approve-agents")
    .option("--ondo-secret-stdin", "Read the Ondo API key id + secret from stdin (2 lines) for --approve-agents")
    .option("--aster-can-spot", "Aster agent: also allow spot trading")
    .option("--lighter-api-key-index <n>", "Lighter agent API key slot (4-254; default: next free)")
    .option("--lighter-rh-api-key-index <n>", "Lighter RH agent API key slot (4-254 except 157; default: next free)")
    .option("--arcus-account-index <n>", "Arcus subaccount for the API key: 0-9, or 255 for all")
    .option("--import-agents <venues>", "Import keys created on the exchange WEBSITES for these --venues (requires --yes); keys on stdin, one line per venue in this order (ondo: 2 lines, key id then secret; qfex: 2 lines, public key then secret). No master wallet needed when every venue is imported")
    .option("--master-address <venue=address>", "Master / owner public address for an --import-agents venue (repeatable; required for aster, pacifica, arcus)", collect, [])
    .option("--lighter-account-index <n>", "Lighter account index of the imported API key (--import-agents)")
    .option("--lighter-rh-account-index <n>", "Lighter RH account index of the imported API key (--import-agents)")
    .option("--qfex-account-id <uuid>", "QFEX account the imported key trades (--import-agents; required — it confirms the account the key is bound to)")
    .option("--allow-unverified <venues>", "Accept storing these --import-agents keys UNVERIFIED (required for pacifica: no read-only check exists); rolled back if another import in the batch fails")
    .action(async (opts: SetupOpts, command: Command) => {
      // optsWithGlobals() merges parent + subcommand options so --passphrase /
      // --wallet work whether placed on `perp --passphrase X setup` (parent) or
      // `perp setup --passphrase X` (subcommand). Commander v13 binds an
      // identically named flag to the parent, so opts.<flag> alone would be
      // undefined. The network is the root -n/--network flag (validated).
      const merged = command.optsWithGlobals() as { passphrase?: string; wallet?: string };
      const resolvedOpts: SetupOpts = {
        ...opts,
        passphrase: merged.passphrase ?? opts.passphrase,
        network: networkOf(command),
        wallet: merged.wallet ?? opts.wallet,
      };
      if (resolvedOpts.nonInteractive) {
        return runNonInteractiveSetup(resolvedOpts);
      }
      if (process.stdin.isTTY !== true) {
        const err = new PerpError("INVALID_PARAMS", "Interactive setup needs a terminal", {
          remediation: "Run in a terminal, or use: perp setup --non-interactive --wallet <name> --venues <list> ...",
        });
        console.error(chalk.red(`\n  Error [${err.structured.code}]: ${err.structured.message}`));
        console.error(chalk.gray(`  Remediation: ${err.structured.remediation}\n`));
        process.exitCode = 1;
        return;
      }
      await runInteractiveSetup(ttyPrompter(), resolvedOpts.passphrase, resolvedOpts.network);
    });
}

// ── Non-interactive setup (agent / CI / Docker) ──────────────────────────────

/**
 * Test seam: emit JSON envelopes when the global --json flag is present.
 * Mirrors the inline pattern used elsewhere (see src/index.ts:87) instead of
 * wiring isJson() through registerInitCommand for one call site.
 */
function setupIsJson(): boolean {
  return process.argv.includes("--json");
}

/** Parse `<venue>=<address>` entries (--master-address). */
function parseVenueAddresses(entries: string[], network: Network): { [K in VenueId]?: string } {
  const out: { [K in VenueId]?: string } = {};
  for (const entry of entries) {
    const eq = entry.indexOf("=");
    if (eq <= 0 || eq === entry.length - 1) {
      throw new PerpError("INVALID_PARAMS", `Invalid --master-address "${entry}"`, { remediation: "Use <venue>=<address>, e.g. --master-address aster=0xYOU" });
    }
    out[resolveSetupVenue(entry.slice(0, eq), network)] = entry.slice(eq + 1).trim();
  }
  return out;
}

/** All of piped stdin (keys for --import-agents). */
function readSetupStdin(): Promise<string> {
  return new Promise((resolveRead, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c: string | Buffer) => chunks.push(typeof c === "string" ? c : c.toString("utf-8")));
    process.stdin.on("end", () => resolveRead(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

function parseSlotFlag(flag: string, raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new PerpError("INVALID_PARAMS", `${flag} must be an integer (got "${raw}")`);
  return n;
}

/**
 * Drive `perp setup` end-to-end without TTY.
 *
 * Master wallet: exactly one of --wallet <existing> or --wallet-name <new>.
 * Passphrase (--passphrase / OWS_PASSPHRASE / stdin) is required to create a
 * wallet or to sign agent approvals. With --ondo-secret-stdin, stdin carries
 * the Ondo key, so the passphrase must come from the flag or env.
 *
 * Side effects, in order: validate everything → create wallet (if asked) →
 * write settings (owsActiveWallet, defaultExchange, slippage) → register
 * agents (only with --approve-agents --yes; a failure on one venue does not
 * stop the others). Never deposits, withdraws, or trades; never writes .env.
 */
export async function runNonInteractiveSetup(opts: SetupOpts): Promise<void> {
  const isJson = setupIsJson();

  try {
    // ── Validate all inputs before any side effect ──
    const network = parseNetwork(opts.network);
    const venues = opts.venues !== undefined ? parseVenueList(opts.venues, network) : [];

    if (opts.defaultVenue !== undefined && opts.defaultExchange !== undefined && opts.defaultVenue !== opts.defaultExchange) {
      throw new PerpError("INVALID_PARAMS", "--default-venue and --default-exchange disagree", { remediation: "Pass only --default-venue" });
    }
    const defaultRaw = opts.defaultVenue !== undefined ? opts.defaultVenue : opts.defaultExchange;
    let defaultVenue: VenueId | null = null;
    if (defaultRaw !== undefined) {
      const id = tryResolveVenueId(defaultRaw);
      if (id !== null && !getVenue(id).roles.includes("trading")) throw roleUnsupported(getVenue(id), "setup");
      if (id === null) {
        throw new PerpError("INVALID_PARAMS", `Invalid --default-venue "${defaultRaw}"`, {
          remediation: `Use one of: ${(venues.length > 0 ? venues : setupVenues().map(v => v.id)).join(", ")}`,
        });
      }
      if (venues.length > 0 && !venues.includes(id)) {
        throw new PerpError("INVALID_PARAMS", `--default-venue ${id} is not in --venues`, { remediation: `Use one of: ${venues.join(", ")}` });
      }
      defaultVenue = id;
    } else if (venues.length === 1) {
      defaultVenue = venues[0];
    }

    const defaultSlippageBps = opts.slippageBps !== undefined
      ? parseSlippageSettingBps("defaultSlippageBps", opts.slippageBps, maxDefaultSlippageBps())
      : null;
    const venueSlippage = parseVenueSlippage(opts.slippage, network);

    if (opts.approveAgents && !opts.yes) {
      throw new PerpError("INVALID_PARAMS", "--approve-agents signs approvals with your master wallet and needs --yes", {
        remediation: "Re-run with --approve-agents --yes",
      });
    }
    if (opts.approveAgents && venues.length === 0) {
      throw new PerpError("INVALID_PARAMS", "--approve-agents needs --venues", { remediation: "Pass --venues <list>" });
    }
    // Ondo in --import-agents is read from the shared stdin instead of --ondo-secret-stdin.
    const ondoImported = opts.importAgents !== undefined && parseVenueList(opts.importAgents, network).includes("ondo");
    const approvingOndo = opts.approveAgents === true && venues.includes("ondo") && !ondoImported;
    if (opts.ondoSecretStdin && !approvingOndo) {
      throw new PerpError("INVALID_PARAMS", "--ondo-secret-stdin is only used with --approve-agents and ondo in --venues", {
        remediation: "Add --approve-agents --yes --venues ondo,... or drop --ondo-secret-stdin",
      });
    }
    if (approvingOndo && !opts.ondoSecretStdin) {
      throw new PerpError("INVALID_PARAMS", "Ondo agent registration reads the API key from stdin", {
        remediation: "printf '%s\\n%s\\n' \"$KEY_ID\" \"$SECRET\" | perp setup --non-interactive ... --ondo-secret-stdin",
      });
    }
    // Raw slots are what an --import-agents key uses (the website picked them); an approve slot must be 4-254.
    const lighterSlotRaw = parseSlotFlag("--lighter-api-key-index", opts.lighterApiKeyIndex);
    const lighterRhSlotRaw = parseSlotFlag("--lighter-rh-api-key-index", opts.lighterRhApiKeyIndex);
    const importsVenue = (v: VenueId): boolean => opts.importAgents !== undefined && parseVenueList(opts.importAgents, network).includes(v);
    const lighterSlot = importsVenue("lighter") ? null : lighterSlotRaw;
    if (lighterSlot !== null) assertLighterSlot("lighter", lighterSlot);
    const lighterRhSlot = importsVenue("lighter-rh") ? null : lighterRhSlotRaw;
    if (lighterRhSlot !== null) assertLighterSlot("lighter-rh", lighterRhSlot);
    const arcusAccountIndex = parseSlotFlag("--arcus-account-index", opts.arcusAccountIndex);
    if (arcusAccountIndex !== null && !((arcusAccountIndex >= 0 && arcusAccountIndex <= 9) || arcusAccountIndex === 255)) {
      throw new PerpError("INVALID_PARAMS", `--arcus-account-index must be 0-9 or 255 (got ${arcusAccountIndex})`);
    }

    // ── Website-created keys (--import-agents): validated here, keys read from stdin below ──
    const importVenues = opts.importAgents !== undefined ? parseVenueList(opts.importAgents, network) : [];
    if (importVenues.length > 0) {
      if (!opts.yes) {
        throw new PerpError("INVALID_PARAMS", "--import-agents stores and live-checks the given keys and needs --yes", { remediation: "Re-run with --import-agents <venues> --yes" });
      }
      const outside = importVenues.filter(v => !venues.includes(v));
      if (outside.length > 0) {
        throw new PerpError("INVALID_PARAMS", `--import-agents venue(s) not in --venues: ${outside.join(", ")}`, { remediation: "List every imported venue in --venues too" });
      }
      if (opts.ondoSecretStdin) {
        throw new PerpError("INVALID_PARAMS", "--ondo-secret-stdin cannot be combined with --import-agents (both read stdin)", {
          remediation: "Put ondo in --import-agents (its key id + secret are its 2 stdin lines)",
        });
      }
      if (process.stdin.isTTY === true) {
        throw new PerpError("INVALID_PARAMS", "--import-agents reads the keys from stdin, but stdin is a terminal", {
          remediation: "Pipe the keys, one line per --import-agents venue in order (ondo: key id, secret): printf '%s\\n' \"$HL_AGENT_KEY\" \"$LT_KEY\" | perp setup --non-interactive ... --import-agents hyperliquid,lighter --yes",
        });
      }
    }
    // M3: a venue whose key cannot be checked is stored only with explicit consent.
    const allowUnverified = opts.allowUnverified !== undefined ? parseVenueList(opts.allowUnverified, network) : [];
    const strayAllow = allowUnverified.filter(v => !importVenues.includes(v));
    if (strayAllow.length > 0) {
      throw new PerpError("INVALID_PARAMS", `--allow-unverified ${strayAllow.join(",")}: not in --import-agents`, { remediation: "List only --import-agents venues in --allow-unverified" });
    }
    const unverifiedNotAllowed = importVenues.filter(v => UNVERIFIED_IMPORT_VENUES.includes(v) && !allowUnverified.includes(v));
    if (unverifiedNotAllowed.length > 0) {
      throw new PerpError("INVALID_PARAMS", `--import-agents ${unverifiedNotAllowed.join(",")}: the key cannot be checked against the venue and would be stored UNVERIFIED`, {
        remediation: `Accept that explicitly with --allow-unverified ${unverifiedNotAllowed.join(",")} (it is removed again if another import in the batch fails), or import it alone: perp wallet agent import ${unverifiedNotAllowed[0]}`,
      });
    }
    const masterAddresses = parseVenueAddresses(opts.masterAddress, network);
    for (const v of Object.keys(masterAddresses) as VenueId[]) {
      if (!importVenues.includes(v)) throw new PerpError("INVALID_PARAMS", `--master-address ${v}=… is only used for --import-agents venues`);
    }
    const lighterAccount = parseSlotFlag("--lighter-account-index", opts.lighterAccountIndex);
    const lighterRhAccount = parseSlotFlag("--lighter-rh-account-index", opts.lighterRhAccountIndex);
    const qfexAccountId = opts.qfexAccountId === undefined ? null : opts.qfexAccountId;
    if (qfexAccountId !== null && !importVenues.includes("qfex")) {
      throw new PerpError("INVALID_PARAMS", "--qfex-account-id is only used with qfex in --import-agents");
    }
    if (importVenues.includes("qfex") && qfexAccountId === null) {
      throw new PerpError("INVALID_PARAMS", "--import-agents qfex needs --qfex-account-id <uuid>: the account the key trades must be named explicitly", {
        remediation: "Find the account id in the QFEX web app (or run `perp wallet agent import qfex` in a terminal, which shows it for confirmation)",
      });
    }
    const approveVenues = opts.approveAgents === true ? venues.filter(v => !importVenues.includes(v)) : [];

    if (opts.wallet !== undefined && opts.walletName !== undefined) {
      throw new PerpError("INVALID_PARAMS", "Pass either --wallet <existing> or --wallet-name <new>, not both");
    }
    // No master wallet on this computer is fine when every agent comes from the website.
    const noMaster = opts.wallet === undefined && opts.walletName === undefined;
    if (noMaster && (importVenues.length === 0 || approveVenues.length > 0)) {
      throw new PerpError("INVALID_PARAMS", "No master wallet given", {
        remediation: "Pass --wallet <existing OWS wallet> (see: perp wallet list) or --wallet-name <new name> — or, without a master on this computer, import website-created keys for every venue: --import-agents <venues> --yes",
      });
    }

    // ── Passphrase: needed to create a wallet or sign approvals (Ondo / imports sign nothing) ──
    const needsPassphrase = opts.walletName !== undefined || approveVenues.some(v => v !== "ondo");
    let passphrase: string | null = null;
    if (needsPassphrase) {
      if ((opts.ondoSecretStdin || importVenues.length > 0) && opts.passphrase === undefined && !("OWS_PASSPHRASE" in process.env)) {
        throw new PerpError("PASSPHRASE_REQUIRED", "stdin carries the keys, so the passphrase must come from --passphrase or OWS_PASSPHRASE", {
          remediation: "Set OWS_PASSPHRASE or pass --passphrase",
        });
      }
      // resolvePassphrase already throws PASSPHRASE_REQUIRED when stdin is
      // non-TTY and nothing was provided. In TTY mode it returns null —
      // non-interactive mode must NOT fall back to a prompt.
      passphrase = await resolvePassphrase({ flag: opts.passphrase });
      if (passphrase === null) {
        throw new PerpError("PASSPHRASE_REQUIRED", "Non-interactive setup requires a passphrase", {
          remediation: "Provide --passphrase <pp> or set OWS_PASSPHRASE env var",
        });
      }
    }

    // ── Imported keys: read all stdin lines now (before any side effect) ──
    const importSecrets = new Map<VenueId, ImportSecret>();
    if (importVenues.length > 0) {
      const lines = (await readSetupStdin()).split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
      const want = importVenues.reduce((n, v) => n + importSecretLineCount(v), 0);
      if (lines.length !== want) {
        throw new PerpError("INVALID_PARAMS", `--import-agents ${importVenues.join(",")} expects ${want} line(s) on stdin (one per venue in order; ondo: key id, then secret; qfex: public key, then secret); got ${lines.length}`, {
          remediation: "Pipe exactly one key line per venue, in --import-agents order",
        });
      }
      let at = 0;
      for (const v of importVenues) {
        const n = importSecretLineCount(v);
        importSecrets.set(v, importSecretFromLines(v, lines.slice(at, at + n)));
        at += n;
      }
      assertDistinctImportSecrets([...importSecrets.entries()]);
    }

    // ── Master wallet ──
    const ows = loadOws();
    let wallet: { name: string; id: string; accounts: unknown[] } | null;
    let created: boolean;
    if (noMaster) {
      wallet = null;
      created = false;
    } else if (opts.walletName !== undefined) {
      wallet = ows.createWallet(opts.walletName, passphrase);
      created = true;
    } else {
      const name = opts.wallet as string;
      const found = ows.listWallets().find(w => w.name === name);
      if (!found) {
        throw new PerpError("KEY_NOT_FOUND", `OWS wallet "${name}" not found`, {
          remediation: "List wallets with: perp wallet list (or create one with --wallet-name <name>)",
        });
      }
      wallet = found;
      created = false;
    }

    // ── Settings ──
    const settings = applySetupSettings({
      owsActiveWallet: wallet !== null ? wallet.name : null,
      defaultExchange: defaultVenue,
      defaultSlippageBps,
      slippageBps: venueSlippage,
    });

    // ── Agents ──
    const agents: AgentStepResult[] = [];
    for (const venue of importVenues) {
      try {
        const outcome = await importVenueAgent({
          venue, network, agentName: null,
          masterAddress: masterAddresses[venue] ?? null,
          accountIndex: venue === "lighter" ? lighterAccount : venue === "lighter-rh" ? lighterRhAccount : venue === "arcus" ? arcusAccountIndex : null,
          apiKeyIndex: venue === "lighter" ? lighterSlotRaw : venue === "lighter-rh" ? lighterRhSlotRaw : null,
          expiresIn: null, replace: false,
          secret: importSecrets.get(venue) as ImportSecret,
          accountId: venue === "qfex" ? qfexAccountId : null,
          // Non-interactive: only the explicitly named account counts as confirmed.
          confirmAccount: venue !== "qfex" ? null : async binding => {
            if (qfexAccountId !== null && qfexAccountId.toLowerCase() === binding.accountId) return true;
            throw new PerpError("INVALID_PARAMS", `QFEX key resolves to account ${binding.accountId}, not --qfex-account-id ${String(qfexAccountId)}`, {
              remediation: `Re-run with --qfex-account-id ${binding.accountId} if that is the account you intend to trade`,
            });
          },
        });
        agents.push({ venue, status: "imported", agentName: outcome.agentName, verification: outcome.verification });
      } catch (err) {
        agents.push(failed(venue, err));
      }
    }
    // M3: one failed import → the batch's UNVERIFIED imports are removed again (never left behind
    // unchecked while the user is fixing the batch).
    const failedImports = agents.filter(a => a.status === "failed").map(a => a.venue);
    if (failedImports.length > 0) {
      for (let i = 0; i < agents.length; i++) {
        const a = agents[i];
        if (a.status !== "imported" || a.verification.status !== "unverified") continue;
        const meta = getAgent(a.venue, a.agentName);
        if (meta !== null) await deleteImportedAgentLocal(a.venue, network, meta);
        agents[i] = failed(a.venue, new PerpError("APPROVE_FAILED", `${a.venue} key "${a.agentName}" was stored UNVERIFIED and has been removed again because ${failedImports.join(", ")} failed in the same batch`, {
          remediation: `Re-run the whole batch once ${failedImports.join(", ")} is fixed`,
        }));
      }
    }
    if (wallet !== null && approveVenues.length > 0) {
      for (const venue of approveVenues) {
        const blocker = approveBlocker(venue, network);
        if (blocker !== null) {
          agents.push({ venue, status: "skipped", reason: blocker });
          continue;
        }
        try {
          const outcome = await approveVenueAgent({
            venue, network, master: (wallet as { name: string }).name, agentName: null, expiresIn: "90d",
            canPerp: true, canSpot: venue === "aster" && opts.asterCanSpot === true, canWithdraw: false,
            rotate: false, passphrase,
            apiKeyIndex: venue === "lighter" ? lighterSlot : venue === "lighter-rh" ? lighterRhSlot : null,
            forceSlot: false,
            accountIndex: arcusAccountIndex !== null ? arcusAccountIndex : 0,
            aster: {},
            ondoKey: null, // venue === "ondo" → read from stdin (--ondo-secret-stdin)
          });
          agents.push({ venue, status: "approved", agentName: "meta" in outcome ? outcome.meta.agentName : outcome.agentName });
        } catch (err) {
          agents.push(failed(venue, err));
        }
      }
    }

    const data = {
      mode: "non-interactive" as const,
      walletName: wallet !== null ? wallet.name : null,
      walletId: wallet !== null ? wallet.id : null,
      walletCreated: created,
      accounts: wallet !== null ? wallet.accounts : [],
      owsActiveWallet: settings.owsActiveWallet,
      network,
      venues,
      defaultExchange: settings.defaultExchange === "" ? null : settings.defaultExchange,
      defaultSlippageBps: settings.defaultSlippageBps,
      slippageBps: settings.slippageBps,
      agents,
      warnings: agents.some(a => a.status === "imported") ? [IMPORT_KEY_WARNING] : [],
      legacyEnvKeys: legacyEnvKeyNames(),
      nextSteps: nextStepCommands(venues, network),
    };
    const failures = agents.filter(a => a.status === "failed");
    if (failures.length > 0) {
      throw new PerpError("APPROVE_FAILED", `Agent registration failed for: ${failures.map(f => f.venue).join(", ")} (settings were saved)`, {
        result: data,
        remediation: `Fix the reported error, then: perp wallet agent ${failures.every(f => importVenues.includes(f.venue)) ? "import" : "approve"} <venue>`,
      });
    }

    if (isJson) {
      printJson(jsonOk(data));
      return;
    }

    console.log(chalk.cyan.bold("\n  perp-cli Setup (non-interactive) — Done\n"));
    console.log(`  Wallet:           ${wallet !== null ? `${chalk.white.bold(wallet.name)}${created ? chalk.gray(" (created)") : ""}` : chalk.gray("none on this computer (imported keys only)")}`);
    console.log(`  Active wallet:    ${chalk.cyan(settings.owsActiveWallet)}`);
    console.log(`  Network:          ${network}`);
    if (venues.length > 0) console.log(`  Venues:           ${venues.join(", ")}`);
    if (settings.defaultExchange) console.log(`  Default exchange: ${chalk.cyan(settings.defaultExchange)}`);
    console.log(`  Slippage:         ${settings.defaultSlippageBps} bps default${Object.entries(settings.slippageBps).map(([v, b]) => `, ${v} ${b}`).join("")}`);
    for (const a of agents) {
      const text = a.status === "approved" ? chalk.green(`agent ${a.agentName}`)
        : a.status === "imported" ? (a.verification.status === "verified"
          ? chalk.green(`imported ${a.agentName} (verified)`)
          : chalk.yellow(`imported ${a.agentName} — NOT verified: ${a.verification.method}`))
          : chalk.gray(`skipped — ${a.status === "skipped" ? a.reason : ""}`);
      console.log(`  ${a.venue.padEnd(17)} ${text}`);
    }
    if (importVenues.length > 0) {
      console.log(chalk.gray(`\n  ${IMPORT_SCOPE_NOTE}`));
      console.log(chalk.yellow(`  [warn] ${IMPORT_KEY_WARNING}`));
    }
    if (data.legacyEnvKeys.length > 0) {
      console.log(chalk.yellow(`\n  ⚠ ${ENV_FILE} holds raw private keys (${data.legacyEnvKeys.join(", ")}); consider moving them to the OWS vault (perp wallet import).`));
    }
    console.log(chalk.gray(`\n  Vault: ~/.ows/ (AES-256-GCM encrypted)`));
    console.log(chalk.white.bold("\n  Next steps:"));
    for (const c of data.nextSteps) console.log(`    ${chalk.green(c)}`);
    console.log();
  } catch (err) {
    if (isJson) {
      if (err instanceof PerpError) {
        printJson(
          jsonError(err.structured.code, err.structured.message, {
            ...(err.structured.remediation || err.structured.details
              ? { details: { ...err.structured.details, ...(err.structured.remediation ? { remediation: err.structured.remediation } : {}) } }
              : {}),
          }),
        );
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        printJson(jsonError("UNKNOWN", msg));
      }
      process.exitCode = 1;
      return;
    }
    if (err instanceof PerpError) {
      console.error(chalk.red(`\n  Error [${err.structured.code}]: ${err.structured.message}`));
      if (err.structured.remediation) {
        console.error(chalk.gray(`  Remediation: ${err.structured.remediation}\n`));
      }
      const result = err.structured.details?.result as { agents?: AgentStepResult[] } | undefined;
      for (const a of result?.agents ?? []) {
        if (a.status === "failed") console.error(chalk.red(`  ${a.venue}: [${a.error.code}] ${a.error.message}`));
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`\n  Error: ${msg}\n`));
    }
    process.exitCode = 1;
  }
}

