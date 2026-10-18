/**
 * Arcus Spot Router HTTP client + wire types.
 *
 * Ported from @arcus-xyz/arcus-spot-sdk@1.0.2 (src/client.ts, src/types.ts,
 * src/chains.ts) — Copyright Arcus, licensed under the Apache License 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Changes: viem removed, only
 * the "arcus" venue shapes kept, errors mapped to PerpError.
 *
 * Endpoints (router.spot.arcus.xyz): GET /v1/tokens, /v1/price, /v1/quote,
 * /v1/status; POST /v1/submit. No API key is sent — the router served
 * /tokens, /price and /quote without one (verified 2026-10-01). Whether
 * /submit needs one is unverified; a 401/403 on submit is reported as
 * NOT_IMPLEMENTED (no key storage exists, SSOT Rule #3).
 */

import { PerpError } from "../../errors.js";
import type { Network } from "../venue-types.js";

/** Canonical Permit2 (same address on every chain). */
export const PERMIT2_ADDRESS = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
/** Multicall3 — `eth_getCode` non-empty on RH mainnet and testnet (verified 2026-10-01). */
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** `/tokens` sentinel for the chain's native asset. */
export const NATIVE_TOKEN_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export interface ArcusSpotDeployment {
  routerUrl: string;
  chainId: number;
  /** Permit2 spender bound in every arcus-venue intent (SDK chains.ts). */
  arcusSettlement: string;
}

export const ARCUS_SPOT_DEPLOYMENTS: Record<Network, ArcusSpotDeployment> = {
  mainnet: {
    routerUrl: "https://router.spot.arcus.xyz/v1",
    chainId: 4663,
    arcusSettlement: "0x006102b16A04c20306A28b652745D3973D7D24fa",
  },
  testnet: {
    routerUrl: "https://router.spot.testnet.arcus.xyz/v1",
    chainId: 46630,
    arcusSettlement: "0xE8D8b187754D8a5Ca4Ea4E77Cd01506f9332A773",
  },
};

/** Per-request HTTP timeout (SDK default). */
export const ARCUS_ROUTER_TIMEOUT_MS = 15_000;
/** Longest Retry-After (seconds) a GET waits out before failing with RATE_LIMITED. */
const MAX_RETRY_AFTER_S = 60;
/** Rate-limit waits per GET before failing with RATE_LIMITED. */
const MAX_RATE_LIMIT_WAITS = 2;

// ── Wire types (arcus venue only) ──

export interface RouterToken {
  chainId: number;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  source: string;
  category: string;
  verified: boolean;
  /** Canonical wrapped (placeholder) token for RFQ fallback fills; null/absent = none. */
  wrappedTokenAddress?: string | null;
}

export interface RouteFee {
  amount: string;
  token: string;
  type: string;
  bps?: number;
  amountUsd?: number;
}

export interface PriceEntry {
  venue: string;
  /** Net of fees, buy-token base units. */
  buyAmount: string;
  sellAmount: string;
  fees: RouteFee[];
}

export interface PriceResponse {
  recommended: string;
  venue: string;
  referencePrice: string | null;
  all: PriceEntry[];
}

export interface Eip712TypedData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
}

export interface TakerIntent {
  taker: string;
  takerSellToken: string;
  takerBuyToken: string;
  sellAmount: string;
  minBuyAmount: string;
  allowWrapped: boolean;
  nonce: string;
  deadline: string;
}

export interface TakerIntentTypedData extends Eip712TypedData {
  message: {
    permitted: { token: string; amount: string };
    spender: string;
    nonce: string;
    deadline: string;
    witness: TakerIntent;
  };
}

export interface ArcusQuoteEntry extends PriceEntry {
  venue: "arcus";
  expiry: number;
  toSign: TakerIntentTypedData;
  arcus: { minAmountOut: string };
}

export interface QuoteResponse {
  recommended: string;
  venue: string;
  all: Array<PriceEntry & { toSign?: unknown }>;
}

/** EIP-2612 permit folded into SwapShell.permits[] (SDK types.ts `Permit`). */
export interface Permit {
  token: string;
  value: string;
  deadline: string;
  v: number;
  r: string;
  s: string;
}

export interface ArcusSignedQuote {
  venue: "arcus";
  chainId: number;
  taker: string;
  typedData: TakerIntentTypedData;
  signature: string;
  permits?: Permit[];
}

export interface ArcusSubmitResponse {
  venue: string;
  txHash: string;
  status: string;
  maker?: string;
  wrapped?: boolean;
  settledToken?: string;
  orderId?: string;
}

export type RouterStatus = "pending" | "submitted" | "confirmed" | "failed" | "unknown";

export interface StatusResponse {
  venue: string;
  status: RouterStatus;
  txHash?: string | null;
  reason?: string | null;
  errorCode?: string | null;
  swap?: unknown;
}

/** Router codes meaning the trade is below the router's minimum size/fee. */
const BELOW_MINIMUM_CODES = new Set(["TRADE_NOTIONAL_BELOW_MINIMUM", "TRADE_BELOW_MINIMUM_FEE"]);

