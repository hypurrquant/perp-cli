# QA 리포트 — 4개 Perp DEX 업데이트 감사 + P1 수정

- **날짜:** 2026-09-04
- **브랜치:** `qa/2026-05-16-numeric-audit-test-followup` (Phase 2·3·4와 동일 브랜치에 계속)
- **베이스 커밋:** `2d2ff70` (docs(qa-report): append Phase 4)
- **추가 커밋 (4):**
  - `1d0ef99` fix(pacifica): revoke agents via the real endpoint and stop reporting refusals as success
  - `d4dfebc` fix(hyperliquid): fail closed on editOrder and surface per-order modify rejections
  - `4d73948` feat(errors): map Aster -5050 DEPOSIT_REQUIRED with remediation
  - `3b36fb3` fix(lighter): correct the L1 deposit --asset-id default from 2 (LIT) to 3 (USDC)
- **감사 구간:** 2026-06-20(직전 감사) → 2026-09-04. 브랜치는 6/21 이후 약 2.5개월 휴면.
- **방법:** DEX별 병렬 에이전트가 공식 문서/스펙 레포/공식 SDK를 라이브 fetch → 어댑터와 대조. 모든 주장은 문서 인용 또는 `file:line` 요구. 고위험 주장(자금·키·게이트)은 메인 세션에서 **직접 재검증**.

---

## 0. 헤드라인

**거래소 프로토콜 변경으로 깨진 것은 없다.** 4개 DEX의 서명 코어(HL L1 action hash, Aster EIP-712 도메인, Pacifica canonical JSON, Lighter WASM 상수)는 전부 정본과 일치했다. 변경은 대부분 완화·추가 방향이었다.

이번 감사의 실제 수확은 두 가지다.
1. **6월 감사가 놓친 선재 결함** — 그중 3건은 "성공했다고 보고하고 실패하는" 부류.
2. **API 시그니처가 아니라 거래소 정책·경제 모델이 바뀐 것** — drift 감사로는 잡히지 않아 문서를 직접 읽어야 나온다.

---

## 1. DEX별 업데이트 현황

| DEX | 문서 변경량 | 우리를 깨는 변경 | 주요 내용 |
|---|---|---|---|
| **Aster** | 30+ 커밋 | **없음** | nonce 창 10s→±60s 완화, nonce 스코프 user→agent, `registerAndApproveAgent` chainId 정정, 신규 엔드포인트 5종 |
| **Hyperliquid** | 중간 | **없음** | cancel `f`(fast) / modify `a`(always_place) 플래그, HIP-4 deployer 액션, l2Book fast |
| **Lighter** | 적음 | **없음**(SDK 미업그레이드 시) | tx 35/36/45 추가, WASM ABI에 `skipNonce` 삽입(1.0.11) |
| **Pacifica** | **0건** | **없음** | 6/20 이후 신규 API 변경 없음. 공식 changelog는 2026-05-04 이후 정지 |

**라이브 상장 변동** (6/20 스모크 대비): HL 230→233 · Pacifica 69→76 · Aster 483→**555** · Lighter 198→**233**. 4개 DEX read 경로 전부 정상.

### 1.1 유일하게 이미 라이브에서 터지는 변경 — Aster `-5050`

`e9cd13e` CHANGELOG: *"Starting **2026-09-01 00:00 UTC**, all authenticated V3 API endpoints will only be accessible once the main wallet ... has completed a deposit."* 감사 시점 기준 **3일째 적용 중**.

- **면제:** agent wallet CRUD, builder, public market data.
- **함정:** 면제 덕분에 `wallet agent create aster`는 **성공**하고, 첫 인증 조회에서 실패한다. 사용자는 설정을 마쳤다고 믿은 뒤 원인 불명 에러를 만난다.
- **영향 범위:** `_signed*Eip712`를 타는 Aster 인증 경로 전량 (balance/positions/orders/history/pnl/trade/cancel/leverage).
- **성격:** API drift 아님. 우리가 보내는 것은 옳고, **새 실패 모드가 생긴 것**.

---

## 2. 적용한 수정 (P1 5건)

