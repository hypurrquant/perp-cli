import { MAINNET_REST, type Network, getNetworkConfig } from "./constants.js";
import { buildSignedRequest, buildAgentSignedRequest, signWithWallet } from "./signing.js";
import { PerpError, extractErrorMessage, orderNotSent, orderOutcomeUnknown, sendFailure } from "../errors.js";
import { invalidateCache } from "../cache.js";
import { requireSolanaAddress } from "../exchanges/address.js";
import {
  PACIFICA_COST_CANCEL, PACIFICA_COST_STANDARD, PACIFICA_MAX_THROTTLE_WAIT_MS, PACIFICA_READ_NEED, PACIFICA_SIGNED_MAX_WAIT_MS,
  pacificaRateLimiter, type PacificaRateLimiter, type RateNeed, type RateTicket,
} from "./rate-limit.js";
import type {
  MarketInfo,
  PriceInfo,
  Orderbook,
  Trade,
  Kline,
  FundingRateHistory,
  KlineInterval,
  AggLevel,
  AccountInfo,
  AccountSettings,
  Position,
  OrderInfo,
  MarketOrderParams,
  LimitOrderParams,
  StopOrderParams,
  EditOrderParams,
  CancelOrderParams,
  CancelAllOrdersParams,
  TWAPParams,
  CancelTWAPParams,
  TPSLParams,
  UpdateLeverageParams,
  WithdrawParams,
  TransferFundsParams,
  BatchAction,
  BatchActionType,
  CreateLakeParams,
  LakeDepositParams,
  LakeWithdrawParams,
} from "./types/index.js";

type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>;

/** Per-request timeout of a POST (fetch + body read). */
export const PACIFICA_POST_TIMEOUT_MS = 15_000;

/**
 * Account-setting writes whose HTTP 4xx is the venue's explicit refusal (nothing changed).
 * docs.pacifica.fi (api-documentation/api/rest-api):
 *   account/update-leverage:      "Status 400: Invalid request parameters" — {"error": "Invalid leverage", "code": 400}
 *   orders/create-position-tp-sl: "Status 400: Bad request" — {"error": "Position not found", "code": 400}
 * Both pages list only "Status 500: Internal server error" besides.
 */
const DEFINITE_4XX_PATHS: ReadonlySet<string> = new Set(["/positions/tpsl", "/account/leverage"]);

/** POST endpoints that only read (signed listings): a failure there is an ordinary read error. */
const READ_POST_PATHS: ReadonlySet<string> = new Set(["/account/subaccount/list", "/agent/list", "/account/api_keys"]);

/** Cancels cost 0.5 credits (docs: rate-limits "Order cancellation 0.5"), by path and by signed operation type. */
const CANCEL_POST_PATHS: ReadonlySet<string> = new Set(["/orders/cancel", "/orders/stop/cancel", "/orders/cancel_all", "/orders/twap/cancel"]);
const CANCEL_OPERATIONS: ReadonlySet<string> = new Set(["cancel_order", "cancel_stop_order", "cancel_all_orders", "cancel_twap_order"]);
/** Signed operation types of the READ_POST_PATHS listings: the read need applies before and after signing. */
const READ_OPERATIONS: ReadonlySet<string> = new Set(["list_subaccounts", "list_agent_wallets", "list_api_keys"]);

/**
 * A signed write needs only its own cost (never the read reserve); `maxWaitMs` = how long it may
 * wait at this point (before signing: the normal bound; after signing: inside expiry_window).
 */
function writeNeed(cancel: boolean, maxWaitMs: number): RateNeed {
  const cost = cancel ? PACIFICA_COST_CANCEL : PACIFICA_COST_STANDARD;
  return { cost, reserve: 0, maxWaitMs };
}

/**
 * Credits ×10 reserved for one POST /orders/batch. The docs (api/rate-limits "Credit Costs") price
 * a "Standard request/action" at 1 credit and an "Order cancellation" at 0.5 and say nothing
 * batch-specific (batch-order page: no cost); every action is individually signed and processed,
 * so the batch is reserved per ACTION — the conservative reading (over-reserving only throttles
 * earlier; the venue's ratelimit headers on the response settle the real count).
 */
export function pacificaBatchCost(types: readonly BatchActionType[]): number {
  return types.reduce((a, t) => a + (t === "Cancel" || t === "CancelStopOrder" ? PACIFICA_COST_CANCEL : PACIFICA_COST_STANDARD), 0);
}

