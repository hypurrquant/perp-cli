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

**출고 기본값(shipped default)은 fallback 이 아니라 설정이다 (2026-10-02).** 다음 (a)–(e) 를 모두 만족하는 기본값은 "숨은 fallback" 이 아니라 문서화된 설정값이다:
- (a) `src/settings.ts` `DEFAULTS` **한 곳**에서 선언 (예: `defaultSlippageBps: 50`)
- (b) **한 곳**에서 해석 (예: `resolveSlippage()` — `src/exchanges/slippage.ts`; 어댑터는 settings 를 읽지 않고 해석된 값을 인자로 받음)
- (c) `perp settings show` / `--json` 에 "(shipped default)" 로 표시되고 `perp settings set` 으로 변경 가능
- (d) 그 값을 쓴 모든 결과에 출처(`source: "flag" | "venue" | "default"`) 기록
- (e) 잘못된 설정은 throw (`loadSettings` 가 손상된 settings.json / 잘못된 키에 `INVALID_PARAMS` + remediation; 파일이 **없는** 경우만 DEFAULTS — 이는 실패가 아님)

**기본 off 설정 (2026-10-02, builder fee):** 사용자에게 비용을 지우는 값(builder fee, deBridge affiliate fee)은 출고 기본값이 **없다** — settings 키 부재 = off (`settings.builder.<venue>`, `settings.bridge.debridgeAffiliate`). env 변수(`PACIFICA_BUILDER_CODE`, `DEBRIDGE_REFERRAL_CODE` / `DEBRIDGE_AFFILIATE_FEE_PERCENT` / `DEBRIDGE_AFFILIATE_FEE_RECIPIENT`)와 하드코딩 상수(`"PERPCLI"`)는 설정 소스가 아니며 읽지 않는다. 해석은 `resolveBuilderGate()`(`src/exchanges/builder-fee.ts`) 한 곳, 어댑터는 settings 를 읽지 않는다. venue 승인 조회 실패는 "fee 없이 전송 + `execution.notes` 기록" — 주문을 대체·변형하는 fallback 이 아니라 사용자 비용을 붙이지 않는 보수적 동작이며 결과에 드러난다.

**런타임 조회 실패의 대체는 계속 금지:** mark 조회 실패 → mid 사용, `catch → DEFAULTS`, 캐시-as-실시간 등은 여전히 Rule #2 위반이다.

## SSOT Rule #3 — Single Secret Source per Key

**모든 암호 비밀(개인키, 위임 키, slot PK, API 토큰)은 정확히 한 자리에만 영속된다.** 같은 종류의 비밀이 두 곳에 흩어지면 (a) 어느 쪽이 truth 인지 모호해지고, (b) 일부만 백업/로테이션 되어 부분 노출이 생기고, (c) 한쪽 손상 시 silent 으로 잘못된 키로 동작한다.

