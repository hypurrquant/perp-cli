[English](README.md) | [한국어](README.ko.md) | **中文** | [日本語](README.ja.md)

> 以英文版 [README](README.md) 为准；本译文可能滞后于英文版。

# perp-cli

[![npm version](https://img.shields.io/npm/v/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![npm downloads](https://img.shields.io/npm/dw/perp-cli.svg)](https://www.npmjs.com/package/perp-cli)
[![license](https://img.shields.io/npm/l/perp-cli.svg)](https://github.com/hypurrquant/perp-cli/blob/main/LICENSE)

多 DEX 永续合约 CLI — **Pacifica**（Solana）、**Hyperliquid**（HyperEVM）、**Lighter**（Ethereum）、**Aster**（BNB Chain）、**Lighter RH**（Robinhood chain）、**Ondo Perps**（链下）、**Arcus**（Robinhood chain）、**QFEX**（链下，TradFi 永续合约）、**RISEx**（RISE chain — 只读；交易功能已规划，尚未上线）、**TxFlow**（仅市场数据 — 非官方 API）、**Variational Omni**（仅市场数据 — 官方 API，RFQ 交易场所）、**GRVT**（仅市场数据 — 官方 API；交易功能已规划，尚未上线）、**Extended**（Starknet，仅市场数据 — 官方 API；交易功能已规划，尚未上线），以及 **Derive** 期权数据（只读）。

```bash
npm install -g perp-cli       # global install
perp --json portfolio

# Or without global install (restricted environments)
npx -y perp-cli --json portfolio
```

本软件包附带 **三个** 可执行文件（`package.json` `bin`）：

| 可执行文件 | 说明 | 文档 |
|---|---|---|
| `perp` | CLI 本体 | [命令分组](#命令分组)、[核心命令](#核心命令) |
| `perp-mcp` | 面向 Claude Desktop、Cursor 及其他 MCP 客户端的 MCP 服务器（stdio） | [MCP 服务器](#mcp-服务器) |
| `perp-guardrail` | OWS Policy Engine 检查器，负责批准或拒绝 agent 密钥的签名请求 | [签名护栏](#签名护栏perp-guardrail) |

## 功能特性

- **13 个永续合约交易场所** — 其中 8 个可交易：Pacifica、Hyperliquid、Lighter、Aster、Lighter RH、Ondo Perps、Arcus、QFEX（跨链桥 / 永续-永续套利覆盖最初的四个）；以下提供市场数据：RISEx（只读；交易功能已规划，尚未上线）、TxFlow（非官方 API，只读）、Variational（官方 API，只读 — 暂无公开交易 API）、GRVT（官方 API，只读 — 交易功能已规划，尚未上线）和 Extended（官方 API，只读 — 交易功能已规划，尚未上线）；另有 **Derive** 期权数据（只读）。详见[支持矩阵](#支持矩阵)
- **资金费率套利** — 永续-永续 + 现货-永续扫描，一条命令完成双腿执行
- **投资组合** — 一次调用即可返回所有交易所的余额、持仓和风险等级
- **资金** — 充值、提现、划转、多提供商跨链桥（cctp/relay/debridge）、交易所间再平衡 — 全部集中在一个命令组中
- **机器人** — TWAP、网格、DCA、追踪止损，支持后台任务管理
- **Agent 优先设计** — `--json`、`--fields`、`--ndjson`、`--dry-run`、运行时 schema 自省
- **安全** — 交易前校验、响应净化、client-id 去重

## 支持矩阵

本版本中各交易场所支持的功能，均从代码推导而来（交易场所定义位于 `src/exchanges/venues/*.ts`，`perp-cli/ws` 编解码器位于 `src/ws/codecs/`，以及 `funds deposit|withdraw` 命令和期权注册表）。✅ = 已实现且可用；— = 不可用。本表说明的是 perp-cli **提供** 了什么，而非用真金白银跑过什么 — 后者请参见[实际可用功能 — 主网验证](#实际可用功能--主网验证2026-10-13)。

| 交易场所 | 市场数据（CLI） | 资金费率 | WS 推送（`perp-cli/ws`） | 按地址查询持仓（`--address`） | 按地址查询余额（`account balance --address`） | 交易 | 通过 perp-cli 充值 | 通过 perp-cli 提现 | 附加功能 | API |
|---|---|---|---|---|---|---|---|---|---|---|
| Hyperliquid（含通过 `--dex` 访问的 HIP-3） | ✅ | ✅ 每小时 | ✅ 公共 + 用户（HIP-3 dex 需手动开启） | ✅（原生 + 所有 HIP-3 dex） | ✅（原生，按账户模式，+ HIP-3 dex；现货） | ✅ | ✅（来自 Arbitrum 的 USDC） | ✅（CCTP） | 现货、outcome（HIP-4）、原生 TWAP | 官方 |
| Pacifica | ✅ | ✅ 每小时 | ✅ 公共 + 用户 | ✅（Solana 地址） | ✅（含现货） | ✅ | ✅ | ✅ | 现货（统一保证金）、原生 TWAP（仅限主钱包签名）；Print（`perp print`）、Vaults（`perp vault`；充值仅限主钱包）和 Atomic basket（`trade atomic`）— 均尚未经过实盘验证；旧版 `wallet manage lake`：`create` 仍可用，`deposit` / `withdraw` 会拒绝并指向 `perp vault` | 官方 |
| Lighter | ✅ | ✅ 每小时 | ✅ 公共 + 用户 | ✅（所有子账户） | ✅（所有子账户；现货） | ✅ | ✅（L1 或 CCTP） | ✅ | 现货、客户端 TWAP | 官方 |
| Lighter RH | ✅ | ✅ 每小时 | ✅ 公共 + 用户（主网；测试网 WS → HTTP 403） | ✅（所有子账户） | ✅（所有子账户；现货） | ✅ | ✅（USDG，主网） | ✅（`-e lighter-rh funds withdraw lighter`） | 现货、客户端 TWAP | 官方 |
| Aster | ✅ | ✅ 按交易对 | ✅ 仅公共（用户频道：已知缺口） | — | — | ✅ | ✅（USDT / USDC，主网） | ✅（agent 需带 `--can-withdraw --ip-whitelist`） | 现货、客户端 TWAP | 官方 |
| Ondo Perps | ✅ | ✅ 每小时 | — | — | — | ✅ | ✅（USDC，主网） | —（API 不允许提现；请用网页应用）⁴ | 现货、客户端 TWAP | 官方 |
| Arcus | ✅ | ✅ 每小时 | ✅ 公共 + 用户 | — | — | ✅ | —（网页应用） | ✅（提至账户所有者） | 现货（链上兑换）、客户端 TWAP | 官方 |
| QFEX | ✅ | 未验证（仅展示，`--include-unverified`） | — | — | — | ✅（无挂单式 reduce-only，无自动化 — 见 [QFEX](#qfex)） | 仅提供地址 | —（暂时禁用；请用网页应用）⁵ | — | 官方 |
| RISEx | ✅ | ✅ 每小时 | — | ✅ | ✅ | —（**只读**；交易功能已规划，尚未上线） | —（仅限应用内） | —（仅限应用内） | 按地址读取账户 | 官方 |
| TxFlow | ✅ | 未验证（仅展示，`--include-unverified`） | — | — | — | —（仅市场数据） | — | — | — | **非官方** |
| Variational | ✅（`market book` = RFQ 报价，而非订单簿） | 未验证（仅展示，`--include-unverified`）；结算周期按市场而定（1h / 4h / 8h） | — | — | — | —（仅市场数据） | — | — | 股票 / ETF / 大宗商品；pre-IPO（不参与匹配） | 官方 |
| GRVT | ✅ | 未验证（仅展示，`--include-unverified`）；结算周期按市场而定（4h / 8h） | —（仅有按合约的推送流） | — | — | —（本版本仅市场数据；交易功能已规划，尚未上线） | — | — | 股票 / ETF、大宗商品；pre-IPO 不参与匹配 | 官方 |
| Extended | ✅（加密货币以及股票 / ETF / 大宗商品 / 指数 / 外汇） | 未验证（仅展示，`--include-unverified`），每小时；`_24_5` 股票在休市时段记为 0 | —（每个推送流一个 socket；暂不支持） | — | — | —（只读） | — | — | 资产类别列；pre-IPO 及有歧义的代码不参与匹配 | 官方 |
| Derive | 仅期权（`perp -e derive options …`） | — | — | — | — | —（**只读**；交易功能已规划，尚未上线） | — | — | 期权：标的、到期日、期权链（IV、希腊值）、报价 | 官方 |

- **资金费率** ✅ = 费率单位已与实际结算的资金费支付核对过（`fundingVerified`），因此该交易场所会参与 `arb scan` 和资金费率策略；未验证的交易场所只在加上 `--include-unverified` 时显示，永远不会被排名或交易。
- **WS 推送** = `perp-cli/ws` / `@hypurrquant/perp-ws` 频道：公共 = 全市场 / 单市场状态及 `bbo`；用户 = 账户、持仓、订单、成交。`book` / `trades` 频道目前在任何交易场所均不可用。
- **按地址查询持仓** = `perp -e <venue> account positions --address <addr>`（不带 `-e`：下列所有交易场所）以及 MCP `get_positions_by_address`：基于交易场所的公开数据查询任意账户的未平仓持仓 — 无需密钥，不签署任何内容。除 Pacifica（base58 Solana 地址）外均为 0x 地址；其他交易场所返回 `CAPABILITY_UNSUPPORTED` 拒绝。
- **按地址查询余额** = `perp -e <venue> account balance --address <addr>`（不带 `-e`：上述所有交易场所）以及 MCP `get_balance_by_address`：基于交易场所的公开数据查询任意账户的余额 — 无需密钥，不签署任何内容。计算方式与查询自己的余额相同（Hyperliquid：权益来源取决于账户的抽象模式）；在交易场所按地址公开现货代币余额时包含现货余额；Lighter：该地址的每个账户各占一行（`--account-index` 可缩小范围）；Hyperliquid：账户价值非零的 HIP-3 dex（查询失败的 dex 会给出警告 — 视为未知，而非零）。其他交易场所返回 `CAPABILITY_UNSUPPORTED` 拒绝。
- **客户端 TWAP** = 在没有原生 TWAP 的交易场所上，由 `trade twap` / `strategy twap` 进行切片下单（QFEX 因自动化闸门而拒绝）。

## 安装配置

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

同一个 EVM 密钥可同时用于 Hyperliquid 和 Lighter。

> **Lighter API Key Index：** 索引 0–3 由 Lighter 前端（网页 / 移动端）保留。perp-cli 默认使用索引 `4`。可通过 `LIGHTER_API_KEY_INDEX` 环境变量覆盖，或使用 `perp wallet agent approve lighter --api-key-index <n>` 管理 agent 槽位。有效范围：4–254。

### Lighter RH, Ondo Perps, Arcus

这些交易场所没有 `wallet set` 私钥路径 — 请改为注册 agent / API 密钥：

```bash
perp wallet agent approve lighter-rh                  # Lighter RH L2 slot key (USDG collateral, Robinhood chain)
printf '%s\n%s\n' "$KEY_ID" "$SECRET" | perp wallet agent approve ondo   # Ondo HMAC key id + secret, stdin only
perp wallet agent approve arcus --master <ows-wallet> # Arcus Ed25519 API key (OWS wallet agent-arcus-<master>)
perp wallet agent verify [lighter-rh|ondo|arcus]      # no venue = verify every configured venue
```

### 本机没有主钱包 — 导入在交易所网站上创建的密钥

在交易场所的网站上创建 agent / API 密钥，然后导入。主钱包无需存在于本机；它仅通过公开地址来识别。密钥从隐藏提示或
stdin 读取（绝不经由 argv），并且**在保存任何内容之前先向交易场所校验** — 校验被拒绝则不保存任何内容；无法在没有主钱包的情况下校验的交易场所会被报告为 `unverified`，绝不会被标记为已验证。

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

使用导入的密钥即可交易。**充值、提现、划转、跨链桥、设置推荐码以及 agent
授权都需要主钱包**：没有主钱包时会以 `NO_SIGNER_AVAILABLE` 失败（"请在交易所
网站上操作，或通过 `perp wallet import` 添加主钱包"）。CLI 无法撤销或轮换导入的密钥 —
请在网站上撤销；`perp wallet agent revoke <venue> <name> --local-only` 会删除本地副本，
`wallet agent import <venue> --agent-name <name> --replace` 可换入一个在网站上新建的密钥。
`perp setup` 对每个交易场所都提供相同的选择：用本机的主钱包授权，或导入一个
在网站上创建的密钥（第 1 步可以跳过主钱包）。

密钥只保存在一处（参见 `docs/SSOT_RULES.md` Rule #3）：Lighter RH → `~/.perp/lighter-rh-agents/`，Ondo → `~/.perp/ondo-agents/<keyId>.json`，Arcus → OWS 钱包 `agent-arcus-<master>`；导入的 EVM / Solana / Ed25519 密钥 → OWS 钱包 `agent-{hl,aster,pac,arcus}-import-<name>`（空口令，与已授权的 agent 钱包相同），导入的 Lighter 密钥 → 带网络标签的 Lighter keystore。缺少钱包 / 密钥时，现在会以 `KEY_NOT_FOUND` / `NO_SIGNER_AVAILABLE` 失败，而不再静默回退为只读。

## 交易场所

| 交易场所 | `-e` id（别名） | 交易 | 备注 |
|-------|-------------------|---------|-------|
| Pacifica | `pacifica`（`pac`） | 是 | Solana |
| Hyperliquid | `hyperliquid`（`hl`） | 是 | HyperEVM；通过 `--dex` 访问 HIP-3 dex |
| Lighter | `lighter`（`lt`） | 是 | Ethereum L2 |
| Aster | `aster`（`ast`） | 是 | BNB Chain；资金费率结算周期按交易对而定 |
| Lighter RH | `lighter-rh`（`lrh`、`rh`） | 是 | 运行在 Robinhood chain 上的 Lighter 引擎，USDG 作保证金 |
| Ondo Perps | `ondo`（`ondo-perps`） | 是 | 链下引擎；限价单 TIF GTC（默认）/ IOC / ALO；限制地区：US、PA |
| QFEX | `qfex`（`qf`） | 是（见下文 **QFEX**） | 托管式链下引擎；股票 / 指数 / 大宗商品，全仓保证金，USDC；限价单 TIF GTC（默认）/ IOC / FOK / ALO；测试网 = QFEX UAT；限制地区：US、GB、ES 等 |
| Arcus | `arcus` | 是 | Robinhood chain，USDG 作保证金；限价单 TIF GTC（默认，以 GTT 发送）/ IOC / FOK / ALO；限制地区：US、CA、GB；**访问白名单** — 未列入的地址会被拒绝（请在 arcus.xyz 申请访问） |
| RISEx | `risex`（`rise`） | **否 — 只读**（交易功能已规划，尚未上线；见下文 **RISEx**） | RISE chain 上的全链上订单簿，USDC；官方 API。提供市场数据、资金费率和按地址读取账户；所有交易 / agent / 机器人路径 → `CAPABILITY_UNSUPPORTED`；充值 / 提现只能在 RISEx 应用中进行 |
| Variational | `variational`（`var`、`omni`） | **否 — 仅市场数据**（见下文 **Variational**） | Variational Omni，一个 RFQ 交易场所（单一做市商，无订单簿）；官方只读 API，暂无公开交易 API。资金费率未验证（仅在 `--include-unverified` 时显示）；限制地区：US、CA 等 |
| GRVT | `grvt`（`grv`） | **否 — 本版本仅市场数据**（交易功能已规划，尚未上线；见下文 **GRVT**） | 混合式永续合约交易所，USDT 作保证金；官方 Market Data API。资金费率未验证（仅在 `--include-unverified` 时显示）；测试网 = `-n testnet`；交易需要 KYC；限制地区：US、CA、SG、HK 等 |
| Extended | `extended`（`ext`、`x10`） | **否 — 本版本仅市场数据**（交易功能已规划，尚未上线；见下文 **Extended**） | Starknet 上的永续合约订单簿（原 X10），USD 作保证金；官方公开 API。加密货币以及 RWA（股票、ETF、指数、大宗商品、外汇）。资金费率未验证（仅在 `--include-unverified` 时显示）；测试网 = Sepolia（`-n testnet`）；限制地区：US、GB、CA、HK 等 |
| TxFlow | `txflow`（`txf`） | **否 — 仅市场数据** | **非官方 API**：TxFlow 目前没有官方 API；perp-cli 读取的是其网页应用所用的未公开 API，可能随时变更或失效，恕不另行通知。资金费率未验证（仅在 `--include-unverified` 时显示） |

- **订单有效期（TIF）：** `trade limit` 在所有交易场所默认使用 `GTC`（通用名称 `GTC | IOC | FOK | ALO`；交易场所不支持的 TIF → `CAPABILITY_UNSUPPORTED`）。Lighter 的只做 Maker（`ALO`）在交易场所验证通过前处于禁用状态。
- **开仓时附带止盈/止损：** `trade market|buy|sell|limit ... --tp <px> --sl <px>` 在所有交易场所含义相同 — *保护本次开仓已确认的成交*。下单前会先检查方向（多头：tp > 参考价 > sl；空头：反之；参考价 = 市价开仓用标记价格，限价开仓用限价）。Ondo 将止盈止损腿附加在订单上；Arcus 发送开仓 + 止盈止损的批量订单；Hyperliquid / Lighter / Aster 先确认开仓成交，再按成交数量下 reduce-only 的止盈止损触发单（仅限市价或 `--tif IOC` 开仓 — 挂单式开仓 → `CAPABILITY_UNSUPPORTED`）；Pacifica 确认成交后设置持仓止盈止损（若该交易对已有持仓或止盈止损则拒绝 — 绝不覆盖）。开仓结果未知 → `ORDER_PENDING` 且**不**设置止盈止损（持仓可能处于无保护状态）；开仓已成交但某条腿失败 → `ORDER_PARTIAL`（不可重试），并返回开仓结果及已下的腿 — 不要重新开仓，请用 `trade tpsl` 补全。
- **对持仓设置止盈/止损：** `trade tpsl <SYM> <long|short> --tp <px> --sl <px> [--tp-limit <px>] [--size <n>]` — 参数是**持仓**方向（不再接受 buy/sell），会与实时持仓核对；各腿均为 reduce-only，数量按实时持仓（或 `--size`）确定。
- **止损单默认为 reduce-only**（所有交易场所的 `trade stop`）；传入 `--no-reduce-only` 可让止损单开仓或反手（Ondo 和 QFEX 拒绝，其止损单始终为 reduce-only）。Lighter / Arcus 的市价触发单以触发价 ± 滑点上限（`--slippage-bps` 或设置项）的限价单执行，在行情剧烈波动时可能无法成交；其他交易场所使用原生市价触发单（`--slippage-bps` → `CAPABILITY_UNSUPPORTED`）。
- **改单：** `trade edit` 保留订单的 TIF。Pacifica：只做 Maker（ALO）订单原生改单；由 perp-cli 下的 GTC / TOB 订单（TIF 记录在 client order id 中）会被撤销并以剩余未成交数量重新下单；TIF 未知的订单 → `CAPABILITY_UNSUPPORTED`（请传入 `--tif`）。
- **滑点上限：** 所有市价类订单（开仓、平仓、现货）都受同一个值约束：`--slippage-bps <n>` → `settings.slippageBps.<venue>` → `settings.defaultSlippageBps`（出厂默认 50，可在 `perp settings show` 中查看；通过 `perp settings set defaultSlippageBps <n>` 修改）。超出 1..交易场所上限（Arcus 为 1000）的值会在发送前被拒绝。
- **限制地区：** 为有地区限制的交易场所（Ondo、Arcus、QFEX）创建签名适配器时，会在 stderr 输出一次性提示；它从不阻止操作 — 请自行查阅交易场所条款。
- **聚合视图**（`portfolio`、`account positions/orders`、`risk`、`history`、`wallet agent verify`、MCP `portfolio`）覆盖所有已配置凭证的账户类交易场所。

### 实际可用功能 — 主网验证（2026-10-13）

下面每个标记都来自真金白银的主网实测，而非代码阅读 — 以交易场所的最小下单量进行，多切片 / 多档位检查时将单交易场所上限提高到约 $25–30，Hyperliquid TWAP 约为 $110。

✅ 已实盘验证 · ⛔ 不支持（在发送任何请求前即拒绝） · ❌ 已实现但尚未在主网运行 · — 交易场所未提供

| 功能 | HL | HIP-3 `xyz` | Pacifica | Lighter | Lighter RH | Aster | Ondo | Arcus | QFEX |
|---|---|---|---|---|---|---|---|---|---|
| 市价 / 限价（GTC、ALO、IOC）、撤单、改单、平仓、减仓、清仓、状态查询 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 开仓 `--tp/--sl`、`trade tpsl`、`trade stop` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 止损限价单 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔ |
| 挂单式 reduce-only 限价单 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔ | ✅ | ⛔（仅 IOC） |
| Client order id（下单 / 查询状态 / 撤单） | ✅ | ✅ | ✅³（UUID） | ✅（数字） | ✅（数字） | ✅ | ✅ | ✅ | 仅限生成的 id |
| 逐仓保证金（设置、带持仓回读、恢复） | ✅ | ✅ | ✅ | ✅ | ✅ | ❌（交易场所以 `-4050` 拒绝，条件未知） | ⛔ | ✅ | ⛔ |
| `trade scale-in` / `scale-tp` | ✅ | ✅（持仓 ≥ $20.5） | ✅ | ✅ | ✅ | ✅ | scale-in ✅ / scale-tp ⛔ — 请改用部分 `trade tpsl --size` ✅ | ✅ | scale-in ✅ / scale-tp ⛔ |
| `trade split` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `trade multi`（多个交易场所上的腿） | ✅ | ✅（全局 `--dex xyz`） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 原生 TWAP（`trade twap`） | ✅ | ❌（HL 最低 $100） | ✅ 主钱包签名 / ⛔ agent 签名 | —² | —² | —² | —² | —² | —² |
| 客户端 TWAP（其他交易场所上的 `trade twap`、`strategy twap`、`--background`） | — | — | — | ✅ | ✅ | ✅ | ✅ | ✅ | ⛔（自动化闸门） |
| 有持仓时的 `account margin` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 现货（`trade spot-*`） | ✅ | — | ✅ | ✅ | ✅ | ❌（需要 USDT） | ✅ | ❌（需要 Arcus 签发的密钥） | — |
| 通过 perp-cli 充值 | ✅ | （HL） | ✅ | ✅ | ✅ | ✅ | ✅ | —（网页应用） | —（仅提供地址） |
| 提现（至本人地址）⁶ | ✅ | （HL） | ✅ | ✅ | ✅ | ✅（`--asset USDC`） | ⛔⁴ | ✅ | ⛔⁵ |

RISEx、TxFlow、Variational、GRVT 和 Extended 不在此表中：本版本中它们均不支持交易。RISEx 交易（已随版本发布但自 0.15.0 起禁用）仅在**测试网**上演练过（2026-10-14）；尚未在主网下过任何 RISEx 订单。

² perp-cli 在该交易场所没有原生 TWAP：`trade twap` 会改为运行客户端 TWAP（切片）。未检查交易场所的 API 是否提供该功能。  
³ 已在会话中验证；未保存日志文件。  
⁴ 不可用：Ondo Perps API 不允许提现（`funds withdraw ondo` → `CAPABILITY_UNSUPPORTED`）。请在 Ondo 网页应用中提现。  
⁵ perp-cli 中暂时禁用（`funds withdraw qfex` → `CAPABILITY_UNSUPPORTED`）。请在 QFEX 网页应用中提现。  
⁶ 主网，2026-10-13：每个交易场所向账户本人地址提现一次，并在目标链上核对到账金额 — `funds withdraw hyperliquid 12.22`（Arbitrum USDC）、`funds withdraw pacifica 12.98`（Solana USDC）、`-e lighter funds withdraw lighter 15.95`（Ethereum USDC）、`-e lighter-rh funds withdraw lighter 12.96` 和 `funds withdraw arcus 9.94`（Robinhood Chain USDG）、`funds withdraw aster 8.74 --chain arbitrum --asset USDC`（Arbitrum USDC）。

自动化功能，已实盘验证（以最小下单量进行有限次运行，运行后停止并清仓）：

| 领域 | 已验证 |
|---|---|
| 套利 | 在 Aster–Arcus、Lighter–Arcus 上的 `arb exec` / `status` / `close`；`arb auto`（Lighter–HL）；现货-永续 `arb exec <sym> spot:hl pacifica` 和 `arb close`；`strategy funding-arb`、`quick-arb`、`funding-auto`（Pacifica–HL）；`strategy delta-neutral`（HL 现货 + Pacifica 永续） |
| 机器人 | `strategy grid` / `dca` / `trailing-stop` / `quick-grid` / `quick-dca` / `preset`（Aster）；通过 `strategy start <config>` 运行全部 12 种引擎策略（Aster）；`strategy apex`（Aster） |
| 执行辅助 | `strategy twap`（Aster）、`trade twap --background`（Arcus）、`strategy plan execute`（10 种动作类型中的 9 种 — 未运行 `cancel_order`）、`perp background stop`（优雅停止：撤销订单，列出持仓） |
| Hyperliquid HIP-4 outcome | GTC 下单 / 撤单、IOC 买入、`outcome sell --all` / `--size` |

资金与跨链桥，已实盘验证（主网，2026-10-13 — `funds bridge send` 运行，在 HL 充值 $11 后执行 `funds rebalance plan` + `execute --withdraw-only`，告警规则命令在未配置渠道的情况下运行）：

| 领域 | 已验证 | 未验证 |
|---|---|---|
| `funds bridge send` | deBridge Arbitrum → Solana USDC（OWS 签名）；Relay 兑换 Arbitrum ETH → Robinhood ETH、Robinhood USDG → Solana SOL / USDC、Robinhood USDG → Arbitrum USDC | CCTP 路线；任何**以 Solana 为源链**的跨链（OWS Solana 签名路径仅有 mock 测试覆盖） |
| `funds bridge exchange` | — | 全部；HyperCore → Solana CCTP 路线（`--from hyperliquid --to pacifica`）疑似损坏（Solana 接收地址编码问题） |
| `funds rebalance` | `plan`；`execute --withdraw-only`（HL → Arbitrum） | `execute --auto-bridge`（尚无 gas 预检查） |
| `funds transfer` | — | HL `usdSend`、QFEX 账户划转（需要接收账户） |
| 告警 | 规则 `add` / `list` / `remove`；`test` / `start` 在未配置渠道时拒绝 | Telegram / Discord 推送（需要 bot token） |

尚未在主网运行：子账户、构建者费用、`strategy claude-agent`（需要 Anthropic 密钥）、仪表盘。

### QFEX

QFEX 是托管式交易场所：没有钱包签名。唯一的凭证是**在 QFEX 网站上创建的 API 密钥**（Developer Settings，2FA），通过 `perp wallet agent import qfex` 导入（公钥 + 私钥经由隐藏提示 / stdin 输入；加密保存在 `~/.perp/qfex-agents/`）。导入时会解析出该密钥交易所用的**唯一账户 UUID**（主账户，或 `--account-id <uuid>`），显示出来，并在你确认前不保存任何内容（管道输入时：传入与之相同的 `--account-id`）。创建交易密钥时**不要**勾选 "Deposit and withdraw" 权限。

```bash
perp -n testnet wallet agent import qfex              # QFEX UAT (api.qfex.io); y/N on the resolved account
perp -e qfex market list                              # public: /refdata + market-data snapshot
perp -e qfex trade limit AAPL buy 320 0.01            # GTC: "accepted" after the ACK; "open" once listed (trade status)
perp -e qfex trade market AAPL buy 0.01               # IOC LIMIT at mark ± slippage (never the venue's unbounded MARKET)
perp -e qfex trade status c:<id> --symbol AAPL        # by the generated client order id
perp funds deposit qfex                               # prints the USDC / Arbitrum One deposit address; you send the funds
```

已在 QFEX 生产环境验证（2026-10-13）：`trade close` / `close-all` / `flatten` / `reduce`（以 reduce-only **IOC** 发送）、`trade stop`、`trade tpsl`（两条腿）、带 `--sl` 的市价开仓、`trade edit`（原生修改 — 生成新的订单 id，但保留 client id，因此 `c:<id>` 仍然可用）、按 `c:<id>` 撤单 / 查询状态。

perp-cli **在 QFEX 上仍然拒绝**的操作（统一返回 `CAPABILITY_UNSUPPORTED`，在发送任何请求之前）：

| 拒绝的操作 | 原因 | 替代做法 |
|---|---|---|
| 挂单式 reduce-only 订单（GTC / ALO 的 `trade limit --reduce-only`、`trade scale-tp`） | 实测：挂单式 reduce-only 订单**在持仓归零后仍保持挂单**；之后若被撮合，交易场所如何处理尚未验证 | reduce-only IOC（`trade close` / `reduce`），或 `trade stop` / `trade tpsl` |
| 止损限价单（`--tp-limit`、带限价的 `trade stop`） | 交易场所的止损单在触发时会转为市价单 | 止损市价单 |
| 会开仓或反手的止损单（`trade stop --no-reduce-only`） | QFEX 的止损单只能减仓 | reduce-only 止损单 |
| 对 reduce-only 订单执行 `trade edit` | reduce-only 订单在下单时按实时持仓确定数量；改单会跳过该检查 | 先 `trade cancel`，再重新下单 |
| `--client-id` | client id 在该交易场所上不唯一；perp-cli 只信任自己生成的 id | 省略该参数（会返回生成的 id） |
| 非 USD 计价的市场（`SKHYNIX-KRW`，…） | 下单数量、风险限额和名义价值均假定以 USD 计价 | QFEX 网页应用 |
| QFEX 上的无人值守自动化：机器人、计划、TWAP、DCA、网格、资金费率套利、追踪止损、后台任务；`arb scan` 排名中的 QFEX | 自动化在验证通过前处于闸门关闭状态（`QFEX_AUTOMATION_VERIFIED`）；资金费率的单位尚未验证，且股票资金费只在一周中的部分时间计提（Q4） | 手动交易 QFEX；仅查看资金费率：`perp arb scan --rates --include-unverified` |

已知注意事项：在持仓刚平掉后立即撤销其止损 / 止盈单，可能会返回 "unexpected error"，而交易场所实际上已自行移除该止损单。QFEX 不保留止损单记录，因此 perp-cli 无法证明撤单成功，会报告 `ORDER_PARTIAL`（pending）— 请检查 `perp -e qfex account orders`；若未列出任何订单，则止损单已不存在。

订单结果从不靠猜测：IOC / 市价单只有在收到交易场所的终态帧时才算最终结果（未成交 → `ORDER_REJECTED`，`reason: iocNoFill`）；订单发出后任何不明确的情况都返回 `ORDER_PENDING` 及可供查询的 `c:<id>` — 切勿重复提交。perp-cli 从不启用 QFEX 的断线撤单（cancel-on-disconnect），但**同一用户的另一个启用了该功能的连接（例如官方 QFEX CLI）在断开时会撤销该账户的所有订单**。

**提现** 目前在 perp-cli 中禁用（`funds withdraw qfex` → `CAPABILITY_UNSUPPORTED`，`--dry-run` 下同样如此）；请在 QFEX 网页应用中提现。子账户：`perp -e qfex funds transfer <amount> primary --from <account uuid>`。

### RISEx（只读 — 交易功能已规划，尚未上线）

RISEx 是 RISE chain 上的全链上永续合约订单簿（USDC 作保证金），通过其**官方** API 接入。新交易场所分阶段上线：本版本中 perp-cli 仅读取 RISEx 数据；交易功能将在后续版本中推出。

```bash
perp -e risex market list                     # public; funding = last settled hourly rate (verified)
perp -e risex market book BTC                 # also: prices | info | trades | kline | funding
perp arb scan --rates                         # RISEx rows in the funding comparison
perp health                                   # RISEx is probed as an official venue
perp -e risex account positions --ows <master>   # account reads are public by address — nothing is signed
```

- **本版本中拒绝的操作**（`CAPABILITY_UNSUPPORTED`，"RISEx trading is planned for a later perp-cli release"，在读取任何密钥或发送任何请求之前 — `--dry-run` 下同样如此）：所有 `perp -e risex trade …` 写操作、`trade multi` / `arb exec` / `arb auto` 的腿、所有 `strategy …` 命令（机器人、计划、TWAP / 网格 / DCA、`--exchanges` 腿）、`wallet agent approve|import|revoke|rotate risex`（`revoke --force` 仅清除本地记录）、`perp setup --venues risex`、`funds faucet risex`，以及 MCP 的 `trade_preview` / `trade_execute` / `trade_close` 工具。`arb scan --basis` 只覆盖可交易的交易场所，因此不包含 RISEx；在 `arb scan` 中，含 RISEx 腿的交易对会被标记为 `executable: false` / "(read-only)"。
- **资金：** 充值和提现在 RISEx 应用（app.rise.trade）中完成。`funds deposit|withdraw risex`、`funds transfer -e risex` 以及涉及 risex 的 `funds rebalance execute` 均以 `CAPABILITY_UNSUPPORTED` 拒绝（`--dry-run` 下同样如此）。
- 交易代码（链上限制为仅可交易的会话签名器、EIP-712 permit）及其测试已随版本发布，但由一个开关关闭（`src/exchanges/venues/risex-release.ts` 中的 `RISEX_TRADING_ENABLED`）。

### TxFlow（仅市场数据 — 非官方 API）

TxFlow 尚未发布官方 API。perp-cli 读取的是 app.txflow.com 所用的**未公开** API — 只读，且可能随时变更或被封锁。每一行 JSON 都带有 `venueApi: "unofficial"`（在混合表格和 MCP 输出中为 `apiStatus`）；人类可读输出会附加脚注。

```bash
perp -e txflow market list | info <SYM> | book <SYM> | trades <SYM> | kline <SYM> 1h
perp arb scan --rates --include-unverified                  # TxFlow funding (percent per hour on the venue, shown as a fraction), display only
```

所有交易 / 账户 / 投资组合 / 资金（充值、提现、划转、再平衡）/ agent / builder / 策略 / arb exec 命令，以及所有 MCP 账户或交易工具，都会在发出任何请求前以 `CAPABILITY_UNSUPPORTED` 拒绝 TxFlow。没有资金费率历史，也没有测试网；无法证明资金费率结算周期为 1 小时的市场，其资金费率显示为未知。

### Variational（仅市场数据 — 官方 API）

Variational Omni 是一个 RFQ 交易场所：由其唯一的做市商（OLP）为每笔交易报价，因此没有订单簿。perp-cli 读取其**官方**、有文档的只读 API（一次 `GET /metadata/v2/stats` 调用获取全部市场，共享缓存 5 秒；交易场所限制为每 IP 每 10 秒 10 次请求）。Variational 暂无公开交易 API。

```bash
perp -e variational market list | prices | info <SYM>   # perps by base (BTC), swaps keep the suffix (XAU-SWAP)
perp -e variational market book BTC                      # the OLP's indicative RFQ quotes at fixed sizes — not an order book
perp -e variational market funding BTC                   # current terms: per interval (1h / 4h / 8h per market), hourly, APR
perp arb scan --rates --include-unverified               # Variational funding rows, display only
perp health                                              # probed as an official venue
```

- **资金费率未验证：** 公布的费率是对下一次支付的动态预测，无法与实际结算的支付核对（没有公开的账户 API），因此仅在 `--include-unverified` 时显示 — 永远不会被排名、交易或保存到资金费率历史中。没有资金费率历史接口。
- **交易对：** TradFi 永续合约（股票、ETF、大宗商品）会被显式分类；`US500-PERP` 是 SPDR S&P 500 ETF（按 `SPY` 比较）；pre-IPO 市场、互换（swap）、`SPX`（SPX6900）和 `QNT`（Quant）永远不会跨交易场所匹配。不公布指数价格、最小价格变动、最小数量单位、杠杆或以基础资产计的未平仓量（显示为 `-` / null）。
- **拒绝的操作**（`CAPABILITY_UNSUPPORTED`，在发出任何请求前 — `--dry-run` 下同样如此）：所有交易 / 账户 / 投资组合 / 资金 / agent / builder / 策略 / arb exec 命令，以及所有 MCP 账户或交易工具。没有测试网，没有 WebSocket。

### GRVT（仅市场数据 — 官方 API）

GRVT 是一个混合式永续合约交易所（链下撮合，USDT 作保证金）。perp-cli 读取其**官方**、无需密钥的 Market Data API（`POST https://market-data.grvt.io/full/v1/…`；测试网 `-n testnet`）。本版本中 GRVT 为只读；交易功能计划在后续版本中推出。

```bash
perp -e grvt market list | prices | info <SYM>   # base tickers (BTC, KPEPE, XAU, AAPL); BTC_USDT_Perp also accepted
perp -e grvt market book BTC                      # order book (10 / 50 / 100 / 500 levels served)
perp -e grvt market funding BTC                   # settled funding history (per 4h / 8h interval)
perp -e grvt market trades | kline BTC …          # public tape / candles
perp arb scan --rates --include-unverified        # GRVT funding rows, display only
perp health                                       # probed as an official venue
```

- **资金费率未验证：** 结算周期按市场而定（4h 或 8h）；市场行中携带的是 GRVT 对当前周期的指示性费率（`fundingRateKind: "predicted"`），已从百分比换算为每周期的小数。它尚未与实际结算的支付核对，因此仅在 `--include-unverified` 时显示 — 永远不会被排名或交易。
- **交易对：** 加密货币按代码匹配；股票 / ETF 按经过审核的列表中的代码匹配；XAU / XAG / CL / BZ → GOLD / SILVER / WTI / Brent；pre-IPO 市场（OPENAI、ANTHROPIC、SPACEX）及有歧义的代码永远不会跨交易场所匹配。不公布最小数量步长（`stepSize` 为 null）；最大杠杆取自 GRVT 的保证金规则（`market list|prices|info`，最多缓存 6 小时 — `leverageAsOf`）。
- **请求：** GRVT 没有批量 ticker 接口，因此完整读取一次市场数据需对每个市场请求一次 ticker（约 185 次请求，约 5 秒），结果复用 15 秒；文档中的限额（ticker 每分钟 1500 次，其余每分钟 500 次）由交易场所限流器执行。
- **拒绝的操作**（`CAPABILITY_UNSUPPORTED`，"GRVT is read-only (market data) in this version; trading is planned for a later release"，在发出任何请求前 — `--dry-run` 下同样如此）：所有交易 / 账户 / 投资组合 / 资金 / agent / builder / 策略 / arb exec 命令、`setup --venues grvt`，以及所有 MCP 账户或交易工具。没有 `perp-cli/ws` 编解码器（GRVT 的推送流按合约划分，数量上限低于其市场数）。

### Extended（仅市场数据 — 官方 API）

Extended（原 X10）是 Starknet 上的永续合约订单簿（USD 作保证金），上线加密货币和 RWA 市场（股票、ETF、指数、大宗商品、外汇）。perp-cli 读取其**官方**、无需密钥的公开 API（`https://api.starknet.extended.exchange/api/v1`；测试网 Sepolia `-n testnet`）。本版本中 Extended 为只读；交易功能计划在后续版本中推出。

```bash
perp -e extended market list | prices | info <SYM>   # base tickers (BTC, TSLA, SPX500M); wire names (TSLA_24_5-USD) also accepted
perp -e extended market book TSLA                     # order book (RFQ markets: the indicative book)
perp -e extended market funding ETH                   # applied hourly funding prints
perp -e extended market trades | kline BTC …          # public tape / candles
perp arb scan --rates --include-unverified            # Extended funding rows, display only
perp health                                           # probed as an official venue
```

- **资金费率未验证：** 每小时结算一次，为每小时的小数费率，四舍五入到 6 位小数。市场行中携带的是当前小时正在累计的费率（`fundingRateKind: "accruing"`）；`market funding` 显示已结算的记录。它尚未与账户的资金费支付核对，且 `_24_5` 股票在标的休市期间记为 0，因此仅在 `--include-unverified` 时显示 — 永远不会被排名或交易。
- **交易对：** 去掉 `_24_5` 后缀的资产名称（`TSLA_24_5-USD` → `TSLA`）；`market list` 显示资产类别列。加密货币按代码匹配；股票 / ETF 按代码匹配；XAU / XAG / WTI / XBR → GOLD / SILVER / WTI / Brent，SPX500M / TECH100M → SPX / NDX。pre-IPO 市场、在其他地方是加密货币代码的 RWA 代码（PURR、QNT、BB、ON、ADI、BOT）、XIAOMI 以及加密货币 `SPX`（SPX6900）永远不会跨交易场所匹配。
- **拒绝的操作**（`CAPABILITY_UNSUPPORTED`，"Extended is read-only (market data) in this version; trading is planned for a later release"，在发出任何请求前 — `--dry-run` 下同样如此）：所有交易 / 账户 / 投资组合 / 资金 / agent / builder / 策略 / arb exec 命令、`setup --venues extended`，以及所有 MCP 账户或交易工具。没有 `perp-cli/ws` 编解码器（Extended 的推送流为每个流 URL 一个 socket，没有订阅帧）。

### 期权市场数据 — Derive（只读）

通过官方公开 API 获取 Derive（derive.xyz）期权数据 — 无需密钥；不下单、不涉及账户、不签名（交易功能已规划，尚未上线）。Derive 不是永续合约交易场所：`-e derive` 仅可与 `perp options` 搭配使用。

```bash
perp --json -e derive options underlyings
perp --json -e derive options expiries ETH
perp --json -e derive options chain ETH --expiry 2026-12-25 --strikes 10   # bid/ask, mark, IV, greeks, OI per strike
perp --json -e derive options quote ETH-20261225-3500-P
```

### 现货交易

现货支持按交易场所声明（`VenueDefinition.spot`），所有现货命令、投资组合视图和机器人都经由同一个工厂。交易对格式为 `BASE/QUOTE`；只写基础资产（`ETH`）时使用该交易场所的第一个计价资产。

| 交易场所 | 账户模型 | 计价资产 | 限价 / 订单簿 / 撤单 | 现货↔永续划转 |
|-------|---------------|-------|-----------------------|--------------------|
| Hyperliquid | 运行时决定（统一账户与永续共享 USDC；标准账户则相互独立） | USDC | 是 | 是（统一账户上为空操作） |
| Lighter / Lighter RH | 独立 | USDC / USDG | 是 | 是 |
| Aster | 独立（`sapi` 现货账户） | USDT、USD1（只写基础资产 → USDT） | 是 | 是 |
| Pacifica | **统一** — 现货与永续共享同一账户 | USDC | 是 | 否（无需划转） |
| Ondo Perps | 独立（现货钱包 ↔ 保证金） | USDC | 是 | 是 |
| Arcus | **钱包** — 从你的 EVM 主钱包进行链上兑换（router、Permit2） | USDG | 否（仅市价兑换） | 否 |

```bash
perp --json -e <EX> trade spot-buy <SYM> <SIZE> [--slippage-bps <n>] [--yes]
perp --json -e <EX> trade spot-sell <SYM> <SIZE> [--slippage-bps <n>] [--yes]
perp --json -e <EX> trade spot-limit <SYM> <buy|sell> <PRICE> <SIZE> [--tif GTC|IOC|ALO]
perp --json -e <EX> trade spot-cancel <SYM> <ORDER_ID>
perp --json -e <EX> trade spot-orders [SYM]
perp --json -e <EX> trade spot-transfer <to-spot|to-perp> <AMOUNT>   # moves the venue's first quote asset
perp --json -e <EX> trade spot-balance
```

- **不支持的操作会明确报错**，返回 `CAPABILITY_UNSUPPORTED`（例如 Arcus 上的 `spot-limit` / `spot-cancel` / `spot-orders` / `spot-transfer`）。
- **共享余额账户上的 `spot-transfer`**（Pacifica、Hyperliquid 统一账户）会作为空操作成功返回，并带有 `execution.method: "sharedAccount"`（无需移动任何资金）；真正发生划转时报告 `execution.method: "transfer"`。
- **滑点：** 与永续合约规则相同 — `--slippage-bps <n>` → `settings.slippageBps.<venue>` → `settings.defaultSlippageBps`（出厂值 50）。
- **Pacifica：** 现货买入会消耗共享的 USDC 永续保证金，并减少永续可用保证金（首次买入前会打印警告）。Pacifica `getMarkets()`（永续）不再列出 `SOL-USDC` 现货市场。
- **Aster：** agent 签名器需要现货权限 — `perp wallet agent rotate aster --can-spot`（或 `perp wallet agent approve aster --can-spot`）；否则现货订单会以 `POLICY_DENIED` 失败。
- **Arcus：** 兑换经由 `router.spot.arcus.xyz`，从 EVM 主钱包在 Robinhood chain 上结算（`--ows` / 当前 OWS 钱包；没有则 → `NO_SIGNER_AVAILABLE`）。现货只需要主钱包 — 无需 Arcus 永续 agent 密钥；没有该密钥时，永续订单 / 账户读取会以 `AGENT_NOT_REGISTERED` 失败（`perp wallet agent approve arcus`）。列出 Arcus 现货市场很慢（约 80 秒，每个代币调用一次 router `/price`）— 请直接使用 `spot-buy` / `spot-sell`。不支持 EIP-2612 permit 的代币需要一次性的链上 `approve(Permit2)`，会消耗 Robinhood Chain ETH 作为 gas — 传入 `--yes` 以允许该操作。结果会显示 `status`、`finality`、`receivedToken` 及补救建议；`pending` 结果表示兑换已提交 — **切勿重复提交**。
- **结果：** 现货订单会打印标准化结果（状态、最终性、成交数量、成交均价、收到的代币、补救建议）。`spot-buy` / `spot-sell` 在所有交易场所上都会附加一条 `execution` 记录（方式、滑点 bps 及其来源、交易场所路径计算出的保护价格和参考价）。`spot-cancel` 在所有交易场所上都返回统一的 `SpotOrderResult` 结构（Lighter 撤单在 `spot-orders` 确认前为 `pending`）；`spot-orders` 在所有交易场所上列出相同的列（包括 Hyperliquid）。
- **投资组合 / 首页概览：** 现货价值会叠加在永续权益之上，标记为 `shared` 的余额除外（Pacifica USDC、Hyperliquid 统一账户 USDC）。没有现货价格的代币会被排除在合计之外，并在 stderr 输出警告（绝不按 0 估值）。
- **机器人与套利**（`funding-arb`、`spot-perp-arb`、`arb exec spot:<venue>`、`arb close`、`arb scan --mode spot-perp`）只使用具有独立（或运行时决定）现货余额**且**支持现货↔永续划转的现货交易场所：hyperliquid、lighter、lighter-rh、aster、ondo。Pacifica（共享保证金）和 Arcus（链上兑换）会以 `CAPABILITY_UNSUPPORTED` 拒绝；请用 `trade spot-*` 手动交易。

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

### 构建者费用（默认关闭）

除非你自行配置且交易场所的授权已确认，否则 perp-cli **不会**附加任何构建者费用（builder fee）：

```bash
perp settings set builder.hyperliquid 0xBuilder…,1   # <address|code>,<feeBps> — strict: format, venue cap; asks y/N (or --yes)
perp wallet builder status                            # per venue: supported? configured? approved? attached?
perp --dry-run wallet builder approve hyperliquid     # plan only
perp wallet builder approve hyperliquid               # master-signed, asks y/N (or --yes)
perp --no-builder trade market BTC buy 0.1            # skip it for one command
perp settings unset builder.hyperliquid               # off again
```

支持：hyperliquid（≤ 10 bps，不适用于 HIP-3 dex）、pacifica（最高 ≤ 10 bps，不适用于现货）、aster（≤ 10 bps，主网）、ondo（≤ 10 bps，无需授权步骤）、qfex（`perp settings set builder.qfex <uuid>` — 属于**手续费分成**：你的成交会归属到该 builder code，你支付正常手续费，没有额外费用；该代码随交易连接一同发送；仅限主网）。Lighter / Lighter RH / Arcus：不支持。如果授权缺失或无法读取，订单会**不带**该费用发送，结果中的 `execution.notes` 会说明原因；`execution.builderFee` 显示实际附加的费用。

## 核心命令

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

## Telegram 告警

通过 Telegram 推送资金费率告警，支持后台守护进程。

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

设置流程：BotFather token → 校验 bot → 向 bot 发送 `/start` → 自动识别 chat ID → 发送测试消息。

交易所参数：`-e hyperliquid` / `-e pacifica` / `-e lighter` / `-e aster`（别名：`hl`、`pac`、`lt`）。

全局参数：`--json`、`--fields <f>`、`--ndjson`、`--dry-run`、`--dex <name>`（HIP-3）、`-w, --wallet <name>`。

## MCP 服务器

[![Glama MCP server](https://glama.ai/mcp/servers/hypurrquant/perp-cli/badges/score.svg)](https://glama.ai/mcp/servers/hypurrquant/perp-cli)

perp-cli 内置功能完整的 MCP 服务器（30 个工具、3 个资源、2 个提示词），可用于 Claude Desktop、Cursor 及其他 MCP 客户端。

**查询市场数据无需 API 密钥** — 无需任何配置即可浏览价格、订单簿、资金费率和套利机会。只有在需要交易时才添加密钥。

**网络：** 在服务器 env 中设置 `PERP_NETWORK=testnet` 即可使用测试网（会做校验；未设置 = 主网）；每个结果都会报告 `meta.network`。`trade_execute` / `trade_close` 会经过与 `perp trade` 相同的本地风控闸门下真实订单（MCP 无法覆盖），拒绝在被隔离的交易对上下非 reduce-only 订单，并写入执行日志。

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

如需交易和账户数据，请先运行 `perp setup`：MCP 服务器读取的是与 CLI 相同的 OWS vault 钱包和 agent keystore。切勿在 MCP 配置中放入私钥。通过 `PERP_NETWORK` 选择网络（`mainnet` | `testnet`；未设置 = 主网，无效值会导致服务器停止）：
```json
{
  "env": {
    "PERP_NETWORK": "testnet"
  }
}
```

**只读工具（无需密钥）：** `get_markets`、`get_orderbook`、`get_funding_rates`、`get_prices`、`get_positions_by_address`（通过公开地址查询任意账户的未平仓持仓 — hyperliquid（含 HIP-3）、lighter、lighter-rh、pacifica、risex）、`get_balance_by_address`（通过公开地址查询任意账户的余额 — 相同的交易场所；省略 `exchange` 则查询全部）、`get_outcome_markets`、`get_outcome_view`、`get_outcome_book`、`get_option_expiries`、`get_option_chain`、`get_option_quote`（Derive 期权）、`pacifica_print_products`、`pacifica_print_quote`、`pacifica_print_positions`、`pacifica_vaults`（Pacifica Print / vaults；写操作仅限 CLI）、`arb_scan`、`health_check`

**顾问工具（无需密钥）：** `suggest_command`、`explain_command`

**账户与交易工具（需要密钥）：** `get_balance`、`get_positions`、`get_open_orders`、`get_outcome_positions`、`portfolio`、`trade_preview`、`trade_execute`、`trade_close`、`get_funding_analysis`、`get_pnl_analysis`、`get_arb_compare`

- `get_markets` / `get_orderbook` 会附加 `meta.apiStatus`（TxFlow 为 `"unofficial"` + `apiNote`）；`get_prices` 列出 `meta.unofficialApiVenues`；`health_check` 的每一行带有 `apiStatus`。账户 / 交易工具以 `CAPABILITY_UNSUPPORTED` 拒绝 TxFlow；`trade_preview` / `trade_execute` / `trade_close` 会在读取任何凭证前拒绝 RISEx（只读）。

**资源：** `market://prices`、`market://funding-rates`、`perp://schema`

**提示词：** `trading-guide`、`arb-strategy`

## 签名护栏（`perp-guardrail`）

随包附带的第三个可执行文件。它**不是**供你手动运行的命令：它是 [OWS](https://github.com/open-wallet-standard) Policy Engine 在 agent API 密钥签署任何内容之前
所启动的自定义策略可执行文件。OWS 将一个 `PolicyContext` JSON 文档写入其 stdin；它在
stdout 上返回一个 JSON 文档，`{"allow": true}` 或 `{"allow": false, "reason": "..."}`。被拒绝的请求永远不会被签名。

它根据策略所携带的 `policy_config` 检查以下内容（`src/guardrail/perp-guardrail.ts`）：

- 依据按链划分的白名单检查**链**和**目标合约**（Solana 主网 / devnet 上的 Pacifica 程序、
  Arbitrum / Base / Ethereum 上的 Hyperliquid bridge + CCTP v2 + USDC，以及用于 Hyperliquid typed data 和 Lighter 的
  仅签名链 — `src/guardrail/contracts.ts`）；
- **单笔交易**和**每日累计**的 USD 金额（`max_tx_usd`、`max_daily_usd`）；
- **单笔提现**和**每日提现**的 USD 金额（`max_withdraw_usd`、
  `max_daily_withdraw_usd`）；
- **被阻止的函数选择器**（`block_selectors`，例如 `approve` / `transferFrom`）。

输入类型接受 `policy_config.allowed_symbols`，但**没有任何检查会读取它** — 目前它不起任何
约束作用。`policy_config` 是必需的：不带它的上下文会被拒绝
（"policy_config missing from PolicyContext"），绝不会依靠内置默认值放行。USD 金额由交易的原生 `value` 结合
`eth_price_usd` 推算（策略未指定时默认为 3500），因此非 ETH 计价的链，或金额位于 calldata 中的代币
转账，不会进行金额检查。

请通过 CLI 接入 — `--perp-defaults` / `wallet setup` 路径会把策略指向已安装软件包内的这个
可执行文件并填好限额，因此你永远不需要自己写路径：

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

由 `--perp-defaults` 填入时的默认值：`max_tx_usd` 1000、`max_daily_usd` 5000、
`max_withdraw_usd` 500、`max_daily_withdraw_usd` 2000（`DEFAULT_LIMITS`）。护栏是 OWS 一侧的第二道
防线；它不能取代 perp-cli 自身的交易前风控闸门。

## AI Agent 技能

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

## 许可证

MIT
