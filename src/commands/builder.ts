/**
 * `perp wallet builder status|approve|revoke <venue>` — the one place a user inspects,
 * approves and revokes builder fees (src/exchanges/builder-fee.ts).
 *
 * Builder fees are OFF unless settings `builder.<venue>` is set, and the approve command
 * only ever approves exactly that configured builder and fee (never a value from argv),
 * after an explicit y/N (or --yes). Approvals are signed by the MASTER wallet (venue rule:
 * an agent / API wallet cannot sign them); without a master on this computer the command
 * stops with NO_SIGNER_AVAILABLE and tells the user to approve on the venue website.
 */

import { Command } from "commander";
import chalk from "chalk";
import { isDryRun, networkOf, supportsDryRun } from "../cli-flags.js";
import { PerpError } from "../errors.js";
import { loadSettings } from "../settings.js";
import { printJson, jsonOk, withJsonErrors } from "../utils.js";
import { resolvePassphrase } from "../agent-wallet/passphrase.js";
import { getVenue, networkConfig } from "../exchanges/venue.js";
import "../exchanges/venues/index.js";
import type { ExchangeAdapter } from "../exchanges/interface.js";
import type { Network, VenueId } from "../exchanges/venue-types.js";
import {
  BUILDER_FEE_CAPABILITIES, BUILDER_FEE_UNSUPPORTED, builderFeeUnsupported, builderFeeVenues, builderTargetOf, bpsToRate,
  feeText, hlMaxFeeRatePercent, requireBuilderCapability, requireFeeBps, resetBuilderApprovalCache,
  type BuilderApproval, type BuilderFeeCapability, type BuilderFeeKind, type BuilderTarget,
} from "../exchanges/builder-fee.js";

// ── Plan ──

export interface BuilderApprovalPlan {
  venue: VenueId;
  network: Network;
  /** Builder address (lowercase) or code — from settings builder.<venue>. */
  identity: string;
  /** null = feeKind "share" (QFEX): the user pays the normal venue fee, nothing extra. */
  feeBps: number | null;
  feeKind: BuilderFeeKind;
  /** null = feeKind "share". */
  capBps: number | null;
  /** "none" = the venue has no approval step (Ondo): nothing to sign. */
  approval: "master" | "none";
  /** The venue action that would be signed, and the fee value in the venue's own unit. */
  action: string | null;
  venueFeeValue: string | null;
  /** Master wallet that would sign (--master or settings owsActiveWallet); null = none on this computer. */
  master: string | null;
}

const APPROVE_ACTION: { readonly [K in VenueId]?: string } = {
  hyperliquid: "approveBuilderFee (HyperliquidTransaction:ApproveBuilderFee, user-signed)",
  pacifica: "approve_builder_code (POST /account/builder_codes/approve)",
  aster: "ApproveBuilder (POST /fapi/v3/approveBuilder, EIP-712 domain A)",
};

function venueFeeValue(venue: VenueId, feeBps: number): string {
  // HL: percent string ("0.01%" = 1 bp); Pacifica / Aster: decimal fraction ("0.0001" = 1 bp).
  return venue === "hyperliquid" ? hlMaxFeeRatePercent(feeBps) : bpsToRate(feeBps);
}

/** The configured target, or INVALID_PARAMS telling the user how to configure it. */
function configuredTarget(venue: VenueId): BuilderTarget {
  const target = builderTargetOf(loadSettings().builder, venue);
  if (target === null) {
    const cap = requireBuilderCapability(venue);
    throw new PerpError("INVALID_PARAMS", `No builder fee is configured for ${venue} (settings builder.${venue} is not set — builder fees are off)`, {
      remediation: `Configure it first (explicit opt-in): perp settings set builder.${venue} ${cap.feeKind === "share" ? "<uuid>" : `<${cap.identity}>,<feeBps>`}`,
    });
  }
  return target;
}

function assertNetworkSupported(venue: VenueId, cap: BuilderFeeCapability, network: Network): void {
  if (network === "testnet" && !cap.testnet) {
    throw new PerpError("CAPABILITY_UNSUPPORTED", `${venue} does not support builderFee on testnet — the testnet API documents no builder approval flow`, {
      venue, feature: "builderFee", reason: "no testnet builder approval flow", remediation: `Run on mainnet (-n mainnet)`,
    });
  }
}

