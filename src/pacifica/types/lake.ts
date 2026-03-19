export interface CreateLakeParams {
  symbol: string;
  amount: string;
}

export interface LakeDepositParams {
  lake_id: string;
  amount: string;
}

export interface LakeWithdrawParams {
  lake_id: string;
  amount: string;
}
