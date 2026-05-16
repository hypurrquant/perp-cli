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
