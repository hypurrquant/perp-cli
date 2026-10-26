# Contributing to perp-cli

Thank you for your interest in contributing to perp-cli! This guide will help you get started.

## Getting Started

### Prerequisites

- **Node.js** >= 20
- **pnpm** >= 10

### Setup

```bash
git clone https://github.com/hypurrquant/perp-cli.git
cd perp-cli
pnpm install
pnpm run build
```

### Running locally

```bash
# CLI
node dist/index.js status

# MCP server
node dist/mcp-server.js
```

### Running tests

```bash
# Unit tests (required before submitting a PR)
pnpm test

# Integration tests (optional — requires exchange API keys)
pnpm run test:integration
```

The testing standard — test layers, output contracts, invariants, the conformance suite and the
definition of done for a venue / feature — is [`docs/TESTING.md`](docs/TESTING.md).

## How to Contribute

### Before you start

1. **Search existing issues** to avoid duplicating work
2. **Open an issue first** for large changes or new features — let's discuss before you code
3. **Small PRs are preferred** — easier to review and merge

### Workflow

1. Fork the repository
2. Create a branch from `main` (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run `pnpm test` and ensure all tests pass
5. Run `pnpm run build` and ensure it compiles
6. Commit with a clear message (e.g. `feat: add market depth command`)
7. Push to your fork and open a Pull Request

### Commit message convention

We follow a lightweight [Conventional Commits](https://www.conventionalcommits.org/) style:

- `feat:` — new feature
- `fix:` — bug fix
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `docs:` — documentation only
- `test:` — adding or updating tests
- `chore:` — maintenance (deps, CI, etc.)

## Test Policy

| Test type | Required for PR? | Notes |
|---|---|---|
| Unit tests (`pnpm test`) | **Yes** | Must pass |
| Integration — read-only | Optional | Maintainers will re-run if needed |
| Integration — live/mainnet | **No** | Never required from contributors |

> **Note:** Integration tests hit live exchanges and may require API keys. Contributors are NOT expected to run them. Maintainers will verify these separately.

## Documentation

If your PR changes any of the following, please update the relevant docs:

- CLI commands or flags → update `docs/commands.md` (and the `README.md` Command Groups table for a new group)
- Venue support or per-venue behaviour → update `docs/venues.md` (support matrix) and the `README.md` venue table
- `--json` output shape → update `API_RESPONSE_SPEC.md`
- MCP tool name or schema → update `docs/mcp.md`

## Code Style

- TypeScript with strict mode
- ESM modules (`import/export`)
- Avoid `any` types where possible
- Keep functions focused and small

## Security

- **Never commit API keys, private keys, or secrets**
- If you find a security vulnerability, do NOT open a public issue — see [SECURITY.md](SECURITY.md)
- Be careful with exchange API calls that can modify positions or move funds

## Questions?

Open a [Discussion](https://github.com/hypurrquant/perp-cli/discussions) or comment on the relevant issue.
