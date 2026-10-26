# Releasing

Two npm packages are released together, **always with the same version**:

| Package | Directory | Contents |
|---|---|---|
| `perp-cli` | repository root | the CLI, MCP server, `perp-cli/ws` and `perp-cli/ws/node` |
| `@hypurrquant/perp-ws` | `packages/perp-ws` | the same `src/ws/**` built standalone (zero dependencies; `ws` is an optional peer) |

`scripts/sync-skill-version.mjs` keeps `skills/perp-cli/SKILL.md` and `packages/perp-ws/package.json` at
perp-cli's version. Syncing (write mode) is an **explicit release step** (step 1); CI and both
`prepublishOnly` hooks only run `--check` and refuse to publish on drift — a publish never rewrites files.

## Before the release: stale-content check

Version numbers, venue lists and MCP counts are written by hand in several files that no test reads.
Check each against the live values before step 1:

- [ ] **Venues**: `perp --json` → `data.venues` (ids, read-only / market-data-only roles)
- [ ] **MCP counts**: start `perp-mcp` and list them (`tools/list`, `resources/list`, `prompts/list`)
- [ ] `README.md` + `README.{ko,zh,ja}.md`: venue table, MCP tool count, commands still valid
- [ ] `docs/venues.md` support matrix, `docs/mcp.md` tool list + counts, `docs/verification.md` date
- [ ] `package.json` `description`; the GitHub repository description and topics
- [ ] `.claude-plugin/plugin.json` + `.claude-plugin/marketplace.json`: `version` (both fields), description, MCP counts
- [ ] `.cursorrules`, `mcp-config.example.json` (no private keys in an MCP config)
- [ ] `skills/perp-cli/SKILL.md` + `references/*.md` match the CLI (`--help`); skill `package.json` version
- [ ] CHANGELOG `[Unreleased]` lists every merged PR since the last tag (`git log v<last>..main --merges`)

## Steps

1. Bump the version in the root `package.json` (e.g. `0.15.0`), then sync (write mode — the only
   step that edits SKILL.md / `packages/perp-ws/package.json`) and commit the result:

   ```sh
   pnpm run sync-skill-version            # SKILL.md + packages/perp-ws/package.json
   node scripts/sync-skill-version.mjs --check
   ```

2. Move the CHANGELOG `[Unreleased]` section under the new version and date.

3. Verify:

   ```sh
   npx tsc --noEmit && pnpm run typecheck:test && pnpm test
   node scripts/ws-gate/release-gate.mjs   # packs and checks both packages (network required)
   # the perp-ws consumer steps run under every Node ≥ 20 found (PATH, nvm, fnm, Homebrew node@N,
   # or PERP_GATE_NODES=/path/node20:/path/node24); the report lists which versions ran
   ```

4. Commit, tag (`git tag v0.15.0`), push the commit and the tag.

5. Publish `perp-cli` from the repository root. Its `prepublishOnly` checks the version sync (fails on
   drift: go back to step 1), deletes `dist/` and rebuilds:

   ```sh
   npm publish
   ```

6. Publish `@hypurrquant/perp-ws`. Its `prepublishOnly` (`scripts/perp-ws-prepublish.mjs`) fails on
   version drift, deletes `packages/perp-ws/dist`, rebuilds it from `src/ws/**` and checks that
   `dependencies` is empty:

   ```sh
   cd packages/perp-ws
   npm publish --access public
   ```

7. Check both on the registry:

   ```sh
   npm view perp-cli version
   npm view @hypurrquant/perp-ws version dependencies peerDependencies
   ```

If one publish fails, fix it and publish that package at the same version; never publish the two at
different versions.
