# Perpetual Futures DEX Research: Non-EVM, Non-Solana Chains
**Generated:** 2026-03-19 21:25 UTC
**Scope:** Active perpetual futures DEXes on alternative L1/L2 chains as of March 2026

---

[OBJECTIVE] Identify all major active perpetual futures DEXes on non-EVM, non-Solana chains,
assess their SDK/API availability, and rate implementation feasibility for the perp-cli
ExchangeAdapter interface.

[DATA] 11 ecosystems surveyed: Sui, Aptos, StarkNet, Sei, Injective, dYdX Chain, Osmosis/Cosmos,
NEAR/Aurora, TON, Monad, and Bitcoin L2s (Stacks). 14 DEXes assessed in depth.
Data sources: DeFiLlama, DefiLlama Perps, official GitHub repos, npm packages, project documentation.

---

## ECOSYSTEM 1: SUI

### 1.1 BlueFin (fireflyprotocol)

**Chain:** Sui
**Status:** ACTIVE — primary perp DEX on Sui
**TVL/Volume:** ~$4.2B monthly volume (Aug 2025 peak); $82B+ cumulative. Sui ecosystem TVL peaked $2.6B (Oct 2025), ~$561M as of Feb 2026.
**Architecture:** Off-chain orderbook with on-chain settlement (CEX-like UX)
**Leverage:** Up to 20x (market dependent)
**Assets:** BTC, ETH, SOL, SUI, APT, ARB, AVAX, WAL, DEEP, SEI, and more

**SDK/API:**
- TypeScript client (v2): `fireflyprotocol/bluefin-v2-client-ts` on GitHub
- Python client: `fireflyprotocol/bluefin-client-python-sui`
- npm package: `@bluefin-exchange/bluefin-v2-client`
- REST API + WebSocket feeds available
- Off-chain orderbook queryable via HTTP; on-chain settlement via Sui contracts

**Interface Method Coverage:**
- getMarkets() — YES (market symbol list via SDK)
- getOrderbook() — YES (off-chain orderbook query)
- getRecentTrades() — YES (trade feed via REST)
- getFundingHistory() — YES (funding rate history)
- getKlines() — YES (OHLCV data)
- getBalance() — YES (account balance via SDK)
- getPositions() — YES (open positions)
- getOpenOrders() — YES (order management)
- getOrderHistory() — YES
- getTradeHistory() — YES
- getFundingPayments() — YES
- marketOrder() — YES
- limitOrder() — YES
- editOrder() — YES (order amendment)
- cancelOrder() — YES
- cancelAllOrders() — YES
- setLeverage() — YES (adjust leverage per market)
- stopOrder() — YES (stop-limit/stop-market)

**FEASIBILITY: EASY**
Full TypeScript SDK exists, actively maintained, well-documented. Nearly 1:1 method mapping.

---

### 1.2 Aftermath Finance

**Chain:** Sui
**Status:** ACTIVE (full-suite DeFi: AMM + liquid staking + DEX aggregator + orderbook perps)
**TVL/Volume:** Part of Sui DeFi ecosystem ($2.11B TVL Q3 2025 across all Sui protocols)
**Architecture:** Orderbook-based perpetuals optimized for Sui throughput
**Leverage:** Not publicly specified; market-dependent
**Assets:** Crypto, forex, commodities

**SDK/API:**
- TypeScript/JavaScript SDK available (Aftermath Finance SDK on npm)
- REST API endpoint exposed
- WebSocket: not confirmed in search results
- Primarily built for on-chain interaction via Sui Move modules

**Interface Method Coverage:**
- getMarkets() — LIKELY (SDK exposes market data)
- getOrderbook() — LIKELY
- getBalance() — YES (via SDK)
- getPositions() — LIKELY
- marketOrder() / limitOrder() — YES (orderbook perps)
- setLeverage() — UNCERTAIN
- stopOrder() — UNCERTAIN

**FEASIBILITY: MEDIUM**
SDK exists but perpetuals component documentation is less mature than BlueFin. Requires deeper
investigation of Aftermath Perps-specific endpoints.

---

### 1.3 Turbos Finance

