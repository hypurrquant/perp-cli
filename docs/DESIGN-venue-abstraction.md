# Venue 추상화 재설계 (Lighter RH · Ondo · Arcus · Variational 도입 대비)

- **[REMOVED 2026-10-02] Variational은 사용자 요청으로 코드베이스에서 완전히 제거되었다** (`src/exchanges/variational/`, `venues/variational.ts`, alias `omni`). 아래 Variational 관련 서술(§4, §10.1, §13 표, 리서치 부록)은 설계/리서치 기록으로만 보존하며 현재 구현이 아니다. `VenueDefinition.create: null`·`roles` 메커니즘은 일반 구조로 유지.
- 상태: **Implemented — 테스트 대기** (2026-09-30). 설계 critic 3회(v1 REVISE → v2 REVISE → v3 APPROVE-WITH-EDITS, §10/§10.13) 반영 후 구현. 구현 리뷰(code-reviewer) + 재검증(verifier) 지적 반영. 실금액/테스트넷 검증 항목은 §11
- 준수 규칙: [`SSOT_RULES.md`](./SSOT_RULES.md) Rule #2 (No Fallback), Rule #3 (Single Secret Source)
- 범위:
  - `src/exchanges/**` (perp 어댑터 + `spot-interface.ts` / `lighter-spot.ts` / `hyperliquid-spot.ts` + outcome 어댑터)
  - 어댑터 생성 경로 5곳: `src/index.ts` (`getAdapter`, `_initWithOws`, `getAdapterForExchange`, `getHLAdapterForDex`) + `src/mcp-server.ts`
  - **어댑터를 거치지 않는 public 데이터 경로**: `src/funding/rates.ts`, `src/funding/normalize.ts`, `src/api/public/**`, `mcp-server.ts` `fetchMarketsPublic`
  - venue 이름으로 키잉된 상태: `src/config.ts` (`Exchange` union, `envMap`), `src/settings.ts`, `src/commands/init.ts` (`EXCHANGE_ENV_MAP`), agent store, keystore
  - 심볼 매핑: `src/dex-asset-map.ts`, `spot-interface.ts` `SPOT_PERP_TOKEN_MAP`
  - 소비자: `src/commands/**`, `src/bot/strategies/**` (23개), MCP tools (22개)

---

## 0. TL;DR

CCXT 수준의 "완전 통일"은 하지 않는다. 신규 4개 venue 모두 CCXT 미지원이고 주식 퍼프 / RFQ / 비동기 ack 등
모양이 제각각이다. **기존 `ExchangeAdapter`는 그대로 두고**, 그 옆에 다음을 추가한다.

| # | 층 | 해결하는 문제 | 누가 필요로 하나 |
|---|---|---|---|
| L1 | **VenueDefinition** — venue id · 네트워크 설정 · 비밀 저장소 · funding 주기 · 팩토리 | venue = 클래스 1:1 가정, 생성 경로 5개, 이름 하드코딩 | Lighter RH (같은 클래스, 다른 설정), 전부 |
| L2 | **Public 데이터 경로를 venue 정의로** | `funding/rates.ts`의 venue별 하드코딩 fan-out | Variational(읽기 전용), 신규 전부 |
| L3 | **역할 인터페이스 + 명시적 Capability** (새 코드 전용, 새 메서드 이름) | 읽기 전용 venue 표현 불가, "있지만 모양이 다른" 기능 | Ondo(정정 없음), Arcus(TP/SL batch only) |
| L4 | **정규화된 주문 결과 + 마켓 메타데이터 + 단일 canonical 심볼** | `Promise<unknown>`, 주식 퍼프 세션 정보 없음, 심볼 매핑 3곳 | Arcus(비동기), 주식 퍼프 3곳 + HL HIP-3 |

신규 venue 착수 전에 **기존 Rule #2 위반 3건(funding 주기 `?? 1`, `tryGetAdapter` 삼킴, optional 마켓 필드)** 을 먼저 정리한다.

---

## 1. 현재 구조와 문제점 (근거)

### 1.1 현재 구조
- `src/exchanges/interface.ts` — 단일 `ExchangeAdapter` (market data + account + trading + risk). trading/risk 메서드 7개가 `Promise<unknown>`.
- `src/exchanges/capabilities.ts` — 선택 기능 11종을 **메서드 존재 여부(duck typing)** 로 판별 (`hasPacificaSdk`는 내부에서 `adapter.name === "pacifica"` 분기).
- `src/exchanges/registry.ts` — `{ name, aliases, chain }`만 등록. 생성 로직 없음.
- 어댑터 생성 경로 **5개**, 서로 동작이 다름:
  - `index.ts` `getAdapter` (117-274), `_initWithOws` (277-371), `getAdapterForExchange` (409-548), `getHLAdapterForDex` (552~)
  - `mcp-server.ts` `getAdapter` (45-71, agent tier·OWS·testnet·Pacifica builder code 미반영) + `fetchMarketsPublic` (~89-110)
  - family별 모듈 싱글턴 캐시: `_lighterAdapter`, `_pacificaAdapter`, `_hlAdapter`
- funding 비교/arb 스캔은 **어댑터를 안 거친다**: `funding/rates.ts:198-209` `fetchAllFundingRates` → `fetchPacificaRates / fetchHyperliquidRates / fetchLighterRates / fetchAsterRates` (raw fetch + `api/public/urls.ts`). 소비자: `commands/arb.ts`, `portfolio.ts`, `alerts.ts`, `dashboard/server.ts`, `mcp-server.ts`.

### 1.2 문제점

