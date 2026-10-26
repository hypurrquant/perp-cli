[English](README.md) | **한국어** | [中文](README.zh.md) | [日本語](README.ja.md)

> 정본은 영문 [README](README.md)이며, 이 번역본은 영문판보다 업데이트가 늦을 수 있습니다.

# perp-cli

[![npm version](https://img.shields.io/npm/v/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![npm downloads](https://img.shields.io/npm/dw/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![license](https://img.shields.io/npm/l/perp-cli.svg)](https://github.com/hypurrquant/perp-cli/blob/main/LICENSE)

멀티 DEX 무기한 선물(perpetual futures) CLI — **Pacifica** (Solana), **Hyperliquid** (HyperEVM), **Lighter** (Ethereum), **Aster** (BNB Chain), **Lighter RH** (Robinhood chain), **Ondo Perps** (오프체인), **Arcus** (Robinhood chain), **QFEX** (오프체인, TradFi perp), **RISEx** (RISE chain — 읽기 전용, 거래 기능은 예정되어 있으나 아직 미지원), **TxFlow** (마켓 데이터 전용 — 비공식 API), **Variational Omni** (마켓 데이터 전용 — 공식 API, RFQ 거래소), **GRVT** (마켓 데이터 전용 — 공식 API, 거래 기능은 예정되어 있으나 아직 미지원), **Extended** (Starknet, 마켓 데이터 전용 — 공식 API, 거래 기능은 예정되어 있으나 아직 미지원), 그리고 **Derive** 옵션 데이터(읽기 전용)를 지원합니다.

```bash
npm install -g perp-cli       # global install
perp --json portfolio

# Or without global install (restricted environments)
npx -y perp-cli --json portfolio
```

이 패키지에는 실행 파일이 **세 개** 포함되어 있습니다(`package.json` `bin`):

| 바이너리 | 설명 | 문서 |
|---|---|---|
| `perp` | CLI 본체 | [커맨드 그룹](#커맨드-그룹), [핵심 커맨드](#핵심-커맨드) |
| `perp-mcp` | Claude Desktop, Cursor 등 MCP 클라이언트용 MCP 서버(stdio) | [MCP 서버](#mcp-서버) |
| `perp-guardrail` | 에이전트 키의 서명 요청을 승인하거나 거부하는 OWS Policy Engine 검사기 | [서명 가드레일](#서명-가드레일-perp-guardrail) |

## 주요 기능

- **13개 perp 거래소** — 8곳에서 거래 가능: Pacifica, Hyperliquid, Lighter, Aster, Lighter RH, Ondo Perps, Arcus, QFEX (브리지 / perp-perp 차익거래는 기존 4곳을 지원). 마켓 데이터 제공: RISEx (읽기 전용, 거래 기능은 예정되어 있으나 아직 미지원), TxFlow (비공식 API, 읽기 전용), Variational (공식 API, 읽기 전용 — 아직 공개 거래 API 없음), GRVT (공식 API, 읽기 전용 — 거래 기능은 예정되어 있으나 아직 미지원), Extended (공식 API, 읽기 전용 — 거래 기능은 예정되어 있으나 아직 미지원). 여기에 **Derive** 옵션 데이터(읽기 전용)까지. [지원 현황표](#지원-현황표) 참고
- **펀딩비 차익거래** — perp-perp + spot-perp 스캔, 그리고 커맨드 한 번으로 양방향 레그 동시 실행
- **포트폴리오** — 한 번의 호출로 모든 거래소의 잔고, 포지션, 리스크 수준 반환
- **자금 관리** — 입금, 출금, 이체, 멀티 프로바이더 브리지(cctp/relay/debridge), 거래소 간 리밸런싱을 하나의 그룹에서 처리
- **봇** — TWAP, 그리드, DCA, 트레일링 스톱 및 백그라운드 작업 관리
- **에이전트 우선 설계** — `--json`, `--fields`, `--ndjson`, `--dry-run`, 런타임 스키마 인트로스펙션
- **안전성** — 주문 전 검증, 응답 새니타이징, client-id 기반 중복 방지

## 지원 현황표

이번 릴리스에서 거래소별로 지원하는 기능을 코드 기준으로 정리했습니다(거래소 정의는 `src/exchanges/venues/*.ts`, `perp-cli/ws` 코덱은 `src/ws/codecs/`, `funds deposit|withdraw` 커맨드, 옵션 레지스트리). ✅ = 구현되어 사용 가능, — = 사용 불가. 이 표는 perp-cli가 **제공하는** 기능을 나타낼 뿐, 실제 자금으로 실행해 본 결과는 아닙니다. 실거래 검증 결과는 [동작 확인 현황 — 메인넷 검증](#동작-확인-현황--메인넷-검증-2026-10-13)을 참고하세요.

| 거래소 | 마켓 데이터 (CLI) | 펀딩비 | WS 스트림 (`perp-cli/ws`) | 주소로 포지션 조회 (`--address`) | 주소로 잔고 조회 (`account balance --address`) | 거래 | perp-cli로 입금 | perp-cli로 출금 | 부가 기능 | API |
|---|---|---|---|---|---|---|---|---|---|---|
| Hyperliquid (`--dex`로 HIP-3 포함) | ✅ | ✅ 1시간 단위 | ✅ public + user (HIP-3 dex는 옵트인) | ✅ (네이티브 + 모든 HIP-3 dex) | ✅ (네이티브(계정 모드 기준) + HIP-3 dex, 현물) | ✅ | ✅ (Arbitrum에서 USDC) | ✅ (CCTP) | 현물, outcome (HIP-4), 네이티브 TWAP | 공식 |
| Pacifica | ✅ | ✅ 1시간 단위 | ✅ public + user | ✅ (Solana 주소) | ✅ (현물 포함) | ✅ | ✅ | ✅ | 현물(통합 마진), 네이티브 TWAP(마스터 서명 전용); Print (`perp print`), Vaults (`perp vault`, 입금은 마스터 전용), Atomic basket (`trade atomic`) — 모두 아직 라이브 검증 전; 레거시 `wallet manage lake`: `create`는 여전히 동작하며 `deposit` / `withdraw`는 거부되고 `perp vault`를 안내 | 공식 |
| Lighter | ✅ | ✅ 1시간 단위 | ✅ public + user | ✅ (모든 서브 계정) | ✅ (모든 서브 계정, 현물) | ✅ | ✅ (L1 또는 CCTP) | ✅ | 현물, 클라이언트 측 TWAP | 공식 |
| Lighter RH | ✅ | ✅ 1시간 단위 | ✅ public + user (메인넷; 테스트넷 WS → HTTP 403) | ✅ (모든 서브 계정) | ✅ (모든 서브 계정, 현물) | ✅ | ✅ (USDG, 메인넷) | ✅ (`-e lighter-rh funds withdraw lighter`) | 현물, 클라이언트 측 TWAP | 공식 |
| Aster | ✅ | ✅ 심볼별 | ✅ public 전용 (user 채널: 알려진 미지원 항목) | — | — | ✅ | ✅ (USDT / USDC, 메인넷) | ✅ (`--can-withdraw --ip-whitelist`가 설정된 에이전트) | 현물, 클라이언트 측 TWAP | 공식 |
| Ondo Perps | ✅ | ✅ 1시간 단위 | — | — | — | ✅ | ✅ (USDC, 메인넷) | — (API에서 허용하지 않음, 웹 앱 이용)⁴ | 현물, 클라이언트 측 TWAP | 공식 |
| Arcus | ✅ | ✅ 1시간 단위 | ✅ public + user | — | — | ✅ | — (웹 앱) | ✅ (계정 소유자에게) | 현물(온체인 스왑), 클라이언트 측 TWAP | 공식 |
| QFEX | ✅ | 미검증 (표시 전용, `--include-unverified`) | — | — | — | ✅ (대기 reduce-only 없음, 자동화 없음 — [QFEX](#qfex) 참고) | 주소만 제공 | — (현재 비활성화, 웹 앱 이용)⁵ | — | 공식 |
| RISEx | ✅ | ✅ 1시간 단위 | — | ✅ | ✅ | — (**읽기 전용**, 거래 기능은 예정되어 있으나 아직 미지원) | — (앱에서만) | — (앱에서만) | 주소 기반 계정 조회 | 공식 |
| TxFlow | ✅ | 미검증 (표시 전용, `--include-unverified`) | — | — | — | — (마켓 데이터 전용) | — | — | — | **비공식** |
| Variational | ✅ (`market book` = 오더북이 아닌 RFQ 호가) | 미검증 (표시 전용, `--include-unverified`); 마켓별 주기 (1h / 4h / 8h) | — | — | — | — (마켓 데이터 전용) | — | — | 주식 / ETF / 원자재; pre-IPO (매칭 대상 아님) | 공식 |
| GRVT | ✅ | 미검증 (표시 전용, `--include-unverified`); 마켓별 주기 (4h / 8h) | — (종목별 스트림만 존재) | — | — | — (이번 버전은 마켓 데이터 전용, 거래 기능은 예정되어 있으나 아직 미지원) | — | — | 주식 / ETF, 원자재; pre-IPO는 매칭 대상 아님 | 공식 |
| Extended | ✅ (크립토 + 주식 / ETF / 원자재 / 지수 / FX) | 미검증 (표시 전용, `--include-unverified`), 1시간 단위; `_24_5` 주식은 장외 시간에 0으로 기록 | — (스트림마다 소켓 하나, 아직 미지원) | — | — | — (읽기 전용) | — | — | 자산군 컬럼; pre-IPO 및 모호한 티커는 매칭 대상 아님 | 공식 |
| Derive | 옵션 전용 (`perp -e derive options …`) | — | — | — | — | — (**읽기 전용**, 거래 기능은 예정되어 있으나 아직 미지원) | — | — | 옵션: 기초자산, 만기, 체인(IV, 그릭스), 호가 | 공식 |

- **펀딩비** ✅ = 펀딩비 단위가 실제 정산된 지급 내역으로 검증된 경우(`fundingVerified`)로, 해당 거래소는 `arb scan` 및 펀딩 전략에 포함됩니다. 미검증 거래소는 `--include-unverified`를 지정했을 때만 표시되며, 순위 산정이나 거래에는 절대 사용되지 않습니다.
- **WS 스트림** = `perp-cli/ws` / `@hypurrquant/perp-ws` 채널: public = 전체 마켓 / 마켓별 상태 및 `bbo`, user = 계정, 포지션, 주문, 체결. `book` / `trades` 채널은 아직 어느 거래소에서도 제공되지 않습니다.
- **주소로 포지션 조회** = `perp -e <venue> account positions --address <addr>` (`-e` 생략 시 아래 모든 거래소) 및 MCP `get_positions_by_address`: 거래소의 공개 데이터로 **임의** 계정의 오픈 포지션을 조회합니다 — 키 불필요, 서명 없음. Pacifica(base58 Solana)를 제외하면 0x 주소를 사용하며, 그 외 거래소는 `CAPABILITY_UNSUPPORTED`로 거부합니다.
- **주소로 잔고 조회** = `perp -e <venue> account balance --address <addr>` (`-e` 생략 시 위의 모든 거래소) 및 MCP `get_balance_by_address`: 거래소의 공개 데이터로 **임의** 계정의 잔고를 조회합니다 — 키 불필요, 서명 없음. 계산 방식은 본인 잔고 조회와 동일합니다(Hyperliquid: 자산 평가액(equity) 소스는 계정의 abstraction 모드를 따름). 거래소가 주소 기준으로 공개하는 경우 현물 토큰 잔고도 포함하며, Lighter는 해당 주소의 계정마다 한 행씩 표시하고(`--account-index`로 범위 축소), Hyperliquid는 계정 가치가 0이 아닌 HIP-3 dex를 표시합니다(조회에 실패한 dex는 경고로 처리 — 0이 아니라 알 수 없음으로 간주). 그 외 거래소는 `CAPABILITY_UNSUPPORTED`로 거부합니다.
- **클라이언트 측 TWAP** = 네이티브 TWAP이 없는 거래소에서 `trade twap` / `strategy twap`이 주문을 분할 실행하는 방식입니다(QFEX에서는 자동화 게이트에 의해 거부됨).

## 설정

```bash
# Import an exchange key into the encrypted OWS vault and make it the active wallet.
# The key is read from a hidden prompt or stdin — never argv (shell history), never ~/.perp/.env.
perp wallet set hl                   # Hyperliquid (EVM) — hidden prompt
pbpaste | OWS_PASSPHRASE="$PP" perp wallet set pac --name pac   # Pacifica (Solana) — piped
# The active wallet serves every venue; one EVM key covers HL / Lighter / Aster.
# Lighter trading also needs: perp wallet agent approve lighter

# Or the interactive setup wizard (every trading venue): picks / creates / imports an OWS
# vault wallet, network, venues, registers agent wallets (y/N confirmation before
# any signature — never moves funds), explains + sets the slippage bound, and the
# default venue. It never writes keys to ~/.perp/.env.
perp setup

# Scriptable (CI / agents) — writes settings only, signs nothing:
perp --json setup --non-interactive --wallet <ows-wallet> --venues hyperliquid,aster \
  --network testnet --default-venue hyperliquid --slippage-bps 50 --slippage aster=80
# Add agent registration explicitly (Ondo key id + secret via stdin only):
OWS_PASSPHRASE=<pp> perp --json setup --non-interactive --wallet <ows-wallet> \
  --venues hyperliquid,arcus --approve-agents --yes --arcus-account-index 0

# Verify
perp wallet show
```

동일한 EVM 키로 Hyperliquid와 Lighter를 모두 사용할 수 있습니다.

> **Lighter API Key Index:** 인덱스 0–3은 Lighter 프런트엔드(웹/모바일)가 예약해 두었습니다. perp-cli는 기본적으로 인덱스 `4`를 사용합니다. `LIGHTER_API_KEY_INDEX` 환경 변수로 변경하거나, 관리형 에이전트 슬롯이 필요하면 `perp wallet agent approve lighter --api-key-index <n>`을 사용하세요. 유효 범위: 4–254.

### Lighter RH, Ondo Perps, Arcus

이 거래소들은 `wallet set` 개인 키 경로를 지원하지 않습니다. 대신 에이전트 / API 키를 등록하세요.

```bash
perp wallet agent approve lighter-rh                  # Lighter RH L2 slot key (USDG collateral, Robinhood chain)
printf '%s\n%s\n' "$KEY_ID" "$SECRET" | perp wallet agent approve ondo   # Ondo HMAC key id + secret, stdin only
perp wallet agent approve arcus --master <ows-wallet> # Arcus Ed25519 API key (OWS wallet agent-arcus-<master>)
perp wallet agent verify [lighter-rh|ondo|arcus]      # no venue = verify every configured venue
```

### 이 컴퓨터에 마스터 지갑이 없는 경우 — 거래소 웹사이트에서 만든 키 가져오기

거래소 웹사이트에서 에이전트 / API 키를 만든 다음 가져오세요. 마스터 지갑은 이 컴퓨터에 있을 필요가 없으며,
공개 주소로만 식별됩니다. 키는 숨김 프롬프트나 stdin으로 읽으며(argv는 사용하지 않음)
**저장하기 전에 거래소에서 먼저 검증합니다** — 검증이 거부되면 아무것도 저장하지 않고,
마스터 없이는 검증할 수 없는 거래소는 `unverified`로 보고하며 절대 검증된 것으로 표시하지 않습니다.

```bash
perp -n testnet wallet agent import hyperliquid                    # API wallet key; master read from HL (userRole)
pbpaste | perp wallet agent import aster --master-address 0xYOU     # signer key; signed /fapi/v3/balance check (works on Aster testnet too)
perp wallet agent import pacifica --master-address <SOL account>   # agent key; UNVERIFIED (Pacifica lists bindings only master-signed)
perp wallet agent import lighter --account-index 123 --api-key-index 5   # slot key; auth token accepted for that slot
perp wallet agent import arcus --master-address 0xOWNER            # Ed25519 key; public key listed ACTIVE for the owner
printf '%s\n%s\n' "$KEY_ID" "$SECRET" | perp wallet agent import ondo
printf '%s\n%s\n' "$PUBLIC_KEY" "$SECRET" | perp wallet agent import qfex --account-id <uuid>   # QFEX: import only (keys are created on the website, 2FA)
perp wallet agent list                                              # SOURCE column: approved | imported

# Setup without any master wallet: one stdin line per --import-agents venue, in order (ondo: 2 lines)
printf '%s\n%s\n' "$HL_AGENT_KEY" "$LT_KEY" | perp --json setup --non-interactive \
  --venues hyperliquid,lighter --import-agents hyperliquid,lighter --yes \
  --lighter-account-index 123 --lighter-api-key-index 5
```

가져온 키로 거래할 수 있습니다. 다만 **입금, 출금, 이체, 브리지, 레퍼럴 설정, 에이전트
승인에는 마스터가 필요합니다**. 마스터가 없으면 `NO_SIGNER_AVAILABLE`("do it on the exchange
website, or add the master with `perp wallet import`")로 실패합니다. CLI는 가져온 키를 폐기하거나 교체할 수 없습니다 —
웹사이트에서 폐기하세요. `perp wallet agent revoke <venue> <name> --local-only`는 로컬 사본을 삭제하고,
`wallet agent import <venue> --agent-name <name> --replace`는 웹사이트에서 새로 만든 키로 교체합니다.
`perp setup`도 거래소마다 같은 선택지를 제공합니다: 이 컴퓨터의 마스터 지갑으로 승인하거나,
웹사이트에서 만든 키를 가져올 수 있습니다(1단계에서 마스터 지갑을 건너뛸 수 있음).

시크릿은 한 곳에만 저장됩니다(`docs/SSOT_RULES.md` Rule #3 참고): Lighter RH → `~/.perp/lighter-rh-agents/`, Ondo → `~/.perp/ondo-agents/<keyId>.json`, Arcus → OWS 지갑 `agent-arcus-<master>`, 가져온 EVM / Solana / Ed25519 키 → OWS 지갑 `agent-{hl,aster,pac,arcus}-import-<name>`(승인된 에이전트 지갑과 마찬가지로 빈 패스프레이즈), 가져온 Lighter 키 → 네트워크 태그가 붙은 Lighter 키스토어. 이제 지갑/키가 없으면 조용히 읽기 전용으로 대체하는 대신 `KEY_NOT_FOUND` / `NO_SIGNER_AVAILABLE`로 실패합니다.

## 거래소

| 거래소 | `-e` id (별칭) | 거래 | 비고 |
|-------|-------------------|---------|-------|
| Pacifica | `pacifica` (`pac`) | 지원 | Solana |
| Hyperliquid | `hyperliquid` (`hl`) | 지원 | HyperEVM; `--dex`로 HIP-3 dex 사용 |
| Lighter | `lighter` (`lt`) | 지원 | Ethereum L2 |
| Aster | `aster` (`ast`) | 지원 | BNB Chain; 펀딩 주기는 심볼별로 다름 |
| Lighter RH | `lighter-rh` (`lrh`, `rh`) | 지원 | Robinhood chain 위의 Lighter 엔진, USDG 담보 |
| Ondo Perps | `ondo` (`ondo-perps`) | 지원 | 오프체인 엔진; 지정가 TIF GTC(기본값) / IOC / ALO; 이용 제한 지역: US, PA |
| QFEX | `qfex` (`qf`) | 지원 (아래 **QFEX** 참고) | 수탁형, 오프체인 엔진; 주식 / 지수 / 원자재, 교차 마진, USDC; 지정가 TIF GTC(기본값) / IOC / FOK / ALO; 테스트넷 = QFEX UAT; 이용 제한 지역: US, GB, ES 등 |
| Arcus | `arcus` | 지원 | Robinhood chain, USDG 담보; 지정가 TIF GTC(기본값, GTT로 전송) / IOC / FOK / ALO; 이용 제한 지역: US, CA, GB; **접근 화이트리스트** — 등록되지 않은 주소는 거부됨(arcus.xyz에서 접근 요청) |
| RISEx | `risex` (`rise`) | **미지원 — 읽기 전용** (거래 기능은 예정되어 있으나 아직 미지원, 아래 **RISEx** 참고) | RISE chain 위의 완전 온체인 오더북, USDC; 공식 API. 마켓 데이터, 펀딩비, 주소 기반 계정 조회 지원; 모든 거래 / 에이전트 / 봇 경로 → `CAPABILITY_UNSUPPORTED`; 입출금은 RISEx 앱에서만 가능 |
| Variational | `variational` (`var`, `omni`) | **미지원 — 마켓 데이터 전용** (아래 **Variational** 참고) | RFQ 거래소인 Variational Omni(마켓 메이커 하나, 오더북 없음); 공식 읽기 전용 API, 아직 공개 거래 API 없음. 펀딩비는 미검증(`--include-unverified`를 지정했을 때만 표시); 이용 제한 지역: US, CA 등 |
| GRVT | `grvt` (`grv`) | **미지원 — 이번 버전은 마켓 데이터 전용** (거래 기능은 예정되어 있으나 아직 미지원, 아래 **GRVT** 참고) | 하이브리드 perp 거래소, USDT 담보; 공식 Market Data API. 펀딩비는 미검증(`--include-unverified`를 지정했을 때만 표시); 테스트넷 = `-n testnet`; 거래에는 KYC 필요; 이용 제한 지역: US, CA, SG, HK 등 |
| Extended | `extended` (`ext`, `x10`) | **미지원 — 이번 버전은 마켓 데이터 전용** (거래 기능은 예정되어 있으나 아직 미지원, 아래 **Extended** 참고) | Starknet 위의 perp 오더북(구 X10), USD 담보; 공식 공개 API. 크립토와 RWA(주식, ETF, 지수, 원자재, FX). 펀딩비는 미검증(`--include-unverified`를 지정했을 때만 표시); 테스트넷 = Sepolia(`-n testnet`); 이용 제한 지역: US, GB, CA, HK 등 |
| TxFlow | `txflow` (`txf`) | **미지원 — 마켓 데이터 전용** | **비공식 API**: TxFlow는 아직 공식 API가 없으며, perp-cli는 웹 앱이 사용하는 비공개(문서화되지 않은) API를 읽습니다. 사전 고지 없이 변경되거나 동작하지 않을 수 있습니다. 펀딩비는 미검증(`--include-unverified`를 지정했을 때만 표시) |

- **Time in force:** `trade limit`은 모든 거래소에서 기본값이 `GTC`입니다(공통 명칭 `GTC | IOC | FOK | ALO`; 거래소가 제공하지 않는 TIF → `CAPABILITY_UNSUPPORTED`). Lighter의 post-only(`ALO`)는 거래소에서 검증될 때까지 비활성화되어 있습니다.
- **진입 시 TP/SL:** `trade market|buy|sell|limit ... --tp <px> --sl <px>`는 모든 거래소에서 같은 의미입니다 — *이 진입 주문의 검증된 체결분을 보호*합니다. 방향은 주문 전송 전에 검사합니다(롱: tp > 기준가 > sl, 숏: 그 반대; 기준가 = 시장가 진입은 마크 가격, 지정가 진입은 지정가). Ondo는 레그를 주문에 첨부하고, Arcus는 진입+TP/SL을 배치로 전송합니다. Hyperliquid / Lighter / Aster는 진입 체결을 확인한 뒤 체결 수량에 맞춘 reduce-only TP/SL 트리거 주문을 넣습니다(시장가 또는 `--tif IOC` 진입만 가능 — 대기 주문 진입 → `CAPABILITY_UNSUPPORTED`). Pacifica는 체결을 확인한 뒤 포지션 TP/SL을 설정합니다(해당 심볼에 이미 포지션이나 TP/SL이 있으면 거부 — 절대 덮어쓰지 않음). 진입 결과를 알 수 없으면 → `ORDER_PENDING`이며 TP/SL은 **설정되지 않습니다**(포지션이 보호되지 않은 상태일 수 있음). 진입은 체결됐지만 레그 하나가 실패하면 → `ORDER_PARTIAL`(재시도 불가)로, 진입 결과와 어떤 레그가 설정됐는지 함께 반환합니다 — 재진입하지 말고 `trade tpsl`로 마무리하세요.
- **포지션에 TP/SL 설정:** `trade tpsl <SYM> <long|short> --tp <px> --sl <px> [--tp-limit <px>] [--size <n>]` — 인자는 **포지션의** 방향이며(buy/sell은 더 이상 받지 않음) 실제 포지션과 대조합니다. 레그는 reduce-only이며 실제 포지션 크기(또는 `--size`)에 맞춰집니다.
- **스톱 주문은 모든 거래소에서 기본적으로 reduce-only입니다**(`trade stop`). 스톱으로 포지션을 열거나 뒤집으려면 `--no-reduce-only`를 지정하세요(스톱이 항상 reduce-only인 Ondo와 QFEX에서는 거부). Lighter / Arcus의 시장가 트리거는 트리거 가격 ± 슬리피지 한도(`--slippage-bps` 또는 설정값)의 지정가로 실행되므로 급변 장세에서는 체결되지 않을 수 있습니다. 다른 거래소는 네이티브 시장가 트리거를 사용합니다(`--slippage-bps` → `CAPABILITY_UNSUPPORTED`).
- **주문 수정:** `trade edit`은 주문의 TIF를 유지합니다. Pacifica: post-only(ALO) 주문은 네이티브로 수정되고, perp-cli가 넣은 GTC / TOB 주문(TIF가 client order id에 기록됨)은 취소 후 남은 미체결 수량으로 다시 주문합니다. TIF를 알 수 없는 주문 → `CAPABILITY_UNSUPPORTED`(`--tif` 지정 필요).
- **슬리피지 한도:** 모든 시장가 계열 주문(진입, 청산, 현물)은 하나의 값으로 제한됩니다: `--slippage-bps <n>` → `settings.slippageBps.<venue>` → `settings.defaultSlippageBps`(기본 제공값 50, `perp settings show`에서 확인; `perp settings set defaultSlippageBps <n>`으로 변경). 1..거래소 최대값(Arcus 1000) 범위를 벗어난 값은 전송 전에 거부됩니다.
- **이용 제한 지역:** 이용 제한 지역이 있는 거래소(Ondo, Arcus, QFEX)의 서명 어댑터를 생성하면 stderr에 한 번 안내가 출력됩니다. 실행을 막지는 않으니 거래소 약관은 직접 확인하세요.
- **통합 뷰**(`portfolio`, `account positions/orders`, `risk`, `history`, `wallet agent verify`, MCP `portfolio`)는 자격 증명이 설정된 모든 계정 거래소를 포함합니다.

### 동작 확인 현황 — 메인넷 검증 (2026-10-13)

아래 표시는 모두 코드를 읽고 판단한 것이 아니라 실제 자금으로 메인넷에서 실행한 결과입니다 — 거래소 최소 주문 단위로 실행했으며, 다중 분할 / 다중 레벨 검증에서는 거래소별 상한을 약 $25–30로, Hyperliquid TWAP에서는 약 $110로 올렸습니다.

✅ 라이브 검증 완료 · ⛔ 미지원 (전송 전에 거부) · ❌ 구현되었으나 아직 메인넷 미실행 · — 거래소에서 제공하지 않음

| 기능 | HL | HIP-3 `xyz` | Pacifica | Lighter | Lighter RH | Aster | Ondo | Arcus | QFEX |
|---|---|---|---|---|---|---|---|---|---|
| 시장가 / 지정가 (GTC, ALO, IOC), 취소, 수정, 청산, 축소, 전체 청산, 상태 조회 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 진입 시 `--tp/--sl`, `trade tpsl`, `trade stop` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 스톱 리밋 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ |
| 대기 reduce-only 지정가 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ (IOC만 가능) |
| Client order id (주문 / 상태 조회 / 취소) | ✅ | ✅ | ✅³ (UUID) | ✅ (숫자) | ✅ (숫자) | ✅ | ✅ | ✅ | 생성된 id만 가능 |
| 격리 마진 (설정, 포지션과 함께 재조회, 원복) | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ (거래소가 `-4050`으로 거부, 원인 불명) | ⛔ | ✅ | ⛔ |
| `trade scale-in` / `scale-tp` | ✅ | ✅ (포지션 ≥ $20.5) | ✅ | ✅ | ✅ | ✅ | scale-in ✅ / scale-tp ⛔ — 부분 `trade tpsl --size` 사용 ✅ | ✅ | scale-in ✅ / scale-tp ⛔ |
| `trade split` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `trade multi` (여러 거래소에 걸친 레그) | ✅ | ✅ (전역 `--dex xyz`) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 네이티브 TWAP (`trade twap`) | ✅ | ❌ (HL 최소 $100) | ✅ 마스터 서명 / ⛔ 에이전트 서명 | —² | —² | —² | —² | —² | —² |
| 클라이언트 측 TWAP (다른 거래소의 `trade twap`, `strategy twap`, `--background`) | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ (자동화 게이트) |
| 포지션 보유 중 `account margin` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 현물 (`trade spot-*`) | ✅ | — | ✅ | ✅ | ✅ | ❌ (USDT 필요) | ✅ | ❌ (Arcus 발급 키 필요) | — |
| perp-cli로 입금 | ✅ | (HL) | ✅ | ✅ | ✅ | ✅ | ✅ | — (웹 앱) | — (주소만 제공) |
| 출금 (본인 주소로)⁶ | ✅ | (HL) | ✅ | ✅ | ✅ | ✅ (`--asset USDC`) | ⛔⁴ | ✅ | ⛔⁵ |

RISEx, TxFlow, Variational, GRVT, Extended는 이번 릴리스에서 거래를 지원하지 않으므로 이 표에 없습니다. RISEx 거래 기능(포함되어 있으나 0.15.0부터 비활성화)은 **테스트넷**에서만 실행해 봤으며(2026-10-14), 메인넷 RISEx 주문은 실행한 적이 없습니다.

² 이 거래소에는 perp-cli의 네이티브 TWAP이 없어 `trade twap`이 대신 클라이언트 측 TWAP(분할 주문)을 실행합니다. 거래소 API가 TWAP을 제공하는지는 확인하지 않았습니다.  
³ 세션에서 검증했으나 저장된 로그 파일은 없습니다.  
⁴ 사용 불가: Ondo Perps API는 출금을 허용하지 않습니다(`funds withdraw ondo` → `CAPABILITY_UNSUPPORTED`). Ondo 웹 앱에서 출금하세요.  
⁵ 현재 perp-cli에서 비활성화되어 있습니다(`funds withdraw qfex` → `CAPABILITY_UNSUPPORTED`). QFEX 웹 앱에서 출금하세요.  
⁶ 메인넷, 2026-10-13: 거래소마다 계정 본인 주소로 한 번씩 출금하고, 도착 체인에서 수령 금액을 확인했습니다 — `funds withdraw hyperliquid 12.22` (Arbitrum USDC), `funds withdraw pacifica 12.98` (Solana USDC), `-e lighter funds withdraw lighter 15.95` (Ethereum USDC), `-e lighter-rh funds withdraw lighter 12.96` 및 `funds withdraw arcus 9.94` (Robinhood Chain USDG), `funds withdraw aster 8.74 --chain arbitrum --asset USDC` (Arbitrum USDC).

자동화 기능 라이브 검증 결과(최소 크기로 제한된 실행, 이후 중지하고 포지션을 모두 정리함):

| 영역 | 검증 항목 |
|---|---|
| 차익거래 | Aster–Arcus, Lighter–Arcus에서 `arb exec` / `status` / `close`; `arb auto` (Lighter–HL); spot-perp `arb exec <sym> spot:hl pacifica` 및 `arb close`; `strategy funding-arb`, `quick-arb`, `funding-auto` (Pacifica–HL); `strategy delta-neutral` (HL 현물 + Pacifica perp) |
| 봇 | `strategy grid` / `dca` / `trailing-stop` / `quick-grid` / `quick-dca` / `preset` (Aster); `strategy start <config>`를 통한 12개 엔진 전략 전체 (Aster); `strategy apex` (Aster) |
| 실행 헬퍼 | `strategy twap` (Aster), `trade twap --background` (Arcus), `strategy plan execute` (액션 유형 10개 중 9개 — `cancel_order`는 미실행), `perp background stop` (정상 종료: 주문 취소, 포지션 목록 출력) |
| Hyperliquid HIP-4 outcome | GTC 주문 / 취소, IOC 매수, `outcome sell --all` / `--size` |

자금 및 브리지 라이브 검증 결과(메인넷, 2026-10-13 — `funds bridge send` 실행, $11 HL 입금 후 `funds rebalance plan` + `execute --withdraw-only`, 채널 없이 알림 규칙 커맨드 실행):

| 영역 | 검증됨 | 미검증 |
|---|---|---|
| `funds bridge send` | deBridge Arbitrum → Solana USDC (OWS 서명); Relay 스왑 Arbitrum ETH → Robinhood ETH, Robinhood USDG → Solana SOL / USDC, Robinhood USDG → Arbitrum USDC | CCTP 경로; **Solana 출발** 브리지 전체 (OWS Solana 서명 경로는 mock 테스트로만 검증) |
| `funds bridge exchange` | — | 전부; HyperCore → Solana CCTP 경로(`--from hyperliquid --to pacifica`)는 동작하지 않는 것으로 의심됨 (Solana 수신자 인코딩) |
| `funds rebalance` | `plan`; `execute --withdraw-only` (HL → Arbitrum) | `execute --auto-bridge` (아직 가스 사전 확인 없음) |
| `funds transfer` | — | HL `usdSend`, QFEX 계정 간 이체 (수신 계정 필요) |
| 알림 | 규칙 `add` / `list` / `remove`; 채널이 없으면 `test` / `start`는 거부 | Telegram / Discord 전송 (봇 토큰 필요) |

아직 메인넷에서 실행하지 않은 항목: 서브 계정, 빌더 수수료, `strategy claude-agent` (Anthropic 키 필요), 대시보드.

### QFEX

QFEX는 수탁형 거래소로, 지갑 서명이 없습니다. 유일한 자격 증명은 **QFEX 웹사이트에서 생성한 API 키**(Developer Settings, 2FA)이며, `perp wallet agent import qfex`로 가져옵니다(공개 키 + 시크릿을 숨김 프롬프트 / stdin으로 입력하며, `~/.perp/qfex-agents/`에 암호화 저장). 가져오기 과정에서 해당 키로 거래하는 **계정 UUID 하나**(primary 또는 `--account-id <uuid>`)를 확인해 보여 주며, 사용자가 확인하기 전까지는 아무것도 저장하지 않습니다(파이프 입력 시: 동일한 값을 `--account-id`로 전달). 거래용 키는 "Deposit and withdraw" 권한 **없이** 생성하세요.

```bash
perp -n testnet wallet agent import qfex              # QFEX UAT (api.qfex.io); y/N on the resolved account
perp -e qfex market list                              # public: /refdata + market-data snapshot
perp -e qfex trade limit AAPL buy 320 0.01            # GTC: "accepted" after the ACK; "open" once listed (trade status)
perp -e qfex trade market AAPL buy 0.01               # IOC LIMIT at mark ± slippage (never the venue's unbounded MARKET)
perp -e qfex trade status c:<id> --symbol AAPL        # by the generated client order id
perp funds deposit qfex                               # prints the USDC / Arbitrum One deposit address; you send the funds
```

QFEX 프로덕션에서 검증 완료(2026-10-13): `trade close` / `close-all` / `flatten` / `reduce` (reduce-only **IOC**로 전송), `trade stop`, `trade tpsl` (양쪽 레그), `--sl`을 붙인 시장가 진입, `trade edit` (네이티브 수정 — 주문 id는 새로 발급되지만 client id는 유지되므로 `c:<id>`를 계속 사용 가능), `c:<id>`로 취소 / 상태 조회.

perp-cli가 **QFEX에서 여전히 거부하는** 항목(전송 전에 일괄적으로 `CAPABILITY_UNSUPPORTED`):

| 거부 항목 | 이유 | 대안 |
|---|---|---|
| 대기 reduce-only 주문 (GTC / ALO의 `trade limit --reduce-only`, `trade scale-tp`) | 라이브 확인 결과: 대기 중인 reduce-only 주문이 **포지션이 0이 된 뒤에도 열린 채로 남습니다**. 이후 체결될 경우 거래소가 어떻게 처리하는지는 검증되지 않았습니다 | reduce-only IOC (`trade close` / `reduce`), 또는 `trade stop` / `trade tpsl` |
| 스톱 리밋 (`--tp-limit`, 지정가를 붙인 `trade stop`) | 거래소의 스톱 주문은 트리거되면 시장가 주문으로 전환됩니다 | 스톱 마켓 |
| 포지션을 열거나 뒤집는 스톱 (`trade stop --no-reduce-only`) | QFEX 스톱 주문은 포지션 축소만 가능합니다 | reduce-only 스톱 |
| reduce-only 주문의 `trade edit` | reduce-only 주문은 주문 시점에 실제 포지션 기준으로 크기를 검사하는데, 수정하면 이 검사를 건너뛰게 됩니다 | `trade cancel` 후 다시 주문 |
| `--client-id` | 거래소에서 client id가 고유하지 않으므로, perp-cli는 자신이 생성한 id만 신뢰합니다 | 생략 (생성된 id가 보고됨) |
| USD로 호가되지 않는 마켓 (`SKHYNIX-KRW`, …) | 주문 크기, 리스크 한도, 명목 금액은 USD를 전제로 합니다 | QFEX 웹 앱 |
| QFEX 무인 자동화: 봇, 플랜, TWAP, DCA, 그리드, 펀딩비 차익거래, 트레일링 스톱, 백그라운드 작업; `arb scan` 순위에서 QFEX | 검증 전까지 자동화가 차단되어 있습니다(`QFEX_AUTOMATION_VERIFIED`). 펀딩비 단위가 검증되지 않았고, 주식 펀딩은 한 주 중 일부 기간에만 발생합니다(Q4) | QFEX는 수동으로 거래; 펀딩비 조회만: `perp arb scan --rates --include-unverified` |

알려진 주의 사항: 포지션이 청산된 직후 스톱 / TP를 취소하면, 거래소가 스톱을 직접 삭제하는 동안 "unexpected error"가 응답될 수 있습니다. QFEX는 스톱 주문 기록을 보관하지 않으므로 perp-cli는 취소 여부를 증명할 수 없어 `ORDER_PARTIAL`(pending)을 보고합니다 — `perp -e qfex account orders`를 확인해 아무것도 나오지 않으면 스톱이 삭제된 것입니다.

주문 결과는 절대 추측하지 않습니다: IOC / 시장가 주문은 거래소의 종결 프레임을 받았을 때만 확정됩니다(체결 없음 → `ORDER_REJECTED`, `reason: iocNoFill`). 주문 전송 후 결과가 불분명하면 확인용 `c:<id>`와 함께 `ORDER_PENDING`을 반환합니다 — 절대 재전송하지 마세요. perp-cli는 QFEX cancel-on-disconnect를 절대 활성화하지 않지만, **같은 사용자의 다른 연결(예: 공식 QFEX CLI)이 이를 활성화했다면 그 연결이 끊길 때 계정의 모든 주문이 취소됩니다**.

**출금**은 현재 perp-cli에서 비활성화되어 있습니다(`funds withdraw qfex` → `CAPABILITY_UNSUPPORTED`, `--dry-run`에서도 동일). QFEX 웹 앱에서 출금하세요. 서브 계정: `perp -e qfex funds transfer <amount> primary --from <account uuid>`.

### RISEx (읽기 전용 — 거래 기능은 예정되어 있으나 아직 미지원)

RISEx는 RISE chain 위의 완전 온체인 perp 오더북(USDC 담보)으로, **공식** API를 통해 연결합니다. 신규 거래소는 단계적으로 출시됩니다. 이번 릴리스에서 perp-cli는 RISEx 데이터 조회만 지원하며, 거래 기능은 이후 릴리스에서 제공됩니다.

```bash
perp -e risex market list                     # public; funding = last settled hourly rate (verified)
perp -e risex market book BTC                 # also: prices | info | trades | kline | funding
perp arb scan --rates                         # RISEx rows in the funding comparison
perp health                                   # RISEx is probed as an official venue
perp -e risex account positions --ows <master>   # account reads are public by address — nothing is signed
```

- **이번 릴리스에서 거부되는 항목** (`CAPABILITY_UNSUPPORTED`, "RISEx trading is planned for a later perp-cli release", 키를 읽거나 요청을 보내기 전에 거부 — `--dry-run`에서도 동일): 모든 `perp -e risex trade …` 쓰기 작업, `trade multi` / `arb exec` / `arb auto` 레그, 모든 `strategy …` 커맨드(봇, 플랜, TWAP / 그리드 / DCA, `--exchanges` 레그), `wallet agent approve|import|revoke|rotate risex`(`revoke --force`는 로컬 기록만 삭제), `perp setup --venues risex`, `funds faucet risex`, 그리고 MCP `trade_preview` / `trade_execute` / `trade_close` 도구. `arb scan --basis`는 거래 가능한 거래소만 다루므로 RISEx는 포함되지 않으며, `arb scan`에서 RISEx 레그가 있는 페어는 `executable: false` / "(read-only)"로 표시됩니다.
- **자금:** 입출금은 RISEx 앱(app.rise.trade)에서 진행합니다. `funds deposit|withdraw risex`, `funds transfer -e risex`, risex가 포함된 `funds rebalance execute`는 `CAPABILITY_UNSUPPORTED`로 거부됩니다(`--dry-run`에서도 동일).
- 거래 코드(온체인에서 거래 전용으로 제한된 세션 서명자, EIP-712 permit)는 테스트와 함께 포함되어 있지만 플래그 하나(`src/exchanges/venues/risex-release.ts`의 `RISEX_TRADING_ENABLED`)로 꺼져 있습니다.

### TxFlow (마켓 데이터 전용 — 비공식 API)

TxFlow는 아직 공식 API를 공개하지 않았습니다. perp-cli는 app.txflow.com이 사용하는 **문서화되지 않은** API를 읽습니다 — 읽기 전용이며, 언제든 변경되거나 차단될 수 있습니다. 모든 JSON 행에는 `venueApi: "unofficial"`(혼합 테이블과 MCP 출력에서는 `apiStatus`)이 포함되며, 사람이 읽는 출력에는 각주가 추가됩니다.

```bash
perp -e txflow market list | info <SYM> | book <SYM> | trades <SYM> | kline <SYM> 1h
perp arb scan --rates --include-unverified                  # TxFlow funding (percent per hour on the venue, shown as a fraction), display only
```

모든 거래 / 계정 / 포트폴리오 / 자금(입금, 출금, 이체, 리밸런싱) / 에이전트 / 빌더 / 전략 / arb exec 커맨드와 모든 MCP 계정·거래 도구는 요청을 보내기 전에 TxFlow를 `CAPABILITY_UNSUPPORTED`로 거부합니다. 펀딩비 내역과 테스트넷은 없으며, 펀딩 주기가 1시간임을 증명할 수 없는 마켓은 펀딩비를 알 수 없음으로 표시합니다.

### Variational (마켓 데이터 전용 — 공식 API)

Variational Omni는 RFQ 거래소입니다. 단일 마켓 메이커(OLP)가 모든 거래의 호가를 제시하므로 오더북이 없습니다. perp-cli는 **공식** 문서화된 읽기 전용 API를 읽습니다(모든 마켓을 `GET /metadata/v2/stats` 한 번으로 조회해 5초간 공유, 거래소 제한은 IP당 10초에 10회 요청). Variational은 아직 공개 거래 API가 없습니다.

```bash
perp -e variational market list | prices | info <SYM>   # perps by base (BTC), swaps keep the suffix (XAU-SWAP)
perp -e variational market book BTC                      # the OLP's indicative RFQ quotes at fixed sizes — not an order book
perp -e variational market funding BTC                   # current terms: per interval (1h / 4h / 8h per market), hourly, APR
perp arb scan --rates --include-unverified               # Variational funding rows, display only
perp health                                              # probed as an official venue
```

- **펀딩비는 미검증입니다:** 공개되는 펀딩비는 다음 지급에 대한 변동 예측값이며, 공개 계정 API가 없어 실제 정산된 지급 내역과 대조할 수 없습니다. 따라서 `--include-unverified`를 지정했을 때만 표시되며, 순위 산정이나 거래, 펀딩비 내역 저장에는 절대 사용되지 않습니다. 펀딩비 내역 엔드포인트도 없습니다.
- **심볼:** TradFi perp(주식, ETF, 원자재)는 명시적으로 분류됩니다. `US500-PERP`는 SPDR S&P 500 ETF이며(`SPY`로 비교), pre-IPO 마켓, 스왑, `SPX`(SPX6900), `QNT`(Quant)는 거래소 간에 절대 매칭하지 않습니다. 지수 가격, 틱, 랏, 레버리지, 기초자산 단위 미결제약정은 공개되지 않습니다(`-` / null로 표시).
- **거부 항목** (`CAPABILITY_UNSUPPORTED`, 요청 전에 거부 — `--dry-run`에서도 동일): 모든 거래 / 계정 / 포트폴리오 / 자금 / 에이전트 / 빌더 / 전략 / arb exec 커맨드와 모든 MCP 계정·거래 도구. 테스트넷과 WebSocket은 없습니다.

### GRVT (마켓 데이터 전용 — 공식 API)

GRVT는 하이브리드 perp 거래소(오프체인 매칭, USDT 담보)입니다. perp-cli는 키가 필요 없는 **공식** Market Data API(`POST https://market-data.grvt.io/full/v1/…`, 테스트넷 `-n testnet`)를 읽습니다. 이번 버전에서 GRVT는 읽기 전용이며, 거래 기능은 이후 릴리스에서 제공될 예정입니다.

```bash
perp -e grvt market list | prices | info <SYM>   # base tickers (BTC, KPEPE, XAU, AAPL); BTC_USDT_Perp also accepted
perp -e grvt market book BTC                      # order book (10 / 50 / 100 / 500 levels served)
perp -e grvt market funding BTC                   # settled funding history (per 4h / 8h interval)
perp -e grvt market trades | kline BTC …          # public tape / candles
perp arb scan --rates --include-unverified        # GRVT funding rows, display only
perp health                                       # probed as an official venue
```

- **펀딩비는 미검증입니다:** 주기는 마켓별로 다르며(4h 또는 8h), 마켓 행에는 진행 중인 주기에 대한 GRVT의 예상 펀딩비(`fundingRateKind: "predicted"`)가 퍼센트에서 주기당 소수로 변환되어 들어갑니다. 실제 정산된 지급 내역과 대조하지 않았으므로 `--include-unverified`를 지정했을 때만 표시되며, 순위 산정이나 거래에는 절대 사용되지 않습니다.
- **심볼:** 크립토는 티커 기준, 주식 / ETF는 검토된 목록의 티커 기준입니다. XAU / XAG / CL / BZ → GOLD / SILVER / WTI / Brent. pre-IPO 마켓(OPENAI, ANTHROPIC, SPACEX)과 모호한 티커는 거래소 간에 절대 매칭하지 않습니다. 랏 단위는 공개되지 않으며(`stepSize` null), 최대 레버리지는 GRVT 마진 규칙에서 가져옵니다(`market list|prices|info`, 최대 6시간 캐시 — `leverageAsOf`).
- **요청:** GRVT에는 일괄 티커 API가 없어 전체 마켓을 읽으려면 마켓마다 티커를 하나씩 요청해야 하며(~185회 요청, ~5초), 결과는 15초간 재사용합니다. 문서화된 제한(티커는 분당 1500회, 그 외는 분당 500회)은 거래소 리미터가 적용합니다.
- **거부 항목** (`CAPABILITY_UNSUPPORTED`, "GRVT is read-only (market data) in this version; trading is planned for a later release", 요청 전에 거부 — `--dry-run`에서도 동일): 모든 거래 / 계정 / 포트폴리오 / 자금 / 에이전트 / 빌더 / 전략 / arb exec 커맨드, `setup --venues grvt`, 모든 MCP 계정·거래 도구. `perp-cli/ws` 코덱은 없습니다(GRVT 스트림은 종목별이며, 마켓 수보다 적은 개수로 제한됨).

### Extended (마켓 데이터 전용 — 공식 API)

Extended(구 X10)는 Starknet 위의 perp 오더북(USD 담보)으로, 크립토와 RWA 마켓(주식, ETF, 지수, 원자재, FX)을 상장하고 있습니다. perp-cli는 키가 필요 없는 **공식** 공개 API(`https://api.starknet.extended.exchange/api/v1`, 테스트넷 Sepolia `-n testnet`)를 읽습니다. 이번 버전에서 Extended는 읽기 전용이며, 거래 기능은 이후 릴리스에서 제공될 예정입니다.

```bash
perp -e extended market list | prices | info <SYM>   # base tickers (BTC, TSLA, SPX500M); wire names (TSLA_24_5-USD) also accepted
perp -e extended market book TSLA                     # order book (RFQ markets: the indicative book)
perp -e extended market funding ETH                   # applied hourly funding prints
perp -e extended market trades | kline BTC …          # public tape / candles
perp arb scan --rates --include-unverified            # Extended funding rows, display only
perp health                                           # probed as an official venue
```

- **펀딩비는 미검증입니다:** 1시간에 한 번 적용되며, 시간당 소수로 소수점 6자리에서 반올림됩니다. 마켓 행에는 현재 시간에 누적 중인 펀딩비(`fundingRateKind: "accruing"`)가 들어가고, `market funding`은 적용된 기록을 보여 줍니다. 계정의 펀딩 지급 내역과 대조하지 않았고, `_24_5` 주식은 기초자산 시장이 닫혀 있는 동안 0으로 기록되므로 `--include-unverified`를 지정했을 때만 표시되며, 순위 산정이나 거래에는 절대 사용되지 않습니다.
- **심볼:** `_24_5` 접미사를 뗀 자산명입니다(`TSLA_24_5-USD` → `TSLA`). `market list`에는 자산군 컬럼이 표시됩니다. 크립토는 티커 기준, 주식 / ETF도 티커 기준이며, XAU / XAG / WTI / XBR → GOLD / SILVER / WTI / Brent, SPX500M / TECH100M → SPX / NDX로 매핑됩니다. pre-IPO 마켓, 다른 곳에서는 크립토 티커인 RWA 티커(PURR, QNT, BB, ON, ADI, BOT), XIAOMI, 크립토 `SPX`(SPX6900)는 거래소 간에 절대 매칭하지 않습니다.
- **거부 항목** (`CAPABILITY_UNSUPPORTED`, "Extended is read-only (market data) in this version; trading is planned for a later release", 요청 전에 거부 — `--dry-run`에서도 동일): 모든 거래 / 계정 / 포트폴리오 / 자금 / 에이전트 / 빌더 / 전략 / arb exec 커맨드, `setup --venues extended`, 모든 MCP 계정·거래 도구. `perp-cli/ws` 코덱은 없습니다(Extended 스트림은 스트림 URL마다 소켓이 하나씩이며, 구독 프레임이 없음).

### 옵션 마켓 데이터 — Derive (읽기 전용)

공식 공개 API를 통한 Derive(derive.xyz) 옵션 데이터 — 키 불필요, 주문·계정·서명 없음(거래 기능은 예정되어 있으나 아직 미지원). Derive는 perp 거래소가 아니므로 `-e derive`는 `perp options`에서만 동작합니다.

```bash
perp --json -e derive options underlyings
perp --json -e derive options expiries ETH
perp --json -e derive options chain ETH --expiry 2026-12-25 --strikes 10   # bid/ask, mark, IV, greeks, OI per strike
perp --json -e derive options quote ETH-20261225-3500-P
```

### 현물 거래

현물 지원 여부는 거래소별로 선언되며(`VenueDefinition.spot`), 모든 현물 커맨드, 포트폴리오 뷰, 봇은 하나의 팩토리를 거칩니다. 심볼 형식은 `BASE/QUOTE`이며, 기초자산만 지정하면(`ETH`) 거래소의 첫 번째 호가 자산을 사용합니다.

| 거래소 | 계정 모델 | 호가 자산 | 지정가 / 오더북 / 취소 | 현물↔perp 이체 |
|-------|---------------|-------|-----------------------|--------------------|
| Hyperliquid | 런타임 결정 (통합 계정은 perp와 USDC를 공유, 표준 계정은 분리) | USDC | 지원 | 지원 (통합 계정에서는 no-op) |
| Lighter / Lighter RH | 분리 | USDC / USDG | 지원 | 지원 |
| Aster | 분리 (`sapi` 현물 계정) | USDT, USD1 (기초자산만 지정 시 → USDT) | 지원 | 지원 |
| Pacifica | **통합** — 현물이 perp 계정을 공유 | USDC | 지원 | 미지원 (필요 없음) |
| Ondo Perps | 분리 (현물 지갑 ↔ 마진) | USDC | 지원 | 지원 |
| Arcus | **지갑** — 마스터 EVM 지갑에서 온체인 스왑 (라우터, Permit2) | USDG | 미지원 (시장가 스왑만 가능) | 미지원 |

```bash
perp --json -e <EX> trade spot-buy <SYM> <SIZE> [--slippage-bps <n>] [--yes]
perp --json -e <EX> trade spot-sell <SYM> <SIZE> [--slippage-bps <n>] [--yes]
perp --json -e <EX> trade spot-limit <SYM> <buy|sell> <PRICE> <SIZE> [--tif GTC|IOC|ALO]
perp --json -e <EX> trade spot-cancel <SYM> <ORDER_ID>
perp --json -e <EX> trade spot-orders [SYM]
perp --json -e <EX> trade spot-transfer <to-spot|to-perp> <AMOUNT>   # moves the venue's first quote asset
perp --json -e <EX> trade spot-balance
```

- **지원하지 않는 작업은 명확하게 실패합니다** — `CAPABILITY_UNSUPPORTED` (예: Arcus에서 `spot-limit` / `spot-cancel` / `spot-orders` / `spot-transfer`).
- **잔고 공유 계정에서의 `spot-transfer`** (Pacifica, Hyperliquid 통합 계정)는 `execution.method: "sharedAccount"`와 함께 no-op으로 성공합니다(옮길 것이 없음). 실제로 이체되면 `execution.method: "transfer"`를 보고합니다.
- **슬리피지:** perp와 같은 규칙입니다 — `--slippage-bps <n>` → `settings.slippageBps.<venue>` → `settings.defaultSlippageBps` (기본 제공값 50).
- **Pacifica:** 현물 매수는 공유된 USDC perp 마진을 사용하므로 perp 가용 마진이 줄어듭니다(첫 매수 전에 경고 출력). Pacifica `getMarkets()` (perp)에는 더 이상 `SOL-USDC` 현물 마켓이 나열되지 않습니다.
- **Aster:** 에이전트 서명자에게 현물 권한이 필요합니다 — `perp wallet agent rotate aster --can-spot` (또는 `perp wallet agent approve aster --can-spot`). 권한이 없으면 현물 주문이 `POLICY_DENIED`로 실패합니다.
- **Arcus:** 스왑은 `router.spot.arcus.xyz`를 거쳐 마스터 EVM 지갑(`--ows` / 활성 OWS 지갑, 없으면 → `NO_SIGNER_AVAILABLE`)에서 Robinhood chain 위에서 정산됩니다. 현물에는 마스터 지갑만 있으면 되며 Arcus perp 에이전트 키는 필요 없습니다. 에이전트 키 없이 perp 주문 / 계정 조회를 하면 `AGENT_NOT_REGISTERED`로 실패합니다(`perp wallet agent approve arcus`). Arcus 현물 마켓 목록 조회는 느리므로(~80초, 토큰마다 라우터 `/price` 한 번) `spot-buy` / `spot-sell`을 바로 사용하세요. EIP-2612 permit을 지원하지 않는 토큰은 Robinhood Chain ETH 가스가 드는 1회성 온체인 `approve(Permit2)`가 필요합니다 — 허용하려면 `--yes`를 지정하세요. 결과에는 `status`, `finality`, `receivedToken`과 해결 방법(remediation)이 표시되며, `pending` 결과는 스왑이 제출되었음을 뜻합니다 — **재전송하지 마세요**.
- **결과:** 현물 주문은 정규화된 결과(상태, 최종성, 체결 수량, 평균 가격, 수령 토큰, 해결 방법)를 출력합니다. `spot-buy` / `spot-sell`은 모든 거래소에서 `execution` 레코드(방식, 슬리피지 bps + 출처, 거래소 경로가 계산하는 경우 보호 가격과 기준가)를 추가합니다. `spot-cancel`은 모든 거래소에서 하나의 `SpotOrderResult` 형태를 반환하며(Lighter 취소는 `spot-orders`로 확인될 때까지 `pending`), `spot-orders`는 모든 거래소(Hyperliquid 포함)에서 동일한 컬럼을 표시합니다.
- **포트폴리오 / 랜딩:** 현물 가치는 perp 자산 평가액에 더해지며, `shared`로 표시된 잔고(Pacifica USDC, Hyperliquid 통합 USDC)는 제외됩니다. 현물 가격이 없는 토큰은 stderr 경고와 함께 합계에서 제외됩니다(절대 0으로 평가하지 않음).
- **봇과 차익거래** (`funding-arb`, `spot-perp-arb`, `arb exec spot:<venue>`, `arb close`, `arb scan --mode spot-perp`)는 현물 잔고가 분리되어(또는 런타임 결정) 있으면서 **동시에** 현물↔perp 이체를 지원하는 거래소만 사용합니다: hyperliquid, lighter, lighter-rh, aster, ondo. Pacifica(공유 마진)와 Arcus(온체인 스왑)는 `CAPABILITY_UNSUPPORTED`로 거부되므로 `trade spot-*`로 직접 거래하세요.

## 커맨드 그룹

| 그룹 | 설명 |
|-------|-------------|
| `market` | 가격, 오더북, 펀딩비, 캔들(kline), HIP-3 dex |
| `account` | 잔고, 포지션, 주문, 마진 |
| `trade` | 시장가/지정가/스톱 주문, 청산, 분할 진입·익절(scale), 분할 실행 |
| `outcome` | Hyperliquid Outcome (HIP-4) — 바이너리/범위 계약, outcome별 호가 자산(outcomeMeta `quoteToken`, 현재는 USDC), 레버리지 없음 |
| `options` | 옵션 마켓 데이터, 읽기 전용 (Derive: `-e derive options underlyings / expiries / chain / quote`) |
| `print` | Pacifica Print — 사이클마다 프리미엄을 받는 행사가 주문: games, quote, positions, history, events, deposit / cancel (`--dry-run`) |
| `vault` | Pacifica vault (API: lakes) — list, info, positions, deposit (마스터 지갑 전용) / withdraw (`--dry-run`) |
| `arb` | 펀딩비 차익거래 — 스캔, 실행, 청산, 모니터링 (perp-perp 및 spot-perp) |
| `strategy` | 19개 봇 알고리즘 (grid, dca, twap, APEX, REFLECT, 프리셋) + 중첩 스크립트 플랜 |
| `funds` | 입금, 출금, 이체, 크로스체인 브리지 (멀티 프로바이더), 거래소 간 리밸런싱 |
| `risk` | 리스크 한도, 청산까지의 거리, 가드레일 |
| `wallet` | 멀티 지갑 관리, 에이전트 지갑 (`wallet agent ...`), 빌더 수수료 (`wallet builder ...`, 기본값 꺼짐), 마진 모드 / 서브 계정 / API 키 (`wallet manage ...`), 온체인 잔고 |
| `history` | 실행 로그, 손익(PnL), 성과 분석 |
| `portfolio` | 거래소 통합 개요 (기존 `account balance` / `status` / `dashboard`를 대체; `account balance --address`는 키 없이 임의 계정의 잔고를 조회) |
| `health` | 어댑터 상태 점검: 모든 거래소의 REST 엔드포인트에 ping (연결 상태 + 지연 시간) |
| `settings` | CLI 설정 (레퍼럴, 기본값, 수수료, 빌더 수수료, deBridge 제휴) |
| `backtest` | 전략 백테스트 |
| `background` | 백그라운드 프로세스 관리자 (전략, 알림 등을 위한 tmux 세션) |
| `alerts` | 백그라운드 데몬 기반 펀딩비 알림 (Telegram / Discord) |
| `setup` | 설정 마법사: OWS 지갑, 거래소, 에이전트 지갑, 슬리피지, 기본 거래소 (별칭: `init`; 스크립트용 `--non-interactive`) |

### 빌더 수수료 (기본값 꺼짐)

perp-cli는 사용자가 직접 설정하고 거래소 승인이 확인된 경우가 아니면 빌더 수수료를 **전혀** 붙이지 않습니다.

```bash
perp settings set builder.hyperliquid 0xBuilder…,1   # <address|code>,<feeBps> — strict: format, venue cap; asks y/N (or --yes)
perp wallet builder status                            # per venue: supported? configured? approved? attached?
perp --dry-run wallet builder approve hyperliquid     # plan only
perp wallet builder approve hyperliquid               # master-signed, asks y/N (or --yes)
perp --no-builder trade market BTC buy 0.1            # skip it for one command
perp settings unset builder.hyperliquid               # off again
```

지원: hyperliquid (≤ 10 bps, HIP-3 dex 제외), pacifica (최대 ≤ 10 bps, 현물 제외), aster (≤ 10 bps, 메인넷), ondo (≤ 10 bps, 승인 단계 없음), qfex (`perp settings set builder.qfex <uuid>` — **수수료 분배** 방식: 체결이 빌더 코드에 귀속되며 사용자는 추가 비용 없이 일반 수수료만 냄; 코드는 거래 연결에 실려 전송됨; 메인넷 전용). Lighter / Lighter RH / Arcus: 미지원. 승인이 없거나 읽을 수 없으면 주문은 수수료 **없이** 전송되며, 결과의 `execution.notes`에 그 이유가 기록됩니다. `execution.builderFee`에는 실제로 붙은 수수료가 표시됩니다.

## 핵심 커맨드

```bash
# Portfolio (balances + positions + risk across all exchanges)
perp --json portfolio

# Market data
perp --json -e <EX> market list
perp --json -e <EX> market book <SYM>
perp --json -e <EX> market mid <SYM>              # fast mid-price lookup
perp --json -e <EX> market funding <SYM>
perp --json -e <EX> market kline <SYM> 1h          # candlestick data
perp --json -e hl market hip3                       # list HIP-3 deployed dexes

# Trading
perp --json -e <EX> trade buy <SYM> <SIZE>          # shortcut for market buy
perp --json -e <EX> trade sell <SYM> <SIZE>         # shortcut for market sell
perp --json -e <EX> trade market <SYM> buy <SIZE> --smart  # IOC limit (less slippage)
perp --json -e <EX> trade split <SYM> buy 5000      # orderbook-aware split (large orders)
perp --json -e <EX> trade close <SYM>
perp --json -e <EX> trade flatten                    # close ALL positions on exchange
perp --json -e <EX> trade reduce <SYM> 50            # reduce position by 50%
perp --json -e <EX> trade cancel <SYM>               # cancel by symbol (or orderId)
perp --json -e <EX> trade buy <SYM> <SIZE> --tp <PX> --sl <PX>  # entry protected by TP/SL
perp --json -e <EX> trade tpsl <SYM> long --tp <PX> --sl <PX>   # TP/SL on an open position (long|short)
perp --json -e <EX> trade stop <SYM> sell <SIZE> <PX>            # reduce-only stop (default)
perp --json -e <EX> trade leverage <SYM> <N>

# Account
perp --json portfolio -e <EX>                        # balance + spot + positions (your own balance: account balance was renamed in v0.12)
perp --json -e <EX> account positions
perp --json -e <EX> account positions --address <ADDR>   # ANY account's positions, keyless (no -e: every supporting venue)
perp --json -e <EX> account balance --address <ADDR>     # ANY account's balances (+ spot, HL HIP-3 dexes, Lighter sub-accounts), keyless
perp --json -e <EX> account pnl                      # realized + unrealized + funding
perp --json -e <EX> account funding                  # personal funding payment history
perp --json -e <EX> account settings                 # per-market leverage & margin mode

# Outcome markets (Hyperliquid HIP-4 — fully-collateralized binary contracts, quote token per outcome (USDC today), min 10 quote tokens)
perp --json outcome list                                       # active markets + Yes/No mid prices
perp --json outcome view <outcome>                             # symmetric Yes/No book + underlying gap + expiry
perp --json outcome book <outcome> <side>                      # one-side orderbook (e.g. '1 yes' or '1 0')
perp --json outcome positions                                  # open outcome holdings
perp --json outcome orders                                     # open outcome orders
perp --json outcome buy <outcome> <side> <usd> --dry-run       # validate before submit
perp --json outcome buy <outcome> <side> <usd>                 # market buy, notional in the outcome's quote token
perp --json outcome sell <outcome> <side> <usd> --limit <px> --tif gtc
perp --json outcome cancel <outcome> <side> <oid>

# Funding rate arbitrage
perp --json arb scan --min 5                         # perp-perp opportunities
perp --json arb scan --mode spot-perp                # spot+perp opportunities
perp --json arb scan --rates                         # funding rates across all exchanges
perp --json arb scan --basis                         # cross-exchange basis opportunities
perp --json arb scan --gaps                          # cross-exchange price gaps
perp --json arb scan --hip3                          # HIP-3 cross-dex funding spreads
perp --json arb scan --live                          # continuous live monitoring
perp --json arb exec <SYM> <longEx> <shortEx> <$>   # perp-perp dual-leg entry
perp --json arb exec <SYM> spot:<exch> <perpEx> <$>  # spot+perp entry
perp --json arb config                               # show arb defaults
perp --json arb history                              # past arb trade performance (alias: log)

# Funds (deposit, withdraw, transfer, bridge, rebalance)
perp --json funds deposit hyperliquid 100
perp --json funds withdraw pacifica 50
perp --json funds deposit lighter-rh 10                # USDG on Robinhood Chain (approve + deposit, mainnet)
perp --json -e lighter-rh funds withdraw lighter 10    # USDG → Robinhood Chain
perp --json funds deposit aster 8                      # USDT → Aster vault on BNB Chain (--chain arbitrum / --asset USDC; mainnet)
perp --json funds withdraw aster 8 --chain bsc         # USDT → your own address (agent needs --can-withdraw --ip-whitelist)
perp --json funds deposit ondo 12 --probe 2            # USDC transfer to your Ondo funding address (Arbitrum; --chain ethereum)
perp --json funds withdraw arcus 10                   # to the Arcus account owner
perp --json funds transfer 100 <ADDRESS>             # HL internal transfer (instant)
perp --json funds bridge quote --from solana --to arbitrum --amount 100
perp --json funds bridge send --from solana --to arbitrum --amount 100   # auto-cheapest provider
perp --json --dry-run funds bridge send --from robinhood --to solana --from-asset USDG --to-asset SOL --amount 15   # Relay quote only
perp --json funds bridge send --from robinhood --to bsc --from-asset USDG --to-asset USDT --amount 15               # Relay swap, OWS master signs
perp --json funds bridge exchange --from pacifica --to hyperliquid --amount 100
perp --json funds rebalance check                    # balances across exchanges
perp --json funds rebalance plan                     # compute optimal moves
perp --json funds rebalance execute --auto-bridge    # withdraw → bridge → deposit
perp --json funds info                               # all routes & limits

# Risk
perp --json risk limits --max-leverage 5
perp --json risk liquidation-distance

# Strategies (19 bot algorithms + nested scripted plans)
perp strategy list-strategies                        # list all available strategies
perp strategy run <strategy> [symbol]                # run any strategy
perp strategy apex [symbol]                          # APEX autonomous orchestrator
perp strategy reflect                                # trading performance analysis
perp strategy preset-list                            # list strategy presets
perp --json strategy twap <SYM> buy <SIZE> 30m
perp --json strategy grid <SYM> --range 5 --grids 10 --size 100
perp strategy plan example                           # scripted multi-step plan format
perp --json strategy plan validate <FILE>            # validate scripted plan
perp --json strategy plan execute <FILE> --dry-run   # dry-run scripted plan

# Background process supervisor (tmux)
perp background list                                 # list running jobs
perp background stop <ID>                            # stop a job
perp background logs <ID> -f                         # follow logs
# Jobs inherit -n, --dry-run, -e, --ows, -w, --no-agent, --dex and never receive keys via argv/env:
# they read the OWS vault / agent keystores / ~/.perp/.env themselves. -k, --passphrase, --ows-key or a
# shell-exported key / OWS_PASSPHRASE is refused — register an agent (perp wallet agent approve <venue>).

```

## Telegram 알림

백그라운드 데몬을 지원하는 Telegram 펀딩비 알림입니다.

```bash
# Interactive setup (BotFather token + chat ID auto-detection)
perp alerts setup

# Add alert rules
perp alerts add ETH 30              # alert when ETH funding > 30% annualized
perp alerts add --all 50            # alert for any symbol > 50%

# Test & manage
perp alerts test                    # send test message
perp alerts list                    # show active rules

# Run daemon
perp alerts start                   # foreground
perp alerts start --background      # tmux background daemon
perp alerts stop                    # stop background daemon
```

설정 흐름: BotFather 토큰 → 봇 검증 → 봇에 `/start` 전송 → chat ID 자동 감지 → 테스트 메시지.

거래소 플래그: `-e hyperliquid` / `-e pacifica` / `-e lighter` / `-e aster` (별칭: `hl`, `pac`, `lt`).

전역 플래그: `--json`, `--fields <f>`, `--ndjson`, `--dry-run`, `--dex <name>` (HIP-3), `-w, --wallet <name>`.

## MCP 서버

[![Glama MCP server](https://glama.ai/mcp/servers/hypurrquant/perp-cli/badges/score.svg)](https://glama.ai/mcp/servers/hypurrquant/perp-cli)

perp-cli에는 Claude Desktop, Cursor 등 MCP 클라이언트를 위한 완전한 기능의 MCP 서버(도구 30개, 리소스 3개, 프롬프트 2개)가 포함되어 있습니다.

**마켓 데이터에는 API 키가 필요 없습니다** — 별도 설정 없이 가격, 오더북, 펀딩비, 차익거래 기회를 살펴볼 수 있습니다. 키는 거래하려고 할 때만 추가하면 됩니다.

**네트워크:** 테스트넷을 사용하려면 서버 env에 `PERP_NETWORK=testnet`을 설정하세요(값 검증됨, 미설정 = 메인넷). 모든 결과에 `meta.network`가 표시됩니다. `trade_execute` / `trade_close`는 `perp trade`와 동일한 로컬 리스크 게이트를 거쳐 실제 주문을 넣으며(MCP로는 우회 불가), 격리(quarantine)된 심볼에서는 reduce-only가 아닌 주문을 거부하고, 실행 로그에 기록됩니다.

```json
{
  "mcpServers": {
    "perp-cli": {
      "command": "npx",
      "args": ["-y", "-p", "perp-cli", "perp-mcp"]
    }
  }
}
```

거래와 계정 데이터를 사용하려면 먼저 `perp setup`을 실행하세요. MCP 서버는 CLI와 같은 OWS vault 지갑과 에이전트 키스토어를 읽습니다. MCP 설정에 개인 키를 절대 넣지 마세요. 네트워크는 `PERP_NETWORK`로 선택합니다(`mainnet` | `testnet`; 미설정 = 메인넷, 잘못된 값이면 서버가 중지됨):
```json
{
  "env": {
    "PERP_NETWORK": "testnet"
  }
}
```

**읽기 전용 도구 (키 불필요):** `get_markets`, `get_orderbook`, `get_funding_rates`, `get_prices`, `get_positions_by_address` (공개 주소로 임의 계정의 오픈 포지션 조회 — hyperliquid(HIP-3 포함), lighter, lighter-rh, pacifica, risex), `get_balance_by_address` (공개 주소로 임의 계정의 잔고 조회 — 동일한 거래소; 전체 조회 시 `exchange` 생략), `get_outcome_markets`, `get_outcome_view`, `get_outcome_book`, `get_option_expiries`, `get_option_chain`, `get_option_quote` (Derive 옵션), `pacifica_print_products`, `pacifica_print_quote`, `pacifica_print_positions`, `pacifica_vaults` (Pacifica Print / vault; 쓰기 작업은 CLI 전용), `arb_scan`, `health_check`

**어드바이저 도구 (키 불필요):** `suggest_command`, `explain_command`

**계정 및 거래 도구 (키 필요):** `get_balance`, `get_positions`, `get_open_orders`, `get_outcome_positions`, `portfolio`, `trade_preview`, `trade_execute`, `trade_close`, `get_funding_analysis`, `get_pnl_analysis`, `get_arb_compare`

- `get_markets` / `get_orderbook`은 `meta.apiStatus`를 추가하고(TxFlow는 `"unofficial"` + `apiNote`), `get_prices`는 `meta.unofficialApiVenues`를 나열하며, `health_check` 행에는 `apiStatus`가 포함됩니다. 계정 / 거래 도구는 TxFlow를 `CAPABILITY_UNSUPPORTED`로 거부하며, `trade_preview` / `trade_execute` / `trade_close`는 자격 증명을 읽기 전에 RISEx(읽기 전용)를 거부합니다.

**리소스:** `market://prices`, `market://funding-rates`, `perp://schema`

**프롬프트:** `trading-guide`, `arb-strategy`

## 서명 가드레일 (`perp-guardrail`)

패키지에 포함된 세 번째 바이너리입니다. 직접 실행하는 커맨드가 **아닙니다**: 에이전트 API 키가
무언가에 서명하기 전에 [OWS](https://github.com/open-wallet-standard) Policy Engine이 실행하는 커스텀 정책 실행 파일입니다.
OWS가 `PolicyContext` JSON 문서를 stdin으로 전달하면, 이 바이너리는 stdout으로 JSON 문서 하나,
`{"allow": true}` 또는 `{"allow": false, "reason": "..."}`로 응답합니다. 거부된 요청은 절대 서명되지 않습니다.

정책에 포함된 `policy_config`를 바탕으로 다음 항목을 검사합니다(`src/guardrail/perp-guardrail.ts`):

- 체인별 화이트리스트에 대한 **체인**과 **대상 컨트랙트**(Solana 메인넷 / devnet의 Pacifica 프로그램,
  Arbitrum / Base / Ethereum의 Hyperliquid 브리지 + CCTP v2 + USDC, Hyperliquid typed data와 Lighter용
  서명 전용 체인 — `src/guardrail/contracts.ts`);
- **트랜잭션당** 및 **일일 누적** USD 금액(`max_tx_usd`, `max_daily_usd`);
- **출금당** 및 **일일 출금** USD 금액(`max_withdraw_usd`,
  `max_daily_withdraw_usd`);
- **차단된 함수 셀렉터**(`block_selectors`, 예: `approve` / `transferFrom`).

`policy_config.allowed_symbols`는 입력 타입에서 허용되지만 **이를 읽는 검사는 없습니다** — 현재는 아무것도
강제하지 않습니다. `policy_config`는 필수이며, 이것이 없는 컨텍스트는 거부됩니다
("policy_config missing from PolicyContext"). 내장 기본값으로 허용되는 일은 절대 없습니다. USD 금액은 트랜잭션의 네이티브 `value`와
`eth_price_usd`(정책에 명시되지 않으면 기본값 3500)로 계산하므로, ETH 단위가 아닌 체인이나
금액이 calldata에 들어 있는 토큰 전송은 금액 검사 대상이 아닙니다.

CLI로 연결하세요 — `--perp-defaults` / `wallet setup` 경로는 설치된 패키지 안의 이 바이너리를 정책에 지정하고
한도를 채워 주므로, 경로를 직접 입력할 필요가 없습니다.

```bash
# One-click: OWS vault wallet + guardrail policy + agent API key
perp wallet setup --name perp-trading --max-tx-usd 1000 --max-daily-usd 5000

# Or create the policy explicitly, with perp-cli's chain whitelist and this binary as the executable
perp wallet policy create --id perp-main --name "perp-cli guardrail" --perp-defaults \
  --max-tx-usd 1000 --max-daily-usd 5000 --max-withdraw-usd 500 --max-daily-withdraw-usd 2000 \
  --block-approve

# Point a policy at it by hand instead (any OWS policy executable path)
perp wallet policy create --id custom --name custom --executable "$(command -v perp-guardrail)"
```

`--perp-defaults`가 채워 주는 기본값: `max_tx_usd` 1000, `max_daily_usd` 5000,
`max_withdraw_usd` 500, `max_daily_withdraw_usd` 2000 (`DEFAULT_LIMITS`). 가드레일은 OWS 측의 2차
방어선이며, perp-cli 자체의 주문 전 리스크 게이트를 대체하지 않습니다.

## AI 에이전트 스킬

Claude Code, Cursor, Codex, Gemini CLI 등 에이전트 CLI에 바로 넣어 쓸 수 있는 스킬입니다. 비대화형 커맨드 가이드, 운영 플레이북, 전략 프레임워크, 재사용 가능한 셸 스크립트(사전 점검, 차익거래 모니터, 검증)가 포함되어 있어, 에이전트가 적절한 확인 지점에서 멈추고 대화형 마법사에서 막히는 일이 없습니다.

### 설치

```bash
# Claude Code — slash command
/install-skill hypurrquant/perp-cli

# Cursor / Codex / generic agent CLIs — via npx
npx skills add hypurrquant/perp-cli

# Manual install (any agent that reads a Skills directory)
git clone https://github.com/hypurrquant/perp-cli.git
cp -R perp-cli/skills/perp-cli ~/.claude/skills/        # or your CLI's skills dir
```

스킬은 npm 패키지 안(`perp-cli/skills/perp-cli`)에 포함되어 있으므로, 전역 설치만 해도 로컬에서 사용할 수 있습니다.

```bash
npm install -g perp-cli@latest
ls "$(npm root -g)/perp-cli/skills/perp-cli"
```

### 스킬 구성

| 파일 | 용도 |
|------|---------|
| `SKILL.md` | 최상위 에이전트 가이드 — 규칙, 워크플로, 예시 |
| `references/commands.md` | 비대화형 커맨드 전체 레퍼런스 (모든 그룹) |
| `references/agent-operations.md` | 설정 흐름, 멱등성, 오류 처리, 흔한 실수 |
| `references/strategies.md` | 펀딩비 차익거래 의사결정 프레임워크 + 리스크 관리 |
| `scripts/preflight.sh` | 설치 + 지갑 + 연결 + 리스크 준비 상태 점검 |
| `scripts/arb-monitor.sh` | 진행 중인 차익거래 포지션 실시간 모니터 |
| `scripts/spot-perp-scan.sh` | 잔고 정보를 반영한 spot+perp 기회 스캔 |
| `scripts/funding-analysis.sh` | 거래소 간 펀딩비 개요 / 심볼별 상세 분석 |
| `scripts/validate-arb.sh` | 실행 전 검증 (가격 / 잔고 / 리스크 / dry-run) |

전체 에이전트 가이드는 [`skills/perp-cli/SKILL.md`](skills/perp-cli/SKILL.md)를 참고하세요.

## 에이전트 우선 CLI 설계

[에이전트 우선 CLI 원칙](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/)에 따라 설계되었습니다.

```bash
# Every command returns structured JSON envelope
perp --json portfolio
# → { "ok": true, "data": {...}, "meta": { "timestamp": "..." } }

# Filter output to specific fields (saves tokens)
perp --json --fields totalEquity,risk portfolio

# Stream large lists as NDJSON (one JSON per line)
perp --json --ndjson -e hl market list

# Pre-validate before executing
perp --json -e hl trade check BTC buy 0.01
perp --json --dry-run -e hl trade market BTC buy 0.01

# Idempotent orders with client ID (Hyperliquid: a 128-bit cloid, 0x + 32 hex; --auto-id generates one)
perp --json -e hl trade market BTC buy 0.01 --client-id 0x1234567890abcdef1234567890abcdef
perp --json -e hl trade status c:0x1234567890abcdef1234567890abcdef
```

모든 응답은 자동으로 새니타이징됩니다(제어 문자 제거, 프롬프트 인젝션 패턴 차단).
오류에는 `retryable` 플래그가 포함됩니다 — `true`일 때만 재시도하세요.

## 라이선스

MIT
