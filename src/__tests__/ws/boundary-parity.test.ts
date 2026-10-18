/**
 * perp-cli/ws structural guards (plan ws-0.14.4 §4.7, §8): the import boundary (src/ws imports only
 * src/ws), parity of the local copies (venue ids, error codes, URLs, funding intervals) with the CLI
 * sources, and the no-placeholder grep (§3: no `?? 0` / `|| 0` / `?? ""` on venue data).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VENUE_IDS as CLI_VENUE_IDS } from "../../exchanges/venue-types.js";
import { ALL_VENUES } from "../../exchanges/venues/index.js";
import { ERROR_CODES } from "../../errors.js";
import { VENUE_IDS as WS_VENUE_IDS } from "../../ws/ids.js";
import { WS_ERROR_CODES } from "../../ws/errors.js";
import { VENUE_STATIC } from "../../ws/venue-static.js";
import { hyperliquid } from "../../ws/codecs/hyperliquid.js";
import { pacifica } from "../../ws/codecs/pacifica.js";
import { lighter, lighterRh } from "../../ws/codecs/lighter.js";
import { aster } from "../../ws/codecs/aster.js";
import { arcus } from "../../ws/codecs/arcus.js";

const WS_DIR = resolve(import.meta.dirname, "../../ws");
const CODECS = [hyperliquid, pacifica, lighter, lighterRh, aster, arcus];

/**
 * CLI venues with no perp-cli/ws codec yet. Explicit and test-visible: ondo/qfex arrive in 0.15.1;
 * risex/txflow are CLI venues without a ws codec; variational documents no WebSocket at all;
 * grvt has per-instrument selectors only (no all-markets stream) and 150 concurrent streams < its 184 perps.
 */
const CLI_VENUES_WITHOUT_WS = ["ondo", "qfex", "risex", "txflow", "variational", "grvt"];

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? tsFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("import boundary", () => {
  it("src/ws/** imports only src/ws/** (node.ts may also import `ws` types and node:module)", () => {
    for (const file of tsFiles(WS_DIR)) {
      const src = readFileSync(file, "utf8");
      const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map(m => m[1]);
      for (const spec of specs) {
        const rel = relative(WS_DIR, file);
        if ((spec === "ws" || spec === "node:module") && rel === "node.ts") continue;
        expect(spec.startsWith("."), `${rel} imports "${spec}"`).toBe(true);
        const target = resolve(dirname(file), spec);
        expect(target.startsWith(WS_DIR), `${rel} imports "${spec}" outside src/ws`).toBe(true);
      }
    }
  });
});

describe("parity with the CLI", () => {
  it("every ws VenueId exists in the CLI registry (subset); CLI venues without WS are listed explicitly", () => {
    for (const id of WS_VENUE_IDS) expect(CLI_VENUE_IDS, id).toContain(id);
    const codecVenues = CODECS.map(c => c.venue);
    for (const v of codecVenues) expect(CLI_VENUE_IDS, v).toContain(v);
    for (const v of CLI_VENUE_IDS) {
      if ((codecVenues as readonly string[]).includes(v)) continue;
      expect(CLI_VENUES_WITHOUT_WS, `CLI venue "${v}" has no ws codec — add it to CLI_VENUES_WITHOUT_WS`).toContain(v);
    }
    for (const v of CLI_VENUES_WITHOUT_WS) expect(codecVenues).not.toContain(v);
  });

  it("WsErrorCode ⊂ ErrorCode with the same status / retryable", () => {
    for (const [code, v] of Object.entries(WS_ERROR_CODES)) {
      const cli = (ERROR_CODES as Record<string, { status: number; retryable: boolean }>)[code];
      expect(cli, code).toBeDefined();
      expect({ status: cli.status, retryable: cli.retryable }, code).toEqual(v);
    }
  });

  it("WS / REST URLs match the venue definitions", () => {
    for (const codec of CODECS) {
      const def = ALL_VENUES.find(d => d.id === codec.venue)!;
      const st = VENUE_STATIC[codec.venue as keyof typeof VENUE_STATIC]!;
      for (const net of ["mainnet", "testnet"] as const) {
        const n = def.networks[net];
        expect(st.restUrl[net], `${codec.venue} ${net} rest`).toBe(n == null ? null : n.restUrl);
        expect(st.wsUrl[net], `${codec.venue} ${net} ws`).toBe(n == null ? null : n.wsUrl);
      }
    }
    expect(aster.url("mainnet")).toBe("wss://fstream.asterdex.com/stream"); // combined-stream path on the defined host
  });

  it("funding intervals match the CLI basis (Lighter WS is the documented per-1h exception)", () => {
    for (const codec of CODECS) {
      const def = ALL_VENUES.find(d => d.id === codec.venue)!;
      const st = VENUE_STATIC[codec.venue as keyof typeof VENUE_STATIC]!;
      expect(st.fundingVerified, codec.venue).toBe(def.fundingVerified);
      if (def.fundingRateBasis === "perMarket") {
        expect(st.rateIntervalHours, codec.venue).toBe("perMarket");
        expect(st.settlementIntervalHours, codec.venue).toBe("perMarket");
        continue;
      }
      expect(def.settlementIntervalHours, codec.venue).toBe(st.settlementIntervalHours);
      if (codec.venue === "lighter" || codec.venue === "lighter-rh") {
        // CLI basis = REST /api/v1/funding-rates (fraction per 8 h); WS values are percent per 1 h (Phase 0).
        expect(def.fundingRateBasis).toEqual({ kind: "perHours", hours: 8 });
        expect(st.rateIntervalHours).toBe(1);
        continue;
      }
      expect(def.fundingRateBasis, codec.venue).toEqual({ kind: "perHours", hours: st.rateIntervalHours });
    }
  });
});

describe("no placeholder defaults", () => {
  it("src/ws/** has no `?? 0`, `|| 0`, `?? \"\"`, `|| \"\"` or `?? []`", () => {
    const re = /\?\?\s*0(?![.\d])|\|\|\s*0(?![.\d])|\?\?\s*""|\|\|\s*""|\?\?\s*''|\|\|\s*''|\?\?\s*\[\]/;
    for (const file of tsFiles(WS_DIR)) {
      readFileSync(file, "utf8").split("\n").forEach((line, i) => {
        expect(re.test(line), `${relative(WS_DIR, file)}:${i + 1}: ${line.trim()}`).toBe(false);
      });
    }
  });
});