**Chain:** Sui (backed by Jump Crypto + Mysten Labs)
**Status:** ACTIVE but lower activity — primarily concentrated liquidity AMM + perps
**TVL/Volume:** Smaller relative to BlueFin
**Architecture:** Oracle-based perps (Pyth/Chainlink prices), zero-slippage model; 0.1% open/close fee
**Leverage:** Up to 30x
**Assets:** Major crypto assets

**SDK/API:**
- No dedicated TypeScript perps SDK found
- Sui Move smart contract interaction required
- REST API: not confirmed
- GitHub: turbos-finance org exists but SDK coverage unknown

**Interface Method Coverage:**
- getMarkets() — PARTIAL (on-chain query)
- getOrderbook() — NO (oracle-based, no traditional orderbook)
- marketOrder() / limitOrder() — YES (open/close positions)
- setLeverage() — YES
- stopOrder() — UNCERTAIN

**FEASIBILITY: HARD**
No mature SDK for perps. Oracle-based model lacks orderbook, so getOrderbook() is not applicable.
On-chain interaction via Sui Move SDK required.

---

## ECOSYSTEM 2: APTOS

### 2.1 Merkle Trade

**Chain:** Aptos
**Status:** SHUT DOWN — wound down operations Feb 10, 2026. All positions forcibly closed.
**Historical Note:** Was largest Aptos perp DEX; $7B volume in 4 months; 115K+ traders.
TypeScript SDK existed (`merkle-trade` GitHub org).

**FEASIBILITY: N/A — Protocol is defunct.**

---

### 2.2 Kana Labs Perps

**Chain:** Aptos
**Status:** ACTIVE — launched June 2025 as first fully on-chain CLOB-based perps DEX on Aptos
**Architecture:** CLOB (Central Limit Order Book) on-chain
**Leverage:** Not publicly specified

**SDK/API:**
- Kana Labs has existing DEX aggregator SDK; perps SDK status unknown
- On-chain CLOB suggests REST + WebSocket possible
- Official docs needed for confirmation

**Interface Method Coverage:**
- CLOB architecture means orderbook methods are feasible
- Full method coverage uncertain without SDK docs

**FEASIBILITY: MEDIUM**
CLOB architecture is favorable for interface compatibility but SDK maturity is unconfirmed.

---

### 2.3 Tsunami Finance

**Chain:** Aptos
**Status:** LOW ACTIVITY — last major coverage 2022-2023; unclear if actively maintained in 2026
**Architecture:** Oracle-based, GLP-style liquidity pool (TLP token), zero slippage
**Leverage:** Up to 30x
**Assets:** Major crypto pairs

**SDK/API:**
- No dedicated TypeScript SDK found
- On-chain Aptos Move contract interaction
- Pyth/Chainlink oracle pricing

**Interface Method Coverage:**
- getOrderbook() — NO (oracle-based)
- marketOrder() / limitOrder() — PARTIAL
- setLeverage() — YES

**FEASIBILITY: HARD**
Low activity, no SDK, oracle-based model incompatible with orderbook interface methods.

---

### 2.4 Panora Perps

**Chain:** Aptos
**Status:** ACTIVE — Aptos DeFi super app; perps integrated; raised funding Aug 2025
**Architecture:** Integrates on-chain perpetual markets into aggregator
**TVL/Volume:** $7.2B+ in total transaction volume across aggregator

**SDK/API:**
- Panora SDK exists (DEX aggregator)
- Perps-specific SDK: not confirmed

**FEASIBILITY: MEDIUM**
Aggregator SDK exists. Perps component needs deeper investigation.

---

## ECOSYSTEM 3: STARKNET

### 3.1 Paradex

