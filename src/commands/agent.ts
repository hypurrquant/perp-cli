import { Command, Option } from "commander";
import { networkOf } from "../cli-flags.js";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { printJson, jsonOk } from "../utils.js";
import { PerpError, classifyError } from "../errors.js";
import chalk from "chalk";
import bs58 from "bs58";
import { loadSettings, type AgentMeta, type OndoAgentMeta, type ArcusAgentMeta, type QfexAgentMeta, type RisexAgentMeta, type TxflowAgentMeta } from "../settings.js";
import {
  getAgent, setAgent, deleteAgent, listAgents, acquireLock, releaseLock,
  getVenueAgent, getVenueAgentForNetwork, setVenueAgent, deleteVenueAgent, listVenueAgents,
  agentNetworkOf, recordedAgentNetworkOf, assertAgentNetwork, getAgentForNetwork, agentSourceOf,
} from "../agent-wallet/store.js";
import { getVenue, networkConfig, resolveVenueId, roleUnsupported } from "../exchanges/venue.js";
import { RISEX_APP_URL } from "../exchanges/venues/risex.js";
import { listConfiguredAccountVenues } from "../config.js";
import "../exchanges/venues/index.js";
import type { Network, VenueId } from "../exchanges/venue-types.js";
import { LIGHTER_RH_RESERVED_KEY_INDEXES, type LighterVenueId } from "../exchanges/venues/lighter-family.js";
import { HL_USER_SIGNED } from "../exchanges/venues/hyperliquid.js";
import { unsupported } from "../exchanges/trading-v2.js";
import { resolvePassphrase } from "../agent-wallet/passphrase.js";
import { OwsEvmSigner } from "../signer/ows-evm.js";
import { OwsSolanaSigner } from "../signer/ows-solana.js";
import { loadOws } from "../signer/ows-loader.js";
import {
  ASTER_DOMAIN_A,
  buildApproveAgentTypedData,
  buildDelAgentTypedData,
} from "../exchanges/aster-typed-data.js";

/**
 * Subcommand `--passphrase <pp>`: still accepted (existing scripts) but deprecated like the root
 * flag — hidden from help, and a stderr warning when it was given on the command line (it is
 * visible in ps / shell history). Use with `.hook("preAction", warnDeprecatedPassphrase)`.
 */
export function deprecatedPassphraseOption(what: string = "Master OWS passphrase", flags: string = "--passphrase <pp>"): Option {
  return new Option(flags, `DEPRECATED (visible in ps / shell history) — ${what}; prefer OWS_PASSPHRASE env or stdin`).hideHelp();
}

export const ARGV_PASSPHRASE_WARNING = "[warn] --passphrase on the command line is DEPRECATED and visible in ps / shell history. Use the OWS_PASSPHRASE env var or pipe it on stdin.\n";

/** preAction hook paired with deprecatedPassphraseOption(): warns once per command run. */
export function warnDeprecatedPassphrase(cmd: Command): void {
  if (cmd.getOptionValueSource("passphrase") === "cli") process.stderr.write(ARGV_PASSPHRASE_WARNING);
}

/**
 * Emit a structured JSON error envelope to stdout and exit non-zero.
 * Stdout (not stderr) so machine consumers can read the envelope from a
 * single stream — matches the rest of the CLI's --json error path.
 */
function reportErrorAndExit(err: unknown): never {
  const ts = new Date().toISOString();
  // Route through the central classifier so generic Errors thrown from
  // dependencies (e.g. NAPI "decryption failed: aead::Error" from OWS vault
  // unlock) get a meaningful code + remediation instead of a bare UNKNOWN.
  // PerpError instances pass through unchanged via classifyError's first
  // branch so explicitly typed errors keep their structured shape.
  const envelope = { ok: false, error: classifyError(err), meta: { timestamp: ts } };
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exit(1);
}


export function isLighterFamilyVenue(v: VenueId): v is LighterVenueId {
  return getVenue(v).family === "lighter";
}

/** Validate an explicit Lighter-family API key slot: 4..254, minus venue-reserved indexes. */
export function assertLighterSlot(venue: LighterVenueId, n: number): void {
  if (!Number.isInteger(n) || n < 4 || n > 254) {
    throw new PerpError("INVALID_PARAMS", `--api-key-index must be an integer in [4, 254]; got ${n}`, {
      remediation: "Slots 0-3 are reserved by the Lighter frontend. Use 4-254.",
    });
  }
  if (venue === "lighter-rh" && LIGHTER_RH_RESERVED_KEY_INDEXES.includes(n)) {
    throw new PerpError("INVALID_PARAMS", `Lighter RH API key index ${n} is reserved (${LIGHTER_RH_RESERVED_KEY_INDEXES.join(", ")})`, {
      remediation: "Use an index in 4-254 other than 157.",
    });
  }
}

/** Read one line from a TTY without echo (raw mode). */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          cleanup();
          process.stdout.write("\n");
          resolve(buf);
          return;
        }
        if (c === "\u0003") {
          cleanup();
          reject(new PerpError("INVALID_PARAMS", "Cancelled"));
          return;
        }
        if (c === "\u007f" || c === "\b") {
          buf = buf.slice(0, -1);
          continue;
        }
        buf += c;
      }
    };
    stdin.on("data", onData);
  });
}

/** Read all of a piped (non-TTY) stdin. */
function readPipedStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c: string | Buffer) => chunks.push(typeof c === "string" ? c : c.toString("utf-8")));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

/**
 * Ondo API key id + secret, from stdin only (never flags).
 * TTY: key id prompt, then hidden secret prompt. Piped: line 1 = key id, line 2 = secret.
 */
/** Lighter ChangePubKey settlement window when confirming a slot (docs example: 30 s, 1 s apart; kept under the 60 req/min budget). */
const LIGHTER_SLOT_CONFIRM_TIMEOUT_MS = 30_000;
const LIGHTER_SLOT_CONFIRM_POLL_MS = 3_000;

async function readOndoKeyFromStdin(): Promise<{ keyId: string; secret: string }> {
  if (process.stdin.isTTY === true) {
    const rl = createInterface({ input, output });
    let keyId: string;
    try {
      keyId = (await rl.question("Ondo API key id (ondoKeyId_…): ")).trim();
    } finally {
      rl.close();
    }
    const secret = (await promptHidden("Ondo API secret (hidden): ")).trim();
    return { keyId, secret };
  }
  const lines = (await readPipedStdin()).split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length !== 2) {
    throw new PerpError("INVALID_PARAMS", `Expected 2 lines on stdin (key id, secret); got ${lines.length}`, {
      remediation: "printf '%s\\n%s\\n' \"$KEY_ID\" \"$SECRET\" | perp wallet agent approve ondo",
    });
  }
  return { keyId: lines[0], secret: lines[1] };
}

const _require = createRequire(import.meta.url);
const _pkg = _require("../../package.json") as { version: string };

// ── Verify helper types ───────────────────────────────────────────────────

interface VerifyOpts {
  agentName?: string;
  master?: string;
  masterAddress?: string;
  accountIndex?: string;
  passphrase?: string;
}

export interface VerifyResult {
  registered: boolean;
  count: number;
  items: unknown[];
  warnings?: string[];
}

// ── Per-DEX verify implementations ───────────────────────────────────────

async function verifyAster(_opts: VerifyOpts): Promise<VerifyResult> {
  // No-fallback policy (CLAUDE.md SSOT rule #2): Aster has no verified
  // master-signing path for `/fapi/v3/agent`. The HypurrQuant_FE reference
  // confirms Aster has no REST endpoint to list approved agents at all —
  // master signing is used only for one-time approveAgent/approveBuilder.
  //
  // Returning local cache as if it were verified live state would be a
  // fallback (silent substitution masquerading as success). The SSOT rule
  // bans that pattern: failure must propagate, not get hidden behind a
  // synthesized success envelope. Throw NOT_IMPLEMENTED with explicit
  // remediation pointing to local-cache surfaces.
  throw new PerpError(
    "NOT_IMPLEMENTED",
    "Aster live agent verify is not supported (no verified master-signing path; FE reference also lacks this endpoint).",
    {
      remediation: "Use 'perp wallet agent list aster' to inspect local cache, or 'perp wallet agent rotate aster <name>' to refresh on-chain.",
    },
  );
}

/**
 * Verify Hyperliquid agent registration.
 *
 * Cross-check (AC-28, v3.4): When agentName provided AND persisted in
 * settings.agents.hyperliquid[name], asserts live response contains expected
 * agentEvmAddress. Mismatch → meta.warnings populated (non-fatal).
 */
async function verifyHyperliquid(network: Network, opts: VerifyOpts): Promise<VerifyResult> {
  // The named agent must belong to the selected network; otherwise use the
  // first agent registered on it (a mainnet agent is never checked on testnet).
  const namedMeta = opts.agentName !== undefined ? getAgent("hyperliquid", opts.agentName) : null;
  if (namedMeta !== null) assertAgentNetwork("hyperliquid", namedMeta, network);
  // Resolve master EVM address: flag > named agent's userEvmAddress > first agent on this network
  // > the selected OWS master wallet's EVM account
  let masterAddress = opts.masterAddress;
  if (!masterAddress) {
    const meta = namedMeta ?? getAgentForNetwork("hyperliquid", network);
    if (meta?.userEvmAddress) masterAddress = meta.userEvmAddress;
  }
  if (!masterAddress) {
    // No local agent record (e.g. right after a revoke): the selected OWS master wallet
    // (--master, else the active wallet) names the account. Reading its address needs no passphrase.
    const masterName = opts.master ?? loadSettings().owsActiveWallet;
    if (masterName) masterAddress = OwsEvmSigner.create(masterName).getAddress();
  }
  if (!masterAddress) {
    throw new PerpError("INVALID_PARAMS", "Master EVM address required for Hyperliquid verify: no local agent record and no OWS master wallet is selected. Use --master-address.", {
      remediation: "perp wallet agent verify hyperliquid --master-address 0xYOUR_ADDRESS (or select the master wallet: --master <walletName>)",
    });
  }

  const user = masterAddress.toLowerCase();
  const resp = await fetch(`${networkConfig(getVenue("hyperliquid"), network).restUrl}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "extraAgents", user }),
  });

  if (!resp.ok) {
    throw new PerpError("EXCHANGE_ERROR", `Hyperliquid verify failed: HTTP ${resp.status}`, {
      remediation: "Check master EVM address. Run: perp wallet agent verify hyperliquid --master-address 0xADDR",
    });
  }

  const data = await resp.json() as unknown;
  const items = Array.isArray(data) ? data : [];
  const warnings: string[] = [];

  // Cross-check: AC-28 — verify persisted agentEvmAddress matches live response
  if (opts.agentName) {
    const agentMeta = namedMeta;
    if (agentMeta?.agentEvmAddress) {
      const expected = agentMeta.agentEvmAddress.toLowerCase();
      const found = items.some(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "address" in item &&
          typeof (item as Record<string, unknown>).address === "string" &&
          ((item as Record<string, unknown>).address as string).toLowerCase() === expected,
      );
      if (!found) {
        warnings.push(
          `Agent "${opts.agentName}" (expected address ${agentMeta.agentEvmAddress}) not found in Hyperliquid live response.`,
        );
      }
    }
  }

  return { registered: items.length > 0, count: items.length, items, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * Verify Pacifica agent registration — POST /agent/list, master-signed.
 *
 * Mirrors the official SDK `list_agent_wallets` (pacifica-fi/python-sdk
 * rest/api_agent_keys_detailed.py): the signed message nests an EMPTY payload
 * under `data` ({"data":{},"expiry_window":…,"timestamp":…,"type":"list_agent_wallets"}),
 * and the request body is `{account, agent_wallet: null, signature, timestamp,
 * expiry_window}` — no `type` field. The earlier `list_api_keys` →
 * /account/api_keys shape signed a header without `data` and was rejected
 * live with "signature does not match signer and canonical payload".
 *
 * When an agent record exists for this network (named, or the first one),
 * `registered` reflects whether ITS agent pubkey is in the live list.
 */
async function verifyPacifica(network: Network, opts: VerifyOpts): Promise<VerifyResult> {
  const settings = loadSettings();
  const masterName = opts.master ?? settings.owsActiveWallet;
  if (!masterName) {
    // Pacifica lists agent bindings only via a master-signed request (no agent-signed read exists).
    throw new PerpError("NO_SIGNER_AVAILABLE", "Pacifica agent verify is signed by the master wallet, and none is configured on this computer", {
      remediation: "Check the agent on the Pacifica website (API keys), or add the master wallet and run: perp wallet agent verify pacifica --master <walletName>",
    });
  }
  const namedMeta = opts.agentName !== undefined ? getAgent("pacifica", opts.agentName) : null;
  if (namedMeta !== null) assertAgentNetwork("pacifica", namedMeta, network);
  const expectedMeta = namedMeta ?? getAgentForNetwork("pacifica", network);
  const expectedAgent = expectedMeta?.agentSolanaAddress ?? null;

  const passphrase = opts.passphrase ?? "";
  const solanaSigner = OwsSolanaSigner.create(masterName, passphrase);
  const account = solanaSigner.getPublicKeyBase58();

  const { buildListAgentWalletsMessage } = await import("../exchanges/pacifica-typed-data.js");
  const built = buildListAgentWalletsMessage();
  const sigBytes = await solanaSigner.signMessage(new TextEncoder().encode(built.canonicalJson));

  const body = {
    account,
    agent_wallet: null as null,
    signature: bs58.encode(sigBytes),
    timestamp: built.header.timestamp,
    expiry_window: built.header.expiry_window,
  };

  const resp = await fetch(`${networkConfig(getVenue("pacifica"), network).restUrl}/agent/list`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new PerpError("EXCHANGE_ERROR", `Pacifica verify failed: HTTP ${resp.status}: ${text.slice(0, 200)}`, {
      remediation: "Check master wallet name and passphrase. Run: perp wallet agent verify pacifica --master <name> --passphrase $PP",
    });
  }

  const json = await resp.json() as unknown;
  const items = parsePacAgentList(json);
  const listed = items.map(pacAgentPubkeyOf);
  const warnings: string[] = [];
  if (expectedAgent !== null && expectedMeta !== null) {
    const found = listed.includes(expectedAgent);
    if (!found) {
      warnings.push(`Agent "${expectedMeta.agentName}" (${expectedAgent}) is not bound to ${account} on Pacifica ${network}.`);
    }
    return { registered: found, count: items.length, items, warnings: warnings.length > 0 ? warnings : undefined };
  }
  return { registered: items.length > 0, count: items.length, items };
}

/** Extract the agent list from a Pacifica /agent/list envelope; throws on an unrecognized shape. */
export function parsePacAgentList(json: unknown): unknown[] {
  if (json !== null && typeof json === "object") {
    const env = json as Record<string, unknown>;
    if (env.success === false) {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica verify rejected: ${JSON.stringify(env.error ?? env).slice(0, 200)}`, {
        remediation: "Check master wallet name and passphrase. Run: perp wallet agent verify pacifica --master <name>",
      });
    }
    const data = env.data;
    if (Array.isArray(data)) return data;
    if (data !== null && typeof data === "object" && Array.isArray((data as Record<string, unknown>).agent_wallets)) {
      return (data as Record<string, unknown>).agent_wallets as unknown[];
    }
  }
  throw new PerpError("EXCHANGE_ERROR", `Pacifica /agent/list returned an unrecognized shape: ${JSON.stringify(json).slice(0, 200)}`, {
    remediation: "Check the agent on the Pacifica website (API keys) and report the response shape.",
  });
}

/** Agent pubkey of one /agent/list entry (a bare base58 string or an object carrying it). */
function pacAgentPubkeyOf(item: unknown): string | null {
  if (typeof item === "string") return item;
  if (item !== null && typeof item === "object") {
    const o = item as Record<string, unknown>;
    for (const k of ["agent_wallet", "address", "public_key"]) {
      if (typeof o[k] === "string") return o[k] as string;
    }
  }
  return null;
}

/**
 * Verify Lighter agent registration.
 *
 * NOTE (v3.3 limitation): Cross-check semantics from AC-23 are inactive for
 * this DEX because settings.agents.lighter type slot does not exist yet
 * (AgentsByExchange has only `aster?`). When Phase 2d extends AgentsByExchange
 * + AgentMeta with per-DEX fields (accountIndex, publicKey, etc.), the
 * cross-check branch below becomes live.
 */
async function verifyLighter(venue: LighterVenueId, network: Network, opts: VerifyOpts): Promise<VerifyResult> {
  const accountIndexStr = opts.accountIndex;
  // Resolve accountIndex: flag > named agent > first agent on this network
  const namedMeta = opts.agentName !== undefined ? getAgent(venue, opts.agentName) : null;
  if (namedMeta !== null) assertAgentNetwork(venue, namedMeta, network);
  let accountIndex: number | undefined;
  if (accountIndexStr !== undefined) {
    accountIndex = parseInt(accountIndexStr, 10);
  } else {
    const meta = namedMeta ?? getAgentForNetwork(venue, network);
    if (meta?.accountIndex !== undefined) accountIndex = meta.accountIndex;
  }
  if (accountIndex === undefined || isNaN(accountIndex)) {
    throw new PerpError("INVALID_PARAMS", `Account index required for ${venue} verify. Use --account-index.`, {
      remediation: `perp wallet agent verify ${venue} --account-index <n>`,
    });
  }

  const restUrl = networkConfig(getVenue(venue), network).restUrl;
  const resp = await fetch(
    `${restUrl}/api/v1/apikeys?account_index=${accountIndex}`,
    { method: "GET" },
  );

  if (!resp.ok) {
    throw new PerpError("EXCHANGE_ERROR", `${venue} verify failed: HTTP ${resp.status}`, {
      remediation: `Check account index. Run: perp wallet agent verify ${venue} --account-index ${accountIndex}`,
    });
  }

  const data = await resp.json() as unknown;
  const apiKeys = (
    data &&
    typeof data === "object" &&
    "api_keys" in data
  )
    ? (data as Record<string, unknown>).api_keys
    : [];
  const items = Array.isArray(apiKeys) ? apiKeys : [];
  const warnings: string[] = [];

  // Cross-check if agentName provided
  if (opts.agentName) {
    const agentMeta = namedMeta;
    if (agentMeta?.publicKey) {
      const expected = agentMeta.publicKey;
      const found = items.some(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "public_key" in item &&
          (item as Record<string, unknown>).public_key === expected,
      );
      if (!found) {
        warnings.push(
          `Agent "${opts.agentName}" (expected public_key ${agentMeta.publicKey}) not found in ${venue} live response.`,
        );
      }
    }
  }

  return { registered: items.length > 0, count: items.length, items, warnings: warnings.length > 0 ? warnings : undefined };
}


/** Ondo: authenticate GET /v1/account with the stored key (proves the key is live). */
async function verifyOndo(network: Network, opts: VerifyOpts): Promise<VerifyResult> {
  const meta = getVenueAgent("ondo", opts.agentName);
  if (!meta) {
    throw new PerpError("AGENT_NOT_REGISTERED", "No Ondo Perps API key registered", { remediation: "perp wallet agent approve ondo" });
  }
  const { loadOndoCredentials } = await import("../exchanges/ondo/agent.js");
  const { OndoClient } = await import("../exchanges/ondo/client.js");
  const def = getVenue("ondo");
  const client = new OndoClient({
    restUrl: networkConfig(def, network).restUrl,
    network,
    rateLimit: def.rateLimit,
    credentials: loadOndoCredentials(meta.keyId),
  });
  const account = await client.get<{ accountID: string; accountState: string }>("/v1/account", null);
  return { registered: true, count: 1, items: [{ agentName: meta.agentName, keyId: meta.keyId, accountID: account.accountID, accountState: account.accountState }] };
}

