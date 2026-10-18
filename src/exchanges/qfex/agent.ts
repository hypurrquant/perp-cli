/**
 * QFEX API key import.
 *
 * Keys are created on the QFEX website (Developer Settings, 2FA) — there is no programmatic
 * approval. The public key + secret are entered via hidden prompt / stdin only (never flags,
 * never env). The secret is stored only in ~/.perp/qfex-agents/<publicKey>.json (AES-256-GCM,
 * 0600; SSOT Rule #3); settings keep the QfexAgentMeta pointer.
 *
 * The import BINDS the key to one concrete account UUID (the primary account's id, or the
 * given subaccount) — never "whatever the venue defaults to" — shows it, and stores nothing
 * until the caller confirms it. Every check is a read; no order, no subscription to act on,
 * and the banker (funding) host is not called (its GET /address issues an address).
 */

import { deleteVenueSecret, loadVenueSecret, saveVenueSecret } from "../../agent-wallet/venue-keystore.js";
import { PerpError } from "../../errors.js";
import type { QfexAgentMeta } from "../../settings.js";
import type { Network } from "../venue-types.js";
import { QfexClient } from "./client.js";
import type { QfexCredentials } from "./signing.js";
import { QFEX_IDLE_CLOSE_MS, QFEX_TIMEOUTS, QfexTradeSession } from "./ws-transport.js";
import type { RateLimitPolicy } from "../venue.js";

export const QFEX_AGENTS_DIR = "qfex-agents";
export const QFEX_IMPORT_REMEDIATION = "perp wallet agent import qfex";

/** The key is also the keystore file name and a URL query value → a conservative charset. */
const PUBLIC_KEY_RE = /^[A-Za-z0-9._-]{1,200}$/;
const SECRET_RE = /^\S{1,200}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertCredentialFormat(publicKey: string, secret: string): void {
  // The qfex_pub_… / qfex_secret_… prefixes in the docs are examples; they are not enforced.
  if (!PUBLIC_KEY_RE.test(publicKey)) {
    throw new PerpError("INVALID_PARAMS", "QFEX public key must be 1-200 characters of letters, digits, '.', '_' or '-'", {
      remediation: "Copy the public key exactly as shown in QFEX Developer Settings",
    });
  }
  if (!SECRET_RE.test(secret)) {
    throw new PerpError("INVALID_PARAMS", "QFEX secret must be 1-200 characters without whitespace — input not shown", {
      remediation: "Copy the secret exactly as shown when the key was created (it is displayed once)",
    });
  }
}

