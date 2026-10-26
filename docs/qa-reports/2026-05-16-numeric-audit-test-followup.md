# QA Report — qa/2026-05-16-numeric-audit-test-followup

## QA 결과 요약

- **브랜치**: `qa/2026-05-16-numeric-audit-test-followup`
- **베이스 커밋**: `e084091` (직전 사이클 `qa/2026-05-06-numeric-validation-audit` HEAD)
- **HEAD 커밋**: `2a29254`
- **추가 커밋 수**: 17개 (직전 사이클 follow-up 8 + 어댑터 parity 9)

```
2a29254 test(exchanges): pin cross-adapter envelope consistency for NaN/empty payloads
b160ae0 test(wallet): extend OWS-aware integration with create / use / remove parity
5b5fc68 test(funding-rates): pin Pacifica row-skip on non-finite venue payload
1ad351a fix(position-history): skip non-finite realizedPnl in stats aggregation
5c714e5 fix(pacifica): guard 8 venue-payload sites with parseFiniteVenueNumber
e74ad73 fix(aster): guard 7 venue-payload sites with parseFiniteVenueNumber
57aad52 fix(hyperliquid): guard 10 venue-payload sites with parseFiniteVenueNumber
1100b1e refactor(lighter): migrate to shared parseFiniteVenueNumber
cffd1bb refactor(numeric): extract parseFiniteVenueNumber to src/utils/numeric.ts
51f6af8 fix(outcome): widen book.time to unknown so empty-string runtime check compiles
94c58a2 test(wallet): real-vault integration test for OWS-aware balance (dc1c1e0)
8e91f36 test(numeric): pin empty-string strict-rejection policy across 4 sites
bbc7819 fix(numeric): strict-reject empty-string venue payloads across 4 sites
508e06e test(errors): pin retired 'FATAL' / 'INVALID_EXCHANGE' codes (198f196)
1fc5dda test(event-stream): pin non-finite mark/liq/balance guards (ed533cb)
a5e1046 test(outcome): pin l2Book.time non-finite guard (ed533cb)
ea06afd test(rebalance): pin non-finite balance partial-result guard (ed533cb)
```

## 환경

- **컨테이너**: `perp-qa` Docker, `~/.ows`·`~/.perp` 마운트
- **Node**: v20+ (이미지 기본)
- **OS**: Linux (컨테이너), Darwin (호스트)
- **베이스 이미지**: node:20 — 이전 사이클과 동일
- **빌드 위치**: `/opt/perp-cli` (컨테이너 내), git clone + 호스트 push 후 `git pull`

## 회귀 결과 (Phase A — 컨테이너 패리티)

| Check | 명령 | 결과 |
|-------|------|------|
| Branch | `git log --oneline -1` | `2a29254` ✓ |
| Build | `pnpm build` | exit 0 ✓ |
| Unit suite | `pnpm test` | **80 files / 1462 passed / 0 fail / 22.00s** ✓ |
| Integration (OWS) | `pnpm test:integration src/__tests__/integration/wallet-ows-aware.integration.test.ts` | **1 file / 7 passed / 0 fail / 8.27s** ✓ |

호스트 결과(80 files / 1462 / 22.27s, 7 / 8.92s)와 정확히 일치. 컨테이너 환경 드리프트 없음.

## 라이브 검증 매트릭스 (Phase B — mainnet 읽기 경로)

이번 사이클의 핵심 가설: **새 `parseFiniteVenueNumber` 가드가 4 어댑터의 실제 mainnet 페이로드에서 false-positive 를 일으키지 않는다.** 4 어댑터 모두 정상 데이터로 가드를 통과해야 함.

### 어댑터별 portfolio (5 cases)

| 명령 | 어댑터 응답 | 새 가드 발화 | 결과 |
|------|-------------|---------------|------|
| `perp --json portfolio` | 4/4 connected, equity 모두 finite | 0건 | ✓ |
| `perp --json portfolio -e hyperliquid` | equity `3.4e-7`, spot USDC+USDH | 0건 | ✓ |
| `perp --json portfolio -e pacifica` | equity `24.38548`, perp-only | 0건 | ✓ |
| `perp --json portfolio -e aster` | equity `-0.0000019794257208` (음수 dust) | 0건 | ✓ |
| `perp --json portfolio -e lighter` | equity `26.28`, **실제 포지션 SKHYNIXUSD short** with mark/entry/upnl/leverage 모두 finite | 0건 | ✓ |

