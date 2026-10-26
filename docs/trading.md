# Trading

[← README](../README.md) · Order semantics shared by every venue, spot trading and builder fees.

## Order semantics

- **Time in force:** `trade limit` defaults to `GTC` on every venue (common names `GTC | IOC | FOK | ALO`; a TIF the venue does not offer → `CAPABILITY_UNSUPPORTED`). Lighter post-only (`ALO`) is disabled until verified on the venue.
- **TP/SL on an entry:** `trade market|buy|sell|limit ... --tp <px> --sl <px>` means the same on every venue — *protect this entry's verified fill*. The direction is checked before anything is sent (long: tp > reference > sl; short: the reverse; reference = mark for market entries, the limit price for limit entries). Ondo attaches the legs to the order; Arcus sends an entry+TP/SL batch; Hyperliquid / Lighter / Aster verify the entry fill, then place reduce-only TP/SL trigger orders sized to it (only market or `--tif IOC` entries — a resting entry → `CAPABILITY_UNSUPPORTED`); Pacifica verifies the fill, then sets position TP/SL (refused if the symbol already has a position or TP/SL — never overwritten). Entry outcome unknown → `ORDER_PENDING` and **no** TP/SL (the position may be unprotected); entry filled but a leg failed → `ORDER_PARTIAL` (not retryable) with the entry result and which legs were placed — do not re-enter, finish with `trade tpsl`.
- **TP/SL on a position:** `trade tpsl <SYM> <long|short> --tp <px> --sl <px> [--tp-limit <px>] [--size <n>]` — the argument is the **position's** side (buy/sell no longer accepted), checked against the live position; legs are reduce-only and sized to the live position (or `--size`).
- **Stop orders are reduce-only by default** on every venue (`trade stop`); pass `--no-reduce-only` to let a stop open or flip a position (refused on Ondo and QFEX, whose stops are always reduce-only). Lighter / Arcus market triggers execute as a limit at trigger ± the slippage bound (`--slippage-bps` or settings) and may stay unfilled in a fast move; other venues use native market triggers (`--slippage-bps` → `CAPABILITY_UNSUPPORTED`).
- **Order edit:** `trade edit` keeps the order's TIF. Pacifica: post-only (ALO) orders are edited natively; GTC / TOB orders placed by perp-cli (TIF recorded in the client order id) are cancelled and replaced with the remaining open size; orders whose TIF is unknown → `CAPABILITY_UNSUPPORTED` (pass `--tif`).
- **Slippage bound:** every market-type order (entry, close, spot) is bounded by one value: `--slippage-bps <n>` → `settings.slippageBps.<venue>` → `settings.defaultSlippageBps` (shipped default 50, shown in `perp settings show`; change with `perp settings set defaultSlippageBps <n>`). Values outside 1..venue max (Arcus 1000) are rejected before sending.

## Spot trading

Spot support is declared per venue (`VenueDefinition.spot`) and every spot command, portfolio view and bot goes through one factory. Symbols are `BASE/QUOTE`; a bare base (`ETH`) uses the venue's first quote asset.

| Venue | Account model | Quote | Limit / book / cancel | Spot↔perp transfer |
|-------|---------------|-------|-----------------------|--------------------|
| Hyperliquid | runtime (unified accounts share USDC with perp; standard accounts are separate) | USDC | yes | yes (no-op on unified accounts) |
| Lighter / Lighter RH | separate | USDC / USDG | yes | yes |
| Aster | separate (`sapi` spot account) | USDT, USD1 (bare base → USDT) | yes | yes |
| Pacifica | **unified** — spot shares the perp account | USDC | yes | no (not needed) |
| Ondo Perps | separate (spot wallet ↔ margin) | USDC | yes | yes |
| Arcus | **wallet** — on-chain swaps from your master EVM wallet (router, Permit2) | USDG | no (market swaps only) | no |

```bash
perp --json -e <EX> trade spot-buy <SYM> <SIZE> [--slippage-bps <n>] [--yes]
perp --json -e <EX> trade spot-sell <SYM> <SIZE> [--slippage-bps <n>] [--yes]
perp --json -e <EX> trade spot-limit <SYM> <buy|sell> <PRICE> <SIZE> [--tif GTC|IOC|ALO]
perp --json -e <EX> trade spot-cancel <SYM> <ORDER_ID>
perp --json -e <EX> trade spot-orders [SYM]
perp --json -e <EX> trade spot-transfer <to-spot|to-perp> <AMOUNT>   # moves the venue's first quote asset
perp --json -e <EX> trade spot-balance
```

