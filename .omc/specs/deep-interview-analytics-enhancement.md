# Deep Interview Spec: Analytics Enhancement

## Metadata
- Interview ID: perpcli-features-001
- Rounds: 8
- Final Ambiguity Score: 17.0%
- Type: brownfield
- Generated: 2026-03-17
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.92 | 35% | 0.322 |
| Constraint Clarity | 0.75 | 25% | 0.188 |
| Success Criteria | 0.80 | 25% | 0.200 |
| Context Clarity | 0.80 | 15% | 0.120 |
| **Total Clarity** | | | **0.830** |
| **Ambiguity** | | | **17.0%** |

## Goal
기존 `perp analytics` 커맨드를 확장하여 3가지 분석 기능을 강화한다:
1. **펀딩 수익 누적 통계** — 거래소×심볼별 누적 금액, 일별 추이, 아비 포지션별 분해
2. **PnL 기간별 추이 분석** — 일별 PnL + 누적 그래프, 거래소별 분해
3. **전략/아비 성과 비교** — 활성 아비 포지션들의 수익률, 실현 PnL, 펀딩 수익을 한 테이블로 비교

## Constraints
- 추가 저장소(DB, 스냅샷 파일) 없이 기존 데이터만 활용
  - `execution-log.json` — 트레이드 기록
  - 거래소 API — `getFundingPayments()`, `getPositions()`, `getTradeHistory()`
  - `arb-state.json` — 아비 포지션 정보
- 기존 CLI 패턴 유지: 터미널 테이블 (기본) + `--json` (머신 리더블)
- 기본 지표만 (Sharpe ratio, MDD 등 고급 지표 불필요)
- 기존 `perp analytics` 커맨드를 확장/개선 (새 커맨드 그룹 생성 X)
- `--period <duration>` 옵션 추가 (7d, 30d, 90d, all)

## Non-Goals
- SQLite 등 별도 데이터베이스 도입
- 대시보드/차트 시각화 (web dashboard)
- CSV/PDF 내보내기
- 고급 통계 지표 (Sharpe, MDD, 승률)
- 새로운 커맨드 그룹 (perp report 등)

## Acceptance Criteria
- [ ] `perp analytics funding --period 30d` — 거래소×심볼별 누적 펀딩 수익 + 연환산 수익률 테이블
- [ ] `perp analytics funding --period 7d --daily` — 일별 펀딩 수익 추이 테이블
- [ ] `perp analytics funding --period 30d` — 아비 포지션별 펀딩 수익 분해 (long/short 거래소 표시)
- [ ] `perp analytics pnl --period 30d` — 일별 PnL + 누적 테이블, 거래소별 분해
- [ ] `perp analytics compare` — 활성 아비 포지션 성과 비교 테이블 (수익률, 실현PnL, 펀딩수익)
- [ ] 모든 커맨드에 `--json` 지원
- [ ] 모든 커맨드에 `--period` 옵션 (7d, 30d, 90d, all)
- [ ] 기존 `analytics summary` 커맨드 영향 없음
- [ ] 테스트 추가 (유닛 + 통합)

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 3개 영역 중 하나가 더 급함 | Contrarian: 어떤 게 가장 급해? | 세 개 다 동일 우선순위 |
| 고급 지표(Sharpe 등) 필요 | Simplifier: 기본만으로 충분? | 기본 지표면 충분 |
| 별도 DB 필요 | 데이터 축적 방식? | 기존 execution-log + API만 활용 |
| 새 커맨드 그룹 필요 | 기존 확장 vs 새로 만들기? | 기존 analytics 확장 + --period 추가 |

## Technical Context
### 기존 코드 구조
- `src/commands/account.ts` — `analytics summary/pnl/funding` 서브커맨드 등록
- `src/funding-rates.ts` — `fetchAllFundingRates()` 크로스 거래소 펀딩
- `src/funding-history.ts` — 펀딩 히스토리 유틸
- `src/execution-log.ts` — 트레이드 로깅/읽기
- `src/arb/arb-state.ts` — 아비 포지션 상태
- `src/arb/arb-history-stats.ts` — 아비 성과 통계
- `src/exchanges/interface.ts` — `getFundingPayments()`, `getTradeHistory()` 등