| # | 결함 | 심각 | 커밋 |
|---|---|---|---|
| 1 | **Pacifica revoke 무음 실패** — 타입·엔드포인트 둘 다 오답 + 응답 폐기 → 사용자는 폐기됐다고 믿지만 agent 키가 거래 권한을 유지 | **P1 (보안)** | `1d0ef99` |
| 2 | **HL `editOrder` `?? "buy"` 폴백** — 주문 미발견 시 매도→매수 재작성 → 포지션 오픈/플립 | **P1** | `d4dfebc` |
| 3 | **HL modify per-order 거부 미검사** — 거래소가 거부한 정정을 초록색 성공으로 출력 | **P1** | `d4dfebc` |
| 4 | **Aster `-5050` 미매핑** — 정체불명 `EXCHANGE_ERROR`로 낙하, remediation 없음 | P1 | `4d73948` |
| 5 | **Lighter deposit `--asset-id` 기본 2(LIT)** — 6월 P0 수정이 withdraw에만 적용, deposit 누락 | P1 | `3b36fb3` |

### 2.1 Pacifica revoke (`1d0ef99`)

정본은 공식 SDK `rest/api_agent_keys_detailed.py`(최종 커밋 2025-10-27 — 6월 감사보다 8개월 앞섬): `revoke_agent_wallet` → `POST /agent/revoke`, `revoke_all_agent_wallets` → `POST /agent/revoke_all`.

우리 구현은 `unbind_agent_wallet` → `POST /agent/bind`. **둘 다 Pacifica에 존재하지 않는다.** 게다가 이중으로 삼켰다:
- `agent.ts` `revokePacAgent()` — `await fetch(...)` 응답을 status 확인 없이 폐기 (`// Revoke is best-effort — don't throw on HTTP errors`)
- 호출부 — `try { ... } catch { /* best effort */ }`

결과: 서버가 거부해도 CLI는 성공 출력 + 로컬 메타 삭제. **거래 권한이 있는 키가 살아있는 채로 식별 수단만 사라진다.**

코드에 붙어있던 `FIXME(2c-spike): unverified endpoint ... Confirm against live mainnet`가 정확히 이걸 예고하고 있었다.

**아이러니:** 올바른 구현이 `src/pacifica/client.ts:437` `revokeAgentWallet()` / `:452` `revokeAllAgentWallets()`에 처음부터 있었고 **호출처가 0건**이었다.

조치: 타입·엔드포인트 교체, 비-2xx 및 `200 + success:false` 모두 throw + remediation, revoke 커맨드에서 삼킴 제거(실패 시 로컬 레코드 보존, `--force`는 로컬 정리 전용 유지), rotate는 계속 진행하되 stderr 경고.

### 2.2 HL editOrder (`d4dfebc`)

**(a) 폴백:** `const side = existing?.side ?? "buy"`. 6월 `c54fc99`가 Aster에서 동일 패턴을 *"fails closed on missing"*으로 고쳤으나 HL은 점검하지 않았다 — CLAUDE.md의 다중 어댑터 동시 검사 규칙 미적용 사례.

**(b) false success:** `_signAndSendAction`은 외피 `status === "err"`만 throw. HL은 거부를 `status:"ok"` + `statuses[0].error`로 반환한다. per-order 검사인 `_validateOrderFill`은 시장가 경로에서만 호출되어 modify는 무검사 통과 → `trade.ts:727`이 조건 없이 초록색 출력.

조치: RAW `frontendOpenOrders`를 읽어 side·reduceOnly 보존 + 트리거 주문 거부, `_validateModifyResult` 추가.

**남긴 것 — `always_place`:** `a` 미전송은 문서상 옳지만(*"`a` must be skipped if false"*), 그 경로에서 non-executable GTC는 **TIF가 ALO로 오버라이드**된다(`exchange-endpoint.md:266`). 즉 정정한 주문이 체결 가격에 닿아도 테이커 체결되지 않는다. `a: true` opt-in 노출이 해법이나 이번 커밋에 묶지 않고 §5로 이관.

### 2.3 Aster `-5050` (`4d73948`)

`DEPOSIT_REQUIRED`(403, non-retryable) 신설 + 분류 분기(메시지/코드명/숫자 `-5050` 3중 매칭).

