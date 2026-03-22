# Deep Interview Spec: v0.7.1 Pre-Release QA

## Metadata
- Interview ID: v071-qa-20260322
- Rounds: 3
- Final Ambiguity Score: 15%
- Type: brownfield
- Generated: 2026-03-22
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.90 | 0.35 | 0.315 |
| Constraint Clarity | 0.85 | 0.25 | 0.213 |
| Success Criteria | 0.85 | 0.25 | 0.213 |
| Context Clarity | 0.75 | 0.15 | 0.113 |
| **Total Clarity** | | | **0.853** |
| **Ambiguity** | | | **14.7%** |

## Goal
v0.7.1 릴리즈 전, perp-cli의 모든 핵심 기능을 실제 거래소 API를 호출하는 E2E 시나리오 테스트로 검증한다. 유닛 테스트가 아닌 실제 사용자가 CLI를 쓰는 것과 동일한 방식으로 테스트하여 프로젝트 품질을 보장한다.

## Constraints
- 실제 주문이 체결되지 않도록 시장가 대비 충분히 낮은 가격에 limit order 사용
- 거래소당 10-20개 대표 자산 샘플링 (전체 자산 아님)
- 3개 거래소: Hyperliquid (HL), Pacifica (PAC), Lighter (LT)
- Perp + Spot (HL spot, LT spot) 모두 포함
- 비거래 CLI 커맨드 (market, account, arb, funding 등) 출력값 검증 포함
- 봇 전략은 이번 QA 범위에서 제외 (별도 진행)
- 현재 브랜치 `feat/bot-engine-v2`에서 테스트
- 기존 941 유닛 테스트는 별도로 전부 통과 확인

## Non-Goals
- 봇 전략 19개 라이브 테스트 (별도 QA)
- 새 DEX 브랜치 (aster, paradex, extended, ostium, nado) 테스트
- 부하 테스트 / 성능 테스트
- 실제 체결되는 주문 테스트

## Acceptance Criteria

### Phase 1: Build & Unit Tests
- [ ] `pnpm build` — tsc 에러 0개
- [ ] `pnpm test` — 기존 유닛 테스트 전체 통과 (941+)

### Phase 2: CLI 커맨드 출력 검증 (비거래)
- [ ] `perp market list` — 3개 거래소 각각 마켓 목록 출력 (에러 없음)
- [ ] `perp market price <symbol>` — 가격 조회 성공
- [ ] `perp account` — 3개 거래소 잔고 조회 성공
- [ ] `perp arb scan` — 아비트라지 스캔 결과 출력
- [ ] `perp market funding` — 펀딩레이트 조회 성공
- [ ] `perp positions` / `perp orders` — 포지션/주문 조회 성공
- [ ] JSON 출력 모드 (`--json`) 정상 동작

### Phase 3: Perp 주문/취소 E2E (거래소별 대표 자산)
- [ ] HL perp: 10-20개 대표 자산 — limit order(낮은 가격) → 주문 확인 → cancel → 취소 확인
- [ ] PAC perp: 10-20개 대표 자산 — 동일 플로우
- [ ] LT perp: 10-20개 대표 자산 — 동일 플로우
- [ ] 모든 주문의 최소 notional ($12+) 준수 확인
- [ ] 모든 decimal/precision이 API 기반 동적 조회 확인

### Phase 4: Spot 주문/취소 E2E
- [ ] HL spot: 대표 자산 (ETH, HYPE, PURR 등) — limit order → cancel 플로우
- [ ] LT spot: 대표 자산 (ETH, LINK, AAVE 등) — limit order → cancel 플로우
- [ ] Spot decimal auto-rounding 정상 동작

### Phase 5: 결과값 비교 (Cross-Validation)
- [ ] 거래소별 잔고 조회 결과가 거래소 웹/API 직접 조회와 일치
- [ ] 가격 데이터가 합리적 범위 내 (실시간 시세 ±5%)
- [ ] 포지션 데이터 정확성 검증

