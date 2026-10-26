# QA reports

The QA history of this repo, one file per cycle, named `<YYYY-MM-DD>-<slug>.md`.

These used to live only on the laptop that ran the QA: five reports existed, none was tracked,
and the newest one predated the 0.15.0 release. A QA record nobody else can read is not a
record, and `docs/TESTING.md` §7.3 asks a reviewer to check that a release PR has its report
attached — which cannot be checked against an untracked directory. They are tracked from here on.

## What belongs here

- the structured cycle report (`docs/QA_WORKFLOW.md`), and
- the `release-qa` report of a release candidate or a published release:
  `pnpm release-qa --tarball <perp-cli.tgz> --tarball <hypurrquant-perp-ws.tgz> --out <dir>`
  writes `release-qa.md` + `release-qa.json`; commit the `.md` as
  `<YYYY-MM-DD>-release-qa-<version>.md` and link it from the release PR.

## What must not

Keys, passphrases, private keys, `.env` contents, and third-party wallet addresses — the same bar
the fixtures are held to. A report describes *what was run and what came back*; it does not need
live account identifiers to do that, so leave them out rather than redact them later. A public
repo makes every paste permanent.
