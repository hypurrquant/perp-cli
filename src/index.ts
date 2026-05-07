#!/usr/bin/env node
// MUST be first import — installs a stderr filter for --json mode so SDK
// startup banners don't leak into machine output. ESM hoists all static
// imports to the top, but executes them in source order, so this side-effect
// import runs before any DEX SDK is loaded.
import "./_stderr-filter.js";

// Save original process.exit before any SDK (Go WASM) can patch it
const _origExit = process.exit.bind(process);
import { config } from "dotenv";
import { resolve } from "path";
import { createRequire } from "node:module";

// SSOT Rule #3: load only ~/.perp/.env. The CWD .env auto-load was removed
// because it caused master-address pollution when run from a project tree
// containing leftover dev keys (`wallet show` returned env-derived addresses
// instead of the OWS active wallet's). If you need ad-hoc env overrides,
// export them in your shell — keystore is the canonical source.
config({ path: resolve(process.env.HOME || "~", ".perp", ".env") });
import { Command } from "commander";
import chalk from "chalk";
import type { Network } from "./pacifica/index.js";
import { Keypair } from "@solana/web3.js";
import { tryLoadPrivateKey, parseSolanaKeypair, isOwsKey, getOwsWalletName, type Exchange } from "./config.js";
import { PacificaAdapter } from "./exchanges/pacifica.js";
import { HyperliquidAdapter } from "./exchanges/hyperliquid.js";
// LighterAdapter is lazy-imported to avoid CJS/ESM issues at startup
import type { LighterAdapter } from "./exchanges/lighter.js";
import type { ExchangeAdapter } from "./exchanges/interface.js";
import { resolveExchangeName } from "./exchanges/registry.js";
import { registerMarketCommands } from "./commands/market.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerOutcomeCommands } from "./commands/outcome.js";
import { registerTradeCommands } from "./commands/trade.js";
// manage commands now register under `wallet manage ...` via registerWalletCommands.
// stream commands removed — WS feeds still used by dashboard/event-stream internally
import { registerArbCommands } from "./commands/arb.js";
import { registerWalletCommands } from "./commands/wallet.js";
// bridge + rebalance now nested under `funds` — registered inside registerFundsCommands.
import { registerFundsCommands } from "./commands/funds.js";
// alert commands removed
import { registerArbAutoCommands } from "./commands/arb-auto.js";
import { registerArbManageCommands } from "./commands/arb/index.js";
// Agent commands now register under `wallet agent ...` via registerWalletCommands.
import { registerStrategyCommands } from "./commands/bot.js";
import { registerRiskCommands } from "./commands/risk.js";
import { registerHistoryCommands } from "./commands/history.js";
import { registerSettingsCommands } from "./commands/settings.js";
// dex commands merged into market (hip3) — use --dex flag for markets/balance
// `plan` is no longer top-level — registered as `strategy plan` inside
// registerStrategyCommands.
// funding merged into arb.ts
import { registerBacktestCommands } from "./commands/backtest.js";
import { registerPortfolioCommand } from "./commands/portfolio.js";
import { registerInitCommand, EXCHANGE_ENV_MAP, validateKey } from "./commands/init.js";
import { registerAlertCommands } from "./commands/alerts.js";
import { loadSettings, saveSettings } from "./settings.js";
import { setSharedApiNetwork } from "./shared-api.js";
import { LANDING_EXCHANGES, asterAgentMissing as getAsterAgentMissing, renderLandingExchangeLine } from "./landing.js";

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

const program = new Command();

// Resolve default exchange from settings (fallback: "pacifica")
const _settings = loadSettings();
const _defaultExchange = _settings.defaultExchange || "pacifica";

program
  .name("perp")
  .description("Multi-DEX Perpetual Futures CLI (Pacifica, Hyperliquid, Lighter, Aster)")
  .version(_pkg.version)
  .option("-e, --exchange <exchange>", `Exchange: pacifica, hyperliquid, lighter, aster (default: ${_defaultExchange})`, _defaultExchange)
  .option("-n, --network <network>", "Network: mainnet or testnet", "mainnet")
  .option("-k, --private-key <key>", "Private key")
  .option("--json", "Output raw JSON (for piping)")
  .option("--fields <fields>", "Comma-separated fields to include in JSON output (e.g. totalEquity,positions)")
  .option("--ndjson", "Output newline-delimited JSON (one object per line for streaming)")
  .option("--dry-run", "Simulate trades without executing (log as simulated)")
  .option("-w, --wallet <name>", "Use a specific wallet by name (from 'perp wallet list')")
  .option("--ows <name>", "Use an OWS (Open Wallet Standard) wallet by name")
  .option("--ows-key <token>", "OWS API key token (ows_key_...) for policy-gated agent access")
  .option("--no-agent", "Bypass agent wallet routing for this run; falls back to OWS master or PK direct")
  .option("--passphrase <pp>", "Master OWS passphrase (also accepts OWS_PASSPHRASE env or stdin)")
  .option("--dex <name>", "HIP-3 deployed perp dex name (Hyperliquid only)")
  .configureOutput({
    writeErr: (str) => {
      if (process.argv.includes("--json")) {
        const msg = str.replace(/^error:\s*/i, "").trim();
        // Use inline envelope (jsonError import not available in sync context)
        console.log(JSON.stringify({
          ok: false,
          error: { code: "CLI_ERROR", message: msg },
          meta: { timestamp: new Date().toISOString() },
        }));
      } else {
        process.stderr.write(str);
      }
    },
  });

