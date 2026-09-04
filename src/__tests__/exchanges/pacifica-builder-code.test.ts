/**
 * builder_code must ride on EVERY order-creation endpoint.
 *
 * Pacifica changelog 2026-04-23: "Added `builder_code` parameter to all order
 * creation endpoints". market / limit / TWAP attached it; stop orders and
 * position TP/SL did not, so referral attribution was silently lost on those
 * paths. CLAUDE.md §7 treats unintended referral-code removal as a security
 * guard item, hence a dedicated regression test.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PacificaClient } from "../../pacifica/client.js";
import { BUILDER_CODE } from "../../pacifica/constants.js";

const BUILDER = "builder-code-under-test";

function makeClient() {
  const client = new PacificaClient({ network: "mainnet", builderCode: BUILDER });
  const post = vi.fn().mockResolvedValue({ success: true });
  (client as unknown as { post: unknown }).post = post;
  // signedBody hands the payload straight through to post(); capture what it built.
  (client as unknown as { signedBody: unknown }).signedBody = vi.fn(
    async (type: string, payload: Record<string, unknown>) => ({ type, ...payload }),
  );
  return { client, post };
}

const sign = async () => new Uint8Array(64);

describe("Pacifica builder_code coverage across order-creation endpoints", () => {
  let client: PacificaClient;
  let post: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ client, post } = makeClient());
  });

  it("createMarketOrder carries builder_code", async () => {
    await client.createMarketOrder({ symbol: "BTC" } as never, "acct", sign);
    expect(post.mock.calls[0][1].builder_code).toBe(BUILDER);
  });

  it("createLimitOrder carries builder_code", async () => {
    await client.createLimitOrder({ symbol: "BTC" } as never, "acct", sign);
    expect(post.mock.calls[0][1].builder_code).toBe(BUILDER);
  });

  it("createStopOrder carries builder_code", async () => {
    await client.createStopOrder({ symbol: "BTC" } as never, "acct", sign);
    expect(post.mock.calls[0][0]).toBe("/orders/stop/create");
    expect(post.mock.calls[0][1].builder_code).toBe(BUILDER);
  });

  it("setTPSL carries builder_code", async () => {
    await client.setTPSL({ symbol: "BTC" } as never, "acct", sign);
    expect(post.mock.calls[0][0]).toBe("/positions/tpsl");
    expect(post.mock.calls[0][1].builder_code).toBe(BUILDER);
  });

  it("falls back to the embedded PERPCLI builder code when none is configured", async () => {
    // CLAUDE.md §7: the embedded referral code must not be dropped by accident.
    // A client constructed without an explicit code still attributes to PERPCLI.
    const bare = new PacificaClient({ network: "mainnet" });
    const barePost = vi.fn().mockResolvedValue({ success: true });
    (bare as unknown as { post: unknown }).post = barePost;
    (bare as unknown as { signedBody: unknown }).signedBody = vi.fn(
      async (type: string, payload: Record<string, unknown>) => ({ type, ...payload }),
    );
    await bare.createStopOrder({ symbol: "BTC" } as never, "acct", sign);
    expect(barePost.mock.calls[0][1].builder_code).toBe(BUILDER_CODE);
  });
});