### 어댑터별 account positions (4 cases — `account positions`, NOT `positions`)

| 명령 | 응답 | 결과 |
|------|------|------|
| `perp --json account positions -e hyperliquid` | `data: []` (정상 empty) | ✓ |
| `perp --json account positions -e pacifica` | `data: []` | ✓ |
| `perp --json account positions -e aster` | `data: []` | ✓ |
| `perp --json account positions -e lighter` | SKHYNIXUSD short, size/entry/mark/liq/upnl/leverage 모두 finite | ✓ |

### Cross-exchange 집계 (3 cases — `funds rebalance check/plan`, NOT `rebalance plan`)

| 명령 | 응답 | 결과 |
|------|------|------|
| `perp --json arb scan --rates` | APT / WIF / 다수 심볼, 3 어댑터 funding rate aggregation, Pacifica row-skip 가드 통과 | ✓ |
| `perp --json funds rebalance check` | 4 어댑터 snapshot 정상, `unavailable: []` | ✓ |
| `perp --json funds rebalance plan` | `totalEquity: 50.63`, `summary: "Balanced — no moves needed"` | ✓ |

### Wallet OWS-aware (3 cases — dc1c1e0 + 94c58a2 회귀)

| 명령 | 응답 | 결과 |
|------|------|------|
| `perp --json wallet balance` | OWS-shaped envelope, EVM `0xabf2…637D3` 0.0016 ETH + 0.03 USDC, Solana `4iTFFwUq…aB7` 0.00092 SOL | ✓ |
| `perp --json wallet balance --testnet` | testnet RPC 정상 응답 (잔액 0) | ✓ |
| `perp --json wallet list` | OWS vault 10+ 지갑 surface (agent-pac-main, agent-hl-main, ...) | ✓ |

**총 15개 라이브 명령 / 0 false positive / 0 어댑터 회귀.** 새 가드는 정상 mainnet 페이로드를 reject하지 않음.

## Plan vs Actual — CLI 명령명 정정

QA plan 작성 시 명령명 검증 누락 — `positions` / `rebalance plan` 명령은 존재하지 않음. 실제 트리:

| Plan에 적은 명령 | 실제 명령 | 비고 |
|------------------|----------|------|
| `perp positions -e <ex>` | `perp account positions -e <ex>` | `account` 네임스페이스 |
| `perp rebalance plan` | `perp funds rebalance plan` | `funds` 네임스페이스 |
| `perp rebalance` (top-level) | `perp funds rebalance` | 동일 |

수정 후 모두 정상 동작. Plan 오류이며 코드 회귀 아님.

## 변경된 공개 인터페이스

- **신규 export**: `parseFiniteVenueNumber(value, fieldName, exchange, opts?)` from `src/utils/numeric.js`.
- **삭제**: `LighterAdapter._toFiniteNumber` static 메서드 (`_` prefix로 private convention; 외부 의존성 없음 가정).
- **거동 변경 (behavior)**: 4 어댑터 모두 venue 비유한 NaN / `""` 페이로드에서 `EXCHANGE_ERROR` throw — pre-fix 는 silent $0 coercion. **라이브 검증 결과 false-positive 없음**.
- **에러 메시지 (신규)**: `<exchange> response field \`<fieldName>\` is not a finite number: <value>` / `... is an empty string (use null for missing data)`. 모두 `structured.details.exchange` 로 출처 식별.
- **`getPositionStats` 거동 변경**: 비유한 `realizedPnl` 행은 PnL 합산에서 제외 (totalTrades에는 카운트, stderr warn). Pre-fix 는 NaN propagation으로 모든 통계 오염.

## 사람 검토 필요 항목

