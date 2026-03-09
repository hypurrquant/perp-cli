// Core
export { PacificaClient, type PacificaClientConfig } from "./client";
export { PacificaWSClient, type PacificaWSConfig } from "./ws-client";

// Signing
export {
  sortJsonKeys,
  prepareMessage,
  createHeader,
  signWithWallet,
  buildSignedRequest,
  buildAgentSignedRequest,
} from "./signing";

// Deposit
export { buildDepositInstruction, deposit } from "./deposit";

// Constants
export * from "./constants";

// Types
export * from "./types";
