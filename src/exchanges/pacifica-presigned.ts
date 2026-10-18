/**
 * Pacifica signed writes whose body the caller builds before signing (Print `/game/*`, vault
 * `/lake/*`). Building the canonical message and the request body is pure, so `--dry-run`
 * prints exactly what a live run would sign and send — only the signature is missing.
 *
 * Signing scheme (docs.pacifica.fi api-documentation/api/signing, reused from
 * src/pacifica/signing.ts): message = compact JSON, keys sorted recursively, of
 * `{ type, timestamp, expiry_window, data: <payload> }`; Ed25519 signature, base58. The body is
 * `{ account, agent_wallet?, signature, timestamp, expiry_window, ...payload }` — the same shape
 * as `buildSignedRequest` / `buildAgentSignedRequest`.
 *
 * Send outcome (money-safety rules, docs/TEST-PLAN.md):
 *  - HTTP 4xx (except 409 / 429): the venue refused — ACTION_REJECTED, nothing happened;
 *  - HTTP 409 "duplicate idempotency key": a request with this key already exists — ORDER_PENDING;
 *  - HTTP 429: RATE_LIMITED, nothing happened;
 *  - timeout / reset / 5xx / unreadable or ambiguous 2xx body: ORDER_PENDING — never resubmit.
 */
import bs58 from "bs58";
import { prepareMessage } from "../pacifica/signing.js";
import { DEFAULT_EXPIRY_WINDOW } from "../pacifica/constants.js";
import type { PacificaClient } from "../pacifica/client.js";
import { PerpError, extractErrorMessage, orderNotSent } from "../errors.js";

export type PresignedPath = "/game/deposit" | "/game/end" | "/lake/deposit" | "/lake/withdraw";

export interface PresignedRequest {
  /** Signing operation type (header `type`). */
  type: string;
  path: PresignedPath;
  /** Canonical JSON the signer signs (UTF-8 bytes). */
  message: string;
  /** Request body without `signature`. */
  body: Record<string, unknown>;
  /** `idempotency_key` of the payload, or null when the operation has none. */
  idempotencyKey: string | null;
}

export interface PresignedIdentity {
  /** Master account address (`account`). */
  account: string;
  /** Agent wallet pubkey when an agent key signs, else null (master signs). */
  agentWallet: string | null;
}

/** Build the canonical message and unsigned body. Undefined payload values are refused (they would be dropped by JSON but not by the signer). */
export function buildPresigned(p: {
  type: string;
  path: PresignedPath;
  payload: Record<string, unknown>;
  identity: PresignedIdentity;
  timestamp: number;
  expiryWindow?: number;
}): PresignedRequest {
  for (const [k, v] of Object.entries(p.payload)) {
    if (v === undefined) throw new Error(`buildPresigned: payload field ${k} is undefined`);
  }
  const expiryWindow = p.expiryWindow ?? DEFAULT_EXPIRY_WINDOW;
  const message = prepareMessage({ type: p.type, timestamp: p.timestamp, expiry_window: expiryWindow }, p.payload);
  const body: Record<string, unknown> = {
    account: p.identity.account,
    ...(p.identity.agentWallet !== null ? { agent_wallet: p.identity.agentWallet } : {}),
    timestamp: p.timestamp,
    expiry_window: expiryWindow,
    ...p.payload,
  };
  const key = p.payload.idempotency_key;
  return { type: p.type, path: p.path, message, body, idempotencyKey: typeof key === "string" ? key : null };
}

/** Sign the canonical message; returns the full body (`signature` added). A signing failure is "not sent". */
export async function signPresigned(req: PresignedRequest, signMessage: (msg: Uint8Array) => Promise<Uint8Array>): Promise<Record<string, unknown>> {
  try {
    const sig = await signMessage(new TextEncoder().encode(req.message));
    const { account, agent_wallet, ...rest } = req.body;
    return { account, ...(agent_wallet !== undefined ? { agent_wallet } : {}), signature: bs58.encode(sig), ...rest };
  } catch (e) {
    throw orderNotSent("pacifica", req.type, e);
  }
}

/**
 * Send a signed body and return the response `data` object. `what` names the action in errors
 * ("Print deposit"); `check` is the read command that settles an unknown outcome.
 */
export async function sendPresigned(
  client: Pick<PacificaClient, "postPresigned">,
  req: PresignedRequest,
  signedBody: Record<string, unknown>,
  ctx: { what: string; check: string },
): Promise<Record<string, unknown>> {
  const details = { exchange: "pacifica", path: req.path, idempotencyKey: req.idempotencyKey };
  const pending = (why: string): PerpError => new PerpError("ORDER_PENDING", `Pacifica ${ctx.what}: outcome unknown — ${why}`, {
    ...details,
    remediation: `Do NOT resubmit — the ${ctx.what} may have been executed. Check first: ${ctx.check}`,
  });
  let raw: unknown;
  try {
    raw = await client.postPresigned(req.path, signedBody);
  } catch (e) {
    if (e instanceof PerpError) {
      if (e.structured.code === "ORDER_PENDING") throw pending(e.message);
      throw e; // definite (not sent / refused) — client already classified it
    }
    const m = /^POST \S+ failed \((\d{3})\): ([\s\S]*)$/.exec(extractErrorMessage(e));
    if (m === null) throw pending(extractErrorMessage(e));
    const status = Number(m[1]);
    const venueError = venueErrorOf(m[2]);
    if (status === 409) throw pending(`HTTP 409 duplicate idempotency key ${req.idempotencyKey ?? "(none)"} — a request with this key already reached the venue: ${venueError}`);
    if (status === 429) {
      throw new PerpError("RATE_LIMITED", `Pacifica ${ctx.what} rate-limited (HTTP 429, nothing was executed): ${venueError}`, { ...details, remediation: "Wait and retry" });
    }
    if (status >= 400 && status < 500) {
      throw new PerpError("ACTION_REJECTED", `Pacifica ${ctx.what} refused (HTTP ${status}, nothing was executed): ${venueError}`, {
        ...details, httpStatus: status, remediation: "Fix the parameter named in the venue message and retry",
      });
    }
    throw pending(`HTTP ${status}: ${venueError}`);
  }
  if (raw === null || typeof raw !== "object") throw pending(`unreadable response ${JSON.stringify(raw)?.slice(0, 160)}`);
  const env = raw as Record<string, unknown>;
  if (env.success === false) {
    throw new PerpError("ACTION_REJECTED", `Pacifica ${ctx.what} refused (nothing was executed): ${String(env.error ?? "success: false")}`, {
      ...details, venueCode: env.code ?? null, remediation: "Fix the parameter named in the venue message and retry",
    });
  }
  const data = env.data;
  if (env.success !== true || data === null || typeof data !== "object" || Array.isArray(data)) {
    throw pending(`response without a data object: ${JSON.stringify(raw).slice(0, 200)}`);
  }
  return data as Record<string, unknown>;
}

function venueErrorOf(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    if (typeof j.error === "string" && j.error !== "") return j.error;
  } catch { /* not JSON */ }
  return text.slice(0, 300);
}
