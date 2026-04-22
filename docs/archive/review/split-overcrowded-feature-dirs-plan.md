# Plan: Split Overcrowded Feature Directories

## Project context

- **Type:** web app (Next.js 16 App Router, TypeScript, Prisma 7, PostgreSQL 16 with RLS)
- **Test infrastructure:** unit + integration (Vitest) + E2E (Playwright) + CI/CD (GitHub Actions, `scripts/pre-pr.sh`)
- **Security surfaces affected:** `src/lib/crypto-*`, `src/lib/auth-*`, `src/lib/audit-*`, `src/lib/tenant-rls.ts`; allowlists in `scripts/check-bypass-rls.mjs` (RLS bypass gate) and `scripts/check-crypto-domains.mjs` (crypto domain ledger); vitest coverage thresholds on crypto/auth; CI workflow `grep -v` exemptions.
- **Path alias:** only `@/*` → `./src/*` in `tsconfig.json`. No intermediate aliases. Moving `src/lib/foo.ts` → `src/lib/auth/foo.ts` changes the import specifier from `@/lib/foo` to `@/lib/auth/foo` at all call sites.
- **Import sites (upper bound):** 791 files import from `@/lib/`, 145 from `@/hooks/`, 100 from `@/components/passwords/`. Per-phase proportion estimated before each PR (see step 9 below).
- **Test mocks in scope:** `vi.mock("@/lib/...")` occurs in ~1462 places across ~250 test files (codemod MUST re-count at runtime). Mock-holding directories: co-located `*.test.ts` under `src/lib/`, centralized `src/__tests__/lib/`, `src/__tests__/api/`, `src/__tests__/integration/`, `src/workers/__tests__/`. Additionally, `await import("@/lib/...")` with static-string argument (~178 sites), `vi.importActual`, `vi.importOriginal<typeof import(...)>()`, and `typeof import(...)` type references (~26 sites). The codemod MUST rewrite all of these specifiers alongside imports.

## Objective

Reduce top-level file density of three overcrowded directories by grouping files into feature-based subdirectories. **Move-only refactor**: no semantic changes, no new tests, no signature changes.

Target:

| Directory | Before (total / non-test) | Target (non-test top-level) |
|---|---|---|
| `src/lib` | 241 / 134 | ≤ 45 (relaxed from ≤30 — residual ~44 single-instance utilities / core infrastructure, enumerated below) |
| `src/hooks` | 113 / 60 | ≤ 30 |
| `src/components/passwords` | 89 / 62 | ≤ 30 |

The ≤ 45 target for `src/lib` (relaxed once more from ≤ 40 per Round 3 F15/F22 — actual residual count is 44 unique entries) acknowledges that these files are "single-instance utility / core infrastructure" without a natural cluster of ≥ 2 siblings. Enumerated, de-duplicated list:

- **Pinned at root by allowlist**: `tenant-rls.ts` (RLS definition), `tenant-context.ts` (cross-cutting), `notification.ts` (RLS-allowlisted), `webhook-dispatcher.ts` (CI grep-v), `url-helpers.ts` (CI grep-v), `env.ts`, `load-env.ts` (bootstrap-sequence-sensitive), `prisma.ts` (singleton import target), `password-generator.ts` (server-side single-instance).
- **Single-instance utilities**: `logger.ts`, `utils.ts`, `redis.ts`, `health.ts`, `openapi-spec.ts`, `wordlist.ts`, `safe-keys.ts`, `backoff.ts`, `ime-guard.ts`, `input-range.ts`, `events.ts`, `locale.ts`, `translation-types.ts`, `download-blob.ts`, `dynamic-styles.ts`, `external-http.ts`, `parse-body.ts`, `parse-user-agent.ts`, `with-request-log.ts`, `bulk-selection-helpers.ts`, `client-navigation.ts`, `google-domain.ts`, `qr-scanner-client.ts`, `ssh-key.ts`, `credit-card.ts`, `tag-tree.ts`, `tailscale-client.ts`, `secure-note-templates.ts`, `inject-extension-bridge-code.ts`, `export-format-common.ts`, `filter-members.ts`, `url-validation.ts`, `cors.ts`, `api-response.ts`, `api-error-codes.ts`.

Each can be grouped later when a sibling joins. Grouping is out of scope for this refactor; `api-response.ts` + `api-error-codes.ts` are a candidate for a future `src/lib/api/` subdir but not justified at 2 files.

## Requirements

### Functional (non-regression)

- All tests pass: `npx vitest run`, `npm run test:integration`, `npm run test:coverage`.
- Production build succeeds: `npx next build`.
- `scripts/pre-pr.sh` passes (lint + all static checks).
- E2E test set remains green (Playwright).
- No change to exported symbols, function signatures, module-level side effects.
- No change to externally observable routes, API endpoints, DB schema.
- **Test count invariant**: `npx vitest run --reporter=json` pre-move counts == post-move counts. All four metrics MUST match: `numTotalTests`, `numPassedTests`, `numSkippedTests`, `numFailedTests`. Any divergence means a test was lost, newly skipped, or newly failing — all block merge.

### Non-functional

- Each phase PR is revertible cleanly via `git revert <merge-sha>`.
- `git log --follow` traces file history across moves → use `git mv` only.
- Per-file diff outside the moved file is limited to import-specifier and `vi.mock(...)` specifier updates. No opportunistic refactors in move PRs.

### Allowlist / safelist updates (mandatory per move — COMPLETE list)

The following files contain hardcoded `src/(lib|hooks|components/passwords)/*` paths and MUST be updated in lockstep with any move affecting a listed file. Missing an update is a potential **Critical** regression (security gate fails silent or coverage enforcement disabled).