- **Unsupported operations fail loudly** with `CAPABILITY_UNSUPPORTED` (e.g. `spot-limit` / `spot-cancel` / `spot-orders` / `spot-transfer` on Arcus).
- **`spot-transfer` on a shared-balance account** (Pacifica, Hyperliquid unified) succeeds as a no-op with `execution.method: "sharedAccount"` (nothing needs to move); a real move reports `execution.method: "transfer"`.
- **Slippage:** same rule as perps — `--slippage-bps <n>` → `settings.slippageBps.<venue>` → `settings.defaultSlippageBps` (shipped 50).
- **Pacifica:** spot buys spend the shared USDC perp margin and reduce perp available margin (a warning is printed before the first buy). Pacifica `getMarkets()` (perp) no longer lists the `SOL-USDC` spot market.
- **Aster:** an agent signer needs spot permission — `perp wallet agent rotate aster --can-spot` (or `perp wallet agent approve aster --can-spot`); otherwise spot orders fail with `POLICY_DENIED`.
- **Arcus:** swaps go through `router.spot.arcus.xyz` and settle on the Robinhood chain from the master EVM wallet (`--ows` / active OWS wallet; none → `NO_SIGNER_AVAILABLE`). Spot needs only the master wallet — no Arcus perp agent key; perp orders / account reads without one fail with `AGENT_NOT_REGISTERED` (`perp wallet agent approve arcus`). Listing Arcus spot markets is slow (~80 s, one router `/price` per token) — use `spot-buy` / `spot-sell` directly. Tokens without EIP-2612 permit need a one-time on-chain `approve(Permit2)` that costs Robinhood Chain ETH gas — pass `--yes` to allow it. Results show `status`, `finality`, `receivedToken` and a remediation; a `pending` result means the swap was submitted — **do not resubmit**.
- **Results:** spot orders print the normalized result (status, finality, filled size, average price, received token, remediation). `spot-buy` / `spot-sell` add an `execution` record on every venue (method, slippage bps + source, protection price and reference where the venue path computes one). `spot-cancel` returns one `SpotOrderResult` shape on every venue (a Lighter cancel is `pending` until `spot-orders` confirms it); `spot-orders` lists the same columns on every venue (Hyperliquid included).
- **Portfolio / landing:** spot value is added on top of perp equity except balances marked `shared` (Pacifica USDC, Hyperliquid unified USDC). Tokens without a spot price are excluded from totals with a stderr warning (never valued at 0).
- **Bots and arb** (`funding-arb`, `spot-perp-arb`, `arb exec spot:<venue>`, `arb close`, `arb scan --mode spot-perp`) only use spot venues with a separate (or runtime) spot balance **and** a spot↔perp transfer: hyperliquid, lighter, lighter-rh, aster, ondo. Pacifica (shared margin) and Arcus (on-chain swaps) are refused with `CAPABILITY_UNSUPPORTED`; trade them manually with `trade spot-*`.

## Builder fees (off by default)

perp-cli attaches **no** builder fee unless you configure one and the venue approval is confirmed:

```bash
perp settings set builder.hyperliquid 0xBuilder…,1   # <address|code>,<feeBps> — strict: format, venue cap; asks y/N (or --yes)
perp wallet builder status                            # per venue: supported? configured? approved? attached?
perp --dry-run wallet builder approve hyperliquid     # plan only
perp wallet builder approve hyperliquid               # master-signed, asks y/N (or --yes)
perp --no-builder trade market BTC buy 0.1            # skip it for one command
perp settings unset builder.hyperliquid               # off again
```

Supported: hyperliquid (≤ 10 bps, not on HIP-3 dexes), pacifica (≤ 10 bps max, not on spot), aster (≤ 10 bps, mainnet), ondo (≤ 10 bps, no approval step), qfex (`perp settings set builder.qfex <uuid>` — a **fee share**: your fills are attributed to the builder code and you pay the normal fee, nothing extra; the code rides on the trading connection; mainnet only). Lighter / Lighter RH / Arcus: unsupported. If the approval is missing or cannot be read, the order is sent **without** the fee and the result's `execution.notes` says why; `execution.builderFee` shows what was attached.
