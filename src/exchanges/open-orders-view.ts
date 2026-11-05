import { PerpError } from "../errors.js";
import type { ExchangeAdapter, ExchangeOrder } from "./interface.js";

/**
 * Open orders for a read-only VIEW (portfolio, MCP portfolio, stream, dashboard) that also shows
 * balances and positions: a venue that cannot list orders without a signer (Lighter read-only /
 * expired agent → NO_SIGNER_AVAILABLE / AGENT_EXPIRED) reports the orders as unknown
 * (`orders: null` + the reason) instead of losing the whole venue. Every other failure throws.
 * Never use it on a cancel / flatten path: there an unknown order list must fail loudly.
 */
export async function openOrdersForView(adapter: ExchangeAdapter): Promise<{ orders: ExchangeOrder[] | null; error: string | null }> {
  try {
    return { orders: await adapter.getOpenOrders(), error: null };
  } catch (e) {
    if (e instanceof PerpError && (e.structured.code === "NO_SIGNER_AVAILABLE" || e.structured.code === "AGENT_EXPIRED")) {
      return { orders: null, error: e.message };
    }
    throw e;
  }
}
