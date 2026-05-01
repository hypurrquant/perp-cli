/**
 * Unit tests for AsterAdapter three-tier signer routing (Step 3, AC-5/6/13/19/20).
 *
 * fetch is mocked globally. Agent/OWS/PK signers are stubbed.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// ── Shared stubs ──────────────────────────────────────────────────────────────

function makeAgentMeta(overrides: Partial<{
  agentEvmAddress: `0x${string}`;
  userEvmAddress: `0x${string}`;
  expiresAt: string;
}> = {}) {
  return {
    agentName: "test-agent",
    agentWalletName: "agent-aster-main",
    agentEvmAddress: (overrides.agentEvmAddress ?? "0xAgentAddr000000000000000000000000000000") as `0x${string}`,
    userEvmAddress: (overrides.userEvmAddress ?? "0xMasterAddr00000000000000000000000000000") as `0x${string}`,
    masterWalletName: "main",
    owsApiKeyId: "ows_key_test",
    owsPolicyId: "policy-test",
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(),
    approvedAt: new Date().toISOString(),
    permissions: { canPerpTrade: true, canSpotTrade: false, canWithdraw: false },
    asterApprovalNonce: "1000",
    status: "active" as const,
  };
}

function makeAgentStrategy(address = "0xAgentAddr000000000000000000000000000000") {
  return {
    getAddress: vi.fn().mockReturnValue(address),
    signTypedData: vi.fn().mockResolvedValue({
      signature: "0xAgentSignature",
      r: "0x00",
      s: "0x00",
      v: 27,
    }),
  };
}

function makeEvmSigner(address = "0xMasterAddr00000000000000000000000000000") {
  return {
    getAddress: vi.fn().mockReturnValue(address),
    signTypedData: vi.fn().mockResolvedValue("0xMasterSignature"),
    signMessage: vi.fn().mockResolvedValue("0x"),
  };
}

function makePkSigner(address = "0xPkAddr000000000000000000000000000000000") {
  return {
    getAddress: vi.fn().mockReturnValue(address),
    signTypedData: vi.fn().mockResolvedValue("0xPkSignature"),
    signMessage: vi.fn().mockResolvedValue("0x"),
  };
}

/** Returns a successful Aster order response */
function mockOrderResponse() {
  return {
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue({ code: "000000", orderId: "12345", status: "FILLED", executedQty: "0.1" }),
    text: vi.fn().mockResolvedValue(""),
    headers: { get: vi.fn().mockReturnValue(null) },
  };
}

/** Stub `fetch` globally and return the response mock */
function stubFetch(response: ReturnType<typeof mockOrderResponse>) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ── Import adapter after each mock setup ────────────────────────────────────

