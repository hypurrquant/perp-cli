import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { buildProgram } from "../cli-program.js";

/**
 * Source of truth for the top-level command groups registered by `perp`.
 *
 * Must be kept in sync with:
 *   1. src/index.ts — register* calls (the actual Commander tree)
 *   2. README.md   — "## Command Groups" markdown table
 *
 * The QA cycle on 2026-05-05 surfaced a v0.13.0 README ↔ Commander drift
 * (4 stale rows + 2 missing — `outcome` / `health`). This file is the
 * regression guard. Adding a top-level group should fail this test until
 * all three locations are updated.
 *
 * The list is hand-maintained (it fixes the README order); the last test checks it against the
 * visible top-level commands of the real Commander tree (buildProgram), so a new group cannot be
 * added without updating this list and the README.
 */
const KNOWN_TOP_LEVEL_GROUPS = [
  "market",
  "account",
  "trade",
  "outcome",
  "options",
  "arb",
  "strategy",
  "funds",
  "risk",
  "wallet",
  "history",
  "portfolio",
  "health",
  "settings",
  "backtest",
  "background",
  "alerts",
  "setup",
] as const;

function parseReadmeCommandGroupsTable(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const readmePath = resolve(here, "..", "..", "README.md");
  const md = readFileSync(readmePath, "utf-8");

  const tableStart = md.indexOf("## Command Groups");
  if (tableStart < 0) {
    throw new Error("README.md: '## Command Groups' section not found");
  }
  // Section ends at the next ## heading
  const tableEnd = md.indexOf("\n## ", tableStart + "## Command Groups".length);
  const section = md.slice(tableStart, tableEnd > 0 ? tableEnd : undefined);

  // Row format: `| \`name\` | description |`
  const rowRe = /^\|\s*`(\w+)`\s*\|/gm;
  const groups: string[] = [];
  for (const m of section.matchAll(rowRe)) {
    groups.push(m[1]);
  }
  return groups;
}

describe("README ↔ command-group sync (Section 9 — docs cannot drift from CLI)", () => {
  it("README 'Command Groups' table covers exactly the known top-level groups", () => {
    const readmeGroups = parseReadmeCommandGroupsTable().sort();
    const knownGroups = [...KNOWN_TOP_LEVEL_GROUPS].sort();
    expect(readmeGroups).toEqual(knownGroups);
  });

  it("README table has no duplicate group rows", () => {
    const readmeGroups = parseReadmeCommandGroupsTable();
    expect(new Set(readmeGroups).size).toBe(readmeGroups.length);
  });

  it("README table lists groups in the SSOT order (subjective tone — change KNOWN_TOP_LEVEL_GROUPS together if reordering on purpose)", () => {
    // This is intentionally strict to prevent silent reshuffling that
    // would break agent docs and skill bundles relying on documented
    // ordering. Loosen to set comparison if a re-order is desired.
    const readmeGroups = parseReadmeCommandGroupsTable();
    expect(readmeGroups).toEqual([...KNOWN_TOP_LEVEL_GROUPS]);
  });

  it("the known groups are exactly the visible top-level commands of the CLI (hidden aliases excluded)", () => {
    const { program } = buildProgram({ defaultExchange: "pacifica", version: "test" });
    const visible = program.commands
      .filter(c => c.name() !== "help" && (c as unknown as { _hidden?: boolean })._hidden !== true)
      .map(c => c.name())
      .sort();
    expect(visible).toEqual([...KNOWN_TOP_LEVEL_GROUPS].sort());
  });
});