| Allowlist file | What it gates | Risk of stale entry |
|---|---|---|
| `scripts/check-bypass-rls.mjs` | Per-file → allowed Prisma model list for RLS bypass calls (`ALLOWED_USAGE` map). 74 path entries. | **Critical**: stale path → file's `withBypassRls()` calls un-gated; model-set drift during rename enables cross-tenant data access. |
| `scripts/check-crypto-domains.mjs` | Crypto domain ledger verification (`cryptoFiles` array, 7 entries today). | **Critical**: new crypto file bypasses HKDF/AAD domain verification → cross-protocol key reuse. |
| `scripts/check-team-auth-rls.mjs` | Directory scan of `src/app/api` and `src/lib`; uses TARGETS array. | Verify it still scans correctly after subdir additions. |
| `scripts/__tests__/smoke-key-provider.test.mjs` | Relative `.ts` imports with `.ts` extension in `.mjs`. | Smoke test breaks silently; not covered by `tsc --noEmit`. |
| `vitest.config.ts` | `coverage.include` (30+ paths), `coverage.thresholds` (per-file 80% line on `auth-or-token.ts`, `crypto-server.ts`, `crypto-team.ts`). | **Critical**: stale include = coverage silently shrinks; stale threshold key = enforcement silently disabled. |
| `vitest.integration.config.ts` | `include` patterns for integration tests. | Stale = integration test discovery breaks. |
| `next.config.ts` | `import { PERMISSIONS_POLICY } from "./src/lib/security-headers"` (relative path from repo root). | Production `next build` fails at first compile. |
| `sentry.server.config.ts`, `sentry.client.config.ts` | `import { scrubSentryEvent } from "@/lib/sentry-scrub"` (alias, handled by codemod's alias-rewrite pass). | **Critical**: client scrubber fails to load on stale alias → raw events with tokens/session IDs ship to Sentry. |
| `src/instrumentation.ts` (covered by `src/**`), `instrumentation-client.ts` (repo root) | `src/instrumentation.ts` has 4 `await import("@/lib/...")` static-string dynamic imports at L5, L11, L14, L32 (env, redis, key-provider, sentry-sanitize); `instrumentation-client.ts` sits at repo root. | Telemetry / OpenTelemetry hooks break on stale specifiers. |
| `prisma.config.ts`, `eslint.config.mjs`, `postcss.config.mjs` | Possible `src/lib` refs. | Build/lint config break. |
| `proxy.ts` (root) | Re-exports or imports from `src/lib`. | Next.js proxy breaks. |
| `.github/workflows/ci.yml` | Line 144 hardcodes `grep -v 'src/lib/webhook-dispatcher.ts'` and `'src/lib/url-helpers.ts'` for fetch-compliance check. | Moving either file → CI silently skips → fixing by removing grep creates SSRF surface. |
| `.github/workflows/codeql.yml`, `.github/codeql/codeql-config.yml` | Potential path filters. | CodeQL scan coverage drops. |
| `.github/CODEOWNERS` | Security-reviewer requirement for security-sensitive paths (created in Phase 0; see §Phase 0 below). | Review policy inheritance lost on move. |
| `CLAUDE.md`, `README.md`, `docs/**/*.md` | 336+ `src/lib/*` references (plus `src/hooks/*`, `src/components/passwords/*`). | Documentation drift; Claude agents chasing stale paths. |
| `load-test/setup/*.mjs` | Comment-only references to `src/lib/crypto-client.ts`. | Copy-paste drift of crypto constants by future devs. |

### Disposition of every `check-bypass-rls.mjs` entry (mandatory — Critical gate)

Every entry in `ALLOWED_USAGE` MUST be listed here with its target disposition. Entries not listed must be added before starting Phase 1.

| Path | Target disposition |
|---|---|
| `src/lib/tenant-rls.ts` | **Stays at root** (definition file for bypass purposes) |
| `src/lib/tenant-context.ts` | **Stays at root** (cross-cutting tenant context) |
| `src/lib/auth-adapter.ts` | → `src/lib/auth/auth-adapter.ts` (Phase 1) |
| `src/lib/audit.ts` | → `src/lib/audit/audit.ts` (Phase 3) |
| `src/lib/audit-outbox.ts` | → `src/lib/audit/audit-outbox.ts` (Phase 3) |
| `src/lib/audit-user-lookup.ts` | → `src/lib/audit/audit-user-lookup.ts` (Phase 3) |
| `src/lib/audit-chain.ts` | → `src/lib/audit/audit-chain.ts` (Phase 3) |
| `src/lib/scim-token.ts` | → `src/lib/auth/scim-token.ts` (Phase 1) |
| `src/lib/extension-token.ts` | → `src/lib/auth/extension-token.ts` (Phase 1) |
| `src/lib/maintenance-auth.ts` | → `src/lib/auth/maintenance-auth.ts` (Phase 1) |
| `src/lib/account-lockout.ts` | → `src/lib/auth/account-lockout.ts` (Phase 1) |
| `src/lib/lockout-admin-notify.ts` | → `src/lib/auth/lockout-admin-notify.ts` (Phase 1) |
| `src/lib/new-device-detection.ts` | → `src/lib/auth/new-device-detection.ts` (Phase 1) |
| `src/lib/notification.ts` | **Stays at root** for this refactor (candidate for future `src/lib/notifications/` but not in scope) |
| `src/lib/webhook-dispatcher.ts` | **Stays at root** (referenced by `.github/workflows/ci.yml:144` hardcoded grep — pinned to avoid CI breakage) |
| `src/lib/tenant-auth.ts` | → `src/lib/auth/tenant-auth.ts` (Phase 1) |
| `src/lib/team-auth.ts` | → `src/lib/auth/team-auth.ts` (Phase 1) — DECIDED |
| `src/lib/vault-reset.ts` | → `src/lib/vault/vault-reset.ts` (Phase 4) |
| `src/lib/api-key.ts` | → `src/lib/auth/api-key.ts` (Phase 1) |
| `src/lib/webauthn-authorize.ts` | → `src/lib/auth/webauthn-authorize.ts` (Phase 1) |
| `src/lib/user-session-invalidation.ts` | → `src/lib/auth/user-session-invalidation.ts` (Phase 1) |
| `src/lib/access-restriction.ts` | → `src/lib/auth/access-restriction.ts` (Phase 1) |
| `src/lib/team-policy.ts` | → `src/lib/team/team-policy.ts` (Phase 4) |
| `src/lib/session-timeout.ts` | → `src/lib/auth/session-timeout.ts` (Phase 1) |
| `src/lib/service-account-token.ts` | → `src/lib/auth/service-account-token.ts` (Phase 1) |
| `src/lib/mcp/oauth-server.ts` | **Stays in `src/lib/mcp/`** (existing subdir, not moved) |
| `src/lib/delegation.ts` | → `src/lib/auth/delegation.ts` (Phase 1) |
| `src/app/api/**` entries | Unchanged by this refactor; API routes are not moved |
| `src/auth.ts` | **Stays at root** (Auth.js entry point) |

Additional allowlist enforcement: `scripts/verify-allowlist-rename-only.mjs` parses `git diff main -- scripts/check-bypass-rls.mjs` as `Map<path→models>` before and after; enforces (a) every added key replaces a removed key with IDENTICAL model set (byte-level compare), (b) the removed path is covered by `git mv` in the same PR. Wired into `pre-pr.sh` for refactor branches.

## Technical approach

### Grouping rationale

Grouping driven by existing semantic clusters already visible in filename prefixes (e.g., `audit-*`, `crypto-*`, `personal-login-*`, `use-sidebar-*`, `password-import-*`). Low-risk mechanical grouping — not a domain re-architecture.

### Proposed `src/lib` subdirectories

| Subdir | Files (representative) |
|---|---|
| `src/lib/auth/` | `auth-adapter.ts`, `auth-or-token.ts`, `check-auth.ts`, `api-key.ts`, `csrf.ts`, `access-restriction.ts`, `account-lockout.ts`, `admin-token.ts`, `extension-token.ts`, `service-account-token.ts`, `scim-token.ts`, `share-access-token.ts`, `maintenance-auth.ts`, `team-auth.ts` (DECIDED here, NOT in team/), `tenant-auth.ts`, `v1-auth.ts`, `webauthn-authorize.ts`, `webauthn-client.ts`, `webauthn-server.ts`, `session-timeout.ts`, `session-meta.ts`, `user-session-invalidation.ts`, `delegation.ts`, `scope-parser.ts`, `callback-url.ts`, `ip-access.ts`, `travel-mode.ts`, `new-device-detection.ts`, `lockout-admin-notify.ts` |
| `src/lib/crypto/` | `crypto-aad.ts`, `crypto-blob.ts`, `crypto-client.ts`, `crypto-emergency.ts`, `crypto-recovery.ts`, `crypto-server.ts`, `crypto-team.ts`, `crypto-utils.ts`, `export-crypto.ts` |
| `src/lib/audit/` | `audit.ts`, `audit-action-key.ts`, `audit-action-label.ts`, `audit-chain.ts`, `audit-csv.ts`, `audit-display.ts`, `audit-log-stream.ts`, `audit-logger.ts`, `audit-outbox.ts`, `audit-query.ts`, `audit-target-label.ts`, `audit-user-lookup.ts` |
| `src/lib/security/` | `security-headers.ts`, `sentry-sanitize.ts`, `sentry-scrub.ts`, `rate-limit.ts`, `rate-limiters.ts`, `password-policy-validation.ts`, `password-analyzer.ts` |
| `src/lib/vault/` | `vault-context.tsx`, `vault-reset.ts`, `active-vault-context.tsx`, `auto-lock-context.tsx`, `personal-entry-payload.ts`, `personal-entry-save.ts`, `entry-save-core.ts`, `entry-form-helpers.ts`, `entry-form-types.ts`, `entry-sort.ts` |
| `src/lib/team/` | `team-entry-payload.ts`, `team-entry-save.ts`, `team-entry-validation.ts`, `team-policy.ts`, `team-vault-context.tsx`, `team-vault-core.tsx` (NOTE: `team-auth.ts` is NOT here; it lives in `src/lib/auth/`) |
| `src/lib/emergency-access/` | `emergency-access-context.tsx`, `emergency-access-server.ts`, `emergency-access-state.ts` |
| `src/lib/tenant/` | `tenant-claim-storage.ts`, `tenant-claim.ts`, `tenant-management.ts` (NOTE: `tenant-rls.ts` and `tenant-context.ts` STAY at root per RLS-allowlist disposition; `tenant-auth.ts` lives in `src/lib/auth/`) |
| `src/lib/format/` | `format-datetime.ts`, `format-file-size.ts`, `format-user.ts` |
| `src/lib/folder/` | `folder-path.ts`, `folder-utils.ts` |
| `src/lib/prisma/` | `prisma-error.ts`, `prisma-filters.ts` (NOTE: `prisma.ts` STAYS at root as the singleton import target) |
| `src/lib/env/` | `env-utils.ts` (NOTE: `env.ts`, `load-env.ts` STAY at root as bootstrap-sequence-sensitive files) |
| `src/lib/notification/` | `notification-messages.ts` (NOTE: `notification.ts` STAYS at root per RLS-allowlist disposition) |
| `src/lib/generator/` | `generator-prefs.ts`, `generator-summary.ts` (NOTE: `password-generator.ts` STAYS at root as single-instance server-side generator) |

Existing `src/lib/` subdirs NOT moved and unaffected by this refactor: `__tests__/` (1 file: `prisma-filters.test.ts`), `blob-store/`, `constants/`, `directory-sync/`, `email/`, `key-provider/`, `mcp/`, `scim/`, `services/`, `validations/`, `watchtower/`.

Files remaining at `src/lib/` root (not moved in this refactor, pending later evaluation): `prisma.ts`, `env.ts`, `env-utils.ts`, `logger.ts`, `utils.ts`, `url-helpers.ts` (pinned by ci.yml), `notification.ts`, `webhook-dispatcher.ts` (pinned by ci.yml), `tenant-rls.ts` (RLS definition), `tenant-context.ts`, `format-datetime.ts`, `format-file-size.ts`, `format-user.ts`, and other single-instance utilities. Explicit list produced per phase.

### Proposed `src/hooks` subdirectories

**Directory collision resolution**: `src/hooks/form/` (singular) exists with 2 files (`form-scope-config.ts`, `login-form-derived.ts`). To avoid sibling `form/` + `forms/` at the same level: **consolidate into existing `src/hooks/form/`** (singular, keep existing name). All new hook-forms files move into `src/hooks/form/`.

| Subdir | Files |
|---|---|
| `src/hooks/form/` (EXISTING, extended) | existing `form-scope-config.ts` + `login-form-derived.ts`; add `use-entry-form-translations.ts`, `entry-form-translations.ts`, `entry-action-bar-props.ts`, `use-entry-has-changes.ts`, `use-form-dirty.ts`, `password-form-router.ts`, `use-before-unload-guard.ts`, `use-navigation-guard.ts` |
| `src/hooks/sidebar/` | all `use-sidebar-*.ts`, `sidebar-crud-error.ts` |
| `src/hooks/personal/` | `personal-form-sections-props.ts`, all `personal-login-*`, `use-personal-*` |
| `src/hooks/team/` | `team-form-sections-props.ts`, all `team-login-*`, `use-team-*` |
| `src/hooks/vault/` | `use-reveal-timeout.ts`, `use-reprompt.ts`, `use-vault-context.ts`, `use-audit-logs.ts` |
| `src/hooks/bulk/` | `use-bulk-action.ts`, `use-bulk-selection.ts` |

Files remaining at `src/hooks/` root: `use-local-storage.ts`, `use-callback-url.ts`, `use-tenant-role.ts`, `use-travel-mode.tsx`, `use-watchtower.ts`.

### Proposed `src/components/passwords` subdirectories

**Directory collision resolution**: `src/components/passwords/detail-sections/` (existing, 9 files) overlaps with proposed `detail/`. **Consolidate: rename proposed `detail/` to nest as `src/components/passwords/detail/`**; move existing `detail-sections/` into `src/components/passwords/detail/sections/` (add to Phase 6 scope).

| Subdir | Files |
|---|---|
| `src/components/passwords/import/` | all `password-import-*`, `use-import-execution.ts`, `use-import-file-flow.ts` |
| `src/components/passwords/export/` | `password-export.tsx`, `export-options-panel.tsx` |
| `src/components/passwords/entry/` | all `entry-*.tsx` / `entry-*.ts`, `attachment-section.tsx` |
| `src/components/passwords/personal/` | all `personal-*` |
| `src/components/passwords/detail/` + `detail/sections/` | `password-detail-inline.tsx`, `password-card.tsx`, `password-dashboard.tsx`, `password-list.tsx`; existing `detail-sections/*` moves into `detail/sections/` |
| `src/components/passwords/dialogs/` | `reprompt-dialog.tsx`, `qr-capture-dialog.tsx`, `personal-password-edit-dialog*`, `personal-password-new-dialog.tsx` |
| `src/components/passwords/shared/` | `copy-button.tsx`, `favicon.tsx`, `totp-field.tsx`, `travel-mode-indicator.tsx`, `secure-note-markdown.tsx`, `folder-like.ts`, `form-navigation.ts`, `password-generator.tsx`, `trash-list.tsx` |

Complete enumeration of `src/components/passwords/*.{ts,tsx}` (non-test) is covered by the above rows. Any file not listed here indicates a discrepancy and must be added to a row before Phase 6 begins.

### Codemod and verification scripts (all created in Phase 0)

`scripts/move-and-rewrite-imports.mjs` (ts-morph AST-based). Scope and obligations:

1. **File types processed:** `*.ts`, `*.tsx`, `*.mjs`, `*.js` (configs). Both alias `@/lib/...` and relative `./src/lib/...` / `../../src/lib/...` specifiers.
2. **Directory scope:** `src/**` (covers `src/instrumentation.ts`, `src/workers/`, `src/__tests__/`), `scripts/**`, `e2e/**`, **repo-root config files** (`next.config.ts`, `vitest.config.ts`, `vitest.integration.config.ts`, `eslint.config.mjs`, `sentry.server.config.ts`, `sentry.client.config.ts`, `instrumentation-client.ts`, `prisma.config.ts`, `postcss.config.mjs`, `proxy.ts`), and `.github/workflows/*.yml`. (`src/workers/` and `src/instrumentation.ts` are covered by `src/**` — they are NOT at repo root.) `extension/`, `cli/`, `load-test/` are OUT OF default scope but post-check greps scan them for stale refs.
3. **What the codemod rewrites:**
   - Alias imports (`@/lib/foo` → `@/lib/auth/foo`).
   - Relative imports INSIDE moved files (`./sibling` → correct new relative path, recomputed per move graph).
   - Relative imports FROM outside `src/` (e.g., `scripts/__tests__/smoke-key-provider.test.mjs` uses `../../src/lib/...`).
   - Re-export chains (`export * from "@/lib/foo"`, `export { X } from "@/lib/foo"`). Known sites: `src/lib/audit.ts`, `src/lib/tenant-auth.ts`, `src/lib/team-auth.ts` re-export from `@/lib/constants/*`. Enumerate via `rg "^export .* from ['\"]@/(lib|hooks|components/passwords)/"` and rewrite each.
   - **`vi.mock()` and `vi.doMock()` string literals** in `.test.ts`/`.test.tsx` — **~1462 occurrences** across ~250 test files per `rg` count (codemod MUST re-count at runtime, not trust the static number). AST-rewrite these as module specifiers.
   - **Static-string dynamic imports and test-helper import variants** (new in Round 2): `await import("@/lib/<path>")` with a STRING-LITERAL argument (178 call sites across `src/__tests__/`, `src/instrumentation.ts`, and tests). Also `vi.importActual("<specifier>")`, `vi.importOriginal<typeof import("<specifier>")>()`, and TypeScript-only `typeof import("<specifier>")` type references (26 sites). ts-morph handles these as `CallExpression` with `StringLiteral` args and `ImportTypeNode` for the type variant — all well-supported.
   - Hardcoded string paths in allowlists: `scripts/check-bypass-rls.mjs` ALLOWED_USAGE keys, `scripts/check-crypto-domains.mjs` cryptoFiles array, `vitest.config.ts` coverage.include AND coverage.thresholds keys, `.github/workflows/ci.yml` grep exemption strings.
4. **What the codemod FAILS on (not warns):**
   - Template-literal dynamic `import(\`@/lib/${name}\`)` that could resolve to a moved path. Developer MUST refactor to either (a) exhaustive switch with static literals, or (b) explicit module map `{ foo: () => import("@/lib/crypto/foo") }`. 2 template-literal dynamic imports exist today (both in `src/i18n/messages.ts:92` and `:110` for i18n messages — confirmed safe, both target `../../messages/...`, not `src/lib/*`).
   - Any file in `.github/` or root configs importing a moved path if the config pattern cannot be safely rewritten (bail to human).
5. **Mechanical gates emitted in PR:**
   - `scripts/verify-move-only-diff.mjs`: strips `^(\s*)(import|export)\b.*from ['"].*['"];?$` and blank lines from both pre-move and post-move versions; runs `diff` — must be empty. Applied to ALL moved files; MANDATORY for `src/lib/crypto/**`, `src/lib/auth/**`, `src/lib/audit/**` (security-sensitive).
   - `scripts/verify-allowlist-rename-only.mjs`: enforces byte-identical model-set during `check-bypass-rls.mjs` path rename.
   - `scripts/check-vitest-coverage-include.mjs`: every `coverage.include` entry resolves to ≥1 file; every `coverage.thresholds` key matches an existing path. **Extended per Round 2 (T11):** parses pre-move (main) AND post-move (PR) `vitest.config.ts` and asserts that the set of `coverage.include` entries removed and the set added correspond 1:1 to the PR's `git mv` file renames. Same for `coverage.thresholds` keys. Analogous to `verify-allowlist-rename-only.mjs` but for the coverage config.
   - `scripts/check-doc-paths.mjs`: every `src/(lib|hooks|components/passwords)/...` reference in `docs/**/*.md`, `CLAUDE.md`, `README.md` resolves to an existing file.
   - `scripts/check-mjs-imports.mjs`: every `import(...)` target in every `*.mjs` resolves to an existing file.
   - `scripts/check-dynamic-import-specifiers.mjs` (new, Round 2 S21): asserts zero stale `await import("@/(lib|hooks|components/passwords)/<old-top-level-name>")` string literals and zero stale `vi.importActual(...)` / `vi.importOriginal<typeof import(...)>()` / `typeof import(...)` specifiers post-move.
   - `scripts/refactor-phase-verify.mjs`: runs ALL `check-*.mjs` scripts on the post-merge tree (not branch tree) before phase merge. **Round 2 addition:** also asserts `git rev-parse origin/main` matches the expected last-merged SHA recorded when the PR was opened; fails if the branch is stale vs main (guards against race when single-phase-PR-in-flight policy is bypassed).
6. **Proof-of-execution gate:** PR CI re-runs the codemod from a clean checkout using the script AT LAST-MERGED-TO-MAIN REVISION (not the branch's potentially-modified copy); bitwise compares resulting tree with PR tree via `git diff --exit-code`. Differ → fail. Prevents hand-edits masquerading as "codemod output" and prevents weaponized codemod edits within the same PR.

### Stray-reference post-check (mandatory grep gate)

After codemod + `tsc --noEmit` pass, grep for any stale reference to old paths:

```sh
rg -n "@/(lib|hooks|components/passwords)/<old-top-level-name>" src/ scripts/ e2e/ extension/ cli/ load-test/
rg -n "src/(lib|hooks|components/passwords)/<old-top-level-name>\.(ts|tsx)" .
```

Expected: zero matches. Any match blocks merge. Pre-audit regex WIDENED per Round 1 findings to cover `.tsx` and all three top-level dirs.

### Security review scaffolding (Phase 0 prerequisites)

Before any move PR lands:

1. **`.github/CODEOWNERS`** (created in Phase 0):
   ```
   # Security-sensitive paths — require security reviewer approval
   /scripts/move-and-rewrite-imports.mjs   @security
   /scripts/check-bypass-rls.mjs           @security
   /scripts/check-crypto-domains.mjs       @security
   /scripts/check-team-auth-rls.mjs        @security
   /scripts/verify-allowlist-rename-only.mjs  @security
   /scripts/verify-move-only-diff.mjs      @security
   /src/lib/crypto*                        @security
   /src/lib/auth*                          @security
   /src/lib/tenant-rls.ts                  @security
   /.github/workflows/                     @security
   /.github/CODEOWNERS                     @security
   /.git-blame-ignore-revs                 @security
   ```
   (Replace `@security` with the actual team handle; user to confirm.)

2. **`.git-blame-ignore-revs`** (created empty in Phase 0). Append each phase's move-commit SHA in the SAME PR as the move. `docs/forensics.md` added with instruction: `git config blame.ignoreRevsFile .git-blame-ignore-revs`.

3. **Pre-move secret-leakage scan**: `gitleaks detect --staged` wired into `pre-pr.sh` for refactor branches. Post-move: `git status --porcelain | grep -E '\.env|\.pem|\.key|credentials$' && fail`. Assert `.gitignore` unchanged: `git diff --name-only main | grep -q '^\.gitignore$' && fail`.

4. **Crypto ledger conversion**: convert `scripts/check-crypto-domains.mjs` from hardcoded `cryptoFiles` array to:
   - Glob: `readdirSync("src/lib", {recursive:true})` filtered to `^crypto-.*\.ts$|^export-crypto\.ts$`.
   - **Exclusion list** (Round 2 F19): `crypto-blob.ts` contains only field-name helpers (`toBlobColumns`, `toOverviewColumns`) with no HKDF / AAD content; it is glob-matched by the `crypto-*` prefix but must be explicitly excluded from the ledger scan via a constant `LEDGER_EXEMPT = ["crypto-blob.ts"]` in the script. Adding to exemption requires documented justification.
   - Discover-all: any file in repo containing `passwd-sso-[a-z0-9-]+` or `(SCOPE_|AAD_SCOPE_)\w+\s*=\s*"[A-Z]{2}"` tokens MUST be in scan (regardless of filename prefix) — this catches newly-added crypto logic in non-`crypto-*`-prefixed files.
   - Replace L98-102 `try/catch { continue }` with `fail("crypto file listed but not found: ${file}")`.
   Land BEFORE any crypto file moves (Phase 0 prerequisite for Phase 2).

5. **Dynamic-import audit**: `rg "import\(\`@/(lib|hooks|components/passwords)" src/ scripts/ e2e/` — confirm zero template-literal dynamic imports touching moved paths. Document each existing dynamic import: currently 2 template-literal dynamic imports exist (both at `src/i18n/messages.ts:92` and `:110`, targeting `../../messages/${safe}/${ns}.json`) — neither touches `src/lib/*`.

6. **Merge queue configuration** (new, Round 2 S26): before Phase 1 can start, the `refactor/split-overcrowded-feature-dirs` branch-protection rule MUST have GitHub merge queue enabled, OR `refactor-phase-verify.mjs` MUST run in the `merge_group` event trigger in CI. Without one of these, the single-phase-PR-in-flight rule degrades from automated to policy-only, and two phase PRs can race. User confirms merge-queue availability before Phase 1 kickoff.

## Implementation steps

### Phase 0 — Preparation (one PR, no file moves)

- Land this plan file on `refactor/split-overcrowded-feature-dirs`.
- Create `.github/CODEOWNERS`, `.git-blame-ignore-revs`, `docs/forensics.md`.
- Create codemod `scripts/move-and-rewrite-imports.mjs` with all features above + unit tests against fixture directory.
- Create verification scripts: `verify-move-only-diff.mjs`, `verify-allowlist-rename-only.mjs`, `check-vitest-coverage-include.mjs`, `check-doc-paths.mjs`, `check-mjs-imports.mjs`, `refactor-phase-verify.mjs`.
- Convert `scripts/check-crypto-domains.mjs` to glob + fail-on-missing (NO crypto files moved yet; this is a neutral improvement).
- Wire new checks into `pre-pr.sh` (gitleaks, refactor-phase-verify, rename-only).
- Document rollback procedure in PR description.
- Merge-queue rule announcement: **only one phase PR in flight at a time**; coordinate with active feature branches.

### Phase 1-7 — Per-subdir moves (one PR per subdir)

Every per-subdir PR follows this exact sequence:

1. **Pre-phase analysis (before running codemod):**
   - `rg -l "@/lib/(<file1>|<file2>|...)" src/ scripts/ e2e/ | wc -l` — import-site estimate. If > 200 sites, split the phase into smaller PRs.
   - Record `npx vitest run --reporter=json | jq '.numTotalTests'` as pre-move test count.
2. **Run codemod:** `node scripts/move-and-rewrite-imports.mjs --config phases/<phase-name>.json`. Codemod performs `git mv` + all import/mock/allowlist rewrites atomically.
3. **Enforce gates (all must pass):**
   - `npx tsc --noEmit` (alias + relative imports OK).
   - `scripts/verify-move-only-diff.mjs` on security-sensitive moves (Phases 1, 2, 4).
   - `scripts/verify-allowlist-rename-only.mjs` on `check-bypass-rls.mjs` diff.
   - `scripts/check-vitest-coverage-include.mjs`.
   - `scripts/check-doc-paths.mjs`.
   - `scripts/check-mjs-imports.mjs`.
   - Stray-reference post-check greps (zero matches).
4. **Update CLAUDE.md path references** for moved files in the SAME commit.
5. **Run full test gate:**
   - `npx vitest run --reporter=json | jq '{numTotalTests, numPassedTests, numSkippedTests, numFailedTests}'` + assert all four metrics match pre-move values (test-count invariant, expanded per T10).
   - `npm run test:integration` (required for Phase 3 audit and Phase 4 security/vault/team).
   - `npm run test:coverage` (required for Phase 1 auth-or-token, Phase 2 crypto-server/crypto-team; the npm script exists in `package.json`, verified).
   - `npx next build`.
   - `npm run pre-pr` (full CI parity).
6. **Append move-commit SHA to `.git-blame-ignore-revs`** in the same PR.
7. **PR description checklist**:
   - List of moved files.
   - Allowlist line-number checklist (pre-computed by codemod, e.g., "Phase 1 updates `scripts/check-bypass-rls.mjs` L25, 27-32, 41-46, 48, 51-52, 55, 57-58, 60, 88, 99; `vitest.config.ts` L...; etc.").
   - Test count before/after.
   - Import-site diff count.
   - `git log --follow` spot-check on one moved file.
8. **Open PR; CI runs merge-queue verification** (`refactor-phase-verify.mjs`) re-running all checks on post-merge tree.
9. **Merge; no other phase PR in flight during this phase's review period.**

Phase ordering (one PR each unless noted):

1. **Phase 0** — Preparation (as above).
2. **Phase 1** — `src/lib/auth/` (29 files). **Split per Round 2 F17** to keep any single PR ≤ ~12 moves and respect the ≤ 200 import-update budget:
   - **Phase 1a — token modules (6 files)**: `api-key.ts`, `extension-token.ts`, `scim-token.ts`, `service-account-token.ts`, `share-access-token.ts`, `admin-token.ts`.
   - **Phase 1b — WebAuthn + passkey (3 files)**: `webauthn-authorize.ts`, `webauthn-client.ts`, `webauthn-server.ts`.
   - **Phase 1c — session / lockout / device (8 files)**: `session-timeout.ts`, `session-meta.ts`, `user-session-invalidation.ts`, `account-lockout.ts`, `lockout-admin-notify.ts`, `new-device-detection.ts`, `travel-mode.ts`, `ip-access.ts`.
   - **Phase 1d — core auth / tenant / team / delegation / adapter (12 files)**: `auth-adapter.ts`, `auth-or-token.ts`, `check-auth.ts`, `csrf.ts`, `access-restriction.ts`, `callback-url.ts`, `delegation.ts`, `maintenance-auth.ts`, `scope-parser.ts`, `team-auth.ts`, `tenant-auth.ts`, `v1-auth.ts`.
   Each sub-phase follows the full per-PR sequence. crypto-domain ledger not yet touched at any Phase-1 sub-phase.
3. **Phase 2** — `src/lib/crypto/` (9 files). Requires crypto ledger already converted in Phase 0. Apply `verify-move-only-diff.mjs` strictly. Also verify e2e/helpers: `e2e/helpers/crypto.ts`, `e2e/helpers/crypto.test.ts`, `e2e/helpers/share-link.ts` updated for `crypto-client.ts` move.
4. **Phase 3** — `src/lib/audit/` (12 files). Must pass `scripts/check-team-auth-rls.mjs`, pre-pr `no-deprecated-logAudit` check, `test:integration` (audit-outbox).
5. **Phase 4a** — `src/lib/security/` (7 files).
6. **Phase 4b** — `src/lib/vault/` (10 files).
7. **Phase 4c** — `src/lib/team/` (6 files, excluding `team-auth.ts`).
7.5. **Phase 4d** — new `src/lib/` subdirs for remaining clusters (runs AFTER Phase 4a/4b/4c; 5 small PRs): `src/lib/emergency-access/` (3 files), `src/lib/tenant/` (3 files), `src/lib/format/` (3 files), `src/lib/folder/` + `src/lib/prisma/` + `src/lib/env/` + `src/lib/notification/` + `src/lib/generator/` (2 files each, grouped into 1-2 PRs). Explicit sequencing prevents the Phase 3.5 ordering ambiguity reported in Round 3.

8. **Phase 5** — `src/hooks/*` subdirs (6 PRs: `form/` (extend existing), `sidebar/`, `personal/`, `team/`, `vault/`, `bulk/`). Apply the uniform per-PR cap (≤ 20 file moves AND ≤ 200 import updates; split if exceeded).
9. **Phase 6** — `src/components/passwords/*` subdirs (6 PRs). Verify Playwright selectors unchanged (file paths change, CSS/data-testid/id unchanged).
10. **Phase 7** — Completion gate.

### Phase 7 — Completion gate

- Confirm each target directory top-level non-test file count ≤ 30.
- Consolidation check: no duplicate directories (`form/` not coexisting with `forms/`).
- Final `.git-blame-ignore-revs` completeness audit.
- Close out refactor branch; allow normal feature PRs to resume full velocity.

## Testing strategy

- **Per-PR (mandatory, merge gate):**
  - `npx vitest run` + test-count invariant (pre == post).
  - `npm run test:integration` (gate for Phase 3 / 4).
  - `npm run test:coverage` (gate for Phase 1 / 2).
  - `npx next build`.
  - `npm run pre-pr` (lint + 7 static checks + gitleaks + all verify-* scripts).
  - `git log --follow <moved-file>` spot-check on one file per phase.
- **Per-PR (spot-check):**
  - Local dev server smoke on `/dashboard`, `/dashboard/passwords`, `/dashboard/teams`.
- **Per-phase (CI, blocking):**
  - E2E Playwright (`audit-outbox-integration`, `rls-smoke`, full E2E suite).
- **No new tests added.** Move-only refactor. Adding tests masks move regressions.

## Considerations & constraints

### Risks and mitigations (consolidated)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Missed `@/lib/...` import → build failure | Low | High | ts-morph AST + `tsc --noEmit` + stray-reference grep |
| Missed `vi.mock("@/lib/...")` → real module runs in test (real DB, real crypto) | Medium | **Critical** (silent false-pass) | Codemod rewrites vi.mock string literals; pre/post occurrence count asserted zero-stale |
| `check-bypass-rls.mjs` model-set drift during rename | Medium | **Critical** (cross-tenant data access) | `verify-allowlist-rename-only.mjs` mandatory pre-PR gate |
| New crypto file bypasses `check-crypto-domains.mjs` | Medium | **Critical** (cross-protocol key reuse) | Converted to glob + discover-all + fail-on-missing in Phase 0 |
| Codemod script weaponized (malicious edit) | Low | **Critical** (silent PBKDF2/HKDF change) | CODEOWNERS gate on codemod file; CI re-runs at last-merged revision; verify-move-only-diff gate on crypto/auth |
| `vitest.config.ts` coverage include silently stops matching → security-file coverage drops | Medium | **Critical** (coverage-blind backdoor) | Added to allowlist; `check-vitest-coverage-include.mjs` asserts every entry resolves |
| Root-config relative import breaks (`next.config.ts`, `sentry.*.config.ts`) | High (without fix) | **Critical** for sentry (telemetry secret leak) | Codemod scope extended to repo-root configs; `./src/lib/...` recognized |
| CI `grep -v 'webhook-dispatcher.ts'` silent drift → SSRF surface | Medium | **Major** | `webhook-dispatcher.ts` PINNED at root in this refactor; future move requires ci.yml update in same PR |
| Missing CODEOWNERS → review inheritance lost | N/A today | **Major** forensics | CODEOWNERS created in Phase 0 |
| `git blame` post-move points to refactor-commit author → forensic dead-end | High | **Major** | `.git-blame-ignore-revs` populated per phase + `docs/forensics.md` |
| Transitional-window inconsistency (3-8 weeks, multiple in-flight PRs) | Medium | **Major** | Single-phase-PR-in-flight quiesce rule; `refactor-phase-verify.mjs` on post-merge tree |
| Pre-move secret scan misses | Low | Medium | `gitleaks detect --staged` + post-move `.env` grep reject |
| `.mjs` import chains break (scripts/__tests__, load-test) | Low | Medium | First-class `.mjs` codemod support + `check-mjs-imports.mjs` |
| Dynamic template-literal `import()` unsafe → path traversal | Low (none exist today in scope) | Major if introduced | Codemod FAILS (not warns); Phase 0 audit confirms zero matches in moved-path prefix |
| Re-export chains missed | Low | Medium | Enumerated via `rg "^export .* from"`; codemod rewrites |
| Relative imports inside moved files resolve wrong | High | High | Codemod recomputes every relative specifier per-move; tsc catches any miss |
| Git rename detection broken by content edits | Medium | Medium | `git mv` only; no content edits in move commit beyond imports |
| Directory name collisions (`form/` vs `forms/`, `detail/` vs `detail-sections/`) | N/A (now resolved) | Medium | Consolidated into single canonical name; see §Proposed subdirs |
| Test count silently drops | Medium | Major | Pre/post test count assertion per PR |
| Docs drift across `.tsx`, hooks, components/passwords paths | High | Low-Medium | Widened pre-audit regex + `check-doc-paths.mjs` |
| Large PR overwhelms review | Medium | Medium | ≤ 30 file moves + ≤ 200 import updates per PR; split if exceeded |
| Feature-branch merge conflicts during refactor | Medium | Medium | Documented rebase procedure; rerun same codemod on feature branch |

### Explicitly out of scope

- Consolidating `src/__tests__/` / `src/lib/__tests__/` contents (separate decision).
- Renaming files (only directory reparenting in scope).
- Extracting additional aliases.
- Any content changes inside moved files except the minimum imports/exports/`vi.mock` specifier updates.
- Moving files remaining-at-root per allowlist disposition (e.g., `tenant-rls.ts`, `webhook-dispatcher.ts`).

## User operation scenarios

1. **Developer pulls latest main after Phase 2 lands, runs `npm run dev`.**
   Expected: dev server starts, no module resolution errors. Failure mode watched: `Error: Cannot find module '@/lib/crypto-client'` — stray-reference grep prevents this from merging.

2. **Developer on feature branch rebases onto post-Phase-1 main.**
   Expected: conflicts on feature-branch files importing moved `@/lib/auth-*` — resolve by rerunning same codemod on feature branch. Procedure documented in phase PR description.

3. **Claude Code agent asks "where is crypto-client?" after Phase 2.**
   Expected: `Glob src/lib/crypto/*.ts` finds it; CLAUDE.md already updated in Phase 2 PR; `check-doc-paths.mjs` ensures no stale doc references remain.

4. **CI runs `scripts/check-bypass-rls.mjs` on a PR that edits `src/lib/auth/audit-outbox.ts`.**
   Expected: allowlist contains `src/lib/auth/audit-outbox.ts`, check passes. `verify-allowlist-rename-only.mjs` ran in the phase PR that introduced this path; model set was byte-identical to pre-move entry.

5. **`git blame src/lib/auth/api-key.ts` after Phase 1.**
   Expected: with `git config blame.ignoreRevsFile .git-blame-ignore-revs`, blame skips the refactor-commit and shows actual authorship. Without config, default `git blame` shows refactor author — mitigated by `docs/forensics.md` instruction.

6. **Security reviewer audits Phase 2 (`src/lib/crypto/`).**
   Expected: `verify-move-only-diff.mjs` output in PR description shows empty diff after stripping imports/exports; reviewer spot-checks one file; CODEOWNERS requires security-team approval.

7. **Post-incident forensic: "who last modified crypto-client.ts?"**
   Expected: analyst uses `git log --follow -M90% --find-renames src/lib/crypto/crypto-client.ts`; rename detection returns pre-move commits. `.git-blame-ignore-revs` + `docs/forensics.md` make this the default configured experience.

8. **Adversarial scenario: attacker attempts silent model-set expansion.**
   Attacker proposes "Phase N rename" PR with `scripts/check-bypass-rls.mjs` diff adding `passwordEntry` to `webhook-dispatcher.ts`'s allowed models.
   Expected: `verify-allowlist-rename-only.mjs` detects model-set change (not a pure rename); PR fails pre-pr. CODEOWNERS requires security-team review. `verify-move-only-diff.mjs` (if file touched) catches any content change beyond imports.

## Success criteria

- All three target directories have ≤ 30 non-test top-level files.
- `pre-pr.sh` green on final commit of each phase PR.
- CI (E2E + integration) green on merge.
- `git log --follow` works for spot-checked moved files per phase.
- No external-facing change (API/behavior/route/schema).
- All allowlists accurate for all moved files at each phase (no stale entries, no un-gated files).
- `.git-blame-ignore-revs` contains every refactor-phase move-commit SHA.
- CODEOWNERS enforces security review for security-sensitive path changes at close.
- Test-count invariant held across every phase (no lost tests).
- `check-crypto-domains.mjs` runs in glob+discover-all mode post-Phase-0.
