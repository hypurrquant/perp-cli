#!/usr/bin/env node
/**
 * Sync skills/perp-cli/SKILL.md `metadata.version` and the install-guard
 * comment to package.json's version field. Run before publish so the bundled
 * skill metadata never drifts from the npm package version.
 *
 * Wired into the `prepublishOnly` script in package.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkgPath = resolve(root, "package.json");
const skillPath = resolve(root, "skills/perp-cli/SKILL.md");

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const skill = readFileSync(skillPath, "utf-8");

const updated = skill
  .replace(/^(\s*version:\s*)"[\d.]+"/m, `$1"${pkg.version}"`)
  .replace(/(must be >= )[\d.]+/g, `$1${pkg.version}`);

if (updated === skill) {
  console.log(`[sync-skill-version] no changes (already at ${pkg.version})`);
} else {
  writeFileSync(skillPath, updated, "utf-8");
  console.log(`[sync-skill-version] SKILL.md synced to ${pkg.version}`);
}