부수로 **어댑터의 구조적 결함 2건**을 함께 고쳤다:
- `aster.ts`가 `json.code`를 에러 판정에만 쓰고 `classifyError`에 넘기지 않아 **코드 기반 매핑이 원천 불가**였다 → 코드를 분류 입력에 포함하고 `details.venueCode`로 보존(사용자 메시지는 불변).
- 두 throw 지점이 `classifyError`의 `remediation`을 **드롭**하고 있었다 → 전파.

### 2.4 Lighter deposit asset-id (`3b36fb3`)

`funds.ts`에 `--asset-id`가 두 번 선언돼 있고 6월 `966ffc0`이 withdraw만 고쳤다. 라이브 `assetDetails`: **3 = USDC**(l1_decimals 6), 2 = LIT(l1_decimals 18), 1 = ETH.

핸들러 자기모순: USDC ERC20(`0xa0b8…eb48`, `/api/v1/layer1BasicInfo`가 USDCContract로 확인)을 approve·전송하고 `parseUnits(amount, 6)`로 계산하면서 자산을 LIT로 선언.

가드는 **옵션 기본값 자체**에 걸었다 — 결함이 핸들러가 아니라 선언부에 있었고, 그래서 핸들러 테스트가 잡지 못했다.

---

## 3. 우리 6월 작업 정정 2건

### 3.1 `cde3212` "HL user-signed action → SDK 라우팅" — 3건 중 1건은 fix가 아니었다

| 항목 | SDK 1.7.7 실제 | 정본 `signing.py` | 판정 |
|---|---|---|---|
| #3 `withdraw3` | user-signed, `WITHDRAW_SIGN_TYPES`와 필드·타입·순서 동일 | `:96-101` | ✅ 옳았음 |
| #9 `approveBuilderFee` | user-signed, 타입·primaryType 동일 | `:427-437` | ✅ 옳았음 |
| #10 `tokenDelegate` | **L1 서명**(`signL1Action`), 액션에 `hyperliquidChain`·`signatureChainId` 없음 | `:442-449` **user-signed** | ❌ **무효** |

`#10`은 수정 전후가 동일하다(자체 L1 스킴 → SDK의 동일 L1 스킴). **6월 Phase 2 표의 해당 행은 "fix"가 아니라 "미해결"로 정정한다.** 원인은 stale SDK가 아니라 SDK 1.7.7 자체 버그이며, `latest == 1.7.7`이라 업그레이드로 해소되지 않는다.

**실피해 0** — `tokenDelegate`는 어댑터 메서드 정의만 있고 호출처가 없다(미배선). 배선 전에 SDK 경로를 버리고 `agent.ts:1739-1744`의 `approveAgent` 패턴대로 직접 user-signed 서명해야 한다.

### 3.2 Pacifica `unbind_agent_wallet` "미문서화" 처분은 오판

6월 감사는 `operation-types` 표에 unbind가 없다는 이유로 "미문서화"로 처분했다. 실제로는 문서화된 revoke가 공식 SDK에 존재했다(§2.1).

**구조적 원인:** 그 표 자체가 불완전하다 — `edit_order`(edit-order.md), `add_isolated_margin`(add-isolated-margin.md) 등이 개별 페이지에만 존재한다. **앞으로 Pacifica는 표 + 개별 페이지 + 공식 SDK 3중 확인**이 필요하다.

---

## 4. 감사 범위 밖이었던 것 — 경제 모델 변화 (미수정, 설계 판단 필요)

API 시그니처가 안 바뀌어 drift 감사로는 안 잡히는 부류. **전부 미수정**이며 §6 참조.

### 4.1 Pacifica auto-lending 기본 ON

- `auto_lend_disabled`: *"`null` means default (**enabled**)"* — 신규 계정은 `null`
- *"**Any account meeting the threshold is automatically a lender**"*, 자격 = USDC ≥ 1,000
- 차입 진입도 무이벤트: *"An account is treated as a borrower whenever `equity_without_spot < 0` … **No user action is required**, and no explicit borrow transaction is submitted."* 차입 APR 최대 **50%**, 이자 60초마다 누적.

