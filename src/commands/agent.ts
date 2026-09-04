import { Command } from "commander";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { printJson, jsonOk } from "../utils.js";
import { PerpError, classifyError } from "../errors.js";
import chalk from "chalk";
import bs58 from "bs58";
import { loadSettings } from "../settings.js";
import { getAgent, setAgent, deleteAgent, listAgents, acquireLock, releaseLock } from "../agent-wallet/store.js";
import { resolvePassphrase } from "../agent-wallet/passphrase.js";
import { OwsEvmSigner } from "../signer/ows-evm.js";
import { OwsSolanaSigner } from "../signer/ows-solana.js";
import { loadOws } from "../signer/ows-loader.js";
import {
  buildApproveAgentTypedData,
  buildDelAgentTypedData,
  buildApproveBuilderTypedData,
} from "../exchanges/aster-typed-data.js";

/**
 * Emit a structured JSON error envelope to stdout and exit non-zero.
 * Stdout (not stderr) so machine consumers can read the envelope from a
 * single stream — matches the rest of the CLI's --json error path.
 */
function reportErrorAndExit(err: unknown): never {
  const ts = new Date().toISOString();
  // Route through the central classifier so generic Errors thrown from
  // dependencies (e.g. NAPI "decryption failed: aead::Error" from OWS vault
  // unlock) get a meaningful code + remediation instead of a bare UNKNOWN.
  // PerpError instances pass through unchanged via classifyError's first
  // branch so explicitly typed errors keep their structured shape.
  const envelope = { ok: false, error: classifyError(err), meta: { timestamp: ts } };
  process.stdout.write(JSON.stringify(envelope) + "\n");
  process.exit(1);
}

const _require = createRequire(import.meta.url);
const _pkg = _require("../../package.json") as { version: string };

// ── Verify helper types ───────────────────────────────────────────────────

interface VerifyOpts {
  agentName?: string;
  master?: string;
  masterAddress?: string;
  accountIndex?: string;
  passphrase?: string;
}

interface VerifyResult {
  registered: boolean;
  count: number;
  items: unknown[];
  warnings?: string[];
}

// ── Per-DEX verify implementations ───────────────────────────────────────

async function verifyAster(_opts: VerifyOpts): Promise<VerifyResult> {
  // No-fallback policy (CLAUDE.md SSOT rule #2): Aster has no verified
  // master-signing path for `/fapi/v3/agent`. The HypurrQuant_FE reference
  // confirms Aster has no REST endpoint to list approved agents at all —
  // master signing is used only for one-time approveAgent/approveBuilder.
  //
  // Returning local cache as if it were verified live state would be a
  // fallback (silent substitution masquerading as success). The SSOT rule
  // bans that pattern: failure must propagate, not get hidden behind a
  // synthesized success envelope. Throw NOT_IMPLEMENTED with explicit
  // remediation pointing to local-cache surfaces.
  throw new PerpError(
    "NOT_IMPLEMENTED",
    "Aster live agent verify is not supported (no verified master-signing path; FE reference also lacks this endpoint).",
    {
      remediation: "Use 'perp wallet agent list aster' to inspect local cache, or 'perp wallet agent rotate aster <name>' to refresh on-chain.",
    },
  );
}

/**
 * Verify Hyperliquid agent registration.
 *
 * Cross-check (AC-28, v3.4): When agentName provided AND persisted in
 * settings.agents.hyperliquid[name], asserts live response contains expected
 * agentEvmAddress. Mismatch → meta.warnings populated (non-fatal).
 */
async function verifyHyperliquid(opts: VerifyOpts): Promise<VerifyResult> {
  const settings = loadSettings();
  // Resolve master EVM address: flag > named agent's userEvmAddress > first registered agent
  let masterAddress = opts.masterAddress;
  if (!masterAddress) {
    const hlMap = settings.agents?.hyperliquid;
    if (hlMap) {
      if (opts.agentName && hlMap[opts.agentName]?.userEvmAddress) {
        masterAddress = hlMap[opts.agentName].userEvmAddress;
      } else {
        const first = Object.values(hlMap)[0];
        if (first?.userEvmAddress) masterAddress = first.userEvmAddress;
      }
    }
  }
  if (!masterAddress) {
    throw new PerpError("INVALID_PARAMS", "Master EVM address required for Hyperliquid verify. Use --master-address.", {
      remediation: "perp wallet agent verify hyperliquid --master-address 0xYOUR_ADDRESS",
    });
  }

  const user = masterAddress.toLowerCase();
  const resp = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "extraAgents", user }),
  });

  if (!resp.ok) {
    throw new PerpError("EXCHANGE_ERROR", `Hyperliquid verify failed: HTTP ${resp.status}`, {
      remediation: "Check master EVM address. Run: perp wallet agent verify hyperliquid --master-address 0xADDR",
    });
  }

  const data = await resp.json() as unknown;
  const items = Array.isArray(data) ? data : [];
  const warnings: string[] = [];

  // Cross-check: AC-28 — verify persisted agentEvmAddress matches live response
  if (opts.agentName) {
    const agentMeta = settings.agents?.hyperliquid?.[opts.agentName];
    if (agentMeta?.agentEvmAddress) {
      const expected = agentMeta.agentEvmAddress.toLowerCase();
      const found = items.some(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "address" in item &&
          typeof (item as Record<string, unknown>).address === "string" &&
          ((item as Record<string, unknown>).address as string).toLowerCase() === expected,
      );
      if (!found) {
        warnings.push(
          `Agent "${opts.agentName}" (expected address ${agentMeta.agentEvmAddress}) not found in Hyperliquid live response.`,
        );
      }
    }
  }

  return { registered: items.length > 0, count: items.length, items, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * Verify Pacifica agent registration.
 *
 * NOTE (v3.3 limitation): Cross-check semantics from AC-23 are inactive for
 * this DEX because settings.agents.pacifica type slot does not exist yet
 * (AgentsByExchange has only `aster?`). When Phase 2c extends AgentsByExchange
 * + AgentMeta with per-DEX fields (accountIndex, publicKey, etc.), the
 * cross-check branch below becomes live.
 */
async function verifyPacifica(opts: VerifyOpts): Promise<VerifyResult> {
  const settings = loadSettings();
  const masterName = opts.master ?? settings.owsActiveWallet;
  if (!masterName) {
    throw new PerpError("INVALID_PARAMS", "Master wallet name required for Pacifica verify. Use --master.", {
      remediation: "perp wallet agent verify pacifica --master <walletName> --passphrase $PP",
    });
  }
  const passphrase = opts.passphrase ?? "";
  const solanaSigner = OwsSolanaSigner.create(masterName, passphrase);
  const account = solanaSigner.getPublicKeyBase58();

  const timestamp = Date.now();
  const expiryWindow = 5000;
  const type = "list_api_keys";

  // Canonical JSON: sort keys lexicographically, no whitespace
  const signHeader = { expiry_window: expiryWindow, timestamp, type };
  const canonicalJson = JSON.stringify(signHeader);

  // Sign canonical JSON with Ed25519 (OWS Solana signer)
  const msgBytes = new TextEncoder().encode(canonicalJson);
  const sigBytes = await solanaSigner.signMessage(msgBytes);

  // Base58-encode the signature
  const sigBase58 = bs58.encode(sigBytes);

  const body = {
    account,
    agent_wallet: null as null,
    signature: sigBase58,
    timestamp,
    expiry_window: expiryWindow,
    type,
  };

  const resp = await fetch("https://api.pacifica.fi/api/v1/account/api_keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new PerpError("EXCHANGE_ERROR", `Pacifica verify failed: HTTP ${resp.status}: ${body.slice(0, 200)}`, {
      remediation: "Check master wallet name and passphrase. Run: perp wallet agent verify pacifica --master <name> --passphrase $PP",
    });
  }

  const data = await resp.json() as unknown;
  const apiKeys = (
    data &&
    typeof data === "object" &&
    "data" in data &&
    typeof (data as Record<string, unknown>).data === "object" &&
    (data as Record<string, unknown>).data !== null &&
    "api_keys" in ((data as Record<string, unknown>).data as Record<string, unknown>)
  )
    ? ((data as Record<string, unknown>).data as Record<string, unknown>).api_keys
    : [];
  const items = Array.isArray(apiKeys) ? apiKeys : [];

  return { registered: items.length > 0, count: items.length, items };
}

/**
 * Verify Lighter agent registration.
 *
 * NOTE (v3.3 limitation): Cross-check semantics from AC-23 are inactive for
 * this DEX because settings.agents.lighter type slot does not exist yet
 * (AgentsByExchange has only `aster?`). When Phase 2d extends AgentsByExchange
 * + AgentMeta with per-DEX fields (accountIndex, publicKey, etc.), the
 * cross-check branch below becomes live.
 */
async function verifyLighter(opts: VerifyOpts): Promise<VerifyResult> {
  const settings = loadSettings();
  const accountIndexStr = opts.accountIndex;
  // Resolve accountIndex: flag > named agent > first registered agent
  let accountIndex: number | undefined;
  if (accountIndexStr !== undefined) {
    accountIndex = parseInt(accountIndexStr, 10);
  } else {
    const ltMap = settings.agents?.lighter;
    if (ltMap) {
      if (opts.agentName && ltMap[opts.agentName]?.accountIndex !== undefined) {
        accountIndex = ltMap[opts.agentName].accountIndex;
      } else {
        const first = Object.values(ltMap)[0];
        if (first?.accountIndex !== undefined) accountIndex = first.accountIndex;
      }
    }
  }
  if (accountIndex === undefined || isNaN(accountIndex)) {
    throw new PerpError("INVALID_PARAMS", "Account index required for Lighter verify. Use --account-index.", {
      remediation: "perp wallet agent verify lighter --account-index <n>",
    });
  }

  const resp = await fetch(
    `https://mainnet.zklighter.elliot.ai/api/v1/apikeys?account_index=${accountIndex}`,
    { method: "GET" },
  );

  if (!resp.ok) {
    throw new PerpError("EXCHANGE_ERROR", `Lighter verify failed: HTTP ${resp.status}`, {
      remediation: `Check account index. Run: perp wallet agent verify lighter --account-index ${accountIndex}`,
    });
  }

  const data = await resp.json() as unknown;
  const apiKeys = (
    data &&
    typeof data === "object" &&
    "api_keys" in data
  )
    ? (data as Record<string, unknown>).api_keys
    : [];
  const items = Array.isArray(apiKeys) ? apiKeys : [];
  const warnings: string[] = [];

  // Cross-check if agentName provided
  if (opts.agentName) {
    const ltAgents = (settings.agents as Record<string, unknown> | undefined);
    const ltMap = (ltAgents && typeof ltAgents === "object" && "lighter" in ltAgents)
      ? ltAgents.lighter as Record<string, { publicKey?: string }> | undefined
      : undefined;
    const agentMeta = ltMap?.[opts.agentName];
    if (agentMeta?.publicKey) {
      const expected = agentMeta.publicKey;
      const found = items.some(
        (item: unknown) =>
          typeof item === "object" &&
          item !== null &&
          "public_key" in item &&
          (item as Record<string, unknown>).public_key === expected,
      );
      if (!found) {
        warnings.push(
          `Agent "${opts.agentName}" (expected public_key ${agentMeta.publicKey}) not found in Lighter live response.`,
        );
      }
    }
  }

  return { registered: items.length > 0, count: items.length, items, warnings: warnings.length > 0 ? warnings : undefined };
}


/**
 * Register the per-DEX agent-wallet management subtree (`approve` /
 * `list` / `revoke` / `rotate` / `verify`) under the supplied parent
 * `wallet` command. The function previously registered `agent` as a
 * top-level command on `program`; the hard-cut consolidation in v0.11+
 * relocates it to `wallet agent ...`.
 */