let _adapter: ExchangeAdapter | null = null;
let _pacificaAdapter: PacificaAdapter | null = null;
let _hlAdapter: HyperliquidAdapter | null = null;
let _lighterAdapter: LighterAdapter | null = null;

/** Map short aliases to canonical exchange names. Full names pass through. */
function resolveExchangeAlias(name: string): string {
  return resolveExchangeName(name);
}

function getExchange(): Exchange {
  return resolveExchangeAlias(program.opts().exchange) as Exchange;
}

async function getAdapter(): Promise<ExchangeAdapter> {
  const opts = program.opts();
  const owsName = opts.ows as string | undefined;
  const owsKeyToken = (opts.owsKey as string | undefined) || process.env.OWS_API_KEY;
  const walletName = owsName ? `ows:${owsName}` : (opts.wallet as string | undefined);
  // Commander's `--no-agent` flag sets opts.agent === false (NOT opts.noAgent).
  // Normalize so downstream wiring can use a single boolean consistently.
  const noAgent = opts.agent === false;

  // Skip cache when --wallet/--ows is specified (different wallet = different account)
  if (!walletName && _adapter) return _adapter;

  const exchange = resolveExchangeAlias(opts.exchange) as Exchange;
  const network = opts.network as string;
  const isTestnet = network === "testnet";

  // Try to load key — null means no key configured (read-only mode)
  const pk = await tryLoadPrivateKey(exchange, opts.privateKey, walletName);

  // OWS wallet detected — use OWS signers instead of raw keys
  if (pk && isOwsKey(pk)) {
    return _initWithOws(exchange, getOwsWalletName(pk), isTestnet, opts, owsKeyToken);
  }

  switch (exchange) {
    case "pacifica": {
      const keypair = pk ? parseSolanaKeypair(pk) : Keypair.generate();
      const pacNetwork = (isTestnet ? "testnet" : "mainnet") as Network;
      const settings = loadSettings();
      const builderCode = process.env.PACIFICA_BUILDER_CODE || settings.referralCodes.pacifica || "PERPCLI";
      _pacificaAdapter = new PacificaAdapter(keypair, pacNetwork, builderCode, !!pk);
      // Tier 2: OWS master if --ows or settings.owsActiveWallet (Phase 2c)
      const pacOwsName = owsName || _settings.owsActiveWallet;
      if (pacOwsName && !pk) {
        const { OwsSolanaSigner } = await import("./signer/ows-solana.js");
        const { resolvePassphrase } = await import("./agent-wallet/passphrase.js");
        const pp = await resolvePassphrase({ flag: opts.passphrase as string | undefined });
        if (pp !== null) _pacificaAdapter.setSigner(OwsSolanaSigner.create(pacOwsName, pp));
      }
      // Tier 1: agent if registered (Phase 2c)
      const { getAgent: getPacAgent } = await import("./agent-wallet/store.js");
      const pacAgentMeta = getPacAgent("pacifica");
      if (pacAgentMeta) {
        const { OwsSolanaSigner: PacOwsSolanaSigner } = await import("./signer/ows-solana.js");
        // Pacifica agent wallet was created with empty passphrase (see runPacApproveFlow);
        // open with "" to match. Agent at-rest encryption handled by OWS storage layer.
        const agentSigner = PacOwsSolanaSigner.create(pacAgentMeta.agentWalletName, "");
        _pacificaAdapter.setAgentSigner(pacAgentMeta, agentSigner);
      }
      if (noAgent) _pacificaAdapter.setNoAgent(true);
      _adapter = _pacificaAdapter;
      break;
    }
    case "hyperliquid": {
      _hlAdapter = new HyperliquidAdapter(pk ?? undefined, isTestnet);
      if (opts.dex) _hlAdapter.setDex(opts.dex);
      await _hlAdapter.init();
      if (pk) {
        const hlSettings = loadSettings();
        if (!hlSettings.referralApplied.hyperliquid) {
          const hlRef = process.env.HL_REFERRAL_CODE || hlSettings.referralCodes.hyperliquid;
          if (hlRef) {
            _hlAdapter.autoSetReferrer(hlRef).then(() => {
              const s = loadSettings();
              s.referralApplied.hyperliquid = true;
              saveSettings(s);
            }).catch((err) => {
              // Per SSOT Rule #2: do NOT mark applied=true on failure.
              // Leave referralApplied[ex]=false so next adapter init retries.
              process.stderr.write(`[hyperliquid] referral apply failed: ${err instanceof Error ? err.message : String(err)}\n`);
            });
          }
        }
      }
      // Tier 2: OWS master if --ows or settings.owsActiveWallet
      const hlOwsName = owsName || _settings.owsActiveWallet;
      if (hlOwsName && !pk) {
        const { OwsEvmSigner } = await import("./signer/ows-evm.js");
        const { resolvePassphrase } = await import("./agent-wallet/passphrase.js");
        const pp = await resolvePassphrase({ flag: opts.passphrase as string | undefined });
        if (pp !== null) _hlAdapter.setSigner(OwsEvmSigner.create(hlOwsName, pp));
      }
      // Tier 1: agent if registered
      const { getAgent: getHlAgent } = await import("./agent-wallet/store.js");
      const hlAgentMeta = getHlAgent("hyperliquid");
      if (hlAgentMeta) {
        const { OwsEvmSigner: HlOwsEvmSigner } = await import("./signer/ows-evm.js");
        // HL agent wallet was created with empty passphrase (see runHlApproveFlow);
        // open with "" to match. Agent at-rest encryption handled by OWS storage layer.
        const agentSigner = HlOwsEvmSigner.create(hlAgentMeta.agentWalletName, "");
        _hlAdapter.setAgentSigner(hlAgentMeta, agentSigner);
      }
      if (noAgent) _hlAdapter.setNoAgent(true);
      _adapter = _hlAdapter;
      break;
    }
    case "lighter": {
      const { LighterAdapter } = await import("./exchanges/lighter.js");
      // Phase 2d (SSOT Rule #3): when an agent is registered AND not bypassed,
      // load the agent's L2 secp256k1 key from the encrypted keystore at
      // ~/.perp/lighter-agents/<accountIndex>-<slot>.json BEFORE init() so the
      // WASM client is created with the agent identity. Missing keystore →
      // loadLighterKey throws LIGHTER_KEYSTORE_NOT_FOUND with remediation
      // (no fallback to env per SSOT Rule #2).
      const { getAgent: getLtAgent } = await import("./agent-wallet/store.js");
      const ltAgentMeta = getLtAgent("lighter");
      _lighterAdapter = new LighterAdapter(pk ?? "", isTestnet);
      if (ltAgentMeta && !noAgent) {
        const { loadLighterKey } = await import("./agent-wallet/lighter-keystore.js");
        const ltL2Key = loadLighterKey(ltAgentMeta.accountIndex!, ltAgentMeta.apiKeyIndex!, "");
        _lighterAdapter.setAgentSigner(ltAgentMeta, ltL2Key);
      }
      if (noAgent) _lighterAdapter.setNoAgent(true);
      await _lighterAdapter.init();
      // LT referral apply is L2-signed (POST /referral/use uses the WASM slot
      // signer's auth token, not the master EVM). Trigger on any active
      // signer tier — agent / OWS master / PK direct — gated by isReadOnly.
      const ltSettings = loadSettings();
      if (!ltSettings.referralApplied.lighter && !_lighterAdapter.isReadOnly) {
        const ltRef = process.env.LIGHTER_REFERRAL_CODE || ltSettings.referralCodes.lighter;
        if (ltRef) {
          _lighterAdapter.useReferralCode(ltRef).then(() => {
            const s = loadSettings();
            s.referralApplied.lighter = true;
            saveSettings(s);
          }).catch((err) => {
            // Per SSOT Rule #2: do NOT mark applied=true on failure.
            process.stderr.write(`[lighter] referral apply failed: ${err instanceof Error ? err.message : String(err)}\n`);
          });
        }
      }
      _adapter = _lighterAdapter;
      break;
    }
    case "aster": {
      const { AsterAdapter } = await import("./exchanges/aster.js");
      const ast = new AsterAdapter(pk ?? undefined, isTestnet);  // Tier 3 from PK
      await ast.init();
      // Tier 2: OWS master if --ows or settings.owsActiveWallet
      const asterOwsName = owsName || _settings.owsActiveWallet;
      if (asterOwsName) {
        const { OwsEvmSigner } = await import("./signer/ows-evm.js");
        const { resolvePassphrase } = await import("./agent-wallet/passphrase.js");
        const pp = await resolvePassphrase({ flag: opts.passphrase as string | undefined });
        if (pp !== null) ast.setMasterSigner(OwsEvmSigner.create(asterOwsName, pp));
      }
      // Tier 1: agent if registered
      const { getAgent: getAsterAgent } = await import("./agent-wallet/store.js");
      const agentMeta = getAsterAgent("aster");
      if (agentMeta) {
        const { agentSigningStrategyFor } = await import("./agent-wallet/signing-strategy.js");
        const strat = agentSigningStrategyFor(agentMeta, owsKeyToken ?? "");
        ast.setAgent(agentMeta, strat);
      }
      if (noAgent) ast.setNoAgent(true);
      _adapter = ast;
      break;
    }
    default:
      throw new Error(`Unknown exchange: ${exchange}`);
  }

  return _adapter;
}