**빌려준 USDC가 잠기지는 않는다**(opt-out 절: *"USDC balance remains usable for trading"*). 고 utilization 시 lender 인출 제한은 문서 서술 없음 — **미확인**.

**우리 숫자에 대한 영향 3건:**

| # | 무엇 | 증거 |
|---|---|---|
| 1 | `equity`가 USDC 현금이 아님 — `account_equity` = *"Account balance + unrealized PnL + isolated margin + **raw spot market value**"* | `pacifica.ts:252` |
| 2 | 차입·이자 상태를 CLI로 알 수 없음 — `pending_interest` 타입 선언만 있고 참조 0건 | `types/account.ts:10` |
| 3 | **사전 게이트가 검증 불가 조건을 PASS로 단언** | 아래 |

**(3) 상세.** 거부 조건은 *"When pool `utilization > 90%`, accounts carrying a borrow (`equity_without_spot < 0`) cannot place new perpetual orders unless reduce-only."* 3개 AND 중 **2개를 판정할 수 없다**:

```
cross_account_equity  → src 전체 0건
spot_collateral       → src 전체 0건
pending_interest      → 선언만, 참조 0건
loan_pool             → src 전체 0건
```

`trade-validator.ts:117-135`는 NaN `available`에 대해 Rule #2 가드를 정성껏 두고, 바로 다음 `:139`에서 `balance_sufficient: passed: true`를 단언한다. **NaN은 정직하게 실패시키면서 더 큰 미검증 조건은 PASS로 넘기는 비대칭.**

- 빈도: 낮음(스트레스 조건 동시 충족 필요)
- 피해: 단건은 422로 경미. **twap/scale-in/multi-leg는 leg 중간 throw → 한쪽 다리만 열린 미헤지 포지션**(`trade-validator.ts:300` 공유 게이트)
- 실패 자체는 Rule #2 준수(`client.ts:105-114`가 body 담아 throw). 위반은 앞단의 거짓 사전보증.

### 4.2 HL portfolio 모드 담보·부채 회계

```ts
hyperliquid.ts:515  const PORTFOLIO_COLLATERAL = ["HYPE", "BTC", "USDH"];
```

문서(`portfolio-margin.md` cap 표, `account-abstraction-modes.md`)는 **HYPE / BTC / USDC / USDT**. `USDH`는 담보가 아니고 **`USDT`가 누락** → USDT 담보 계정은 `:524-529`의 미반영 경고를 받지 못한다.

더 큰 쪽: `:511` `equity = spotTotal`(USDC만)로 끝나는데 portfolio는 부족분을 자동 차입한다. `borrowLendUserState`는 **참조 0건** → 부채 미차감 → equity 과대 → `enforceOrderRisk` 사이징이 헐거워진다.

P2(portfolio 모드 계정 한정). **담보 목록 오류는 문서만으로 확정, probe 불필요.** 부채 크기는 `borrowLendUserState` public info POST 1회로 확인 가능 — 서명·자금 이동 불필요.

### 4.3 Lighter 다중자산 담보 라이브

라이브 `assetDetails`에서 ETH·XAUT가 `margin_mode: enabled`. `getBalance`(`lighter.ts:541-569`)는 USDC만 집계.

---

## 5. 미수정 P2 / 신규 기능

