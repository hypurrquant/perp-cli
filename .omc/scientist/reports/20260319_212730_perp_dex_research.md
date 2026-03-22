# Perpetual DEX Research Report — March 2026

**Objective:** Research appchain, hybrid, and off-chain perpetual DEXes for potential integration into perp-cli's ExchangeAdapter interface.

**Date:** 2026-03-19 21:27 UTC
**Analyst:** Scientist Agent (oh-my-claudecode)

---

## [OBJECTIVE]

Identify and evaluate perpetual futures DEXes that operate their own chain (appchain), off-chain matching engine, or hybrid infrastructure for integration feasibility against the ExchangeAdapter interface in perp-cli.

The 16 adapter methods evaluated:
- **Market data:** `getMarkets()`, `getOrderbook()`, `getRecentTrades()`, `getFundingHistory()`, `getKlines()`
- **Account:** `getBalance()`, `getPositions()`, `getOpenOrders()`, `getOrderHistory()`, `getTradeHistory()`, `getFundingPayments()`
- **Trading:** `marketOrder()`, `limitOrder()`, `editOrder()`, `cancelOrder()`, `cancelAllOrders()`, `setLeverage()`, `stopOrder()`

---

## [DATA]

- **DEXes analyzed:** 12
- **Excluded (already supported):** Drift/Pacifica, Hyperliquid, Lighter
- **Data sources:** Official documentation, GitHub repositories, npm packages, DefiLlama, web search (March 2026)
- **Feasibility ratings:** EASY = official TS SDK + REST+WS; MEDIUM = API available but incomplete/no TS SDK; HARD = no SDK, complex architecture or low viability

**[STAT:n]** n = 12 DEXes across 8 distinct chain architectures

---

## [FINDING 1] Three DEXes are immediately integrable (EASY tier)

dYdX v4, Orderly Network, and Bluefin all have official TypeScript SDKs, comprehensive REST+WS APIs, and all 16 adapter methods are implementable with moderate effort.

**[STAT:n]** n = 3 out of 12 (25%) DEXes are EASY tier
**[STAT:effect_size]** EASY-tier DEXes account for $1,300M/day combined estimated volume (dYdX $800M + Orderly $300M + Bluefin $200M)

---

## [FINDING 2] Five DEXes are MEDIUM feasibility — require custom API work

Paradex, ApeX Protocol, Aevo, SynFutures v3, and Backpack Exchange have REST/WS APIs but lack TypeScript SDKs, require specialized signing (STARK, EIP-712, Sui), or have architectural differences that add complexity.

**[STAT:n]** n = 5 out of 12 (42%) DEXes are MEDIUM tier
**[STAT:effect_size]** Paradex alone has $2,100M estimated daily volume — the largest of any non-supported DEX

---

## [FINDING 3] Four DEXes are not practical to integrate (HARD tier)

RabbitX, Perpetual Protocol (sunsetting), LogX, and IntentX/Carbon either have no SDK, very low volume, are in architectural transition, or have fundamentally incompatible design patterns.

**[STAT:n]** n = 4 out of 12 (33%) DEXes are HARD tier
**[STAT:effect_size]** Combined volume of HARD-tier DEXes: ~$65M/day — <2% of analyzed universe

---

## [FINDING 4] TypeScript SDK coverage is low industry-wide

Only 3 of 12 DEXes (25%) offer an official TypeScript/JavaScript SDK on npm. The majority rely on Python SDKs or raw API access. This is a key integration friction point.

**[STAT:n]** TS SDK available: 3/12 (25%)
**[STAT:n]** REST API available: 11/12 (92%)
**[STAT:n]** WebSocket feeds: 8/12 (67%)
**[STAT:n]** npm package (any language): 7/12 (58%)

---

## Detailed DEX Profiles

### dYdX v4 — `EASY`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | Cosmos Appchain — Sovereign L1 (Cosmos SDK) |
| **TVL** | $400M |
| **Est. Daily Volume** | $800M |
| **TypeScript SDK** | YES |
| **REST API** | YES |
| **WebSocket** | YES |
| **npm package** | `@dydxprotocol/v4-client-js` |
| **Max Leverage** | 20x |
| **Assets** | 100+ |

