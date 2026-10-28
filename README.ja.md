[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | **日本語**

> 正式版は英語の [README.md](README.md) です。この翻訳は英語版の更新に遅れている場合があります。

# perp-cli

[![npm version](https://img.shields.io/npm/v/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![npm downloads](https://img.shields.io/npm/dw/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![license](https://img.shields.io/npm/l/perp-cli.svg)](https://github.com/hypurrquant/perp-cli/blob/main/LICENSE)

多数の DEX の無期限先物を 1 つの CLI で — ターミナルから取引、ファンディングの比較、資金移動、ボットの実行ができ、AI エージェントにもそのまま渡せます（JSON 出力、MCP サーバー、エージェントスキル）。

- **8 つの取引所で取引可能:** Hyperliquid（HIP-3 dex を含む）、Pacifica、Lighter、Lighter RH、Aster、Ondo Perps、Arcus、QFEX（ブリッジと perp-perp アービトラージは当初の 4 取引所が対象: Pacifica、Hyperliquid、Lighter、Aster）
- **マーケットデータのみ:** RISEx、GRVT、Extended、Variational、TxFlow — さらに Derive のオプションデータ

## インストール

```bash
npm install -g perp-cli
perp --version

# Or without a global install
npx -y perp-cli --json portfolio
```

このパッケージには 3 つの実行ファイルが含まれています: `perp`（CLI 本体）、`perp-mcp`（[MCP サーバー](docs/mcp.md)、stdio）、`perp-guardrail`（[署名ガードレール](docs/guardrail.md)）。

## クイックスタート

**1. まずは見てみる — キー不要。**

```bash
perp -e hl market list                  # markets, prices, funding
perp -e hl market book BTC              # order book
perp arb scan --rates                   # funding rates across venues
```

**2. ウォレットを追加する。** セットアップウィザードが暗号化された [OWS](https://github.com/open-wallet-standard) vault ウォレットを作成またはインポートし、取引所を選択してエージェントキーを登録します（署名のたびに確認を求め、資金を移動することはありません）:

```bash
perp setup
perp wallet show
```

キーは非表示プロンプトまたは stdin から読み込まれます — argv や `~/.perp/.env` から読むことはありません。1 つの EVM キーで Hyperliquid、Lighter、Aster をカバーできます。その他の方法（1 行でのキーインポート、スクリプトによるセットアップ、取引所の Web サイトで作成したキー）については [docs/setup.md](docs/setup.md) を参照してください。

**3. アカウントを確認して取引する。** どのコマンドにも `-n testnet` を付ければ testnet を使用できます。

```bash
perp --json portfolio                                 # balances + positions + risk on every venue
perp --json --dry-run -e hl trade market BTC buy 0.001   # validate only, nothing is sent
perp --json -e hl trade market BTC buy 0.001          # market order (bounded by the slippage setting)
perp --json -e hl trade close BTC
```

## AI Agent Skill

Claude Code、Cursor、Codex、Gemini CLI などのエージェント CLI にそのまま導入できるスキルです。非対話型のコマンドガイド、運用プレイブック、戦略フレームワーク、再利用可能なシェルスクリプト（事前チェック、アービトラージ監視、バリデーション）を同梱しており、エージェントが適切な確認ポイントで停止し、対話型ウィザードで止まってしまうことがありません。

### インストール

```bash
# Claude Code — slash command
/install-skill hypurrquant/perp-cli

# Cursor / Codex / generic agent CLIs — via npx
npx skills add hypurrquant/perp-cli

# Manual install (any agent that reads a Skills directory)
git clone https://github.com/hypurrquant/perp-cli.git
cp -R perp-cli/skills/perp-cli ~/.claude/skills/        # or your CLI's skills dir
```

スキルは npm パッケージ内（`perp-cli/skills/perp-cli`）に同梱されているため、グローバルインストールでもローカルで利用できます:

```bash
npm install -g perp-cli@latest
ls "$(npm root -g)/perp-cli/skills/perp-cli"
```

### スキルの内容

| ファイル | 用途 |
|------|---------|
| `SKILL.md` | トップレベルのエージェントガイド — ルール、ワークフロー、例 |
| `references/commands.md` | 非対話型コマンドの完全なリファレンス（全グループ） |
| `references/agent-operations.md` | セットアップフロー、冪等性、エラー処理、よくある間違い |
| `references/strategies.md` | ファンディング・アービトラージの意思決定フレームワーク + リスク管理 |
| `scripts/preflight.sh` | インストール + ウォレット + 接続性 + リスクの準備状況チェック |
| `scripts/arb-monitor.sh` | オープン中のアービトラージポジションのライブ監視 |
| `scripts/spot-perp-scan.sh` | 残高を考慮した現物 + 無期限先物の機会スキャン |
| `scripts/funding-analysis.sh` | 取引所横断のファンディング概要 / シンボルごとの詳細 |
| `scripts/validate-arb.sh` | 執行前バリデーション（価格 / 残高 / リスク / dry-run） |

エージェントガイドの全文は [`skills/perp-cli/SKILL.md`](skills/perp-cli/SKILL.md) を参照してください。

## 機能

- **ファンディングレート・アービトラージ** — perp-perp と spot-perp のスキャン、1 コマンドでの両建てエントリーと決済
- **ポートフォリオ** — 1 回の呼び出しで全取引所の残高、ポジション、リスクを取得
- **資金管理** — 入金、出金、送金、マルチプロバイダーブリッジ（CCTP / Relay / deBridge）、取引所間リバランス
- **ボット** — TWAP、グリッド、DCA、トレーリングストップなど、バックグラウンドジョブ管理付き
- **エージェントファースト** — `--json`、`--fields`、`--ndjson`、`--dry-run`、ランタイムスキーマのイントロスペクション
- **安全性** — 取引前バリデーション、すべての成行注文へのスリッページ上限、client-id による重複排除、レスポンスのサニタイズ

## 取引所

| 取引所 | `-e` | 取引 | チェーン / 担保 |
|---|---|---|---|
| Hyperliquid | `hyperliquid` (`hl`) | ✅ | HyperEVM、USDC。`--dex` で HIP-3 dex |
| Pacifica | `pacifica` (`pac`) | ✅ | Solana、USDC |
| Lighter | `lighter` (`lt`) | ✅ | Ethereum L2、USDC |
| Lighter RH | `lighter-rh` (`lrh`) | ✅ | Robinhood chain、USDG |
| Aster | `aster` (`ast`) | ✅ | BNB Chain、USDT / USDC |
| Ondo Perps | `ondo` | ✅ | オフチェーン、USDC |
| Arcus | `arcus` | ✅（アクセスホワイトリスト） | Robinhood chain、USDG |
| QFEX | `qfex` (`qf`) | ✅（手動取引のみ） | カストディアル。株式、指数、コモディティ |
| RISEx | `risex` | 読み取り専用 | RISE chain、USDC |
| GRVT | `grvt` | マーケットデータのみ | USDT |
| Extended | `extended` (`ext`) | マーケットデータのみ | Starknet。暗号資産 + 株式 / FX |
| Variational | `variational` (`var`) | マーケットデータのみ | RFQ 取引所 |
| TxFlow | `txflow` (`txf`) | マーケットデータのみ | 公式 API（Beta） |
| Derive | `derive` | オプションデータのみ | — |

- **[サポートマトリクスと取引所ごとの注意点](docs/venues.md)** — ファンディング、WebSocket、入金 / 出金、アドレス指定の照会、制限地域
- **[メインネット検証](docs/verification.md)** — どの機能を実資金で実行したか
- **[取引の詳細](docs/trading.md)** — Time in force、TP/SL、ストップ、スリッページ、現物取引、ビルダー手数料

## 主要コマンド

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

全グループを含む完全な一覧: **[docs/commands.md](docs/commands.md)**。グローバルフラグ: `--json`、`--fields <f>`、`--ndjson`、`--dry-run`、`-n testnet`、`-e <venue>`、`--dex <name>`（HIP-3）、`-w, --wallet <name>`。

## コマンドグループ

| グループ | 説明 |
|-------|-------------|
| `market` | 価格、板、ファンディング、ローソク足、HIP-3 dex |
| `account` | 残高、ポジション、注文、証拠金 |
| `trade` | 成行 / 指値 / ストップ注文、決済、スケール、分割執行 |
| `outcome` | Hyperliquid Outcome（HIP-4）— バイナリ / レンジ契約。アウトカムごとのクオート（outcomeMeta `quoteToken`、現在は USDC）、レバレッジなし |
| `options` | オプションのマーケットデータ、読み取り専用（Derive: `-e derive options underlyings / expiries / chain / quote`） |
| `print` | Pacifica Print — サイクルごとにプレミアムを得るストライク注文: games、quote、positions、history、events、deposit / cancel（`--dry-run`） |
| `vault` | Pacifica vaults（API: lakes）— list、info、positions、deposit（マスターウォレットのみ）/ withdraw（`--dry-run`） |
| `arb` | ファンディングレート・アービトラージ — scan、exec、close、monitor（perp-perp および spot-perp） |
| `strategy` | 19 種のボットアルゴリズム（grid、dca、twap、APEX、REFLECT、プリセット）+ ネスト可能なスクリプトプラン |
| `funds` | 入金、出金、送金、クロスチェーンブリッジ（マルチプロバイダー）、取引所間リバランス |
| `risk` | リスク上限、清算までの距離、ガードレール |
| `wallet` | マルチウォレット管理、エージェントウォレット（`wallet agent ...`）、ビルダー手数料（`wallet builder ...`、デフォルトでオフ）、証拠金モード / サブアカウント / API キー（`wallet manage ...`）、オンチェーン残高 |
| `history` | 執行ログ、損益、パフォーマンスの内訳 |
| `portfolio` | 取引所横断の統合ビュー（旧 `account balance` / `status` / `dashboard` を置き換え。`account balance --address` は任意のアカウントの残高をキー不要で取得） |
| `health` | アダプターのヘルスチェック: 全取引所の REST エンドポイントに ping（接続性 + レイテンシ） |
| `settings` | CLI 設定（リファラル、デフォルト値、手数料、ビルダー手数料、deBridge アフィリエイト） |
| `backtest` | 戦略のバックテスト |
| `background` | バックグラウンドプロセスのスーパーバイザー（戦略、アラートなどの tmux セッション） |
| `alerts` | バックグラウンドデーモン付きのファンディングレートアラート（Telegram / Discord） |
| `setup` | セットアップウィザード: OWS ウォレット、取引所、エージェントウォレット、スリッページ、デフォルト取引所（エイリアス: `init`。スクリプト用に `--non-interactive`） |

## エージェントファースト CLI 設計

[エージェントファースト CLI の原則](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/)に従って構築されています:

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

すべてのレスポンスは自動的にサニタイズされます（制御文字の除去、プロンプトインジェクションパターンのブロック）。
エラーには `retryable` フラグが含まれます — `true` の場合にのみリトライしてください。

## MCP サーバー

[![Glama MCP server](https://glama.ai/mcp/servers/hypurrquant/perp-cli/badges/score.svg)](https://glama.ai/mcp/servers/hypurrquant/perp-cli)

`perp-mcp` は Claude Desktop、Cursor などの MCP クライアントに 31 のツールを提供します。マーケットデータにはキー不要です。アカウントと取引のツールを使う場合は、先に `perp setup` を実行してください（サーバーは同じウォレットを読み取ります）。MCP の設定に秘密鍵を記載しないでください。

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

testnet、全ツール一覧、リソース、プロンプト: **[docs/mcp.md](docs/mcp.md)**。

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [セットアップ](docs/setup.md) | ウォレット、エージェントキー、取引所の Web サイトで作成したキー、シークレットの保存場所 |
| [取引所](docs/venues.md) | サポートマトリクス、取引所 id、QFEX / RISEx / GRVT / Extended / Variational / TxFlow / Derive の詳細 |
| [取引](docs/trading.md) | Time in force、TP/SL、ストップ、注文の変更、スリッページ、現物取引、ビルダー手数料 |
| [コマンド](docs/commands.md) | 全コマンドグループと例、Telegram アラート |
| [メインネット検証](docs/verification.md) | 取引所ごとに実資金で実行した内容 |
| [MCP サーバー](docs/mcp.md) | 設定、testnet、ツール、リソース、プロンプト |
| [署名ガードレール](docs/guardrail.md) | `perp-guardrail`、エージェントキー用の OWS ポリシー実行ファイル |
| [テスト](docs/TESTING.md) | テストスイートと取引所チェックリスト |
| [CHANGELOG](CHANGELOG.md) | リリースノート |

## ライセンス

MIT
