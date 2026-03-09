import { MAINNET_REST, BUILDER_CODE, type Network, getNetworkConfig } from "./constants";
import { buildSignedRequest, buildAgentSignedRequest } from "./signing";
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
  CreateLakeParams,
  LakeDepositParams,
  LakeWithdrawParams,
} from "./types";

type SignMessageFn = (message: Uint8Array) => Promise<Uint8Array>;

export interface PacificaClientConfig {
  network?: Network;
  baseUrl?: string;
  apiKey?: string;
  builderCode?: string;
}

export class PacificaClient {
  private baseUrl: string;
  private apiKey?: string;
  private builderCode: string;

  constructor(config: PacificaClientConfig = {}) {
    this.baseUrl =
      config.baseUrl || getNetworkConfig(config.network).restUrl;
    this.apiKey = config.apiKey;
    this.builderCode = config.builderCode || BUILDER_CODE;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) h["PF-API-KEY"] = this.apiKey;
    return h;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (params) {
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null) url.searchParams.set(k, v);
      });
    }
    const res = await fetch(url.toString(), { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET ${path} failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    // Unwrap Pacifica API response envelope: {success, data, error, code}
    if (json && typeof json === "object" && "data" in json && "success" in json) {
      return json.data as T;
    }
    return json as T;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`POST ${path} failed (${res.status}): ${text}`);
    }
    return res.json();
  }

  private addBuilderCode(payload: Record<string, unknown>): Record<string, unknown> {
    if (this.builderCode) {
      return { ...payload, builder_code: this.builderCode };
    }
    return payload;
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

  async getAccountSettings(account: string): Promise<AccountSettings[]> {
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
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const payload = this.addBuilderCode({ ...params });
    const body = await buildSignedRequest("create_market_order", payload, account, signMessage);
    return this.post("/orders/create_market", body);
  }

  async createLimitOrder(
    params: LimitOrderParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const payload = this.addBuilderCode({ ...params });
    const body = await buildSignedRequest("create_order", payload, account, signMessage);
    return this.post("/orders/create", body);
  }

  async createStopOrder(
    params: StopOrderParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("create_stop_order", params, account, signMessage);
    return this.post("/orders/stop/create", body);
  }

  async editOrder(
    params: EditOrderParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("edit_order", params, account, signMessage);
    return this.post("/orders/edit", body);
  }

  async cancelOrder(
    params: CancelOrderParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("cancel_order", params, account, signMessage);
    return this.post("/orders/cancel", body);
  }

  async cancelAllOrders(
    params: CancelAllOrdersParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("cancel_all_orders", params, account, signMessage);
    return this.post("/orders/cancel_all", body);
  }

  async cancelStopOrder(
    params: { symbol: string; order_id: number },
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("cancel_stop_order", params, account, signMessage);
    return this.post("/orders/stop/cancel", body);
  }

  async createTWAP(
    params: TWAPParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const payload = this.addBuilderCode({ ...params });
    const body = await buildSignedRequest("create_twap_order", payload, account, signMessage);
    return this.post("/orders/twap/create", body);
  }

  async cancelTWAP(
    params: CancelTWAPParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("cancel_twap_order", params, account, signMessage);
    return this.post("/orders/twap/cancel", body);
  }

  async setTPSL(
    params: TPSLParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("set_position_tpsl", params, account, signMessage);
    return this.post("/positions/tpsl", body);
  }

  async updateLeverage(
    params: UpdateLeverageParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("update_leverage", params, account, signMessage);
    return this.post("/account/leverage", body);
  }

  async updateMarginMode(
    params: { symbol: string; is_isolated: boolean },
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("update_margin_mode", params, account, signMessage);
    return this.post("/account/margin", body);
  }

  async withdraw(
    params: WithdrawParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("withdraw", params, account, signMessage);
    return this.post("/account/withdraw", body);
  }

  // ==================== SUBACCOUNT ====================

  async createSubaccount(
    subaccountName: string,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    // Step 1: Initiate
    const initiateBody = await buildSignedRequest(
      "subaccount_initiate",
      { subaccount_name: subaccountName },
      account,
      signMessage
    );
    await this.post("/account/subaccount/create", initiateBody);

    // Step 2: Confirm
    const confirmBody = await buildSignedRequest(
      "subaccount_confirm",
      { subaccount_name: subaccountName },
      account,
      signMessage
    );
    return this.post("/account/subaccount/create", confirmBody);
  }

  async listSubaccounts(
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("list_subaccounts", {}, account, signMessage);
    return this.post("/account/subaccount/list", body);
  }

  async transferFunds(
    params: TransferFundsParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("transfer_funds", params, account, signMessage);
    return this.post("/account/subaccount/transfer", body);
  }

  // ==================== AGENT WALLET ====================

  async bindAgentWallet(
    agentWallet: string,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest(
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
    const body = await buildSignedRequest("list_agent_wallets", {}, account, signMessage);
    return this.post("/agent/list", body);
  }

  async revokeAgentWallet(
    agentWallet: string,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest(
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
    const body = await buildSignedRequest("revoke_all_agent_wallets", {}, account, signMessage);
    return this.post("/agent/revoke_all", body);
  }

  // ==================== API KEYS ====================

  async createApiKey(
    name: string,
    maxFeeRate: string,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest(
      "create_api_key",
      { name, max_fee_rate: maxFeeRate },
      account,
      signMessage
    );
    return this.post("/account/api_keys/create", body);
  }

  async listApiKeys(
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("list_api_keys", {}, account, signMessage);
    return this.post("/account/api_keys", body);
  }

  async revokeApiKey(
    apiKey: string,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest(
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
    const body = await buildSignedRequest("create_lake", params, account, signMessage);
    return this.post("/lake/create", body);
  }

  async depositToLake(
    params: LakeDepositParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("deposit_to_lake", params, account, signMessage);
    return this.post("/lake/deposit", body);
  }

  async withdrawFromLake(
    params: LakeWithdrawParams,
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("withdraw_from_lake", params, account, signMessage);
    return this.post("/lake/withdraw", body);
  }

  // ==================== BUILDER CODE ====================

  async approveBuilderCode(
    params: { builder_code: string; max_fee_rate: string },
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("approve_builder_code", params, account, signMessage);
    return this.post("/account/builder_codes/approve", body);
  }

  async revokeBuilderCode(
    params: { builder_code: string },
    account: string,
    signMessage: SignMessageFn
  ): Promise<unknown> {
    const body = await buildSignedRequest("revoke_builder_code", params, account, signMessage);
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
    const body = await buildSignedRequest("update_builder_code_fee_rate", params, account, signMessage);
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
    const body = await buildSignedRequest("claim_referral_code", params, account, signMessage);
    return this.post("/referral/user/code/claim", body);
  }

  // ==================== BATCH ====================

  async batchOrders(actions: BatchAction[]): Promise<unknown> {
    return this.post("/orders/batch", { actions });
  }
}