**Notes:** Official TS SDK (`@dydxprotocol/v4-client-js`). Full REST Indexer + WebSocket feeds. Composite client covers all operations. Detailed documentation at docs.dydx.exchange. The Indexer provides off-chain data (orderbooks, trades, candles, funding) while on-chain queries go through gRPC. All 16 adapter methods are directly implementable.

**Adapter method coverage:** getMarkets ✓, getOrderbook ✓, getRecentTrades ✓, getFundingHistory ✓, getKlines ✓, getBalance ✓, getPositions ✓, getOpenOrders ✓, getOrderHistory ✓, getTradeHistory ✓, getFundingPayments ✓, marketOrder ✓, limitOrder ✓, editOrder ✓, cancelOrder ✓, cancelAllOrders ✓, setLeverage ✓, stopOrder ✓

---

### Orderly Network — `EASY`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | NEAR Omnichain Infra — Omnichain CLOB Infra |
| **TVL** | $100M |
| **Est. Daily Volume** | $300M |
| **TypeScript SDK** | YES |
| **REST API** | YES |
| **WebSocket** | YES |
| **npm package** | `@orderly.network/orderly-sdk` |
| **Max Leverage** | 50x |
| **Assets** | 133+ |

**Notes:** Official TypeScript SDK (`@orderly.network/orderly-sdk` on npm). Full REST+WS. Omnichain infrastructure — same API works across EVM, Solana, and NEAR chains. Multi-collateral support. Builder-friendly: saves 200+ hours per integration claim. `@orderly.network/orderly-sdk` is the primary entry point. All operations covered.

**Adapter method coverage:** getMarkets ✓, getOrderbook ✓, getRecentTrades ✓, getFundingHistory ✓, getKlines ✓, getBalance ✓, getPositions ✓, getOpenOrders ✓, getOrderHistory ✓, getTradeHistory ✓, getFundingPayments ✓, marketOrder ✓, limitOrder ✓, editOrder ✓, cancelOrder ✓, cancelAllOrders ✓, setLeverage ✓, stopOrder ✓

---

### Bluefin — `EASY`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | Sui Blockchain — Off-chain CLOB + Sui |
| **TVL** | $84M |
| **Est. Daily Volume** | $200M |
| **TypeScript SDK** | YES |
| **REST API** | YES |
| **WebSocket** | YES |
| **npm package** | `@bluefin-exchange/bluefin-v2-client` |
| **Max Leverage** | 20x |
| **Assets** | 50+ |

**Notes:** Official TypeScript SDK (`@bluefin-exchange/bluefin-v2-client` on npm, `bluefin-v2-client-ts` on GitHub). Full REST+WS documented. Sui wallet signing (ed25519). Off-chain CLOB with 30ms latency, <500ms on-chain finality. $84M TVL, strong growth in 2025. Backpack wallet natively integrates Bluefin. All operations implementable.

**Adapter method coverage:** getMarkets ✓, getOrderbook ✓, getRecentTrades ✓, getFundingHistory ✓, getKlines ✓, getBalance ✓, getPositions ✓, getOpenOrders ✓, getOrderHistory ✓, getTradeHistory ✓, getFundingPayments ✓, marketOrder ✓, limitOrder ✓, editOrder ✓, cancelOrder ✓, cancelAllOrders ✓, setLeverage ✓, stopOrder ✓

---

### Paradex — `MEDIUM`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | Starknet Appchain — ZK Appchain |
| **TVL** | $176M |
| **Est. Daily Volume** | $2,100M |
| **TypeScript SDK** | NO |
| **REST API** | YES |
| **WebSocket** | YES |
| **npm package** | `paradex-py (Python)` |
| **Max Leverage** | 50x |
| **Assets** | 100+ |

**Notes:** Python SDK (`paradex-py`) is the only official SDK. REST + WebSocket API well-documented at docs.paradex.trade. Authentication requires STARK key signing (Starknet ECDSA), which adds implementation complexity in TypeScript. Must use raw HTTP/WS calls. All data endpoints available. Paradex is growing fast ($2.1B avg daily vol in Season 2).