| 항목 | 근거 | 비고 |
|---|---|---|
| **Lighter 비-USDC 출금 100배 과소** | `lighter.ts:895-908` `_withdrawRaw`가 `assetId` 무관 `×1e6` 고정. ETH·LIT는 decimals 8 | 기본 USDC 경로는 정확 → P2 |
| **HL `a: true` (always_place)** | `exchange-endpoint.md:266` GTC→ALO 무음 변환 | opt-in 플래그, `false`면 반드시 키 생략 |
| **HL `f: true` (fast cancel)** | `:180` *"prioritized in the mempool **if and only if** `fast = true`"* | 지금은 무해. **예고된 업그레이드 후 우리 취소 전부 후순위** |
| **Lighter rate-limit fan-out** | `lighter.ts:638-647` `getOpenOrders`가 활성 마켓 수만큼 `/accountActiveOrders` 동시 발사. 표준 한도 60 req/min | 폴링 루프와 겹치면 429 |
| Aster `agentCode` | spec L4757 referral/invitation code | 우리는 미전송(`agent.ts:1525-1551`). 임베디드 referral 정책 확인 필요 |
| Pacifica `builder_code` 누락 | `client.ts:275` `createStopOrder`, `:339` `setTPSL`이 `addBuilderCode` 미적용 (market/limit/TWAP은 적용) | changelog 2026-04-23 *"all order creation endpoints"*. **레퍼럴 수익 누수** |
| Pacifica `AccountSettings` 타입 불일치 | 문서 응답 `{auto_lend_disabled, margin_settings[], spot_settings[]}` vs 우리 `{symbol, margin_mode, leverage}` 배열 | `perp account settings` 출력이 빌 가능. **라이브 미확인** |
| Pacifica cross leverage=1 잔존 | `margin`은 isolated 전용 → cross는 `"0"` → `pacifica.ts:301` `|| 1` 폴백. 문서상 기본은 max leverage | 표시 경로 한정(`account.ts:470` 마진율 과대). 주문 게이트 무관 |

**신규 기능 (미지원, 순위):** HL `a`/`f`/priority-fee grouping/borrow-lend 조회 · Lighter Integrator 수수료 귀속(tx 45)/단일 마켓 원자적 cancel-all/POST_ONLY/TWAP · Aster `registerAndApproveAgent` 이관/guarded cancel/`PUT /fapi/v3/batchOrders` · Pacifica attached TP/SL.

---

## 6. SDK 판정

| 패키지 | 설치 | latest | 판정 |
|---|---|---|---|
| `lighter-ts-sdk` | 1.0.10 | **1.0.13** (2026-07-10) | **조건부 안전** |
| `hyperliquid` | 1.7.7 | 1.7.7 (2025-09-05 published) | 업그레이드 경로 없음 |

**Lighter 업그레이드 — 이중 스케일 P0 없음.** 두 버전 signer 소스 대조 + 실서명에서 `usdcAmount` passthrough 확인. 저수준 `WasmSignerClient`는 여전히 스케일하지 않으므로 `lighter.ts:902`의 `×1e6`은 유지가 맞다. perp-cli가 쓰는 서명 7종(createOrder 3 / cancel·cancelAll·modify / updateLeverage / signWithdraw / signTransfer)이 `ExpiredAt`·`Sig` 제외 **전 필드 동일**.

**단 1곳 차단:** 1.0.11이 WASM ABI에 `skipNonce`를 `nonce` 앞에 삽입 → `lighter-spot.ts:418-422`의 raw 10-arg `signTransfer`가 실패. 실행 증거 `[1.0.10] err=none` / `[1.0.11~13] err=SignTransfer expects 11 args`. **fail-loud라 자금 위험 0**이나 `transferUsdcToSpot`/`transferUsdcToPerp`가 죽어 spot 경로 전면 중단, 그리고 throw가 `if (wasmModule?.signTransfer)` 분기 안에서 나므로 SDK fallback으로 흐르지 않는다.

→ **`memo`와 `nonce` 사이 `0` 삽입을 SDK 업그레이드와 동일 커밋에 포함할 것.** 먼저 넣으면 1.0.10에서 반대로 깨진다.

**SDK 상수 오값은 무영향** — `lighter.ts:18`의 `import type` 하나뿐이고 `LIGHTER_CONSTANTS`·`TransactionType`·`OrderType`·`TimeInForce` 참조 0건. 자체 상수(`lighter.ts:29-35`)와 인라인 리터럴을 쓰며 전부 문서 정본과 일치.

---

## 7. 테스트 결과

- **빌드:** `tsc` exit 0
- **전체:** 92 files / **1583 tests PASS** (세션 시작 91 files / 1565 → **+18**)
  - HL editOrder/modify 가드 +7 (side·reduceOnly 보존, fail-closed, 트리거 거부, 거부 3종)
  - Pacifica revoke 가드 +5 (정본 타입/엔드포인트, revoke-all 분리, 빈 문자열 거부, 실패 3종에서 레코드 보존, `--force`)
  - Aster DEPOSIT_REQUIRED +5, Lighter asset-id +4 (신규 파일), revoke-all 캐노니컬 +1