export function registerWalletAgentCommands(
  walletCmd: Command,
  isJson: () => boolean
) {
  const agent = walletCmd
    .command("agent")
    .description("Agent wallet management — register/revoke/rotate/verify per-DEX delegation keys");


  // ── agent approve <exchange> ── register an agent wallet ──────────────────
  agent
    .command("approve <exchange>")
    .description("Register an agent wallet for an exchange (Phase 2a/b/c/d: aster, hyperliquid, pacifica, lighter)")
    .option("--master <name>", "Master OWS wallet name")
    .option("--agent-name <name>", "Agent name (default: perp-cli-aster)")
    .option("--expires-in <duration>", "Expiry: 30d, 90d, 180d, 1y, or ISO-8601 datetime (default: 90d)")
    .option("--can-perp", "Allow perp trading (default: on)", true)
    .option("--no-perp", "Disallow perp trading")
    .option("--can-spot", "Allow spot trading (default: off)", false)
    .option("--no-spot", "Disallow spot trading")
    .option("--can-withdraw", "Allow withdrawals (default: off)", false)
    .option("--no-withdraw", "Disallow withdrawals")
    .option("--rotate", "Allow re-approving an existing agent name")
    .option("--passphrase <pp>", "Master OWS passphrase (fallback: OWS_PASSPHRASE env / stdin)")
    .option("--builder <addr>", "Builder address for optional builder approval")
    .option("--max-fee-rate <bps>", "Max fee rate bps (required with --builder)")
    .option("--builder-name <name>", "Optional builder name")
    .option("--ip-whitelist <list>", "Comma-separated IP whitelist (pass empty string to include empty)")
    .option("--api-key-index <n>", "Lighter slot index (4-254). Default: next free slot.")
    .option("--json", "Machine-readable output")
    .action(async (exchange: string, opts: {
      master?: string;
      agentName?: string;
      expiresIn?: string;
      canPerp?: boolean;
      canSpot?: boolean;
      canWithdraw?: boolean;
      rotate?: boolean;
      passphrase?: string;
      builder?: string;
      maxFeeRate?: string;
      builderName?: string;
      ipWhitelist?: string;
      apiKeyIndex?: string;
      json?: boolean;
    }, command: Command) => {
      const useJson = opts.json ?? isJson();
      // optsWithGlobals() merges parent + subcommand options so --passphrase
      // works whether placed on `perp --passphrase X wallet agent approve` or
      // on the subcommand. Commander v13 silently shadows the subcommand flag
      // when the parent defines an identically-named flag — the visible bug
      // was approve throwing PASSPHRASE_REQUIRED even with --passphrase set.
      const mergedOpts = command.optsWithGlobals() as { passphrase?: string };
      const passphraseFlag = mergedOpts.passphrase ?? opts.passphrase;

      // Normalize aliases
      const exchangeNorm = exchange === "lt" ? "lighter"
        : exchange === "hl" ? "hyperliquid"
        : exchange === "pac" ? "pacifica"
        : exchange === "ast" ? "aster"
        : exchange;

      // Phase 2d: Aster + HL + PAC + LT all implemented.
      if (
        exchangeNorm !== "aster" &&
        exchangeNorm !== "hyperliquid" &&
        exchangeNorm !== "pacifica" &&
        exchangeNorm !== "lighter"
      ) {
        reportErrorAndExit(new PerpError("NOT_IMPLEMENTED", `${exchange} agent approve not implemented`, {
          remediation: "Use one of: aster, hyperliquid, pacifica, lighter",
        }));
      }

      // ── Lighter approve branch (Phase 2d) ───────────────────────────────
      if (exchangeNorm === "lighter") {
        const masterName = opts.master ?? loadSettings().owsActiveWallet;
        const agentName = opts.agentName ?? "perp-cli-lt";
        const expiresIn = opts.expiresIn ?? "90d";
        let expiresAt: Date;
        try {
          expiresAt = parseExpiresIn(expiresIn);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          reportErrorAndExit(new PerpError("INVALID_PARAMS", msg, {
            remediation: "Use: 30d, 90d, 180d, 1y, or ISO-8601 datetime",
          }));
        }
        if (!masterName) {
          reportErrorAndExit(new PerpError("INVALID_PARAMS", "Master wallet name is required. Use --master or set owsActiveWallet in settings.", {
            remediation: "Run: perp setup or use --master <name>",
          }));
        }
        // Slot validation: explicit value must be 4..254. Otherwise pick free slot.
        let chosenSlot: number | undefined;
        if (opts.apiKeyIndex !== undefined) {
          const n = parseInt(opts.apiKeyIndex, 10);
          if (!Number.isInteger(n) || n < 4 || n > 254) {
            reportErrorAndExit(new PerpError("INVALID_PARAMS", `--api-key-index must be an integer in [4, 254]; got ${opts.apiKeyIndex}`, {
              remediation: "Slots 0-3 are reserved by the Lighter frontend. Use 4-254.",
            }));
          }
          chosenSlot = n;
        }
        const passphrase = await resolvePassphrase({ flag: passphraseFlag });
        if (passphrase === null) {
          reportErrorAndExit(new PerpError("PASSPHRASE_REQUIRED", "No passphrase provided and stdin is non-TTY", {
            remediation: "Provide passphrase via --passphrase flag, OWS_PASSPHRASE env var, or stdin pipe",
          }));
        }
        try {
          acquireLock("lighter");
          try {
            const result = await runLtApproveFlow({
              masterName,
              passphrase: passphrase ?? "",
              agentName,
              expiresAt,
              expiresAtIso: expiresAt.toISOString(),
              nowIso: new Date().toISOString(),
              canPerp: opts.canPerp ?? true,
              canSpot: opts.canSpot ?? false,
              canWithdraw: opts.canWithdraw ?? false,
              apiKeyIndex: chosenSlot,
            });
            if (useJson) {
              printJson(jsonOk(result));
            } else {
              console.log(chalk.green.bold("\n  Lighter Agent approved successfully!\n"));
              console.log(`  Name:           ${chalk.cyan(agentName)}`);
              console.log(`  API Key Index:  ${chalk.cyan(String(result.apiKeyIndex))}`);
              console.log(`  Public Key:     ${chalk.cyan(result.publicKey)}`);
              console.log(`  Account Index:  ${chalk.cyan(String(result.accountIndex))}`);
              console.log(`  Expires:        ${chalk.cyan(expiresAt.toISOString())}`);
              console.log();
            }
          } finally {
            releaseLock("lighter");
          }
        } catch (err) {
          reportErrorAndExit(err);
        }
        return;
      }

      // ── Pacifica approve branch (Phase 2c) ──────────────────────────────
      if (exchangeNorm === "pacifica") {
        const masterName = opts.master ?? loadSettings().owsActiveWallet;
        const agentName = opts.agentName ?? "perp-cli-pac";
        const expiresIn = opts.expiresIn ?? "90d";
        let expiresAt: Date;
        try {
          expiresAt = parseExpiresIn(expiresIn);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          reportErrorAndExit(new PerpError("INVALID_PARAMS", msg, {
            remediation: "Use: 30d, 90d, 180d, 1y, or ISO-8601 datetime",
          }));
        }
        if (!masterName) {
          reportErrorAndExit(new PerpError("INVALID_PARAMS", "Master wallet name is required. Use --master or set owsActiveWallet in settings.", {
            remediation: "Run: perp setup or use --master <name>",
          }));
        }
        const passphrase = await resolvePassphrase({ flag: passphraseFlag });
        if (passphrase === null) {
          reportErrorAndExit(new PerpError("PASSPHRASE_REQUIRED", "No passphrase provided and stdin is non-TTY", {
            remediation: "Provide passphrase via --passphrase flag, OWS_PASSPHRASE env var, or stdin pipe",
          }));
        }
        try {
          acquireLock("pacifica");
          try {
            const result = await runPacApproveFlow({
              masterName,
              passphrase: passphrase ?? "",
              agentName,
              expiresAt,
              expiresAtIso: expiresAt.toISOString(),
              nowIso: new Date().toISOString(),
              canPerp: opts.canPerp ?? true,
              canSpot: opts.canSpot ?? false,
              canWithdraw: opts.canWithdraw ?? false,
            });
            if (useJson) {
              printJson(jsonOk(result));
            } else {
              console.log(chalk.green.bold("\n  Pacifica Agent approved successfully!\n"));
              console.log(`  Name:           ${chalk.cyan(agentName)}`);
              console.log(`  Agent Address:  ${chalk.cyan(result.agentSolanaAddress)}`);
              console.log(`  Master Address: ${chalk.cyan(result.userSolanaAddress)}`);
              console.log(`  Expires:        ${chalk.cyan(expiresAt.toISOString())}`);
              console.log();
            }
          } finally {
            releaseLock("pacifica");
          }
        } catch (err) {
          reportErrorAndExit(err);
        }
        return;
      }

      // ── Hyperliquid approve branch ──────────────────────────────────────
      if (exchangeNorm === "hyperliquid") {
        const masterName = opts.master ?? loadSettings().owsActiveWallet;
        const agentName = opts.agentName ?? "perp-cli-hl";
        const expiresIn = opts.expiresIn ?? "90d";
        let expiresAt: Date;
        try {
          expiresAt = parseExpiresIn(expiresIn);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          reportErrorAndExit(new PerpError("INVALID_PARAMS", msg, {
            remediation: "Use: 30d, 90d, 180d, 1y, or ISO-8601 datetime",
          }));
        }
        if (!masterName) {
          reportErrorAndExit(new PerpError("INVALID_PARAMS", "Master wallet name is required. Use --master or set owsActiveWallet in settings.", {
            remediation: "Run: perp setup or use --master <name>",
          }));
        }
        const passphrase = await resolvePassphrase({ flag: passphraseFlag });
        if (passphrase === null) {
          reportErrorAndExit(new PerpError("PASSPHRASE_REQUIRED", "No passphrase provided and stdin is non-TTY", {
            remediation: "Provide passphrase via --passphrase flag, OWS_PASSPHRASE env var, or stdin pipe",
          }));
        }
        try {
          acquireLock("hyperliquid");
          try {
            const result = await runHlApproveFlow({
              masterName,
              passphrase: passphrase ?? "",
              agentName,
              expiresAt,
              expiresAtIso: expiresAt.toISOString(),
              nowIso: new Date().toISOString(),
              canPerp: opts.canPerp ?? true,
              canSpot: opts.canSpot ?? false,
              canWithdraw: opts.canWithdraw ?? false,
            });
            if (useJson) {
              printJson(jsonOk(result));
            } else {
              console.log(chalk.green.bold("\n  Hyperliquid Agent approved successfully!\n"));
              console.log(`  Name:          ${chalk.cyan(agentName)}`);
              console.log(`  Agent Address: ${chalk.cyan(result.agentAddress)}`);
              console.log(`  Expires:       ${chalk.cyan(expiresAt.toISOString())}`);
              console.log();
            }
          } finally {
            releaseLock("hyperliquid");
          }
        } catch (err) {
          reportErrorAndExit(err);
        }
        return;
      }

      // Wizard mode: enter only when ALL THREE conditions hold
      const wizardMode =
        opts.master === undefined &&
        opts.agentName === undefined &&
        opts.expiresIn === undefined &&
        process.stdin.isTTY === true &&
        process.env["OWS_PASSPHRASE"] === undefined;

      let masterName: string;
      let agentName: string;
      let expiresIn: string;
      let canPerp: boolean;
      let canSpot: boolean;
      let canWithdraw: boolean;
      let passphrase: string | null;

      if (wizardMode) {
        const rl = createInterface({ input, output });
        try {
          const settings = loadSettings();
          const defMaster = settings.owsActiveWallet || "main";
          const rawMaster = await rl.question(`Master wallet name [${defMaster}]: `);
          masterName = rawMaster.trim() || defMaster;

          const rawAgent = await rl.question(`Agent name [perp-cli-aster]: `);
          agentName = rawAgent.trim() || "perp-cli-aster";

          const rawExpiry = await rl.question(`Expires-in [90d]: `);
          expiresIn = rawExpiry.trim() || "90d";

          const rawPerp = await rl.question(`Can perp trade? [Y/n]: `);
          canPerp = rawPerp.trim().toLowerCase() !== "n";

          const rawSpot = await rl.question(`Can spot trade? [y/N]: `);
          canSpot = rawSpot.trim().toLowerCase() === "y";

          const rawWithdraw = await rl.question(`Can withdraw? [y/N]: `);
          canWithdraw = rawWithdraw.trim().toLowerCase() === "y";

          // Hidden passphrase prompt — readline doesn't support hidden natively;
          // we use muted output pattern compatible with node:readline/promises
          process.stdout.write("Master passphrase: ");
          const rawPp = await rl.question("");
          passphrase = rawPp.trim() || null;
        } finally {
          rl.close();
        }
      } else {
        masterName = opts.master ?? loadSettings().owsActiveWallet;
        agentName = opts.agentName ?? "perp-cli-aster";
        expiresIn = opts.expiresIn ?? "90d";
        canPerp = opts.canPerp ?? true;
        canSpot = opts.canSpot ?? false;
        canWithdraw = opts.canWithdraw ?? false;
        // 3-path passphrase resolver (non-TTY path)
        passphrase = await resolvePassphrase({ flag: passphraseFlag });
        if (passphrase === null) {
          // TTY but non-wizard (some flags were supplied) — throw PASSPHRASE_REQUIRED
          reportErrorAndExit(new PerpError("PASSPHRASE_REQUIRED", "No passphrase provided and stdin is non-TTY or wizard skipped", {
            remediation: "Provide passphrase via --passphrase flag, OWS_PASSPHRASE env var, or stdin pipe",
          }));
        }
      }

      if (!masterName) {
        reportErrorAndExit(new PerpError("INVALID_PARAMS", "Master wallet name is required. Use --master or set owsActiveWallet in settings.", {
          remediation: "Run: perp setup or use --master <name>",
        }));
      }

      // Parse expires-in
      let expiresAt: Date;
      try {
        expiresAt = parseExpiresIn(expiresIn);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        reportErrorAndExit(new PerpError("INVALID_PARAMS", msg, {
          remediation: "Use: 30d, 90d, 180d, 1y, or ISO-8601 datetime",
        }));
      }
      const expiredMs = expiresAt.getTime();
      const expiresAtIso = expiresAt.toISOString();
      const nonceMicros = Date.now() * 1000 + (Math.floor(Math.random() * 1000));
      const nowIso = new Date().toISOString();

      const asterChain = "Mainnet" as const;

      try {
        // Step 1: Acquire lock at the START of the flow (before any OWS resources
        // are created) so that concurrent approves are fully serialized, not just
        // the final settings write.
        acquireLock("aster");
        try {
          const result = await runApproveFlow({
            masterName,
            passphrase: passphrase ?? "",
            agentName,
            expiresAt,
            expiredMs,
            expiresAtIso,
            nonceMicros,
            nowIso,
            canPerp,
            canSpot,
            canWithdraw,
            asterChain,
            builder: opts.builder,
            maxFeeRate: opts.maxFeeRate,
            builderName: opts.builderName,
            ipWhitelist: opts.ipWhitelist,
          });

          if (useJson) {
            printJson(jsonOk(result));
          } else {
            console.log(chalk.green.bold("\n  Agent approved successfully!\n"));
            console.log(`  Name:          ${chalk.cyan(agentName)}`);
            console.log(`  Agent Address: ${chalk.cyan(result.agentAddress)}`);
            console.log(`  Expires:       ${chalk.cyan(expiresAtIso)}`);
            console.log(`  API Key ID:    ${chalk.gray(result.owsApiKeyId)}`);
            console.log(`  Policy ID:     ${chalk.gray(result.policyId)}`);
            console.log();
          }
        } finally {
          releaseLock("aster");
        }
      } catch (err) {
        reportErrorAndExit(err);
      }
    });

  // ── agent list [<exchange>] ──────────────────────────────────────────────
  agent
    .command("list [exchange]")
    .description("List registered agent wallets")
    .option("--json", "Machine-readable output")
    .action((exchange: string | undefined, opts: { json?: boolean }) => {
      const useJson = opts.json ?? isJson();
      const all = listAgents(exchange);
      const now = Date.now();

      const rows = all.map(({ exchange: ex, meta }) => {
        let status: "active" | "expired" | "partial";
        if (meta.status === "partial") {
          status = "partial";
        } else if (new Date(meta.expiresAt).getTime() < now) {
          status = "expired";
        } else {
          status = "active";
        }
        return {
          name: meta.agentName,
          exchange: ex,
          evmAddress: meta.agentEvmAddress,
          expiresAt: meta.expiresAt,
          status,
          permissions: meta.permissions,
        };
      });

      if (useJson) {
        printJson(jsonOk(rows));
        return;
      }

      if (rows.length === 0) {
        console.log("No agents registered. Run `perp wallet agent approve <exchange> ...` to create one.");
        return;
      }

      console.log(chalk.cyan.bold("\n  Registered Agent Wallets\n"));
      const header = ["NAME", "EXCHANGE", "EVM ADDR", "EXPIRES", "STATUS", "PERP", "SPOT", "WITHDRAW"];
      const colWidths = [20, 10, 14, 26, 9, 6, 6, 10];
      console.log("  " + header.map((h, i) => chalk.bold(h.padEnd(colWidths[i]))).join("  "));
      console.log("  " + header.map((_, i) => "─".repeat(colWidths[i])).join("  "));
      for (const r of rows) {
        const addr = r.evmAddress ? r.evmAddress.slice(0, 6) + "…" + r.evmAddress.slice(-4) : "";
        const statusColor = r.status === "active" ? chalk.green : r.status === "expired" ? chalk.red : chalk.yellow;
        const cols = [
          r.name.slice(0, 19),
          r.exchange,
          addr,
          new Date(r.expiresAt).toLocaleDateString(),
          statusColor(r.status),
          r.permissions.canPerpTrade ? chalk.green("Y") : chalk.gray("N"),
          r.permissions.canSpotTrade ? chalk.green("Y") : chalk.gray("N"),
          r.permissions.canWithdraw ? chalk.green("Y") : chalk.gray("N"),
        ];
        console.log("  " + cols.map((c, i) => String(c).padEnd(colWidths[i])).join("  "));
      }
      console.log();
    });

  // ── agent revoke <exchange> <agentName> ─────────────────────────────────
  agent
    .command("revoke <exchange> <agentName>")
    .description("Revoke an agent wallet registration")
    .option("--force", "Skip Aster POST, only clear local state")
    .option("--passphrase <pp>", "Master OWS passphrase")
    .option("--json", "Machine-readable output")
    .action(async (exchange: string, agentName: string, opts: {
      force?: boolean;
      passphrase?: string;
      json?: boolean;
    }, command: Command) => {
      const useJson = opts.json ?? isJson();
      // optsWithGlobals(): see wallet agent approve for full rationale.
      const mergedOpts = command.optsWithGlobals() as { passphrase?: string };
      const passphraseFlag = mergedOpts.passphrase ?? opts.passphrase;

      try {
        // Step 1: Check local meta (idempotent — absent = already revoked)
        const meta = getAgent(exchange, agentName);
        if (!meta) {
          const result = { ok: true, data: { alreadyRevoked: true } };
          if (useJson) {
            printJson(result);
          } else {
            console.log(`Agent "${agentName}" on ${exchange} not found locally — already revoked.`);
          }
          return;
        }

        if (!opts.force) {
          // Step 2: Resolve passphrase
          const passphrase = await resolvePassphrase({ flag: passphraseFlag });
          if (passphrase === null) {
            throw new PerpError("PASSPHRASE_REQUIRED", "No passphrase provided and stdin is non-TTY", {
              remediation: "Provide passphrase via --passphrase flag, OWS_PASSPHRASE env var, or stdin pipe",
            });
          }

          if (exchange === "hyperliquid") {
            // HL revoke: POST approveAgent with zero-address (best-effort, idempotent)
            const masterName = meta.masterWalletName;
            const masterSigner = OwsEvmSigner.create(masterName, passphrase);
            try {
              await revokeHlAgent(masterSigner);
            } catch { /* best effort — HL revoke is idempotent */ }
          } else if (exchange === "pacifica") {
            // PAC revoke: signed revoke_agent_wallet → POST /agent/revoke.
            // Rule #2: do NOT swallow. A refused revoke leaves the agent key
            // authorized to trade; suppressing it here would delete the local
            // record (Step 6) and leave the user believing the key is dead.
            // Mirrors the Aster branch below: fail, and offer --force for a
            // local-only cleanup.
            const masterName = meta.masterWalletName;
            const solanaSigner = OwsSolanaSigner.create(masterName, passphrase);
            await revokePacAgent(solanaSigner, meta.agentSolanaAddress ?? "");
          } else if (exchange === "lighter" || exchange === "lt") {
            // LT revoke: Lighter has no on-chain revoke action; revoke is local-only.
            // Slots persist on the L2 server until overwritten by a fresh ChangePubKey
            // at the same index. revokeLtAgent is a no-op stub that exists for
            // symmetry with the other DEX revoke helpers.
            try {
              await revokeLtAgent();
            } catch { /* best effort — LT revoke is idempotent */ }
          } else {
            // Aster revoke: Step 3: Build DelAgent EIP-712
            const masterName = meta.masterWalletName;
            const masterSigner = OwsEvmSigner.create(masterName, passphrase);
            const userEvmAddress = masterSigner.getAddress() as `0x${string}`;
            const nonceMicros = Date.now() * 1000 + Math.floor(Math.random() * 1000);

            const delTypedData = buildDelAgentTypedData({
              user: userEvmAddress,
              agentAddress: meta.agentEvmAddress,
              nonceMicros,
              asterChain: "Mainnet",
            });

            const signature = await masterSigner.signTypedData(
              delTypedData.domain as Record<string, unknown>,
              delTypedData.types as Record<string, Array<{ name: string; type: string }>>,
              delTypedData.message,
            );

            // Step 4: POST DELETE /fapi/v3/agent
            const baseUrl = "https://fapi.asterdex.com";
            const qsEntries: [string, string][] = [
              ["agentAddress", meta.agentEvmAddress],
              ["asterChain", "Mainnet"],
              ["user", userEvmAddress],
              ["nonce", String(nonceMicros)],
              ["signature", signature],
              ["signatureChainId", "56"],
            ];
            const qs = new URLSearchParams(Object.fromEntries(qsEntries));

            const revokeRes = await fetch(`${baseUrl}/fapi/v3/agent?${qs.toString()}`, {
              method: "DELETE",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: "",
            });

            // Idempotent: 404 = already revoked server-side, treat as success
            if (!revokeRes.ok && revokeRes.status !== 404) {
              const errText = await revokeRes.text().catch(() => "");
              throw new PerpError("EXCHANGE_ERROR", `Aster agent delete failed (${revokeRes.status}): ${errText.slice(0, 200)}`, {
                remediation: "Use --force to skip Aster POST and only clear local state",
              });
            }
          }
        }

        // Step 5: Revoke OWS API key (Aster only — HL has no OWS key)
        if (meta.owsApiKeyId) {
          try {
            const ows = loadOws();
            ows.revokeApiKey(meta.owsApiKeyId);
          } catch { /* best effort */ }
        }

        // Step 6: Delete local agent entry
        deleteAgent(exchange, agentName);

        if (useJson) {
          printJson(jsonOk({ revoked: true }));
        } else {
          console.log(chalk.green(`Agent "${agentName}" on ${exchange} revoked successfully.`));
        }
      } catch (err) {
        reportErrorAndExit(err);
      }
    });

  // ── agent rotate <exchange> [<oldAgentName>] ─────────────────────────────
  agent
    .command("rotate <exchange> [oldAgentName]")
    .description("Rotate an agent wallet: revoke existing, then approve with same name")
    .option("--passphrase <pp>", "Master OWS passphrase")
    .option("--master <name>", "Master OWS wallet name")
    .option("--agent-name <name>", "Agent name to rotate (default: first registered agent)")
    .option("--expires-in <duration>", "New expiry (default: 90d)")
    .option("--can-perp", "Allow perp trading (default: inherit or on)")
    .option("--no-can-perp", "Disallow perp trading")
    .option("--can-spot", "Allow spot trading (default: inherit or off)")
    .option("--no-can-spot", "Disallow spot trading")
    .option("--can-withdraw", "Allow withdrawals (default: inherit or off)")
    .option("--no-can-withdraw", "Disallow withdrawals")
    .option("--json", "Machine-readable output")
    .action(async (exchange: string, oldAgentNameArg: string | undefined, opts: {
      passphrase?: string;
      master?: string;
      agentName?: string;
      expiresIn?: string;
      canPerp?: boolean;
      canSpot?: boolean;
      canWithdraw?: boolean;
      json?: boolean;
    }, command: Command) => {
      const useJson = opts.json ?? isJson();
      // optsWithGlobals(): see wallet agent approve for full rationale.
      const mergedOpts = command.optsWithGlobals() as { passphrase?: string };
      const passphraseFlag = mergedOpts.passphrase ?? opts.passphrase;

      try {
        // Determine which agent to rotate
        const agentNameToRotate = oldAgentNameArg ?? opts.agentName ?? getAgent(exchange)?.agentName;
        if (!agentNameToRotate) {
          throw new PerpError("AGENT_NOT_REGISTERED", `No agent found for ${exchange}`, {
            remediation: `Run: perp wallet agent approve ${exchange} to create one`,
          });
        }

        // Resolve passphrase early (needed for both revoke and approve phases)
        const passphrase = await resolvePassphrase({ flag: passphraseFlag });
        if (passphrase === null) {
          throw new PerpError("PASSPHRASE_REQUIRED", "No passphrase provided and stdin is non-TTY", {
            remediation: "Provide passphrase via --passphrase flag, OWS_PASSPHRASE env var, or stdin pipe",
          });
        }

        const settings = loadSettings();
        const masterName = opts.master ?? settings.owsActiveWallet;

        // Capture existing agent meta before revoke (for permission inheritance)
        const existing = getAgent(exchange, agentNameToRotate);

        // Resolve permissions: explicit flags > old agent's permissions > defaults.
        // With --no-can-perp/spot/withdraw pattern, opts values are undefined when not passed.
        const permFlagsProvided = opts.canPerp !== undefined || opts.canSpot !== undefined || opts.canWithdraw !== undefined;
        let canPerp: boolean;
        let canSpot: boolean;
        let canWithdraw: boolean;
        if (permFlagsProvided) {
          canPerp = opts.canPerp ?? true;
          canSpot = opts.canSpot ?? false;
          canWithdraw = opts.canWithdraw ?? false;
        } else if (existing?.permissions) {
          // Preserve old agent's permission set when flags are absent
          canPerp = existing.permissions.canPerpTrade;
          canSpot = existing.permissions.canSpotTrade;
          canWithdraw = existing.permissions.canWithdraw;
        } else {
          canPerp = true;
          canSpot = false;
          canWithdraw = false;
        }

        // Revoke existing (if present) — best effort
        if (existing) {
          try {
            if (exchange === "pacifica") {
              // Pacifica master is a Solana keypair; can't reuse the EVM master signer.
              const revokePacSigner = OwsSolanaSigner.create(existing.masterWalletName, passphrase);
              await revokePacAgent(revokePacSigner, existing.agentSolanaAddress ?? "");
              if (existing.owsApiKeyId) {
                try { loadOws().revokeApiKey(existing.owsApiKeyId); } catch { /* best effort */ }
              }
              deleteAgent(exchange, agentNameToRotate);
              // Continue to the shared approve flow below.
              // (skip the remaining EVM-revoke branch via early continuation)
            } else if (exchange === "lighter" || exchange === "lt") {
              // LT rotate: no on-chain revoke; just clear local entry. The new
              // approve picks the next free slot, leaving the old slot orphaned
              // on the L2 server (it cannot be used again until overwritten via
              // a fresh ChangePubKey at that index — which the next approve does
              // implicitly when it picks max+1).
              await revokeLtAgent();
              if (existing.owsApiKeyId) {
                try { loadOws().revokeApiKey(existing.owsApiKeyId); } catch { /* best effort */ }
              }
              deleteAgent(exchange, agentNameToRotate);
              // Continue to the shared approve flow below.
            } else {
            const revokeMs = OwsEvmSigner.create(existing.masterWalletName, passphrase);
            if (exchange === "hyperliquid") {
              // HL: revoke via approveAgent with zero-address
              await revokeHlAgent(revokeMs);
            } else {
              // Aster: DELETE /fapi/v3/agent
              const userEvmAddress = revokeMs.getAddress() as `0x${string}`;
              const nonceMicros = Date.now() * 1000 + Math.floor(Math.random() * 1000);
              const delTypedData = buildDelAgentTypedData({
                user: userEvmAddress,
                agentAddress: existing.agentEvmAddress,
                nonceMicros,
                asterChain: "Mainnet",
              });
              const sig = await revokeMs.signTypedData(
                delTypedData.domain as Record<string, unknown>,
                delTypedData.types as Record<string, Array<{ name: string; type: string }>>,
                delTypedData.message,
              );
              const baseUrl = "https://fapi.asterdex.com";
              const qs = new URLSearchParams(Object.fromEntries([
                ["agentAddress", existing.agentEvmAddress],
                ["asterChain", "Mainnet"],
                ["user", userEvmAddress],
                ["nonce", String(nonceMicros)],
                ["signature", sig],
                ["signatureChainId", "56"],
              ] as [string, string][]));
              await fetch(`${baseUrl}/fapi/v3/agent?${qs.toString()}`, {
                method: "DELETE",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: "",
              });
            }
            if (existing.owsApiKeyId) {
              try { loadOws().revokeApiKey(existing.owsApiKeyId); } catch { /* best effort */ }
            }
            deleteAgent(exchange, agentNameToRotate);
            }
          } catch (revokeErr) {
            // Best effort on revoke — still rotate in a new agent. But do not
            // stay silent: a failed revoke means the OLD agent key may remain
            // authorized to trade, which the user must know to clean up.
            process.stderr.write(
              `[${exchange}] warning: revoking the previous agent failed — it may still be authorized. ` +
              `${revokeErr instanceof Error ? revokeErr.message : String(revokeErr)}\n`,
            );
          }
        }

        const expiresIn = opts.expiresIn ?? "90d";
        const expiresAt = parseExpiresIn(expiresIn);
        const expiresAtIso = expiresAt.toISOString();
        const nowIso = new Date().toISOString();

        // Acquire lock and run the shared approve flow
        acquireLock(exchange);
        try {
          let rotatedAgentAddress: string;
          if (exchange === "hyperliquid") {
            const result = await runHlApproveFlow({
              masterName,
              passphrase,
              agentName: agentNameToRotate,
              expiresAt,
              expiresAtIso,
              nowIso,
              canPerp,
              canSpot,
              canWithdraw,
            });
            rotatedAgentAddress = result.agentAddress;
          } else if (exchange === "pacifica") {
            const result = await runPacApproveFlow({
              masterName,
              passphrase,
              agentName: agentNameToRotate,
              expiresAt,
              expiresAtIso,
              nowIso,
              canPerp,
              canSpot,
              canWithdraw,
            });
            rotatedAgentAddress = result.agentSolanaAddress;
          } else if (exchange === "lighter" || exchange === "lt") {
            const result = await runLtApproveFlow({
              masterName,
              passphrase,
              agentName: agentNameToRotate,
              expiresAt,
              expiresAtIso,
              nowIso,
              canPerp,
              canSpot,
              canWithdraw,
              // No apiKeyIndex override on rotate — picks next free slot.
            });
            rotatedAgentAddress = `slot=${result.apiKeyIndex} pubkey=${result.publicKey}`;
          } else {
            const expiredMs = expiresAt.getTime();
            const nonceMicros = Date.now() * 1000 + Math.floor(Math.random() * 1000);
            const result = await runApproveFlow({
              masterName,
              passphrase,
              agentName: agentNameToRotate,
              expiresAt,
              expiredMs,
              expiresAtIso,
              nonceMicros,
              nowIso,
              canPerp,
              canSpot,
              canWithdraw,
              asterChain: "Mainnet",
            });
            rotatedAgentAddress = result.agentAddress;
          }

          if (useJson) {
            printJson(jsonOk({ rotated: true, agentName: agentNameToRotate, agentEvmAddress: rotatedAgentAddress, expiresAt: expiresAtIso }));
          } else {
            console.log(chalk.green(`Agent "${agentNameToRotate}" on ${exchange} rotated successfully.`));
            console.log(`  New agent address: ${chalk.cyan(rotatedAgentAddress)}`);
            console.log(`  Expires: ${chalk.cyan(expiresAtIso)}`);
          }
        } finally {
          releaseLock(exchange);
        }
      } catch (err) {
        reportErrorAndExit(err);
      }
    });

  // ── agent verify [exchange] [agentName] ──────────────────────────────────
  agent
    .command("verify [exchange] [agentName]")
    .description("Verify agent wallet registration via DEX query API")
    .option("--master <name>", "Master OWS wallet name (Aster/PAC). Defaults to settings.owsActiveWallet")
    .option("--master-address <addr>", "Master EVM address (HL only)")
    .option("--account-index <n>", "Account index (Lighter only)")
    .option("--passphrase <pp>", "Master OWS passphrase (Aster/PAC). Falls back to OWS_PASSPHRASE env.")
    .option("--json", "Machine-readable output")
    .action(async (exchange: string | undefined, agentName: string | undefined, opts: {
      master?: string;
      masterAddress?: string;
      accountIndex?: string;
      passphrase?: string;
      json?: boolean;
    }, command: Command) => {
      const useJson = opts.json ?? isJson();
      const ts = new Date().toISOString();
      // optsWithGlobals(): see wallet agent approve for full rationale.
      const mergedOpts = command.optsWithGlobals() as { passphrase?: string };
      const passphraseFlag = mergedOpts.passphrase ?? opts.passphrase;

      // Resolve passphrase via 3-path: flag > env > (no stdin prompt in verify)
      const passphrase = passphraseFlag ?? process.env["OWS_PASSPHRASE"] ?? "";

      const verifyOpts: VerifyOpts = {
        agentName,
        master: opts.master,
        masterAddress: opts.masterAddress,
        accountIndex: opts.accountIndex,
        passphrase,
      };

      if (!exchange) {
        // Aggregate mode: all 4 DEXs in parallel
        const [asterResult, hlResult, pacResult, ltResult] = await Promise.allSettled([
          verifyAster(verifyOpts),
          verifyHyperliquid(verifyOpts),
          verifyPacifica(verifyOpts),
          verifyLighter(verifyOpts),
        ]);

        function slotResult(r: PromiseSettledResult<VerifyResult>) {
          if (r.status === "fulfilled") {
            const slot: Record<string, unknown> = { registered: r.value.registered, count: r.value.count, items: r.value.items };
            if (r.value.warnings && r.value.warnings.length > 0) slot.warnings = r.value.warnings;
            return slot;
          }
          const err = r.reason instanceof PerpError ? r.reason : null;
          return {
            error: {
              code: err ? err.structured.code : "EXCHANGE_ERROR",
              message: err ? err.structured.message : (r.reason instanceof Error ? r.reason.message : String(r.reason)),
              remediation: err ? err.structured.remediation : undefined,
            },
          };
        }

        const data = {
          aster: slotResult(asterResult),
          hyperliquid: slotResult(hlResult),
          pacifica: slotResult(pacResult),
          lighter: slotResult(ltResult),
        };

        if (useJson) {
          printJson({ ok: true, data, meta: { timestamp: ts } });
        } else {
          console.log(chalk.bold("Agent Verify — All DEXs"));
          for (const [dex, slot] of Object.entries(data)) {
            if ("error" in slot) {
              console.log(chalk.yellow(`  ${dex}: ERROR — ${(slot as { error: { message: string } }).error.message}`));
            } else {
              const s = slot as { registered: boolean; count: number; warnings?: string[] };
              const icon = s.registered ? chalk.green("✓") : chalk.gray("○");
              console.log(`  ${icon} ${dex}: ${s.count} agent(s) registered`);
              for (const w of s.warnings ?? []) {
                console.log(chalk.yellow(`      [warn] ${w}`));
              }
            }
          }
        }
        return;
      }

      // Single-DEX mode
      try {
        let result: VerifyResult;
        const ex = exchange.toLowerCase();
        if (ex === "aster") {
          result = await verifyAster(verifyOpts);
        } else if (ex === "hyperliquid" || ex === "hl") {
          result = await verifyHyperliquid(verifyOpts);
        } else if (ex === "pacifica" || ex === "pac") {
          result = await verifyPacifica(verifyOpts);
        } else if (ex === "lighter" || ex === "lt") {
          result = await verifyLighter(verifyOpts);
        } else {
          throw new PerpError("INVALID_PARAMS", `Unknown exchange "${exchange}". Use: aster, hyperliquid, pacifica, lighter`, {
            remediation: "perp wallet agent verify <aster|hyperliquid|pacifica|lighter> [agentName]",
          });
        }

        if (useJson) {
          printJson({
            ok: true,
            data: { exchange: ex, registered: result.registered, count: result.count, items: result.items },
            meta: { timestamp: ts, ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}) },
          });
        } else {
          const icon = result.registered ? chalk.green("✓") : chalk.gray("○");
          console.log(`${icon} ${chalk.bold(ex)}: ${result.count} agent(s) registered`);
          if (result.count > 0) {
            if (ex === "aster") {
              console.log(chalk.dim("  agentAddress               | agentName        | expired     | canPerp | canSpot | canWithdraw"));
              for (const item of result.items) {
                const i = item as Record<string, unknown>;
                const addr = String(i["agentAddress"] ?? "").substring(0, 20) + "…";
                const name = String(i["agentName"] ?? "").padEnd(16);
                const exp = i["expired"] !== undefined ? String(i["expired"]) : "—";
                const cp = i["canPerpTrade"] ? "yes" : "no";
                const cs = i["canSpotTrade"] ? "yes" : "no";
                const cw = i["canWithdraw"] ? "yes" : "no";
                console.log(`  ${addr} | ${name} | ${exp} | ${cp.padEnd(7)} | ${cs.padEnd(7)} | ${cw}`);
              }
            } else if (ex === "hyperliquid" || ex === "hl") {
              console.log(chalk.dim("  address                    | validUntil  | name"));
              for (const item of result.items) {
                const i = item as Record<string, unknown>;
                const addr = String(i["address"] ?? "").substring(0, 20) + "…";
                const vu = i["validUntil"] !== undefined ? String(i["validUntil"]) : "—";
                const name = String(i["name"] ?? "");
                console.log(`  ${addr} | ${vu.padEnd(11)} | ${name}`);
              }
            } else if (ex === "lighter" || ex === "lt") {
              console.log(chalk.dim("  api_key_index | public_key (truncated)  | nonce | transaction_time"));
              for (const item of result.items) {
                const i = item as Record<string, unknown>;
                const idx = String(i["api_key_index"] ?? "");
                const pk = String(i["public_key"] ?? "").substring(0, 20) + "…";
                const nonce = String(i["nonce"] ?? "");
                const tt = String(i["transaction_time"] ?? "");
                console.log(`  ${idx.padEnd(13)} | ${pk.padEnd(23)} | ${nonce.padEnd(5)} | ${tt}`);
              }
            } else if (ex === "pacifica" || ex === "pac") {
              console.log(chalk.dim("  api_key (truncated)      | created_at"));
              for (const item of result.items) {
                const i = item as Record<string, unknown>;
                const key = String(i["api_key"] ?? "").substring(0, 20) + "…";
                const created = String(i["created_at"] ?? "");
                console.log(`  ${key.padEnd(24)} | ${created}`);
              }
            }
          }
          if (result.warnings && result.warnings.length > 0) {
            for (const w of result.warnings) {
              process.stderr.write(chalk.yellow(`[warn] ${w}\n`));
            }
          }
        }
      } catch (err) {
        reportErrorAndExit(err);
      }
    });
}

