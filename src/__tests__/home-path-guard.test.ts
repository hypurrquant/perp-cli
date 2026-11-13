/**
 * Guard: the home directory is resolved only in src/paths.ts.
 *
 * `resolve(process.env.HOME || "~", ".perp")` appeared in ~20 modules: with HOME unset
 * (cron, systemd, containers) settings, nonces, execution logs and the bot quarantine were
 * written under `./~/.perp` in the CWD (path.resolve does not expand "~"). os.homedir() call
 * sites resolved differently again (passwd fallback). Every path now goes through
 * perpPath() / owsPath(), which throw when no home is set. This test fails if a module
 * reads HOME or os.homedir() itself again.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWED = new Set(["paths.ts"]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "__tests__" ? [] : sourceFiles(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function offenders(pattern: RegExp): string[] {
  return sourceFiles(SRC)
    .map((f) => relative(SRC, f).split(sep).join("/"))
    .filter((rel) => !ALLOWED.has(rel))
    .flatMap((rel) => readFileSync(join(SRC, rel), "utf-8").split("\n")
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => pattern.test(line) && !/^\s*(\/\/|\*)/.test(line))
      .map(({ i }) => `${rel}:${i + 1}`));
}

describe("home directory resolution lives only in src/paths.ts", () => {
  it('no `HOME || "~"` / `HOME ?? "~"` fallback in src', () => {
    expect(offenders(/HOME["'\]]*\s*(\|\||\?\?)\s*["']~["']/)).toEqual([]);
  });

  it("no direct process.env.HOME read outside src/paths.ts", () => {
    expect(offenders(/process\.env(\.HOME\b|\[\s*["']HOME["']\s*\])/)).toEqual([]);
  });

  it("no os.homedir() call outside src/paths.ts", () => {
    expect(offenders(/\bhomedir\s*\(/)).toEqual([]);
  });
});
