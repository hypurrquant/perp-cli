export interface AccountInfo {
  balance: string;
  fee_level: number;
  maker_fee: string;
  taker_fee: string;
  account_equity: string;
  available_to_spend: string;
  available_to_withdraw: string;
  pending_balance: string;
  pending_interest: string;
  total_margin_used: string;
  cross_mmr: string;
  positions_count: number;
  orders_count: number;
  stop_orders_count: number;
}

export interface AccountSettings {
  symbol: string;
  margin_mode: "cross" | "isolated";
  leverage: number;
}

export interface SubaccountInfo {
  subaccount_name: string;
  subaccount_address: string;
}

export interface TransferFundsParams {
  from_account: string;
  to_account: string;
  amount: string;
}

export interface WithdrawParams {
  amount: string;
  dest_address: string;
}

export interface UpdateLeverageParams {
  symbol: string;
  leverage: number;
}

export interface UpdateMarginModeParams {
  symbol: string;
  is_isolated: boolean;
}
