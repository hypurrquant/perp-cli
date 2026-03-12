# arb-auto 안정성 개선 기획서

> 브랜치: `feat/arb-auto`
> 작성일: 2026-03-13
> 대상 파일: `src/commands/arb-auto.ts`, `src/arb/state.ts`, `src/commands/arb/index.ts`

---

## 검증 결과 요약

| # | 이슈 | 검증 | 심각도 |
|---|------|------|--------|
| 1 | Entry 후 state 미저장 | **확인** | HIGH |
| 2 | Close 후 state 미삭제 | **확인** | HIGH |
| 3 | Funding rate 정규화 누락 | **확인** | MEDIUM |
| 4 | Close 시 양쪽 검증 없음 | **확인** | HIGH |
| 5 | Daemon↔CLI state 불일치 | **확인** | MEDIUM |
| 6 | setInterval 미정리 | **확인** | LOW |
| 7 | Rollback exception 전파 | **오탐** — 외부 try-catch가 잡음 | - |
| 8 | Critical margin 기존 포지션 | **오탐** — 의도된 설계 (진입만 차단) | - |
| 9 | Exchange down 감지 | **오탐** — 현재 구조에서 충분 | - |
| 10 | Settlement schedule 중복 | **확인** | LOW |
| 11 | TAKER_FEE 중복 (값 불일치) | **확인** | LOW |
| 12 | Size string/number 혼용 | **확인** | MEDIUM |
| 13 | Fill 수량 미검증 | **확인** | HIGH |
| 14 | Settle boost 미사용 | **확인** | MEDIUM |
| 15 | Spread 부호 손실 | **오탐** — abs()가 맞는 설계 | - |

**확인: 10건 / 오탐: 5건**

---

## 수정 계획

### Phase 1 — 돈 관련 버그 (HIGH)

#### 1-1. Entry 후 즉시 state 저장
- **현상**: `openPositions.push()` 후 `persistAddPosition()` 미호출. 크래시 시 거래소엔 포지션 있는데 추적 불가
- **위치**: `arb-auto.ts:827-837`
- **수정**: entry 성공 직후 `persistAddPosition()` 호출
```
openPositions.push(newPos)
persistAddPosition(newPos)  // ← 추가
```

#### 1-2. Close 후 즉시 state 삭제
- **현상**: `openPositions.splice()` 후 `persistRemovePosition()` 미호출. 재시작 시 닫힌 포지션 복구 시도
- **위치**: `arb-auto.ts:541`
- **수정**: splice 직전에 `persistRemovePosition()` 호출
```
persistRemovePosition(pos.symbol)  // ← 추가
openPositions.splice(i, 1)
```

#### 1-3. Close 양쪽 레그 검증
- **현상**: 순차 await로 long 청산 → short 청산. long 성공 후 short 실패 시에도 position splice 됨
- **위치**: `arb-auto.ts:501-541`
- **수정**:
  - `Promise.allSettled()`로 변경
  - 양쪽 성공 시에만 splice
  - 한쪽 실패 시 로그 + 재시도 (arb close의 retry 패턴 재사용)
  - 양쪽 실패 시 splice 하지 않음 (다음 사이클에서 재시도)

#### 1-4. Fill 수량 검증
- **현상**: marketOrder() 후 요청 사이즈를 그대로 기록. 부분 체결 감지 불가
- **위치**: `arb-auto.ts:728-831`
- **수정**:
  - entry 후 양쪽 거래소에서 `getPositions()` 조회
  - 실제 포지션 사이즈로 `openPositions` 기록
  - 사이즈 불일치 시 로그 경고

---

### Phase 2 — 안정성 (MEDIUM)

