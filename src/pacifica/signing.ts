import bs58 from "bs58";
import { DEFAULT_EXPIRY_WINDOW } from "./constants";

/**
 * Recursively sort all object keys alphabetically.
 * Exact port of Python SDK's sort_json_keys().
 */
export function sortJsonKeys(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(sortJsonKeys);
  }

  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJsonKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  return value;
}

/**
 * Prepare the message string for signing.
 * Exact port of Python SDK's prepare_message().
 *
 * Header must contain: type, timestamp, expiry_window
 * Returns compact JSON with sorted keys and payload nested under "data".
 */
export function prepareMessage(
  header: { type: string; timestamp: number; expiry_window: number },
  payload: object
): string {
  if (!header.type || !header.timestamp || !header.expiry_window) {
    throw new Error("Header must have type, timestamp, and expiry_window");
  }

  const data = {
    ...header,
    data: payload,
  };

  const sorted = sortJsonKeys(data);
  // JSON.stringify with no space args produces compact JSON (same as Python separators=(",",":"))
  return JSON.stringify(sorted);
}

/**
 * Create a signing header with current timestamp.
 */
export function createHeader(
  type: string,
  expiryWindow: number = DEFAULT_EXPIRY_WINDOW
): { type: string; timestamp: number; expiry_window: number } {
  return {
    type,
    timestamp: Date.now(),
    expiry_window: expiryWindow,
  };
}

/**
 * Sign a message using a wallet adapter's signMessage function.
 * Used in browser context with Phantom/Solflare/etc.
 *
 * @param header - Operation header (type, timestamp, expiry_window)
 * @param payload - Operation payload
 * @param signMessage - Wallet adapter's signMessage function
 * @returns [message, base58EncodedSignature]
 */
export async function signWithWallet(
  header: { type: string; timestamp: number; expiry_window: number },
  payload: object,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>
): Promise<[string, string]> {
  const message = prepareMessage(header, payload);
  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = await signMessage(messageBytes);
  const signature = bs58.encode(signatureBytes);
  return [message, signature];
}

/**
 * Build a signed request body for REST API POST.
 * Flattens payload to top level and adds account, signature, timestamp, expiry_window.
 */
export async function buildSignedRequest(
  operationType: string,
  payload: object,
  account: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  expiryWindow: number = DEFAULT_EXPIRY_WINDOW
): Promise<Record<string, unknown>> {
  const header = createHeader(operationType, expiryWindow);
  const [, signature] = await signWithWallet(header, payload, signMessage);

  return {
    account,
    signature,
    timestamp: header.timestamp,
    expiry_window: header.expiry_window,
    ...payload,
  };
}

/**
 * Build a signed request with agent wallet.
 * Used when an agent wallet is trading on behalf of a main account.
 */
export async function buildAgentSignedRequest(
  operationType: string,
  payload: object,
  mainAccount: string,
  agentWallet: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
  expiryWindow: number = DEFAULT_EXPIRY_WINDOW
): Promise<Record<string, unknown>> {
  const header = createHeader(operationType, expiryWindow);
  const [, signature] = await signWithWallet(header, payload, signMessage);

  return {
    account: mainAccount,
    agent_wallet: agentWallet,
    signature,
    timestamp: header.timestamp,
    expiry_window: header.expiry_window,
    ...payload,
  };
}