**기준 자리:**
- **Master keypair** (사용자 본 지갑) → OWS vault (`~/.ows/wallets/`, AES-256-GCM, 사용자 master passphrase)
- **Multi-chain agent keypair** (Aster/HL/PAC 같이 OWS 가 지원하는 curve) → OWS vault 의 별도 wallet (`agent-<dex>-<master>`), 빈 passphrase + mode 0600 (file-permission 기반 보안 — Aster/HL/PAC 현재 패턴과 동일)
- **Single-curve raw agent key** (Lighter L2 slot 키 등 OWS 가 native curve 지원 안 하는 경우) → `~/.perp/<dex>-agents/<account>-<slot>.json`, AES-256-GCM 동일 스킴, mode 0600
- **OWS API key 토큰** → `~/.ows/keys/<id>.json` (OWS 표준)
- **Venue 별 등록 자리 (venue abstraction, 2026-09):**
  - **Lighter RH** (Lighter-family L2 slot 키) → `~/.perp/lighter-rh-agents/<account>-<slot>.json` (Lighter 와 동일 keystore 스킴, 디렉터리만 분리)
  - **Ondo Perps** (HMAC API key id + secret) → `~/.perp/ondo-agents/<keyId>.json`, AES-256-GCM, mode 0600. `perp wallet agent approve ondo` 가 stdin 으로만 입력받음 (argv/env 금지)
  - **Arcus** (Ed25519 API key) → OWS vault 의 별도 wallet `agent-arcus-<master>` (Aster/HL/PAC 패턴과 동일)
  - **QFEX** (HMAC API public key + secret, 웹사이트에서만 생성) → `~/.perp/qfex-agents/<publicKey>.json`, AES-256-GCM, mode 0600. `perp wallet agent import qfex` 가 숨김 프롬프트 / stdin 으로만 입력받음 (argv/env 금지). settings 에는 메타(`publicKey`, 계정 UUID, network)만. public key 는 WebSocket URL(`?api_key=`)에 실리며 비밀이 아님 — secret 은 로그·에러·argv 어디에도 나오지 않음
  - **RISEx** (session signer, EVM 키) → OWS vault 의 별도 wallet `agent-risex-<master>[-testnet]` (빈 passphrase, HL/Arcus 패턴과 동일). `perp wallet agent approve risex` 로만 생성 (master 서명 등록 + on-chain trading-only 제한). import 는 거절 (앱에서 만든 signer 는 자금 이동 권한 보유). settings 에는 메타(signer/account 주소, 만료, 권한 상태)만. permit nonce 상태 `~/.perp/risex-nonce/<network>-<account>.json` 은 비밀 아님
  - **TxFlow** → 자격 증명 없음 (비공식 read-only API, market data 전용)
  - **Extended** → 자격 증명 없음 (공식 public API, 이번 버전은 market data 전용 — trading 은 이후 릴리즈)
- **웹사이트에서 만든 키 import (`perp wallet agent import <venue>`, 2026-10-02):** master 는 공개 주소로만 기록(`masterWalletName: ""`, `source: "imported"`).
  - HL / Aster (EVM) · Pacifica (Solana) · Arcus (Ed25519) → OWS vault wallet `agent-{hl,aster,pac,arcus}-import-<agentName>` (빈 passphrase, 승인형 agent wallet 과 동일 모델)
  - Lighter / Lighter RH → 승인형과 같은 network-tagged keystore (`~/.perp/lighter-agents/<network>-<account>-<slot>.json`, `~/.perp/lighter-rh-agents/…`, atomic write)
  - Ondo → `~/.perp/ondo-agents/<keyId>.json` (approve 와 동일)
  - QFEX → `~/.perp/qfex-agents/<publicKey>.json` (import 가 유일한 등록 경로)
  - 키는 숨김 프롬프트 / stdin 으로만 입력, venue 확인 전에는 저장하지 않음. 에러 메시지에서 키 문자열은 제거.
- **Public address 캐시** → `settings.json` 의 `wallets.<name>.publicAddresses` 또는 `agents.<dex>.<name>.userEvmAddress` (read-through, OWS/keystore 가 SSOT)

