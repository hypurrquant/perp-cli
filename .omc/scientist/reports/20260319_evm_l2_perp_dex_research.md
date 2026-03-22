# EVM L2 Perpetual Futures DEX Research Report
**Date**: March 2026
**Prepared by**: Scientist agent (oh-my-claudecode)
**Scope**: Major perpetual futures DEXes on EVM L2 chains — integration feasibility for perp-cli

---

## [OBJECTIVE]
Identify all major active perpetual futures DEXes on EVM L2 chains as of March 2026. For each, document chain, TVL/volume, SDK/API availability, supported operations, and rate implementation feasibility for the perp-cli ExchangeAdapter interface.

---

## [DATA]
- Total DEXes researched: 15
- Active protocols: 13
- Shut down / defunct: 1 (Vertex Protocol — Aug 2025)
- Uncertain / low activity: 1 (Derivio on zkSync)
- Sources: DefiLlama, official documentation, npm registry, GitHub, web search (March 2026)

---

## Feasibility Rating Key
| Rating | Meaning |
|--------|---------|
| **EASY** | Official TypeScript/JS SDK, well-documented, most interface methods directly mappable |
| **MEDIUM** | REST API exists and is documented, or SDK exists but uses non-standard patterns (keepers, intents, on-chain settlement) |
| **HARD** | No SDK/API; on-chain contract interaction only via viem/ethers; high engineering effort |
| **N/A** | Defunct or not viable |

---

## [FINDING] DEX-by-DEX Analysis

---

### 1. GMX v2
**Chain**: Arbitrum (primary), Avalanche, Ethereum Mainnet
**Status**: ACTIVE
**Feasibility**: EASY

[STAT:n] TVL: ~$258M (DefiLlama, early 2026)
[STAT:n] Daily volume: Multi-billion weekly, $500M+ days reported
[STAT:n] Lifetime integrations: 80+ DeFi projects

**SDK/API**:
- TypeScript SDK: `@gmx-io/sdk` (npm) — official, two clients
  - `GmxSdk`: full read/write via RPC
  - `GmxApiSdk`: lightweight read-only over HTTP
- REST API: Yes (docs.gmx.io/docs/api/overview)
- WebSocket: No official feed
- SDK v2 covers: markets, tickers, tokens, pairs, rates, APY, performance, positions, orders, OHLCV

**Order types**: Market, Limit, Stop, Trigger (conditional)
**Max leverage**: 100x
**Assets**: BTC, ETH, SOL, LINK, ARB + permissionless GM pools

**Interface Coverage**:
| Method | Supported |
|--------|-----------|
| getMarkets() | Yes |
| getOrderbook() | Partial (oracle-based, no classic CLOB) |
| getRecentTrades() | Yes |
| getFundingHistory() | Yes |
| getKlines() | Yes (OHLCV via SDK) |
| getBalance() | Yes |
| getPositions() | Yes (`sdk.positions.getPositions()`) |
| getOpenOrders() | Yes |
| getOrderHistory() | Yes |
| getTradeHistory() | Yes |
| getFundingPayments() | Yes |
| marketOrder() | Yes (on-chain tx via SDK) |
| limitOrder() | Yes |
| editOrder() | Yes |
| cancelOrder() | Yes |
| cancelAllOrders() | Yes |
| setLeverage() | Yes |
| stopOrder() | Yes (trigger orders) |

**Notes**: July 2025 hack, fully recovered. DAO shifted staking to treasury buybacks (March 2026). Permissionless pool creation. Best SDK ecosystem among EVM L2 perp DEXes.

---

### 2. Gains Network (gTrade) v10
**Chain**: Arbitrum (primary, >90% volume), Polygon, Base
**Status**: ACTIVE
**Feasibility**: EASY

[STAT:n] TVL: $24.7M total ($19.6M on Arbitrum, $3.2M on Base, $1.1M on Polygon)
[STAT:n] 24h volume: ~$111M/day; monthly: $1.96B
[STAT:n] Lifetime volume on Arbitrum: $58B+ (since Dec 2022)

