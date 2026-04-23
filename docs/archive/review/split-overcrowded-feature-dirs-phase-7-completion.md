# Phase 7: Completion Report

Date: 2026-04-23
Branch: `refactor/split-overcrowded-feature-dirs`
Base: `main`
Commits on branch: 53 (26 refactor commits + 26 blame-ignore chore commits + 1 review-complete commit)

## Success criteria — all met

| Target directory | Before (non-test) | After (non-test) | Target | Status |
|---|---|---|---|---|
| `src/lib/`                | 134 | 44 | ≤ 45 | ✓ |
| `src/hooks/`              | 60  | 5  | ≤ 30 | ✓ |
| `src/components/passwords/` | 62 | 0  | ≤ 30 | ✓ |

Additional success criteria verified:
- `node scripts/refactor-phase-verify.mjs` → 13/13 scripts pass on final HEAD.
- `npx eslint .` → 0 warnings.
- `npx next build` → success.
- Test-count invariant: 7236 pre-refactor == 7236 post-refactor (zero lost/newly-skipped/newly-failing tests).
- No duplicate directories: `src/hooks/form` (singular) as consolidated; `src/components/passwords/detail/` with `detail/sections/` nested (old `detail-sections/` removed).
- `.git-blame-ignore-revs` contains all 13 refactor move SHAs.
- Every security-sensitive path is covered by CODEOWNERS `/src/lib/auth/**`, `/src/lib/crypto/**`, `/src/lib/audit/**`.

## Phase-by-phase summary

| Phase | Subdir | Impl | Tests | Import sites | Key rewrites |
|---|---|---|---|---|---|
| 1a | `src/lib/auth/` (tokens) | 6 | 5 | 44 | 24 alias + 28 vi.mock |
| 1b | `src/lib/auth/` (webauthn) | 3 | 2 | 20 | 12 alias + 8 vi.mock |
| 1c | `src/lib/auth/` (session/lockout/device) | 8 | 7 | 58 | 35 alias + 32 vi.mock |
| 1d-1 | `src/lib/auth/` (tenant-auth, team-auth) | 2 | 2 | 164 | 102 alias + 88 vi.mock |
| 1d-2 | `src/lib/auth/` (core auth rest) | 10 | 9 | 130 | 79 alias + 72 vi.mock |
| 2 | `src/lib/crypto/` | 9 | 8 | 149 | 127 alias + 77 vi.mock |
| 3-1 | `src/lib/audit/` (audit.ts alone) | 1 | 0 | 275 | 133 alias + 143 vi.mock |
| 3-2 | `src/lib/audit/` (remaining) | 11 | 6 | 40 | 45 alias + 9 vi.mock |
| 4a | `src/lib/security/` | 7 | 4 | 192 | 99 alias + 94 vi.mock |
| 4b | `src/lib/vault/` | 10 | 6 | 93 | 88 alias + 21 vi.mock |
| 4c | `src/lib/team/` | 6 | 5 | 37 | 26 alias + 14 vi.mock |
| 4d | emergency-access, tenant, format, folder, prisma, env, notification, generator | 17 | 15 | — | 130 alias + 26 vi.mock |
| 5a | `src/hooks/sidebar/` | 7 | 7 | — | 17 alias |
| 5b | `src/hooks/personal/` | 17 | 17 | — | 64 alias + 2 vi.mock |
| 5c | `src/hooks/team/` | 16 | 15 | — | 57 alias + 8 vi.mock |
| 5d | `src/hooks/form/` (extend existing) | 8 | 3 | — | 70 alias |
| 5e | `src/hooks/{vault,bulk}/` | 6 | 6 | — | 44 alias |
| 6a | `src/components/passwords/import/` | 14 | 4 | — | 31 alias + 3 vi.mock |
| 6b | `src/components/passwords/export/` | 2 | 1 | — | 4 alias |
| 6c | `src/components/passwords/entry/` | 15 | 8 | — | 117 alias |
| 6d | `src/components/passwords/personal/` | 13 | 4 | — | 16 alias + 14 vi.mock |
| 6e | `src/components/passwords/dialogs/` | 6 | 1 | — | 6 alias |
| 6f | `src/components/passwords/detail/{,sections/}` | 13 | 0 | — | 12 alias + 25 relative |
| 6g | `src/components/passwords/shared/` | 9 | 0 | — | 22 alias + 15 relative |