1. **PR 머지 시점**: 17 commits stacked. STRICT 룰 — main 머지/PR 생성/태깅 모두 사용자 명시 승인 필수. 자동 진행 안 함.
2. **버전 bump 결정**: 어댑터 거동 변경 포함 (`getBalance` NaN→throw) — semver minor (`v0.13.0` → `v0.14.0`) 권장. 사용자 결정 시 release flow 별도 진행.
3. **`account positions` 출력 사이트 추가 검증**: Phase B 에서 Lighter 1건만 실제 포지션 surface. HL/PAC/Aster 실거래 포지션이 발생한 시점에 한 번 더 확인 권장 (현재는 empty array 회귀만 검증됨).
4. **`portfolio` HL 모드 보조 검증**: 현재 HL `unified` 모드만 라이브 검증됨. `standard` / `portfolio` 모드 사용자가 있다면 별도 매트릭스 필요 (특히 `standard` 모드의 `marginSummary.accountValue` + `withdrawable` 분기 — Phase 2.3 신규 가드 사이트).
5. **Phase C 건너뜀**: 컨테이너 안에서 production code 패치 → revert 사이클은 위험 (잘못된 revert 가 호스트 빌드와 컨테이너 빌드 발산 유발). 신규 가드 발화는 unit 테스트 (1462 중 47개 신규 venue-payload 테스트) 로 증거 확보. 별도 staging 환경에서 강제 NaN 주입 테스트는 follow-up 으로 고려.

## Phase E — 확장 command-based 매트릭스 (read-only 전체 트리)

Phase B 가 어댑터 read-path 중심 (`portfolio` / `positions` / `wallet balance`) 이었다면, Phase E 는 CLI top-level command 트리 전체의 read-only 명령을 횡단으로 검증해서 다음을 보장:

- 이번 사이클이 만진 helper (`parseFiniteVenueNumber`) 가 portfolio/positions 외 경로(market, account, arb, history 등) 에서 false-positive 를 일으키지 않음
- 198f196 의 error-code retirement 가 라이브 envelope 에 정확히 반영됨
- 사이클 무관한 명령들도 일관된 JSON envelope 으로 동작 (`ok:true` 또는 registered `error.code`)

### Outcome (HIP-4) — 7 cases

| 명령 | 결과 |
|------|------|
| `perp --json outcome list` | ✓ 5 active markets (outcome 50/51/52/53/54), 모두 sides/encoding/assetId/mid finite |
| `perp --json outcome view 50` | ✓ BTC priceBinary, mark $77863.5 / target $78985 / gap -1.42% / `inTheMoney:"no"`, 양 sides book |
| `perp --json outcome book 50 0` (Yes) | ✓ `time: 1778937424121` finite, bids/asks |
| `perp --json outcome book 50 1` (No) | ✓ `time: 1778937425176` finite, bids/asks |
| `perp --json outcome view 52` (no class) | ✓ `underlying:null` (class 없음 → 계산 안함), sides bids/asks/mid 정상 |
| `perp --json outcome positions` | ✓ `data: []` (미보유) |
| `perp --json outcome orders` | ✓ `data: []` |

**bbc7819 + 51f6af8 가 가드한 `book.time` 경로 false-positive 0건** — 실제 venue 가 finite ms timestamp 반환.

### Health + 확장 read-only 매트릭스 — 38 cases

| 카테고리 | 명령 | 결과 |
|---------|------|------|
| **Health** | `health` | ✓ 4/4 ok (PAC 109ms / HL 92ms / LT 43ms / Aster 80ms) |
| **Market (9)** | `market list / prices / info BTC / book BTC / trades BTC / funding BTC / mid BTC / kline BTC 1h` | 8/8 ✓ |
| | `market hip3` | ✓ **expected error**: `INVALID_PARAMS` + remediation `"Re-run with -e hyperliquid."` — **198f196 contract 라이브 검증** (이전 `INVALID_EXCHANGE` 아닌 registered code + remediation 정상) |
| **Account (8)** | `account orders / history / settings / trades / funding / pnl / twap-orders` | 7/7 ✓ |
| | `account margin BTC` | ✓ **expected error**: `POSITION_NOT_FOUND` (사용자 미보유, registered code) |
| **Arb (3)** | `arb status / history / config` | 3/3 ✓ |
| **Risk (3)** | `risk status / limits / liquidation-distance` | 3/3 ✓ |
| **History (8)** | `history list / positions / summary / pnl / funding / report / snapshot / perf` | 8/8 ✓ |
| **Settings (2)** | `settings show / fees` | 2/2 ✓ |
| **Alerts (1)** | `alerts list` | ✓ |
| **Funds (1)** | `funds info` | ✓ |
| **Strategy (2)** | `strategy list-strategies / preset-list` | 2/2 ✓ |
| **Background (1)** | `background list` | ✓ |

