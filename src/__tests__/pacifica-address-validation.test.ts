/**
 * Dogfood 0.15.1: Pacifica answers an EVM (or any non-Solana) address with `success: true, []`,
 * which reads as "no positions / orders / shares". Every Pacifica address path (account reads,
 * Print orders, vaults — CLI and MCP) now requires a base58 32-byte Solana public key and refuses
 * anything else with INVALID_PARAMS before a request is sent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { PacificaClient, requireSolanaAddress } from "../pacifica/client.js";
import { PerpError } from "../errors.js";

const SOL = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T"; // a 32-byte base58 public key
const EVM = "0x1234567890abcdef1234567890abcdef12345678";

function codeOf(fn: () => unknown): string | null {
  try { fn(); return null; } catch (e) { return e instanceof PerpError ? e.structured.code : `non-PerpError: ${String(e)}`; }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("requireSolanaAddress", () => {
  it("accepts a base58 32-byte public key (trimmed)", () => {
    expect(requireSolanaAddress(` ${SOL} `)).toBe(SOL);
  });

  it("refuses an EVM address with INVALID_PARAMS naming it", () => {
    expect(codeOf(() => requireSolanaAddress(EVM))).toBe("INVALID_PARAMS");
    try { requireSolanaAddress(EVM); } catch (e) { expect((e as PerpError).message).toMatch(/EVM address/); }
  });

  it("refuses base58-looking text that is not 32 bytes (the old character-class check let it through)", () => {
    const hexNoZero = "abcdef123456789abcdef123456789abcdef1234"; // 40 chars, all base58 characters
    expect(codeOf(() => requireSolanaAddress(hexNoZero))).toBe("INVALID_PARAMS");
    expect(codeOf(() => requireSolanaAddress(""))).toBe("INVALID_PARAMS");
  });
});

describe("PacificaClient: address parameters are checked before any request", () => {
  it("getPositions / getOrders / getAccount(EVM) → INVALID_PARAMS, nothing sent", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] })));
    vi.stubGlobal("fetch", fetchSpy);
    const c = new PacificaClient();
    for (const read of [() => c.getPositions(EVM), () => c.getOrders(EVM), () => c.getAccount(EVM), () => c.getEnvelope("/game/accounts", { account: EVM }), () => c.getEnvelope("/lake/get_deposit_whitelist", { lake: EVM })]) {
      await expect(read()).rejects.toMatchObject({ structured: { code: "INVALID_PARAMS" } });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("a Solana address goes through", async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ success: true, data: [] })));
    vi.stubGlobal("fetch", fetchSpy);
    await new PacificaClient().getPositions(SOL);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain(`account=${SOL}`);
  });
});