export interface PacificaClientConfig {
  network?: Network;
  baseUrl?: string;
  apiKey?: string;
}

/** Query parameters that carry a Solana address (account reads, Print orders, vaults). */
const ADDRESS_PARAMS: ReadonlySet<string> = new Set(["account", "game_account", "lake"]);

export { requireSolanaAddress };

function checkAddressParams(params: Record<string, string> | undefined): void {
  for (const [k, v] of Object.entries(params ?? {})) if (ADDRESS_PARAMS.has(k) && v !== undefined && v !== null) requireSolanaAddress(v, k);
}

export class PacificaClient {
  private baseUrl: string;
  private apiKey?: string;
  /**
   * Agent-wallet pubkey for the current request signer, set by the adapter when an
   * agent wallet (not the master) is signing. When present, signed bodies carry the
   * `agent_wallet` field (with account = master) so Pacifica verifies the signature
   * against the agent key. Undefined for master/PK signers.
   */
  private requestAgentWallet?: string;
  /** Credit-quota state for this base URL + key tier (rate-limit.ts; process-local): unsigned GETs (IP quota) … */
  private readonly rate: PacificaRateLimiter;
  /** … and signed POSTs (may report the account's quota) kept apart. */
  private readonly signedRate: PacificaRateLimiter;

  /** Attach (or clear) the agent wallet used for subsequent signed requests. */
  setRequestAgentWallet(agentWallet?: string): void {
    this.requestAgentWallet = agentWallet;
  }

  /** Build a signed POST body, attaching agent_wallet when an agent is the active signer. */
  private async signedBody(
    operationType: string,
    payload: object,
    account: string,
    signMessage: SignMessageFn,
  ): Promise<Record<string, unknown>> {
    // Throttle BEFORE signing: a wait after signing would eat into the body's expiry_window.
    // A fail-fast RATE_LIMITED here sent nothing (details.sent === false).
    await this.signedRate.awaitCapacity(operationType, READ_OPERATIONS.has(operationType)
      ? PACIFICA_READ_NEED
      : writeNeed(CANCEL_OPERATIONS.has(operationType), PACIFICA_MAX_THROTTLE_WAIT_MS));
    try {
      return await (this.requestAgentWallet
        ? buildAgentSignedRequest(operationType, payload, account, this.requestAgentWallet, signMessage)
        : buildSignedRequest(operationType, payload, account, signMessage));
    } catch (e) {
      // Signing failed before any request was sent: definitely not placed (never ORDER_PENDING).
      throw orderNotSent("pacifica", operationType, e);
    }
  }

