/**
 * E2E venue profiles — only what the venue definitions (src/exchanges/venues/*.ts)
 * do NOT already declare: test symbols, funding routes, faucets, access gates and
 * the design verification items each step
 * settles. Capabilities (TIF set, tpsl method, amend, orderAck, spot
 * model) are read from the built venue definition at runtime, never copied here.
 */

export type Net = "mainnet" | "testnet";

/** E2E venue ids. `hyperliquid` also runs its HIP-3 dex (`--dex <name>`) as a second leg of the same run. */
export const E2E_VENUES = [
  "hyperliquid", "pacifica", "lighter", "lighter-rh", "aster", "ondo", "arcus", "qfex",
] as const;
export type E2eVenue = (typeof E2E_VENUES)[number];

/**
 * Wallet a CLI deposit is sent from: the runner's mainnet preflight reads its deposit-asset and
 * gas balances over a read-only RPC. `rpcUrl` / `token` null = taken from the built venue
 * definition (networks.<net>.rpcUrl / depositPins.token).
 */
export interface DepositWallet {
  kind: "evm" | "solana";
  chain: string;
  rpcUrl: string | null;
  /** ERC-20 contract / SPL mint of the deposit asset. */
  token: string | null;
  decimals: number;
  asset: string;
  gasAsset: string;
  /** Gas balance the CLI deposit command itself requires (0 = it has no such check). */
  minGas: number;
  source: string;
}

export type FundingRoute =
  | {
    kind: "cli"; args: (amount: string) => string[]; min: number | null; note: string;
    /** Where `min` comes from (venue docs, the CLI's own check, or a runner-conservative value). */
    minSource: string;
    /** true = the venue does NOT credit a deposit below `min` (funds lost) — the runner refuses it. */
    belowMinLost: boolean;
    /** Known venue fee for this move; null = none documented. */
    fee: { amount: number; asset: string; source: string } | null;
    /** Live minimum read at preflight and enforced on top of `min`; null = none published. */
    liveMin: "lighterAssetDetails" | null;
    /** Deposit routes: the wallet the deposit is sent from. null on withdraw routes. */
    wallet: DepositWallet | null;
  }
  | { kind: "manual"; instructions: string[] }
  | { kind: "ondoSandbox"; note: string }
  | { kind: "none"; reason: string };

export interface VenueProfile {
  id: E2eVenue;
  /** `-e` value passed to the CLI. */
  cliVenue: string;
  /** HIP-3 leg run after the core dex in the same run (`--dex <name>` on the CLI), null otherwise. */
  hip3: { dex: string; symbols: Record<Net, string[]>; prerequisites: Record<Net, string[]> } | null;
  /** Candidate perp symbols; the runner picks the one with the smallest venue minimum. */
  symbols: Record<Net, string[]>;
  /**
   * Minimum order notional when the venue's public market data does not publish one.
   * `source` says where the number comes from; "assumed" values are reported as such.
   */
  minNotionalFallback: { usd: number; source: string } | null;
  /** Environment the CLI needs for this network (e.g. a testnet host override). */
  testnetEnv: { name: string; suggested: string; why: string } | null;
  /** Testnet funds and access gates — printed by preflight. */
  prerequisites: Record<Net, string[]>;
  deposit: Record<Net, FundingRoute>;
  withdraw: Record<Net, FundingRoute>;
  /** Suggested spot symbol (operator still passes --spot-symbol / --spot-size). */
  spotSymbol: Record<Net, string | null>;
}

/** Arbitrum One USDC + public RPC — the same constants `funds deposit hyperliquid` / `lighter cctp arbitrum` use (src/commands/funds.ts). */
const ARBITRUM_USDC: DepositWallet = {
  kind: "evm", chain: "Arbitrum One", rpcUrl: "https://arb1.arbitrum.io/rpc", token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  decimals: 6, asset: "USDC", gasAsset: "ETH", minGas: 0.0001, source: "src/commands/funds.ts (USDC_ARB / CCTP_CHAINS.arbitrum; gas check 0.0001 ETH on the HL route, 0.00005 on CCTP)",
};
/** Lighter family: GET /api/v1/assetDetails min_withdrawal_amount (1.000000 on lighter and lighter-rh mainnet, 2026-10-05) is read live at preflight. */
const LIGHTER_LIVE_MIN = "GET /api/v1/assetDetails min_withdrawal_amount (read live at preflight; 1.000000 on 2026-10-05)";

