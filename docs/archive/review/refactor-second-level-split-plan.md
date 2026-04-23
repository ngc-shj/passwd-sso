# Plan: Second-Level Directory Split & Top-dir Reorganization

> **Round 5 revision (2026-04-23)**: Applies 2 Critical blockers from Round 4 (F31, T23). Remaining Round 4 Major/Minor findings recorded as execution-time TODOs in the review file (`refactor-second-level-split-review.md` §"Round 4 Deferrals").
>
> - **F31 Critical fix** — `check-blame-ignore-revs.mjs` ALLOWED_MA_PATHS extended with `/^e2e\/.+\.(ts|tsx)$/` and `/^scripts\/manual-tests\/.+\.ts$/`. Pre-flight obligation added: PR 1 author MUST run the check against all existing SHAs in `.git-blame-ignore-revs` before opening PR 1.
> - **T23 Critical fix** — `ci-integration.yml` step changed from `npm run db:migrate` to `npx prisma migrate deploy` (matches existing CI precedent at `ci.yml:270,337,423`; `migrate dev` is dev-only per Prisma docs).
>
> **Round 4 revision (2026-04-23)**: Incorporates all Round 3 findings (1 Critical, 6 Major, 7 Minor). Key changes:
>
> - **S16 Critical fix** — `check-blame-ignore-revs.mjs` re-specified with a two-tier rule: R100 required for all rename entries; M/A entries allowed ONLY if they match a refactor-tool-adjacent allowlist (import rewrites + phase-config + allowlist files). Validated against PR #392's `f4dac457` move commit shape (11× R100 + 1× phase-config A + 2× allowlist M + 30+× consumer import M).
> - **S14 Major fix** — `/.trivyignore @ngc-shj` added to PR 1 CODEOWNERS additions.
> - **T17 Major fix** — `npx tsx -e '...'` (no `--tsconfig` flag) for barrel smoke check (empirically verified emits output).
> - **F27/S17 Major fix** — `scripts/__tests__/check-licenses.test.mjs:7` declared as MANUAL-EDIT consumer in PR 2 (codemod does not handle `resolve()` string-literals).
> - **F28 Major fix** — PR 2 CODEOWNERS DELETE directive specifies exact lines (5,6,7,10,11,12,13) to retain the 4 admin-tool literal rules at L4/L8/L9/L14.
> - **F29/T16 Major fix** — `redis.ts` pinned at `src/lib/` root (added to 10-file pin list); pre-pr.sh regex and `ci-integration.yml` `paths:` remain valid.
> - **S15 Major fix** — PR 1 checklist adds `gh api .../branches/main/protection/required_status_checks` verification; output pasted in PR body.
> - **S18 Minor fix** — `/src/lib/tenant-context.ts @ngc-shj` folded into PR 1 (earlier coverage).
> - **T18 Minor fix** — DB reachability check has `connectionTimeoutMillis: 3000` + `statement_timeout: 3000`.
> - **T19 Minor fix** — `DATABASE_URL` explicitly documented as inline from postgres service.
> - **T20 Minor fix** — `--check-test-pairs` extension-mismatch semantics documented (exact-extension match required; cross-extension pairs listed explicitly).
> - **T21 Minor fix** — PR 2 consumer enumeration explicitly calls out `refactor-phase-verify.mjs:111` `capture-test-counts` cmd entry.
> - **T22 Minor fix** — Mechanical edit protocol step 13 + completion criterion §8 reworded: CI authoritative, pre-pr.sh local preview, paste optional.

## Project context