**Adapter method coverage:** getMarkets ✓, getOrderbook ✓, getRecentTrades ✓, getFundingHistory ✓, getKlines ~, getBalance ✓, getPositions ✓, getOpenOrders ✓, getOrderHistory ✓, getTradeHistory ✓, getFundingPayments ✓, marketOrder ✓ (via REST), limitOrder ✓, editOrder ~, cancelOrder ✓, cancelAllOrders ✓, setLeverage ✓, stopOrder ~

---

### Backpack Exchange — `MEDIUM`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | Solana (CEX) — CEX + Solana settlement |
| **TVL** | N/A (CEX) |
| **Est. Daily Volume** | $747M |
| **TypeScript SDK** | NO |
| **REST API** | YES |
| **WebSocket** | YES |
| **npm package** | `bpx-api-client (Rust/Python)` |
| **Max Leverage** | 50x |
| **Assets** | 100+ |

**Notes:** CEX (not DEX). Regulated exchange (VARA Dubai license, CySEC). Official API at docs.backpack.exchange. Rust official client (`bpx-api-client`), Python community SDK. No TypeScript SDK but REST is well-documented. $747M avg daily vol; 94% perps. Note: centralized custody despite 'self-custodial wallet' marketing. Acquired FTX EU Jan 2025.

**Adapter method coverage:** getMarkets ✓, getOrderbook ✓, getRecentTrades ✓, getFundingHistory ✓, getKlines ✓, getBalance ✓, getPositions ✓, getOpenOrders ✓, getOrderHistory ✓, getTradeHistory ✓, getFundingPayments ✓, marketOrder ✓, limitOrder ✓, editOrder ✓, cancelOrder ✓, cancelAllOrders ✓, setLeverage ✓, stopOrder ✓

---

### SynFutures v3 — `MEDIUM`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | Base + Blast (EVM) — Oyster AMM (on-chain) |
| **TVL** | $50M |
| **Est. Daily Volume** | $300M |
| **TypeScript SDK** | NO |
| **REST API** | YES |
| **WebSocket** | NO |
| **npm package** | `oyster-api (self-host)` |
| **Max Leverage** | 20x |
| **Assets** | 300+ |

**Notes:** Oyster AMM (oAMM) model: hybrid on-chain orderbook + concentrated liquidity AMM. No off-chain matching — everything on-chain. `oyster-api` GitHub repo provides a self-hostable query service. No real-time WS feeds documented. Interaction primarily via EVM smart contracts. $73.8B volume in 2025 on Base. Permissionless market creation (300+ assets). V4 redesign in progress for 2026.

**Adapter method coverage:** getMarkets ✓ (subgraph/RPC), getOrderbook ~ (RPC), getRecentTrades ~ (subgraph), getFundingHistory ✓ (on-chain), getKlines ~ (subgraph), getBalance ✓, getPositions ✓ (contract call), getOpenOrders ~ (on-chain), getOrderHistory ~ (subgraph), getTradeHistory ~ (subgraph), getFundingPayments ~ (on-chain), marketOrder ✓ (contract), limitOrder ✓ (contract), editOrder ~, cancelOrder ✓, cancelAllOrders ~, setLeverage ✓, stopOrder ~

---

### ApeX Protocol — `MEDIUM`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | StarkEx (ZK-Rollup) — ZK-Rollup (StarkEx) |
| **TVL** | $38M |
| **Est. Daily Volume** | $50M |
| **TypeScript SDK** | NO |
| **REST API** | YES |
| **WebSocket** | YES |
| **npm package** | `apexpro-openapi (Python)` |
| **Max Leverage** | 50x |
| **Assets** | 100+ |

**Notes:** Python SDK (`apexpro-openapi` on GitHub). REST+WS documented at api-docs.pro.apex.exchange. Uses StarkEx stark-curve ECDSA signing. No official TypeScript SDK; would need to port signing logic. Portfolio margin (Feb 2025) and Chainlink integration (Nov 2025) are notable features. TVL small (~$38M) but active orderbook.

