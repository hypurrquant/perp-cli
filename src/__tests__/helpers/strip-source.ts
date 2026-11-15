/**
 * Source-scanning helpers for the grep-guard tests (rule2-*-guard.test.ts).
 * No parser dependency: a small scanner that blanks comments and string/template text so a guard
 * never matches prose ("throw new Error(" inside a comment or a message), while keeping every
 * newline and offset so reported line numbers stay right.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "../../..");

/** Replace comments and the contents of '…' / "…" / `…` literals (template `${…}` code is kept) with spaces. */
export function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  const blank = (c: string) => (c === "\n" ? "\n" : " ");
  // Stack of template-literal brace depths so `${ … }` code is scanned as code again.
  const tpl: number[] = [];
  let braces = 0;
  let i = 0;
  const n = src.length;
  const scanTemplateText = () => {
    // inside a template literal's text part; stops at closing backtick or `${`
    while (i < n) {
      const c = src[i];
      if (c === "\\") { out.push(" ", blank(src[i + 1] ?? " ")); i += 2; continue; }
      if (c === "`") { out.push("`"); i++; return; }
      if (c === "$" && src[i + 1] === "{") { out.push("${"); i += 2; tpl.push(braces); braces++; return; }
      out.push(blank(c)); i++;
    }
  };
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { while (i < n && src[i] !== "\n") { out.push(" "); i++; } continue; }
    if (c === "/" && d === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out.push(blank(src[i])); i++; }
      out.push("  "); i += 2; continue;
    }
    if (c === "'" || c === '"') {
      out.push(c); i++;
      while (i < n && src[i] !== c && src[i] !== "\n") {
        if (src[i] === "\\") { out.push(" ", blank(src[i + 1] ?? " ")); i += 2; } else { out.push(" "); i++; }
      }
      if (i < n && src[i] === c) { out.push(c); i++; }
      continue;
    }
    if (c === "`") { out.push("`"); i++; scanTemplateText(); continue; }
    if (c === "{") braces++;
    if (c === "}") {
      braces--;
      if (tpl.length && tpl[tpl.length - 1] === braces) { tpl.pop(); out.push("}"); i++; scanTemplateText(); continue; }
    }
    out.push(c); i++;
  }
  return out.join("");
}

/** Production .ts files under `dir` (relative to repo root), skipping tests and node_modules. */
export function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "__tests__" || name === "node_modules") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
  };
  walk(join(ROOT, dir));
  return out.sort();
}

export const rel = (p: string): string => relative(ROOT, p).split("\\").join("/");
export const strippedSource = (p: string): string => stripCommentsAndStrings(readFileSync(p, "utf8"));
export const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

/** Text of the balanced `( … )` that starts at `open` (index of "("), or "" when unbalanced. */
export function balancedParens(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return "";
}

/** Compare per-file counts with a baseline; returns human-readable problems (empty = ok). */
export function ratchetProblems(actual: Record<string, number>, baseline: Record<string, number>, how: { raise: string; lower: string }): string[] {
  const problems: string[] = [];
  for (const f of new Set([...Object.keys(actual), ...Object.keys(baseline)])) {
    const a = actual[f] ?? 0, b = baseline[f] ?? 0;
    if (a > b) problems.push(`${f}: ${a} > baseline ${b} — ${how.raise}`);
    else if (a < b) problems.push(`${f}: ${a} < baseline ${b} — ${how.lower}`);
  }
  return problems;
}

/** The baseline literal to paste back, one file per line (merge-friendly). */
export const formatBaseline = (counts: Record<string, number>): string =>
  "{\n" + Object.entries(counts).filter(([, v]) => v > 0).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `  "${k}": ${v},`).join("\n") + "\n}";