- **Type**: web app (Next.js 16 App Router + TypeScript + Prisma 7 + PostgreSQL 16 + Auth.js v5)
- **Test infrastructure**: unit + integration + E2E + CI/CD (`npx vitest run`, `npx next build`, `scripts/pre-pr.sh`, `scripts/refactor-phase-verify.mjs`, GitHub Actions, `npm run test:integration` with live Postgres)
- **Path alias**: `@/*` → `./src/*` only.
- **Refactor tooling (existing, from PR #392)**:
  - `scripts/move-and-rewrite-imports.mjs` — ts-morph-based `git mv` + import rewrite. Handles `vi.mock`, `vi.doMock`, `vi.importActual`, `vi.importOriginal`, dynamic `import()`, `typeof import()`, `@/`-alias, relative imports (starting with `.`), barrel re-exports, `require()`.
  - **Known limitation** (per Round 3 F27/S17): codemod does NOT rewrite string-literal args to `resolve()`, `join()`, or other path-construction helpers where the specifier does not start with `.`. Files matching this pattern require manual edit, enumerated per phase.
  - `scripts/verify-move-only-diff.mjs` — move-only diff gate (fails-closed on ts-morph parse errors)
  - `scripts/verify-allowlist-rename-only.mjs` — allowlist drift guard (byte-identical model-set)
  - `scripts/refactor-phase-verify.mjs` — meta-orchestrator (13 checks today; 17 after PR 1)
  - `scripts/check-dynamic-import-specifiers.mjs` — dynamic import audit (prefix-scoped)
  - `scripts/check-doc-paths.mjs` — doc link drift guard (currently scans `src/(lib|hooks|components/passwords)` only)
  - `scripts/check-vitest-coverage-include.mjs` — coverage include list audit (`--enforce-rename-parity`)
  - `scripts/capture-test-counts.mjs` + `.refactor-test-count-baseline` — silent-test-loss guard
  - `.refactor-phase-verify-baseline` — origin/main SHA pin
  - `.git-blame-ignore-revs` — git-blame SHA skip list (maintained per phase)
  - `docs/forensics.md` — blame/follow procedure
- **Environment verified**:
  - `gh` CLI 2.83.2 — used for parallel-branch guard
  - `npx tsx` — verified: `npx tsx -e '<code>'` prints output; `npx tsx --tsconfig tsconfig.json -e '<code>'` silently exits 0 (DO NOT USE the --tsconfig flag form)
- **Background**: PR #392 (2026-04-23) merged — first-level split of `src/{lib,hooks,components/passwords}`. This plan is the second-level split.

## Objective

Reduce direct-file density while preserving git history, test coverage, CI green, and security-sensitive ownership boundaries.

**Threshold policy (canonical)**:
- **Overcrowded**: > 30 non-test files → MANDATORY split
- **Borderline**: 25–30 → preemptive split OK
- **Target after split**:
  - `src/lib/` direct non-test files ≤ 25 (10 pinned + 11 single-instance utilities + residuals)
  - Each new sub-dir ≤ 15
  - `src/components/(settings|team)/` each sub-dir ≤ 15
- **Counted units**: `*.ts(x)` excluding `*.test.ts(x)` and `index.ts` barrels

## Current density baseline (2026-04-23 on `main` at `02752a8e`)

| Directory | Non-test | Classification | Decision |
|---|---|---|---|
| `src/lib/` | 44 | OVER | MANDATORY split (PR 5) |
| `src/lib/constants/` | 30 | BORDERLINE | Preemptive split (PR 4) |
| `src/lib/auth/` | 29 | BORDERLINE | **SKIP** — no mandatory trigger |
| `src/components/settings/` | 34 | OVER | MANDATORY split (PR 6) |
| `src/components/team/` | 31 | OVER | MANDATORY split (PR 7) |

## Requirements

### Root-of-repo fixed (codified in `CONTRIBUTING.md`)

Build: `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `prisma.config.ts`, `proxy.ts`, `instrumentation-client.ts`, `sentry.*.config.ts`, `components.json`.
Container: `Dockerfile`, `docker-compose*.yml`, `.dockerignore`.
Metadata: `README*.md`, `LICENSE`, `SECURITY.md`, `CHANGELOG.md`, `CLAUDE.md`, `CONTRIBUTING.md`.
Release/CI: `release-please*.json`, `.trivyignore`, `.git-blame-ignore-revs`, `.refactor-*-baseline`, `.nvmrc`, `.gitignore`.
Env: `.env.example`, `.env.local` (gitignored).

### Root-of-`scripts/` fixed

- **Runtime**: `audit-outbox-worker.ts`
- **Operator / incident-response**: `purge-history.sh`, `purge-audit-logs.sh`, `rotate-master-key.sh`, `set-outbox-worker-password.sh`
- **Other operational**: `deploy.sh`, `scim-smoke.sh`, `mcp-reauth.sh`, `generate-icons.sh`, `bump-version.sh`
- **Data fixtures**: `rls-smoke-*.sql`, `tenant-team-*.sql`, `license-allowlist.json`
- **Admin-only refactor tools** (CODEOWNERS-gated): `move-and-rewrite-imports.mjs`, `verify-move-only-diff.mjs`, `verify-allowlist-rename-only.mjs`, `refactor-phase-verify.mjs`
- **CI orchestrator** (CODEOWNERS-gated in PR 1): `pre-pr.sh`

### Root-of-`src/lib/` pinned (10 files; NOT moved by PR 5)

| File | Pinning reason |
|------|---------------|
| `tenant-rls.ts` | RLS definition — central security boundary |
| `tenant-context.ts` | Cross-cutting tenant context |
| `prisma.ts` | Singleton Prisma client import target |
| `redis.ts` | **Added Round 4**: singleton Redis client; also preserves integration-test gate path-matching (F29/T16 fix). Matches PR #392's "single-instance utility" rationale. |
| `env.ts` | Bootstrap-sequence-sensitive |
| `load-env.ts` | Bootstrap-sequence-sensitive |
| `password-generator.ts` | Single-instance server-side generator |
| `notification.ts` | RLS-allowlisted |
| `webhook-dispatcher.ts` | Pinned by `.github/workflows/ci.yml:139-145` hardcoded `grep -v` |
| `url-helpers.ts` | Pinned by `.github/workflows/ci.yml:139-145` hardcoded `grep -v` |

### Test-only orphan

`src/lib/validations.test.ts` — legacy barrel test, stays at root (deletion out of scope).

## Technical approach

### Phase ordering

| # | Label | Branch | Depends on |
|---|---|---|---|
| 1 | Tooling + policy + additive CODEOWNERS | `refactor/tooling-prep` | — |
| 2 | `scripts/` reorg + CODEOWNERS cleanup | `refactor/scripts-reorg` | PR 1 |
| 4 | `src/lib/constants/` split | `refactor/lib-constants-split` | PR 2 |
| 5 | `src/lib/` direct-file split | `refactor/lib-direct-split` | PR 4 |
| 6 | `src/components/settings/` split | `refactor/settings-split` | PR 5 |
| 7 | `src/components/team/` split | `refactor/team-split` | PR 6 |
| 9 | Wrap-up | `refactor/split-wrapup` | PR 7 |

PRs 3 and 8 intentionally absent.

### PR 1 deliverables (tooling pre-stage — additive-only)

No file moves. **No DELETE of existing CODEOWNERS rules** (S1 fix).

1. **`scripts/refactor-phase-verify.mjs`** — extend `scripts` array:
   - `{ label: "check-dynamic-import-specifiers (src/components/settings)", cmd: ["node", "scripts/check-dynamic-import-specifiers.mjs", "--old-prefix", "src/components/settings"] }`
   - `{ label: "check-dynamic-import-specifiers (src/components/team)", cmd: ["node", "scripts/check-dynamic-import-specifiers.mjs", "--old-prefix", "src/components/team"] }`

2. **`scripts/check-doc-paths.mjs`** — two-pass extension (F17):
   - Pass A (existing): `SRC_REF_RE = /src\/(?:lib|hooks|components\/passwords|components\/settings|components\/team)\/[a-z0-9_/.-]+\.(?:tsx|ts)/g` with existing `SKIP_GLOBS`.
   - Pass B (new): `SCRIPT_REF_RE = /\bscripts\/[a-z0-9_/-]+\.(?:sh|mjs|ts|sql|json)\b/g` scans `CLAUDE.md`, `README.md`, `README.ja.md`, `docs/**/*.md` — implemented via a dedicated `scanForScriptRefs()` function that bypasses `SKIP_GLOBS`.

3. **`scripts/check-codeowners-drift.mjs`** (new, ~120 LOC). Must-have-owner roster:
   - `src/lib/auth/**`, `src/lib/crypto/**`, `src/lib/audit/**`
   - `src/lib/tenant-rls.ts`, `src/lib/tenant-context.ts` (S18 — added in PR 1 for earlier coverage)
   - `src/lib/tenant/**` (pre-existing subdir with 3 files; covered once `/src/lib/tenant/**` rule exists)
   - `src/lib/constants/auth/**` (post-PR-4)
   - `scripts/pre-pr.sh`
   - `scripts/move-and-rewrite-imports.mjs`, `verify-move-only-diff.mjs`, `verify-allowlist-rename-only.mjs`, `refactor-phase-verify.mjs`
   - `scripts/check-*.mjs` (pre-PR-2; matches files at `scripts/` root) and `scripts/checks/**` (post-PR-2)
   - `.github/workflows/**`
   - `.github/CODEOWNERS`
   - `.git-blame-ignore-revs`
   - `.trivyignore` (S14 — roster entry + matching CODEOWNERS rule in item 9)
   Wired as check #14.

4. **`scripts/check-blame-ignore-revs.mjs`** (new, ~120 LOC — S16 fix). Two-tier rule:
   - For each SHA in `.git-blame-ignore-revs`, run `git show --name-status -M100% <sha>`.
   - Parse output lines.
   - **Renamed entries** (`R<score>\t<old>\t<new>`): score MUST equal `100`. Any `R<100` → FAIL with SHA and offending path pair.
   - **Modified / Added / Deleted entries** (`M\t<path>`, `A\t<path>`, `D\t<path>`): allowed ONLY if `<path>` matches the refactor-tool-adjacent allowlist:
     ```
     ALLOWED_MA_PATHS = [
       /^scripts\/check-[^/]+\.mjs$/,              // allowlist rewrite pre-PR-2
       /^scripts\/checks\/[^/]+\.mjs$/,            // allowlist rewrite post-PR-2
       /^scripts\/verify-[^/]+\.mjs$/,             // verify-*.mjs
       /^scripts\/refactor-phase-verify\.mjs$/,    // meta-orchestrator updates
       /^scripts\/manual-tests\/.+\.ts$/,          // F31: manual-tests consumer imports (existing SHA 243cfc0e)
       /^docs\/archive\/review\/phases\/.+\.json$/, // phase-config adds
       /^\.git-blame-ignore-revs$/,                // the SHA list itself
       /^vitest\.config\.ts$/,                     // coverage.include rewrites
       /^\.github\/workflows\/.+\.yml$/,           // workflow path-filter rewrites
       /^\.github\/CODEOWNERS$/,                   // CODEOWNERS rewrites in same commit
       /^src\/[^/]+.*\.(ts|tsx|mjs|js)$/,           // consumer import rewrites
       /^scripts\/[^/]+\.(sh|mjs|ts)$/,             // scripts consumers (pre-pr.sh, etc.)
       /^e2e\/.+\.(ts|tsx)$/,                       // F31: e2e helpers/tests consumer imports (existing SHA 243cfc0e)
       /^CLAUDE\.md$/, /^README\.md$/, /^README\.ja\.md$/, /^docs\/.+\.md$/, // doc rewrites
       /^CHANGELOG\.md$/,                           // release-please
     ]
     ```
   - Additional invariant: each commit MUST have ≥ 1 `R100` entry. A commit in `.git-blame-ignore-revs` with zero R100 entries is nonsensical — FAIL.
   - **Pre-flight obligation (F31)**: before PR 1 opens, the author MUST run the proposed `check-blame-ignore-revs.mjs` logic against ALL existing SHAs in `.git-blame-ignore-revs` (24 SHAs from PR #392 phase commits). Paste the pass output in PR 1 body. If any existing SHA fails, extend `ALLOWED_MA_PATHS` and re-verify before opening.
   - Validated empirically against PR #392 move SHAs `f4dac457` (auth phase: 11× R100 + 1× phase-config A + 2× allowlist M + 30+× consumer M) AND `243cfc0e` (crypto phase: includes `e2e/helpers/*.ts` and `scripts/manual-tests/*.ts` — now covered by extended allowlist).
   Wired as check #15.

5. **`scripts/move-and-rewrite-imports.mjs`** — add `--check-test-pairs` flag. Semantics (T14 + T20):
   - For every `foo.ts(x)` in `moves[]`: if a sibling `foo.test.ts(x)` (same extension base: `foo.ts` ↔ `foo.test.ts`, `foo.tsx` ↔ `foo.test.tsx`) exists on disk, it MUST also appear in `moves[]`.
   - For every `foo.test.ts(x)` in `moves[]`: the sibling `foo.ts(x)` (same extension base) MUST also appear in `moves[]` if it exists on disk.
   - **Cross-extension pairs** (`foo.ts` + `foo.test.tsx`, or vice versa): NOT treated as automatic pairs. If present, must be listed explicitly in `moves[]` by the author. Flag documents this in its help text: "Cross-extension test-impl pairs are not auto-detected; list both in moves[] explicitly."
   - Mandatory in phase PRs 4–7 (step 3 of mechanical edit protocol).

6. **`scripts/refactor-phase-verify.mjs`** — add check #16 (parallel-branch guard) via `gh pr list`:
   ```
   OPEN_REFACTOR=$(gh pr list --state open --json headRefName --jq '.[].headRefName' | grep -c '^refactor/' || true)
   CURRENT=$(git rev-parse --abbrev-ref HEAD)
   if [[ "$CURRENT" == refactor/* ]]; then OPEN_REFACTOR=$((OPEN_REFACTOR - 1)); fi
   if [ "$OPEN_REFACTOR" -gt 0 ]; then fail; fi
   ```

7. **`scripts/pre-pr.sh`** — conditional `run_step` with DB-reachability precondition and timeout (T13 + T18 + T19):
   ```bash
   if git rev-parse --abbrev-ref HEAD | grep -q "^refactor/" && \
      git diff --name-only main...HEAD | \
        grep -E '^src/lib/(prisma|redis|tenant-(context|rls)|auth/.+-token)\.ts$|^src/lib/(prisma|tenant|auth)/' \
        > /dev/null; then
     # DB reachability check with 3-second timeout (T18)
     if node -e 'const{Pool}=require("pg");const p=new Pool({connectionString:process.env.DATABASE_URL,connectionTimeoutMillis:3000,statement_timeout:3000});p.query("select 1").then(()=>process.exit(0)).catch(()=>process.exit(1)).finally(()=>p.end())' 2>/dev/null; then
       run_step "Integration tests" bash -c 'npm run test:integration'
     else
       printf "  (skipped — no Postgres reachable within 3s; start docker compose or set DATABASE_URL before push)\n\n"
     fi
   fi
   ```
   - Regex (F29 / T16 fix): `redis.ts` is pinned at root (per Round 4 pin list), so `^src/lib/redis\.ts$` (first alternation) covers it; `src/lib/redis/` is absent from the second alternation (no `redis/` subdir created).
   - Second alternation `^src/lib/(prisma|tenant|auth)/` covers: `src/lib/prisma/**` (PR 5 moves nothing in here since `prisma.ts` is pinned; but the dir exists as a subdir target), `src/lib/tenant/**` (existing subdir), `src/lib/auth/**` (existing subdir).
   - `CONTRIBUTING.md` documents: "Contributors touching `src/lib/auth/**`, `src/lib/prisma.ts`, `src/lib/redis.ts`, or `src/lib/tenant-*` files MUST run `npm run test:integration` before PR; `pre-pr.sh` runs it automatically when DB is reachable (3s timeout)."

8. **`CONTRIBUTING.md`** (new) — sections: "Directory Policy", "Integration Tests", "Refactor Workflow".

9. **`.github/CODEOWNERS`** — **ADDITIVE-ONLY rules (S1 fix)**:
   - **ADD** `/scripts/check-*.mjs @ngc-shj` (transitional; matches current root files)
   - **ADD** `/scripts/checks/** @ngc-shj` (matches post-PR-2 paths; benign empty glob until PR 2)
   - **ADD** `/scripts/pre-pr.sh @ngc-shj` (S9 fix)
   - **ADD** `/src/lib/constants/auth/** @ngc-shj` (F26 fix — preemptive)
   - **ADD** `/src/lib/tenant-context.ts @ngc-shj` (S18 fix — earlier coverage)
   - **ADD** `/src/lib/tenant/** @ngc-shj` (S18 — covers existing subdir files pre-existing and future)
   - **ADD** `/.trivyignore @ngc-shj` (S14 fix — closes pre-existing supply-chain gap)
   - **DO NOT DELETE** the existing 11 literal `scripts/<name>.mjs` rules (lines 4–14) — PR 2 deletes only the 7 check-* rules.
   - **DO NOT DELETE** the dead flat-file patterns `/src/lib/crypto*` and `/src/lib/auth*` — PR 9 wrap-up removes them.

10. **`.github/workflows/ci-integration.yml`** (new — S11/T12/T19 fix):
    ```yaml
    name: ci-integration
    on:
      pull_request:
        paths:
          - 'src/lib/auth/**'
          - 'src/lib/prisma.ts'
          - 'src/lib/prisma/**'
          - 'src/lib/redis.ts'
          - 'src/lib/tenant-rls.ts'
          - 'src/lib/tenant-context.ts'
          - 'src/lib/tenant/**'
    jobs:
      integration:
        runs-on: ubuntu-latest
        services:
          postgres:
            image: postgres:16
            env:
              POSTGRES_USER: postgres
              POSTGRES_PASSWORD: postgres
              POSTGRES_DB: passwd_test
            ports: ['5432:5432']
            options: --health-cmd=pg_isready --health-interval=5s --health-timeout=3s --health-retries=5
        env:
          # Inline DATABASE_URL from service — NO secrets (fork PRs run unchanged)
          DATABASE_URL: postgresql://postgres:postgres@localhost:5432/passwd_test
        steps:
          - uses: actions/checkout@v4
          - uses: actions/setup-node@v4
            with: { node-version-file: '.nvmrc' }
          - run: npm ci
          # T23 fix: use `migrate deploy` (idempotent, non-interactive) — NOT `migrate dev`
          # (`migrate dev` requires shadow DB, may prompt for drift reset, auto-generates migrations).
          # Matches existing CI precedent at ci.yml:270,337,423.
          - run: npx prisma migrate deploy
          - run: npm run test:integration
    ```
    Note (T19): `DATABASE_URL` is inline (not from secrets), so fork PRs run the job unchanged.

11. **PR 1 checklist — `required_status_checks` verification (S15 fix)**:
    After PR 1 merges AND the repo admin updates branch-protection settings to require `ci-integration`, the PR author runs:
    ```bash
    gh api repos/:owner/:repo/branches/main/protection/required_status_checks \
      --jq '.checks[] | .context' | grep -F ci-integration
    ```
    Expected: output includes `ci-integration`. Paste in PR 1 body as proof. If setting is not applied, PR 2 blocks until it is.

### PR 2 deliverables (scripts/ reorg + CODEOWNERS cleanup)

**Atomic commit (S1 fix)**: `git mv` of scripts + DELETE of specific literal CODEOWNERS rules + consumer updates, same PR.

**Moves** (via codemod):
- `scripts/check-bypass-rls.mjs` → `scripts/checks/check-bypass-rls.mjs`
- `scripts/check-crypto-domains.mjs` → `scripts/checks/check-crypto-domains.mjs`
- `scripts/check-team-auth-rls.mjs` → `scripts/checks/check-team-auth-rls.mjs`
- `scripts/check-migration-drift.mjs` → `scripts/checks/check-migration-drift.mjs`
- `scripts/check-vitest-coverage-include.mjs` → `scripts/checks/check-vitest-coverage-include.mjs`
- `scripts/check-dynamic-import-specifiers.mjs` → `scripts/checks/check-dynamic-import-specifiers.mjs`
- `scripts/check-mjs-imports.mjs` → `scripts/checks/check-mjs-imports.mjs`
- `scripts/check-doc-paths.mjs` → `scripts/checks/check-doc-paths.mjs`
- `scripts/check-licenses.mjs` → `scripts/checks/check-licenses.mjs`
- `scripts/check-e2e-selectors.sh` → `scripts/checks/check-e2e-selectors.sh`
- `scripts/capture-test-counts.mjs` → `scripts/checks/capture-test-counts.mjs`
- Test siblings (codemod-handled): `scripts/__tests__/check-crypto-domains.test.mjs`, `scripts/__tests__/move-and-rewrite-imports.test.mjs`, `scripts/__tests__/smoke-key-provider.test.mjs` — these use static `import ... from "../<script>.mjs"` (starts with `.`, handled by codemod).

**MANUAL-EDIT consumer (F27/S17 fix)**:
- `scripts/__tests__/check-licenses.test.mjs:7`: current `const SCRIPT = resolve(__dirname, "..", "check-licenses.mjs")` — the codemod does NOT rewrite `resolve()` string-literals. PR 2 author hand-edits to `resolve(__dirname, "..", "checks", "check-licenses.mjs")`. Alternative (preferred long-term): refactor test to use static import matching the `check-crypto-domains.test.mjs` pattern — but that's a content change beyond move-only scope, so hand-edit the path in PR 2 and file a follow-up.

**CODEOWNERS (F28 fix — specific line list, NOT "lines 4-14")**:
- DELETE line 5 (`/scripts/check-bypass-rls.mjs`)
- DELETE line 6 (`/scripts/check-crypto-domains.mjs`)
- DELETE line 7 (`/scripts/check-team-auth-rls.mjs`)
- DELETE line 10 (`/scripts/check-vitest-coverage-include.mjs`)
- DELETE line 11 (`/scripts/check-dynamic-import-specifiers.mjs`)
- DELETE line 12 (`/scripts/check-mjs-imports.mjs`)
- DELETE line 13 (`/scripts/check-doc-paths.mjs`)
- DELETE the transitional `/scripts/check-*.mjs` glob added in PR 1 (now obsolete; files moved into `scripts/checks/`)
- RETAIN line 4 (`/scripts/move-and-rewrite-imports.mjs`), line 8 (`/scripts/verify-allowlist-rename-only.mjs`), line 9 (`/scripts/verify-move-only-diff.mjs`), line 14 (`/scripts/refactor-phase-verify.mjs`)

**Consumer enumeration (F3 + F19 + T21)** — exhaustive list:
- `scripts/pre-pr.sh` — lines 32–48 (6 `scripts/...` calls; rewrite each to `scripts/checks/<name>` for moved files)
- `scripts/refactor-phase-verify.mjs` — entries for: `check-team-auth-rls.mjs` (line 99 approx), `check-bypass-rls.mjs` (line 100), `check-crypto-domains.mjs` (line 101), `check-migration-drift.mjs` (line 102), `check-vitest-coverage-include.mjs` (line 105), `check-doc-paths.mjs` (line 106), `check-mjs-imports.mjs` (line 107), `check-dynamic-import-specifiers.mjs` (lines 108–110, 3 `--old-prefix` entries from PR 1's existing + 2 added), **`capture-test-counts.mjs` (line 111)** — T21 explicit callout. Update every `cmd` path to `scripts/checks/<name>`.
- `scripts/__tests__/check-licenses.test.mjs` — MANUAL edit (above)
- `scripts/__tests__/check-crypto-domains.test.mjs` — codemod rewrites `../check-crypto-domains.mjs` → `../checks/check-crypto-domains.mjs` (static import pattern, starts with `.`; handled)
- `package.json` — `scripts` map
- `.github/workflows/ci.yml` — path filters (`paths:`) + inline `scripts/` calls
- `.github/workflows/refactor-phase-verify.yml` — inline calls
- `.github/workflows/codeql.yml` (if path refs present)
- `.github/workflows/ci-integration.yml` — currently no `scripts/` refs; verify after PR 1 lands
- `CLAUDE.md` — "Admin scripts" block (line 22 area) + any `scripts/check-*` refs
- `README.md`, `README.ja.md`
- `docs/operations/deployment.md`
- Other `docs/**/*.md` (extended `check-doc-paths.mjs` from PR 1 catches residuals)

### PR 4 deliverables (`src/lib/constants/` split)

Phase-config JSON: `docs/archive/review/phases/refactor-second-level-split-phase-4.json` (committed BEFORE PR 4 opens).

**Final partition (30 non-test files)**:

| Target subdir | Files | Count |
|---|---|---|
| `auth/` | `api-key.ts`, `api-path.ts`, `extension-token.ts`, `mcp.ts`, `service-account.ts`, `share-permission.ts`, `share-type.ts`, `tenant-permission.ts`, `tenant-role.ts`, `totp.ts` | 10 |
| `audit/` | `audit-target.ts`, `audit.ts`, `notification.ts` | 3 |
| `team/` | `team-permission.ts`, `team-role.ts` | 2 |
| `vault/` | `custom-field.ts`, `entry-type.ts`, `export-format.ts`, `import-format.ts`, `storage-key.ts`, `vault.ts` | 6 |
| `integrations/` | `breakglass.ts`, `connect-status.ts`, `emergency-access.ts`, `extension.ts`, `invitation.ts` | 5 |
| (remain at root) | `index.ts` (barrel), `app.ts`, `time.ts`, `timing.ts` | 4 |

Test pairs co-move (enforced by `--check-test-pairs`): `api-path.test.ts`, `audit.test.ts`, `breakglass.test.ts`, `mcp.test.ts`, `share-permission.test.ts`, `team-permission.test.ts`.

**CODEOWNERS**: `/src/lib/constants/auth/** @ngc-shj` already added preemptively in PR 1.

**Barrel integrity check (step 14, T11/T17 fix)**:
```bash
npx tsx -e 'import * as C from "@/lib/constants"; const keys = Object.keys(C).sort(); console.log(JSON.stringify({count: keys.length, keys}, null, 2));'
```
(Note: NO `--tsconfig` flag — verified empirically in Round 4 to silence output.) Run pre-move on main and post-move on PR branch; JSON MUST be byte-identical. Output captured in PR body as proof.

### PR 5 deliverables (`src/lib/` direct-file split)

Phase-config JSON: `docs/archive/review/phases/refactor-second-level-split-phase-5.json`.

**Moveable (34 = 44 - 10 pinned)**:

| Target | Files | Count |
|---|---|---|
| NEW `http/` | `api-error-codes.ts`, `api-response.ts`, `cors.ts`, `parse-body.ts`, `with-request-log.ts`, `external-http.ts`, `backoff.ts` | 7 |
| NEW `url/` | `url-validation.ts`, `client-navigation.ts`, `google-domain.ts` | 3 |
| NEW `ui/` | `credit-card.ts`, `dynamic-styles.ts`, `ime-guard.ts`, `input-range.ts`, `qr-scanner-client.ts`, `download-blob.ts` | 6 |
| existing `format/` | `export-format-common.ts`, `secure-note-templates.ts`, `ssh-key.ts`, `wordlist.ts`, `tag-tree.ts` | 5 added |
| existing `services/` | `tailscale-client.ts` | 1 added |

**Stays at root**:
- **Pinned (10)**: `tenant-rls.ts`, `tenant-context.ts`, `prisma.ts`, `redis.ts`, `env.ts`, `load-env.ts`, `password-generator.ts`, `notification.ts`, `webhook-dispatcher.ts`, `url-helpers.ts`
- **Single-instance utilities (12)**: `logger.ts`, `utils.ts`, `safe-keys.ts`, `locale.ts`, `translation-types.ts`, `filter-members.ts`, `bulk-selection-helpers.ts`, `parse-user-agent.ts`, `health.ts`, `openapi-spec.ts`, `inject-extension-bridge-code.ts`, `events.ts`
- **Legacy orphan (1)**: `validations.test.ts` (test-only)

Sum: 7 + 3 + 6 + 5 + 1 + 10 + 12 = 44 non-test files ✓ (plus 1 test-only orphan).

**Post-PR-5 `src/lib/` direct non-test count**: 10 + 12 = **22** (≤ 25 ✓).

Circular-import risk: `http/` may import from `url/` (one-directional). Codemod dry-run + `npx tsc --noEmit` in phase-config preparation validates no cycles.

**`check-bypass-rls.mjs` ALLOWED_USAGE**: PR 5 causes ZERO renames (all listed `src/lib/` paths either pinned at root or already in unchanged subdirs). `verify-allowlist-rename-only.mjs` passes with empty rename set; PR body pastes output as proof.

**`.github/workflows/ci.yml` fetch-basePath exclusions**: `webhook-dispatcher.ts` and `url-helpers.ts` PINNED at root; literal `grep -v` exclusions remain valid. No update needed.

**CODEOWNERS update in PR 5**: none required (all affected CODEOWNERS additions already made in PR 1: `/src/lib/tenant-context.ts`, `/src/lib/tenant/**`). `tenant-rls.ts` rule exists at line 25 (unchanged).

### PR 6 deliverables

Phase-config JSON: `docs/archive/review/phases/refactor-second-level-split-phase-6.json`. Sub-dirs: `{security, developer, account}`. Draft distribution (finalized at phase-config):

| Subdir | Files | Count |
|---|---|---|
| `security/` | `passkey-credentials-card`, `tenant-*-policy-card` group (access-restriction, delegation, lockout, passkey, password, session, token), `tenant-vault-reset-button`, `tenant-reset-history-dialog`, `rotate-key-card` | ~11 |
| `developer/` | `api-key-manager`, `cli-token-card`, `mcp-client-card`, `mcp-connections-card`, `service-account-card`, `access-request-card`, `scope-badges`, `delegation-manager`, `create-delegation-dialog`, `tenant-webhook-card`, `base-webhook-card`, `audit-delivery-target-card`, `scim-provisioning-card`, `directory-sync-card` | ~14 |
| `account/` | `tab-description`, `section-nav`, `section-layout`, `section-card-header`, `form-dirty-badge`, `travel-mode-card`, `tenant-audit-log-card`, `tenant-retention-policy-card`, `tenant-members-card` | ~9 |

### PR 7 deliverables

Phase-config JSON: `docs/archive/review/phases/refactor-second-level-split-phase-7.json`. Sub-dirs: `{forms, management, security}`.

| Subdir | Pattern | Count |
|---|---|---|
| `forms/` | `team-*-form.tsx`, `team-entry-*`, `team-login-*`, `team-tag-input`, `team-tags-and-folder-section`, `team-attachment-section` | ~12 |
| `management/` | `team-create-dialog`, `team-edit-dialog*`, `team-new-dialog`, `team-role-badge`, `team-archived-list`, `team-trash-list`, `team-export` | ~10 |
| `security/` | `team-policy-settings`, `team-rotate-key-button`, `team-scim-token-manager`, `team-webhook-card`, `team-bulk-wiring` | ~9 |

### PR 9 deliverables (wrap-up)

1. Full CODEOWNERS audit via `check-codeowners-drift.mjs`.
2. **REMOVE dead flat-file patterns (F25)**: DELETE `/src/lib/crypto*` and `/src/lib/auth*`.
3. `docs/forensics.md` sync — verify `.git-blame-ignore-revs` SHAs per PR 1 check #15.
4. `docs/README.md` index refresh (folded from former PR 3).
5. `CLAUDE.md` final path-reference audit.
6. Delete empty orphan sub-directories.

### Mechanical edit protocol (per PR)

1. `git checkout main && git pull && git checkout -b refactor/<phase-label>`
2. Commit `docs/archive/review/phases/refactor-second-level-split-phase-N.json` FIRST. Config lists impl+test pairs.
3. `node scripts/move-and-rewrite-imports.mjs --config <phase>.json --check-test-pairs` MUST pass (symmetric; exact-extension match).
4. `node scripts/move-and-rewrite-imports.mjs --config <phase>.json`
5. **Manual edits** (if any listed in phase deliverables — e.g., PR 2's `check-licenses.test.mjs:7`).
6. `node scripts/verify-move-only-diff.mjs`
7. `node scripts/verify-allowlist-rename-only.mjs`; paste output in PR body when touching RLS-guarded paths.
8. `node scripts/check-codeowners-drift.mjs` (check #14).
9. `node scripts/check-blame-ignore-revs.mjs` (check #15; two-tier R100 + M/A-allowlist).
10. `node scripts/refactor-phase-verify.mjs --force` (16 checks total).
11. `npx eslint .`
12. `npx vitest run` — count MUST match `.refactor-test-count-baseline`.
    - Mismatch → split content into separate PR. `--record` requires reviewer sign-off.
13. **Integration tests** — **authoritative gate is `ci-integration.yml` (CI)**. Local `pre-pr.sh` runs them when DB reachable as preview only. **Paste in PR body is OPTIONAL evidence** (T22 clarification).
14. **Barrel integrity (PR 4 only)**:
    ```bash
    # On main (before PR 4 work): capture baseline
    git checkout main && npx tsx -e 'import * as C from "@/lib/constants"; const keys = Object.keys(C).sort(); console.log(JSON.stringify({count: keys.length, keys}, null, 2));' > /tmp/barrel-baseline.json
    # On PR branch (after codemod): capture post
    git checkout <pr-branch> && npx tsx -e '<same command>' > /tmp/barrel-post.json
    diff /tmp/barrel-baseline.json /tmp/barrel-post.json  # MUST be empty
    ```
    Paste both outputs in PR body.
15. `npx next build`
16. `bash scripts/pre-pr.sh` (includes conditional integration-test run as local preview, all 16 static checks).
17. Commit: append move SHA to `.git-blame-ignore-revs` in the SAME commit (commit message: `refactor: <phase-label>`).
18. PR body: (a) density delta, (b) move SHA, (c) `verify-allowlist-rename-only` output (when applicable), (d) barrel snapshot diff (PR 4 only), (e) phase-config JSON path. Integration-test output is OPTIONAL (CI is authoritative).

## Implementation steps

1. **PR 1 — Tooling + policy + additive CODEOWNERS** (`refactor/tooling-prep`): 11 items above. No file moves.
2. **PR 2 — `scripts/` reorg + CODEOWNERS cleanup** (`refactor/scripts-reorg`): atomic moves + specific-line DELETEs + consumer updates (including manual edit of `check-licenses.test.mjs:7`).
3. **PR 4 — `src/lib/constants/` split** (`refactor/lib-constants-split`).
4. **PR 5 — `src/lib/` direct-file split** (`refactor/lib-direct-split`): 34 files moved (redis.ts now pinned), 10 pinned, 12 single-instance at root. Total root = 22 (≤ 25 ✓).
5. **PR 6 — `src/components/settings/` split** (`refactor/settings-split`).
6. **PR 7 — `src/components/team/` split** (`refactor/team-split`).
7. **PR 9 — Wrap-up** (`refactor/split-wrapup`).

## Testing strategy

1. **Per-PR**: `bash scripts/pre-pr.sh` (lint + 16 static checks + vitest + conditional int-test preview + next build).
2. **Integration tests (auth/DB-touching PRs)**: machine-enforced via `.github/workflows/ci-integration.yml` (authoritative). Local `pre-pr.sh` previews when DB reachable (3s timeout).
3. **E2E regression guard**: `scripts/checks/check-e2e-selectors.sh` (part of `pre-pr.sh`). E2E tests in `e2e/tests/*.spec.ts` are selector-based; do not import component paths.
4. **Stale-branch + parallel-branch guards**: `.refactor-phase-verify-baseline` + check #16 (`gh pr list`).
5. **Test count baseline**: `.refactor-test-count-baseline` + `scripts/checks/capture-test-counts.mjs` (post-PR-2).
6. **Barrel integrity (PR 4)**: `npx tsx -e '...'` JSON snapshot diff.
7. **Dynamic import audit**: 5 prefixes (`src/lib`, `src/hooks`, `src/components/passwords`, `src/components/settings`, `src/components/team`).
8. **CODEOWNERS drift**: check #14 with expanded roster (S10 fix).
9. **Blame-ignore-revs integrity**: check #15 with two-tier R100 + allowlist (S16 fix).
10. **`vitest.config.ts` file-specific `coverage.thresholds` audit**: one-time pre-PR-4.
11. **Reproducible claim numbers**: PR 4 body includes `grep -rn "from ['\"]@/lib/constants['\"]" src/ | wc -l` and `grep -rn "vi\.mock(['\"]@/lib/constants/" src/ | wc -l` at PR time (T15 fix). Round 4 empirical snapshot: 421 barrel-form + 13 deep-mock — not load-bearing; PR 4 re-captures.

## User operation scenarios

### Scenario A: Git blame during incident response
Setup: `git config blame.ignoreRevsFile .git-blame-ignore-revs`. `check-blame-ignore-revs.mjs` (PR 1 check #15) validates every SHA is rename-plus-allowlisted-M/A — prevents content SHA from silently hiding authorship.

### Scenario B: Feature-branch rebase after phase merge
```bash
git fetch origin && git rebase origin/main
node scripts/move-and-rewrite-imports.mjs \
  --config docs/archive/review/phases/refactor-second-level-split-phase-6.json \
  --dry-run
```
Validation: extended `check-dynamic-import-specifiers.mjs` catches residual stale imports.

### Scenario C: CODEOWNERS drift on new files
`check-codeowners-drift.mjs` fails any PR that adds a must-have-owner path without matching rule.

### Scenario D: Non-refactor feature PR touches `src/lib/auth/service-account-token.ts`
Triggers `ci-integration.yml` via `paths:` filter. Machine-enforced; required_status_checks blocks merge on failure.

### Scenario E: Developer without local Postgres runs `pre-pr.sh`
3-second reachability timeout → skip with message → other checks continue. CI-side `ci-integration.yml` is authoritative.

### Scenario F: PR 8 (auth split) re-evaluation
If `src/lib/auth/` exceeds 30 after feature-PR accretion, open a separate plan.

### Scenario G: PR 2 migrated script's test
- `check-crypto-domains.test.mjs`: uses `import ... from "../check-crypto-domains.mjs"` — codemod rewrites to `"../checks/check-crypto-domains.mjs"` automatically.
- `check-licenses.test.mjs:7`: uses `resolve(__dirname, "..", "check-licenses.mjs")` — **codemod does NOT rewrite this pattern**. PR 2 author hand-edits to `resolve(__dirname, "..", "checks", "check-licenses.mjs")`. Listed as MANUAL-EDIT consumer in PR 2 deliverables.

## Considerations & constraints

### In scope
- Directory-density reduction for 4 MANDATORY / BORDERLINE dirs.
- `CONTRIBUTING.md` Directory Policy + Integration Tests + Refactor Workflow.
- Tool extensions in PR 1 (16 refactor-phase-verify checks total).
- New CI integration workflow (`ci-integration.yml`, inline DATABASE_URL).
- CODEOWNERS glob broadening (additive PR 1, cleanup PR 2 + PR 9).
- `check-blame-ignore-revs.mjs` two-tier rule validated against PR #392 precedent.

### Out of scope (explicit)
- Content changes (internal refactor, API reshaping).
- `src/app/` route handler reorganization.
- `extension/`, `cli/`.
- `src/lib/auth/` split (borderline at 29).
- `tools/` directory (DROPPED).
- `scripts/refactor/` sub-dir (DROPPED).
- Deletion of `src/lib/validations.test.ts` legacy orphan.
- Refactoring `check-licenses.test.mjs` to static-import pattern (follow-up after PR 2).

### Risks (Round 4 updated)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| CODEOWNERS regression window | Eliminated | — | PR 1 additive-only; PR 2 specific-line DELETEs; check #14 |
| PR 1 self-blocks via drift check on `.trivyignore` | Eliminated | — | S14 fix: rule added to PR 1 item 9 |
| Admin-tool CODEOWNERS rules deleted by PR 2 | Eliminated | — | F28 fix: specific line numbers (5,6,7,10,11,12,13) not "lines 4-14" |
| `check-blame-ignore-revs.mjs` fails on every real commit | Eliminated | — | S16 fix: two-tier rule (R100 + M/A allowlist) validated against PR #392 `f4dac457` |
| Codemod misses `resolve()` string-literal in test | Eliminated | — | F27/S17 fix: explicit MANUAL-EDIT consumer in PR 2 |
| `redis.ts` path drifts from integration-test gate | Eliminated | — | F29/T16 fix: `redis.ts` pinned at root |
| Barrel smoke check silently no-ops | Eliminated | — | T17 fix: drop `--tsconfig` flag; empirically verified |
| `required_status_checks` drifts from plan intent | Eliminated | — | S15 fix: `gh api` verification step in PR 1 checklist |
| `tenant-context.ts` unowned between phases | Eliminated | — | S18 fix: CODEOWNERS added in PR 1 |
| DB reachability hangs `pre-pr.sh` | Eliminated | — | T18 fix: 3s timeout |
| Fork-PR secret access breaks `ci-integration.yml` | Eliminated | — | T19 fix: inline DATABASE_URL from service, no secrets |
| `--check-test-pairs` cross-ext ambiguity | Eliminated | — | T20 fix: documented as "list explicitly" |
| PR 2 misses `capture-test-counts` path update | Eliminated | — | T21 fix: explicit callout |
| Completion criterion §8 wording ambiguity | Eliminated | — | T22 fix: CI authoritative, paste optional |
| Parallel refactor branches | Eliminated | — | Check #16 |
| `scripts/__tests__/*.test.mjs` static imports | Eliminated | — | Codemod handles |
| Constants dedup confusion | Eliminated | — | Concrete PR 4 mapping |
| Feature branches stale after phase merge | Medium | Developer friction | Scenario B + committed phase-config JSONs |
| `CLAUDE.md` path drift | Low | Stale docs | `check-doc-paths.mjs` two-pass |
| E2E coverage include drift | Low | Coverage false-negative | `check-vitest-coverage-include.mjs --enforce-rename-parity` |

### Completion criteria

1. Directory densities:
   - `src/lib/` direct ≤ 25 (22 after PR 5)
   - `src/lib/constants/` every subdir ≤ 15 (max 10)
   - `src/components/settings/` every subdir ≤ 15
   - `src/components/team/` every subdir ≤ 13
2. `bash scripts/pre-pr.sh` green on every phase PR.
3. CI green including `ci-integration.yml` on auth-touching PRs; `refactor-phase-verify.mjs` runs 16 checks.
4. `.git-blame-ignore-revs`: every SHA passes `check-blame-ignore-revs.mjs` (R100 rename + allowlisted M/A); `git blame -e` surfaces original author on a moved file.
5. `.github/CODEOWNERS` final state: `/scripts/checks/** @ngc-shj`, `/scripts/pre-pr.sh @ngc-shj`, 4 admin-tool literals (L4, L8, L9, L14), `/src/lib/{auth,crypto,audit}/**`, `/src/lib/tenant-rls.ts`, `/src/lib/tenant-context.ts`, `/src/lib/tenant/**`, `/src/lib/constants/auth/**`, `/.trivyignore`, `/.github/workflows/`, `/.github/CODEOWNERS`, `/.git-blame-ignore-revs`. No dead flat-file patterns.
6. `CONTRIBUTING.md` Directory Policy + Integration Tests + Refactor Workflow merged (PR 1).
7. `CLAUDE.md` path references validated by extended `check-doc-paths.mjs`.
8. **Auth-touching PRs gate**: `ci-integration.yml` green — machine-enforced via `required_status_checks` (verified post-merge by PR 1 author via `gh api`).
9. `src/lib/auth/` explicitly NOT split (29 ≤ 30 threshold).
