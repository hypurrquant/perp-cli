/**
 * perp-ws QA (0.15.0):
 *  B. `subscribe` after `close()` rejected INVALID_PARAMS "stream is closed" while the docs said "the
 *     close reason". CLIENT_CLOSE is not an error code, so the rejection stays INVALID_PARAMS and now
 *     carries `details.closeReason: "CLIENT_CLOSE"`; the docs say so.
 *  C. The code lived at `e.code` on error events but `err.structured.code` on `ready` rejections
 *     (`err.code` undefined). WsError gains `code` / `remediation` getters mirroring `structured`.
 */
import { describe, it, expect } from "vitest";
import { createVenueStream } from "../../ws/stream.js";
import { WsError } from "../../ws/errors.js";
import { arcus } from "../../ws/codecs/arcus.js";
import { ARCUS_ROUTES, fakeFetch, fakeTransport } from "./helpers.js";

describe("WsError code / remediation", () => {
  it("mirror structured (remediation null when none)", () => {
    const e = new WsError("SYMBOL_NOT_FOUND", "nope", { remediation: "list markets" });
    expect(e.code).toBe("SYMBOL_NOT_FOUND");
    expect(e.remediation).toBe("list markets");
    expect(new WsError("INVALID_PARAMS", "x").remediation).toBeNull();
    expect(e.structured.code).toBe("SYMBOL_NOT_FOUND"); // kept
  });
});

describe("subscribe after close()", () => {
  it("rejects INVALID_PARAMS with details.closeReason CLIENT_CLOSE; err.code works", async () => {
    const s = createVenueStream(arcus, { transport: fakeTransport().factory, fetch: fakeFetch(ARCUS_ROUTES), visibility: null });
    await s.close();
    const sub = s.subscribe({ kind: "allMarkets" });
    const err = await sub.ready.then(() => null, (e: unknown) => e) as WsError;
    expect(err).toBeInstanceOf(WsError);
    expect(err.code).toBe("INVALID_PARAMS");
    expect(err.structured.details).toEqual({ closeReason: "CLIENT_CLOSE" });
  });
});
