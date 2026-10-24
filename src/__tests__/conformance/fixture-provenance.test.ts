/**
 * Provenance of the recorded fixtures (docs/TESTING.md §7.3-2: "New fixtures are recorded
 * (header `recordedWith`), not hand-written").
 *
 * 0.16.0 added 56 fixtures and 23 of them said nothing about where their bytes came from, so §9
 * ("fixture shapes not taken from real responses") could not be checked by anyone — the reviewer
 * had no way to tell a recording from a hand-written object (HIK-10). This test turns the
 * checklist line into a gate: every fixture either carries an in-file `recordedWith` header or is
 * listed in fixtures/PROVENANCE.json, and the manifest may not rot.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join, relative, sep } from "node:path";

const REPO = join(import.meta.dirname, "../../..");
const FIXTURES = join(REPO, "src/__tests__/fixtures");
const MANIFEST = join(FIXTURES, "PROVENANCE.json");

type Manifest = {
  recorded: Record<string, { recordedWith: string; evidence: string }>;
  legacyUnverified: string[];
};
const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;

/** Repo-relative paths (posix separators) of every fixture file, the manifest itself aside. */
function fixtureFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(d => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return fixtureFiles(p);
    if (!statSync(p).isFile()) return [];
    const rel = relative(REPO, p).split(sep).join("/");
    return rel === "src/__tests__/fixtures/PROVENANCE.json" ? [] : [rel];
  });
}

/** The first 3 KB is the header region: `recordedWith` is written at the top of a fixture. */
function hasInFileHeader(rel: string): boolean {
  const p = join(REPO, rel);
  const head = rel.endsWith(".gz") ? gunzipSync(readFileSync(p)).subarray(0, 3000).toString("utf8")
    : readFileSync(p, "utf8").slice(0, 3000);
  return head.includes("\"recordedWith\"");
}

const files = fixtureFiles(FIXTURES);

describe("every fixture declares where its bytes came from", () => {
  it("finds the fixture tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no fixture is unaccounted for — a new one must carry a header or a manifest entry", () => {
    const unaccounted = files.filter(f =>
      !hasInFileHeader(f) && manifest.recorded[f] === undefined && !manifest.legacyUnverified.includes(f));
    expect(unaccounted).toEqual([]);
  });

  it("the manifest does not rot: every path it names still exists", () => {
    const missing = [...Object.keys(manifest.recorded), ...manifest.legacyUnverified].filter(f => !files.includes(f));
    expect(missing).toEqual([]);
  });

  it("a fixture is declared once, not twice", () => {
    const both = Object.keys(manifest.recorded).filter(f => manifest.legacyUnverified.includes(f));
    expect(both).toEqual([]);
    const headerAndEntry = Object.keys(manifest.recorded).filter(hasInFileHeader);
    expect(headerAndEntry).toEqual([]);
  });

  it("the grandfather list stays frozen — it may shrink, never grow", () => {
    // 70 fixtures predate the manifest. HIK-10 established provenance for the 0.16.0 additions
    // only; raising this number means an undocumented fixture was added instead of recorded.
    expect(manifest.legacyUnverified.length).toBeLessThanOrEqual(70);
  });

  it.each(Object.entries(manifest.recorded))("%s states a method and cites its evidence", (_f, entry) => {
    expect(entry.recordedWith.length).toBeGreaterThan(40);
    expect(entry.evidence.length).toBeGreaterThan(20);
  });
});