**총 38/38 정상 envelope 응답.** 37 `ok:true` + 2 expected registered-error 응답. `parseFiniteVenueNumber` 발화 0건, ad-hoc error code (`FATAL`/`INVALID_EXCHANGE`) 0건.

## 추가 발견 — `startEventStream` dead code (P1)

QA 중 발견 — 이번 사이클의 ed533cb + bbc7819 가 가드한 `src/event-stream.ts:startEventStream()` 는 **production caller 0건**:

- production 전체 grep: 유일한 importer 는 `src/position-history.ts:8` (`import type { StreamEvent }` — 타입만)
- `src/index.ts:36` 의 "stream commands removed — WS feeds still used by dashboard/event-stream internally" 코멘트는 **stale** (실제 dashboard / bot 어디서도 호출 안 함)

### 시사점

| 옵션 | 평가 |
|------|------|
| A. 유지 | 미래 stream CLI 재도입 / 라이브러리 import 대비 방어 코드. 유지 비용 = 모듈 + 5 unit test (~250 lines). ed533cb + bbc7819 의 5개 NaN/empty 가드 unit test 는 여전히 valid (방어 contract). |
| B. 모듈 제거 | dead code 정리. 단점 = ed533cb 사이클 작업 무위. 사용자 의도 확인 필요 — "stream commands removed" 코멘트가 의도된 잠재 재도입 신호일 수도. |
| C. CLI 재추가 | `perp events --tail` 같은 stream subscribe 명령 부활. 사이클 범위 밖 (별도 feature 작업). |

**현재 권장**: 옵션 A (유지) — guards 자체는 올바르고 unit-test 도 robust. 사용자가 명시적으로 dead-code cleanup 을 지시할 때 옵션 B 로 별도 사이클 진행.

## 다음 권장 액션

- [ ] **사용자 검토 후 PR 작성** (main 향한 PR — STRICT 룰)
- [ ] **버전 bump 결정** (v0.13.0 → v0.14.0 후보, breaking 거동 변경 포함)
- [ ] **HL `standard`/`portfolio` 모드 라이브 보조 검증** (해당 모드 사용자 발생 시) — unit-level 은 `75effe4` 에서 7 case 추가 완료
- [ ] **HL/PAC/Aster 실포지션 보유 시점 재검증** (현재 Lighter 만 surface)
- [ ] **`startEventStream` 처리 결정**: 유지 / 제거 / CLI 재추가 중 사용자 선택

## 결론

이번 사이클의 핵심 위험 (어댑터 read-path 거동 변경이 정상 mainnet 데이터에서 false-positive 발생) 은 **Phase B 15 + Phase E 45 = 총 60개 라이브 매트릭스 전부 통과로 해소**. 1469 unit + 7 integration test 도 모두 green. 머지 가능 상태.

추가 P1 finding (event-stream dead code) 는 사이클 무관한 별도 cleanup item — 작업 흐름에 영향 없음.

---

## Phase F — test-followup 후속 (2026-05-29)

> 2026-05-16 사이클과 동일 브랜치에서 이어진 후속 QA. 위 Phase A–E (60-command
> live matrix) 는 numeric-guard 묶음(~`a70ebfb`) 검증분이고, 본 Phase F 는 그
> 이후 누적된 커밋(`b420788` / `9918594` / `f1c5302`)의 재검증과 신규 결함 1건의
> 수정·푸시를 다룬다. 베이스 `dcae870`, 추가 커밋 `70dd5b7`(fix) / `327c6f1`(docs).