// ── Pre-venue rollback helpers ───────────────────────────────────────────────
//
// When `wallet agent approve <dex>` fails BEFORE the venue accepted the agent
// (HTTP error, body-code rejection, parse error, network drop), the locally
// generated `agent-<dex>-<master>` OWS wallet is orphaned in `~/.ows/wallets/`.
// Retry collides with "wallet name already exists". These helpers auto-delete
// the orphan and produce an actionable remediation string.
//
// Post-venue (persist-only) failures must NOT use these — those leave a
// status:"partial" record so the user can still revoke venue-side state.

/**
 * Best-effort delete of an orphan local OWS wallet. Returns true on success,
 * false on failure (also logs the failure to stderr per SSOT Rule #2: rollback
 * failures must not silently mask the original error). The caller threads the
 * boolean into the user-visible remediation.
 */
function tryDeleteOrphanWallet(
  ows: { deleteWallet: (name: string) => void },
  walletName: string | undefined,
): boolean {
  if (!walletName) return false;
  try {
    ows.deleteWallet(walletName);
    return true;
  } catch (cleanupErr) {
    // Don't swallow — surface the rollback failure on stderr so the user can
    // see exactly what's stuck. Original error still propagates from caller.
    process.stderr.write(
      `[warn] failed to clean up orphan wallet "${walletName}": ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}\n`,
    );
    return false;
  }
}

