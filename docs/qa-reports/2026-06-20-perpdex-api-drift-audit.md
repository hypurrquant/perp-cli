# QA 리포트 — 4개 Perp DEX API Drift 감사 + 업데이트

- **날짜:** 2026-06-20
- **브랜치:** `qa/2026-05-16-numeric-audit-test-followup`
- **베이스 커밋:** `2f3d9d8` (docs: document manual-order risk enforcement)
- **추가 커밋 (4):**
  - `cca359e` fix(aster): migrate public market-data reads /fapi/v1 → /fapi/v3
  - `cbc111e` feat(trade): enforce risk limits on twap / scale-in / multi-leg orders
  - `46c677d` feat(aster): populate position liquidationPrice + markPrice from /fapi/v3/positionRisk
  - `20bcfab` feat(pacifica): support trigger_price_type on stop orders (mark/last/mid)
- **방법:** 4개 DEX 공식 문서를 라이브 fetch(`perp-dex-docs` 스킬 canonical URL) → 어댑터 구현과 대조. 모든 drift 주장은 문서 인용 + 어댑터 `file:line` 증거 요구.

---

## 1. 감사 결과 매트릭스

| DEX | 코어 서명/엔드포인트 | 확정 Drift | 조치 |
|---|---|---|---|
| **Lighter** | ✅ 전부 현행 | 없음 | tx-type(8·12·13·14·15·16·17·20)·order-type(0–5)·TIF(0·1) 상수 전수 일치. No-Fallback 가드가 signer 재넘버링 방어. 조치 불필요 |
| **Pacifica** | ✅ 실거래 경로 전부 현행 | P1: `unbind_agent_wallet` 공식 표 부재 | **사람 검토** (§4). trigger_price_type 신규 지원 추가 (`20bcfab`) |
| **Hyperliquid** | ✅ 코어 전부 현행 | P1(잠재): Outcome `MAX_SIDE=9` vs binary(0/1) | 미조치 — 인스턴스 `_validateOutcomeSide`가 이미 실시장 sideSpecs로 차단. §5 메뉴 |
| **Aster** | ✅ Domain B·nonce(µs)·EIP-712 일치 | **P1: public read v1→v3** | **수정 완료** (`cca359e`) |

세부 근거는 세션 transcript 및 메모리 `aster_verify_endpoint_pending.md` 참조.

## 2. 적용한 변경 (drift 수정 + 후속)