### F-1. abort-listener 누수 (신규 발견 → 수정, P0)

**발견 경위**: 전체 unit suite 실행 시 stderr 에
`MaxListenersExceededWarning: 11 abort listeners added to [AbortSignal]` 출력.
`event-stream.test.ts` 단독 실행으로 출처 확정.

**근본 원인**: `startEventStream()`(`event-stream.ts`) 와 `history track` PnL
loop(`history.ts`) 의 polling while-loop 가 매 iteration 마다
`signal.addEventListener("abort", …, { once: true })` 를 추가. `{ once: true }`
는 abort *발생 시에만* listener 를 제거하는데, 정상 흐름은 timer 가 먼저
resolve 되므로 listener 가 영구 누적. Node EventTarget 기본 MaxListeners=10 →
11번째에서 경고. long-running stream/tracker 에서 실질 메모리 누수.

**수정**(`70dd5b7`): timer 분기에서 `removeEventListener` 로 정리 → 각 iteration
이 signal 을 listener 0 으로 남김. abort 분기는 `{ once: true }` 가 정리.
`startEventStream` 은 dead code 이나 테스트가 직접 호출하므로 함께 수정;
`history track` 은 production-reachable CLI.

**회귀 가드(P0)**: `event-stream.test.ts` 에 `getEventListeners(signal,"abort")`
를 15 cycle 동안 샘플링해 최대 1개만 붙는지 검증(pre-fix ~14 관측). fix 후
경고 소멸 + 가드 통과.

**Live↔unit cross-validation**: 이 결함은 Node EventTarget 의 실제 listener
count 를 unit 에서 직접 측정하므로 **unit 가드 = 실동작 검증**. 별도 live 재현
불요 (`perp history track` 은 foreground 무한 loop 라 Docker live 부적합).

### F-2. arb-sizing / symbolMatch 잠재결함 (`9918594` — 호출처 회귀분석)