async function buildAdapter() {
  // Fresh import each test via re-import
  const { AsterAdapter } = await import("../../exchanges/aster.js");
  return AsterAdapter;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("AsterAdapter — three-tier signer routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default fetch stub — server time (init()) + order response
    const initResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ serverTime: Date.now() }),
      text: vi.fn().mockResolvedValue(""),
      headers: { get: vi.fn().mockReturnValue(null) },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(initResponse)   // init() ping
      .mockResolvedValue(mockOrderResponse()), // subsequent calls
    );
  });

  // ─── Test 1: Tier 1 selection ───────────────────────────────────────────────
  it("Tier 1 (agent) selected when agent registered and not expired", async () => {
    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    const meta = makeAgentMeta();
    const agentStrat = makeAgentStrategy(meta.agentEvmAddress);
    ast.setAgent(meta, agentStrat);

    await ast.marketOrder("BTC", "buy", "0.001");

    expect(ast.activeSignerTier).toBe("agent");
    expect(agentStrat.signTypedData).toHaveBeenCalled();
  });

  // ─── Test 2: Tier 2 selection ───────────────────────────────────────────────
  it("Tier 2 (master) selected when no agent configured", async () => {
    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    const masterSigner = makeEvmSigner();
    ast.setMasterSigner(masterSigner);

    await ast.marketOrder("BTC", "buy", "0.001");

    expect(ast.activeSignerTier).toBe("master");
    expect(masterSigner.signTypedData).toHaveBeenCalled();
  });

  // ─── Test 3: Tier 3 selection ───────────────────────────────────────────────
  it("Tier 3 (pk) selected when no agent or master, only PK configured", async () => {
    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    const pkSigner = makePkSigner();
    ast.setPkSigner(pkSigner);

    await ast.marketOrder("BTC", "buy", "0.001");

    expect(ast.activeSignerTier).toBe("pk");
    expect(pkSigner.signTypedData).toHaveBeenCalled();
  });

  // ─── Test 4: --no-agent bypass ──────────────────────────────────────────────
  it("--no-agent bypasses Tier 1; falls through to Tier 2 (master)", async () => {
    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    const meta = makeAgentMeta();
    const agentStrat = makeAgentStrategy(meta.agentEvmAddress);
    const masterSigner = makeEvmSigner();

    ast.setAgent(meta, agentStrat);
    ast.setMasterSigner(masterSigner);
    ast.setNoAgent(true);

    await ast.marketOrder("BTC", "buy", "0.001");

    expect(ast.activeSignerTier).toBe("master");
    expect(agentStrat.signTypedData).not.toHaveBeenCalled();
    expect(masterSigner.signTypedData).toHaveBeenCalled();
  });

  // ─── Test 5: NO_SIGNER_AVAILABLE ────────────────────────────────────────────
  it("throws NO_SIGNER_AVAILABLE with remediation when no tier configured", async () => {
    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    let err: unknown;
    try {
      await ast.marketOrder("BTC", "buy", "0.001");
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    const e = err as { structured?: { code: string; remediation?: string }; message: string };
    expect(e.structured?.code ?? "").toBe("NO_SIGNER_AVAILABLE");
    expect(e.structured?.remediation ?? "").toContain("perp wallet agent approve aster");
    expect(e.structured?.remediation ?? "").toContain("ASTER_PRIVATE_KEY");
  });

  // ─── Test 6: AGENT_EXPIRED when only Tier 1 available ──────────────────────
  it("throws AGENT_EXPIRED when agent expired and no master/pk available", async () => {
    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    const expiredMeta = makeAgentMeta({
      expiresAt: new Date(Date.now() - 1000).toISOString(), // already expired
    });
    const agentStrat = makeAgentStrategy(expiredMeta.agentEvmAddress);
    ast.setAgent(expiredMeta, agentStrat);

    let err: unknown;
    try {
      await ast.marketOrder("BTC", "buy", "0.001");
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    const e = err as { structured?: { code: string; remediation?: string } };
    expect(e.structured?.code ?? "").toBe("AGENT_EXPIRED");
    expect(e.structured?.remediation ?? "").toContain("perp wallet agent approve aster --rotate");
  });

  // ─── Test 7: AGENT_EXPIRED falls through to master when available ───────────
  it("expired agent falls through to Tier 2 (master) without error", async () => {
    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    const expiredMeta = makeAgentMeta({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const agentStrat = makeAgentStrategy(expiredMeta.agentEvmAddress);
    const masterSigner = makeEvmSigner();

    ast.setAgent(expiredMeta, agentStrat);
    ast.setMasterSigner(masterSigner);

    await ast.marketOrder("BTC", "buy", "0.001");

    // Should use master, not agent
    expect(masterSigner.signTypedData).toHaveBeenCalled();
    expect(agentStrat.signTypedData).not.toHaveBeenCalled();
  });

  // ─── Test 8: isReadOnly ──────────────────────────────────────────────────────
  it("isReadOnly returns true when no signer in any tier", async () => {
    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();
    expect(ast.isReadOnly).toBe(true);
  });

  it("isReadOnly returns false when agent configured", async () => {
    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();
    ast.setAgent(makeAgentMeta(), makeAgentStrategy());
    expect(ast.isReadOnly).toBe(false);
  });

  it("isReadOnly returns false when master signer configured", async () => {
    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();
    ast.setMasterSigner(makeEvmSigner());
    expect(ast.isReadOnly).toBe(false);
  });

  it("isReadOnly returns false when PK signer configured", async () => {
    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();
    ast.setPkSigner(makePkSigner());
    expect(ast.isReadOnly).toBe(false);
  });

  // ─── Test 9: Read methods work without any signer ───────────────────────────
  it("read-only methods (getMarkets, ticker) work without any signer", async () => {
    // getMarkets makes 3 parallel/sequential public calls:
    //  1. init() → /fapi/v1/time
    //  2. /fapi/v1/exchangeInfo → { symbols: [] }
    //  3. /fapi/v1/ticker/24hr → []
    //  4. /fapi/v1/premiumIndex → [] (non-critical, caught)
    const timeResp = { ok: true, status: 200, json: vi.fn().mockResolvedValue({ serverTime: Date.now() }), text: vi.fn().mockResolvedValue(""), headers: { get: vi.fn().mockReturnValue(null) } };
    const infoResp = { ok: true, status: 200, json: vi.fn().mockResolvedValue({ symbols: [] }), text: vi.fn().mockResolvedValue(""), headers: { get: vi.fn().mockReturnValue(null) } };
    const tickerResp = { ok: true, status: 200, json: vi.fn().mockResolvedValue([]), text: vi.fn().mockResolvedValue(""), headers: { get: vi.fn().mockReturnValue(null) } };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(timeResp)    // init()
      .mockResolvedValueOnce(infoResp)    // exchangeInfo
      .mockResolvedValueOnce(tickerResp)  // ticker/24hr
      .mockResolvedValue(tickerResp),     // premiumIndex (also array)
    );

    const AsterAdapter = await buildAdapter();
    const ast = new AsterAdapter(undefined, false);
    await ast.init();  // no signer configured

    // Should not throw for read-only operations
    await expect(ast.getMarkets()).resolves.toBeDefined();
  });

  // ─── Test 10: HMAC removal regression ───────────────────────────────────────
  it("HMAC code removed — aster.ts contains no HMAC/API-key references", () => {
    const asterSrc = readFileSync(
      resolve(process.cwd(), "src/exchanges/aster.ts"),
      "utf-8",
    );
    expect(asterSrc).not.toMatch(/createHmac/);
    expect(asterSrc).not.toMatch(/X-MBX-APIKEY/);
    expect(asterSrc).not.toMatch(/ASTER_API_KEY/);
    expect(asterSrc).not.toMatch(/ASTER_API_SECRET/);
    expect(asterSrc).not.toMatch(/_apiKey/);
    expect(asterSrc).not.toMatch(/_apiSecret/);
  });
});

// ── AC-19: remediation field on structured errors ──────────────────────────

describe("AsterAdapter — AC-19 remediation fields", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  function makeInitFetch() {
    const initResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ serverTime: Date.now() }),
      text: vi.fn().mockResolvedValue(""),
      headers: { get: vi.fn().mockReturnValue(null) },
    };
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(initResponse)
      .mockResolvedValue(mockOrderResponse()),
    );
  }

  it("NO_SIGNER_AVAILABLE error includes remediation with all three setup commands", async () => {
    makeInitFetch();
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    let err: unknown;
    try {
      await ast.marketOrder("BTC", "buy", "0.001");
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    const e = err as { structured?: { code: string; remediation?: string } };
    expect(e.structured).toBeDefined();
    const rem = e.structured?.remediation ?? "";
    // All three setup commands must appear
    expect(rem).toContain("perp wallet agent approve aster");
    expect(rem).toContain("--ows");
    expect(rem).toContain("ASTER_PRIVATE_KEY");
  });

  it("AGENT_EXPIRED error includes --rotate remediation", async () => {
    makeInitFetch();
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    const meta = makeAgentMeta({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    ast.setAgent(meta, makeAgentStrategy());

    let err: unknown;
    try {
      await ast.marketOrder("BTC", "buy", "0.001");
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    const e = err as { structured?: { code: string; remediation?: string } };
    expect(e.structured).toBeDefined();
    expect(e.structured?.code ?? "").toBe("AGENT_EXPIRED");
    expect(e.structured?.remediation ?? "").toContain("--rotate");
  });

  it("withdraw without master throws NO_SIGNER_AVAILABLE with remediation", async () => {
    makeInitFetch();
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    let err: unknown;
    try {
      await ast.withdraw("100", "0xDest");
    } catch (e) {
      err = e;
    }

    expect(err).toBeDefined();
    const e = err as { structured?: { code: string; remediation?: string } };
    expect(e.structured).toBeDefined();
    expect(e.structured?.code ?? "").toBe("NO_SIGNER_AVAILABLE");
    expect(e.structured?.remediation ?? "").toContain("--ows");
  });
});

// ── C1: Tier 2/3 user/signer field model ─────────────────────────────────────

describe("AsterAdapter — V3 user/signer field model in signed query string", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    const initResponse = {
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ serverTime: Date.now() }),
      text: vi.fn().mockResolvedValue(""),
      headers: { get: vi.fn().mockReturnValue(null) },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(initResponse));
  });

  it("Tier 1 (agent): emits user=master and signer=agent as distinct fields", async () => {
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    const meta = makeAgentMeta({
      userEvmAddress: "0xMasterAddr00000000000000000000000000000",
      agentEvmAddress: "0xAgentAddr000000000000000000000000000000",
    });
    ast.setAgent(meta, makeAgentStrategy(meta.agentEvmAddress));

    const resolved = ast._resolveSigner();
    const qs = await ast._buildSignedQueryString({ symbol: "BTCUSDT" }, resolved);
    const sp = new URLSearchParams(qs);

    expect(sp.get("user")).toBe(meta.userEvmAddress);
    expect(sp.get("signer")).toBe(meta.agentEvmAddress);
    expect(sp.get("user")).not.toBe(sp.get("signer"));
    expect(sp.get("signature")).toBeTruthy();
  });

  it("Tier 2 (master): emits user==signer (both fields present even when identical)", async () => {
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    const masterAddr = "0xMasterAddr00000000000000000000000000000";
    const masterSigner = makeEvmSigner(masterAddr);
    ast.setMasterSigner(masterSigner);

    const resolved = ast._resolveSigner();
    const qs = await ast._buildSignedQueryString({ symbol: "BTCUSDT" }, resolved);
    const sp = new URLSearchParams(qs);

    // Both fields MUST be present in the query string
    expect(qs).toContain("user=");
    expect(qs).toContain("signer=");
    expect(sp.get("user")).toBe(masterAddr);
    expect(sp.get("signer")).toBe(masterAddr);
    expect(sp.get("signature")).toBeTruthy();
  });

  it("Tier 3 (pk): emits user==signer (both fields present even when identical)", async () => {
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    const pkAddr = "0xPkAddr000000000000000000000000000000000";
    const pkSigner = makePkSigner(pkAddr);
    ast.setPkSigner(pkSigner);

    const resolved = ast._resolveSigner();
    const qs = await ast._buildSignedQueryString({ symbol: "BTCUSDT" }, resolved);
    const sp = new URLSearchParams(qs);

    expect(qs).toContain("user=");
    expect(qs).toContain("signer=");
    expect(sp.get("user")).toBe(pkAddr);
    expect(sp.get("signer")).toBe(pkAddr);
  });

  it("--no-agent + master: master self-signs (user==signer==master), NOT agent address", async () => {
    const { AsterAdapter } = await import("../../exchanges/aster.js");
    const ast = new AsterAdapter(undefined, false);
    await ast.init();

    const masterAddr = "0xMasterAddr00000000000000000000000000000";
    const meta = makeAgentMeta({ userEvmAddress: masterAddr });
    ast.setAgent(meta, makeAgentStrategy(meta.agentEvmAddress));
    ast.setMasterSigner(makeEvmSigner(masterAddr));
    ast.setNoAgent(true);

    const resolved = ast._resolveSigner();
    expect(resolved.tier).toBe("master");

    const qs = await ast._buildSignedQueryString({ symbol: "BTCUSDT" }, resolved);
    const sp = new URLSearchParams(qs);

    // When --no-agent bypasses Tier 1, master self-signs: both fields = master.
    expect(sp.get("user")).toBe(masterAddr);
    expect(sp.get("signer")).toBe(masterAddr);
  });
});
