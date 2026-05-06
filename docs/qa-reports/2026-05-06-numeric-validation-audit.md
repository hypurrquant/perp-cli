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
- **추가 커밋 수:** 5개 (3 fix + 1 doc-self + 1 follow-up fix + 1 follow-up doc)

| # | 해시 | 제목 |
|---|------|------|
| 1 | `f381c0b` | `fix(validator): reject non-finite numeric inputs (Rule #2 audit)` |
| 2 | `26d78d7` | `fix(lighter): reject non-finite numeric venue payloads (Rule #2 audit)` |
| 3 | `ed533cb` | `fix(numeric-audit): observability + rebalance + outcome-time NaN guards` |
| 4 | `dcae870` | `docs(qa-report): numeric-validation-audit cycle report` (본 문서 v1) |
| 5 | `f34ce9b` | `fix(pacifica): drop ambiguous nextFunding/nextFundingTime mapping (Rule #2 follow-up)` |
| 6 | `47ab08c` | `docs(skills): align SKILL.md and references with actual --help output` |

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

## Follow-up — Cross-DEX 스모크 + SKILL 정합 (commits 5–6)

본 follow-up 은 1차 사이클 commits 1–3 을 origin push 한 뒤, 사용자가
지정한 4 개 추가 검증 (numeric 회귀 / 4 DEX read-only / wallet agent
verify / SKILL.md ↔ `--help` 정합) 을 컨테이너에서 실행하여 발견된
사항을 정리한다. 핵심 산출은 **신규 결함 1 건 (commit `f34ce9b`)** +
**SKILL/refs ↔ help mismatch P0 3 + P1 3 (commit `47ab08c`)**.

### 실행한 확장 스코프

| 검증 | 명령 | 결과 |
|------|------|------|
| 회귀 (전체 vitest) | `pnpm test` (컨테이너) | 75 files / 1396 → **1397 passed** / 0 fail / 23.97s |
| 4 DEX adapter | `perp health` + `market mid|book|funding BTC` × 4 + `arb scan --rates` | 4/4 OK, latency 43–109 ms, NaN/Infinity 누출 0 |
| Wallet agent verify | `perp wallet agent verify <ex>` × 4 | HL ✅ / LT ✅ / Aster `NOT_IMPLEMENTED` (메모리 일치) / **PAC 미완료 — passphrase 필요** |
| SKILL.md ↔ `--help` 정합 | 모든 cmd group `--help` 채집 + 3 doc 파일 cross-check | P0 3 / P1 3 mismatch 식별 → commit `47ab08c` 로 동시 패치 |

### 신규 결함 — Pacifica `nextFundingTime` 오염 (commit `f34ce9b`)

**증상.** `perp arb scan --rates` JSON 출력에서 Pacifica entries 의
스키마 정의 필드 `nextFundingTime` (주석: `// unix ms, if available`)
이 음수 소수점 값을 가짐 (예: WIF 의 경우 `-0.00014299`). 같은 entry
의 `fundingRate` 와 정확히 동일.

**Root cause.**

- `src/api/public/pacifica.ts:11` — `PacificaAsset.nextFunding?: number`
  필드가 의미상 "다음 주기 펀딩 **rate**" (Pacifica API 의 `next_funding`
  필드, 작은 소수). 이름이 시간/율 모호.
- `src/funding/rates.ts:70` — `nextFundingTime: p.nextFunding` 으로 그
  rate 값을 cross-DEX 스키마의 unix-ms 슬롯에 매핑. 결과적으로 모든
  Pacifica entry 가 garbage 값을 시간 자리에 출력.
- `src/commands/arb.ts:33,43,72,81` — file-local `FundingRate` interface
  의 `nextFunding` 필드는 **set 만 되고 read 안 됨** (write-only dead
  state). 추가로 Pacifica = rate / Aster = unix-ms 의 두 다른 의미를
  같은 슬롯에 섞어 채움.

**Fix.** 죽은/혼합 의미 필드 제거 (3 src 파일):

1. `pacifica.ts` — `PacificaAsset.nextFunding` 제거. `next_funding` 은
   `funding` 계산에 이미 우선 사용 중이라 정보 손실 없음.
2. `funding/rates.ts:60-76` — Pacifica entry 빌드에서 `nextFundingTime`
   할당 라인 제거. JSDoc 주석으로 "Pacifica 는 next-funding-time 을
   노출하지 않으니 의도적으로 미설정" 명시.
3. `commands/arb.ts` — dead `nextFunding` 필드 + 양쪽 set site 제거.

**회귀 가드 (1 신규 테스트, 1396 → 1397).** `funding-rates.test.ts`
"Pacifica nextFundingTime guard" — Pacifica mock 응답에 `next_funding:
-0.00014299` 가 있어도 출력 entry 의 `nextFundingTime` 가 `undefined`
임을 단언. fix 가 reverted 되면 테스트 실패.

**라이브 검증.** push 후 컨테이너 재빌드 + `arb scan --rates`:
- Pacifica entries: 5 / `nextFundingTime` 보유: **0 ✅**
- Aster entries: 6 / `nextFundingTime` 보유: **6 ✅** (Aster 만이 진짜
  unix-ms 데이터를 노출 — schema 의도와 일치)

