/**
 * Adapter construction for the pre-existing venues (pacifica / hyperliquid /
 * lighter / lighter-rh / aster) — the single creation path that replaced the
 * three copies in src/index.ts (getAdapter / _initWithOws / getAdapterForExchange)
 * and the MCP server's getOrCreateAdapter.
 *
 * Signer tiers, as before: agent (Tier 1) → OWS master (Tier 2) → raw PK (Tier 3).
 * Which tier signs a given request is still decided inside each adapter.
 *
 * Adapter modules are imported lazily so venue definitions stay cheap to load.
 */

import { PerpError } from "../../errors.js";
import type { AgentMeta } from "../../settings.js";
import type { ExchangeAdapter } from "../interface.js";
import type { VenueCreateContext, VenueCredentials } from "../venue.js";
import { resolveBuilderGate } from "../builder-fee.js";
import type { LighterVenueId } from "./lighter-family.js";

/**
 * Legacy-shaped agent meta (aster/hl/pac/lighter/lighter-rh), or null. An agent
 * registered on another network is never attached: --no-agent drops it,
 * otherwise AGENT_NOT_REGISTERED (a mainnet agent must not sign on testnet).
 */
async function legacyAgentOf(ctx: VenueCreateContext, creds: VenueCredentials, venue: string): Promise<AgentMeta | null> {
  const agent = creds.agent;
  if (agent === null) return null;
  if ("kind" in agent) {
    throw new PerpError("INVALID_PARAMS", `${venue}: agent meta of kind "${agent.kind}" cannot sign for this venue`);
  }
  const { agentNetworkOf, assertAgentNetwork } = await import("../../agent-wallet/store.js");
  if (ctx.noAgent && agentNetworkOf(venue, agent) !== ctx.network) return null;
  assertAgentNetwork(venue, agent, ctx.network);
  return agent;
}

/**
 * An imported agent (key created on the venue website) belongs to the master address on its
 * record. If a DIFFERENT master wallet is loaded, account reads would show that wallet while the
 * agent trades for its own master — refuse instead of mixing two accounts (Rule #2).
 */
async function assertImportedAgentMaster(venue: string, agent: AgentMeta, masterAddress: string): Promise<void> {
  const { agentSourceOf } = await import("../../agent-wallet/store.js");
  if (agentSourceOf(venue, agent) !== "imported") return;
  // Pacifica records the master as a Solana address (base58, case-sensitive); EVM venues as 0x hex.
  const recorded = venue === "pacifica" ? agent.userSolanaAddress : agent.userEvmAddress;
  if (recorded === undefined || recorded === "") {
    throw new PerpError("INVALID_PARAMS", `${venue} agent "${agent.agentName}" was imported without a master address`, {
      remediation: `Re-import it: perp wallet agent import ${venue} --agent-name ${agent.agentName} --master-address <master> --replace`,
    });
  }
  const same = venue === "pacifica" ? masterAddress === recorded : masterAddress.toLowerCase() === recorded.toLowerCase();
  if (same) return;
  throw new PerpError("INVALID_PARAMS", `${venue} agent "${agent.agentName}" was imported for master ${recorded}, but the loaded master wallet is ${masterAddress}`, {
    remediation: `Select the matching master (--ows <wallet>), or run with --no-agent to use ${masterAddress} directly`,
  });
}

function effectiveCredentials(ctx: VenueCreateContext): VenueCredentials {
  return ctx.readOnly
    ? { pk: null, owsWallet: null, owsPassphrase: null, owsKeyToken: ctx.credentials.owsKeyToken, agent: null }
    : ctx.credentials;
}

/** Passphrase that opens the OWS master wallet. resolveCredentials sets it whenever owsWallet is set. */
function owsMasterPassphrase(creds: VenueCredentials): string {
  if (creds.owsPassphrase === null) {
    throw new PerpError("PASSPHRASE_REQUIRED", `OWS wallet "${creds.owsWallet}" has no resolved passphrase`, {
      remediation: "Pass --passphrase, set OWS_PASSPHRASE, or --ows-key <token>",
    });
  }
  return creds.owsPassphrase;
}