**SDK/API**:
- TypeScript SDK: `@gainsnetwork/sdk` (npm, v1.0.0-rc12) — official
- REST API: Yes, no auth required for GET endpoints
- WebSocket: Yes (event stream for live updates)
- v10 SDK: normalized trading variables + trades

**Key API endpoints**:
- `/trading-variables` — markets, leverage limits
- `/open-trades/<address>` — open positions (replaces allTrades as of Oct 27, 2025)

**Order types**: Market, Limit, Stop-Loss, Take-Profit
**Max leverage**: Up to 500x (selected markets), 150x typical
**Assets**: 270+ markets — crypto, forex, stocks, commodities

**Interface Coverage**:
| Method | Supported |
|--------|-----------|
| getMarkets() | Yes |
| getOrderbook() | No (synthetic/oracle model) |
| getRecentTrades() | Yes |
| getFundingHistory() | Yes |
| getKlines() | Via third-party |
| getBalance() | Yes |
| getPositions() | Yes |
| getOpenOrders() | Yes |
| getOrderHistory() | Yes |
| getTradeHistory() | Yes |
| getFundingPayments() | Yes |
| marketOrder() | Yes |
| limitOrder() | Yes |
| editOrder() | Yes |
| cancelOrder() | Yes |
| cancelAllOrders() | Yes |
| setLeverage() | Yes |
| stopOrder() | Yes |

**Notes**: Synthetic model — no traditional orderbook. 270+ markets widest of any L2 DEX. 2026 roadmap: DEGEN markets, RWA expansion.

---

### 3. Synthetix Perps v3
**Chain**: Base (primary, Arbitrum deprecated), Ethereum Mainnet (launched Dec 2025)
**Status**: ACTIVE
**Feasibility**: MEDIUM

[STAT:n] TVL: ~$210M (Jan 2025)
[STAT:n] Monthly volume: $274M on Base; $11B generated in 6-week competition (Dec 2025)
[STAT:n] Arbitrum v3 sunsetted; resources consolidated on Base

**SDK/API**:
- TypeScript SDK: `@parifi/synthetix-sdk-ts` (npm) — uses viem internally
- Python SDK: Also available
- REST API: Subgraph + contract reads
- WebSocket: No
- Keeper-based settlement model (async commit + settle)

**Order types**: Market, Limit (via keepers), Stop (via keepers)
**Max leverage**: 50x (ETH Mainnet), higher on Base
**Assets**: BTC, ETH, SOL + 12+ markets on Base; weekly market additions in 2026

**Interface Coverage**:
| Method | Supported |
|--------|-----------|
| getMarkets() | Yes |
| getOrderbook() | No (oracle-based) |
| getRecentTrades() | Yes |
| getFundingHistory() | Yes |
| getKlines() | Via Pyth/Chainlink |
| getBalance() | Yes |
| getPositions() | Yes |
| getOpenOrders() | Yes |
| getOrderHistory() | Yes |
| getTradeHistory() | Yes |
| getFundingPayments() | Yes |
| marketOrder() | Via keeper settlement (async) |
| limitOrder() | Via keeper settlement (async) |
| editOrder() | Limited |
| cancelOrder() | Yes |
| cancelAllOrders() | Partial |
| setLeverage() | Yes |
| stopOrder() | Via keeper |

**Notes**: Non-standard async order flow requires keeper settlement. Arbitrum v3 deprecated. Ethereum Mainnet launched Dec 2025. 2026 roadmap: new markets every week. Kwenta is a frontend built on top.

---

### 4. Kwenta
**Chain**: Optimism (v2, legacy), Base (v3 via Synthetix)
**Status**: ACTIVE (UI layer)
**Feasibility**: MEDIUM

**SDK/API**: No dedicated SDK — implement via Synthetix SDK (`@parifi/synthetix-sdk-ts`).
**Order types**: Market, Limit, Stop-Market, Stop-Limit
**Max leverage**: 50x (Synthetix constraint)

**Notes**: Kwenta is a frontend/interface layer on top of Synthetix. Same integration approach as Synthetix Perps v3. v2 on Optimism (OP Mainnet), v3 routing to Base via Synthetix infrastructure.

