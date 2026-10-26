/**
 * Refusal invariant (docs/TESTING.md §5): every write / account path of a venue that lacks the
 * role refuses with CAPABILITY_UNSUPPORTED + remediation, as ONE JSON document, before any I/O and
 * before any key is loaded (the venue's create() is never called) — also under --dry-run.
 *
 * Registry-driven generalization of the per-venue refusal tables (risex-read-only, txflow,
 * variational, grvt, extended tests): the venues come from listVenues() by role, the commands from
 * the templates below, so a new read-only venue is covered without writing a table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../exchanges/venues/index.js";
import { getVenue, listPublicPositionVenues, listVenues, type VenueRole } from "../../exchanges/venue.js";
import { ErrorEnvelope, issues } from "./contracts.js";
import { runCli } from "./harness.js";

/** `{v}` = the venue id, `{o}` = another venue that has every role. */
const TEMPLATES: Record<Exclude<VenueRole, "marketData">, string[][]> = {
  trading: [
    ["-e", "{v}", "trade", "market", "BTC", "buy", "0.001"],
    ["-e", "{v}", "trade", "buy", "BTC", "0.001"],
    ["-e", "{v}", "trade", "sell", "BTC", "0.001"],
    ["-e", "{v}", "trade", "limit", "BTC", "buy", "50000", "0.001"],
    ["-e", "{v}", "trade", "cancel", "BTC", "123"],
    ["-e", "{v}", "trade", "cancel-all"],
    ["-e", "{v}", "trade", "leverage", "BTC", "5"],
    ["-e", "{v}", "trade", "close", "BTC"],
    ["-e", "{v}", "trade", "close-all"],
    ["-e", "{v}", "trade", "tpsl", "BTC", "long", "--tp", "90000"],
    ["-e", "{v}", "trade", "stop", "BTC", "sell", "0.001", "70000"],
    ["-e", "{v}", "trade", "edit", "BTC", "123", "50000", "0.001"],
    ["-e", "{v}", "trade", "twap", "BTC", "buy", "0.01", "10m"],
    ["trade", "multi", "{v}:BTC:buy:0.001", "{o}:BTC:sell:0.001"],
    ["arb", "exec", "BTC", "{v}", "{o}", "10"],
    ["arb", "exec", "BTC", "{o}", "{v}", "10"],
    ["wallet", "agent", "approve", "{v}"],
    ["wallet", "agent", "import", "{v}"],
    ["wallet", "builder", "approve", "{v}"],
    ["-e", "{v}", "strategy", "twap", "BTC", "buy", "0.01", "10m"],
    ["-e", "{v}", "strategy", "grid", "BTC", "--upper", "90000", "--lower", "80000", "--grids", "5", "--size", "0.001"],
  ],
  account: [
    ["-e", "{v}", "account", "positions"],
    ["-e", "{v}", "account", "orders"],
    ["-e", "{v}", "account", "trades"],
    ["-e", "{v}", "portfolio"],
    ["funds", "deposit", "{v}", "10"],
    ["funds", "withdraw", "{v}", "10"],
    ["-e", "{v}", "funds", "transfer", "10", "0x0000000000000000000000000000000000000001"],
    ["funds", "rebalance", "execute", "--exchanges", "{v},{o}"],
  ],
};

/** A venue with every role, for the two-venue commands. */
const OTHER = "hyperliquid";

const READ_ONLY = listVenues().filter(v => !v.roles.includes("trading") || !v.roles.includes("account"));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async (u: unknown) => { throw new Error(`I/O before the refusal: ${String(u)}`); });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("read-only venues are derived from the registry", () => {
  it("covers every venue without the trading or account role (and only those)", () => {
    expect(READ_ONLY.map(v => v.id).sort()).toEqual(
      listVenues().filter(v => !(v.roles.includes("trading") && v.roles.includes("account"))).map(v => v.id).sort(),
    );
    expect(READ_ONLY.length).toBeGreaterThan(0);
  });
});

