# QA Report — Numeric Validation Audit

> 본 보고서는 `docs/QA_WORKFLOW.md` Section 11 의 한국어 구조화 포맷에
> 따라 작성된다. 이전 사이클 (`qa/2026-05-05-v0.13.0-validation`) 의
> production 결함 3건 (NaN silent-pass / NaN propagation / silent empty
> book) 이 같은 audit pass 에서 발견된 것을 확인하고, **사용자 가설
> "빙산의 일각"** 을 다른 모듈 전반에 검증한 follow-up.

## QA 결과 요약

- **브랜치:** `qa/2026-05-06-numeric-validation-audit` (origin push 완료)
- **베이스 커밋:** `1d0e961` — `Merge pull request #13 from hypurrquant/qa/2026-05-05-v0.13.0-validation`
- **베이스 버전:** `0.13.0`
- **추가 커밋 수:** 3개

| # | 해시 | 제목 |
|---|------|------|
| 1 | `f381c0b` | `fix(validator): reject non-finite numeric inputs (Rule #2 audit)` |
| 2 | `26d78d7` | `fix(lighter): reject non-finite numeric venue payloads (Rule #2 audit)` |
| 3 | `ed533cb` | `fix(numeric-audit): observability + rebalance + outcome-time NaN guards` |

PR URL 후보:
`https://github.com/hypurrquant/perp-cli/pull/new/qa/2026-05-06-numeric-validation-audit`

## 가설 검증 결과

이전 사이클 사용자 review 의 핵심 가설:

> "production 버그 2건 = 빙산의 일각일 가능성. 같은 treatment 안 받은
> 다른 모듈에도 같은 패턴의 버그가 있을 가능성이 높음."

이번 audit 가 **18개의 추가 사이트** 에서 동일 패턴의 NaN silent-pass /
NaN propagation 결함을 확인. 가설 강하게 입증됨.

| 모듈 | 결함 사이트 | Fix commit |
|------|----------|-----------|
| `trade-validator.ts` | 5 (markPrice / balance / orderbook px·sz / posSize / fundingRate) | `f381c0b` |
| `exchanges/lighter.ts` | 9 (balance + position aggregation 9곳) | `26d78d7` |
| `event-stream.ts` | 2 (liquidation distance / balance delta) | `ed533cb` |
| `rebalance.ts` | 1 (planner input) | `ed533cb` |
| `exchanges/hyperliquid-outcome.ts:439` | 1 (l2Book time, 이전 사이클 leftover) | `ed533cb` |

**이전 사이클 (3건) + 이번 사이클 (18건) = 합계 21건** 의 같은 클래스
Rule #2 위반이 **2 audit pass** 에서 발견됨.

## 환경 / Pre-flight (Section 4)

- **호스트:** macOS (Darwin 25.4.0), pnpm 10, Node 20·22·24 매트릭스
- **컨테이너:** `perp-qa` Docker, `~/.ows`·`~/.perp` 마운트
- working tree clean, base `1d0e961` = origin/main HEAD
- mainnet 거래 실행 0건 (audit 자체가 readonly + 단위 테스트 영역)

## 실행 내역

### 적용된 audit 패턴

이전 사이클의 `_computeUnderlying` / `_computeMidSum` /
`_assertOutcomeRange` 패턴 follow-through:

1. **Helper 추출 + 단위 테스트** (가능한 곳) — 같은 가드 로직을 한 곳에
   두고 테스트로 freeze.
2. **Inline 가드 + 명시 throw** (helper 추출이 어려운 곳, e.g. event
   stream 에서 venue 응답이 일회용으로 해석됨).
3. **에러 메시지에 field name + 원본 value** 포함 — triage 시 어느 venue
   endpoint 의 어떤 field 가 깨졌는지 즉시 식별.

### 모듈별 변경

#### `trade-validator.ts` (`f381c0b`, 5 sites + 6 tests)

| Site | 이전 동작 | 변경 후 |
|------|---------|---------|
| `markPrice` | `<= 0` 검사가 NaN 통과시킴 | `Number.isNaN` / Infinity pre-check throw |
| `balance.available` | NaN 면 "insufficient" branch 거짓 진입 + `$NaN available` 노출 | throw EXCHANGE_ERROR |
| 주문북 level `px`·`sz` | NaN 누적 시 `availableLiquidity` NaN, `>= notional` 항상 false | level 단위 finite + positive 검사 throw |
| reduce-only `pos.size` | NaN 면 size 비교 거짓 통과 | parseFloat 후 finite 검사 throw |
| `marketInfo.fundingRate` (output) | envelope 에 `NaN` JSON 노출 | 0 substitute + warning push (output sanitization) |