---

### 5. Perennial Finance v2
**Chain**: Arbitrum
**Status**: ACTIVE
**Feasibility**: MEDIUM

[STAT:n] TVL: Lower tier (estimated $5–20M; DefiLlama tracked)
[STAT:n] Volume: Not widely reported in top rankings

**SDK/API**:
- TypeScript SDK: `@perennial/sdk` (npm) — official, GitHub: `equilibria-xyz/perennial-v2-sdk-ts`
- GraphQL subgraph for historical data
- Key SDK methods: `marketSnapshots()`, `activePositionPnl()`, open orders, trade history
- WebSocket: No
- REST API: No (subgraph only)

**Order types**: Market, Limit (via solver intents)
**Max leverage**: Market-dependent
**Assets**: ETH, BTC + selected markets; intent-based solver execution

**Interface Coverage**:
| Method | Supported |
|--------|-----------|
| getMarkets() | Yes |
| getOrderbook() | No (AMM/intent model) |
| getRecentTrades() | Via subgraph |
| getFundingHistory() | Via subgraph |
| getKlines() | Via subgraph |
| getBalance() | Yes |
| getPositions() | Yes |
| getOpenOrders() | Yes |
| getOrderHistory() | Via subgraph |
| getTradeHistory() | Via subgraph |
| getFundingPayments() | Via subgraph |
| marketOrder() | Via solver intents |
| limitOrder() | Via solver intents |
| editOrder() | Limited |
| cancelOrder() | Yes |
| cancelAllOrders() | Partial |
| setLeverage() | Implicit via position size |
| stopOrder() | Via solver |

**Notes**: "Perennial Rollup" concept — dedicated perps chain for isolated execution. Kwenta considered Perennial for Arbitrum deployment (KIP-118). Intent-based execution model.

---

### 6. HMX Protocol
**Chain**: Arbitrum
**Status**: ACTIVE
**Feasibility**: HARD

[STAT:n] Lifetime volume: $50B+
[STAT:n] TVL: Moderate (DefiLlama tracked, ~$10–30M estimated)

**SDK/API**:
- TypeScript SDK: None confirmed
- Python SDK: Planned/in development (roadmap item)
- REST API: No public documentation found
- WebSocket: No
- Integration: On-chain contracts via viem/ethers only

**Order types**: Market, Limit, Stop
**Max leverage**: 1,000x (advertised)
**Assets**: Crypto, Forex, Equities, Commodities (multi-asset)

**Notes**: Proprietary oracle aggregator compresses Pyth + Stork price data (10x gas efficiency). Cross-margin + multi-collateral. 1,000x leverage on selected markets. No SDK = HARD integration.

---

### 7. MUX Protocol v3
**Chain**: Arbitrum (primary), BNB Chain, Optimism, Avalanche
**Status**: ACTIVE
**Feasibility**: HARD

**SDK/API**:
- TypeScript SDK: None confirmed
- REST API: No public documentation found
- WebSocket: No
- Integration: On-chain contracts + Chainlink Data Streams

**Order types**: Market, Limit, Stop, Conditional
**Max leverage**: 100x
**Assets**: BTC, ETH + major crypto

**Notes**: Aggregator model — routes orders through GMX and other protocols. Adopted Chainlink Data Streams on Arbitrum (May 2025) for sub-second market data. V3 launch with high-speed conditional orders.

---

### 8. Vela Exchange
**Chain**: Arbitrum
**Status**: ACTIVE (reduced activity vs 2023 peak)
**Feasibility**: HARD

**SDK/API**:
- TypeScript SDK: None
- REST API: None found
- WebSocket: None found
- Integration: On-chain CLOB only

**Order types**: Market, Limit, Stop
**Max leverage**: 100x
**Assets**: Crypto perpetuals

**Notes**: On-chain CLOB perpetual. High activity in 2023, significantly diminished in 2025–2026. No SDK ecosystem. CLOB model means orderbook data is on-chain only.

---

