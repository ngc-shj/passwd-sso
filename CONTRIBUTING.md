# Contributing

This document codifies conventions that must be respected across PRs. If a convention here conflicts with `CLAUDE.md`, `CLAUDE.md` wins.

## Directory Policy

### Root-of-repository fixed

The following files must NOT move out of the repository root:

- **Build / runtime config**: `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.tsbuildinfo`, `next.config.ts`, `next-env.d.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `prisma.config.ts`, `proxy.ts`, `instrumentation-client.ts`, `sentry.client.config.ts`, `sentry.server.config.ts`, `components.json`
- **Container**: `Dockerfile`, `docker-compose*.yml`, `.dockerignore`
- **Repo metadata**: `README.md`, `README.ja.md`, `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, `CLAUDE.md`, `CONTRIBUTING.md`
- **Release / CI**: `release-please*.json`, `.trivyignore`, `.git-blame-ignore-revs`, `.refactor-phase-verify-baseline`, `.nvmrc`, `.gitignore`
- **Env**: `.env.example`, `.env.local` (gitignored)

### Root-of-`scripts/` fixed

The following must NOT move into any `scripts/<subdir>/`:

- **Runtime entrypoints**: `audit-outbox-worker.ts` (referenced by `Dockerfile:25`, `docker-compose.override.yml:35`)
- **Operator / incident-response**: `purge-history.sh`, `purge-audit-logs.sh`, `rotate-master-key.sh`, `set-outbox-worker-password.sh`
- **Other operational**: `deploy.sh`, `scim-smoke.sh`, `mcp-reauth.sh`, `generate-icons.sh`, `bump-version.sh`
- **Data fixtures**: `rls-smoke-*.sql`, `tenant-team-*.sql`, `license-allowlist.json`
- **Admin-only refactor tools** (CODEOWNERS-gated): `move-and-rewrite-imports.mjs`, `verify-move-only-diff.mjs`, `verify-allowlist-rename-only.mjs`, `refactor-phase-verify.mjs`, `check-codeowners-drift.mjs`, `check-blame-ignore-revs.mjs`
- **CI orchestrator** (CODEOWNERS-gated): `pre-pr.sh`
- **Manual smoke tests**: `scripts/manual-tests/*` stays at that path

### Root-of-`src/lib/` pinned (10 files)

The following stay at `src/lib/` root. Moving any of them requires updating the CI path filters / static grep exclusions and is out of scope for mechanical splits:

| File | Pinning reason |
|------|---------------|
| `tenant-rls.ts` | RLS definition — central security boundary |
| `tenant-context.ts` | Cross-cutting tenant context |
| `prisma.ts` | Singleton Prisma client import target |
| `redis.ts` | Singleton Redis client; also preserves integration-test gate regex |
| `env.ts` | Bootstrap-sequence-sensitive |
| `load-env.ts` | Bootstrap-sequence-sensitive |
| `password-generator.ts` | Single-instance server-side generator |
| `notification.ts` | RLS-allowlisted |
| `webhook-dispatcher.ts` | Pinned by `.github/workflows/ci.yml` hardcoded `grep -v` |
| `url-helpers.ts` | Pinned by `.github/workflows/ci.yml` hardcoded `grep -v` |

## Integration Tests

Contributors touching any of the following files MUST run `npm run test:integration` against a live Postgres before opening a PR:

- `src/lib/auth/**`
- `src/lib/prisma.ts`, `src/lib/prisma/**`
- `src/lib/redis.ts`
- `src/lib/tenant-rls.ts`, `src/lib/tenant-context.ts`, `src/lib/tenant/**`

Guidance:

- `scripts/pre-pr.sh` runs integration tests automatically when the diff matches the above paths AND a local Postgres is reachable (3-second timeout). Start the compose stack first: `docker compose -f docker-compose.yml -f docker-compose.override.yml up -d db`.
- To defer integration tests to CI: `PREPR_SKIP_INTEGRATION=1 bash scripts/pre-pr.sh`.
- **The authoritative gate is `.github/workflows/ci-integration.yml`** — it runs on every PR matching the path filter and blocks merge on failure. The local run is a convenience preview.

## Refactor Workflow

Large-scale directory reorganizations (e.g., second-level splits) use a phase-config-driven codemod to preserve history and atomicity.

### Phase-config JSON

Each phase PR commits a phase-config to `docs/archive/review/phases/<plan-name>-phase-<N>.json` in the FIRST commit of the PR:

```json
{
  "phaseName": "phase-<N>-<slug>",
  "moves": [
    { "from": "src/lib/foo.ts",       "to": "src/lib/bar/foo.ts" },
    { "from": "src/lib/foo.test.ts",  "to": "src/lib/bar/foo.test.ts" }
  ]
}
```

### `--check-test-pairs` (mandatory)

Run before applying the codemod:

```bash
node scripts/move-and-rewrite-imports.mjs --config <phase>.json --check-test-pairs
```

Symmetric pair validation:
- Every impl `foo.ts(x)` in `moves[]` with a sibling `foo.test.ts(x)` on disk → sibling must also be in `moves[]`.
- Every test `foo.test.ts(x)` in `moves[]` with a sibling `foo.ts(x)` on disk → sibling must also be in `moves[]`.
- **Cross-extension pairs** (`foo.ts` + `foo.test.tsx`, or vice versa) are NOT auto-paired. If intentional, list both in `moves[]` explicitly.

### Execute

```bash
node scripts/move-and-rewrite-imports.mjs --config <phase>.json
```

Post-execution gates (all run automatically by `scripts/refactor-phase-verify.mjs`):

- `verify-move-only-diff.mjs` — PR is move-only.
- `verify-allowlist-rename-only.mjs` — RLS bypass allowlist renames are model-set-preserving.
- `check-codeowners-drift.mjs` — every security-sensitive path has matching CODEOWNERS coverage.
- `check-blame-ignore-revs.mjs` — every SHA in `.git-blame-ignore-revs` is R100 rename + allowlisted M/A/D.
- Parallel-branch guard — fails if another `refactor/*` PR is open.

### Forensics

See `docs/forensics.md` for the `git blame` / `git log --follow` procedure used to recover authorship across refactor moves. The move-commit SHA MUST be appended to `.git-blame-ignore-revs` in the SAME commit as the move (not a follow-up commit).