### QA Gate
- 모든 acceptance criteria 통과 필수
- 실패 시 원인 수정 후 재테스트
- 수정 불가능한 외부 이슈(거래소 다운 등)는 문서화 후 skip 허용

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| "모든 자산" 테스트 필요 | 전체 자산 vs 샘플링 | 거래소당 10-20개 대표 자산 샘플링 |
| 봇 전략도 포함 | QA 범위 확인 | 봇은 별도 QA, 이번은 코어 기능만 |
| spot도 포함 | 이전 세션에서 spot 검증 완료 여부 | 포함 — 완전한 커버리지 위해 |

## Technical Context
- 프로젝트: /Users/hik/Documents/GitHub/perp-cli
- 브랜치: feat/bot-engine-v2
- 거래소 어댑터: src/exchanges/ (HL, PAC, LT perp + HL, LT spot)
- CLI 커맨드: src/commands/ (21개)
- 테스트: vitest, 61 test files (44 unit + 17 integration)
- 빌드: pnpm build (tsup)
- 환경변수: ~/.perp/.env (API keys)

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| CLI Command | core domain | name, exchange, outputFormat | executes via ExchangeAdapter |
| Exchange Adapter | core domain | name (HL/PAC/LT), type (perp/spot) | provides API access |
| Asset | core domain | symbol, minNotional, sizeDecimals, priceDecimals | traded on Exchange |
| Order | core domain | type (limit), price, size, status, orderId | placed on Asset via Adapter |
| Test Scenario | supporting | steps, exchange, assets, passStatus | validates Order lifecycle |
| QA Gate | supporting | allPassed, failures, fixCount | aggregates Test Scenarios |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 6 | 6 | - | - | N/A |
| 2 | 6 | 0 | 0 | 6 | 100% |
| 3 | 6 | 0 | 0 | 6 | 100% |

## Interview Transcript
<details>
<summary>Full Q&A (3 rounds)</summary>

### Round 1
**Q:** "실제 사용하는 것에 대한 테스트"에서 어느 범위까지를 말하는 건가요? CLI 커맨드를 실행해서 출력값을 확인하는 수준인지, 아니면 실제 거래소 API를 호출해서 주문을 넣고 취소하는 라이브 테스트까지 포함하는 건가요?
**A:** E2E 시나리오 테스트를 하는데 실제 주문이 체결되게는 하지 않아도 되고 낮은 값에 주문 걸고 취소하는 것까지 하는 걸로 진행해주고 이거 주문할 수 있는 모든 자산에 대해서 모두 테스트해서 성공하는 것을 확인하는 것을 테스트 규칙으로 두고 이걸 통과하지 못하면 통과할때까지 수정하는걸로 하자
**Ambiguity:** 27% (Goal: 0.85, Constraints: 0.50, Criteria: 0.80, Context: 0.70)

### Round 2
**Q:** "모든 자산"의 범위를 명확히 하고 싶습니다. 현재 3개 거래소(HL, PAC, LT)의 perp + HL/LT spot이 있고, 봇 전략 19개도 있습니다. QA 범위에 포함할 것을 선택해주세요.
**A:** 대표 자산 샘플링 (거래소당 10-20개)
**Ambiguity:** 21% (Goal: 0.85, Constraints: 0.75, Criteria: 0.80, Context: 0.70)

### Round 3
**Q:** QA 테스트에 주문/취소 외에 비거래 CLI 커맨드(market data 조회, account 잔고, arb scan, funding rates 등)도 포함할까요? 그리고 spot 어댑터(HL/LT spot)도 테스트 범위에 포함하나요?
**A:** perp 주문 + 전체 CLI + spot (Recommended)
**Ambiguity:** 15% (Goal: 0.90, Constraints: 0.85, Criteria: 0.85, Context: 0.75)

</details>