/** Arcus: GET /v1/apiKeys?address=<owner> and cross-check the stored key. */
async function verifyArcus(network: Network, opts: VerifyOpts): Promise<VerifyResult> {
  const meta = getVenueAgent("arcus", opts.agentName);
  if (!meta) {
    throw new PerpError("AGENT_NOT_REGISTERED", "No Arcus API key registered", { remediation: "perp wallet agent approve arcus --master <ows-wallet>" });
  }
  const { listArcusApiKeys } = await import("../exchanges/arcus/agent.js");
  const keys = await listArcusApiKeys(network, meta.ownerAddress);
  const warnings: string[] = [];
  const hit = keys.find(k => k.apiKey.toLowerCase() === meta.apiKeyHex.toLowerCase());
  if (!hit) warnings.push(`Arcus key ${meta.apiKeyHex} ("${meta.agentName}") is not listed for ${meta.ownerAddress}`);
  else if (hit.status !== "ACTIVE") warnings.push(`Arcus key ${meta.apiKeyHex} status is ${hit.status}`);
  return { registered: keys.length > 0, count: keys.length, items: keys, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * QFEX: a signed read as the bound account (GET /user/positions) and a Trade WebSocket
 * authentication with that account. Read-only; nothing is cached from a denial.
 */
async function verifyQfex(network: Network, opts: VerifyOpts): Promise<VerifyResult> {
  const meta = opts.agentName !== undefined ? getVenueAgent("qfex", opts.agentName) : getVenueAgentForNetwork("qfex", network);
  if (!meta) {
    throw new PerpError("AGENT_NOT_REGISTERED", `No QFEX API key imported for ${network}`, { remediation: `perp${network === "testnet" ? " -n testnet" : ""} wallet agent import qfex` });
  }
  if (meta.network !== network) {
    throw new PerpError("AGENT_NOT_REGISTERED", `QFEX key "${meta.agentName}" was imported for ${meta.network}, not ${network}`, { remediation: `perp${meta.network === "testnet" ? " -n testnet" : ""} wallet agent verify qfex ${meta.agentName}` });
  }
  const { loadQfexCredentials } = await import("../exchanges/qfex/agent.js");
  const { QfexClient } = await import("../exchanges/qfex/client.js");
  const { QFEX_ENDPOINTS } = await import("../exchanges/venues/qfex.js");
  const { QfexTradeSession, QFEX_TIMEOUTS, QFEX_IDLE_CLOSE_MS } = await import("../exchanges/qfex/ws-transport.js");
  const credentials = loadQfexCredentials(meta.publicKey);
  const ep = QFEX_ENDPOINTS[network];
  const client = new QfexClient({ restUrl: ep.rest, bankerUrl: ep.banker, network, credentials, accountId: meta.accountId });
  await client.get("/user/positions", null);
  await new QfexTradeSession({
    url: ep.tradeWs, network, credentials, accountId: meta.accountId, builderCode: null,
    rateLimit: getVenue("qfex").rateLimit, timeouts: QFEX_TIMEOUTS, idleCloseMs: QFEX_IDLE_CLOSE_MS,
  }).verifyAuth();
  return {
    registered: true, count: 1,
    items: [{ agentName: meta.agentName, publicKey: meta.publicKey, accountId: meta.accountId, isPrimaryAccount: meta.isPrimaryAccount, network: meta.network, checks: "signed GET /user/positions as the account; Trade WebSocket authentication" }],
  };
}

/**
 * Confirmation of the account a QFEX key was resolved to. In a terminal: a
 * y/N prompt showing the UUID. Without one (piped stdin, --json): only an explicit --account-id
 * that equals the resolved account counts — the resolved UUID is printed on stderr either way.
 */
export function confirmImportAccount(explicitAccountId: string | null, json: boolean): (binding: { accountId: string; isPrimaryAccount: boolean; method: string }) => Promise<boolean> {
  return async binding => {
    const what = `QFEX account ${binding.accountId} (${binding.isPrimaryAccount ? "primary" : "subaccount"})`;
    process.stderr.write(`  This key will trade ${what} — ${binding.method}\n`);
    if (explicitAccountId !== null && explicitAccountId.toLowerCase() === binding.accountId) return true;
    if (json || process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
      throw new PerpError("INVALID_PARAMS", `QFEX import needs the account confirmed: the key resolves to ${what}`, {
        remediation: `Re-run with that account named explicitly: perp wallet agent import qfex --account-id ${binding.accountId}`,
      });
    }
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const a = (await rl.question(`  Store the key for ${what}? [y/N]: `)).trim().toLowerCase();
      return a === "y" || a === "yes";
    } finally {
      rl.close();
    }
  };
}

/** RISEx: session-key status on the venue and the on-chain permission bitmap (read-only). */
async function verifyRisex(network: Network, opts: VerifyOpts): Promise<VerifyResult> {
  const meta = opts.agentName !== undefined ? getVenueAgent("risex", opts.agentName) : getVenueAgentForNetwork("risex", network);
  // Read-only release (trading role gated): approve / revoke are refused, so point to the RISEx app.
  const tradingGated = !getVenue("risex").roles.includes("trading");
  if (!meta) {
    throw new PerpError("AGENT_NOT_REGISTERED", `No RISEx signer registered for ${network}`, {
      remediation: tradingGated
        ? `RISEx is read-only in this perp-cli release (trading in a later release): manage signers in the RISEx app (${RISEX_APP_URL})`
        : `perp${network === "testnet" ? " -n testnet" : ""} wallet agent approve risex --master <ows-wallet>`,
    });
  }
  const { verifyRisexAgent } = await import("../exchanges/risex/agent.js");
  const v = await verifyRisexAgent(meta);
  const warnings: string[] = [];
  if (!v.active) warnings.push(`RISEx signer ${meta.signerAddress} status is ${String(v.status)} (1 = Active)`);
  if (v.expired) warnings.push(`RISEx signer ${meta.signerAddress} expired at ${meta.expiresAt}`);
  if (v.active && (!v.tradingOnly || meta.permissions.tradingOnly !== true)) {
    // An active signer that can do more than trade is a failure, never ok:true.
    throw new PerpError("POLICY_DENIED", `RISEx signer ${meta.signerAddress} ("${meta.agentName}") is NOT restricted to trading-only (on-chain ${JSON.stringify(v.permissions)}, bitmap ${String(v.bitmap)}; recorded tradingOnly=${String(meta.permissions.tradingOnly)})${v.reason !== null ? ` — ${v.reason}` : ""}`, {
      exchange: "risex", signer: meta.signerAddress, permissions: v.permissions, bitmap: v.bitmap,
      remediation: tradingGated
        ? `Revoke it in the RISEx app (${RISEX_APP_URL}); then remove the local record: perp${network === "testnet" ? " -n testnet" : ""} wallet agent revoke risex ${meta.agentName} --force`
        : `Revoke it: perp${network === "testnet" ? " -n testnet" : ""} wallet agent revoke risex ${meta.agentName}, then approve a new one`,
    });
  }
  return {
    registered: v.active, count: 1,
    items: [{ agentName: meta.agentName, signer: meta.signerAddress, account: meta.accountAddress, network: meta.network, status: v.status, permissions: v.permissions, tradingOnly: v.tradingOnly, expiresAt: meta.expiresAt }],
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** TxFlow: agentOwner / approvedAgents (read-only) — the agent is authorized for its account under its label. */
async function verifyTxflow(network: Network, opts: VerifyOpts): Promise<VerifyResult> {
  const meta = opts.agentName !== undefined ? getVenueAgent("txflow", opts.agentName) : getVenueAgentForNetwork("txflow", network);
  const net = network === "testnet" ? " -n testnet" : "";
  if (!meta) {
    throw new PerpError("AGENT_NOT_REGISTERED", `No TxFlow agent registered for ${network}`, {
      remediation: `perp${net} wallet agent approve txflow --master <ows-wallet> (or import one created in the TxFlow web app: perp${net} wallet agent import txflow)`,
    });
  }
  if (meta.network !== network) {
    throw new PerpError("AGENT_NOT_REGISTERED", `TxFlow agent "${meta.agentName}" is registered on ${meta.network}, not ${network}`, {
      remediation: meta.network === "mainnet" ? "Run without -n testnet" : "Run with -n testnet",
    });
  }
  const { verifyTxflowAgent } = await import("../exchanges/txflow/agent.js");
  const v = await verifyTxflowAgent(meta);
  const warnings: string[] = [];
  if (!v.authorized) {
    warnings.push(v.owner === null
      ? `TxFlow agent ${meta.agentAddress} is NOT authorized by any account — approve it again: perp${net} wallet agent approve txflow${meta.source === "approved" ? " --rotate" : ""}`
      : `TxFlow agent ${meta.agentAddress} is authorized for ${v.owner}, not ${meta.accountAddress}`);
  }
  if (network === "mainnet") warnings.push("TxFlow mainnet trading is open to whitelisted accounts only (apply at https://txflow.com/apply); access is not readable in advance — the first order is refused (POLICY_DENIED) if the account is not whitelisted");
  return {
    registered: v.authorized, count: 1,
    items: [{ agentName: meta.agentName, agent: meta.agentAddress, account: meta.accountAddress, network: meta.network, source: meta.source, owner: v.owner, label: v.label }],
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/** Dispatch a verify to the venue-specific implementation. */
async function verifyVenue(ex: VenueId, network: Network, opts: VerifyOpts): Promise<VerifyResult> {
  if (ex === "aster") return verifyAster(opts);
  if (ex === "hyperliquid") return verifyHyperliquid(network, opts);
  if (ex === "pacifica") return verifyPacifica(network, opts);
  if (isLighterFamilyVenue(ex)) return verifyLighter(ex, network, opts);
  if (ex === "ondo") return verifyOndo(network, opts);
  if (ex === "arcus") return verifyArcus(network, opts);
  if (ex === "qfex") return verifyQfex(network, opts);
  if (ex === "risex") return verifyRisex(network, opts);
  if (ex === "txflow") return verifyTxflow(network, opts);
  throw new PerpError("NOT_IMPLEMENTED", `${ex} has no agents to verify`, {
    remediation: "perp wallet agent verify <aster|hyperliquid|pacifica|lighter|lighter-rh|ondo|arcus|qfex|risex|txflow> [agentName]",
  });
}

// ── Shared agent registration (used by `wallet agent approve` and `perp setup`) ──

/** Agent-management operation gated per venue/network. */
export type AgentOp = "approve" | "revoke" | "rotate";

/**
 * Why agent `op` cannot run for `venue` on `network`; null when it can. Every
 * other venue resolves endpoints / signing chain from the selected network
 * (venue definition) — never a mainnet fallback.
 *
 * Aster testnet: approve uses POST /fapi/v3/registerAndApproveAgent, documented
 * for testnet (asterdex/api-docs V3 aster-finance-futures-api-testnet.md,
 * 2026-05-12). Revoke / rotate need the master-signed DelAgent (AsterChain,
 * Domain A) flow, which the testnet docs do not document.
 */
export function agentApproveUnsupportedReason(venue: VenueId, network: Network, op: AgentOp): string | null {
  if (venue === "aster" && network === "testnet" && op !== "approve") {
    return "the testnet API documents only registerAndApproveAgent — no agent delete / rotate flow";
  }
  return null;
}

/** Throws the uniform CAPABILITY_UNSUPPORTED error when agentApproveUnsupportedReason() is non-null. */
export function assertAgentApproveSupported(venue: VenueId, network: Network, op: AgentOp): void {
  const def = getVenue(venue);
  if (!def.roles.includes("trading")) throw roleUnsupported(def, `agent ${op}`);
  if (venue === "qfex") {
    // Programmatic key creation needs a website session (SIWE + MFA) — not a CLI path.
    throw unsupported("qfex", "agentApprove", "API keys are created (and revoked) on the QFEX website, behind 2FA",
      `Create the key in QFEX Developer Settings, then import it: perp${network === "testnet" ? " -n testnet" : ""} wallet agent import qfex`);
  }
  const reason = agentApproveUnsupportedReason(venue, network, op);
  if (reason === null) return;
  throw unsupported(getVenue(venue).displayName, `agent ${op} on ${network}`, reason,
    "Revoke the testnet API agent at https://www.asterdex-testnet.com/en/api-wallet (Pro API), then approve a new one: perp -n testnet wallet agent approve aster");
}

/**
 * Aster master-signed Domain A structs (ApproveAgent / DelAgent) carry an
 * AsterChain field and are documented for mainnet only — refuse anything else.
 */
function assertAsterDomainAMainnet(network: Network): void {
  if (network === "mainnet") return;
  throw unsupported("Aster", `master-signed agent operations on ${network}`,
    "the AsterChain-bearing approveAgent / DelAgent structs are documented for mainnet only",
    "On testnet use: perp -n testnet wallet agent approve aster (registerAndApproveAgent)");
}

/** Default agent name per venue and network (the `--agent-name` default of `wallet agent approve`). */
export function defaultAgentName(venue: VenueId, network: Network): string {
  // Short suffix: Hyperliquid limits agent names to 16 characters ("perp-cli-hl-tn" = 14).
  const suffix = network === "testnet" ? "-tn" : "";
  switch (venue) {
    case "aster": return `perp-cli-aster${suffix}`;
    case "hyperliquid": return `perp-cli-hl${suffix}`;
    case "pacifica": return `perp-cli-pac${suffix}`;
    case "lighter": return `perp-cli-lt${suffix}`;
    case "lighter-rh": return `perp-cli-lrh${suffix}`;
    case "ondo": return `perp-cli-ondo${suffix}`;
    case "arcus": return `perp-cli-arcus${suffix}`;
    case "qfex": return `perp-cli-qfex${suffix}`;
    case "risex": return `perp-cli-risex${suffix}`;
    case "txflow": return `perp-cli-txflow${suffix}`;
    case "variational": return `perp-cli-variational${suffix}`;
    case "grvt": return `perp-cli-grvt${suffix}`;
    case "extended": return `perp-cli-extended${suffix}`;
  }
}

/**
 * Local OWS agent wallet name. Testnet agents get their own wallet so a
 * testnet approve never collides with (or reuses) the mainnet agent key.
 */
function agentWalletNameFor(prefix: "hl" | "pac" | "aster", masterName: string, network: Network): string {
  return network === "testnet" ? `agent-${prefix}-${masterName}-testnet` : `agent-${prefix}-${masterName}`;
}

/**
 * The agent's OWS wallet name is fixed per venue + master + network, and OWS refuses a duplicate
 * name. An existing wallet of that name is refused here, before anything is created or signed.
 */
function assertAgentWalletNameFree(venue: "hyperliquid" | "pacifica" | "aster", agentWalletName: string, network: Network): void {
  if (!loadOws().listWallets().some((w: { name: string }) => w.name === agentWalletName)) return;
  const net = network === "testnet" ? " -n testnet" : "";
  const owner = listAgents(venue).find(a => a.meta.agentWalletName === agentWalletName);
  if (owner !== undefined) {
    throw new PerpError("INVALID_PARAMS", `${venue} agent "${owner.meta.agentName}" already exists (its OWS wallet "${agentWalletName}" is in use)`, {
      exchange: venue,
      remediation: `Replace it (revoke + new key): perp${net} wallet agent approve ${venue} --rotate, or perp${net} wallet agent rotate ${venue} ${owner.meta.agentName}`,
    });
  }
  throw new PerpError("INVALID_PARAMS", `OWS wallet "${agentWalletName}" already exists but no ${venue} agent record uses it (left over from an interrupted approve)`, {
    exchange: venue,
    remediation: `If no ${venue} agent on the venue uses its key, delete it (ows wallet delete ${agentWalletName}) and re-run the approve`,
  });
}

/** Refuse to overwrite a legacy-shaped agent record registered on another network. */
function assertAgentNameFree(venue: VenueId, agentName: string, network: Network): void {
  const existing = getAgent(venue, agentName);
  if (existing !== null && agentNetworkOf(venue, existing) !== network) {
    throw new PerpError("INVALID_PARAMS", `${venue} agent "${agentName}" is already registered on ${agentNetworkOf(venue, existing)}`, {
      remediation: `Choose another --agent-name for the ${network} agent (default: ${defaultAgentName(venue, network)})`,
    });
  }
}

/** Ondo / Arcus: refuse (even with --rotate) to replace a record registered on another network. */
function assertVenueAgentNameFree(venue: "ondo" | "arcus" | "risex" | "txflow", agentName: string, network: Network): void {
  const existing = getVenueAgent(venue, agentName);
  if (existing !== null && existing.network !== network) {
    throw new PerpError("INVALID_PARAMS", `${venue} agent "${agentName}" is already registered on ${existing.network}`, {
      remediation: `Choose another --agent-name for the ${network} agent (default: ${defaultAgentName(venue, network)})`,
    });
  }
}

export interface ApproveAgentParams {
  venue: VenueId;
  network: Network;
  /** Master OWS wallet; null → settings.owsActiveWallet. Unused for Ondo. */
  master: string | null;
  /** null → defaultAgentName(venue). */
  agentName: string | null;
  /** 30d, 90d, 180d, 1y, or ISO-8601 datetime. */
  expiresIn: string;
  canPerp: boolean;
  canSpot: boolean;
  canWithdraw: boolean;
  /**
   * Replace an existing agent of the same name. Ondo / Arcus: re-register in place;
   * Pacifica / Hyperliquid / Aster: the `wallet agent rotate` path (rotateVenueAgent).
   */
  rotate: boolean;
  /** Resolved master passphrase. null → PASSPHRASE_REQUIRED for every venue except Ondo / Arcus. */
  passphrase: string | null;
  /** Lighter / Lighter RH slot; null → next free slot (free locally AND on-chain). */
  apiKeyIndex: number | null;
  /** Lighter / Lighter RH: allow an explicit apiKeyIndex whose slot already holds an on-chain key (`--force`). */
  forceSlot: boolean;
  /** Arcus subaccount: 0-9, or 255 for all. */
  accountIndex: number;
  /** Aster-only IP whitelist. (Builder approval: `perp wallet builder approve aster`.) */
  aster: { ipWhitelist?: string };
  /** Ondo key id + secret; null → read from stdin (TTY prompt, or 2 piped lines). Never a flag. */
  ondoKey: { keyId: string; secret: string } | null;
}

export type ApproveAgentOutcome =
  | { venue: "ondo"; meta: OndoAgentMeta }
  | { venue: "arcus"; meta: ArcusAgentMeta }
  | { venue: "risex"; meta: RisexAgentMeta }
  | { venue: "txflow"; meta: TxflowAgentMeta }
  | { venue: LighterVenueId; agentName: string; expiresAt: string; result: LtApproveFlowResult }
  | { venue: "pacifica"; agentName: string; expiresAt: string; result: PacApproveFlowResult }
  | { venue: "hyperliquid"; agentName: string; expiresAt: string; result: HlApproveFlowResult }
  | { venue: "aster"; agentName: string; expiresAt: string; result: ApproveFlowResult };

function parseExpiresInParam(expiresIn: string): Date {
  try {
    return parseExpiresIn(expiresIn);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PerpError("INVALID_PARAMS", msg, { remediation: "Use: 30d, 90d, 180d, 1y, or ISO-8601 datetime" });
  }
}

function requireMaster(master: string | null): string {
  const name = master ?? loadSettings().owsActiveWallet;
  if (!name) {
    // No master wallet on this computer: approving signs with the master, so it cannot run here.
    throw new PerpError("NO_SIGNER_AVAILABLE", "Agent approval is signed by the master wallet, and none is configured on this computer (no --master, settings.owsActiveWallet empty)", {
      remediation: "Create the agent / API key on the exchange website and import it: perp wallet agent import <venue> (hidden prompt / stdin). Or add the master wallet (perp wallet import --name <name>) and pass --master <name>.",
    });
  }
  return name;
}

function requirePassphrase(passphrase: string | null): string {
  if (passphrase === null) {
    throw new PerpError("PASSPHRASE_REQUIRED", "No passphrase provided and stdin is non-TTY", {
      remediation: "Provide passphrase via --passphrase flag, OWS_PASSPHRASE env var, or stdin pipe",
    });
  }
  return passphrase;
}

/**
 * Register one agent wallet / API key on `venue`. Throws on any failure (the
 * caller decides whether to exit or continue with other venues). Holds the
 * per-venue lock for the duration of the venue round-trip.
 */
export async function approveVenueAgent(p: ApproveAgentParams): Promise<ApproveAgentOutcome> {
  assertAgentApproveSupported(p.venue, p.network, "approve");
  const agentName = p.agentName ?? defaultAgentName(p.venue, p.network);

  // Ondo: HMAC key entered on stdin only
  if (p.venue === "ondo") {
    assertVenueAgentNameFree("ondo", agentName, p.network);
    if (getVenueAgent("ondo", agentName) && !p.rotate) {
      throw new PerpError("INVALID_PARAMS", `Ondo agent "${agentName}" already exists`, {
        remediation: "Pass --rotate to replace it, or choose another --agent-name",
      });
    }
    const { approveOndoAgent } = await import("../exchanges/ondo/agent.js");
    const { keyId, secret } = p.ondoKey ?? await readOndoKeyFromStdin();
    const meta = await approveOndoAgent({ agentName, keyId, secret, network: p.network });
    setVenueAgent("ondo", meta);
    return { venue: "ondo", meta };
  }

  // Arcus: OWS Ed25519 agent + EIP-712 createApiKey
  if (p.venue === "arcus") {
    const masterName = requireMaster(p.master);
    assertVenueAgentNameFree("arcus", agentName, p.network);
    if (getVenueAgent("arcus", agentName) && !p.rotate) {
      throw new PerpError("INVALID_PARAMS", `Arcus agent "${agentName}" already exists`, {
        remediation: "Pass --rotate to re-register it, or choose another --agent-name",
      });
    }
    const expiresAt = parseExpiresIn(p.expiresIn);
    const validDays = Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000);
    const { approveArcusAgent } = await import("../exchanges/arcus/agent.js");
    acquireLock("arcus");
    try {
      const meta = await approveArcusAgent({
        agentName, masterOwsWallet: masterName, passphrase: p.passphrase, accountIndex: p.accountIndex, network: p.network, validDays,
      });
      setVenueAgent("arcus", meta);
      return { venue: "arcus", meta };
    } finally {
      releaseLock("arcus");
    }
  }

  // RISEx: master-signed RegisterSigner, then an on-chain restriction to trading-only.
  if (p.venue === "risex") {
    const masterName = requireMaster(p.master);
    assertVenueAgentNameFree("risex", agentName, p.network);
    if (p.canWithdraw || p.canSpot) {
      throw new PerpError("INVALID_PARAMS", "RISEx signers registered by perp-cli are always restricted to trading only (no fund movement, no spot)", {
        remediation: "Drop --can-withdraw / --can-spot",
      });
    }
    const expiresAt = parseExpiresInParam(p.expiresIn);
    const { approveRisexAgent, revokeRisexAgent, risexAgentWalletName, risexRotatePreflight, risexSignerStatus } = await import("../exchanges/risex/agent.js");
    acquireLock("risex");
    try {
      const existing = getVenueAgent("risex", agentName);
      if (existing !== null) {
        if (!p.rotate) {
          throw new PerpError("INVALID_PARAMS", `RISEx signer "${agentName}" already exists`, {
            remediation: `Replace it (revoke the old signer, register a fresh one): perp${p.network === "testnet" ? " -n testnet" : ""} wallet agent approve risex --rotate — or choose another --agent-name`,
          });
        }
        // Rotate: the new signer's checks (pins, maintenance, master gas) pass first, then a
        // venue-confirmed revoke of the old signer, then drop its key, then approve.
        await risexRotatePreflight(masterName, p.passphrase, p.network);
        // A kept record whose signer never registered (or is already revoked) has nothing to
        // revoke on the venue: it is only forgotten locally. An Active one is revoked first.
        const status = await risexSignerStatus(existing);
        if (status === 1) await revokeRisexAgent({ meta: existing, masterOwsWallet: masterName, passphrase: p.passphrase });
        try { loadOws().deleteWallet(existing.agentWalletName); } catch { /* already gone */ }
        deleteVenueAgent("risex", agentName);
      } else if (p.rotate && loadOws().listWallets().some((w: { name: string }) => w.name === risexAgentWalletName(masterName, p.network))) {
        throw new PerpError("INVALID_PARAMS", `OWS wallet "${risexAgentWalletName(masterName, p.network)}" exists but no RISEx signer record uses it`, {
          remediation: `If no RISEx signer uses its key, delete it (ows wallet delete ${risexAgentWalletName(masterName, p.network)}) and re-run the approve`,
        });
      }
      const meta = await approveRisexAgent({ agentName, masterOwsWallet: masterName, passphrase: p.passphrase, network: p.network, expiresAt });
      setVenueAgent("risex", meta);
      return { venue: "risex", meta };
    } finally {
      releaseLock("risex");
    }
  }

  // TxFlow: master-signed approveAgent (direct EIP-712); the agent signs trading actions only.
  if (p.venue === "txflow") {
    const masterName = requireMaster(p.master);
    assertVenueAgentNameFree("txflow", agentName, p.network);
    if (p.canWithdraw || p.canSpot) {
      throw new PerpError("INVALID_PARAMS", "TxFlow agent keys sign trading actions only (withdrawals and transfers are master-signed); perp-cli trades perps only", {
        remediation: "Drop --can-withdraw / --can-spot",
      });
    }
    const existing = getVenueAgent("txflow", agentName);
    if (existing !== null && !p.rotate) {
      throw new PerpError("INVALID_PARAMS", `TxFlow agent "${agentName}" already exists`, {
        remediation: `Replace it (the venue rebinds the label to a new key): perp${p.network === "testnet" ? " -n testnet" : ""} wallet agent approve txflow --rotate — or choose another --agent-name`,
      });
    }
    if (existing !== null && existing.source === "imported") {
      throw new PerpError("INVALID_PARAMS", `TxFlow agent "${agentName}" was imported from the TxFlow web app — --rotate replaces keys this CLI approved`, {
        remediation: `Remove the imported copy first (perp wallet agent revoke txflow ${agentName} --local-only), or choose another --agent-name`,
      });
    }
    const { approveTxflowAgent } = await import("../exchanges/txflow/agent.js");
    acquireLock("txflow");
    try {
      const meta = await approveTxflowAgent({ agentName, masterOwsWallet: masterName, passphrase: p.passphrase, network: p.network, replacing: existing });
      setVenueAgent("txflow", meta);
      return { venue: "txflow", meta };
    } finally {
      releaseLock("txflow");
    }
  }

  const expiresAt = parseExpiresInParam(p.expiresIn);
  const masterName = requireMaster(p.master);
  const expiresAtIso = expiresAt.toISOString();
  const nowIso = new Date().toISOString();
  assertAgentNameFree(p.venue, agentName, p.network);

  // --rotate: the same path as `wallet agent rotate` (venue-confirmed revoke → delete the old
  // local key → approve), for the OWS-stored agents (the fixed `agent-<dex>-<master>` wallet name
  // would otherwise collide with the previous agent's) and the Lighter-family keystore agents.
  // Without --rotate an existing agent of this name is never silently replaced.
  if (p.venue === "pacifica" || p.venue === "hyperliquid" || p.venue === "aster" || isLighterFamilyVenue(p.venue)) {
    if (!p.rotate) {
      if (getAgent(p.venue, agentName) !== null) {
        const net = p.network === "testnet" ? " -n testnet" : "";
        throw new PerpError("INVALID_PARAMS", `${p.venue} agent "${agentName}" already exists on this computer`, {
          exchange: p.venue,
          remediation: `Replace it (revoke the old key, register a fresh one): perp${net} wallet agent approve ${p.venue} --rotate — or choose another --agent-name`,
        });
      }
    } else if (!isLighterFamilyVenue(p.venue) || getAgent(p.venue, agentName) !== null) {
      return rotateVenueAgent({
        exchange: p.venue, network: p.network, agentNameToRotate: agentName, master: p.master,
        passphrase: async () => p.passphrase, expiresIn: p.expiresIn,
        canPerp: p.canPerp, canSpot: p.canSpot, canWithdraw: p.canWithdraw, ipWhitelist: p.aster.ipWhitelist,
      });
    }
  }

  // Lighter family (lighter, lighter-rh): slot must be 4..254 minus venue-reserved
  if (isLighterFamilyVenue(p.venue)) {
    const ltVenue = p.venue;
    if (p.apiKeyIndex !== null) assertLighterSlot(ltVenue, p.apiKeyIndex);
    const passphrase = requirePassphrase(p.passphrase);
    acquireLock(ltVenue);
    try {
      const result = await runLtApproveFlow({
        venue: ltVenue, network: p.network, masterName, passphrase, agentName, expiresAt, expiresAtIso, nowIso,
        canPerp: p.canPerp, canSpot: p.canSpot, canWithdraw: p.canWithdraw,
        apiKeyIndex: p.apiKeyIndex ?? undefined,
        forceSlot: p.forceSlot,
      });
      return { venue: ltVenue, agentName, expiresAt: expiresAtIso, result };
    } finally {
      releaseLock(ltVenue);
    }
  }

  const passphrase = requirePassphrase(p.passphrase);

  if (p.venue === "pacifica") {
    acquireLock("pacifica");
    try {
      const result = await runPacApproveFlow({
        network: p.network, masterName, passphrase, agentName, expiresAt, expiresAtIso, nowIso,
        canPerp: p.canPerp, canSpot: p.canSpot, canWithdraw: p.canWithdraw,
      });
      return { venue: "pacifica", agentName, expiresAt: expiresAtIso, result };
    } finally {
      releaseLock("pacifica");
    }
  }

  if (p.venue === "hyperliquid") {
    acquireLock("hyperliquid");
    try {
      const result = await runHlApproveFlow({
        network: p.network, masterName, passphrase, agentName, expiresAt, expiresAtIso, nowIso,
        canPerp: p.canPerp, canSpot: p.canSpot, canWithdraw: p.canWithdraw,
      });
      return { venue: "hyperliquid", agentName, expiresAt: expiresAtIso, result };
    } finally {
      releaseLock("hyperliquid");
    }
  }

  // Aster. Acquire the lock at the START of the flow (before any OWS resources
  // are created) so that concurrent approves are fully serialized, not just
  // the final settings write.
  const nonceMicros = Date.now() * 1000 + (Math.floor(Math.random() * 1000));
  acquireLock("aster");
  try {
    const result = await runApproveFlow({
      network: p.network, masterName, passphrase, agentName, expiresAt,
      expiredMs: expiresAt.getTime(), expiresAtIso, nonceMicros, nowIso,
      canPerp: p.canPerp, canSpot: p.canSpot, canWithdraw: p.canWithdraw,
      ipWhitelist: p.aster.ipWhitelist,
    });
    return { venue: "aster", agentName, expiresAt: expiresAtIso, result };
  } finally {
    releaseLock("aster");
  }
}

/**
 * Loud warning for a QFEX key that has — or may have (it cannot be checked without acting) — the
 * "Deposit and withdraw" permission. Such a key can withdraw with the key alone, and imported keys
 * are stored with an empty passphrase (file permissions only). Not a block: a funding key is needed
 * for a QFEX withdrawal. Shown at import and in `wallet agent list`. null = no warning.
 */
export function qfexWithdrawKeyWarning(meta: Pick<QfexAgentMeta, "agentName" | "permissions">): string | null {
  if (meta.permissions.depositWithdraw === false) return null;
  const has = meta.permissions.depositWithdraw === true ? "HAS" : "MAY HAVE (cannot be checked without withdrawing)";
  return `QFEX key "${meta.agentName}" ${has} the "Deposit and withdraw" permission and is stored with an EMPTY passphrase (protected by file permissions only) — anyone who can read ~/.perp can withdraw with it. Delete it right after use: perp wallet agent revoke qfex ${meta.agentName} --local-only, and delete the key on the QFEX website.`;
}

/** Venues `wallet agent rotate` (and `approve --rotate`) can rotate. */
type RotatableVenue = "aster" | "hyperliquid" | "pacifica" | LighterVenueId;

type RotatedAgentOutcome = Exclude<ApproveAgentOutcome, { venue: "ondo" | "arcus" | "risex" | "txflow" }>;

export interface RotateAgentParams {
  exchange: RotatableVenue;
  network: Network;
  agentNameToRotate: string;
  /** null → the old agent's master, then settings.owsActiveWallet. */
  master: string | null;
  /** Resolved lazily, after the record / master checks (null → PASSPHRASE_REQUIRED). */
  passphrase: () => Promise<string | null>;
  expiresIn: string;
  /** Both undefined → inherit the old agent's trade permissions. */
  canPerp: boolean | undefined;
  canSpot: boolean | undefined;
  /** Never inherited: true only when --can-withdraw was passed explicitly (Aster: needs ipWhitelist). */
  canWithdraw: boolean | undefined;
  /** Aster-only IP whitelist. */
  ipWhitelist: string | undefined;
}

/**
 * Rotate an agent: venue-confirmed revoke of the existing agent (when one is recorded), delete
 * its dead OWS wallet and local record, then approve a fresh agent under the same name. The single
 * path of `wallet agent rotate` and `wallet agent approve --rotate`.
 */
export async function rotateVenueAgent(p: RotateAgentParams): Promise<RotatedAgentOutcome> {
  const { exchange, network, agentNameToRotate } = p;
  const settings = loadSettings();

  // Capture existing agent meta before revoke (for permission inheritance).
  // It must belong to the selected network — rotate never crosses networks.
  // The OWS agent wallet name derives from the master (one per venue + master + network), so
  // under a NEW agent name the agent to replace is the record that owns that wallet.
  const named = getAgent(exchange, agentNameToRotate);
  if (named !== null) assertAgentNetwork(exchange, named, network);
  const walletOwner = (): AgentMeta | null => {
    if (isLighterFamilyVenue(exchange)) return null;
    const master = p.master || settings.owsActiveWallet;
    if (!master) return null;
    const walletName = agentWalletNameFor(exchange === "hyperliquid" ? "hl" : exchange === "pacifica" ? "pac" : "aster", master, network);
    const owner = listAgents(exchange).find(a => a.meta.agentWalletName === walletName && agentNetworkOf(exchange, a.meta) === network);
    return owner === undefined ? null : owner.meta;
  };
  const existing = named ?? walletOwner();
  if (existing !== null && agentSourceOf(exchange, existing) === "imported") {
    const net = network === "testnet" ? " -n testnet" : "";
    throw new PerpError("INVALID_PARAMS", `${exchange} agent "${agentNameToRotate}" was imported from the exchange website — this CLI cannot rotate it (no master wallet signature)`, {
      remediation: `Create a new key on the ${getVenue(exchange).displayName} website (and delete the old one there), then: perp${net} wallet agent import ${exchange} --agent-name ${agentNameToRotate} --replace`,
    });
  }

  // The new agent is approved by the old agent's master unless --master says
  // otherwise; resolved before the revoke so an unknown master changes nothing.
  const masterName = p.master || existing?.masterWalletName || settings.owsActiveWallet;
  if (!masterName) {
    throw new PerpError("INVALID_PARAMS", `No master wallet for rotating ${exchange} agent "${agentNameToRotate}": no --master, no master on the agent record, and settings.owsActiveWallet is empty`, {
      remediation: `Pass the master that registered it: perp wallet agent rotate ${exchange} ${agentNameToRotate} --master <ows-wallet>`,
    });
  }

  // Resolve permissions BEFORE anything is revoked: explicit flags > old agent's trade
  // permissions > defaults. With --no-can-perp/spot pattern, opts values are undefined when not
  // passed. canWithdraw is NEVER inherited: only an explicit --can-withdraw grants it.
  const permFlagsProvided = p.canPerp !== undefined || p.canSpot !== undefined;
  let canPerp: boolean;
  let canSpot: boolean;
  if (permFlagsProvided) {
    canPerp = p.canPerp ?? true;
    canSpot = p.canSpot ?? false;
  } else if (existing?.permissions) {
    // Preserve old agent's trade permissions when flags are absent
    canPerp = existing.permissions.canPerpTrade;
    canSpot = existing.permissions.canSpotTrade;
  } else {
    canPerp = true;
    canSpot = false;
  }
  const canWithdraw = p.canWithdraw === true;
  // Aster: --can-withdraw without --ip-whitelist is refused here, before the passphrase is read
  // and before the old agent is revoked (a later refusal would leave no agent at all).
  if (exchange === "aster") assertAsterWithdrawIpWhitelist(canWithdraw, p.ipWhitelist);

  // Resolve passphrase (needed for both revoke and approve phases)
  const passphrase = await p.passphrase();
  if (passphrase === null) {
    throw new PerpError("PASSPHRASE_REQUIRED", "No passphrase provided and stdin is non-TTY", {
      remediation: "Provide passphrase via --passphrase flag, OWS_PASSPHRASE env var, or stdin pipe",
    });
  }

  // Revoke the existing agent (if present) BEFORE approving the new one.
  // Fail closed: if the venue does not confirm the revoke, abort with the
  // old agent's local record (and keys) untouched and no new agent
  // approved — the user keeps a working, recorded agent and can retry.
  // The local record is deleted only after a confirmed revoke, so a later
  // approve failure leaves no agent but nothing still authorized either.
  if (existing) {
    try {
      if (exchange === "pacifica") {
        // Pacifica master is a Solana keypair; can't reuse the EVM master signer.
        const revokePacSigner = OwsSolanaSigner.create(existing.masterWalletName, passphrase);
        await revokePacAgent(revokePacSigner, existing.agentSolanaAddress ?? null, network);
      } else if (isLighterFamilyVenue(exchange)) {
        // LT rotate: kill the old slot (ChangePubKey to a throwaway key) and delete
        // its keystore file before the new approve registers a fresh slot.
        await revokeLtAgent(exchange, network, existing, passphrase);
      } else if (exchange === "hyperliquid") {
        const revokeMs = OwsEvmSigner.create(existing.masterWalletName, passphrase);
        await revokeHlAgent(revokeMs, network, existing.agentName, existing.agentEvmAddress);
      } else {
        // Aster: DELETE /fapi/v3/agent — the response decides success.
        const revokeMs = OwsEvmSigner.create(existing.masterWalletName, passphrase);
        await assertAsterAgentDeleted(
          await deleteAsterAgent(revokeMs, existing.agentEvmAddress, network),
          existing.agentEvmAddress,
          `The old agent "${existing.agentName}" and its local record were kept and no new agent was approved. Retry the rotate, or delete the agent in the Aster UI and run: perp wallet agent revoke aster ${existing.agentName} --force`,
        );
      }
    } catch (revokeErr) {
      if (revokeErr instanceof PerpError && (revokeErr.structured.code === "APPROVE_FAILED" || revokeErr.structured.code === "APPROVE_PARTIAL")) throw revokeErr;
      throw new PerpError("APPROVE_FAILED", `Rotate aborted: revoking the previous ${exchange} agent "${existing.agentName}" failed — it may still be authorized. ${revokeErr instanceof Error ? revokeErr.message : String(revokeErr)}`, {
        exchange,
        remediation: `The old agent and its local record were kept and no new agent was approved. Retry: perp wallet agent rotate ${exchange} ${existing.agentName}`,
      });
    }
    if (existing.owsApiKeyId) {
      try { loadOws().revokeApiKey(existing.owsApiKeyId); } catch { /* best effort */ }
    }
    // Confirmed revoke → the old OWS agent wallet is dead; delete it so the approve
    // below can create the same `agent-<dex>-<master>` name (OWS refuses duplicates).
    if (!isLighterFamilyVenue(exchange)) deleteRevokedAgentWallet(exchange, existing);
    deleteAgent(exchange, existing.agentName);
  }

  const expiresAt = parseExpiresIn(p.expiresIn);
  const expiresAtIso = expiresAt.toISOString();
  const nowIso = new Date().toISOString();

  // Acquire lock and run the shared approve flow
  acquireLock(exchange);
  try {
    if (exchange === "hyperliquid") {
      const result = await runHlApproveFlow({
        network,
        masterName,
        passphrase,
        agentName: agentNameToRotate,
        expiresAt,
        expiresAtIso,
        nowIso,
        canPerp,
        canSpot,
        canWithdraw,
      });
      return { venue: "hyperliquid", agentName: agentNameToRotate, expiresAt: expiresAtIso, result };
    } else if (exchange === "pacifica") {
      const result = await runPacApproveFlow({
        network,
        masterName,
        passphrase,
        agentName: agentNameToRotate,
        expiresAt,
        expiresAtIso,
        nowIso,
        canPerp,
        canSpot,
        canWithdraw,
      });
      return { venue: "pacifica", agentName: agentNameToRotate, expiresAt: expiresAtIso, result };
    } else if (isLighterFamilyVenue(exchange)) {
      const result = await runLtApproveFlow({
        venue: exchange,
        network,
        masterName,
        passphrase,
        agentName: agentNameToRotate,
        expiresAt,
        expiresAtIso,
        nowIso,
        canPerp,
        canSpot,
        canWithdraw,
        // No apiKeyIndex override on rotate — picks next slot free locally and on-chain.
        forceSlot: false,
      });
      return { venue: exchange, agentName: agentNameToRotate, expiresAt: expiresAtIso, result };
    } else {
      const expiredMs = expiresAt.getTime();
      const nonceMicros = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      const result = await runApproveFlow({
        network,
        masterName,
        passphrase,
        agentName: agentNameToRotate,
        expiresAt,
        expiredMs,
        expiresAtIso,
        nonceMicros,
        nowIso,
        canPerp,
        canSpot,
        canWithdraw,
        ipWhitelist: p.ipWhitelist,
      });
      return { venue: "aster", agentName: agentNameToRotate, expiresAt: expiresAtIso, result };
    }
  } finally {
    releaseLock(exchange);
  }
}

/** Display identity of a rotated agent (EVM / Solana address, or the Lighter slot + public key). */
function rotatedAgentAddressOf(o: RotatedAgentOutcome): string {
  if (o.venue === "hyperliquid" || o.venue === "aster") return o.result.agentAddress;
  if (o.venue === "pacifica") return o.result.agentSolanaAddress;
  return `slot=${o.result.apiKeyIndex} pubkey=${o.result.publicKey}`;
}

/** Live (read-only) registration check for `venue` — `wallet agent verify <venue>`. */
export async function verifyVenueAgent(venue: VenueId, network: Network, opts: { master: string | null; passphrase: string }): Promise<VerifyResult> {
  return verifyVenue(venue, network, { master: opts.master ?? undefined, passphrase: opts.passphrase });
}

/** Human-readable summary of a successful approve (no secrets — public ids/addresses only). */
export function printApproveOutcome(outcome: ApproveAgentOutcome): void {
  switch (outcome.venue) {
    case "ondo":
      console.log(chalk.green.bold("\n  Ondo Perps API key registered!\n"));
      console.log(`  Name:     ${chalk.cyan(outcome.meta.agentName)}`);
      console.log(`  Key ID:   ${chalk.cyan(outcome.meta.keyId)}`);
      console.log(`  Keystore: ${chalk.gray(outcome.meta.keystorePath)}`);
      console.log();
      return;
    case "arcus":
      console.log(chalk.green.bold("\n  Arcus API key registered!\n"));
      console.log(`  Name:          ${chalk.cyan(outcome.meta.agentName)}`);
      console.log(`  API Key:       ${chalk.cyan(outcome.meta.apiKeyHex)}`);
      console.log(`  Owner:         ${chalk.cyan(outcome.meta.ownerAddress)}`);
      console.log(`  Account Index: ${chalk.cyan(String(outcome.meta.accountIndex))}`);
      console.log(`  Valid Until:   ${chalk.cyan(outcome.meta.validUntil)}`);
      console.log();
      return;
    case "risex":
      console.log(chalk.green.bold("\n  RISEx signer registered and restricted to trading-only!\n"));
      console.log(`  Name:        ${chalk.cyan(outcome.meta.agentName)}`);
      console.log(`  Signer:      ${chalk.cyan(outcome.meta.signerAddress)}`);
      console.log(`  Account:     ${chalk.cyan(outcome.meta.accountAddress)}`);
      console.log(`  Expires:     ${chalk.cyan(outcome.meta.expiresAt)}`);
      console.log(`  Permissions: ${chalk.cyan("trading only")} ${chalk.gray(`(on-chain; disabled ${outcome.meta.permissions.disabled.join(", ")}; verified ${outcome.meta.permissions.verifiedAt})`)}`);
      console.log(chalk.gray("  Deposits / withdrawals: RISEx app only (perp-cli never moves RISEx funds)."));
      console.log();
      return;
    case "txflow":
      console.log(chalk.green.bold("\n  TxFlow agent approved!\n"));
      console.log(`  Name (label): ${chalk.cyan(outcome.meta.agentName)}`);
      console.log(`  Agent:        ${chalk.cyan(outcome.meta.agentAddress)}`);
      console.log(`  Account:      ${chalk.cyan(outcome.meta.accountAddress)}`);
      console.log(`  Network:      ${chalk.cyan(outcome.meta.network)}`);
      console.log(chalk.gray("  The agent signs trading actions only; deposits / withdrawals stay in the TxFlow web app. TxFlow agents do not expire."));
      if (outcome.meta.network === "mainnet") console.log(chalk.gray("  Mainnet trading is open to whitelisted accounts only (apply at https://txflow.com/apply)."));
      console.log();
      return;
    case "lighter":
    case "lighter-rh":
      console.log(chalk.green.bold(`\n  ${getVenue(outcome.venue).displayName} Agent approved successfully!\n`));
      console.log(`  Name:           ${chalk.cyan(outcome.agentName)}`);
      console.log(`  API Key Index:  ${chalk.cyan(String(outcome.result.apiKeyIndex))}`);
      console.log(`  Public Key:     ${chalk.cyan(outcome.result.publicKey)}`);
      console.log(`  Account Index:  ${chalk.cyan(String(outcome.result.accountIndex))}`);
      console.log(`  Expires:        ${chalk.cyan(outcome.expiresAt)}`);
      console.log();
      return;
    case "pacifica":
      console.log(chalk.green.bold("\n  Pacifica Agent approved successfully!\n"));
      console.log(`  Name:           ${chalk.cyan(outcome.agentName)}`);
      console.log(`  Agent Address:  ${chalk.cyan(outcome.result.agentSolanaAddress)}`);
      console.log(`  Master Address: ${chalk.cyan(outcome.result.userSolanaAddress)}`);
      console.log(`  Expires:        ${chalk.cyan(outcome.expiresAt)}`);
      console.log();
      return;
    case "hyperliquid":
      console.log(chalk.green.bold("\n  Hyperliquid Agent approved successfully!\n"));
      console.log(`  Name:          ${chalk.cyan(outcome.agentName)}`);
      console.log(`  Agent Address: ${chalk.cyan(outcome.result.agentAddress)}`);
      console.log(`  Expires:       ${chalk.cyan(outcome.expiresAt)}`);
      console.log();
      return;
    case "aster":
      console.log(chalk.green.bold("\n  Agent approved successfully!\n"));
      console.log(`  Name:          ${chalk.cyan(outcome.agentName)}`);
      console.log(`  Agent Address: ${chalk.cyan(outcome.result.agentAddress)}`);
      console.log(`  Expires:       ${chalk.cyan(outcome.expiresAt)}`);
      console.log(`  API Key ID:    ${chalk.gray(outcome.result.owsApiKeyId)}`);
      console.log(`  Policy ID:     ${chalk.gray(outcome.result.policyId)}`);
      console.log();
      return;
  }
}

/**
 * Register the per-DEX agent-wallet management subtree (`approve` /
 * `list` / `revoke` / `rotate` / `verify`) under the supplied parent
 * `wallet` command. The function previously registered `agent` as a
 * top-level command on `program`; the hard-cut consolidation in v0.11+
 * relocates it to `wallet agent ...`.
 */
export function registerWalletAgentCommands(
  walletCmd: Command,
  isJson: () => boolean
) {
  const agent = walletCmd
    .command("agent")
    .description("Agent wallet management — register/revoke/rotate/verify per-DEX delegation keys");


  // ── agent approve <exchange> ── register an agent wallet ──────────────────
  agent
    .command("approve <exchange>")
    .description("Register an agent wallet / API key for an exchange (aster, hyperliquid, pacifica, lighter, lighter-rh, ondo, arcus, risex, txflow — risex: a trading-only session signer, restricted on-chain; txflow: an agent key approved by the master, no expiry)")
    .option("--master <name>", "Master OWS wallet name")
    .option("--agent-name <name>", "Agent name (default: perp-cli-aster)")
    .option("--expires-in <duration>", "Expiry: 30d, 90d, 180d, 1y, or ISO-8601 datetime (default: 90d)")
    .option("--can-perp", "Allow perp trading (default: on)", true)
    .option("--no-perp", "Disallow perp trading")
    .option("--can-spot", "Allow spot trading (default: off)", false)
    .option("--no-spot", "Disallow spot trading")
    .option("--can-withdraw", "Allow withdrawals (default: off)", false)
    .option("--no-withdraw", "Disallow withdrawals")
    .option("--rotate", "Allow re-approving an existing agent name")
    .addOption(deprecatedPassphraseOption()).hook("preAction", warnDeprecatedPassphrase)
    .addOption(new Option("--builder <addr>", "Removed — use: perp wallet builder approve <venue>").hideHelp())
    .addOption(new Option("--max-fee-rate <rate>", "Removed — use: perp wallet builder approve <venue>").hideHelp())
    .addOption(new Option("--builder-name <name>", "Removed — use: perp wallet builder approve <venue>").hideHelp())
    .option("--ip-whitelist <list>", "Aster IP whitelist, comma- or space-separated (required with --can-withdraw)")
    .option("--api-key-index <n>", "Lighter / Lighter RH slot index (4-254; RH also excludes 157). Default: next slot free locally and on-chain.")
    .option("--force", "Lighter / Lighter RH: overwrite an --api-key-index slot that already holds an on-chain key (kills whatever signs with it)")
    .option("--account-index <n>", "Arcus subaccount the key is scoped to: 0-9, or 255 for all (trading needs 0-9)", "0")
    .option("--json", "Machine-readable output")
    .action(async (exchange: string, opts: {
      master?: string;
      agentName?: string;
      expiresIn?: string;
      canPerp?: boolean;
      canSpot?: boolean;
      canWithdraw?: boolean;
      rotate?: boolean;
      passphrase?: string;
      builder?: string;
      maxFeeRate?: string;
      builderName?: string;
      ipWhitelist?: string;
      apiKeyIndex?: string;
      accountIndex: string;
      force?: boolean;
      json?: boolean;
    }, command: Command) => {
      const useJson = opts.json ?? isJson();
      // optsWithGlobals() merges parent + subcommand options so --passphrase
      // works whether placed on `perp --passphrase X wallet agent approve` or
      // on the subcommand. Commander v13 silently shadows the subcommand flag
      // when the parent defines an identically-named flag — the visible bug
      // was approve throwing PASSPHRASE_REQUIRED even with --passphrase set.
      const mergedOpts = command.optsWithGlobals() as { passphrase?: string };
      const passphraseFlag = mergedOpts.passphrase ?? opts.passphrase;

      try {
        if (opts.builder !== undefined || opts.maxFeeRate !== undefined || opts.builderName !== undefined) {
          // Builder fees are opt-in and approved only for the builder configured in settings.
          throw new PerpError("INVALID_PARAMS", "--builder / --max-fee-rate / --builder-name moved out of agent approve", {
            remediation: "Configure the builder (perp settings set builder.<venue> <address|code>,<feeBps>), then: perp wallet builder approve <venue>",
          });
        }
        const network = networkOf(command);
        // Normalize aliases (UNKNOWN_VENUE for anything unregistered)
        const venue = resolveVenueId(exchange);
        // Venues whose keys exist only as website-created imports (qfex) are refused before any prompt / passphrase read.
        if (getVenue(venue).masterKeyKind === "none") assertAgentApproveSupported(venue, network, "approve");

        let master = opts.master ?? null;
        let agentName = opts.agentName ?? null;
        // RISEx signers default to 30 days (owner decision; the venue maximum is not documented).
        let expiresIn = opts.expiresIn ?? (venue === "risex" ? "30d" : "90d");
        let canPerp = opts.canPerp ?? true;
        let canSpot = opts.canSpot ?? false;
        let canWithdraw = opts.canWithdraw ?? false;
        let passphrase: string | null = null;

        // Aster wizard mode: enter only when no identity flags were given, stdin
        // is a TTY and OWS_PASSPHRASE is unset.
        const asterWizard =
          venue === "aster" &&
          opts.master === undefined &&
          opts.agentName === undefined &&
          opts.expiresIn === undefined &&
          process.stdin.isTTY === true &&
          process.env["OWS_PASSPHRASE"] === undefined;

        if (asterWizard) {
          const rl = createInterface({ input, output });
          try {
            const settings = loadSettings();
            const defMaster = settings.owsActiveWallet || "main";
            const rawMaster = await rl.question(`Master wallet name [${defMaster}]: `);
            master = rawMaster.trim() || defMaster;

            const rawAgent = await rl.question(`Agent name [perp-cli-aster]: `);
            agentName = rawAgent.trim() || "perp-cli-aster";

            const rawExpiry = await rl.question(`Expires-in [90d]: `);
            expiresIn = rawExpiry.trim() || "90d";

            const rawPerp = await rl.question(`Can perp trade? [Y/n]: `);
            canPerp = rawPerp.trim().toLowerCase() !== "n";

            const rawSpot = await rl.question(`Can spot trade? [y/N]: `);
            canSpot = rawSpot.trim().toLowerCase() === "y";

            const rawWithdraw = await rl.question(`Can withdraw? [y/N]: `);
            canWithdraw = rawWithdraw.trim().toLowerCase() === "y";

            // Hidden passphrase prompt — readline doesn't support hidden natively;
            // we use muted output pattern compatible with node:readline/promises
            process.stdout.write("Master passphrase: ");
            const rawPp = await rl.question("");
            // Empty input = unencrypted vault wallet (historical wizard behavior).
            passphrase = rawPp.trim();
          } finally {
            rl.close();
          }
        } else if (venue !== "ondo") {
          // Aster: --can-withdraw without --ip-whitelist is refused before any passphrase read.
          if (venue === "aster") assertAsterWithdrawIpWhitelist(canWithdraw, opts.ipWhitelist);
          // No master wallet on this computer → refuse before asking for a passphrase.
          requireMaster(master);
          // Ondo reads its key from stdin, so the passphrase resolver (which may
          // consume a piped stdin) must not run for it.
          passphrase = await resolvePassphrase({ flag: passphraseFlag });
        }

        const outcome = await approveVenueAgent({
          venue,
          network,
          master,
          agentName,
          expiresIn,
          canPerp,
          canSpot,
          canWithdraw,
          rotate: opts.rotate === true,
          passphrase,
          apiKeyIndex: opts.apiKeyIndex !== undefined ? Number(opts.apiKeyIndex) : null,
          forceSlot: opts.force === true,
          accountIndex: Number(opts.accountIndex),
          aster: { ipWhitelist: opts.ipWhitelist },
          ondoKey: null,
        });

        if (useJson) {
          printJson(jsonOk("meta" in outcome ? outcome.meta : outcome.result));
          return;
        }
        printApproveOutcome(outcome);
      } catch (err) {
        reportErrorAndExit(err);
      }
    });

  // ── agent import <exchange> ── register a key created on the exchange website ──
  // SSOT Rule #3: the key is read from a hidden prompt or stdin — never argv.
  agent
    .command("import <exchange> [key]")
    .description("Import an agent wallet / API key created on the exchange WEBSITE (master wallet not needed on this computer; key via hidden prompt or stdin — never argv)")
    .option("--master-address <address>", "Master / owner public address (aster, pacifica, arcus: required; hyperliquid, lighter, txflow: optional cross-check)")
    .option("--account-index <n>", "Lighter / Lighter RH: account index (required). Arcus: subaccount the key is scoped to (optional cross-check)")
    .option("--api-key-index <n>", "Lighter / Lighter RH: the key's API key slot (required)")
    .option("--account-id <uuid>", "QFEX: the account the key trades (default: the primary account; required without a terminal — it is the confirmation)")
    .option("--agent-name <name>", "Local name for the key (default: web-<venue>[-testnet])")
    .option("--expires-in <duration>", "Expiry shown on the website (30d, 1y, ISO) — recorded when the venue does not report it")
    .option("--replace", "Replace an existing imported key of the same name (its local copy is deleted)")
    .addOption(new Option("--secret <secret>", "Refused — keys are never accepted on argv").hideHelp())
    .option("--json", "Machine-readable output")
    .addHelpText("after", `
Input (never argv): a hidden prompt in a terminal, or stdin when piped —
  one line with the private key; ondo: two lines (API key id, then secret);
  qfex: two lines (API public key, then secret).

Per venue:
  hyperliquid  API wallet private key (More → API on the website). Verified: info userRole = agent of the master.
  aster        API wallet (signer) private key + --master-address (user). Verified: signed GET /fapi/v3/balance.
  pacifica     agent wallet private key + --master-address (account). NOT verifiable without the master (reported "unverified").
  lighter      API key private key + --account-index + --api-key-index. Verified: slot holds a key and an auth token signed by the key is accepted.
  lighter-rh   same as lighter.
  arcus        API key private key (Ed25519) + --master-address (owner). Verified: GET /v1/apiKeys lists its public key ACTIVE.
  ondo         API key id + secret. Verified: authenticated GET /v1/account.
  qfex         API public key + secret [--account-id <uuid>]. Verified: signed reads as the account + Trade WebSocket
               auth. The key is bound to ONE account UUID, which is shown and must be confirmed (y/N in a terminal;
               piped: pass --account-id <uuid> equal to it). QFEX keys are created only on the website (2FA).
  txflow       agent (API wallet) private key [+ --master-address]. Verified: info agentOwner = an account (the master).

The imported key trades. Deposits / withdrawals / transfers / referral / agent approvals need the
master wallet: do them on the website, or add the master with 'perp wallet import'.
The CLI cannot revoke an imported key: 'wallet agent revoke <venue> <name> --local-only' removes
the local copy only — revoke it on the website.

Examples:
  perp -n testnet wallet agent import hyperliquid
  pbpaste | perp wallet agent import aster --master-address 0xYOU
  perp wallet agent import lighter --account-index 12345 --api-key-index 5
  printf '%s\\n%s\\n' "$KEY_ID" "$SECRET" | perp wallet agent import ondo
  printf '%s\\n%s\\n' "$PUBLIC_KEY" "$SECRET" | perp -n testnet wallet agent import qfex --account-id <uuid>`)
    .action(async (exchange: string, argvKey: string | undefined, opts: {
      masterAddress?: string;
      accountIndex?: string;
      apiKeyIndex?: string;
      accountId?: string;
      agentName?: string;
      expiresIn?: string;
      replace?: boolean;
      secret?: string;
      json?: boolean;
    }, command: Command) => {
      const useJson = opts.json ?? isJson();
      try {
        // (-k / --private-key is a root option: the root preAction already rejects it.)
        if (argvKey !== undefined || opts.secret !== undefined) {
          throw new PerpError("INVALID_PARAMS", "Refusing a key on the command line: it is visible in shell history and the process list", {
            remediation: "Enter it at the hidden prompt (run in a terminal) or pipe it on stdin (e.g. pbpaste | perp wallet agent import <venue> ...). Clear the key from your shell history.",
          });
        }
        const network = networkOf(command);
        const venue = resolveVenueId(exchange);
        // TxFlow (market data only) / RISEx (perp-cli-registered, restricted signers only): refused before any stdin read.
        const { assertImportSupported } = await import("./agent-import.js");
        assertImportSupported(venue, network);
        const int = (flag: string, raw: string | undefined): number | null => {
          if (raw === undefined) return null;
          const n = Number(raw);
          if (!Number.isInteger(n) || n < 0) throw new PerpError("INVALID_PARAMS", `${flag} must be a non-negative integer (got "${raw}")`);
          return n;
        };
        if (opts.accountId !== undefined && venue !== "qfex") {
          throw new PerpError("INVALID_PARAMS", "--account-id applies to qfex only", { remediation: "Lighter / Arcus use --account-index" });
        }
        const { importVenueAgent, readImportSecret, printImportOutcome } = await import("./agent-import.js");
        const accountId = opts.accountId ?? null;
        const params = {
          venue,
          network,
          agentName: opts.agentName ?? null,
          masterAddress: opts.masterAddress ?? null,
          accountIndex: int("--account-index", opts.accountIndex),
          apiKeyIndex: int("--api-key-index", opts.apiKeyIndex),
          expiresIn: opts.expiresIn ?? null,
          replace: opts.replace === true,
          accountId,
          confirmAccount: venue === "qfex" ? confirmImportAccount(accountId, useJson) : null,
        };
        const outcome = await importVenueAgent({ ...params, secret: await readImportSecret(venue) });
        if (useJson) {
          printJson(jsonOk(outcome));
          return;
        }
        printImportOutcome(outcome);
      } catch (err) {
        reportErrorAndExit(err);
      }
    });

  // ── agent list [<exchange>] ──────────────────────────────────────────────
  agent
    .command("list [exchange]")
    .description("List registered agent wallets")
    .option("--json", "Machine-readable output")
    .action((exchange: string | undefined, opts: { json?: boolean }) => {
      const useJson = opts.json ?? isJson();
      const all = listAgents(exchange === undefined ? undefined : resolveVenueId(exchange))
        .filter(({ exchange: ex }) => exchange === undefined || ex === resolveVenueId(exchange));
      const now = Date.now();

      const rows = all.map(({ exchange: ex, meta }) => {
        let status: "active" | "expired" | "partial";
        if (meta.status === "partial") {
          status = "partial";
        } else if (new Date(meta.expiresAt).getTime() < now) {
          status = "expired";
        } else {
          status = "active";
        }
        return {
          name: meta.agentName,
          exchange: ex,
          // null = untagged record whose network cannot be determined (shown as "unknown").
          network: recordedAgentNetworkOf(ex, meta),
          // "approved" = signed by a master wallet on this machine; "imported" = created on the website.
          source: agentSourceOf(ex, meta),
          evmAddress: meta.agentEvmAddress as string,
          // "" = unknown (imported key whose venue does not report an expiry).
          expiresAt: meta.expiresAt,
          status,
          // null = set on the exchange website, not known locally (imported keys).
          permissions: agentSourceOf(ex, meta) === "imported" ? null : meta.permissions,
          warning: null,
        } as {
          name: string; exchange: string; network: Network | null; source: "approved" | "imported";
          evmAddress: string; expiresAt: string; status: "active" | "expired" | "partial";
          permissions: AgentMeta["permissions"] | null;
          /** Loud key-safety warning (QFEX keys that can, or may, withdraw); null = none. */
          warning: string | null;
        };
      });

      // Ondo / Arcus keys use venue-specific metas (no EVM agent address / permission set).
      const venueFilter = exchange === undefined ? null : resolveVenueId(exchange);
      for (const { exchange: ex, meta } of listVenueAgents()) {
        if (venueFilter !== null && venueFilter !== ex) continue;
        const expiresAt = meta.kind === "arcus" ? meta.validUntil : meta.kind === "risex" ? meta.expiresAt : null; // ondo / qfex / txflow keys carry no expiry
        const status: "active" | "expired" = expiresAt !== null && expiresAt !== "" && new Date(expiresAt).getTime() < now ? "expired" : "active";
        rows.push({
          name: meta.agentName,
          exchange: ex,
          network: meta.network,
          source: agentSourceOf(ex, meta),
          evmAddress: meta.kind === "arcus" ? meta.ownerAddress : meta.kind === "risex" ? meta.signerAddress : meta.kind === "txflow" ? meta.agentAddress : "",
          // Ondo keys carry no expiry; shown as "—".
          expiresAt: expiresAt ?? "",
          status,
          // QFEX permissions are set on the website and cannot be read back → null (unknown).
          permissions: meta.kind === "qfex" ? null : { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
          warning: meta.kind === "qfex" ? qfexWithdrawKeyWarning(meta) : null,
        });
      }

      if (useJson) {
        printJson(jsonOk(rows));
        return;
      }

      if (rows.length === 0) {
        console.log("No agents registered. Run `perp wallet agent approve <exchange> ...` to create one.");
        return;
      }

      console.log(chalk.cyan.bold("\n  Registered Agent Wallets\n"));
      const header = ["NAME", "EXCHANGE", "NETWORK", "SOURCE", "EVM ADDR", "EXPIRES", "STATUS", "PERP", "SPOT", "WITHDRAW"];
      const colWidths = [20, 10, 8, 8, 14, 26, 9, 6, 6, 10];
      console.log("  " + header.map((h, i) => chalk.bold(h.padEnd(colWidths[i]))).join("  "));
      console.log("  " + header.map((_, i) => "─".repeat(colWidths[i])).join("  "));
      for (const r of rows) {
        const addr = r.evmAddress ? r.evmAddress.slice(0, 6) + "…" + r.evmAddress.slice(-4) : "";
        const statusColor = r.status === "active" ? chalk.green : r.status === "expired" ? chalk.red : chalk.yellow;
        const cols = [
          r.name.slice(0, 19),
          r.exchange,
          r.network ?? "unknown",
          r.source,
          addr,
          r.expiresAt ? new Date(r.expiresAt).toLocaleDateString() : r.source === "imported" ? "unknown" : "—",
          statusColor(r.status),
          ...(r.permissions === null
            ? [chalk.gray("?"), chalk.gray("?"), chalk.gray("?")]
            : [
              r.permissions.canPerpTrade ? chalk.green("Y") : chalk.gray("N"),
              r.permissions.canSpotTrade ? chalk.green("Y") : chalk.gray("N"),
              r.permissions.canWithdraw === null ? chalk.gray("?") : r.permissions.canWithdraw ? chalk.green("Y") : chalk.gray("N"),
            ]),
        ];
        console.log("  " + cols.map((c, i) => String(c).padEnd(colWidths[i])).join("  "));
      }
      if (rows.some(r => r.source === "imported")) {
        console.log(chalk.gray("\n  imported = created on the exchange website; PERP/SPOT/WITHDRAW \"?\" = set on the website. The CLI cannot revoke these (revoke on the website)."));
      }
      for (const r of rows) if (r.warning !== null) console.log(chalk.red.bold(`\n  [WARNING] ${r.warning}`));
      console.log();
    });

  // ── agent revoke <exchange> <agentName> ─────────────────────────────────
  agent
    .command("revoke <exchange> <agentName>")
    .description("Revoke an agent wallet registration (imported keys: --local-only — revoke them on the website)")
    .option("--force", "Skip the venue revoke call, only clear local state")
    .option("--local-only", "Only remove the local record (and, for imported keys, the local key copy) — nothing is sent; the key stays authorized on the exchange")
    .addOption(deprecatedPassphraseOption()).hook("preAction", warnDeprecatedPassphrase)
    .option("--master <name>", "Master OWS wallet (Arcus revoke). Defaults to settings.owsActiveWallet")
    .option("--json", "Machine-readable output")
    .action(async (exchangeArg: string, agentName: string, opts: {
      force?: boolean;
      localOnly?: boolean;
      passphrase?: string;
      master?: string;
      json?: boolean;
    }, command: Command) => {
      const useJson = opts.json ?? isJson();
      let exchange: VenueId;
      let network: Network;
      const localOnly = opts.force === true || opts.localOnly === true;
      try {
        exchange = resolveVenueId(exchangeArg);
        network = networkOf(command);
        // An imported key is only ever removed locally, so it needs no venue support for revoke
        // (e.g. an imported Aster testnet key).
        const rec = exchange === "ondo" || exchange === "arcus" || exchange === "qfex" || exchange === "risex" || exchange === "txflow" ? getVenueAgent(exchange, agentName) : getAgent(exchange, agentName);
        // QFEX keys only exist as imports: a missing record is "already removed", never an approve-capability error.
        // A release-gated venue (RISEx in 0.15.0) still lets --force / --local-only clear local state: nothing is signed or sent.
        const localCleanupOfGated = localOnly && getVenue(exchange).gatedRoles !== null;
        if (exchange !== "qfex" && !localCleanupOfGated && (rec === null || agentSourceOf(exchange, rec) !== "imported")) assertAgentApproveSupported(exchange, network, "revoke");
      } catch (e) {
        reportErrorAndExit(e);
      }
      // optsWithGlobals(): see wallet agent approve for full rationale.
      const mergedOpts = command.optsWithGlobals() as { passphrase?: string };
      const passphraseFlag = mergedOpts.passphrase ?? opts.passphrase;

      try {
        // ── Ondo: the key stays valid on the venue — revoke it in the Ondo Perps UI ──
        if (exchange === "ondo") {
          const ondoMeta = getVenueAgent("ondo", agentName);
          if (!ondoMeta) {
            if (useJson) printJson({ ok: true, data: { alreadyRevoked: true } });
            else console.log(`Agent "${agentName}" on ondo not found locally — already revoked.`);
            return;
          }
          const { revokeOndoAgentLocal } = await import("../exchanges/ondo/agent.js");
          const keystoreRemoved = revokeOndoAgentLocal(ondoMeta.keyId);
          deleteVenueAgent("ondo", agentName);
          const note = "The key is still valid on Ondo Perps — delete it in the Ondo Perps UI (API Keys).";
          if (useJson) printJson(jsonOk({ revoked: true, local: true, keystoreRemoved, note }));
          else console.log(chalk.green(`Agent "${agentName}" on ondo removed locally.`) + chalk.yellow(`\n  ${note}`));
          return;
        }
        // ── QFEX: local removal only — the key is revoked in QFEX Developer Settings (website, 2FA) ──
        if (exchange === "qfex") {
          const qfexMeta = getVenueAgent("qfex", agentName);
          if (!qfexMeta) {
            if (useJson) printJson({ ok: true, data: { alreadyRevoked: true } });
            else console.log(`Agent "${agentName}" on qfex not found locally — already removed.`);
            return;
          }
          const { revokeQfexAgentLocal } = await import("../exchanges/qfex/agent.js");
          const keystoreRemoved = revokeQfexAgentLocal(qfexMeta.publicKey);
          deleteVenueAgent("qfex", agentName);
          const note = "The key is still valid on QFEX — revoke it in QFEX Developer Settings (website) to invalidate it.";
          if (useJson) printJson(jsonOk({ revoked: true, local: true, keystoreRemoved, note }));
          else console.log(chalk.green(`Agent "${agentName}" on qfex removed locally.`) + chalk.yellow(`\n  ${note}`));
          return;
        }
        // ── RISEx: RevokeSigner signed by the master wallet (gasless REST); then the key is deleted ──
        if (exchange === "risex") {
          const risexMeta = getVenueAgent("risex", agentName);
          if (!risexMeta) {
            if (useJson) printJson({ ok: true, data: { alreadyRevoked: true } });
            else console.log(`Agent "${agentName}" on risex not found locally — already revoked.`);
            return;
          }
          if (risexMeta.network !== network) {
            throw new PerpError("AGENT_NOT_REGISTERED", `RISEx signer "${agentName}" is registered on ${risexMeta.network}, not ${network}`, {
              remediation: risexMeta.network === "mainnet" ? "Run without -n testnet to revoke it" : "Run with -n testnet to revoke it",
            });
          }
          let txHash: string | null = null;
          if (!localOnly) {
            const masterName = opts.master ?? loadSettings().owsActiveWallet;
            if (!masterName) {
              throw new PerpError("INVALID_PARAMS", "Master wallet name is required to revoke a RISEx signer", {
                remediation: "Use --master <name>, or --force to clear local state only (then revoke it in the RISEx app)",
              });
            }
            const passphrase = await resolvePassphrase({ flag: passphraseFlag });
            const { revokeRisexAgent } = await import("../exchanges/risex/agent.js");
            txHash = (await revokeRisexAgent({ meta: risexMeta, masterOwsWallet: masterName, passphrase })).txHash;
          }
          try { loadOws().deleteWallet(risexMeta.agentWalletName); } catch { /* already gone */ }
          deleteVenueAgent("risex", agentName);
          if (useJson) printJson(jsonOk({ revoked: !localOnly, local: localOnly, txHash }));
          else console.log(localOnly
            ? chalk.yellow(`Agent "${agentName}" on risex removed locally only — revoke signer ${risexMeta.signerAddress} in the RISEx app.`)
            : chalk.green(`Agent "${agentName}" on risex revoked successfully.`));
          return;
        }
        // ── TxFlow: approveAgent with the zero address under the agent's label (master-signed) ──
        if (exchange === "txflow") {
          const txMeta = getVenueAgent("txflow", agentName);
          if (!txMeta) {
            if (useJson) printJson({ ok: true, data: { alreadyRevoked: true } });
            else console.log(`Agent "${agentName}" on txflow not found locally — already revoked.`);
            return;
          }
          if (txMeta.network !== network) {
            throw new PerpError("AGENT_NOT_REGISTERED", `TxFlow agent "${agentName}" is registered on ${txMeta.network}, not ${network}`, {
              remediation: txMeta.network === "mainnet" ? "Run without -n testnet to revoke it" : "Run with -n testnet to revoke it",
            });
          }
          if (txMeta.source === "imported" && !localOnly) {
            throw new PerpError("INVALID_PARAMS", `txflow agent "${agentName}" was imported from the TxFlow web app — this CLI cannot revoke it (it has no master wallet signature for it)`, {
              remediation: `Revoke it in the TxFlow web app, then remove the local copy: perp${network === "testnet" ? " -n testnet" : ""} wallet agent revoke txflow ${agentName} --local-only`,
            });
          }
          if (!localOnly) {
            const masterName = opts.master ?? loadSettings().owsActiveWallet;
            if (!masterName) {
              throw new PerpError("INVALID_PARAMS", "Master wallet name is required to revoke a TxFlow agent", {
                remediation: "Use --master <name>, or --force to clear local state only (then revoke it in the TxFlow web app)",
              });
            }
            const passphrase = await resolvePassphrase({ flag: passphraseFlag });
            const { revokeTxflowAgent } = await import("../exchanges/txflow/agent.js");
            await revokeTxflowAgent({ meta: txMeta, masterOwsWallet: masterName, passphrase });
          }
          const ows = loadOws();
          deleteVenueAgent("txflow", agentName);
          if (ows.listWallets().some((w: { name: string }) => w.name === txMeta.agentWalletName)) {
            const { deleteFailure } = await import("../exchanges/txflow/agent.js");
            const left = deleteFailure(() => ows.deleteWallet(txMeta.agentWalletName));
            if (left !== null) {
              throw new PerpError("APPROVE_PARTIAL", `TxFlow agent "${agentName}" was ${localOnly ? "removed locally" : "revoked"}, but deleting its key failed (${left}): it stayed in OWS wallet "${txMeta.agentWalletName}"`, {
                exchange: "txflow", keyLeftInVault: txMeta.agentWalletName,
                remediation: `Delete the key: ows wallet delete ${txMeta.agentWalletName}${localOnly ? " (and revoke the agent in the TxFlow web app)" : ""}`,
              });
            }
          }
          if (useJson) printJson(jsonOk({ revoked: !localOnly, local: localOnly }));
          else console.log(localOnly
            ? chalk.yellow(`Agent "${agentName}" on txflow removed locally only — revoke agent ${txMeta.agentAddress} in the TxFlow web app.`)
            : chalk.green(`Agent "${agentName}" on txflow revoked successfully.`));
          return;
        }
        // ── Arcus: EIP-712 RevokeApiKey signed by the master wallet ──
        if (exchange === "arcus") {
          const arcusMeta = getVenueAgent("arcus", agentName);
          if (!arcusMeta) {
            if (useJson) printJson({ ok: true, data: { alreadyRevoked: true } });
            else console.log(`Agent "${agentName}" on arcus not found locally — already revoked.`);
            return;
          }
          if (arcusMeta.network !== network) {
            throw new PerpError("AGENT_NOT_REGISTERED", `Arcus API key "${agentName}" is registered on ${arcusMeta.network}, not ${network}`, {
              remediation: arcusMeta.network === "mainnet" ? "Run without -n testnet to revoke it" : "Run with -n testnet to revoke it",
            });
          }
          if (agentSourceOf("arcus", arcusMeta) === "imported") {
            await removeImportedLocally("arcus", network, arcusMeta, agentName, localOnly, useJson);
            return;
          }
          if (!localOnly) {
            const masterName = opts.master ?? loadSettings().owsActiveWallet;
            if (!masterName) {
              throw new PerpError("INVALID_PARAMS", "Master wallet name is required to revoke an Arcus key", {
                remediation: "Use --master <name>, or --force to clear local state only",
              });
            }
            const passphrase = await resolvePassphrase({ flag: passphraseFlag });
            const { revokeArcusAgent } = await import("../exchanges/arcus/agent.js");
            await revokeArcusAgent({ meta: arcusMeta, masterOwsWallet: masterName, passphrase, network });
          }
          deleteVenueAgent("arcus", agentName);
          if (useJson) printJson(jsonOk({ revoked: true }));
          else console.log(chalk.green(`Agent "${agentName}" on arcus revoked successfully.`));
          return;
        }

        // Step 1: Check local meta (idempotent — absent = already revoked)
        const meta = getAgent(exchange, agentName);
        if (!meta) {
          const result = { ok: true, data: { alreadyRevoked: true } };
          if (useJson) {
            printJson(result);
          } else {
            console.log(`Agent "${agentName}" on ${exchange} not found locally — already revoked.`);
          }
          return;
        }
        // A mainnet agent is never revoked (or locally forgotten) from a testnet run, and vice versa.
        assertAgentNetwork(exchange, meta, network);
        if (agentSourceOf(exchange, meta) === "imported") {
          await removeImportedLocally(exchange, network, meta, agentName, localOnly, useJson);
          return;
        }

        if (!localOnly) {
          // Step 2: Resolve passphrase
          const passphrase = await resolvePassphrase({ flag: passphraseFlag });
          if (passphrase === null) {
            throw new PerpError("PASSPHRASE_REQUIRED", "No passphrase provided and stdin is non-TTY", {
              remediation: "Provide passphrase via --passphrase flag, OWS_PASSPHRASE env var, or stdin pipe",
            });
          }

          if (exchange === "hyperliquid") {
            // HL revoke: POST approveAgent with zero-address under the agent's name.
            // Rule #2: do NOT swallow — a failed/unknown revoke throws APPROVE_FAILED
            // before the local record is deleted (Step 6), like Pacifica / Aster.
            const masterName = meta.masterWalletName;
            const masterSigner = OwsEvmSigner.create(masterName, passphrase);
            await revokeHlAgent(masterSigner, network, meta.agentName, meta.agentEvmAddress);
          } else if (exchange === "pacifica") {
            // PAC revoke: signed revoke_agent_wallet → POST /agent/revoke.
            // Rule #2: do NOT swallow. A refused revoke leaves the agent key
            // authorized to trade; suppressing it here would delete the local
            // record (Step 6) and leave the user believing the key is dead.
            // Mirrors the Aster branch below: fail, and offer --force for a
            // local-only cleanup.
            const masterName = meta.masterWalletName;
            const solanaSigner = OwsSolanaSigner.create(masterName, passphrase);
            await revokePacAgent(solanaSigner, meta.agentSolanaAddress ?? null, network);
          } else if (isLighterFamilyVenue(exchange)) {
            // LT / LT-RH revoke: ChangePubKey the slot to a throwaway key (private half
            // discarded) — the old agent key stops working — then delete its keystore file.
            // Rule #2: a failed ChangePubKey throws before the local record is deleted.
            await revokeLtAgent(exchange, network, meta, passphrase);
          } else if (exchange !== "aster") {
            throw new PerpError("UNKNOWN_VENUE", `No revoke path for ${exchange}`);
          } else {
            // Aster revoke: signed DelAgent → DELETE /fapi/v3/agent
            const masterSigner = OwsEvmSigner.create(meta.masterWalletName, passphrase);
            await assertAsterAgentDeleted(
              await deleteAsterAgent(masterSigner, meta.agentEvmAddress, network),
              meta.agentEvmAddress,
              "Retry, or use --force to clear only the local record (the agent stays authorized on Aster until deleted in the Aster UI).",
            );
          }
        }

        // Step 5: Revoke OWS API key (Aster only — HL has no OWS key)
        if (meta.owsApiKeyId) {
          try {
            const ows = loadOws();
            ows.revokeApiKey(meta.owsApiKeyId);
          } catch { /* best effort */ }
        }

        // Step 5b: the venue confirmed the revoke — delete the now-dead OWS agent wallet, so a
        // later approve/rotate can recreate `agent-<dex>-<master>` (OWS refuses duplicate names).
        if (!localOnly && (exchange === "hyperliquid" || exchange === "pacifica" || exchange === "aster")) {
          deleteRevokedAgentWallet(exchange, meta);
        }

        // Step 6: Delete local agent entry (--force: also the Lighter-family slot keystore file)
        if (localOnly && isLighterFamilyVenue(exchange) && typeof meta.accountIndex === "number" && typeof meta.apiKeyIndex === "number") {
          const { deleteLighterFamilyKey } = await import("../agent-wallet/lighter-keystore.js");
          deleteLighterFamilyKey(exchange, network, meta.accountIndex, meta.apiKeyIndex);
        }
        deleteAgent(exchange, agentName);

        if (localOnly) {
          // Local-only: nothing was sent, so the key is NOT revoked on the venue.
          const note = `The agent key was NOT revoked on ${exchange} and may still be authorized — revoke it in the venue UI, or re-run without --force.`;
          if (useJson) printJson(jsonOk({ revoked: false, localOnly: true, note }));
          else console.log(chalk.yellow(`Agent "${agentName}" on ${exchange} removed locally only. ${note}`));
        } else if (useJson) {
          printJson(jsonOk({ revoked: true }));
        } else {
          console.log(chalk.green(`Agent "${agentName}" on ${exchange} revoked successfully.`));
        }
      } catch (err) {
        reportErrorAndExit(err);
      }
    });

  // ── agent rotate <exchange> [<oldAgentName>] ─────────────────────────────
  agent
    .command("rotate <exchange> [oldAgentName]")
    .description("Rotate an agent wallet: revoke existing, then approve with same name")
    .addOption(deprecatedPassphraseOption()).hook("preAction", warnDeprecatedPassphrase)
    .option("--master <name>", "Master OWS wallet name (default: the old agent's master, then settings.owsActiveWallet)")
    .option("--agent-name <name>", "Agent name to rotate (default: first registered agent)")
    .option("--expires-in <duration>", "New expiry (default: 90d)")
    .option("--can-perp", "Allow perp trading (default: inherit or on)")
    .option("--no-can-perp", "Disallow perp trading")
    .option("--can-spot", "Allow spot trading (default: inherit or off)")
    .option("--no-can-spot", "Disallow spot trading")
    .option("--can-withdraw", "Allow withdrawals (default: off — never inherited from the old agent; Aster also needs --ip-whitelist)")
    .option("--no-can-withdraw", "Disallow withdrawals (the default)")
    .option("--ip-whitelist <list>", "Aster IP whitelist, comma- or space-separated (required with --can-withdraw)")
    .option("--json", "Machine-readable output")
    .action(async (exchangeArg: string, oldAgentNameArg: string | undefined, opts: {
      passphrase?: string;
      master?: string;
      agentName?: string;
      expiresIn?: string;
      canPerp?: boolean;
      canSpot?: boolean;
      canWithdraw?: boolean;
      ipWhitelist?: string;
      json?: boolean;
    }, command: Command) => {
      const useJson = opts.json ?? isJson();
      // optsWithGlobals(): see wallet agent approve for full rationale.
      const mergedOpts = command.optsWithGlobals() as { passphrase?: string };
      const passphraseFlag = mergedOpts.passphrase ?? opts.passphrase;

      try {
        const exchange = resolveVenueId(exchangeArg);
        if (exchange !== "aster" && exchange !== "hyperliquid" && exchange !== "pacifica" && !isLighterFamilyVenue(exchange)) {
          throw new PerpError("NOT_IMPLEMENTED", `rotate is not supported for ${exchange}`, {
            remediation: `Run: perp wallet agent revoke ${exchange} <name>, then perp wallet agent approve ${exchange}`,
          });
        }
        const network = networkOf(command);
        // Determine which agent to rotate (default: first agent registered on this network)
        const agentNameToRotate = oldAgentNameArg ?? opts.agentName ?? getAgentForNetwork(exchange, network)?.agentName;
        const imported = agentNameToRotate !== undefined ? getAgent(exchange, agentNameToRotate) : null;
        if (imported === null || agentSourceOf(exchange, imported) !== "imported") assertAgentApproveSupported(exchange, network, "rotate");
        if (!agentNameToRotate) {
          throw new PerpError("AGENT_NOT_REGISTERED", `No agent found for ${exchange}`, {
            remediation: `Run: perp wallet agent approve ${exchange} to create one`,
          });
        }

        const outcome = await rotateVenueAgent({
          exchange, network, agentNameToRotate,
          master: opts.master || null,
          passphrase: () => resolvePassphrase({ flag: passphraseFlag }),
          expiresIn: opts.expiresIn ?? "90d",
          canPerp: opts.canPerp, canSpot: opts.canSpot, canWithdraw: opts.canWithdraw,
          ipWhitelist: opts.ipWhitelist,
        });
        const rotatedAgentAddress = rotatedAgentAddressOf(outcome);
        const expiresAtIso = outcome.expiresAt;
        if (useJson) {
          printJson(jsonOk({ rotated: true, agentName: agentNameToRotate, agentEvmAddress: rotatedAgentAddress, expiresAt: expiresAtIso }));
        } else {
          console.log(chalk.green(`Agent "${agentNameToRotate}" on ${exchange} rotated successfully.`));
          console.log(`  New agent address: ${chalk.cyan(rotatedAgentAddress)}`);
          console.log(`  Expires: ${chalk.cyan(expiresAtIso)}`);
        }
      } catch (err) {
        reportErrorAndExit(err);
      }
    });

  // ── agent verify [exchange] [agentName] ──────────────────────────────────
  agent
    .command("verify [exchange] [agentName]")
    .description("Verify agent wallet registration via DEX query API")
    .option("--master <name>", "Master OWS wallet name (Aster/PAC). Defaults to settings.owsActiveWallet")
    .option("--master-address <addr>", "Master EVM address (HL only)")
    .option("--account-index <n>", "Account index (Lighter only)")
    .addOption(deprecatedPassphraseOption()).hook("preAction", warnDeprecatedPassphrase)
    .option("--json", "Machine-readable output")
    .action(async (exchange: string | undefined, agentName: string | undefined, opts: {
      master?: string;
      masterAddress?: string;
      accountIndex?: string;
      passphrase?: string;
      json?: boolean;
    }, command: Command) => {
      const useJson = opts.json ?? isJson();
      const ts = new Date().toISOString();
      // optsWithGlobals(): see wallet agent approve for full rationale.
      const mergedOpts = command.optsWithGlobals() as { passphrase?: string };
      const passphraseFlag = mergedOpts.passphrase ?? opts.passphrase;

      // Resolve passphrase via 3-path: flag > env > (no stdin prompt in verify)
      const passphrase = passphraseFlag ?? process.env["OWS_PASSPHRASE"] ?? "";

      const verifyOpts: VerifyOpts = {
        agentName,
        master: opts.master,
        masterAddress: opts.masterAddress,
        accountIndex: opts.accountIndex,
        passphrase,
      };

      if (!exchange) {
        // Aggregate mode: every account venue with configured credentials, in parallel
        let network: Network;
        try {
          network = networkOf(command);
        } catch (err) {
          reportErrorAndExit(err);
        }
        const venues = await listConfiguredAccountVenues();
        const results = await Promise.allSettled(venues.map(v => verifyVenue(v, network, verifyOpts)));

        function slotResult(r: PromiseSettledResult<VerifyResult>) {
          if (r.status === "fulfilled") {
            const slot: Record<string, unknown> = { registered: r.value.registered, count: r.value.count, items: r.value.items };
            if (r.value.warnings && r.value.warnings.length > 0) slot.warnings = r.value.warnings;
            return slot;
          }
          const err = r.reason instanceof PerpError ? r.reason : null;
          return {
            error: {
              code: err ? err.structured.code : "EXCHANGE_ERROR",
              message: err ? err.structured.message : (r.reason instanceof Error ? r.reason.message : String(r.reason)),
              remediation: err ? err.structured.remediation : undefined,
            },
          };
        }

        const data: Record<string, ReturnType<typeof slotResult>> = Object.fromEntries(
          venues.map((v, i) => [v, slotResult(results[i])]),
        );

        if (useJson) {
          printJson({ ok: true, data, meta: { timestamp: ts } });
        } else {
          console.log(chalk.bold("Agent Verify — All DEXs"));
          for (const [dex, slot] of Object.entries(data)) {
            if ("error" in slot) {
              console.log(chalk.yellow(`  ${dex}: ERROR — ${(slot as { error: { message: string } }).error.message}`));
            } else {
              const s = slot as { registered: boolean; count: number; warnings?: string[] };
              const icon = s.registered ? chalk.green("✓") : chalk.gray("○");
              console.log(`  ${icon} ${dex}: ${s.count} agent(s) registered`);
              for (const w of s.warnings ?? []) {
                console.log(chalk.yellow(`      [warn] ${w}`));
              }
            }
          }
        }
        return;
      }

      // Single-DEX mode
      try {
        const ex = resolveVenueId(exchange);
        const result = await verifyVenue(ex, networkOf(command), verifyOpts);

        if (useJson) {
          printJson({
            ok: true,
            data: { exchange: ex, registered: result.registered, count: result.count, items: result.items },
            meta: { timestamp: ts, ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}) },
          });
        } else {
          const icon = result.registered ? chalk.green("✓") : chalk.gray("○");
          console.log(`${icon} ${chalk.bold(ex)}: ${result.count} agent(s) registered`);
          if (result.count > 0) {
            if (ex === "aster") {
              console.log(chalk.dim("  agentAddress               | agentName        | expired     | canPerp | canSpot | canWithdraw"));
              for (const item of result.items) {
                const i = item as Record<string, unknown>;
                const addr = String(i["agentAddress"] ?? "").substring(0, 20) + "…";
                const name = String(i["agentName"] ?? "").padEnd(16);
                const exp = i["expired"] !== undefined ? String(i["expired"]) : "—";
                const cp = i["canPerpTrade"] ? "yes" : "no";
                const cs = i["canSpotTrade"] ? "yes" : "no";
                const cw = i["canWithdraw"] ? "yes" : "no";
                console.log(`  ${addr} | ${name} | ${exp} | ${cp.padEnd(7)} | ${cs.padEnd(7)} | ${cw}`);
              }
            } else if (ex === "hyperliquid") {
              console.log(chalk.dim("  address                    | validUntil  | name"));
              for (const item of result.items) {
                const i = item as Record<string, unknown>;
                const addr = String(i["address"] ?? "").substring(0, 20) + "…";
                const vu = i["validUntil"] !== undefined ? String(i["validUntil"]) : "—";
                const name = String(i["name"] ?? "");
                console.log(`  ${addr} | ${vu.padEnd(11)} | ${name}`);
              }
            } else if (isLighterFamilyVenue(ex)) {
              console.log(chalk.dim("  api_key_index | public_key (truncated)  | nonce | transaction_time"));
              for (const item of result.items) {
                const i = item as Record<string, unknown>;
                const idx = String(i["api_key_index"] ?? "");
                const pk = String(i["public_key"] ?? "").substring(0, 20) + "…";
                const nonce = String(i["nonce"] ?? "");
                const tt = String(i["transaction_time"] ?? "");
                console.log(`  ${idx.padEnd(13)} | ${pk.padEnd(23)} | ${nonce.padEnd(5)} | ${tt}`);
              }
            } else if (ex === "pacifica") {
              console.log(chalk.dim("  api_key (truncated)      | created_at"));
              for (const item of result.items) {
                const i = item as Record<string, unknown>;
                const key = String(i["api_key"] ?? "").substring(0, 20) + "…";
                const created = String(i["created_at"] ?? "");
                console.log(`  ${key.padEnd(24)} | ${created}`);
              }
            }
          }
          if (result.warnings && result.warnings.length > 0) {
            for (const w of result.warnings) {
              process.stderr.write(chalk.yellow(`[warn] ${w}\n`));
            }
          }
        }
      } catch (err) {
        reportErrorAndExit(err);
      }
    });
}

/**
 * Revoke for an IMPORTED key: the CLI holds no master wallet signature for it, so it never claims
 * a venue revoke. Without --local-only → refused; with it → the local key copy and record are
 * deleted and the user is told the key is still authorized on the exchange.
 */
async function removeImportedLocally(
  exchange: VenueId, network: Network, meta: AgentMeta | ArcusAgentMeta, agentName: string, localOnly: boolean, useJson: boolean,
): Promise<void> {
  const where = `${getVenue(exchange).displayName} website`;
  if (!localOnly) {
    throw new PerpError("INVALID_PARAMS", `${exchange} agent "${agentName}" was imported from the exchange website — this CLI cannot revoke it (it has no master wallet signature for it)`, {
      remediation: `Revoke / delete the key on the ${where}, then remove the local copy: perp${network === "testnet" ? " -n testnet" : ""} wallet agent revoke ${exchange} ${agentName} --local-only`,
    });
  }
  const { deleteImportedAgentLocal } = await import("./agent-import.js");
  const { keyRemoved } = await deleteImportedAgentLocal(exchange, network, meta);
  const note = `The key is still authorized on the exchange — revoke it on the ${where}.`;
  if (useJson) printJson(jsonOk({ revoked: false, localOnly: true, keyRemoved, note }));
  else console.log(chalk.yellow(`Imported agent "${agentName}" on ${exchange} removed from this computer${keyRemoved ? " (local key deleted)" : ""}. ${note}`));
}

/**
 * After a venue-CONFIRMED revoke, delete the agent's OWS wallet (its key can no longer trade).
 * Absent wallet = nothing to do. A delete failure throws (Rule #2) with the exact cleanup step.
 */
function deleteRevokedAgentWallet(exchange: "hyperliquid" | "pacifica" | "aster", meta: AgentMeta): void {
  const name = meta.agentWalletName;
  if (!name) return;
  const ows = loadOws();
  if (!ows.listWallets().some((w: { name: string }) => w.name === name)) return;
  try {
    ows.deleteWallet(name);
  } catch (e) {
    throw new PerpError("APPROVE_PARTIAL", `${exchange} agent "${meta.agentName}" was revoked, but deleting its OWS wallet "${name}" failed: ${e instanceof Error ? e.message : String(e)}`, {
      exchange,
      remediation: `The key is revoked on ${exchange}. Delete the wallet manually (ows wallet delete ${name}), then re-run.`,
    });
  }
}

// ── Pre-venue rollback helpers ───────────────────────────────────────────────
//
// When `wallet agent approve <dex>` fails BEFORE the venue accepted the agent
// (HTTP error, body-code rejection, parse error, network drop), the locally
// generated `agent-<dex>-<master>` OWS wallet is orphaned in `~/.ows/wallets/`.
// Retry collides with "wallet name already exists". These helpers auto-delete
// the orphan and produce an actionable remediation string.
//
// Post-venue (persist-only) failures must NOT use these — those leave a
// status:"partial" record so the user can still revoke venue-side state.

/**
 * Best-effort delete of an orphan local OWS wallet. Returns true on success,
 * false on failure (also logs the failure to stderr per SSOT Rule #2: rollback
 * failures must not silently mask the original error). The caller threads the
 * boolean into the user-visible remediation.
 */
function tryDeleteOrphanWallet(
  ows: { deleteWallet: (name: string) => void },
  walletName: string | undefined,
): boolean {
  if (!walletName) return false;
  try {
    ows.deleteWallet(walletName);
    return true;
  } catch (cleanupErr) {
    // Don't swallow — surface the rollback failure on stderr so the user can
    // see exactly what's stuck. Original error still propagates from caller.
    process.stderr.write(
      `[warn] failed to clean up orphan wallet "${walletName}": ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`,
    );
    return false;
  }
}

/**
 * Build an actionable remediation message for pre-venue approve failures.
 * On clean rollback: tells the user to deposit + retry the canonical
 * `wallet agent approve <dex> --master <master>` command (no manual steps).
 * On rollback failure: tells the user to manually delete the orphan wallet
 * before retrying. The agent address is appended for diagnostic purposes
 * (some users may need it for the venue UI).
 */
function buildPreVenueRemediation(opts: {
  cleanupOk: boolean;
  dex: "hyperliquid" | "pacifica" | "aster";
  network: Network;
  masterName: string;
  agentAddress: string;
  hint?: string;
}): string {
  const { cleanupOk, dex, network, masterName, agentAddress, hint } = opts;
  const retry = `perp${network === "testnet" ? " -n testnet" : ""} wallet agent approve ${dex} --master ${masterName}`;
  const walletName = agentWalletNameFor(dex === "hyperliquid" ? "hl" : dex === "pacifica" ? "pac" : "aster", masterName, network);
  const head = cleanupOk
    ? `Local agent wallet cleaned up. Deposit funds and retry: ${retry}`
    : `Manual cleanup required — local agent wallet may still exist. Run: perp wallet remove ${walletName}, then retry: ${retry}`;
  const parts = [head];
  if (hint) parts.push(hint);
  parts.push(`Agent address (diagnostic): ${agentAddress}`);
  return parts.join(" | ");
}

// ── Shared approve flow helper ───────────────────────────────────────────────

interface ApproveFlowOpts {
  network: Network;
  masterName: string;
  passphrase: string;
  agentName: string;
  expiresAt: Date;
  expiredMs: number;
  expiresAtIso: string;
  nonceMicros: number;
  nowIso: string;
  canPerp: boolean;
  canSpot: boolean;
  canWithdraw: boolean;
  ipWhitelist?: string;
}

export interface ApproveFlowResult {
  agentAddress: `0x${string}`;
  agentName: string;
  expiresAt: string;
  owsApiKeyId: string;
  policyId: string;
  asterApprovalNonce: string;
  userEvmAddress: `0x${string}`;
}

/**
 * Core approve flow: Steps 2-12 (OWS wallet + policy + api-key + EIP-712 + Aster POST + persist).
 * Caller MUST hold the exchange lock before calling this function.
 * The function is re-entrant safe with setAgent because callerHoldsLock() will
 * return true when called from within a locked context.
 */
async function runApproveFlow(opts: ApproveFlowOpts): Promise<ApproveFlowResult> {
  const {
    network, masterName, passphrase, agentName, expiredMs, expiresAtIso, nonceMicros, nowIso,
    canPerp, canSpot, canWithdraw,
  } = opts;
  assertAgentApproveSupported("aster", network, "approve");
  // Withdraw permission requires an IP whitelist on both networks (V3 docs: mandatory when
  // canWithdraw is true) — refused before any OWS resource is created or anything is signed.
  assertAsterWithdrawIpWhitelist(canWithdraw, opts.ipWhitelist);
  if (network === "testnet") {
    // Validate registerAndApproveAgent inputs before any OWS resource is created.
    if (/[&=]/.test(agentName) || /[&=]/.test(opts.ipWhitelist ?? "")) {
      throw new PerpError("INVALID_PARAMS", "Aster registerAndApproveAgent: agent name and IP whitelist must not contain '&' or '='", {
        remediation: "Choose another --agent-name / --ip-whitelist",
      });
    }
  }
  const baseUrl = networkConfig(getVenue("aster"), network).restUrl;
  let owsApiKeyId: string | undefined;
  let owsPolicyId: string | undefined;
  let agentEvmAddress: `0x${string}` | undefined;
  let agentWalletName: string | undefined;

  // Steps 2-3: Resolve master signer
  const masterSigner = OwsEvmSigner.create(masterName, passphrase);
  const userEvmAddress = masterSigner.getAddress() as `0x${string}`;

  // Step 4: Generate agent OWS wallet
  const ows = loadOws();
  agentWalletName = agentWalletNameFor("aster", masterName, network);
  assertAgentWalletNameFree("aster", agentWalletName, network);
  const agentWallet = ows.createWallet(agentWalletName, passphrase);
  const agentEvmAccount = agentWallet.accounts.find(
    (a: { chainId: string }) => a.chainId.startsWith("eip155:"),
  );
  if (!agentEvmAccount) {
    throw new PerpError("INVALID_PARAMS", `Agent wallet "${agentWalletName}" has no EVM account`, {
      remediation: "Check OWS vault configuration",
    });
  }
  agentEvmAddress = agentEvmAccount.address as `0x${string}`;

  // Step 5: Build OWS policy
  const policyId = `aster-perp-${Date.now()}`;
  owsPolicyId = policyId;
  ows.createPolicy(JSON.stringify({
    id: policyId,
    name: `perp-cli-aster-${agentName}`,
    version: 1,
    created_at: nowIso,
    rules: [{ type: "allowed_chains", chain_ids: ["eip155:56"] }],
    expires_at: expiresAtIso,
    executable: null,
    action: "deny",
  }));

  // Step 6: Build OWS API key — store only the id, never the token
  const apiKeyResult = ows.createApiKey(
    `api-aster-${agentName}`,
    [agentWallet.id],
    [policyId],
    passphrase,
    expiresAtIso,
  );
  owsApiKeyId = apiKeyResult.id;

  // Steps 8-11: sign + POST. Testnet uses the documented unauthenticated
  // POST /fapi/v3/registerAndApproveAgent (asterdex/api-docs V3 testnet, 2026-05-12);
  // the AsterChain-bearing Domain A approveAgent struct is documented for mainnet only.
  // Mainnet keeps approveAgent: it is the live-verified path, and the docs describe
  // registerAndApproveAgent as "equivalent to the standalone registration step followed
  // by approveAgent" — an alternative, not a replacement.
  const endpoint = network === "testnet" ? "registerAndApproveAgent" : "approveAgent";
  const agentRes = network === "testnet"
    ? await postAsterRegisterAndApproveAgent({
        baseUrl, masterSigner, user: userEvmAddress, agentAddress: agentEvmAddress, agentName,
        expiredMs, nonceMicros, canPerp, canSpot, canWithdraw, ipWhitelist: opts.ipWhitelist,
      })
    : await postAsterApproveAgent({
        network, baseUrl, masterSigner, user: userEvmAddress, agentAddress: agentEvmAddress, agentName,
        expiredMs, nonceMicros, canPerp, canSpot, canWithdraw, ipWhitelist: opts.ipWhitelist,
      });
  let asterPostSucceeded = false;
  if (agentRes.ok) {
    const resp = await agentRes.json() as { code: string | number; msg?: string; message?: string };
    if (resp.code === "000000" || resp.code === 200) {
      asterPostSucceeded = true;
    } else {
      // Aster POST body indicated failure — pre-venue (Aster did not register).
      // Rollback both api key + orphan local OWS wallet.
      if (owsApiKeyId) {
        try { ows.revokeApiKey(owsApiKeyId); } catch { /* best effort */ }
      }
      const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
      const errMsg = resp.msg ?? resp.message ?? String(resp.code);
      throw new PerpError("APPROVE_PARTIAL", `Aster ${endpoint} failed: ${errMsg}`, {
        remediation: buildPreVenueRemediation({
          cleanupOk, dex: "aster", network, masterName, agentAddress: agentEvmAddress,
        }),
      });
    }
  } else {
    // HTTP error — pre-venue (Aster did not register). Rollback both.
    if (owsApiKeyId) {
      try { ows.revokeApiKey(owsApiKeyId); } catch { /* best effort */ }
    }
    const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
    const errText = await agentRes.text().catch(() => "");
    throw new PerpError("APPROVE_PARTIAL", `Aster ${endpoint} failed (${agentRes.status}): ${errText.slice(0, 200)}`, {
      remediation: buildPreVenueRemediation({
        cleanupOk, dex: "aster", network, masterName, agentAddress: agentEvmAddress,
      }),
    });
  }

  // Step 12: Persist agent meta
  // Note: setAgent is re-entrant — if caller holds the lock, it writes directly.
  try {
    setAgent("aster", {
      agentName,
      agentWalletName,
      agentEvmAddress,
      userEvmAddress,
      masterWalletName: masterName,
      owsApiKeyId,
      owsPolicyId,
      expiresAt: expiresAtIso,
      approvedAt: nowIso,
      permissions: { canPerpTrade: canPerp, canSpotTrade: canSpot, canWithdraw },
      asterApprovalNonce: String(nonceMicros),
      status: "active",
      network,
    });
  } catch (persistErr) {
    // Settings persist failed AFTER Aster registration succeeded.
    // CRITICAL-2 fix: attempt BOTH remote DELETE and local revokeApiKey.
    // Only if BOTH succeed → APPROVE_FAILED (clean). Otherwise → APPROVE_PARTIAL.
    let deleteOk = false;
    let revokeOk = false;

    // Attempt remote DELETE /fapi/v3/agent
    try {
      const delRes = await deleteAsterAgent(masterSigner, agentEvmAddress, network);
      deleteOk = delRes.ok || delRes.status === 404;
    } catch { /* best effort */ }

    // Attempt local API key revocation
    if (owsApiKeyId) {
      try { ows.revokeApiKey(owsApiKeyId); revokeOk = true; } catch { /* best effort */ }
    } else {
      revokeOk = true; // nothing to revoke
    }

    if (deleteOk && revokeOk) {
      // Clean rollback — throw APPROVE_FAILED (not partial)
      throw new PerpError("APPROVE_FAILED", `Agent approve failed: settings persist error after clean rollback. ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`, {
        remediation: `Both remote Aster agent and local OWS API key have been cleaned up. Retry: perp wallet agent approve aster`,
      });
    }

    // Partial state — at least one cleanup failed. Save partial record for recovery.
    const failedSteps: string[] = [];
    if (!deleteOk) failedSteps.push("Aster DELETE /fapi/v3/agent");
    if (!revokeOk) failedSteps.push("OWS revokeApiKey");

    try {
      setAgent("aster", {
        agentName,
        agentWalletName: agentWalletName ?? "",
        agentEvmAddress: agentEvmAddress!,
        userEvmAddress,
        masterWalletName: masterName,
        owsApiKeyId: owsApiKeyId ?? "",
        owsPolicyId: owsPolicyId ?? "",
        expiresAt: expiresAtIso,
        approvedAt: nowIso,
        permissions: { canPerpTrade: canPerp, canSpotTrade: canSpot, canWithdraw },
        asterApprovalNonce: String(nonceMicros),
        status: "partial",
        network,
      });
    } catch { /* best effort — already in a bad state */ }

    throw new PerpError("APPROVE_PARTIAL", `Agent registered on Aster but persist+cleanup failed. Failed steps: ${failedSteps.join(", ")}. Persist error: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`, {
      remediation: `Aster agent address: ${agentEvmAddress}. Run: perp wallet agent approve aster --rotate to re-register`,
    });
  }

  return {
    agentAddress: agentEvmAddress,
    agentName,
    expiresAt: expiresAtIso,
    owsApiKeyId,
    policyId: owsPolicyId,
    asterApprovalNonce: String(nonceMicros),
    userEvmAddress,
  };
}

interface AsterAgentPostOpts {
  baseUrl: string;
  masterSigner: OwsEvmSigner;
  user: `0x${string}`;
  agentAddress: `0x${string}`;
  agentName: string;
  expiredMs: number;
  nonceMicros: number;
  canPerp: boolean;
  canSpot: boolean;
  canWithdraw: boolean;
  ipWhitelist?: string;
}

/** Mainnet: master-signed Domain A ApproveAgent → POST /fapi/v3/approveAgent. */
async function postAsterApproveAgent(o: AsterAgentPostOpts & { network: Network }): Promise<Response> {
  assertAsterDomainAMainnet(o.network);
  const asterChain = asterChainOf(o.network);
  const approveTypedData = buildApproveAgentTypedData({
    user: o.user,
    agentAddress: o.agentAddress,
    agentName: o.agentName,
    expiredMs: o.expiredMs,
    canPerpTrade: o.canPerp,
    canSpotTrade: o.canSpot,
    canWithdraw: o.canWithdraw,
    ipWhitelist: o.ipWhitelist,
    nonceMicros: o.nonceMicros,
    asterChain,
  });
  const signature = await o.masterSigner.signTypedData(
    approveTypedData.domain as Record<string, unknown>,
    approveTypedData.types as Record<string, Array<{ name: string; type: string }>>,
    approveTypedData.message,
  );
  const qsEntries: [string, string][] = [
    ["agentName", o.agentName],
    ["agentAddress", o.agentAddress],
  ];
  if (o.ipWhitelist !== undefined && o.ipWhitelist !== null) {
    qsEntries.push(["ipWhitelist", o.ipWhitelist]);
  }
  qsEntries.push(
    ["expired", String(o.expiredMs)],
    ["canSpotTrade", String(o.canSpot)],
    ["canPerpTrade", String(o.canPerp)],
    ["canWithdraw", String(o.canWithdraw)],
    ["asterChain", asterChain],
    ["user", o.user],
    ["nonce", String(o.nonceMicros)],
    ["signature", signature],
    ["signatureChainId", String(ASTER_DOMAIN_A.chainId)],
  );
  return fetch(`${o.baseUrl}/fapi/v3/approveAgent?${new URLSearchParams(Object.fromEntries(qsEntries)).toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "",
  });
}

/** Aster: an API wallet with withdraw permission must carry an IP whitelist (pre-flight, nothing signed). */
export function assertAsterWithdrawIpWhitelist(canWithdraw: boolean, ipWhitelist: string | undefined): void {
  if (!canWithdraw || asterSpaceIpWhitelist(ipWhitelist) !== "") return;
  throw new PerpError("INVALID_PARAMS", "Aster requires an IP whitelist when an API wallet is granted the withdraw permission", {
    remediation: "Pass --ip-whitelist \"<ip> <ip/cidr>\" together with --can-withdraw, or drop --can-withdraw",
  });
}

/**
 * Normalize the `--ip-whitelist` flag (comma- or space-separated) to the
 * space-delimited form registerAndApproveAgent signs; "" when absent.
 */
export function asterSpaceIpWhitelist(raw: string | undefined): string {
  if (raw === undefined) return "";
  return raw.split(/[,\s]+/).filter(s => s.length > 0).join(" ");
}

/**
 * Testnet: POST /fapi/v3/registerAndApproveAgent (unauthenticated; the master
 * EVM wallet signs the literal param string as Message{msg}, domain chainId =
 * signatureChainId = 56). Params are sent in the signed order plus `signature`.
 */
async function postAsterRegisterAndApproveAgent(o: AsterAgentPostOpts): Promise<Response> {
  const { buildRegisterAndApproveAgentTypedData, ASTER_REGISTER_AGENT_EVM_CHAIN_ID } = await import("../exchanges/aster-typed-data.js");
  const td = buildRegisterAndApproveAgentTypedData({
    user: o.user,
    nonceMicros: o.nonceMicros,
    agentName: o.agentName,
    agentAddress: o.agentAddress,
    expiredMs: o.expiredMs,
    signatureChainId: ASTER_REGISTER_AGENT_EVM_CHAIN_ID,
    canSpotTrade: o.canSpot,
    canPerpTrade: o.canPerp,
    canWithdraw: o.canWithdraw,
    ipWhitelist: asterSpaceIpWhitelist(o.ipWhitelist),
  });
  const signature = await o.masterSigner.signTypedData(
    td.domain as Record<string, unknown>,
    td.types as unknown as Record<string, Array<{ name: string; type: string }>>,
    td.message,
  );
  const qs = new URLSearchParams([...td.params, ["signature", signature]]);
  return fetch(`${o.baseUrl}/fapi/v3/registerAndApproveAgent?${qs.toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "",
  });
}

/** Aster `AsterChain` field for the network (signed into Domain A messages and sent as a query param). */
function asterChainOf(network: Network): "Mainnet" | "Testnet" {
  return network === "testnet" ? "Testnet" : "Mainnet";
}

/**
 * Master-signed DelAgent → DELETE /fapi/v3/agent on the selected network's
 * host. Returns the raw response; callers decide how to treat non-2xx.
 */
async function deleteAsterAgent(masterSigner: OwsEvmSigner, agentAddress: `0x${string}`, network: Network): Promise<Response> {
  assertAgentApproveSupported("aster", network, "revoke");
  assertAsterDomainAMainnet(network);
  const userEvmAddress = masterSigner.getAddress() as `0x${string}`;
  const asterChain = asterChainOf(network);
  const nonceMicros = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const delTypedData = buildDelAgentTypedData({ user: userEvmAddress, agentAddress, nonceMicros, asterChain });
  const signature = await masterSigner.signTypedData(
    delTypedData.domain as Record<string, unknown>,
    delTypedData.types as Record<string, Array<{ name: string; type: string }>>,
    delTypedData.message,
  );
  const qs = new URLSearchParams(Object.fromEntries([
    ["agentAddress", agentAddress],
    ["asterChain", asterChain],
    ["user", userEvmAddress],
    ["nonce", String(nonceMicros)],
    ["signature", signature],
    ["signatureChainId", String(ASTER_DOMAIN_A.chainId)],
  ] as [string, string][]));
  return fetch(`${networkConfig(getVenue("aster"), network).restUrl}/fapi/v3/agent?${qs.toString()}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "",
  });
}

/**
 * Decide an Aster DELETE /fapi/v3/agent response. 2xx = deleted; 404 = already
 * gone server-side (idempotent). Anything else — or a 2xx JSON body carrying a
 * negative Aster error `code` — throws APPROVE_FAILED: the agent may still be
 * authorized, so the caller must keep its local record.
 */
async function assertAsterAgentDeleted(res: Response, agentAddress: string, nextStep: string): Promise<void> {
  if (res.status === 404) return;
  const text = await res.text();
  const remediation = `The agent key may still be authorized to trade. ${nextStep} Agent: ${agentAddress}`;
  if (!res.ok) {
    throw new PerpError("APPROVE_FAILED", `Aster agent delete failed (${res.status}): ${text.slice(0, 200)}`, {
      exchange: "aster",
      remediation,
    });
  }
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* non-JSON 2xx body: the venue accepted it */ }
  const code = body !== null && typeof body === "object" ? (body as { code?: unknown }).code : null;
  if (typeof code === "number" && code < 0) {
    throw new PerpError("APPROVE_FAILED", `Aster agent delete rejected: ${text.slice(0, 200)}`, {
      exchange: "aster",
      remediation,
    });
  }
}

/**
 * Parse an expires-in string to a Date.
 * Accepts: "30d", "90d", "180d", "1y", or any ISO-8601 datetime string.
 * Throws if malformed.
 */
export function parseExpiresIn(value: string): Date {
  const v = value.trim();
  // Match Nd (days) or Ny (years)
  const daysMatch = v.match(/^(\d+)d$/i);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    return new Date(Date.now() + days * 24 * 3600 * 1000);
  }
  const yearsMatch = v.match(/^(\d+)y$/i);
  if (yearsMatch) {
    const years = parseInt(yearsMatch[1], 10);
    return new Date(Date.now() + years * 365 * 24 * 3600 * 1000);
  }
  // Try ISO-8601
  const d = new Date(v);
  if (!isNaN(d.getTime())) {
    return d;
  }
  throw new PerpError("INVALID_PARAMS", `Invalid expires-in value: "${v}". Use: 30d, 90d, 180d, 1y, or ISO-8601 datetime`, {
    remediation: "Use: 30d, 90d, 180d, 1y, or ISO-8601 datetime",
  });
}

// ── Hyperliquid agent approve/revoke helpers (Phase 2b) ──────────────────────

/**
 * EIP-712 domain for HL user-signed actions on `network`. chainId must equal
 * the action's signatureChainId (HL_USER_SIGNED in the venue definition).
 */
function hlUserSignedDomain(network: Network): Record<string, unknown> {
  return {
    name: "HyperliquidSignTransaction",
    version: "1",
    chainId: HL_USER_SIGNED[network].signatureChainId,
    verifyingContract: "0x0000000000000000000000000000000000000000",
  };
}

/** POST /exchange URL for `network` (venue definition restUrl). */
function hlExchangeUrl(network: Network): string {
  return `${networkConfig(getVenue("hyperliquid"), network).restUrl}/exchange`;
}

/** EIP-712 types for HyperliquidTransaction:ApproveAgent */
const HL_APPROVE_AGENT_TYPES = {
  "HyperliquidTransaction:ApproveAgent": [
    { name: "hyperliquidChain", type: "string" },
    { name: "agentAddress", type: "address" },
    { name: "agentName", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** Hyperliquid approveAgent: "The expiration can be at most 180 days in the future" (exchange-endpoint docs). */
const HL_AGENT_MAX_VALIDITY_MS = 180 * 86_400_000;

interface HlApproveFlowOpts {
  network: Network;
  masterName: string;
  passphrase: string;
  agentName: string;
  expiresAt: Date;
  expiresAtIso: string;
  nowIso: string;
  canPerp: boolean;
  canSpot: boolean;
  canWithdraw: boolean;
}

export interface HlApproveFlowResult {
  agentAddress: `0x${string}`;
  agentName: string;
  expiresAt: string;
  userEvmAddress: `0x${string}`;
}

/**
 * Core HL approve flow.
 * Caller MUST hold the "hyperliquid" lock before calling this function.
 *
 * Steps:
 *  1. Resolve master via OwsEvmSigner.create
 *  2. Generate agent OWS wallet (eip155-only, name `agent-hl-<masterName>`)
 *  3. Build HL approveAgent action + EIP-712 message
 *  4. Master signs EIP-712 (user-signed domain; hyperliquidChain + signatureChainId per network)
 *  5. POST <network restUrl>/exchange
 *  6. On success: persist AgentMeta to settings.agents.hyperliquid[name]
 */
async function runHlApproveFlow(opts: HlApproveFlowOpts): Promise<HlApproveFlowResult> {
  const { network, masterName, passphrase, agentName, expiresAt, expiresAtIso, nowIso, canPerp, canSpot, canWithdraw } = opts;
  const { hyperliquidChain, signatureChainIdHex } = HL_USER_SIGNED[network];
  // Hyperliquid rejects extra-agent names outside 1..16 characters; refuse before any wallet is created.
  // The check covers the name itself: the venue docs state no length rule, and the documented
  // expiry suffix below is by itself longer than 16 characters.
  if (agentName.length < 1 || agentName.length > 16) {
    throw new PerpError("INVALID_PARAMS", `Hyperliquid agent name "${agentName}" must be 1-16 characters (got ${agentName.length})`, {
      remediation: "Pass a shorter --agent-name",
    });
  }
  if (agentName.includes("valid_until")) {
    throw new PerpError("INVALID_PARAMS", `Hyperliquid agent name "${agentName}" must not contain "valid_until" (the venue reads it as the expiry suffix)`, {
      remediation: "Pass a different --agent-name; set the expiry with --expires-in",
    });
  }
  // Docs (for-developers/api/exchange-endpoint, approveAgent → agentName): "A custom expiration can
  // be set by appending `valid_until {timestamp}` after the name. The expiration can be at most
  // 180 days in the future". The timestamp is sent in milliseconds, the unit of every other HL API
  // timestamp (nonce; extraAgents `validUntil`). Without the suffix the venue applies its own
  // expiry and the stored expiresAt would not be the venue's.
  const validityMs = expiresAt.getTime() - Date.now();
  if (!(validityMs > 0) || validityMs > HL_AGENT_MAX_VALIDITY_MS) {
    throw new PerpError("INVALID_PARAMS", `Hyperliquid agent expiry ${expiresAtIso} must be in the future and at most 180 days away (venue limit)`, {
      exchange: "hyperliquid",
      remediation: "Pass --expires-in 180d or less (e.g. --expires-in 90d)",
    });
  }
  const wireAgentName = `${agentName} valid_until ${expiresAt.getTime()}`;

  const { ethers } = await import("ethers");

  // Step 1: Resolve master signer
  const masterSigner = OwsEvmSigner.create(masterName, passphrase);
  const userEvmAddress = masterSigner.getAddress() as `0x${string}`;

  // Step 2: Generate agent OWS wallet
  const ows = loadOws();
  const agentWalletName = agentWalletNameFor("hl", masterName, network);
  // HL agent wallet created with empty passphrase. This is intentional:
  // (1) Tier 1 hot-path must be prompt-free (P1 from agent_first_design.md).
  // (2) OWS provides at-rest encryption regardless of per-wallet passphrase.
  // (3) Agent blast-radius is limited (perp-only, no withdraw, no master ops).
  // At runtime, src/index.ts opens this wallet with "" matching the create-time empty.
  assertAgentWalletNameFree("hyperliquid", agentWalletName, network);
  const agentWallet = ows.createWallet(agentWalletName, "");
  const agentEvmAccount = agentWallet.accounts.find(
    (a: { chainId: string }) => a.chainId.startsWith("eip155:"),
  );
  if (!agentEvmAccount) {
    throw new PerpError("INVALID_PARAMS", `Agent wallet "${agentWalletName}" has no EVM account`, {
      remediation: "Check OWS vault configuration",
    });
  }
  const agentEvmAddress = agentEvmAccount.address as `0x${string}`;

  // Step 3: Build nonce (monotonic ms)
  const now = Date.now();
  const nonce = now;

  const action: Record<string, unknown> = {
    type: "approveAgent",
    hyperliquidChain,
    signatureChainId: signatureChainIdHex,
    agentAddress: agentEvmAddress,
    agentName: wireAgentName,
    nonce,
  };

  // Step 4: Master signs EIP-712 (user-signed domain)
  const message = {
    hyperliquidChain,
    agentAddress: agentEvmAddress,
    agentName: wireAgentName,
    nonce,
  };

  let sigRaw: string;
  try {
    sigRaw = await masterSigner.signTypedData(
      hlUserSignedDomain(network),
      HL_APPROVE_AGENT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      message,
    );
  } catch (e) {
    // Nothing was sent: the fresh agent wallet is an orphan — remove it so a retry
    // (e.g. after a wrong passphrase) does not hit "wallet name already exists".
    tryDeleteOrphanWallet(ows, agentWalletName);
    throw e;
  }

  const parsed = ethers.Signature.from(sigRaw);
  const signature = { r: parsed.r, s: parsed.s, v: parsed.v };

  // Step 5: POST /exchange
  const payload = { action, nonce, signature, vaultAddress: null };

  const agentRes = await fetch(hlExchangeUrl(network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await agentRes.text();
  let resp: Record<string, unknown>;
  try {
    resp = JSON.parse(text);
  } catch {
    // Pre-venue parse failure — Hyperliquid did NOT register the agent.
    // Roll back the orphan local OWS wallet so retry doesn't collide with
    // "wallet name already exists". Errors during cleanup must NOT mask the
    // original network/parse error (SSOT Rule #2).
    const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
    throw new PerpError("EXCHANGE_ERROR", `HL exchange API parse error (${agentRes.status}): ${text.slice(0, 200)}`, {
      remediation: buildPreVenueRemediation({
        cleanupOk, dex: "hyperliquid", network, masterName, agentAddress: agentEvmAddress,
        hint: "Check Hyperliquid API status",
      }),
    });
  }
  // Same acceptance rule as revokeHlAgent: only HTTP 2xx + status "ok" is a registered agent.
  // Anything else but an explicit "err" is an UNKNOWN outcome: the agent may or may not be
  // authorized, so the local agent wallet is kept (deleting it could orphan a live key).
  if (!agentRes.ok || (resp?.status !== "ok" && resp?.status !== "err")) {
    throw new PerpError("APPROVE_PARTIAL", `HL approveAgent outcome unknown (HTTP ${agentRes.status}): ${text.slice(0, 200)}`, {
      exchange: "hyperliquid",
      remediation: `Check the Hyperliquid UI (More → API) for agent ${agentEvmAddress}. If it is listed, re-run approve with --rotate; if not, delete the local OWS wallet "${agentWalletName}" and retry.`,
    });
  }
  if (resp?.status === "err") {
    // Pre-venue rejection — Hyperliquid did NOT register the agent. Roll
    // back the orphan local OWS wallet so retry can proceed cleanly.
    const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
    throw new PerpError("APPROVE_PARTIAL", `HL approveAgent failed: ${typeof resp.response === "string" ? resp.response : JSON.stringify(resp)}`, {
      remediation: buildPreVenueRemediation({
        cleanupOk, dex: "hyperliquid", network, masterName, agentAddress: agentEvmAddress,
      }),
    });
  }

  // Step 6: Persist
  setAgent("hyperliquid", {
    agentName,
    agentWalletName,
    agentEvmAddress,
    userEvmAddress,
    masterWalletName: masterName,
    owsApiKeyId: "",        // HL has no OWS API key model
    owsPolicyId: "",        // HL has no OWS Policy model
    expiresAt: expiresAtIso,
    approvedAt: nowIso,
    permissions: { canPerpTrade: canPerp, canSpotTrade: canSpot, canWithdraw },
    asterApprovalNonce: String(nonce),  // reused field: stores HL nonce for diagnostics
    status: "active",
    network,
  });

  return { agentAddress: agentEvmAddress, agentName, expiresAt: expiresAtIso, userEvmAddress };
}

/**
 * Post a HL revoke action for the given agent.
 * Uses approveAgent with agentAddress set to the zero address under the
 * agent's own name — HL keys agent slots by name (the unnamed slot is "").
 *
 * Rule #2: the venue must confirm with `{status:"ok"}`. Any other answer
 * (HTTP error, `{status:"err"}`, unparseable body) throws APPROVE_FAILED —
 * the agent key may still be authorized, so the caller must not forget it.
 */
/** Hyperliquid's answer to a zero-address approveAgent for a named agent it no longer holds (pruned / expired). */
const HL_AGENT_ALREADY_GONE = "Extra agent does not exist.";

async function revokeHlAgent(masterSigner: OwsEvmSigner, network: Network, agentName: string, agentAddress: string): Promise<void> {
  const { ethers } = await import("ethers");
  const { hyperliquidChain, signatureChainIdHex } = HL_USER_SIGNED[network];

  const nonce = Date.now();

  // Zero-address revoke: approveAgent with empty agentAddress (validUntil:0 convention)
  const revokeAddress = "0x0000000000000000000000000000000000000000" as const;
  const action: Record<string, unknown> = {
    type: "approveAgent",
    hyperliquidChain,
    signatureChainId: signatureChainIdHex,
    agentAddress: revokeAddress,
    agentName,
    nonce,
  };

  const message = {
    hyperliquidChain,
    agentAddress: revokeAddress,
    agentName,
    nonce,
  };

  const sigRaw = await masterSigner.signTypedData(
    hlUserSignedDomain(network),
    HL_APPROVE_AGENT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    message,
  );

  const parsed = ethers.Signature.from(sigRaw);
  const signature = { r: parsed.r, s: parsed.s, v: parsed.v };

  const payload = { action, nonce, signature, vaultAddress: null };
  const res = await fetch(hlExchangeUrl(network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const remediation = `The agent key may still be authorized to trade. Retry, or remove the API wallet in the Hyperliquid UI (More → API). Agent: ${agentAddress} ("${agentName}")`;
  if (!res.ok) {
    throw new PerpError("APPROVE_FAILED", `Hyperliquid revoke failed (${res.status}): ${text.slice(0, 200)}`, {
      exchange: "hyperliquid",
      remediation,
    });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new PerpError("APPROVE_FAILED", `Hyperliquid revoke returned an unreadable response (${res.status}): ${text.slice(0, 200)}`, {
      exchange: "hyperliquid",
      remediation,
    });
  }
  const status = body !== null && typeof body === "object" ? (body as { status?: unknown }).status : null;
  // The venue no longer knows this agent — nothing is left to revoke. HL docs (for-developers/api/
  // nonces-and-api-wallets, "API wallet pruning"): "API wallets and their associated nonce state may
  // be pruned in the following cases: 1. The wallet is deregistered. … 2. The wallet expires.
  // 3. The account that registered the agent no longer has funds." Only this exact venue answer
  // (live mainnet 2026-10-05, on an expired agent) counts as "already gone".
  if (status === "err" && (body as { response?: unknown }).response === HL_AGENT_ALREADY_GONE) return;
  if (status !== "ok") {
    throw new PerpError("APPROVE_FAILED", `Hyperliquid revoke rejected: ${text.slice(0, 200)}`, {
      exchange: "hyperliquid",
      remediation,
    });
  }
}

// ── HL userSetAbstraction (account-mode write) helper ────────────────────────

/** EIP-712 types for HyperliquidTransaction:UserSetAbstraction */
const HL_USER_SET_ABSTRACTION_TYPES = {
  "HyperliquidTransaction:UserSetAbstraction": [
    { name: "hyperliquidChain", type: "string" },
    { name: "user", type: "address" },
    { name: "abstraction", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** Public abstraction modes (CLI surface) → HL on-wire string. */
const HL_ABSTRACTION_TO_WIRE = {
  unified: "unifiedAccount",
  standard: "disabled",
  portfolio: "portfolioMargin",
} as const;

export type HlAbstractionMode = keyof typeof HL_ABSTRACTION_TO_WIRE;

interface HlSetAbstractionFlowOpts {
  masterName: string;
  passphrase: string;
  mode: HlAbstractionMode;
  isTestnet: boolean;
}

interface HlSetAbstractionFlowResult {
  mode: HlAbstractionMode;
  abstraction: string;
  hyperliquidChain: "Mainnet" | "Testnet";
  nonce: number;
  userEvmAddress: `0x${string}`;
  response: Record<string, unknown>;
}

/**
 * Send a Hyperliquid `userSetAbstraction` action.
 *
 * Reuses the same EIP-712 user-signed domain (`HyperliquidSignTransaction`,
 * per-network signatureChainId) and `OwsEvmSigner.signTypedData` plumbing as
 * `runHlApproveFlow`; the only differences are the type struct
 * (`UserSetAbstraction` vs `ApproveAgent`) and the action payload.
 *
 * Throws `PerpError` with structured remediation on signature/network/venue
 * failure (Rule #2: no fallback, no silent retry).
 */
export async function runHlSetAbstractionFlow(
  opts: HlSetAbstractionFlowOpts,
): Promise<HlSetAbstractionFlowResult> {
  const { masterName, passphrase, mode, isTestnet } = opts;
  const { ethers } = await import("ethers");

  const masterSigner = OwsEvmSigner.create(masterName, passphrase);
  const userEvmAddress = masterSigner.getAddress() as `0x${string}`;

  const network: Network = isTestnet ? "testnet" : "mainnet";
  const { hyperliquidChain, signatureChainIdHex } = HL_USER_SIGNED[network];
  const abstraction = HL_ABSTRACTION_TO_WIRE[mode];
  const nonce = Date.now();

  // Field set and order per hyperliquid-python-sdk USER_SET_ABSTRACTION_SIGN_TYPES
  // (hyperliquidChain, user, abstraction, nonce); `user` is the lower-cased master address.
  // Without `user` in the signed struct HL recovers a different signer (live testnet 2026-10-05:
  // "Must deposit before performing actions. User: 0x5e33…").
  const user = userEvmAddress.toLowerCase() as `0x${string}`;
  const action = {
    type: "userSetAbstraction",
    hyperliquidChain,
    signatureChainId: signatureChainIdHex,
    user,
    abstraction,
    nonce,
  } as Record<string, unknown>;

  const message = {
    hyperliquidChain,
    user,
    abstraction,
    nonce,
  };

  let sigRaw: string;
  try {
    sigRaw = await masterSigner.signTypedData(
      hlUserSignedDomain(network),
      HL_USER_SET_ABSTRACTION_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      message,
    );
  } catch (sigErr) {
    throw new PerpError("SIGNATURE_FAILED", `HL userSetAbstraction signing failed: ${sigErr instanceof Error ? sigErr.message : String(sigErr)}`, {
      remediation: "Confirm OWS master is unlocked and passphrase is correct.",
    });
  }
  const parsed = ethers.Signature.from(sigRaw);
  const signature = { r: parsed.r, s: parsed.s, v: parsed.v };

  const payload = { action, nonce, signature, vaultAddress: null };

  const res = await fetch(hlExchangeUrl(network), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let resp: Record<string, unknown>;
  try {
    resp = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new PerpError("EXCHANGE_ERROR", `HL exchange API parse error (${res.status}): ${text.slice(0, 200)}`, {
      remediation: "Check Hyperliquid API status. Retry: perp wallet manage account-mode <mode>",
    });
  }
  if (resp?.status === "err") {
    throw new PerpError("EXCHANGE_ERROR", `HL userSetAbstraction failed: ${typeof resp.response === "string" ? resp.response : JSON.stringify(resp)}`, {
      remediation: "Verify master EVM wallet is the account owner. Retry: perp wallet manage account-mode <mode>",
    });
  }

  return {
    mode,
    abstraction,
    hyperliquidChain,
    nonce,
    userEvmAddress,
    response: resp,
  };
}

// ── Pacifica agent approve/revoke helpers (Phase 2c) ─────────────────────────

interface PacApproveFlowOpts {
  network: Network;
  masterName: string;
  passphrase: string;
  agentName: string;
  expiresAt: Date;
  expiresAtIso: string;
  nowIso: string;
  canPerp: boolean;
  canSpot: boolean;
  canWithdraw: boolean;
}

export interface PacApproveFlowResult {
  agentSolanaAddress: string;
  userSolanaAddress: string;
  agentName: string;
  expiresAt: string;
}

/**
 * Core Pacifica approve flow.
 * Caller MUST hold the "pacifica" lock before calling this function.
 *
 * Steps:
 *  1. Resolve master via OwsSolanaSigner.create
 *  2. Generate agent OWS wallet (`agent-pac-<masterName>`) with empty passphrase
 *  3. Build canonical bind_agent_wallet message + master Ed25519 signature
 *  4. POST <network restUrl>/agent/bind (api.pacifica.fi / test-api.pacifica.fi)
 *  5. On success: persist AgentMeta to settings.agents.pacifica[name]
 *  6. On failure: rollback agent OWS wallet + emit APPROVE_PARTIAL/APPROVE_FAILED
 *
 * Off-chain auth — no on-chain transaction, no gas required.
 */
async function runPacApproveFlow(opts: PacApproveFlowOpts): Promise<PacApproveFlowResult> {
  const {
    network, masterName, passphrase, agentName, expiresAtIso, nowIso,
    canPerp, canSpot, canWithdraw,
  } = opts;

  const { buildBindAgentMessage } = await import("../exchanges/pacifica-typed-data.js");

  // Step 1: Resolve master Solana signer
  const masterSigner = OwsSolanaSigner.create(masterName, passphrase);
  const userSolanaAddress = masterSigner.getPublicKeyBase58();

  // Step 2: Generate agent OWS wallet (empty passphrase mirrors HL pattern;
  // the runtime opens with "" so the hot-path is prompt-free).
  const ows = loadOws();
  const agentWalletName = agentWalletNameFor("pac", masterName, network);
  assertAgentWalletNameFree("pacifica", agentWalletName, network);
  const agentWallet = ows.createWallet(agentWalletName, "");
  const agentSolAccount = agentWallet.accounts.find(
    (a: { chainId: string }) => a.chainId.startsWith("solana:"),
  );
  if (!agentSolAccount) {
    throw new PerpError("INVALID_PARAMS", `Agent wallet "${agentWalletName}" has no Solana account`, {
      remediation: "Check OWS vault configuration",
    });
  }
  const agentSolanaAddress: string = agentSolAccount.address;

  // Step 3: Build canonical bind_agent_wallet payload + Ed25519 signature
  const bind = buildBindAgentMessage({
    account: userSolanaAddress,
    agentWallet: agentSolanaAddress,
  });
  const msgBytes = new TextEncoder().encode(bind.canonicalJson);
  const sigBytes = await masterSigner.signMessage(msgBytes);
  const signature = bs58.encode(sigBytes);

  // Step 4: POST /api/v1/agent/bind
  // FIXME(2c-spike): unverified — confirm against live mainnet. Pacifica's
  // public API documentation does not enumerate `agent/bind` explicitly; the
  // shape below mirrors `buildSignedRequest()` (account+signature+timestamp+
  // expiry_window+payload-flattened) which IS the documented Pacifica REST
  // signing pattern. See HypurrQuant_FE PacificaPerpAdapter.ts for the
  // production reference once available.
  const requestBody: Record<string, unknown> = {
    account: userSolanaAddress,
    signature,
    timestamp: bind.header.timestamp,
    expiry_window: bind.header.expiry_window,
    type: bind.header.type,
    ...bind.payload, // adds agent_wallet
  };

  let pacPostSucceeded = false;
  let resp: Record<string, unknown> | undefined;
  try {
    const httpRes = await fetch(`${networkConfig(getVenue("pacifica"), network).restUrl}/agent/bind`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    if (httpRes.ok) {
      resp = await httpRes.json() as Record<string, unknown>;
      // Pacifica REST envelope: success === true OR explicit data field
      if (resp.success === false || resp.error) {
        const errMsg = typeof resp.error === "string" ? resp.error : JSON.stringify(resp);
        // Pre-venue rejection — Pacifica did NOT register the agent.
        const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
        throw new PerpError("APPROVE_PARTIAL", `Pacifica bind_agent_wallet failed: ${errMsg}`, {
          remediation: buildPreVenueRemediation({
            cleanupOk, dex: "pacifica", network, masterName, agentAddress: agentSolanaAddress,
          }),
        });
      }
      pacPostSucceeded = true;
    } else {
      const errText = await httpRes.text().catch(() => "");
      // Pre-venue rejection — Pacifica did NOT register the agent.
      const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
      throw new PerpError("APPROVE_PARTIAL", `Pacifica bind_agent_wallet failed (${httpRes.status}): ${errText.slice(0, 200)}`, {
        remediation: buildPreVenueRemediation({
          cleanupOk, dex: "pacifica", network, masterName, agentAddress: agentSolanaAddress,
        }),
      });
    }
  } catch (httpErr) {
    if (httpErr instanceof PerpError) throw httpErr;
    // Network-level failure — Pacifica did NOT register the agent.
    const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
    throw new PerpError("APPROVE_PARTIAL", `Pacifica bind_agent_wallet network error: ${httpErr instanceof Error ? httpErr.message : String(httpErr)}`, {
      remediation: buildPreVenueRemediation({
        cleanupOk, dex: "pacifica", network, masterName, agentAddress: agentSolanaAddress,
      }),
    });
  }

  // Step 5: Persist
  // PAC has no OWS API key/Policy model — leave those as empty strings.
  // agentEvmAddress is set to the zero address; the canonical address lives
  // in agentSolanaAddress.
  try {
    setAgent("pacifica", {
      agentName,
      agentWalletName,
      agentEvmAddress: "0x0000000000000000000000000000000000000000",
      userEvmAddress: "0x0000000000000000000000000000000000000000",
      agentSolanaAddress,
      userSolanaAddress,
      masterWalletName: masterName,
      owsApiKeyId: "",
      owsPolicyId: "",
      expiresAt: expiresAtIso,
      approvedAt: nowIso,
      permissions: { canPerpTrade: canPerp, canSpotTrade: canSpot, canWithdraw },
      asterApprovalNonce: String(bind.header.timestamp),
      status: "active",
      network,
    });
  } catch (persistErr) {
    // Settings persist failed AFTER Pacifica registration succeeded.
    // Best-effort revoke + APPROVE_PARTIAL.
    if (pacPostSucceeded) {
      try {
        await revokePacAgent(masterSigner, agentSolanaAddress, network);
      } catch { /* best effort */ }
    }
    throw new PerpError("APPROVE_PARTIAL", `Pacifica agent registered but persist failed: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`, {
      remediation: `Pacifica agent address: ${agentSolanaAddress}. Run: perp wallet agent approve pacifica --rotate to re-register.`,
    });
  }

  return {
    agentSolanaAddress,
    userSolanaAddress,
    agentName,
    expiresAt: expiresAtIso,
  };
}

/**
 * Revoke a Pacifica agent wallet.
 *
 * Endpoint + operation type follow the official Pacifica SDK
 * (`rest/api_agent_keys_detailed.py`): `revoke_agent_wallet` → POST
 * /agent/revoke. A missing agent address is refused (it must never widen into
 * `revoke_all_agent_wallets`, which would also kill agents this CLI does not own).
 *
 * Rule #2: this THROWS on a rejected revoke. It previously POSTed an
 * `unbind_agent_wallet` type to /agent/bind — neither of which Pacifica
 * exposes — and discarded the response entirely, so a refused revoke was
 * reported to the user as success while the agent key stayed authorized to
 * trade. Callers that genuinely want best-effort must catch explicitly.
 */
export async function revokePacAgent(masterSigner: OwsSolanaSigner, agentSolanaAddress: string | null, network: Network): Promise<void> {
  if (agentSolanaAddress === null || agentSolanaAddress.length === 0) {
    throw new PerpError("AGENT_NOT_REGISTERED", "Pacifica agent record has no agent address — refusing to send a revoke (it would revoke ALL agents)", {
      exchange: "pacifica",
      remediation: "Revoke the agent in the Pacifica UI, then clear the local record: perp wallet agent revoke pacifica <name> --force",
    });
  }
  const { buildRevokeAgentMessage } = await import("../exchanges/pacifica-typed-data.js");
  const userSolanaAddress = masterSigner.getPublicKeyBase58();

  const built = buildRevokeAgentMessage({ account: userSolanaAddress, agentWallet: agentSolanaAddress });
  const path = "/agent/revoke";

  const msgBytes = new TextEncoder().encode(built.canonicalJson);
  const sigBytes = await masterSigner.signMessage(msgBytes);
  const signature = bs58.encode(sigBytes);

  const requestBody: Record<string, unknown> = {
    account: userSolanaAddress,
    signature,
    timestamp: built.header.timestamp,
    expiry_window: built.header.expiry_window,
    type: built.header.type,
    ...built.payload,
  };

  const res = await fetch(`${networkConfig(getVenue("pacifica"), network).restUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new PerpError("APPROVE_FAILED", `Pacifica revoke failed (${res.status}): ${text.slice(0, 200)}`, {
      exchange: "pacifica",
      remediation: `The agent key may still be authorized to trade. Retry, or revoke it from the Pacifica UI. Agent: ${agentSolanaAddress}`,
    });
  }
  // Pacifica wraps REST results in `{ success, error, data }` — a 200 with
  // success:false is still a refusal, so check the envelope, not just the code.
  try {
    const parsed = JSON.parse(text) as { success?: boolean; error?: unknown };
    if (parsed && parsed.success === false) {
      throw new PerpError("APPROVE_FAILED", `Pacifica revoke rejected: ${JSON.stringify(parsed.error ?? parsed)}`, {
        exchange: "pacifica",
        remediation: `The agent key may still be authorized to trade. Retry, or revoke it from the Pacifica UI. Agent: ${agentSolanaAddress}`,
      });
    }
  } catch (e) {
    if (e instanceof PerpError) throw e;
    // Non-JSON 2xx body: the venue accepted it. Nothing to assert.
  }
}

// ── Lighter agent approve/revoke helpers (Phase 2d) ──────────────────────────

interface LtApproveFlowOpts {
  venue: LighterVenueId;
  network: Network;
  masterName: string;
  passphrase: string;
  agentName: string;
  expiresAt: Date;
  expiresAtIso: string;
  nowIso: string;
  canPerp: boolean;
  canSpot: boolean;
  canWithdraw: boolean;
  /** Optional explicit slot (4-254). When omitted, picks the first slot free locally AND on-chain. */
  apiKeyIndex?: number;
  /** Allow an explicit slot that already holds an on-chain key no local agent tracks (`--force`). */
  forceSlot: boolean;
}

export interface LtApproveFlowResult {
  apiKeyIndex: number;
  publicKey: string;
  accountIndex: number;
  agentName: string;
  expiresAt: string;
  userEvmAddress: `0x${string}`;
}

/** A slot is occupied on-chain when /apikeys lists a non-empty, non-zero public key for it. */
function isLtSlotKeyOccupied(publicKey: string): boolean {
  return !/^(0x)?0*$/.test(publicKey.trim());
}

/**
 * Pick the first free Lighter slot in [5, 254].
 *
 * A slot is used when any local agent record (any network — conservative) holds it,
 * when the venue reserves it, or when the account's on-chain key list shows a key on
 * it (`onChainOccupied`) — an auto pick must never overwrite a key some other client
 * (web app, another machine) is using.
 */
export function pickNextFreeLtSlot(settings: ReturnType<typeof loadSettings>, venue: LighterVenueId, onChainOccupied: ReadonlySet<number>): number {
  const ltMap = settings.agents?.[venue] ?? {};
  const used = new Set<number>(venue === "lighter-rh" ? LIGHTER_RH_RESERVED_KEY_INDEXES : []);
  for (const meta of Object.values(ltMap)) {
    if (typeof meta.apiKeyIndex === "number") used.add(meta.apiKeyIndex);
  }
  for (const slot of onChainOccupied) used.add(slot);
  // Slot 4 is the default Lighter env-key auto-setup index — treat as used so
  // agent-managed slots don't collide with the env-driven legacy path.
  used.add(4);
  for (let i = 5; i <= 254; i++) {
    if (!used.has(i)) return i;
  }
  throw new PerpError("INVALID_PARAMS", "All Lighter slots [4, 254] are in use (locally or on-chain)", {
    remediation: `Revoke an existing agent: perp wallet agent revoke ${venue} <name>`,
  });
}

/**
 * Core Lighter approve flow.
 * Caller MUST hold the "lighter" lock before calling this function.
 *
 * Steps:
 *  1. Resolve master via OwsEvmSigner.create
 *  2. Pick free slot in [4, 254] (or use explicit apiKeyIndex when supplied)
 *  3. Spin up a temporary LighterAdapter bound to the master signer; init() to
 *     resolve accountIndex from L1 EVM address
 *  4. Call LighterAdapter.setupApiKey(slot) — generates secp256k1 keypair via
 *     WASM generateAPIKey, signs L1 EIP-712 + L2 ChangePubKey, POSTs sendTx
 *  5. On success: create agent OWS wallet (empty passphrase) to securely store
 *     the agent secp256k1 private key for hot-path reload at trade time
 *  6. Persist AgentMeta with apiKeyIndex/publicKey/accountIndex to settings
 *  7. On failure: emit APPROVE_PARTIAL/APPROVE_FAILED. Lighter has no on-chain
 *     rollback — the slot stays orphaned on the L2 server until overwritten.
 *
 * Off-chain auth — no on-chain BNB/ETH gas required.
 */
async function runLtApproveFlow(opts: LtApproveFlowOpts): Promise<LtApproveFlowResult> {
  const {
    venue, network, masterName, passphrase, agentName, expiresAtIso, nowIso,
    canPerp, canSpot, canWithdraw, apiKeyIndex: explicitSlot, forceSlot,
  } = opts;
  const venueName = getVenue(venue).displayName;

  const { LighterAdapter } = await import("../exchanges/lighter.js");

  // Step 1: Resolve master EVM signer (Lighter L1 ChangePubKey is EVM EIP-712 + EIP-191).
  const masterSigner = OwsEvmSigner.create(masterName, passphrase);
  const userEvmAddress = masterSigner.getAddress() as `0x${string}`;

  if (explicitSlot !== undefined) {
    // Validate range (defensive — caller should have already checked, but the
    // helper is also used from rotate where no validation runs upstream).
    assertLighterSlot(venue, explicitSlot);
  }

  // Step 2: Spin up a LighterAdapter bound to the master EVM signer.
  // Constructor takes evmKey (empty since we'll inject signer); init() resolves
  // accountIndex from the L1 EVM address via REST.
  const adapter = LighterAdapter.forVenue(venue, "", network === "testnet");
  adapter.setSigner(masterSigner);
  await adapter.init();

  if (adapter.accountIndex < 0) {
    throw new PerpError("INVALID_PARAMS", `No ${venueName} account found for master EVM address ${userEvmAddress}`, {
      remediation: `Deposit ${adapter.collateralSymbol} to the master address on ${venueName} to create an account, then retry.`,
    });
  }

  // Step 3: Pick the slot against the account's LIVE key list. Overwriting an occupied slot
  // silently kills whatever client (web app, another machine, another agent) signs with it.
  const onChain = await adapter.listApiKeys();
  const onChainOccupied = new Set(onChain.filter((k) => isLtSlotKeyOccupied(k.publicKey)).map((k) => k.apiKeyIndex));
  let chosenSlot: number;
  if (explicitSlot !== undefined) {
    chosenSlot = explicitSlot;
    const localHolder = listAgents(venue).find(({ meta }) =>
      meta.accountIndex === adapter.accountIndex && meta.apiKeyIndex === chosenSlot && agentNetworkOf(venue, meta) === network);
    if (localHolder) {
      throw new PerpError("INVALID_PARAMS", `${venueName} slot ${chosenSlot} on account ${adapter.accountIndex} is held by local ${network} agent "${localHolder.meta.agentName}"`, {
        remediation: `Rotate it (perp${network === "testnet" ? " -n testnet" : ""} wallet agent rotate ${venue} ${localHolder.meta.agentName}), or pick another --api-key-index`,
      });
    }
    if (onChainOccupied.has(chosenSlot) && !forceSlot) {
      throw new PerpError("INVALID_PARAMS", `${venueName} slot ${chosenSlot} on account ${adapter.accountIndex} already holds an on-chain API key — approving would overwrite it and break whatever signs with it`, {
        remediation: `Omit --api-key-index to auto-pick a free slot, or pass --force to deliberately overwrite slot ${chosenSlot}`,
      });
    }
  } else {
    chosenSlot = pickNextFreeLtSlot(loadSettings(), venue, onChainOccupied);
  }

  // Before any venue write: account indexes are per-network and pre-tagging keystore files are keyed
  // by accountIndex + slot only (migrated to the network-tagged path on first load), so refuse to
  // reuse another network's account+slot.
  for (const { meta } of listAgents(venue)) {
    if (meta.accountIndex === adapter.accountIndex && meta.apiKeyIndex === chosenSlot && agentNetworkOf(venue, meta) !== network) {
      throw new PerpError("INVALID_PARAMS", `${venueName} keystore slot ${adapter.accountIndex}-${chosenSlot} already holds ${agentNetworkOf(venue, meta)} agent "${meta.agentName}"`, {
        remediation: `Pick another slot: perp${network === "testnet" ? " -n testnet" : ""} wallet agent approve ${venue} --api-key-index <4-254>`,
      });
    }
  }

  // Step 4: Generate keypair + ChangePubKey via existing production infra.
  // setupApiKey already does:
  //   - generateAPIKey() (WASM)
  //   - createClient with new key
  //   - signChangePubKey
  //   - signMessage(messageToSign) via EVM signer (EIP-191)
  //   - append L1Sig to txInfo
  //   - POST /api/v1/sendTx with retry on invalid-nonce
  let registered: { privateKey: string; publicKey: string };
  try {
    registered = await adapter.setupApiKey(chosenSlot);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PerpError("APPROVE_PARTIAL", `${venueName} ChangePubKey failed: ${msg}`, {
      remediation: `Slot ${chosenSlot} for cleanup: this slot may be partially registered on the L2 server. Retry with a different --api-key-index, or rotate.`,
    });
  }

  // Step 5: Persist the agent's 40-byte L2 private key (SSOT Rule #3 —
  // encrypted at-rest in `~/.perp/lighter-agents/<accountIndex>-<slot>.json`).
  //
  // Lighter's L2 secp256k1 key is a non-OWS-native curve, so it cannot live in
  // `~/.ows/wallets/`. The keystore module mirrors OWS's AES-256-GCM + scrypt
  // scheme and uses an empty passphrase — same threat model as HL/PAC agents
  // (file mode 0600 + obfuscation, NOT cryptographic strength against a local
  // attacker). `accountIndex` and `apiKeyIndex` already live in
  // settings.agents.lighter[name], so they don't need to be duplicated in env.
  const agentWalletName = venue === "lighter" ? `agent-lt-${masterName}` : `agent-${venue}-${masterName}`;
  void agentWalletName; // wallet bookkeeping only — not used to derive the L2 key
  const { saveLighterFamilyKey } = await import("../agent-wallet/lighter-keystore.js");
  try {
    saveLighterFamilyKey(venue, network, adapter.accountIndex, chosenSlot, registered.privateKey, "");
  } catch (saveErr) {
    // The slot already holds the new key on-chain, but its private half could not be stored —
    // the slot is unusable from this machine until it is re-registered.
    throw new PerpError("APPROVE_PARTIAL", `${venueName} ChangePubKey succeeded on slot ${chosenSlot} (account ${adapter.accountIndex}) but saving its key to the keystore failed: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`, {
      exchange: venue,
      remediation: `Slot ${chosenSlot} now holds a key whose private half was not saved. Fix the keystore directory (permissions / disk space under ~/.perp), then re-register the slot: perp${network === "testnet" ? " -n testnet" : ""} wallet agent approve ${venue} --api-key-index ${chosenSlot} --force`,
    });
  }

  // Step 6: Persist
  try {
    setAgent(venue, {
      agentName,
      agentWalletName,
      // Lighter agent's identity on the L2 is publicKey + apiKeyIndex.
      // We store the master EVM address as agentEvmAddress for diagnostic
      // continuity (Aster/HL strict typing); the agent's real identity is
      // captured in the new optional fields.
      agentEvmAddress: userEvmAddress,
      userEvmAddress,
      apiKeyIndex: chosenSlot,
      publicKey: registered.publicKey.replace(/^0x/, ""),
      accountIndex: adapter.accountIndex,
      masterWalletName: masterName,
      owsApiKeyId: "",        // Lighter has no OWS API key model
      owsPolicyId: "",        // Lighter has no OWS Policy model
      expiresAt: expiresAtIso,
      approvedAt: nowIso,
      permissions: { canPerpTrade: canPerp, canSpotTrade: canSpot, canWithdraw },
      asterApprovalNonce: String(Date.now()),  // reused field: not used by LT
      status: "active",
      network,
    });
  } catch (persistErr) {
    throw new PerpError("APPROVE_PARTIAL", `${venueName} ChangePubKey succeeded but persist failed: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`, {
      remediation: `${venueName} slot ${chosenSlot} is registered on the L2 server. Manually update settings.agents.${venue} or re-run: perp wallet agent approve ${venue} --api-key-index <other slot>.`,
    });
  }

  return {
    apiKeyIndex: chosenSlot,
    publicKey: registered.publicKey.replace(/^0x/, ""),
    accountIndex: adapter.accountIndex,
    agentName,
    expiresAt: expiresAtIso,
    userEvmAddress,
  };
}

/**
 * Revoke a Lighter-family agent: Lighter has no "remove key" tx, so the slot's public key
 * is replaced (master-signed ChangePubKey) by a freshly generated throwaway key whose private
 * half is discarded — the old agent key can no longer sign. Then the slot keystore file is
 * deleted. Throws APPROVE_FAILED (nothing deleted locally) when the ChangePubKey is not accepted.
 */
async function revokeLtAgent(venue: LighterVenueId, network: Network, meta: AgentMeta, passphrase: string): Promise<void> {
  const venueName = getVenue(venue).displayName;
  if (typeof meta.accountIndex !== "number" || typeof meta.apiKeyIndex !== "number") {
    throw new PerpError("AGENT_NOT_REGISTERED", `${venueName} agent "${meta.agentName}" has no accountIndex/apiKeyIndex — cannot locate its slot`, {
      remediation: `Revoke the key in the ${venueName} web app (API keys), then: perp wallet agent revoke ${venue} ${meta.agentName} --force`,
    });
  }
  const { LighterAdapter } = await import("../exchanges/lighter.js");
  const adapter = LighterAdapter.forVenue(venue, "", network === "testnet");
  adapter.setSigner(OwsEvmSigner.create(meta.masterWalletName, passphrase));
  await adapter.init();
  if (adapter.accountIndex !== meta.accountIndex) {
    throw new PerpError("APPROVE_FAILED", `${venueName} master account ${adapter.accountIndex} does not own agent "${meta.agentName}" (account ${meta.accountIndex})`, {
      remediation: `Run with the master wallet that registered it (--master / settings.owsActiveWallet), or revoke it in the ${venueName} web app`,
    });
  }
  let throwawayPublicKey: string;
  try {
    // Throwaway key: the returned private key is intentionally dropped (never persisted or logged).
    throwawayPublicKey = (await adapter.setupApiKey(meta.apiKeyIndex)).publicKey;
  } catch (e) {
    throw new PerpError("APPROVE_FAILED", `${venueName} revoke failed: ChangePubKey on slot ${meta.apiKeyIndex} was not accepted — ${e instanceof Error ? e.message : String(e)}`, {
      exchange: venue,
      remediation: `The agent key may still be authorized. Retry, or revoke it in the ${venueName} web app. Slot: ${meta.apiKeyIndex}`,
    });
  }
  // sendTx acceptance is not settlement: re-read the slot and require its public key to be the
  // throwaway one before deleting the local key (otherwise the old key may still be live and the
  // user would lose the only local copy of a still-authorized key's record).
  const norm = (k: string): string => k.trim().replace(/^0x/i, "").toLowerCase();
  // Docs (apidocs.lighter.xyz "Create accounts programmatically"): "`code: 200` only means the API
  // accepted the transaction. It still has to execute before the key can sign orders, so poll
  // apikeys until it returns your public key" — their example polls every 1 s for 30 s. Live
  // (lighter-rh mainnet 2026-10-05) the slot showed the new key a few seconds after the send.
  let slotKey: string | null;
  try {
    const deadline = Date.now() + LIGHTER_SLOT_CONFIRM_TIMEOUT_MS;
    for (;;) {
      const keys = await adapter.listApiKeys();
      const entry = keys.find((k) => k.apiKeyIndex === meta.apiKeyIndex);
      slotKey = entry ? entry.publicKey : null;
      if ((slotKey !== null && norm(slotKey) === norm(throwawayPublicKey)) || Date.now() + LIGHTER_SLOT_CONFIRM_POLL_MS > deadline) break;
      await new Promise((r) => setTimeout(r, LIGHTER_SLOT_CONFIRM_POLL_MS));
    }
  } catch (e) {
    throw new PerpError("APPROVE_PARTIAL", `${venueName} revoke sent ChangePubKey for slot ${meta.apiKeyIndex}, but re-reading the slot failed: ${e instanceof Error ? e.message : String(e)}`, {
      exchange: venue,
      remediation: `Local key kept. Check the slot: perp${network === "testnet" ? " -n testnet" : ""} wallet agent verify ${venue} --agent-name ${meta.agentName}; once the slot shows a different key, re-run the revoke.`,
    });
  }
  if (slotKey === null || norm(slotKey) !== norm(throwawayPublicKey) || (meta.publicKey !== undefined && norm(slotKey) === norm(meta.publicKey))) {
    throw new PerpError("APPROVE_PARTIAL", `${venueName} revoke sent ChangePubKey for slot ${meta.apiKeyIndex}, but the slot does not show the replacement key yet (current: ${slotKey === null ? "none" : slotKey.slice(0, 20) + "…"})`, {
      exchange: venue,
      remediation: `Local key kept — the old agent key may still be authorized. Wait a few seconds and re-run: perp${network === "testnet" ? " -n testnet" : ""} wallet agent revoke ${venue} ${meta.agentName}`,
    });
  }
  const { deleteLighterFamilyKey } = await import("../agent-wallet/lighter-keystore.js");
  deleteLighterFamilyKey(venue, network, meta.accountIndex, meta.apiKeyIndex);
}