/** Initialize adapter with OWS wallet signer injection. */
async function _initWithOws(
  exchange: Exchange,
  owsWalletName: string,
  isTestnet: boolean,
  opts: Record<string, unknown>,
  owsKeyToken?: string,
): Promise<ExchangeAdapter> {
  const { OwsEvmSigner } = await import("./signer/ows-evm.js");
  const { OwsSolanaSigner } = await import("./signer/ows-solana.js");

  // If an OWS API key token is provided, use it as passphrase → routes through policy engine
  const passphrase = owsKeyToken || "";
  // Commander's `--no-agent` flag sets opts.agent === false (NOT opts.noAgent).
  const noAgent = (opts as { agent?: boolean }).agent === false;

  switch (exchange) {
    case "pacifica": {
      const pacNetwork = (isTestnet ? "testnet" : "mainnet") as Network;
      const settings = loadSettings();
      const builderCode = process.env.PACIFICA_BUILDER_CODE || settings.referralCodes.pacifica || "PERPCLI";
      const dummyKeypair = Keypair.generate();
      _pacificaAdapter = new PacificaAdapter(dummyKeypair, pacNetwork, builderCode, true);
      _pacificaAdapter.setSigner(OwsSolanaSigner.create(owsWalletName, passphrase));
      // Tier 1: agent if registered (Phase 2c)
      const { getAgent: getPacAgentOws } = await import("./agent-wallet/store.js");
      const pacAgentMetaOws = getPacAgentOws("pacifica");
      if (pacAgentMetaOws) {
        const agentSignerOws = OwsSolanaSigner.create(pacAgentMetaOws.agentWalletName, "");
        _pacificaAdapter.setAgentSigner(pacAgentMetaOws, agentSignerOws);
      }
      if (noAgent) _pacificaAdapter.setNoAgent(true);
      _adapter = _pacificaAdapter;
      return _adapter;
    }
    case "hyperliquid": {
      _hlAdapter = new HyperliquidAdapter(undefined, isTestnet);
      if (opts.dex) _hlAdapter.setDex(opts.dex as string);
      _hlAdapter.setSigner(OwsEvmSigner.create(owsWalletName, passphrase));
      await _hlAdapter.init();
      _adapter = _hlAdapter;
      return _adapter;
    }
    case "lighter": {
      const { LighterAdapter } = await import("./exchanges/lighter.js");
      _lighterAdapter = new LighterAdapter("", isTestnet);
      _lighterAdapter.setSigner(OwsEvmSigner.create(owsWalletName, passphrase));
      // Tier 1: agent if registered (mirrors getAdapter / getAdapterForExchange).
      // Without this, _initWithOws would skip Tier 1 and fall through to
      // auto-setup-at-slot-4 which is wrong for agent users (and breaks under
      // SDK 1.0.11+ where signChangePubKey signature changed).
      const { getAgent: getLtAgentOws } = await import("./agent-wallet/store.js");
      const ltAgentMetaOws = getLtAgentOws("lighter");
      if (ltAgentMetaOws && !noAgent) {
        const { loadLighterKey } = await import("./agent-wallet/lighter-keystore.js");
        const ltL2KeyOws = loadLighterKey(ltAgentMetaOws.accountIndex!, ltAgentMetaOws.apiKeyIndex!, "");
        _lighterAdapter.setAgentSigner(ltAgentMetaOws, ltL2KeyOws);
      }
      if (noAgent) _lighterAdapter.setNoAgent(true);
      await _lighterAdapter.init();
      _adapter = _lighterAdapter;
      return _adapter;
    }
    case "aster": {
      const { AsterAdapter } = await import("./exchanges/aster.js");
      const asterOws = new AsterAdapter(undefined, isTestnet);
      await asterOws.init();
      asterOws.setMasterSigner(OwsEvmSigner.create(owsWalletName, passphrase));
      // Optionally also set agent if registered
      const { getAgent: getAsterAgentOws } = await import("./agent-wallet/store.js");
      const asterMeta = getAsterAgentOws("aster");
      if (asterMeta) {
        const { agentSigningStrategyFor } = await import("./agent-wallet/signing-strategy.js");
        asterOws.setAgent(asterMeta, agentSigningStrategyFor(asterMeta, owsKeyToken ?? ""));
      }
      if (noAgent) asterOws.setNoAgent(true);
      _adapter = asterOws;
      return _adapter;
    }
    default:
      throw new Error(`Unknown exchange: ${exchange}`);
  }
}

