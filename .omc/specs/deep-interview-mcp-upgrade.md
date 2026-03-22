# Deep Interview Spec: MCP Server Full Upgrade

## Metadata
- Interview ID: perpcli-direction-002
- Rounds: 9
- Final Ambiguity Score: 17.0%
- Type: brownfield
- Generated: 2026-03-17
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.92 | 35% | 0.322 |
| Constraint Clarity | 0.80 | 25% | 0.200 |
| Success Criteria | 0.75 | 25% | 0.188 |
| Context Clarity | 0.80 | 15% | 0.120 |
| **Total Clarity** | | | **0.830** |
| **Ambiguity** | | | **17.0%** |

## Goal
perp-cli의 MCP 서버를 read-only advisor에서 full-featured trading assistant로 업그레이드한다.
목적은 **사용자 생태계 확장** — Claude Desktop/Cursor 유저(수백만)가 `npx perp-mcp`로 바로 사용할 수 있게 만들어 디스커버리를 높이는 것.

3가지 확장:
1. **Trade execution tools** — dry-run preview + 유저 확인 후 실행 모델
2. **Extended read tools** — 분석, 아비 스캔, 펀딩 통계 등 기존 CLI 기능을 MCP 도구로 노출
3. **MCP prompts & resources** — 마켓 데이터 리소스, 트레이딩 가이드 프롬프트

## Constraints
- 기존 `src/mcp-server.ts` 확장 (새 서버 X)
- 안전 모델: 모든 trade execution은 **dry-run 먼저 → 유저 확인 → 실행** 흐름
- 기존 ExchangeAdapter 인터페이스 활용
- MCP SDK (`@modelcontextprotocol/sdk`) 사용
- 기존 CLI 기능의 MCP 래핑 (로직 중복 최소화)

## Non-Goals
- ACP (Agent Commerce Protocol) 지원 — 이후 단계
- 플러그인 시스템 — 이후 단계
- 자동 트레이딩 전략 실행 (봇 등)
- MCP 서버 자체의 인증/권한 시스템

## Acceptance Criteria
- [ ] MCP tools: `trade_market`, `trade_limit`, `trade_close` — dry-run 결과 반환 + 확인 후 실행
- [ ] MCP tools: `get_funding_analysis`, `get_pnl_analysis`, `get_arb_scan`, `get_arb_compare` — 분석 도구
- [ ] MCP tools: `get_portfolio`, `get_positions`, `get_orderbook` — 기존 read 도구 유지/확장
- [ ] MCP resources: `market://prices`, `market://funding-rates` — 실시간 데이터 리소스
- [ ] MCP prompts: `trading-guide`, `arb-strategy` — 가이드 프롬프트
- [ ] 안전 모델: trade tools는 항상 dry-run 결과를 먼저 반환하고, execute 확인을 별도 호출로 분리
- [ ] `npx perp-mcp` 으로 바로 실행 가능 (기존 bin 엔트리 유지)
- [ ] 모든 도구에 명확한 description + inputSchema (Claude가 잘 이해하도록)
- [ ] 테스트 추가

## Assumptions Exposed & Resolved
| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| 더 이상 개발할 게 없다 | 진짜 없나? | 기능은 충분하지만 방향(생태계 확장)이 필요 |
| 온보딩이 문제다 | Contrarian: 진짜 문제? | 디스커버리가 더 큰 문제 |
| 자동화/전략을 넣어야 한다 | CLI에 필요 없다고 생각했음 | MCP를 통한 AI 연동이 더 적절 |
| 3가지 방향 전부 해야 함 | Simplifier: 하나만 고르면? | MCP 강화가 가장 빠른 ROI |
| AI가 직접 트레이드해야 함 | 안전 문제 | dry-run + 유저 확인 모델 |

## Technical Context
### 기존 코드
- `src/mcp-server.ts` — 현재 read-only MCP 서버 (get_markets, get_balance 등)
- `src/exchanges/interface.ts` — ExchangeAdapter (모든 거래소 공통 인터페이스)
- `src/commands/` — 기존 CLI 명령어 로직 (래핑 대상)
- `src/trade-validator.ts` — pre-trade validation (MCP에서 재사용)
- `src/smart-order.ts` — 스마트 주문 실행
- `src/funding-rates.ts` — 크로스 거래소 펀딩
- `src/arb/` — 아비트라지 로직

