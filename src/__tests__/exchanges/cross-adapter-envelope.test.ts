/**
 * Cross-adapter envelope consistency for the shared `parseFiniteVenueNumber`
 * helper introduced in Phase 2.1 and consumed by all 4 adapters.
 *
 * Each adapter-shape test (hyperliquid-toFinite / aster-toFinite /
 * pacifica-toFinite) asserts its own envelope locally. This file pins the
 * cross-cutting contract: all 4 adapters surface NaN/empty venue payloads
 * as `EXCHANGE_ERROR` tagged with the same `structured.details.exchange`
 * shape, so multi-DEX consumers (rebalance, portfolio, arb-scan) can
 * branch on a single error code regardless of which adapter raised.
 *
 * Phase 5 of qa/2026-05-16 follow-up.
 */
import { describe, it, expect } from "vitest";
import { parseFiniteVenueNumber } from "../../utils/numeric.js";
import { classifyError } from "../../errors.js";

const EXCHANGES = ["hyperliquid", "pacifica", "aster", "lighter"] as const;

describe("Cross-adapter envelope consistency for NaN venue payload", () => {
  it.each(EXCHANGES)("'%s' adapter surfaces EXCHANGE_ERROR with structured.details.exchange tag", (exchange) => {
    try {
      parseFiniteVenueNumber(NaN, "balance.equity", exchange);
      expect.fail(`expected throw for ${exchange}`);
    } catch (e) {
      const err = e as Error;
      const s = classifyError(err);
      expect(s.code, `${exchange} code`).toBe("EXCHANGE_ERROR");
      expect(s.message, `${exchange} message`).toMatch(/balance\.equity.*not a finite/);
      // The exchange tag must be present in structured.details for downstream
      // routing — classifyError preserves it from the PerpError constructor.
      expect(
        (s.details as { exchange?: string } | undefined)?.exchange,
        `${exchange} exchange tag`,
      ).toBe(exchange);
    }
  });

  it.each(EXCHANGES)("'%s' adapter surfaces EXCHANGE_ERROR for empty-string venue payload", (exchange) => {
    try {
      parseFiniteVenueNumber("", "balance.available", exchange);
      expect.fail(`expected throw for ${exchange}`);
    } catch (e) {
      const err = e as Error;
      const s = classifyError(err);
      expect(s.code, `${exchange} code`).toBe("EXCHANGE_ERROR");
      expect(s.message, `${exchange} message`).toMatch(/balance\.available.*empty string/);
      expect(
        (s.details as { exchange?: string } | undefined)?.exchange,
        `${exchange} exchange tag`,
      ).toBe(exchange);
    }
  });

  it("envelope shape is identical (same key set) across all 4 adapters", () => {
    const shapes = EXCHANGES.map((exchange) => {
      try {
        parseFiniteVenueNumber(NaN, "x", exchange);
        return null;
      } catch (e) {
        const s = classifyError(e as Error);
        return Object.keys(s).sort().join(",");
      }
    });
    // All 4 shapes must be equal — a future divergence (one adapter losing
    // a field, or gaining an extra one) would be visible here.
    const first = shapes[0];
    for (let i = 1; i < shapes.length; i++) {
      expect(shapes[i], `${EXCHANGES[i]} vs ${EXCHANGES[0]}`).toBe(first);
    }
  });
});