### 9. SynFutures v3
**Chain**: Base (primary); Blast deprecated April 2025
**Status**: ACTIVE on Base
**Feasibility**: MEDIUM

**SDK/API**:
- TypeScript SDK: Official V3 SDK released Q1 2025 (`docs.synfutures.com/developers/sdk`, GitHub: SynFutures org)
- REST API: Partial
- WebSocket: No
- Oyster AMM: concentrated liquidity + on-chain orderbook hybrid

**Order types**: Market, Limit (Oyster AMM hybrid)
**Max leverage**: Not specified
**Assets**: Permissionless market creation — meme coins + major crypto

**Interface Coverage**:
| Method | Supported |
|--------|-----------|
| getMarkets() | Yes |
| getOrderbook() | Yes (hybrid on-chain CLOB) |
| getRecentTrades() | Yes |
| getFundingHistory() | Partial |
| getKlines() | Partial |
| getBalance() | Yes |
| getPositions() | Yes |
| getOpenOrders() | Yes |
| getOrderHistory() | Via subgraph |
| getTradeHistory() | Via subgraph |
| getFundingPayments() | Partial |
| marketOrder() | Yes |
| limitOrder() | Yes |
| editOrder() | Limited |
| cancelOrder() | Yes |
| cancelAllOrders() | Partial |
| setLeverage() | Implicit |
| stopOrder() | Limited |

**Notes**: Blast protocol deprecated April 15, 2025. Pivoted to Base. Oyster AMM = concentrated liquidity + on-chain orderbook. 2026 roadmap: mobile app Q3 2026. Permissionless market creation is unique.

---

### 10. Polynomial Protocol
**Chain**: Polynomial Chain (own OP Stack L2 on Optimism Superchain)
**Status**: ACTIVE
**Feasibility**: HARD

**SDK/API**:
- TypeScript SDK: None found
- REST API: None found
- WebSocket: None found
- Built on Synthetix v3 infrastructure; own L2

**Order types**: Market, Limit (hybrid CLOB+AMM)
**Max leverage**: Not specified

**Notes**: Own L2 chain (Polynomial Chain) on OP Superchain. Gasless trading. No public developer SDK. Would require direct contract interaction. Hybrid CLOB+AMM model.

---

### 11. ApeX Omni
**Chain**: zkLink X (unified cross-chain layer); deposits from Arbitrum, Base, Mantle, Ethereum, BNB Chain
**Status**: ACTIVE
**Feasibility**: MEDIUM

[STAT:n] Users: 145,000+ (14.5x growth in 6 months during 2025)

**SDK/API**:
- TypeScript SDK: None (no npm package found)
- REST API: Yes — documented at `api-docs.pro.apex.exchange`
- WebSocket: Yes
- Cross-collateral: USDC, WBTC, WETH, ETH, cmETH, mETH, cbBTC, USDe

**Order types**: Market, Limit, Stop
**Max leverage**: 100x
**Assets**: 70+ markets including crypto and prediction markets

**Interface Coverage**: Full coverage via REST API (getMarkets, getOrderbook, getRecentTrades, getFundingHistory, getKlines, getBalance, getPositions, getOpenOrders, getOrderHistory, getTradeHistory, getFundingPayments, all order types, cancelOrder, setLeverage, stopOrder).

**Notes**: zkLink X layer for unified multi-chain UX. No bridging needed. Prediction markets + stock perps planned. AppChain in development (early 2026). REST API is comprehensive.

---

### 12. MYX Finance v2
**Chain**: Linea (primary), Arbitrum, BNB Chain, opBNB
**Status**: ACTIVE
**Feasibility**: MEDIUM

[STAT:n] TVL: ~$21M (early 2026)
[STAT:n] Monthly volume: $9B+ (Aug 2025 peak)

**SDK/API**:
- TypeScript SDK: None
- REST API: Yes — `myxfinance.gitbook.io/myx/protocol/api`
- WebSocket: No
- Account abstraction: EIP-4337/EIP-7702 (gasless in V2)

**Order types**: Market, Limit
**Max leverage**: 50x (V2)
**Assets**: Major crypto perpetuals

