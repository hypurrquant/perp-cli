# perp-cli v0.6.0 Distribution Checklist

## npm 배포 (직접)
- [ ] `npm publish` — perp-cli 메인 패키지
- [ ] `cd skills/perp-cli && npm publish` — @hypurrquant/perp-cli-skill

## MCP 디렉토리 등록
- [ ] **Anthropic MCP Directory** — https://github.com/modelcontextprotocol/servers
  - PR로 `perp-mcp` 등록 (src/mcp-server.ts 기반)
  - 필요: README에 MCP 설정 가이드 섹션 추가
- [ ] **mcp.so** — https://mcp.so (커뮤니티 MCP 디렉토리)
- [ ] **Glama MCP Directory** — https://glama.ai/mcp/servers
- [ ] **Smithery** — https://smithery.ai (MCP 마켓플레이스)

## AI Skill 마켓플레이스
- [ ] **Claude Code Skills** — `npx skills add hypurrquant/perp-cli` (이미 지원)
- [ ] **Cursor Rules** — .cursorrules 파일 추가
- [ ] **GPTs / Custom GPTs** — perp-cli OpenAPI spec 기반 (향후)

## 커뮤니티
- [ ] **GitHub Topics** — `mcp-server`, `perpetual-futures`, `trading-cli`, `defi`, `hyperliquid` 태그
- [ ] **npm keywords** — package.json keywords 확인/업데이트
- [ ] **awesome-mcp-servers** — https://github.com/punkpeye/awesome-mcp-servers PR