const MANUAL_UI = (venue: string, extra: string[]): FundingRoute => ({ kind: "manual", instructions: [`${venue} web UI`, ...extra] });

export const PROFILES: Record<E2eVenue, VenueProfile> = {
  hyperliquid: {
    id: "hyperliquid", cliVenue: "hyperliquid",
    hip3: {
      dex: "xyz",
      symbols: { mainnet: ["XYZ100", "TSLA", "NVDA", "GOLD"], testnet: ["XYZ100", "TSLA", "NVDA"] },
      prerequisites: {
        testnet: ["HIP-3 leg (dex xyz): same HL testnet account/agent; HIP-3 margin is per-dex (transfer USDC to the dex if the dex is not unified)"],
        mainnet: ["HIP-3 leg (dex xyz): same HL account/agent; check dex collateral with: perp -e hyperliquid --dex xyz portfolio"],
      },
    },
    symbols: { mainnet: ["ETH", "SOL", "BTC"], testnet: ["ETH", "SOL", "BTC"] },
    minNotionalFallback: { usd: 10, source: "HL docs: minimum order value $10" },
    testnetEnv: null,
    prerequisites: {
      testnet: [
        "HL testnet faucet (app.hyperliquid-testnet.xyz/drip): 1,000 mock USDC; needs a mainnet deposit history on the same address",
        "perp wallet agent approve hyperliquid -n testnet (agent = API wallet)",
      ],
      mainnet: ["USDC on Arbitrum + a little ETH for gas (or relayer)", "perp wallet agent approve hyperliquid"],
    },
    deposit: {
      mainnet: { kind: "cli", args: a => ["funds", "deposit", "hyperliquid", a], min: 5, note: "Arbitrum USDC → Bridge2 (min 5 USDC)",
        minSource: "HL docs (Bridge2): minimum deposit 5 USDC — a smaller amount is not credited and is lost; the CLI refuses < 5 too", belowMinLost: true, fee: null, liveMin: null, wallet: ARBITRUM_USDC },
      testnet: { kind: "none", reason: "unsupported on testnet: no Bridge2 deposit to the HL testnet (funds = mock USDC from app.hyperliquid-testnet.xyz/drip)" },
    },
    withdraw: {
      mainnet: { kind: "cli", args: a => ["funds", "withdraw", "hyperliquid", a], min: 2, note: "to own Arbitrum address; $1 fee, ~5 min",
        minSource: "runner: must exceed the 1 USDC withdrawal fee", belowMinLost: false, fee: { amount: 1, asset: "USDC", source: "HL docs (Bridge2): withdrawal fee 1 USDC" }, liveMin: null, wallet: null },
      testnet: { kind: "cli", args: a => ["funds", "withdraw", "hyperliquid", a], min: 2, note: "testnet withdraw (Arbitrum Sepolia)",
        minSource: "runner: must exceed the 1 USDC withdrawal fee", belowMinLost: false, fee: { amount: 1, asset: "USDC", source: "HL docs (Bridge2): withdrawal fee 1 USDC" }, liveMin: null, wallet: null },
    },
    spotSymbol: { mainnet: "HYPE", testnet: "PURR" },
  },
  pacifica: {
    id: "pacifica", cliVenue: "pacifica", hip3: null,
    symbols: { mainnet: ["SOL", "ETH", "BTC"], testnet: ["SOL", "ETH", "BTC"] },
    minNotionalFallback: null,
    testnetEnv: null,
    prerequisites: {
      testnet: ["Pacifica testnet app (test-app.pacifica.fi) faucet → test USDC; access code may be required", "perp wallet agent approve pacifica -n testnet"],
      mainnet: ["USDC + ~0.01 SOL on Solana (or relayer)", "perp wallet agent approve pacifica"],
    },
    deposit: {
      // --no-relay: the runner never uses the relayer path (it signs a transaction built by the relayer host); direct deposit only.
      mainnet: { kind: "cli", args: a => ["funds", "deposit", "pacifica", a, "--no-relay"], min: 10, note: "Solana USDC, direct (--no-relay; min 10 USDC, needs ~0.005 SOL)",
        minSource: "CLI check `funds deposit pacifica` (src/commands/funds.ts: Minimum deposit is 10 USDC)", belowMinLost: false, fee: null, liveMin: null,
        wallet: { kind: "solana", chain: "Solana", rpcUrl: "https://api.mainnet-beta.solana.com", token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, asset: "USDC", gasAsset: "SOL", minGas: 0.005,
          source: "src/pacifica/constants.ts MAINNET_USDC_MINT; RPC and the 0.005 SOL gas check as in src/commands/funds.ts" } },
      testnet: { kind: "none", reason: "unsupported on testnet: `funds deposit pacifica` targets the mainnet program (funds = test-app.pacifica.fi faucet)" },
    },
    withdraw: {
      // Same conservative 10 as testnet (below): the documented 1 USDC was refused there and the real minimum is not published.
      mainnet: { kind: "cli", args: a => ["funds", "withdraw", "pacifica", a], min: 10, note: "to the account owner's Solana wallet (runner minimum 10 USDC — conservative; $1 fee)",
        minSource: "runner-conservative: docs say min 1 USDC + 1 USDC fee, but 1 USDC was refused on testnet (422 code 29 WITHDRAW_AMOUNT_TOO_LOW, 2026-10-02) and no endpoint publishes the minimum",
        belowMinLost: false, fee: { amount: 1, asset: "USDC", source: "Pacifica docs: withdrawal fee 1 USDC" }, liveMin: null, wallet: null },
      // Runner-only conservative default: docs list a 1 USDC minimum (+ $1 fee) but testnet refused
      // 1 USDC (422 code 29 WITHDRAW_AMOUNT_TOO_LOW, 2026-10-02) and no endpoint publishes the real
      // minimum (probing it would be a write). The CLI itself enforces only the documented 1.
      testnet: { kind: "cli", args: a => ["funds", "withdraw", "pacifica", a], min: 10, note: "testnet withdraw (runner default 10 USDC — conservative; venue minimum not published)",
        minSource: "runner-conservative: 1 USDC refused on testnet (422 code 29, 2026-10-02); venue minimum not published", belowMinLost: false,
        fee: { amount: 1, asset: "USDC", source: "Pacifica docs: withdrawal fee 1 USDC" }, liveMin: null, wallet: null },
    },
    spotSymbol: { mainnet: "SOL", testnet: "SOL" },
  },
  lighter: {
    id: "lighter", cliVenue: "lighter", hip3: null,
    symbols: { mainnet: ["ETH", "SOL", "BTC"], testnet: ["ETH", "BTC", "SOL"] },
    minNotionalFallback: null,
    testnetEnv: null,
    prerequisites: {
      testnet: ["Lighter testnet account (testnet.app.lighter.xyz) + test USDC from its faucet", "perp wallet agent approve lighter -n testnet (ChangePubKey, slot 4-254)"],
      mainnet: ["USDC on Arbitrum/Base/Avalanche (CCTP) or Ethereum L1", "perp wallet agent approve lighter"],
    },
    deposit: {
      mainnet: { kind: "cli", args: a => ["funds", "deposit", "lighter", "cctp", "arbitrum", a], min: 5, note: "CCTP from Arbitrum via intent address (min 5 USDC)",
        minSource: "CLI check `funds deposit lighter cctp` (src/commands/funds.ts: Minimum CCTP deposit is 5 USDC)", belowMinLost: false, fee: null, liveMin: null, wallet: ARBITRUM_USDC },
      testnet: { kind: "none", reason: "unsupported on testnet: no CLI deposit route to the Lighter testnet (funds = the testnet app faucet)" },
    },
    withdraw: {
      mainnet: { kind: "cli", args: a => ["funds", "withdraw", "lighter", a], min: 1, note: "standard withdraw to L1 (~12 h)",
        minSource: LIGHTER_LIVE_MIN, belowMinLost: false, fee: null, liveMin: "lighterAssetDetails", wallet: null },
      testnet: { kind: "cli", args: a => ["funds", "withdraw", "lighter", a], min: 1, note: "testnet standard withdraw",
        minSource: LIGHTER_LIVE_MIN, belowMinLost: false, fee: null, liveMin: "lighterAssetDetails", wallet: null },
    },
    spotSymbol: { mainnet: "ETH", testnet: "ETH" },
  },
  "lighter-rh": {
    id: "lighter-rh", cliVenue: "lighter-rh", hip3: null,
    symbols: { mainnet: ["ETH", "TSLA", "BTC"], testnet: ["TSLA", "ETH", "BTC"] },
    minNotionalFallback: null,
    testnetEnv: null,
    prerequisites: {
      testnet: [
        "Lighter RH testnet account + test USDC (testnet collateral asset 3 = USDC; no public faucet documented — request via Lighter RH team / app)",
        "perp wallet agent approve lighter-rh -n testnet --api-key-index <4-254, not 157> (slots 0,1,2,3,157 are reserved)",
        "Standard account REST limit 60 req/min — the runner paces calls",
      ],
      mainnet: [
        "USDG + ETH (gas) on Robinhood Chain for the master wallet → `perp funds deposit lighter-rh <amount>` (approve + deposit; min 1 USDG)",
        "perp wallet agent approve lighter-rh --api-key-index <4-254, not 157>",
      ],
    },
    deposit: {
      mainnet: { kind: "cli", args: a => ["funds", "deposit", "lighter-rh", a], min: 1, note: "Robinhood Chain contract approve + deposit (master OWS wallet signs; needs RH ETH gas)",
        minSource: "Lighter RH docs: minimum 1 USDG per deposit (LIGHTER_RH_MIN_DEPOSIT, src/exchanges/lighter-rh-deposit.ts)", belowMinLost: false, fee: null, liveMin: null,
        wallet: { kind: "evm", chain: "Robinhood Chain", rpcUrl: null, token: null, decimals: 6, asset: "USDG", gasAsset: "ETH", minGas: 0, source: "venue definition lighter-rh mainnet rpcUrl + depositPins.token; assetDetails l1_decimals 6" } },
      testnet: { kind: "none", reason: "unsupported on testnet: `funds deposit lighter-rh` is CAPABILITY_UNSUPPORTED on testnet (funds = the app faucet)" },
    },
    withdraw: {
      // `funds withdraw lighter` resolves the adapter from -e → LighterAdapter for lighter-rh (asset 3 = USDG).
      mainnet: { kind: "cli", args: a => ["funds", "withdraw", "lighter", a], min: 1, note: "-e lighter-rh routes to the RH adapter; asset 3 = USDG → Robinhood Chain",
        minSource: LIGHTER_LIVE_MIN, belowMinLost: false, fee: null, liveMin: "lighterAssetDetails", wallet: null },
      testnet: { kind: "cli", args: a => ["funds", "withdraw", "lighter", a], min: 1, note: "-e lighter-rh routes to the RH adapter; testnet asset 3 = USDC",
        minSource: LIGHTER_LIVE_MIN, belowMinLost: false, fee: null, liveMin: "lighterAssetDetails", wallet: null },
    },
    spotSymbol: { mainnet: null, testnet: null },
  },
  aster: {
    id: "aster", cliVenue: "aster", hip3: null,
    symbols: { mainnet: ["ETH", "SOL", "BTC"], testnet: ["ETH", "SOL", "BTC"] },
    minNotionalFallback: null,
    // Testnet REST host comes from the venue definition (fapi.asterdex-testnet.com) — no env override.
    testnetEnv: null,
    prerequisites: {
      testnet: [
        "Aster testnet account + test USDT (testnet UI faucet; no CLI deposit)",
        "perp wallet agent approve aster -n testnet --can-spot (spot needs canSpotTrade)",
      ],
      mainnet: ["USDT on BNB Chain → deposit in Aster UI (no CLI deposit)", "perp wallet agent approve aster --can-spot"],
    },
    deposit: {
      mainnet: MANUAL_UI("Aster", ["Deposit USDT (BNB Chain) — no CLI deposit path"]),
      testnet: { kind: "none", reason: "unsupported on testnet: no CLI deposit path (funds = the testnet UI faucet)" },
    },
    withdraw: {
      mainnet: MANUAL_UI("Aster", ["`perp funds withdraw aster` returns CAPABILITY_UNSUPPORTED (withdrawAssets = null) — withdraw in the UI"]),
      testnet: { kind: "none", reason: "unsupported: `perp funds withdraw aster` returns CAPABILITY_UNSUPPORTED (withdrawAssets = null)" },
    },
    spotSymbol: { mainnet: "ASTER", testnet: "ASTER" },
  },
  ondo: {
    id: "ondo", cliVenue: "ondo", hip3: null,
    symbols: { mainnet: ["BTC", "ETH", "TSLA"], testnet: ["BTC", "ETH", "TSLA"] },
    minNotionalFallback: { usd: 10, source: "assumed — Ondo market data publishes no min notional; confirm on the first order" },
    testnetEnv: null,
    prerequisites: {
      testnet: [
        "Sandbox account (app.ondoperps-sandbox.xyz) + API key created in the UI (scopes: trade, transfer)",
        "printf '%s\\n%s\\n' \"$KEY_ID\" \"$SECRET\" | perp wallet agent approve ondo -n testnet",
        "Funds: POST /v1/sandbox_deposit (runner deposit phase, sandbox only)",
      ],
      mainnet: [
        "Ondo account (KYC/region gate: not US/PA) + API key created in the UI",
        "Deposit to the account's funding address (UI) — no CLI deposit",
      ],
    },
    deposit: {
      mainnet: MANUAL_UI("Ondo Perps", ["Send USDC to the funding address shown in the UI (POST /v1/wallet/deposit_address/list)"]),
      testnet: { kind: "ondoSandbox", note: "POST /v1/sandbox_deposit {amount, symbol: USDC, deposit_destination: {id, wallet: margin}, chain_id: eth-sepolia}" },
    },
    withdraw: {
      // The destination must be on the Ondo address book, so the runner cannot pick it: run the CLI by hand.
      mainnet: { kind: "manual", instructions: ["perp funds withdraw ondo <amount> --to <address-book address> (try --dry-run first)"] },
      testnet: { kind: "manual", instructions: ["perp -n testnet funds withdraw ondo <amount> --to <address-book address> (sandbox /v1/withdraw; sandbox_withdrawal is a separate sandbox-only debit)"] },
    },
    spotSymbol: { mainnet: "TSLA", testnet: "TSLA" },
  },
  arcus: {
    id: "arcus", cliVenue: "arcus", hip3: null,
    symbols: { mainnet: ["BTC", "ETH", "SOL"], testnet: ["BTC", "ETH", "SOL"] },
    minNotionalFallback: null,
    testnetEnv: null,
    prerequisites: {
      testnet: [
        "Access whitelist for the master address (account/order reads return 403 otherwise)",
        "Testnet app: ~$1k test funds button + USDG mint; RH testnet ETH for gas (no public faucet — ask Arcus/RH)",
        "perp wallet agent approve arcus -n testnet --master <ows-wallet> --account-index 0",
      ],
      mainnet: [
        "Whitelisted master address; USDG on Robinhood Chain; RH ETH for approve/withdraw gas",
        "Deposit through the Arcus deposit proxy (UI) — no CLI deposit",
        "perp wallet agent approve arcus --master <ows-wallet> --account-index 0",
      ],
    },
    deposit: {
      mainnet: MANUAL_UI("Arcus", ["Deposit USDG via the deposit proxy (needs RH ETH gas)"]),
      testnet: { kind: "none", reason: "unsupported on testnet: no CLI deposit path (funds = the ~$1k test-funds button / USDG mint in the app)" },
    },
    withdraw: {
      // Withdraw-to-owner; needs the agent key (account) + the master wallet signature (--wallet/--ows).
      mainnet: { kind: "cli", args: a => ["funds", "withdraw", "arcus", a], min: 1, note: "to the account owner on Robinhood Chain (min 1 USDG)",
        minSource: "profile value (min 1 USDG) — not confirmed on a live withdraw", belowMinLost: false, fee: null, liveMin: null, wallet: null },
      testnet: { kind: "cli", args: a => ["funds", "withdraw", "arcus", a], min: 1, note: "to the account owner (min 1 USDG)",
        minSource: "profile value (min 1 USDG) — not confirmed on a live withdraw", belowMinLost: false, fee: null, liveMin: null, wallet: null },
    },
    spotSymbol: { mainnet: "TSLA", testnet: "TSLA" },
  },
  // QFEX. Order: UAT (testnet) first for every phase, then mainnet $20.
  // Until Q2 passes every reduce-only path (close / flatten / stop / tpsl / --tp/--sl) and amend
  // return CAPABILITY_UNSUPPORTED by design: run the generic trade phase only up to the plain
  // limit / cancel / market steps, and flatten a test position with a plain OPPOSITE order
  // (`perp trade market <SYM> sell <size> -e qfex`), not `trade close`.
  qfex: {
    id: "qfex", cliVenue: "qfex", hip3: null,
    // Smallest minimum order notional first (refdata 2026-10-04: SILVER 0.001 × 60.5 = $0.06, AAPL 0.01 × 333 = $3.3, GOLD 0.001 × 4,144 = $4.1).
    symbols: { mainnet: ["SILVER", "AAPL", "GOLD"], testnet: ["CL", "AAPL", "GOLD"] },
    minNotionalFallback: { usd: 10, source: "assumed — /refdata publishes min_quantity only; REJECTED_LESS_THAN_MIN_NOTIONAL exists but the threshold is unpublished" },
    testnetEnv: null,
    prerequisites: {
      testnet: [
        "UAT account at qfex.io + API key created in Developer Settings (Execute orders, View orders / positions / balance; NO Deposit and withdraw)",
        "printf '%s\\n%s\\n' \"$PUBLIC_KEY\" \"$SECRET\" | perp -n testnet wallet agent import qfex --account-id <uuid>   (or run it in a terminal: the resolved account UUID is shown for y/N confirmation)",
        "UAT funds: UNVERIFIED how they are issued (UAT web UI / banker.qfex.io)",
        "Gated by design until Q2 / Q5 / Q7 / Q21 pass: trade close / close-all / flatten / reduce / stop / tpsl / --tp / --sl / edit → CAPABILITY_UNSUPPORTED",
        "UAT /md/contracts returned HTTP 500 on 2026-10-04 (Q19): funding reads fail there; markets and order entry do not need it",
      ],
      mainnet: [
        "Run every UAT phase first. Mainnet blockers: Q1, Q2, Q5, Q7, Q10, Q14, Q20, Q21, Q22, Q23",
        "QFEX account (KYC; not US / UK / ES / … — see restrictedRegions), 2FA, API key created in Developer Settings",
        "$20 USDC on Arbitrum One → the address printed by `perp funds deposit qfex`",
      ],
    },
    deposit: {
      mainnet: { kind: "manual", instructions: ["perp funds deposit qfex → send USDC on Arbitrum One to the printed address (perp-cli sends nothing)"] },
      testnet: { kind: "none", reason: "UAT funding route undocumented" },
    },
    withdraw: {
      // Needs settings withdraw.qfex (interactive terminal confirmation) and a key with the withdraw permission; QFEX may require the web app + 2FA (Q17).
      mainnet: { kind: "manual", instructions: ["perp settings set withdraw.qfex <address>,<maxPerTx>,<maxPerDay> (terminal only)", "perp funds withdraw qfex <amount> --to <allowlisted address> (--dry-run first)"] },
      testnet: { kind: "manual", instructions: ["perp -n testnet funds withdraw qfex <amount> --to <allowlisted address> (--dry-run first)"] },
    },
    spotSymbol: { mainnet: null, testnet: null },
  },
};

