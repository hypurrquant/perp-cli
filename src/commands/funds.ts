import { Command } from "commander";
import { isDryRun as dryRunFlag, supportsDryRun } from "../cli-flags.js";
import chalk from "chalk";
import { printJson, formatUsd, jsonOk, jsonError } from "../utils.js";
import type { ExchangeAdapter } from "../exchanges/index.js";
import type { Network } from "../pacifica/index.js";
import { logExecution } from "../execution-log.js";
import { hasPacificaSdk, hasEvmAddress, isWithdrawCapable, isUsdTransferCapable, hasLighterAccount } from "../exchanges/capabilities.js";
import { registerFundsBridgeCommands } from "./bridge.js";
import { registerFundsRebalanceCommands } from "./rebalance.js";
import { PerpError, isConnectFailure, isDefiniteOrderFailure, isTransportFailure, orderOutcomeUnknown, parsePositiveDecimal } from "../errors.js";
import { cliCredentialOptsFrom, requireMasterWallet } from "../config.js";
import type { VenueId } from "../exchanges/venue-types.js";
import { getVenue, requireCapabilities, roleUnsupported, READ_ONLY_CREDENTIALS, type Network as VenueNetwork, type VenueDefinition } from "../exchanges/venue.js";
import { RISEX_APP_URL, RISEX_FUNDS_APP_ONLY } from "../exchanges/venues/risex.js";
import { VARIATIONAL_READ_ONLY_REMEDIATION } from "../exchanges/venues/variational.js";
import { EXTENDED_READ_ONLY_REMEDIATION } from "../exchanges/venues/extended.js";
import { unsupported } from "../exchanges/trading-v2.js";
import { registerOnchainFundsCommands } from "./funds-onchain.js";
import { QFEX_BANKER_NETWORK, QFEX_WITHDRAW_DISABLED, QFEX_WITHDRAW_ENABLED, QFEX_WITHDRAW_NETWORK } from "../exchanges/venues/qfex.js";
import type { QfexAdapter } from "../exchanges/qfex/adapter.js";
import { loadSettings } from "../settings.js";
import { assertWithdrawAllowed, forgetWithdrawAttempt, recordWithdrawAttempt } from "../withdraw-gate.js";
import "../exchanges/venues/index.js";

/**
 * Execution-log status of a failed funds action: an unknown outcome (ORDER_PENDING — the request
 * was sent and may have executed) is logged "unverified", never "failed".
 */
export function fundsFailStatus(err: unknown): "failed" | "unverified" {
  return err instanceof PerpError && err.structured.code === "ORDER_PENDING" ? "unverified" : "failed";
}

/** `{ txHash }` of a broadcast transaction whose outcome is unknown (ORDER_PENDING details), for the execution log. */
function pendingTxMeta(err: unknown): { txHash?: string } {
  const h = err instanceof PerpError ? err.structured.details?.txHash : undefined;
  return typeof h === "string" ? { txHash: h } : {};
}

const DEFAULT_RELAYER = "http://localhost:3100";

function getRelayerUrl(): string {
  return process.env.PERP_RELAYER_URL || DEFAULT_RELAYER;
}

function relayerUnavailable(): PerpError {
  return new PerpError("EXCHANGE_UNREACHABLE", `The relayer at ${getRelayerUrl()} is not reachable; nothing was sent`, {
    remediation: "Start the relayer / set PERP_RELAYER_URL, or drop --relay for a direct deposit (you pay gas)",
  });
}

/** A broadcast deposit whose confirmation could not be read: unknown outcome, carrying the signature. */
export function depositOutcomeUnknown(signature: string, e: unknown): PerpError {
  const pending = orderOutcomeUnknown("pacifica", `deposit transaction ${signature}`, e,
    `Do NOT deposit again yet — the transaction was broadcast and may still confirm. Check signature ${signature} on a Solana explorer, then: perp -e pacifica account balance`);
  return new PerpError("ORDER_PENDING", pending.message, { exchange: "pacifica", signature, remediation: pending.structured.remediation });
}

async function relayerAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${getRelayerUrl()}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Local withdraw-gate verdict for a Hyperliquid destination that is not (known to be) the account
 * owner: settings.withdraw.hyperliquid allowlist + maxPerTx / maxPerDay (the QFEX gate mechanism,
 * src/withdraw-gate.ts). "passes" or "would refuse: …"; never throws a POLICY_DENIED (dry runs).
 */
export function hyperliquidGateVerdict(network: string, amount: string, destination: string, nowMs: number): string {
  const gate = loadSettings().withdraw.hyperliquid;
  try {
    assertWithdrawAllowed("hyperliquid", network, amount, destination, gate === undefined ? null : gate, nowMs);
  } catch (e) {
    if (e instanceof PerpError && e.structured.code === "POLICY_DENIED") return `would refuse: ${e.message}`;
    throw e;
  }
  return "passes (destination allowlisted in settings withdraw.hyperliquid, within maxPerTx / maxPerDay)";
}

/**
 * Enforce settings.withdraw.hyperliquid for a master-signed withdraw3 / usdSend to `destination`
 * and record the attempt in the withdraw ledger BEFORE it is sent. Returns the ledger id (forget it
 * only on a definite refusal), or null when the destination is the owner (no gate, no ledger).
 */
export function hyperliquidGateEnforce(network: string, amount: string, destination: string, owner: string | null, nowMs: number): string | null {
  if (owner !== null && destination.toLowerCase() === owner.toLowerCase()) return null;
  const gate = loadSettings().withdraw.hyperliquid;
  assertWithdrawAllowed("hyperliquid", network, amount, destination, gate === undefined ? null : gate, nowMs);
  return recordWithdrawAttempt("hyperliquid", network, amount, destination, nowMs);
}

/** Display names of `VenueNetworkConfig.settlementChain` / withdraw-network ids. */
const CHAIN_LABELS: Readonly<Record<string, string>> = {
  ethereum: "Ethereum",
  robinhood: "Robinhood Chain",
  arbitrum: "Arbitrum",
  solana: "Solana",
  bnb: "BNB Chain",
  hyperliquid: "Hyperliquid",
};

/** Label for a chain id. An unmapped id is a programming error (covered by a unit test over every venue). */
export function chainLabel(chain: string): string {
  const label = CHAIN_LABELS[chain];
  if (label === undefined) throw new Error(`no display label for chain "${chain}" (add it to CHAIN_LABELS)`);
  return label;
}

/** Circle forwarding fee per HL CCTP destination, from HL_CCTP_ROUTES (null = not published). */
async function hlCctpFeeText(): Promise<string> {
  const { HL_CCTP_ROUTES } = await import("../exchanges/hyperliquid.js");
  return Object.entries(HL_CCTP_ROUTES)
    .map(([chain, r]) => `${chain}: ${r.forwardingFeeUsdc === null ? "fee not published" : `${r.forwardingFeeUsdc} USDC`}`)
    .join(", ");
}

/** Withdraw asset declared by the venue definition (capabilities.withdrawAssets[0]). */
function withdrawAssetOf(def: VenueDefinition): string {
  const assets = requireCapabilities(def).withdrawAssets;
  if (assets === null || assets.length === 0) {
    throw new Error(`${def.id} declares no withdrawAssets but has a withdraw command`);
  }
  return assets[0];
}

/** Withdrawal chain of venues that settle off-chain and pay out on a public chain. */
const OFFCHAIN_WITHDRAW_CHAIN: { readonly [K in VenueId]?: string } = {
  qfex: QFEX_WITHDRAW_NETWORK,
};

/** Chain a venue's withdrawals arrive on (QFEX settles off-chain and pays out on Arbitrum). */
function withdrawChainOf(def: VenueDefinition, net: VenueNetwork): string {
  const payout = OFFCHAIN_WITHDRAW_CHAIN[def.id];
  if (payout !== undefined) return payout;
  const cfg = def.networks[net];
  if (cfg === null) {
    throw new PerpError("NOT_IMPLEMENTED", `${def.displayName} has no ${net} environment`, {
      remediation: `Run without --network testnet for ${def.id}`,
    });
  }
  return cfg.settlementChain;
}

/** "-e lighter: USDC → Ethereum; -e lighter-rh: USDG → Robinhood Chain" — from the venue definitions. */
export function lighterFamilyWithdrawSummary(): string {
  return (["lighter", "lighter-rh"] as const).map(id => {
    const def = getVenue(id);
    return `-e ${id}: ${withdrawAssetOf(def)} → ${chainLabel(def.networks.mainnet.settlementChain)}`;
  }).join("; ");
}

