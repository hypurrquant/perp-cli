# Setup

[← README](../README.md) · Wallets, agent keys, keys created on the exchange website, and where secrets are stored.

## Wallet and setup wizard

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

Same EVM key works for both Hyperliquid and Lighter.

> **Lighter API Key Index:** Indexes 0–3 are reserved by Lighter's frontend (web/mobile). perp-cli defaults to index `4`. Override with `LIGHTER_API_KEY_INDEX` env var, or use `perp wallet agent approve lighter --api-key-index <n>` for managed agent slots. Valid range: 4–254.

## Lighter RH, Ondo Perps, Arcus

These venues have no `wallet set` private-key path — register an agent / API key instead:

```bash
perp wallet agent approve lighter-rh                  # Lighter RH L2 slot key (USDG collateral, Robinhood chain)
printf '%s\n%s\n' "$KEY_ID" "$SECRET" | perp wallet agent approve ondo   # Ondo HMAC key id + secret, stdin only
perp wallet agent approve arcus --master <ows-wallet> # Arcus Ed25519 API key (OWS wallet agent-arcus-<master>)
perp -n testnet wallet agent approve txflow --master <ows-wallet>   # TxFlow agent key — refused while TxFlow trading is switched off (TXFLOW_TRADING_ENABLED)
perp wallet agent verify [lighter-rh|ondo|arcus|txflow]  # no venue = verify every configured venue
```

## No master wallet on this computer — import a key created on the exchange website

Create the agent / API key on the venue's website, then import it. The master wallet never has to be
on this machine; it is identified only by its public address. The key is read from a hidden prompt or
stdin (never argv) and **checked against the venue before anything is stored** — a refused check stores
nothing; a venue that cannot be checked without the master is reported as `unverified`, never as verified.

```bash
perp -n testnet wallet agent import hyperliquid                    # API wallet key; master read from HL (userRole)
pbpaste | perp wallet agent import aster --master-address 0xYOU     # signer key; signed /fapi/v3/balance check (works on Aster testnet too)
perp wallet agent import pacifica --master-address <SOL account>   # agent key; UNVERIFIED (Pacifica lists bindings only master-signed)
perp wallet agent import lighter --account-index 123 --api-key-index 5   # slot key; auth token accepted for that slot
perp wallet agent import arcus --master-address 0xOWNER            # Ed25519 key; public key listed ACTIVE for the owner
printf '%s\n%s\n' "$KEY_ID" "$SECRET" | perp wallet agent import ondo
printf '%s\n%s\n' "$PUBLIC_KEY" "$SECRET" | perp wallet agent import qfex --account-id <uuid>   # QFEX: import only (keys are created on the website, 2FA)
perp -n testnet wallet agent import txflow                         # TxFlow web-app key (agentOwner check) — refused while TxFlow trading is switched off
perp wallet agent list                                              # SOURCE column: approved | imported

# Setup without any master wallet: one stdin line per --import-agents venue, in order (ondo: 2 lines)
printf '%s\n%s\n' "$HL_AGENT_KEY" "$LT_KEY" | perp --json setup --non-interactive \
  --venues hyperliquid,lighter --import-agents hyperliquid,lighter --yes \
  --lighter-account-index 123 --lighter-api-key-index 5
```

Trading works with the imported key. **Deposits, withdrawals, transfers, bridge, referral set and agent
approvals need the master**: without it they fail with `NO_SIGNER_AVAILABLE` ("do it on the exchange
website, or add the master with `perp wallet import`"). The CLI cannot revoke or rotate an imported key —
revoke it on the website; `perp wallet agent revoke <venue> <name> --local-only` removes the local copy,
and `wallet agent import <venue> --agent-name <name> --replace` swaps in a new website-created key.
`perp setup` offers the same choice per venue: approve with this computer's master wallet, or import a
website-created key (Step 1 can skip the master wallet).

Secrets are stored once (see `docs/SSOT_RULES.md` Rule #3): Lighter RH → `~/.perp/lighter-rh-agents/`, Ondo → `~/.perp/ondo-agents/<keyId>.json`, Arcus → OWS wallet `agent-arcus-<master>`; imported EVM / Solana / Ed25519 keys → OWS wallet `agent-{hl,aster,pac,arcus}-import-<name>` (empty passphrase, like approved agent wallets), imported Lighter keys → the network-tagged Lighter keystore. A missing wallet/key now fails with `KEY_NOT_FOUND` / `NO_SIGNER_AVAILABLE` instead of silently falling back to read-only.
