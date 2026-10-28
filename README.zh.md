[English](README.md) | [한국어](README.ko.md) | **中文** | [日本語](README.ja.md)

> 以英文版 [README](README.md) 为准；本译文可能滞后于英文版。

# perp-cli

[![npm version](https://img.shields.io/npm/v/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![npm downloads](https://img.shields.io/npm/dw/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![license](https://img.shields.io/npm/l/perp-cli.svg)](https://github.com/hypurrquant/perp-cli/blob/main/LICENSE)

一个 CLI 搞定多个 DEX 的永续合约 — 在终端中交易、比较资金费率、调拨资金和运行机器人，或交给 AI agent 使用（JSON 输出、MCP 服务器、agent 技能）。

- **9 个可交易场所：** Hyperliquid（含 HIP-3 dex）、Pacifica、Lighter、Lighter RH、Aster、Ondo Perps、Arcus、QFEX、TxFlow（跨链桥和永续-永续套利覆盖最初的四个：Pacifica、Hyperliquid、Lighter、Aster）
- **仅市场数据：** RISEx、GRVT、Extended、Variational — 另有 Derive 期权数据

## 安装

```bash
npm install -g perp-cli
perp --version

# Or without a global install
npx -y perp-cli --json portfolio
```

本软件包附带三个可执行文件：`perp`（CLI 本体）、`perp-mcp`（[MCP 服务器](docs/mcp.md)，stdio）和 `perp-guardrail`（[签名护栏](docs/guardrail.md)）。

## 快速开始

**1. 先看看 — 无需密钥。**

```bash
perp -e hl market list                  # markets, prices, funding
perp -e hl market book BTC              # order book
perp arb scan --rates                   # funding rates across venues
```

**2. 添加钱包。** 设置向导会创建或导入一个加密的 [OWS](https://github.com/open-wallet-standard) vault 钱包，选择交易场所并注册 agent 密钥（每次签名前都会先询问，且绝不会移动资金）：

```bash
perp setup
perp wallet show
```

密钥从隐藏输入提示或 stdin 读取 — 绝不从 argv 或 `~/.perp/.env` 读取。一个 EVM 密钥即可覆盖 Hyperliquid、Lighter 和 Aster。其他方式（单行导入密钥、可脚本化的设置、在交易所网站上创建的密钥）请参见 [docs/setup.md](docs/setup.md)。

**3. 查看账户并交易。** 在任意命令后加上 `-n testnet` 即可使用测试网。

```bash
perp --json portfolio                                 # balances + positions + risk on every venue
perp --json --dry-run -e hl trade market BTC buy 0.001   # validate only, nothing is sent
perp --json -e hl trade market BTC buy 0.001          # market order (bounded by the slippage setting)
perp --json -e hl trade close BTC
```

## AI Agent Skill

适用于 Claude Code、Cursor、Codex、Gemini CLI 及其他 agent CLI 的即插即用技能（skill）。内含非交互式命令指南、运维手册、策略框架以及可复用的 shell 脚本（预检、套利监控、校验），让你的 agent 在正确的确认节点停下，并且永远不会卡在交互式向导上。

### 安装

```bash
# Claude Code — slash command
/install-skill hypurrquant/perp-cli

# Cursor / Codex / generic agent CLIs — via npx
npx skills add hypurrquant/perp-cli

# Manual install (any agent that reads a Skills directory)
git clone https://github.com/hypurrquant/perp-cli.git
cp -R perp-cli/skills/perp-cli ~/.claude/skills/        # or your CLI's skills dir
```

该技能随 npm 包一同发布（`perp-cli/skills/perp-cli`），因此全局安装后也可在本地使用：

```bash
npm install -g perp-cli@latest
ls "$(npm root -g)/perp-cli/skills/perp-cli"
```

### 技能包含的内容

| 文件 | 用途 |
|------|---------|
| `SKILL.md` | 顶层 agent 指南 — 规则、工作流、示例 |
| `references/commands.md` | 完整的非交互式命令参考（涵盖所有命令组） |
| `references/agent-operations.md` | 设置流程、幂等性、错误处理、常见错误 |
| `references/strategies.md` | 资金费率套利决策框架 + 风险管理 |
| `scripts/preflight.sh` | 安装 + 钱包 + 连通性 + 风险就绪检查 |
| `scripts/arb-monitor.sh` | 实时监控未平仓的套利持仓 |
| `scripts/spot-perp-scan.sh` | 结合余额信息扫描现货+永续机会 |
| `scripts/funding-analysis.sh` | 跨交易所资金费率概览 / 单交易对深入分析 |
| `scripts/validate-arb.sh` | 执行前校验（价格 / 余额 / 风险 / dry-run） |

完整的 agent 指南请参见 [`skills/perp-cli/SKILL.md`](skills/perp-cli/SKILL.md)。

## 功能特性

- **资金费率套利** — 永续-永续和现货-永续扫描，一条命令完成双腿开仓与平仓
- **投资组合** — 一次调用即可返回所有交易场所的余额、持仓和风险
- **资金** — 充值、提现、划转、多提供商跨链桥（CCTP / Relay / deBridge）、交易所间再平衡
- **机器人** — TWAP、网格、DCA、追踪止损等，支持后台任务管理
- **Agent 优先设计** — `--json`、`--fields`、`--ndjson`、`--dry-run`、运行时 schema 自省
- **安全** — 交易前校验、每笔市价单都有滑点上限、client-id 去重、响应净化

## 交易场所

| 交易场所 | `-e` | 交易 | 链 / 抵押品 |
|---|---|---|---|
| Hyperliquid | `hyperliquid` (`hl`) | ✅ | HyperEVM，USDC；HIP-3 dex 通过 `--dex` |
| Pacifica | `pacifica` (`pac`) | ✅ | Solana，USDC |
| Lighter | `lighter` (`lt`) | ✅ | Ethereum L2，USDC |
| Lighter RH | `lighter-rh` (`lrh`) | ✅ | Robinhood chain，USDG |
| Aster | `aster` (`ast`) | ✅ | BNB Chain，USDT / USDC |
| Ondo Perps | `ondo` | ✅ | 链下，USDC |
| Arcus | `arcus` | ✅（访问白名单） | Robinhood chain，USDG |
| QFEX | `qfex` (`qf`) | ✅（仅限手动交易） | 托管；股票、指数、大宗商品 |
| RISEx | `risex` | 只读 | RISE chain，USDC |
| GRVT | `grvt` | 仅市场数据 | USDT |
| Extended | `extended` (`ext`) | 仅市场数据 | Starknet；加密货币 + 股票 / 外汇 |
| Variational | `variational` (`var`) | 仅市场数据 | RFQ 交易场所 |
| TxFlow | `txflow` (`txf`) | ✅（仅限手动交易；主网未验证，白名单） | 官方 API（Beta），USDC |
| Derive | `derive` | 仅期权数据 | — |

- **[支持矩阵及各交易场所说明](docs/venues.md)** — 资金费率、WebSocket、充值 / 提现、按地址查询、限制地区
- **[主网验证](docs/verification.md)** — 哪些功能已用真实资金运行过
- **[交易细节](docs/trading.md)** — 订单有效期（TIF）、止盈/止损、止损单、滑点、现货交易、构建者费用

## 常用命令

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

包含所有命令组的完整列表：**[docs/commands.md](docs/commands.md)**。全局参数：`--json`、`--fields <f>`、`--ndjson`、`--dry-run`、`-n testnet`、`-e <venue>`、`--dex <name>`（HIP-3）、`-w, --wallet <name>`。

## 命令分组

| 命令组 | 说明 |
|-------|-------------|
| `market` | 价格、订单簿、资金费率、K 线、HIP-3 dex |
| `account` | 余额、持仓、订单、保证金 |
| `trade` | 市价 / 限价 / 止损单、平仓、分批、拆单执行 |
| `outcome` | Hyperliquid Outcome（HIP-4）— 二元 / 区间合约，按 outcome 计价（outcomeMeta `quoteToken`，目前为 USDC），无杠杆 |
| `options` | 期权市场数据，只读（Derive：`-e derive options underlyings / expiries / chain / quote`） |
| `print` | Pacifica Print — 每个周期赚取权利金的行权价订单：games、quote、positions、history、events、deposit / cancel（`--dry-run`） |
| `vault` | Pacifica vaults（API 中称 lakes）— list、info、positions、deposit（仅限主钱包）/ withdraw（`--dry-run`） |
| `arb` | 资金费率套利 — 扫描、执行、平仓、监控（永续-永续 & 现货-永续） |
| `strategy` | 19 种机器人算法（grid、dca、twap、APEX、REFLECT、预设）+ 嵌套的脚本化计划 |
| `funds` | 充值、提现、划转、跨链桥（多提供商）、交易所间再平衡 |
| `risk` | 风险限额、强平距离、护栏 |
| `wallet` | 多钱包管理、agent 钱包（`wallet agent ...`）、构建者费用（`wallet builder ...`，默认关闭）、保证金模式 / 子账户 / API 密钥（`wallet manage ...`）、链上余额 |
| `history` | 执行日志、盈亏、绩效拆解 |
| `portfolio` | 跨交易所统一概览（取代原来的 `account balance` / `status` / `dashboard`；`account balance --address` 可无需密钥读取任意账户的余额） |
| `health` | 适配器健康检查：ping 每个交易场所的 REST 端点（连通性 + 延迟） |
| `settings` | CLI 设置（推荐码、默认值、手续费、构建者费用、deBridge affiliate） |
| `backtest` | 策略回测 |
| `background` | 后台进程管理器（用于策略、告警等的 tmux 会话） |
| `alerts` | 资金费率告警（Telegram / Discord），支持后台守护进程 |
| `setup` | 设置向导：OWS 钱包、交易场所、agent 钱包、滑点、默认交易场所（别名：`init`；脚本中使用 `--non-interactive`） |

## Agent 优先的 CLI 设计

遵循 [agent-first CLI principles](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/) 构建：

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

所有响应都会自动净化（去除控制字符，拦截提示词注入模式）。
错误中包含 `retryable` 标志 — 仅当其为 `true` 时才重试。

## MCP 服务器

[![Glama MCP server](https://glama.ai/mcp/servers/hypurrquant/perp-cli/badges/score.svg)](https://glama.ai/mcp/servers/hypurrquant/perp-cli)

`perp-mcp` 为 Claude Desktop、Cursor 及其他 MCP 客户端提供 31 个工具。查询市场数据无需密钥；如需账户和交易工具，请先运行 `perp setup`（服务器读取的是同一个钱包）。切勿在 MCP 配置中放入私钥。

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

测试网、完整工具列表、资源和提示词：**[docs/mcp.md](docs/mcp.md)**。

## 文档

| 文档 | 内容 |
|---|---|
| [设置](docs/setup.md) | 钱包、agent 密钥、在交易所网站上创建的密钥、机密信息的存放位置 |
| [交易场所](docs/venues.md) | 支持矩阵、交易场所 id、QFEX / RISEx / GRVT / Extended / Variational / TxFlow / Derive 详情 |
| [交易](docs/trading.md) | 订单有效期（TIF）、止盈/止损、止损单、改单、滑点、现货交易、构建者费用 |
| [命令](docs/commands.md) | 所有命令组及示例、Telegram 告警 |
| [主网验证](docs/verification.md) | 各交易场所哪些功能已用真实资金运行过 |
| [MCP 服务器](docs/mcp.md) | 配置、测试网、工具、资源、提示词 |
| [签名护栏](docs/guardrail.md) | `perp-guardrail`，用于 agent 密钥的 OWS 策略可执行文件 |
| [测试](docs/TESTING.md) | 测试套件和交易场所检查清单 |
| [CHANGELOG](CHANGELOG.md) | 版本发布说明 |

## 许可证

MIT