### SKILL/refs ↔ `--help` mismatch (commit `47ab08c`)

#### P0 — 잘못된 명령 (agent 호출 시 venue 도달 전 실패)

| 위치 | 잘못된 내용 | 수정 |
|------|------------|------|
| `commands.md:286` | `perp wallet manage withdraw <amount> <addr>` | 제거. `wallet manage` 서브: margin/sub/lake/builder/referral/apikey/account-mode 만. 일반 인출은 `funds withdraw <ex> <amount>`. |
| `commands.md:292` | `account-mode [standard|big-blocks]` | `[unified|standard|portfolio]` 로 정정 (실제 `--help` 일치). |
| `commands.md:339` | `history stats` | 제거. 같은 줄에 `summary` 가 있고 `perf` 도 후에 등장. |

#### P1 — 불완전 또는 outdated 안내

| 위치 | 문제 | 패치 |
|------|-----|------|
| `commands.md:281` | `wallet agent approve` 에 `--master`/`--api-key-index` 만 노출 | `--agent-name` / `--expires-in` (default 90d!) / `--can-perp` `--no-perp` / `--can-spot` `--no-spot` / `--can-withdraw` `--no-withdraw` / `--rotate` / `--passphrase` / `--builder` `--max-fee-rate` `--builder-name` / `--ip-whitelist` 추가. `--expires-in` 미노출이 가장 위험 — agent silently expire 가능. |
| `commands.md:285` (verify) | DEX 별 옵션 매트릭스 부재 | `--master` / `--master-address` (HL) / `--account-index` (LT) / `--passphrase` (Aster·PAC) 명시 + Aster `NOT_IMPLEMENTED` 주석. |
| `agent-operations.md:9-12` + `commands.md:425-428` + `SKILL.md:39` | "NEVER use perp setup/init/wallet setup" 통째 금지 | `setup --non-interactive --passphrase <pp> --wallet-name <name>` 가 agent-safe 임을 명시. `wallet setup` 은 passphrase prompt 만 issue → `OWS_PASSPHRASE` env 로 무인 실행 가능. |

#### 변경 없음 (정합 확인됨)

- 거래소 단축 별칭 (`pac/hl/lt/aster`) — `src/commands/wallet.ts:622`
  alias 맵 + 라이브 `perp -e pac/lt market mid BTC` 둘 다 통과.
- `wallet manage account-mode` 모드는 실제 help 와 commands.md 만
  불일치였음 (이번 P0-2 수정으로 해소).
- 4 DEX adapter 인터페이스 (markets/prices/funding/book/health) 정상.
- Outcome (HIP-4) 명령군 SKILL.md ↔ help 일치.

### Wallet agent verify 매트릭스

| DEX | 결과 | 노트 |
|-----|------|------|
| Hyperliquid | ✅ | `count=2` (`hypurrquant`, `perp-cli-hl`), `validUntil` 노출. extraAgents 라이브 endpoint. |
| Lighter | ✅ | `count=11` slot 0,3,4,5,6,…, `account_index 723334`. |
| Aster | ✅ (`NOT_IMPLEMENTED` 예상) | 메모리 `aster_verify_endpoint_pending.md` 와 일치. `/fapi/v3/agent` 가 동일 sig 인데 reject — Aster 측 endpoint 또는 FE 참조 sig 경로 발굴 필요. 본 사이클 범위 외. |
| Pacifica | ⏸ 미완료 | OWS passphrase 컨테이너 env 주입 미수신 → `EXCHANGE_ERROR HTTP 400 Verification failed`. 사용자가 `! docker exec -it perp-qa perp wallet agent verify pacifica --master main --passphrase '<pp>' --json` 실행 시 매트릭스 닫힘. |

### Section 7 보안 가드 (commits 5–6)

| 항목 | 결과 |
|------|------|
| `git diff --cached` 비밀 스캔 (PK / mnemonic / API key / 32-byte hex+) | 위배 0건 — placeholder `<pp>` 만 |
| 임베디드 referral code 변경 여부 | 변경 없음 (settings 또는 wallet 코드 미수정) |
| signer abstraction 우회 추가 코드 | 없음 |
| testnet PK / 비밀 의 repo 커밋 | 없음 (모든 변경 = 공개 docs / 버그 fix) |
| 테스트 로그에 PK / 서명 페이로드 출력 | 없음 (mock 만, 실제 키 미사용) |

### 다음 권장 액션 (사이클 종료 후)

1. **(즉시) PAC verify 수행** — passphrase 주입 후 매트릭스 4/4 닫기.
2. **(단기) PR 생성 → main 머지** — qa 브랜치 → main, 사용자 승인 후
   사람이 PR 트리거.
3. **(중기) Aster `/fapi/v3/agent` master sig 경로 재시도** — FE 참조
   비교 후 별도 사이클로 분리.
4. **(중기) `arb scan --rates` schema 강제 테스트 추가** — 모든 entry 의
   `nextFundingTime` 가 `undefined` 또는 `Number.isFinite(v) && v >
   Date.now()` 이도록 property test (fast-check 도입 후 같이 묶기).

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