| # | 문제 | 근거 |
|---|---|---|
| P1 | venue 식별이 클래스에 하드코딩 | `lighter.ts:65-66` `name = "lighter"; chain = "ethereum"`, `:114-117` URL·chainId(304/300) (+ `:115` `LIGHTER_TESTNET_URL` env override) |
| P2 | venue 이름 분기 산재 | `(===\|case) "(lighter\|aster\|hyperliquid\|pacifica)"` **152줄 / 25파일**(테스트 제외). `!==`, alias(`"lt"`,`"hl"`,`"pac"`,`"ast"` → 174줄), `Record<Exchange,…>` 맵, 객체 키(`lighter:` ~125줄)까지 포함하면 실제 범위는 더 큼. 상위: agent.ts 21, arb-auto.ts 20, index.ts 14, mcp-server.ts 12, arb.ts 12 |
| P3 | 생성 경로 5개 + 동작 불일치 | §1.1. `getAdapterForExchange`(Pacifica)는 OWS Tier 2 생략, `_initWithOws`(HL)는 agent tier 생략, MCP는 agent/OWS/testnet 전부 생략. `tryGetAdapter`는 모든 에러를 삼키고 null 반환 (**Rule #2 위반**) |
| P4 | 캐시가 family 단위 | `_lighterAdapter` 싱글턴 → `lighter-rh`를 요청해도 캐시된 Lighter 인스턴스가 반환될 구조 |
| P5 | WASM 서명기 공유 상태 **(검증 필요)** | `lighter.ts:1381` `_wasmClient` static. `createClient({chainId})`는 어댑터마다 호출(`:329-335`, `:1453-1459`)되므로 "chainId 1회 고정"은 아님. 다만 Go 런타임 상태가 account/apiKeyIndex로 키잉된다면 Lighter·RH 동시 사용 시 충돌 가능 → **SDK 확인 후 판단** |
| P6 | 비밀·설정이 venue 문자열로 키잉 | keystore 디렉터리 `lighter-keystore.ts:60` `"lighter-agents"`, 경로 `:65` `{accountIndex}-{slot}.json`. settings `referralCodes.lighter`, `referralApplied.lighter`, `fees.lighter`, `agents.lighter`(`settings.ts:165-170` key별 merge), `config.ts:10` `Exchange` union, `config.ts:88-93` `envMap`, `init.ts:88` `EXCHANGE_ENV_MAP` |
| P7 | 담보 자산 하드코딩 | `lighter.ts:559` `symbol === "USDC"`, `lighter-spot.ts:110-111,198,405` `/USDC`, `:139` `parts[1] ?? "USDC"` (**Rule #2 위반**), `:424` `assetIndex = 3 // USDC` |
| P8 | funding 주기 기본값 (**Rule #2 위반, 금전 영향**) | `funding/normalize.ts:19-24` `EXCHANGE_FUNDING_HOURS` 이름 키잉, `:32,37` `?? 1`. 신규 venue는 전부 조용히 1h 취급 → 8h venue면 8배 과대평가된 rate로 arb/sizing |
| P9 | optional 마켓 필드 (**Rule #2 위반**) | `ExchangeMarketInfo`의 `sizeDecimals?`, `stepSize?`, `fundingHours?`, `marginTiers?` + `maxLeverageForNotional`의 fallback |
| P10 | 읽기 전용 venue 표현 불가 | `ExchangeAdapter`가 trading 필수 |
| P11 | Capability = 존재 여부뿐 | Ondo `editOrder`는 cancel+replace, Arcus TP/SL은 batch grouping만, FOK 유무 등 표현 불가 |
| P12 | 주문 결과 비정규화 | `ExchangeAdapter` trading/risk 7개 `Promise<unknown>` (spot/outcome/capability 포함 `exchanges/*.ts` 전체 88곳) |
| P13 | canonical 심볼 SSOT 3곳 | `dex-asset-map.ts` `toCanonical`/`ALIASES` (HIP-3 dex 간 같은 이름 자동 매칭 = 추측 매칭), `spot-interface.ts` `SPOT_PERP_TOKEN_MAP`, (제안될) 주식 퍼프 매핑 |
| P14 | 레이트리밋 부재 | 공통 리미터 없음. Aster 429 backoff, `lighter.ts:269-274` 계정 조회 429 retry뿐. Ondo 기본 **1 req/s**, Lighter RH standard **60 req/min** |
| P15 | testnet 무시하는 하드코딩 URL (**버그**) | `commands/agent.ts:257`, `commands/funds.ts:465`(`createIntentAddress` 재구현, mainnet 고정), `dashboard/ws-feeds.ts:487` — `--network testnet`에서도 mainnet 호출 |

---

## 2. 설계 원칙

1. **기존 `ExchangeAdapter`는 건드리지 않는다.** 새 역할 인터페이스는 **새 메서드 이름**으로 추가해 오버로드·시그니처 충돌을 피한다. 기존 어댑터는 새 인터페이스를 *추가로* 구현하고, 소비자를 점진 이전한다.
2. **공통분모만 통일한다.** HIP-3, Pacifica lake, Ondo builder code 등 고유 기능은 capability guard로 남긴다.
3. **Capability는 데이터로 선언하되, 실제로 분기하는 필드만.** 소비자 없는 필드는 추가하지 않는다.
4. **venue ≠ 클래스.** 한 어댑터 클래스가 여러 venue 정의를 가진다 (`lighter`/`lighter-rh`, 그리고 이미 존재하는 HL HIP-3 dex 패턴).
5. **Rule #2:** 신규 타입의 "모르는 값"은 `T | null`, 기본값 대체 금지. **Rule #3:** 신규 venue는 비밀 저장소를 정의에 명시, env 변수 신규 도입 금지.

---

## 3. 설계

### L1. VenueDefinition

```ts
// src/exchanges/venue.ts (신규)
export type VenueId =
  | "pacifica" | "hyperliquid" | "lighter" | "aster"
  | "lighter-rh" | "ondo" | "arcus" | "variational";

/** 키 곡선/형태 — 현재 `chain` 필드가 실제로 쓰이는 의미 ("evm"/"solana"/"apikey" 비교: wallet.ts, init.ts, settings.ts) */
export type KeyKind = "evm" | "solana" | "lighter-l2" | "ed25519-apikey" | "hmac-apikey" | "none";

export interface VenueNetworkConfig {
  restUrl: string;
  wsUrl: string | null;
  explorerUrl: string | null;
  signingChainId: number | null;   // Lighter 304 / RH 466324 / Arcus 4663
  settlementChain: string;         // 자금이 있는 체인: "ethereum" | "robinhood" | "arbitrum" | "solana" | "bnb" | "offchain"
  collateral: string[];            // ["USDC"] | ["USDG"] | ["USDC","SPYon",...]
  collateralAssetIndex: number | null;  // Lighter 계열: USDC=3 / RH USDG=3 — 하드코딩 대신 여기서
}

export interface SecretStorage {
  kind: "ows-wallet" | "perp-keystore";
  /** perp-keystore면 ~/.perp/<dir>/ — venue id 기반 */
  dir: string | null;
}

export interface VenueDefinition {
  id: VenueId;
  aliases: string[];
  family: "pacifica" | "hyperliquid" | "lighter" | "aster" | "ondo" | "arcus" | "variational";
  keyKind: KeyKind;
  secretStorage: SecretStorage;
  networks: { mainnet: VenueNetworkConfig; testnet: VenueNetworkConfig | null };
  fundingIntervalHours: number;                // 필수. normalize.ts의 ?? 1 제거
  roles: ReadonlyArray<VenueRole>;             // L3
  capabilities: VenueCapabilities | null;      // L3 — trading role이 없으면 null
  rateLimit: RateLimitPolicy;
  restrictedRegions: string[];                 // 경고 표시용
  publicData: PublicDataFetchers;              // L2
  create(ctx: VenueCreateContext): Promise<ExchangeAdapter>;
}

export type VenueRole = "marketData" | "account" | "trading";

export interface VenueCreateContext {
  network: "mainnet" | "testnet";
  signerTier: "agent" | "master" | "pk" | "readOnly";  // 호출자가 명시 — 생성부가 추측하지 않음
  walletName: string | null;
}
```

**핵심 변경**
- **어댑터 식별:** 어댑터의 `readonly name`은 유지하되 값은 `VenueId` (생성 시 주입). `readonly chain`은 **`keyKind` + `settlementChain`으로 분리** — 현재 `chain`은 "키 형태" 의미로 쓰이고 있어 그대로 두면 RH(`robinhood`)에서 의미가 섞인다.
  → `adapter.name === "lighter"` 분기는 `lighter-rh`에서 false가 되므로, **Lighter family 공통 로직은 `venue.family === "lighter"`로** 바꿔야 한다 (Phase 3).
- **생성 통합:** 5개 경로를 `getVenue(id).create(ctx)` 하나로. 현재 경로 간 동작 차이는 **통합 시 하나로 정해야 하므로 behavior change**다 (§6 Phase 2에 명시).
  - MCP 서버가 agent tier를 쓰게 할지 여부는 **결정 필요** (§8).
- **캐시 키:** family 싱글턴 → `Map<\`${venueId}:${network}:${walletName}\`, ExchangeAdapter>`.
- **`tryGetAdapter`의 catch 제거** (Rule #2).
- **HL HIP-3 (`getHLAdapterForDex`)**: 이미 "한 클래스, 여러 dex" 패턴. 이번 설계에서는 **VenueId로 승격하지 않고** 기존 `DexCapable` guard로 유지 (HIP-3 dex는 동적으로 늘어나므로 정적 VenueId와 안 맞음). 단 canonical 심볼(L4)에는 포함.

#### 비밀 저장소 (Rule #3) — 신규 venue 포함

| venue | 비밀 | 저장소 | 비고 |
|---|---|---|---|
| lighter | L2 slot 키 | `~/.perp/lighter-agents/<account>-<slot>.json` | **기존 그대로** (마이그레이션 없음) |
| lighter-rh | L2 slot 키 | `~/.perp/lighter-rh-agents/<account>-<slot>.json` | 같은 모듈, 디렉터리만 venue id로. `lighter-keystore.ts:60` 상수 → 인자화 |
| ondo | HMAC key id + secret | `~/.perp/ondo-agents/<keyId>.json` (AES-256-GCM, 0600) | `perp agent add ondo --key-id` 로 등록 |
| arcus | Ed25519 API 키 (지갑 EIP-712로 등록) | `~/.perp/arcus-agents/<address>-<subaccount>.json` | 만료(≤180일) 메타 함께 저장, 만료 시 명시적 에러 |
| variational | 없음 (읽기 전용) | – | |

- 이 표를 `SSOT_RULES.md` Rule #3 기준 자리 목록에 추가한다.
- **`config.ts` `envMap`, `init.ts` `EXCHANGE_ENV_MAP`에 신규 venue 항목을 추가하지 않는다** (`ONDO_API_KEY` 류 금지).
- `lighter.ts:293-304` auto-setup이 키 저장 실패를 삼키는 부분은 RH가 그대로 물려받으므로 Phase 1에서 수정.

#### 설정(settings) 스키마
- `referralCodes`, `referralApplied`, `fees`, `agents` 를 `Record<VenueId, …>`로 타입화. 기존 키(`lighter` 등)는 그대로 유효 → 파일 마이그레이션 불필요, `lighter-rh` 등은 새 키.
- `config.ts` `Exchange` union → `VenueId`로 대체.

### L2. Public 데이터 경로를 venue 정의로

funding 비교·arb 스캔·대시보드는 어댑터가 아니라 `funding/rates.ts`의 하드코딩 fan-out을 쓴다. 여기를 바꾸지 않으면 venue를 추가할 때마다 fan-out을 또 고쳐야 한다.

```ts
export interface PublicDataFetchers {
  fetchFundingRates(network: "mainnet" | "testnet"): Promise<FundingRateSnapshot[]>;
  fetchMarkets(network: "mainnet" | "testnet"): Promise<VenueMarket[]>;
}
```

- `fetchAllFundingRates()` → `listVenues().filter(v => v.roles.includes("marketData")).map(v => v.publicData.fetchFundingRates(net))`.
- 기존 `fetchPacificaRates` 등은 각 venue 정의의 `publicData`로 **이동**(로직 재사용).
- `fetchMarketsPublic`(MCP)도 동일 경로로.
- funding 정규화는 `venue.fundingIntervalHours`만 사용 — `EXCHANGE_FUNDING_HOURS` 맵과 `?? 1` 삭제, 정의 없는 venue는 throw.
  - 마켓별로 주기가 다른 venue(HL HIP-3 등)는 `VenueMarket.fundingIntervalHours`(필수)가 우선.
- 부분 실패: 한 venue 실패 시 **결과에 `{ venue, error }`로 명시**하고 나머지는 반환 (조용히 누락 금지).

→ **Variational은 여기에만 참여**: `/metadata/stats`로 markets + funding. 사이즈별 quote는 호가창으로 합성하지 않고 별도 `getQuotes()` 타입으로 노출 (합성 호가 = 가짜 데이터).

### L3. 역할 인터페이스 + 명시적 Capability (새 코드 전용)

**기존 `ExchangeAdapter`는 변경하지 않는다.** 새 역할 인터페이스는 **겹치지 않는 새 메서드 이름**을 쓴다.

```ts
export interface VenueBase {
  readonly name: VenueId;
  readonly venue: VenueDefinition;
  readonly network: "mainnet" | "testnet";
}

/** v2 trading — 기존 marketOrder/limitOrder/stopOrder/editOrder/cancelOrder/cancelAllOrders/setLeverage와 이름이 겹치지 않음 */
export interface TradingV2 extends VenueBase {
  placeOrder(req: OrderRequest): Promise<OrderResult>;
  amendOrder(req: AmendRequest): Promise<OrderResult>;
  cancelByRef(symbol: string, ref: OrderRef): Promise<CancelResult>;
  cancelAllV2(symbol: string | null): Promise<CancelResult>;
  applyLeverage(symbol: string, leverage: number, marginMode: "cross" | "isolated" | null): Promise<LeverageResult>;
  getOrderStatus(symbol: string, ref: OrderRef): Promise<OrderResult>;
}

export type OrderRef = { kind: "orderId"; value: string } | { kind: "clientOrderId"; value: string };
export interface CancelResult { cancelled: OrderRef[]; failed: Array<{ ref: OrderRef; error: string }>; venueRaw: unknown }
export interface LeverageResult { symbol: string; leverage: number; marginMode: "cross" | "isolated"; venueRaw: unknown }
```

- 기존 4개 어댑터: `ExchangeAdapter` + `TradingV2`를 둘 다 구현 (TradingV2 내부에서 기존 로직 재사용). 신규 venue(ondo/arcus)는 **`TradingV2`만 구현하고 `ExchangeAdapter`는 얇은 shim**으로 제공(기존 명령이 동작하도록).
- 소비자(명령/봇/MCP)는 Phase 5에서 `TradingV2`로 이전 → 이전 완료 후 레거시 trading 메서드 제거.
- `setLeverage`의 현재 반환값을 출력하는 곳(`commands/trade.ts:804`, `plan-executor.ts:256`)은 이전 시 `LeverageResult`로 바뀜 → Phase 5의 출력 변경에 포함.
- 역할 판정: `hasRole(adapter, "trading")` — `venue.roles`를 SSOT로 사용. Variational은 `marketData`만 선언하고 **어댑터 인스턴스 자체를 만들지 않는다**(L2 public 경로로만 참여). `arb exec` 등 실행 경로는 `trading` role 없는 venue를 후보에서 제외.

#### Capability — 실제로 분기하는 필드만

```ts
export interface VenueCapabilities {
  marketOrder: "native" | "iocLimit" | "rfq";   // iocLimit/rfq면 slippageBps 필수
  timeInForce: ReadonlyArray<"GTC" | "GTT" | "IOC" | "FOK" | "ALO">;
  clientOrderId: boolean;
  orderAck: "sync" | "async";                   // async면 clientOrderId 필수 (아래 불변식)
  tpsl: "attached" | "separateOrders" | "batchGroup" | null;
  amend: "native" | "cancelReplace" | null;
  batchPlaceMax: number | null;
  marginModes: ReadonlyArray<"cross" | "isolated">;
  withdrawAssets: string[] | null;
}
```

- 각 필드의 소비자: `marketOrder`/`timeInForce`/`tpsl`/`amend` → `trade` 명령 사전 검증, `orderAck`/`clientOrderId` → `awaitOrderFinal`, `batchPlaceMax` → `scale-in`/`split`, `marginModes` → `trade leverage`, `withdrawAssets` → `funds withdraw`.
- `sandbox`는 `networks.testnet !== null`로 판단 (중복 필드 두지 않음). `hedgeMode`, `subaccounts`, `websocket` 등은 **소비자가 생길 때 추가**.
- 명령 계층은 전송 **전에** 검증 → 미지원이면 `NOT_IMPLEMENTED` + remediation. 예: `trade limit --tif FOK -e ondo` → "Ondo supports GTC/IOC/ALO".
- 기존 duck-typing guard는 venue 고유 메서드 접근용으로 유지. `hasPacificaSdk`의 `name === "pacifica"` 분기는 `venue.family`로.

### L4. 주문 결과 · 마켓 메타데이터 · canonical 심볼

#### 주문 요청/결과 (Rule #2 반영)

```ts
export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stopMarket" | "stopLimit";
  size: string;
  price: string | null;             // limit/stopLimit 필수
  triggerPrice: string | null;      // stop* 필수
  triggerSource: "mark" | "last" | "mid" | null;
  tif: "GTC" | "GTT" | "IOC" | "FOK" | "ALO" | null;
  reduceOnly: boolean;
  clientOrderId: string | null;     // venue.capabilities.orderAck === "async"면 필수 (CLI가 생성)
  slippageBps: number | null;       // marketOrder가 iocLimit/rfq면 필수. native일 때만 null 허용
  tpsl: { tp: string | null; sl: string | null } | null;
}

export interface OrderResult {
  status: "accepted" | "open" | "partiallyFilled" | "filled" | "rejected" | "cancelled";
  finality: "final" | "pending";    // pending = 확정 전 (async venue의 timeout 포함)
  orderId: string | null;
  clientOrderId: string | null;     // 불변식: orderId !== null || clientOrderId !== null
  filledSize: string;
  avgPrice: string | null;
  venueRaw: unknown;
}
```

- **slippage 기본값 없음:** 현재 어댑터마다 숨어 있는 슬리피지 상수(Pacifica 1%, Lighter ±100%/-50% 등)는 이 단계에서 드러내고, `--slippage` 플래그 또는 settings의 **명시적 값**에서만 온다. 둘 다 없으면 에러.
- **`awaitOrderFinal(adapter, ref, { timeoutMs })`**: `timeoutMs` 필수(기본값 없음). 타임아웃이면 `finality: "pending"`으로 반환하고 CLI는 `perp trade status <ref>` 안내. **추측으로 filled 처리 금지.**
- 참조 불변식: async venue는 `clientOrderId` 필수 → ack에 orderId가 없어도 cancel/조회 가능.
- 참고: 현재 Lighter market order는 tx를 끝까지 polling(`lighter.ts:706-720`)하므로 사실상 sync. `orderAck: "async"`로 선언하되 **기존 명령의 체결 대기 동작은 `awaitOrderFinal`로 동일하게 재현**한다.

#### 마켓 메타데이터 (P9 동시 수정)

```ts
export interface VenueMarket {
  venue: VenueId;
  venueSymbol: string;              // "TSLA-USD.P" (Ondo), "16" (Lighter RH market id), "xyz:TSLA" (HIP-3)
  canonical: string | null;         // canonical-symbols.ts 매핑. 매핑 없으면 null (arb 후보 제외)
  assetClass: "crypto" | "equity" | "index" | "etf" | "commodity" | "fx" | "preIpo";
  settle: string;                   // "USDC" | "USDG"
  markPrice: string;
  indexPrice: string | null;
  fundingRate: string | null;
  fundingIntervalHours: number;
  openInterest: string | null;      // Aster처럼 미노출이면 null ("0" 하드코딩 금지)
  volume24h: string | null;
  tickSize: string;
  stepSize: string;
  minNotional: string | null;
  maxLeverage: number;
  marginTiers: Array<{ lowerBound: number; maxLeverage: number }> | null;
  session: MarketSession | null;    // 주식 퍼프만
}

export interface MarketSession {
  underlyingOpen: boolean;
  priceBand: { lower: string; upper: string } | null;   // Ondo 주말 밴드, Arcus 장 마감 밴드
  marginMultiplier: number | null;                      // Arcus 장 마감 IM 1.5x
}
```

- `ExchangeMarketInfo`(기존)는 유지하되 optional 필드(`sizeDecimals?`, `stepSize?`, `fundingHours?`, `marginTiers?`)를 `| null`로 바꾸고 `maxLeverageForNotional`의 fallback을 제거 — Phase 1.
- 정밀도: 전송 전 공통 `toVenuePrecision(market, price, size)` — tick/step에 안 맞으면 **반올림이 아니라 방향이 정해진 규칙**(가격: 주문에 불리하지 않은 방향, 수량: 내림)으로 맞추고, 결과가 0이면 에러. Aster의 raw 전송을 이 단계에서 수정.

#### canonical 심볼 — 단일 SSOT

- `src/exchanges/canonical-symbols.ts`가 **`dex-asset-map.ts`의 `toCanonical`/`ALIASES`와 `SPOT_PERP_TOKEN_MAP`을 대체**한다.
- 매핑은 `(venue, venueSymbol) → canonical` 명시 테이블. **이름이 같다고 자동 매칭하지 않는다** (현재 HIP-3 dex 간 같은 base 자동 매칭 포함 — 이것도 명시 매핑으로).
- 주식 퍼프 대상: Ondo, Arcus, Lighter RH, **HL HIP-3 equity dex** (예: `TSLA` ↔ `TSLA-USD.P` ↔ RH market 16 ↔ `xyz:TSLA`).
- 매핑 없는 심볼은 `canonical: null` → arb/funding 비교에서 제외하고 경고 출력.

#### 레이트리밋

```ts
export interface RateLimitPolicy {
  capacity: number;
  refillPerSec: number;
  weights: Record<string, number> | null;   // Lighter RH trades=600, Arcus setLeverage=125 ...
}
```
- 공통 HTTP 래퍼가 venue 정책으로 throttle, 429는 `RATE_LIMITED`로 정규화.
- **한계:** 프로세스 내 token bucket이므로 CLI와 MCP 서버·봇이 동시에 돌면 합산 한도를 넘을 수 있다. Ondo(1 req/s)는 venue 쪽 한도 상향이 사실상 전제 (§8).

---

## 4. 신규 venue 매핑

| 항목 | Lighter RH | Ondo Perps | Arcus | ~~Variational~~ (제거됨) |
|---|---|---|---|---|
| family | `lighter` (**재사용**) | `ondo` (신규) | `arcus` (신규) | `variational` (신규, public만) |
| roles | all | all | all | marketData |
| keyKind / 저장소 | lighter-l2 / `lighter-rh-agents/` | hmac-apikey / `ondo-agents/` | ed25519-apikey / `arcus-agents/` | none |
| settlementChain / collateral | robinhood / USDG (asset idx 3) | offchain (입금: ETH·Arbitrum) / USDC + 토큰화 주식 | robinhood / USDG | arbitrum / USDC |
| signingChainId | 466324 (testnet 300) | – | 4663 (testnet 46630) | – |
| fundingIntervalHours | **확인 필요** | 1 | 1 | 마켓별 (Bybit/Binance 주기 추종, 기본 1) → 마켓 필드 사용 |
| marketOrder | iocLimit | native | iocLimit (mark ±10% 이내) | (향후 rfq) |
| timeInForce | GTT, IOC | GTC, IOC, ALO | GTT, IOC, FOK, ALO | – |
| tpsl | separateOrders | attached | batchGroup | – |
| amend | native | cancelReplace | native | – |
| batchPlaceMax | null | 20 | 100 | – |
| marginModes | cross, isolated | **cross** | cross, isolated | – |
| orderAck | async | sync | async | – |
| testnet | ✅ | ✅ sandbox | ✅ | ❌ |
| rateLimit | standard 60/min, `trades` weight 600 | **1 req/s** | IP 1500 weight/min | 10 req/10s |
| session | 24/7, 세션 정보 없음 | 주말 ±1/maxLev 밴드 | 장 마감 IM 1.5x·fixed funding·밴드 | – |
| 특이사항 | API key index 0–3·157 예약 | 헤더명 `ONDO-KEY-ID` vs 스펙 `X-API-KEY-ID` sandbox 확정 필요 | 모든 주문 `goodTilTime` ≥ 1개월, 가격·수량 정수 인코딩, 시간 단위 혼재(서명 ns / goodTilTime µs) | 거래 API 없음, ToS가 무단 자동화 금지 |
| 접근 제한 | US·UK·CA·CH·AE·SG 불가 | US·파나마 불가 | US·CA·UK 불가, 퍼프 waitlist 가능성 | US·CA·TW 불가, 초대 코드 |

**Lighter RH를 위해 설정화할 하드코딩**: `lighter.ts:114-117`(URL/chainId, `:115` env override 포함), `:559`(USDC), `lighter-spot.ts:75`(explorer), `:110-111,139,198,405,424`(USDC 표기·asset index), `lighter-keystore.ts:60`(디렉터리), 외부 URL 6곳(`api/public/urls.ts`, `dashboard/ws-feeds.ts:487`, `funding/rates.ts:394,404`, `commands/agent.ts:257`, `commands/funds.ts:465`).
`commands/funds.ts:465`는 `lighter.ts` `createIntentAddress(chainId)`를 재구현한 것이므로 **어댑터 메서드 호출로 교체**.

---

## 5. 하지 않을 것 (Non-goals)

- **CCXT로 교체**: 신규 4개가 전부 CCXT 밖. 추후 dYdX/Paradex/GRVT 확장 시 `family: "ccxt"` 래퍼를 하나의 family로 추가하는 선택지는 열어둔다(단 CCXT 기본 builder fee 1bp는 명시적으로 off).
- **Variational 웹앱 역공학/자동화**: ToS 위반, 포인트 회수 위험. 공식 API 전까지 public 데이터만.
- **HIP-3 dex를 VenueId로 승격**: 동적 목록이라 정적 union과 안 맞음. 기존 `DexCapable` 유지.
- **WebSocket 계층 전면 통일**: 이번 범위는 `awaitOrderFinal`에 필요한 주문/체결 채널까지.

---

## 6. 마이그레이션 계획 (PR 단위)

각 Phase는 독립 PR, 기존 테스트(약 1,925개) 전량 통과가 머지 조건. **"동작 변화" 열에 적힌 것 외에는 동작이 바뀌면 안 된다.**

| Phase | 내용 | 동작 변화 |
|---|---|---|
| **0. 버그** | `trade limit` tif/reduceOnly 누락(`trade.ts:300`), HL `stopOrder` limitPrice 무시(`hyperliquid.ts:1015-1019`), Pacifica "no order_id" 오경고, testnet 무시 URL 3곳(P15) | 버그 수정 |
| **1. Rule #2 정리** | funding 주기 `?? 1` 제거(P8), `ExchangeMarketInfo` optional → `\| null`(P9), `tryGetAdapter` catch 제거, `lighter-spot.ts:139` fallback, `lighter.ts:293-304` 키 저장 실패 삼킴 | 이전에 조용히 넘어가던 실패가 **에러로 드러남** |
| **2. VenueDefinition + 생성 통합** | `venue.ts`, 기존 4개 정의, 5개 생성 경로 → `create(ctx)`, 캐시 키 `(venue, network, wallet)`, `name: VenueId`, `chain` → `keyKind`/`settlementChain`, settings·`Exchange` 타입 `VenueId`화 | **있음 (명시):** MCP가 agent/OWS/testnet을 따르게 되는지(§8 결정), Pacifica `getAdapterForExchange`의 OWS Tier 2 적용, HL `_initWithOws`의 agent tier 적용 |
| **3. 이름 분기 치환** | 152줄+ (alias·맵·객체 키 포함). "지원 여부" → capability, "family 공통" → `venue.family`, 키/담보/체인 → 정의 필드. 대상에 bot strategies(23), MCP tools(22), spot/outcome 어댑터 포함 | 없음 |
| **4. Public 경로 + canonical** | `PublicDataFetchers`로 `funding/rates.ts` fan-out 교체, `canonical-symbols.ts`로 3개 매핑 통합(HIP-3 포함, 자동 매칭 제거) | HIP-3 자동 매칭 → 명시 매핑 (매핑 누락 심볼이 arb에서 빠짐) |
| **5. TradingV2 + 결과 정규화** | `TradingV2` 구현(기존 4개), `awaitOrderFinal`, `toVenuePrecision`, rate limiter, slippage 명시화, 명령/봇/MCP 소비자 이전 | `--json` 출력 형태 변경 → **한 릴리스 동안 legacy envelope 병행** 후 제거. 슬리피지 미지정 시 에러 |
| **6. Lighter RH** | Phase 2·3의 Lighter family 부분 완료가 **전제**. P5 WASM 검증 → 필요 시 인스턴스화, keystore 디렉터리 인자화, USDG/asset index 설정화, `lighter-rh` 등록 | venue 추가 |
| **7. Ondo → Arcus** | Ondo(sandbox) 먼저, Arcus(testnet, waitlist 확인 후). 둘 다 `TradingV2` + `ExchangeAdapter` shim | venue 추가 |
| **8. Variational (public)** | `publicData`만 구현, `getQuotes()` 별도 타입 | 기능 추가 |

**Lighter RH를 빨리 붙여야 한다면:** Phase 0 → 1 → 2 → Phase 3 중 **Lighter family 관련 분기만**(settings·agent store·funding 주기·keystore·`=== "lighter"`) → Phase 6. 나머지 3·4·5는 병행.

---

## 7. 테스트 전략

- **Capability contract**: 모든 trading venue에 대해 선언된 TIF/TP·SL/amend 방식이 실제로 전송되고, 미선언 조합은 전송 전 `NOT_IMPLEMENTED` (mock HTTP).
- **Rule #2 회귀**: funding 주기 미정의 venue → throw, `slippageBps` 누락 → 에러, `awaitOrderFinal` 타임아웃 → `finality: "pending"`.
- **Multi-instance**: 같은 프로세스에서 `lighter` + `lighter-rh` → 각각 올바른 chainId로 서명되는지, 캐시가 섞이지 않는지.
- **Keystore 격리**: 같은 account/slot이라도 venue가 다르면 다른 디렉터리를 읽는지. 신규 venue가 env를 읽지 않는지.
- **Precision**: venue별 tick/step 경계값, 0으로 떨어지는 수량 거절.
- **Canonical**: 매핑 누락 심볼이 arb 후보에서 빠지고 경고가 나오는지. HIP-3 자동 매칭 제거 회귀.
- **Integration**: Ondo sandbox, Arcus testnet, Lighter RH testnet 파일 추가 (`test:integration`).
- **이름 분기 가드**: `rg '(===|!==|case) "(lighter|aster|hyperliquid|pacifica|ondo|arcus|lt|hl|pac|ast)"' src` 결과가 허용 목록 외로 늘어나면 CI 실패.

---

## 8. 결정 필요 / 확인 필요

**결정 필요**
1. **MCP 서버 서명 tier**: 통합 후 MCP도 agent → master → PK를 따를지, 지금처럼 PK 직접만 쓸지. (현재 동작은 의도였나?)
2. **`restrictedRegions`**: CLI에서 경고만 할지(권장), 차단할지.
3. **Ondo rate limit 상향 요청**: 기본 1 req/s로는 봇·arb 폴링이 불가 → support@ondoperps.xyz 요청 여부.
4. **Lighter RH 계정 티어**: standard 60 req/min → Premium/Plus 전환 여부.

**확인 필요 (구현 전)**
5. **Lighter WASM 서명기가 chainId별로 분리되는지**(P5) — `node_modules` 복구 후 `lighter-ts-sdk` 확인.
6. **Lighter RH funding 주기** (1h/8h).
7. **Arcus 퍼프 waitlist** (`AddressNotOnWhitelist` 에러 존재) — 대상 주소로 testnet/mainnet 확인.
8. **Ondo 인증 헤더명·WS login 서명 순서** — sandbox에서 확정.
9. **Variational API 신청** (https://variational.typeform.com/api-request).

---

## 9. 구현 결정 (2026-09-30, 목표 지시: "docs 기반 전체 구현 → 테스트는 마지막에 별도")

### 9.1 §8 결정 사항 — 권장안으로 확정
| # | 결정 |
|---|---|
| 1 MCP 서명 tier | **CLI와 동일한 tier(agent → master → PK)** 를 따른다. 생성 경로 통합의 목적이 동작 일치이므로. CHANGELOG에 behavior change로 기록 |
| 2 restrictedRegions | **경고만** (stderr 1회, `--json`에서는 `warnings[]`). 차단 안 함 |
| 3·4 rate limit 상향 / RH 티어 | 코드 범위 밖. `RateLimitPolicy`는 venue 문서의 **기본(최저) 한도**로 선언, settings에서 venue별 override(명시 값만) 허용 |
| 5 WASM chainId 분리 | **확인 완료**: Go 런타임 전역 맵이 `(accountIndex, apiKeyIndex)`만으로 키잉 → 같은 인덱스면 체인 간 덮어씀. `WasmSignerClient`를 **chainId별 인스턴스**(`Map<chainId, Promise<WasmSignerClient>>`)로 분리. 서명 호출 시 `apiKeyIndex/accountIndex` 항상 명시 |
| 6 RH funding 주기 | 구현 시 `/api/v1/fundings` 응답 간격으로 확인해 `fundingIntervalHours`에 기록 (확인 전 추정값 금지 — 확인 안 되면 venue 정의 생성 시 throw) |
| 7·8·9 | 실금액/테스트넷 테스트 단계에서 확인 (코드상 TODO 아님 — 해당 경로는 venue 에러를 그대로 전파) |

### 9.2 SDK / 의존성 결정 (근거: `scratchpad/sdk-findings.md`)
| venue | SDK | 결정 |
|---|---|---|
| Lighter / Lighter RH | `lighter-ts-sdk@1.0.10` (third-party, lighter-go WASM 번들) | **기존 SDK 유지**, chainId별 `WasmSignerClient` 인스턴스 |
| Ondo | 공식 없음. `@lifi/perps-sdk-provider-ondo`는 LI.FI 백엔드 경유 → 부적합 | **raw `fetch` + `node:crypto` HMAC**, 신규 의존성 없음. 헤더는 라이브 검증된 `ONDO-KEY-ID`/`ONDO-TIMESTAMP`/`ONDO-SIGN`, prehash = `ts(ms) + METHOD + path?query + body` |
| Arcus | 공식 perps SDK 없음 (spot SDK만) | **raw `fetch` + `tweetnacl`(기존 직접 의존성) Ed25519 + `ethers` EIP-712**. 가격/수량 정수 인코딩, `goodTilTime` ns, 서명 스킴 2종 |
| Variational | Python SDK만(구 API) | **raw `fetch`**, `/metadata/stats` public만. `funding_rate`는 연율로 추정 → `funding_interval_s`로 주기 환산, 연율 여부는 코드 주석이 아니라 정규화 함수의 명시 파라미터로 |

### 9.3 파일 배치
```
src/exchanges/
  venue.ts                 # VenueId, VenueDefinition, VenueCapabilities, RateLimitPolicy, getVenue/listVenues
  venue-types.ts           # OrderRequest/OrderResult/OrderRef/CancelResult/LeverageResult/VenueMarket/MarketSession
  trading-v2.ts            # TradingV2 인터페이스, awaitOrderFinal, validateOrderRequest(capabilities)
  precision.ts             # toVenuePrecision
  rate-limiter.ts          # token bucket + fetch 래퍼
  canonical-symbols.ts     # (venue, venueSymbol) → canonical
  venues/
    pacifica.ts hyperliquid.ts lighter.ts lighter-rh.ts aster.ts   # VenueDefinition (기존 어댑터 연결)
    ondo.ts arcus.ts variational.ts
  ondo/  client.ts signing.ts adapter.ts public.ts
  arcus/ client.ts signing.ts adapter.ts public.ts
  variational/ public.ts
src/agent-wallet/
  venue-keystore.ts        # ~/.perp/<venueId>-agents/ 공통 AES-GCM 키스토어 (lighter-keystore는 이것의 thin wrapper로)
```

### 9.4 테스트
목표 지시에 따라 **이번 구현 단계에서는 테스트를 작성/수정하지 않는다.** 검증은 `tsc --noEmit`(테스트 디렉터리 제외) 통과까지. §7 테스트 전략과 기존 테스트 갱신은 이후 실금액·테스트넷 단계에서 진행.

---

## 10. v3 계약 확정 (critic 2차 리뷰 반영 — **§3~§9와 충돌하면 이 절이 우선**)

### 10.0 원칙 #1 수정
"기존 `ExchangeAdapter`는 건드리지 않는다" → **"기존 4개 venue의 주문 전송/서명 경로는 바꾸지 않는다. 데이터 타입 강화(optional → `| null`, 필드 추가)와 이름/설정의 venue화는 허용."**

### 10.1 Funding — 두 개념 분리 (Critical #1)

> Variational(annualized/perMarket) 행은 제거됨(2026-10-02) — 기록용.
`fundingIntervalHours` 단일 필드를 폐기하고 두 필드로 나눈다.

```ts
export type FundingRateBasis = { kind: "perHours"; hours: number } | { kind: "annualized" };
// VenueDefinition
fundingRateBasis: FundingRateBasis | "perMarket";          // 호가된 rate 1개가 몇 시간치인가 (정규화용)
settlementIntervalHours: number | "perMarket";              // 실제 정산 주기 (타이밍용, SETTLEMENT_SCHEDULES 대체)
// VenueMarket: fundingRateBasis: FundingRateBasis; settlementIntervalHours: number  (둘 다 필수)
```

| venue | fundingRateBasis | settlementIntervalHours | 근거 |
|---|---|---|---|
| hyperliquid | perHours 1 | 1 | `normalize.ts:5` |
| hyperliquid HIP-3 (`hl:<dex>`) | perHours 1 | 1 | **현행 동작 보존**(`getFundingHours` 맵 miss → 1). `normalize.ts:9` 주석("8h")과 불일치 → 실데이터 검증 항목 |
| pacifica | perHours 1 | 1 | `normalize.ts:6` |
| lighter | perHours 8 | 1 | `normalize.ts:7`, `arb/utils.ts:13` |
| aster | perHours 8 | 8 | `normalize.ts`, `arb/utils.ts:14` |
| lighter-rh | perHours 8 | 1 | "Lighter RH는 Lighter와 동일 API/엔진"(apidocs lighter-rh.md) → Lighter와 동일. **정산 간격(timestamp spacing)으로 추정하지 않는다.** 실데이터 검증 항목 |
| ondo | perHours 1 | 1 | docs funding-rates: hourly, premium/8 반영된 1h rate |
| arcus | perHours 1 | 1 | docs: hourly funding |
| ~~variational~~ (제거됨) | annualized | perMarket (`funding_interval_s`/3600) | sdk-findings §4. `funding_interval_s === 0`인 listing은 **경고 후 제외** |

- `getFundingHours(x)` / `toHourlyRate(rate, x)`: `parseVenueRef(x)`(`"hl:<dex>"` 포함)로 venue를 해석 → basis 사용. **해석 불가 문자열은 `UNKNOWN_VENUE` throw** (remediation 포함). `?? 1` 삭제.
- 시장 단위 값(`market.fundingHours ?? getFundingHours(x)` 약 20곳)은 "시장 값 우선, 없으면 venue 정의 값" = 두 값 모두 정의된 SSOT이므로 유지.
- `SETTLEMENT_SCHEDULES` → `settlementIntervalHours`에서 생성. `arb/utils.ts:25` unknown → pacifica 대체 삭제 → throw.
- 이 작업은 **Phase 2**(정의가 생긴 뒤)에서 수행.

### 10.2 생성 컨텍스트 (Major #2, #3, #15)
```ts
export interface VenueCredentials {
  pk: string | null;                 // --private-key 또는 legacy env (legacy venue만)
  owsWallet: string | null;
  owsPassphrase: string | null;
  owsKeyToken: string | null;
  agent: AnyAgentMeta | null;
}
export interface VenueCreateContext {
  network: "mainnet" | "testnet";
  credentials: VenueCredentials;     // 어댑터가 여러 signer를 동시에 보유하고 작업별로 고름 (현행 유지)
  noAgent: boolean;
  hlDex: string | null;
  readOnly: boolean;                 // true면 credentials 무시, public 읽기만
}
export function resolveCredentials(venue: VenueId, opts: CliCredentialOpts): VenueCredentials;  // CLI·MCP 공용
export function hasCredentials(venue: VenueId, opts: CliCredentialOpts): boolean;             // catch 없는 명시 검사
```
- `mcp-server.ts:78` `tryGetAdapter`, `config.ts:16-22` `tryLoadPrivateKey`의 catch 삼킴 → `hasCredentials()`로 분기 후, 자격이 있으면 생성 에러를 그대로 전파.
- 직접 생성 27곳 전수 목록은 Phase 2 PR 설명에 첨부. **Phase 3-lite 범위(§10.9) 안에서는** 신규 venue로 도달 가능한 경로만 `create(ctx)`로 교체. `commands/agent.ts:2414` `new LighterAdapter("", false)`(항상 mainnet)는 버그로 수정.

### 10.3 설정·env 타입 (Major #4)
- `type LegacyVenueId = "pacifica" | "hyperliquid" | "lighter" | "aster"`. `config.ts` `envMap: Partial<Record<LegacyVenueId, string[]>>` — **신규 venue는 env 키 로드 없음**, `loadPrivateKey(venue)`는 신규 venue에 대해 `NO_ENV_TIER` throw.
- settings의 venue 맵(`referralCodes`, `referralApplied`, `fees`, `slippageBps`(신규)): `{ [K in VenueId]?: T }`. **"키 없음 = 해당 기능 off"** (referral 미적용, fee override 없음, slippage 미설정 → slippage 필요한 주문은 `SLIPPAGE_REQUIRED` throw). 기본값 주입 없음.
- `lighter-rh` master 키 = **OWS wallet만**(env 없음). RH referral은 RH 코드가 생길 때까지 **off**(Lighter 코드 `718585MY` 상속 안 함).
- `AgentsByExchange`에 `"lighter-rh"`, `ondo`, `arcus` 키 추가.

### 10.4 Agent 메타·비밀 저장소 (Major #5, #6)
```ts
export type AnyAgentMeta = AgentMeta /* 기존: aster/hl/pac/lighter/lighter-rh */ | OndoAgentMeta | ArcusAgentMeta;
export interface OndoAgentMeta { kind: "ondo"; agentName: string; keyId: string; keystorePath: string; scopes: string[] | null; approvedAt: string }
export interface ArcusAgentMeta { kind: "arcus"; agentName: string; agentWalletName: string /* OWS */; apiKeyHex: string; accountIndex: number; ownerAddress: `0x${string}`; validUntil: string; approvedAt: string }
```
| venue | 비밀 | 저장소 (Rule #3) |
|---|---|---|
| lighter-rh | L2 slot 키 | `~/.perp/lighter-rh-agents/<account>-<slot>.json` (curve 미지원 → perp-keystore) |
| ondo | HMAC key id + secret | `~/.perp/ondo-agents/<keyId>.json` (curve 키 아님 → perp-keystore, AES-256-GCM, 0600) |
| arcus | Ed25519 agent 키 | **OWS wallet `agent-arcus-<master>`** (OWS가 ed25519 raw signMessage 지원 — Pacifica agent와 동일 패턴). pubkey hex는 base58 주소에서 유도 |

- 명령: `perp wallet agent approve ondo|arcus|lighter-rh`, `list`/`revoke`는 기존 서브커맨드에 venue 추가.
  - ondo: key id / secret은 **stdin 프롬프트로만** 입력(플래그 금지).
  - arcus: OWS agent wallet 생성 → master EVM으로 `createApiKey` EIP-712 서명 → `/v1/apiKeys`로 확인 → 메타 저장.
  - lighter-rh: 기존 lighter approve 흐름을 venue 파라미터화.

### 10.5 Lighter WASM (Major #7)
`LighterAdapter._wasmClient`(static 단일) → `static _wasmClients = new Map<string /* `${venueId}:${network}` */, Promise<WasmSignerClient>>()`. Lighter testnet과 RH testnet이 모두 chainId 300이므로 chainId가 아니라 venue+network로 키잉. `lighter.ts:297` 등 `_wasmClient` 참조를 인스턴스의 client로 교체. 서명 호출 시 `apiKeyIndex`/`accountIndex` 항상 명시.

### 10.6 Public 데이터 (Major #8, #9)
```ts
export interface VenueFundingRate {
  venue: VenueId; venueSymbol: string; canonical: string | null;
  rate: string; basis: FundingRateBasis; markPrice: string | null; nextFundingTime: number | null;
}
export interface VenuePublicData {
  fetchFundingRates(net: "mainnet" | "testnet"): Promise<VenueFundingRate[]>;
  fetchMarkets(net: "mainnet" | "testnet"): Promise<VenueMarket[]>;
}
```
- 기존 `FundingRateSnapshot`(`rates.ts:42`) 이름 유지. `ExchangeFundingRate.exchange`를 `VenueId`로 확장, `exchangeStatus: Record<string, { ok: true } | { ok: false; error: string }>`.
- 기존 4개 fetcher의 `catch { return [] }`(`rates.ts:73,92,136,187`) 삭제 → 에러는 `exchangeStatus`에 기록.
- base URL은 `venue.networks[net]`에서 받아 `api/public/*`에 인자로 전달 (Lighter 계열만 이번 범위. 그 외 하드코딩 URL 57줄/21파일은 **범위 밖**으로 명시).
- `rates.ts:402-411` dead loop 삭제.
- **마켓 타입 관계:** 신규 venue 어댑터는 `getVenueMarkets(): Promise<VenueMarket[]>`를 구현하고, legacy `getMarkets()`는 순수 함수 `toLegacyMarketInfo(VenueMarket): ExchangeMarketInfo`로 정의. 기존 4개 venue는 이번 범위에서 `getVenueMarkets` 미구현(§10.9). `mcp-server.ts:93-99`의 `"0"`/고정 maxLeverage 날조 제거 → `publicData.fetchMarkets` 경유.

### 10.7 Legacy shim 매핑 (Major #10) — Ondo/Arcus
| legacy 메서드 | 동작 |
|---|---|
| `getMarkets` | `getVenueMarkets().map(toLegacyMarketInfo)` |
| `getOrderbook/getRecentTrades/getFundingHistory/getKlines` | 네이티브 구현. venue가 REST로 제공하지 않으면(`Arcus getKlines`는 REST `/v1/candles` 있음 → 구현) `NOT_IMPLEMENTED` + remediation |
| `getBalance/getPositions/getOpenOrders/getOrderHistory/getTradeHistory/getFundingPayments` | 네이티브 구현 |
| `marketOrder` | `placeOrder({type:"market", slippageBps: capabilities.marketOrder === "slippageBounded" ? settings.slippageBps[venue] : null, ...})`, 필요한데 미설정이면 `SLIPPAGE_REQUIRED` |
| `limitOrder` | `opts.tif`를 capabilities로 검증 후 `placeOrder` (tif 미지정 → `"GTC"`가 아닌 **venue가 선언한 첫 번째 resting TIF를 쓰지 않음** → CLI가 넘기는 값만 사용, 없으면 `TIF_REQUIRED`) |
| `editOrder` | `amendOrder` (Ondo는 `amend: "cancelReplace"` → cancel 후 재주문, 결과에 두 단계 모두 기록) |
| `cancelOrder/cancelAllOrders` | `cancelByRef/cancelAllV2` |
| `stopOrder` | `tpsl`/stop 지원 방식대로. Arcus(`batchGroup`)는 reduce-only 단일 stop을 batch 1건 그룹으로 전송, reduce-only 아니면 `NOT_IMPLEMENTED` |
| `setLeverage` | `applyLeverage` |
| 반환값 | 모두 `OrderResult`(또는 `CancelResult`/`LeverageResult`) |
- `ExchangePosition.liquidationPrice: string` → `string | null` (Phase 1, 소비자 null 처리).

### 10.8 기존 4개 venue Capability (Major #11) — 현재 코드 기준
| | pacifica | hyperliquid | lighter / lighter-rh | aster |
|---|---|---|---|---|
| marketOrder | slippageBounded (어댑터 내장 1%) | slippageBounded (SDK) | slippageBounded (어댑터 내장) | native |
| timeInForce | GTC, IOC, ALO | GTC, IOC, ALO | GTT, IOC | GTC, IOC, FOK, ALO(GTX) |
| clientOrderId | false | false | false | false |
| orderAck | sync(폴링) | sync | async(폴링으로 확정) | sync(폴링) |
| tpsl | positionLevel | separateOrders | separateOrders | separateOrders |
| amend | native | native(트리거 주문 제외) | native | cancelReplace(LIMIT만) |
| batchPlaceMax | null | null | null | null |
| marginModes | cross, isolated | cross, isolated | cross, isolated | cross, isolated |
| withdrawAssets | USDC | USDC | USDC (RH: USDG) | null |
- `marketOrder` 값 이름 `iocLimit` → **`slippageBounded`**로 변경 (Pacifica는 IOC가 아니라 slippage 파라미터).
- `tpsl` 값에 `"positionLevel"` 추가.
- 기존 venue의 내장 slippage 상수는 **이번 범위에서 유지**(주문 경로 불변, §10.0). 신규 venue만 `settings.slippageBps` 필수.

### 10.9 범위 확정 — Pragmatic cut 채택
| 항목 | 이번 구현 | 후속 |
|---|---|---|
| Phase 3 이름 분기 | **3-lite**: 신규 venue(`lighter-rh`/`ondo`/`arcus`/`variational`)로 도달 가능한 분기만 — `=== "lighter"` 중 family 공통인 것 → `family`, 잘못된 case로 떨어지는 switch default, settings/agent-store 키. 나머지는 CI rg 가드의 **스냅샷 허용목록**으로 동결 | 전량 치환 |
| Phase 5 TradingV2 | 신규 venue는 네이티브 `TradingV2` + legacy shim(§10.7). **모든 venue**에 대해 `trade` 명령의 capability 사전 검증 적용 (tif/reduceOnly/tpsl/amend). 기존 4개 venue 주문 경로·JSON 출력 불변 | 기존 4개 `TradingV2` 래퍼, 봇/arb/MCP 소비자 이전, legacy 제거 |
| Rate limiter | 신규 venue + Lighter RH에만 | 기존 어댑터 SDK HTTP 래핑 |
| Canonical | venue별 `symbolIdentity: "baseTicker" \| "explicit"`. crypto 중심 venue(pacifica/hl core/lighter/aster/ondo·arcus·lighter-rh의 crypto 마켓)는 quote 접미사 제거한 ticker 동일성 + override 표(1000PEPE/kPEPE/UBTC 등). **equity·HIP-3·주식 퍼프는 explicit만** | 표 확장 |
| getVenueMarkets | 신규 venue만 | 기존 4개 |

### 10.10 모호성 해소
- **가격 정밀도:** limit 가격이 tick에 안 맞으면 **반올림하지 않고 거절**(`INVALID_TICK`). slippage-bounded market의 보호 가격은 **체결 방향으로**(buy = 올림, sell = 내림) tick 정렬. 수량은 step으로 **내림**, 0이면 `SIZE_TOO_SMALL`.
- **`tif: null`:** market 주문에서만 허용. limit/stopLimit은 필수.
- **`tpsl` on `separateOrders` venue:** `placeOrder`에서 **전송 전 거절**(`NOT_IMPLEMENTED`, remediation: `perp trade tpsl`). fan-out 안 함.
- **상태 매핑:** `accepted` = venue가 수신 확인했으나 오더북/상태 미확인, `open` = 오더북에 resting 확인(트리거 대기 포함). Ondo `pending`→accepted, `untriggered`→open. Arcus 202→accepted.
- **Arcus 시간 단위:** 서명 필드 `g` = ns, 요청 body `goodTilTime` = µs 문자열, 헤더 `X-Timestamp` = ns (§9.2 "goodTilTime ns"는 오기 — 이 절이 우선).
- **Ondo 헤더:** `ONDO-KEY-ID` 라이브 검증 완료. 미확정은 WS login 서명 순서뿐.
- **`VenueDefinition.create`:** `((ctx) => Promise<ExchangeAdapter>) | null` — Variational은 null.
- **venue 정의 파일은 어댑터를 `import()`로 지연 로드** (funding 경로에서 `lighter-ts-sdk` 강제 로드 방지). `registry.ts`는 `listVenues()`에서 파생.
- **KeyKind 분리:** `masterKeyKind: "evm" | "solana" | "none"`, `agentKeyKind: "evm" | "solana" | "lighter-l2" | "ed25519" | "hmac" | "none"`. 기존 `chain` 비교(`init.ts:214`, `wallet.ts:647,1013`)는 `masterKeyKind` 의미.
- **`settlementChain: "robinhood"`의 rebalance/bridge**: 경로 없음 → `rebalance.ts`에서 `NO_BRIDGE_ROUTE` throw.

### 10.11 Rule #2 인벤토리 — 이번 범위
| 위치 | 조치 |
|---|---|
| `normalize.ts` `?? 1`, `arb/utils.ts:25` | §10.1 (Phase 2) |
| `rates.ts:73,92,136,187,235` catch→[] | §10.6 |
| `mcp-server.ts:78` tryGetAdapter, `config.ts:16-22` tryLoadPrivateKey | §10.2 |
| `lighter-spot.ts:139` `?? "USDC"` | venue collateral로 |
| `lighter.ts:293-304` 키 저장 실패 삼킴, `:483` `.catch(() => new Map())`, `:495` `?? 0` | throw로 |
| `ExchangeMarketInfo` optional 필드, `maxLeverageForNotional` fallback | `\| null` |
| `mcp-server.ts:126` Lighter orderbook `market_id=0` 고정 (버그) | 심볼 → market id 해석 |
| `mcp-server.ts:93-99` 날조 값 | §10.6 |
| **범위 밖(기록만)**: `settings.ts:188` catch→DEFAULTS, `config.ts:97` generic `PRIVATE_KEY`, `index.ts:143` read-only용 `Keypair.generate()`, `index.ts:146` `\|\| "PERPCLI"`, `OWS_API_KEY` env, `ExchangeAdapter` optional 멤버 | 후속 |
| **해소 (2026-10-02)**: `\|\| "PERPCLI"` / `PACIFICA_BUILDER_CODE` / `referralCodes.pacifica` 빌더 코드 체인 삭제 → venue 공통 opt-in `settings.builder.<venue>` + 승인 확인 (`src/exchanges/builder-fee.ts`, `VenueDefinition.builderFee`, `wallet builder`), DEBRIDGE_* env → `settings.bridge.debridgeAffiliate` | 완료 |

### 10.12 실행 순서
1. **Phase 0** 버그 (P15 URL은 Phase 2로 이동)
2. **Phase T** 타입 우선: `venue.ts`, `venue-types.ts`, `trading-v2.ts` 계약만
3. 병렬 레인 (신규 파일 위주, 서로 파일 겹치지 않음)
   - A: `ondo/*`, `arcus/*`, `variational/public.ts`
   - B: Lighter RH 내부 (`lighter.ts` 설정 주입·WASM 맵, `lighter-spot.ts`, `venue-keystore.ts`)
   - C: `canonical-symbols.ts`, `precision.ts`, `rate-limiter.ts`
4. 직렬 스파인: Phase 1(펀딩 제외) → Phase 2(정의·생성·설정·펀딩·P15) → 3-lite → 5-lite(capability 검증, shim 연결, agent approve 명령) → public 데이터 경로
5. 각 직렬 단계 후 `tsc --noEmit` 필수, 기존 `pnpm test`는 **정보용**으로 실행(게이트 아님, 결과만 기록).

### 10.13 critic 3차 (APPROVE-WITH-EDITS) 반영 — 최우선
1. **정규화 시그니처:** `rateToHourly(rate, basis: FundingRateBasis)` (`venue-types.ts`) — `annualized`는 `rate / 8760`. `getFundingHours(venueRef)`는 venue basis가 `"perMarket"`이거나 `annualized`면 throw(`INVALID_PARAMS`, remediation: 시장 basis 사용). `toHourlyRate(rate, venueRef)`는 `rateToHourly(rate, fundingBasisOf(venueRef))`. per-market 정산은 `getLastSettlement`에 시장 interval을 넘겨야 하며, 생성 스케줄은 **00:00 UTC 기준**.
2. **`funding-arb-utils.ts` `computeFundingHoursFromHistory`(:254-255, :278):** 히스토리 간격(=정산 주기)을 basis로 쓰지 않는다 → 시장/venue `fundingRateBasis` 사용, `"unknown"` fallback 삭제. 간격은 정산 타이밍에만.
3. **`exchangeStatus` 형태 유지:** `Record<string, "ok" | "error">` 그대로 두고 `exchangeErrors: Record<string, string>` 필드 추가 (dashboard/ui.ts 인라인 JS 등 기존 소비자 보호).
4. **§10.8 TIF 열 = "현재 어댑터가 받는 CLI 입력":** lighter/lighter-rh `GTC(→GTT 매핑), GTT, IOC` / pacifica `GTC, IOC, ALO, TOB` / aster `GTC, IOC, FOK, GTX` (코드는 대문자 그대로 전송, ALO→GTX 매핑 없음 — ALO 미선언). `TimeInForce` 타입에 `"TOB" | "GTX"` 추가.
5. **기존 4개 venue 사전 검증**은 위 입력 집합을 정확히 허용. 수용 조건: 기본 tif로 `perp trade limit -e lighter` 동작 유지.
6. **§10.7 `limitOrder`:** 신규 venue(ondo/arcus/lighter-rh 제외 — lighter-rh는 lighter 어댑터)는 CLI 기본 tif 없음 → 사용자가 명시한 값만, 없으면 `TIF_REQUIRED`. 기존 4개(+lighter-rh)는 기본 `GTC` 유지. 구현: `trade.ts`의 `--tif` 기본값 제거 후 "legacy family면 GTC" 명시 분기.
7. **`ExchangeMarketInfo.fundingHours`의 의미 = basis**(rate 1개가 커버하는 시간), 정산 주기 아님.
8. 인용 정정: `config.ts:97` → `:100`.

---

## 11. 테스트 단계 확인 항목 (구현 중 코드로 확정 불가했던 것)

| # | venue | 확인할 것 | 관련 코드 |
|---|---|---|---|
| 1 | lighter-rh | funding basis 8h 가정 (Lighter와 동일 엔진). RH rate vs premium 비교로 확정 | `venues/lighter-rh.ts` |
| 2 | lighter-rh | 실제 L2 서명·ChangePubKey·출금 (RH 계정 필요), standard 계정 60 req/min 한도 체감 | `lighter.ts` |
| 3 | lighter + lighter-rh | 같은 프로세스 동시 사용 시 WASM 런타임 분리 (예: `perp account positions` 전 venue). 서명기는 공식 lighter-go v1.0.9 WASM(`vendor/lighter-signer/`, sha256 고정·로드 시 검증)으로 교체 — Go export는 `go.run()` 직후 동기적으로 캡처 후 전역 복원하므로 런타임 간 덮어쓰기 없음(단위 테스트로 확인), 실 venue 동시 사용은 testnet E2E에서 확인 | `lighter-signer.ts`, `lighter.ts` `_getWasmClient` |
| 4 | ondo | HMAC 서명 실검증(가짜 키는 서명 전에 거절됨), 서명 필요한 read/write 전부 | `ondo/client.ts` |
| 5 | ondo | DELETE 응답이 동기적으로 `status: "canceled"`인지 (amend 전제), reduce-only IOC 허용 여부 (slippage 청산 경로) | `ondo/adapter.ts` amend / market |
| 6 | ondo | position stop이 `GET /v1/perps/orders`에 `untriggered`로 보이는지 (stop 조회) | `ondo/adapter.ts` stopOrder |
| 7 | ondo | 출금 wallet `margin` vs `main`, WS login 서명 순서 | `ondo/adapter.ts` withdraw |
| 8 | arcus | **접근 화이트리스트 등록 선행** (계정/주문 조회 403) | — |
| 9 | arcus | `entryTpsl` 자식 leg의 `parentOrderId` 필요 여부, modify body 형식, 주문 직후 `/v1/order/{id}` 404 지속 시간 | `arcus/adapter.ts` |
| 10 | arcus | 출금 `uint256` 문자열 수용, scheduleCancel 서명 스킴 (미구현) | `arcus/signing.ts` |
| 11 | hyperliquid HIP-3 | funding basis 1h 가정(현행 보존) vs 주석의 8h | `venue.ts` fundingBasisOf |
| 12 | 전체 | 기존 테스트 갱신: 인터페이스 null화, `tryLoadPrivateKey` 제거, `resolveExchangeName` throw, Lighter 테스트의 `Object.create` 생성자 우회 등 (정보용 실행 기준 약 13개 파일 실패) | `src/__tests__/**` |
| 13 | lighter (+rh) | post-only: 공식 문서(trading.md)·공식 WASM 기준 TIF `2` = POST_ONLY → **ALO 활성화**(28일 expiry). 남은 확인: testnet에서 교차하는 post-only가 `canceled-post-only`(st 5)로 끝나는지 → 결과는 `orderOutcome` cancelled(final) | `lighter.ts` limitOrder / resolveOrderOutcome |
| 14 | pacifica | `/orders/edit` 동작: 원 주문 TIF 무관하게 ALO로 재생성·`client_order_id` 유지·새 order_id인지. 생성 `client_order_id`(UUID, 접두 `5ac1f<code>`로 TIF 기록)가 거절되지 않는지, cancel 직후 `history_by_id` 종결 행(filled_amount)이 바로 보이는지(TIF 보존 cancel→replace 전제). `/positions/tpsl`의 `side` = 포지션 side(bid=long)인지, 기존 TP/SL 덮어쓰기 여부 | `pacifica.ts` amendKeepingTif / setPositionTpSl |
| 15 | hyperliquid | `frontendOpenOrders`의 `tif` 필드가 resting 주문에 항상 `Gtc`/`Alo`/`Ioc`로 오는지(없으면 정정은 통일 미지원 응답). 스팟 `openOrders`의 coin 표기(`@<index>` / `PURR/USDC`), TP/SL 레그(`grouping: "na"`, reduce-only trigger) 수락 | `hyperliquid.ts` editOrder, `hyperliquid-spot.ts` getSpotOpenOrders |
| 16 | pacifica | `/orders/history_by_id` 행 정렬·식별: 여러 행일 때 `created_at`이 상태 변화마다 증가하는지(최대 `created_at` = 현재 상태 전제), 동일 `created_at` 동률 시 종결 행이 하나뿐인지, `order_id` 필드가 행마다 오는지. 배열 위치는 사용하지 않음(`pacificaLatestHistoryRow`) | `pacifica.ts` marketOrder / amendKeepingTif, `pacifica-spot.ts` |
| 17 | lighter (+rh) | `/tx` 상태는 공식 매핑 **0 Failed · 1 Pending · 2 Executed · 3 Pending-final** 로 교체(구 SDK 0–5 매핑 폐기): 2/3 + `executed_at > 0` = 실행, `event_info.ae` 비어 있지 않음 = 거절, 0 = `ORDER_REJECTED`, 1 = 계속 폴링(testnet 폴링 창 3배). 남은 확인: 폴링 창(IOC 10×500 ms, 취소·TP/SL 20×500 ms, testnet ×3) 충분성, resting GTT의 `event_info.to.st` = 2 | `lighter.ts` lighterTxState / pollTx |
| 18 | lighter (+rh) / aster | 명시 `kind` TP/SL 레그: 트리거가 이미 교차한 take-profit / stop-loss를 venue가 거절하는지(Aster -2021, Lighter 거절 코드) → `ORDER_PARTIAL` 경로 | `aster.ts` / `lighter.ts` stopOrder |
| 19 | lighter (+rh) | `/accountActiveOrders` 행의 `type` 문자열(stop-loss / take-profit 계열)과 `trigger_price` — 트리거 주문 정정 거절 판정 전제 | `lighter.ts` modifyOrder |
| 20 | hyperliquid | IOC no-match 오류 문구("could not immediately match")가 주문별 `{error}`로 오는지, 취소 응답 `statuses[0] === "success"`(취소 증명) | `hyperliquid.ts` _validateVenueAck, `legacy-trading-v2.ts` cancelByRef |
| 21 | lighter (+rh) | 취소·정정은 `/accountActiveOrders` 행을 order id(문자열 `order_id`)로 찾아 **`client_order_index`로 서명**(0이면 정확히 표현되는 `order_id`, 아니면 `INVALID_PARAMS`; 목록에 없으면 `ORDER_NOT_FOUND`) — 구 2^53 일괄 거절 제거. 남은 확인: 이미 체결/없는 주문 취소 tx가 `ae`로 거절되는지(그렇다면 `cancelByRef` failed). 현재 완화: `cancelAllV2` 취소 후 live 재조회 → 남은 주문 `pending` | `lighter.ts` cancelOrder / lighterOrderSignIndex, `legacy-trading-v2.ts` cancelByRef |
| 22 | lighter (+rh) | 비-IOC 주문 결과: `event_info.to`(client index 일치) `st` 2 open / 3 filled / 4–16 canceled-* → `orderOutcome`(final), 판정 불가 시 `GET /api/v1/accountOrders?client_order_indexes=<coi>`(Authorization 헤더) — read 경로는 testnet에서 200 확인(2026-10-02), 주문 후 행 status 문자열·`filled_base_amount` 확인 필요. 시장 구분은 `market_type`(testnet perps 4095–4097, RH testnet 2048/2049) | `lighter.ts` resolveOrderOutcome / _refreshMarketMap |

**미결 질문 (2026-10-02 리뷰):**
- **Pacifica 포지션 TP/SL `side` 의미** — `/positions/tpsl`의 `side`가 포지션 side(bid = long)인지 청산 side인지 미확인(#14와 함께 testnet 확인).
- **정정 size 의미** — Pacifica native edit(ALO), Lighter `modifyOrder`가 받는 size가 "새 미체결 수량"인지 "원래 총 수량"인지 미확인. CLI는 "새 미체결 수량"으로 정의(§13.4); venue 의미가 다르면 부분 체결된 주문 정정 시 수량이 어긋남. **Arcus는 해결(2026-10-02)**: openapi `MODIFY_SIZE_ALREADY_FILLED`가 modify size를 "체결량 포함 새 TOTAL size"로 정의 → 어댑터가 `quantity`/서명 `q` = 직전 조회 체결량 + 새 미체결 수량으로 전송, 새 미체결 수량 ≤ 0 은 취소, `MODIFY_SIZE_ALREADY_FILLED`는 재조회한 주문 상태(cancelled)로 보고(`arcus/adapter.ts` amendOrder). 서명 identity(`id` 단독 vs `id`+`c`)는 문서 모순 — `ARCUS_MODIFY_SIGNED_IDENTITY`(기본 openapi `idOnly`, UNVERIFIED, TEST-PLAN §7b).
- **Arcus 진입 TP/SL 레그 크기** — `entryTpsl` batch는 진입과 레그를 원자적으로 함께 보내므로 레그는 검증된 체결량이 아니라 **요청 수량**으로 크기가 정해진다(검증 후 크기 조정 불가: 진입 전에 이미 전송됨). 진입이 부분 체결이면 레그가 포지션보다 크다 — 레그가 reduce-only면 venue가 초과분을 막는지 확인 필요. 고칠 수 있는 방법(진입 검증 후 별도 레그)은 원자성을 잃으므로 현재는 문서화만.
- **HL 부분 체결 GTC** — GTC 지정가가 일부 체결 후 나머지가 resting이면 HL 응답은 `resting`만 담아 `open`(filledSize 0)으로 보고됨; 즉시 체결분은 응답에 없다(주문 조회로만 확인 가능).

**기존부터 있던 위험:** 없음 (모두 수정됨). 마지막 항목 — 크립토 티커 동일성 매칭에서 가격 괴리 큰 쌍(PRL 167% 등)이 후보로 나오던 문제 — 은 `funding/rates.ts` `groupByCanonical`(중앙값 대비 `MAX_PRICE_DEVIATION_PCT` 초과 venue 제외, 전원 불일치 그룹 삭제)과 `arb-auto.ts` `fetchFundingSpreads`(중앙값 필터 + 선택된 롱/숏 쌍 자체의 가격 괴리 검사)로 수정. 라이브 `arb scan`: 괴리 >5% 쌍 0건.

**기존부터 있던 위험 — 수정됨 (2026-10-01, 실금액/테스트넷 전):** 모든 봇/arb 주문 경로가 §12.3 규칙(검증된 체결, 청산·롤백·trim은 reduce-only, 결과 불명 시 재시도 없이 격리, 순차 레그 = 두 번째 레그는 첫 레그의 검증 체결량 기준, 진입·청산 전 격리 확인)을 따른다. 공용 헬퍼: `src/commands/arb-auto.ts` `openPerpPairVerified` / `closePerpPairVerified`(placePerpVerified + trimFirstLegToHedge + quarantineSymbol), `placePerpVerified`의 `place` 옵션(smartOrder IOC를 같은 방식으로 검증).
- **funding-auto** (`src/bot/strategies/funding-auto.ts`): spot-perp 모드가 스팟 레그 없이 perp 숏만 열던 문제 → 모드 제거(`spotPerpRatio > 0`이면 init에서 `CAPABILITY_UNSUPPORTED`; 이 전략은 매 tick 라이브 perp 포지션으로 페어를 재발견하고 스팟 상태를 보관하지 않아 스팟 레그를 소유/청산할 수 없음 → `spot-perp-arb` 사용). perp-perp 진입 `Promise.all` → 순차 검증 레그 + reduce-only 롤백 + trim + 격리. 청산은 venue 포지션 크기 문자열 그대로 reduce-only 검증(`toFixed(0)` 반올림 제거), 결과 불명/부분 청산/한쪽만 닫힘 → 즉시 격리, 확정 실패 3회 연속 → 격리. 거래/펀딩 이력 조회 실패는 0으로 취급하지 않고 해당 tick의 청산 판단을 건너뜀.
- **arb auto 데몬**: 진입 병렬 + 비 reduce-only 롤백 재시도 2회 → 순차 검증 레그(상태에는 검증된 hedged 수량 저장). 청산 병렬 + 실패 레그 재시도 2회 + 다음 사이클 양쪽 재전송 → 순차 reduce-only 검증, 사이클 내 재시도 없음, 확정 실패(변화 없음)만 다음 사이클 재시도·3회 연속 시 격리, 불명/부분/한쪽만 닫힘은 즉시 격리(상태 유지). `arb dex-auto`도 동일(청산 실패 시 추적에서 빠지던 문제 포함).
- **arb exec perp-perp**: 병렬 raw 주문 → 순차 검증 레그(`--smart`는 IOC를 `place`로 검증), silent-reject/롤백/reconcile trim의 best-effort 비 reduce-only 주문 → reduce-only 검증, 재시도 없음, 불명 → 격리. "Rollback OK — no open exposure"는 롤백 체결량을 측정해 잔여가 있으면 격리 + `openExposure` 보고. `trading` role 없는 venue(variational) 레그는 `CAPABILITY_UNSUPPORTED`(perp-perp 양 레그, `spot:*`의 perp 레그).
- **arb close** (`src/commands/arb/index.ts`): `closeWithRetry`(비 reduce-only, 2회 재시도) → `closePerpPairVerified`(venue 포지션 크기, 순차 reduce-only 검증, 재시도 없음, 불명 → 격리). perp-perp·spot-perp 두 경로 모두 격리 심볼은 `RISK_VIOLATION`, `--force`로만 진행(경고 출력, 격리는 해제하지 않음).
- **bot engine** (`src/bot/engine.ts` executeActions): market `place_order`에 `reduceOnly` 전달(이전엔 limit만).
- **funding-arb** (`funding-arb-strategy.ts`): spot-perp 복구가 동일 venue만 보던 것 → canonical 심볼(quarantineKey)로 교차 venue(스팟 A, perp 숏 B)까지 재구성, 동일 venue 우선, 후보가 여럿이거나 이미 다른 숏에 매칭된 보유분이면 격리(미추적 노출 방지), 격리 심볼은 추적만 하고 손대지 않음. 진입 롤백 sweep(`notional × 1.02`) → 이번 매도 대금만(매도 전 quote 초과분, 이번 진입 이체액 상한).
- **Lighter perp** (`lighter.ts`): open orders / order history / trade history의 `is_ask` 누락 시 buy로 기본값 → `EXCHANGE_ERROR` throw(`getOpenOrders`의 catch가 이를 "주문 없음"으로 삼키지 않음).
- **CLI `trade close` / `close-all` / `flatten` / `reduce`** (`src/commands/trade.ts`): reduce-only 없이 market 전송 → 모든 venue에 `marketOrder(..., { reduceOnly: true })`(legacy 어댑터는 직접 지원, Ondo/Arcus는 `marketOrder` → `placeOrder` `reduceOnly: true`). `reduce`는 포지션 크기 문자열 기준, 그 소수 자릿수로 floor(`floorSize`), 100%는 포지션 크기 그대로, 포지션보다 크면 `INVALID_PARAMS`. MCP `trade_close`는 이미 reduce-only(확인).
- **arb auto basis 체크** (`src/commands/arb-auto.ts`): aster 등 pacifica/hyperliquid 외 venue를 `ltMarkPrice`로 매핑 → `SNAPSHOT_MARK_COLUMNS`(venue → snapshot mark 컬럼 + 라벨) 데이터 기반, 컬럼 없는 venue는 경고 출력 후 체크 생략.
- **Ondo client 타임아웃** (`src/exchanges/ondo/client.ts`): `ONDO_REQUEST_TIMEOUT_MS`(15 s, fetch + body). GET 실패/타임아웃 = 확정 오류(`TIMEOUT` / `EXCHANGE_UNREACHABLE`), POST 실패/타임아웃 = 결과 불명(`ORDER_PENDING`, `orderOutcomeUnknown`). Arcus REST client(`arcus/client.ts`)는 기존 15 s 타임아웃에 같은 GET/POST 분류 적용(POST 실패가 재시도 가능한 `EXCHANGE_UNREACHABLE`이던 것). Arcus spot router는 이미 타임아웃 + `/submit` → `ORDER_PENDING`.
- **funding-auto 청산 조건** (`src/bot/strategies/funding-auto.ts`): `Math.abs` 스프레드 → 보유 방향 기준 부호 있는 스프레드(숏 venue 시간당 − 롱 venue 시간당, funding basis 정규화, 연환산) ≤ `perpPerpCloseSpread`(코드 기본값도 선언된 파라미터 기본값 0으로 일치; 이전 getter 기본값 5는 미사용).
- **HIP-3 포지션 검증** (`src/bot/perp-order.ts` `signedPerpPosition`): HL dex 어댑터면 주문 심볼과 포지션 coin을 어댑터와 같은 해석(`resolveSymbol` + dex prefix, 대소문자 무시)으로 비교 → `pair.long.raw`/`getPositions()` 표기 차이로 인한 허위 격리 방지. 실계정(테스트넷) 확인은 남음.
- **2차 (2026-10-01, 남은 주문 경로):** 신규 `closePerpVerified()`(`src/bot/perp-order.ts`) — reduce-only 검증 청산 후 체결이 요청보다 적으면(80% 허용) 포지션 재조회 → 측정된 잔여분만 reduce-only market 1회 → 그래도 남으면 `residual` 반환, 호출자 격리. `closePerpPairVerified`·`openPerpPairVerified` 롤백·`trimFirstLegToHedge`(부분 trim → `ORDER_PARTIAL` → 격리)가 사용.
  - **`perp strategy funding-arb --auto-execute`** (`src/strategies/funding-arb.ts`): `Promise.all` 양 레그 + lot-size 오류 시 양 레그 재전송 + `reconcileArbFills`(venue 전체 포지션, 비 reduce-only) → `openPerpPairVerified`(source `funding-arb-cli`) / `closePerpPairVerified`(venue 포지션 크기 문자열, 추적 수량 상한) / 한쪽 소멸 시 남은 레그만 reduce-only 검증 청산, 비상 청산 동일, 격리 확인. lot-size: 롱이 확정 거절(아무것도 안 나감)이면 1회 재계산, 숏 거절이면 롱 재전송 없이 숏만 lot 내림 수량으로 1회(`shortLotRetry`) 후 롱 초과분 trim. 선택 쌍 가격 괴리 검사 추가. `reconcileArbFills` 삭제.
  - **`trade multi`** (`src/commands/trade.ts`): 병렬 raw 주문 + `Promise.race` "Leg timeout"(체결됐을 수 있는 레그를 실패로 보고, 비 reduce-only 롤백) → 레그 순차 `placePerpVerified`(`--smart`는 `place`로 IOC 검증, fallback 없음), 확정 실패 시 이후 레그 미전송, 체결 레그는 측정 체결량으로 reduce-only 롤백(+잔여 1회), 불명 레그 → 격리(`trade-multi`)·롤백 없음, 롤백 실패/불명/잔여 → 격리. `--timeout` 제거(`INVALID_PARAMS`).
  - **부분 체결 잔여**: funding-arb(봇) 롤백·perp-perp 청산·고아 숏, funding-arb-v2 롤백·청산, funding-auto 롤백·청산, spot-perp 청산(perp 잔여 시 스팟은 검증된 perp 청산량만 매도 + 격리, 스팟 매도 실패 시 재헤지는 측정 청산량)·로테이션(새 숏 = 옛 숏 검증 청산량), 헤지 복원 재오픈 부분 체결 → 격리. funding-arb spot-perp 진입에서 perp 숏 < 스팟 → 격리.
  - **`arb exec spot:*`**: 초과 숏 reduce 2회 시도 → `closePerpVerified` 1회; reduce 실패 또는 검증 숏 < 스팟 보유면 `filled` 대신 격리 + `status: "quarantined"`, `exposure`.
  - **smartOrder** (`src/smart-order.ts`): 오더북 조회 실패·빈 호가·가격 계산 불가·응답 내 거절·명시적 IOC no-match(`executedQty` 0) → `ORDER_REJECTED`(전송 안 됨/아무것도 안 남음) → `placePerpVerified`의 허위 격리 제거. 명시 신호 없는 IOC 0체결(Lighter)은 측정 → 격리 가능(유지).
  - **`isPositionGone(e)`** (`funding-arb-utils.ts`): 에러 객체 수용, `ORDER_REJECTED` + `details.reduceOnlyFlat` 우선(ORDER_PENDING은 항상 false), 텍스트 `(no X position to reduce)`·HL `Reduce only order would increase position` 추가. `placePerpVerified`: 평문 lot-size 거절 + 포지션 불변 → `ORDER_REJECTED`(`details.lotSize`).
  - **trailing-stop**: 시작 시 크기로 비 reduce-only market → 트리거 시 포지션 재조회, 라이브 크기로 `closePerpVerified`; 포지션 소멸 → `reason: "position_gone"`. **plan `close_position`**: reduce-only, 라이브 크기. **MCP**: 모든 도구 에러가 `classifyError` 구조(`code`/`retryable`/`remediation`/`details`), `trade_execute`/`trade_close`는 확정 실패 외 전부 `ORDER_PENDING`("do NOT resubmit").
  - **funding/rates.ts**: 정규 그룹에서 선택된 롱/숏 쌍 자체의 가격 괴리 > `MAX_PRICE_DEVIATION_PCT` → 제외(2-venue 그룹이 최대 10% 괴리로 통과하던 문제).
  - **삭제**: `funding-arb-v2-strategy.ts`(미사용), `recoverArbPositions()`, `reconcileArbFills()`.
- **3차 (2026-10-01, 메인넷 블로커) — 수정됨:**
  - **MCP `trade_execute`** (`src/mcp-server.ts`): 주문 후 포지션 조회 실패가 이미 나간 주문을 재시도 가능한 에러로 바꾸던 문제 → 조회를 캐시 무효화 후 감싸고 실패 시 `ok: true` + `currentPosition: null` + `warning`. 다른 MCP 주문 도구는 `trade_close`뿐이며 주문 후 조회 없음(사전 조회는 캐시 무효화).
  - **어댑터 전송 전 실패 타입화** (`ORDER_PENDING` 오분류 제거, 메시지 유지): Lighter `getMarketIndex` → `SYMBOL_NOT_FOUND`, `getMarkPrice` → `PRICE_STALE`, `toTicks` 소수 자릿수 미로드 → `ORDER_REJECTED`·최소 크기 미만 → `SIZE_TOO_SMALL`·최소 가격 미만 → `INVALID_PARAMS`, `ensureSigner` → `NO_SIGNER_AVAILABLE`, `sendTx` 전 signer 오류 → `SIGNATURE_FAILED`, `marketOrder`/`limitOrder`/`stopOrder`의 `sendTx` 이전 전 구간 → `orderNotSent`. Hyperliquid `getAssetIndex` → `SYMBOL_NOT_FOUND`, `_validateOrderFill` 주문별 에러·IOC 0체결 → `ORDER_REJECTED`(resting은 미확정 유지), dex 시세 없음 → `PRICE_STALE`, L1 서명 실패 → `SIGNATURE_FAILED`. Aster 폴링 종결 상태(0체결)·즉시 종결 0체결·취소 확인된(체결 0) 3초 미체결 → `ORDER_REJECTED`(취소 실패는 미확정 유지), 서명 실패 → `orderNotSent`. Pacifica 응답 `success:false`·폴링 cancelled/rejected(0체결) → `ORDER_REJECTED`, 서명 실패(`signedBody`) → `orderNotSent`. Arcus 도달 불가 clientId 가드 → `INVALID_PARAMS`. `DEFINITE_ORDER_FAILURE_CODES`에 `PRICE_STALE` 추가(전송 전에만 발생).
  - **plan-executor** (`src/plan-executor.ts`): 롤백이 `cancelAllOrders()`(전 심볼, 에러 삼킴)만 하던 문제 → 체결된 `market_order` 스텝은 측정 체결량만큼 reduce-only `closePerpVerified`, limit/stop 스텝은 해당 심볼 주문만 취소, 실패 → `rollback_failed` + 격리(`plan-execute`). `market_order`/`close_position`은 `placePerpVerified`, limit/stop의 비확정 오류 → `ORDER_PENDING`. 결과 불명 스텝 → `pending`, 플랜 중단 + 격리, 그 스텝(심볼)은 롤백 안 함. `dependsOn`은 의존 스텝이 success/dry_run일 때만 실행(skipped/pending/rolled_back도 차단).
  - **funding-arb(봇) `closePerpPerp`**: 숏 청산 확정 실패 시 롱 재오픈(비 reduce-only, 매 tick 반복 가능) → 즉시 격리(`closePerpPairVerified`와 동일). 롱 청산 확정 실패 연속 `MAX_CLOSE_FAILURES`(3) → 격리.
  - **funding-arb-v2 `closePosition`**: 롱 청산 후 숏 청산 확정 실패 → 즉시 격리(네이키드 숏을 여러 tick 유지하지 않음).
  - **reduce-only 청산 전 캐시 무효화** (`invalidateCache("acct")`): `strategies/funding-arb.ts` `venueLegSize`, `trailing-stop.ts` `closeLive`, MCP `trade_close`, `arb-auto.ts` spot-perp close, plan `close_position`.
  - **`trade multi` / `arb exec` 종료 코드**: 실패/격리/불명 결과가 `ok: true`로 나가던 문제 → `process.exitCode = 1` + JSON `ok: false`(`ORDER_PENDING` / `ORDER_PARTIAL` / `ORDER_REJECTED`, 전체 결과는 `error.details`). `arb exec` 사전 중단도 `ok: false`.

---

## 12. 스팟 확장 (2026-10-01)

근거: `scratchpad/spot-aster-pacifica.md`, `scratchpad/spot-ondo-arcus.md`.

### 12.1 범위
| venue | 스팟 | 구현 | 계정 모델 |
|---|---|---|---|
| hyperliquid | 기존 `HyperliquidSpotAdapter` | 유지 (정의에 연결만) | 통합(unified) + USDC 이체 |
| lighter / lighter-rh | 기존 `LighterSpotAdapter` | 유지 (정의에 연결만) | 분리 + self-transfer |
| **aster** | `sapi.asterdex.com` `/api/v3/*`, 71개, USDT/USD1 quote | **신규 `AsterSpotAdapter`** — 기존 EIP-712 서명 재사용, 호스트·경로만 다름 | 분리 + `/api/v3/asset/wallet/transfer` (`FUTURE_SPOT`/`SPOT_FUTURE`) |
| **pacifica** | `SOL-USDC` 1개 (`/info` `instrument_type:"spot"`) | **신규 `PacificaSpotAdapter`** — 기존 client 주문/취소 재사용 | **공유 계정** (이체 없음, 스팟 보유분이 perp 담보) |
| **ondo** | 11개 주식/ETF 스팟 (`/v1/spot/*`, 공개 문서 없음 — 웹앱 경로) | **신규 `OndoSpotAdapter`** — 기존 HMAC client | 분리 + `POST /v1/perps/transfers` (`spot`↔`margin`) |
| **arcus** | 스왑 라우터 (`router.spot.arcus.xyz`, Permit2, Robinhood Chain 온체인 정산) | **신규 `ArcusSpotAdapter` — 시장가 스왑만**. 지정가/오더북/취소 = `NOT_IMPLEMENTED` | 지갑 ERC-20 (거래소 계정 아님), 이체 없음 |
| ~~variational~~ (제거됨) | 없음 | — | — |

### 12.2 계약
- `VenueDefinition`에 `spot: VenueSpotDefinition | null` 추가:
  ```ts
  interface VenueSpotDefinition {
    accountModel: "unified" | "separate" | "wallet";   // unified=perp와 공유, separate=별도 잔고+이체, wallet=온체인 지갑
    quoteAssets: string[];                              // ["USDC"] | ["USDT","USD1"] | ["USDG"]
    capabilities: { limitOrder: boolean; orderbook: boolean; cancel: boolean; transfer: boolean };
    createSpot(perp: ExchangeAdapter): Promise<SpotAdapter>;   // 지연 import
  }
  ```
- 흩어진 스팟 생성(약 10곳: index.ts, portfolio.ts, trade.ts spot-*, bot/engine.ts, funding-arb-*.ts, spot-perp-*.ts, arb-auto.ts)을 **`getSpotAdapter(venueId, perpAdapter)` 한 곳**(`src/exchanges/spot-factory.ts`)으로 교체. `spot === null`이면 `CAPABILITY_UNSUPPORTED`.
- `SpotAdapter` 인터페이스는 유지하고, 선택 기능은 capability guard로: `SpotTransferCapable { transferToSpot(amount: string, asset: string); transferToPerp(...) }`, `SpotCancelAllCapable`, `SpotOpenOrdersCapable`. 기존 HL/Lighter의 `transferUsdcToSpot(number)`은 유지하되 새 인터페이스도 구현.
- 미지원 메서드(Arcus 지정가 등)는 **`NOT_IMPLEMENTED` + remediation** (Rule #2: 빈 오더북 반환 금지).
- 스팟 시장가 슬리피지: 기존 HL/Lighter 동작 유지. 신규(Aster는 native market, Pacifica는 기존 client 방식, Ondo/Arcus는 slippage 필요)는 `settings.slippageBps[venue]` 또는 `--slippage-bps` 필수 → 없으면 `SLIPPAGE_REQUIRED`.
- Aster 스팟은 agent `permissions.canSpotTrade === true` 필요 → 아니면 `POLICY_DENIED` + remediation `perp wallet agent approve aster --can-spot`(플래그명은 현행 코드 확인).
- **Pacifica perp `getMarkets()`에서 `instrument_type === "spot"` 제외** (현재 SOL-USDC가 perp로 섞임 — 버그).

### 12.4 critic 반영 (APPROVE-WITH-EDITS) — §12.1~12.3보다 우선
1. **팩토리 계약:** `getSpotAdapter(venueId, perp): Promise<SpotAdapter | null>` (`src/exchanges/spot-factory.ts`). null = `def.spot === null`. init/네트워크 에러는 전파(catch 없음). `createSpot`이 `init()` 호출. 캐시 키 `${venueId}:${network}` (→ §12.3 리뷰 반영: perp 어댑터 인스턴스 기준으로 변경). `funding-arb-utils.getSpotAdapter` 삭제 → 모든 호출부가 팩토리 사용. CLI 명령은 null → `CAPABILITY_UNSUPPORTED`.
2. **교체 대상 전수:** `index.ts:335-360`, `portfolio.ts:328-370`, `trade.ts` spot-buy/spot-sell/spot-balance, `bot/engine.ts:582,613`, `funding-arb-utils.ts:40-101,190,212`, `funding-arb-strategy.ts:142-153,503,843,922`, `funding-arb-v2-strategy.ts:293,492,592`, `spot-perp-arb-strategy.ts`, `spot-perp-executor.ts`, `commands/arb/index.ts:406-422,769-779`(`SPOT_EXCHANGES`), `arb-auto.ts:1879`(+instanceof 캐스트 1921/1936/2221/2449/2460), `arb/index.ts:867/878`, `wallet.ts:601`, `funding/rates.ts:383-400`(스팟 탐색은 `def.spot` 기반).
3. **봇 범위:** 이번 단계에서 봇 spot-perp(funding-arb*, spot-perp-*, arb-auto, arb/index)는 `accountModel ∈ {separate, runtime}` **이고** `capabilities.transfer`인 스팟 venue만 허용. Pacifica(공유 마진)·Arcus(온체인 스왑)는 봇에서 `CAPABILITY_UNSUPPORTED`로 제외. (CLI 수동 스팟 거래는 허용.)
4. **이체:** `transferUsdcToSpot/ToPerp` 헬퍼는 `SpotTransferCapable`로 디스패치, `asset = def.spot.quoteAssets[0]`. `unified` = no-op이며 "Transferred" 로그 금지. 그 외 capability 없음 = throw. HL은 `accountModel: "runtime"`(`isUnifiedAccount`로 결정).
5. **결과 타입:** `SpotOrderResult { venue, symbol, orderId: string|null, status: "filled"|"partial"|"open"|"pending"|"rejected"|"cancelled", filledSize: string|null, avgPrice: string|null, finality: "final"|"pending", receivedToken: string|null, venueRaw }`. 신규 어댑터는 이것을 반환. Arcus는 `/status` 확정 후 반환, 타임아웃이면 `finality:"pending"` + "재시도 금지" remediation(throw 아님 — 이미 제출됨).
6. **심볼:** `SpotMarketInfo.symbol = BASE/QUOTE`. 어댑터는 bare base 또는 BASE/QUOTE를 받아 venue 형식(BTCUSDT, SOL-USDC, TSLA-USDC, 토큰 주소)으로 변환. base 하나에 quote가 여럿이면(Aster USDT/USD1) bare base는 `quoteAssets[0]`. quote/base 판정은 `def.spot.quoteAssets` 사용(`startsWith("USDC")` 금지). spot-perp 매칭은 `canonical-symbols.ts`.
7. **Arcus:** master EVM 키(OWS `--wallet`/`owsActiveWallet`)로 서명, 없으면 `NO_SIGNER_AVAILABLE`. **스팟은 Arcus perp agent 키 불필요** — `ArcusAdapter`는 master 자격(owsWallet/pk)만 있고 agent가 없어도 생성되며, agent가 필요한 perp 호출(주문/취소/amend/레버리지/private 조회/출금)은 `requireAccount()` 한 곳에서 `AGENT_NOT_REGISTERED`(remediation `perp wallet agent approve arcus`)로 호출 시점에 실패(fallback 없음). `allowWrapped=false`(wrapped 수령 시 실패). EIP-2612 permit 불가 토큰의 approve tx는 `--yes` + RH ETH 잔고 확인 필요. RPC는 `VenueNetworkConfig.rpcUrl`(신규 필드). 라우터 API 키 저장 안 함(필요 판명 시 SSOT Rule #3 표에 추가).
8. **Pacifica/Aster:** Pacifica 잔고의 USDC 행은 `shared: true`로 표시, portfolio/index는 perp equity에 중복 합산 금지. 스팟 주문 `reduce_only:false`. Aster `canSpotTrade` 게이트는 **signer가 agent일 때만**, remediation `perp wallet agent rotate aster --can-spot`. MARKET_LOT_SIZE 검사, FOK 거절.
- 슬리피지 키는 perp와 동일한 `settings.slippageBps[venue]`. Ondo는 perp에서 선택이지만 **스팟 시장가(IOC limit)는 필수** — 같은 키, 다른 필수성(명시).

### 12.3 위험
- Ondo 스팟 엔드포인트는 비문서 → HMAC 키 수용 여부, transfer wallet 이름 `"spot"` 테스트 단계 확인 (§11에 추가).
- Arcus 스왑: 라우터 API 키 요구 여부, Permit2 최초 approve의 ETH 가스, wrapped 토큰(wTSLA) 수령 시 메이커 정산 위험 → 결과에 수령 토큰 명시.
- Pacifica 스팟 매수는 perp 마진을 줄임 → 주문 전 경고 출력.
- Arcus getSpotMarkets is slow (~80s; one /price per token, router rate limit) — prefer spot-buy/spot-sell directly. Valuation (portfolio / landing) prices only held tokens via `SpotPricesCapable.getSpotPrices(tokens)` (required for `accountModel: "wallet"`), bounded by `SPOT_VALUATION_TIMEOUT_MS` (5 s).

**리뷰 반영 (2026-10-01, spot 확장 독립 리뷰):**
- **체결 해석 단일화:** 봇/arb의 모든 스팟 레그는 `spotMarketFill()` / `interpretSpotFill()` (`src/exchanges/spot-result.ts`)을 거친다. rejected/cancelled → throw, pending/open/미보고 체결 → `ORDER_PENDING`(재시도 금지), partial/filled → 체결 수량 반환 → 헤지는 체결 수량만. 레거시 Lighter 결과(tx hash만)는 주문 전후 base 잔고 delta로 측정, delta 0은 `ORDER_PENDING`.
- **arb exec spot:\*:** 모든 검증(잔고·가격 동일성·depth·사이징) → dry-run 반환 → 레버리지 → 부족분만 이체 → 주문. 이체 후 abort는 되돌려 이체 + 보고. 병렬 진입에서 스팟 미체결/부분/pending이면 perp 숏을 체결 수량까지 reduce-only로 축소(naked short 금지), 상태에는 실제 레그 수량 저장.
- **Arcus `/submit` 이후:** 어떤 에러(status poll, receipt, 불일치, txHash 없음)도 throw하지 않고 `finality:"pending"` + tx hash/order id + "do NOT resubmit". intent deadline > 5분 거부, EIP-712 타입 고정(Permit2 `PermitWitnessTransferFrom`/`TokenPermissions` + SDK `TakerIntent` 필드 순서) 불일치 시 서명 거부, 서명 전 USDG 금액 stderr 출력 + `venueRaw`.
- **봇 spot↔perp 매칭:** `matchSpotPerp()` — `canonicalFor(spotVenue, base, perp.assetClass) === perp.canonical`(perp venue public data) **그리고** |spot−perp mark| ≤ `MAX_PRICE_DEVIATION_PCT`. bare-ticker 일치만으로는 매칭하지 않는다. 봇 포지션은 심볼 하나만 저장(`getPerpSymbol(base)`)하므로 perp 심볼이 다른 canonical 쌍(UBTC↔BTC 등)은 로그 후 건너뛴다(포지션 모델에 perp 심볼 저장 시 해제 가능).
- **`SpotMarketInfo.markPrice: string | null`** — 사용 가능한 가격 없음 = null (Ondo 단면 호가에서 last price 대체 금지, Lighter `"0"` 금지). 평가/매칭에서 제외.
- **팩토리 캐시 키(§12.4 #1 갱신):** `${venueId}:${network}` 대신 perp 어댑터 인스턴스(자기 network에 고정) × `confirmOnchainApprove`. read-only/서명 어댑터가 서로 evict하지 않음.
- **불명/비헤지 결과 = 격리(quarantine), 재시도 금지 (2026-10-01 verifier 반영):**
  - `ORDER_PENDING` 스팟/perp 레그, 미확인 perp 레그, 실패/부분 롤백, dust 진입 체결, 상태 불명 로테이션 레그, 연속 3회 청산 실패, spot-perp-executor의 `manual` 결과, stop 시 닫지 못한 funding-arb-v2 포지션, `arb exec spot:*`/`arb close`의 pending·MANUAL 결과 → `src/bot/quarantine.ts`가 `~/.perp/bot-quarantine.json`에 기록(`<source>:<SYMBOL>`, source = 전략명 또는 `arb-exec`/`arb-close`) + `[QUARANTINE] CRITICAL` 로그(remediation 포함).
  - **격리는 심볼 단위 전역**: 조회는 source와 무관하게 심볼로 한다. funding-arb, funding-arb-v2(라이브), spot-perp-arb, funding-auto, `arb exec`(perp-perp·`spot:*`, `RISK_VIOLATION`으로 거부), `arb auto` / `arb dex-auto` 데몬(진입·청산), `arb close`(`--force` 없으면 `RISK_VIOLATION`) 모두 격리 심볼을 건너뜀(진입·청산·로테이션·stop 청산). 매 조회마다 파일을 다시 읽으므로 CLI(별도 프로세스)의 `perp strategy quarantine-clear <SYMBOL> [--strategy <source>]`는 실행 중인 봇의 다음 tick부터 반영(재시작 불필요). 영속화 실패한 항목만 프로세스 메모리에 보관(해당 프로세스 종료까지). 파일 읽기 실패는 격리로 간주(fail-closed).
  - `SpotPerpExecutor.closePosition` → `CloseResult`에 `{ closed: false, manual: true, reason }` 추가. perp가 이미 없던(이번 호출이 닫지 않은) 상태에서 스팟 매도 실패 시 perp 숏 재오픈 금지 → manual. `openPosition`도 pending/검증 실패/dust/롤백 실패/perp 숏 결과 불명 시 `manual: true`. `rotateShort` → `RotationResult { ok, manual, reason }`: 청산·신규 숏 결과 불명 또는 롤백 재오픈 실패 = manual(격리, 10분 쿨다운 아님); 신규 숏 결과 불명이면 기존 숏 재오픈 금지(이중 숏 방지).
  - spot-perp 청산(funding-arb, spot-perp-arb 공통): executor `closePosition` — perp 숏 **먼저** reduce-only(검증) → 스팟 매도 → 이번 매도 대금(청산 전 quote 대비 delta)만 perp로 이체. perp가 이미 없으면 reduce-only 거절로 감지(스팟을 다시 팔지 않음). 결정적 실패는 5분 쿨다운, 연속 3회 → 격리 (sell→fail→rebuy / close→fail→re-hedge 루프 금지).
- **주문 결과 분류 (2026-10-01 verifier 2차):**
  - 새 코드 `ORDER_REJECTED`(retryable false) = 확실히 미체결(venue 명시 거절 또는 전송 전 실패). `DEFINITE_ORDER_FAILURE_CODES` / `isDefiniteOrderFailure()` (`src/errors.ts`): 검증·정책·서명자·`ORDER_REJECTED` 등.
  - `spotMarketFill()`: 주문 호출이 던진 에러가 definite 코드면 그대로(확정 실패), **그 외 전부**(비-PerpError, `EXCHANGE_UNREACHABLE`, `TIMEOUT`, `EXCHANGE_ERROR`, `RATE_LIMITED`, `UNKNOWN`) → `ORDER_PENDING` → 호출자는 격리.
  - 어댑터: 요청 전 단계(마켓 해석, 수량/notional 검증, 기준가, nonce, 서명, allowance) 실패 = `ORDER_REJECTED`(`orderNotSent`); 요청 후 transport 오류·timeout·5xx·본문 해석 불가 = `ORDER_PENDING`(`orderOutcomeUnknown`). Lighter/Lighter RH `sendTx`(non-200 code·실패 tx status = `ORDER_REJECTED`), Hyperliquid(`status:"err"`·0 체결 IoC = `ORDER_REJECTED`, per-order status 없음·resting IoC = pending), Ondo(4xx envelope = `ORDER_REJECTED`), Aster(서명 후 네트워크 오류 = pending 결과, 4xx = `ORDER_REJECTED`), Arcus(`/submit` 본문 읽기 실패 = `ORDER_PENDING`, 라우터 4xx = `ORDER_REJECTED`).
  - **perp 레그도 가정하지 않는다:** `placePerpVerified()` (`src/bot/perp-order.ts`) — 주문 전/후 포지션(캐시 우회, polling) delta ≥ 80%(또는 reduce-only가 포지션을 0으로) = 체결; 움직임 없음/포지션 읽기 실패/transport 오류 = `ORDER_PENDING`. spot-perp-executor, funding-arb(perp-perp 레그·청산·롤백, spot-perp 숏), funding-arb-v2 사용. Lighter perp `marketOrder`의 "assuming executed"는 그대로 두되 봇에서는 delta로 확인. perp 결과 불명이면 스팟/롱 롤백 금지(naked short 방지) → 격리.
  - **Lighter tx event 체결 교차검증:** `event_info` `is`−`rs`로 만든 체결(`venueRaw.fillSource = TX_EVENT_FILL_SOURCE`)은 `spotMarketFill()`에서 fresh base 잔고 delta ≥ 80% 확인, 미달/읽기 실패 = `ORDER_PENDING`.
  - **복구:** 포지션/스팟 잔고 읽기 실패 venue를 "포지션 없음"으로 취급하지 않음 — 로그 + 해당 venue 진입 차단, funding-arb/spot-perp-arb는 매 tick 복구 재시도.
  - **funding-arb-v2:** 라이브 전략은 `funding-arb-v2.ts`(engine.ts가 import). `funding-arb-v2-strategy.ts`는 457de60 이후 import되지 않던 dead code — 이전 v2 하드닝 기술은 철회, 파일은 2026-10-01 삭제. 라이브 v2: 레그 순차·검증, 숏 실패 시 롱 reduce-only 롤백, 청산은 진입 수량으로 reduce-only, stop 시 미청산 포지션은 격리(삭제 금지).
  - `arb auto` 데몬은 perp-perp만 관리. 저장된 `mode: "spot-perp"` 포지션은 경고 1회 후 제외(`perp arb close <symbol>`로 청산), 같은 심볼의 perp-perp 신규 진입 차단(상태가 심볼 키).
- **perp 결과 불명 처리 강화 (2026-10-01 verifier 3차):**
  - `placePerpVerified()`는 **타입 있는 definite 실패(`isDefiniteOrderFailure`)만** 그대로 던진다. 그 외 모든 에러(untyped `Error` 포함)는 거절로 추론하지 않고 성공 경로와 같은 polling으로 포지션 delta를 측정 — ≥80% 이동 = 체결, 이동 없음 = `ORDER_PENDING`(격리). 유일한 예외: reduce-only 주문이 plain venue 메시지로 실패했고 주문 전후 포지션이 모두 0 → `ORDER_REJECTED`(원 메시지 유지, 호출자의 `isPositionGone()` 유지). 전송 후 서버 오류 `HL exchange API error (5xx)`(hyperliquid exchange POST)·Pacifica `POST … failed (5xx)`는 `isUnknownOutcomeServerError()`(`src/errors.ts`)로 unknown-outcome 분류(위 예외에서도 제외).
  - **`arb exec spot:*` / `arb close`(spot-perp)**: 진입 perp 숏, 진입 축소(reduce-only), 청산 되사기(reduce-only), 재숏, naked-short 축소 모두 `placePerpVerified()`. perp 결과 불명 → `quarantineSymbol` + 중단(스팟 되팔기 없음, 재숏/추가 축소 없음, 상태·이체 미변경, `status: "perp_pending"`). "hedged" 상태 저장은 perp 체결이 검증된 경우만(측정된 체결 수량으로 저장). 청산은 검증된 되사기 수량 기준으로 남은 숏/스팟을 재매칭. 미헤지 진입 실패 메시지는 실제 잔량(spot held / perp short) 표시("no open exposure" 문구 제거).
  - **격리 키 = canonical:** `quarantineKey(symbol)`(`src/bot/quarantine.ts`) — 대문자, HIP-3 dex prefix(`xyz:`)·`-PERP` 제거, `DENOMINATION_ALIASES` 적용(KPEPE→1000PEPE, UBTC→BTC). 등록·조회·해제 모두 이 키로 비교(기존 파일 항목도 조회 시 키 계산). `entry.symbol`은 소스가 보고한 심볼 그대로 표시용 보관.
  - **두 번째 레그 = 첫 레그의 검증 체결량:** funding-arb(perp-perp)·funding-arb-v2 진입의 숏은 롱의 `placePerpVerified` 측정 체결량(`fillSizeString`, 요청 수량 아님)으로 주문. 숏이 덜 체결되면 `trimFirstLegToHedge()`(`src/bot/perp-order.ts`)가 이번 거래의 초과분만(venue 전체 포지션 아님) 롱에서 reduce-only·검증으로 줄임; 실패/불명 → 격리. 추적 수량 = 숏 검증 체결량. 이 경로에서 `reconcileArbFills`(venue 전체 포지션 기준) 미사용.
- **체결 측정 (§12.4 #5 갱신):** Lighter 스팟은 `/tx` `event_info`의 taker order(`is`/`rs`, `is`가 전송한 base amount와 일치할 때만)로 체결 수량을 읽어 `SpotOrderResult` 반환. 체결 보고가 없을 때만 잔고 delta 측정이며, 이때 **캐시 우회 읽기** 사용: `SpotFreshBalancesCapable.getSpotBalancesFresh()`(공유 15s `acct:` 캐시를 쓰는 어댑터 — Lighter, Hyperliquid — 필수 구현) / `readSpotBalancesFresh()`. spot-perp-executor 사전/사후 검증, 청산 후 quote sweep도 동일. Lighter `getSpotBalances()`는 실패 시 throw(`[]` 금지). 읽기 실패를 0으로 취급하지 않는다.
- **제출 결과 불명 = pending:** Aster 스팟 주문 POST가 HTTP 5xx 또는 해석 불가 2xx 본문 → `finality: "pending"` 결과(재시도 가능한 `EXCHANGE_ERROR` 금지). Arcus `/submit` 5xx/timeout/unreachable → `ORDER_PENDING`(retryable false) + intent 만료 전 재제출 금지 remediation.
- **Sweep 범위:** `sweepSpotQuoteToPerp(spot, min, { keep, max })` — 거래 전 스팟 quote(`keep`, 캐시 우회로 읽음)는 건드리지 않고, `arb exec spot:*`는 이번에 이체한 금액(`max`)까지만 되돌림. `arb close` perp 되사기는 reduce-only.
- **남은 미결 항목 (구현으로 확정 불가):**
  1. **Aster 스팟 수수료가 base 자산으로 차감**될 수 있음 → 매수 후 보유량 < 체결 수량이면, 같은 수량으로 청산(spot sell)할 때 잔고 부족. 현재 헤지/청산 수량은 `executedQty` 기준(수수료 미반영). 수수료 자산(`commissionAsset`)·차감 방식 실거래 확인 후 sellable size 계산 필요 (S18).
  2. **Pacifica `account_equity`가 스팟 담보(SOL 보유분 평가액)를 이미 포함**할 가능성 → 포함한다면 portfolio에서 non-shared 스팟 행(SOL)을 perp equity에 더하는 현재 합산이 이중 계상. 실계정에서 equity vs `balance` + 스팟 평가액 비교로 확인 필요 (S19).

**테스트 단계 확인 항목 (스팟, §11 형식 — 구현 중 코드로 확정 불가):**

| # | venue | 확인할 것 | 관련 코드 |
|---|---|---|---|
| S1 | ondo | `/v1/spot/*`가 perps HMAC 키를 수용하는지 (비문서 경로) | `ondo/spot.ts` |
| S2 | ondo | 스팟 잔고 coin 표기 `TSLA` vs `TSLAon`, 수량 단위 | `ondo/spot.ts` getSpotBalances |
| S3 | ondo | transfer wallet 이름 `"spot"`, `from.id`에 accountID 사용 여부 | `ondo/spot.ts` transfer |
| S4 | ondo | 스팟 주문 응답 형태 / 수수료 차감(fee netting) | `ondo/spot.ts` place |
| S5 | ondo | DELETE `?market=` vs body, cancel-all 형식 | `ondo/spot.ts` cancel |
| S6 | ondo | 오더북 depth 파라미터 | `ondo/spot.ts` getSpotOrderbook |
| S7 | ondo | 스팟 TIF 집합 (GTC/IOC/ALO 가정) | `ondo/spot.ts` spotLimitOrder |
| S8 | ondo | 최소 주문 크기 | `ondo/spot.ts` |
| S9 | aster | MARKET BUY에 `quantity` 허용 여부 (quoteOrderQty 필요?) | `aster-spot.ts` spotMarketOrder |
| S10 | aster | 계정 조회(잔고/미체결)도 agent 스팟 권한이 필요한지 | `aster-spot.ts` |
| S11 | aster | 시장가 주문에 MIN_NOTIONAL 적용 여부 | `aster-spot.ts` |
| S12 | aster | 권한 부족 시 에러 코드 (POLICY_DENIED 매핑) | `aster-spot.ts` |
| S13 | aster | 실 응답 status 값 (NEW/FILLED/EXPIRED…) → `SpotOrderResult.status` 매핑 | `aster-spot.ts` |
| S14 | arcus | ~~스팟 시장가 per-call 슬리피지 없음~~ → **해결:** `spotMarketOrder(…, opts?: { slippageBps })`, 우선순위 `opts.slippageBps` → `settings.slippageBps.arcus` → `SLIPPAGE_REQUIRED`; `venues/arcus.ts` `perCallSlippage: true` (CLI `--slippage-bps` 전달) | `arcus/spot.ts`, `venues/arcus.ts` |
| S15 | 전체 | `arb scan --mode spot-perp` 스팟 탐색은 read-only perp 어댑터 + 스팟 어댑터 `getSpotMarkets()` 사용 — Ondo 스팟 마켓 조회가 무인증으로 되는지 (S1), Lighter RH read-only 초기화 비용 | `funding/rates.ts` fetchSpotPerpSpreads |
| S16 | hyperliquid | unified 계정에서 `transferBetweenSpotAndPerp` 거절 여부 (팩토리는 `isUnifiedAccount`면 no-op) | `spot-factory.ts` transferQuote |
| S17 | lighter | `accountActiveOrders` 행의 `filled_base_amount` 필드명 (spot-orders `filled`) | `lighter-spot.ts` getSpotOpenOrders |
| S18 | aster | 스팟 체결 수수료 자산(`commissionAsset`)이 base인지 — 매수 후 매도 가능 수량 = executedQty − fee? | `aster-spot.ts` _toResult, `spot-result.ts` |
| S19 | pacifica | `account_equity`에 스팟 보유분(SOL) 평가액 포함 여부 → portfolio 이중 계상 여부 | `pacifica-spot.ts` getSpotBalances, `portfolio.ts` |
| S20 | arcus | 라우터 `toSign.types`가 고정한 `TakerIntent` 필드 순서와 일치하는지 (불일치 시 서명 거부 → 스왑 불가) | `arcus/spot.ts` PINNED_INTENT_TYPES |
| S21 | lighter | 스팟 IOC 체결 후 `/tx` status 2/3 시점에 잔고가 반영되는지 (체결 보고 없을 때의 잔고 delta 측정) | `spot-result.ts` spotMarketFill |
| S22 | lighter | 스팟 `/tx` `event_info.to`의 `is`/`rs`가 정수 base 단위(10^sizeDecimals)이고 IOC 잔여 취소 전 값인지 — 불일치(`is` ≠ 전송 base amount)면 잔고 delta로 대체됨 | `lighter-spot.ts` _takerFilledBase |

---

## 13. 통일된 겉면 (Uniform Surface, 2026-10-02)

> 참고: Variational은 제거됨(2026-10-02) — 이 절의 표/예시에서 Variational 언급은 무시.

**사용자 결정:** "겉으로 보이는 것은 모든 거래소가 같게, 뒤에서 처리하는 방식은 거래소마다 달라도 된다." 슬리피지는 **전역 기본값 하나**, 원리상 불가능한 기능은 **같은 형식의 미지원 응답**.

### 13.1 원칙
1. **명령·옵션·기본값·결과 형식은 venue 무관 동일.** venue 차이는 어댑터(TradingV2 구현) 안에서 흡수.
2. 흡수가 **금액상 안전할 때만** 내부 처리(에뮬레이션). 안전하게 흉내 낼 수 없으면 통일 미지원 응답(§13.6).
3. 내부 처리 결과는 **결과에 투명하게 기록**(`OrderResult.execution` — 실제 사용한 방식·변환 내역). 숨기되 감추지는 않음.
4. 기존 안전 계층(§10, §11 수정됨, §12.4) 유지: 체결 확인, 결과 불명=격리, reduce-only 청산.

### 13.2 시장가 = "슬리피지 상한 내 즉시 체결(IOC)" — 모든 venue 동일 의미
- 해석 순서(전부 **명시적 설정**, 숨은 상수 없음): `--slippage-bps` → `settings.slippageBps[venue]` → **`settings.defaultSlippageBps`**(신규, 출고값 50).
  - 출고값 50은 settings 스키마의 **문서화된 기본 설정값**이며 `perp settings show`에 표시, `perp settings set defaultSlippageBps <n>`으로 변경 → Rule #2의 "숨은 fallback"이 아님(사용자 가시·설정 가능·결과에 기록).
- venue별 내부 처리:
  | venue | 내부 방식 |
  |---|---|
  | hyperliquid (core·HIP-3) | 보호가 IOC limit (SDK `marketOpen` 숨은 slippage·HIP-3 5% 상수 제거) |
  | lighter / lighter-rh | 보호가 IOC (`mark×2 / ×0.5` 밴드 제거) |
  | pacifica | `slippage_percent = bps/100` (하드코딩 "1" 제거) |
  | aster | 보호가 IOC LIMIT (native MARKET 대신 — 상한 보장) |
  | ondo | 보호가 IOC limit (이미 구현) |
  | arcus | 보호가 IOC (이미 구현) |
  | 스팟 전 venue | 동일 규칙 (Aster 스팟 native MARKET → 보호가 IOC, Pacifica 스팟 percent, Ondo/Arcus 기존) |
- 결과: `execution.slippageBps`, `execution.protectionPrice`, `execution.slippageSource: "flag"|"venue"|"default"`.
- 보호가 기준가: venue mark(없으면 mid) — 기준가를 못 얻으면 `PRICE_STALE`(주문 전, 확실한 실패).

### 13.3 TIF — 공통 집합과 매핑
- 공통 입력: `GTC | IOC | FOK | ALO`(post-only). 기본값 **`GTC` 전 venue 동일**(ondo/arcus의 `TIF_REQUIRED` 폐지).
- 매핑(어댑터 내부):
  | 공통 | hl | lighter(+rh) | pacifica | aster | ondo | arcus |
  |---|---|---|---|---|---|---|
  | GTC | Gtc | GTT(장기) | GTC | GTC | GTC | GTT(goodTil = 최대 허용) |
  | IOC | Ioc | IOC | IOC | IOC | IOC | IOC |
  | FOK | 미지원 | 미지원 | 미지원 | FOK | 미지원 | FOK |
  | ALO | Alo | 미지원* | ALO | GTX | GTC+postOnly | ALO |
  - *Lighter post-only 지원 여부는 SDK/문서 확인 후 매핑, 없으면 통일 미지원 응답.
  - FOK 에뮬레이션(IOC+부분체결 취소)은 **하지 않음** — 부분 체결은 되돌릴 수 없음 → 통일 미지원 응답.
- venue 고유 TIF(`TOB`, `GTX`, `GTT`)는 별칭으로 계속 허용하되 문서상 공통 이름 권장.

### 13.4 주문 정정 (`trade edit`) — 같은 의미: "가격/수량 변경, 원래 TIF·post-only 유지"
- native modify venue: 그대로.
- cancel+replace venue(ondo, aster): **주문 의도 로컬 기록**(`~/.perp/order-intents.json`, venue·orderId·symbol·side·tif·postOnly·reduceOnly — 비밀 아님) → 재주문 시 자동 적용. `--tif` 불필요.
  - 기록이 없는 주문(다른 클라이언트로 낸 주문): venue가 TIF/postOnly를 응답에 주면 사용, 안 주면 **`--tif`를 요구하는 대신** 통일 미지원 응답(`reason: "original order attributes unknown"`, 대안: `--tif` 명시).
  - 부분 체결 주문: 취소 → 체결분 확인 → **남은 수량만** 재주문. 결과 `execution: { method: "cancelReplace", filledBeforeCancel, replacedSize }`.
- 정정 불가 상태(트리거 주문 등): 통일 미지원 응답.

### 13.5 TP/SL — 같은 옵션 `--tp --sl` (진입 첨부) / `trade tpsl` (포지션 대상)
| venue 방식 | 내부 처리 |
|---|---|
| attached (ondo) | 주문에 첨부 |
| batchGroup (arcus) | entryTpsl 배치 |
| positionLevel (pacifica) | 진입 체결 확인 후 포지션 TP/SL 설정 |
| separateOrders (hl, lighter, aster) | 진입 **체결 확인 후** 체결 수량으로 reduce-only 트리거 주문 2개 |
- 진입은 됐는데 TP/SL 설정 실패 → `ORDER_PARTIAL`(재시도 금지, 진입 결과 포함, remediation `perp trade tpsl`).

### 13.6 통일 미지원 응답
```ts
PerpError("CAPABILITY_UNSUPPORTED", "<Venue> does not support <feature>", {
  details: { venue, feature, reason },          // feature: "limitOrder" | "fok" | "postOnly" | "amend" | "trading" | "orderbook" | ...
  remediation: "<대안 명령>",
})
```
- 대상 예: Variational 주문/계정, Arcus 스팟 지정가·오더북·취소, FOK 미지원 venue, isolated 미지원(ondo), Arcus 비-reduce-only 스톱.
- 사람 출력도 한 형식: `✗ <Venue>: <feature> 미지원 — <reason>. 대안: <remediation>`.

### 13.7 결과 형식 통일
- **모든 venue의 trade 명령이 `OrderResult`(§10.10) + `execution`을 반환** — 기존 4개 venue의 legacy 원시 응답(JSON)은 `venueRaw`로 이동. → 기존 4개 venue용 `TradingV2` 래퍼 구현(§10.9에서 미뤘던 항목).
- 스팟은 `SpotOrderResult`로 통일(HL/Lighter legacy 결과도 래핑).
- `--json` 출력 형태 변경 = BEHAVIOR CHANGE. 한 릴리스 동안 `legacy` 필드에 원시 응답 병행 제공.
- **의도된 예외 — 다중 레그 명령:** `trade multi`와 마찬가지로 `trade atomic`(Pacifica 전용, `POST /orders/batch`의 `CreateMarket` 레그 묶음, `src/exchanges/pacifica-atomic.ts`)은 단일 `OrderResult`가 아니라 **레그별 결과**(`outcomes[]`: `symbol` / `side` / `size` / `clientOrderId` / `orderId` / `status` filled·partiallyFilled·notFilled·rejected·unknown / `filledSize` / `detail`)를 반환한다. 전부 체결 = `ok`; 미확인 레그 → `ORDER_PENDING`(그 심볼 격리, 재전송 금지), 0 체결 → `ORDER_REJECTED`, 그 외 `ORDER_PARTIAL` — 전체 레그는 `error.details.legs`. batch 응답의 `CreateMarket` 결과는 `order_id: null`(docs 예시)이라 각 레그는 자신의 `client_order_id`로 추적(`orderByClientId`, 제한된 polling) 후 `history_by_id`로 체결 확인. HTTP 400(문서화된 전체 거절) / 429 외의 batch 실패(timeout, 5xx, 해석 불가 응답)는 **모든 레그**를 격리한다. 다른 venue는 `CAPABILITY_UNSUPPORTED`.

### 13.8 스팟 통일
- `spot-transfer`: unified 계정(pacifica, HL unified)은 **no-op 성공**(`execution.method: "sharedAccount"`, 이동 불필요) — 에러 아님. wallet(arcus)은 통일 미지원 응답.
- `spot-orders`/`spot-cancel`: 지원 venue 동일 형식, arcus는 통일 미지원 응답.

### 13.9 영향·위험
- **기존 venue 주문 경로 변경**(§10.0 "기존 주문 경로 불변" 원칙을 이 절이 대체): HL/Lighter/Pacifica/Aster 시장가 슬리피지 상한이 50bps로 좁아짐 → 얇은 호가에서 **부분 체결·미체결 증가** 가능(체결 확인 계층이 처리, 결과에 표시). 봇/arb는 이미 verified 경로.
- Aster native MARKET → IOC LIMIT 전환: Aster `PRICE_FILTER`/`PERCENT_PRICE` 필터 준수 필요.
- order-intents.json: 비밀 아님(SSOT Rule #3 무관), 손상 시 → 해당 주문 정정은 통일 미지원 응답(추측 금지).

### 13.10 critic 반영 (REVISE) — §13.1~13.9보다 우선

**우선순위:** §13은 다음을 대체한다 — §10.0, §10.8 마지막 bullet(내장 slippage 상수 유지), §10.9 Phase 5 "주문 경로·JSON 불변", §10.10 "tpsl on separateOrders → 거절", §10.13 #6(TIF_REQUIRED), §12.2/§12.4 스팟 slippage(SLIPPAGE_REQUIRED·HL/Lighter 유지), `settings.ts` "No default is ever injected" 주석.

**사용자 결정(재확인):** 슬리피지 기본값은 **진입·청산·트리거 모두 단일 값**(`defaultSlippageBps`, 출고 50). critic이 제안한 청산/트리거 별도 기본값은 채택하지 않음 — 아래 위험을 수용하고 문서화.

1. **단일 해석 함수:** `resolveSlippage(venue, flagBps) → { bps, source: "flag" | "venue" | "default" }` 한 곳(src/exchanges/slippage.ts). 어댑터는 settings를 읽지 않고 **해석된 값을 인자로 받음**(Ondo/Arcus/Pacifica-spot 내부 `getVenueSlippageBps` 호출 제거). 범위 1 ≤ bps ≤ venue 최대(Arcus 1000, Aster PERCENT_PRICE 한도) — 범위 밖은 전송 전 `INVALID_PARAMS`, clamp 금지. 시그니처를 **필수**로: `marketOrder(sym, side, size, opts: { reduceOnly: boolean; slippage: ResolvedSlippage })` → tsc가 모든 호출부를 드러냄.
2. **Rule #2 정합:** 출고 기본값은 (a) `settings.ts DEFAULTS` 한 곳 선언, (b) `resolveSlippage` 한 곳 해석, (c) `settings show`/`--json`에 "(shipped default)" 표시, (d) 모든 결과에 `source` 기록, (e) 잘못된 설정은 throw — 이 조건을 만족하면 "설정"이지 fallback이 아님. **런타임 조회 실패 대체(mark→mid, catch→DEFAULTS)는 계속 금지.** 이 단락을 SSOT_RULES Rule #2에 추가. **`loadSettings`의 `catch → DEFAULTS`(settings.ts:228)를 이번에 제거** — 손상된 settings.json / 잘못된 slippage 키는 `INVALID_PARAMS` throw.
3. **트리거(stop/TP/SL):** 같은 단일 bps를 쓰되 **기준가는 트리거 가격**(mark 아님). venue 네이티브 시장가 트리거(HL `isMarket`, Aster `STOP_MARKET`/`TAKE_PROFIT_MARKET`)는 네이티브 유지(상한 없음). Lighter 트리거 밴드(`mark×0.5/×2`)는 trigger±bps로, Arcus 트리거 레그는 trigger 기준(기존). **수용된 위험:** 50bps 지정가 트리거(Lighter/Arcus)는 급변 시 미체결 가능 → 결과·문서·`trade stop` 도움말에 경고.
4. **확정 IOC 결과 = 확정:** 어댑터가 IOC 결과를 **확정적으로** 보고(`filledSize` + final). Lighter는 tx `event_info`(is−rs), 0 체결 → `ORDER_REJECTED`. `placePerpVerified`는 venue 보고 final 부분 체결을 포지션 delta와 교차 확인 후 `filledSize`로 반환(`ORDER_PENDING` 아님) — 기존 2nd-leg/trim 로직이 처리. **이 변경은 상한 변경과 같은 PR**(분리 금지). 수용된 위험: 얇은 호가에서 청산 부분 체결 → `closePerpVerified` 잔여 1회 재시도 → 잔여 시 격리.
5. **기준가:** venue 정의에 기준가 출처 **하나** 선언(런타임 대체 없음, 없으면 `PRICE_STALE`). Lighter는 `last_trade_price`이므로 orderbook mid로 교체 검토(얇은 RH 주식). 반올림은 `precision.alignProtectionPrice`(체결 방향) + HL 5 유효숫자/`6−szDec`. 실제 적용 bps(반올림 후)를 `execution`에 기록.
6. **Aster IOC LIMIT 전환:** `PRICE_FILTER.tickSize`·`PERCENT_PRICE` 로드, 보호가 체결 방향 정렬, PERCENT_PRICE 밖이면 전송 전 `INVALID_PARAMS`.
7. **`-s/--slippage <pct>`(trade market/buy/sell, 기본 "1", 사실상 미사용) 제거** → `--slippage-bps`만. help 문구 "(ondo/arcus)" 수정. `--split`의 `--max-slippage`(pct)는 별개 개념으로 명시.
8. **결과 형식:** legacy `ExchangeAdapter` 메서드는 **원시 응답 반환 유지**(in-process 계약 — smart-order `isIocNoMatch`/`hasOrderError`, perp-order `checkVenueStatus`, plan-executor `extractOrderId`, grid order id 의존). 4개 기존 venue의 `TradingV2`는 같은 내부 send 함수를 공유하는 **새 메서드**로 추가하고, **`commands/trade.ts`와 MCP 도구만** TradingV2로 전환. CLI `--json`과 MCP 출력 변경 = BEHAVIOR CHANGE, `legacy`(원시) 필드 1 릴리스 병행.
9. **Lighter TradingV2 전제:** `clientOrderId: true`(Lighter `clientOrderIndex` 숫자, CLI 형식 규칙)로 선언 변경 후 래퍼 구현(현재 async+clientOrderId:false 조합은 validator가 전부 거절).
10. **정정(`trade edit`) 의미:** `size` = **새 미체결 수량**(native modify 관례). cancel+replace: `replace = size − (filledAtCancel − filledAtRead)`, ≤0이면 재주문 없음(보고). cancel 결과 불명 → 재주문 금지(`ORDER_PENDING`). cancel 성공·replace 실패 → `ORDER_PARTIAL {cancelled, placed:null}`. **HL `modifyOrder`의 `tif: "Gtc"` 하드코딩 → 원 주문 tif 전달**(frontendOpenOrders). **Aster 정정의 기존 버그(체결분 무시 → 이중 수량) 수정**, Aster v3 native modify(`PUT /fapi/v3/order`) 존재 시 native로.
11. **주문 의도 기록은 Ondo postOnly만:** Aster는 openOrders의 `timeInForce`/`reduceOnly` 사용. Ondo는 **생성한 clientOrderId에 post-only 표식 인코딩**(파일 없음) 우선; 불가 시 주문별 파일 `~/.perp/order-intents/<venue>-<account>-<orderId>.json`(tmp+rename), 어댑터 `placeOrder`에서 기록.
12. **TP/SL:** 진입 전 방향 검사(long: tp > ref > sl). `--tp/--sl` = "이번 진입의 검증된 체결 수량을 보호". positionLevel(Pacifica)은 기존 TP/SL 존재 시 거절(덮어쓰기 금지). separateOrders venue에서 진입이 resting/미즉시 → 통일 미지원 응답. 진입 `ORDER_PENDING` → TP/SL 미배치 + `ORDER_PENDING`("포지션 보호 안 됨"). 실패 코드 `ORDER_PARTIAL`로 통일(`APPROVE_PARTIAL` 사용 중단). **`trade tpsl` side 도움말/동작 불일치 버그 수정**(help는 "CLOSE side", 코드는 포지션 side). Aster TP는 `TAKE_PROFIT_MARKET`(현재 STOP_MARKET 고정 → TP -2021 실패), Lighter/Aster size "0" 문제 수정. HL `normalTpsl` 그룹은 attached 후보로 평가.
13. **통일 미지원 응답 헬퍼:** `unsupported(venue, feature, reason, remediation)` → `CAPABILITY_UNSUPPORTED` + `details.{venue, feature, reason}`. 기존 inline throw 전부 교체. 사람 출력 한 형식.
14. **기타:** `OrderRequest.slippageBps` → 필수 `ResolvedSlippage`, `capabilities.marketOrder` 의미 재정의(내부 방식 표시용), `SLIPPAGE_REQUIRED` 폐지. GTC→GTT 만료(Lighter 28일, Arcus +40일)는 `execution.expiresAt` 기록. `execution`은 필수 필드(`protectionPrice: string | null` — Pacifica는 venue 계산). 스팟 HL 5%·Lighter 5% 상수, `trade-validator.ts:44` 0.5% 검사도 `resolveSlippage`로.
15. **구현 순서:** (1) settings 해석기 + strict loadSettings + 필수 시그니처 → (2) 어댑터 레인 병렬(HL / Lighter / Pacifica / Aster / Ondo·Arcus 정리) + 같은 PR로 perp-order 확정 부분체결 처리 → (3) 정정·TIF 별칭 → (4) TradingV2 래퍼 + trade/MCP 결과 통일 + 미지원 헬퍼 → (5) TP/SL → (6) 스팟.

---

## 부록 A. 조사 출처

- Lighter RH: https://apidocs.rh.lighter.xyz/docs/get-started , 차이점 https://apidocs.lighter.xyz/docs/lighter-rh.md
- Ondo Perps: https://docs.ondoperps.xyz/llms.txt , REST spec https://docs.ondoperps.xyz/api-reference/rest-spec.json
- Arcus: https://docs.arcus.xyz/llms-full.txt
- Variational: https://docs.variational.io/technical-documentation/api , 로드맵 https://docs.variational.io/getting-started/roadmap.md
- CCXT capability 비교: ccxt master `6b40786` (v4.5.84)

## 부록 B. v1 → v2 변경 (critic 리뷰 반영)

- 코드 인용 정정: `lighter.ts:555→559`, `:1383→1381`(+ "chainId 1회 고정" 주장 철회, 검증 항목으로), `lighter-keystore.ts:64→60/65`, `mcp-server.ts:48-64→45-71`, 생성 경로 1개→5개, "50파일"→25파일(152줄은 유지, 실제 범위는 더 큼), `Promise<unknown>` 88→`ExchangeAdapter` 7, `lighter-spot.ts:424` 추가, `createIntentAddress` "chain_id 4663 하드코딩" 주장 철회(`funds.ts:465` 재구현 문제로 대체).
- 추가: 신규 venue 비밀 저장소(Rule #3), public 데이터 경로(L2), funding 주기 필수화, settings/`Exchange` 타입 venue화, spot/outcome/bot/MCP 범위, 캐시 키.
- 변경: 기존 `ExchangeAdapter` 무변경 + 새 메서드 이름(`TradingV2`), `chain` → `keyKind`/`settlementChain`, `slippageBps` 기본값 제거, `OrderResult.finality`와 참조 불변식, `timeoutMs` 필수, canonical 심볼 단일화(HIP-3 포함), Capability 필드 축소, Variational 합성 호가 → `getQuotes()`.
- 단계: Rule #2 정리를 Phase 1로 분리, Phase 2 동작 변화 명시, Lighter RH는 Phase 3 Lighter 부분 완료 후로.

---

## 14. QFEX (8번째 venue `qfex`, 2026-10-04)

> 출처: https://docs.qfex.com/llms.txt, `/api-reference/openapi.yaml`, `/websocket/trade.yaml`, `/websocket/mds.yaml`, 각 `.md` 페이지, 공식 CLI README (https://github.com/QFEX-org/cli). §10·§13과 충돌하면 §13.10 → §10.13 → 이 절 순으로 우선.

### 14.0 확인된 사실

| 항목 | 내용 | 출처 |
|---|---|---|
| 상품 | TradFi perp, 전 종목 cross margin, margin asset USDC, 스팟 없음. refdata 242종목 중 ACTIVE 213 (EQUITY 193 / INDEX 14 / COMMODITY 6), FX는 전부 INACTIVE·DELISTED | [L] `GET https://api.qfex.com/refdata`, [D] `/qfex/liquidation-margin-call` |
| 심볼 | `AAPL-USD`, `CL-USD`, `GOLD-USD`, `US100-USD`. **비-USD quote 존재**: `SKHYNIX-KRW`, `SIVE-SEK`, `ZHIPU-HKD`(+`ZHIPU-USD`), `CXMT-CNY`, `KIOXIA-JPY` | [L] |
| 호스트 (prod) | REST `https://api.qfex.com`, trade `wss://trade.qfex.com`, mds `wss://mds.qfex.com`, funding `https://banker.qfex.com` | [O], [A], [D] `/api-reference/programmatic-funding` |
| 호스트 (UAT) | REST `https://api.qfex.io`, trade `wss://trade.qfex.io/`, mds `wss://mds.qfex.io/`, funding `https://banker.qfex.io`. "Identical API and behaviour, separate exchange instance with no real funds" | CLI README "Environments", [D] programmatic-funding, [L] `api.qfex.io/refdata` 200 (39종목, ACTIVE 29) |
| 인증 | WS: `wss://trade.qfex.com?api_key=<public>` 접속 후 1분 내 `auth`. HMAC-SHA256(secret, `${nonce}:${unix_ts}`) hex, nonce hex ≤100자·15분 내 유일. REST: 헤더 4개 `x-qfex-public-key` / `x-qfex-hmac-signature` / `x-qfex-nonce` / `x-qfex-timestamp`(±5분), 서명 문자열 동일(메서드·경로·본문 미포함) | [D] `/websocket/channels/trade/authenticate`, [O] securitySchemes |
| 서브계정 | WS `params.account_id`, REST 헤더 `x-qfex-requested-account-id`. 생략 = primary | [D], [O] |
| 주문 | WS 전용. `add_order` `order_type ∈ LIMIT/MARKET/ALO/TAKE_PROFIT/STOP_LOSS`, `order_time_in_force ∈ GTC/IOC/FOK`. 조합: MARKET=IOC만, LIMIT=전부, ALO=GTC만, Stop=IOC | [A], [D] `/api-reference/enums`, `/qfex/order-types` |
| 응답 | `order_responses` 채널 구독 필수(2025-09-25 changelog). 요청 id 없음. `order_response`에 `order_id`, `client_order_id`, `status`, `quantity_remaining`, `trade_id` | [A], [D] `/websocket/changelog` |
| cancel-on-disconnect | **opt-in, 연결 단위**. 켜면 계정의 **모든** 주문이 끊길 때 취소 | [D] `/websocket/channels/trade/cancel_on_disconnect` |
| speed bump | limit 주문(신규·정정) 500 ms 대기. FAQ는 "cancels and liquidity-adding orders are not affected" | [D] `/qfex/architecture`, `/qfex/faq` |
| price band | 밴드 밖 buy(상단 초과)/sell(하단 미만)은 엔진 도달 전 거절. 폭은 세션별 가변(주식 5–10%, CME 3.3%, 금속 1.65–3.3%). refdata `min_price`/`max_price`가 현재 밴드 (AAPL 316.73–350.07 @ 333.4, 주말 ±5%) | [D] `/qfex/risk-limits`, [L] |
| funding | 60분마다, `market_hours` 안에서만, 밖은 0. interest 없음, `F_final = P̄(bps)/100`. pre-IPO는 24/7 funding | [D] `/qfex/funding`, `/qfex/pre-ipo-stocks` |
| rate limit | user 단위(연결·키 합산) 12,000 weight / 60 s EMA, general·cancel 버킷 분리. WS만 해당, REST는 "separate controls" | [D] `/websocket/rate` |
| 제한 지역 | US, UK, Spain, Ukraine, Syria, Iran, Russia, North Korea, Myanmar, Belarus, Venezuela, Sudan — "including but not limited to" | [D] `/qfex/faq` |
| API key | 웹사이트 Developer Settings(2FA). 계정 범위(특정 계정 / All accounts) + 권한 5종. **Deposit and withdraw는 All accounts 키만**. secret은 1회 표시 | [D] `/api-reference/api-keys` |
| 입출금 | USDC/Arbitrum One, USDT/TRON, USD 은행. primary 계정만 대상. `POST /withdraw`는 멱등 아님, 200 빈 본문 | [D] programmatic-funding |

**문서 내부 불일치** (구현 시 양쪽 다 받거나 라이브 확인):

| 항목 | 불일치 |
|---|---|
| `add_order`의 `reduce_only` | 예시에만 `"reduce_only": 0`, Python 샘플은 오타 `"resuce_only": True`, 파라미터 표·AsyncAPI에는 없음. `modify_order`는 bool로 명시 |
| 에러 프레임 | `/websocket/errors`는 `{"err": {...}}`, `/websocket/rate`는 `{"type":"Err","error_code":...}` |
| `set_user_leverage` 응답 | 문서는 `{"ack_response": true}`, AsyncAPI는 `{"ack": {incoming_message}}` |
| positions pulse | 본문 1 s, Note 10 s |
| `get_user_trades` 응답 키 | 문서 `user_trades`, AsyncAPI `user_trades_response` |
| max leverage | spec index CL 20×, refdata `default_max_leverage` 10 → **refdata가 SSOT** |

### 14.1 VenueDefinition (`src/exchanges/venues/qfex.ts`)

```ts
export const QFEX_ENDPOINTS: Readonly<Record<Network, { rest: string; tradeWs: string; mdsWs: string; banker: string }>> = {
  mainnet: { rest: "https://api.qfex.com", tradeWs: "wss://trade.qfex.com", mdsWs: "wss://mds.qfex.com", banker: "https://banker.qfex.com" },
  testnet: { rest: "https://api.qfex.io",  tradeWs: "wss://trade.qfex.io",  mdsWs: "wss://mds.qfex.io",  banker: "https://banker.qfex.io" },
};
export const QFEX_WITHDRAW_NETWORK = "arbitrum";   // banker network "ARBITRUM_ONE"
```

| 필드 | 값 | 근거 / 비고 |
|---|---|---|
| `id` / `aliases` / `displayName` | `"qfex"` / `["qf"]` / `"QFEX"` | |
| `family` | `"qfex"` | `venue.ts:168` union 확장 |
| `masterKeyKind` / `agentKeyKind` | `"none"` / `"hmac"` | 수탁형, 지갑 서명 경로 없음 |
| `secretStorage` | `{ kind: "perp-keystore", dir: "qfex-agents" }` | Rule #3 표에 추가 |
| `networks.mainnet` | `restUrl` api.qfex.com, `wsUrl` trade.qfex.com, `settlementChain: "offchain"`, `collateral: ["USDC"]`, 나머지 null | `VenueNetworkConfig`에 host가 2개뿐이라 mds·banker는 `QFEX_ENDPOINTS` |
| `networks.testnet` | 같은 형태의 UAT 값 (non-null) | 14.0 |
| `fundingRateBasis` / `settlementIntervalHours` | `{ kind: "perHours", hours: 1 }` / `1` | `/qfex/funding` |
| `roles` | `["marketData", "account", "trading"]` | |
| `capabilities.marketOrder` | `"native"` | 어댑터는 보호가 IOC LIMIT 전송 (14.3) — `venues/ondo.ts:72-75`와 같은 표기 |
| `capabilities.timeInForce` | `["GTC", "IOC", "FOK", "ALO"]` | ALO는 `order_type: "ALO"` + GTC |
| `capabilities.clientOrderId` | `true` | |
| `capabilities.orderAck` | `"async"` | ACK 후 체결·거절 이벤트가 따로 옴. clientOrderId 필수가 되어 상관키가 보장됨 (`trading-v2.ts:103`) |
| `capabilities.tpsl` | `"attached"` | `add_order.take_profit` / `stop_loss` |
| `capabilities.amend` | `"native"` | `modify_order` (order_id 변경, 부분 체결 주문 불가) |
| `capabilities.batchPlaceMax` | `null` | batch 메시지 없음 |
| `capabilities.marginModes` | `["cross"]` | |
| `capabilities.withdrawAssets` | `["USDC"]` | TRON USDT·USD 은행은 범위 밖 |
| `rateLimit` | `{ capacity: 100, refillPerSec: 50, weights: {...} }` | venue 한도 200/s의 25% (같은 user의 다른 프로세스·QFEX 웹·공식 CLI 몫). weights는 `/websocket/rate` 표 그대로 |
| `restrictedRegions` | `["US","GB","ES","UA","SY","IR","RU","KP","MM","BY","VE","SD"]` | 목록은 비한정 |
| `symbolIdentity` | `"explicit"` | crypto 마켓 없음 |
| `spot` | `null` | |
| `maxSlippageBps` | `1000` | 최대 밴드(주식 open 10%). 실제 상한은 주문별 밴드 사전 검증 |
| `builderFee` | `BUILDER_FEE_CAPABILITIES["qfex"]` | 14.7 |

- weights: `add_order` 1, `cancel_order` 1, `modify_order` 1, `get_order` 2, `get_user_orders` 5, `cancel_all_orders` 2, `get_user_trades` 0.5, `subscribe` 0.1, `unsubscribe` 0.1, `set_user_leverage` 0.1, `cancel_stop_order` 1, `modify_stop_order` 1.
- cancel 계열은 버킷 키 `qfex:<net>:cancel`, 나머지는 `qfex:<net>:ws`. 어떤 메시지가 cancel 버킷인지는 UNVERIFIED (Q14).
- REST 한도는 문서에 없음 → `qfex/client.ts`에 별도 보수 정책(`qfex:<net>:rest`, 5 req/s) 선언, UNVERIFIED 주석.

**funding의 market-hours-zero 규칙**
- venue가 준 rate를 그대로 싣는다. `market_hours`로 funding 활성 여부를 추론하지 않는다. refdata 세션(`pre_market`/`open`/`post_market`/`weekend`/`close`)과 문서의 funding 시간(주식 일 20:00–금 20:00 ET 연속)이 1:1 대응하지 않고, 야간 구간은 refdata에 항목이 없다 (Q9).
- `VenueMarket.session.underlyingOpen` = 현재 시각이 `session: "open"` 구간 안인지(`tz` 기준). `priceBand` = refdata `min_price`/`max_price`. `marginMultiplier` = null.
- 연율화 주의: 주식 funding은 주 약 120/168시간만 발생 → `hourly × 8760`은 과대. 14.8 참고.

**심볼·canonical**

| QFEX | CLI `symbol` | `assetClass` | canonical |
|---|---|---|---|
| `<T>-USD`, `product_category: EQUITY` | `<T>` | `equity` | ticker identity (Ondo·Arcus·Lighter RH·`hl:xyz`와 자동 매칭) |
| `<T>-<KRW/JPY/CNY/HKD/SEK>` | 접미사 유지 (`SKHYNIX-KRW`) | `equity` | **null** (현지통화 quote; `ZHIPU-HKD` vs `ZHIPU-USD` 충돌 방지) |
| pre-IPO (`ANTHROPIC-USD`, `OPENAI-USD`, …) | `<T>` | `preIpo` | null (10억 주 환산 규약이 venue 고유) |
| `GOLD-USD` / `SILVER-USD` | `GOLD` / `SILVER` | `commodity` | `"qfex\|GOLD": "GOLD"`, `"qfex\|SILVER": "SILVER"` |
| `CL-USD` | `CL` | `commodity` | `"qfex\|CL": "CRUDE_OIL_WTI"` (`hl:xyz\|CL`과 동일. 만기 선물 블렌드라 roll 주간 괴리 가능 → outlier 필터가 방어) |
| `US100-USD` / `US500-USD` | `US100` / `US500` | `index` | `"qfex\|US100": "NDX"`, `"qfex\|US500": "SPX"` |
| 그 외 INDEX·COMMODITY (`NATGAS`, `COPPER`, `URANIUM`, `KOSPI`, `NIKKEI`, `HSI`, `TAIEX`, `XLF`, `SOXL`, `UVXY`, …) | `<T>` | `index` / `commodity` | 매핑 없음 → null. 상대 venue 상품 확인 후 추가 |

- refdata에 pre-IPO 표시가 없다 → `qfex/public.ts`에 명시 목록 `QFEX_PRE_IPO`를 두고, 목록 범위는 Q12에서 확정.
- `product_category: EQUITY`에 ETF(`IBIT`, `TLT`, `RSP`, `SMH`)가 섞여 있지만 equity·etf 모두 ticker identity라 결과는 같다.

### 14.2 WebSocket 요청/응답 트랜스포트 (`src/exchanges/qfex/ws-transport.ts`)

**연결 순서 (one-shot)**
1. `new WebSocket("${tradeWs}?api_key=${publicKey}")` — public key만 URL에 실림(비밀 아님). connect 타임아웃 10 s.
2. auth 전송:
   ```json
   { "type": "auth", "params": { "hmac": { "public_key": "...", "nonce": "<32 hex>", "unix_ts": 1760545414, "signature": "<hex>" },
     "account_id": "<uuid, 선택>", "builder_code": "<uuid, 선택>" } }
   ```
   `{"authenticated": true}` 대기 10 s [A]. 실패 응답 형태는 UNVERIFIED (Q3) → err 프레임, close, 타임아웃 모두 "주문 미전송"(`orderNotSent`, 확정 실패).
3. `{ "type": "subscribe", "params": { "channels": ["order_responses", "fills", "stop_orders"] } }` → `{"subscribed": "<channel>"}` 3건 대기. 실패 = 미전송.
4. 명령 전송 → 상관 → venue-final 대기 → 5. `close(1000)`.

**응답 상관 (요청 id 없음)**

| 명령 | 상관 키 | 완료 조건 |
|---|---|---|
| `add_order` | `order_response.client_order_id === 우리 id`. 이후 같은 `order_id` | 14.3 표 |
| `cancel_order` (order_id) | `order_response.order_id` | `CANCELLED` / `NO_SUCH_ORDER` / `REJECTED` |
| `cancel_order` (client_order_id) | `client_order_id` (여러 건 가능) | 사전 `get_user_orders`로 대상 수 확정 후 그 수만큼 |
| `modify_order` | `client_order_id` (보존 여부 UNVERIFIED, Q5) | `MODIFIED`(**새 order_id**) / `CANNOT_MODIFY_*` |
| `cancel_stop_order` / `modify_stop_order` | `order_response.order_id === stop_order_id` | `CANCELLED` / `MODIFIED` |
| `cancel_all_orders` | 사전 조회한 order_id 집합 | 전부 `CANCELLED`, 또는 타임아웃 → 사후 `get_user_orders`로 판정 |
| `get_user_orders` / `get_order` | 프레임 키 `all_orders_response` | 첫 프레임 |
| 모든 명령 | `err.incoming_message` (요청 에코) | 에코의 `type` + `client_order_id`/`order_id` 일치 |

- 요청 id가 없어 **연결당 mutating 명령은 한 번에 하나**(FIFO 큐). 조회도 같은 큐.
- err 파서는 `{"err": {...}}`와 `{"type":"Err", ...}` 둘 다 수용.
- `incoming_message`가 없는 err가 mutating 명령 대기 중에 오면 그 명령의 응답으로 보되, 전송 후라면 결과 불명으로 처리.

**결과 불명 규칙** — `ws.send()` 콜백 성공을 "전송됨"의 경계로 삼는다.

| 상황 | 결과 |
|---|---|
| connect / auth / subscribe 실패, send 콜백 에러 | `orderNotSent` (확정 실패, 재시도는 호출자 판단) |
| 전송 후 상관된 `order_response` 없이 socket close 또는 타임아웃 | `ORDER_PENDING` (`orderOutcomeUnknown`), remediation `perp trade status c:<id> --symbol <S> -e qfex`. **재전송 금지** |
| 전송 후 `err.error_code === "ServerError"` | `ORDER_PENDING` (문서는 "safe to retry"지만 주문이 엔진에 들어갔는지 알 수 없음) |
| 전송 후 `RateLimited` / `InvalidJSONFormat` / `InvalidParameter` / `InvalidOrder` / `PermissionDenied` / `KycRequired` / `TncRequired` (에코 일치) | 확정 거절 |
| ACK 수신 후 final 전에 끊김 | `status: "accepted"`, `finality: "pending"` → `placeAndConfirm`이 `getOrderStatus`로 확정 |

- 불명 시 어댑터가 새 연결로 **조회만** 1회 한다: `get_user_orders(symbol)`에서 client id 매칭, 없으면 REST `GET /user/historic-orders?client_order_id=`. 둘 다 없으면 `ORDER_PENDING` 유지 — "없음 = 미접수"로 해석하지 않는다(speed bump·인덱싱 지연).

**타임아웃**

| 구간 | 값 |
|---|---|
| connect / auth / subscribe | 각 10 s |
| ACK | 5 s |
| IOC·FOK·시장가 final | 전송 후 10 s (500 ms speed bump 포함) |
| GTC·ALO resting 확인 | ACK 후 **1,200 ms**(500 ms + 여유) 동안 같은 `order_id`의 거절·체결 프레임이 없으면 `open` |
| terminal 후 fills 수집 | `Σfill.quantity === quantity − quantity_remaining`이 될 때까지 최대 1 s |

**cancel-on-disconnect 정책**
- 트랜스포트는 `cancel_on_disconnect` 메시지를 **어떤 경로로도 보내지 않는다**. 타입 화이트리스트에 넣지 않고 단위 테스트로 고정.
- 기본 off 라이브 확인은 Q1 (mainnet 전 차단 항목).
- 사용자의 다른 연결(공식 CLI `qfex account cod --enable` 등)이 켠 경우 그 연결이 끊기면 perp-cli 주문도 취소된다 → 문서에 경고.

**nonce·시계**
- nonce = `randomBytes(16).toString("hex")` (128 bit). 프로세스 간 조율 불필요, REST·WS 공용. 파일 락·카운터 없음.
- `unix_ts`는 초. REST 허용 ±5분, WS 허용폭 UNVERIFIED → 인증 실패 remediation에 "시스템 시계 확인".

**프로세스 내 재사용 (봇)**
- `QfexTradeSession`을 `(network, publicKey, accountId, builderCode)` 키로 프로세스당 1개 유지. `builder_code`는 연결 수명 동안 고정이라 `--no-builder`는 다른 세션이 된다.
- idle 시 socket을 `unref()` → 이벤트 루프가 비면 `beforeExit`에서 `close(1000)`. one-shot CLI도 같은 경로.
- 재연결 시 **보낸 명령을 재생하지 않는다**. 끊긴 순간 대기 중이던 mutating 명령은 전부 `ORDER_PENDING`.
- keepalive 요구사항 UNVERIFIED (Q15) → 장수 세션은 15 s 간격 ws ping.
- 한도는 user 합산이라 `acquireRate`는 프로세스 내 보호일 뿐 (`rate-limiter.ts:4-5`의 기존 제약과 같음).

**사전 검증 (전송 전, 확정 실패)**

| 검사 | 실패 시 |
|---|---|
| refdata `status !== "ACTIVE"` | `SYMBOL_NOT_FOUND` + status |
| limit 가격이 `tick_size` 배수 아님 | `INVALID_TICK` (반올림 안 함, §10.10) |
| 수량: `lot_size` 내림 후 0 또는 `< min_quantity` / `> max_quantity` | `SIZE_TOO_SMALL` / `SIZE_TOO_LARGE` |
| buy 가격 `> max_price` 또는 sell 가격 `< min_price` | `INVALID_PARAMS`, details `{ band: { lower, upper }, price }`. **clamp 금지** |
| 보호가가 밴드 밖 | `INVALID_PARAMS`, remediation "--slippage-bps를 줄이거나 limit 사용" |
| 가격·수량 문자열 유효숫자 > 15 | `INVALID_PARAMS` (wire가 JSON number) |

- 시장 시간: QFEX는 24/7 거래, 시간 외에는 밴드 축소 + 포지션 한도 50%/10% [D risk-limits]. 사전 차단하지 않고 venue 거절을 매핑: `REJECTED_MARKET_CLOSED` → `ORDER_REJECTED`, details `{ reason: "marketClosed" }` (확정).
- refdata 응답은 `Cache-Control`이 붙는다 [O]. 밴드의 실시간 원천은 MDS `minmax_price` → 신선도 Q13.

### 14.3 TradingV2 매핑 (`src/exchanges/qfex/adapter.ts`)

**시장가: 보호가 IOC LIMIT로 결정**
- native `MARKET`은 사용자 상한이 없고(밴드 3.3–10%까지 체결 가능) §13.2 "슬리피지 상한 내 즉시 체결"을 만족하지 못한다.
- 대가: LIMIT이라 500 ms speed bump를 받는다 → 그 사이 가격이 움직이면 미체결·부분 체결이 는다. 상한은 유지된다.
- 기준가(§13.10 #5, 출처 하나): **MDS `market_stats` 스냅샷의 mark** — `wss://mds.qfex.com`에 `{ "type": "subscribe", "channels": ["market_stats"], "symbols": ["*"] }`, 구독 즉시 최신 스냅샷이 온다 [D `/websocket/channels/mds/market_stats`]. 3 s 안에 해당 심볼 mark가 없으면 `PRICE_STALE`. index·last·mid 대체 금지.
- `execution = { method: "protectedIoc", slippageBps, slippageSource, protectionPrice, referencePrice: mark, tifSent: "IOC" }`.

| 연산 | wire |
|---|---|
| market | `add_order { order_type: "LIMIT", order_time_in_force: "IOC", price: alignProtectionPrice(mark ± bps), quantity, client_order_id }` |
| limit GTC / IOC / FOK | `order_type: "LIMIT"`, TIF 그대로 |
| limit ALO | `order_type: "ALO"`, `order_time_in_force: "GTC"`. 교차 시 venue가 거절·취소 → resting 확인 창에서 감지 |
| reduce-only | `reduce_only: true` (JSON boolean — Q2, production 2026-10-05) + 전송 전 규칙·ACK 에코 검사(§14.13 "Q2 해제"). **즉시 체결 TIF만**: 시장가(보호가 IOC)와 limit IOC. resting(GTC·ALO)·FOK는 `capabilities.reduceOnlyTif: ["IOC"]`로 전송 전에 거절(`QFEX_RESTING_REDUCE_ONLY_VERIFIED`) |
| attached TP/SL (`--tp/--sl`) | 같은 `add_order`에 `take_profit` / `stop_loss`. 미사용은 필드 생략(0 전송 여부는 Q2에서 함께 확인) |
| stop / `trade tpsl` | `add_order { order_type: "STOP_LOSS" \| "TAKE_PROFIT", order_time_in_force: "GTC"(읽히지 않음), price: <trigger>, quantity }` |
| amend | `modify_order { order_id, symbol, side, order_type, reduce_only, price, quantity }` |
| amend (stop) | `modify_stop_order { stop_order_id, symbol, side, order_type, price, quantity }` |
| cancel | `cancel_order { symbol, order_id: <값>, cancel_order_id_type: "order_id" \| "client_order_id" }` |
| cancel (stop) | `cancel_stop_order { stop_order_id }` |
| cancel-all | `cancel_all_orders { params: { symbol } }` 또는 `{ params: {} }` (전 종목) |
| close | reduce-only 보호가 IOC LIMIT (아래) |
| leverage | REST `POST /user/leverage { symbol, leverage }` |
| status | 아래 |

**stop·TP/SL**
- trigger는 mark 기준, 발동 시 market 전환(`STOP_MARKET`). 상한 없는 native 유지(§13.10 #3). `triggerSource`는 `"mark"`만, 그 외 `unsupported`.
- stop은 포지션 축소 전용("cannot exceed your current position") → `reduceOnly: false` stop과 `stopLimit`은 `unsupported(…, "openingStop" | "stopLimit", …)`.
- 타입 결정(기준가 = mark): 롱 청산(sell)은 trigger < mark → `STOP_LOSS`, > mark → `TAKE_PROFIT`. 숏 청산(buy)은 반대. trigger == mark → `INVALID_PARAMS`.
- 전송 전 포지션 조회 → 수량 ≤ |position|, side 반대 확인. 문서 경고: 초과 시 "다른 stop 주문이 취소될 수 있음".
- attached TP/SL로 생긴 stop 주문의 id 수령 경로는 UNVERIFIED (Q7).

**amend**
- **order_id가 바뀐다** → `OrderResult.orderId` = 새 id, `execution.notes`에 `replacedOrderId`. `method: "nativeAmend"`.
- `reduce_only` 일치가 필수(2026-09-09 breaking)인데 `order_response`에 그 필드가 없다 → perp-cli가 낸 주문은 **생성한 clientOrderId에 표식 인코딩**(§13.10 #11 Ondo 방식): reduce-only는 접두 `pr`, 아니면 `p`.
- 표식이 없는 주문(다른 클라이언트): `unsupported("qfex", "amend", "original order reduce_only unknown", "cancel 후 재주문")`. true/false를 번갈아 시도하지 않는다.
- 부분 체결 주문은 venue가 `CANNOT_MODIFY_PARTIAL_FILL` 거절 → 그대로 전파(`ORDER_REJECTED` + remediation). cancel+replace 자동 전환 없음.
- `size` = 새 미체결 수량(§13.10 #10). `modify_order.quantity`가 총수량인지 잔량인지 UNVERIFIED (Q5). 미체결 주문만 정정 가능하므로 실질 차이는 없다.
- 정정도 limit → 500 ms speed bump.

**cancel**
- ref가 일반 주문인지 stop인지 먼저 읽는다: `get_user_orders(symbol)`(weight 5)에서 `type ∈ {TAKE_PROFIT, STOP_LOSS}`면 `cancel_stop_order`, 아니면 `cancel_order`. "먼저 보내고 실패하면 다른 것" 방식은 쓰지 않는다.
- `client_order_id` 취소는 같은 id의 모든 주문을 취소 → perp-cli id는 유일하게 생성, 결과의 `cancelled[]`는 venue가 `CANCELLED`로 증명한 건만.
- cancel-all이 stop·TWAP도 지우는지 UNVERIFIED (Q8) → 사후 `get_user_orders`에 남은 stop은 `cancel_stop_order`로 개별 취소하고, 증명 안 된 건은 `pending[]`.

**close**
- native `close_position`은 쓰지 않는다: 엔진이 "mark 근처"로 가격을 정해 사용자 상한이 없고, changelog가 "only intended for use in the frontend"라고 적었다.
- REST `GET /user/positions`의 `position` 수량·부호로 reduce-only 보호가 IOC를 낸다. 부분 체결은 기존 `closePerpVerified` 경로.
- **안전장치 (2026-10-05 Q2 결과로 갱신, §14.13 "Q2 해제" 참조):** venue는 포지션보다 큰 reduce-only 주문을 접수 시점에 거절·cap하지 않는다. 그래서 어댑터가 모든 reduce-only 전송 직전에 직접 검사한다 — (a) `GET /user/positions`에 해당 심볼 포지션이 있다(없으면 `POSITION_NOT_FOUND`, 전송 안 함), (b) 주문 side가 포지션 반대, (c) 수량 ≤ |position| − (같은 심볼·같은 side의 다른 열린 LIMIT/ALO 주문 **전부**의 `quantity_remaining` 합 — reduce-only가 아닌 일반 주문도 포지션을 소진하므로 함께 센다), (d) 수량 ≥ `min_quantity`(단, 내림한 포지션 전량을 닫는 주문은 예외). reduce-only 주문은 즉시 체결 TIF(IOC)만 보낸다 — resting 주문은 접수 시점에만 검사되기 때문이다. 이 검사는 read-then-send라 읽은 뒤 포지션이 줄어드는 경우(speed bump 500 ms, 다른 프로세스, stop 트리거)는 막지 못한다 — 그 경우는 venue가 체결 시점에 cap해야 안전한데 이는 미검증이다(§14.12 #1의 지적은 이 잔여 위험으로 남는다).

**status (`getOrderStatus`)**
1. WS `get_user_orders(symbol)` → 열려 있으면 `open` / `partiallyFilled`. `get_order`는 order_id만 받고 열린 주문만 준다.
2. 없으면 REST `GET /user/historic-orders?symbol=&client_order_id=` → `terminal_status`, `filled_qty`, `avg_price`. orderId ref는 symbol + 시간창으로 받아 `order_id` 필터.
3. 둘 다 없으면 `ORDER_NOT_FOUND`. `awaitOrderFinal`이 ack와 함께 호출한 경우만 "아직 안 보임"으로 해석(`trading-v2.ts:188`).
- historic-orders 반영 지연과 `terminal_status` 값 집합은 UNVERIFIED (Q6).

**체결 집계 (venue 필드만)**
- `filledSize` = `fill_response.quantity` 합(같은 `order_id`, `trade_id`로 중복 제거). `avgPrice` = Σ(price×quantity)/Σquantity.
- terminal `order_response`의 `quantity − quantity_remaining`과 교차 확인. 불일치하면 `filledSize`는 order_response 값, `avgPrice: null`, `execution.notes`에 사유.
- wire가 JSON float → 수량은 `lot_size` 소수 자릿수, 가격은 `tick_size` 자릿수로 양자화해 문자열화(`qfex/signing.ts`의 `toWireNumber` / `fromWireNumber` 한 곳).

**상태 매핑**

| venue `status` | OrderResult |
|---|---|
| `ACK` | `accepted` (pending). GTC·ALO는 resting 창 통과 후 `open` |
| `FILLED`, `quantity_remaining == 0` | `filled`, final |
| `FILLED`, `quantity_remaining > 0` | `partiallyFilled` (IOC·FOK면 계속 대기) |
| `IOC_PARTIALLY_FILLED` | `partiallyFilled`, final |
| `IOC_CANCELLED`, 체결 0 | `ORDER_REJECTED` throw (§13.10 #4), details `{ reason: "iocNoFill" }` |
| `CANCELLED`, `CANCELLED_STP`, `EXPIRED` | `cancelled`, final (STP는 notes) |
| `MODIFIED` | `open`, 새 order_id |

**에러 매핑 (`src/exchanges/qfex/errors.ts`)** — order_response의 거절 status는 엔진 확정.

| venue | PerpError |
|---|---|
| `INVALID_PRICE`, `INVALID_QUANTITY`, `INVALID_ORDER_TYPE`, `INVALID_TIME_IN_FORCE`, `INVALID_TAKE_PROFIT_PRICE`, `INVALID_STOP_LOSS_PRICE`, `INVALID_CLIENT_ORDER_ID`, `INVALID_TICK_SIZE_PRECISION_QUANTITY`, `REJECTED_MUST_CHANGE_VALUE_MODIFY`, `NO_CHANGE_NO_UPDATE` | `INVALID_PARAMS` |
| `INVALID_TICK_SIZE_PRECISION_PRICE` | `INVALID_TICK` |
| `PRICE_LESS_THAN_MIN_PRICE`, `PRICE_GREATER_THAN_MAX_PRICE`, `REJECTED_GREATER_THAN_MAX_PRICE_BAND`, `REJECTED_LESS_THAN_MIN_PRICE_BAND` | `INVALID_PARAMS` (details.band) |
| `QUANTITY_LESS_THAN_MIN_QUANTITY`, `REJECTED_LESS_THAN_MIN_NOTIONAL` | `SIZE_TOO_SMALL` |
| `QUANTITY_GREATER_THAN_MAX_QUANTITY` | `SIZE_TOO_LARGE` |
| `BAD_SYMBOL` | `SYMBOL_NOT_FOUND` |
| `NOT_FOUND`, `NO_SUCH_ORDER`, `CANNOT_MODIFY_NO_SUCH_ORDER` | `ORDER_NOT_FOUND` |
| `CANNOT_MODIFY_PARTIAL_FILL`, `CANNOT_MODIFY_ALO_WOULD_CROSS`, `REJECTED`, `REJECTED_FAILED_TO_PROCESS`, `REJECTED_MARKET_CLOSED` | `ORDER_REJECTED` (details.venueStatus) |
| `FAILED_MARGIN_CHECK` | `MARGIN_INSUFFICIENT` |
| `REJECTED_WOULD_BREACH_MAX_POSITION`, `REJECTED_WOULD_BREACH_MAX_NOTIONAL`, `REJECTED_OPEN_INTEREST_LIMIT`, `REJECTED_TOTAL_OPEN_INTEREST_LIMIT`, `REJECTED_TOO_MANY_OPEN_ORDERS`, `USER_IN_LIQUIDATION` | `RISK_VIOLATION` |
| `PERMISSION_DENIED`, err `PermissionDenied` | `POLICY_DENIED` (remediation: 웹사이트에서 키 권한 확인) |
| `USER_NOT_FOUND` | `AGENT_NOT_REGISTERED` |
| err `KycRequired` / `TncRequired` | `POLICY_DENIED` (remediation: KYC / 약관 동의) |
| `RATE_LIMITED`, err `RateLimited` | `RATE_LIMITED` (메시지의 retry-after 파싱 → `retryAfterMs`. 자동 재전송 없음) |
| err `InvalidJSONFormat`, `InvalidParameter`, `InvalidOrder`, `InvalidOrderId` | `INVALID_PARAMS` |
| err `AlreadyAuthenticated` | `EXCHANGE_ERROR` (트랜스포트 버그) |
| err `ServerError` | mutating 전송 후면 `ORDER_PENDING`, 그 외 `EXCHANGE_ERROR` |
| REST 401 / 403 / 429 / 5xx | `SIGNATURE_FAILED` / `POLICY_DENIED` / `RATE_LIMITED` / `EXCHANGE_ERROR` (본문 `title`·`detail` 포함) |

### 14.4 계정 조회

| 조회 | 경로 | 필요 권한 |
|---|---|---|
| balance | REST `GET /user/positions`의 `balance`(`deposit`, `realised_pnl`, `unrealised_pnl`, `order_margin`, `position_margin`, `net_funding`, `available_balance`) + `GET /user/subaccounts/equity` | View balance |
| positions | REST `GET /user/positions`의 `positions[]`(`symbol`, `position`, `average_price`, `leverage`, `unrealised_pnl`, `initial_margin`, `maintenance_margin`, `net_funding`) | View positions |
| open orders (stop 포함) | **WS만** `get_user_orders { limit, offset, symbol? }` → `all_orders_response.orders[]` (stop은 `type: TAKE_PROFIT/STOP_LOSS`로 같은 배열) + `twaps[]` | View orders |
| order history | REST `GET /user/historic-orders` (limit ≤ 1000) | View orders |
| trades | REST `GET /user/trade` (`exchange_order_id`, `symbol`, `start`, `end`, limit ≤ 1000) | View orders |
| funding payments | REST `GET /executions?execution_type=<funding>&symbol=` (limit ≤ 100) | View balance (추정) |
| fees | REST `GET /user/fees` | View balance |

- 응답에 mark·청산가가 없다 → `ExchangePosition.liquidationPrice: null`. markPrice는 MDS 스냅샷.
- equity는 venue가 주는 값(`/user/subaccounts/equity`)만 쓴다. balance 필드로 직접 합산하지 않는다(산식 UNVERIFIED).
- `position`의 부호 규약, `execution_type` 값 집합, view-only 키의 trade WS 인증 가능 여부는 UNVERIFIED (Q10, Q11).
- 서브계정: REST는 `x-qfex-requested-account-id`, WS는 `account_id` — `QfexAgentMeta.accountId` 한 곳에서 주입.

### 14.5 키 온보딩

**결정: import만.** `wallet agent approve qfex` → `unsupported("qfex", "agentApprove", "API keys are created on the QFEX website (2FA)", "perp wallet agent import qfex")`.
- 프로그래매틱 생성(`POST https://verify.qfex.com/rest/v1/rpc/generate_api_key_v3`)은 SIWE 세션 + MFA 승격 토큰 + `QFEX_AUTH_CLIENT_KEY`가 필요하고, SIWE는 등록된 redirect URL의 domain·URI를 검증한다 [D `/api-reference/wallet-authentication`] → CLI가 쓸 경로가 아니다.

```ts
export interface QfexAgentMeta {
  kind: "qfex";
  agentName: string;
  publicKey: string;
  keystorePath: string;              // ~/.perp/qfex-agents/<publicKey>.json  { publicKey, secret }
  accountId: string | null;          // null = primary
  permissions: {                     // null = 확인 불가
    viewPositions: boolean | null; viewBalance: boolean | null; viewOrders: boolean | null;
    executeOrders: boolean | null; depositWithdraw: boolean | null;
  };
  network: "mainnet" | "testnet";
  approvedAt: string;
  source: "imported";
}
```

**`perp wallet agent import qfex [--name <n>] [--account-id <uuid>]`**
1. stdin 2줄(public key, secret) 또는 숨김 프롬프트 2회. argv·env 금지. `--account-id`는 비밀이 아니므로 플래그.
2. 형식 검사는 "공백 없음, 1–200자"만. `qfex_pub_…` / `qfex_secret_…` 접두는 문서 예시일 뿐 UNVERIFIED → 강제하지 않는다.
3. 검증 호출(전부 읽기):
   - REST `GET /user/positions` → 성공 시 `viewPositions`, `viewBalance` = true. 403이면 false, 401이면 `SIGNATURE_FAILED`로 중단.
   - REST `GET /user/trade?limit=1` → `viewOrders`.
   - `--account-id`가 있으면 REST `GET /user/subaccounts/balance`(`account_id`, `is_master`)에 그 id가 있는지 확인.
   - WS 접속 + `auth`(account_id 포함) → `{"authenticated": true}` 후 즉시 close. 주문·구독 없음.
4. `executeOrders`, `depositWithdraw`는 **null로 기록**. 주문 없이 확인할 방법이 없고, banker `GET /address`는 첫 호출에 주소를 발급하는 부작용이 있어 import 시 호출하지 않는다. 첫 사용에서 `POLICY_DENIED`가 나면 meta를 false로 갱신.
5. 전부 통과한 뒤에만 keystore 기록(`saveVenueSecret("qfex-agents", publicKey, …)`) → `setVenueAgent("qfex", meta)`.
- revoke = 로컬 keystore + meta 삭제만. 출력에 "키는 QFEX Developer Settings에서 revoke해야 무효화됨".
- 권장 구성: 거래용 키(계정 한정, withdraw 없음)와 입출금용 키(All accounts + Deposit and withdraw)를 따로 import. `funds … qfex`는 `--agent <name>`으로 선택.
- setup wizard (`src/commands/init.ts`): Ondo 분기(`:206-214`, `:285`, `:499-504`, `:541-544`, `:577`)에 qfex 추가.
  - 프롬프트: "QFEX public key (blank = skip)" → "QFEX secret (hidden)" → "Subaccount id (blank = primary)".
  - `--import-agents`의 stdin은 qfex 2줄(`agent-import.ts:131-141`).
  - 안내 문구: "No signature. Your QFEX API key is stored encrypted in ~/.perp/qfex-agents/ and checked with read-only requests."
  - `masterKeyKind: "none"` → 지갑·승인 단계 건너뜀(`init.ts:579`).

### 14.6 Funds

**deposit** — `perp funds deposit qfex [--network arbitrum]`
- banker `GET /address?network=ARBITRUM_ONE` → `{ address, network, asset }`.
- 응답이 `network === "ARBITRUM_ONE"` && `asset === "USDC"`가 아니면 `EXCHANGE_ERROR`로 주소를 보여주지 않는다(문서 경고: 다른 자산·네트워크 전송은 유실).
- 1단계는 **주소 표시만**. 송금은 사용자가 지갑·거래소에서 한다. `--dry-run`은 호출 없이 계획만 출력.
- 최소 입금액·confirmation 수는 API에 없다("Check the QFEX funding screen") → `null` 표시.
- TRON USDT는 `unsupported("qfex", "depositTron", …)`. USDT 입금이 USDC 증거금으로 어떻게 잡히는지 문서에 없다.

**withdraw** — `perp funds withdraw qfex <amount> --to <0x…> [--agent <name>]`
- banker `POST /withdraw { "amount": <number, gross>, "address": "<0x…>", "network": "ARBITRUM_ONE" }` → 200 빈 본문. `network`는 항상 명시.
- master 불필요: `masterKeyKind: "none"`, 키 권한이 전부. `--to` 필수(소유자 주소 개념 없음), EVM 주소 형식 검증.
- 사전 확인(읽기): `GET /user/subaccounts/balance`의 primary `available_balance ≥ amount`, 아니면 `INSUFFICIENT_BALANCE`.
- **멱등 아님** → 타임아웃·5xx·연결 끊김 = 결과 불명, 재시도 금지. remediation: `GET /executions`로 확인.
- 수수료는 gross에서 차감, 액수 미공개 → 결과에 `fee: null`. 성공 = "접수·차감"이지 온체인 완료가 아니다(수동 심사 가능).
- **안전 게이트 (신규, 결정 필요):** 문서에 출금 주소 화이트리스트·API 출금 MFA 언급이 없다(UNVERIFIED, Q17) → keystore가 유출되거나 에이전트가 오도되면 임의 주소로 출금된다.
  - `settings.withdraw.qfex = { allowlist: string[], maxPerTx: number }`. 키 부재 = 출금 거부(`POLICY_DENIED`, remediation `perp settings set …`).
  - `--to`가 allowlist에 없거나 amount > maxPerTx면 전송 전 거부. 출고 기본값 없음(Rule #2 "기본 off" 범주).
- 서브계정 잔고는 먼저 primary로 transfer.

**subaccount transfer** — REST `POST /user/transfer?src_account_id=<uuid>&dst_account_id=<uuid>` body `{ "amount": <number> }` → 204.
- 표면: `perp funds transfer <amount> <destination> -e qfex --from <primary|uuid>`. `primary`는 `GET /user/subaccounts/balance`의 `is_master` 행으로 해석. `--dry-run` 지원.
- 필요 권한·멱등성 UNVERIFIED (Q16) → 타임아웃은 결과 불명, 양쪽 잔고 조회로 확인.
- 서브계정 생성(`POST /user/subaccounts`)은 범위 밖.

### 14.7 Builder code

- QFEX builder code는 **수수료 분배**다: trader는 정상 수수료를 내고, venue가 그중 builder 몫(≤ 50%)을 builder 계정에 적립한다 [D `/qfex/builder-code`]. 사용자 추가 비용 0.
- 주문별이 아니라 **연결별**: `auth.params.builder_code`(UUID). 코드가 없거나 무효여도 주문은 정상, 에러 없음.
- 사용자 동의 절차 없음 → `approval: "none"`.

`builder-fee.ts` 변경:
```ts
feeKind: "exact" | "max" | "share";        // share = venue 수수료의 분배, 사용자 추가 비용 없음
qfex: { approval: "none", identity: "code", perpCapBps: 0, spotCapBps: null, hip3: null, testnet: false,
        feeStepBps: 0, feeKind: "share", docs: "https://docs.qfex.com/qfex/builder-code" },
```
- `settings.builder.qfex = { code: "<uuid v4>" }`. `feeBps` 키는 받지 않는다 → `parseBuilderEntry`(`builder-fee.ts:149-184`)에 `feeKind === "share"` 분기(UUID 정규식, feeBps 금지).
- 기본 off 유지: settings 키 부재 = 코드 미전송. 출고 코드·env 없음.
- `resolveBuilderGate("qfex", ctx, …, null, () => "")` → gate가 있으면 세션 auth에 코드 포함. `--no-builder`는 코드 없는 별도 세션.
- `execution.builderFee = { identity: <uuid>, feeBps: 0, feeKind: "share", approvedMaxBps: null }` + notes "attribution is not confirmable from the trader side".
- `testnet: false`: prod 계정에서 만든 UUID를 UAT에 보내는 것은 의미가 없다.
- `wallet builder approve qfex`는 "no approval step" 안내(`src/commands/builder.ts:48`).
- perp-cli 자신의 builder code 생성(`POST /user/builder-code`)은 범위 밖.

### 14.8 Public 데이터 (`src/exchanges/qfex/public.ts`)

| 용도 | 경로 | 필드 |
|---|---|---|
| 마켓 정적 정보 | REST `GET /refdata` | `symbol`, `status`, `product_category`, `tick_size`, `lot_size`, `min_quantity`, `max_quantity`, `min_price`, `max_price`, `default_max_leverage`, `market_hours`, `quote_asset`, `margin_asset` |
| funding·OI·거래량 | REST `GET /md/contracts` | `ticker_id`, `last_price`, `index_price`, `funding_rate`, `next_funding_rate`, `next_funding_rate_timestamp`, `open_interest`, `open_interest_usd`, `base_volume`, `target_volume` |
| mark | MDS WS `market_stats` 스냅샷 (`symbols: ["*"]`) | `mark_prices[].price`, `bbos[]` |
| orderbook | REST `GET /md/orderbook/{ticker_id}` | `bids`, `asks` (수량 0 레벨 포함 → 필터) |
| funding history | REST `GET /funding/{symbol}?intervalMinutes=60&fromISO=&toISO=` | `data[].windowStart`, `rate` |
| klines | REST `GET /candles/{symbol}` | |

- `VenueMarket`: `tickSize` = `tick_size`, `stepSize` = `lot_size`, `minSize` = `min_quantity`, `minNotional: null`(미공개), `maxLeverage` = `default_max_leverage`, `marginTiers: null`, `tradable` = `status === "ACTIVE"`, `settle: "USDC"`.
- `fetchFundingRates`: `rate` = `funding_rate`, `nextFundingTime` = `next_funding_rate_timestamp × 1000`, `markPrice` = MDS mark. mark를 못 받으면 fetch 전체를 throw → `exchangeStatus: "error"`. index·last로 대체하지 않는다.
- **funding rate 단위 UNVERIFIED (Q4, arb 포함의 차단 항목).** `F_final = P̄(bps)/100`은 "퍼센트 표기"와 "1/100 감쇠 후 분수" 두 해석이 가능하다. [L] `GET /funding/AAPL-USD` 값 `0.00000149`/h는 분수라면 연 1.3%로 그럴듯하나 추정이다. 확인 전까지 qfex는 `funding` 조회에는 싣되 **`arb scan` 순위에서 제외**(opt-in `--include-unverified`).
- arb scan:
  - outlier: 기존 `dropPriceOutliers`(`rates.ts:158`)가 그대로 적용. `US100`·`CL`·pre-IPO의 가격 규약 차이를 걸러낸다.
  - market hours: `session.underlyingOpen === false`면 스캔 행에 "funding inactive (QFEX market hours)" 표기, rate 0을 지속 수익으로 연율화하지 않는다.
  - 연율화: 주식 funding은 주 약 120시간만 발생 → `hourly × 8760`은 약 40% 과대. 1단계는 경고 표기만, 2단계는 `VenueMarket.session`에 `fundingHoursPerWeek: number | null` 추가(타입 변경, 별도 승인).
- `MARK_PRICE_PREFERENCE`(`rates.ts:68-70`) 끝에 `"qfex"` 추가.

### 14.9 E2E 러너 프로필 (`scripts/e2e/venues.ts`)

```ts
qfex: {
  id: "qfex", cliVenue: "qfex", hip3: null,
  symbols: { mainnet: ["SILVER", "AAPL", "GOLD"], testnet: ["CL", "AAPL", "GOLD"] },   // 러너가 refdata 최소 notional로 선택
  minNotionalFallback: { usd: 10, source: "assumed — refdata publishes min_quantity only; REJECTED_LESS_THAN_MIN_NOTIONAL exists but the threshold is unpublished" },
  testnetEnv: null,
  prerequisites: {
    testnet: ["UAT account at qfex.io + API key (Execute orders, View orders/positions/balance)",
              "printf '%s\\n%s\\n' \"$PUB\" \"$SECRET\" | perp -n testnet wallet agent import qfex",
              "UAT funds: UNVERIFIED how they are issued (banker.qfex.io / UAT UI)"],
    mainnet: ["QFEX account (KYC; not US/UK/ES/…), 2FA, API key created in Developer Settings",
              "$20 USDC on Arbitrum One → deposit address from `perp funds deposit qfex`"],
  },
  deposit:  { mainnet: { kind: "manual", instructions: ["perp funds deposit qfex → send USDC on Arbitrum One to the printed address"] },
              testnet: { kind: "none", reason: "UAT funding route undocumented" } },
  withdraw: { mainnet: { kind: "manual", instructions: ["perp funds withdraw qfex <amount> --to <allowlisted address> (--dry-run first)"] },
              testnet: { kind: "manual", instructions: ["perp -n testnet funds withdraw qfex <amount> --to <address>"] } },
  spotSymbol: { mainnet: null, testnet: null },
}
```
- [L] 최소 주문 notional(2026-10-04): SILVER 0.001 × 60.5 = $0.06, AAPL 0.01 × 333 = $3.3, GOLD 0.001 × 4,144 = $4.1, US500 0.001 × 7,720 = $7.7, US100 0.001 × 30,800 = $30.8. $20 계정이면 10–20× 레버리지로 $10 notional 테스트에 충분.
- 단계: public → import → balance/positions → leverage → limit GTC(**밴드 안**, `min_price` + 1 tick) → status → amend(새 order_id) → cancel → ALO → market(보호가 IOC) → attached TP/SL → stop → close → cancel-all → **disconnect 후 주문 유지** → trades/funding 조회 → subaccount transfer → deposit address → withdraw. spot 단계 없음.
- 순서: **UAT 전 단계 → mainnet $20**. Q1·Q2는 UAT에서만 먼저 확인.
- `scripts/e2e/venues.ts`·`run.ts`·`docs/TEST-PLAN.md`는 다른 세션이 편집 중일 수 있음 → 병합 조율.

### 14.10 라이브로만 확인 가능한 항목 (`DESIGN_ITEMS` 키 `Q1`…)

| # | 확인 내용 | 차단 수준 |
|---|---|---|
| Q1 | GTC 주문을 내고 socket을 닫아도(정상 close + 강제 종료) 주문이 남는가 (cancel-on-disconnect 기본 off). **부분 확인 (production 2026-10-05):** 정상 socket close 후에도 GTC 주문이 남았다(한 CLI 프로세스가 낸 주문을 새 프로세스가 조회). **강제 종료(kill) 변형은 미검증.** | **mainnet 전 차단** (kill 변형 남음) |
| Q2 | `add_order.reduce_only`의 wire 타입(bool vs 0/1), 생략 시 기본값, 반대 방향 초과 수량 처리. `take_profit`/`stop_loss` 생략 vs 0. **확인 (production 2026-10-05, primary 계정, GOLD-USD, long 0.003):** ① wire = JSON boolean — `"reduce_only": true` SELL LIMIT GTC 4280, 수량 0.006 → `{"status":"ACK","quantity":0.006,"quantity_remaining":0.006,"reduce_only":true,"order_origin":"PORT",…}`; 모든 `order_response`(일반 주문 포함)가 `reduce_only`를 boolean으로 싣는다. ② 포지션 없음 → 같은 프레임(수량 0.003)이 `INVALID_QUANTITY`로 거절(강제됨). ③ **포지션(0.003)보다 큰 0.006은 접수 시 거절·cap되지 않고 전량 0.006으로 resting**(`account orders`에 표시, 이후 취소). **미검증:** 초과 주문이 체결 시점에 cap되는지, 포지션이 줄거나 닫힌 뒤 resting reduce-only 주문의 동작, 생략 시 기본값, `take_profit`/`stop_loss` 생략 vs 0. 문서(docs.qfex.com, 2026-10-05 재확인): add_order 파라미터 표에 `reduce_only` 없음, 샘플만 `"reduce_only": true  // Optional`(Node·Go) / `"resuce_only": True # Optional`(Python 오타), `/qfex/order-types`·`/qfex/faq`에 reduce-only 언급 없음. → 게이트 해제 + 어댑터 전송 전 규칙(§14.3 안전장치). | 해제 (체결 시 cap 여부는 잔여 미검증) |
| Q3 | auth 성공·실패 프레임 형태, WS timestamp 허용폭, 1분 미인증 시 close code | |
| Q4 | `funding_rate` 단위: `/executions` funding 금액 ÷ (포지션 notional) 대조 | **arb 포함 차단** |
| Q5 | `modify_order`: `client_order_id` 보존 여부, `quantity`가 총수량인지 잔량인지, 응답 순서. **확인 (production 2026-10-12, GOLD-USD):** resting BUY LIMIT 4050 → `modify_order {order_id, symbol, side, order_type, quantity, price:4060, reduce_only:false}` → `order_response` MODIFIED, **새 order_id**(8e4a…, 이전 c563…), **같은 `client_order_id`**. resting reduce-only 주문을 flat 상태에서 교차 가격 4120으로 modify → `INVALID_QUANTITY`(거절, 주문 그대로, 포지션 안 열림). `quantity` 총량/잔량·TP/SL 보존은 미검증 | 해제 (`QFEX_MODIFY_KEEPS_CLIENT_ID = true`) |
| Q6 | `/user/historic-orders` 반영 지연, `terminal_status` / `execution_state` 값 집합 | |
| Q7 | attached TP/SL로 생긴 stop 주문의 id 수령 경로(`stop_orders` 채널 프레임 형태), 진입 미체결 시 동작 | |
| Q8 | `cancel_all_orders`가 stop·TWAP도 취소하는가, 완료 신호 유무 | |
| Q9 | refdata `market_hours`와 실제 funding 활성 구간의 대응(야간 구간, `close` 세션, CL·US100 16–17 CT 정지 시 거래 가능 여부) | |
| Q10 | `PositionPublic.position` 부호, `/executions`의 `execution_type` 값, 서브계정 헤더 동작 | |
| Q11 | view-only 키로 trade WS auth·`get_user_orders` 가능한가, 계정 한정 키로 `/user/subaccounts/balance` 호출 결과 | |
| Q12 | pre-IPO 종목 목록(`ANTHROPIC`, `OPENAI` 외), `PURR-USD`·`USDE-USD` 등의 실제 기초자산 | |
| Q13 | refdata `min_price`/`max_price` 갱신 주기(Cache-Control) vs MDS `minmax_price` | |
| Q14 | speed bump 중 ACK 시점과 `get_user_orders` 노출 시점, LIMIT IOC도 500 ms 대기하는지, cancel 버킷 소속 메시지 | |
| Q15 | idle 연결 유지 요구사항(ping), 동시 연결 수 제한 | |
| Q16 | `/user/transfer`·`/user/leverage` 필요 권한, 멱등성 | |
| Q17 | API 키 출금에 주소 화이트리스트·MFA·수동 심사가 걸리는가, 최소 출금액·수수료 | |
| Q18 | `client_order_id` 허용 형식·길이(`INVALID_CLIENT_ORDER_ID` 조건) | |
| Q19 | UAT 상태: `mds.qfex.io` 503, `api.qfex.io/md/contracts` 500 (2026-10-04) — UAT에서 mark 조회 가능 여부 | UAT E2E 차단 가능 |

### 14.11 파일 계획

**신규**

| 파일 | 내용 |
|---|---|
| `src/exchanges/venues/qfex.ts` | 정의, `QFEX_ENDPOINTS`, `QFEX_WITHDRAW_NETWORK`, lazy `create` |
| `src/exchanges/qfex/signing.ts` | nonce, HMAC, REST 헤더·WS auth payload, `toWireNumber` / `fromWireNumber` |
| `src/exchanges/qfex/client.ts` | REST 클라이언트(api + banker), rate 버킷, problem+json 파싱 |
| `src/exchanges/qfex/ws-transport.ts` | `QfexTradeSession`(connect·auth·subscribe·FIFO·상관·타임아웃·idle close), MDS one-shot 스냅샷 |
| `src/exchanges/qfex/errors.ts` | status·err → PerpError 표, 확정/불명 분류 |
| `src/exchanges/qfex/public.ts` | `fetchMarkets` / `fetchFundingRates`, `market_hours` → session, `QFEX_PRE_IPO` |
| `src/exchanges/qfex/agent.ts` | `importQfexAgent`, `loadQfexCredentials`, `revokeQfexAgentLocal` |
| `src/exchanges/qfex/adapter.ts` | `TradingV2` + legacy shim(§10.7), `withdraw`, `transfer`, `depositAddress` |
| `src/__tests__/exchanges/qfex-*.test.ts` | signing 벡터, 트랜스포트(프로세스 내 `ws` 서버 fake), 에러 매핑, public fixture, adapter 매핑 |

**수정**

| 파일 | 변경 |
|---|---|
| `src/exchanges/venue-types.ts:12-21` | `VenueId`, `VENUE_IDS`에 `"qfex"` |
| `src/exchanges/venue.ts:168` | `family` union에 `"qfex"` |
| `src/exchanges/venues/index.ts:15-32` | import·`ALL_VENUES`·export |
| `src/exchanges/builder-fee.ts:51-92, 125-130, 149-184` | `feeKind: "share"`, `qfex` 항목, `BuilderSettings.qfex`, UUID 파싱 분기 |
| `src/exchanges/canonical-symbols.ts:44-61` | `qfex\|GOLD`, `qfex\|SILVER`, `qfex\|CL`, `qfex\|US100`, `qfex\|US500` |
| `src/settings.ts:114-156` | `QfexAgentMeta`, `AnyAgentMeta`, `AgentsByExchange.qfex`, `withdraw.qfex` 스키마·파서 |
| `src/agent-wallet/store.ts:108, 159, 271, 316-319` | `NON_LEGACY_AGENT_VENUES`, `agentSourceOf`, `VenueAgentMap`, `listVenueAgents` |
| `src/config.ts:137, 156` | qfex agent 조회 분기 |
| `src/commands/agent-import.ts:49, 126-159, 291-323, 690-727` | `ImportSecret` qfex 변형, 2줄 stdin, `importQfex`, 삭제 |
| `src/commands/agent.ts:467-470, 525, 549, 583-644, 750, 822` | verify·기본 이름·approve 미지원 응답·도움말 |
| `src/commands/init.ts:206-214, 285, 469, 499-504, 541-544, 577, 856-861, 991-1028` | wizard 프롬프트·안내·non-interactive stdin |
| `src/commands/funds.ts:63, 139 이후, 992-1060, 1090, 1137` | `withdrawChainOf` 일반화, `deposit qfex`, withdraw 루프에 qfex + 게이트, transfer 라우팅, info 표 |
| `src/commands/trade.ts:67, 679-680, 768, 1214, 1543` | `V2_CLIENT_ID_RULES.qfex`(Q18 후 확정), 도움말의 "(ondo/arcus)" |
| `src/commands/builder.ts:48` | qfex = 승인 단계 없음 |
| `src/funding/rates.ts:68-70` | `MARK_PRICE_PREFERENCE`, 미검증 venue 제외 플래그 |
| `scripts/e2e/venues.ts:12-14, 48, 228`, `scripts/e2e/run.ts:445-459` | 프로필, `DESIGN_ITEMS` Q1–Q19, 단계 매핑 |
| `docs/SSOT_RULES.md:48-56` | Rule #3 표에 `~/.perp/qfex-agents/<publicKey>.json` |
| `docs/DESIGN-venue-abstraction.md`, `docs/TEST-PLAN.md`, `README.md`, `skills/perp-cli/references/*`, `CHANGELOG.md` | 이 절, 테스트 항목, 사용법 |
| 기존 테스트 | `builder-fee.test.ts`, `agent-import.test.ts`, `setup-wizard.test.ts`, `funds-merge.test.ts`, `market-public-adapter.test.ts`, `wallet-builder.test.ts` (모든 venue 순회 단언) |

**위험**

| 위험 | 대응 |
|---|---|
| `reduce_only` 형식 오류로 청산 주문이 신규 진입이 됨 | 전송 전 포지션·수량 검사(14.3), Q2 UAT 선확인 |
| 요청 id 없는 프로토콜에서 응답 오귀속 | 연결당 mutating 1건, client id 유일 생성, 에코 일치 검사 |
| 문서와 실제 프레임 불일치(14.0 표) | 파서는 양쪽 형태 수용, 미지 프레임은 무시하지 않고 로그 + 대기 지속 |
| float wire로 인한 수량·가격 오차 | 유효숫자 15 제한, tick·lot 양자화 한 곳 |
| 출금 키 유출 | allowlist + maxPerTx 게이트, 거래·출금 키 분리 권장 |
| funding 단위 100배 오류 | Q4 전 arb 순위 제외 |
| 프로세스가 socket 때문에 종료되지 않음 | idle `unref` + `beforeExit` close, 테스트로 고정 |
| `VenueId` 추가로 인한 exhaustive switch 누락 | `tsc --noEmit`가 `[K in VenueId]` 표를 드러냄. `=== "ondo"` 분기는 수동 grep |

### 14.12 Critic 리뷰 반영 (2026-10-04, **이 절이 §14.0–14.11보다 우선**)

> 독립 critic 판정: APPROVE WITH REQUIRED EDITS. 아래 필수 수정 1–14는 §14.0–14.11의 해당 내용을 대체한다. 충돌 시 이 절을 따른다.

#### 필수 수정 (REQUIRED edits)

**1. Reduce-only: the "safety net" is not one (§14.3 close, risk table row 1).**
- **Wrong:** "플래그가 무시돼도 포지션이 뒤집히지 않는다" is false. The check is read-then-send across a 500 ms speed bump.
- **Evidence:** the `add_order` parameter table and AsyncAPI have no `reduce_only`. The Python sample sends the typo `"resuce_only": True` with no error noted, which suggests unknown or mistyped fields are silently ignored.
- **Scenario:** long 1 AAPL with a resting SL. The user or `closePerpVerified` reads position = 1 and sends a "reduce-only" sell of 1. The SL triggers during the speed bump, the flag was ignored, and the account is now short 1. The same happens with a second process or the web UI.
- **Change:**
  - Delete that sentence.
  - Hard-gate in code: while the wire format constant is unset, every `reduceOnly: true` path throws `unsupported("qfex","reduceOnly",…)`. This covers close, the `closePerpVerified` shim, stops, and the bot shim.
  - Q2 acceptance must prove venue enforcement on UAT: a reduce-only order with qty > position, and one with no position, must be rejected or capped.
  - Promote Q10 (the sign of `position`; `PositionPublic` has no side field) to a mainnet blocker. A misread sign doubles the position on close.

**2. `open` inferred from 1,200 ms of silence (§14.2 timeouts, §14.3 status table).**
- **Wrong:** this violates §10.10 (`open` means resting is confirmed) and §13.1 #4. ACK timing relative to the speed bump is unknown (Q14).
- **Scenario:** an ALO or GTC order gets ACK, then `CANCELLED_STP`, `FAILED_MARGIN_CHECK` or an ALO-cross rejection arrives at 1.3 s. The CLI has already printed `open`/final and closed the socket, so a grid bot or user believes a protective order rests.
- **Change:** GTC/ALO return `status:"accepted", finality:"pending"` after ACK. `open` is set only from a `get_user_orders` row; the existing `placeAndConfirm → awaitOrderFinal(untilResting)` in `src/exchanges/trading-v2.ts:228-258` already does this. Remove the 1,200 ms row.

**3. IOC/FOK finality contradicts the official CLI README, which §14 cites.**
- **Evidence:** README "Order response lifecycle": IOC returns "`FILLED` with `quantity_remaining > 0` if partial, or `CANCELLED` if nothing was filled at all". It never mentions `IOC_PARTIALLY_FILLED` or `IOC_CANCELLED`.
- **Scenario A:** a partial IOC emits `FILLED rem>0` and nothing else. The design "keeps waiting" for 10 s, and the post-ACK timeout outcome is undefined in the table.
- **Scenario B:** a zero-fill IOC emits `CANCELLED`. The design reports `cancelled` instead of `ORDER_REJECTED {iocNoFill}` (§13.10 #4), so bot legs take a different branch.
- **Change:**
  - Any IOC/FOK terminal frame with zero fill, whether `IOC_CANCELLED` or `CANCELLED`, maps to `ORDER_REJECTED iocNoFill`.
  - Add a table row: post-ACK timeout with or without partial `FILLED` frames returns `partiallyFilled`/`accepted` with `finality:"pending"`. It becomes final only when `get_user_orders` shows the order absent and `historic-orders` shows a terminal row.
  - State that `iocOutcomeOf()` returns non-null only when a venue terminal frame was received.
  - Add Q20: the exact IOC/FOK frame sequence for full, partial, and no fill.

**4. Correlation gaps (§14.2 table).** Client-id matching is sufficient for `add_order` of normal orders only. The gaps:
- **(a) modify:** the docs say "`client_order_id` cannot be used for modifies", and the MODIFIED example has `client_order_id: ""` and a new `order_id` with no link to the old one.
  - Scenario: two processes amend two orders on one symbol. Each sees two MODIFIED frames, adopts the wrong new id, and a later cancel hits the other order.
  - Change: correlate MODIFIED on client id plus symbol/side/type/price/quantity equal to the request. If Q5 shows the id is not preserved, set `capabilities.amend` to unsupported; no best-effort.
- **(b) stop orders:** the stop `add_order` parameter table has no `client_order_id`. Add Q21 for echo on stop ACKs. Without an echo, stop placement must return `ORDER_PENDING` and reconcile via `get_user_orders`, never match on symbol/qty.
- **(c) user-supplied `--client-id`:** allowed via `V2_CLIENT_ID_RULES` (`src/commands/trade.ts:65`), but QFEX ids are "not guaranteed unique".
  - Scenario: an old resting order with the same id fills during the wait and is attributed to the new order. Cancel-by-client-id also kills both.
  - Change: qfex rejects user ids (generated only), or requires zero open orders with that id. In either case, ignore frames until an ACK or reject for this request, then pin to `order_id`.
- **(d) session reuse:** after any timeout or unknown outcome, destroy the session so late frames cannot meet the next command.
- **(e) "sent" boundary:** `readyState !== OPEN` before `send()` is `orderNotSent`. Any error after `send()` is called is `ORDER_PENDING`, because a retry duplicates the order.
- **(f) legacy shim:** state that `marketOrder`/`limitOrder`/`stopOrder` generate the client id. The Ondo shim passes `clientOrderId: null` (`src/exchanges/ondo/adapter.ts:855`), and `orderAck:"async"` rejects that.

**5. Attached TP/SL and amend.**
- **Wrong (attached):** Q7 is not a blocker, yet `tpsl:"attached"` ships. The stop quantity on a partial or zero-fill entry is unknown, and the docs warn that an oversize stop "could cause your order to be rejected or other stop orders to be cancelled".
  - Scenario: an IOC entry fills 30%. The venue stages the SL for 100%, which cancels the user's other stops. Or a zero-fill leaves an orphan stop that fires on a later position.
  - Change: declare `tpsl:"separateOrders"` (entry verified, then reduce-only stops sized to the fill, per §13.5) until Q7 passes. After Q7, reconcile stops via `get_user_orders` on every entry; a mismatch is `ORDER_PARTIAL`.
- **Wrong (amend):** `modify_order` documents `take_profit`/`stop_loss` as "Set `0` if unused", and the design's wire omits them.
  - Scenario: amending the price of an order with attached TP/SL silently strips protection.
  - Change: amend re-sends the order's current `take_profit`/`stop_loss` from `get_user_orders`. Add omit-versus-preserve to Q5.
- **Stop type:** for `--tp`/`--sl` and `trade tpsl`, the type comes from user intent and is validated against mark (§13.10 #12). Inference from mark applies only to bare `trade stop`.

**6. Funding exclusion covers only `arb scan`.**
- **Evidence:** bots read `m.fundingRate` from `adapter.getMarkets()` (`src/bot/strategies/funding-auto.ts:214`, `funding-arb-v2.ts:102`) and match by ticker, not canonical, with no outlier filter. `fetchAllFundingRates` also feeds MCP `get_funding_rates`/`arb_scan` (`src/mcp-server.ts:271,1299,2115`), alerts (`src/commands/alerts.ts:336`), the dashboard, and portfolio.
- **Scenario:** `bot funding-auto` with qfex plus another venue opens a hedge on a rate that may be 100× off, or on the weekend 0. It can also pair QFEX `OPENAI`/`US100`/`CL` with a same-ticker, different-convention contract, leaving the notional unhedged.
- **Change:**
  - Add one venue flag, e.g. `fundingVerified: false`.
  - `fetchVenuesRates` drops such venues unless `includeUnverified` is passed; only `funding`/`arb scan --include-unverified` pass it.
  - Until Q4, `QfexAdapter.getVenueMarkets()` returns `fundingRate: null`, so the legacy shim gives bots NaN.
  - `arb-auto` and bot strategy construction reject qfex as a leg with `unsupported(…,"fundingArb",…)`.
  - Q4 must also decide `funding_rate` versus `next_funding_rate`; both exist, and live values differ (OPENAI −4e-8 vs +1e-8).
  - Inclusion later requires the 120/168 annualization fix first, not a warning.

**7. Non-USD quote symbols are tradable with USD-assuming code.**
- **Evidence:** live refdata has 9 active KRW/JPY/CNY/SEK markets, e.g. SKHYNIX-KRW at 1,841,400.
- **Scenario:** `--usd` sizing, risk-limit notional, portfolio, and min-notional all compute `size × price` as USD. The result is a 1,400× mis-sized order or a nonsensical risk check.
- **Change:** in phase 1, `tradable:false` for `quote_asset !== "USD"`, and orders fail with `unsupported("qfex","nonUsdQuote",…)`. Record `quote_asset` on the market. Also validate each order against per-symbol `order_types` and `order_time_in_force` from refdata.

**8. Withdraw gate.**
- **Wrong:**
  - It sits in `funds.ts`, leaving `adapter.withdraw()` ungated for any future caller.
  - It is QFEX-only, while Ondo has the same API-key-plus-arbitrary-`--to` shape with no gate (`src/commands/funds.ts:993-1050`).
  - It does not stop the threat it cites: a misled agent can run `perp settings set withdraw.qfex…` and then withdraw.
- **Change:**
  - Enforce inside `QfexAdapter.withdraw()`.
  - Define it as `settings.withdraw.<venue>` for API-key-authority venues: qfex now, ondo listed as a follow-up.
  - Allowlist mutation requires an interactive TTY confirmation and is refused under `--json`, non-TTY, MCP, and jobs.
  - Add `maxPerDay`, to match `max_daily_withdraw_usd` in `src/guardrail/perp-guardrail.ts`.
  - State plainly that the gate is not a defence against key theft; the defence is a trading key without the withdraw permission.
  - Pre-check against the documented Withdrawable Balance (`Cash + realised + min(unrealised,0) − 1.05×Margin`), or drop the pre-check. `available_balance` is the wrong quantity.
  - Banker 401 maps to `POLICY_DENIED`/`SIGNATURE_FAILED` by body; the docs say 401 can mean "terms not accepted". A 400 is a definite failure.
- **Already fine:** there is no MCP, plan-executor, or bot withdraw path today, and rebalance throws for unknown venues.

**9. Key import does not bind the key to an account.**
- **Wrong:** `accountId: null` is stored for "primary", and nothing records which account the venue resolved.
- **Scenario:** a subaccount-scoped key is imported without `--account-id`, or an "All accounts" key silently trades primary instead of the intended subaccount.
- **Change:**
  - Import resolves and stores the concrete account UUID (the `is_master` row, or the given id). Never store null.
  - Print it and require confirmation.
  - Assert `order_response.user_id` against the expected id on every correlated frame (Q22: is `user_id` the account or the user?). A mismatch is `ORDER_PENDING` plus an alarm.
  - The adapter refuses when `meta.network !== ctx.network`, matching the Ondo meta comment at `src/settings.ts:120`.
  - `permissions.*` is informational only. Never write `false` from a runtime `POLICY_DENIED`; it may be KYC, terms, region, or scope, and a cached false becomes a hidden gate.

**10. Reference price and metadata coupling.**
- **Wrong (staleness):** only "mark present within 3 s" is checked. The docs say the snapshot is sent "when data is available", and each `mark_prices[]` entry carries its own `time`.
  - Change: `PRICE_STALE` if the entry's `time` is older than N s (declare N). Subscribe to the single symbol for orders; use `"*"` only for scans.
- **Wrong (coupling):** `VenueMarket.markPrice` is required, and `/md/contracts` feeds markets.
  - Scenario: an MDS or contracts outage blocks limit, stop, and cancel-adjacent paths. UAT `/md/contracts` returns 500 today, confirmed.
  - Change: order-entry precision (tick, lot, min/max, bands, status) loads from `/refdata` alone. Only market and close orders need mark. A `/md/contracts` failure fails funding/OI reads, not order entry.

**11. Frame shapes: three more doc conflicts missing from §14.0.**
- Auth success: the authenticate page shows `{ "type": "auth", "result": "success" }`; AsyncAPI shows `{"authenticated": true}`. Accept both. Anything else within 10 s is `orderNotSent`.
- Errors: the docs' own client samples branch on `msg.type === "error"`. Accept `err`, `type:"Err"`, and `type:"error"`.
- `RateLimited` is documented with `incoming_message: {}`. An empty echo counts as "no echo", which after send means unknown. Say so in the table.

**12. Builder "share" typing.**
- **Wrong:** `feeBps: 0`, `perpCapBps: 0`, and `feeStepBps: 0` break invariants. `BuilderTarget.feeBps` must be > 0, `parseBuilderEntry` divides by `feeStepBps` (`src/exchanges/builder-fee.ts:176`), `parseBuilderSettings` always writes `{code, feeBps}`, and skip notes print "configured: 0 bps".
- **Change:** `feeBps: number | null` on `BuilderTarget`/`AppliedBuilderFee`, with null for share. Add `BuilderShareEntry { code }`. Branch in both parse functions and in `decide()` notes. List the `builder-fee.test.ts` cases to update. `settings set builder.qfex` keeps the existing `--yes` confirmation, with disclosure text "your fills are attributed to <uuid>; you pay the normal fee".

**13. MCP and long-lived processes are missing from §14.11.**
- **Evidence:** `trade_execute`/`trade_close` auto-include any venue with `create !== null` (`src/mcp-server.ts:1597-1802`).
- **Change:** add `src/mcp-server.ts` and `src/mcp-trade-guard.ts` to the file plan, covering the health check, orderbook, and the qfex unsupported cases. Specify session idle-close (e.g. 30 s) for the MCP server and bots, and reconnect as re-auth plus re-subscribe with no replay. Register new write commands with `supportsDryRun` (default-deny). Add a SIGINT handler that prints `ORDER_PENDING` and `c:<id>` if a mutating command is in flight.

**14. Q-list and E2E.**
- **Blockers:** add Q20–Q22 from above, and Q23: `/user/positions` freshness after a fill. It is documented as a "latest … snapshot" with a 1 s/10 s pulse conflict, and `placePerpVerified` (`src/bot/perp-order.ts:57`) polls for about 10 s, so a slow snapshot quarantines every fill. Mark Q5, Q7, Q10, Q14, and Q20–Q23 as mainnet blockers.
- **E2E phases to add:** reduce-only violation; two concurrent sessions with the same symbol and qty; a kill-socket-after-send drill; IOC partial and no-fill; amend of an order with TP/SL.
- **Fix Q19:** see false claim 1.

#### 선택 개선
- Client-id marker: `pr…` is also a prefix-match for `p` + `r…`. Use an unambiguous delimiter. A wrong marker is venue-rejected, so this is safe today.
- Compute `avgPrice` and fill sums in decimal or BigInt, not float `===`.
- `nextFundingTime`: return null if the timestamp is in the past. CL shows a Friday value today.
- Leave restricted regions warn-only, consistent with `src/cli-program.ts:131`.
- Rate limit: 25% of the user budget is fine. Document that `RATE_LIMITED` on a cancel is surfaced, not retried.
- Pre-IPO share-count adjustments rescale position quantity. Note this for bot state.

#### §14 본문에서 사실과 다른 것으로 확인된 주장
1. **Q19 "`mds.qfex.io` 503" as a UAT outage.** A plain GET to prod `mds.qfex.com` also returns 503. A WS upgrade to `mds.qfex.io` returns 101 (probed 14:37 UTC). Only the `api.qfex.io/md/contracts` 500 is real.
2. **"keepalive 요구사항 UNVERIFIED".** The authenticate page says: "the server keeps the connection alive by periodically sending heartbeat messages in the form of WebSocket ping frames".
3. **Auth success = `{"authenticated": true}`.** The docs page shows `{ "type": "auth", "result": "success" }`, and the conflict is not listed.
4. **"API 출금 MFA 언급이 없다".** The official CLI README says: "Withdrawals require two-factor authentication (2FA) and cannot be initiated from the CLI."
5. **IOC terminal statuses.** The README says `FILLED` with remaining > 0, or `CANCELLED`; see edit 3.
6. **Close safety sentence.** A logic error; see edit 1.
7. **Withdraw pre-check on `available_balance`.** The docs define a separate Withdrawable Balance (`/qfex/definitions`).
8. **Error frame "two forms".** The docs' samples use a third, `type === "error"`.

**Verified true:** cancel-on-disconnect is opt-in and per connection; the speed-bump quotes; the rate limit of 12,000/60 s per user with split buckets; the restricted-region list; the non-idempotent withdraw; the refdata band values; and `margin_asset` USDC.

#### 미해결 질문
- Does builder attribution interact with invitation-code or lifetime-tier fee discounts? The docs say "full fee" in both cases.
- Does `order_responses` on a subaccount session also carry primary-account events?
- Does the multi-channel subscribe emit one `subscribed` frame per channel?

### 14.13 구현 기록 (2026-10-05) — §14.12 반영 결과와 문서 대비 차이

구현 위치: `src/exchanges/venues/qfex.ts`, `src/exchanges/qfex/{signing,errors,client,ws-transport,public,agent,adapter}.ts`, `src/withdraw-gate.ts`. 테스트: `src/__tests__/exchanges/qfex-*.test.ts`, `src/__tests__/commands/qfex-agent-import.test.ts`, `src/__tests__/qfex-gates.test.ts`.

**라이브 확인이 필요한 사실 = 상수 하나씩 (`qfex/signing.ts`)**

| 상수 | 값 | UNSET 동안의 동작 | 해제 |
|---|---|---|---|
| `QFEX_REDUCE_ONLY_WIRE` | `"boolean"` (production 2026-10-05, Q2) | (`null`이면) 모든 `reduceOnly: true` 경로가 `unsupported("qfex","reduceOnly",…)`. 설정된 지금은 `reduce_only: true`(JSON boolean)를 보내고, 전송 전 규칙 + ACK 에코 검사를 한다(아래 "Q2 해제") | Q2 — 해제됨 |
| `QFEX_AUTOMATION_VERIFIED` | `null` | `QfexAdapter.automationGate()` → `unsupported("qfex","automation",…)`. `assertCanClosePositions`(봇·plan·TWAP·DCA·grid·funding-arb·trailing stop)와 `startJob`이 시작 전에 거절. 수동 명령은 묻지 않는다 | Q21 통과(2026-10-12). 남은 조건: Q2 잔여·Q4, 자동화 흐름의 보호 stop |
| `QFEX_STOP_CLIENT_ID_ECHO` | `true` (production 2026-10-12, Q21) | `QfexAdapter.stopOrderGate()` → `null`. `placeStop`: reduce-only stop-market만, 전송 전 포지션·side·(크기 + 같은 type 다른 stop) ≤ 포지션 검사, ACK의 client id·`reduce_only: true` 확인, `get_user_orders` 행으로 open 확정. `stop_order_response` heartbeat는 상태로 읽지 않는다 | Q21 — 해제됨 |
| `QFEX_RESTING_REDUCE_ONLY_VERIFIED` | `null` | `capabilities.reduceOnlyTif: ["IOC"]` → `limit --reduce-only`의 GTC·ALO·FOK와 `scale-tp`가 전송 전에 `unsupported(…,"restingReduceOnly",…)` | 체결 시 cap 검증 후 `true` (`reduceOnlyTif`가 `null`이 된다) |
| `QFEX_MODIFY_KEEPS_CLIENT_ID` | `true` (production 2026-10-12, Q5) | `capabilities.amend: "native"`. `amendOrder`가 MODIFIED를 client id + 보낸 symbol/side/type/price/quantity로 상관시키고 새 order_id를 보고(`replacedOrderId` note, `get_user_orders` 재확인). reduce-only 주문 amend는 계속 거절 | Q5 — 해제됨 |
| `QFEX_USER_ID_IS_ACCOUNT` | `null` | `order_response.user_id ≠ accountId`는 `execution.notes`에 기록(실패 아님). `true`가 되면 `ORDER_PENDING` + alarm | Q22 |

**문서와 달라진 점**

| 항목 | §14 문서 | 구현 | 이유 |
|---|---|---|---|
| deposit 네트워크 옵션 | `--network arbitrum` | `--chain arbitrum` | 루트 `-n/--network`(mainnet\|testnet)가 서브커맨드 `--network`를 삼킨다 |
| 미검증 funding 조회 | `funding` 명령 | `arb scan --rates\|--compare <sym> --include-unverified` | 최상위 `funding` 명령이 없다. 플래그는 표시 전용이며 기본 스캔 순위에는 쓸 수 없다(`INVALID_PARAMS`) |
| `fetchMarkets` 출처 | `/refdata` + `/md/contracts` + MDS | `/refdata` + MDS `market_stats`(mark·OI·거래대금) | §14.12 #10: `/md/contracts` 장애가 마켓 목록을 막지 않도록. `/md/contracts`는 `fetchFundingRates`만 사용 |
| 출금 사전 잔고 확인 | Withdrawable Balance 또는 삭제 | 삭제 | API가 Withdrawable Balance를 주지 않는다. venue의 400 → `INSUFFICIENT_BALANCE` |
| stop 주문 | reduce-only 게이트만 | reduce-only stop-market만(`TAKE_PROFIT`/`STOP_LOSS`, `placeStop`). `--tp/--sl`은 검증된 진입 체결 뒤 별도 stop leg, `trade tpsl`도 같은 leg(`placeTpSlLeg`). stop-limit·여는 stop은 거절 | Q21 통과 (production 2026-10-12): **확인 (production 2026-10-12 ~16:03 UTC, GOLD-USD, scratchpad `qfex-probe.mts`):** `add_order {order_type:"STOP_LOSS", side:"SELL", quantity:0.003, price:3900(트리거), order_time_in_force:"GTC", client_order_id, reduce_only:true}` → `order_response` ACK가 `client_order_id`와 `reduce_only: true`를 에코(`order_origin: "STOP_ORDER"`, order_id b622…), 이후 약 1초마다 `stop_order_response` 프레임(같은 `stop_order_id`, client id 에코, `stop_order_type: "STOPLOSS"`, direction SELL — heartbeat이며 새 상태가 아님). `account orders`에 status untriggered·type STOP_LOSS로 표시. `cancel_stop_order {stop_order_id}` → `ack` 프레임 후 `order_response` CANCELLED(client id 에코) |
| client id 표식 (`p`/`pr`) | 접두 인코딩 | 없음 — UUID 그대로 | reduce-only 여부는 venue가 `order_response.reduce_only`로 돌려주므로 표식이 필요 없다. amend는 Q5 해제 시 함께 설계 |
| 구독 | 채널 3개를 한 메시지로 | 채널마다 `subscribe` 1건 + 각각 확인 | 다중 채널 구독의 확인 프레임 수가 미확정(§14.12 미해결 질문) |
| `QfexAgentMeta` | `accountId: string \| null` | `accountId: string` + `isPrimaryAccount: boolean` | §14.12 #9. 출금은 primary 계정 키만 |
| `getRecentTrades` | — | `unsupported` | 문서의 `GET /public/trades`가 404 (2026-10-04) |
| `getFundingPayments` | `/executions?execution_type=<funding>` | `unsupported` | `execution_type` 값 미공개(Q10) |
| `hasCredentials(qfex)` | — | import된 키가 있을 때만 true | `masterKeyKind: "none"` venue에 master 지갑은 자격이 아니다 |

**Q2 해제 (2026-10-05, production 증거는 §14.10 Q2 행)** — `src/exchanges/qfex/adapter.ts`

- 동작하는 것(수동 명령만): `trade close` / `reduce` / `close-all` / `flatten`, `limit --reduce-only --tif IOC`, MCP `trade_close`, legacy shim(`marketOrder`, `limitOrder` IOC, `reduceOnly: true`). 시장가 청산은 기존 시장가와 같은 보호가 IOC LIMIT + `reduce_only: true`.
- 계속 막힌 것: attached TP/SL(Q7), funding(Q4), reduce-only 주문 amend, 그리고 아래 두 가지. (2026-10-12: stop·`trade tpsl`·`--tp/--sl`은 Q21 통과로, 일반 주문 amend는 Q5 통과로 열림 — 위 상수 표.)
- **자동화 게이트 (`QFEX_AUTOMATION_VERIFIED = null`, `QfexAdapter.automationGate()`):** stop이 거절되는 동안 무인 전략은 venue에 보호 청산을 걸 수 없다. 그래서 `assertCanClosePositions`가 reduce-only 게이트 다음에 `automationGateOf`를 확인하고, 봇(`bot/engine.ts`)·plan·TWAP·DCA·grid·funding-arb·trailing stop은 첫 주문·첫 읽기 전에 `CAPABILITY_UNSUPPORTED`(feature `automation`)로 거절된다. `startJob`도 같은 게이트로 qfex 백그라운드 job을 tmux 실행 전에 거절한다. 수동 명령(`trade close` / `reduce` / `close-all` / `flatten` / `limit --reduce-only` / MCP `trade_close`)은 `reduceOnlyGateOf`만 묻기 때문에 영향이 없다. 해제: Q21 통과 후 상수를 `true`로.
- **resting reduce-only 금지 (`QFEX_RESTING_REDUCE_ONLY_VERIFIED = null`):** Q2에서 venue는 포지션보다 큰 resting reduce-only 주문을 그대로 접수했다. 체결 시 cap은 **즉시 체결(IOC) 주문에 대해서만** 증명됐다(아래 "체결 시 cap 증거"). resting 주문이 접수된 뒤 포지션이 줄거나 닫혔을 때 어떻게 되는지(나중 체결 시 cap되는지, 취소되는지)는 여전히 미검증이므로 상수는 그대로 둔다. 전송 전 규칙은 접수 시점에만 돈다. 그래서 `capabilities.reduceOnlyTif: ["IOC"]`로 두어 `limit --reduce-only`의 GTC·ALO·FOK와 `scale-tp`(GTC reduce-only limit)를 `validateOrderRequest`에서 전송 전에 거절한다(feature `restingReduceOnly`, remediation: `--tif IOC` 또는 `trade reduce`). 해제: 상수를 `true`로 바꾸면 `reduceOnlyTif`가 `null`이 된다(다른 변경 없음).
- **전송 전 규칙 (`requireReducible`, 모든 reduce-only 전송 직전, 세션 연결 후):**
  1. `GET /user/positions`에서 해당 심볼 행을 읽는다. 행 없음 / `position = 0` → `POSITION_NOT_FOUND`(로컬 거절, venue에 맡기지 않음).
  2. side가 포지션 반대가 아니면(long→sell, short→buy) `INVALID_PARAMS`.
  3. `get_user_orders(symbol)`에서 같은 심볼·같은 side·stop이 아닌 행 **전부**의 `quantity_remaining` 합 = reserved (일반 SELL도 long을 소진하므로 `reduce_only` 값과 무관하게 센다). 수량 > floor(|position|, lot) − reserved 이면 `SIZE_TOO_LARGE`(details: `position`, `reservedByOpenOrders`, `available`, `reservingOrderIds`; remediation: 수량 축소 또는 해당 주문 취소 명령 + 주문 id).
  4. 같은 side 열린 주문 행에 `reduce_only`가 boolean으로 없으면 검증된 행 형식이 아니므로 거절: `ORDER_REJECTED "… not sent"`(details `sent: false`, `unreadableOrderIds`; remediation: `perp trade cancel <SYM> <orderId> -e qfex (<ids>)`). 읽기 실패·행 중복·숫자가 아닌 position도 모두 `ORDER_REJECTED "… not sent"`(확정, 전송 없음). 기본값 대체 없음.
  5. stop 행(`TAKE_PROFIT`/`STOP_LOSS`)은 reserved에 넣지 않는다 — 문서 `/qfex/order-types`: "Act only to decrease position at the time of execution". 웹에서 건 SL이 있어도 CLI 청산이 가능해야 하기 때문이다. 대신 그 심볼에 stop 행이 있으면 `execution.notes`에 개수와 id를 적는다.
  6. 최소 수량: reduce-only 주문의 `min_quantity` 검사는 포지션을 읽은 뒤에 한다. 수량이 내림한 포지션 전량과 같으면 최소 수량 미만이어도 보낸다(잔량 청산; venue가 받아 주는지는 미검증이라 `execution.notes`에 적고 venue 응답을 그대로 전달). 전량이 아니면 `SIZE_TOO_SMALL`.
- **체결 시 cap 증거 (production 2026-10-05, raw `add_order`, GOLD-USD, long 0.003):** SELL LIMIT IOC 0.006 @ 4125 `reduce_only: true` → `order_response` 3개: (1) `ACK` quantity 0.006, quantity_remaining 0.006, `reduce_only: true` (2) `FILLED` quantity 0.003 @ 4145, quantity_remaining 0.003, trade_id 있음, **`reduce_only: false`** (3) `CANCELLED` quantity 0.006, quantity_remaining 0.003, `reduce_only: true`. 이후 포지션은 flat — venue가 체결 시점에 포지션 크기까지만 체결하고 나머지를 취소했다(flip 없음). 관측 1회, 즉시 체결 주문만.
- **ACK 에코 검사 (`reduceOnlyUnconfirmedFrame`):** 판정 대상은 주문을 설명하는 프레임, 즉 ACK와 그 밖의 **체결이 아닌 상태 프레임**(`CANCELLED`·`IOC_CANCELLED`·`MODIFIED`·ACK 이후 거절 등)이다. 이 프레임들에 `reduce_only === true`가 있어야 한다. 체결을 싣는 프레임(status `FILLED`)은 판정하지 않는다 — 위 증거처럼 venue는 ACK·CANCELLED에 `true`를 싣는 주문의 FILLED 프레임에 `false`를 싣고, 그 프레임의 `quantity`는 주문 수량이 아니라 체결 수량이다(정상 동작). 체결이 아닌 프레임이 하나도 없으면 확인해 줄 프레임이 없으므로 받은 프레임을 그대로 판정한다(확인 없음을 확인으로 읽지 않는다). reduce-only 주문이 final `partiallyFilled`로 끝나면 `execution.notes`에 "venue가 체결 시점에 포지션 크기로 cap하고 나머지를 취소했다(또는 지정가 안의 유동성 부족)"를 적는다. 판정 대상 프레임이 `false`거나 없으면 `ORDER_PENDING`(details `alarm: "reduceOnlyNotEchoed"`, `orderId`, `clientOrderId`, `reduceOnlyEcho: false | null`, `venueRaw`)을 던진다. **자동 취소는 하지 않는다** — 취소는 그 자체로 결과가 불확실할 수 있는 두 번째 변경 명령이고(§14.12 #4e: 재전송·자동 조치 없음) 이미 난 체결은 되돌리지 못한다. remediation은 `trade status c:<id>` → 열려 있으면 `trade cancel <SYM> <orderId>` → `account positions` 순서를 적는다. 결과가 불명이라 client id로 다시 읽은 행에는 출처별로 적용한다: 열린 주문 행(get_user_orders)은 `true`가 아니면 경고, `/user/historic-orders` 행은 `reduce_only` 필드가 없으므로 **종결된 행이면 경고 없이** 결과를 돌려주고 `execution.notes`에 "reduce_only not reported on historic rows"를 적는다. 명시적 `false`는 어느 행이든 경고이고, 종결되지 않은 historic 행에 필드가 없으면(아직 살아 있을 수 있음) 경고다.
- **로컬 거절의 확정성:** `POSITION_NOT_FOUND`(details `sent: false`)는 `isDefiniteOrderFailure`가 `details.sent === false`를 확정 실패로 인정하므로 `placePerpVerified`가 10 s 폴링 없이 `ORDER_REJECTED { reduceOnlyFlat: true }`로 바꿔 던진다(격리 없음). `POSITION_NOT_FOUND` 코드 자체는 확정 코드 집합에 넣지 않았다 — `classifyError`가 메시지 문자열에서도 이 코드를 만들기 때문이다.
- **잔여 위험:** 전송 전 규칙은 read-then-send다. 읽은 뒤 포지션이 줄면(다른 프로세스·웹 UI·stop 트리거, speed bump 500 ms) venue의 체결 시 cap에 의존한다. 이 cap은 IOC 주문에서 1회 관측됐고(위 증거), resting 주문에 대해서는 미검증이다. `position` 부호(Q10): short 포지션이 side short로 읽히는 것을 production 2026-10-05에 확인했다.
- **부수 효과 없음:** `reduceOnlyGate()`는 `null`이 됐지만 자동화는 위 자동화 게이트가 따로 막는다. Q2 해제로 열린 것은 수동 reduce-only 명령뿐이다.

**러너**: `scripts/e2e`에는 프로필·`DESIGN_ITEMS` Q1–Q23·`ITEM_VENUES`/`NOT_COVERED` 항목만 추가했다. 공통 trade 단계 중 qfex에서 `CAPABILITY_UNSUPPORTED`로 멈추는 것은 amend(Q5), stop·TP/SL(Q21), resting reduce-only limit(GTC·ALO, `scale-tp` 포함)에 의존하는 단계다(의도된 동작, `docs/TEST-PLAN.md` §9.2). 시장가·IOC reduce-only 청산 단계는 Q2 해제로 실행된다.


## 15. RISEx · TxFlow (9·10번째 venue, 2026-10-14)

> 계획: `.omc/plans/venues-risex-txflow.md` (로컬). 결정: Q-R2 (signer on-chain trading-only 제한), Q-R3 (RISEx 입출금 앱 전용), Q-T1 (TxFlow bulk funding = WS one-shot snapshot).

**TxFlow (`txflow` | `txf`)** — `roles: ["marketData"]`, `capabilities: null`, `apiStatus: unofficial` (공식 API 없음; app.txflow.com 이 쓰는 비공식 HL-style `POST /info` + WS). `perpMeta` 디렉터리(음수 `szDecimals` → 정확한 lot step), WS `allAssetCtxs` 1회 스냅샷을 coin id(=perpMeta `index`)로 조인, funding 은 %/h → 소수/h(정확한 두 자리 이동), `fundingVerified: false`. 403 / 200+`{message}` / 형태 변경은 `EXCHANGE_ERROR`, fallback 없음. 모든 계정·거래·자금·agent·builder·봇 경로는 요청 전에 `CAPABILITY_UNSUPPORTED` (`venue.ts roleUnsupported`). JSON `venueApi` / 행별 `apiStatus`, 사람 출력 각주, MCP meta, 랜딩 화면에 "unofficial" 표기.

**RISEx (`risex` | `rise`)** — RISE chain on-chain 오더북, USDC. account(master)는 설정만 서명, 모든 주문은 session signer 의 EIP-712 `VerifyWitness` permit. 승인 = master `RegisterSigner` + signer `VerifySigner` → signer 가 거래(permission 2) 외 모든 권한에 `DisablePermission` 서명, master 가 on-chain 전송(가스 필요) → `hasPermission` 으로 최종 상태 증명; 실패 시 자동 revoke. 증거: `src/__tests__/fixtures/risex/permissions-evidence.json`. Funding: `current_funding_rate` = 직전 정산 시간당 값 (`fundingVerified: true`, 증거 `funding-payments-evidence.json`). nonce: (anchor+1, bit) 를 파일 락 아래 전송 전에 기록·소각, 재사용 없음. 결과 불명 → 1회 조회(nonce 소비 여부, client id) 후 `ORDER_PENDING` + quarantine. 입출금 명령은 `CAPABILITY_UNSUPPORTED` (앱 전용), testnet faucet 만 지원. TP/SL·amend·builder fee·자동화는 아직 거절. 메인넷 주문은 미검증 (testnet E2E 만).