/**
 * Build an actionable remediation message for pre-venue approve failures.
 * On clean rollback: tells the user to deposit + retry the canonical
 * `wallet agent approve <dex> --master <master>` command (no manual steps).
 * On rollback failure: tells the user to manually delete the orphan wallet
 * before retrying. The agent address is appended for diagnostic purposes
 * (some users may need it for the venue UI).
 */
function buildPreVenueRemediation(opts: {
  cleanupOk: boolean;
  dex: "hyperliquid" | "pacifica" | "aster";
  masterName: string;
  agentAddress: string;
  hint?: string;
}): string {
  const { cleanupOk, dex, masterName, agentAddress, hint } = opts;
  const retry = `perp wallet agent approve ${dex} --master ${masterName}`;
  const head = cleanupOk
    ? `Local agent wallet cleaned up. Deposit funds and retry: ${retry}`
    : `Manual cleanup required — local agent wallet may still exist. Run: perp wallet remove agent-${dex === "hyperliquid" ? "hl" : dex === "pacifica" ? "pac" : "aster"}-${masterName}, then retry: ${retry}`;
  const parts = [head];
  if (hint) parts.push(hint);
  parts.push(`Agent address (diagnostic): ${agentAddress}`);
  return parts.join(" | ");
}

// ── Shared approve flow helper ───────────────────────────────────────────────