### 아키텍처
```
Claude Desktop / Cursor
       │
       ▼
 MCP Protocol (stdio)
       │
       ▼
 perp-mcp (src/mcp-server.ts)
  ├── Read Tools (기존 + 확장)
  │   ├── get_markets, get_portfolio, get_positions
  │   ├── get_funding_analysis  ← NEW
  │   ├── get_pnl_analysis      ← NEW
  │   ├── get_arb_scan          ← NEW
  │   └── get_arb_compare       ← NEW
  ├── Trade Tools (NEW)
  │   ├── trade_preview (dry-run) → returns preview
  │   └── trade_execute (confirm) → executes order
  ├── Resources (NEW)
  │   ├── market://prices
  │   └── market://funding-rates
  └── Prompts (NEW)
      ├── trading-guide
      └── arb-strategy
```

## Ontology (Key Entities)
| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| MCPServer | core domain | tools, resources, prompts | Wraps ExchangeAdapter |
| TradeExecution | core domain | symbol, side, size, dryRun, confirmed | Uses SafetyModel |
| SafetyModel | core domain | dryRunFirst, requireConfirmation | Guards TradeExecution |
| AnalyticsTool | core domain | fundingAnalysis, pnlAnalysis, arbScan | Wraps CLI analytics |
| PerpCLI | supporting | commands, adapters, version | Base for MCPServer |
| Users | supporting | claudeDesktop, cursor, developers | Discovery target |
| Ecosystem | supporting | npmDownloads, githubStars, activeUsers | Growth metric |
| PluginSystem | future | exchanges, strategies, modules | Post-MCP roadmap |

## Ontology Convergence
| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 2 | 2 | - | - | N/A |
| 2 | 3 | 1 | 0 | 2 | 67% |
| 3 | 4 | 1 | 0 | 3 | 75% |
| 4 | 5 | 1 | 0 | 4 | 80% |
| 5 | 5 | 0 | 1 | 4 | 100% |
| 6 | 7 | 2 | 0 | 5 | 71% |
| 7 | 7 | 0 | 0 | 7 | 100% |
| 8 | 7 | 0 | 0 | 7 | 100% |
| 9 | 8 | 1 | 0 | 7 | 88% |

## Interview Transcript
<details>
<summary>Full Q&A (9 rounds)</summary>

### Round 1
**Q:** perp-cli를 누가 쓰고 있어?
**A:** 오픈소스/팀 사용
**Ambiguity:** 79.3%

### Round 2
**Q:** 기능 부족 피드백이 있었나?
**A:** 기능은 충분, 방향이 안 보임
**Ambiguity:** 70.0%

### Round 3
**Q:** 궁극적으로 뛰 성취하고 싶어?
**A:** 사용자 생태계 확장
**Ambiguity:** 56.8%

### Round 4
**Q:** 새 유저의 가장 큰 장벽은?
**A:** 온보딩/설정이 어렵다
**Ambiguity:** 48.0%

### Round 5 [Contrarian]
**Q:** 온보딩이 진짜 문제야? 디스커버리 vs 온보딩?
**A:** 디스커버리가 더 급함
**Ambiguity:** 43.0%

### Round 6 [Simplifier]
**Q:** MCP / ACP / 플러그인 중 하나만 고르면?
**A:** MCP 강화 우선
**Ambiguity:** 30.5%

### Round 7
**Q:** MCP 강화 방향은?
**A:** 실행 + 읽기 확장 + prompts/resources
**Ambiguity:** 22.8%

### Round 8
**Q:** 현재 read-only MCP를 어떻게 확장?
**A:** 둘 다 + prompts/resources
**Ambiguity:** 22.8%

### Round 9
**Q:** 트레이드 실행 안전 모델은?
**A:** dry-run 먼저 + 유저 확인
**Ambiguity:** 17.0%

</details>