**금지 패턴:**
- 키 재료를 `.env` 평문으로 영속화 (`setEnvVar(..., privateKey)`). 거래소별 ad-hoc env 변수 (`LIGHTER_API_KEY`, `*_PRIVATE_KEY`) 신규 도입 금지. CI/배포에서 `.env` 누락 시 silent 으로 기능이 깨지고, OWS 백업에 미포함.
- 동일 키를 두 저장소에 동시 갱신 ("env 와 OWS 가 sync 돼야 한다" 류 주석은 SSOT rule #3 위반 신호)
- 거래소 SDK 가 "평문 hex 만 받는다"는 핑계로 디스크 평문 우회. 어댑터 init 시점에 keystore 에서 read → in-memory 변수로 보유. 디스크 평문 영속화 금지.
- 설정 파일에 비밀 자체 (`settings.agents.<dex>.<name>.privateKey` 등) 넣기. settings 는 메타/공개 주소만.
- 자식 프로세스(tmux 백그라운드 잡, OWS CLI, `open`/`tail` 등)의 argv / env 로 키 재료·passphrase 전달 (`ps` 에 노출). 자식에는 비밀이 아닌 selector(`--ows`, `-w`, `--no-agent`, `--dex`, `--no-builder`)만 넘기고 (설정 env passthrough 없음 — builder fee 는 자식이 settings.json 에서 읽는다), 자식이 OWS vault / agent keystore / `~/.perp/.env` 에서 직접 읽는다. 자식이 읽을 수 없는 비밀(argv `-k`/`--passphrase`/`--ows-key`, shell-only env)이 필요한 백그라운드 잡은 `INVALID_PARAMS` 로 거부 (`src/jobs.ts`, `src/secret-env.ts`, 2026-10-02).
- 키를 argv 로 받기 (`wallet import <key>`, `settings env set <exchange> <key>`) — hidden prompt / stdin 만 허용.

**올바른 패턴:**
- Agent 발급 시: 어떤 거래소든 hot-path 키는 즉시 keystore (OWS wallet 또는 `~/.perp/<dex>-agents/`) 로 write. `settings.agents.<dex>.<name>` 에는 `agentWalletName` 또는 `keystorePath` 등 포인터만 저장. env 손대지 않음.
- 어댑터 init 시: keystore 에서 read → in-memory `_apiKey`. process 종료 시 GC. 평문 디스크 영속화 없음.
- 새 거래소 추가 시: hot-path 키 저장소를 OWS wallet 또는 `~/.perp/<dex>-agents/` 둘 중 하나로 결정 후 SSOT Rule #3 표에 추가. env 변수 신규 도입은 SSOT 검토 필요.

**예 (2026-05-01 적용):** `~/.perp/.env` 의 `LIGHTER_API_KEY` 가 Lighter agent 의 hot-path L2 슬롯 PK 였음. Aster/HL/PAC agent 는 OWS vault 에 들어있는데 Lighter 만 env 평문 — `agent.ts:2170-2182` FIXME 로 이미 알려진 SSOT 결함이었다. 결과: (a) 사용자가 .env 지우면 silent 으로 LT 거래 깨짐, (b) OWS 백업에 LT agent 키 미포함, (c) `wallet rotate` 같은 master-level 작업이 LT slot 키와 분리됨, (d) `wallet show --json` 출력이 OWS active wallet 대신 .env PK 우선시하는 잔재 버그. 해결: `agent.ts:2165-2177` 의 `setEnvVar` 호출을 `~/.perp/lighter-agents/<account>-<slot>.json` keystore write 로 교체, `lighter.ts` 어댑터의 env read 제거, `index.ts` 의 lighter case 가 `loadLighterKey()` 로 PK 로드 후 `setAgentSigner()` 주입. 모듈: `src/agent-wallet/lighter-keystore.ts`. 마이그레이션 헬퍼 `migrateFromEnvIfPresent()` 가 기존 사용자의 env → keystore 1회 이전 + .env entry 삭제까지 자동 처리.

**왜 이 룰이 중요한가:** Rule #2 (fallback 금지) 가 *런타임 흐름* 의 SSOT 라면, Rule #3 은 *영속 상태* 의 SSOT 다. fallback 없이 정직하게 실패하는 코드도, 비밀 자체가 두 곳에 있으면 어느 자리가 정답인지부터 흐려진다. Rule #3 가드가 있어야 신규 거래소 추가 시 또 env 잔재가 생기는 것을 막을 수 있다.

## Reference

- HypurrQuant_FE CLAUDE.md (rule #2 원본): the downstream HypurrQuant_FE repo, `CLAUDE.md` rule #2
- HypurrQuant_FE perp-data-ssot.md (Section 1 case study): the downstream HypurrQuant_FE repo, `docs/guide/web/architecture/perp-data-ssot.md` Section 1
- Lighter keystore module (Rule #3 적용 사례): `src/agent-wallet/lighter-keystore.ts`