#### 2-1. Funding rate 정규화
- **현상**: `rateFor()`가 raw rate 반환. Lighter는 8h rate → 8배 과대 추정
- **위치**: `arb-auto.ts:850-852`
- **수정**: `toHourlyRate()` 적용
```
const longHourly = toHourlyRate(rateFor(pos.longExchange), pos.longExchange)
const shortHourly = toHourlyRate(rateFor(pos.shortExchange), pos.shortExchange)
```

#### 2-2. Daemon↔CLI state 동기화
- **현상**: 데몬은 startup 시에만 state 로드. CLI로 수동 close 해도 데몬 모름
- **위치**: `arb-auto.ts:355` (in-memory array), cycle loop
- **수정**:
  - 매 사이클 시작 시 `loadArbState()` 재로드
  - in-memory `openPositions`와 persisted state 비교
  - state에 없는 포지션은 in-memory에서도 제거 (CLI에서 닫은 것)
  - state에 있지만 in-memory에 없는 건 복구

#### 2-3. Settle boost 실제 적용
- **현상**: `settleBoostMultiplier` 계산만 하고 진입 판단에 미사용
- **위치**: `arb-auto.ts:674-682`
- **수정**: netSpread에 boost 반영
```
const boostedNetSpread = netSpread * settleBoostMultiplier
if (boostedNetSpread < minSpread) continue
```

#### 2-4. Size 타입 통일
- **현상**: ArbPosition은 `size: string`, ArbPositionState는 `longSize: number`
- **위치**: `arb-auto.ts:60`, `arb/state.ts`
- **수정**: ArbPosition.size를 number로 변경. 불필요한 parseFloat/String 제거

---

### Phase 3 — 코드 품질 (LOW)

#### 3-1. setInterval 정리
- **위치**: `arb-auto.ts:883, 396-405`
- **수정**: interval ID 저장, SIGINT 시 clearInterval() 호출

#### 3-2. TAKER_FEE 중앙화
- **위치**: `arb-auto.ts:71`, `arb/index.ts:78` 등 4곳
- **수정**: `src/constants.ts`에 단일 정의, 모든 파일에서 import

#### 3-3. Settlement schedule 중복 제거
- **위치**: `arb-auto.ts:126-131`, `arb/utils.ts:10-15`
- **수정**: `arb/utils.ts`의 정의만 남기고, arb-auto.ts에서 import

---

## 작업 순서

```
Phase 1 (안전성) ─── 1-1 → 1-2 → 1-3 → 1-4
                         │
Phase 2 (안정성) ─── 2-1 → 2-2 → 2-3 → 2-4
                         │
Phase 3 (품질)   ─── 3-1 → 3-2 → 3-3
```

- Phase 1은 순서대로 (state 저장이 먼저, close 검증이 그 다음)
- Phase 2는 독립적이라 병렬 가능
- Phase 3은 리팩토링이라 마지막

---

## 테스트 계획

| 수정 | 검증 방법 |
|------|----------|
| 1-1, 1-2 | state 파일 직접 확인: entry 후 파일에 기록되는지, close 후 삭제되는지 |
| 1-3 | 한쪽 거래소 mock으로 에러 발생시켜 partial close 시나리오 테스트 |
| 1-4 | dry-run + 실제 포지션 사이즈 비교 |
| 2-1 | Lighter 포지션의 funding 추정치가 HL/PAC와 비례하는지 확인 |
| 2-2 | daemon 실행 중 CLI로 `arb close` → 다음 사이클에서 position 사라지는지 |
| 2-3 | settle 직후 진입 threshold가 낮아지는지 로그 확인 |
| 3-x | 기존 테스트 통과 확인 |

---

## 영향 범위

- `src/commands/arb-auto.ts` — Phase 1, 2 대부분
- `src/arb/state.ts` — Phase 1 (persist 함수 활용)
- `src/commands/arb/index.ts` — Phase 2-2 (close 시 state 업데이트)
- `src/constants.ts` — Phase 3 (신규 파일)
- `src/funding/normalize.ts` — 변경 없음 (기존 toHourlyRate 사용)