// Sync wrapper for commands that need adapter (lazy init)
function getAdapterSync(): ExchangeAdapter {
  if (!_adapter) throw new Error("Adapter not initialized");
  return _adapter;
}

function isJson(): boolean {
  return !!program.opts().json || process.argv.includes("--ndjson");
}

function isDryRun(): boolean {
  return !!program.opts().dryRun;
}

// Helper to get PacificaAdapter specifically (for Pacifica-only commands)
function getPacificaAdapter(): PacificaAdapter {
  if (!_pacificaAdapter) throw new Error("This command requires --exchange pacifica");
  return _pacificaAdapter;
}

function getHLAdapter(): HyperliquidAdapter {
  if (!_hlAdapter) throw new Error("This command requires --exchange hyperliquid");
  return _hlAdapter;
}

// Register command groups with async adapter getter
registerMarketCommands(program, getAdapter, isJson, getAdapterForExchange);
registerAccountCommands(program, getAdapter, isJson, getAdapterForExchange);
registerOutcomeCommands(program, getAdapterForExchange, isJson);
registerTradeCommands(program, getAdapter, isJson, isDryRun, getAdapterForExchange);
// manage tree wired inside registerWalletCommands below.
// stream commands removed
registerArbCommands(program, isJson, getAdapterForExchange);
registerWalletCommands(program, isJson, getAdapter, getPacificaAdapter);
registerFundsCommands(
  program,
  getAdapter,
  isJson,
  () => program.opts().network as Network,
  getAdapterForExchange
);
// alert commands removed

