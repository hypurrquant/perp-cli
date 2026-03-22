# Deep Interview Spec: ExchangeAdapter 플러그인 아키텍처 리팩토링

## Metadata
- Rounds: 7
- Final Ambiguity Score: 10.2%
- Type: brownfield
- Generated: 2026-03-19
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.95 | 35% | 0.333 |
| Constraint Clarity | 0.85 | 25% | 0.213 |
| Success Criteria | 0.92 | 25% | 0.230 |
| Context Clarity | 0.82 | 15% | 0.123 |
| **Total Clarity** | | | **0.898** |
| **Ambiguity** | | | **10.2%** |

## Goal
ExchangeAdapter 인터페이스를 플러그인 아키텍처로 리팩토링하여, 새 DEX 어댑터를 추가할 때 **어댑터 파일 1개 + registry 등록**만으로 모든 CLI 커맨드에서 자동 작동하도록 한다. 커맨드 파일에서 instanceof 체크를 제거하고, 거래소별 고유 기능은 `adapter.native()` 패턴으로 접근한다.

## Architecture

### 1. Core Interface (유지 + 확장)
```typescript
export interface ExchangeAdapter {
  readonly name: string;
  readonly chain: string;          // NEW: "solana" | "evm" | "cosmos" | "sui" | ...
  readonly aliases: string[];      // NEW: ["hl", "hyper"]

  // 기존 18개 메서드 유지 (getMarkets, marketOrder, ...)
  init?(): Promise<void>;          // NEW: optional init lifecycle
  withdraw?(amount: string, destination: string): Promise<unknown>;  // NEW: 통일된 시그니처
}
```

### 2. Capability Sub-interfaces (공통 기능만)
```typescript
export interface TwapCapable {
  twapOrder(symbol: string, side: "buy"|"sell", size: string, durationMinutes: number): Promise<unknown>;
  twapCancel(symbol: string, twapId: number): Promise<unknown>;
}

export interface StopOrderCapable {
  stopOrder(symbol: string, side: "buy"|"sell", size: string, triggerPrice: string, opts?: {...}): Promise<unknown>;
}

// 타입 가드 함수
export function hasTwap(adapter: ExchangeAdapter): adapter is ExchangeAdapter & TwapCapable {
  return 'twapOrder' in adapter;
}
```

### 3. Adapter Registry
```typescript
// exchanges/registry.ts
export interface AdapterFactory {
  name: string;
  aliases: string[];
  chain: string;
  create(privateKey: string, testnet: boolean, opts?: Record<string, unknown>): ExchangeAdapter;
}

const registry: AdapterFactory[] = [];

export function registerAdapter(factory: AdapterFactory): void { ... }
export function getAdapterFactory(nameOrAlias: string): AdapterFactory | undefined { ... }
export function listExchanges(): AdapterFactory[] { ... }
```

### 4. Native Access (거래소 고유 기능)
```typescript
// 거래소 고유 기능은 타입 단언으로 접근
const hl = adapter as HyperliquidAdapter;
hl.listDeployedDexes();  // HIP-3 전용

// 또는 커맨드 파일에서:
if (adapter.name === "hyperliquid") {
  const hl = adapter as HyperliquidAdapter;
  // ... HIP-3 dex 전용 로직
}
```

### 5. Command 파일 변경
- **instanceof 제거**: `adapter instanceof HyperliquidAdapter` → `hasTwap(adapter)` 또는 `adapter.name === "hyperliquid"`
- **공통 기능**: 인터페이스 메서드 직접 호출
- **거래소 고유 기능**: `adapter.name` 체크 후 타입 단언 (거래소별 manage 커맨드 등)

## Constraints
- **모든 호환성 유지**: MCP 서버, 봇 엔진, arb 데몬, CLI 인터페이스 변경 없음
- **기존 941개 테스트 전부 통과**
- **점진적 마이그레이션**: 기존 어댑터 3개는 그대로 동작, 새 registry에 등록만 추가
- **공통 기능만 추상화**: 거래소 고유 기능(lake, HIP-3, 스테이킹 등)은 native access 유지

## Non-Goals
- 모든 거래소 고유 기능을 capability 인터페이스로 추상화하지 않음
- CLI 사용자 경험 변경 없음 (명령어/옵션/출력 동일)
- 이 PR에서 새 DEX를 추가하지 않음 (인프라만 준비)