**Adapter method coverage:** getMarkets ✓, getOrderbook ✓, getRecentTrades ✓, getFundingHistory ✓, getKlines ✓, getBalance ✓, getPositions ✓, getOpenOrders ✓, getOrderHistory ✓, getTradeHistory ✓, getFundingPayments ✓, marketOrder ✓, limitOrder ✓, editOrder ✓, cancelOrder ✓, cancelAllOrders ✓, setLeverage ✓, stopOrder ✓

---

### Aevo — `MEDIUM`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | OP Stack Rollup — Custom OP Stack L2 |
| **TVL** | $31M |
| **Est. Daily Volume** | $12M |
| **TypeScript SDK** | NO |
| **REST API** | YES |
| **WebSocket** | YES |
| **npm package** | `aevo-sdk (Python)` |
| **Max Leverage** | 10x |
| **Assets** | 100+ |

**Notes:** Python SDK (`aevo-sdk` on GitHub). REST+WS at api-docs.aevo.xyz. All signed orders via EIP-712 or custom signing. Supports perps + options + pre-launch trading. Volume has declined significantly in 2025-2026 (~$12M daily). Platform activity low and there may be sunset risk. Custom OP Stack chain.

**Adapter method coverage:** getMarkets ✓, getOrderbook ✓, getRecentTrades ✓, getFundingHistory ✓, getKlines ✓, getBalance ✓ (GET /account), getPositions ✓ (GET /positions), getOpenOrders ✓, getOrderHistory ✓, getTradeHistory ✓, getFundingPayments ✓, marketOrder ✓, limitOrder ✓, editOrder ✓, cancelOrder ✓, cancelAllOrders ✓, setLeverage ✓, stopOrder ✓

---

### LogX — `HARD`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | Multi-chain — Multi-chain Aggregator |
| **TVL** | $5M |
| **Est. Daily Volume** | $30M |
| **TypeScript SDK** | NO |
| **REST API** | YES |
| **WebSocket** | NO |
| **npm package** | `—` |
| **Max Leverage** | 50x |
| **Assets** | 100+ |

**Notes:** Multi-chain aggregator. LogX Pro uses Orderly Network as backend — direct Orderly integration is preferable. LogX OG uses self-pool model. No official SDK. $17B+ total lifetime volume. Backed by Sequoia Capital and Coinbase Ventures. Low documentation quality for direct integration.

**Adapter method coverage:** Better to integrate Orderly Network directly. LogX-specific methods require custom implementation.

---

### RabbitX — `HARD`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | Starknet — Off-chain + Starknet |
| **TVL** | $15M |
| **Est. Daily Volume** | $20M |
| **TypeScript SDK** | NO |
| **REST API** | YES |
| **WebSocket** | YES |
| **npm package** | `—` |
| **Max Leverage** | 50x |
| **Assets** | 100+ |

**Notes:** No official SDK (TypeScript or Python). REST API exists but documentation is sparse. Starknet ECDSA signing required. Small protocol (~$20M daily vol). Low integration priority given lack of SDK and small market size. StarkNet off-chain hybrid model.

**Adapter method coverage:** getMarkets ~, getOrderbook ~, getRecentTrades ~, getFundingHistory ?, getKlines ?, getBalance ~, getPositions ~, getOpenOrders ~, getOrderHistory ?, getTradeHistory ?, getFundingPayments ?, marketOrder ~ (raw REST), limitOrder ~ (raw REST), editOrder ?, cancelOrder ~, cancelAllOrders ?, setLeverage ?, stopOrder ?

---

### IntentX/Carbon — `HARD`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | Multi-chain (EVM) — Intent-based (SYMMIO) |
| **TVL** | $6M |
| **Est. Daily Volume** | $10M |
| **TypeScript SDK** | NO |
| **REST API** | YES |
| **WebSocket** | NO |
| **npm package** | `—` |
| **Max Leverage** | 50x |
| **Assets** | 315+ |

**Notes:** Intent-based architecture via SYMMIO settlement layer. Solvers compete to fulfill trades. 315+ pairs including exotic assets. Transitioning to Carbon protocol in 2026. No official SDK. The intent architecture is fundamentally different from standard orderbook adapters — getOrderbook() and similar concepts don't map cleanly. Very low volume (~$10M daily).

