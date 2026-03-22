# Deep Interview Spec: 실제 Funding Rate 트레이더 봇

## Metadata
- Rounds: 5
- Final Ambiguity Score: 19.9%
- Type: brownfield
- Generated: 2026-03-22
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.88 | 35% | 0.308 |
| Constraint Clarity | 0.78 | 25% | 0.195 |
| Success Criteria | 0.70 | 25% | 0.175 |
| Context Clarity | 0.82 | 15% | 0.123 |
| **Total Clarity** | | | **0.801** |
| **Ambiguity** | | | **19.9%** |

## Goal
실제 펀딩 레이트 트레이더의 사고방식을 그대로 구현한 완전 자동화 봇. 자본을 분할하여 두 모드를 동시 운영:
1. **Spot-Perp (안정형):** spot 매수 + perp short → 델타 뉴트럴, ~7% 연환산 펀딩 수익
2. **Perp-Perp (기회형):** 거래소간 펀딩 스프레드 포착 → 고수익, 스프레드 수렴시 청산

봇의 "생각" 프로세스:
```
1. 잔액/포지션 확인 → "내가 뭘 갖고 있지?"
2. 펀딩 레이트 스캔 → "어디에 기회가 있지?"
3. 비용 계산 → "진입 비용(수수료+슬리피지) vs 예상 수익?"
4. 리스크 체크 → "최대 손실 감당 가능?"
5. 진입 실행 → spot+perp 또는 perp+perp 동시 진입
6. 모니터링 → "스프레드 유지 중? 청산할까?"
7. 청산 → 스프레드 수렴 또는 리스크 한도 도달시 양쪽 동시 청산
```

## Constraints
- 자본: 현재 $73 (HL $19.7 + LT $11.6 + PAC $42.5) — 전부 사용 가능
- 분할 운영: 자본을 spot-perp와 perp-perp에 비율로 분배 (설정 가능)
- 자동 전환 안 함: 전환 비용(수수료+슬리피지) > 펀딩 수익이므로 분할이 현실적
- 설정 기반: 비율, 최소 스프레드, 최대 포지션 수 등 YAML/설정으로 관리
- 기존 인프라 활용: ExchangeAdapter + capability guards + strategy interface
- spot-perp는 HL/LT spot 어댑터 필요 (이미 존재: HyperliquidSpotAdapter, LighterSpotAdapter)
- Spot-perp ~7% annualized (안정적), Perp-perp 순간 고수익 (비지속적)

## Non-Goals
- 방향성 트레이딩 (delta neutral만)
- 레버리지 사용 (1x only, 리스크 최소화)
- 자동 전환 (분할 고정)
- 새 거래소 어댑터 개발 (기존 3개 사용)

## Acceptance Criteria
- [ ] `perp bot run funding-auto <symbol>` 또는 `perp bot funding-auto` 로 실행 가능
- [ ] Spot-perp 모드: spot 매수 + perp short 동시 진입, 델타 뉴트럴 유지
- [ ] Perp-perp 모드: 거래소간 롱/숏 동시 진입, 스프레드 수렴시 자동 청산
- [ ] 분할 운영: 자본 비율 설정(YAML)에 따라 양쪽 동시 운영
- [ ] 비용 체크: 진입 전 수수료+슬리피지 vs 예상 수익 비교
- [ ] 리스크 체크: 최대 손실 한도, 최대 포지션 수 제한
- [ ] TUI 대시보드에서 실시간 상태 표시
- [ ] fee 제외 순수익이 1주일 기준 양수 가능한 알고리즘
- [ ] 기존 941 테스트 통과 유지
- [ ] dry-run 모드로 실제 주문 없이 검증 가능

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 자동 전환이 가능하다 | 전환 비용 > 펀딩 수익 가능 | 분할 운영으로 변경 |
| spot-perp가 항상 수익적 | ~7%이지만 안정적 | 맞음, 기본 전략으로 적합 |
| perp-perp가 지속적 | 순간적이고 비지속적 | 기회형으로 분류, 빠른 진입/청산 |
| 리스크 한도를 고정해야 한다 | 잔액 전부 사용 가능 | YAML 설정으로 유연하게 |

## Technical Context
- 기존 funding 시스템: `src/funding/rates.ts` (3-DEX 비교), `normalize.ts` (시간당 정규화), `history.ts` (이력 추적)
- 기존 arb 시스템: `src/arb/` (포지션 관리, 상태 추적, 사이징)
- Spot 어댑터: `HyperliquidSpotAdapter`, `LighterSpotAdapter` (이미 존재)
- Strategy 인터페이스: `src/bot/strategy-types.ts` (Phase 0에서 생성됨)
- TUI: `src/bot/tui/BotDashboard.tsx` (이미 존재)
- 현재 잔액: HL $19.7, LT $11.6, PAC $42.5

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| FundingBot | core | mode, capital, status | manages SpotPerpLeg + PerpPerpLeg |
| SpotPerpLeg | core | spotExchange, perpExchange, symbol, spotSize, perpSize, entrySpread | part of FundingBot |
| PerpPerpLeg | core | longExchange, shortExchange, symbol, longSize, shortSize, entrySpread | part of FundingBot |
| CapitalAllocator | core | totalCapital, spotPerpRatio, perpPerpRatio, reserveRatio | allocates capital to Legs |
| FundingScanner | supporting | scanInterval, minSpread, exchanges | feeds opportunities to FundingBot |
| CostCalculator | supporting | fees, slippage, breakEvenHours | evaluates opportunity viability |
| RiskManager | supporting | maxLoss, maxPositions, maxPerPosition | gates FundingBot entries |

## Interview Transcript
<details>
<summary>Full Q&A (5 rounds)</summary>

### Round 1
**Q:** 펀딩 트레이더로서 가장 먼저 뭘 하고 싶으세요?
**A:** 완전 자동화 — 봇이 스캔→진입→관리→청산 전부 자동
**Ambiguity:** 61.8%

### Round 2
**Q:** 리스크 한도는?
**A:** 잔액 전부 사용 가능, 설정 기반. Spot-perp ~7% 안정, perp-perp 순간 고수익 비지속
**Ambiguity:** 46.3%

### Round 3
**Q:** 두 모드 운영 방식은?
**A:** 상황별 자동 전환
**Ambiguity:** 39.5%

### Round 4 (Contrarian)
**Q:** 자동 전환 비용이 수익보다 클 수 있는데?
**A:** 맞아, 분할 운영이 현실적
**Ambiguity:** 30.8%

### Round 5
**Q:** 성공 기준은?
**A:** 수익률 달성 (fee 제외 순수익 양수)
**Ambiguity:** 19.9%
</details>