**Chain:** StarkNet AppChain (StarkNet's first dedicated appchain, incubated by Paradigm)
**Status:** ACTIVE — major perp DEX, challenger to Hyperliquid
**TVL:** $176M TVL (Feb 2026, down from $218M peak in Jan 2026)
**Volume:** Daily ATH $3B+ (Jan 25, 2026); avg ~$2.1B/day during Season 2
**Open Interest:** ~$550M (Feb 2026)
**Markets:** 100+ perpetual pairs; expanding to spot, options, RWA perps
**Leverage:** Market dependent
**Fees:** 0% trading fees for retail users

**SDK/API:**
- npm package: `@paradex/sdk` (official JavaScript/TypeScript SDK)
- Python SDK: `paradex-py` (available on PyPI)
- REST API: `docs.paradex.trade/api` — fully documented
- WebSocket feeds: YES
- Code samples: `tradeparadex/code-samples` on GitHub
- Authentication: API authentication documented

**Interface Method Coverage:**
- getMarkets() — YES (`GET /markets` documented)
- getOrderbook() — YES
- getRecentTrades() — YES
- getFundingHistory() — YES
- getKlines() — YES
- getBalance() — YES (account data)
- getPositions() — YES
- getOpenOrders() — YES
- getOrderHistory() — YES
- getTradeHistory() — YES
- getFundingPayments() — YES
- marketOrder() — YES
- limitOrder() — YES
- editOrder() — YES
- cancelOrder() — YES
- cancelAllOrders() — YES
- setLeverage() — YES
- stopOrder() — YES (stop-loss/take-profit available)

**FEASIBILITY: EASY**
Excellent TypeScript SDK + comprehensive REST API. Full method coverage confirmed in docs.
Privacy-first design (Paradex uses DIME token). One of the strongest candidates for integration.

---

### 3.2 ZKX Protocol

**Chain:** StarkNet
**Status:** UNCERTAIN — launched token ($ZKX) on KuCoin/Gate/Bitget in June 2024, but no
significant activity found in 2025-2026 search results. Likely low-activity or stalled.
**Architecture:** Social perp trading DEX; raised $7.6M
**Volume:** Not confirmed for 2025-2026

**SDK/API:**
- No TypeScript SDK found
- Status of API unclear

**FEASIBILITY: HARD**
Unclear active status. No SDK. Not recommended for integration prioritization.

---

## ECOSYSTEM 4: SEI NETWORK

### 4.1 Citrex Markets

**Chain:** Sei (native to Sei's CosmWasm + EVM dual environment)
**Status:** ACTIVE — launched January 2025, operating CLOB perp DEX on Sei
**Architecture:** CLOB exchange
**Volume:** DEX activity on Sei reached $43M avg daily volume Q3 2025 (75% QoQ growth)

**SDK/API:**
- Sei has native CosmWasm + EVM compatibility
- Citrex-specific SDK: not confirmed in search results
- REST/WebSocket likely (CLOB architecture)

**Interface Method Coverage:**
- CLOB model supports orderbook queries
- Full coverage uncertain without SDK docs

**FEASIBILITY: MEDIUM**
CLOB architecture is promising but SDK maturity unknown. Sei's EVM compatibility may allow
standard Web3 tooling.

---

### 4.2 Monaco Protocol

**Chain:** Sei (incubated by Sei Labs)
**Status:** UPCOMING as of 2025 — perpetual futures exchange in development
**SDK/API:** Too early to assess

**FEASIBILITY: UNKNOWN**

---

## ECOSYSTEM 5: INJECTIVE

### 5.1 Helix (native DEX on Injective)

**Chain:** Injective Protocol (Cosmos-based appchain optimized for finance)
**Status:** ACTIVE
**TVL:** $15.7M
**Volume:** $4.3B in 30-day perp volume; $44.4B cumulative perp volume; $7B+ total DEX volume
**Markets:** Unlimited markets (permissionless market creation on Injective)
**Leverage:** Up to 20x
**Order Types:** Market, limit, stop-loss, take-profit, stop-limit, stop-market

**SDK/API:**
- TypeScript SDK: `@injectivelabs/sdk-ts` (npm package, actively maintained)
- GitHub: `InjectiveLabs/injective-ts` monorepo
- API Reference: `api.injective.exchange`
- REST API: YES (gRPC-Web + HTTP)
- WebSocket: YES
- Python SDK: also available
- Example repos: `injective-ts-examples`, `injective-ts-example`

**Interface Method Coverage:**
- getMarkets() — YES (`getDerivativeMarkets()` in SDK)
- getOrderbook() — YES (orderbook gRPC/HTTP endpoints)
- getRecentTrades() — YES
- getFundingHistory() — YES (funding payments per market)
- getKlines() — YES (OHLCV candles)
- getBalance() — YES (subaccount balances)
- getPositions() — YES (derivative positions per subaccount)
- getOpenOrders() — YES (derivative orders)
- getOrderHistory() — YES
- getTradeHistory() — YES (derivative trade history)
- getFundingPayments() — YES
- marketOrder() — YES (MsgCreateDerivativeMarketOrder)
- limitOrder() — YES (MsgCreateDerivativeLimitOrder)
- editOrder() — YES (cancel + replace pattern or batch update)
- cancelOrder() — YES (MsgCancelDerivativeOrder)
- cancelAllOrders() — YES (MsgBatchCancelDerivativeOrders)
- setLeverage() — YES (leverage adjustment per market)
- stopOrder() — YES (conditional orders supported)

**FEASIBILITY: EASY**
Mature `@injectivelabs/sdk-ts` covers all operations. Helix is built on this same SDK.
Injective is a fully-featured financial chain with native derivatives support at protocol level.

---

## ECOSYSTEM 6: dYdX CHAIN (Cosmos)

### 6.1 dYdX v4

**Chain:** Sovereign Cosmos appchain (CometBFT + Cosmos SDK)
**Status:** ACTIVE — formerly dominant; now ~10-15% market share after Hyperliquid rise
**TVL:** ~$1B+ TVL historically; current figures lower after market share loss
**Volume:** ~$200-250M daily avg 2025; lifetime volume ~$1.5T
**Markets:** 200+ perpetual markets
**Architecture:** Decentralized off-chain orderbook + on-chain settlement via Cosmos validators

**SDK/API:**
- TypeScript client: `dydxprotocol/v4-clients` (v4-client-js)
- npm: official `@dydxprotocol/v4-client-js`
- REST API (Indexer/Comlink): `docs.dydx.exchange` — fully documented
- WebSocket: YES (Indexer WebSocket feeds)
- Getting Started guide with TypeScript examples in official docs
- Indexer: read-only REST + WebSocket for market/account data
- Validator client: write operations (place/cancel orders)

**Interface Method Coverage:**
- getMarkets() — YES (IndexerClient.markets)
- getOrderbook() — YES (orderbook per market)
- getRecentTrades() — YES
- getFundingHistory() — YES (historical funding rates)
- getKlines() — YES (candles)
- getBalance() — YES (subaccount USDC balance)
- getPositions() — YES (perpetual positions per subaccount)
- getOpenOrders() — YES
- getOrderHistory() — YES
- getTradeHistory() — YES
- getFundingPayments() — YES
- marketOrder() — YES (IOC market order)
- limitOrder() — YES
- editOrder() — YES (cancel + replace)
- cancelOrder() — YES
- cancelAllOrders() — YES
- setLeverage() — NO native leverage setter (position size determines effective leverage)
- stopOrder() — YES (conditional orders via order flags)

**FEASIBILITY: EASY**
Excellent documentation and TypeScript SDK. Note: setLeverage() has no direct equivalent
because dYdX uses cross-margin with no explicit leverage setting — position size implicitly
determines leverage. All other methods covered.

---

## ECOSYSTEM 7: OSMOSIS / COSMOS

### 7.1 Levana Perps

**Chain:** Osmosis (primary), Sei, Injective — all CosmWasm-based chains
**Status:** ACTIVE but small — low TVL across all deployments
**TVL:** Osmosis $1.02M, Sei $23.7K, Injective $12K (very small)
**Volume:** 30-day perp volume $9.53M; 24h volume $286K
**Architecture:** Fully collateralized peer-to-pool (NO orderbook — AMM-style)
**Leverage:** Up to 30x
**Assets:** Native Cosmos chain tokens

**SDK/API:**
- TypeScript tutorial using CosmJS library — `docs.levana.finance/api-tutorial-ts`
- No standalone npm SDK; uses CosmJS + Levana contract queries
- REST: CosmWasm contract query via LCD endpoints
- WebSocket: CosmWasm subscription possible
- NOT an orderbook — uses automated market maker for perps

**Interface Method Coverage:**
- getMarkets() — YES (factory contract query)
- getOrderbook() — NO (no orderbook; AMM model)
- getRecentTrades() — PARTIAL (position events)
- getFundingHistory() — YES (borrow fee / funding rate history)
- getKlines() — PARTIAL (oracle price history)
- getBalance() — YES (cw20 token balances)
- getPositions() — YES (position queries)
- getOpenOrders() — NO (no order concept in AMM perps)
- getOrderHistory() — NO
- getTradeHistory() — PARTIAL (position open/close events)
- getFundingPayments() — YES (borrow fees)
- marketOrder() — YES (open_position message)
- limitOrder() — NO (no limit orders in AMM model)
- editOrder() — NO (update margin/leverage for existing position)
- cancelOrder() — NO (close_position instead)
- cancelAllOrders() — NO
- setLeverage() — YES (update_position_leverage)
- stopOrder() — PARTIAL (slippage protection only)

**FEASIBILITY: HARD**
AMM-based perps model is fundamentally incompatible with orderbook interface methods
(getOrderbook, limitOrder, cancelOrder, getOpenOrders). Would require a separate adapter pattern.
Low TVL makes integration questionable from a business value perspective.

---

## ECOSYSTEM 8: NEAR / AURORA

### 8.1 Spin Finance

**Chain:** NEAR Protocol
**Status:** UNCLEAR — not found in major 2025-2026 perp DEX rankings. Likely low-activity or defunct.
**Historical:** Spin was a CLOB DEX on NEAR; status unclear in 2026.

**FEASIBILITY: UNKNOWN / LOW PRIORITY**

### 8.2 Aurora

**Chain:** Aurora (EVM on NEAR)
**Note:** Aurora is EVM-compatible, so it falls outside the non-EVM scope of this research.
Any EVM-based perp DEX on Aurora would use standard EVM tooling.

---

## ECOSYSTEM 9: TON / TELEGRAM

**Finding:** No significant perpetual futures DEX found on TON as of March 2026.
The TON ecosystem focuses on spot DEXs (STON.fi, DeDust) and Telegram mini-apps.
The search results confirm no TON-native perp DEXes with meaningful TVL or SDK availability.

**FEASIBILITY: N/A — No qualifying protocol found.**

---

## ECOSYSTEM 10: MONAD

### 10.1 Perpl

**Chain:** Monad (EVM-compatible L1, mainnet Nov 2025)
**Status:** EARLY — Monad is EVM-compatible, so Perpl uses EVM tooling.
**Note:** Monad is EVM-compatible — falls partially outside non-EVM scope.
Monad mainnet launched November 24, 2025. Ecosystem still nascent.

**FEASIBILITY: N/A (EVM-compatible)**

---

## ECOSYSTEM 11: BITCOIN L2 (STACKS)

### 11.1 Velar PerpDex

**Chain:** Stacks (Bitcoin L2 using Clarity smart contracts)
**Status:** ACTIVE — launched March 28, 2025 as first Bitcoin-native perpetual DEX
**Architecture:** Perpetual futures on Bitcoin L2; 5-second block times; 100% Bitcoin finality
**Leverage:** Up to 10x
**Initial pair:** sBTC-USDh
**TVL/Volume:** Early stage, no major TVL figures published

**SDK/API:**
- Stacks uses Clarity smart contracts (not Solidity, not Move)
- Stacks.js: TypeScript library for Stacks interactions
- Velar developer toolkit mentioned but no dedicated perps SDK confirmed
- Clarity contract calls for order placement
- REST API: likely via Stacks API (Hiro) for reads

**Interface Method Coverage:**
- getMarkets() — PARTIAL (contract state reads)
- getOrderbook() — UNCERTAIN
- marketOrder() / limitOrder() — YES (contract calls)
- setLeverage() — YES
- stopOrder() — UNCERTAIN

**FEASIBILITY: HARD**
Clarity VM is unique (not EVM, not Rust/Move). Stacks.js exists but Velar's perps SDK is
immature. Block times (5 seconds) may impact latency. Early-stage protocol.

---

## SUMMARY TABLE

| DEX | Chain | TVL | Daily Vol | TS SDK | REST | WS | Feasibility |
|-----|-------|-----|-----------|--------|------|-----|-------------|
| BlueFin | Sui | ~$100M+ | ~$140M | YES (v2) | YES | YES | EASY |
| Aftermath Finance | Sui | Sui ecosystem | Unknown | PARTIAL | YES | UNKNOWN | MEDIUM |
| Turbos Finance | Sui | Small | Small | NO | PARTIAL | NO | HARD |
| Kana Labs Perps | Aptos | Unknown | Unknown | PARTIAL | UNKNOWN | UNKNOWN | MEDIUM |
| Paradex | StarkNet AppChain | $176M | ~$2.1B avg | YES | YES | YES | EASY |
| ZKX | StarkNet | Low | Unknown | NO | NO | NO | HARD |
| Citrex Markets | Sei | Unknown | ~$43M (Sei DEX) | UNKNOWN | UNKNOWN | UNKNOWN | MEDIUM |
| Helix (Injective) | Injective | $15.7M | ~$143M | YES | YES | YES | EASY |
| dYdX v4 | dYdX Chain (Cosmos) | ~$1B+ hist. | ~$200-250M | YES | YES | YES | EASY |
| Levana Perps | Osmosis/Sei/Injective | $1.05M total | $286K | PARTIAL (CosmJS) | PARTIAL | PARTIAL | HARD |
| Velar PerpDex | Stacks (Bitcoin L2) | Early | Early | NO | PARTIAL | NO | HARD |
| Merkle Trade | Aptos | DEFUNCT | DEFUNCT | N/A | N/A | N/A | N/A |

---

## PRIORITY RANKING FOR PERP-CLI INTEGRATION

### Tier 1 — RECOMMENDED (EASY feasibility, active, good volume)
1. **Paradex** (StarkNet) — $176M TVL, $2.1B daily vol, full TS SDK, 100+ markets
2. **Helix/Injective** — $15.7M TVL, $4.3B/30d perp vol, mature `@injectivelabs/sdk-ts`
3. **dYdX v4** (Cosmos chain) — $1B+ TVL history, 200+ markets, `v4-client-js` SDK
4. **BlueFin** (Sui) — $82B cumulative vol, `bluefin-v2-client-ts`, all methods covered

### Tier 2 — POSSIBLE but requires investigation (MEDIUM feasibility)
5. **Aftermath Finance** (Sui) — Orderbook perps, SDK exists, docs less mature
6. **Citrex Markets** (Sei) — CLOB architecture, SDK status needs direct investigation
7. **Kana Labs** (Aptos) — CLOB perps, launched June 2025, SDK needs investigation

### Tier 3 — NOT RECOMMENDED (HARD or N/A)
- Turbos Finance — No SDK, oracle model, low activity
- Levana Perps — AMM model incompatible with orderbook interface
- ZKX — Unclear active status, no SDK
- Velar PerpDex — Immature, Clarity VM, no SDK
- Merkle Trade — DEFUNCT
- Spin Finance (NEAR) — Unclear status
- TON perps — No qualifying protocol

---

[FINDING] Four DEXes (Paradex, Helix/Injective, dYdX v4, BlueFin) have confirmed TypeScript SDKs
with near-complete method coverage for the ExchangeAdapter interface.
[STAT:n] n=14 DEXes assessed across 11 ecosystems
[STAT:effect_size] 4/14 EASY tier, 3/14 MEDIUM tier, 5/14 HARD tier, 2/14 N/A

[FINDING] dYdX v4's setLeverage() has no direct equivalent — cross-margin model only.
[STAT:n] n=1 method gap among EASY-tier protocols

[FINDING] Levana Perps (Osmosis/Sei/Injective) is fundamentally incompatible with the orderbook
adapter interface due to AMM-based perpetuals model lacking orders, orderbook, and limit order concepts.
[STAT:n] n=8 interface methods not mappable to Levana's AMM model

[FINDING] Two major ecosystems yielded no viable perp DEX: TON (no protocol) and NEAR (unclear status).
Monad is EVM-compatible and thus out of non-EVM scope.
[STAT:n] n=3 ecosystems with no actionable integration candidate

[LIMITATION] TVL and volume figures are point-in-time snapshots from DeFiLlama and project
announcements; actual current figures may differ. SDK API completeness for MEDIUM-tier protocols
(Aftermath, Citrex, Kana Labs) requires hands-on testing to confirm method coverage. ZKX and
Spin Finance active status could not be confirmed and may have wound down. Monad ecosystem
perp DEXes were not fully assessed as Monad is EVM-compatible.