## Acceptance Criteria
- [ ] `exchanges/registry.ts` 생성 — registerAdapter, getAdapterFactory, listExchanges
- [ ] 기존 3개 어댑터(Pacifica, Hyperliquid, Lighter) registry에 등록
- [ ] `ExchangeAdapter`에 `init?()`, `chain`, `aliases` 추가
- [ ] `withdraw()` 시그니처 통일 — 3개 어댑터 모두 동일 시그니처
- [ ] `TwapCapable`, `StopOrderCapable` 서브인터페이스 + 타입 가드 함수
- [ ] `index.ts` 팩토리: switch문 → registry.get() 기반
- [ ] 커맨드 파일 instanceof → capability 타입 가드 또는 name 체크로 전환
- [ ] 기존 941개 테스트 전부 통과
- [ ] tsc 컴파일 에러 0
- [ ] 라이브 테스트: 3개 거래소 주문/취소 정상 작동
- [ ] 새 DEX 추가 DX: 어댑터 파일 1개 + registry 등록 1줄 + 테스트 파일 + 스킬 문서 갱신
- [ ] 전체 리팩토링 한번에 완료 (단계적이 아닌 일괄)

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 모든 기능을 추상화해야 한다 | 50+ 거래소 고유 메서드가 있는데 전부 인터페이스화? | 공통 기능만 추상화, 나머지는 native access |
| Breaking change OK | 내부 도구라 괜찮지 않나? | 모든 호환성 유지 필요 (MCP, bot, arb 포함) |
| 자동 디스커버리 필요 | 파일 스캔 vs 수동 등록? | Registry 배열 방식 (명시적, 오버헤드 없음) |

## Technical Context (Brownfield)
- 현재 코드: 17개 소스 파일, 3개 어댑터, 37개 instanceof 체크
- 인터페이스: 18개 메서드 (interface.ts:70-98)
- 어댑터별 고유 메서드: Pacifica 5개, Hyperliquid 30+개, Lighter 15+개
- 팩토리: index.ts switch문 (lines 105-182)
- 배럴: exchanges/index.ts (20 lines)

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| ExchangeAdapter | core domain | name, chain, aliases, 18 methods, init?, withdraw? | implements by Adapter, registered in AdapterRegistry |
| Capability | core domain | interface name, type guard function | extends ExchangeAdapter |
| AdapterRegistry | core domain | factories[], get(), register(), list() | contains AdapterFactory |
| AdapterFactory | core domain | name, aliases, chain, create() | creates ExchangeAdapter |
| Command | supporting | action handlers | uses ExchangeAdapter via registry |
| NativeAccess | pattern | type assertion, name check | accesses adapter-specific methods |
| MigrationStrategy | constraint | additive-only, backward-compatible | governs refactoring approach |
| TypeGuard | pattern | hasTwap(), hasWithdraw() | narrows ExchangeAdapter to Capability |

## Interview Transcript
<details>
<summary>Full Q&A (7 rounds)</summary>

### Round 1
**Q:** 인터페이스 리팩토링의 핵심 목표가 뭔가요?
**A:** 풀 리팩토링: 플러그인 아키텍처
**Ambiguity:** 63.5%

### Round 2
**Q:** 하위 호환성은 어떻게 할까요?
**A:** 모든 호환성은 유지해야함
**Ambiguity:** 52.8%

### Round 3
**Q:** 리팩토링이 끝났다고 판단할 기준이 뭐예요?
**A:** 어댑터 파일 1개만 추가
**Ambiguity:** 31.8%

### Round 4 (Contrarian)
**Q:** 50+ 고유 기능을 모두 capability로 추상화하면 복잡도가 늘지 않나?
**A:** 공통 기능만 추상화
**Ambiguity:** 24.3%

### Round 5
**Q:** 어댑터 등록/디스커버리 메커니즘을 어떻게 할까요?
**A:** Registry 배열
**Ambiguity:** 17.8%

### Round 6 (Simplifier)
**Q:** 1차 범위로 꼭 필요한 것만 남긴다면?
**A:** 전부 한번에 (registry + capability + instanceof 전환 + factory 리팩토링 일괄)
**Ambiguity:** 13.5%

### Round 7
**Q:** 새 DEX 추가 시 개발자가 만들어야 하는 파일은?
**A:** 어댑터 파일 + 테스트 파일 + 문서 갱신
**Ambiguity:** 10.2%
</details>
