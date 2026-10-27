# MCP server

[← README](../README.md) · Configuration, network selection and the full tool list.

perp-cli includes a full-featured MCP server (31 tools, 3 resources, 2 prompts) for Claude Desktop, Cursor, and other MCP clients.

**No API keys required for market data** — explore prices, orderbooks, funding rates, and arb opportunities without any setup. Add keys only when you want to trade.

**Network:** set `PERP_NETWORK=testnet` in the server env to serve testnet (validated; unset = mainnet); every result reports `meta.network`. `trade_execute` / `trade_close` place real orders through the same local risk gate as `perp trade` (no override over MCP), refuse non-reduce-only orders on quarantined symbols, and are written to the execution log.

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

For trading and account data, run `perp setup` first: the MCP server reads the same OWS vault wallet and agent keystores as the CLI. Never put private keys in the MCP config. Select the network with `PERP_NETWORK` (`mainnet` | `testnet`; unset = mainnet, invalid values stop the server):
```json
{
  "env": {
    "PERP_NETWORK": "testnet"
  }
}
```

**Read-only tools (no keys):** `get_markets`, `get_orderbook`, `get_funding_rates`, `get_prices`, `get_positions_by_address` (any account's open positions by public address — hyperliquid incl. HIP-3, lighter, lighter-rh, pacifica, risex), `get_balance_by_address` (any account's balances by public address — same venues; omit `exchange` for all), `get_outcome_markets`, `get_outcome_view`, `get_outcome_book`, `get_option_expiries`, `get_option_chain`, `get_option_quote` (Derive options), `pacifica_print_products`, `pacifica_print_quote`, `pacifica_print_positions`, `pacifica_vaults` (Pacifica Print / vaults; writes are CLI-only), `arb_scan`, `health_check`

**Advisor tools (no keys):** `suggest_command`, `explain_command`

**Account & trading tools (keys required):** `get_balance`, `get_positions`, `get_open_orders`, `get_outcome_positions`, `portfolio`, `trade_preview`, `trade_execute`, `trade_close`, `get_funding_analysis`, `get_pnl_analysis`, `get_arb_compare`

- `get_markets` / `get_orderbook` add `meta.apiStatus` (`"unofficial"` + `apiNote` for a venue read through an undocumented API; none at present); `get_prices` lists `meta.unofficialApiVenues`; `health_check` rows carry `apiStatus`. Account read tools cover TxFlow (the account address of the master wallet or a stored agent; without credentials → `NO_SIGNER_AVAILABLE`); TxFlow trading tools refuse with `CAPABILITY_UNSUPPORTED` while TxFlow trading is switched off (implemented, pending testnet verification); `trade_preview` / `trade_execute` / `trade_close` refuse RISEx (read-only) before any credential is read.

**Resources:** `market://prices`, `market://funding-rates`, `perp://schema`

**Prompts:** `trading-guide`, `arb-strategy`