/** Read + decrypt the stored key. Throws KEY_NOT_FOUND / SIGNATURE_FAILED. */
export function loadQfexCredentials(publicKey: string): QfexCredentials {
  const plaintext = loadVenueSecret(QFEX_AGENTS_DIR, publicKey, "", QFEX_IMPORT_REMEDIATION);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (e) {
    throw new PerpError("SIGNATURE_FAILED", `QFEX keystore for ${publicKey} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, {
      remediation: QFEX_IMPORT_REMEDIATION,
    });
  }
  const r = parsed as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || typeof r.publicKey !== "string" || typeof r.secret !== "string") {
    throw new PerpError("SIGNATURE_FAILED", `QFEX keystore for ${publicKey} is missing publicKey/secret`, { remediation: QFEX_IMPORT_REMEDIATION });
  }
  if (r.publicKey !== publicKey) {
    throw new PerpError("SIGNATURE_FAILED", `QFEX keystore for ${publicKey} holds a different public key`, { remediation: QFEX_IMPORT_REMEDIATION });
  }
  return { publicKey: r.publicKey, secret: r.secret };
}

export interface QfexAccountBinding {
  accountId: string;
  isPrimaryAccount: boolean;
  /** How the account was established (shown to the user and recorded as the verification method). */
  method: string;
}

interface SubaccountRow { account_id?: unknown; is_master?: unknown }

function codeOf(e: unknown): string | null {
  return e instanceof PerpError ? e.structured.code : null;
}

/**
 * Permission-probing read; any failure other than the two below aborts the import.
 * true = the read succeeded, false = the venue denied it (403), null = the permission cannot be
 * told: an account that has never been funded answers GET /user/positions with HTTP 500
 * "position balance not found" (live production 2026-10-05) — the key authenticated, but there
 * is no balance record to read yet.
 */
async function probe(read: () => Promise<unknown>): Promise<boolean | null> {
  try {
    await read();
    return true;
  } catch (e) {
    if (codeOf(e) === "POLICY_DENIED") return false;
    if (isUnfundedAccountError(e)) return null;
    throw e;
  }
}

/** QFEX's answer for an account with no balance record yet (never funded). */
export function isUnfundedAccountError(e: unknown): boolean {
  return e instanceof PerpError && /position balance not found/i.test(e.message);
}

export interface QfexImportOptions {
  agentName: string;
  publicKey: string;
  secret: string;
  network: Network;
  /** --account-id; null = the user's primary account. */
  accountId: string | null;
  endpoints: { rest: string; tradeWs: string; banker: string };
  rateLimit: RateLimitPolicy;
  /** Shown the resolved account; returning false stores nothing. */
  confirmAccount(binding: QfexAccountBinding): Promise<boolean>;
}

/**
 * Verify a key against the venue with reads only, bind it to one account, get that binding
 * confirmed, then store it. Nothing is written if any step fails or the confirmation is declined.
 */
export async function importQfexAgent(opts: QfexImportOptions): Promise<{ meta: QfexAgentMeta; binding: QfexAccountBinding }> {
  const publicKey = opts.publicKey.trim();
  const secret = opts.secret.trim();
  assertCredentialFormat(publicKey, secret);
  if (opts.accountId !== null && !UUID_RE.test(opts.accountId)) {
    throw new PerpError("INVALID_PARAMS", `--account-id "${opts.accountId}" is not a UUID`, {
      remediation: "Use the account id shown in the QFEX web app (Subaccounts)",
    });
  }
  const credentials: QfexCredentials = { publicKey, secret };
  const client = new QfexClient({ restUrl: opts.endpoints.rest, bankerUrl: opts.endpoints.banker, network: opts.network, credentials, accountId: null });

  // 1. Which account? GET /user/subaccounts/balance lists the user's accounts with is_master.
  let binding: QfexAccountBinding;
  let rows: SubaccountRow[] | null;
  try {
    const body = await client.getAs<{ accounts?: unknown }>("/user/subaccounts/balance", null, null);
    if (!Array.isArray(body.accounts)) throw new PerpError("EXCHANGE_ERROR", "QFEX /user/subaccounts/balance: response has no accounts list");
    rows = body.accounts as SubaccountRow[];
  } catch (e) {
    if (codeOf(e) !== "POLICY_DENIED") throw e;
    rows = null; // the key may not list accounts (e.g. scoped to one account)
  }
  if (rows !== null) {
    const ids = rows.filter(r => typeof r.account_id === "string").map(r => ({ id: (r.account_id as string).toLowerCase(), master: r.is_master === true }));
    if (opts.accountId !== null) {
      const hit = ids.find(r => r.id === opts.accountId!.toLowerCase());
      if (hit === undefined) {
        throw new PerpError("AGENT_NOT_REGISTERED", `QFEX ${opts.network} lists no account ${opts.accountId} for this key`, {
          remediation: `Accounts visible to the key: ${ids.map(r => `${r.id}${r.master ? " (primary)" : ""}`).join(", ") || "none"}`,
        });
      }
      binding = { accountId: hit.id, isPrimaryAccount: hit.master, method: "GET /user/subaccounts/balance lists the account" };
    } else {
      const masters = ids.filter(r => r.master);
      if (masters.length !== 1) {
        throw new PerpError("EXCHANGE_ERROR", `QFEX /user/subaccounts/balance lists ${masters.length} primary accounts; cannot tell which account the key trades`, {
          remediation: "Pass the account explicitly: perp wallet agent import qfex --account-id <uuid>",
        });
      }
      binding = { accountId: masters[0].id, isPrimaryAccount: true, method: "GET /user/subaccounts/balance: the is_master account" };
    }
  } else {
    if (opts.accountId === null) {
      throw new PerpError("POLICY_DENIED", "This QFEX key cannot list accounts, so the account it trades cannot be resolved", {
        remediation: "Pass the account the key is scoped to: perp wallet agent import qfex --account-id <uuid> (shown in the QFEX web app)",
      });
    }
    binding = { accountId: opts.accountId.toLowerCase(), isPrimaryAccount: false, method: "given --account-id; a signed read as that account succeeded (the key cannot list accounts, so primary/sub is unknown — treated as a subaccount)" };
  }

  // 2. Reads AS that account. 401 aborts (SIGNATURE_FAILED); 403 = that permission is missing.
  const viewPositions = await probe(() => client.getAs("/user/positions", null, binding.accountId));
  const viewOrders = await probe(() => client.getAs("/user/trade", { limit: 1 }, binding.accountId));
  if (rows === null && viewPositions !== true) {
    const positions = viewPositions === false ? "was denied positions" : "could not read positions (unknown: the account is not funded yet)";
    throw new PerpError("POLICY_DENIED", `The key could not list accounts and ${positions} as ${binding.accountId}; nothing proves it can act on that account`, {
      remediation: viewPositions === false
        ? "Check the account id and the key's scope / View permissions in QFEX Developer Settings"
        : "Fund the account first (a never-funded account has no balance record to read), or import a key with All accounts access",
    });
  }

  // 3. Trade WebSocket authentication with the account named explicitly. No command is sent.
  const session = new QfexTradeSession({
    url: opts.endpoints.tradeWs, network: opts.network, credentials, accountId: binding.accountId, builderCode: null,
    rateLimit: opts.rateLimit, timeouts: QFEX_TIMEOUTS, idleCloseMs: QFEX_IDLE_CLOSE_MS,
  });
  await session.verifyAuth();

  // 4. The user confirms the account BEFORE anything is stored.
  if (!(await opts.confirmAccount(binding))) {
    throw new PerpError("INVALID_PARAMS", `QFEX import cancelled — account ${binding.accountId} was not confirmed; nothing was stored`, {
      remediation: "Re-run and confirm the account, or pass the intended one: perp wallet agent import qfex --account-id <uuid>",
    });
  }

  const keystorePath = saveVenueSecret(QFEX_AGENTS_DIR, publicKey, JSON.stringify({ publicKey, secret }), "");
  const meta: QfexAgentMeta = {
    kind: "qfex",
    agentName: opts.agentName,
    publicKey,
    keystorePath,
    accountId: binding.accountId,
    isPrimaryAccount: binding.isPrimaryAccount,
    // Positions and balance come from the same endpoint. Execute / withdraw cannot be checked without acting.
    permissions: { viewPositions, viewBalance: viewPositions, viewOrders, executeOrders: null, depositWithdraw: null },
    network: opts.network,
    approvedAt: new Date().toISOString(),
    source: "imported",
  };
  return { meta, binding };
}

/**
 * Delete the local keystore for `publicKey`. Returns true if a file was removed. The key stays
 * valid on the venue — revoke it in QFEX Developer Settings.
 */
export function revokeQfexAgentLocal(publicKey: string): boolean {
  return deleteVenueSecret(QFEX_AGENTS_DIR, publicKey);
}