`b420788` 커버리지 추가 중 표면화돼 `9918594` 에서 수정된 2건을 호출처
회귀분석으로 재검증:
- `computeMatchedSize` / `computeSpotPerpMatchedSize` round-up 분기가
  `minNotional` 미달 size 를 반환할 수 있던 문제 → `notionalUp >= minNotional`
  재확인 추가(SSOT Rule #2). 호출처 6곳 모두 기존에 `null` 핸들링 보유 → 회귀
  없음.
- `symbolMatch` 단방향 → 양방향 `-PERP` strip. 호출처 13곳 모두
  `symbolMatch(venueSymbol, userInput)` 순서로 일관. `false→true` 전환만 발생
  (동일 base perp), false-positive 없음. spot 은 `BTC/USDC` 형태라 strip 무관.

### F-3. bridge integration 2건 실패 (pre-existing, 사람 검토 필요)

`pnpm test:integration` → 166 passed / 1 failed / 174 skipped, **2 failed files**.
둘 다 2026-03 이후 미변경이며 numeric/listener 작업과 무관:
- `bridge.integration.test.ts > "CCTP same-chain doesn't throw"`: `edge cases
  (offline)` 블록이 실제로는 `getCctpQuote → fetch(CCTP_FEE_API/3/3)` 호출 →
  Circle API 가 same-chain(domain 3→3)에 **HTTP 400**. `bridge-engine.ts` 는
  Rule #2 대로 throw(정상); 테스트 기대가 외부 API 관대함에 의존(stale) + 블록
  라벨이 "offline" 인데 실제 네트워크 호출.
- `bridge-strict.integration.test.ts`: `beforeAll`(line 65) 이 `.env` 의
  `pk`/`HL_PRIVATE_KEY` 요구 → 호스트에 mainnet PK 없어서 throw(Section 7 준수).
  98 cases skip 인데 파일은 failed 표시. `describe.skipIf` 가드면 skipped 로
  표시될 것.

### F-4. 검증 결과

| 항목 | 결과 |
|------|------|
| `pnpm build` (tsc) | exit 0 |
| `pnpm test` (unit) | **1526 passed / 81 files / 0 failed** (이번 세션 1525→1526; 사이클 전체 1400→1526) |
| `MaxListenersExceededWarning` | fix 후 **소멸** |
| `pnpm test:integration` | 166 passed / 1 failed(외부 CCTP) / 174 skipped — bridge 2건 pre-existing |
| pre-push hook (tsc) | ✅ Build OK |
| CHANGELOG `[Unreleased]` | 실제 상태로 동기화 (`327c6f1`) |

---

## Phase G — risk-control audit + 수동 주문 risk 강제 (2026-06-02)

사용자 질문 "격리 계정 / 자산 한도 / 레버리지 제한 / 출금 제한 / 실시간 모니터링 —
잘 되어 있나"에서 출발한 5개 안전장치 코드 audit + 발견된 최우선 갭 수정.

### G-1. Audit 결과 (5개 안전장치)

| 항목 | 상태 | 근거 |
|------|------|------|
| 격리된 계정 | ✅ | agent wallet 키 권한 격리, `canWithdraw` 기본 off (`commands/agent.ts:333`) |
| 자산 한도 | ⚠️→✅ | `risk.ts` 한도 정의 + 자동매매 cap 존재. **수동 주문 미강제가 최대 갭 → 본 Phase에서 수정** |
| 레버리지 제한 | ⚠️ | `preTradeCheck` block 로직 존재하나 진입 명령에 leverage 인자 없어 notional/exposure 위주 강제 |
| 출금 제한 | ✅ | `perp-guardrail` OWS Policy Engine — per-tx/daily 출금 한도 + fail-closed (`perp-guardrail.ts:92`) |
| 실시간 모니터링 | ⚠️ | `perp risk` / `history track` / bot daily-loss는 작동; 상시 push 경보(`event-stream`)는 dead code |

핵심 갭: **수동 주문(`trade market/buy/sell/limit`)이 `adapter.marketOrder/limitOrder`를
직접 호출해 `~/.perp/risk.json` 한도를 우회**. risk 강제는 자동매매(cross-chain-margin)와
advisory `trade check`에만 존재했음.

### G-2. 수정 (`3c06dcc` / `630d746` / `19809d7`)

- `enforceOrderRisk()`(`trade-validator.ts`) — dry-run 가드 직후 4개 진입 명령에서 호출.
  notional(limit price 또는 markPrice) → `assessRisk` → `preTradeCheck` → 위반 시
  `RISK_VIOLATION` + remediation throw. `reduce-only`/`--force` 면제, **JSON 모드 동일 강제(fail-safe)**.
- `--force` 플래그 신규 (의도적 우회).
- `DEFAULT_LIMITS` 주석을 relaxed 100k 의도에 정합 (behavior 불변).
- `agent-operations.md`에 risk-gate 노트 추가 (에이전트가 `RISK_VIOLATION` 인지하도록).

### G-3. 테스트 영향 & 검증

- 회귀 가드 9 cases(`enforce-order-risk.test.ts`): skip(reduce-only/force), 차단(maxPosition/exposure),
  markPrice 조회, PRICE_STALE fail-closed, remediation 힌트.
- enforce 추가가 기존 단위 테스트 24개를 깨뜨림 — 원인은 **테스트 mock이 신규 `enforceOrderRisk`
  export를 누락**(risk 차단이 아니라 `undefined` 호출). 4개 test 파일 mock에 no-op stub 추가로 복구.
- 최종: `pnpm build` exit 0, `pnpm test` **1526 → 1535 passed / 82 files / 0 failed**.

### G-4. 남은 갭 (사람 검토 / 후속)

- **진입 명령에 leverage 인자 부재** → 직접 leverage 차단 미적용 (거래소 자체 maxLeverage만 작동).
- **`twap`/`scale-in`/`multi`/`split`/`stop`/`tpsl` 미적용** — 1차는 핵심 4개. 후속 확장 대상.
- **실시간 청산 push 경보 부재** — `event-stream` dead code (Phase F-1 / Outstanding 참조). CLI 재노출 시 활성.