for (const def of READ_ONLY) {
  const missing = (["trading", "account"] as const).filter(r => !def.roles.includes(r));
  describe(`${def.id} (no ${missing.join(" / ")} role)`, () => {
    const cases = missing.flatMap(role => TEMPLATES[role]).map(t => t.map(a => a.replaceAll("{v}", def.id).replaceAll("{o}", OTHER)));
    for (const base of cases) {
      for (const argv of [base, ["--dry-run", ...base]]) {
        it(`perp ${argv.join(" ")} → CAPABILITY_UNSUPPORTED before I/O or key load`, async () => {
          const create = def.create === null ? null : vi.spyOn(getVenue(def.id), "create" as never);
          const r = await runCli(argv);
          expect(r.docs, "exactly one JSON document").toBe(1);
          expect(r.envelope.ok).toBe(false);
          const code = r.envelope.error!.code;
          // A command that cannot simulate is refused by the dry-run guard first — also before any I/O.
          if (argv[0] === "--dry-run" && code === "INVALID_PARAMS") expect(r.envelope.error!.message).toMatch(/--dry-run/);
          else {
            expect(code, r.envelope.error!.message).toBe("CAPABILITY_UNSUPPORTED");
            expect(issues(ErrorEnvelope, r.envelope), "refusal carries a remediation").toBe("");
          }
          expect(fetchMock).not.toHaveBeenCalled();
          if (create !== null) expect(create).not.toHaveBeenCalled();
        });
      }
    }
  });
}

/**
 * Keyless account reads on a venue WITH the account role: one typed refusal everywhere —
 * NO_SIGNER_AVAILABLE (or a venue-specific signer code) with remediation, never UNKNOWN / a 500
 * ("No private key configured" was a bare Error on hyperliquid / lighter / pacifica).
 */
const ACCOUNT_VENUES = listVenues().filter(v => v.roles.includes("account"));
const SIGNER_CODES = new Set(["NO_SIGNER_AVAILABLE", "KEY_NOT_FOUND", "AGENT_NOT_REGISTERED"]);
const CAPABILITY_CODES = new Set(["CAPABILITY_UNSUPPORTED"]);
/** Every `account` subcommand that reads the configured account (balance is a rename pointer; --address is public). */
const ACCOUNT_SUBCOMMANDS: string[][] = [["positions"], ["orders"], ["history"], ["settings"], ["trades"], ["funding-history"], ["margin", "BTC"], ["pnl"], ["twap-orders"]];
describe("keyless account reads refuse with a typed code on every account venue × every account subcommand", () => {
  // Public start-up reads a venue adapter makes before any account call (Aster server time, the
  // Lighter market directory) are answered minimally; any other request fails the cell.
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (u: unknown) => {
      const url = String(u);
      if (url.includes("/fapi/v3/time")) return new Response(JSON.stringify({ serverTime: Date.now() }), { status: 200 });
      if (url.includes("/api/v1/orderBooks")) return new Response(JSON.stringify({ code: 200, order_books: [{ symbol: "BTC", market_id: 1, market_type: "perp", status: "active", supported_size_decimals: 5, supported_price_decimals: 1 }] }), { status: 200 });
      throw new Error(`unexpected request before the refusal: ${url}`);
    }));
  });
  it("the registry has account venues", () => expect(ACCOUNT_VENUES.length).toBeGreaterThan(0));
  for (const def of ACCOUNT_VENUES) {
    for (const sub of ACCOUNT_SUBCOMMANDS) {
      // twap-orders on a venue without native TWAP answers NOT_SUPPORTED (exit 0) — its contract is
      // under review; the Pacifica cell (the account read) is checked.
      if (sub[0] === "twap-orders" && def.id !== "pacifica") continue;
      const argv = ["-e", def.id, "account", ...sub];
      it(`perp ${argv.join(" ")} (no key) → a typed refusal with remediation, never ok:true / UNKNOWN`, async () => {
        const r = await runCli(argv);
        expect(r.envelope.ok, "a keyless account read cannot succeed").toBe(false);
        const e = r.envelope.error!;
        // A venue without the feature refuses with its capability code; every other keyless read with a signer code.
        expect(SIGNER_CODES.has(e.code) || CAPABILITY_CODES.has(e.code), `${def.id}: ${e.code} ${e.message}`).toBe(true);
        expect(issues(ErrorEnvelope, r.envelope), "refusal carries a remediation").toBe("");
      });
    }
  }
});