## Tooling bugs discovered & fixed during execution

1. **Phase 1a**: `verify-allowlist-rename-only.mjs`, `verify-move-only-diff.mjs`, `check-vitest-coverage-include.mjs` compared `main...HEAD` (commit-vs-commit) — invisible to pre-commit working-tree renames. Switched to `-M main` (working-tree vs main), equivalent on CI post-push.
2. **Phase 3-2**: codemod is AST-scoped; hardcoded `readFileSync(…"src/lib/audit-target-label.ts"…)` in a structural test was untouched. `capture-test-counts` caught it as `1 failed test`; fixed manually.
3. **Phase 4a**: `rewriteExternalRelativeImports` only handled static `ImportDeclaration` — dynamic `import()`, `require()`, `vi.mock/doMock/importActual/importOriginal`, `typeof import()` with **relative** string-literal specifiers were not rewritten (alias-only rewriter covered them). Added to codemod. Also: the rewriter stripped explicit `.ts`/`.tsx` extensions from the target, breaking `.mjs` files that import TypeScript sources with explicit extensions. Added extension preservation.
4. **Phase 5e**: two more hardcoded fs-path / string-assertion caught by `capture-test-counts` and fixed.
5. **Phase 6f**: three hardcoded fs-path readers in test files caught and fixed (`detail-sections/`, `password-list.tsx`, `password-detail-inline.tsx`).

Pattern: the codemod is AST-scoped, so any test that reads source files via `readFileSync` / `join(process.cwd(), …)` or asserts on source text via string literals requires manual follow-up. `capture-test-counts` invariant is the safety net that catches these — without it, silent test losses would pass CI.

## Residual `src/lib/` (44 single-instance utilities)

Explicitly pinned at root per plan disposition:
- RLS / infra: `tenant-rls.ts`, `tenant-context.ts`, `notification.ts`, `webhook-dispatcher.ts`, `url-helpers.ts`, `env.ts`, `load-env.ts`, `prisma.ts`, `password-generator.ts`

Single-instance utilities:
- `api-error-codes.ts`, `api-response.ts`, `backoff.ts`, `bulk-selection-helpers.ts`, `client-navigation.ts`, `cors.ts`, `credit-card.ts`, `download-blob.ts`, `dynamic-styles.ts`, `events.ts`, `export-format-common.ts`, `external-http.ts`, `filter-members.ts`, `google-domain.ts`, `health.ts`, `ime-guard.ts`, `inject-extension-bridge-code.ts`, `input-range.ts`, `locale.ts`, `logger.ts`, `openapi-spec.ts`, `parse-body.ts`, `parse-user-agent.ts`, `qr-scanner-client.ts`, `redis.ts`, `safe-keys.ts`, `secure-note-templates.ts`, `ssh-key.ts`, `tag-tree.ts`, `tailscale-client.ts`, `translation-types.ts`, `url-validation.ts`, `utils.ts`, `with-request-log.ts`, `wordlist.ts`

Each can be grouped later when a second sibling joins (e.g., `api/` for api-error-codes + api-response).

## Residual `src/hooks/` (5 single-instance hooks)

`use-callback-url.ts`, `use-local-storage.ts`, `use-tenant-role.ts`, `use-travel-mode.tsx`, `use-watchtower.ts` — no natural cluster; stay at root.

## Residual `src/components/passwords/` (0)

All files moved; top-level contains only subdirectories (`detail/`, `dialogs/`, `entry/`, `export/`, `import/`, `personal/`, `shared/`) and the `__tests__/` directory.
