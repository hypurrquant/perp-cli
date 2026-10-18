/**
 * Ondo Perps API-key ("agent") registration.
 *
 * The HMAC key id + secret are created by the user in the Ondo Perps UI and
 * entered via stdin by the CLI (never flags). The secret is persisted only in
 * ~/.perp/ondo-agents/<keyId>.json (AES-256-GCM, 0600; SSOT Rule #3); settings
 * keep the OndoAgentMeta pointer only.
 */

import { deleteVenueSecret, loadVenueSecret, saveVenueSecret } from "../../agent-wallet/venue-keystore.js";
import { PerpError } from "../../errors.js";
import type { OndoAgentMeta } from "../../settings.js";
import { networkConfig } from "../venue.js";
import type { Network } from "../venue-types.js";
import { ondoVenue } from "../venues/ondo.js";
import { OndoClient, type OndoCredentials } from "./client.js";

export const ONDO_AGENTS_DIR = "ondo-agents";
export const ONDO_APPROVE_REMEDIATION = "perp wallet agent approve ondo";

const KEY_ID_RE = /^ondoKeyId_[A-Za-z0-9_-]+$/;
const SECRET_RE = /^ondoApiSecret_\S+$/;

function assertCredentialFormat(keyId: string, secret: string): void {
  if (!KEY_ID_RE.test(keyId)) {
    throw new PerpError("INVALID_PARAMS", `Ondo key id must look like "ondoKeyId_…" (got "${keyId.slice(0, 16)}…")`, {
      remediation: "Copy the key id exactly as shown in Ondo Perps → API Keys, including the ondoKeyId_ prefix",
    });
  }
  if (!SECRET_RE.test(secret)) {
    throw new PerpError("INVALID_PARAMS", `Ondo API secret must start with "ondoApiSecret_"`, {
      remediation: "Copy the secret exactly as shown when the key was created, including the ondoApiSecret_ prefix",
    });
  }
}

/** Read + decrypt the stored key for `keyId`. Throws KEY_NOT_FOUND / SIGNATURE_FAILED. */
export function loadOndoCredentials(keyId: string): OndoCredentials {
  const plaintext = loadVenueSecret(ONDO_AGENTS_DIR, keyId, "", ONDO_APPROVE_REMEDIATION);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (e) {
    throw new PerpError("SIGNATURE_FAILED", `Ondo keystore for ${keyId} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, {
      remediation: ONDO_APPROVE_REMEDIATION,
    });
  }
  const r = parsed as Record<string, unknown> | null;
  if (!r || typeof r.keyId !== "string" || typeof r.secret !== "string") {
    throw new PerpError("SIGNATURE_FAILED", `Ondo keystore for ${keyId} is missing keyId/secret`, { remediation: ONDO_APPROVE_REMEDIATION });
  }
  if (r.keyId !== keyId) {
    throw new PerpError("SIGNATURE_FAILED", `Ondo keystore for ${keyId} holds a different key id (${r.keyId})`, {
      remediation: ONDO_APPROVE_REMEDIATION,
    });
  }
  return { keyId: r.keyId, secret: r.secret };
}

interface OndoAccountInfo {
  accountID: string;
  accountState: "open" | "disabled" | "offboarding" | "closed";
  /** OpenAPI AccountInfo.disabledFunctionality (optional object of booleans). */
  disabledFunctionality?: { disablePerps?: boolean; disableAPIKeys?: boolean };
}

/**
 * Verify an API key against the venue (authenticated GET /v1/account), reject
 * accounts whose perps / API-key functionality is disabled, then store it (scopes unknown —
 * see below). Nothing is written if any step fails.
 */
export async function approveOndoAgent(opts: {
  agentName: string;
  keyId: string;
  secret: string;
  network: Network;
}): Promise<OndoAgentMeta> {
  const keyId = opts.keyId.trim();
  const secret = opts.secret.trim();
  assertCredentialFormat(keyId, secret);

  const client = new OndoClient({
    restUrl: networkConfig(ondoVenue, opts.network).restUrl,
    network: opts.network,
    rateLimit: ondoVenue.rateLimit,
    credentials: { keyId, secret },
  });
  const account = await client.get<OndoAccountInfo>("/v1/account", null);
  if (account.accountState !== "open") {
    throw new PerpError("APPROVE_FAILED", `Ondo Perps account ${account.accountID} is ${account.accountState}`, {
      remediation: "Resolve the account state in the Ondo Perps UI, then retry",
    });
  }
  const disabled = account.disabledFunctionality;
  if (disabled !== undefined && (disabled.disablePerps === true || disabled.disableAPIKeys === true)) {
    const what = [disabled.disablePerps === true ? "perps" : null, disabled.disableAPIKeys === true ? "API keys" : null].filter(Boolean).join(" and ");
    throw new PerpError("APPROVE_FAILED", `Ondo Perps account ${account.accountID} has ${what} disabled`, {
      remediation: "Check the account's status in the Ondo Perps UI (region / compliance restrictions), then retry",
    });
  }
  // Scopes are not readable with the key itself: GET /v1/api_keys answers API-key auth with 403
  // key_not_allowed_for_action (live mainnet 2026-10-05, although the OpenAPI spec lists ApiKeyAuth
  // for it). They are recorded as unknown; a missing scope surfaces on the first call that needs it.
  const keystorePath = saveVenueSecret(ONDO_AGENTS_DIR, keyId, JSON.stringify({ keyId, secret }), "");
  return {
    kind: "ondo",
    agentName: opts.agentName,
    keyId,
    keystorePath,
    scopes: null,
    network: opts.network,
    approvedAt: new Date().toISOString(),
  };
}

/**
 * Delete the local keystore for `keyId`. Returns true if a file was removed.
 * The key itself stays valid on the venue — revoke it in the Ondo Perps UI.
 */
export function revokeOndoAgentLocal(keyId: string): boolean {
  return deleteVenueSecret(ONDO_AGENTS_DIR, keyId);
}