// Helper to get adapter for a specific exchange (used by arb-auto)
async function getAdapterForExchange(rawExchange: string): Promise<ExchangeAdapter> {
  const exchange = resolveExchangeAlias(rawExchange);
  const opts = program.opts();
  const network = opts.network as string;
  const isTestnet = network === "testnet";
  const owsName = opts.ows as string | undefined;
  const owsKeyToken = (opts.owsKey as string | undefined) || process.env.OWS_API_KEY;
  const walletName = owsName ? `ows:${owsName}` : (opts.wallet as string | undefined);
  // Commander's `--no-agent` flag sets opts.agent === false (NOT opts.noAgent).
  const noAgent = opts.agent === false;
  const pk = await tryLoadPrivateKey(exchange as Exchange, opts.privateKey, walletName);

  // Route through OWS init when pk is an OWS reference (e.g. "ows:main").
  // Mirrors getAdapter() at the top of this file. Without this, adapters
  // would try to parse "ows:main" as a raw private key and ethers would
  // throw "invalid BytesLike value" / parseSolanaKeypair would fail.
  if (pk && isOwsKey(pk)) {
    return _initWithOws(exchange as Exchange, getOwsWalletName(pk), isTestnet, opts, owsKeyToken);
  }

  switch (exchange) {
    case "pacifica": {
      if (_pacificaAdapter) return _pacificaAdapter;
      const keypair = pk ? parseSolanaKeypair(pk) : Keypair.generate();
      const pacNetwork = (isTestnet ? "testnet" : "mainnet") as Network;
      const s1 = loadSettings();
      const builderCode = process.env.PACIFICA_BUILDER_CODE || s1.referralCodes.pacifica || "PERPCLI";
      _pacificaAdapter = new PacificaAdapter(keypair, pacNetwork, builderCode, !!pk);
      // Tier 1: agent if registered (Phase 2c)
      const { getAgent: getPacAgentEx } = await import("./agent-wallet/store.js");
      const pacAgentMetaEx = getPacAgentEx("pacifica");
      if (pacAgentMetaEx) {
        const { OwsSolanaSigner: PacOwsSolanaSignerEx } = await import("./signer/ows-solana.js");
        // Pacifica agent wallet was created with empty passphrase (see runPacApproveFlow);
        // open with "" to match. Agent at-rest encryption handled by OWS storage layer.
        const agentSignerEx = PacOwsSolanaSignerEx.create(pacAgentMetaEx.agentWalletName, "");
        _pacificaAdapter.setAgentSigner(pacAgentMetaEx, agentSignerEx);
      }
      if (noAgent) _pacificaAdapter.setNoAgent(true);
      if (!_adapter) _adapter = _pacificaAdapter;
      return _pacificaAdapter;
    }
    case "hyperliquid": {
      if (_hlAdapter) return _hlAdapter;
      _hlAdapter = new HyperliquidAdapter(pk ?? undefined, isTestnet);
      if (opts.dex) _hlAdapter.setDex(opts.dex);
      await _hlAdapter.init();
      if (pk) {
        const s2 = loadSettings();
        if (!s2.referralApplied.hyperliquid) {
          const hlRef = process.env.HL_REFERRAL_CODE || s2.referralCodes.hyperliquid;
          if (hlRef) {
            _hlAdapter.autoSetReferrer(hlRef).then(() => {
              const s = loadSettings();
              s.referralApplied.hyperliquid = true;
              saveSettings(s);
            }).catch((err) => {
              // Per SSOT Rule #2: do NOT mark applied=true on failure.
              // Leave referralApplied[ex]=false so next adapter init retries.
              process.stderr.write(`[hyperliquid] referral apply failed: ${err instanceof Error ? err.message : String(err)}\n`);
            });
          }
        }
      }
      // Tier 1: agent if registered
      {
        const { getAgent: getHlAgent2 } = await import("./agent-wallet/store.js");
        const hlAgentMeta2 = getHlAgent2("hyperliquid");
        if (hlAgentMeta2) {
          const { OwsEvmSigner: HlOwsEvmSigner2 } = await import("./signer/ows-evm.js");
          // HL agent wallet was created with empty passphrase (see runHlApproveFlow);
          // open with "" to match. Agent at-rest encryption handled by OWS storage layer.
          const agentSigner2 = HlOwsEvmSigner2.create(hlAgentMeta2.agentWalletName, "");
          _hlAdapter.setAgentSigner(hlAgentMeta2, agentSigner2);
        }
        if (noAgent) _hlAdapter.setNoAgent(true);
      }
      if (!_adapter) _adapter = _hlAdapter;
      return _hlAdapter;
    }
    case "lighter": {
      if (_lighterAdapter) return _lighterAdapter;
      const { LighterAdapter } = await import("./exchanges/lighter.js");
      const { getAgent: getLtAgentEx } = await import("./agent-wallet/store.js");
      const ltAgentMetaEx = getLtAgentEx("lighter");
      _lighterAdapter = new LighterAdapter(pk ?? "", isTestnet);
      if (ltAgentMetaEx && !noAgent) {
        // SSOT Rule #3: load agent L2 key from encrypted keystore — no env fallback.
        const { loadLighterKey } = await import("./agent-wallet/lighter-keystore.js");
        const ltL2KeyEx = loadLighterKey(ltAgentMetaEx.accountIndex!, ltAgentMetaEx.apiKeyIndex!, "");
        _lighterAdapter.setAgentSigner(ltAgentMetaEx, ltL2KeyEx);
      }
      if (noAgent) _lighterAdapter.setNoAgent(true);
      await _lighterAdapter.init();
      // LT referral apply is L2-signed; trigger on any active tier (agent
      // included), gated by isReadOnly. See first LT case for rationale.
      const s3 = loadSettings();
      if (!s3.referralApplied.lighter && !_lighterAdapter.isReadOnly) {
        const ltRef = process.env.LIGHTER_REFERRAL_CODE || s3.referralCodes.lighter;
        if (ltRef) {
          _lighterAdapter.useReferralCode(ltRef).then(() => {
            const s = loadSettings();
            s.referralApplied.lighter = true;
            saveSettings(s);
          }).catch((err) => {
            // Per SSOT Rule #2: do NOT mark applied=true on failure.
            process.stderr.write(`[lighter] referral apply failed: ${err instanceof Error ? err.message : String(err)}\n`);
          });
        }
      }
      if (!_adapter) _adapter = _lighterAdapter;
      return _lighterAdapter;
    }
    case "aster": {
      const { AsterAdapter } = await import("./exchanges/aster.js");
      const astEx = new AsterAdapter(pk ?? undefined, isTestnet);
      await astEx.init();
      // Tier 2: OWS master if --ows or settings.owsActiveWallet
      const asterExOwsName = (opts.ows as string | undefined) || _settings.owsActiveWallet;
      if (asterExOwsName) {
        const { OwsEvmSigner } = await import("./signer/ows-evm.js");
        const { resolvePassphrase } = await import("./agent-wallet/passphrase.js");
        const pp = await resolvePassphrase({ flag: opts.passphrase as string | undefined });
        if (pp !== null) astEx.setMasterSigner(OwsEvmSigner.create(asterExOwsName, pp));
      }
      // Tier 1: agent if registered
      const owsKeyEx = (opts.owsKey as string | undefined) || process.env.OWS_API_KEY;
      const { getAgent: getAsterAgentEx } = await import("./agent-wallet/store.js");
      const agentMetaEx = getAsterAgentEx("aster");
      if (agentMetaEx) {
        const { agentSigningStrategyFor } = await import("./agent-wallet/signing-strategy.js");
        astEx.setAgent(agentMetaEx, agentSigningStrategyFor(agentMetaEx, owsKeyEx ?? ""));
      }
      if (noAgent) astEx.setNoAgent(true);
      if (!_adapter) _adapter = astEx;
      return astEx;
    }
    default:
      throw new Error(`Unknown exchange: ${exchange}`);
  }
}

