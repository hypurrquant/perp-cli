import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonOk, jsonError } from "../utils.js";

/**
 * Zod schema for the public `--json` envelope. This is the contract
 * external agents (MCP, Claude, scripts) parse against. Drift in `jsonOk`
 * / `jsonError` shape would silently break every consumer that pinned to
 * the old envelope.
 *
 * Adapted from `ApiResponse` in src/utils.ts. Keep these two definitions
 * in mental sync — when `ApiResponse` adds a field, add it here too.
 */
const MetaSchema = z.object({
  exchange: z.string().optional(),
  timestamp: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, "ISO-8601 timestamp"),
  duration_ms: z.number().optional(),
});

const ErrorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  status: z.number().optional(),
  retryable: z.boolean().optional(),
  retryAfterMs: z.number().optional(),
  remediation: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});

const EnvelopeOkSchema = z.object({
  ok: z.literal(true),
  data: z.unknown().optional(),
  meta: MetaSchema,
});

const EnvelopeErrSchema = z.object({
  ok: z.literal(false),
  error: ErrorPayloadSchema,
  meta: MetaSchema,
});

const EnvelopeSchema = z.union([EnvelopeOkSchema, EnvelopeErrSchema]);

describe("--json envelope contract — Zod schema guard for jsonOk/jsonError", () => {
  it("jsonOk with simple data validates against EnvelopeOk", () => {
    const out = jsonOk({ price: "100", size: "1.0" });
    expect(EnvelopeOkSchema.safeParse(out).success).toBe(true);
    expect(EnvelopeSchema.safeParse(out).success).toBe(true);
  });

  it("jsonOk with array data validates", () => {
    const out = jsonOk([1, 2, 3]);
    expect(EnvelopeOkSchema.safeParse(out).success).toBe(true);
  });

  it("jsonOk with null/undefined data validates", () => {
    expect(EnvelopeOkSchema.safeParse(jsonOk(null)).success).toBe(true);
    expect(EnvelopeOkSchema.safeParse(jsonOk(undefined)).success).toBe(true);
  });

  it("jsonOk emits an ISO-8601 timestamp in meta", () => {
    const out = jsonOk({});
    const parsed = MetaSchema.safeParse(out.meta);
    expect(parsed.success).toBe(true);
  });

  it("jsonOk merges optional meta (exchange, duration_ms)", () => {
    const out = jsonOk({ ok: 1 }, { exchange: "hyperliquid", duration_ms: 42 });
    expect(EnvelopeOkSchema.safeParse(out).success).toBe(true);
    expect(out.meta?.exchange).toBe("hyperliquid");
    expect(out.meta?.duration_ms).toBe(42);
  });

  it("jsonError validates against EnvelopeErr (minimal — code + message only)", () => {
    const out = jsonError("INVALID_PARAMS", "Side must be 0..9");
    expect(EnvelopeErrSchema.safeParse(out).success).toBe(true);
    expect(EnvelopeSchema.safeParse(out).success).toBe(true);
  });

  it("jsonError with the full agent-actionable payload validates", () => {
    const out = jsonError("RATE_LIMITED", "Too many requests", {
      status: 429,
      retryable: true,
      retryAfterMs: 8000,
      remediation: "Wait and retry; backoff implemented.",
      details: { endpoint: "/info" },
    });
    expect(EnvelopeErrSchema.safeParse(out).success).toBe(true);
    expect(out.error?.retryable).toBe(true);
    expect(out.error?.retryAfterMs).toBe(8000);
  });

  it("EnvelopeOk and EnvelopeErr are mutually exclusive on `ok`", () => {
    const ok = jsonOk({ x: 1 });
    const err = jsonError("X", "y");
    expect(EnvelopeErrSchema.safeParse(ok).success).toBe(false);
    expect(EnvelopeOkSchema.safeParse(err).success).toBe(false);
  });

  it("a malformed envelope (missing meta.timestamp) is rejected", () => {
    const malformed = { ok: true, data: {} } as unknown;
    expect(EnvelopeOkSchema.safeParse(malformed).success).toBe(false);
  });

  it("a malformed envelope (error without code) is rejected", () => {
    const malformed = { ok: false, error: { message: "no code" }, meta: { timestamp: new Date().toISOString() } };
    expect(EnvelopeErrSchema.safeParse(malformed).success).toBe(false);
  });

  it("the live outcome-view-shaped data validates as EnvelopeOk (Appendix B regression)", () => {
    // Snapshot of the live `perp --json outcome view 2 --depth 3` response
    // captured during the QA cycle on 2026-05-05. Any change to the
    // envelope shape that would break this real response should fail here.
    const liveResponse = {
      ok: true,
      data: {
        outcome: 2,
        name: "Recurring",
        description: "class:priceBinary|underlying:BTC|expiry:20260505-0600|targetPrice:79980|period:1d",
        class: "priceBinary",
        expiryMs: 1777960800000,
        msToExpiry: 4509344,
        period: "1d",
        underlying: {
          symbol: "BTC",
          source: "BTC",
          markPrice: "80718.5",
          targetPrice: 79980,
          gap: 738.5,
          gapPct: 0.9233558389597398,
          inTheMoney: "yes",
        },
        sides: [
          { side: 0, name: "Yes", encoding: 20, assetId: 100000020, mid: "0.965075", bids: [], asks: [], impliedProb: 0.965075 },
          { side: 1, name: "No", encoding: 21, assetId: 100000021, mid: "0.034925", bids: [], asks: [], impliedProb: 0.034925 },
        ],
        midSum: 1,
        serverTime: 1777956290656,
      },
      meta: { timestamp: new Date().toISOString() },
    };
    expect(EnvelopeOkSchema.safeParse(liveResponse).success).toBe(true);
  });
});