/** HTTP-level router failure (non-2xx). `routerCode` is the router's error code when it sent one. */
export class RouterHttpError extends PerpError {
  constructor(
    message: string,
    readonly status: number,
    readonly routerCode: string | null,
    readonly body: unknown,
    readonly retryAfter: string | null,
  ) {
    super(
      status === 429 ? "RATE_LIMITED" : routerCode !== null && BELOW_MINIMUM_CODES.has(routerCode) ? "SIZE_TOO_SMALL" : "EXCHANGE_ERROR",
      message,
      { exchange: "arcus", httpStatus: status, routerCode },
    );
    this.name = "RouterHttpError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function routerErrorMessage(body: unknown): { code: string | null; message: string | null } {
  if (!body || typeof body !== "object") return { code: null, message: typeof body === "string" && body ? body : null };
  const b = body as Record<string, unknown>;
  const code = typeof b.code === "string" ? b.code : null;
  const error = typeof b.error === "string" ? b.error : null;
  const details = Array.isArray(b.details)
    ? b.details
        .map(d => {
          const item = d as { venue?: unknown; error?: { message?: unknown; code?: unknown } };
          const v = typeof item.venue === "string" ? item.venue : "upstream";
          const c = typeof item.error?.code === "string" ? item.error.code : null;
          const m = typeof item.error?.message === "string" ? item.error.message : null;
          return `${v}: ${[c, m].filter(Boolean).join(" ")}`;
        })
        .join("; ")
    : null;
  return { code, message: [error ?? code, details].filter(Boolean).join(" — ") || null };
}

export class ArcusSpotRouter {
  constructor(readonly deployment: ArcusSpotDeployment) {}

  private url(path: string, params: Record<string, string>): string {
    const u = new URL(`${this.deployment.routerUrl}/${path}`);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  private async request<T>(method: "GET" | "POST", url: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARCUS_ROUTER_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      const aborted = controller.signal.aborted;
      throw new PerpError(aborted ? "TIMEOUT" : "EXCHANGE_UNREACHABLE",
        `Arcus router ${method} ${url} ${aborted ? `timed out after ${ARCUS_ROUTER_TIMEOUT_MS}ms` : `failed: ${e instanceof Error ? e.message : String(e)}`}`,
        { exchange: "arcus" });
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    if (!res.ok) {
      const { code, message } = routerErrorMessage(parsed);
      throw new RouterHttpError(
        `Arcus router ${method} ${new URL(url).pathname} → HTTP ${res.status}${message ? `: ${message}` : ""}`,
        res.status, code, parsed, res.headers.get("retry-after"),
      );
    }
    return parsed as T;
  }

  /**
   * Idempotent GET. A 429 is waited out per the server's Retry-After (logged to
   * stderr, at most MAX_RATE_LIMIT_WAITS times, each ≤ MAX_RETRY_AFTER_S);
   * beyond that → RATE_LIMITED. Never used for POST /submit.
   */
  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = this.url(path, params);
    for (let waits = 0; ; waits++) {
      try {
        return await this.request<T>("GET", url, undefined);
      } catch (e) {
        if (!(e instanceof RouterHttpError) || e.status !== 429) throw e;
        const ra = e.retryAfter === null ? Number.NaN : Number(e.retryAfter);
        if (!Number.isFinite(ra) || ra < 0 || ra > MAX_RETRY_AFTER_S || waits >= MAX_RATE_LIMIT_WAITS) {
          throw new PerpError("RATE_LIMITED", `Arcus router rate limit on /${path} (Retry-After: ${Number.isFinite(ra) ? `${ra}s` : "none"})`, {
            exchange: "arcus",
            remediation: "Wait a minute and retry",
          });
        }
        console.error(`[arcus-spot] router rate-limited on /${path}; waiting ${ra}s (Retry-After)`);
        await sleep(ra * 1000);
      }
    }
  }

  async tokens(): Promise<RouterToken[]> {
    const rows = await this.get<unknown>("tokens", { chainId: String(this.deployment.chainId) });
    if (!Array.isArray(rows)) throw new PerpError("EXCHANGE_ERROR", "Arcus router /tokens did not return a list", { exchange: "arcus" });
    return rows as RouterToken[];
  }

  async price(sellToken: string, buyToken: string, sellAmount: bigint): Promise<PriceResponse> {
    return this.get<PriceResponse>("price", {
      chainId: String(this.deployment.chainId), sellToken, buyToken, sellAmount: sellAmount.toString(),
    });
  }

  async quote(p: { sellToken: string; buyToken: string; sellAmount: bigint; taker: string; slippageBps: number }): Promise<QuoteResponse> {
    return this.get<QuoteResponse>("quote", {
      chainId: String(this.deployment.chainId),
      sellToken: p.sellToken,
      buyToken: p.buyToken,
      sellAmount: p.sellAmount.toString(),
      taker: p.taker,
      slippageBps: String(p.slippageBps),
      allowWrapped: "false", // never accept a wrapped placeholder
    });
  }

  /** Single attempt — never retried (a resend could double-execute). Throws RouterHttpError / PerpError. */
  async submit(body: ArcusSignedQuote): Promise<ArcusSubmitResponse> {
    return this.request<ArcusSubmitResponse>("POST", `${this.deployment.routerUrl}/submit`, body);
  }

  async status(id: string): Promise<StatusResponse> {
    return this.get<StatusResponse>("status", { venue: "arcus", id, chainId: String(this.deployment.chainId) });
  }

  statusUrl(id: string): string {
    return this.url("status", { venue: "arcus", id, chainId: String(this.deployment.chainId) });
  }
}
