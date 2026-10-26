# Signing guardrail (`perp-guardrail`)

[← README](../README.md)

The third shipped binary. It is **not** a command you run by hand: it is the custom policy executable
the [OWS](https://github.com/open-wallet-standard) Policy Engine spawns before an agent API key signs
anything. OWS writes a `PolicyContext` JSON document to its stdin; it answers one JSON document on
stdout, `{"allow": true}` or `{"allow": false, "reason": "..."}`. A denied request is never signed.

What it checks, from the `policy_config` the policy carries (`src/guardrail/perp-guardrail.ts`):

- the **chain** and the **destination contract** against the per-chain whitelist (Pacifica programs on
  Solana mainnet / devnet, the Hyperliquid bridge + CCTP v2 + USDC on Arbitrum / Base / Ethereum, the
  signing-only chains for Hyperliquid typed data and Lighter — `src/guardrail/contracts.ts`);
- the **per-transaction** and **daily cumulative** USD amount (`max_tx_usd`, `max_daily_usd`);
- the **per-withdrawal** and **daily withdrawal** USD amount (`max_withdraw_usd`,
  `max_daily_withdraw_usd`);
- **blocked function selectors** (`block_selectors`, e.g. `approve` / `transferFrom`).

`policy_config.allowed_symbols` is accepted by the input type but **no check reads it** — it enforces
nothing today. `policy_config` is required: a context without it is denied
("policy_config missing from PolicyContext"), never allowed by baked-in defaults. USD amounts are derived from the transaction's native `value` with
`eth_price_usd` (default 3500 when the policy states none), so a non-ETH-denominated chain or a token
transfer whose amount lives in calldata is not amount-checked.

Wire it up through the CLI — the `--perp-defaults` / `wallet setup` paths point the policy at this
binary inside the installed package and fill the limits in, so you never write the path yourself:

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

Defaults when `--perp-defaults` fills them in: `max_tx_usd` 1000, `max_daily_usd` 5000,
`max_withdraw_usd` 500, `max_daily_withdraw_usd` 2000 (`DEFAULT_LIMITS`). The guardrail is a second
line of defence on the OWS side; it does not replace perp-cli's own pre-trade risk gate.
