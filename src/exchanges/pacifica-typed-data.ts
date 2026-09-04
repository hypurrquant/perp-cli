/**
 * Pacifica agent-wallet signing builders (Phase 2c).
 *
 * Pacifica auth model — off-chain signed messages over Solana Ed25519.
 * Reference: https://pacifica.gitbook.io/docs/api-documentation/api/signing.md
 *
 * Canonical JSON rules (from Pacifica signing spec + production reference
 * `src/pacifica/signing.ts:prepareMessage()`):
 *   1. Recursively sort all object keys alphabetically.
 *   2. Compact JSON (`JSON.stringify(value)` — no whitespace).
 *   3. Outer wrapper has the shape `{ <header fields>, "data": <payload> }`
 *      where header is `{ type, timestamp, expiry_window }`. The `data` key
 *      is sorted lexicographically alongside the header fields.
 *
 * `bind_agent_wallet` mirrors HypurrQuant_FE `PacificaPerpAdapter.ts` (see
 * project memory `hypurrquant_fe_reference.md`).
 *
 * Revocation follows the OFFICIAL Pacifica SDK (`rest/api_agent_keys_detailed.py`):
 * `revoke_agent_wallet` → POST /agent/revoke, `revoke_all_agent_wallets` →
 * POST /agent/revoke_all. An earlier `unbind_agent_wallet` → /agent/bind shape
 * was carried over from the HypurrQuant reference and is NOT part of Pacifica's
 * API; it was silently rejected, leaving revoked-looking agents authorized.
 *
 * Pure functions — no side effects, no fs/fetch/env reads.
 */

import { sortJsonKeys } from "../pacifica/signing.js";

/** Default expiry window for signed Pacifica REST requests (ms). */
export const DEFAULT_EXPIRY_WINDOW = 5_000;

// ── Types ────────────────────────────────────────────────────────────────

export interface BindAgentMessageParams {
  /** Master Solana base58 public key. */
  account: string;
  /** Agent Solana base58 public key. */
  agentWallet: string;
  /** Optional ms-epoch timestamp; defaults to `Date.now()`. */
  timestamp?: number;
  /** Optional expiry window (ms); defaults to DEFAULT_EXPIRY_WINDOW. */
  expiryWindow?: number;
}

export interface RevokeAgentMessageParams {
  /** Master Solana base58 public key. */
  account: string;
  /** Agent Solana base58 public key to revoke. Required — must not be empty. */
  agentWallet: string;
  timestamp?: number;
  expiryWindow?: number;
}

export interface BuiltMessage {
  /** Canonical JSON string ready for Ed25519 signing. */
  canonicalJson: string;
  /** Header captured for use in the REST envelope. */
  header: { type: string; timestamp: number; expiry_window: number };
  /** Original payload object (caller supplies in REST envelope alongside signature). */
  payload: Record<string, unknown>;
}

// ── Builders ─────────────────────────────────────────────────────────────

/**
 * Build the canonical JSON for `bind_agent_wallet`.
 *
 * Wire shape (after sorting):
 *   {"data":{"agent_wallet":"<base58>"},"expiry_window":5000,"timestamp":...,"type":"bind_agent_wallet"}
 *
 * The `account` field is supplied separately in the REST envelope; only the
 * `agent_wallet` payload field is included inside the signed `data` block.
 * This mirrors `buildSignedRequest()` in `src/pacifica/signing.ts`, which is
 * the production reference for non-agent signed Pacifica requests.
 */
export function buildBindAgentMessage(params: BindAgentMessageParams): BuiltMessage {
  const timestamp = params.timestamp ?? Date.now();
  const expiryWindow = params.expiryWindow ?? DEFAULT_EXPIRY_WINDOW;
  const type = "bind_agent_wallet";
  const payload: Record<string, unknown> = {
    agent_wallet: params.agentWallet,
  };
  const header = { type, timestamp, expiry_window: expiryWindow };
  const wrapped = { ...header, data: payload };
  const sorted = sortJsonKeys(wrapped);
  return {
    canonicalJson: JSON.stringify(sorted),
    header,
    payload,
  };
}

/**
 * Build the canonical JSON for `revoke_agent_wallet` (POST /agent/revoke).
 *
 * Revokes exactly one agent wallet. To revoke every agent, use
 * `buildRevokeAllAgentsMessage` — Pacifica exposes that as its own operation
 * type and endpoint, not as an empty-string sentinel on this one.
 */
export function buildRevokeAgentMessage(params: RevokeAgentMessageParams): BuiltMessage {
  if (!params.agentWallet) {
    // Rule #2: an empty agent address is not a "revoke all" sentinel on this
    // operation. Signing one would produce a request the venue cannot act on.
    throw new Error("buildRevokeAgentMessage requires a non-empty agentWallet; use buildRevokeAllAgentsMessage to revoke every agent.");
  }
  const timestamp = params.timestamp ?? Date.now();
  const expiryWindow = params.expiryWindow ?? DEFAULT_EXPIRY_WINDOW;
  const type = "revoke_agent_wallet";
  const payload: Record<string, unknown> = {
    agent_wallet: params.agentWallet,
  };
  const header = { type, timestamp, expiry_window: expiryWindow };
  const wrapped = { ...header, data: payload };
  const sorted = sortJsonKeys(wrapped);
  return {
    canonicalJson: JSON.stringify(sorted),
    header,
    payload,
  };
}

/**
 * Build the canonical JSON for `revoke_all_agent_wallets`
 * (POST /agent/revoke_all). Payload is empty per the official SDK.
 */
export function buildRevokeAllAgentsMessage(
  params: Omit<RevokeAgentMessageParams, "agentWallet">,
): BuiltMessage {
  const timestamp = params.timestamp ?? Date.now();
  const expiryWindow = params.expiryWindow ?? DEFAULT_EXPIRY_WINDOW;
  const type = "revoke_all_agent_wallets";
  const payload: Record<string, unknown> = {};
  const header = { type, timestamp, expiry_window: expiryWindow };
  const wrapped = { ...header, data: payload };
  const sorted = sortJsonKeys(wrapped);
  return {
    canonicalJson: JSON.stringify(sorted),
    header,
    payload,
  };
}
