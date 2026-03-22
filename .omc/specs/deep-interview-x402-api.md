# Deep Interview Spec: x402 Paid API (Cloudflare Workers)

## Metadata
- Interview ID: perpcli-x402-005
- Rounds: 4
- Final Ambiguity Score: 19.0%
- Type: brownfield
- Generated: 2026-03-19
- Threshold: 20%
- Status: PASSED

## Goal
perp-cli의 MCP 도구들을 x402 프로토콜로 수익화하는 Cloudflare Workers API 서버를 별도 레포에 구축한다.
CDP Facilitator가 결제 검증/정산을 처리하고, 모든 엔드포인트는 per-call 유료.

## Constraints
- **별도 레포** (perp-api 또는 유사 이름) — perp-cli 레포가 아님
- **Cloudflare Workers** 배포 — Hono 프레임워크
- **x402 프로토콜** — `@x402/hono` 미들웨어
- **CDP Facilitator** — 결제 검증/정산 위임
- **Base 체인 USDC** — 초기 결제 수단
- **전체 유료** (per-call) — 무료 티어 없음
- perp-cli를 백엔드로 사용 (CLI 또는 직접 어댑터 임포트)

## Non-Goals
- MPP 지원 (Phase 2)
- 무료 티어 / rate limiting
- 사용자 인증 시스템 (x402가 대체)
- 프론트엔드 UI

## Acceptance Criteria
- [ ] Cloudflare Workers 프로젝트 (Hono + x402 미들웨어)
- [ ] 거래소 시장 데이터 엔드포인트 (markets, orderbook, prices, funding rates)
- [ ] 포트폴리오/포지션 엔드포인트 (balance, positions, portfolio)
- [ ] 트레이딩 엔드포인트 (trade preview, execute, close)
- [ ] 분석 엔드포인트 (funding analysis, pnl, arb scan, arb compare)
- [ ] 모든 엔드포인트에 x402 paywall 적용
- [ ] CDP Facilitator 연동 (Base USDC)
- [ ] wrangler deploy 가능
- [ ] README with setup guide

## Technical Context

### 아키텍처
```
AI Agent / Client
    │
    │ HTTP + x402 Payment Header
    ▼
Cloudflare Workers (Hono)
    │
    │ @x402/hono middleware
    │ → CDP Facilitator (verify/settle)
    │
    ▼
perp-cli adapters (HL, PAC, LT)
    │
    ▼
Exchange APIs
```

### 엔드포인트 설계
```
GET  /markets/:exchange          → get_markets
GET  /orderbook/:exchange/:symbol → get_orderbook
GET  /prices                     → get_prices
GET  /funding-rates              → get_funding_rates
GET  /balance/:exchange          → get_balance
GET  /positions/:exchange        → get_positions
GET  /portfolio                  → portfolio
POST /trade/preview              → trade_preview
POST /trade/execute              → trade_execute
POST /trade/close                → trade_close
GET  /analytics/funding          → get_funding_analysis
GET  /analytics/pnl              → get_pnl_analysis
GET  /analytics/arb-scan         → arb_scan
GET  /analytics/arb-compare      → get_arb_compare
GET  /health                     → health_check
```

### x402 가격 (초기)
- 시장 데이터: $0.001/call
- 계정 데이터: $0.005/call
- 트레이딩: $0.01/call
- 분석: $0.005/call

### 수익 레이어
1. Referral codes (DEX 레벨) — 기존
2. x402 per-call (API 레벨) — 이번 구현
3. MPP session (향후) — Phase 2