// ── Pacifica ──

export async function createPacifica(ctx: VenueCreateContext): Promise<ExchangeAdapter> {
  const creds = effectiveCredentials(ctx);
  const { PacificaAdapter } = await import("../pacifica.js");
  const { parseSolanaKeypair } = await import("../../config.js");
  const { Keypair } = await import("@solana/web3.js");
  const { loadSettings } = await import("../../settings.js");
  const { OwsSolanaSigner } = await import("../../signer/ows-solana.js");

  let adapter: InstanceType<typeof PacificaAdapter>;
  if (creds.owsWallet !== null) {
    // Tier 2: OWS master. The keypair is unused for signing once a signer is injected.
    adapter = new PacificaAdapter(Keypair.generate(), ctx.network, true);
    adapter.setSigner(OwsSolanaSigner.create(creds.owsWallet, owsMasterPassphrase(creds)));
  } else if (creds.pk !== null) {
    adapter = new PacificaAdapter(parseSolanaKeypair(creds.pk), ctx.network, true);
  } else {
    // Read-only: no key material. index.ts:143 Keypair.generate() recorded as out of scope.
    adapter = new PacificaAdapter(Keypair.generate(), ctx.network, false);
  }
  const agent = await legacyAgentOf(ctx, creds, "pacifica");
  if (agent !== null && !ctx.noAgent) {
    // A loaded master (OWS / raw key) must be the master the imported agent was created for.
    if (creds.owsWallet !== null || creds.pk !== null) await assertImportedAgentMaster("pacifica", agent, adapter.publicKey);
    // Pacifica agent wallets are created with an empty passphrase (runPacApproveFlow).
    adapter.setAgentSigner(agent, OwsSolanaSigner.create(agent.agentWalletName, ""));
  }
  if (ctx.noAgent) adapter.setNoAgent(true);
  // Builder code: only settings builder.pacifica (off by default) + a confirmed approval.
  const pac = adapter;
  pac.builderFee = resolveBuilderGate("pacifica", ctx, loadSettings().builder, t => pac.builderApprovalOf(t), () => pac.publicKey);
  return adapter;
}

// ── Hyperliquid ──

export async function createHyperliquid(ctx: VenueCreateContext): Promise<ExchangeAdapter> {
  const creds = effectiveCredentials(ctx);
  const { HyperliquidAdapter } = await import("../hyperliquid.js");
  const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
  const isTestnet = ctx.network === "testnet";

  const adapter = new HyperliquidAdapter(creds.pk ?? undefined, isTestnet);
  if (ctx.hlDex !== null) adapter.setDex(ctx.hlDex);
  if (creds.owsWallet !== null) adapter.setSigner(OwsEvmSigner.create(creds.owsWallet, owsMasterPassphrase(creds)));
  const agent = await legacyAgentOf(ctx, creds, "hyperliquid");
  // No master on this machine (e.g. an agent imported from the HL website): account reads use the
  // master's public address from the agent record; the agent key signs trades.
  if (agent !== null && !ctx.noAgent && creds.owsWallet === null && creds.pk === null) adapter.setAddress(agent.userEvmAddress);
  await adapter.init();
  if (agent !== null && !ctx.noAgent && adapter.address) await assertImportedAgentMaster("hyperliquid", agent, adapter.address);

  // No implicit referral signing on creation (read-only paths share this path):
  // referral is the explicit `perp -e hyperliquid wallet manage referral set`.

  if (agent !== null) {
    // HL agent wallets are created with an empty passphrase (runHlApproveFlow).
    adapter.setAgentSigner(agent, OwsEvmSigner.create(agent.agentWalletName, ""));
  }
  if (ctx.noAgent) adapter.setNoAgent(true);
  // Builder fee: only settings builder.hyperliquid (off by default) + a confirmed master approval.
  const { loadSettings } = await import("../../settings.js");
  adapter.builderFee = resolveBuilderGate("hyperliquid", ctx, loadSettings().builder, t => adapter.builderApprovalOf(t), () => adapter.address);
  return adapter;
}