// Helper to get an HL adapter configured for a specific HIP-3 dex
const _dexAdapters = new Map<string, HyperliquidAdapter>();
async function getHLAdapterForDex(dex: string): Promise<HyperliquidAdapter> {
  if (_dexAdapters.has(dex)) return _dexAdapters.get(dex)!;
  const opts = program.opts();
  const walletName = opts.wallet as string | undefined;
  const pk = await tryLoadPrivateKey("hyperliquid", opts.privateKey, walletName);
  const adapter = new HyperliquidAdapter(pk ?? undefined, opts.network === "testnet");
  if (dex !== "hl") adapter.setDex(dex);
  await adapter.init();
  _dexAdapters.set(dex, adapter);
  return adapter;
}

registerArbAutoCommands(program, getAdapterForExchange, isJson, getHLAdapterForDex);
registerArbManageCommands(program, getAdapterForExchange, isJson);
// `agent` is no longer top-level — registered as `wallet agent` inside
// registerWalletCommands above.
// withdraw merged into funds.
// `rebalance` is no longer top-level — registered as `funds rebalance` inside
// registerFundsCommands above.

// Background processes & strategies
import { registerBackgroundCommands } from "./commands/jobs.js";
registerBackgroundCommands(program, isJson);
registerStrategyCommands(program, getAdapter, getAdapterForExchange, isJson);

