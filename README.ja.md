[English](README.md) | [한국어](README.ko.md) | [中文](README.zh.md) | **日本語**

> 正式版は英語の [README.md](README.md) です。この翻訳は英語版の更新に遅れている場合があります。

# perp-cli

[![npm version](https://img.shields.io/npm/v/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![npm downloads](https://img.shields.io/npm/dw/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![license](https://img.shields.io/npm/l/perp-cli.svg)](https://github.com/hypurrquant/perp-cli/blob/main/LICENSE)

マルチ DEX 無期限先物 CLI — **Pacifica**（Solana）、**Hyperliquid**（HyperEVM）、**Lighter**（Ethereum）、**Aster**（BNB Chain）、**Lighter RH**（Robinhood chain）、**Ondo Perps**（オフチェーン）、**Arcus**（Robinhood chain）、**QFEX**（オフチェーン、TradFi 無期限先物）、**RISEx**（RISE chain — 読み取り専用。取引は予定されていますが、まだ利用できません）、**TxFlow**（マーケットデータのみ — 非公式 API）、**Variational Omni**（マーケットデータのみ — 公式 API、RFQ 取引所）、**GRVT**（マーケットデータのみ — 公式 API。取引は予定されていますが、まだ利用できません）、**Extended**（Starknet、マーケットデータのみ — 公式 API。取引は予定されていますが、まだ利用できません）、そして **Derive** のオプションデータ（読み取り専用）に対応。

```bash
npm install -g perp-cli       # global install
perp --json portfolio

# Or without global install (restricted environments)
npx -y perp-cli --json portfolio
```

このパッケージには **3 つ**の実行ファイルが含まれています（`package.json` の `bin`）:

| バイナリ | 内容 | ドキュメント |
|---|---|---|
| `perp` | CLI 本体 | [コマンドグループ](#コマンドグループ)、[主要コマンド](#主要コマンド) |
| `perp-mcp` | Claude Desktop、Cursor などの MCP クライアント向け MCP サーバー（stdio） | [MCP サーバー](#mcp-サーバー) |
| `perp-guardrail` | エージェントキーの署名リクエストを承認または拒否する OWS Policy Engine チェッカー | [署名ガードレール](#署名ガードレール-perp-guardrail) |

## 機能

- **13 の無期限先物取引所** — うち 8 つで取引可能: Pacifica、Hyperliquid、Lighter、Aster、Lighter RH、Ondo Perps、Arcus、QFEX（ブリッジ / perp-perp アービトラージは当初の 4 取引所が対象）。マーケットデータは RISEx（読み取り専用。取引は予定されていますが、まだ利用できません）、TxFlow（非公式 API、読み取り専用）、Variational（公式 API、読み取り専用 — 公開取引 API はまだありません）、GRVT（公式 API、読み取り専用 — 取引は予定されていますが、まだ利用できません）、Extended（公式 API、読み取り専用 — 取引は予定されていますが、まだ利用できません）。さらに **Derive** のオプションデータ（読み取り専用）。[サポートマトリクス](#サポートマトリクス)を参照
- **ファンディングレート・アービトラージ** — perp-perp + spot-perp のスキャンと、1 コマンドでの両建て執行
- **ポートフォリオ** — 1 回の呼び出しで全取引所の残高、ポジション、リスクレベルを取得
- **資金管理** — 入金、出金、送金、マルチプロバイダーブリッジ（cctp/relay/debridge）、取引所間リバランスをすべて 1 つのグループに集約
- **ボット** — TWAP、グリッド、DCA、トレーリングストップとバックグラウンドジョブ管理
- **エージェントファースト設計** — `--json`、`--fields`、`--ndjson`、`--dry-run`、ランタイムスキーマのイントロスペクション
- **安全性** — 取引前バリデーション、レスポンスのサニタイズ、client-id による重複排除

## サポートマトリクス

このリリースで各取引所がサポートする機能を、コードから導出したものです（取引所定義は `src/exchanges/venues/*.ts`、`perp-cli/ws` コーデックは `src/ws/codecs/`、`funds deposit|withdraw` コマンド、オプションレジストリ）。✅ = 実装済みで利用可能、— = 利用不可。これは perp-cli が**提供する**機能を示すもので、実際の資金で実行したかどうかではありません — それについては[動作確認済み機能 — メインネット検証](#動作確認済み機能--メインネット検証-2026-10-13)を参照してください。

| 取引所 | マーケットデータ（CLI） | ファンディング | WS ストリーム（`perp-cli/ws`） | アドレス指定のポジション（`--address`） | アドレス指定の残高（`account balance --address`） | 取引 | perp-cli 経由の入金 | perp-cli 経由の出金 | その他 | API |
|---|---|---|---|---|---|---|---|---|---|---|
| Hyperliquid（`--dex` による HIP-3 を含む） | ✅ | ✅ 1 時間ごと | ✅ public + user（HIP-3 dex はオプトイン） | ✅（ネイティブ + すべての HIP-3 dex） | ✅（ネイティブ、アカウントモード別、+ HIP-3 dex、現物） | ✅ | ✅（Arbitrum からの USDC） | ✅（CCTP） | 現物、アウトカム（HIP-4）、ネイティブ TWAP | 公式 |
| Pacifica | ✅ | ✅ 1 時間ごと | ✅ public + user | ✅（Solana アドレス） | ✅（現物を含む） | ✅ | ✅ | ✅ | 現物（統合証拠金）、ネイティブ TWAP（マスター署名のみ）。Print（`perp print`）、Vaults（`perp vault`、入金はマスターのみ）、Atomic basket（`trade atomic`）— いずれもライブ未検証。レガシーの `wallet manage lake`: `create` は引き続き動作、`deposit` / `withdraw` は拒否され `perp vault` へ誘導 | 公式 |
| Lighter | ✅ | ✅ 1 時間ごと | ✅ public + user | ✅（すべてのサブアカウント） | ✅（すべてのサブアカウント、現物） | ✅ | ✅（L1 または CCTP） | ✅ | 現物、クライアントサイド TWAP | 公式 |
| Lighter RH | ✅ | ✅ 1 時間ごと | ✅ public + user（メインネット。testnet WS → HTTP 403） | ✅（すべてのサブアカウント） | ✅（すべてのサブアカウント、現物） | ✅ | ✅（USDG、メインネット） | ✅（`-e lighter-rh funds withdraw lighter`） | 現物、クライアントサイド TWAP | 公式 |
| Aster | ✅ | ✅ シンボルごと | ✅ public のみ（user チャネル: 既知の未対応） | — | — | ✅ | ✅（USDT / USDC、メインネット） | ✅（`--can-withdraw --ip-whitelist` 付きのエージェント） | 現物、クライアントサイド TWAP | 公式 |
| Ondo Perps | ✅ | ✅ 1 時間ごと | — | — | — | ✅ | ✅（USDC、メインネット） | —（API が出金を許可しない。Web アプリ）⁴ | 現物、クライアントサイド TWAP | 公式 |
| Arcus | ✅ | ✅ 1 時間ごと | ✅ public + user | — | — | ✅ | —（Web アプリ） | ✅（アカウント所有者宛て） | 現物（オンチェーンスワップ）、クライアントサイド TWAP | 公式 |
| QFEX | ✅ | 未検証（表示のみ、`--include-unverified`） | — | — | — | ✅（待機中の reduce-only なし、自動化なし — [QFEX](#qfex) を参照） | アドレスのみ | —（現在は無効。Web アプリ）⁵ | — | 公式 |
| RISEx | ✅ | ✅ 1 時間ごと | — | ✅ | ✅ | —（**読み取り専用**。取引は予定されていますが、まだ利用できません） | —（アプリのみ） | —（アプリのみ） | アドレス指定のアカウント読み取り | 公式 |
| TxFlow | ✅ | 未検証（表示のみ、`--include-unverified`） | — | — | — | —（マーケットデータのみ） | — | — | — | **非公式** |
| Variational | ✅（`market book` = RFQ クオートであり、板ではない） | 未検証（表示のみ、`--include-unverified`）。間隔はマーケットごと（1h / 4h / 8h） | — | — | — | —（マーケットデータのみ） | — | — | 株式 / ETF / コモディティ。pre-IPO（マッチング対象外） | 公式 |
| GRVT | ✅ | 未検証（表示のみ、`--include-unverified`）。間隔はマーケットごと（4h / 8h） | —（銘柄ごとのストリームのみ） | — | — | —（このバージョンではマーケットデータのみ。取引は予定されていますが、まだ利用できません） | — | — | 株式 / ETF、コモディティ。pre-IPO はマッチング対象外 | 公式 |
| Extended | ✅（暗号資産に加え、株式 / ETF / コモディティ / 指数 / FX） | 未検証（表示のみ、`--include-unverified`）、1 時間ごと。`_24_5` 株式は取引時間外に 0 を出力 | —（ストリームごとに 1 ソケット。未対応） | — | — | —（読み取り専用） | — | — | アセットクラス列。pre-IPO と曖昧なティッカーはマッチング対象外 | 公式 |
| Derive | オプションのみ（`perp -e derive options …`） | — | — | — | — | —（**読み取り専用**。取引は予定されていますが、まだ利用できません） | — | — | オプション: 原資産、満期、チェーン（IV、グリーク）、クオート | 公式 |

- **ファンディング** ✅ = レートの単位が実際に決済された支払いと照合済み（`fundingVerified`）であり、その取引所は `arb scan` とファンディング戦略の対象になります。未検証の取引所は `--include-unverified` 指定時にのみ表示され、ランキングや取引の対象にはなりません。
- **WS ストリーム** = `perp-cli/ws` / `@hypurrquant/perp-ws` のチャネル: public = 全マーケット / マーケットごとの状態と `bbo`、user = アカウント、ポジション、注文、約定。`book` / `trades` チャネルはまだどの取引所でも利用できません。
- **アドレス指定のポジション** = `perp -e <venue> account positions --address <addr>`（`-e` なし: 下記のすべての取引所）および MCP `get_positions_by_address`: 公開されている取引所データから任意のアカウントのオープンポジションを取得 — キー不要、署名なし。Pacifica（base58 の Solana アドレス）以外は 0x アドレス。その他の取引所は `CAPABILITY_UNSUPPORTED` で拒否します。
- **アドレス指定の残高** = `perp -e <venue> account balance --address <addr>`（`-e` なし: 上記のすべての取引所）および MCP `get_balance_by_address`: 公開されている取引所データから任意のアカウントの残高を取得 — キー不要、署名なし。自分の残高と同じ計算方法（Hyperliquid: 資産額のソースはアカウントの抽象化モードに従う）。取引所がアドレス単位で公開している場合は現物トークン残高も含みます。Lighter: そのアドレスのアカウントごとに 1 行（`--account-index` で絞り込み）。Hyperliquid: アカウント価値が 0 でない HIP-3 dex（失敗した dex は警告 — 0 ではなく不明扱い）。その他の取引所は `CAPABILITY_UNSUPPORTED` で拒否します。
- **クライアントサイド TWAP** = ネイティブ TWAP のない取引所での `trade twap` / `strategy twap` による分割執行（QFEX では自動化ゲートにより拒否）。

## セットアップ

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

同じ EVM キーで Hyperliquid と Lighter の両方を利用できます。

> **Lighter API Key Index:** インデックス 0〜3 は Lighter のフロントエンド（Web / モバイル）用に予約されています。perp-cli のデフォルトはインデックス `4` です。`LIGHTER_API_KEY_INDEX` 環境変数で上書きするか、管理対象のエージェントスロットには `perp wallet agent approve lighter --api-key-index <n>` を使用してください。有効範囲: 4〜254。

### Lighter RH、Ondo Perps、Arcus

これらの取引所には `wallet set` による秘密鍵のパスがありません — 代わりにエージェント / API キーを登録します:

```bash
perp wallet agent approve lighter-rh                  # Lighter RH L2 slot key (USDG collateral, Robinhood chain)
printf '%s\n%s\n' "$KEY_ID" "$SECRET" | perp wallet agent approve ondo   # Ondo HMAC key id + secret, stdin only
perp wallet agent approve arcus --master <ows-wallet> # Arcus Ed25519 API key (OWS wallet agent-arcus-<master>)
perp wallet agent verify [lighter-rh|ondo|arcus]      # no venue = verify every configured venue
```

### このコンピューターにマスターウォレットがない場合 — 取引所の Web サイトで作成したキーをインポート

取引所の Web サイトでエージェント / API キーを作成し、それをインポートします。マスターウォレットをこのマシンに置く必要はなく、
公開アドレスだけで識別されます。キーは非表示プロンプトまたは stdin から読み込まれ（argv は使わない）、
**保存する前に取引所側で検証されます** — 検証で拒否された場合は何も保存されません。マスターなしでは検証できない取引所は
検証済みではなく `unverified` として報告されます。

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

インポートしたキーで取引できます。**入金、出金、送金、ブリッジ、リファラル設定、エージェント承認にはマスターが必要です**:
マスターがない場合は `NO_SIGNER_AVAILABLE`（「取引所の Web サイトで行うか、`perp wallet import` でマスターを追加してください」）で失敗します。
CLI はインポートしたキーを失効・ローテーションできません — Web サイトで失効させてください。`perp wallet agent revoke <venue> <name> --local-only` はローカルのコピーを削除し、
`wallet agent import <venue> --agent-name <name> --replace` は Web サイトで新たに作成したキーに差し替えます。
`perp setup` でも取引所ごとに同じ選択肢が提示されます: このコンピューターのマスターウォレットで承認するか、
Web サイトで作成したキーをインポートするか（ステップ 1 でマスターウォレットをスキップ可能）。

シークレットは 1 か所にのみ保存されます（`docs/SSOT_RULES.md` Rule #3 を参照）: Lighter RH → `~/.perp/lighter-rh-agents/`、Ondo → `~/.perp/ondo-agents/<keyId>.json`、Arcus → OWS ウォレット `agent-arcus-<master>`。インポートした EVM / Solana / Ed25519 キー → OWS ウォレット `agent-{hl,aster,pac,arcus}-import-<name>`（承認済みエージェントウォレットと同様に空のパスフレーズ）、インポートした Lighter キー → ネットワークタグ付きの Lighter キーストア。ウォレット / キーが見つからない場合、黙って読み取り専用にフォールバックするのではなく、`KEY_NOT_FOUND` / `NO_SIGNER_AVAILABLE` で失敗するようになりました。

## 取引所

| 取引所 | `-e` id（エイリアス） | 取引 | 備考 |
|-------|-------------------|---------|-------|
| Pacifica | `pacifica`（`pac`） | 可 | Solana |
| Hyperliquid | `hyperliquid`（`hl`） | 可 | HyperEVM。`--dex` で HIP-3 dex |
| Lighter | `lighter`（`lt`） | 可 | Ethereum L2 |
| Aster | `aster`（`ast`） | 可 | BNB Chain。ファンディング間隔はシンボルごと |
| Lighter RH | `lighter-rh`（`lrh`、`rh`） | 可 | Robinhood chain 上の Lighter エンジン、USDG 担保 |
| Ondo Perps | `ondo`（`ondo-perps`） | 可 | オフチェーンエンジン。指値の TIF は GTC（デフォルト）/ IOC / ALO。制限地域: US、PA |
| QFEX | `qfex`（`qf`） | 可（下記 **QFEX** を参照） | カストディアル、オフチェーンエンジン。株式 / 指数 / コモディティ、クロスマージン、USDC。指値の TIF は GTC（デフォルト）/ IOC / FOK / ALO。testnet = QFEX UAT。制限地域: US、GB、ES ほか |
| Arcus | `arcus` | 可 | Robinhood chain、USDG 担保。指値の TIF は GTC（デフォルト、GTT として送信）/ IOC / FOK / ALO。制限地域: US、CA、GB。**アクセスホワイトリスト** — 未登録のアドレスは拒否されます（arcus.xyz でアクセスを申請） |
| RISEx | `risex`（`rise`） | **不可 — 読み取り専用**（取引は予定されていますが、まだ利用できません。下記 **RISEx** を参照） | RISE chain 上の完全オンチェーン板、USDC。公式 API。マーケットデータ、ファンディング、アドレス指定のアカウント読み取り。取引 / エージェント / ボットのすべてのパス → `CAPABILITY_UNSUPPORTED`。入出金は RISEx アプリのみ |
| Variational | `variational`（`var`、`omni`） | **不可 — マーケットデータのみ**（下記 **Variational** を参照） | Variational Omni、RFQ 取引所（マーケットメイカー 1 社、板なし）。公式の読み取り専用 API、公開取引 API はまだありません。ファンディングは未検証（`--include-unverified` 指定時のみ表示）。制限地域: US、CA ほか |
| GRVT | `grvt`（`grv`） | **不可 — このバージョンではマーケットデータのみ**（取引は予定されていますが、まだ利用できません。下記 **GRVT** を参照） | ハイブリッド型無期限先物取引所、USDT 担保。公式 Market Data API。ファンディングは未検証（`--include-unverified` 指定時のみ表示）。testnet = `-n testnet`。取引には KYC が必要。制限地域: US、CA、SG、HK ほか |
| Extended | `extended`（`ext`、`x10`） | **不可 — このバージョンではマーケットデータのみ**（取引は予定されていますが、まだ利用できません。下記 **Extended** を参照） | Starknet 上の無期限先物板（旧 X10）、USD 担保。公式パブリック API。暗号資産に加え RWA（株式、ETF、指数、コモディティ、FX）。ファンディングは未検証（`--include-unverified` 指定時のみ表示）。testnet = Sepolia（`-n testnet`）。制限地域: US、GB、CA、HK ほか |
| TxFlow | `txflow`（`txf`） | **不可 — マーケットデータのみ** | **非公式 API**: TxFlow にはまだ公式 API がなく、perp-cli は Web アプリが使用している非公開の API を読み取ります。予告なく変更・停止される可能性があります。ファンディングは未検証（`--include-unverified` 指定時のみ表示） |

- **Time in force:** `trade limit` はすべての取引所でデフォルト `GTC` です（共通名 `GTC | IOC | FOK | ALO`。取引所が提供しない TIF → `CAPABILITY_UNSUPPORTED`）。Lighter のポストオンリー（`ALO`）は取引所で検証されるまで無効です。
- **エントリー時の TP/SL:** `trade market|buy|sell|limit ... --tp <px> --sl <px>` はすべての取引所で同じ意味です — *このエントリーの確認済み約定を保護する*。方向は送信前にチェックされます（ロング: tp > 基準価格 > sl、ショート: その逆。基準価格は成行エントリーではマーク価格、指値エントリーでは指値価格）。Ondo はレッグを注文に付与し、Arcus はエントリー + TP/SL をバッチ送信します。Hyperliquid / Lighter / Aster はエントリーの約定を確認してから、その数量に合わせた reduce-only の TP/SL トリガー注文を発注します（成行または `--tif IOC` のエントリーのみ — 待機するエントリー → `CAPABILITY_UNSUPPORTED`）。Pacifica は約定を確認してからポジションの TP/SL を設定します（そのシンボルにすでにポジションまたは TP/SL がある場合は拒否 — 上書きはしません）。エントリーの結果が不明 → `ORDER_PENDING` となり TP/SL は**設定されません**（ポジションが無保護の可能性あり）。エントリーは約定したがレッグが失敗した → `ORDER_PARTIAL`（リトライ不可）となり、エントリー結果と発注済みのレッグが返されます — 再エントリーせず、`trade tpsl` で仕上げてください。
- **ポジションへの TP/SL:** `trade tpsl <SYM> <long|short> --tp <px> --sl <px> [--tp-limit <px>] [--size <n>]` — 引数は**ポジションの**サイドです（buy/sell は使用不可になりました）。ライブのポジションと照合され、レッグは reduce-only でライブのポジション（または `--size`）に合わせた数量になります。
- **ストップ注文はデフォルトで reduce-only** です（全取引所、`trade stop`）。ストップで新規建てやドテンを許可するには `--no-reduce-only` を指定します（ストップが常に reduce-only である Ondo と QFEX では拒否）。Lighter / Arcus の成行トリガーは、トリガー価格 ± スリッページ上限（`--slippage-bps` または設定）の指値として執行されるため、急変時には約定しないままになる場合があります。その他の取引所はネイティブの成行トリガーを使用します（`--slippage-bps` → `CAPABILITY_UNSUPPORTED`）。
- **注文の変更:** `trade edit` は注文の TIF を維持します。Pacifica: ポストオンリー（ALO）注文はネイティブに変更されます。perp-cli が発注した GTC / TOB 注文（TIF は client order id に記録）は、キャンセル後に残りの未約定数量で再発注されます。TIF が不明な注文 → `CAPABILITY_UNSUPPORTED`（`--tif` を指定）。
- **スリッページ上限:** 成行系の注文（エントリー、決済、現物）はすべて 1 つの値で制限されます: `--slippage-bps <n>` → `settings.slippageBps.<venue>` → `settings.defaultSlippageBps`（出荷時のデフォルトは 50、`perp settings show` で表示、`perp settings set defaultSlippageBps <n>` で変更）。1..取引所の上限（Arcus は 1000）の範囲外の値は送信前に拒否されます。
- **制限地域:** 制限地域のある取引所（Ondo、Arcus、QFEX）の署名アダプターを作成すると、stderr に一度だけ通知が表示されます。ブロックはしません — 取引所の規約はご自身で確認してください。
- **集計ビュー**（`portfolio`、`account positions/orders`、`risk`、`history`、`wallet agent verify`、MCP `portfolio`）は、認証情報が設定されているすべてのアカウント取引所を対象とします。

### 動作確認済み機能 — メインネット検証 (2026-10-13)

以下のマークはすべて、コードを読んだ結果ではなく実資金でのメインネット実行に基づいています — 取引所の最小数量で実行し、複数スライス / 複数レベルのチェックでは取引所ごとの上限を約 $25〜30 に、Hyperliquid TWAP では約 $110 に引き上げています。

✅ ライブで検証済み · ⛔ 非対応（送信前に拒否） · ❌ 実装済みだがメインネットで未実行 · — 取引所が提供していない

| 機能 | HL | HIP-3 `xyz` | Pacifica | Lighter | Lighter RH | Aster | Ondo | Arcus | QFEX |
|---|---|---|---|---|---|---|---|---|---|
| 成行 / 指値（GTC、ALO、IOC）、キャンセル、変更、決済、縮小、全決済、ステータス | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| エントリー時の `--tp/--sl`、`trade tpsl`、`trade stop` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ストップリミット | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ |
| 待機する reduce-only 指値 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔（IOC のみ） |
| Client order id（発注 / ステータス / キャンセル） | ✅ | ✅ | ✅³（UUID） | ✅（数値） | ✅（数値） | ✅ | ✅ | ✅ | 生成された id のみ |
| 分離証拠金（設定、ポジションでの読み戻し、元に戻す） | ✅ | ✅ | ✅ | ✅ | ✅ | ❌（取引所が `-4050` で拒否、条件不明） | ⛔ | ✅ | ⛔ |
| `trade scale-in` / `scale-tp` | ✅ | ✅（ポジション ≥ $20.5） | ✅ | ✅ | ✅ | ✅ | scale-in ✅ / scale-tp ⛔ — 部分的な `trade tpsl --size` を使用 ✅ | ✅ | scale-in ✅ / scale-tp ⛔ |
| `trade split` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `trade multi`（複数取引所へのレッグ） | ✅ | ✅（グローバル `--dex xyz`） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| ネイティブ TWAP（`trade twap`） | ✅ | ❌（HL の最小は $100） | ✅ マスター署名 / ⛔ エージェント署名 | —² | —² | —² | —² | —² | —² |
| クライアントサイド TWAP（他の取引所での `trade twap`、`strategy twap`、`--background`） | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔（自動化ゲート） |
| ポジション保有時の `account margin` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 現物（`trade spot-*`） | ✅ | — | ✅ | ✅ | ✅ | ❌（USDT が必要） | ✅ | ❌（Arcus 発行のキーが必要） | — |
| perp-cli 経由の入金 | ✅ | （HL） | ✅ | ✅ | ✅ | ✅ | ✅ | —（Web アプリ） | —（アドレスのみ） |
| 出金（自分のアドレス宛て）⁶ | ✅ | （HL） | ✅ | ✅ | ✅ | ✅（`--asset USDC`） | ⛔⁴ | ✅ | ⛔⁵ |

RISEx、TxFlow、Variational、GRVT、Extended はこの表に含まれていません: このリリースではいずれも取引できないためです。RISEx の取引（出荷済みだが 0.15.0 以降無効化）は **testnet** でのみ実行しました（2026-10-14）。RISEx のメインネット注文は一度も実行していません。

² perp-cli にはこの取引所向けのネイティブ TWAP がありません: `trade twap` は代わりにクライアントサイド TWAP（スライス）を実行します。取引所の API が TWAP を提供しているかどうかは確認していません。  
³ セッション内で検証済み。保存されたログファイルはありません。  
⁴ 利用不可: Ondo Perps の API は出金を許可していません（`funds withdraw ondo` → `CAPABILITY_UNSUPPORTED`）。Ondo の Web アプリで出金してください。  
⁵ perp-cli では現在無効化されています（`funds withdraw qfex` → `CAPABILITY_UNSUPPORTED`）。QFEX の Web アプリで出金してください。  
⁶ メインネット、2026-10-13: 取引所ごとにアカウント自身のアドレスへ 1 回出金し、受取額を送金先チェーンで確認 — `funds withdraw hyperliquid 12.22`（Arbitrum USDC）、`funds withdraw pacifica 12.98`（Solana USDC）、`-e lighter funds withdraw lighter 15.95`（Ethereum USDC）、`-e lighter-rh funds withdraw lighter 12.96` と `funds withdraw arcus 9.94`（Robinhood Chain USDG）、`funds withdraw aster 8.74 --chain arbitrum --asset USDC`（Arbitrum USDC）。

自動化機能のライブ検証結果（最小数量で期間を区切って実行し、終了後に停止・全決済）:

| 領域 | 検証済み |
|---|---|
| アービトラージ | Aster–Arcus、Lighter–Arcus での `arb exec` / `status` / `close`。`arb auto`（Lighter–HL）。spot-perp の `arb exec <sym> spot:hl pacifica` と `arb close`。`strategy funding-arb`、`quick-arb`、`funding-auto`（Pacifica–HL）。`strategy delta-neutral`（HL 現物 + Pacifica 無期限先物） |
| ボット | `strategy grid` / `dca` / `trailing-stop` / `quick-grid` / `quick-dca` / `preset`（Aster）。`strategy start <config>` による 12 種のエンジン戦略すべて（Aster）。`strategy apex`（Aster） |
| 執行ヘルパー | `strategy twap`（Aster）、`trade twap --background`（Arcus）、`strategy plan execute`（10 種のアクションタイプのうち 9 種 — `cancel_order` は未実行）、`perp background stop`（グレースフル: 注文はキャンセル、ポジションは一覧表示） |
| Hyperliquid HIP-4 アウトカム | GTC の発注 / キャンセル、IOC 買い、`outcome sell --all` / `--size` |

資金管理とブリッジのライブ検証結果（メインネット、2026-10-13 — `funds bridge send` の実行、$11 の HL 入金後の `funds rebalance plan` + `execute --withdraw-only`、チャネルなしでのアラートルールコマンド）:

| 領域 | 検証済み | 未検証 |
|---|---|---|
| `funds bridge send` | deBridge Arbitrum → Solana USDC（OWS 署名）。Relay スワップ Arbitrum ETH → Robinhood ETH、Robinhood USDG → Solana SOL / USDC、Robinhood USDG → Arbitrum USDC | CCTP ルート。**Solana を送金元とする**すべてのブリッジ（OWS の Solana 署名パスはモックテストでのみカバー） |
| `funds bridge exchange` | — | すべて。HyperCore → Solana の CCTP ルート（`--from hyperliquid --to pacifica`）は不具合の疑いあり（Solana の受取人エンコーディング） |
| `funds rebalance` | `plan`。`execute --withdraw-only`（HL → Arbitrum） | `execute --auto-bridge`（ガスの事前チェックはまだなし） |
| `funds transfer` | — | HL `usdSend`、QFEX のアカウント間送金（受取アカウントが必要） |
| アラート | ルールの `add` / `list` / `remove`。チャネルなしでは `test` / `start` は拒否 | Telegram / Discord への配信（ボットトークンが必要） |

メインネットでまだ実行していないもの: サブアカウント、ビルダー手数料、`strategy claude-agent`（Anthropic キーが必要）、ダッシュボード。

### QFEX

QFEX はカストディアル型で、ウォレット署名はありません。唯一の認証情報は **QFEX の Web サイトで作成した API キー**（Developer Settings、2FA）で、`perp wallet agent import qfex` でインポートします（公開鍵 + シークレットを非表示プロンプト / stdin で入力し、`~/.perp/qfex-agents/` に暗号化して保存）。インポート時にそのキーで取引する **1 つのアカウント UUID**（プライマリ、または `--account-id <uuid>`）を解決して表示し、確認するまで何も保存しません（パイプ入力の場合は、それと同じ値を `--account-id` に指定）。取引用キーは「Deposit and withdraw」権限**なし**で作成してください。

```bash
perp -n testnet wallet agent import qfex              # QFEX UAT (api.qfex.io); y/N on the resolved account
perp -e qfex market list                              # public: /refdata + market-data snapshot
perp -e qfex trade limit AAPL buy 320 0.01            # GTC: "accepted" after the ACK; "open" once listed (trade status)
perp -e qfex trade market AAPL buy 0.01               # IOC LIMIT at mark ± slippage (never the venue's unbounded MARKET)
perp -e qfex trade status c:<id> --symbol AAPL        # by the generated client order id
perp funds deposit qfex                               # prints the USDC / Arbitrum One deposit address; you send the funds
```

QFEX 本番環境で検証済み（2026-10-13）: `trade close` / `close-all` / `flatten` / `reduce`（reduce-only の **IOC** として送信）、`trade stop`、`trade tpsl`（両レッグ）、`--sl` 付きの成行エントリー、`trade edit`（ネイティブの modify — 新しい order id になるが client id は維持されるため、`c:<id>` は引き続き使用可能）、`c:<id>` によるキャンセル / ステータス。

perp-cli が **QFEX で引き続き拒否するもの**（送信前に一律 `CAPABILITY_UNSUPPORTED`）:

| 拒否されるもの | 理由 | 代替手段 |
|---|---|---|
| 待機する reduce-only 注文（GTC / ALO での `trade limit --reduce-only`、`trade scale-tp`） | ライブ検証: 待機中の reduce-only 注文は**ポジションがフラットになった後も残り続け**、後でマッチした場合に取引所がどう扱うかは未検証 | reduce-only の IOC（`trade close` / `reduce`）、または `trade stop` / `trade tpsl` |
| ストップリミット（`--tp-limit`、指値価格付きの `trade stop`） | 取引所のストップ注文はトリガー時に成行注文に変換される | ストップマーケット |
| 新規建てやドテンを行うストップ（`trade stop --no-reduce-only`） | QFEX のストップ注文はポジションを縮小するのみ | reduce-only のストップ |
| reduce-only 注文の `trade edit` | reduce-only 注文は発注時にライブのポジションに対して数量チェックされるが、modify ではそのチェックが行われない | `trade cancel` してから再発注 |
| `--client-id` | 取引所では client id が一意ではないため、perp-cli は自身が生成した id のみを信頼する | 省略する（生成された id が報告される） |
| USD 建てでないマーケット（`SKHYNIX-KRW` など） | 数量計算、リスク上限、想定元本が USD 前提 | QFEX の Web アプリ |
| QFEX での無人自動化: ボット、プラン、TWAP、DCA、グリッド、ファンディングアービトラージ、トレーリングストップ、バックグラウンドジョブ。`arb scan` ランキングへの QFEX の掲載 | 検証されるまで自動化はゲートされている（`QFEX_AUTOMATION_VERIFIED`）。ファンディングレートの単位が未検証で、株式のファンディングは週の一部でしか発生しない（Q4） | QFEX は手動で取引。ファンディングの閲覧のみ: `perp arb scan --rates --include-unverified` |

既知の注意点: ポジションの決済直後にストップ / TP をキャンセルすると、取引所側がストップ自体を削除する一方で「unexpected error」が返ることがあります。QFEX はストップ注文の記録を保持しないため、perp-cli はキャンセルを証明できず `ORDER_PARTIAL`（pending）と報告します — `perp -e qfex account orders` を確認し、何も表示されなければストップは消えています。

注文結果を推測することはありません: IOC / 成行注文は取引所の終端フレームを受け取った時点でのみ確定します（何も約定しない → `ORDER_REJECTED`、`reason: iocNoFill`）。注文送信後に不明な状態になったものはすべて、確認用の `c:<id>` 付きで `ORDER_PENDING` となります — 決して再送信しないでください。perp-cli が QFEX の cancel-on-disconnect を有効にすることはありませんが、**同じユーザーの別の接続（例: 公式 QFEX CLI）がそれを有効にしている場合、その接続が切れるとアカウントのすべての注文がキャンセルされます**。

**出金**は perp-cli では現在無効化されています（`funds withdraw qfex` → `CAPABILITY_UNSUPPORTED`、`--dry-run` でも同様）。QFEX の Web アプリで出金してください。サブアカウント: `perp -e qfex funds transfer <amount> primary --from <account uuid>`。

### RISEx（読み取り専用 — 取引は予定されていますが、まだ利用できません）

RISEx は RISE chain 上の完全オンチェーンの無期限先物板（USDC 担保）で、**公式** API 経由で接続します。新しい取引所は段階的に提供されます: このリリースでは perp-cli は RISEx のデータを読み取るのみで、取引は今後のリリースで対応します。

```bash
perp -e risex market list                     # public; funding = last settled hourly rate (verified)
perp -e risex market book BTC                 # also: prices | info | trades | kline | funding
perp arb scan --rates                         # RISEx rows in the funding comparison
perp health                                   # RISEx is probed as an official venue
perp -e risex account positions --ows <master>   # account reads are public by address — nothing is signed
```

- **このリリースで拒否されるもの**（`CAPABILITY_UNSUPPORTED`、「RISEx trading is planned for a later perp-cli release」、キーの読み込みやリクエスト送信の前に拒否 — `--dry-run` でも同様）: すべての `perp -e risex trade …` 書き込み、`trade multi` / `arb exec` / `arb auto` のレッグ、すべての `strategy …` コマンド（ボット、プラン、TWAP / グリッド / DCA、`--exchanges` のレッグ）、`wallet agent approve|import|revoke|rotate risex`（`revoke --force` はローカルの記録を消去するのみ）、`perp setup --venues risex`、`funds faucet risex`、および MCP の `trade_preview` / `trade_execute` / `trade_close` ツール。`arb scan --basis` は取引可能な取引所のみを対象とするため RISEx は含まれません。`arb scan` では RISEx のレッグを含むペアは `executable: false` /「(read-only)」と表示されます。
- **資金:** 入出金は RISEx アプリ（app.rise.trade）で行います。`funds deposit|withdraw risex`、`funds transfer -e risex`、risex を含む `funds rebalance execute` は `CAPABILITY_UNSUPPORTED` で拒否されます（`--dry-run` でも同様）。
- 取引コード（オンチェーンで取引のみに制限されたセッション署名者、EIP-712 permit）はテストとともに出荷されていますが、1 つのフラグ（`src/exchanges/venues/risex-release.ts` の `RISEX_TRADING_ENABLED`）で無効化されています。

### TxFlow（マーケットデータのみ — 非公式 API）

TxFlow はまだ公式 API を公開していません。perp-cli は app.txflow.com が使用している**非公開の** API を読み取ります — 読み取り専用であり、いつでも変更・ブロックされる可能性があります。すべての JSON 行に `venueApi: "unofficial"`（混在テーブルや MCP 出力では `apiStatus`）が付き、人間向けの出力には脚注が追加されます。

```bash
perp -e txflow market list | info <SYM> | book <SYM> | trades <SYM> | kline <SYM> 1h
perp arb scan --rates --include-unverified                  # TxFlow funding (percent per hour on the venue, shown as a fraction), display only
```

取引 / アカウント / ポートフォリオ / 資金（入金、出金、送金、リバランス）/ エージェント / ビルダー / 戦略 / arb exec のすべてのコマンドと、MCP のすべてのアカウント・取引ツールは、リクエスト前に `CAPABILITY_UNSUPPORTED` で TxFlow を拒否します。ファンディング履歴も testnet もありません。ファンディング間隔が 1 時間であることを証明できないマーケットでは、ファンディングは不明として表示されます。

### Variational（マーケットデータのみ — 公式 API）

Variational Omni は RFQ 取引所です: 単一のマーケットメイカー（OLP）がすべての取引にクオートを提示するため、板はありません。perp-cli はドキュメント化された**公式**の読み取り専用 API を読み取ります（全マーケットに対して `GET /metadata/v2/stats` を 1 回呼び出し、5 秒間共有。取引所の制限は IP あたり 10 リクエスト / 10 秒）。Variational にはまだ公開取引 API がありません。

```bash
perp -e variational market list | prices | info <SYM>   # perps by base (BTC), swaps keep the suffix (XAU-SWAP)
perp -e variational market book BTC                      # the OLP's indicative RFQ quotes at fixed sizes — not an order book
perp -e variational market funding BTC                   # current terms: per interval (1h / 4h / 8h per market), hourly, APR
perp arb scan --rates --include-unverified               # Variational funding rows, display only
perp health                                              # probed as an official venue
```

- **ファンディングは未検証:** 公開されているレートは次回支払いの変動する予測値であり、決済済みの支払いと照合できない（公開アカウント API がない）ため、`--include-unverified` 指定時にのみ表示されます — ランキング、取引、ファンディング履歴への保存の対象にはなりません。ファンディング履歴のエンドポイントはありません。
- **シンボル:** TradFi 無期限先物（株式、ETF、コモディティ）は明示的に分類されます。`US500-PERP` は SPDR S&P 500 ETF（`SPY` として比較）です。pre-IPO マーケット、スワップ、`SPX`（SPX6900）、`QNT`（Quant）は取引所間でマッチングされません。インデックス価格、ティック、ロット、レバレッジ、基軸単位の建玉は公開されていません（`-` / null として表示）。
- **拒否されるもの**（`CAPABILITY_UNSUPPORTED`、リクエスト前に拒否 — `--dry-run` でも同様）: 取引 / アカウント / ポートフォリオ / 資金 / エージェント / ビルダー / 戦略 / arb exec のすべてのコマンドと、MCP のすべてのアカウント・取引ツール。testnet なし、WebSocket なし。

### GRVT（マーケットデータのみ — 公式 API）

GRVT はハイブリッド型の無期限先物取引所です（オフチェーンマッチング、USDT 担保）。perp-cli はキー不要の**公式** Market Data API（`POST https://market-data.grvt.io/full/v1/…`、testnet は `-n testnet`）を読み取ります。このバージョンでは GRVT は読み取り専用で、取引は今後のリリースで対応予定です。

```bash
perp -e grvt market list | prices | info <SYM>   # base tickers (BTC, KPEPE, XAU, AAPL); BTC_USDT_Perp also accepted
perp -e grvt market book BTC                      # order book (10 / 50 / 100 / 500 levels served)
perp -e grvt market funding BTC                   # settled funding history (per 4h / 8h interval)
perp -e grvt market trades | kline BTC …          # public tape / candles
perp arb scan --rates --include-unverified        # GRVT funding rows, display only
perp health                                       # probed as an official venue
```

- **ファンディングは未検証:** 間隔はマーケットごと（4h または 8h）です。マーケット行には進行中の間隔に対する GRVT の参考レート（`fundingRateKind: "predicted"`）が含まれ、パーセントから間隔あたりの小数に変換されます。決済済みの支払いと照合されていないため、`--include-unverified` 指定時にのみ表示されます — ランキングや取引の対象にはなりません。
- **シンボル:** 暗号資産はティッカーで、株式 / ETF はレビュー済みリストのティッカーで指定します。XAU / XAG / CL / BZ → GOLD / SILVER / WTI / Brent。pre-IPO マーケット（OPENAI、ANTHROPIC、SPACEX）と曖昧なティッカーは取引所間でマッチングされません。ロットステップは公開されていません（`stepSize` は null）。最大レバレッジは GRVT の証拠金ルールから取得します（`market list|prices|info`、最大 6 時間キャッシュ — `leverageAsOf`）。
- **リクエスト:** GRVT には一括ティッカーがないため、全マーケットの読み取りはマーケットごとに 1 ティッカー（約 185 リクエスト、約 5 秒）となり、15 秒間再利用されます。ドキュメント記載の制限（ティッカーは 1500 / 分、その他は 500 / 分）は取引所リミッターで適用されます。
- **拒否されるもの**（`CAPABILITY_UNSUPPORTED`、「GRVT is read-only (market data) in this version; trading is planned for a later release」、リクエスト前に拒否 — `--dry-run` でも同様）: 取引 / アカウント / ポートフォリオ / 資金 / エージェント / ビルダー / 戦略 / arb exec のすべてのコマンド、`setup --venues grvt`、および MCP のすべてのアカウント・取引ツール。`perp-cli/ws` コーデックはありません（GRVT のストリームは銘柄ごとで、マーケット数を下回る上限がある）。

### Extended（マーケットデータのみ — 公式 API）

Extended（旧 X10）は Starknet 上の無期限先物板（USD 担保）で、暗号資産と RWA マーケット（株式、ETF、指数、コモディティ、FX）を上場しています。perp-cli はキー不要の**公式**パブリック API（`https://api.starknet.extended.exchange/api/v1`、testnet は Sepolia `-n testnet`）を読み取ります。このバージョンでは Extended は読み取り専用で、取引は今後のリリースで対応予定です。

```bash
perp -e extended market list | prices | info <SYM>   # base tickers (BTC, TSLA, SPX500M); wire names (TSLA_24_5-USD) also accepted
perp -e extended market book TSLA                     # order book (RFQ markets: the indicative book)
perp -e extended market funding ETH                   # applied hourly funding prints
perp -e extended market trades | kline BTC …          # public tape / candles
perp arb scan --rates --include-unverified            # Extended funding rows, display only
perp health                                           # probed as an official venue
```

- **ファンディングは未検証:** 1 時間に 1 回適用され、1 時間あたりの小数で小数点以下 6 桁に丸められます。マーケット行には現在の時間の累積中レート（`fundingRateKind: "accruing"`）が含まれ、`market funding` は適用済みの値を表示します。アカウントのファンディング支払いとは照合されておらず、`_24_5` 株式は原資産の市場が閉まっている間 0 を出力するため、`--include-unverified` 指定時にのみ表示されます — ランキングや取引の対象にはなりません。
- **シンボル:** `_24_5` サフィックスを除いたアセット名（`TSLA_24_5-USD` → `TSLA`）。`market list` にはアセットクラス列が表示されます。暗号資産はティッカーで、株式 / ETF もティッカーで指定します。XAU / XAG / WTI / XBR → GOLD / SILVER / WTI / Brent、SPX500M / TECH100M → SPX / NDX。pre-IPO マーケット、他の取引所では暗号資産のティッカーである RWA ティッカー（PURR、QNT、BB、ON、ADI、BOT）、XIAOMI、暗号資産の `SPX`（SPX6900）は取引所間でマッチングされません。
- **拒否されるもの**（`CAPABILITY_UNSUPPORTED`、「Extended is read-only (market data) in this version; trading is planned for a later release」、リクエスト前に拒否 — `--dry-run` でも同様）: 取引 / アカウント / ポートフォリオ / 資金 / エージェント / ビルダー / 戦略 / arb exec のすべてのコマンド、`setup --venues extended`、および MCP のすべてのアカウント・取引ツール。`perp-cli/ws` コーデックはありません（Extended のストリームはストリーム URL ごとに 1 ソケットで、subscribe フレームがない）。

### オプションのマーケットデータ — Derive（読み取り専用）

Derive（derive.xyz）のオプションを公式パブリック API 経由で取得します — キー不要。注文、アカウント、署名はありません（取引は予定されていますが、まだ利用できません）。Derive は無期限先物の取引所ではありません: `-e derive` は `perp options` でのみ使用できます。

```bash
perp --json -e derive options underlyings
perp --json -e derive options expiries ETH
perp --json -e derive options chain ETH --expiry 2026-12-25 --strikes 10   # bid/ask, mark, IV, greeks, OI per strike
perp --json -e derive options quote ETH-20261225-3500-P
```

### 現物取引

現物のサポートは取引所ごとに宣言され（`VenueDefinition.spot`）、すべての現物コマンド、ポートフォリオビュー、ボットは 1 つのファクトリーを経由します。シンボルは `BASE/QUOTE` 形式で、基軸通貨のみ（`ETH`）の場合はその取引所の最初のクオート資産が使われます。

| 取引所 | アカウントモデル | クオート | 指値 / 板 / キャンセル | 現物↔無期限先物の振替 |
|-------|---------------|-------|-----------------------|--------------------|
| Hyperliquid | 実行時に判定（統合アカウントは無期限先物と USDC を共有、標準アカウントは別） | USDC | 可 | 可（統合アカウントでは no-op） |
| Lighter / Lighter RH | 別 | USDC / USDG | 可 | 可 |
| Aster | 別（`sapi` 現物アカウント） | USDT、USD1（基軸通貨のみ → USDT） | 可 | 可 |
| Pacifica | **統合** — 現物は無期限先物アカウントを共有 | USDC | 可 | 不可（不要） |
| Ondo Perps | 別（現物ウォレット ↔ 証拠金） | USDC | 可 | 可 |
| Arcus | **ウォレット** — マスター EVM ウォレットからのオンチェーンスワップ（ルーター、Permit2） | USDG | 不可（成行スワップのみ） | 不可 |

```bash
perp --json -e <EX> trade spot-buy <SYM> <SIZE> [--slippage-bps <n>] [--yes]
perp --json -e <EX> trade spot-sell <SYM> <SIZE> [--slippage-bps <n>] [--yes]
perp --json -e <EX> trade spot-limit <SYM> <buy|sell> <PRICE> <SIZE> [--tif GTC|IOC|ALO]
perp --json -e <EX> trade spot-cancel <SYM> <ORDER_ID>
perp --json -e <EX> trade spot-orders [SYM]
perp --json -e <EX> trade spot-transfer <to-spot|to-perp> <AMOUNT>   # moves the venue's first quote asset
perp --json -e <EX> trade spot-balance
```

- **非対応の操作は明示的に失敗します**（`CAPABILITY_UNSUPPORTED`。例: Arcus での `spot-limit` / `spot-cancel` / `spot-orders` / `spot-transfer`）。
- **残高共有アカウントでの `spot-transfer`**（Pacifica、Hyperliquid 統合アカウント）は `execution.method: "sharedAccount"` 付きの no-op として成功します（移動の必要がない）。実際に移動した場合は `execution.method: "transfer"` が報告されます。
- **スリッページ:** 無期限先物と同じルール — `--slippage-bps <n>` → `settings.slippageBps.<venue>` → `settings.defaultSlippageBps`（出荷時 50）。
- **Pacifica:** 現物の買いは共有の USDC 無期限先物証拠金を消費し、無期限先物の利用可能証拠金を減らします（最初の買いの前に警告を表示）。Pacifica の `getMarkets()`（無期限先物）は `SOL-USDC` 現物マーケットを一覧に含めなくなりました。
- **Aster:** エージェント署名者には現物権限が必要です — `perp wallet agent rotate aster --can-spot`（または `perp wallet agent approve aster --can-spot`）。権限がない場合、現物注文は `POLICY_DENIED` で失敗します。
- **Arcus:** スワップは `router.spot.arcus.xyz` を経由し、マスター EVM ウォレット（`--ows` / アクティブな OWS ウォレット。なければ `NO_SIGNER_AVAILABLE`）から Robinhood chain 上で決済されます。現物にはマスターウォレットのみが必要で、Arcus の無期限先物エージェントキーは不要です。エージェントキーなしでの無期限先物の注文 / アカウント読み取りは `AGENT_NOT_REGISTERED` で失敗します（`perp wallet agent approve arcus`）。Arcus の現物マーケットの一覧取得は遅い（約 80 秒、トークンごとにルーターの `/price` を 1 回）ため、`spot-buy` / `spot-sell` を直接使用してください。EIP-2612 permit に対応していないトークンには、Robinhood Chain の ETH ガスがかかる 1 回限りのオンチェーン `approve(Permit2)` が必要です — 許可するには `--yes` を指定してください。結果には `status`、`finality`、`receivedToken` と対処方法が表示されます。`pending` の結果はスワップが送信済みであることを意味します — **再送信しないでください**。
- **結果:** 現物注文は正規化された結果（ステータス、ファイナリティ、約定数量、平均価格、受取トークン、対処方法）を出力します。`spot-buy` / `spot-sell` はすべての取引所で `execution` レコード（方式、スリッページ bps + ソース、取引所のパスが計算する場合は保護価格と基準価格）を付加します。`spot-cancel` はすべての取引所で 1 つの `SpotOrderResult` 形式を返します（Lighter のキャンセルは `spot-orders` で確認されるまで `pending`）。`spot-orders` はすべての取引所（Hyperliquid を含む）で同じ列を表示します。
- **ポートフォリオ / ランディング:** 現物の評価額は無期限先物の資産額に加算されます。ただし `shared` とマークされた残高（Pacifica USDC、Hyperliquid 統合 USDC）は除きます。現物価格のないトークンは stderr への警告付きで合計から除外されます（0 として評価することはありません）。
- **ボットとアービトラージ**（`funding-arb`、`spot-perp-arb`、`arb exec spot:<venue>`、`arb close`、`arb scan --mode spot-perp`）は、別建て（または実行時判定）の現物残高**と**現物↔無期限先物の振替の両方を持つ現物取引所のみを使用します: hyperliquid、lighter、lighter-rh、aster、ondo。Pacifica（共有証拠金）と Arcus（オンチェーンスワップ）は `CAPABILITY_UNSUPPORTED` で拒否されます。これらは `trade spot-*` で手動取引してください。

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

### ビルダー手数料（デフォルトでオフ）

perp-cli は、ユーザーが設定し、かつ取引所での承認が確認されない限り、ビルダー手数料を**一切**付加しません:

```bash
perp settings set builder.hyperliquid 0xBuilder…,1   # <address|code>,<feeBps> — strict: format, venue cap; asks y/N (or --yes)
perp wallet builder status                            # per venue: supported? configured? approved? attached?
perp --dry-run wallet builder approve hyperliquid     # plan only
perp wallet builder approve hyperliquid               # master-signed, asks y/N (or --yes)
perp --no-builder trade market BTC buy 0.1            # skip it for one command
perp settings unset builder.hyperliquid               # off again
```

対応: hyperliquid（≤ 10 bps、HIP-3 dex では不可）、pacifica（最大 ≤ 10 bps、現物では不可）、aster（≤ 10 bps、メインネット）、ondo（≤ 10 bps、承認ステップなし）、qfex（`perp settings set builder.qfex <uuid>` — **手数料シェア**: 約定がビルダーコードに帰属し、支払うのは通常の手数料のみで追加負担なし。コードは取引接続に付与される。メインネットのみ）。Lighter / Lighter RH / Arcus: 非対応。承認がない、または読み取れない場合、注文は手数料**なし**で送信され、結果の `execution.notes` にその理由が示されます。`execution.builderFee` は実際に付加された内容を示します。

## 主要コマンド

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

## Telegram アラート

バックグラウンドデーモンに対応した、Telegram によるファンディングレートアラート。

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

セットアップの流れ: BotFather トークン → ボットの検証 → ボットに `/start` を送信 → チャット ID を自動検出 → テストメッセージ。

取引所フラグ: `-e hyperliquid` / `-e pacifica` / `-e lighter` / `-e aster`（エイリアス: `hl`、`pac`、`lt`）。

グローバルフラグ: `--json`、`--fields <f>`、`--ndjson`、`--dry-run`、`--dex <name>`（HIP-3）、`-w, --wallet <name>`。

## MCP サーバー

[![Glama MCP server](https://glama.ai/mcp/servers/hypurrquant/perp-cli/badges/score.svg)](https://glama.ai/mcp/servers/hypurrquant/perp-cli)

perp-cli には、Claude Desktop、Cursor などの MCP クライアント向けのフル機能の MCP サーバー（30 ツール、3 リソース、2 プロンプト）が含まれています。

**マーケットデータに API キーは不要** — 価格、板、ファンディングレート、アービトラージ機会をセットアップなしで調べられます。キーは取引したいときにだけ追加してください。

**ネットワーク:** サーバーの env に `PERP_NETWORK=testnet` を設定すると testnet を提供します（値は検証され、未設定 = メインネット）。すべての結果に `meta.network` が含まれます。`trade_execute` / `trade_close` は `perp trade` と同じローカルのリスクゲートを通して実際の注文を発注し（MCP 経由での上書きは不可）、隔離対象のシンボルでは reduce-only 以外の注文を拒否し、執行ログに記録されます。

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

取引とアカウントデータを利用するには、まず `perp setup` を実行してください: MCP サーバーは CLI と同じ OWS vault ウォレットとエージェントキーストアを読み取ります。秘密鍵を MCP の設定に書き込まないでください。ネットワークは `PERP_NETWORK` で選択します（`mainnet` | `testnet`。未設定 = メインネット、不正な値の場合はサーバーが停止します）:
```json
{
  "env": {
    "PERP_NETWORK": "testnet"
  }
}
```

**読み取り専用ツール（キー不要）:** `get_markets`、`get_orderbook`、`get_funding_rates`、`get_prices`、`get_positions_by_address`（公開アドレスで任意のアカウントのオープンポジションを取得 — HIP-3 を含む hyperliquid、lighter、lighter-rh、pacifica、risex）、`get_balance_by_address`（公開アドレスで任意のアカウントの残高を取得 — 同じ取引所。`exchange` を省略するとすべて）、`get_outcome_markets`、`get_outcome_view`、`get_outcome_book`、`get_option_expiries`、`get_option_chain`、`get_option_quote`（Derive オプション）、`pacifica_print_products`、`pacifica_print_quote`、`pacifica_print_positions`、`pacifica_vaults`（Pacifica Print / vaults。書き込みは CLI のみ）、`arb_scan`、`health_check`

**アドバイザーツール（キー不要）:** `suggest_command`、`explain_command`

**アカウント・取引ツール（キーが必要）:** `get_balance`、`get_positions`、`get_open_orders`、`get_outcome_positions`、`portfolio`、`trade_preview`、`trade_execute`、`trade_close`、`get_funding_analysis`、`get_pnl_analysis`、`get_arb_compare`

- `get_markets` / `get_orderbook` は `meta.apiStatus`（TxFlow では `"unofficial"` + `apiNote`）を付加し、`get_prices` は `meta.unofficialApiVenues` を列挙し、`health_check` の各行には `apiStatus` が含まれます。アカウント・取引ツールは TxFlow を `CAPABILITY_UNSUPPORTED` で拒否し、`trade_preview` / `trade_execute` / `trade_close` は認証情報を読み込む前に RISEx（読み取り専用）を拒否します。

**リソース:** `market://prices`、`market://funding-rates`、`perp://schema`

**プロンプト:** `trading-guide`、`arb-strategy`

## 署名ガードレール (`perp-guardrail`)

3 つ目の同梱バイナリです。手動で実行するコマンドでは**ありません**: エージェント API キーが何かに署名する前に
[OWS](https://github.com/open-wallet-standard) Policy Engine が起動するカスタムポリシー実行ファイルです。
OWS は `PolicyContext` JSON ドキュメントを stdin に書き込み、ガードレールは stdout に 1 つの JSON ドキュメント
`{"allow": true}` または `{"allow": false, "reason": "..."}` で応答します。拒否されたリクエストは決して署名されません。

ポリシーが持つ `policy_config` に基づいてチェックする項目（`src/guardrail/perp-guardrail.ts`）:

- **チェーン**と**宛先コントラクト**をチェーンごとのホワイトリストと照合（Solana メインネット / devnet 上の Pacifica プログラム、
  Arbitrum / Base / Ethereum 上の Hyperliquid ブリッジ + CCTP v2 + USDC、Hyperliquid の typed data と Lighter 用の
  署名専用チェーン — `src/guardrail/contracts.ts`）
- **トランザクションごと**および**1 日の累計**の USD 金額（`max_tx_usd`、`max_daily_usd`）
- **出金ごと**および**1 日の出金**の USD 金額（`max_withdraw_usd`、
  `max_daily_withdraw_usd`）
- **ブロックする関数セレクタ**（`block_selectors`、例: `approve` / `transferFrom`）

`policy_config.allowed_symbols` は入力型としては受け付けられますが、**それを読むチェックは存在しません** — 現時点では
何も強制しません。`policy_config` は必須です: これを含まないコンテキストは拒否され
（「policy_config missing from PolicyContext」）、組み込みのデフォルト値で許可されることはありません。USD 金額はトランザクションのネイティブ `value` と
`eth_price_usd`（ポリシーで指定がない場合のデフォルトは 3500）から算出されるため、ETH 建てでないチェーンや、金額が calldata に含まれる
トークン送金は金額チェックされません。

CLI 経由で設定してください — `--perp-defaults` / `wallet setup` のパスは、インストール済みパッケージ内のこのバイナリをポリシーに
指定し、上限値も設定するため、パスを自分で書く必要はありません:

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

`--perp-defaults` が設定するデフォルト値: `max_tx_usd` 1000、`max_daily_usd` 5000、
`max_withdraw_usd` 500、`max_daily_withdraw_usd` 2000（`DEFAULT_LIMITS`）。ガードレールは OWS 側の第 2 の
防御線であり、perp-cli 自体の取引前リスクゲートを置き換えるものではありません。

## AI エージェントスキル

Claude Code、Cursor、Codex、Gemini CLI などのエージェント CLI 向けのドロップインスキルです。非対話型のコマンドガイド、運用プレイブック、戦略フレームワーク、再利用可能なシェルスクリプト（プリフライト、アービトラージモニター、バリデーション）を同梱しており、エージェントが適切な確認ポイントで停止し、対話型ウィザードで行き詰まることがないようにします。

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

スキルは npm パッケージ内（`perp-cli/skills/perp-cli`）に同梱されているため、グローバルインストールするとローカルでも利用できます:

```bash
npm install -g perp-cli@latest
ls "$(npm root -g)/perp-cli/skills/perp-cli"
```

### スキルの内容

| ファイル | 用途 |
|------|---------|
| `SKILL.md` | トップレベルのエージェントガイド — ルール、ワークフロー、例 |
| `references/commands.md` | 非対話型コマンドの完全なリファレンス（全グループ） |
| `references/agent-operations.md` | セットアップの流れ、冪等性、エラー処理、よくある間違い |
| `references/strategies.md` | ファンディングアービトラージの意思決定フレームワーク + リスク管理 |
| `scripts/preflight.sh` | インストール + ウォレット + 接続性 + リスクの準備状況チェック |
| `scripts/arb-monitor.sh` | オープン中のアービトラージポジションのライブモニター |
| `scripts/spot-perp-scan.sh` | 残高を考慮した現物 + 無期限先物の機会スキャン |
| `scripts/funding-analysis.sh` | 取引所横断のファンディング概要 / シンボル別のドリルダウン |
| `scripts/validate-arb.sh` | 執行前のバリデーション（価格 / 残高 / リスク / dry-run） |

エージェントガイドの全文は [`skills/perp-cli/SKILL.md`](skills/perp-cli/SKILL.md) を参照してください。

## エージェントファーストの CLI 設計

[エージェントファーストの CLI 原則](https://justin.poehnelt.com/posts/rewrite-your-cli-for-ai-agents/)に従って構築されています:

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

すべてのレスポンスは自動的にサニタイズされます（制御文字の除去、プロンプトインジェクションのパターンのブロック）。
エラーには `retryable` フラグが含まれます — `true` の場合にのみリトライしてください。

## ライセンス

MIT