#### `exchanges/lighter.ts` (`26d78d7`, helper + 9 sites + 9 tests)

`LighterAdapter._toFiniteNumber(value, fieldName, defaultValue=0)` 추출:
- undefined / null → defaultValue (venue 가 빈 계정 / position 에서 omit 가능)
- finite number / parseable string → 그대로
- NaN / ±Infinity / 비숫자 string → throw EXCHANGE_ERROR (field name 포함)

Sites:
- `total_asset_value`, `available_balance`, `collateral`, `position.unrealized_pnl` (balance)
- `position`, `posSize`, `position_value` (positions, markPrice/leverage 계산)

#### `event-stream.ts` (`ed533cb`, 2 sites)

- liquidation distance (`mark`/`liq` NaN → critical alert silent skip)
- balance delta (NaN → balance_update emit 누락)

둘 다 `console.warn` + 분기 가드로 변경. observability 영역이라
throw 가 stream 흐름 깨므로 silent → noisy 로 격상 (warn 로그가 사용자
디버깅 단서).

#### `rebalance.ts` (`ed533cb`, 1 site)

`Number(bal.equity)` 등 NaN propagation → `Promise.allSettled` 의 reject
경로 유도 (어댑터 단위로 plan 에서 제외, 다른 어댑터 영향 없음).

#### `exchanges/hyperliquid-outcome.ts:439` (`ed533cb`, 1 site)

이전 사이클 v0.13.0 의 `getOrderbook` 가드 강화에서 leftover. 이제
`Number(book.time ?? 0)` 도 nullish 와 NaN 분리:
- nullish → 0 (legit "time 정보 없음")
- non-finite → throw (corrupt)

## 테스트 결과

- **passed: 1396 / failed: 0 / added: 15** (host + container cross-validate)
- **이전 (베이스 = main HEAD `1d0e961`):** 1381 / 74 files
- **이후 (QA 브랜치 HEAD = `ed533cb`):** 1396 / 75 files
- **신규 test files (1):** `exchanges/lighter-toFinite.test.ts`
- **확장된 test files (1):** `trade-validator.test.ts` (38 → 44)
- **새 helper 단위 테스트:** 9 case (`_toFiniteNumber`)
- **NaN edge case 테스트 추가:** trade-validator 의 5 production fix 마다 1 case

## 변경된 공개 인터페이스

- **CLI / JSON envelope: 변경 없음.** 정상 동작 시 출력 동일.
- **에러 행동 변경:** NaN/Infinity venue 응답 시 이제 명시 EXCHANGE_ERROR.
  - 이전: silent 0 substitution → "$0 balance" / "Insufficient liquidity: $NaN" / "no alert" 같은 false-positive 분기
  - 이후: throw with field name + value (envelope `error` 필드로 surface)
- **Internal 신규 helpers (모두 underscore prefix, 기존 컨벤션):**
  - `LighterAdapter._toFiniteNumber` (public static, 단위 테스트 가능)

## 테스트 작성 중 발견된 production 결함

이전 사이클은 helper-extract pattern 으로 3건 발견. 이번 audit pass 는
같은 pattern 으로 **18건의 추가 결함**. 모두 NaN propagation
(silent-pass, false-positive 분기, envelope NaN 노출) 의 동일 클래스.

| 분류 | 건수 | 영향 |
|------|------|------|
| 자금 계산 (balance / position / margin) | 13 | "$0" 으로 corrupt 가림, false 충분 잔고 판정, plan 입력 NaN |
| 시세 / 주문북 (markPrice / level px·sz / time) | 4 | NaN 비교 false → silent skip |
| Output sanitization (envelope output) | 1 | agent JSON 파싱 깨짐 |

이전 사이클의 가설 — "같은 treatment 안 받은 모듈에 같은 패턴 더 있음"
— 이 audit 가 18건으로 **6배 강화**된 형태로 검증.

## 사람 검토 필요 항목

1. **`Number.isNaN` vs `!Number.isFinite` 사용** — `markPrice` 가드는
   `Number.isNaN(x) || x === Infinity || x === -Infinity` 명시. 다른
   사이트는 `!Number.isFinite(x)`. 동등하지만 가독성 차이. 통일
   권장 (`!Number.isFinite` 가 더 짧음).