interface ApproveFlowOpts {
  masterName: string;
  passphrase: string;
  agentName: string;
  expiresAt: Date;
  expiredMs: number;
  expiresAtIso: string;
  nonceMicros: number;
  nowIso: string;
  canPerp: boolean;
  canSpot: boolean;
  canWithdraw: boolean;
  asterChain: "Mainnet" | "Testnet";
  builder?: string;
  maxFeeRate?: string;
  builderName?: string;
  ipWhitelist?: string;
}

interface ApproveFlowResult {
  agentAddress: `0x${string}`;
  agentName: string;
  expiresAt: string;
  owsApiKeyId: string;
  policyId: string;
  asterApprovalNonce: string;
  userEvmAddress: `0x${string}`;
}

/**
 * Core approve flow: Steps 2-12 (OWS wallet + policy + api-key + EIP-712 + Aster POST + persist).
 * Caller MUST hold the exchange lock before calling this function.
 * The function is re-entrant safe with setAgent because callerHoldsLock() will
 * return true when called from within a locked context.
 */
async function runApproveFlow(opts: ApproveFlowOpts): Promise<ApproveFlowResult> {
  const {
    masterName, passphrase, agentName, expiredMs, expiresAtIso, nonceMicros, nowIso,
    canPerp, canSpot, canWithdraw, asterChain,
  } = opts;

  const baseUrl = "https://fapi.asterdex.com";
  let owsApiKeyId: string | undefined;
  let owsPolicyId: string | undefined;
  let agentEvmAddress: `0x${string}` | undefined;
  let agentWalletName: string | undefined;

  // Steps 2-3: Resolve master signer
  const masterSigner = OwsEvmSigner.create(masterName, passphrase);
  const userEvmAddress = masterSigner.getAddress() as `0x${string}`;

  // Step 4: Generate agent OWS wallet
  const ows = loadOws();
  agentWalletName = `agent-aster-${masterName}`;
  const agentWallet = ows.createWallet(agentWalletName, passphrase);
  const agentEvmAccount = agentWallet.accounts.find(
    (a: { chainId: string }) => a.chainId.startsWith("eip155:"),
  );
  if (!agentEvmAccount) {
    throw new PerpError("INVALID_PARAMS", `Agent wallet "${agentWalletName}" has no EVM account`, {
      remediation: "Check OWS vault configuration",
    });
  }
  agentEvmAddress = agentEvmAccount.address as `0x${string}`;

  // Step 5: Build OWS policy
  const policyId = `aster-perp-${Date.now()}`;
  owsPolicyId = policyId;
  ows.createPolicy(JSON.stringify({
    id: policyId,
    name: `perp-cli-aster-${agentName}`,
    version: 1,
    created_at: nowIso,
    rules: [{ type: "allowed_chains", chain_ids: ["eip155:56"] }],
    expires_at: expiresAtIso,
    executable: null,
    action: "deny",
  }));

  // Step 6: Build OWS API key — store only the id, never the token
  const apiKeyResult = ows.createApiKey(
    `api-aster-${agentName}`,
    [agentWallet.id],
    [policyId],
    passphrase,
    expiresAtIso,
  );
  owsApiKeyId = apiKeyResult.id;

  // Step 7 (Optional): Builder approval BEFORE approveAgent
  if (opts.builder) {
    if (!opts.maxFeeRate) {
      throw new PerpError("INVALID_PARAMS", "--max-fee-rate is required when --builder is set", {
        remediation: "Add --max-fee-rate <bps> to your command",
      });
    }
    const builderTypedData = buildApproveBuilderTypedData({
      builder: opts.builder,
      maxFeeRate: opts.maxFeeRate,
      builderName: opts.builderName,
      user: userEvmAddress,
      nonceMicros: nonceMicros - 1,
      asterChain,
    });
    const builderSig = await masterSigner.signTypedData(
      builderTypedData.domain as Record<string, unknown>,
      builderTypedData.types as Record<string, Array<{ name: string; type: string }>>,
      builderTypedData.message,
    );
    const builderQsEntries: [string, string][] = [
      ["builder", opts.builder],
      ["maxFeeRate", opts.maxFeeRate],
      ...(opts.builderName !== undefined ? [["builderName", opts.builderName] as [string, string]] : []),
      ["asterChain", asterChain],
      ["user", userEvmAddress],
      ["nonce", String(nonceMicros - 1)],
      ["signature", builderSig],
      ["signatureChainId", "56"],
    ];
    const builderRes = await fetch(`${baseUrl}/fapi/v3/approveBuilder?${new URLSearchParams(Object.fromEntries(builderQsEntries)).toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    if (!builderRes.ok) {
      const errText = await builderRes.text().catch(() => "");
      // Aster builder POST failed — pre-venue (no Aster agent registered yet).
      // Rollback both: api key + orphan local OWS wallet.
      if (owsApiKeyId) {
        try { ows.revokeApiKey(owsApiKeyId); } catch { /* best effort */ }
      }
      tryDeleteOrphanWallet(ows, agentWalletName);
      throw new PerpError("EXCHANGE_ERROR", `Aster approveBuilder failed (${builderRes.status}): ${errText.slice(0, 200)}`, {
        remediation: "Check builder address and max-fee-rate parameters",
      });
    }
    const builderResp = await builderRes.json() as { code: string | number; msg?: string; message?: string };
    const builderOk = builderResp.code === "000000" || builderResp.code === 200;
    if (!builderOk) {
      if (owsApiKeyId) {
        try { ows.revokeApiKey(owsApiKeyId); } catch { /* best effort */ }
      }
      tryDeleteOrphanWallet(ows, agentWalletName);
      const errMsg = builderResp.msg ?? builderResp.message ?? String(builderResp.code);
      throw new PerpError("EXCHANGE_ERROR", `Aster approveBuilder failed: ${errMsg}`, {
        remediation: "Check builder address and max-fee-rate parameters",
      });
    }
  }

  // Step 8: Build EIP-712 ApproveAgent payload
  const approveTypedData = buildApproveAgentTypedData({
    user: userEvmAddress,
    agentAddress: agentEvmAddress,
    agentName,
    expiredMs,
    canPerpTrade: canPerp,
    canSpotTrade: canSpot,
    canWithdraw,
    ipWhitelist: opts.ipWhitelist,
    builder: opts.builder,
    maxFeeRate: opts.maxFeeRate,
    builderName: opts.builderName,
    nonceMicros,
    asterChain,
  });

  // Step 9: Sign
  const signature = await masterSigner.signTypedData(
    approveTypedData.domain as Record<string, unknown>,
    approveTypedData.types as Record<string, Array<{ name: string; type: string }>>,
    approveTypedData.message,
  );

  // Step 10: Build query string
  const qsEntries: [string, string][] = [
    ["agentName", agentName],
    ["agentAddress", agentEvmAddress],
  ];
  if (opts.ipWhitelist !== undefined && opts.ipWhitelist !== null) {
    qsEntries.push(["ipWhitelist", opts.ipWhitelist]);
  }
  qsEntries.push(
    ["expired", String(expiredMs)],
    ["canSpotTrade", String(canSpot)],
    ["canPerpTrade", String(canPerp)],
    ["canWithdraw", String(canWithdraw)],
  );
  if (opts.builder !== undefined && opts.builder !== null) {
    qsEntries.push(["builder", opts.builder]);
    qsEntries.push(["maxFeeRate", opts.maxFeeRate ?? ""]);
    if (opts.builderName !== undefined) {
      qsEntries.push(["builderName", opts.builderName]);
    }
  }
  qsEntries.push(
    ["asterChain", asterChain],
    ["user", userEvmAddress],
    ["nonce", String(nonceMicros)],
    ["signature", signature],
    ["signatureChainId", "56"],
  );

  // Step 11: POST /fapi/v3/approveAgent
  let asterPostSucceeded = false;
  const agentRes = await fetch(`${baseUrl}/fapi/v3/approveAgent?${new URLSearchParams(Object.fromEntries(qsEntries)).toString()}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "",
  });
  if (agentRes.ok) {
    const resp = await agentRes.json() as { code: string | number; msg?: string; message?: string };
    if (resp.code === "000000" || resp.code === 200) {
      asterPostSucceeded = true;
    } else {
      // Aster POST body indicated failure — pre-venue (Aster did not register).
      // Rollback both api key + orphan local OWS wallet.
      if (owsApiKeyId) {
        try { ows.revokeApiKey(owsApiKeyId); } catch { /* best effort */ }
      }
      const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
      const errMsg = resp.msg ?? resp.message ?? String(resp.code);
      throw new PerpError("APPROVE_PARTIAL", `Aster approveAgent failed: ${errMsg}`, {
        remediation: buildPreVenueRemediation({
          cleanupOk, dex: "aster", masterName, agentAddress: agentEvmAddress,
        }),
      });
    }
  } else {
    // HTTP error — pre-venue (Aster did not register). Rollback both.
    if (owsApiKeyId) {
      try { ows.revokeApiKey(owsApiKeyId); } catch { /* best effort */ }
    }
    const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
    const errText = await agentRes.text().catch(() => "");
    throw new PerpError("APPROVE_PARTIAL", `Aster approveAgent failed (${agentRes.status}): ${errText.slice(0, 200)}`, {
      remediation: buildPreVenueRemediation({
        cleanupOk, dex: "aster", masterName, agentAddress: agentEvmAddress,
      }),
    });
  }

  // Step 12: Persist agent meta
  // Note: setAgent is re-entrant — if caller holds the lock, it writes directly.
  try {
    setAgent("aster", {
      agentName,
      agentWalletName,
      agentEvmAddress,
      userEvmAddress,
      masterWalletName: masterName,
      owsApiKeyId,
      owsPolicyId,
      expiresAt: expiresAtIso,
      approvedAt: nowIso,
      permissions: { canPerpTrade: canPerp, canSpotTrade: canSpot, canWithdraw },
      asterApprovalNonce: String(nonceMicros),
      status: "active",
    });
  } catch (persistErr) {
    // Settings persist failed AFTER Aster registration succeeded.
    // CRITICAL-2 fix: attempt BOTH remote DELETE and local revokeApiKey.
    // Only if BOTH succeed → APPROVE_FAILED (clean). Otherwise → APPROVE_PARTIAL.
    let deleteOk = false;
    let revokeOk = false;

    // Attempt remote DELETE /fapi/v3/agent
    try {
      const delNonce = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      const delTypedData = buildDelAgentTypedData({
        user: userEvmAddress,
        agentAddress: agentEvmAddress,
        nonceMicros: delNonce,
        asterChain,
      });
      const delSig = await masterSigner.signTypedData(
        delTypedData.domain as Record<string, unknown>,
        delTypedData.types as Record<string, Array<{ name: string; type: string }>>,
        delTypedData.message,
      );
      const delQs = new URLSearchParams(Object.fromEntries([
        ["agentAddress", agentEvmAddress],
        ["asterChain", asterChain],
        ["user", userEvmAddress],
        ["nonce", String(delNonce)],
        ["signature", delSig],
        ["signatureChainId", "56"],
      ] as [string, string][]));
      const delRes = await fetch(`${baseUrl}/fapi/v3/agent?${delQs.toString()}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      });
      deleteOk = delRes.ok || delRes.status === 404;
    } catch { /* best effort */ }

    // Attempt local API key revocation
    if (owsApiKeyId) {
      try { ows.revokeApiKey(owsApiKeyId); revokeOk = true; } catch { /* best effort */ }
    } else {
      revokeOk = true; // nothing to revoke
    }

    if (deleteOk && revokeOk) {
      // Clean rollback — throw APPROVE_FAILED (not partial)
      throw new PerpError("APPROVE_FAILED", `Agent approve failed: settings persist error after clean rollback. ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`, {
        remediation: `Both remote Aster agent and local OWS API key have been cleaned up. Retry: perp wallet agent approve aster`,
      });
    }

    // Partial state — at least one cleanup failed. Save partial record for recovery.
    const failedSteps: string[] = [];
    if (!deleteOk) failedSteps.push("Aster DELETE /fapi/v3/agent");
    if (!revokeOk) failedSteps.push("OWS revokeApiKey");

    try {
      setAgent("aster", {
        agentName,
        agentWalletName: agentWalletName ?? "",
        agentEvmAddress: agentEvmAddress!,
        userEvmAddress,
        masterWalletName: masterName,
        owsApiKeyId: owsApiKeyId ?? "",
        owsPolicyId: owsPolicyId ?? "",
        expiresAt: expiresAtIso,
        approvedAt: nowIso,
        permissions: { canPerpTrade: canPerp, canSpotTrade: canSpot, canWithdraw },
        asterApprovalNonce: String(nonceMicros),
        status: "partial",
      });
    } catch { /* best effort — already in a bad state */ }

    throw new PerpError("APPROVE_PARTIAL", `Agent registered on Aster but persist+cleanup failed. Failed steps: ${failedSteps.join(", ")}. Persist error: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`, {
      remediation: `Aster agent address: ${agentEvmAddress}. Run: perp wallet agent approve aster --rotate to re-register`,
    });
  }

  return {
    agentAddress: agentEvmAddress,
    agentName,
    expiresAt: expiresAtIso,
    owsApiKeyId,
    policyId: owsPolicyId,
    asterApprovalNonce: String(nonceMicros),
    userEvmAddress,
  };
}

/**
 * Parse an expires-in string to a Date.
 * Accepts: "30d", "90d", "180d", "1y", or any ISO-8601 datetime string.
 * Throws if malformed.
 */
function parseExpiresIn(value: string): Date {
  const v = value.trim();
  // Match Nd (days) or Ny (years)
  const daysMatch = v.match(/^(\d+)d$/i);
  if (daysMatch) {
    const days = parseInt(daysMatch[1], 10);
    return new Date(Date.now() + days * 24 * 3600 * 1000);
  }
  const yearsMatch = v.match(/^(\d+)y$/i);
  if (yearsMatch) {
    const years = parseInt(yearsMatch[1], 10);
    return new Date(Date.now() + years * 365 * 24 * 3600 * 1000);
  }
  // Try ISO-8601
  const d = new Date(v);
  if (!isNaN(d.getTime())) {
    return d;
  }
  throw new PerpError("INVALID_PARAMS", `Invalid expires-in value: "${v}". Use: 30d, 90d, 180d, 1y, or ISO-8601 datetime`, {
    remediation: "Use: 30d, 90d, 180d, 1y, or ISO-8601 datetime",
  });
}

// ── Hyperliquid agent approve/revoke helpers (Phase 2b) ──────────────────────

/** EIP-712 domain for HL user-signed actions (chainId 42161 = Arbitrum) */
const HL_USER_SIGNED_DOMAIN = {
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId: 42161,
  verifyingContract: "0x0000000000000000000000000000000000000000" as const,
};

/** EIP-712 types for HyperliquidTransaction:ApproveAgent */
const HL_APPROVE_AGENT_TYPES = {
  "HyperliquidTransaction:ApproveAgent": [
    { name: "hyperliquidChain", type: "string" },
    { name: "agentAddress", type: "address" },
    { name: "agentName", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

interface HlApproveFlowOpts {
  masterName: string;
  passphrase: string;
  agentName: string;
  expiresAt: Date;
  expiresAtIso: string;
  nowIso: string;
  canPerp: boolean;
  canSpot: boolean;
  canWithdraw: boolean;
}

interface HlApproveFlowResult {
  agentAddress: `0x${string}`;
  agentName: string;
  expiresAt: string;
  userEvmAddress: `0x${string}`;
}

/**
 * Core HL approve flow.
 * Caller MUST hold the "hyperliquid" lock before calling this function.
 *
 * Steps:
 *  1. Resolve master via OwsEvmSigner.create
 *  2. Generate agent OWS wallet (eip155-only, name `agent-hl-<masterName>`)
 *  3. Build HL approveAgent action + EIP-712 message
 *  4. Master signs EIP-712 (user-signed domain, chainId 42161)
 *  5. POST https://api.hyperliquid.xyz/exchange
 *  6. On success: persist AgentMeta to settings.agents.hyperliquid[name]
 */
async function runHlApproveFlow(opts: HlApproveFlowOpts): Promise<HlApproveFlowResult> {
  const { masterName, passphrase, agentName, expiresAtIso, nowIso, canPerp, canSpot, canWithdraw } = opts;

  const { ethers } = await import("ethers");

  // Step 1: Resolve master signer
  const masterSigner = OwsEvmSigner.create(masterName, passphrase);
  const userEvmAddress = masterSigner.getAddress() as `0x${string}`;

  // Step 2: Generate agent OWS wallet
  const ows = loadOws();
  const agentWalletName = `agent-hl-${masterName}`;
  // HL agent wallet created with empty passphrase. This is intentional:
  // (1) Tier 1 hot-path must be prompt-free (P1 from agent_first_design.md).
  // (2) OWS provides at-rest encryption regardless of per-wallet passphrase.
  // (3) Agent blast-radius is limited (perp-only, no withdraw, no master ops).
  // At runtime, src/index.ts opens this wallet with "" matching the create-time empty.
  const agentWallet = ows.createWallet(agentWalletName, "");
  const agentEvmAccount = agentWallet.accounts.find(
    (a: { chainId: string }) => a.chainId.startsWith("eip155:"),
  );
  if (!agentEvmAccount) {
    throw new PerpError("INVALID_PARAMS", `Agent wallet "${agentWalletName}" has no EVM account`, {
      remediation: "Check OWS vault configuration",
    });
  }
  const agentEvmAddress = agentEvmAccount.address as `0x${string}`;

  // Step 3: Build nonce (monotonic ms)
  const now = Date.now();
  const nonce = now;
  const sigChainIdHex = "0xa4b1"; // 42161 hex

  const action: Record<string, unknown> = {
    type: "approveAgent",
    hyperliquidChain: "Mainnet",
    signatureChainId: sigChainIdHex,
    agentAddress: agentEvmAddress,
    agentName,
    nonce,
  };

  // Step 4: Master signs EIP-712 (user-signed domain)
  const message = {
    hyperliquidChain: "Mainnet",
    agentAddress: agentEvmAddress,
    agentName,
    nonce,
  };

  const sigRaw = await masterSigner.signTypedData(
    HL_USER_SIGNED_DOMAIN as unknown as Record<string, unknown>,
    HL_APPROVE_AGENT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    message,
  );

  const parsed = ethers.Signature.from(sigRaw);
  const signature = { r: parsed.r, s: parsed.s, v: parsed.v };

  // Step 5: POST /exchange
  const baseUrl = "https://api.hyperliquid.xyz";
  const payload = { action, nonce, signature, vaultAddress: null };

  const agentRes = await fetch(`${baseUrl}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await agentRes.text();
  let resp: Record<string, unknown>;
  try {
    resp = JSON.parse(text);
  } catch {
    // Pre-venue parse failure — Hyperliquid did NOT register the agent.
    // Roll back the orphan local OWS wallet so retry doesn't collide with
    // "wallet name already exists". Errors during cleanup must NOT mask the
    // original network/parse error (SSOT Rule #2).
    const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
    throw new PerpError("EXCHANGE_ERROR", `HL exchange API parse error (${agentRes.status}): ${text.slice(0, 200)}`, {
      remediation: buildPreVenueRemediation({
        cleanupOk, dex: "hyperliquid", masterName, agentAddress: agentEvmAddress,
        hint: "Check Hyperliquid API status",
      }),
    });
  }
  if (resp?.status === "err") {
    // Pre-venue rejection — Hyperliquid did NOT register the agent. Roll
    // back the orphan local OWS wallet so retry can proceed cleanly.
    const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
    throw new PerpError("APPROVE_PARTIAL", `HL approveAgent failed: ${typeof resp.response === "string" ? resp.response : JSON.stringify(resp)}`, {
      remediation: buildPreVenueRemediation({
        cleanupOk, dex: "hyperliquid", masterName, agentAddress: agentEvmAddress,
      }),
    });
  }

  // Step 6: Persist
  setAgent("hyperliquid", {
    agentName,
    agentWalletName,
    agentEvmAddress,
    userEvmAddress,
    masterWalletName: masterName,
    owsApiKeyId: "",        // HL has no OWS API key model
    owsPolicyId: "",        // HL has no OWS Policy model
    expiresAt: expiresAtIso,
    approvedAt: nowIso,
    permissions: { canPerpTrade: canPerp, canSpotTrade: canSpot, canWithdraw },
    asterApprovalNonce: String(nonce),  // reused field: stores HL nonce for diagnostics
    status: "active",
  });

  return { agentAddress: agentEvmAddress, agentName, expiresAt: expiresAtIso, userEvmAddress };
}

/**
 * Post a HL revoke action for the given agent.
 * Uses approveAgent with agentAddress set to the zero address (empty = revoke).
 * Per HL convention: sending approveAgent with an empty/zero agentAddress
 * clears the agent slot.
 */
async function revokeHlAgent(masterSigner: OwsEvmSigner): Promise<void> {
  const { ethers } = await import("ethers");

  const nonce = Date.now();
  const sigChainIdHex = "0xa4b1";

  // Zero-address revoke: approveAgent with empty agentAddress (validUntil:0 convention)
  const revokeAddress = "0x0000000000000000000000000000000000000000" as const;
  const action: Record<string, unknown> = {
    type: "approveAgent",
    hyperliquidChain: "Mainnet",
    signatureChainId: sigChainIdHex,
    agentAddress: revokeAddress,
    agentName: "",
    nonce,
  };

  const message = {
    hyperliquidChain: "Mainnet",
    agentAddress: revokeAddress,
    agentName: "",
    nonce,
  };

  const sigRaw = await masterSigner.signTypedData(
    HL_USER_SIGNED_DOMAIN as unknown as Record<string, unknown>,
    HL_APPROVE_AGENT_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    message,
  );

  const parsed = ethers.Signature.from(sigRaw);
  const signature = { r: parsed.r, s: parsed.s, v: parsed.v };

  const payload = { action, nonce, signature, vaultAddress: null };
  await fetch("https://api.hyperliquid.xyz/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  // Revoke is best-effort — don't throw on HTTP errors
}

// ── HL userSetAbstraction (account-mode write) helper ────────────────────────

/** EIP-712 types for HyperliquidTransaction:UserSetAbstraction */
const HL_USER_SET_ABSTRACTION_TYPES = {
  "HyperliquidTransaction:UserSetAbstraction": [
    { name: "hyperliquidChain", type: "string" },
    { name: "abstraction", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** Public abstraction modes (CLI surface) → HL on-wire string. */
const HL_ABSTRACTION_TO_WIRE = {
  unified: "unifiedAccount",
  standard: "disabled",
  portfolio: "portfolioMargin",
} as const;

export type HlAbstractionMode = keyof typeof HL_ABSTRACTION_TO_WIRE;

interface HlSetAbstractionFlowOpts {
  masterName: string;
  passphrase: string;
  mode: HlAbstractionMode;
  isTestnet: boolean;
}

interface HlSetAbstractionFlowResult {
  mode: HlAbstractionMode;
  abstraction: string;
  hyperliquidChain: "Mainnet" | "Testnet";
  nonce: number;
  userEvmAddress: `0x${string}`;
  response: Record<string, unknown>;
}

/**
 * Send a Hyperliquid `userSetAbstraction` action.
 *
 * Reuses the same EIP-712 user-signed domain (`HyperliquidSignTransaction`,
 * chainId 42161) and `OwsEvmSigner.signTypedData` plumbing as
 * `runHlApproveFlow`; the only differences are the type struct
 * (`UserSetAbstraction` vs `ApproveAgent`) and the action payload.
 *
 * Throws `PerpError` with structured remediation on signature/network/venue
 * failure (Rule #2: no fallback, no silent retry).
 */
export async function runHlSetAbstractionFlow(
  opts: HlSetAbstractionFlowOpts,
): Promise<HlSetAbstractionFlowResult> {
  const { masterName, passphrase, mode, isTestnet } = opts;
  const { ethers } = await import("ethers");

  const masterSigner = OwsEvmSigner.create(masterName, passphrase);
  const userEvmAddress = masterSigner.getAddress() as `0x${string}`;

  const hyperliquidChain = (isTestnet ? "Testnet" : "Mainnet") as "Mainnet" | "Testnet";
  const sigChainIdHex = "0xa4b1"; // 42161 hex
  const abstraction = HL_ABSTRACTION_TO_WIRE[mode];
  const nonce = Date.now();

  const action = {
    type: "userSetAbstraction",
    hyperliquidChain,
    signatureChainId: sigChainIdHex,
    user: userEvmAddress,
    abstraction,
    nonce,
  } as Record<string, unknown>;

  const message = {
    hyperliquidChain,
    abstraction,
    nonce,
  };

  let sigRaw: string;
  try {
    sigRaw = await masterSigner.signTypedData(
      HL_USER_SIGNED_DOMAIN as unknown as Record<string, unknown>,
      HL_USER_SET_ABSTRACTION_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
      message,
    );
  } catch (sigErr) {
    throw new PerpError("SIGNATURE_FAILED", `HL userSetAbstraction signing failed: ${sigErr instanceof Error ? sigErr.message : String(sigErr)}`, {
      remediation: "Confirm OWS master is unlocked and passphrase is correct.",
    });
  }
  const parsed = ethers.Signature.from(sigRaw);
  const signature = { r: parsed.r, s: parsed.s, v: parsed.v };

  const baseUrl = isTestnet ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz";
  const payload = { action, nonce, signature, vaultAddress: null };

  const res = await fetch(`${baseUrl}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let resp: Record<string, unknown>;
  try {
    resp = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new PerpError("EXCHANGE_ERROR", `HL exchange API parse error (${res.status}): ${text.slice(0, 200)}`, {
      remediation: "Check Hyperliquid API status. Retry: perp wallet manage account-mode <mode>",
    });
  }
  if (resp?.status === "err") {
    throw new PerpError("EXCHANGE_ERROR", `HL userSetAbstraction failed: ${typeof resp.response === "string" ? resp.response : JSON.stringify(resp)}`, {
      remediation: "Verify master EVM wallet is the account owner. Retry: perp wallet manage account-mode <mode>",
    });
  }

  return {
    mode,
    abstraction,
    hyperliquidChain,
    nonce,
    userEvmAddress,
    response: resp,
  };
}

// ── Pacifica agent approve/revoke helpers (Phase 2c) ─────────────────────────

interface PacApproveFlowOpts {
  masterName: string;
  passphrase: string;
  agentName: string;
  expiresAt: Date;
  expiresAtIso: string;
  nowIso: string;
  canPerp: boolean;
  canSpot: boolean;
  canWithdraw: boolean;
}

interface PacApproveFlowResult {
  agentSolanaAddress: string;
  userSolanaAddress: string;
  agentName: string;
  expiresAt: string;
}

/**
 * Core Pacifica approve flow.
 * Caller MUST hold the "pacifica" lock before calling this function.
 *
 * Steps:
 *  1. Resolve master via OwsSolanaSigner.create
 *  2. Generate agent OWS wallet (`agent-pac-<masterName>`) with empty passphrase
 *  3. Build canonical bind_agent_wallet message + master Ed25519 signature
 *  4. POST https://api.pacifica.fi/api/v1/agent/bind
 *  5. On success: persist AgentMeta to settings.agents.pacifica[name]
 *  6. On failure: rollback agent OWS wallet + emit APPROVE_PARTIAL/APPROVE_FAILED
 *
 * Off-chain auth — no on-chain transaction, no gas required.
 */
async function runPacApproveFlow(opts: PacApproveFlowOpts): Promise<PacApproveFlowResult> {
  const {
    masterName, passphrase, agentName, expiresAtIso, nowIso,
    canPerp, canSpot, canWithdraw,
  } = opts;

  const { buildBindAgentMessage } = await import("../exchanges/pacifica-typed-data.js");

  // Step 1: Resolve master Solana signer
  const masterSigner = OwsSolanaSigner.create(masterName, passphrase);
  const userSolanaAddress = masterSigner.getPublicKeyBase58();

  // Step 2: Generate agent OWS wallet (empty passphrase mirrors HL pattern;
  // the runtime opens with "" so the hot-path is prompt-free).
  const ows = loadOws();
  const agentWalletName = `agent-pac-${masterName}`;
  const agentWallet = ows.createWallet(agentWalletName, "");
  const agentSolAccount = agentWallet.accounts.find(
    (a: { chainId: string }) => a.chainId.startsWith("solana:"),
  );
  if (!agentSolAccount) {
    throw new PerpError("INVALID_PARAMS", `Agent wallet "${agentWalletName}" has no Solana account`, {
      remediation: "Check OWS vault configuration",
    });
  }
  const agentSolanaAddress: string = agentSolAccount.address;

  // Step 3: Build canonical bind_agent_wallet payload + Ed25519 signature
  const bind = buildBindAgentMessage({
    account: userSolanaAddress,
    agentWallet: agentSolanaAddress,
  });
  const msgBytes = new TextEncoder().encode(bind.canonicalJson);
  const sigBytes = await masterSigner.signMessage(msgBytes);
  const signature = bs58.encode(sigBytes);

  // Step 4: POST /api/v1/agent/bind
  // FIXME(2c-spike): unverified — confirm against live mainnet. Pacifica's
  // public API documentation does not enumerate `agent/bind` explicitly; the
  // shape below mirrors `buildSignedRequest()` (account+signature+timestamp+
  // expiry_window+payload-flattened) which IS the documented Pacifica REST
  // signing pattern. See HypurrQuant_FE PacificaPerpAdapter.ts for the
  // production reference once available.
  const requestBody: Record<string, unknown> = {
    account: userSolanaAddress,
    signature,
    timestamp: bind.header.timestamp,
    expiry_window: bind.header.expiry_window,
    type: bind.header.type,
    ...bind.payload, // adds agent_wallet
  };

  let pacPostSucceeded = false;
  let resp: Record<string, unknown> | undefined;
  try {
    const httpRes = await fetch("https://api.pacifica.fi/api/v1/agent/bind", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    if (httpRes.ok) {
      resp = await httpRes.json() as Record<string, unknown>;
      // Pacifica REST envelope: success === true OR explicit data field
      if (resp.success === false || resp.error) {
        const errMsg = typeof resp.error === "string" ? resp.error : JSON.stringify(resp);
        // Pre-venue rejection — Pacifica did NOT register the agent.
        const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
        throw new PerpError("APPROVE_PARTIAL", `Pacifica bind_agent_wallet failed: ${errMsg}`, {
          remediation: buildPreVenueRemediation({
            cleanupOk, dex: "pacifica", masterName, agentAddress: agentSolanaAddress,
          }),
        });
      }
      pacPostSucceeded = true;
    } else {
      const errText = await httpRes.text().catch(() => "");
      // Pre-venue rejection — Pacifica did NOT register the agent.
      const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
      throw new PerpError("APPROVE_PARTIAL", `Pacifica bind_agent_wallet failed (${httpRes.status}): ${errText.slice(0, 200)}`, {
        remediation: buildPreVenueRemediation({
          cleanupOk, dex: "pacifica", masterName, agentAddress: agentSolanaAddress,
        }),
      });
    }
  } catch (httpErr) {
    if (httpErr instanceof PerpError) throw httpErr;
    // Network-level failure — Pacifica did NOT register the agent.
    const cleanupOk = tryDeleteOrphanWallet(ows, agentWalletName);
    throw new PerpError("APPROVE_PARTIAL", `Pacifica bind_agent_wallet network error: ${httpErr instanceof Error ? httpErr.message : String(httpErr)}`, {
      remediation: buildPreVenueRemediation({
        cleanupOk, dex: "pacifica", masterName, agentAddress: agentSolanaAddress,
      }),
    });
  }

  // Step 5: Persist
  // PAC has no OWS API key/Policy model — leave those as empty strings.
  // agentEvmAddress is set to the zero address; the canonical address lives
  // in agentSolanaAddress.
  try {
    setAgent("pacifica", {
      agentName,
      agentWalletName,
      agentEvmAddress: "0x0000000000000000000000000000000000000000",
      userEvmAddress: "0x0000000000000000000000000000000000000000",
      agentSolanaAddress,
      userSolanaAddress,
      masterWalletName: masterName,
      owsApiKeyId: "",
      owsPolicyId: "",
      expiresAt: expiresAtIso,
      approvedAt: nowIso,
      permissions: { canPerpTrade: canPerp, canSpotTrade: canSpot, canWithdraw },
      asterApprovalNonce: String(bind.header.timestamp),
      status: "active",
    });
  } catch (persistErr) {
    // Settings persist failed AFTER Pacifica registration succeeded.
    // Best-effort revoke + APPROVE_PARTIAL.
    if (pacPostSucceeded) {
      try {
        await revokePacAgent(masterSigner, agentSolanaAddress);
      } catch { /* best effort */ }
    }
    throw new PerpError("APPROVE_PARTIAL", `Pacifica agent registered but persist failed: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`, {
      remediation: `Pacifica agent address: ${agentSolanaAddress}. Run: perp wallet agent approve pacifica --rotate to re-register.`,
    });
  }

  return {
    agentSolanaAddress,
    userSolanaAddress,
    agentName,
    expiresAt: expiresAtIso,
  };
}

/**
 * Revoke a Pacifica agent wallet.
 *
 * Endpoint + operation type follow the official Pacifica SDK
 * (`rest/api_agent_keys_detailed.py`): `revoke_agent_wallet` → POST
 * /agent/revoke, and `revoke_all_agent_wallets` → POST /agent/revoke_all when
 * no specific agent address is known.
 *
 * Rule #2: this THROWS on a rejected revoke. It previously POSTed an
 * `unbind_agent_wallet` type to /agent/bind — neither of which Pacifica
 * exposes — and discarded the response entirely, so a refused revoke was
 * reported to the user as success while the agent key stayed authorized to
 * trade. Callers that genuinely want best-effort must catch explicitly.
 */
async function revokePacAgent(masterSigner: OwsSolanaSigner, agentSolanaAddress: string): Promise<void> {
  const { buildRevokeAgentMessage, buildRevokeAllAgentsMessage } = await import("../exchanges/pacifica-typed-data.js");
  const userSolanaAddress = masterSigner.getPublicKeyBase58();

  const revokeAll = !agentSolanaAddress;
  const built = revokeAll
    ? buildRevokeAllAgentsMessage({ account: userSolanaAddress })
    : buildRevokeAgentMessage({ account: userSolanaAddress, agentWallet: agentSolanaAddress });
  const path = revokeAll ? "/agent/revoke_all" : "/agent/revoke";

  const msgBytes = new TextEncoder().encode(built.canonicalJson);
  const sigBytes = await masterSigner.signMessage(msgBytes);
  const signature = bs58.encode(sigBytes);

  const requestBody: Record<string, unknown> = {
    account: userSolanaAddress,
    signature,
    timestamp: built.header.timestamp,
    expiry_window: built.header.expiry_window,
    type: built.header.type,
    ...built.payload,
  };

  const res = await fetch(`https://api.pacifica.fi/api/v1${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new PerpError("APPROVE_FAILED", `Pacifica revoke failed (${res.status}): ${text.slice(0, 200)}`, {
      exchange: "pacifica",
      remediation: `The agent key may still be authorized to trade. Retry, or revoke it from the Pacifica UI. Agent: ${agentSolanaAddress || "(all)"}`,
    });
  }
  // Pacifica wraps REST results in `{ success, error, data }` — a 200 with
  // success:false is still a refusal, so check the envelope, not just the code.
  try {
    const parsed = JSON.parse(text) as { success?: boolean; error?: unknown };
    if (parsed && parsed.success === false) {
      throw new PerpError("APPROVE_FAILED", `Pacifica revoke rejected: ${JSON.stringify(parsed.error ?? parsed)}`, {
        exchange: "pacifica",
        remediation: `The agent key may still be authorized to trade. Retry, or revoke it from the Pacifica UI. Agent: ${agentSolanaAddress || "(all)"}`,
      });
    }
  } catch (e) {
    if (e instanceof PerpError) throw e;
    // Non-JSON 2xx body: the venue accepted it. Nothing to assert.
  }
}

// ── Lighter agent approve/revoke helpers (Phase 2d) ──────────────────────────

interface LtApproveFlowOpts {
  masterName: string;
  passphrase: string;
  agentName: string;
  expiresAt: Date;
  expiresAtIso: string;
  nowIso: string;
  canPerp: boolean;
  canSpot: boolean;
  canWithdraw: boolean;
  /** Optional explicit slot (4-254). When omitted, picks max+1 from settings. */
  apiKeyIndex?: number;
}

interface LtApproveFlowResult {
  apiKeyIndex: number;
  publicKey: string;
  accountIndex: number;
  agentName: string;
  expiresAt: string;
  userEvmAddress: `0x${string}`;
}

/**
 * Pick the next free Lighter slot in [4, 254].
 *
 * Strategy: scan settings.agents.lighter; pick `max(usedSlots) + 1` capped to
 * 254. If none used, default to 4. If 4 itself is used (env-driven auto-setup
 * default), advance to next.
 */
function pickNextFreeLtSlot(settings: ReturnType<typeof loadSettings>): number {
  const ltMap = settings.agents?.lighter ?? {};
  const used = new Set<number>();
  for (const meta of Object.values(ltMap)) {
    if (typeof meta.apiKeyIndex === "number") used.add(meta.apiKeyIndex);
  }
  // Slot 4 is the default Lighter env-key auto-setup index — treat as used so
  // agent-managed slots don't collide with the env-driven legacy path.
  used.add(4);
  for (let i = 5; i <= 254; i++) {
    if (!used.has(i)) return i;
  }
  throw new PerpError("INVALID_PARAMS", "All Lighter slots [4, 254] are in use", {
    remediation: "Revoke an existing agent: perp wallet agent revoke lighter <name>",
  });
}

/**
 * Core Lighter approve flow.
 * Caller MUST hold the "lighter" lock before calling this function.
 *
 * Steps:
 *  1. Resolve master via OwsEvmSigner.create
 *  2. Pick free slot in [4, 254] (or use explicit apiKeyIndex when supplied)
 *  3. Spin up a temporary LighterAdapter bound to the master signer; init() to
 *     resolve accountIndex from L1 EVM address
 *  4. Call LighterAdapter.setupApiKey(slot) — generates secp256k1 keypair via
 *     WASM generateAPIKey, signs L1 EIP-712 + L2 ChangePubKey, POSTs sendTx
 *  5. On success: create agent OWS wallet (empty passphrase) to securely store
 *     the agent secp256k1 private key for hot-path reload at trade time
 *  6. Persist AgentMeta with apiKeyIndex/publicKey/accountIndex to settings
 *  7. On failure: emit APPROVE_PARTIAL/APPROVE_FAILED. Lighter has no on-chain
 *     rollback — the slot stays orphaned on the L2 server until overwritten.
 *
 * Off-chain auth — no on-chain BNB/ETH gas required.
 */
async function runLtApproveFlow(opts: LtApproveFlowOpts): Promise<LtApproveFlowResult> {
  const {
    masterName, passphrase, agentName, expiresAtIso, nowIso,
    canPerp, canSpot, canWithdraw, apiKeyIndex: explicitSlot,
  } = opts;

  const { LighterAdapter } = await import("../exchanges/lighter.js");

  // Step 1: Resolve master EVM signer (Lighter L1 ChangePubKey is EVM EIP-712 + EIP-191).
  const masterSigner = OwsEvmSigner.create(masterName, passphrase);
  const userEvmAddress = masterSigner.getAddress() as `0x${string}`;

  // Step 2: Pick slot.
  const settings = loadSettings();
  let chosenSlot: number;
  if (explicitSlot !== undefined) {
    // Validate range (defensive — caller should have already checked, but the
    // helper is also used from rotate where no validation runs upstream).
    if (!Number.isInteger(explicitSlot) || explicitSlot < 4 || explicitSlot > 254) {
      throw new PerpError("INVALID_PARAMS", `apiKeyIndex must be an integer in [4, 254]; got ${explicitSlot}`, {
        remediation: "Slots 0-3 are reserved by the Lighter frontend.",
      });
    }
    chosenSlot = explicitSlot;
  } else {
    chosenSlot = pickNextFreeLtSlot(settings);
  }

  // Step 3: Spin up a LighterAdapter bound to the master EVM signer.
  // Constructor takes evmKey (empty since we'll inject signer); init() resolves
  // accountIndex from the L1 EVM address via REST.
  const adapter = new LighterAdapter("", false);
  adapter.setSigner(masterSigner);
  await adapter.init();

  if (adapter.accountIndex < 0) {
    throw new PerpError("INVALID_PARAMS", `No Lighter account found for master EVM address ${userEvmAddress}`, {
      remediation: "Deposit USDC to the master address on Lighter to create an account, then retry.",
    });
  }

  // Step 4: Generate keypair + ChangePubKey via existing production infra.
  // setupApiKey already does:
  //   - generateAPIKey() (WASM)
  //   - createClient with new key
  //   - signChangePubKey
  //   - signMessage(messageToSign) via EVM signer (EIP-191)
  //   - append L1Sig to txInfo
  //   - POST /api/v1/sendTx with retry on invalid-nonce
  let registered: { privateKey: string; publicKey: string };
  try {
    registered = await adapter.setupApiKey(chosenSlot);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new PerpError("APPROVE_PARTIAL", `Lighter ChangePubKey failed: ${msg}`, {
      remediation: `Slot ${chosenSlot} for cleanup: this slot may be partially registered on the L2 server. Retry with a different --api-key-index, or rotate.`,
    });
  }

  // Step 5: Persist the agent's 40-byte L2 private key (SSOT Rule #3 —
  // encrypted at-rest in `~/.perp/lighter-agents/<accountIndex>-<slot>.json`).
  //
  // Lighter's L2 secp256k1 key is a non-OWS-native curve, so it cannot live in
  // `~/.ows/wallets/`. The keystore module mirrors OWS's AES-256-GCM + scrypt
  // scheme and uses an empty passphrase — same threat model as HL/PAC agents
  // (file mode 0600 + obfuscation, NOT cryptographic strength against a local
  // attacker). `accountIndex` and `apiKeyIndex` already live in
  // settings.agents.lighter[name], so they don't need to be duplicated in env.
  const agentWalletName = `agent-lt-${masterName}`;
  void agentWalletName; // wallet bookkeeping only — not used to derive the L2 key
  const { saveLighterKey } = await import("../agent-wallet/lighter-keystore.js");
  saveLighterKey(adapter.accountIndex, chosenSlot, registered.privateKey, "");

  // Step 6: Persist
  try {
    setAgent("lighter", {
      agentName,
      agentWalletName,
      // Lighter agent's identity on the L2 is publicKey + apiKeyIndex.
      // We store the master EVM address as agentEvmAddress for diagnostic
      // continuity (Aster/HL strict typing); the agent's real identity is
      // captured in the new optional fields.
      agentEvmAddress: userEvmAddress,
      userEvmAddress,
      apiKeyIndex: chosenSlot,
      publicKey: registered.publicKey.replace(/^0x/, ""),
      accountIndex: adapter.accountIndex,
      masterWalletName: masterName,
      owsApiKeyId: "",        // Lighter has no OWS API key model
      owsPolicyId: "",        // Lighter has no OWS Policy model
      expiresAt: expiresAtIso,
      approvedAt: nowIso,
      permissions: { canPerpTrade: canPerp, canSpotTrade: canSpot, canWithdraw },
      asterApprovalNonce: String(Date.now()),  // reused field: not used by LT
      status: "active",
    });
  } catch (persistErr) {
    throw new PerpError("APPROVE_PARTIAL", `Lighter ChangePubKey succeeded but persist failed: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`, {
      remediation: `Lighter slot ${chosenSlot} is registered on the L2 server. Manually update settings.agents.lighter or re-run: perp wallet agent approve lighter --api-key-index <other slot>.`,
    });
  }

  return {
    apiKeyIndex: chosenSlot,
    publicKey: registered.publicKey.replace(/^0x/, ""),
    accountIndex: adapter.accountIndex,
    agentName,
    expiresAt: expiresAtIso,
    userEvmAddress,
  };
}

/**
 * Revoke a Lighter agent (local-only, idempotent).
 *
 * Lighter's L2 has no on-chain revoke action — slots persist on the server
 * until overwritten by a fresh ChangePubKey at the same index. This helper
 * is a no-op stub that exists for symmetry with the other DEX revoke helpers
 * (revokeHlAgent, revokePacAgent) so the dispatch reads consistently. Caller
 * is responsible for `deleteAgent("lighter", name)` to clear local state.
 */
async function revokeLtAgent(): Promise<void> {
  // No-op. See AC-35: Lighter revoke is local-only.
  return;
}
