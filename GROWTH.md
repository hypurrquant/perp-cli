# perp-cli Growth Strategy

## Vision

perp-cli는 DeFi yield 인프라 도구. 목표는 **AI 에이전트 + 트레이더 생태계**에서 표준 도구가 되는 것.

```
Phase 1: 도구 완성 (v0.6.0) ✅
Phase 2: 디스커버리 & 유저 획득 ← 현재
Phase 3: Yield Agent SaaS (새 프로젝트)
```

## KPI

| 지표 | 현재 | 1개월 목표 | 3개월 목표 | 확인 방법 |
|------|------|-----------|-----------|----------|
| npm weekly downloads | — | 100 | 500 | `npm info perp-cli` |
| GitHub stars | — | 50 | 200 | GitHub repo |
| MCP 설치 수 | 0 | 20 | 100 | 추정 (npm downloads 기반) |
| waitlist 가입자 | 0 | 100 | 500 | Yield Agent 랜딩페이지 |

## 주간 체크

```bash
npm info perp-cli --json | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('version:', d.version)"
gh api repos/hypurrquant/perp-cli --jq '"stars: \(.stargazers_count) | forks: \(.forks_count) | watchers: \(.subscribers_count)"'
```

## 배포 채널

### ✅ 완료
- [x] npm v0.6.0 배포
- [x] GitHub Release v0.6.0
- [x] GitHub topics (12개: mcp-server, perpetual-futures, trading-cli, defi, etc.)
- [x] npm keywords (17개: mcp, mcp-server, model-context-protocol, ai-agent, etc.)
- [x] README — MCP 설정 가이드 + 배지 (npm/downloads/license)
- [x] .cursorrules (Cursor IDE 통합)
- [x] mcp.so 등록
- [x] awesome-mcp-servers PR ([#3428](https://github.com/punkpeye/awesome-mcp-servers/pull/3428))
- [x] modelcontextprotocol/servers PR ([#3624](https://github.com/modelcontextprotocol/servers/pull/3624))

### 📋 대기
- [ ] Glama 디렉토리 등록 (glama.ai/mcp/servers)
- [ ] Smithery Skill 등록 (smithery.ai)
- [ ] awesome-mcp-servers PR 머지 대기
- [ ] modelcontextprotocol/servers PR 머지 대기

### 🔜 단기 (1-2주)
- [ ] Crypto Twitter 소개 글 — 스크린샷 + "DeFi yield 자동화 CLI + MCP server for Claude"
- [ ] Reddit 포스팅 — r/algotrading, r/defi, r/hyperliquid
- [ ] Hyperliquid Discord #dev 채널 소개
- [ ] Product Hunt 등록

### 🔮 중기 (1-3개월)
- [ ] 블로그 글 — "How to automate funding rate arb with Claude Desktop"
- [ ] YouTube 데모 — perp-cli + Claude Desktop 실사용
- [ ] 새 거래소 추가 (dYdX, GMX) — 유저 풀 확대
- [ ] HTTP transport 추가 — Smithery/Glama Gateway 지원

## 제품 로드맵

### perp-cli (인프라, 현재 v0.6.0)
```
v0.6.x — 안정화, 버그 수정, 유저 피드백 반영
v0.7.0 — 새 거래소 추가 (dYdX/GMX) + HTTP MCP transport
v0.8.0 — 플러그인 시스템 (사용자가 거래소/전략 추가 가능)
```

### Yield Agent SaaS (새 프로젝트)
```
Phase 1: 랜딩페이지 + waitlist (수요 검증)
Phase 2: 대시보드 + 전략 모니터링
Phase 3: 자동 실행 에이전트 (perp-cli 백엔드)
Phase 4: 구독 모델 + 공개 베타
```

## 경쟁 분석

| 도구 | 거래소 | MCP | 오픈소스 | 차별점 |
|------|--------|:---:|:-------:|--------|
| **perp-cli** | 3 DEX (PAC/HL/LT) | ✅ 18 tools | ✅ | 유일한 멀티DEX MCP 트레이딩 서버 |
| Trading212 MCP | Trading212 (CEX) | ✅ 28 tools | ✅ | CEX 전용 |
| Alpaca MCP | Alpaca (CEX) | ✅ | ✅ | 주식 위주 |
| System-R AI | 커스텀 | ✅ | ✅ | 리스크 관리 위주 |

**perp-cli의 차별점:**
- DEX 전용 (탈중앙화) — CEX MCP 서버는 많지만 DEX는 희소
- 멀티 체인 (Solana + EVM) — 단일 체인 서버들과 차별화
- Yield 특화 (펀딩아비, 델타뉴트럴) — 트레이딩뿐 아니라 yield 전략
- AI agent skill 동시 제공 — MCP + Skill 두 가지 경로

## 마케팅 메시지

**한 줄:** DeFi yield 자동화 — 3개 DEX, 18개 MCP 도구, 오픈소스

**트위터용:**
> Built an open-source CLI + MCP server for DeFi yield automation
>
> - 3 DEXs: Pacifica (Solana), Hyperliquid, Lighter (ETH)
> - 18 MCP tools for Claude Desktop
> - Funding rate arb, delta-neutral, spot+perp hedging
> - npm install -g perp-cli
>
> github.com/hypurrquant/perp-cli

**레딧용:**
> perp-cli: Open-source multi-DEX perpetual futures CLI with AI agent integration
>
> I built a CLI tool that connects to 3 DEX exchanges and includes an MCP server with 18 tools for Claude Desktop/Cursor. It automates funding rate arbitrage, delta-neutral strategies, and portfolio management across Pacifica, Hyperliquid, and Lighter.
>
> Key features: trade execution with dry-run safety, funding analysis, arb scanning, Telegram alerts.