export function builderApprovalPlan(venue: VenueId, network: Network, master: string | null): BuilderApprovalPlan {
  const cap = requireBuilderCapability(venue);
  assertNetworkSupported(venue, cap, network);
  const t = configuredTarget(venue);
  const masterName = master ?? (loadSettings().owsActiveWallet || null);
  return {
    venue, network, identity: t.identity, feeBps: t.feeBps, feeKind: cap.feeKind, capBps: cap.perpCapBps,
    approval: cap.approval,
    action: cap.approval === "none" ? null : APPROVE_ACTION[venue] ?? null,
    venueFeeValue: cap.approval === "none" ? null : venueFeeValue(venue, requireFeeBps(t)),
    master: cap.approval === "none" ? null : masterName,
  };
}

function requirePlanMaster(plan: BuilderApprovalPlan, verb: "approve" | "revoke"): string {
  if (plan.master === null) {
    throw new PerpError("NO_SIGNER_AVAILABLE", `Builder ${verb === "approve" ? "approval" : "revocation"} on ${plan.venue} is signed by the master wallet, and none is configured on this computer (no --master, settings.owsActiveWallet empty)`, {
      remediation: `${verb === "approve" ? "Approve" : "Revoke"} it on the ${getVenue(plan.venue).displayName} website (builder ${plan.identity}${verb === "approve" ? `, max fee ${plan.feeBps} bps` : ""}), or add the master wallet (perp wallet import --name <name>) and pass --master <name>.`,
    });
  }
  return plan.master;
}

// ── Venue signing ──

