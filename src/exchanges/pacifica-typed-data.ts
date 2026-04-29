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
 * The agent bind/unbind action types are documented in HypurrQuant_FE
 * `PacificaPerpAdapter.ts` (production reference for HypurrQuant_FE; see
 * project memory `hypurrquant_fe_reference.md`). We mirror their `bind_agent_wallet`
 * and `unbind_agent_wallet` operation types here.
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

export interface UnbindAgentMessageParams {
  /** Master Solana base58 public key. */
  account: string;
  /**
   * Agent Solana base58 public key to unbind. Pass an empty string to
   * unbind all agent wallets per Pacifica convention.
   */
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
 * Build the canonical JSON for `unbind_agent_wallet`.
 *
 * Pacifica convention: empty `agent_wallet` string unbinds all agents; a
 * specific base58 address unbinds just that agent.
 */
export function buildUnbindAgentMessage(params: UnbindAgentMessageParams): BuiltMessage {
  const timestamp = params.timestamp ?? Date.now();
  const expiryWindow = params.expiryWindow ?? DEFAULT_EXPIRY_WINDOW;
  const type = "unbind_agent_wallet";
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
