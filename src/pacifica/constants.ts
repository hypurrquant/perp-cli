// Pacifica Protocol Constants

// REST API URLs
export const MAINNET_REST = "https://api.pacifica.fi/api/v1";
export const TESTNET_REST = "https://test-api.pacifica.fi/api/v1";

// WebSocket URLs
export const MAINNET_WS = "wss://ws.pacifica.fi/ws";
export const TESTNET_WS = "wss://test-ws.pacifica.fi/ws";

// Mainnet Program IDs
export const MAINNET_PROGRAM_ID = "PCFA5iYgmqK6MqPhWNKg7Yv7auX7VZ4Cx7T1eJyrAMH";
export const MAINNET_CENTRAL_STATE = "9Gdmhq4Gv1LnNMp7aiS1HSVd7pNnXNMsbuXALCQRmGjY";
export const MAINNET_PACIFICA_VAULT = "72R843XwZxqWhsJceARQQTTbYtWy6Zw9et2YV4FpRHTa";
export const MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Testnet (Devnet) Program IDs
export const TESTNET_PROGRAM_ID = "peRPsYCcB1J9jvrs29jiGdjkytxs8uHLmSPLKKP9ptm";
export const TESTNET_CENTRAL_STATE = "2zPRq1Qvdq5A4Ld6WsH7usgCge4ApZRYfhhf5VAjfXxv";
export const TESTNET_PACIFICA_VAULT = "5SDFdHZGTZbyRYu54CgmRkCGnPHC5pYaN27p7XGLqnBs";
export const TESTNET_USDC_MINT = "USDPqRbLidFGufty2s3oizmDEKdqx7ePTqzDMbf5ZKM";

// Signing defaults
export const DEFAULT_EXPIRY_WINDOW = 5000; // 5 seconds

// USDC decimals
export const USDC_DECIMALS = 6;

// Builder code — 0% fee, used for Pacifica hackathon tracking
// The actual 3-way fallback (env → settings.referralCodes.pacifica → "PERPCLI") is
// resolved in index.ts before constructing PacificaAdapter. This constant is only
// a last-resort default for direct PacificaClient usage without a builderCode arg.
export const BUILDER_CODE = "PERPCLI";

// Network config helper
export type Network = "mainnet" | "testnet";

export function getNetworkConfig(network: Network = "mainnet") {
  if (network === "testnet") {
    return {
      restUrl: TESTNET_REST,
      wsUrl: TESTNET_WS,
      programId: TESTNET_PROGRAM_ID,
      centralState: TESTNET_CENTRAL_STATE,
      pacificaVault: TESTNET_PACIFICA_VAULT,
      usdcMint: TESTNET_USDC_MINT,
    };
  }
  return {
    restUrl: MAINNET_REST,
    wsUrl: MAINNET_WS,
    programId: MAINNET_PROGRAM_ID,
    centralState: MAINNET_CENTRAL_STATE,
    pacificaVault: MAINNET_PACIFICA_VAULT,
    usdcMint: MAINNET_USDC_MINT,
  };
}