**Notes**: V2 announced Feb 27, 2026 — gasless one-click trading via account abstraction. Modular Derivative Settlement Engine architecture. Chainlink oracle integration. Linea as primary chain. V2 is a significant upgrade.

---

### 13. Lighter
**Chain**: Custom ZK L2 on Ethereum (EVM-compatible, own chain)
**Status**: ACTIVE — Top 3 perp DEX globally
**Feasibility**: MEDIUM

[STAT:n] TVL: $873M (early 2026)
[STAT:n] Volume: $295B+ monthly (Nov 2025), 248K active addresses
[STAT:n] Market position: #2 perp DEX by active addresses (early 2026)

**SDK/API**:
- TypeScript SDK: None (no npm package published)
- REST API: Yes — well-structured, used in perp-cli already
- WebSocket: Yes
- ZK proofs verify all trades on-chain

**Order types**: Market, Limit
**Max leverage**: Not publicly specified
**Assets**: Major crypto perpetuals (BTC, ETH, etc.)

**Notes**: Off-chain matching engine + ZK proof verification. TGE end of 2025. Nov 2025: exceeded $295B monthly volume, reached #3 globally. Custom ZK L2 (EVM-compatible). Already integrated in perp-cli project.

---

### 14. Vertex Protocol — DEFUNCT
**Chain**: Arbitrum (+ Blast, Mantle)
**Status**: SHUT DOWN — Aug 14, 2025
**Feasibility**: N/A

**Notes**: Acquired by Ink Foundation July 8, 2025. All trading operations ended Aug 14, 2025. VRTX holders received INK tokens. Had excellent TypeScript + Python SDKs with 15ms latency. Not viable for integration.

---

### 15. Derivio
**Chain**: zkSync Era
**Status**: UNCERTAIN (very low activity)
**Feasibility**: HARD

**SDK/API**: None found publicly
**Notes**: Binance Labs incubated. Launched on zkSync Era mainnet. Account abstraction features. Very low activity in 2025–2026. zkSync Lite being deprecated in 2026. Not recommended for integration.

---

## [FINDING] Summary Rankings by Integration Priority

[STAT:n] n = 13 active protocols evaluated

| Priority | DEX | Chain | Feasibility | TVL | Key Advantage |
|----------|-----|-------|-------------|-----|---------------|
| 1 | GMX v2 | Arbitrum | **EASY** | $258M | Official TS SDK, 80+ integrations, full interface |
| 2 | gTrade (Gains Network) | Arbitrum | **EASY** | $24.7M | TS SDK, WebSocket, 270+ markets, no auth needed |
| 3 | ApeX Omni | zkLink X | **MEDIUM** | N/A | Full REST API with docs, WebSocket, 70+ markets |
| 4 | SynFutures v3 | Base | **MEDIUM** | N/A | TS SDK Q1 2025, orderbook hybrid, permissionless |
| 5 | MYX Finance v2 | Linea | **MEDIUM** | $21M | REST API, V2 gasless launch Feb 2026 |
| 6 | Synthetix Perps v3 | Base | **MEDIUM** | $210M | TS SDK, large TVL, but async keeper model |
| 7 | Perennial Finance v2 | Arbitrum | **MEDIUM** | ~$5-20M | TS SDK, subgraph, intent-based execution |
| 8 | Lighter | Custom ZK L2 | **MEDIUM** | $873M | #2 DEX, already in perp-cli, largest TVL |
| 9 | MUX Protocol v3 | Arbitrum | **HARD** | N/A | Aggregator, Chainlink Data Streams, no SDK |
| 10 | HMX Protocol | Arbitrum | **HARD** | ~$10-30M | 1000x leverage, $50B+ volume, no SDK |
| 11 | Polynomial | OP Superchain | **HARD** | N/A | Own L2, gasless, no public SDK |
| 12 | Vela Exchange | Arbitrum | **HARD** | Low | On-chain CLOB, no SDK, reduced activity |
| 13 | Derivio | zkSync Era | **HARD** | Minimal | Low activity, zkSync Lite deprecating |

