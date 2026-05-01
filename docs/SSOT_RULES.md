# perp-cli SSOT Rules

> Single Source of Truth (SSOT) 규칙. 이 문서가 규칙의 정본(canonical)이며, 로컬
> `CLAUDE.md` 는 이 파일을 참조한다. PR 리뷰에서 본 규칙을 인용할 때는 이 파일의
> 라인 번호를 사용하라.
>
> Inherits from HypurrQuant_FE CLAUDE.md SSOT principles. This file documents
> the perp-cli-specific application of those rules.

## SSOT Rule #2 — No Fallback / No Defensive Fallback

**Fallback 은 어떤 형태로든 절대 금지.** 실패하면 실패. 우회 경로(`try/catch` 삼킴, 기본값 대체, silent retry, 캐시-as-실시간 substitution)를 만들지 않는다. 에러는 호출자에게 그대로 전파한다.

**금지 패턴:**
- `value ?? defaultValue` 류 silent substitution
- `try { live() } catch { return cache() }` — live 실패를 cache 결과로 대체
- `field?: T` optional 필드 → `field: T | null` 로 명시. optional 은 fallback 자리를 만든다
- `// TODO: proper fix later` stopgap 주석. 한 commit 안에 정상화 또는 명시적 throw 까지 끝낸다

**올바른 패턴:**
- 라이브 검증 불가능한 endpoint 는 `NOT_IMPLEMENTED` throw 와 명시적 remediation. 사용자가 어떤 다른 명령으로 우회하라고 알려준다
- 필드가 venue 에서 미노출이면 `null` 명시, 사용처가 `null` 일 때 동작을 정의 (gate 비활성화, UI 빈칸 등)

**예 (2026-04-30 적용):** Aster `/fapi/v3/agent` GET 은 verified master-signing path 가 없다. 처음에는 "local cache 로 fallback" 하는 verifyAster 를 짰지만 SSOT 위반. 현재는 `NOT_IMPLEMENTED` throw + remediation `Use 'perp wallet agent list aster'` (`src/commands/agent.ts:58-72`).

**왜 이 룰이 중요한가:** fallback 은 "현상은 가렸지만 진짜 원인은 안 고친" 코드를 양산한다. fallback 을 거부하면 SSOT 가 어디서 뚫리는지 즉시 드러난다.

## SSOT Rule #3 — Single Secret Source per Key

**모든 암호 비밀(개인키, 위임 키, slot PK, API 토큰)은 정확히 한 자리에만 영속된다.** 같은 종류의 비밀이 두 곳에 흩어지면 (a) 어느 쪽이 truth 인지 모호해지고, (b) 일부만 백업/로테이션 되어 부분 노출이 생기고, (c) 한쪽 손상 시 silent 으로 잘못된 키로 동작한다.

**기준 자리:**
- **Master keypair** (사용자 본 지갑) → OWS vault (`~/.ows/wallets/`, AES-256-GCM, 사용자 master passphrase)
- **Multi-chain agent keypair** (Aster/HL/PAC 같이 OWS 가 지원하는 curve) → OWS vault 의 별도 wallet (`agent-<dex>-<master>`), 빈 passphrase + mode 0600 (file-permission 기반 보안 — Aster/HL/PAC 현재 패턴과 동일)
- **Single-curve raw agent key** (Lighter L2 slot 키 등 OWS 가 native curve 지원 안 하는 경우) → `~/.perp/<dex>-agents/<account>-<slot>.json`, AES-256-GCM 동일 스킴, mode 0600
- **OWS API key 토큰** → `~/.ows/keys/<id>.json` (OWS 표준)
- **Public address 캐시** → `settings.json` 의 `wallets.<name>.publicAddresses` 또는 `agents.<dex>.<name>.userEvmAddress` (read-through, OWS/keystore 가 SSOT)