/** Design verification items (numbered #n, S-items and QFEX Q-items). */
export const DESIGN_ITEMS: Record<string, { venues: string; what: string }> = {
  "#1": { venues: "lighter-rh", what: "funding basis 8h assumption" },
  "#2": { venues: "lighter-rh", what: "L2 signing, ChangePubKey, withdraw, 60 req/min" },
  "#3": { venues: "lighter+lighter-rh", what: "WASM runtime isolation in one process" },
  "#4": { venues: "ondo", what: "HMAC signing on all signed reads/writes" },
  "#5": { venues: "ondo", what: "DELETE sync canceled (amend), reduce-only IOC" },
  "#6": { venues: "ondo", what: "position stop visible as untriggered" },
  "#7": { venues: "ondo", what: "withdraw wallet margin vs main, WS login" },
  "#8": { venues: "arcus", what: "access whitelist (403)" },
  "#9": { venues: "arcus", what: "entryTpsl parentOrderId, modify body, /v1/order 404 window" },
  "#10": { venues: "arcus", what: "withdraw uint256 string, scheduleCancel" },
  "#11": { venues: "hyperliquid HIP-3", what: "funding basis 1h vs 8h" },
  "#12": { venues: "all", what: "unit tests updated" },
  "#13": { venues: "lighter(+rh)", what: "post-only TIF value 2" },
  "#14": { venues: "pacifica", what: "/orders/edit semantics, client_order_id, history_by_id after cancel, /positions/tpsl side + overwrite" },
  "#15": { venues: "hyperliquid", what: "frontendOpenOrders tif, spot openOrders coin, TP/SL legs" },
  "#16": { venues: "pacifica", what: "history_by_id row ordering" },
  "#17": { venues: "lighter(+rh)", what: "/tx COMMITTED→EXECUTED timing, cancel of filled order" },
  "#18": { venues: "lighter(+rh)/aster", what: "already-crossed TP/SL trigger rejection → ORDER_PARTIAL" },
  "#19": { venues: "lighter(+rh)", what: "accountActiveOrders type / trigger_price (trigger amend refusal)" },
  "#20": { venues: "hyperliquid", what: "IOC no-match error, cancel statuses[0] success" },
  "#21": { venues: "lighter(+rh)", what: "cancel EXECUTED meaning for filled / unknown order" },
  S1: { venues: "ondo", what: "/v1/spot/* accepts perps HMAC key" },
  S2: { venues: "ondo", what: "spot balance coin notation / units" },
  S3: { venues: "ondo", what: "transfer wallet name spot, from.id" },
  S4: { venues: "ondo", what: "spot order response / fee netting" },
  S5: { venues: "ondo", what: "spot DELETE format / cancel-all" },
  S6: { venues: "ondo", what: "spot orderbook depth param" },
  S7: { venues: "ondo", what: "spot TIF set" },
  S8: { venues: "ondo", what: "spot min order size" },
  S9: { venues: "aster", what: "MARKET BUY quantity accepted" },
  S10: { venues: "aster", what: "account reads need agent spot permission" },
  S11: { venues: "aster", what: "MIN_NOTIONAL on market orders" },
  S12: { venues: "aster", what: "permission error code → POLICY_DENIED" },
  S13: { venues: "aster", what: "spot status mapping" },
  S14: { venues: "arcus", what: "per-call spot slippage (resolved — verify passthrough)" },
  S15: { venues: "all", what: "arb scan --mode spot-perp keyless spot discovery" },
  S16: { venues: "hyperliquid", what: "unified account spot transfer no-op" },
  S17: { venues: "lighter", what: "accountActiveOrders filled_base_amount" },
  S18: { venues: "aster", what: "spot fee asset (commissionAsset) = base?" },
  S19: { venues: "pacifica", what: "account_equity includes spot holdings?" },
  S20: { venues: "arcus", what: "router TakerIntent field order" },
  S21: { venues: "lighter", what: "spot balance reflected at /tx status 2/3" },
  S22: { venues: "lighter", what: "spot event_info is/rs integer base units" },
  // QFEX. [MAINNET BLOCKER] = must pass on UAT before any mainnet order.
  Q1: { venues: "qfex", what: "[MAINNET BLOCKER] a GTC order survives socket close (clean close + kill): cancel-on-disconnect is off by default" },
  Q2: { venues: "qfex", what: "add_order.reduce_only wire type (bool vs 0/1), default when omitted, and venue ENFORCEMENT: reduce-only qty > position and reduce-only with no position are rejected or capped; take_profit / stop_loss omitted vs 0. PASSED 2026-10-05 for the wire type (JSON boolean) and the no-position rejection → QFEX_REDUCE_ONLY_WIRE is set and manual close / reduce / flatten / IOC reduce-only are open. STILL OPEN: an oversize resting reduce-only order was accepted and match-time capping is unproven → gates QFEX_RESTING_REDUCE_ONLY_VERIFIED (limit --reduce-only GTC / ALO, scale-tp). Stops and TP/SL are gated by Q21, automation by QFEX_AUTOMATION_VERIFIED" },
  Q3: { venues: "qfex", what: "auth success / failure frame shapes, WS timestamp tolerance, close code after 1 minute unauthenticated" },
  Q4: { venues: "qfex", what: "[ARB / FUNDING BLOCKER] funding_rate unit (executions funding amount ÷ position notional) and funding_rate vs next_funding_rate; then the 120/168 h annualization fix. Gates fundingVerified" },
  Q5: { venues: "qfex", what: "[MAINNET BLOCKER] modify_order: client_order_id preserved on MODIFIED?, quantity = total or remaining, reply ordering, take_profit / stop_loss omit vs preserve. Gates amend (QFEX_MODIFY_KEEPS_CLIENT_ID)" },
  Q6: { venues: "qfex", what: "/user/historic-orders indexing delay; terminal_status / execution_state value sets" },
  Q7: { venues: "qfex", what: "[MAINNET BLOCKER] attached TP/SL: id of the resulting stop (stop_orders frame shape), stop quantity on a partial / zero-fill entry, effect on other stops. Gates tpsl \"attached\"" },
  Q8: { venues: "qfex", what: "cancel_all_orders: also stops / TWAPs? any completion signal?" },
  Q9: { venues: "qfex", what: "refdata market_hours vs actual funding-active windows (overnight, `close` session, CL / US100 16–17 CT halt)" },
  Q10: { venues: "qfex", what: "[MAINNET BLOCKER] sign of PositionPublic.position (no side field), /executions execution_type values (funding payments), subaccount header behaviour" },
  Q11: { venues: "qfex", what: "view-only key: trade WS auth + get_user_orders allowed? account-scoped key: /user/subaccounts/balance result" },
  Q12: { venues: "qfex", what: "pre-IPO list beyond ANTHROPIC / OPENAI; real underlyings of PURR-USD, USDE-USD" },
  Q13: { venues: "qfex", what: "refdata min_price / max_price refresh (Cache-Control) vs MDS minmax_price" },
  Q14: { venues: "qfex", what: "[MAINNET BLOCKER] ACK timing vs the 500 ms speed bump, when get_user_orders shows the order, whether LIMIT IOC is bumped, which messages use the cancel bucket" },
  Q15: { venues: "qfex", what: "idle connection lifetime (server pings are documented), concurrent connection limit" },
  Q16: { venues: "qfex", what: "/user/transfer and /user/leverage: required permission, idempotency" },
  Q17: { venues: "qfex", what: "API-key withdraw: address whitelist / MFA / manual review (official CLI: needs 2FA, not possible from a CLI), minimum, fee" },
  Q18: { venues: "qfex", what: "client_order_id accepted format / length (INVALID_CLIENT_ORDER_ID); perp-cli sends a UUID" },
  Q19: { venues: "qfex", what: "UAT api.qfex.io/md/contracts HTTP 500 (2026-10-04) — funding reads on UAT. (mds.qfex.io is fine: a plain GET is 503 on prod too, the WS upgrade is 101)" },
  Q20: { venues: "qfex", what: "[MAINNET BLOCKER] exact IOC / FOK frame sequence for full, partial and no fill (FILLED rem>0 / IOC_PARTIALLY_FILLED / IOC_CANCELLED / CANCELLED)" },
  Q21: { venues: "qfex", what: "[MAINNET BLOCKER] stop order ACK: is client_order_id echoed? Gates stop placement" },
  Q22: { venues: "qfex", what: "[MAINNET BLOCKER] order_response.user_id = account id or user id? Gates QFEX_USER_ID_IS_ACCOUNT" },
  Q23: { venues: "qfex", what: "[MAINNET BLOCKER] /user/positions freshness after a fill (1 s vs 10 s pulse) vs placePerpVerified's ~10 s poll" },
};

export function isE2eVenue(s: string): s is E2eVenue {
  return (E2E_VENUES as readonly string[]).includes(s);
}