**Adapter method coverage:** Architecture mismatch: intent submission != limit order. Standard adapter interface incompatible. NOT RECOMMENDED for current integration.

---

### Perpetual Protocol — `HARD`

| Field | Value |
|-------|-------|
| **Chain / Architecture** | Optimism — vAMM (Uniswap v3) |
| **TVL** | $10M |
| **Est. Daily Volume** | $5M |
| **TypeScript SDK** | NO |
| **REST API** | NO |
| **WebSocket** | NO |
| **npm package** | `—` |
| **Max Leverage** | 10x |
| **Assets** | 30+ |

**Notes:** v2 (Curie) is being sunset in 2026. v3 Smart Liquidity Framework announced but in early development. No REST API or official SDK. Smart contract interaction only via Ethereum/Optimism. Binance delisted PERP token Nov 2025. Very low volume (<$5M daily). Not recommended for integration — protocol is in transition/declining.

**Adapter method coverage:** All methods: contract-only, no API. NOT RECOMMENDED for integration.

---

## Integration Priority Recommendations

### Tier 1 — Integrate Next (EASY, high volume)

1. **dYdX v4** (`@dydxprotocol/v4-client-js`) — Largest Cosmos appchain perp DEX, $800M+ daily, full TS SDK
2. **Orderly Network** (`@orderly.network/orderly-sdk`) — Omnichain infrastructure, $300M+ daily, full TS SDK, 133+ markets
3. **Bluefin** (`@bluefin-exchange/bluefin-v2-client`) — Sui-based, $200M+ daily, full TS SDK, 30ms latency

### Tier 2 — Integrate with Moderate Effort (MEDIUM, high volume)

4. **Paradex** — Highest volume of non-EASY tier ($2.1B daily), Starknet appchain, Python SDK + raw REST/WS. Worth the STARK signing complexity given volume.
5. **Backpack Exchange** — $747M daily, clean REST API, straightforward endpoints. Caveat: CEX not DEX.
6. **SynFutures v3** — $300M daily, Base chain, EVM contract interactions. oAMM model requires different approach than orderbook.
7. **ApeX Protocol** — $50M daily, StarkEx, Python SDK available. STARK signing complexity.

### Tier 3 — Low Priority (MEDIUM/HARD, lower volume)

8. **Aevo** — $12M daily (declining), Python SDK available, sunset risk
9. **RabbitX** — $20M daily, no SDK, sparse docs
10. **LogX** — Better integrated via Orderly Network backend directly
11. **IntentX/Carbon** — Architecture mismatch with standard adapter interface
12. **Perpetual Protocol** — Sunsetting v2, v3 in early development — skip

---

## [LIMITATION]

1. **Volume estimates are approximate:** Daily volume figures are estimates from web searches, review articles, and DefiLlama summaries (not live API calls). Actual figures fluctuate significantly day-to-day.
2. **TVL data may be stale:** TVL figures referenced are from recent reports but may not reflect exact values at report time.
3. **SDK documentation completeness unverified:** Method coverage assessments are based on publicly available documentation; actual API completeness requires hands-on integration testing.
4. **Paradex DIME TGE uncertainty:** Post-TGE tokenomics may affect Paradex's incentive structure and volume.
5. **Aevo sunset risk:** Aevo's volume decline and gated access raise questions about long-term viability; integration effort may not be justified.
6. **SynFutures v4 transition:** v3 is being replaced by v4 in 2026; integration effort may need to be repeated.
7. **Backpack CEX classification:** Backpack is technically a centralized exchange; it does not fit the "DEX with own chain" framing, though its API surface is DEX-compatible.

---

## Figures

- `fig1_volume_comparison.png` — Daily volume bar chart by DEX, color-coded by feasibility
- `fig2_feature_matrix.png` — Integration feature matrix (TS SDK, REST, WS, npm, feasibility)
- `fig3_summary_stats.png` — Feasibility distribution + API coverage summary

---

*Report generated by oh-my-claudecode Scientist agent on {datetime.now().strftime('%Y-%m-%d')}*