### 2.1 Aster public read `/fapi/v1/*` → `/fapi/v3/*` (`cca359e`)
- V3 스펙은 모든 공개 엔드포인트를 `/fapi/v3/*`로만 문서화. `/fapi/v1/*`은 미문서화 Binance-compat 레거시 별칭.
- **라이브 교차검증:** 7개 엔드포인트(exchangeInfo·ticker/24hr·depth·trades·klines·fundingRate·time) v1=v3 둘 다 HTTP200 + 응답 키 **완전 동일** 확인.
- `_publicGet` 10곳 전부 v3 이전 (No-Fallback, SSOT Rule #2). stale v2 주석 정정.

### 2.2 Aster 포지션 liquidationPrice + markPrice 배선 (`46c677d`)
- `getPositions`가 liquidationPrice를 하드코딩 `"0"` 하던 것을, 신규 문서화된 `GET /fapi/v3/positionRisk`(Position Information v3, USER_DATA; markPrice+liquidationPrice 공급)로 대체. 기존 public premiumIndex mark-price probe를 1회 signed positionRisk 호출로 교체.
- best-effort: positionRisk 실패 시 mark/liq `"0"` (기존 premiumIndex 실패와 동일 회복력).
- **검증 한계:** positionRisk는 signed USER_DATA → 세션에 Aster 계정 없어 라이브 미실행. 문서 응답 스키마 + 단위테스트로 검증. **실계정 라이브 read 권장.**

### 2.3 risk 게이트 twap/scale-in/multi-leg 확장 + multileg 테스트 (`cbc111e`)
- 세션 시작 시 작업 트리에 있던 `trade.ts`(enforceOrderRisk를 twap/scale-in/multi에 확장) 미커밋 변경이 multileg 테스트 3개를 깨뜨림(mock 어댑터에 `getMarkets` 부재 → 게이트 abort → `marketOrder` 0회). mock에 `getMarkets` 추가로 실게이트를 통과시켜 복구.

### 2.4 Pacifica `trigger_price_type` (`20bcfab`)
- create-stop-order의 옵션 `trigger_price_type`(mark_price|last_trade_price|mid_price) 미지원이던 것을, opt-in `--trigger-type <mark|last|mid>` 플래그로 추가. 미사용 시 canonical-JSON이 undefined 필드 strip → 서명 byte-identical(기존 동작 불변).

## 3. 테스트 결과

- **전체:** 83 files / **1541 tests PASS** (세션 시작 클린 HEAD 1535 → **+6**: positionRisk 2 + trigger_price_type 4).
- **빌드:** `tsc` exit 0.
- **라이브 E2E:** `market list/book/funding --exchange aster` 실데이터 정상 반환 (v3 마이그레이션 end-to-end 검증).
- **회귀:** Aster 111 tests PASS. 다중 어댑터 인터페이스(interface.ts stopOrder opts 확장) 변경 후 전체 GREEN.

## 4. 사람 검토 / testnet 필요 (자금·키 — blind edit 금지)

### 4.1 Aster agent 승인 서명 drift — **probe 준비 완료**
- 라이브 V3 스펙이 `POST /fapi/v3/registerAndApproveAgent`를 **flat `msg`-string** EIP-712 envelope로 문서화. 어댑터(`aster-typed-data.ts:buildApproveAgentTypedData`)는 **structured-field** `ApproveAgent` + domain chainId **56** + `/fapi/v3/approveAgent` 사용 → 상이.
- **문서 자체 모순:** typed_data JSON 예시 domain `chainId=1666`, 요약표 `chainId=56`.
- `wallet agent verify aster` broken 건(메모리)과 직접 연관.
- **probe 산출물:** `scripts/probe-aster-agent.ts` — testnet에서 2×2 매트릭스(엔드포인트 × domain chainId, doc flat-msg envelope) 제출 후 어느 조합이 `{"code":200}` 반환하는지 확인. `canWithdraw=false` 강제, testnet URL 강제, 키는 env(`ASTER_TESTNET_MASTER_PK`)로만. **세션 내 미실행(testnet 자격증명 없음) — 첫 실행이 곧 테스트.**
  ```
  ASTER_TESTNET_MASTER_PK=0x... ASTER_TESTNET_URL=https://fapi.asterdex-testnet.com \
    npx tsx scripts/probe-aster-agent.ts
  ```

### 4.2 Pacifica `unbind_agent_wallet`
- 공식 operation-types 표에 `bind_agent_wallet`만 있고 unbind/revoke 변형 없음. `wallet agent revoke pacifica`(`agent.ts` → `/agent/bind`에 `unbind_agent_wallet` type POST)가 무음 실패 가능. HypurrQuant_FE 출처(코드 주석 자인). **testnet probe 필요.**

## 5. 다음 권장 액션 — 미구현 신규 기능 메뉴 (DEX가 추가, 어댑터 미노출)

additive 기능(drift 아님). 거래 코드라 testnet 검증 동반 권장. 우선순위는 사용자 결정.

- **Hyperliquid:** 주문에 `builder:{b,f}` + cloid `c` 부착(빌더 수수료 수익 — 현재 approveBuilderFee 정의돼 있으나 미배선/호출처 0), `expiresAfter`, `cancelByCloid`, `normalTpsl` grouping(브래킷).
- **Lighter:** TWAP(order type 6), POST_ONLY TIF(2, 메이커 전용), `sendTxBatch`, grouped orders(tx 28), 전용 margin tx(29), integrator 귀속.
- **Pacifica:** 진입 주문(market/limit)에 attached TP/SL, TWAP/batch 어댑터 노출.
- **Aster:** `PUT /fapi/v3/order`(atomic modify — 현재 cancel+replace), batchOrders, `/fapi/v3/balance`(경량 잔고), chase(BBO-peg), countdownCancelAll(dead-man), hedge-mode `positionSide`.

## 6. 공개 인터페이스 변경

- **CLI:** `trade stop`에 `--trigger-type <mark|last|mid>` 추가 (opt-in, Pacifica). 그 외 명령·플래그·출력 불변.
- **어댑터 인터페이스:** `ExchangeAdapter.stopOrder` opts에 `triggerType?` 추가 (optional, 미지원 어댑터 무시 — 하위호환).
- **출력 형식:** Aster v1→v3 마이그레이션은 응답 shape 동일 → 사용자 가시 동작 불변. Aster 포지션의 `liquidationPrice`가 `"0"` → 실제값(positionRisk 성공 시).

---

# Phase 2 — 심층 order/API-call 정확성 감사 + 전체 수정

**방법:** DEX별 멀티에이전트 워크플로우(order/signed-call payload를 필드 단위로 라이브 문서·SDK와 대조 → 3-vote adversarial 검증). 워크플로우 verifier 다수가 transient rate limit으로 실패 → funds/signing 결함은 **직접 코드 재검증**(node_modules·라이브 doc). 11개 후보 중 **10개 확정·수정, 1개 false positive 기각**.

## 확정·수정 (커밋)

| # | 결함 | 심각 | 커밋 |
|---|---|---|---|
| 1 | **Lighter `withdraw` 1e6 스케일 누락** — 저수준 WasmSignerClient는 스케일 안 하는데 raw 금액 전달 → 100 USDC 요청이 0.0001로 서명. node_modules 직접 확정 | **P0** | `966ffc0` |
| 6 | Lighter withdraw CLI `--asset-id` 기본 2 → 3(USDC) | P1 | `966ffc0` |
| 2 | HL `marketOrder`/`smartOrder` reduceOnly 무시 → close가 market fallback 시 flip 가능 → `marketClose` 라우팅 | P1 | `6812c86` |
| 4 | **Pacifica agent-wallet 거래 전체 broken** — `agent_wallet` 누락(buildAgentSignedRequest 미배선) → ensureSigner에서 동기화 | P1 | `c826d46` |
| 5 | Pacifica `withdraw --to` 무시(API에 destination 필드 없음, 라이브 doc 확정) → dest_address 제거 + mismatch throw | P1 | `36eef50` |
| 8 | Aster `editOrder` side="buy" 기본 + reduceOnly 드롭 → raw 주문에서 보존 + Rule #2 throw | P1 | `c54fc99` |
| 3 | HL `withdraw3` fallback이 L1 스킴(잘못)으로 서명 + 에러 삼킴 → fallback 제거 | P1 | `cde3212` |
| 7 | Lighter `getOpenOrders`가 order_id 노출 → cancel/modify가 order_index 자리에 잘못된 키 | P1 | `4832c6e` |
| 9 | HL `approveBuilderFee` L1 스킴 → SDK user-signed 라우팅 (unwired) | P2 | `cde3212` |
| 10 | HL `tokenDelegate` L1 스킴/malformed → SDK 라우팅 (unwired) | P2 | `cde3212` |

## Adversarial 검증으로 기각 (false positive)

- **#11 Lighter spot `_selfTransfer` 이중 스케일** — finding은 last-resort `signer.signTransfer`가 고수준 SDK라 1e6 이중 적용된다 주장. 직접 검증 결과 `this._lt.signer`는 **저수준 WasmSignerClient**(스케일 안 함)라 3개 경로 모두 1회 스케일로 정확. **수정 안 함** (고쳤으면 오히려 버그). → votes=0 finding은 반드시 직접 검증 후 수정 교훈.
- **HL `updateIsolatedMargin` Math.abs** — 워크플로우 3-vote 만장일치 기각(방향은 `isBuy`가 인코딩, `ntli` 부호 아님).

## Phase 2 검증
- 빌드 0 · **전체 1557 tests PASS** (88 files, Phase 2에서 +회귀가드 다수).
- 각 fix는 단위테스트 회귀 가드 포함. **서명/자금 경로(withdraw·agent·reduceOnly·user-signed action)는 라이브 미실행 → 커밋 NOTE에 "testnet 검증 필수" 명시.**
- 공개 인터페이스 변경: `funds withdraw pacifica`에서 `--to` 제거(Pacifica는 본인 지갑 전용; HL/Lighter는 유지). 그 외 출력/명령 불변.

---

# Phase 3 — READ-path / Rule #2 감사 (2026-06-21)

**각도:** 보낸 payload(Phase 2)가 아니라 **읽는 데이터** — 응답 파싱 정확성 + Rule #2(No-Fallback) 위반(silent `?? default` / `catch{}`가 금융 데이터 조작·실패 은폐). 멀티에이전트 audit(self-verify, verify 단계는 레이트리밋 회피 위해 제거 → 결과는 직접 라이브/코드 검증). **15개 후보 → P1 7개 수정, P2 8개 defensible 처분.**

## 수정한 P1 (7개)

| DEX | 결함 | 검증 | 커밋 |
|---|---|---|---|
| Lighter | `getFundingRates` 거래소 필터 누락 → 멀티거래소 aggregate(634행)에서 타 거래소 rate가 Lighter rate를 덮어씀(last-write-wins) | 라이브: binance165/bybit156/hl132/lighter181 | `3dd5df0` |
| Lighter | `getKlines`가 `res.candles` 읽음 → API는 키 `c` → 항상 빈 캔들 | 라이브: `/candles` top keys `code,r,c` | `3dd5df0` |
| Lighter | `getRecentTrades` timestamp `×1000` → 이미 ms(13자리) → year ~58000 | 라이브: timestamp 1781970606461 | `3dd5df0` |
| HL spot | `getSpotBalances`/`getSpotMarkets` `catch{return []}` → fetch 실패를 빈 결과로 위장(arb 사이징·post-fill 검증 오작동) | 코드 | `49b7f6b` |
| Pacifica | `getPositions` 레버리지 `?? 1` 조작 — /positions에 leverage 없고 default-leverage는 settings에서 blank → 1x 표시 + marginRequired 왜곡. settings `catch{}` swallow도 제거 → margin에서 도출 | doc 2회 확인 + 코드 | `f4e5775` |

## P2 처분 (8개 — defensible, 미수정)

- 대부분 market-data **display-path `?? "0"` 방어**(corruption-only 트리거; 이전 numeric-audit이 balance/positions의 risk-gating 필드는 이미 `parseFiniteVenueNumber` strict로 전환). 표시 필드의 "0" 기본값은 합리적.
- **Aster openInterest 하드코딩 "0"**: OI는 per-symbol 전용 엔드포인트뿐 → market-list에서 N회 호출 필요 → 의도된 비용 트레이드오프.
- **Aster positionRisk best-effort "0"**(Phase 1에서 추가): 실패 시 mark/liq "0", 단 `enforceOrderRisk`의 price≤0 가드가 위험 케이스 차단.

## 기각 (Phase 2)
- HL `updateIsolatedMargin` Math.abs (워크플로우 3-vote 만장일치) · Lighter `_selfTransfer` 이중스케일(직접 검증 — 저수준 signer는 미스케일).

## Phase 3 검증
- 빌드 0 · **전체 1565 tests PASS** (91 files). 각 P1 fix 회귀 가드 + 라이브 API shape 확인 포함.
- Pacifica 레버리지(margin 도출)는 라이브 계정 미확인 → 커밋 NOTE에 실계정 검증 권장 명시.
