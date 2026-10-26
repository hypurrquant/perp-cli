[English](README.md) | **한국어** | [中文](README.zh.md) | [日本語](README.ja.md)

> 정본은 영문 [README](README.md)이며, 이 번역본은 영문판보다 업데이트가 늦을 수 있습니다.

# perp-cli

[![npm version](https://img.shields.io/npm/v/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![npm downloads](https://img.shields.io/npm/dw/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![license](https://img.shields.io/npm/l/perp-cli.svg)](https://github.com/hypurrquant/perp-cli/blob/main/LICENSE)

여러 DEX의 무기한 선물(perpetual futures)을 하나로 다루는 CLI — 터미널에서 거래하고, 펀딩비를 비교하고, 자금을 옮기고, 봇을 실행하거나, AI 에이전트에게 맡길 수 있습니다(JSON 출력, MCP 서버, 에이전트 스킬).

- **8개 거래소에서 거래:** Hyperliquid (HIP-3 dex 포함), Pacifica, Lighter, Lighter RH, Aster, Ondo Perps, Arcus, QFEX (브리지와 perp-perp 차익거래는 기존 4곳 지원: Pacifica, Hyperliquid, Lighter, Aster)
- **마켓 데이터 전용:** RISEx, GRVT, Extended, Variational, TxFlow (비공식 API) — 그리고 Derive 옵션 데이터

## 설치

```bash
npm install -g perp-cli
perp --version

# Or without a global install
npx -y perp-cli --json portfolio
```

이 패키지에는 실행 파일이 세 개 포함되어 있습니다: `perp` (CLI 본체), `perp-mcp` ([MCP 서버](docs/mcp.md), stdio), `perp-guardrail` ([서명 가드레일](docs/guardrail.md)).

## 빠른 시작

**1. 둘러보기 — 키 불필요.**

```bash
perp -e hl market list                  # markets, prices, funding
perp -e hl market book BTC              # order book
perp arb scan --rates                   # funding rates across venues
```

**2. 지갑 추가.** 설정 마법사가 암호화된 [OWS](https://github.com/open-wallet-standard) vault 지갑을 생성하거나 가져오고, 거래소를 선택하고, 에이전트 키를 등록합니다(서명할 때마다 먼저 확인하며 자금은 절대 옮기지 않습니다):

```bash
perp setup
perp wallet show
```

키는 숨김 프롬프트나 stdin으로 읽습니다 — argv나 `~/.perp/.env`에서는 절대 읽지 않습니다. EVM 키 하나로 Hyperliquid, Lighter, Aster를 모두 사용할 수 있습니다. 다른 방법(한 줄 키 가져오기, 스크립트용 설정, 거래소 웹사이트에서 만든 키)은 [docs/setup.md](docs/setup.md)를 참고하세요.

**3. 계정 확인 후 거래.** 테스트넷을 사용하려면 아무 커맨드에나 `-n testnet`을 붙이세요.

```bash
perp --json portfolio                                 # balances + positions + risk on every venue
perp --json --dry-run -e hl trade market BTC buy 0.001   # validate only, nothing is sent
perp --json -e hl trade market BTC buy 0.001          # market order (bounded by the slippage setting)
perp --json -e hl trade close BTC
```

## AI Agent Skill

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

스킬은 npm 패키지 안(`perp-cli/skills/perp-cli`)에 포함되어 있으므로, 전역 설치만 해도 로컬에서 사용할 수 있습니다:

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

## 주요 기능

- **펀딩비 차익거래** — perp-perp 및 spot-perp 스캔, 커맨드 한 번으로 양방향 레그 진입과 청산
- **포트폴리오** — 한 번의 호출로 모든 거래소의 잔고, 포지션, 리스크 반환
- **자금 관리** — 입금, 출금, 이체, 멀티 프로바이더 브리지(CCTP / Relay / deBridge), 거래소 간 리밸런싱
- **봇** — TWAP, 그리드, DCA, 트레일링 스톱 등, 백그라운드 작업 관리 포함
- **에이전트 우선 설계** — `--json`, `--fields`, `--ndjson`, `--dry-run`, 런타임 스키마 인트로스펙션
- **안전성** — 주문 전 검증, 모든 시장가 주문의 슬리피지 한도, client-id 기반 중복 방지, 응답 새니타이징

## 거래소

| 거래소 | `-e` | 거래 | 체인 / 담보 |
|---|---|---|---|
| Hyperliquid | `hyperliquid` (`hl`) | ✅ | HyperEVM, USDC; `--dex`로 HIP-3 dex 사용 |
| Pacifica | `pacifica` (`pac`) | ✅ | Solana, USDC |
| Lighter | `lighter` (`lt`) | ✅ | Ethereum L2, USDC |
| Lighter RH | `lighter-rh` (`lrh`) | ✅ | Robinhood chain, USDG |
| Aster | `aster` (`ast`) | ✅ | BNB Chain, USDT / USDC |
| Ondo Perps | `ondo` | ✅ | 오프체인, USDC |
| Arcus | `arcus` | ✅ (접근 화이트리스트) | Robinhood chain, USDG |
| QFEX | `qfex` (`qf`) | ✅ (수동 거래만 가능) | 수탁형; 주식, 지수, 원자재 |
| RISEx | `risex` | 읽기 전용 | RISE chain, USDC |
| GRVT | `grvt` | 마켓 데이터 전용 | USDT |
| Extended | `extended` (`ext`) | 마켓 데이터 전용 | Starknet; 크립토 + 주식 / FX |
| Variational | `variational` (`var`) | 마켓 데이터 전용 | RFQ 거래소 |
| TxFlow | `txflow` (`txf`) | 마켓 데이터 전용 | **비공식** API |
| Derive | `derive` | 옵션 데이터 전용 | — |

- **[지원 현황표 및 거래소별 참고 사항](docs/venues.md)** — 펀딩비, WebSocket, 입금 / 출금, 주소 기반 조회, 이용 제한 지역
- **[메인넷 검증](docs/verification.md)** — 실제 자금으로 실행해 본 기능
- **[거래 상세](docs/trading.md)** — time in force, TP/SL, 스톱, 슬리피지, 현물 거래, 빌더 수수료

## 자주 쓰는 커맨드

```bash
# Market data
perp --json -e <EX> market list | book <SYM> | funding <SYM> | kline <SYM> 1h

# Trading
perp --json -e <EX> trade buy <SYM> <SIZE> --tp <PX> --sl <PX>    # entry protected by TP/SL
perp --json -e <EX> trade limit <SYM> buy <PX> <SIZE>
perp --json -e <EX> trade close <SYM>                              # or: flatten (every position)

# Account
perp --json portfolio
perp --json -e <EX> account positions
perp --json account balance --address <ADDR>                       # any account, keyless

# Funding arb
perp --json arb scan --min 5
perp --json arb exec <SYM> <longEx> <shortEx> <USD>

# Funds
perp --json funds deposit hyperliquid 100
perp --json funds bridge send --from solana --to arbitrum --amount 100
```

모든 그룹을 포함한 전체 목록: **[docs/commands.md](docs/commands.md)**. 전역 플래그: `--json`, `--fields <f>`, `--ndjson`, `--dry-run`, `-n testnet`, `-e <venue>`, `--dex <name>` (HIP-3), `-w, --wallet <name>`.

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

## 에이전트 우선 CLI 설계

[에이전트 우선 CLI 원칙](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/)에 따라 만들었습니다:

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

## MCP 서버

[![Glama MCP server](https://glama.ai/mcp/servers/hypurrquant/perp-cli/badges/score.svg)](https://glama.ai/mcp/servers/hypurrquant/perp-cli)

`perp-mcp`는 Claude Desktop, Cursor 등 MCP 클라이언트에 도구 31개를 제공합니다. 마켓 데이터에는 키가 필요 없으며, 계정 및 거래 도구를 쓰려면 먼저 `perp setup`을 실행하세요(서버는 같은 지갑을 읽습니다). MCP 설정에는 절대 개인 키를 넣지 마세요.

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

테스트넷, 전체 도구 목록, 리소스, 프롬프트: **[docs/mcp.md](docs/mcp.md)**.

## 문서

| 문서 | 내용 |
|---|---|
| [설정](docs/setup.md) | 지갑, 에이전트 키, 거래소 웹사이트에서 만든 키, 시크릿 저장 위치 |
| [거래소](docs/venues.md) | 지원 현황표, 거래소 id, QFEX / RISEx / GRVT / Extended / Variational / TxFlow / Derive 상세 |
| [거래](docs/trading.md) | time in force, TP/SL, 스톱, 주문 수정, 슬리피지, 현물 거래, 빌더 수수료 |
| [커맨드](docs/commands.md) | 모든 커맨드 그룹과 예시, Telegram 알림 |
| [메인넷 검증](docs/verification.md) | 거래소별로 실제 자금으로 실행해 본 항목 |
| [MCP 서버](docs/mcp.md) | 설정, 테스트넷, 도구, 리소스, 프롬프트 |
| [서명 가드레일](docs/guardrail.md) | `perp-guardrail`, 에이전트 키용 OWS 정책 실행 파일 |
| [테스트](docs/TESTING.md) | 테스트 스위트와 거래소 체크리스트 |
| [CHANGELOG](CHANGELOG.md) | 릴리스 노트 |

## 라이선스

MIT