- **덮어쓴 잘못된 계약 2건:**
  - `editOrder defaults to buy when order not found` — **위험한 기본값을 의도된 동작으로 고정**하고 있었음
  - `network error in revoke POST → settings still cleared` — **결함 자체를 고정**하고 있었음

---

## 8. 공개 인터페이스 변경

- **신규 에러 코드 `DEPOSIT_REQUIRED`** (403, non-retryable). JSON 소비자는 새 코드를 만날 수 있다.
- **Aster 에러에 `details.venueCode` 추가.** 사용자 메시지 문자열은 불변.
- **`perp wallet agent revoke pacifica`가 실패 시 에러로 종료**(기존: 항상 성공 출력). 로컬 정리만 원하면 `--force`.
- **`perp trade edit`이 HL에서 거부 시 에러로 종료**(기존: 초록색 성공 출력). 미발견 주문과 트리거 주문은 이제 거부.
- **`perp funds deposit lighter ethereum` 기본 `--asset-id` 2 → 3.** 이전 기본값에 의존하던 호출자는 명시 지정 필요.
- 어댑터 내부: `buildUnbindAgentMessage` → `buildRevokeAgentMessage` + `buildRevokeAllAgentsMessage` (SDK 소비자 영향).

---

## 9. 사람 검토 / testnet 필요

| # | 항목 | 필요 자원 |
|---|---|---|
| 1 | **Pacifica revoke 라이브 확인** — 엔드포인트·타입은 공식 SDK로 확정했으나 실제 revoke 미실행 | 실계정 |
| 2 | **Lighter deposit asset-id 온체인 확증** — 문서가 `_assetIndex`를 assetDetails로 안내하나 브리지 컨트랙트 레지스트리 직접 미확인 (번들 SDK `L1BridgeClient`는 구형 2-arg ABI라 대조 불가) | 소액 입금 |
| 3 | **HL editOrder 라이브** — 트리거 거부·거부 검사 모두 단위 검증만 | 실계정/testnet |
| 4 | **Aster `registerAndApproveAgent` 봉투** — chainId 축은 해소(우리 56이 정답). 남은 축은 봉투 구조이며 우리가 쓰는 `/approveAgent`·`DELETE /agent`·`approveBuilder` **3개 모두 스펙 미문서** → 문서만으로 판정 불가. `scripts/probe-aster-agent.ts` 매트릭스를 2×2 → **2로 축소 가능** | testnet |
| 5 | **HL `wallet manage account-mode`** — 정본 `USER_SET_ABSTRACTION_SIGN_TYPES`는 `[hyperliquidChain, user, abstraction, nonce]`인데 우리는 `user` 없이 3필드 서명(`agent.ts:1946-1951`). struct hash 불일치로 거부 예상. 단위테스트가 action shape만 봐서 미검출 | 마스터 키(자금 무관) |
| 6 | **HL portfolio 부채 크기** — `borrowLendUserState` public POST 1회 | 실계정 read만 |
| 7 | **Pacifica `AccountSettings` shape** — `perp account settings` 실출력 확인 | 실계정 |

---

## 10. 다음 권장 액션

1. **§9-1·2 라이브 확인** — 이번에 손댄 자금·키 경로 2건. 가장 먼저.
2. **§4.1 Pacifica 차입 가시화** — `getBalance`에 `cross_account_equity`·`pending_interest`·`spot_collateral` 노출, `equity_without_spot < 0`이면 차입 플래그. 이어서 `getLoanPool()` 추가 후 게이트에서 **"검증 불가"를 PASS로 단언하지 않도록** 수정.
3. **§4.2 HL `PORTFOLIO_COLLATERAL` 정정** — `USDH` 제거, `USDT`·`USDC` 추가. 문서만으로 확정된 건이라 즉시 가능.
4. **§5 Pacifica `builder_code` 2곳 추가** — 레퍼럴 누수, `addBuilderCode()` 두 줄.
5. **§6 Lighter SDK 1.0.13 업그레이드** — `lighter-spot.ts:418` `skipNonce` 삽입과 **반드시 동일 커밋**.
6. **§5 HL `f`/`a` 플래그 노출** — `f`는 예고된 업그레이드 전 선제 대응 성격.