**금지 패턴:**
- 키 재료를 `.env` 평문으로 영속화 (`setEnvVar(..., privateKey)`). 거래소별 ad-hoc env 변수 (`LIGHTER_API_KEY`, `*_PRIVATE_KEY`) 신규 도입 금지. CI/배포에서 `.env` 누락 시 silent 으로 기능이 깨지고, OWS 백업에 미포함.
- 동일 키를 두 저장소에 동시 갱신 ("env 와 OWS 가 sync 돼야 한다" 류 주석은 SSOT rule #3 위반 신호)
- 거래소 SDK 가 "평문 hex 만 받는다"는 핑계로 디스크 평문 우회. 어댑터 init 시점에 keystore 에서 read → in-memory 변수로 보유. 디스크 평문 영속화 금지.
- 설정 파일에 비밀 자체 (`settings.agents.<dex>.<name>.privateKey` 등) 넣기. settings 는 메타/공개 주소만.

**올바른 패턴:**
- Agent 발급 시: 어떤 거래소든 hot-path 키는 즉시 keystore (OWS wallet 또는 `~/.perp/<dex>-agents/`) 로 write. `settings.agents.<dex>.<name>` 에는 `agentWalletName` 또는 `keystorePath` 등 포인터만 저장. env 손대지 않음.
- 어댑터 init 시: keystore 에서 read → in-memory `_apiKey`. process 종료 시 GC. 평문 디스크 영속화 없음.
- 새 거래소 추가 시: hot-path 키 저장소를 OWS wallet 또는 `~/.perp/<dex>-agents/` 둘 중 하나로 결정 후 SSOT Rule #3 표에 추가. env 변수 신규 도입은 SSOT 검토 필요.

**예 (2026-05-01 적용):** `~/.perp/.env` 의 `LIGHTER_API_KEY` 가 Lighter agent 의 hot-path L2 슬롯 PK 였음. Aster/HL/PAC agent 는 OWS vault 에 들어있는데 Lighter 만 env 평문 — `agent.ts:2170-2182` FIXME 로 이미 알려진 SSOT 결함이었다. 결과: (a) 사용자가 .env 지우면 silent 으로 LT 거래 깨짐, (b) OWS 백업에 LT agent 키 미포함, (c) `wallet rotate` 같은 master-level 작업이 LT slot 키와 분리됨, (d) `wallet show --json` 출력이 OWS active wallet 대신 .env PK 우선시하는 잔재 버그. 해결: `agent.ts:2165-2177` 의 `setEnvVar` 호출을 `~/.perp/lighter-agents/<account>-<slot>.json` keystore write 로 교체, `lighter.ts` 어댑터의 env read 제거, `index.ts` 의 lighter case 가 `loadLighterKey()` 로 PK 로드 후 `setAgentSigner()` 주입. 모듈: `src/agent-wallet/lighter-keystore.ts`. 마이그레이션 헬퍼 `migrateFromEnvIfPresent()` 가 기존 사용자의 env → keystore 1회 이전 + .env entry 삭제까지 자동 처리.

**왜 이 룰이 중요한가:** Rule #2 (fallback 금지) 가 *런타임 흐름* 의 SSOT 라면, Rule #3 은 *영속 상태* 의 SSOT 다. fallback 없이 정직하게 실패하는 코드도, 비밀 자체가 두 곳에 있으면 어느 자리가 정답인지부터 흐려진다. Rule #3 가드가 있어야 신규 거래소 추가 시 또 env 잔재가 생기는 것을 막을 수 있다.

## Reference

- HypurrQuant_FE CLAUDE.md (rule #2 원본): `/Users/hik/Documents/GitHub/HypurrQuant_FE/CLAUDE.md:150-164`
- HypurrQuant_FE perp-data-ssot.md (Section 1 case study): `/Users/hik/Documents/GitHub/HypurrQuant_FE/docs/guide/web/architecture/perp-data-ssot.md:18-38`
- Lighter keystore module (Rule #3 적용 사례): `src/agent-wallet/lighter-keystore.ts`