// ── Lighter family ──

export async function createLighterFamily(venue: LighterVenueId, ctx: VenueCreateContext): Promise<ExchangeAdapter> {
  const creds = effectiveCredentials(ctx);
  if (venue === "lighter-rh" && creds.pk !== null) {
    // The Lighter RH master key is an OWS wallet only — no env / raw-PK tier.
    throw new PerpError("NO_ENV_TIER", "Lighter RH does not accept a raw private key (env / --private-key / local wallet)", {
      remediation: "Import the key into OWS (perp wallet import, key via hidden prompt / stdin) and run with --ows <wallet>, or register an agent: perp wallet agent approve lighter-rh",
    });
  }
  const { LighterAdapter } = await import("../lighter.js");
  const { OwsEvmSigner } = await import("../../signer/ows-evm.js");

  const adapter = LighterAdapter.forVenue(venue, creds.pk ?? "", ctx.network === "testnet");
  if (creds.owsWallet !== null) adapter.setSigner(OwsEvmSigner.create(creds.owsWallet, owsMasterPassphrase(creds)));

  const agent = await legacyAgentOf(ctx, creds, venue);
  if (agent !== null && !ctx.noAgent) {
    if (typeof agent.accountIndex !== "number" || typeof agent.apiKeyIndex !== "number") {
      throw new PerpError("AGENT_NOT_REGISTERED", `${venue} agent "${agent.agentName}" has no accountIndex/apiKeyIndex`, {
        remediation: `perp wallet agent approve ${venue} --rotate`,
      });
    }
    // SSOT Rule #3: the agent L2 key lives only in the venue keystore.
    const { loadLighterFamilyKey } = await import("../../agent-wallet/lighter-keystore.js");
    adapter.setAgentSigner(agent, loadLighterFamilyKey(venue, ctx.network, agent.accountIndex, agent.apiKeyIndex, ""));
    // No master on this machine (e.g. an API key imported from the website): account reads use the
    // account owner's L1 address recorded on the agent; the API key signs trades.
    if (creds.owsWallet === null && creds.pk === null) adapter.setAddress(agent.userEvmAddress);
  }
  if (ctx.noAgent) adapter.setNoAgent(true);
  await adapter.init();
  if (agent !== null && !ctx.noAgent && adapter.address) await assertImportedAgentMaster(venue, agent, adapter.address);

  // No implicit referral signing on creation: `perp -e lighter wallet manage referral set`.
  return adapter;
}

// ── Aster ──

export async function createAster(ctx: VenueCreateContext): Promise<ExchangeAdapter> {
  const creds = effectiveCredentials(ctx);
  const { AsterAdapter } = await import("../aster.js");
  const adapter = new AsterAdapter(creds.pk ?? undefined, ctx.network === "testnet");
  await adapter.init();
  if (creds.owsWallet !== null) {
    const { OwsEvmSigner } = await import("../../signer/ows-evm.js");
    adapter.setMasterSigner(OwsEvmSigner.create(creds.owsWallet, owsMasterPassphrase(creds)));
  }
  const agent = await legacyAgentOf(ctx, creds, "aster");
  if (agent !== null) {
    const { agentSigningStrategyFor } = await import("../../agent-wallet/signing-strategy.js");
    const { agentSourceOf } = await import("../../agent-wallet/store.js");
    // Empty token = no OWS API-key policy gating (legacy behavior). An imported agent's OWS wallet
    // has no API key / policy and an empty passphrase, so it is always opened with "".
    const token = agentSourceOf("aster", agent) === "imported" ? "" : (creds.owsKeyToken ?? "");
    adapter.setAgent(agent, agentSigningStrategyFor(agent, token));
  }
  if (ctx.noAgent) adapter.setNoAgent(true);
  // Builder fee: only settings builder.aster (off by default) + a confirmed master approval.
  const { loadSettings } = await import("../../settings.js");
  adapter.builderFee = resolveBuilderGate("aster", ctx, loadSettings().builder, t => adapter.builderApprovalOf(t), () => adapter.userAddress);
  return adapter;
}