/**
 * Public-address positions (`account positions --address`): registry-driven. A venue without
 * VenuePublicData.fetchPositionsByAddress refuses with CAPABILITY_UNSUPPORTED (feature
 * publicPositions, remediation naming the supporting venues); a supporting venue refuses an address
 * of the wrong format with INVALID_PARAMS — both before any request or key load.
 */
const PUBLIC_POSITION_VENUES = listPublicPositionVenues();
const EVM = "0x0000000000000000000000000000000000000001";
const SOL = "So11111111111111111111111111111111111111112";
describe("account positions --address: unsupported venues refuse before I/O (registry-driven)", () => {
  it("the registry has supporting venues, each with an address kind", () => {
    expect(PUBLIC_POSITION_VENUES.map(v => v.id).sort()).toEqual(["hyperliquid", "lighter", "lighter-rh", "pacifica", "risex"]);
    expect(PUBLIC_POSITION_VENUES.every(v => v.publicData.addressKind === "evm" || v.publicData.addressKind === "solana")).toBe(true);
  });
  const supported = new Set(PUBLIC_POSITION_VENUES.map(v => v.id));
  for (const def of listVenues().filter(v => !supported.has(v.id))) {
    it(`perp -e ${def.id} account positions --address … → CAPABILITY_UNSUPPORTED (publicPositions), nothing sent`, async () => {
      const create = def.create === null ? null : vi.spyOn(getVenue(def.id), "create" as never);
      const r = await runCli(["-e", def.id, "account", "positions", "--address", EVM]);
      expect(r.docs).toBe(1);
      expect(r.envelope.error?.code, r.envelope.error?.message).toBe("CAPABILITY_UNSUPPORTED");
      expect(r.envelope.error?.message).toMatch(/publicPositions/);
      expect(String(r.envelope.error?.remediation)).toContain([...supported].sort()[0]);
      expect(issues(ErrorEnvelope, r.envelope)).toBe("");
      expect(fetchMock).not.toHaveBeenCalled();
      if (create !== null) expect(create).not.toHaveBeenCalled();
    });
  }
});

describe("account positions --address: a wrong address format is INVALID_PARAMS before I/O", () => {
  const wrong = (kind: string | undefined): string[] => (kind === "solana" ? [EVM, "not-an-address", "0x1234"] : [SOL, "not-an-address", "0x1234", `${EVM}00`]);
  for (const def of PUBLIC_POSITION_VENUES) {
    for (const addr of wrong(def.publicData.addressKind)) {
      it(`perp -e ${def.id} account positions --address ${addr} → INVALID_PARAMS naming the expected form`, async () => {
        const r = await runCli(["-e", def.id, "account", "positions", "--address", addr]);
        expect(r.docs).toBe(1);
        expect(r.envelope.error?.code, r.envelope.error?.message).toBe("INVALID_PARAMS");
        expect(r.envelope.error?.message).toMatch(def.publicData.addressKind === "solana" ? /base58 Solana address/ : /EVM 0x address/);
        expect(issues(ErrorEnvelope, r.envelope)).toBe("");
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }
  }
  it("--account-index on a venue with one account per address → INVALID_PARAMS, nothing sent", async () => {
    const r = await runCli(["-e", "hyperliquid", "account", "positions", "--address", EVM, "--account-index", "1"]);
    expect(r.envelope.error?.code).toBe("INVALID_PARAMS");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