### 데이터 흐름
```
거래소 API (getFundingPayments) ──┐
                                  ├── analytics funding (누적/일별/포지션별)
arb-state.json ──────────────────┘

execution-log.json ──────────────── analytics pnl (일별/누적/거래소별)

arb-state.json + 거래소 API ──────── analytics compare (포지션 비교)
```

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| FundingIncome | core domain | exchange, symbol, amount, rate, timestamp | Aggregated per ArbPosition |
| PnLHistory | core domain | date, realizedPnl, unrealizedPnl, exchange | Derived from ExecutionLog |
| ArbPerformance | core domain | symbol, longEx, shortEx, roi, realizedPnl, fundingIncome | References ArbPosition |
| ExecutionLog | supporting | trades, timestamps, prices, sizes | Source for PnLHistory |
| AnalyticsReport | supporting | format (table/json), period, data | Output container |
| DailyFundingBreakdown | supporting | date, exchange, symbol, dailyAmount | Breakdown of FundingIncome |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 1 | 1 | - | - | N/A |
| 2 | 4 | 4 | - | - | N/A |
| 3 | 4 | 0 | 0 | 4 | 100% |
| 4 | 5 | 1 | 0 | 4 | 80% |
| 5 | 5 | 0 | 0 | 5 | 100% |
| 6 | 6 | 1 | 0 | 5 | 83% |
| 7 | 6 | 0 | 0 | 6 | 100% |
| 8 | 6 | 0 | 0 | 6 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (8 rounds)</summary>

### Round 1
**Q:** perp-cli를 사용하면서 가장 불편하거나, '이게 있었으면 좋겠다'고 느낀 순간이 있어?
**A:** 분석/리포팅 개선
**Ambiguity:** 76.5% (Goal: 0.40, Constraints: 0.10, Criteria: 0.10, Context: 0.30)

### Round 2
**Q:** 기존 analytics 중 가장 부족한 부분은?
**A:** 펌딩 수익 누적 통계, PnL 추이/기간별 분석, 전략/아비 성과 비교
**Ambiguity:** 63.2% (Goal: 0.65, Constraints: 0.15, Criteria: 0.20, Context: 0.35)

### Round 3
**Q:** 분석 데이터를 어떻게 축적하고 싶어?
**A:** 기존 데이터 활용 (추가 저장소 없이)
**Ambiguity:** 55.0% (Goal: 0.65, Constraints: 0.45, Criteria: 0.20, Context: 0.40)

### Round 4
**Q:** 분석 결과를 어떤 형태로 보고 싶어?
**A:** 터미널 테이블 + JSON
**Ambiguity:** 43.8% (Goal: 0.70, Constraints: 0.55, Criteria: 0.45, Context: 0.45)

### Round 5 [Contrarian]
**Q:** 3가지 중 지금 바로 쓰고 싶은 건 뭐야?
**A:** 세 개 다 똑같이 필요
**Ambiguity:** 40.0% (Goal: 0.75, Constraints: 0.60, Criteria: 0.45, Context: 0.50)

### Round 6 [Simplifier]
**Q:** 펀딩 수익 통계에서 구체적으로 어떤 지표를 보고 싶어?
**A:** 누적 + 일별 + 아비 포지션별 분해 전부
**Ambiguity:** 32.0% (Goal: 0.85, Constraints: 0.60, Criteria: 0.60, Context: 0.55)

### Round 7
**Q:** PnL/전략 비교에 고급 지표(Sharpe, MDD)도 필요해?
**A:** 기본 지표면 충분
**Ambiguity:** 23.3% (Goal: 0.90, Constraints: 0.70, Criteria: 0.75, Context: 0.60)

### Round 8
**Q:** 기존 analytics 확장 vs 새로 만들기?
**A:** 기존 확장 + --period 추가
**Ambiguity:** 17.0% (Goal: 0.92, Constraints: 0.75, Criteria: 0.80, Context: 0.80)

</details>