async function hlPostUserSigned(network: Network, master: string, passphrase: string, maxFeeRate: string, builder: string): Promise<unknown> {
  const { OwsEvmSigner } = await import("../signer/ows-evm.js");
  const { HL_USER_SIGNED } = await import("../exchanges/venues/hyperliquid.js");
  const { ethers } = await import("ethers");
  const signer = OwsEvmSigner.create(master, passphrase);
  const { hyperliquidChain, signatureChainIdHex, signatureChainId } = HL_USER_SIGNED[network];
  const nonce = Date.now();
  const builderLc = builder.toLowerCase();
  const sig = ethers.Signature.from(await signer.signTypedData(
    { name: "HyperliquidSignTransaction", version: "1", chainId: signatureChainId, verifyingContract: "0x0000000000000000000000000000000000000000" },
    {
      "HyperliquidTransaction:ApproveBuilderFee": [
        { name: "hyperliquidChain", type: "string" },
        { name: "maxFeeRate", type: "string" },
        { name: "builder", type: "address" },
        { name: "nonce", type: "uint64" },
      ],
    },
    { hyperliquidChain, maxFeeRate, builder: builderLc, nonce },
  ));
  const action = { type: "approveBuilderFee", hyperliquidChain, signatureChainId: signatureChainIdHex, maxFeeRate, builder: builderLc, nonce };
  const res = await fetch(`${networkConfig(getVenue("hyperliquid"), network).restUrl}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, nonce, signature: { r: sig.r, s: sig.s, v: sig.v }, vaultAddress: null }),
  });
  const text = await res.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = null; }
  if (!res.ok || body === null || (body as { status?: unknown }).status !== "ok") {
    throw new PerpError("EXCHANGE_ERROR", `Hyperliquid approveBuilderFee rejected (${res.status}): ${text.slice(0, 200)}`, {
      exchange: "hyperliquid",
      remediation: "The builder must hold ≥ 100 USDC perps account value, and the fee must be ≤ 0.1% — check the venue message above",
    });
  }
  return body;
}

function pacificaResult(raw: unknown, what: string): unknown {
  const r = raw as { success?: unknown; error?: unknown } | null;
  if (r === null || typeof r !== "object" || r.success === false || (r.error !== undefined && r.error !== null)) {
    throw new PerpError("EXCHANGE_ERROR", `Pacifica ${what} rejected: ${JSON.stringify(raw).slice(0, 200)}`, { exchange: "pacifica" });
  }
  return raw;
}

async function pacificaMaster(network: Network, master: string, passphrase: string) {
  const { OwsSolanaSigner } = await import("../signer/ows-solana.js");
  const { PacificaClient } = await import("../pacifica/index.js");
  const signer = OwsSolanaSigner.create(master, passphrase);
  // A fresh client: no agent_wallet field — the account (master) signs for itself.
  const client = new PacificaClient({ network });
  return { client, account: signer.getPublicKeyBase58(), sign: (m: Uint8Array) => signer.signMessage(m) };
}

async function asterMasterRequest(method: "POST" | "DELETE", path: string, master: string, passphrase: string, typed: (user: `0x${string}`, nonceMicros: number) => {
  domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; message: Record<string, unknown>;
}, params: [string, string][]): Promise<unknown> {
  const { OwsEvmSigner } = await import("../signer/ows-evm.js");
  const { ASTER_DOMAIN_A } = await import("../exchanges/aster-typed-data.js");
  const signer = OwsEvmSigner.create(master, passphrase);
  const user = signer.getAddress() as `0x${string}`;
  const nonceMicros = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  const td = typed(user, nonceMicros);
  const signature = await signer.signTypedData(td.domain, td.types, td.message);
  const qs = new URLSearchParams(Object.fromEntries([
    ...params,
    ["asterChain", "Mainnet"],
    ["user", user],
    ["nonce", String(nonceMicros)],
    ["signature", signature],
    ["signatureChainId", String(ASTER_DOMAIN_A.chainId)],
  ] as [string, string][]));
  const res = await fetch(`${networkConfig(getVenue("aster"), "mainnet").restUrl}${path}?${qs.toString()}`, {
    method,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "",
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = JSON.parse(text); } catch { /* non-JSON body: judged by status below */ }
  const code = body !== null && typeof body === "object" ? (body as { code?: unknown }).code : undefined;
  const ok = res.ok && (code === undefined || code === "000000" || code === 200 || (typeof code === "number" && code >= 0));
  if (!ok) {
    throw new PerpError("EXCHANGE_ERROR", `Aster ${method} ${path} rejected (${res.status}): ${text.slice(0, 200)}`, { exchange: "aster" });
  }
  return body;
}

/** Sign + send the master approval described by `plan` (settings target, never argv). */
export async function approveBuilderOnVenue(plan: BuilderApprovalPlan, passphrase: string): Promise<unknown> {
  const master = requirePlanMaster(plan, "approve");
  const fee = venueFeeValue(plan.venue, requireFeeBps(plan));
  let out: unknown;
  switch (plan.venue) {
    case "hyperliquid":
      out = await hlPostUserSigned(plan.network, master, passphrase, fee, plan.identity);
      break;
    case "pacifica": {
      const m = await pacificaMaster(plan.network, master, passphrase);
      out = pacificaResult(await m.client.approveBuilderCode({ builder_code: plan.identity, max_fee_rate: fee }, m.account, m.sign), "approve_builder_code");
      break;
    }
    case "aster": {
      const { buildApproveBuilderTypedData } = await import("../exchanges/aster-typed-data.js");
      out = await asterMasterRequest("POST", "/fapi/v3/approveBuilder", master, passphrase,
        (user, nonceMicros) => buildApproveBuilderTypedData({ builder: plan.identity, maxFeeRate: fee, user, nonceMicros, asterChain: "Mainnet" }) as never,
        [["builder", plan.identity], ["maxFeeRate", fee]]);
      break;
    }
    default:
      throw builderFeeUnsupported(plan.venue);
  }
  resetBuilderApprovalCache();
  return out;
}

/** Revoke the configured builder's approval (master-signed). */
export async function revokeBuilderOnVenue(plan: BuilderApprovalPlan, passphrase: string): Promise<unknown> {
  const master = requirePlanMaster(plan, "revoke");
  let out: unknown;
  switch (plan.venue) {
    case "pacifica": {
      const m = await pacificaMaster(plan.network, master, passphrase);
      out = pacificaResult(await m.client.revokeBuilderCode({ builder_code: plan.identity }, m.account, m.sign), "revoke_builder_code");
      break;
    }
    case "aster": {
      const { buildDelBuilderTypedData } = await import("../exchanges/aster-typed-data.js");
      out = await asterMasterRequest("DELETE", "/fapi/v3/builder", master, passphrase,
        (user, nonceMicros) => buildDelBuilderTypedData({ builder: plan.identity, user, nonceMicros, asterChain: "Mainnet" }) as never,
        [["builder", plan.identity]]);
      break;
    }
    case "hyperliquid":
      throw new PerpError("CAPABILITY_UNSUPPORTED", "hyperliquid does not support builderFeeRevoke — the venue docs define no revoke action for ApproveBuilderFee", {
        venue: "hyperliquid", feature: "builderFeeRevoke", reason: "no documented revoke action",
        remediation: "An approval alone charges nothing: a fee is paid only on orders that carry it. Stop perp-cli attaching it: perp settings unset builder.hyperliquid",
      });
    default:
      throw builderFeeUnsupported(plan.venue);
  }
  resetBuilderApprovalCache();
  return out;
}

// ── Status ──

export interface BuilderVenueStatus {
  venue: VenueId;
  supported: boolean;
  /** Why the venue has no builder fees (null when supported). */
  reason: string | null;
  capability: BuilderFeeCapability | null;
  configured: { identity: string; feeBps: number | null } | null;
  /** Venue approval read for the loaded account; null = not configured / unsupported / not applicable on this network. */
  approval: BuilderApproval | null;
  /** Whether the next perp order would carry the fee (configured + approved + network supported). */
  attaches: boolean;
}

export async function builderStatus(venue: VenueId, network: Network, getAdapter: ((v: string) => Promise<ExchangeAdapter>) | null): Promise<BuilderVenueStatus> {
  const cap = BUILDER_FEE_CAPABILITIES[venue];
  if (cap === null) {
    return { venue, supported: false, reason: BUILDER_FEE_UNSUPPORTED[venue] ?? null, capability: null, configured: null, approval: null, attaches: false };
  }
  const t = builderTargetOf(loadSettings().builder, venue);
  const base = { venue, supported: true, reason: null, capability: cap, configured: t === null ? null : { identity: t.identity, feeBps: t.feeBps } };
  if (t === null) return { ...base, approval: null, attaches: false };
  if (network === "testnet" && !cap.testnet) return { ...base, reason: `${venue} testnet has no builder-fee flow`, approval: null, attaches: false };
  if (cap.approval === "none") return { ...base, approval: { status: "approved", maxFeeBps: null }, attaches: true };
  let approval: BuilderApproval;
  if (getAdapter === null) {
    approval = { status: "unknown", reason: "no account adapter available" };
  } else {
    try {
      const adapter = await getAdapter(venue) as ExchangeAdapter & { builderApprovalOf?: (t: BuilderTarget) => Promise<BuilderApproval> };
      if (typeof adapter.builderApprovalOf !== "function") throw new Error(`${venue} adapter cannot read builder approvals`);
      approval = await adapter.builderApprovalOf(t);
    } catch (e) {
      // Shown to the user as "unknown" with the reason — a live order would skip the fee the same way.
      approval = { status: "unknown", reason: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ...base, approval, attaches: approval.status === "approved" };
}

// ── Commands ──

async function confirmConsent(plan: BuilderApprovalPlan, yes: boolean, json: boolean, verb: "approve" | "revoke"): Promise<void> {
  if (yes) return;
  if (json || process.stdin.isTTY !== true) {
    throw new PerpError("INVALID_PARAMS", `Builder ${verb} needs explicit confirmation`, {
      remediation: `Review with --dry-run, then re-run with --yes: perp${plan.network === "testnet" ? " -n testnet" : ""} wallet builder ${verb} ${plan.venue} --yes`,
    });
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const q = verb === "approve"
      ? `  Approve builder ${plan.identity} to charge ${plan.feeKind === "max" ? "up to " : ""}${plan.feeBps} bps on YOUR ${plan.venue} perp orders (cap ${plan.capBps} bps)? [y/N]: `
      : `  Revoke builder ${plan.identity} on ${plan.venue}? [y/N]: `;
    const a = (await rl.question(q)).trim().toLowerCase();
    if (a !== "y" && a !== "yes") throw new PerpError("INVALID_PARAMS", `Builder ${verb} cancelled — nothing was signed`);
  } finally {
    rl.close();
  }
}

async function masterPassphrase(flag: string | undefined): Promise<string> {
  const pp = await resolvePassphrase({ flag });
  if (pp !== null) return pp;
  const { promptHidden } = await import("./agent.js");
  return promptHidden("  Master wallet passphrase (hidden): ");
}

function printPlan(plan: BuilderApprovalPlan, verb: "approve" | "revoke", dryRun: boolean): void {
  console.log(chalk.cyan.bold(`\n  ${dryRun ? "[dry-run] " : ""}Builder ${verb} — ${getVenue(plan.venue).displayName} (${plan.network})\n`));
  console.log(`    Builder:   ${plan.identity}`);
  if (verb === "approve") {
    console.log(`    Fee:       ${plan.feeKind === "max" ? "up to " : ""}${plan.feeBps} bps per perp order (venue cap ${plan.capBps} bps)${plan.venueFeeValue !== null ? ` — sent as ${plan.venueFeeValue}` : ""}`);
  }
  console.log(`    Signs:     ${plan.action ?? "nothing (no approval step)"}`);
  console.log(`    Master:    ${plan.master ?? chalk.yellow("none on this computer")}`);
  console.log(chalk.gray("    Paid by you, on every perp order perp-cli sends while builder." + plan.venue + " is set (disable per run: --no-builder)."));
}

export function registerWalletBuilderCommands(
  wallet: Command,
  isJson: () => boolean,
  getAdapterForExchange: ((v: string) => Promise<ExchangeAdapter>) | null,
): void {
  const builder = wallet.command("builder").description("Builder fees (off by default): status / approve / revoke the builder configured in settings builder.<venue>");

  builder
    .command("status [venue]")
    .description("Builder-fee support, configuration and venue approval (all venues when omitted)")
    .action(async (venueArg: string | undefined, _opts: unknown, cmd: Command) => {
      await withJsonErrors(isJson(), async () => {
        const network = networkOf(cmd);
        const venues: VenueId[] = venueArg !== undefined ? [getVenue(venueArg).id] : [...builderFeeVenues(), ...(["lighter", "lighter-rh", "arcus", "risex", "txflow", "variational", "grvt"] as VenueId[])];
        const rows: BuilderVenueStatus[] = [];
        for (const v of venues) {
          const configured = builderTargetOf(loadSettings().builder, v) !== null;
          // Only read approvals for a configured builder (an unconfigured venue needs no account access).
          rows.push(await builderStatus(v, network, configured ? getAdapterForExchange : null));
        }
        if (isJson()) return printJson(jsonOk({ network, venues: rows }));
        console.log(chalk.cyan.bold(`\n  Builder fees (${network}) — off unless settings builder.<venue> is set\n`));
        for (const r of rows) {
          if (!r.supported) {
            console.log(`  ${r.venue.padEnd(12)} ${chalk.gray(`unsupported — ${r.reason}`)}`);
            continue;
          }
          const cfg = r.configured === null ? chalk.gray("not configured (off)") : `${r.configured.identity} ${feeText(r.configured)}`;
          const appr = r.approval === null ? (r.reason !== null ? chalk.gray(r.reason) : "")
            : r.approval.status === "approved" ? chalk.green(r.capability?.approval === "none" ? "no approval needed" : `approved (max ${r.approval.maxFeeBps} bps)`)
              : r.approval.status === "notApproved" ? chalk.yellow(`NOT approved (max ${r.approval.maxFeeBps ?? "none"}) — perp wallet builder approve ${r.venue}`)
                : r.approval.status === "aboveConsent" ? chalk.yellow(`approved max ${r.approval.maxFeeBps} bps is ABOVE the configured ${r.configured?.feeBps} bps — not attached; re-approve: perp wallet builder approve ${r.venue}`)
                  : chalk.yellow(`unknown — ${r.approval.reason}`);
          console.log(`  ${r.venue.padEnd(12)} ${cfg}  ${appr}${r.attaches ? chalk.green("  → attached") : ""}`);
        }
        console.log();
      });
    });

  supportsDryRun(
    builder
      .command("approve <venue>")
      .description("Approve the builder configured in settings builder.<venue> (master-signed; y/N or --yes; --dry-run prints the plan)")
      .option("--master <name>", "Master OWS wallet name (default: settings owsActiveWallet)")
      .option("--passphrase <pp>", "Master OWS passphrase (fallback: OWS_PASSPHRASE env / stdin / hidden prompt)")
      .option("--yes", "Confirm without the y/N prompt")
      .action(async (venueArg: string, opts: { master?: string; passphrase?: string; yes?: boolean }, cmd: Command) => {
        await withJsonErrors(isJson(), async () => {
          const network = networkOf(cmd);
          const venue = getVenue(venueArg).id;
          const plan = builderApprovalPlan(venue, network, opts.master ?? null);
          if (plan.approval === "none") {
            const info = { ...plan, approvalRequired: false, sent: false };
            if (isJson()) return printJson(jsonOk(info));
            console.log(chalk.green(`\n  ${getVenue(venue).displayName} has no builder approval step — ${plan.identity} (${feeText(plan)}) is ${plan.feeKind === "share" ? "attached to the trading connection as configured: your fills are attributed to it and you pay the normal fee" : "attached to perp orders as configured"}.`));
            console.log(chalk.gray(`  Stop it: perp settings unset builder.${venue} (or --no-builder per run)\n`));
            return;
          }
          if (isDryRun(cmd)) {
            if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, ...plan }));
            printPlan(plan, "approve", true);
            console.log(chalk.yellow("\n  Nothing signed or sent.\n"));
            return;
          }
          requirePlanMaster(plan, "approve");
          if (!isJson()) printPlan(plan, "approve", false);
          await confirmConsent(plan, opts.yes === true, isJson(), "approve");
          const merged = cmd.optsWithGlobals() as { passphrase?: string };
          const result = await approveBuilderOnVenue(plan, await masterPassphrase(merged.passphrase ?? opts.passphrase));
          if (isJson()) return printJson(jsonOk({ ...plan, sent: true, venueResponse: result }));
          console.log(chalk.green(`\n  Approved builder ${plan.identity} on ${plan.venue} (${plan.feeBps} bps). Check: perp wallet builder status ${plan.venue}\n`));
        });
      }),
  );

  supportsDryRun(
    builder
      .command("revoke <venue>")
      .description("Revoke the builder configured in settings builder.<venue> (master-signed; y/N or --yes)")
      .option("--master <name>", "Master OWS wallet name (default: settings owsActiveWallet)")
      .option("--passphrase <pp>", "Master OWS passphrase (fallback: OWS_PASSPHRASE env / stdin / hidden prompt)")
      .option("--yes", "Confirm without the y/N prompt")
      .action(async (venueArg: string, opts: { master?: string; passphrase?: string; yes?: boolean }, cmd: Command) => {
        await withJsonErrors(isJson(), async () => {
          const network = networkOf(cmd);
          const venue = getVenue(venueArg).id;
          const plan = builderApprovalPlan(venue, network, opts.master ?? null);
          if (plan.approval === "none") {
            throw new PerpError("CAPABILITY_UNSUPPORTED", `${venue} has no builder approval to revoke`, {
              venue, feature: "builderFeeRevoke", reason: "no approval step",
              remediation: `Stop attaching the builder code: perp settings unset builder.${venue}`,
            });
          }
          if (venue === "hyperliquid") return void (await revokeBuilderOnVenue(plan, ""));
          const revokePlan = { ...plan, action: venue === "pacifica" ? "revoke_builder_code (POST /account/builder_codes/revoke)" : "DelBuilder (DELETE /fapi/v3/builder, EIP-712 domain A)" };
          if (isDryRun(cmd)) {
            if (isJson()) return printJson(jsonOk({ dryRun: true, sent: false, ...revokePlan }));
            printPlan(revokePlan, "revoke", true);
            console.log(chalk.yellow("\n  Nothing signed or sent.\n"));
            return;
          }
          requirePlanMaster(revokePlan, "revoke");
          if (!isJson()) printPlan(revokePlan, "revoke", false);
          await confirmConsent(revokePlan, opts.yes === true, isJson(), "revoke");
          const merged = cmd.optsWithGlobals() as { passphrase?: string };
          const result = await revokeBuilderOnVenue(revokePlan, await masterPassphrase(merged.passphrase ?? opts.passphrase));
          if (isJson()) return printJson(jsonOk({ ...revokePlan, sent: true, venueResponse: result }));
          console.log(chalk.green(`\n  Revoked builder ${plan.identity} on ${plan.venue}. perp-cli no longer attaches it (approval missing); remove the setting with: perp settings unset builder.${venue}\n`));
        });
      }),
  );
}
