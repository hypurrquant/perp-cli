declare module "@pacifica/sdk" {
  import { TransactionInstruction, PublicKey } from "@solana/web3.js";

  export function buildDepositInstruction(
    userPubkey: PublicKey,
    amount: number,
    network: string,
  ): Promise<TransactionInstruction>;
}
