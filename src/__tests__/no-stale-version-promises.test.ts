/**
 * Shipped text (source → runtime strings and .d.ts JSDoc, the skill, README, docs, package.json)
 * never promises a feature for a version that is already out (≤ the package version): "Planned for
 * 0.15.1", "arrives in 0.15.1", "until 0.15.1", "Not in this release (0.15.1)", "read-only in
 * 0.15.0" were all still shipped in 0.15.1. Say "planned, not yet available" instead.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

/** Phrases that promise (or date) a feature to a version. */
const PROMISE = /(planned for|arrives? in|ships? in|coming in|lands? in|until|not in this release|read-only in|known gap in|reserved for)\s*\(?\*{0,2}v?(\d+\.\d+\.\d+)/gi;

const cmp = (a: string, b: string): number => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "__tests__" || name === "node_modules") continue;
    if (statSync(p).isDirectory()) out.push(...files(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

const SHIPPED = [
  ...files(join(ROOT, "src"), /\.ts$/),
  ...files(join(ROOT, "skills"), /\.md$/),
  ...files(join(ROOT, "docs"), /\.md$/),
  join(ROOT, "README.md"),
  join(ROOT, "package.json"),
  join(ROOT, "packages/perp-ws/package.json"),
  // The published type declarations, when built (the JSDoc consumers read).
  ...["dist/ws/index.d.ts", "dist/ws/node.d.ts", "packages/perp-ws/dist/index.d.ts"].map(f => join(ROOT, f)).filter(f => { try { return statSync(f).isFile(); } catch { return false; } }),
];

describe(`no shipped text promises a version ≤ ${VERSION}`, () => {
  it("finds the shipped files", () => expect(SHIPPED.length).toBeGreaterThan(50));
  it("every version promise names a FUTURE version", () => {
    const stale: string[] = [];
    for (const f of SHIPPED) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(PROMISE)) {
        if (cmp(m[2], VERSION) <= 0) stale.push(`${f.slice(ROOT.length + 1)}: "${m[0]}"`);
      }
    }
    expect(stale).toEqual([]);
  });
});