export function registerFundsCommands(
  program: Command,
  getAdapter: () => Promise<ExchangeAdapter>,
  isJson: () => boolean,
  getNetwork: () => Network,
  getAdapterForExchange: (exchange: string) => Promise<ExchangeAdapter>
) {
  const funds = program.command("funds").description("Fund movement — deposit, withdraw, transfer, bridge, rebalance");

  /** Global --dry-run (root flag; never re-declared on a subcommand — the root would swallow it). */
  const isDryRun = (): boolean => dryRunFlag(program);

  /**
   * Master-only fund movement: NO_SIGNER_AVAILABLE (do it on the website / import the master)
   * when no master wallet is on this machine — runs after the dry-run return, before any key or
   * adapter is loaded. An imported agent / API key never signs these.
   */
  const requireMaster = (venue: VenueId, action: string): Promise<void> =>
    requireMasterWallet(venue, cliCredentialOptsFrom(program.opts()), action);

  /**
   * Dry-run exit for a fund movement: log + print the plan (`sent: false`) and send nothing.
   * Every caller returns this BEFORE loading a key, building an adapter, or contacting a relayer.
   */
  const printFundsPlan = (plan: {
    action: "deposit" | "withdraw" | "transfer"; venue: string; network: string; asset: string; amount: string;
    [k: string]: unknown;
  }): void => {
    logExecution({
      type: "bridge", exchange: plan.venue, symbol: plan.asset, side: plan.action,
      size: plan.amount, status: "simulated", dryRun: true, meta: { ...plan },
    });
    if (isJson()) { printJson(jsonOk({ dryRun: true, sent: false, ...plan })); return; }
    console.log(chalk.yellow(`\n  [dry-run] Would ${plan.action} ${plan.amount} ${plan.asset} (${plan.venue}, ${plan.network})`));
    for (const [k, v] of Object.entries(plan)) {
      if (["action", "venue", "network", "asset", "amount"].includes(k)) continue;
      console.log(`  ${k}: ${String(v)}`);
    }
    console.log(chalk.gray("  Nothing was sent.\n"));
  };

  /**
   * Deposit routes whose chain RPC / bridge contract / token addresses are
   * mainnet deployments (hardcoded below) have no testnet equivalent: a -n
   * testnet run must fail before any key is loaded, never sign on mainnet.
   */
  const requireMainnetDepositRoute = (route: string): void => {
    const network = getNetwork();
    if (network === "mainnet") return;
    throw new PerpError("NO_BRIDGE_ROUTE", `${route} has no ${network} route — its chain RPC and contracts are mainnet deployments`, {
      remediation: "Run without -n testnet to deposit on mainnet, or fund the testnet account from the venue's testnet faucet",
    });
  };

  // ═══════════════════════════════════════════════════════
  //  DEPOSIT
  // ═══════════════════════════════════════════════════════

  const deposit = funds.command("deposit").description("Deposit funds into exchange accounts");

  // ── Pacifica (Solana) ──

  supportsDryRun(deposit.command("pacifica <amount>"))
    .description("Deposit USDC into Pacifica (supports --dry-run)")
    .option("--relay", "Opt in to the gas-sponsoring relayer (PERP_RELAYER_URL); default: direct deposit, you pay gas")
    .option("--no-relay", "Direct deposit, pay gas yourself (the default)")
    .action(async (amount: string, rawOpts: { relay?: boolean }) => {
      const opts = { relay: rawOpts.relay === true };
      const amountNum = Number(parsePositiveDecimal(amount, "amount"));
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      if (amountNum < 10) throw new Error("Minimum deposit is 10 USDC");
      if (isDryRun()) {
        return printFundsPlan({ action: "deposit", venue: "pacifica", network: getNetwork(), asset: "USDC", amount: String(amountNum), chain: "solana", method: opts.relay ? "relayer" : "direct" });
      }
      await requireMaster("pacifica", "Pacifica deposit");

      // Relayer (gas-sponsored) only when asked for with --relay; an unreachable relayer is an
      // error, never a silent switch to a direct deposit.
      if (opts.relay && !(await relayerAvailable())) throw relayerUnavailable();
      if (opts.relay) {
        if (!isJson()) console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} via relayer (gasless)...\n`));

        // The subcommand names the venue: fetch it directly, independent of -e.
        const adapter = await getAdapterForExchange("pacifica");
        if (adapter.name !== "pacifica") throw new Error("pacifica venue did not produce a Pacifica adapter");
        const { PacificaAdapter } = await import("../exchanges/pacifica.js");
        const pacAdapter = adapter as InstanceType<typeof PacificaAdapter>;

        try {
          const buildRes = await fetch(`${getRelayerUrl()}/deposit/pacifica/build`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              userPubkey: pacAdapter.masterSolanaSigner().getPublicKeyBase58(),
              amount: amountNum,
              testnet: getNetwork() === "testnet",
            }),
          });

          if (!buildRes.ok) {
            const err = await buildRes.json() as Record<string, string>;
            throw new Error(err.error || "Relayer build failed");
          }

          const built = (await buildRes.json()) as { transaction?: unknown; fee?: unknown; netAmount?: unknown; feeRecipient?: unknown };
          if (typeof built.transaction !== "string" || typeof built.fee !== "number" || typeof built.netAmount !== "number") {
            throw new PerpError("POLICY_DENIED", "The relayer's build response is missing transaction / fee / netAmount; nothing was signed", {
              remediation: "Drop --relay for a direct deposit (you pay gas)",
            });
          }
          const { transaction, fee, netAmount } = built as { transaction: string; fee: number; netAmount: number };

          if (!isJson()) {
            console.log(`  Fee:       $${formatUsd(fee)} (gas sponsored)`);
            console.log(`  Net:       $${formatUsd(netAmount)} to Pacifica\n`);
          }

          const { Transaction } = await import("@solana/web3.js");
          const { signSolanaTransaction } = await import("../pacifica/sign-tx.js");
          const tx = Transaction.from(Buffer.from(transaction, "base64"));
          // Never blind-sign a relayer-built transaction with the master key: it must be exactly the
          // pinned Pacifica deposit (+ compute budget, + the declared, capped fee transfer) — else refuse.
          const { assertRelayedDepositTransaction } = await import("../pacifica/deposit.js");
          const { PublicKey: SolPublicKey } = await import("@solana/web3.js");
          await assertRelayedDepositTransaction(tx, {
            user: new SolPublicKey(pacAdapter.masterSolanaSigner().getPublicKeyBase58()),
            requestedAmount: amount.trim(), network: getNetwork(),
            declared: { fee, netAmount, feeRecipient: typeof built.feeRecipient === "string" ? built.feeRecipient : null },
          });
          // The relayer pays the fee and adds its signature after ours.
          signSolanaTransaction(pacAdapter.masterSolanaSigner(), tx, true);
          const signed = tx.serialize().toString("base64");

          const submitRes = await fetch(`${getRelayerUrl()}/deposit/pacifica/submit`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              signedTransaction: signed,
              testnet: getNetwork() === "testnet",
            }),
          });

          if (!submitRes.ok) {
            const err = await submitRes.json() as Record<string, string>;
            throw new Error(err.error || "Submit failed");
          }

          const result = (await submitRes.json()) as { signature: string };

          logExecution({
            type: "bridge", exchange: "pacifica", symbol: "USDC", side: "deposit",
            size: String(amountNum), status: "success", dryRun: false,
            meta: { action: "deposit", method: "relay", signature: result.signature },
          });

          if (isJson()) return printJson(jsonOk({ ...result, fee, netAmount, method: "relay" }));
          console.log(chalk.green(`  Deposit confirmed!`));
          console.log(`  Signature: ${result.signature}`);
          console.log(chalk.gray(`\n  Gas: FREE (relayer sponsored)\n`));
          return;
        } catch (err) {
          logExecution({
            type: "bridge", exchange: "pacifica", symbol: "USDC", side: "deposit",
            size: String(amountNum), status: fundsFailStatus(err), dryRun: false,
            error: err instanceof Error ? err.message : String(err),
            meta: { action: "deposit", method: "relay" },
          });
          throw err;
        }
      }

      // Fallback: direct deposit (user pays gas)
      if (!isJson()) {
        console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} USDC into Pacifica...\n`));
        console.log(chalk.gray("  Requires: SOL for gas (~0.005 SOL) + USDC on Solana\n"));
      }

      // The subcommand names the venue: fetch it directly, independent of -e.
      const adapter = await getAdapterForExchange("pacifica");
      if (adapter.name !== "pacifica") throw new Error("pacifica venue did not produce a Pacifica adapter");
      const { PacificaAdapter: PacAdapterCls } = await import("../exchanges/pacifica.js");
      const pacDirect = adapter as InstanceType<typeof PacAdapterCls>;

      try {
        const { Connection, Transaction } = await import("@solana/web3.js");
        const { buildDepositInstruction } = await import("../pacifica/deposit.js");
        const network = getNetwork();
        const rpcUrl = network === "testnet" ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com";
        const connection = new Connection(rpcUrl, "confirmed");

        const { PublicKey } = await import("@solana/web3.js");
        const { getNetworkConfig } = await import("../pacifica/constants.js");
        const { signSolanaTransaction } = await import("../pacifica/sign-tx.js");
        const masterSigner = pacDirect.masterSolanaSigner();
        const owner = new PublicKey(masterSigner.getPublicKeyBase58());
        const solBalance = await connection.getBalance(owner);
        if (solBalance < 5_000_000) {
          if (isJson()) {
            printJson(jsonError("INSUFFICIENT_BALANCE", "Insufficient SOL for gas. Need ~0.005 SOL."));
          } else {
            console.error(chalk.red("  Insufficient SOL for gas. Need ~0.005 SOL."));
            console.error(chalk.gray("  Tip: Use relayer for gasless deposits (start relayer server)\n"));
          }
          process.exit(1);
        }

        // Testnet collateral is the devnet USDP mint, mainnet is USDC (pacifica/constants.ts).
        const USDC_MINT = new PublicKey(getNetworkConfig(network).usdcMint);
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: USDC_MINT });
        const usdcBalance = tokenAccounts.value.length > 0
          ? tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount ?? 0
          : 0;
        if (usdcBalance < amountNum) {
          if (isJson()) {
            printJson(jsonError("INSUFFICIENT_BALANCE", `Insufficient USDC on Solana. Have: $${formatUsd(usdcBalance)}, need: $${formatUsd(amountNum)}`));
          } else {
            console.error(chalk.red(`  Insufficient USDC on Solana. Have: $${formatUsd(usdcBalance)}, need: $${formatUsd(amountNum)}`));
          }
          process.exit(1);
        }

        const ix = await buildDepositInstruction(owner, amount.trim(), network);
        const tx = new Transaction().add(ix);
        tx.feePayer = owner;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        signSolanaTransaction(masterSigner, tx, false);

        // The signature is known before the send: a transport failure after the request left
        // (reset, timeout — not a refused connection) is an unknown outcome carrying it.
        const signedSig = tx.signature;
        let sig: string;
        try {
          sig = await connection.sendRawTransaction(tx.serialize());
        } catch (e) {
          if (signedSig !== null && isTransportFailure(e) && !isConnectFailure(e)) {
            throw depositOutcomeUnknown((await import("bs58")).default.encode(signedSig), e);
          }
          throw e;
        }
        // Broadcast: from here a confirmation timeout / RPC error is an UNKNOWN outcome (the
        // transaction may still land) — reported with the signature, never as "failed".
        let confirmation: { value?: { err?: unknown } } | undefined;
        try {
          confirmation = await connection.confirmTransaction(sig, "confirmed");
        } catch (e) {
          throw depositOutcomeUnknown(sig, e);
        }
        if (confirmation?.value?.err !== undefined && confirmation.value.err !== null) {
          throw new PerpError("ACTION_REJECTED", `Pacifica deposit transaction ${sig} failed on-chain: ${JSON.stringify(confirmation.value.err)} — nothing was deposited`, {
            exchange: "pacifica", signature: sig,
          });
        }

        logExecution({
          type: "bridge", exchange: "pacifica", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "deposit", method: "direct", signature: sig },
        });

        if (isJson()) return printJson(jsonOk({ signature: sig, amount: amountNum, method: "direct" }));
        console.log(chalk.green(`  Deposit confirmed!`));
        console.log(`  Amount:    $${formatUsd(amountNum)} USDC`);
        console.log(`  Signature: ${sig}\n`);
      } catch (err) {
        const pendingSig = err instanceof PerpError ? err.structured.details?.signature : undefined;
        logExecution({
          type: "bridge", exchange: "pacifica", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: fundsFailStatus(err), dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "deposit", method: "direct", ...(typeof pendingSig === "string" ? { signature: pendingSig } : {}) },
        });
        throw err;
      }
    });

  // ── Hyperliquid (Arbitrum — USDC transfer to Bridge2) ──

  supportsDryRun(deposit.command("hyperliquid <amount>"))
    .description("Deposit USDC into Hyperliquid (Arbitrum; supports --dry-run)")
    .option("--relay", "Opt in to the gas-sponsoring relayer (PERP_RELAYER_URL); default: direct deposit, you pay gas")
    .option("--no-relay", "Direct deposit, pay gas yourself (the default)")
    .action(async (amount: string, rawOpts: { relay?: boolean }) => {
      const opts = { relay: rawOpts.relay === true };
      const amountNum = Number(parsePositiveDecimal(amount, "amount"));
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      if (amountNum < 5) throw new Error("Minimum deposit is $5 for Hyperliquid");
      // Relayer and direct Bridge2 transfer both target Arbitrum One + the mainnet HL bridge.
      requireMainnetDepositRoute("Hyperliquid deposit (Arbitrum Bridge2 / relayer)");
      if (isDryRun()) {
        return printFundsPlan({ action: "deposit", venue: "hyperliquid", network: getNetwork(), asset: "USDC", amount: String(amountNum), chain: "arbitrum", method: opts.relay ? "relayer" : "USDC transfer to Bridge2" });
      }
      await requireMaster("hyperliquid", "Hyperliquid deposit");

      // Relayer only when asked for with --relay; an unreachable relayer is an error.
      if (opts.relay && !(await relayerAvailable())) throw relayerUnavailable();

      // The depositing wallet is the OWS master (no raw key): its address for the relayer, its
      // transaction signer for the direct Bridge2 transfer.
      const evm = await import("../evm-master-tx.js");
      const signer = await evm.loadMasterEvmSigner("hyperliquid", cliCredentialOptsFrom(program.opts()), "Hyperliquid deposit");
      const depositor = signer.getAddress();

      if (opts.relay) {
        if (!isJson()) console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} via relayer (gasless)...\n`));

        // The relayer is given the account address and the amount only. Nothing it returns is
        // ever signed with the master key on this path.
        try {
          const res = await fetch(`${getRelayerUrl()}/deposit/hyperliquid`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userAddress: depositor, amount: amountNum }),
          });

          const result = (await res.json()) as Record<string, unknown>;
          if (!res.ok) throw new Error(String(result.error || "Relayer failed"));

          logExecution({
            type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "deposit",
            size: String(amountNum), status: "success", dryRun: false,
            meta: { action: "deposit", method: "relay", txHash: String(result.txHash) },
          });

          if (isJson()) return printJson(jsonOk({ ...result, method: "relay" }));
          console.log(chalk.green(`  Deposit confirmed!`));
          console.log(`  TX Hash: ${result.txHash}`);
          console.log(`  Fee:     $${formatUsd(Number(result.fee))}`);
          console.log(`  Net:     $${formatUsd(Number(result.netAmount))}`);
          console.log(chalk.gray(`\n  Gas: FREE (relayer sponsored)\n`));
          return;
        } catch (err) {
          logExecution({
            type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "deposit",
            size: String(amountNum), status: fundsFailStatus(err), dryRun: false,
            error: err instanceof Error ? err.message : String(err),
            meta: { action: "deposit", method: "relay" },
          });
          throw err;
        }
      }

      // Direct: USDC.transfer() to HL Bridge2
      if (!isJson()) {
        console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} USDC into Hyperliquid...\n`));
        console.log(chalk.gray("  Requires: ETH on Arbitrum for gas (~0.0001 ETH) + USDC on Arbitrum\n"));
      }

      const HL_BRIDGE = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7";
      const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
      const ARB_RPC = "https://arb1.arbitrum.io/rpc";
      const { parseUnits, formatUnits } = await import("ethers");

      const rpc = evm.evmProvider(ARB_RPC, 42161);
      await evm.assertRpcChainId(rpc, ARB_RPC, 42161, "hyperliquid");
      const amountRaw = parseUnits(amount, await evm.erc20Decimals(rpc, USDC_ARB));
      const usdcBal = await evm.erc20Balance(rpc, USDC_ARB, depositor);
      if (usdcBal < amountRaw) {
        throw new PerpError("INSUFFICIENT_BALANCE", `Insufficient USDC on Arbitrum. Have: $${formatUsd(Number(formatUnits(usdcBal, 6)))}`, { exchange: "hyperliquid" });
      }

      try {
        if (!isJson()) console.log(chalk.gray("  Sending USDC to Hyperliquid Bridge2..."));
        // Simulated, signed by the OWS master, broadcast; a lost response / receipt timeout after
        // the broadcast is ORDER_PENDING carrying the tx hash (never a retryable error).
        const { txHash } = await evm.sendMasterTx(rpc, {
          venue: "hyperliquid", chainLabel: "Arbitrum", chainId: 42161, from: depositor, to: USDC_ARB, value: 0n,
          data: evm.ERC20.encodeFunctionData("transfer", [HL_BRIDGE, amountRaw]), label: "USDC transfer to Hyperliquid Bridge2",
        }, tx => signer.signTransaction(tx));

        logExecution({
          type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "deposit", method: "direct", txHash },
        });

        if (isJson()) return printJson(jsonOk({ txHash, amount: amountNum, method: "direct" }));
        console.log(chalk.green(`  Deposit confirmed!`));
        console.log(`  Amount:  $${formatUsd(amountNum)} USDC`);
        console.log(`  TX Hash: ${txHash}`);
        console.log(chalk.gray(`\n  Funds appear in ~1-3 minutes.\n`));
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: fundsFailStatus(err), dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "deposit", method: "direct", ...pendingTxMeta(err) },
        });
        throw err;
      }
    });

  // ── Lighter ──

  const lighterDeposit = deposit.command("lighter").description("Deposit USDC into Lighter");

  supportsDryRun(lighterDeposit.command("ethereum <amount>"))
    .description("Deposit USDC via Ethereum L1 (min 1 USDC, gas: $3-10+; supports --dry-run)")
    // Asset index comes from GET /api/v1/assetDetails, which the deposit docs
    // name as the source for the contract's `_assetIndex`. Live registry:
    // 3 = USDC (l1_decimals 6), 2 = LIT (l1_decimals 18), 1 = ETH. The old
    // "2 = USDC" default contradicted this function's own USDC ERC20 transfer
    // and its parseUnits(amount, 6). Same defect as the withdraw side, which
    // was corrected to 3 in 966ffc0; the deposit side was missed then.
    .option("--asset-id <id>", "Asset index (default: 3 = USDC, per /api/v1/assetDetails)", "3")
    .option("--route <type>", "Route: 0=perps, 1=spot (default: 0)", "0")
    .action(async (amount: string, opts: { assetId: string; route: string }) => {
      const amountNum = Number(parsePositiveDecimal(amount, "amount"));
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      if (amountNum < 1) throw new Error("Minimum deposit via Ethereum is 1 USDC");
      // deposit(address _to, uint16 _assetIndex, uint8 _routeType, uint256 _amount) — Lighter docs
      // (deposits-transfers-and-withdrawals): "`_routeType`: whether you want to deposit the asset
      // to your perps (0), or spot account (1)". Strict: plain integers only ("3abc", "1e1", "" refused).
      if (!/^\d+$/.test(opts.assetId) || Number(opts.assetId) > 65_535) {
        throw new PerpError("INVALID_PARAMS", `--asset-id must be an integer asset index 0-65535 (got "${opts.assetId}")`, {
          exchange: "lighter", remediation: "Use the asset index from GET /api/v1/assetDetails (3 = USDC)",
        });
      }
      if (opts.route !== "0" && opts.route !== "1") {
        throw new PerpError("INVALID_PARAMS", `--route must be 0 (perps) or 1 (spot) (got "${opts.route}")`, { exchange: "lighter", remediation: "Pass --route 0 or --route 1" });
      }
      const assetIndex = Number(opts.assetId);
      const routeType = Number(opts.route);
      requireMainnetDepositRoute("Lighter deposit via Ethereum L1");
      if (isDryRun()) {
        return printFundsPlan({ action: "deposit", venue: "lighter", network: getNetwork(), asset: "USDC", amount: String(amountNum), chain: "ethereum", contract: "0x3B4D794a66304f130a4db8f2551b0070dfcf5ca7", assetIndex: opts.assetId, routeType: opts.route, steps: "approve USDC (if allowance short) → deposit()" });
      }
      await requireMaster("lighter", "Lighter deposit");

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} USDC into Lighter via Ethereum L1...\n`));
        console.log(chalk.yellow("  Warning: Ethereum L1 gas fees may be high ($3-10+)\n"));
      }

      // EIP-55 checksummed (the previous mixed-case literal failed ethers' checksum validation).
      const LIGHTER_CONTRACT = "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7";
      const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
      const ETH_RPC = "https://eth.llamarpc.com";
      const { Interface, parseUnits, formatUnits } = await import("ethers");
      const evm = await import("../evm-master-tx.js");
      // OWS master wallet signs both L1 transactions (no raw key).
      const signer = await evm.loadMasterEvmSigner("lighter", cliCredentialOptsFrom(program.opts()), "Lighter deposit");
      const depositor = signer.getAddress();
      const zkLighter = new Interface(["function deposit(address _to, uint16 _assetIndex, uint8 _routeType, uint256 _amount) payable"]);

      const rpc = evm.evmProvider(ETH_RPC, 1);
      await evm.assertRpcChainId(rpc, ETH_RPC, 1, "lighter");
      const amountRaw = parseUnits(amount, await evm.erc20Decimals(rpc, USDC_ETH));
      const usdcBal = await evm.erc20Balance(rpc, USDC_ETH, depositor);
      if (usdcBal < amountRaw) {
        throw new PerpError("INSUFFICIENT_BALANCE", `Insufficient USDC on Ethereum. Have: $${formatUsd(Number(formatUnits(usdcBal, 6)))}`, { exchange: "lighter" });
      }
      const base = { venue: "lighter", chainLabel: "Ethereum", chainId: 1, from: depositor, value: 0n };
      const sign = (tx: import("ethers").Transaction): Promise<string> => signer.signTransaction(tx);

      try {
        const allowance = await evm.erc20Allowance(rpc, USDC_ETH, depositor, LIGHTER_CONTRACT);
        if (allowance < amountRaw) {
          if (!isJson()) console.log(chalk.gray("  Approving USDC for Lighter..."));
          await evm.sendMasterTx(rpc, { ...base, to: USDC_ETH, data: evm.ERC20.encodeFunctionData("approve", [LIGHTER_CONTRACT, amountRaw]), label: "USDC approve" }, sign);
          if (!isJson()) console.log(chalk.gray("  Approved."));
        }

        if (!isJson()) console.log(chalk.gray("  Calling deposit()..."));
        const { txHash } = await evm.sendMasterTx(rpc, {
          ...base, to: LIGHTER_CONTRACT, label: "Lighter L1 deposit",
          data: zkLighter.encodeFunctionData("deposit", [depositor, assetIndex, routeType, amountRaw]),
        }, sign);

        logExecution({
          type: "bridge", exchange: "lighter", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "deposit", method: "ethereum", txHash },
        });

        if (isJson()) return printJson(jsonOk({ txHash, amount: amountNum, chain: "ethereum", method: "direct" }));
        console.log(chalk.green(`\n  Deposit confirmed!`));
        console.log(`  Amount:  $${formatUsd(amountNum)} USDC`);
        console.log(`  TX Hash: ${txHash}`);
        console.log(chalk.gray(`\n  Funds appear in your Lighter perps account shortly.\n`));
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "lighter", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: fundsFailStatus(err), dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "deposit", method: "ethereum", ...pendingTxMeta(err) },
        });
        throw err;
      }
    });

  const CCTP_CHAINS: Record<string, { chainId: number; rpc: string; usdc: string; name: string }> = {
    arbitrum: { chainId: 42161, rpc: "https://arb1.arbitrum.io/rpc", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", name: "Arbitrum" },
    base:     { chainId: 8453,  rpc: "https://mainnet.base.org",    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", name: "Base" },
    avalanche:{ chainId: 43114, rpc: "https://api.avax.network/ext/bc/C/rpc", usdc: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", name: "Avalanche" },
  };

  supportsDryRun(lighterDeposit.command("cctp <chain> <amount>"))
    .description("Deposit USDC via CCTP (arbitrum, base, avalanche — min 5 USDC; supports --dry-run)")
    .action(async (chain: string, amount: string) => {
      const amountNum = Number(parsePositiveDecimal(amount, "amount"));
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      if (amountNum < 5) throw new Error("Minimum CCTP deposit is 5 USDC");

      const chainKey = chain.toLowerCase();
      const chainInfo = CCTP_CHAINS[chainKey];
      if (!chainInfo) throw new Error(`Unsupported chain: ${chain}. Use: arbitrum, base, avalanche`);
      // The intent address comes from the -n adapter, but the USDC transfer is on a mainnet chain.
      requireMainnetDepositRoute(`Lighter CCTP deposit (${chainInfo.name})`);
      if (isDryRun()) {
        return printFundsPlan({ action: "deposit", venue: "lighter", network: getNetwork(), asset: "USDC", amount: String(amountNum), chain: chainKey, method: "CCTP: create intent address → USDC transfer to it" });
      }
      await requireMaster("lighter", "Lighter CCTP deposit");

      if (!isJson()) console.log(chalk.cyan(`\n  Depositing $${formatUsd(amountNum)} USDC into Lighter via CCTP (${chainInfo.name})...\n`));

      const { parseUnits, formatUnits } = await import("ethers");
      const evm = await import("../evm-master-tx.js");
      // OWS master wallet signs the USDC transfer (no raw key).
      const signer = await evm.loadMasterEvmSigner("lighter", cliCredentialOptsFrom(program.opts()), "Lighter CCTP deposit");
      const depositor = signer.getAddress();

      if (!isJson()) console.log(chalk.gray("  Creating intent address..."));
      // Network-aware: the adapter was built for the selected -n network (venue REST URL).
      const { LighterAdapter } = await import("../exchanges/lighter.js");
      const lt = await getAdapterForExchange("lighter");
      if (!(lt instanceof LighterAdapter)) throw new Error("lighter venue did not produce a LighterAdapter");
      if (lt.address.toLowerCase() !== depositor.toLowerCase()) {
        throw new PerpError("INVALID_PARAMS", `Lighter adapter address ${lt.address || "(none)"} differs from the depositing wallet ${depositor}`, {
          remediation: "Run the deposit with the master wallet that owns the Lighter account (--ows <wallet>)",
        });
      }
      // The USDC goes to this address: only the documented `intent_address` field is accepted
      // (apidocs.lighter.xyz/reference/createintentaddress → CreateIntentAddressResp, required:
      // "code", "intent_address"). The endpoint is unauthenticated and the docs offer no
      // authenticated read of an account's intent address to cross-check against, so the address
      // is requested twice and both answers must name the same address.
      const readIntentAddress = async (): Promise<string> => {
        const intentData = (await lt.createIntentAddress(chainInfo.chainId)) as Record<string, unknown> | null;
        const addr = intentData?.intent_address;
        if (typeof addr !== "string" || !evm.EVM_ADDRESS_RE.test(addr) || /^0x0{40}$/.test(addr)) {
          throw new PerpError("EXCHANGE_ERROR", `Lighter returned no intent_address for chain ${chainInfo.chainId} (got ${JSON.stringify(intentData).slice(0, 160)}) — nothing was sent`, { exchange: "lighter" });
        }
        return addr;
      };
      const intentAddress = await readIntentAddress();
      const intentAddressAgain = await readIntentAddress();
      if (intentAddress.toLowerCase() !== intentAddressAgain.toLowerCase()) {
        throw new PerpError("EXCHANGE_ERROR", `Lighter returned two different intent addresses for chain ${chainInfo.chainId} (${intentAddress} then ${intentAddressAgain}) — nothing was sent`, {
          exchange: "lighter",
          remediation: "Do not send funds to either address. Retry later, or deposit from the Lighter web app",
        });
      }

      if (!isJson()) console.log(`  Intent address: ${intentAddress}`);

      const rpc = evm.evmProvider(chainInfo.rpc, chainInfo.chainId);
      await evm.assertRpcChainId(rpc, chainInfo.rpc, chainInfo.chainId, "lighter");
      const amountRaw = parseUnits(amount, await evm.erc20Decimals(rpc, chainInfo.usdc));
      const usdcBal = await evm.erc20Balance(rpc, chainInfo.usdc, depositor);
      if (usdcBal < amountRaw) {
        throw new PerpError("INSUFFICIENT_BALANCE", `Insufficient USDC on ${chainInfo.name}. Have: $${formatUsd(Number(formatUnits(usdcBal, 6)))}`, { exchange: "lighter" });
      }

      if (!isJson()) console.log(chalk.gray(`  Sending USDC to intent address on ${chainInfo.name}...`));
      try {
        const { txHash } = await evm.sendMasterTx(rpc, {
          venue: "lighter", chainLabel: chainInfo.name, chainId: chainInfo.chainId, from: depositor, to: chainInfo.usdc, value: 0n,
          data: evm.ERC20.encodeFunctionData("transfer", [intentAddress, amountRaw]), label: "USDC transfer to the Lighter CCTP intent address",
        }, tx => signer.signTransaction(tx));

        logExecution({
          type: "bridge", exchange: "lighter", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "deposit", method: "cctp", chain: chainKey, txHash },
        });

        if (isJson()) return printJson(jsonOk({ txHash, amount: amountNum, chain: chainKey, intentAddress, method: "cctp" }));
        console.log(chalk.green(`\n  USDC sent to intent address!`));
        console.log(`  Amount:  $${formatUsd(amountNum)} USDC`);
        console.log(`  TX Hash: ${txHash}`);
        console.log(`  Chain:   ${chainInfo.name}`);
        // apidocs.lighter.xyz/docs/create-accounts-programmatically: "Legacy CCTP route: around 15–20 minutes."
        console.log(chalk.gray(`\n  CCTP deposits take around 15-20 minutes to credit. Funds will appear in Lighter automatically.\n`));
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "lighter", symbol: "USDC", side: "deposit",
          size: String(amountNum), status: fundsFailStatus(err), dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "deposit", method: "cctp", chain: chainKey, ...pendingTxMeta(err) },
        });
        throw err;
      }
    });

  lighterDeposit
    .command("info")
    .description("Show Lighter deposit routes & minimums")
    .action(async () => {
      if (isJson()) {
        return printJson(jsonOk({
          routes: {
            ethereum: { min: "1 USDC", gas: "$3-10+", method: "deposit() on L1 contract" },
            arbitrum: { min: "5 USDC", gas: "~$0.01", method: "CCTP via intent address" },
            base:     { min: "5 USDC", gas: "~$0.01", method: "CCTP via intent address" },
            avalanche:{ min: "5 USDC", gas: "~$0.01", method: "CCTP via intent address" },
          },
          contract: "0x3B4D794a66304f130a4db8f2551b0070dfcf5ca7",
        }));
      }

      console.log(chalk.cyan.bold("\n  Lighter Deposit Routes\n"));

      console.log(chalk.white.bold("  Ethereum L1") + chalk.gray(" (direct)"));
      console.log(`  Min: 1 USDC  |  Gas: $3-10+`);
      console.log(`  Command: ${chalk.green("perp funds deposit lighter ethereum <amount>")}`);

      console.log(chalk.white.bold("\n  Arbitrum") + chalk.gray(" (CCTP)"));
      console.log(`  Min: 5 USDC  |  Gas: ~$0.01`);
      console.log(`  Command: ${chalk.green("perp funds deposit lighter cctp arbitrum <amount>")}`);

      console.log(chalk.white.bold("\n  Base") + chalk.gray(" (CCTP)"));
      console.log(`  Min: 5 USDC  |  Gas: ~$0.01`);
      console.log(`  Command: ${chalk.green("perp funds deposit lighter cctp base <amount>")}`);

      console.log(chalk.white.bold("\n  Avalanche") + chalk.gray(" (CCTP)"));
      console.log(`  Min: 5 USDC  |  Gas: ~$0.01`);
      console.log(`  Command: ${chalk.green("perp funds deposit lighter cctp avalanche <amount>")}`);
      console.log();
    });

  // ── Lighter RH (Robinhood Chain contract deposit) ──

  {
    const rhDef = getVenue("lighter-rh");
    const rhAsset = rhDef.networks.mainnet.collateral[0];
    const rhChain = chainLabel(rhDef.networks.mainnet.settlementChain);
    supportsDryRun(deposit.command("lighter-rh <amount>"))
      .description(`Deposit ${rhAsset} into ${rhDef.displayName} via the ${rhChain} contract (approve + deposit; min 1 ${rhAsset}; supports --dry-run)`)
      .option("--route <type>", "Route: 0=perps, 1=spot (default: 0)", "0")
      .action(async (amount: string, opts: { route: string }) => {
        if (opts.route !== "0" && opts.route !== "1") {
          throw new PerpError("INVALID_PARAMS", `--route must be 0 (perps) or 1 (spot), got "${opts.route}"`);
        }
        const net: VenueNetwork = getNetwork();
        const { planLighterRhDeposit, executeLighterRhDeposit, requireLighterRhDepositNetwork } = await import("../exchanges/lighter-rh-deposit.js");
        // Uniform CAPABILITY_UNSUPPORTED on testnet, before any credential is needed.
        requireLighterRhDepositNetwork(net);
        // The deposit is an L1 contract call from the master wallet; the plan needs its address too.
        if (!isDryRun()) await requireMaster("lighter-rh", `${rhDef.displayName} deposit`);
        const { LighterAdapter } = await import("../exchanges/lighter.js");
        const lt = await getAdapterForExchange("lighter-rh");
        if (!(lt instanceof LighterAdapter)) throw new Error("lighter-rh venue did not produce a LighterAdapter");
        const plan = await planLighterRhDeposit({ network: net, amount, depositor: lt.address, routeType: opts.route === "1" ? 1 : 0 });
        const view = {
          venue: rhDef.id, network: net, asset: plan.asset, amount: plan.amount, depositor: plan.depositor,
          contract: plan.contract, token: plan.token, chainId: plan.chainId, routeType: plan.routeType,
          needsApprove: plan.needsApprove,
        };

        if (isDryRun()) {
          logExecution({
            type: "bridge", exchange: rhDef.id, symbol: plan.asset, side: "deposit",
            size: plan.amount, status: "simulated", dryRun: true,
            meta: { action: "deposit", method: "contract", contract: plan.contract },
          });
          if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, ...view }));
          console.log(chalk.yellow(`\n  [dry-run] Would deposit ${plan.amount} ${plan.asset} into ${rhDef.displayName}`));
          console.log(`  From:     ${plan.depositor} (${rhChain}, chainId ${plan.chainId})`);
          console.log(`  Contract: ${plan.contract}`);
          console.log(`  Steps:    ${plan.needsApprove ? `approve ${plan.asset} → ` : ""}deposit(route ${plan.routeType})`);
          console.log(chalk.gray("  Nothing was sent.\n"));
          return;
        }

        if (!isJson()) {
          console.log(chalk.cyan(`\n  Depositing ${plan.amount} ${plan.asset} into ${rhDef.displayName} on ${rhChain}...\n`));
          if (plan.needsApprove) console.log(chalk.gray(`  Approving ${plan.asset} for ${plan.contract}...`));
        }
        try {
          const res = await executeLighterRhDeposit(plan, tx => lt.signL1Transaction(tx));
          logExecution({
            type: "bridge", exchange: rhDef.id, symbol: plan.asset, side: "deposit",
            size: plan.amount, status: "success", dryRun: false,
            meta: { action: "deposit", method: "contract", txHash: res.depositTxHash, approveTxHash: res.approveTxHash },
          });
          if (isJson()) return printJson(jsonOk({ ...view, ...res, method: "contract" }));
          console.log(chalk.green(`\n  Deposit confirmed!`));
          console.log(`  Amount:  ${plan.amount} ${plan.asset}`);
          if (res.approveTxHash !== null) console.log(`  Approve: ${res.approveTxHash}`);
          console.log(`  TX Hash: ${res.depositTxHash}`);
          console.log(chalk.gray(`\n  Funds appear in your ${rhDef.displayName} account shortly.\n`));
        } catch (err) {
          logExecution({
            type: "bridge", exchange: rhDef.id, symbol: plan.asset, side: "deposit",
            size: plan.amount, status: fundsFailStatus(err), dryRun: false,
            error: err instanceof Error ? err.message : String(err),
            // An unknown-outcome (ORDER_PENDING) failure carries the broadcast tx hash: keep it in the log.
            meta: { action: "deposit", method: "contract", ...pendingTxMeta(err) },
          });
          throw err;
        }
      });
  }

  // ═══════════════════════════════════════════════════════
  //  FAUCET (testnet tooling)
  // ═══════════════════════════════════════════════════════

  const faucet = funds.command("faucet").description("[testnet tooling] Mint venue test collateral (refused on mainnet)");

  supportsDryRun(faucet.command("pacifica <amount>"))
    .description("[testnet tooling] Mint test USDP on Pacifica testnet (Solana devnet mint_test_usdc; master wallet; simulated before send; supports --dry-run)")
    .action(async (amount: string) => {
      const network = getNetwork();
      if (network !== "testnet") {
        throw unsupported("Pacifica", `the test-USDP faucet on ${network}`, "mint_test_usdc exists only on the devnet program",
          "Run on testnet: perp -n testnet funds faucet pacifica <amount>");
      }
      const { testUsdcBaseUnits, mintTestUsdc, PACIFICA_DEVNET_RPC } = await import("../pacifica/faucet.js");
      const { getNetworkConfig } = await import("../pacifica/constants.js");
      const baseUnits = testUsdcBaseUnits(amount);
      const cfg = getNetworkConfig("testnet");
      if (isDryRun()) {
        return printFundsPlan({
          action: "deposit", venue: "pacifica", network, asset: "USDP (test)", amount,
          method: "faucet mint_test_usdc (simulated, then sent)", baseUnits: baseUnits.toString(),
          programId: cfg.programId, mint: cfg.usdcMint, rpc: PACIFICA_DEVNET_RPC,
        });
      }
      await requireMaster("pacifica", "Pacifica testnet faucet");
      // The subcommand names the venue: fetch it directly, independent of -e.
      const adapter = await getAdapterForExchange("pacifica");
      if (adapter.name !== "pacifica") throw new Error("pacifica venue did not produce a Pacifica adapter");
      const { PacificaAdapter } = await import("../exchanges/pacifica.js");
      const pac = adapter as InstanceType<typeof PacificaAdapter>;
      const { Connection } = await import("@solana/web3.js");
      try {
        const { signature, plan } = await mintTestUsdc(new Connection(PACIFICA_DEVNET_RPC, "confirmed"), pac.masterSolanaSigner(), amount);
        logExecution({
          type: "bridge", exchange: "pacifica", symbol: "USDP", side: "deposit",
          size: amount, status: "success", dryRun: false,
          meta: { action: "faucet", network, signature, userAta: plan.userAta },
        });
        if (isJson()) return printJson(jsonOk({ signature, amount, network, method: "faucet", wallet: plan.user, userAta: plan.userAta }));
        console.log(chalk.green(`\n  Minted ${amount} test USDP on Pacifica testnet`));
        console.log(`  Wallet:    ${plan.user}`);
        console.log(`  Signature: ${signature}\n`);
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "pacifica", symbol: "USDP", side: "deposit",
          size: amount, status: fundsFailStatus(err), dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "faucet", network },
        });
        throw err;
      }
    });

  supportsDryRun(faucet.command("risex"))
    .description("[testnet tooling] Get the RISEx testnet faucet's 1000 test USDC (once per wallet; also registers the account; refused on mainnet; supports --dry-run). Refused while RISEx is read-only (trading in a later release)")
    .action(async () => {
      // Gated with RISEx trading (read-only release): the faucet is a venue write.
      const risexDef = getVenue("risex");
      if (!risexDef.roles.includes("trading")) throw roleUnsupported(risexDef, "faucet");
      const network = getNetwork();
      if (network !== "testnet") {
        throw unsupported("RISEx", `the test-USDC faucet on ${network}`, "the faucet exists only on testnet", "Run on testnet: perp -n testnet funds faucet risex");
      }
      const adapter = await getAdapterForExchange("risex");
      const { RisexAdapter } = await import("../exchanges/risex/adapter.js");
      if (!(adapter instanceof RisexAdapter)) throw new Error("risex venue did not produce a RisexAdapter");
      const account = adapter.accountAddress();
      if (isDryRun()) {
        return printFundsPlan({ action: "deposit", venue: "risex", network, asset: "USDC (test)", amount: "1000", method: "testnet faucet POST /v1/account/deposit", account });
      }
      const res = await adapter.testnetFaucet();
      logExecution({ type: "bridge", exchange: "risex", symbol: "USDC", side: "deposit", size: "1000", status: "success", dryRun: false, meta: { action: "faucet", network, account } });
      if (isJson()) return printJson(jsonOk({ ...res, account, amount: "1000", network, method: "faucet" }));
      console.log(chalk.green(`\n  RISEx testnet faucet: 1000 test USDC requested for ${account}`));
      if (res.txHash !== null) console.log(`  Tx: ${res.txHash}`);
      console.log();
    });

  // ═══════════════════════════════════════════════════════
  //  WITHDRAW
  // ═══════════════════════════════════════════════════════

  const withdraw = funds.command("withdraw").description("Withdraw funds from exchange accounts");

  // ── Pacifica ──

  supportsDryRun(withdraw.command("pacifica <amount>"))
    .description("Withdraw USDC from Pacifica to your own Solana wallet (Pacifica has no destination field; supports --dry-run)")
    .action(async (amount: string) => {
      const amountNum = Number(parsePositiveDecimal(amount, "amount"));
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      if (isDryRun()) {
        return printFundsPlan({ action: "withdraw", venue: "pacifica", network: getNetwork(), asset: "USDC", amount: String(amountNum), destination: "account owner's Solana wallet" });
      }
      await requireMaster("pacifica", "Pacifica withdraw");

      // The subcommand names the venue: fetch it directly, independent of -e.
      const adapter = await getAdapterForExchange("pacifica");
      if (!hasPacificaSdk(adapter) || !isWithdrawCapable(adapter)) throw new Error("pacifica venue did not produce a withdraw-capable Pacifica adapter");

      // Pacifica withdrawals always go to the account owner's own wallet.
      const dest = adapter.publicKey;

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Withdrawing $${formatUsd(amountNum)} USDC from Pacifica...\n`));
        console.log(`  Destination: ${dest}`);
      }

      try {
        const result = await adapter.withdraw(String(amountNum), dest);

        logExecution({
          type: "bridge", exchange: "pacifica", symbol: "USDC", side: "withdraw",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "withdraw", destination: dest },
        });

        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  Withdrawal submitted!`));
        console.log(`  Amount: $${formatUsd(amountNum)} USDC`);
        console.log(chalk.gray(`\n  Funds arrive in your Solana wallet shortly.\n`));
      } catch (err) {
        logExecution({
          type: "bridge", exchange: "pacifica", symbol: "USDC", side: "withdraw",
          size: String(amountNum), status: fundsFailStatus(err), dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "withdraw", destination: dest },
        });
        throw err;
      }
    });

  // ── Hyperliquid ──

  supportsDryRun(withdraw.command("hyperliquid <amount>"))
    .description("Withdraw USDC from Hyperliquid over CCTP (native USDC) to your wallet on Arbitrum (default), Ethereum or Base — another address only when allowlisted in settings withdraw.hyperliquid; supports --dry-run")
    .option("--chain <chain>", "Destination chain: arbitrum | ethereum | base", "arbitrum")
    .option("--to <address>", "Destination EVM address (default: your wallet; any other address must be on the settings withdraw.hyperliquid allowlist)")
    .action(async (amount: string, opts: { to?: string; chain: string }) => {
      const { HL_CCTP_ROUTES } = await import("../exchanges/hyperliquid.js");
      const chain = opts.chain.toLowerCase();
      if (!(chain in HL_CCTP_ROUTES)) {
        throw new PerpError("INVALID_PARAMS", `--chain must be one of ${Object.keys(HL_CCTP_ROUTES).join(", ")} (got "${opts.chain}")`);
      }
      const route = HL_CCTP_ROUTES[chain as keyof typeof HL_CCTP_ROUTES];
      const feeNote = route.forwardingFeeUsdc !== null
        ? `CCTP forwarding fee ${route.forwardingFeeUsdc} USDC (deducted on the way) + a small Hyperliquid send fee`
        : "CCTP forwarding fee for this chain is not published — it is deducted on the way";
      const amountStr = parsePositiveDecimal(amount, "amount");
      const amountNum = Number(amountStr);
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      if (opts.to !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(opts.to)) {
        throw new PerpError("INVALID_PARAMS", `--to must be an EVM address (got "${opts.to}")`);
      }
      if (isDryRun()) {
        // The owner address is not resolved in a dry run (no key is loaded): an explicit --to is
        // judged as a non-owner destination; it needs no gate if it is the owner's own address.
        const withdrawGate = opts.to === undefined
          ? "not needed — destination is the account owner's own address"
          : `${hyperliquidGateVerdict(getNetwork(), amountStr, opts.to, Date.now())} (not needed if --to is the account owner's own address; checked again when sent)`;
        return printFundsPlan({ action: "withdraw", venue: "hyperliquid", network: getNetwork(), asset: "USDC", amount: String(amountNum), destination: opts.to !== undefined ? opts.to : "account owner's address", chain, method: "CCTP (sendToEvmWithData)", cctpDomain: route.cctpDomain, fee: feeNote, withdrawGate });
      }
      await requireMaster("hyperliquid", "Hyperliquid withdraw");

      // The subcommand names the venue: fetch it directly, independent of -e (like ondo / arcus).
      const adapter = await getAdapterForExchange("hyperliquid");
      if (!hasEvmAddress(adapter) || !isWithdrawCapable(adapter)) throw new Error("hyperliquid venue did not produce a withdraw-capable EVM adapter");
      // HyperliquidAdapter.withdraw takes the CCTP destination chain.
      const hlWithdraw = adapter.withdraw.bind(adapter) as (amount: string, destination: string, opts: { chain: keyof typeof HL_CCTP_ROUTES }) => Promise<unknown>;

      const dest = opts.to === undefined ? adapter.address : opts.to;
      // Owner-only unless the destination passes settings.withdraw.hyperliquid (checked before any read / send).
      const toOwner = dest.toLowerCase() === adapter.address.toLowerCase();
      if (!toOwner) {
        const gate = loadSettings().withdraw.hyperliquid;
        assertWithdrawAllowed("hyperliquid", getNetwork(), amountStr, dest, gate === undefined ? null : gate, Date.now());
      }

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Withdrawing $${formatUsd(amountNum)} USDC from Hyperliquid...\n`));
        console.log(`  Destination: ${dest}${toOwner ? "" : " (allowlisted in settings withdraw.hyperliquid)"}`);
      }

      const balance = await adapter.getBalance();
      const available = Number(balance.available);
      if (amountNum > available) {
        if (isJson()) {
          printJson(jsonError("INSUFFICIENT_BALANCE", `Insufficient withdrawable balance. Available: $${formatUsd(available)}`));
        } else {
          console.error(chalk.red(`  Insufficient withdrawable balance. Available: $${formatUsd(available)}`));
        }
        process.exit(1);
      }

      const attempt = hyperliquidGateEnforce(getNetwork(), amountStr, dest, adapter.address, Date.now());
      try {
        const result = await hlWithdraw(amountStr, dest, { chain: chain as keyof typeof HL_CCTP_ROUTES });

        logExecution({
          type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "withdraw",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "withdraw", destination: dest, chain, method: "cctp" },
        });

        if (isJson()) return printJson(jsonOk({ result, chain, method: "cctp", fee: feeNote }));
        console.log(chalk.green(`\n  Withdrawal submitted (CCTP → ${chain})!`));
        console.log(`  Amount: $${formatUsd(amountNum)} USDC — ${feeNote}`);
        console.log(chalk.gray(`\n  Processing may take a few minutes.\n`));
      } catch (err) {
        // Only a definite refusal proves nothing left the account; an unknown outcome keeps counting.
        if (attempt !== null && isDefiniteOrderFailure(err)) forgetWithdrawAttempt(attempt);
        logExecution({
          type: "bridge", exchange: "hyperliquid", symbol: "USDC", side: "withdraw",
          size: String(amountNum), status: fundsFailStatus(err), dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "withdraw", destination: dest },
        });
        throw err;
      }
    });

  // ── Lighter ──

  supportsDryRun(withdraw.command("lighter <amount>"))
    // Serves both Lighter-family venues (-e lighter / -e lighter-rh); text derived from their definitions.
    .description(`Withdraw collateral from a Lighter-family venue to your own L1 wallet (${lighterFamilyWithdrawSummary()}; supports --dry-run)`)
    .option("--asset-id <id>", "Asset index (default: 3 = the venue collateral, per /api/v1/assetDetails)", "3")
    .option("--route <type>", "Route type: 0=perp, 1=spot (default: 0)", "0")
    .action(async (amount: string, opts: { assetId: string; route: string }) => {
      const amountNum = Number(parsePositiveDecimal(amount, "amount"));
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      if (isDryRun()) {
        const venue = getVenue(program.opts().exchange as string);
        if (venue.family !== "lighter") throw new Error("Requires --exchange lighter or lighter-rh");
        return printFundsPlan({ action: "withdraw", venue: venue.id, network: getNetwork(), asset: withdrawAssetOf(venue), amount: String(amountNum), destination: "account owner's L1 wallet", chain: withdrawChainOf(venue, getNetwork()), assetIndex: opts.assetId, routeType: opts.route });
      }
      {
        const venue = getVenue(program.opts().exchange as string);
        if (venue.family === "lighter") await requireMaster(venue.id, `${venue.displayName} withdraw`);
      }

      const adapter = await getAdapter();
      if (!hasLighterAccount(adapter) || !isWithdrawCapable(adapter)) throw new Error("Requires --exchange lighter or lighter-rh");
      const { LighterAdapter } = await import("../exchanges/lighter.js");
      if (!(adapter instanceof LighterAdapter)) throw new Error("Requires --exchange lighter or lighter-rh");
      const venueName = getVenue(adapter.venueId).displayName;
      const asset = adapter.collateralSymbol;
      const chain = chainLabel(adapter.network.settlementChain);

      if (!isJson()) {
        console.log(chalk.cyan(`\n  Withdrawing ${formatUsd(amountNum)} ${asset} from ${venueName} to ${chain}...\n`));
        console.log(`  Account Index: ${adapter.accountIndex}`);
        console.log(`  Address: ${adapter.address}`);
      }

      try {
        const result = await adapter.withdraw(String(amountNum), "", { assetId: parseInt(opts.assetId), routeType: parseInt(opts.route) });

        logExecution({
          type: "bridge", exchange: adapter.venueId, symbol: asset, side: "withdraw",
          size: String(amountNum), status: "success", dryRun: false,
          meta: { action: "withdraw" },
        });

        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  Withdrawal submitted!`));
        console.log(`  Amount: ${formatUsd(amountNum)} ${asset}`);
        console.log(chalk.gray(`\n  Standard (secure) withdrawal is processed by the ${chain} contract and can take hours. Use the ${venueName} web app for a fast withdrawal.\n`));
      } catch (err) {
        logExecution({
          type: "bridge", exchange: adapter.venueId, symbol: asset, side: "withdraw",
          size: String(amountNum), status: fundsFailStatus(err), dryRun: false,
          error: err instanceof Error ? err.message : String(err),
          meta: { action: "withdraw" },
        });
        throw err;
      }
    });

  // ── Arcus — uniform surface: same <amount> + --to,
  //    same jsonOk(result), global --dry-run plans without sending. ──


  // Ondo Perps: the API does not allow withdrawals (address-book destinations only; adding one is
  // refused for API keys). The command stays so the refusal is explicit — also under --dry-run.
  supportsDryRun(withdraw.command("ondo [amount]"))
    .description("Not available: Ondo Perps withdrawals are web-app only (refused, also with --dry-run)")
    .option("--to <address>", "Ignored — the API cannot withdraw")
    .action(async () => {
      throw unsupported("Ondo Perps", "withdraw", "the Ondo Perps API does not allow withdrawals", "Withdraw from the Ondo Perps web app");
    });

  // RISEx: deposits / withdrawals are app-only (owner decision). The commands stay so the refusal
  // is explicit — also under --dry-run, before any credential or request.
  supportsDryRun(withdraw.command("risex [amount]"))
    .description(`Not available: RISEx withdrawals are done in the RISEx app (${RISEX_APP_URL}) — refused, also with --dry-run`)
    .option("--to <address>", "Ignored — perp-cli does not move RISEx funds")
    .action(async () => {
      throw unsupported("risex", "withdraw", RISEX_FUNDS_APP_ONLY.reason, RISEX_FUNDS_APP_ONLY.remediation);
    });
  // TxFlow: market data only in perp-cli.
  supportsDryRun(withdraw.command("txflow [amount]"))
    .description("Not available: TxFlow is market data only in perp-cli — refused")
    .option("--to <address>", "Ignored")
    .action(async () => {
      throw roleUnsupported(getVenue("txflow"), "withdraw");
    });
  // Variational: read-only (market data) in perp-cli; no public trading API yet.
  supportsDryRun(withdraw.command("variational [amount]"))
    .description("Not available: Variational is read-only (market data) in perp-cli — refused")
    .option("--to <address>", "Ignored")
    .action(async () => {
      throw roleUnsupported(getVenue("variational"), "withdraw");
    });
  // GRVT: read-only (market data) in this version.
  supportsDryRun(withdraw.command("grvt [amount]"))
    .description("Not available: GRVT is read-only (market data) in this version — refused, also with --dry-run")
    .option("--to <address>", "Ignored")
    .action(async () => {
      throw roleUnsupported(getVenue("grvt"), "withdraw");
    });
  // Extended: market data only in this version.
  supportsDryRun(withdraw.command("extended [amount]"))
    .description("Not available: Extended is market data only in this version — refused, also with --dry-run")
    .option("--to <address>", "Ignored")
    .action(async () => {
      throw roleUnsupported(getVenue("extended"), "withdraw");
    });

  for (const venueId of ["arcus"] as const) {
    const def = getVenue(venueId);
    const asset = withdrawAssetOf(def);
    const toHelp = "Destination EVM address (must equal the Arcus account owner — the default)";
    supportsDryRun(withdraw.command(`${venueId} <amount>`))
      .description(`Withdraw ${asset} from ${def.displayName} to your ${chainLabel(withdrawChainOf(def, "mainnet"))} wallet (supports --dry-run)`)
      .option("--to <address>", toHelp)
      .action(async (amount: string, opts: { to?: string }) => {
        const amountNum = Number(parsePositiveDecimal(amount, "amount"));
        if (!/^\d+(\.\d+)?$/.test(amount) || isNaN(amountNum) || amountNum <= 0) {
          throw new PerpError("INVALID_PARAMS", `Withdraw amount must be a positive decimal (got "${amount}")`);
        }
        const net = getNetwork();
        const chain = chainLabel(withdrawChainOf(def, net));
        const adapter = await getAdapterForExchange(venueId);
        if (!isWithdrawCapable(adapter)) throw new Error(`${def.id} adapter has no withdraw()`);

        const { ArcusAdapter } = await import("../exchanges/arcus/adapter.js");
        if (!(adapter instanceof ArcusAdapter)) throw new Error("arcus venue did not produce an ArcusAdapter");
        const owner = adapter.withdrawDestination;
        if (opts.to !== undefined && opts.to.toLowerCase() !== owner.toLowerCase()) {
          throw new PerpError("INVALID_PARAMS", `Arcus only withdraws to the account owner ${owner}`, {
            remediation: `Omit --to (defaults to ${owner})`,
          });
        }
        const destination = owner;

        const plan = { venue: def.id, network: net, asset, amount: String(amountNum), destination, chain };
        if (isDryRun()) {
          logExecution({
            type: "bridge", exchange: def.id, symbol: asset, side: "withdraw",
            size: String(amountNum), status: "simulated", dryRun: true,
            meta: { action: "withdraw", destination },
          });
          if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, ...plan }));
          console.log(chalk.yellow(`\n  [dry-run] Would withdraw ${formatUsd(amountNum)} ${asset} from ${def.displayName} (${net})`));
          console.log(`  Destination: ${destination} (${chain})`);
          console.log(chalk.gray("  Nothing was sent.\n"));
          return;
        }

        if (!isJson()) {
          console.log(chalk.cyan(`\n  Withdrawing ${formatUsd(amountNum)} ${asset} from ${def.displayName}...\n`));
          console.log(`  Destination: ${destination} (${chain})`);
        }
        try {
          const result = await adapter.withdraw(String(amountNum), destination);
          logExecution({
            type: "bridge", exchange: def.id, symbol: asset, side: "withdraw",
            size: String(amountNum), status: "success", dryRun: false,
            meta: { action: "withdraw", destination },
          });
          if (isJson()) return printJson(jsonOk(result));
          console.log(chalk.green(`\n  Withdrawal submitted!`));
          console.log(`  Amount: ${formatUsd(amountNum)} ${asset}`);
          console.log(chalk.gray(`\n  Track it in the ${def.displayName} app until it arrives on ${chain}.\n`));
        } catch (err) {
          logExecution({
            type: "bridge", exchange: def.id, symbol: asset, side: "withdraw",
            size: String(amountNum), status: fundsFailStatus(err), dryRun: false,
            error: err instanceof Error ? err.message : String(err),
            meta: { action: "withdraw", destination },
          });
          throw err;
        }
      });
  }

  // ── QFEX — custodial; deposit = address display, withdraw = banker POST
  //    gated by settings.withdraw.qfex inside QfexAdapter.withdraw(); switched off (QFEX_WITHDRAW_ENABLED). ──

  /** QFEX adapter for the active network — the default imported key, or the one named by --agent. */
  const qfexAdapterFor = async (agentName: string | undefined): Promise<QfexAdapter> => {
    const { QfexAdapter: Cls } = await import("../exchanges/qfex/adapter.js");
    let adapter: ExchangeAdapter;
    if (agentName === undefined) {
      adapter = await getAdapterForExchange("qfex");
    } else {
      const { getVenueAgent } = await import("../agent-wallet/store.js");
      const meta = getVenueAgent("qfex", agentName);
      if (meta === null) {
        throw new PerpError("AGENT_NOT_REGISTERED", `No QFEX API key named "${agentName}"`, { remediation: "List keys: perp wallet agent list qfex" });
      }
      const def = getVenue("qfex");
      if (def.create === null) throw new Error("qfex venue has no adapter factory");
      adapter = await def.create({
        network: getNetwork(), credentials: { ...READ_ONLY_CREDENTIALS, agent: meta }, noAgent: false, hlDex: null, readOnly: false, noBuilder: true,
      });
    }
    if (!(adapter instanceof Cls)) throw new Error("qfex venue did not produce a QfexAdapter");
    return adapter;
  };

  supportsDryRun(withdraw.command(QFEX_WITHDRAW_ENABLED ? "qfex <amount>" : "qfex [amount]"))
    .description(QFEX_WITHDRAW_ENABLED
      ? "Withdraw USDC from QFEX to an allowlisted Arbitrum One address (needs settings withdraw.qfex and a key with the \"Deposit and withdraw\" permission; supports --dry-run)"
      : "Not available: QFEX withdrawals are disabled in perp-cli for now — use the QFEX web app (refused, also with --dry-run)")
    .option("--to <address>", "Destination EVM address on Arbitrum One (required; must be on the settings withdraw.qfex allowlist)")
    .option("--agent <name>", "Imported QFEX key to use (a key with the \"Deposit and withdraw\" permission, bound to the primary account)")
    .action(async (amount: string, opts: { to?: string; agent?: string }) => {
      if (!QFEX_WITHDRAW_ENABLED) throw unsupported("QFEX", "withdraw", QFEX_WITHDRAW_DISABLED.reason, QFEX_WITHDRAW_DISABLED.remediation);
      const def = getVenue("qfex");
      const net = getNetwork();
      if (!/^\d+(\.\d+)?$/.test(amount) || !(Number(amount) > 0)) {
        throw new PerpError("INVALID_PARAMS", `Withdraw amount must be a positive decimal (got "${amount}")`);
      }
      if (opts.to === undefined) {
        throw new PerpError("INVALID_PARAMS", "QFEX withdraw needs a destination address (the API key has no owner address)", {
          remediation: `perp funds withdraw qfex ${amount} --to <0x address on the settings withdraw.qfex allowlist>`,
        });
      }
      const destination = opts.to;
      const chain = chainLabel(withdrawChainOf(def, net));
      if (isDryRun()) {
        // The local gate needs no key and no network: a dry run shows whether it would refuse.
        const gate = loadSettings().withdraw.qfex;
        assertWithdrawAllowed("qfex", net, amount, destination, gate === undefined ? null : gate, Date.now());
        return printFundsPlan({
          action: "withdraw", venue: "qfex", network: net, asset: "USDC", amount, destination, chain, bankerNetwork: QFEX_BANKER_NETWORK,
          fee: "taken from the amount by QFEX (not published)", // docs.qfex.com/api-reference/programmatic-funding: "`POST /withdraw` is not idempotent" and 403 =
          // "API key lacks **Deposit and withdraw** permission, or the account cannot use funding".
          // 2FA is documented for creating the API key (api-reference/api-keys), not for the withdrawal call.
          note: "POST /withdraw is not idempotent; QFEX answers 403 when the key lacks the \"Deposit and withdraw\" permission or the account cannot use funding",
        });
      }
      const adapter = await qfexAdapterFor(opts.agent);
      if (!isJson()) {
        console.log(chalk.cyan(`\n  Withdrawing ${amount} USDC from QFEX...\n`));
        console.log(`  Destination: ${destination} (${chain})`);
      }
      try {
        const result = await adapter.withdraw(amount, destination);
        logExecution({ type: "bridge", exchange: "qfex", symbol: "USDC", side: "withdraw", size: amount, status: "success", dryRun: false, meta: { action: "withdraw", destination } });
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green(`\n  Withdrawal accepted by QFEX.`));
        console.log(`  Amount: ${amount} USDC (fee taken from it; not published)`);
        console.log(chalk.gray(`\n  ${result.note}\n`));
      } catch (err) {
        logExecution({ type: "bridge", exchange: "qfex", symbol: "USDC", side: "withdraw", size: amount, status: fundsFailStatus(err), dryRun: false, error: err instanceof Error ? err.message : String(err), meta: { action: "withdraw", destination } });
        throw err;
      }
    });

  supportsDryRun(deposit.command("risex [amount]"))
    .description(`Not available: RISEx deposits are done in the RISEx app (${RISEX_APP_URL}) — refused, also with --dry-run`)
    .action(async () => {
      throw unsupported("risex", "deposit", RISEX_FUNDS_APP_ONLY.reason, RISEX_FUNDS_APP_ONLY.remediation);
    });
  supportsDryRun(deposit.command("txflow [amount]"))
    .description("Not available: TxFlow is market data only in perp-cli — refused")
    .action(async () => {
      throw roleUnsupported(getVenue("txflow"), "deposit");
    });
  supportsDryRun(deposit.command("variational [amount]"))
    .description("Not available: Variational is read-only (market data) in perp-cli — refused")
    .action(async () => {
      throw roleUnsupported(getVenue("variational"), "deposit");
    });
  supportsDryRun(deposit.command("grvt [amount]"))
    .description("Not available: GRVT is read-only (market data) in this version — refused, also with --dry-run")
    .action(async () => {
      throw roleUnsupported(getVenue("grvt"), "deposit");
    });
  supportsDryRun(deposit.command("extended [amount]"))
    .description("Not available: Extended is market data only in this version — refused, also with --dry-run")
    .action(async () => {
      throw roleUnsupported(getVenue("extended"), "deposit");
    });

  supportsDryRun(deposit.command("qfex"))
    .description("Show the QFEX deposit address for USDC on Arbitrum One (perp-cli sends nothing — transfer from your own wallet; supports --dry-run)")
    // --chain, not --network: the root -n/--network (mainnet | testnet) would swallow a subcommand --network.
    .option("--chain <chain>", "Deposit chain (arbitrum only; TRON USDT is not supported)", "arbitrum")
    .option("--agent <name>", "Imported QFEX key to use (needs the \"Deposit and withdraw\" permission)")
    .action(async (opts: { chain: string; agent?: string }) => {
      const requested = opts.chain.toLowerCase();
      if (requested === "tron") {
        throw unsupported("qfex", "depositTron", "only USDC on Arbitrum One is supported; how a TRON USDT deposit is credited as USDC margin is not documented", "Deposit USDC on Arbitrum One, or use the QFEX web app for other rails");
      }
      if (requested !== QFEX_WITHDRAW_NETWORK) {
        throw new PerpError("INVALID_PARAMS", `Unsupported QFEX deposit chain "${opts.chain}"`, { remediation: "Use --chain arbitrum" });
      }
      const net = getNetwork();
      if (isDryRun()) {
        return printFundsPlan({
          action: "deposit", venue: "qfex", network: net, asset: "USDC", amount: "(you choose)", chain: chainLabel(QFEX_WITHDRAW_NETWORK),
          method: `GET ${QFEX_BANKER_NETWORK} deposit address from the QFEX banker, then YOU send USDC to it from your wallet`,
        });
      }
      const adapter = await qfexAdapterFor(opts.agent);
      const addr = await adapter.depositAddress();
      const info = {
        venue: "qfex", network: net, address: addr.address, depositNetwork: addr.network, asset: addr.asset,
        minimum: null, confirmations: null,
        warning: "Send ONLY USDC on Arbitrum One to this address. Any other asset or network is lost. Minimum amount and confirmations: see the QFEX funding screen. Deposits credit the primary account.",
      };
      if (isJson()) return printJson(jsonOk(info));
      console.log(chalk.cyan.bold(`\n  QFEX deposit address (${net})\n`));
      console.log(`  Address: ${chalk.green(addr.address)}`);
      console.log(`  Network: ${addr.network} (Arbitrum One)   Asset: ${addr.asset}`);
      console.log(chalk.yellow(`\n  ${info.warning}`));
      console.log(chalk.gray("  perp-cli did not send anything — transfer from your own wallet or exchange.\n"));
    });

  // ── Aster deposit / withdraw, Ondo deposit (OWS-master on-chain legs; address book refused) ──

  registerOnchainFundsCommands({
    program, funds, deposit, withdraw, isJson, isDryRun, getNetwork, getAdapterForExchange,
    requireMaster, printFundsPlan, failStatus: fundsFailStatus,
  });

  // ═══════════════════════════════════════════════════════
  //  TRANSFER (HL internal)
  // ═══════════════════════════════════════════════════════

  supportsDryRun(funds.command("transfer <amount> <destination>"))
    .description("Transfer USDC to another Hyperliquid account (internal, instant; the destination must be on the settings withdraw.hyperliquid allowlist), or — with -e qfex — between your QFEX accounts (destination: primary | <account uuid>; supports --dry-run)")
    .option("--from <account>", "QFEX only: source account (primary | <account uuid>; default: the account the key is bound to)")
    .option("--agent <name>", "QFEX only: imported key to use")
    .action(async (amount: string, destination: string, opts: { from?: string; agent?: string }) => {
      const amountNum = Number(parsePositiveDecimal(amount, "amount"));
      if (isNaN(amountNum) || amountNum <= 0) throw new Error("Invalid amount");
      const exchangeOpt = program.opts().exchange as string | undefined;
      // -e names a venue this command cannot move funds on: refuse instead of transferring on Hyperliquid.
      if (exchangeOpt !== undefined) {
        const def = getVenue(exchangeOpt);
        if (!def.roles.includes("account")) throw roleUnsupported(def, "transfer");
        if (def.id === "risex") throw unsupported("risex", "transfer", RISEX_FUNDS_APP_ONLY.reason, RISEX_FUNDS_APP_ONLY.remediation);
      }
      if (exchangeOpt !== undefined && getVenue(exchangeOpt).id === "qfex") {
        if (isDryRun()) {
          return printFundsPlan({ action: "transfer", venue: "qfex", network: getNetwork(), asset: "USDC", amount, from: opts.from ?? "the key's account", destination });
        }
        const adapter = await qfexAdapterFor(opts.agent);
        // "primary" is resolved from the venue's own account list (is_master) — never assumed.
        const accounts = await adapter.listAccounts();
        const resolve = (name: string): string => {
          if (name.toLowerCase() !== "primary") return name.toLowerCase();
          const primary = accounts.filter(a => a.isPrimary);
          if (primary.length !== 1) throw new PerpError("EXCHANGE_ERROR", `QFEX lists ${primary.length} primary accounts`, { exchange: "qfex" });
          return primary[0].accountId;
        };
        const from = resolve(opts.from === undefined ? adapter.accountId : opts.from);
        const to = resolve(destination);
        for (const id of [from, to]) {
          if (!accounts.some(a => a.accountId === id)) {
            throw new PerpError("INVALID_PARAMS", `QFEX account ${id} is not one of your accounts`, { remediation: `Your accounts: ${accounts.map(a => `${a.accountId}${a.isPrimary ? " (primary)" : ""}`).join(", ")}` });
          }
        }
        if (!isJson()) console.log(chalk.cyan(`\n  Transferring ${amount} USDC on QFEX: ${from} → ${to}...\n`));
        const result = await adapter.transferBetweenAccounts(amount, from, to);
        logExecution({ type: "bridge", exchange: "qfex", symbol: "USDC", side: "transfer", size: amount, status: "success", dryRun: false, meta: { action: "transfer", from, to } });
        if (isJson()) return printJson(jsonOk(result));
        console.log(chalk.green("  Transfer accepted by QFEX."));
        console.log(chalk.gray("  Verify both balances: perp account balance -e qfex\n"));
        return;
      }
      if (opts.from !== undefined || opts.agent !== undefined) {
        throw new PerpError("INVALID_PARAMS", "--from / --agent apply to QFEX transfers only", { remediation: "Add -e qfex, or drop the flags for a Hyperliquid transfer" });
      }
      // usdSend pays another account: the destination must pass settings.withdraw.hyperliquid
      // (allowlist + maxPerTx / maxPerDay, shared with withdrawals to non-owner addresses).
      const amountStr = parsePositiveDecimal(amount, "amount");
      const gateOf = (): import("../settings.js").WithdrawGate | null => {
        const g = loadSettings().withdraw.hyperliquid;
        return g === undefined ? null : g;
      };
      if (isDryRun()) {
        // The gate needs no key and no network: a dry run refuses exactly as the live send would.
        assertWithdrawAllowed("hyperliquid", getNetwork(), amountStr, destination, gateOf(), Date.now());
        return printFundsPlan({ action: "transfer", venue: "hyperliquid", network: getNetwork(), asset: "USDC", amount: String(amountNum), destination, withdrawGate: "passes (destination allowlisted in settings withdraw.hyperliquid, within maxPerTx / maxPerDay)" });
      }
      await requireMaster("hyperliquid", "Hyperliquid transfer");
      assertWithdrawAllowed("hyperliquid", getNetwork(), amountStr, destination, gateOf(), Date.now());

      // Not -e qfex → the Hyperliquid transfer (as the dry-run plan says): fetch it directly, independent of -e.
      const adapter = await getAdapterForExchange("hyperliquid");
      if (!isUsdTransferCapable(adapter)) throw new Error("hyperliquid venue did not produce a USD-transfer-capable adapter");

      if (!isJson()) console.log(chalk.cyan(`\n  Transferring $${formatUsd(amountNum)} USDC to ${destination}...\n`));

      // owner = null: every usdSend destination is gated (sending to another account is the point).
      const attempt = hyperliquidGateEnforce(getNetwork(), amountStr, destination, null, Date.now());
      let result: Awaited<ReturnType<typeof adapter.usdTransfer>>;
      try {
        result = await adapter.usdTransfer(amountNum, destination);
      } catch (err) {
        if (attempt !== null && isDefiniteOrderFailure(err)) forgetWithdrawAttempt(attempt);
        throw err;
      }

      if (isJson()) return printJson(jsonOk(result));
      console.log(chalk.green(`  Transfer complete!`));
      console.log(`  Amount: $${formatUsd(amountNum)} USDC`);
      console.log(`  To:     ${destination}\n`);
    });

  // ═══════════════════════════════════════════════════════
  //  INFO (combined deposit + withdraw)
  // ═══════════════════════════════════════════════════════

  funds
    .command("info")
    .description("Show deposit & withdrawal info, routes, and limits")
    .action(async () => {
      const hasRelay = await relayerAvailable();

      if (isJson()) {
        return printJson(jsonOk({
          relayer: hasRelay ? getRelayerUrl() : null,
          deposit: {
            pacifica: { chain: "Solana", token: "USDC", min: 10, gas: "SOL ~0.005", method: "on-chain program" },
            hyperliquid: { chain: "Arbitrum", token: "USDC", min: 5, gas: "ETH ~0.0001", method: "USDC transfer to Bridge2" },
            lighter: { chain: "Ethereum L1 / Arbitrum / Base / Avalanche", token: "USDC", min: "1 (L1) or 5 (CCTP)", gas: "$3-10 (L1), ~$0.01 (CCTP)", method: "deposit() or CCTP intent" },
            "lighter-rh": { chain: "Robinhood Chain", token: "USDG", min: 1, gas: "Robinhood Chain ETH", method: "approve + deposit() (mainnet only)" },
            qfex: { chain: "Arbitrum", token: "USDC", min: null, method: "address display only: perp funds deposit qfex, then send USDC from your wallet" },
            aster: { chain: "BNB Chain (default) / Arbitrum", token: "USDT (default) / USDC", min: null, gas: "BNB / Arbitrum ETH", method: "approve + vault depositFor(token, forAddress, amount, broker 1) (mainnet only)", command: "perp funds deposit aster <amount> [--chain bsc|arbitrum] [--asset USDT|USDC]" },
            ondo: { chain: "Arbitrum (default) / Ethereum", token: "USDC", min: null, gas: "ETH", method: "USDC transfer to the account's funding address (mainnet only)", command: "perp funds deposit ondo <amount> [--chain arbitrum|ethereum] [--probe <amount>]" },
            risex: { supported: false, note: `${RISEX_FUNDS_APP_ONLY.reason} — ${RISEX_FUNDS_APP_ONLY.remediation}`, testnet: getVenue("risex").roles.includes("trading") ? "perp -n testnet funds faucet risex (1000 test USDC, once)" : null },
            txflow: { supported: false, note: "TxFlow is market data only in perp-cli" },
            variational: { supported: false, note: VARIATIONAL_READ_ONLY_REMEDIATION },
            grvt: { supported: false, note: "GRVT is read-only (market data) in this version; trading is planned for a later release" },
            extended: { supported: false, note: EXTENDED_READ_ONLY_REMEDIATION },
          },
          withdraw: {
            pacifica: { chain: "Solana", token: "USDC", speed: "~10s", fee: "none" },
            hyperliquid: { chain: "Arbitrum (default) / Ethereum / Base", token: "USDC", speed: "minutes (CCTP attestation)", method: "CCTP (sendToEvmWithData)", fee: await hlCctpFeeText(), command: "perp funds withdraw hyperliquid <amount> [--chain arbitrum|ethereum|base]" },
            lighter: { chain: "Ethereum L1", token: "USDC", speed: "~12 hours (standard), minutes (fast)", fee: "varies" },
            "lighter-rh": { chain: "Robinhood Chain", token: "USDG", command: "perp -e lighter-rh funds withdraw lighter <amount>" },
            ondo: { supported: false, note: "the Ondo Perps API does not allow withdrawals — withdraw in the Ondo Perps web app" },
            qfex: QFEX_WITHDRAW_ENABLED
              ? { chain: chainLabel(QFEX_WITHDRAW_NETWORK), token: "USDC", command: "perp funds withdraw qfex <amount> --to <allowlisted address>", gate: "settings withdraw.qfex (allowlist, maxPerTx, maxPerDay)", note: "needs a key with the \"Deposit and withdraw\" permission" }
              : { supported: false, note: `${QFEX_WITHDRAW_DISABLED.reason} — ${QFEX_WITHDRAW_DISABLED.remediation}` },
            arcus: { chain: "Robinhood Chain", token: "USDG", command: "perp funds withdraw arcus <amount>" },
            risex: { supported: false, note: `${RISEX_FUNDS_APP_ONLY.reason} — ${RISEX_FUNDS_APP_ONLY.remediation}` },
            txflow: { supported: false, note: "TxFlow is market data only in perp-cli" },
            variational: { supported: false, note: VARIATIONAL_READ_ONLY_REMEDIATION },
            grvt: { supported: false, note: "GRVT is read-only (market data) in this version; trading is planned for a later release" },
            extended: { supported: false, note: EXTENDED_READ_ONLY_REMEDIATION },
            aster: { chain: "BNB Chain (default) / Arbitrum", token: "USDT (default) / USDC", command: "perp funds withdraw aster <amount> [--chain bsc|arbitrum] [--asset USDT|USDC]", fee: "POST /fapi/v3/aster/user-withdraw-info (taken from the amount)", requires: "mainnet; API wallet approved with --can-withdraw --ip-whitelist; destination = the account's own address" },
          },
        }));
      }

      console.log(chalk.cyan.bold("\n  Funds — Deposit & Withdrawal Info\n"));

      if (hasRelay) {
        console.log(chalk.green("  ✓ Relayer available — gas-free deposits!\n"));
      } else {
        console.log(chalk.yellow("  ⚠ Relayer offline — deposits will cost gas.\n"));
        console.log(chalk.gray("    Start relayer: cd packages/relayer && pnpm start\n"));
      }

      // Deposit info
      console.log(chalk.white.bold("  ── Deposit ──\n"));

      console.log(chalk.white.bold("  Pacifica") + chalk.gray(" (Solana)"));
      console.log(`  Token:   USDC  |  Min: $10  |  Gas: ${hasRelay ? chalk.green("FREE") : "SOL ~0.005"}`);
      console.log(`  Command: ${chalk.green("perp funds deposit pacifica <amount>")}`);

      console.log(chalk.white.bold("\n  Hyperliquid") + chalk.gray(" (Arbitrum)"));
      console.log(`  Token:   USDC  |  Min: $5   |  Gas: ${hasRelay ? chalk.green("FREE") : "ETH ~0.0001"}`);
      console.log(`  Command: ${chalk.green("perp funds deposit hyperliquid <amount>")}`);

      console.log(chalk.white.bold("\n  Lighter") + chalk.gray(" (Ethereum L1 / CCTP)"));
      console.log(`  Token:   USDC  |  Min: 1 (L1), 5 (CCTP)`);
      console.log(`  L1:      ${chalk.green("perp funds deposit lighter ethereum <amount>")} — gas $3-10+`);
      console.log(`  CCTP:    ${chalk.green("perp funds deposit lighter cctp <chain> <amount>")} — gas ~$0.01`);
      console.log(`  Chains:  arbitrum, base, avalanche`);

      console.log(chalk.white.bold("\n  Lighter RH") + chalk.gray(" (Robinhood Chain)"));
      console.log(`  Token:   USDG  |  Min: 1  |  Gas: Robinhood Chain ETH (mainnet only)`);
      console.log(`  Command: ${chalk.green("perp funds deposit lighter-rh <amount>")}`);

      console.log(chalk.white.bold("\n  Aster") + chalk.gray(" (BNB Chain / Arbitrum vault contract)"));
      console.log(`  Token:   USDT (default) or USDC  |  Gas: BNB / Arbitrum ETH (mainnet only)`);
      console.log(`  Command: ${chalk.green("perp funds deposit aster <amount> [--chain bsc|arbitrum] [--asset USDT|USDC]")}`);

      console.log(chalk.white.bold("\n  Ondo Perps") + chalk.gray(" (Arbitrum / Ethereum — USDC transfer to your funding address)"));
      console.log(`  Token:   USDC  |  Gas: ETH (mainnet only)`);
      console.log(`  Command: ${chalk.green("perp funds deposit ondo <amount> [--chain arbitrum|ethereum] [--probe <amount>]")}`);

      // Withdraw info
      console.log(chalk.white.bold("\n  ── Withdraw ──\n"));

      console.log(chalk.white.bold("  Pacifica") + chalk.gray(" → Solana"));
      console.log(`  Speed: ~10s  |  Fee: none`);
      console.log(`  Command: ${chalk.green("perp funds withdraw pacifica <amount>")}`);

      console.log(chalk.white.bold("\n  Hyperliquid") + chalk.gray(" → Arbitrum (default) / Ethereum / Base over CCTP"));
      console.log(`  Fee: ${await hlCctpFeeText()}`);
      console.log(`  Command: ${chalk.green("perp funds withdraw hyperliquid <amount> [--chain arbitrum|ethereum|base]")}`);

      console.log(chalk.white.bold("\n  Lighter") + chalk.gray(" → Ethereum L1"));
      console.log(`  Speed: ~12h (standard)  |  Fee: varies`);
      console.log(`  Command: ${chalk.green("perp -e lt funds withdraw lighter <amount>")}`);

      console.log(chalk.white.bold("\n  Lighter RH") + chalk.gray(" → Robinhood Chain (USDG)"));
      console.log(`  Command: ${chalk.green("perp -e lighter-rh funds withdraw lighter <amount>")}`);

      console.log(chalk.white.bold("\n  Ondo Perps") + chalk.gray(" — not available over the API"));
      console.log(chalk.gray("  Withdraw in the Ondo Perps web app."));

      console.log(chalk.white.bold("\n  Arcus") + chalk.gray(" → Robinhood Chain (USDG, to the account owner)"));
      console.log(`  Command: ${chalk.green("perp funds withdraw arcus <amount>")}`);

      console.log(chalk.white.bold("\n  QFEX") + chalk.gray(QFEX_WITHDRAW_ENABLED ? ` → ${chainLabel(QFEX_WITHDRAW_NETWORK)} (USDC, allowlisted address)` : " — disabled in perp-cli for now"));
      console.log(QFEX_WITHDRAW_ENABLED
        ? `  Command: ${chalk.green("perp funds withdraw qfex <amount> --to <allowlisted address>")}`
        : chalk.gray(`  ${QFEX_WITHDRAW_DISABLED.remediation}.`));

      console.log(chalk.white.bold("\n  Aster") + chalk.gray(" → BNB Chain / Arbitrum (USDT, to the account's own address; mainnet only)"));
      console.log(`  Needs an API wallet approved with --can-withdraw --ip-whitelist; fee from user-withdraw-info`);
      console.log(`  Command: ${chalk.green("perp funds withdraw aster <amount> [--chain bsc|arbitrum] [--asset USDT|USDC]")}`);

      // Transfer + Bridge
      console.log(chalk.white.bold("\n  ── Transfer & Bridge ──\n"));

      console.log(chalk.white.bold("  Internal Transfer") + chalk.gray(" (Hyperliquid → Hyperliquid)"));
      console.log(`  Speed: instant  |  Fee: none`);
      console.log(`  Command: ${chalk.green("perp -e hl funds transfer <amount> <address>")}`);

      console.log(chalk.white.bold("\n  Cross-chain Bridge") + chalk.gray(" (multi-provider: cctp, relay, debridge)"));
      console.log(`  Routes:  Solana, Arbitrum, Base, Avalanche, Ethereum`);
      console.log(`  Quote:   ${chalk.green("perp funds bridge quote --from <chain> --to <chain> --amount <n>")}`);
      console.log(`  Send:    ${chalk.green("perp funds bridge send --from <chain> --to <chain> --amount <n>")}`);
      console.log(`  Between exchanges: ${chalk.green("perp funds bridge exchange --from <ex> --to <ex> --amount <n>")}`);

      console.log(chalk.white.bold("\n  Inter-exchange Rebalance") + chalk.gray(" (orchestrated withdraw → bridge → deposit)"));
      console.log(`  Check:   ${chalk.green("perp funds rebalance check")}`);
      console.log(`  Plan:    ${chalk.green("perp funds rebalance plan")}`);
      console.log(`  Execute: ${chalk.green("perp funds rebalance execute --auto-bridge")}`);

      console.log(chalk.gray("\n  Deposits are direct by default (you pay gas). Add --relay to use the gas-sponsoring relayer.\n"));
    });

  // ═══════════════════════════════════════════════════════
  //  NESTED SUBTREES — bridge (multi-provider) + rebalance
  // ═══════════════════════════════════════════════════════

  registerFundsBridgeCommands(funds, isJson, getNetwork);
  registerFundsRebalanceCommands(funds, getAdapterForExchange, isJson, getNetwork);
}