// Agent-friendly commands
registerRiskCommands(program, getAdapterForExchange, isJson);
registerHistoryCommands(program, isJson, getAdapterForExchange);
registerSettingsCommands(program, isJson, getAdapterForExchange);
// dex commands removed — use 'market hip3' + --dex flag
// `plan` is no longer top-level — registered as `strategy plan` inside
// registerStrategyCommands above.
// funding merged into arb — registerFundingCommands removed
registerBacktestCommands(program, isJson);
registerPortfolioCommand(program, getAdapterForExchange, isJson, _pkg.version, getHLAdapterForDex);
registerInitCommand(program);
registerAlertCommands(program, isJson);

// Switch shared API URLs if --network testnet is used
program.hook("preAction", () => {
  const network = program.opts().network as string;
  if (network === "testnet") setSharedApiNetwork("testnet");
});

// Smart landing page: `perp` with no subcommand
const rawArgs = process.argv.slice(2);
const hasSubcommand = rawArgs.some((a) => !a.startsWith("-") && !["pacifica", "hyperliquid", "lighter", "aster", "hl", "lt", "pac", "ast", "mainnet", "testnet"].includes(a));

if (rawArgs.length === 0 || (!hasSubcommand && !rawArgs.includes("-h") && !rawArgs.includes("--help") && !rawArgs.includes("-V") && !rawArgs.includes("--version"))) {
  // No subcommand — show smart landing instead of help dump
  (async () => {
    try {
      const { getWalletSetupStatus } = await import("./commands/wallet.js");
      const status = getWalletSetupStatus();
      const settings = loadSettings();
      const hasEnvKey = !!(process.env.PRIVATE_KEY || process.env.PACIFICA_PRIVATE_KEY ||
        process.env.HL_PRIVATE_KEY || process.env.HYPERLIQUID_PRIVATE_KEY ||
        process.env.LIGHTER_PRIVATE_KEY || process.env.ASTER_PRIVATE_KEY);
      const hasOwsWallet = !!settings.owsActiveWallet;

      // ── ASCII banner ──
      const banner = [
        "",
        chalk.cyan("  ██████╗ ███████╗██████╗ ██████╗      ██████╗██╗     ██╗"),
        chalk.cyan("  ██╔══██╗██╔════╝██╔══██╗██╔══██╗    ██╔════╝██║     ██║"),
        chalk.cyan("  ██████╔╝█████╗  ██████╔╝██████╔╝    ██║     ██║     ██║"),
        chalk.cyan("  ██╔═══╝ ██╔══╝  ██╔══██╗██╔═══╝     ██║     ██║     ██║"),
        chalk.cyan("  ██║     ███████╗██║  ██║██║          ╚██████╗███████╗██║"),
        chalk.cyan("  ╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝           ╚═════╝╚══════╝╚═╝"),
        "",
        chalk.gray(`  4 exchanges · 19 strategies · v${_pkg.version}`),
      ];
      console.log(banner.join("\n"));

      if (!status.hasWallets && !hasEnvKey && !hasOwsWallet && !settings.defaultExchange) {
        // Fresh install — onboarding
        console.log(chalk.yellow.bold("\n  ⚡ Get started:\n"));
        console.log(`    ${chalk.cyan("perp wallet generate")}            create OWS encrypted wallet`);
        console.log(`    ${chalk.cyan("perp setup")}                      setup wizard`);
        console.log(chalk.gray(`\n  Explore without a wallet:`));
        console.log(`    ${chalk.green("perp market mid BTC")}            quick price check`);
        console.log(`    ${chalk.green("perp arb scan")}                  funding rate arbitrage`);
        console.log(`    ${chalk.green("perp market list")}               available markets`);
        console.log(`    ${chalk.green("perp --help")}                    all commands\n`);
      } else {
        // Configured — show exchange status + balance
        // Ping + balance in parallel (with 5s timeout to keep landing fast)
        const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
          Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

        // Aster venue ships only signed account endpoints — no public
        // address-based balance query exists (HL/PAC/LT all do). So when
        // a user has an env-PK but no Aster agent, every getBalance()
        // call throws NOT_SUPPORTED at venue. Detect that case here so
        // landing can surface a clear "agent required" hint instead of
        // a generic dash.
        const asterAgentMissing = getAsterAgentMissing();

        const statusResults = await Promise.allSettled(LANDING_EXCHANGES.map(async (ex) => {
          try {
            const adapter = await withTimeout(getAdapterForExchange(ex), 5000);
            const [balance, positions] = await withTimeout(Promise.all([adapter.getBalance(), adapter.getPositions()]), 5000);
            const posCount = positions.filter(p => Number(p.size) > 0).length;
            let spotValue = 0;
            // Include non-USDC spot value for unified accounts (HL, LT)
            try {
              if (ex === "hyperliquid") {
                const { HyperliquidSpotAdapter } = await import("./exchanges/hyperliquid-spot.js");
                const hlSpot = new HyperliquidSpotAdapter(adapter as HyperliquidAdapter);
                await hlSpot.init();
                const [raw, markets] = await Promise.all([hlSpot.getSpotBalances(), hlSpot.getSpotMarkets()]);
                const priceMap = new Map(markets.map(m => [m.baseToken.toUpperCase(), Number(m.markPrice)]));
                for (const b of raw) {
                  const base = b.token.replace(/-SPOT$/i, "").toUpperCase();
                  if (base === "USDC" || Number(b.total) <= 0) continue;
                  spotValue += (priceMap.get(base) ?? 0) * Number(b.total);
                }
              } else if (ex === "lighter") {
                const { LighterAdapter } = await import("./exchanges/lighter.js");
                const { LighterSpotAdapter } = await import("./exchanges/lighter-spot.js");
                const ltSpot = new LighterSpotAdapter(adapter as InstanceType<typeof LighterAdapter>);
                await ltSpot.init();
                const [raw, markets] = await Promise.all([ltSpot.getSpotBalances(), ltSpot.getSpotMarkets()]);
                const priceMap = new Map(markets.map(m => [m.baseToken.toUpperCase(), Number(m.markPrice)]));
                for (const b of raw) {
                  if (b.token === "USDC" || b.token === "USDC_SPOT" || Number(b.total) <= 0) continue;
                  spotValue += (priceMap.get(b.token.toUpperCase()) ?? 0) * Number(b.total);
                }
              }
            } catch { /* spot not available */ }
            return { exchange: ex, ok: true, equity: Number(balance.equity) + spotValue, positions: posCount };
          } catch (err) {
            const { PerpError } = await import("./errors.js");
            const errorCode = err instanceof PerpError ? err.structured.code : undefined;
            return { exchange: ex, ok: false, equity: 0, positions: 0, errorCode };
          }
        }));

        console.log(chalk.white.bold("\n  Exchanges:"));
        let totalEquity = 0;
        let totalPositions = 0;
        for (const r of statusResults) {
          if (r.status !== "fulfilled") continue;
          const s = r.value;
          console.log(renderLandingExchangeLine(s, asterAgentMissing));
          if (s.ok) { totalEquity += s.equity; totalPositions += s.positions; }
        }

        if (totalEquity > 0) {
          console.log(chalk.gray("    ─".repeat(20)));
          console.log(`    ${chalk.white.bold("Total".padEnd(16))} ${chalk.white.bold(`$${totalEquity.toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)}${totalPositions > 0 ? chalk.yellow(` ${totalPositions} pos`) : ""}`);
        }

        console.log(chalk.white.bold("\n  Quick:"));
        console.log(`    ${chalk.green("perp portfolio")}             balances + positions + risk`);
        console.log(`    ${chalk.green("perp arb scan")}              funding arbitrage opportunities`);
        console.log(`    ${chalk.green("perp arb status")}            open arb positions + PnL`);
        console.log(`    ${chalk.green("perp portfolio --arb")}       full dashboard (balances + arb top 5)`);
        console.log(`    ${chalk.green("perp portfolio --serve")}     live web monitoring`);
        console.log(`    ${chalk.green("perp --help")}                all commands\n`);
      }
    } catch {
      program.help();
    }
    setTimeout(() => _origExit(0), 500);
  })();
} else {
program.parseAsync().then(() => {
  // Allow a short delay for any pending output, then exit cleanly.
  // Without this, HL SDK's WebSocket keeps the process alive indefinitely.
  setTimeout(() => _origExit(0), 500);
}).catch(async (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  if (isJson()) {
    const { jsonError } = await import("./utils.js");
    const { PerpError } = await import("./errors.js");
    // Preserve typed PerpError code + remediation through the top-level
    // catch (Rule #2: stay loud, keep semantic envelope).
    if (err instanceof PerpError) {
      const s = err.structured;
      console.log(JSON.stringify(jsonError(s.code, s.message, {
        status: s.status,
        retryable: s.retryable,
        retryAfterMs: s.retryAfterMs,
        remediation: s.remediation,
      })));
    } else {
      // Route generic Errors through the central classifier so a typo'd symbol
      // becomes SYMBOL_NOT_FOUND, a stalled fetch becomes EXCHANGE_UNREACHABLE,
      // etc. Hard-coding "FATAL" here gave callers a code that wasn't in
      // ERROR_CODES (no status / retryable / remediation), defeating the
      // structured envelope contract.
      const { classifyError } = await import("./errors.js");
      const s = classifyError(err);
      console.log(JSON.stringify(jsonError(s.code, s.message, {
        status: s.status,
        retryable: s.retryable,
        retryAfterMs: s.retryAfterMs,
        remediation: s.remediation,
      })));
    }
  } else {
    console.error(chalk.red(msg));
  }
  _origExit(1);
});
}