---

## [FINDING] Interface Compatibility Matrix (Active DEXes with SDK/API)

[STAT:n] Operations evaluated: 18 interface methods across top 8 implementable DEXes

| Interface Method | GMX v2 | gTrade | Synthetix v3 | ApeX Omni | SynFutures v3 | MYX v2 | Perennial v2 | Lighter |
|---|---|---|---|---|---|---|---|---|
| getMarkets() | YES | YES | YES | YES | YES | YES | YES | YES |
| getOrderbook() | PARTIAL | NO | NO | YES | YES | NO | NO | YES |
| getRecentTrades() | YES | YES | YES | YES | YES | YES | VIA SG | YES |
| getFundingHistory() | YES | YES | YES | YES | PARTIAL | PARTIAL | VIA SG | YES |
| getKlines() | YES | 3RD | VIA PYTH | YES | PARTIAL | PARTIAL | VIA SG | PARTIAL |
| getBalance() | YES | YES | YES | YES | YES | YES | YES | YES |
| getPositions() | YES | YES | YES | YES | YES | YES | YES | YES |
| getOpenOrders() | YES | YES | YES | YES | YES | YES | YES | YES |
| getOrderHistory() | YES | YES | YES | YES | VIA SG | VIA API | VIA SG | YES |
| getTradeHistory() | YES | YES | YES | YES | VIA SG | VIA API | VIA SG | YES |
| getFundingPayments() | YES | YES | YES | YES | PARTIAL | PARTIAL | VIA SG | YES |
| marketOrder() | YES | YES | KEEPER | YES | YES | YES | SOLVER | YES |
| limitOrder() | YES | YES | KEEPER | YES | YES | YES | SOLVER | YES |
| editOrder() | YES | YES | LIMITED | YES | LIMITED | LIMITED | LIMITED | YES |
| cancelOrder() | YES | YES | YES | YES | YES | YES | YES | YES |
| cancelAllOrders() | YES | YES | PARTIAL | YES | PARTIAL | PARTIAL | PARTIAL | YES |
| setLeverage() | YES | YES | YES | YES | IMPLICIT | YES | IMPLICIT | YES |
| stopOrder() | YES | YES | KEEPER | YES | LIMITED | LIMITED | SOLVER | LIMITED |

Legend: SG = Subgraph (GraphQL), 3RD = Third-party API, KEEPER = async keeper settlement, SOLVER = intent-based solver

---

## [LIMITATION]
1. **Data staleness**: TVL and volume figures from DefiLlama reflect early 2026 snapshots; real-time values fluctuate significantly.
2. **SDK completeness unknown**: SDK coverage for MEDIUM-rated DEXes verified by documentation claims, not live testing. Actual method availability may differ.
3. **Orderbook coverage**: Most EVM L2 DEXes use oracle/AMM pricing, not CLOB — `getOrderbook()` is structurally unsupported in ~60% of protocols.
4. **Keeper/solver latency**: Synthetix v3 and Perennial v2 use async execution models — `marketOrder()` is not instant; settlement requires keeper execution which adds latency.
5. **Chain viability**: zkSync Lite is being deprecated in 2026; Blast activity dropped significantly after SynFutures and Vertex migrated away.
6. **Vertex loss**: Vertex Protocol was the best-documented hybrid DEX with 15ms latency; its shutdown (Aug 2025) removed the clearest EASY integration target on Arbitrum aside from GMX.
7. **Lighter SDK gap**: Despite being #2 by TVL and active addresses, Lighter has no official TS SDK — only REST/WebSocket APIs. Integration is feasible but requires manual client implementation.

---

## Figures
- `/Users/hik/Documents/GitHub/perp-cli/.omc/scientist/figures/perp_dex_landscape.svg` — Feasibility distribution, chain breakdown, TVL snapshot

---

*Sources: DefiLlama, GMX Docs, Gains Network Docs, Synthetix Docs, SynFutures Docs, Perennial SDK docs, ApeX API docs, MYX Finance GitBook, npm registry, GitHub, web search (March 2026)*
