/**
 * Review 2026-10-13, agent / wallet hardening:
 *  - Aster rotate: permissions + the IP-whitelist check run BEFORE any revoke (or passphrase read);
 *    canWithdraw is never inherited — only an explicit --can-withdraw grants it;
 *  - QFEX keys that can / may withdraw get a loud warning (import + wallet agent list);
 *  - subcommand --passphrase is hidden from help and warns when used;
 *  - ~/.perp/.env rewrites force mode 0600 (even when the old file was looser).
 * No network; HOME is isolated by the vitest setup file.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { Command } from "commander";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentMeta } from "../settings.js";

const { rotateVenueAgent, qfexWithdrawKeyWarning, deprecatedPassphraseOption, warnDeprecatedPassphrase } = await import("../commands/agent.js");
const { setAgent, getAgent } = await import("../agent-wallet/store.js");
const { setEnvVar, envFile } = await import("../commands/init.js");
const { registerSettingsCommands } = await import("../commands/settings.js");

afterEach(() => vi.restoreAllMocks());

function asterAgent(canWithdraw: boolean | null): AgentMeta {
  return {
    agentName: "rot", agentWalletName: "agent-aster-main", agentEvmAddress: "0x00000000000000000000000000000000000000a1",
    userEvmAddress: "0x00000000000000000000000000000000000000b2", masterWalletName: "main", owsApiKeyId: "", owsPolicyId: "",
    expiresAt: "2099-01-01T00:00:00Z", approvedAt: "2026-10-01T00:00:00Z",
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw },
    asterApprovalNonce: "", status: "active", network: "mainnet", source: "approved",
  };
}

const rotateParams = (over: Partial<Parameters<typeof rotateVenueAgent>[0]>) => ({
  exchange: "aster" as const, network: "mainnet" as const, agentNameToRotate: "rot", master: "main",
  passphrase: vi.fn(async () => null), expiresIn: "90d",
  canPerp: undefined, canSpot: undefined, canWithdraw: undefined, ipWhitelist: undefined, ...over,
});

describe("Aster agent rotate", () => {
  it("--can-withdraw without --ip-whitelist is refused before the passphrase is read or anything is revoked", async () => {
    setAgent("aster", asterAgent(true));
    const p = rotateParams({ canWithdraw: true });
    await expect(rotateVenueAgent(p)).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    expect(p.passphrase).not.toHaveBeenCalled();
    expect(getAgent("aster", "rot")).not.toBeNull(); // the old agent is untouched
  });

  it("an old agent with canWithdraw=true is NOT inherited: no flags → no IP-whitelist refusal (withdraw stays off)", async () => {
    setAgent("aster", asterAgent(true));
    const p = rotateParams({});
    // Gets past the permission / whitelist check to the passphrase (null → PASSPHRASE_REQUIRED), nothing revoked.
    await expect(rotateVenueAgent(p)).rejects.toMatchObject({ structured: { code: "PASSPHRASE_REQUIRED" } });
    expect(p.passphrase).toHaveBeenCalledTimes(1);
    expect(getAgent("aster", "rot")).not.toBeNull();
  });

  it("an unknown (null) withdraw permission is not inherited either", async () => {
    setAgent("aster", asterAgent(null));
    await expect(rotateVenueAgent(rotateParams({}))).rejects.toMatchObject({ structured: { code: "PASSPHRASE_REQUIRED" } });
  });
});

describe("QFEX withdraw-capable key warning", () => {
  const perms = (depositWithdraw: boolean | null) => ({ viewPositions: true, viewBalance: true, viewOrders: true, executeOrders: null, depositWithdraw });
  it("warns when the withdraw permission is present or unknown; recommends deleting the key", () => {
    expect(qfexWithdrawKeyWarning({ agentName: "fund", permissions: perms(null) })).toMatch(/MAY HAVE.*EMPTY passphrase.*revoke qfex fund --local-only/s);
    expect(qfexWithdrawKeyWarning({ agentName: "fund", permissions: perms(true) })).toMatch(/HAS the "Deposit and withdraw"/);
    expect(qfexWithdrawKeyWarning({ agentName: "trade", permissions: perms(false) })).toBeNull();
  });
});

describe("deprecated subcommand --passphrase", () => {
  it("is accepted, hidden from help, and warns on stderr when given on the command line", async () => {
    const seen: string[] = [];
    const prog = new Command().exitOverride();
    prog.command("x").addOption(deprecatedPassphraseOption()).hook("preAction", warnDeprecatedPassphrase)
      .action((opts: { passphrase?: string }) => { seen.push(String(opts.passphrase)); });
    expect(prog.commands[0].helpInformation()).not.toContain("--passphrase");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await prog.parseAsync(["node", "perp", "x", "--passphrase", "pp"]);
    expect(seen).toEqual(["pp"]);
    expect(err.mock.calls.map(c => String(c[0])).join("")).toMatch(/--passphrase on the command line is DEPRECATED/);
    err.mockClear();
    await prog.parseAsync(["node", "perp", "x"]);
    expect(err).not.toHaveBeenCalled();
  });
});

describe("~/.perp/.env rewrites are 0600", () => {
  const seed = () => {
    mkdirSync(resolve(envFile(), ".."), { recursive: true });
    writeFileSync(envFile(), "FOO=1\nBAR=2\n");
    chmodSync(envFile(), 0o644);
  };

  it("setEnvVar (perp setup) forces 0600 on an existing looser file", () => {
    seed();
    setEnvVar("BAZ", "3");
    expect(statSync(envFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile(), "utf-8")).toContain("BAZ=3");
  });

  it("settings env remove forces 0600 on an existing looser file", async () => {
    seed();
    const prog = new Command().exitOverride();
    prog.option("--json");
    registerSettingsCommands(prog, () => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await prog.parseAsync(["node", "perp", "--json", "settings", "env", "remove", "FOO"]);
    expect(existsSync(envFile())).toBe(true);
    expect(statSync(envFile()).mode & 0o777).toBe(0o600);
    expect(readFileSync(envFile(), "utf-8")).not.toContain("FOO=1");
  });
});