  constructor(config: PacificaClientConfig = {}) {
    this.baseUrl =
      config.baseUrl || getNetworkConfig(config.network).restUrl;
    this.apiKey = config.apiKey;
    this.rate = pacificaRateLimiter(this.baseUrl, this.apiKey, "unsigned");
    this.signedRate = pacificaRateLimiter(this.baseUrl, this.apiKey, "signed");
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["PF-API-KEY"] = this.apiKey;
    return h;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    checkAddressParams(params);
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      });
    }
    const ticket = await this.rate.acquire(`GET ${path}`, PACIFICA_READ_NEED);
    let res: Response;
    try {
      res = await fetch(url.toString(), { headers: this.headers() });
    } finally {
      ticket.release();
    }
    this.rate.observe(res);
    if (!res.ok) {
      const text = await res.text();
      // Structural (by status): RATE_LIMITED with retryAfterMs; never retried here.
      if (res.status === 429) throw this.rate.rateLimitedError(`GET ${path}`, res, text);
      throw new Error(`GET ${path} failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    // Unwrap Pacifica API response envelope: {success, data, error, code}
    if (json && typeof json === "object" && "data" in json && "success" in json) {
      return json.data as T;
    }
    return json as T;
  }

  /**
   * Signed POST. Every path except the listing reads (READ_POST_PATHS) is an account write: once
   * the request is on the wire a connection reset / timeout / 5xx / unreadable body leaves the
   * outcome unknown → ORDER_PENDING (sendFailure), never a retryable network error. No connection
   * at all → not sent. A 4xx is the venue's refusal and keeps the plain `POST <path> failed
   * (<status>): <body>` error the adapters map (422 business codes) — except on
   * DEFINITE_4XX_PATHS, where it is a definite ACTION_REJECTED. HTTP 429 → RATE_LIMITED
   * (details.sent === false, retryAfterMs) — never retried, a write is never resubmitted.
   * "429 = not executed" is our reading of the docs ("When credits are exhausted, requests return
   * HTTP 429"), not an explicit Pacifica statement. Before sending, the credit throttle may wait up
   * to PACIFICA_SIGNED_MAX_WAIT_MS (the body is already signed) or fail fast with RATE_LIMITED
   * (nothing sent). A write needs only its own cost, never the read reserve. A fetch timeout (PACIFICA_POST_TIMEOUT_MS) on a write is ORDER_PENDING too;
 * on a listing read a timeout is TIMEOUT and any other transport failure EXCHANGE_UNREACHABLE.
   */
  private async post<T>(path: string, body: Record<string, unknown>, needOverride?: RateNeed): Promise<T> {
    const write = !READ_POST_PATHS.has(path);
    const what = `POST ${path}`;
    const remediation = `Do NOT resubmit — the request may have been executed. Check open orders, positions and balances first: perp -e pacifica account orders / portfolio`;
    const ticket: RateTicket = await this.signedRate.acquire(what, needOverride !== undefined ? needOverride : write
      ? writeNeed(CANCEL_POST_PATHS.has(path), PACIFICA_SIGNED_MAX_WAIT_MS)
      : { ...PACIFICA_READ_NEED, maxWaitMs: PACIFICA_SIGNED_MAX_WAIT_MS });
    try {
      let res: Response;
      let text: string;
      try {
        res = await fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(PACIFICA_POST_TIMEOUT_MS),
        });
        ticket.settle(res);
        text = await res.text();
      } catch (e) {
        if (write) throw sendFailure("pacifica", what, e, remediation);
        // Signed listing read: nothing can have been executed — an ordinary retryable read failure.
        const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        throw new PerpError(timedOut ? "TIMEOUT" : "EXCHANGE_UNREACHABLE",
          `Pacifica ${what} ${timedOut ? `timed out after ${PACIFICA_POST_TIMEOUT_MS} ms` : `failed: ${extractErrorMessage(e)}`} (read-only listing; nothing was changed)`, {
            exchange: "pacifica",
            remediation: "Retry; if it keeps failing check the network and Pacifica's status",
          });
      }
      if (write && res.status >= 500) {
        throw orderOutcomeUnknown("pacifica", what, new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), remediation);
      }
      // Refused before processing (credits exhausted): nothing executed, never resubmitted here.
      if (res.status === 429) throw this.signedRate.rateLimitedError(what, res, text);
      if (!res.ok) {
        if (DEFINITE_4XX_PATHS.has(path) && res.status >= 400 && res.status < 500) {
          throw new PerpError("ACTION_REJECTED", `Pacifica ${what} refused (HTTP ${res.status}, nothing was changed): ${text.slice(0, 300)}`, {
            exchange: "pacifica",
            httpStatus: res.status,
            remediation: "The venue rejected the request — fix the parameters named in the message and retry",
          });
        }
        throw new Error(`POST ${path} failed (${res.status}): ${text}`);
      }
      try {
        return JSON.parse(text) as T;
      } catch (e) {
        if (!write) throw e;
        throw orderOutcomeUnknown("pacifica", what, new Error(`unreadable response (HTTP ${res.status}): ${text.slice(0, 200)}`), remediation);
      }
    } finally {
      ticket.release(); // no-op once settled; a transport failure frees the reservation
      // Every POST is an account write (order / cancel / TP/SL / leverage / transfer): drop the
      // shared acct: disk cache so no later read serves the pre-write positions / orders.
      invalidateCache("acct");
    }
  }

  /**
   * `builder_code` is attached only when the caller passes one — the adapter decides
   * (settings builder.pacifica + confirmed approval, src/exchanges/builder-fee.ts).
   * null = no builder code (the default, and always for spot: err 108).
   */
  private withBuilderCode(payload: Record<string, unknown>, builderCode: string | null): Record<string, unknown> {
    return builderCode === null ? payload : { ...payload, builder_code: builderCode };
  }

  // ==================== PUBLIC ENDPOINTS ====================

  async getInfo(): Promise<MarketInfo[]> {
    return this.get("/info");
  }

  async getPrices(): Promise<PriceInfo[]> {
    return this.get("/info/prices");
  }

  async getBook(symbol: string, aggLevel?: AggLevel): Promise<Orderbook> {
    const params: Record<string, string> = { symbol };
    if (aggLevel) params.agg_level = String(aggLevel);
    return this.get("/book", params);
  }

  async getTrades(symbol: string): Promise<Trade[]> {
    return this.get("/trades", { symbol });
  }

  async getKline(
    symbol: string,
    interval: KlineInterval,
    startTime: number,
    endTime?: number
  ): Promise<Kline[]> {
    const params: Record<string, string> = {
      symbol,
      interval,
      start_time: String(startTime),
    };
    if (endTime) params.end_time = String(endTime);
    return this.get("/kline", params);
  }

  async getFundingHistory(symbol: string, opts?: { limit?: number; cursor?: string }): Promise<unknown> {
    const params: Record<string, string> = { symbol };
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.cursor) params.cursor = opts.cursor;
    return this.get("/funding_rate/history", params);
  }

  // ==================== AUTHENTICATED GET ENDPOINTS ====================

  async getAccount(account: string): Promise<AccountInfo> {
    return this.get("/account", { account });
  }

  async getAccountSettings(account: string): Promise<AccountSettings> {
    return this.get("/account/settings", { account });
  }

  async getPositions(account: string): Promise<Position[]> {
    return this.get("/positions", { account });
  }

  async getOrders(account: string): Promise<OrderInfo[]> {
    return this.get("/orders", { account });
  }

  async getOrderHistory(
    account: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<unknown> {
    const params: Record<string, string> = { account };
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.cursor) params.cursor = opts.cursor;
    return this.get("/orders/history", params);
  }

  async getTradeHistory(
    account: string,
    opts?: { symbol?: string; start_time?: number; end_time?: number; limit?: number; cursor?: number }
  ): Promise<unknown> {
    const params: Record<string, string> = { account };
    if (opts?.symbol) params.symbol = opts.symbol;
    if (opts?.start_time) params.start_time = String(opts.start_time);
    if (opts?.end_time) params.end_time = String(opts.end_time);
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.cursor) params.cursor = String(opts.cursor);
    return this.get("/trades/history", params);
  }

  async getFundingAccountHistory(
    account: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<unknown> {
    const params: Record<string, string> = { account };
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.cursor) params.cursor = opts.cursor;
    return this.get("/funding/history", params);
  }

  async getPortfolio(
    account: string,
    opts?: { time_range?: string; start_time?: number; end_time?: number; limit?: number }
  ): Promise<unknown> {
    const params: Record<string, string> = { account };
    if (opts?.time_range) params.time_range = opts.time_range;
    if (opts?.start_time) params.start_time = String(opts.start_time);
    if (opts?.end_time) params.end_time = String(opts.end_time);
    if (opts?.limit) params.limit = String(opts.limit);
    return this.get("/portfolio", params);
  }

  async getBalanceHistory(
    account: string,
    opts?: { limit?: number; cursor?: string }
  ): Promise<unknown> {
    const params: Record<string, string> = { account };
    if (opts?.limit) params.limit = String(opts.limit);
    if (opts?.cursor) params.cursor = opts.cursor;
    return this.get("/account/balance/history", params);
  }

  async getOrderHistoryById(orderId: number): Promise<unknown> {
    return this.get("/orders/history_by_id", { order_id: String(orderId) });
  }

  async getTWAPOrders(account: string): Promise<unknown[]> {
    return this.get("/orders/twap", { account });
  }

  // ==================== AUTHENTICATED POST ENDPOINTS ====================

  async createMarketOrder(
    params: MarketOrderParams,
    account: string,
    signMessage: SignMessageFn,
    builderCode: string | null,
  ): Promise<unknown> {
    const payload = this.withBuilderCode({ ...params }, builderCode);
    const body = await this.signedBody("create_market_order", payload, account, signMessage);
    return this.post("/orders/create_market", body);
  }

  async createLimitOrder(
    params: LimitOrderParams,
    account: string,
    signMessage: SignMessageFn,
    builderCode: string | null,
  ): Promise<unknown> {
    const payload = this.withBuilderCode({ ...params }, builderCode);
    const body = await this.signedBody("create_order", payload, account, signMessage);
    return this.post("/orders/create", body);
  }

  async createStopOrder(
    params: StopOrderParams,
    account: string,
    signMessage: SignMessageFn,
    builderCode: string | null,
  ): Promise<unknown> {
    // builder_code applies to every order-creation endpoint, stop orders included (builder-program docs).
    const payload = this.withBuilderCode({ ...params }, builderCode);
    const body = await this.signedBody("create_stop_order", payload, account, signMessage);
    return this.post("/orders/stop/create", body);
  }

  async editOrder(
    params: EditOrderParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("edit_order", params, account, signMessage);
    return this.post("/orders/edit", body);
  }

  async cancelOrder(
    params: CancelOrderParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("cancel_order", params, account, signMessage);
    return this.post("/orders/cancel", body);
  }

  async cancelAllOrders(
    params: CancelAllOrdersParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("cancel_all_orders", params, account, signMessage);
    return this.post("/orders/cancel_all", body);
  }

  async cancelStopOrder(
    params: { symbol: string; order_id: number },
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("cancel_stop_order", params, account, signMessage);
    return this.post("/orders/stop/cancel", body);
  }

  /** create_twap_order documents no builder_code, so a TWAP never carries one (builder-fee.ts). */
  async createTWAP(
    params: TWAPParams,
    account: string,
    signMessage: SignMessageFn,
  ): Promise<unknown> {
    const body = await this.signedBody("create_twap_order", { ...params }, account, signMessage);
    return this.post("/orders/twap/create", body);
  }

  async cancelTWAP(
    params: CancelTWAPParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("cancel_twap_order", params, account, signMessage);
    return this.post("/orders/twap/cancel", body);
  }

  async setTPSL(
    params: TPSLParams,
    account: string,
    signMessage: SignMessageFn,
    builderCode: string | null,
  ): Promise<unknown> {
    // Position TP/SL creates orders and therefore takes builder_code too (POST /positions/tpsl).
    const payload = this.withBuilderCode({ ...params }, builderCode);
    const body = await this.signedBody("set_position_tpsl", payload, account, signMessage);
    return this.post("/positions/tpsl", body);
  }

  async updateLeverage(
    params: UpdateLeverageParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("update_leverage", params, account, signMessage);
    return this.post("/account/leverage", body);
  }

  async updateMarginMode(
    params: { symbol: string; is_isolated: boolean },
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("update_margin_mode", params, account, signMessage);
    return this.post("/account/margin", body);
  }

  async withdraw(
    params: WithdrawParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("withdraw", params, account, signMessage);
    return this.post("/account/withdraw", body);
  }

  // ==================== SUBACCOUNT ====================

  // POST /account/subaccount/create is not implemented. Docs (rest-api/subaccounts/create-subaccount):
  // "Both the main account and subaccount must sign to establish the relationship." — the body is
  // {main_account, subaccount, main_signature, sub_signature, timestamp, expiry_window}; the
  // subaccount keypair signs {account: <main>} ("subaccount_initiate") and the main account signs
  // {signature: <sub_signature>} ("subaccount_confirm") (python-sdk rest/create_subaccount.py).
  // perp-cli has no second (subaccount) keypair source, so `manage sub create` is gated.

  async listSubaccounts(
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("list_subaccounts", {}, account, signMessage);
    return this.post("/account/subaccount/list", body);
  }

  async transferFunds(
    params: TransferFundsParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("transfer_funds", params, account, signMessage);
    return this.post("/account/subaccount/transfer", body);
  }

  // ==================== AGENT WALLET ====================

  async bindAgentWallet(
    agentWallet: string,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody(
      "bind_agent_wallet",
      { agent_wallet: agentWallet },
      account,
      signMessage
    );
    return this.post("/agent/bind", body);
  }

  async listAgentWallets(
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("list_agent_wallets", {}, account, signMessage);
    return this.post("/agent/list", body);
  }

  async revokeAgentWallet(
    agentWallet: string,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody(
      "revoke_agent_wallet",
      { agent_wallet: agentWallet },
      account,
      signMessage
    );
    return this.post("/agent/revoke", body);
  }

  async revokeAllAgentWallets(
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("revoke_all_agent_wallets", {}, account, signMessage);
    return this.post("/agent/revoke_all", body);
  }

  // ==================== API KEYS ====================

  /**
   * API Config Key (rate-limit key). Docs (api/rate-limits/api-config-keys): the request body is
   * account / signature / timestamp / expiry_window only; python-sdk rest/api_config_keys.py signs
   * type "create_api_key" with `signature_payload = {}`.
   */
  async createApiKey(
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("create_api_key", {}, account, signMessage);
    return this.post("/account/api_keys/create", body);
  }

  async listApiKeys(
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("list_api_keys", {}, account, signMessage);
    return this.post("/account/api_keys", body);
  }

  async revokeApiKey(
    apiKey: string,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody(
      "revoke_api_key",
      { api_key: apiKey },
      account,
      signMessage
    );
    return this.post("/account/api_keys/revoke", body);
  }

  // ==================== LAKE ====================

  async createLake(
    params: CreateLakeParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    // Optional fields are omitted, not sent as null (the signed payload must equal the body).
    const payload: Record<string, string> = {};
    if (params.manager !== null) payload.manager = params.manager;
    if (params.nickname !== null) payload.nickname = params.nickname;
    if (params.initial_deposit !== null) payload.initial_deposit = params.initial_deposit;
    const body = await this.signedBody("create_lake", payload, account, signMessage);
    return this.post("/lake/create", body);
  }

  async depositToLake(
    params: LakeDepositParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("deposit_to_lake", params, account, signMessage);
    return this.post("/lake/deposit", body);
  }

  async withdrawFromLake(
    params: LakeWithdrawParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("withdraw_from_lake", params, account, signMessage);
    return this.post("/lake/withdraw", body);
  }

  // ==================== PRINT (game) + VAULT READS / PRE-SIGNED WRITES ====================
  // Shapes and parsing live in src/exchanges/pacifica-print.ts / pacifica-vaults.ts.

  /**
   * Unauthenticated GET that keeps the whole {success, data, has_more, next_cursor} envelope.
   * Same credit limiter as get() (unsigned IP quota, PACIFICA_READ_NEED: may wait for the window,
   * else RATE_LIMITED sent:false); the response headers are recorded; HTTP 429 → RATE_LIMITED
   * (structural, never retried). Timeout → TIMEOUT, transport failure → EXCHANGE_UNREACHABLE,
   * non-JSON / non-object body → EXCHANGE_ERROR (a read: nothing can have changed).
   */
  async getEnvelope(path: string, params: Record<string, string> = {}): Promise<Record<string, unknown>> {
    checkAddressParams(params);
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const what = `GET ${path}`;
    const ticket = await this.rate.acquire(what, PACIFICA_READ_NEED);
    let res: Response;
    let text: string;
    try {
      res = await fetch(url.toString(), { headers: this.headers(), signal: AbortSignal.timeout(PACIFICA_POST_TIMEOUT_MS) });
      ticket.settle(res);
      text = await res.text();
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new PerpError(timedOut ? "TIMEOUT" : "EXCHANGE_UNREACHABLE", `Pacifica GET ${path} ${timedOut ? `timed out after ${PACIFICA_POST_TIMEOUT_MS} ms` : `failed: ${extractErrorMessage(e)}`}`, {
        exchange: "pacifica", remediation: "Retry; if it keeps failing check the network and Pacifica's status",
      });
    } finally {
      ticket.release(); // no-op once settled; a transport failure frees the reservation
    }
    if (res.status === 429) throw this.rate.rateLimitedError(what, res, text);
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${text}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica GET ${path} returned a non-JSON body (HTTP ${res.status}): ${text.slice(0, 160)}`, { exchange: "pacifica" });
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      throw new PerpError("EXCHANGE_ERROR", `Pacifica GET ${path} returned a non-object body: ${text.slice(0, 160)}`, { exchange: "pacifica" });
    }
    return json as Record<string, unknown>;
  }

  /**
   * POST a body the caller already built and signed (Print / vault writes sign their own canonical
   * message so `--dry-run` can show the exact body). Same unknown-outcome rules as every write.
   */
  async postPresigned(path: "/game/deposit" | "/game/end" | "/lake/deposit" | "/lake/withdraw", body: Record<string, unknown>): Promise<unknown> {
    return this.post(path, body);
  }

  /**
   * Pre-sign credit wait for a pre-signed write (same rule as signedBody / amend): call BEFORE
   * building + signing, so the post-sign wait in post() (≤ PACIFICA_SIGNED_MAX_WAIT_MS, inside the
   * 5 s expiry_window) finds credits. Cost: the docs' rate-limits table lists no Print / vault
   * entry — "Standard request/action: 1 credit" applies (end_game is not an order cancellation).
   * Fail-fast RATE_LIMITED here sent and signed nothing (details.sent === false).
   */
  async awaitPresignedCapacity(operationType: string): Promise<void> {
    await this.signedRate.awaitCapacity(operationType, writeNeed(false, PACIFICA_MAX_THROTTLE_WAIT_MS));
  }

  // ==================== BUILDER CODE ====================

  async approveBuilderCode(
    params: { builder_code: string; max_fee_rate: string },
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("approve_builder_code", params, account, signMessage);
    return this.post("/account/builder_codes/approve", body);
  }

  async revokeBuilderCode(
    params: { builder_code: string },
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("revoke_builder_code", params, account, signMessage);
    return this.post("/account/builder_codes/revoke", body);
  }

  async getBuilderApprovals(account: string): Promise<unknown> {
    return this.get("/account/builder_codes/approvals", { account });
  }

  async updateBuilderFeeRate(
    params: { builder_code: string; fee_rate: string },
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("update_builder_code_fee_rate", params, account, signMessage);
    return this.post("/builder/update_fee_rate", body);
  }

  async getBuilderOverview(account: string): Promise<unknown> {
    return this.get("/builder/overview", { account });
  }

  async getBuilderTrades(builderCode: string): Promise<unknown> {
    return this.get("/builder/trades", { builder_code: builderCode });
  }

  async getBuilderLeaderboard(builderCode: string): Promise<unknown> {
    return this.get("/leaderboard/builder_code", { builder_code: builderCode });
  }

  // ==================== REFERRAL ====================

  async claimReferralCode(
    params: { code: string },
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await this.signedBody("claim_referral_code", params, account, signMessage);
    return this.post("/referral/user/code/claim", body);
  }

  // ==================== BATCH ====================

  /**
   * POST /orders/batch with the per-action cost (pacificaBatchCost) reserved. `maxWaitMs` caps the
   * post-sign throttle wait (default PACIFICA_SIGNED_MAX_WAIT_MS, never more): a caller with a
   * tighter signature deadline passes what is left of it, so a wait can never send an expired batch
   * — a longer wait fails fast with RATE_LIMITED (sent: false, nothing sent).
   */
  async batchOrders(actions: BatchAction[], opts: { maxWaitMs?: number } = {}): Promise<unknown> {
    const maxWaitMs = Math.max(0, Math.min(opts.maxWaitMs !== undefined ? opts.maxWaitMs : PACIFICA_SIGNED_MAX_WAIT_MS, PACIFICA_SIGNED_MAX_WAIT_MS));
    return this.post("/orders/batch", { actions }, { cost: pacificaBatchCost(actions.map(a => a.type)), reserve: 0, maxWaitMs });
  }

  /**
   * Pre-sign throttle for a batch (like signedBody does for single writes): wait — up to
   * PACIFICA_MAX_THROTTLE_WAIT_MS, else RATE_LIMITED with nothing signed or sent — until the
   * batch's whole cost fits, so the post-sign acquire in batchOrders normally finds the credits.
   */
  async awaitBatchCapacity(types: readonly BatchActionType[]): Promise<void> {
    await this.signedRate.awaitCapacity("POST /orders/batch", { cost: pacificaBatchCost(types), reserve: 0, maxWaitMs: PACIFICA_MAX_THROTTLE_WAIT_MS });
  }

  /**
   * One signed batch action body (docs rest-api/orders/batch-order: "Batch orders are not signed
   * as a whole, but rather by its individual actions components"; each action's `data` carries the
   * fields of its standalone endpoint, signed with that endpoint's operation type). Nothing is sent.
   * `header` fixes the signed timestamp / expiry window, so every action of one batch can share
   * one timestamp. agent_wallet is attached when an agent is the active signer. A signing failure
   * → ORDER_REJECTED (orderNotSent).
   */
  async signBatchAction(
    operationType: string,
    payload: Record<string, unknown>,
    account: string,
    signMessage: SignMessageFn,
    header: { timestamp: number; expiry_window: number },
  ): Promise<Record<string, unknown>> {
    const full = { type: operationType, timestamp: header.timestamp, expiry_window: header.expiry_window };
    try {
      const [, signature] = await signWithWallet(full, payload, signMessage);
      return {
        account,
        ...(this.requestAgentWallet ? { agent_wallet: this.requestAgentWallet } : {}),
        signature,
        timestamp: full.timestamp,
        expiry_window: full.expiry_window,
        ...payload,
      };
    } catch (e) {
      throw orderNotSent("pacifica", operationType, e);
    }
  }
}
