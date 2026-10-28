/**
 * `wallet agent approve risex --rotate` runs the new signer's checks before revoking the old one;
 * `wallet agent verify risex` fails (POLICY_DENIED) for an active signer that is not trading-only.
 * The RISEx agent module is mocked — no network, no OWS.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
// The RISEx trading code is shipped but switched off in 0.15.0 (read-only phase): enable it here.
vi.mock("../../exchanges/venues/risex-release.js", () => ({ RISEX_TRADING_ENABLED: true }));
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const preflight = vi.fn();
const revoke = vi.fn();
const verify = vi.fn();
const signerStatus = vi.fn();
vi.mock("../../exchanges/risex/agent.js", async (orig) => ({
  ...(await orig<typeof import("../../exchanges/risex/agent.js")>()),
  risexRotatePreflight: (...a: unknown[]) => preflight(...a),
  revokeRisexAgent: (...a: unknown[]) => revoke(...a),
  approveRisexAgent: vi.fn(async () => { throw new Error("approve must not run in this test"); }),
  verifyRisexAgent: (...a: unknown[]) => verify(...a),
  risexSignerStatus: (...a: unknown[]) => signerStatus(...a),
}));

import "../../exchanges/venues/index.js";
import { approveVenueAgent, verifyVenueAgent, type ApproveAgentParams } from "../../commands/agent.js";

const META = {
  kind: "risex", agentName: "perp-cli-risex", agentWalletName: "agent-risex-main",
  signerAddress: "0x00000000000000000000000000000000000000a1", accountAddress: "0x00000000000000000000000000000000000000b2",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  permissions: { tradingOnly: true, disabled: [0, 3, 4], verifiedAt: "2026-10-14T00:00:00Z" },
  network: "mainnet", approvedAt: "2026-10-14T00:00:00Z", source: "approved",
};

function writeMeta(meta: Record<string, unknown>): void {
  const dir = resolve(process.env.HOME as string, ".perp");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "settings.json"), JSON.stringify({ agents: { risex: { "perp-cli-risex": meta } } }));
}

const PARAMS: ApproveAgentParams = {
  venue: "risex", network: "mainnet", master: "main", agentName: null, expiresIn: "30d", canPerp: true, canSpot: false,
  canWithdraw: false, rotate: true, passphrase: "", apiKeyIndex: null, forceSlot: false, accountIndex: 0, aster: {}, ondoKey: null,
};

beforeEach(() => {
  preflight.mockReset(); revoke.mockReset(); verify.mockReset(); signerStatus.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (u: string) => { throw new Error(`unexpected network call: ${u}`); }));
});

describe("approve risex --rotate", () => {
  it("a failing pre-check (no gas / pins / maintenance) stops BEFORE the old signer is revoked", async () => {
    writeMeta(META);
    preflight.mockRejectedValue(Object.assign(new Error("no RISE-chain ETH"), {}));
    await expect(approveVenueAgent(PARAMS)).rejects.toThrow(/no RISE-chain ETH/);
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled();
  });
});

describe("approve risex --rotate: old signer status decides revoke vs local forget", () => {
  it("never registered (status 0) → not revoked on the venue, only forgotten locally", async () => {
    writeMeta({ ...META, permissions: { tradingOnly: false, disabled: [], verifiedAt: null } });
    preflight.mockResolvedValue(undefined);
    signerStatus.mockResolvedValue(0);
    await expect(approveVenueAgent(PARAMS)).rejects.toThrow(/approve must not run/);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("Active (status 1) → revoked before the new approve", async () => {
    writeMeta(META);
    preflight.mockResolvedValue(undefined);
    signerStatus.mockResolvedValue(1);
    revoke.mockResolvedValue({ txHash: "0x1" });
    await expect(approveVenueAgent(PARAMS)).rejects.toThrow(/approve must not run/);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe("verify risex", () => {
  it("active but not trading-only on chain → POLICY_DENIED", async () => {
    writeMeta(META);
    verify.mockResolvedValue({ status: 1, active: true, permissions: { 0: true, 1: true, 2: true, 3: true, 4: true }, tradingOnly: false, expired: false });
    await expect(verifyVenueAgent("risex", "mainnet", { master: null, passphrase: "" })).rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
  });

  it("a kept, unrestricted record (tradingOnly false) → POLICY_DENIED even if the chain read looks fine", async () => {
    writeMeta({ ...META, permissions: { tradingOnly: false, disabled: [], verifiedAt: null } });
    verify.mockResolvedValue({ status: 1, active: true, permissions: { 0: false, 1: false, 2: true, 3: false, 4: false }, tradingOnly: true, expired: false });
    await expect(verifyVenueAgent("risex", "mainnet", { master: null, passphrase: "" })).rejects.toMatchObject({ structured: { code: "POLICY_DENIED" } });
  });

  it("active and trading-only → registered", async () => {
    writeMeta(META);
    verify.mockResolvedValue({ status: 1, active: true, permissions: { 0: false, 1: false, 2: true, 3: false, 4: false }, tradingOnly: true, expired: false });
    const r = await verifyVenueAgent("risex", "mainnet", { master: null, passphrase: "" });
    expect(r.registered).toBe(true);
  });
});