2. **mcp-server.ts 의 advisor numeric output sanitization** — 이번
   사이클 범위에서 분리. portfolio aggregation 의 `Number(snap.balance.equity)` 등
   가드 부재 영역 follow-up. envelope 영향 작지만 lighter.ts cascade
   덕에 부분 보호. 별도 micro-PR 가치.
3. **다른 어댑터 (`pacifica.ts` / `hyperliquid.ts` / `aster.ts`) 의
   동일 audit** — `cross-adapter-matrix` 사이클 (P1) 의 일부로
   처리 권장. lighter.ts 가 가장 많은 silent fallback 을 가졌지만
   다른 어댑터도 부분 패턴 가능.
4. **event-stream / rebalance 의 단위 테스트 부재** — stream/aggregation
   shape 라 단위 테스트 비용 큼. integration test 인프라 (mock signer
   matrix 사이클) 와 함께 생기면 추가 가치.

## 다음 권장 액션

### 즉시 (이번 PR)

- [ ] **PR 생성** — `qa/2026-05-06-numeric-validation-audit` → `main`.
      3 commits, +18 production fixes, +15 tests.

### Follow-up micro-PRs

- [ ] **mcp-server.ts numeric output sanitization** — portfolio aggregation
      `Number(...)` 사이트들 (`extractNumber || "<size>"` 패턴 + balance
      reduce). envelope NaN 노출 차단.
- [ ] **`pacifica.ts` / `hyperliquid.ts` / `aster.ts` 동일 audit** —
      이번 사이클의 cross-adapter follow-up. cross-adapter-matrix 와
      병합 가능.
- [ ] **`Number.isFinite` 통일** — 사람 검토 #1 의 가독성 통일.
- [ ] **`@vitest/coverage-v8` dep 추가 (사용자 승인 필요)** — 정량
      coverage. 이번 audit 가 18건 추가했는데 0% → 미커버 모듈 식별.
- [ ] **`fast-check` property test (사용자 승인 필요)** — `--json` numeric
      필드 finite 강제. 1000+ 자동 case 로 audit 패턴 영구화.

### 다른 사이클로 이미 분리된 항목 (이전 보고서 plan 그대로)

- `qa/2026-05-XX-aster-signer-regression` (P0 격상)
- `commander program-builder factory` (P1)
- `qa/2026-05-XX-cross-adapter-matrix` (P1, mcp-server / 다른 어댑터 audit 묶기 가능)
- `qa/2026-05-XX-failure-modes` (P2)

## Section 3 / Section 13 — 절대 금지 항목 준수

| 항목 | 수행 여부 |
|------|----------|
| `main` 머지 / push | ✗ |
| `npm publish` | ✗ |
| `git tag` | ✗ |
| GitHub Release 생성 | ✗ |
| mainnet 실거래 | ✗ |
| 의존성 메이저 업데이트 | ✗ |
| 새 npm 패키지 추가 | ✗ |

## 부록 A — 가설 강화 데이터

| 사이클 | audit 통과 모듈 | 발견 production 결함 |
|--------|--------------|------------------|
| v0.13.0 (`qa/2026-05-05`) | `hyperliquid-outcome.ts` (helper 5개) | 3 |
| Numeric audit (`qa/2026-05-06`, 본 보고서) | `trade-validator` / `lighter` / `event-stream` / `rebalance` / `outcome-time` | 18 |
| **합계** | 5 영역 | **21** |

이 시점에서 **다음 사이클이 같은 패턴으로 더 발견할 결함의 lower bound**
는 0 이 아님. 추가 audit 사이클의 가성비는 여전히 높음 — 본 보고서의
follow-up plan 이 그 우선순위 정렬.

## 부록 B — audit 검색 명령

다음 사이클이 동일 패턴 적용 시 사용:

```bash
# 1. Number()/parseFloat()/parseInt() 후 isFinite 가드 부재 사이트
grep -rnE '(Number\(|parseFloat\(|parseInt\()' src --include='*.ts' \
  --exclude-dir=__tests__ --exclude-dir=dist \
  | grep -vE '(Number\.is(Finite|Integer)|\.\s*toString)'

# 2. `|| 0` 또는 `?? 0` 같은 numeric default fallback
grep -rnE '\?\? \d|\|\| \d' src/exchanges src/strategies src/arb \
  --include='*.ts'
```
