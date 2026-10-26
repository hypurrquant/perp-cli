**English** | [한국어](README.ko.md) | [中文](README.zh.md) | [日本語](README.ja.md)

# perp-cli

[![npm version](https://img.shields.io/npm/v/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![npm downloads](https://img.shields.io/npm/dw/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![license](https://img.shields.io/npm/l/perp-cli.svg)](https://github.com/hypurrquant/perp-cli/blob/main/LICENSE)

One CLI for perpetual futures across many DEXs — trade, compare funding, move funds and run bots from the terminal, or hand it to an AI agent (JSON output, MCP server, agent skill).

- **Trade on 8 venues:** Hyperliquid (incl. HIP-3 dexes), Pacifica, Lighter, Lighter RH, Aster, Ondo Perps, Arcus, QFEX (bridge and perp-perp arb cover the original four: Pacifica, Hyperliquid, Lighter, Aster)
- **Market data only:** RISEx, GRVT, Extended, Variational, TxFlow (unofficial API) — plus Derive options data

## Install

```bash
npm install -g perp-cli
perp --version

# Or without a global install
npx -y perp-cli --json portfolio
```

The package ships three executables: `perp` (the CLI), `perp-mcp` (the [MCP server](docs/mcp.md), stdio) and `perp-guardrail` (the [signing guardrail](docs/guardrail.md)).

## Quick start

**1. Look around — no keys needed.**

```bash
perp -e hl market list                  # markets, prices, funding
perp -e hl market book BTC              # order book
perp arb scan --rates                   # funding rates across venues
```

**2. Add a wallet.** The setup wizard creates or imports an encrypted [OWS](https://github.com/open-wallet-standard) vault wallet, picks venues and registers agent keys (it asks before every signature and never moves funds):

```bash
perp setup
perp wallet show
```

Keys are read from a hidden prompt or stdin — never from argv or `~/.perp/.env`. One EVM key covers Hyperliquid, Lighter and Aster. For other paths (one-line key import, scriptable setup, keys created on the exchange website) see [docs/setup.md](docs/setup.md).

**3. Check your account and trade.** Add `-n testnet` to any command to use testnet.

```bash
perp --json portfolio                                 # balances + positions + risk on every venue
perp --json --dry-run -e hl trade market BTC buy 0.001   # validate only, nothing is sent
perp --json -e hl trade market BTC buy 0.001          # market order (bounded by the slippage setting)
perp --json -e hl trade close BTC
```

## Features

- **Funding rate arb** — perp-perp and spot-perp scans, one-command dual-leg entry and exit
- **Portfolio** — one call returns balances, positions and risk across every venue
- **Funds** — deposit, withdraw, transfer, multi-provider bridge (CCTP / Relay / deBridge), inter-exchange rebalance
- **Bots** — TWAP, grid, DCA, trailing stop and more, with background job management
- **Agent-first** — `--json`, `--fields`, `--ndjson`, `--dry-run`, runtime schema introspection
- **Safety** — pre-trade validation, a slippage bound on every market order, client-id deduplication, response sanitization

## Venues

| Venue | `-e` | Trading | Chain / collateral |
|---|---|---|---|
| Hyperliquid | `hyperliquid` (`hl`) | ✅ | HyperEVM, USDC; HIP-3 dexes via `--dex` |
| Pacifica | `pacifica` (`pac`) | ✅ | Solana, USDC |
| Lighter | `lighter` (`lt`) | ✅ | Ethereum L2, USDC |
| Lighter RH | `lighter-rh` (`lrh`) | ✅ | Robinhood chain, USDG |
| Aster | `aster` (`ast`) | ✅ | BNB Chain, USDT / USDC |
| Ondo Perps | `ondo` | ✅ | off-chain, USDC |
| Arcus | `arcus` | ✅ (access whitelist) | Robinhood chain, USDG |
| QFEX | `qfex` (`qf`) | ✅ (manual trading only) | custodial; equities, indices, commodities |
| RISEx | `risex` | read-only | RISE chain, USDC |
| GRVT | `grvt` | market data only | USDT |
| Extended | `extended` (`ext`) | market data only | Starknet; crypto + equities / FX |
| Variational | `variational` (`var`) | market data only | RFQ venue |
| TxFlow | `txflow` (`txf`) | market data only | **unofficial** API |
| Derive | `derive` | options data only | — |

- **[Support matrix and per-venue notes](docs/venues.md)** — funding, WebSocket, deposit / withdraw, lookups by address, restricted regions
- **[Mainnet verification](docs/verification.md)** — which features have been run with real money
- **[Trading details](docs/trading.md)** — time in force, TP/SL, stops, slippage, spot trading, builder fees

## Common commands

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

Full list with every group: **[docs/commands.md](docs/commands.md)**. Global flags: `--json`, `--fields <f>`, `--ndjson`, `--dry-run`, `-n testnet`, `-e <venue>`, `--dex <name>` (HIP-3), `-w, --wallet <name>`.

## Command Groups

| Group | Description |
|-------|-------------|
| `market` | Prices, orderbook, funding, klines, HIP-3 dexes |
| `account` | Balance, positions, orders, margin |
| `trade` | Market/limit/stop orders, close, scale, split execution |
| `outcome` | Hyperliquid Outcome (HIP-4) — binary/range contracts, quoted per outcome (outcomeMeta `quoteToken`, USDC today), no leverage |
| `options` | Options market data, read-only (Derive: `-e derive options underlyings / expiries / chain / quote`) |
| `print` | Pacifica Print — strike orders earning a premium per cycle: games, quote, positions, history, events, deposit / cancel (`--dry-run`) |
| `vault` | Pacifica vaults (API: lakes) — list, info, positions, deposit (master wallet only) / withdraw (`--dry-run`) |
| `arb` | Funding rate arb — scan, exec, close, monitor (perp-perp & spot-perp) |
| `strategy` | 19 bot algorithms (grid, dca, twap, APEX, REFLECT, presets) + nested scripted plans |
| `funds` | Deposit, withdraw, transfer, cross-chain bridge (multi-provider), inter-exchange rebalance |
| `risk` | Risk limits, liquidation distance, guardrails |
| `wallet` | Multi-wallet management, agent wallets (`wallet agent ...`), builder fees (`wallet builder ...`, off by default), margin mode / subaccount / API keys (`wallet manage ...`), on-chain balances |
| `history` | Execution log, PnL, performance breakdown |
| `portfolio` | Cross-exchange unified overview (replaces former `account balance` / `status` / `dashboard`; `account balance --address` reads any account's balances, keyless) |
| `health` | Adapter health check: ping every venue's REST endpoint (connectivity + latency) |
| `settings` | CLI settings (referrals, defaults, fees, builder fees, deBridge affiliate) |
| `backtest` | Strategy backtesting |
| `background` | Background process supervisor (tmux sessions for strategies, alerts, etc.) |
| `alerts` | Funding rate alerts (Telegram / Discord) with background daemon |
| `setup` | Setup wizard: OWS wallet, venues, agent wallets, slippage, default venue (alias: `init`; `--non-interactive` for scripts) |

## Agent-First CLI Design

Built following [agent-first CLI principles](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/):

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

All responses are auto-sanitized (control chars stripped, prompt injection patterns blocked).
Errors include `retryable` flag — only retry when `true`.

## MCP Server

[![Glama MCP server](https://glama.ai/mcp/servers/hypurrquant/perp-cli/badges/score.svg)](https://glama.ai/mcp/servers/hypurrquant/perp-cli)

`perp-mcp` serves 30 tools to Claude Desktop, Cursor and other MCP clients. Market data needs no keys; for account and trading tools run `perp setup` first (the server reads the same wallet). Never put private keys in the MCP config.

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

Testnet, the full tool list, resources and prompts: **[docs/mcp.md](docs/mcp.md)**.

## AI Agent Skill

Drop-in skill for Claude Code, Cursor, Codex, Gemini CLI, and other agent CLIs. Bundles a non-interactive command guide, ops playbook, strategy framework, and reusable shell scripts (preflight, arb monitor, validation) so your agent stops at the right confirmation points and never wedges on interactive wizards.

### Install

```bash
# Claude Code — slash command
/install-skill hypurrquant/perp-cli

# Cursor / Codex / generic agent CLIs — via npx
npx skills add hypurrquant/perp-cli

# Manual install (any agent that reads a Skills directory)
git clone https://github.com/hypurrquant/perp-cli.git
cp -R perp-cli/skills/perp-cli ~/.claude/skills/        # or your CLI's skills dir
```

The skill ships inside the npm package (`perp-cli/skills/perp-cli`), so a global install also makes it available locally:

```bash
npm install -g perp-cli@latest
ls "$(npm root -g)/perp-cli/skills/perp-cli"
```

### What's in the skill

| File | Purpose |
|------|---------|
| `SKILL.md` | Top-level agent guide — rules, workflows, examples |
| `references/commands.md` | Full non-interactive command reference (every group) |
| `references/agent-operations.md` | Setup flows, idempotency, error handling, common mistakes |
| `references/strategies.md` | Funding-arb decision framework + risk management |
| `scripts/preflight.sh` | Install + wallet + connectivity + risk readiness check |
| `scripts/arb-monitor.sh` | Live monitor for open arb positions |
| `scripts/spot-perp-scan.sh` | Scan spot+perp opportunities with balance context |
| `scripts/funding-analysis.sh` | Cross-exchange funding overview / per-symbol drilldown |
| `scripts/validate-arb.sh` | Pre-execution validation (price / balance / risk / dry-run) |

See [`skills/perp-cli/SKILL.md`](skills/perp-cli/SKILL.md) for the full agent guide.

## Documentation

| Doc | What's in it |
|---|---|
| [Setup](docs/setup.md) | Wallets, agent keys, keys created on the exchange website, where secrets are stored |
| [Venues](docs/venues.md) | Support matrix, venue ids, QFEX / RISEx / GRVT / Extended / Variational / TxFlow / Derive details |
| [Trading](docs/trading.md) | Time in force, TP/SL, stops, order edit, slippage, spot trading, builder fees |
| [Commands](docs/commands.md) | Every command group with examples, Telegram alerts |
| [Mainnet verification](docs/verification.md) | What has been run with real money, per venue |
| [MCP server](docs/mcp.md) | Configuration, testnet, tools, resources, prompts |
| [Signing guardrail](docs/guardrail.md) | `perp-guardrail`, the OWS policy executable for agent keys |
| [Testing](docs/TESTING.md) | Test suites and the venue checklist |
| [CHANGELOG](CHANGELOG.md) | Release notes |

## License

MIT
