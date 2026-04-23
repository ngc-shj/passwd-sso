# Plan Review: refactor-second-level-split
Date: 2026-04-23
Review round: 1 (initial)

## Changes from Previous Round
Initial review.

## Summary

| Severity | Count | Notes |
|---|---|---|
| Critical | 2 | F1/S1 (merged — CODEOWNERS regression), T8 (auth split integration-test gap) |
| Major | 15 | Cross-cut: refactor-tooling scope gaps, hardcoded-path drift (ci.yml, pre-pr.sh, allowlists), bucket-allocation deferral, barrel/mock integrity |
| Minor | 9 | Policy clarifications, doc link rot, developer-friction items |

The strongest theme: the plan correctly leans on the project's existing mechanical refactor tooling, but the tooling has **scope boundaries** (the `--old-prefix` list in `refactor-phase-verify.mjs`, the regex in `check-doc-paths.mjs`, the codemod's file-scan scope) that do NOT automatically extend to the new phases. Every scope boundary that goes unextended becomes a silent verification gap.

---

## Functionality Findings

### [F1] Critical — CODEOWNERS per-file script rules broken by PR 2 reorg
**[Merged with S1]** — see Security Findings for escalated version.

### [F2] Critical — `scripts/refactor-phase-verify.mjs` `--old-prefix` list does not cover settings/team/constants
- File: `scripts/refactor-phase-verify.mjs:108-110`
- Evidence: orchestrator hardcodes only `src/lib`, `src/hooks`, `src/components/passwords`. No `--old-prefix` for `src/components/settings`, `src/components/team`, `src/lib/constants`.
- Problem: After PR 4/6/7 split, stale dynamic-import specifiers (e.g., `await import("@/components/settings/tenant-password-policy-card")`) will NOT be flagged — only static imports (caught by `tsc`) are safe.
- Impact: Plan claims "all 13 scripts MUST pass" but misses 3 of the 4 refactor phases. Runtime `ReferenceError` possible in prod.
- Fix: In PR 1 or each of PR 4/6/7, extend `scripts` array in `refactor-phase-verify.mjs` with `--old-prefix` for `src/components/settings`, `src/components/team`, `src/lib/constants` (the last is covered transitively by `src/lib` but should be explicit).

### [F3] Major — Consumer enumeration for script paths is incomplete
- File: plan PR 2 step, `scripts/pre-pr.sh:32-53`, `package.json:10-40`, `.github/workflows/ci.yml`, `.github/workflows/refactor-phase-verify.yml`, `Dockerfile:25`, `docker-compose.override.yml:35`, `CLAUDE.md:22-24,458`, `docs/operations/deployment.md`.
- Evidence: Plan PR 2 says "Update `package.json` script entries ... and `scripts/refactor-phase-verify.mjs` inner script path references" — omits `pre-pr.sh`, workflows, Dockerfile, docker-compose, CLAUDE.md, operational docs.
- Problem: `pre-pr.sh` has 6 literal `scripts/...` invocations; workflows have path filters and inline calls; Dockerfile has `RUN npx esbuild scripts/audit-outbox-worker.ts`. If any is missed, CI or container build fails.
- Fix: Enumerate every consumer explicitly in the plan before PR 2 opens.

### [F4] Major — `scripts/audit-outbox-worker.ts` classification unclear
- File: `Dockerfile:25`, `docker-compose.override.yml:35`
- Evidence: `audit-outbox-worker.ts` is a runtime worker entrypoint referenced by Dockerfile build and docker-compose-override command. Plan's PR 2 proposes `{checks,refactor,manual-tests}` subdirs — none fits a runtime worker.
- Problem: If moved, Dockerfile / docker-compose breaks. If not moved, plan must declare it root-fixed in `scripts/`.
- Fix: PR 2 defines an explicit policy: operator & runtime entrypoint scripts (`audit-outbox-worker.ts`, `deploy.sh`, `purge-history.sh`, `purge-audit-logs.sh`, `rotate-master-key.sh`, `set-outbox-worker-password.sh`, `scim-smoke.sh`, `mcp-reauth.sh`, `generate-icons.sh`) stay at `scripts/` root. Codify in `CONTRIBUTING.md` (PR 1).

### [F5] Major — `check-doc-paths.mjs` regex scope excludes `scripts/` and the new component subdirs
- File: `scripts/check-doc-paths.mjs:42-43`
- Evidence: regex: `/src\/(?:lib|hooks|components\/passwords)\/[a-z0-9_/.-]+\.(?:tsx|ts)/g`. Only matches three prefixes.
- Problem: `docs/operations/deployment.md`, `CLAUDE.md`, `README.md` references to `scripts/*.sh` are NOT checked. New settings/team subdirs are NOT checked.
- Fix: Extend regex in PR 1 (before moves) to include `scripts/[a-z0-9_-]+\.(sh|mjs|ts)` and `src/components/(settings|team)/[a-z0-9_/.-]+\.(?:tsx|ts)`. Alternatively, add a grep assertion to PR 2/6/7 checklists.

### [F6] Major — `ci.yml` inline `grep -v` whitelist references `src/lib/webhook-dispatcher.ts` and `src/lib/url-helpers.ts`
**[Merged with S3]** — see Security Findings for escalated framing (SSRF/misrouting risk).

### [F7] Major — `scripts/check-bypass-rls.mjs` ALLOWED_USAGE has 25+ hardcoded `src/lib/` paths
- File: `scripts/check-bypass-rls.mjs:22-50`
- Evidence: entries like `"src/lib/tenant-rls.ts"`, `"src/lib/tenant-context.ts"`, `"src/lib/notification.ts"`, `"src/lib/webhook-dispatcher.ts"` — all PR 5 candidates.
- Problem: The codemod's `rewriteAllowlistFile` uses an anchored regex; `verify-allowlist-rename-only.mjs` provides fail-closed protection (blocks PR if byte-set drifts). So this is flag-only unless the plan omits the verify step.
- [Adjacent] Major: overlaps with Security expert scope for RLS boundary integrity.
- Fix: PR 5 plan body explicitly lists the 25 allowlisted files being moved and requires the `verify-allowlist-rename-only` output in PR description.

### [F8] Major — Constants split lists `team-permission.ts`/`team-role.ts`/`mcp.ts` under multiple buckets with `?`
- File: plan §"src/lib/constants/ → 5 subdirs" table
- Evidence: rows for `auth/`, `team/`, `mcp/` all list the same files with `?`.
- Problem: Deferred allocation; each file has exactly one true home.
- Fix: Resolve dedup in plan BEFORE PR 4 executes. Also: a proposed subdir `src/lib/constants/auth/` resembles `src/lib/auth/` but is NOT CODEOWNERS-covered. Either rename (e.g., `rbac/`, `access/`) or add CODEOWNERS rule `/src/lib/constants/auth/** @ngc-shj`.

### [F9] Major — Deferred bucket allocation prevents up-front verification of ≤25 / ≤30 threshold
- File: plan line 93, line 166
- Evidence: plan says "Final file allocation will be computed at execution time" yet commits to "no bucket > 25".
- Problem: Reviewer cannot confirm (a) threshold is meetable, (b) no circular imports arise (R10), (c) barrel re-exports stay coherent.
- Fix: Produce concrete `docs/archive/review/phases/refactor-second-level-split-phase-{4,5,6,7,8}.json` with final from→to mapping before opening each phase PR; re-review mapping. The project already uses this phase-config pattern (PR #392).

### [F10] Major — Plan does not verify whether `src/lib/webauthn/` exists before proposing the sub-dir
- File: plan line 119, 123
- Evidence: verified — `src/lib/webauthn/` does NOT exist; only `src/lib/auth/webauthn-{authorize,client,server}.ts` files exist (3 non-test files).
- Problem: A `webauthn/` sub-dir under `src/lib/auth/` would hold only 3 files — under-populated vs other proposed sub-dirs (`policy/`: 6, `tokens/`: 6).
- Fix: Either commit to "`src/lib/webauthn/` does not exist; webauthn files move to `src/lib/auth/webauthn/`" OR fold webauthn into `session/`. Decide in plan, not at execution.

### [F11] Major — PR 8 conditional criterion contradicts current threshold
- File: plan line 77, 170, 233
- Evidence: completion criterion says `src/lib/auth/ ≤ 30`; current count is 29; plan calls PR 8 "optional, borderline" and triggers only "if overcrowded".
- Problem: By the stated threshold, 29 is NOT overcrowded — so PR 8 should be unambiguously skipped. Plan is internally contradictory.
- Fix: Pick one threshold (either "> 25" or "> 30") and apply it to both §Requirements and PR 8 trigger. Explicitly declare PR 8 SKIP or DO based on that rule.

### [F12] Major — PR 8 CODEOWNERS update is redundant or narrowing
- File: plan line 170
- Evidence: existing `/src/lib/auth/** @ngc-shj` already recursively matches `/src/lib/auth/tokens/**`.
- Problem: Adding explicit sub-path rules is either redundant or silently narrows coverage.
- Fix: PR 8 plan states "`/src/lib/auth/** @ngc-shj` already covers all sub-dirs — no CODEOWNERS edit required. Verify via `gh api repos/:o/:r/codeowners/errors` post-merge."

### [F13] Minor — PR 3 (`docs/README.md` index update) is near-noop
- File: plan line 72, 165
- Fix: Fold into PR 9 wrap-up OR mark "skip-if-no-drift."

### [F14] Minor — "Serialize, don't parallelize" not enforced
- File: plan line 178, 223
- Fix: Add a `refactor-phase-verify.mjs` check that fails if `git branch -a --list 'refactor/*'` lists more than the current branch.

### [F15] Minor — CLAUDE.md path references updated only at PR 9
**[Merged with S5]** — see Security Findings for incident-response angle.

### [F16] Minor — Scenario B `--dry-run` guidance is vague
**[Merged with T9]** — see Testing Findings.

---

## Security Findings

### [S1] Critical — CODEOWNERS hardcodes per-file script paths that PR 2 reorg will break
- File: `.github/CODEOWNERS:4-14`
- Evidence: 11 explicit entries like `/scripts/move-and-rewrite-imports.mjs @ngc-shj`, `/scripts/check-bypass-rls.mjs @ngc-shj`, `/scripts/verify-move-only-diff.mjs @ngc-shj`, `/scripts/check-crypto-domains.mjs @ngc-shj`. None use `**`. GitHub CODEOWNERS does not apply `*` across `/`.
- Problem: When these files move to sub-dirs under `scripts/`, every literal-path rule STOPS matching — the security-guard scripts become editable without owner review for any commit window where CODEOWNERS update lags the move.
- Impact: Future PR could modify `check-bypass-rls.mjs` or `check-crypto-domains.mjs` to weaken the static RLS/crypto-domain guard without `@ngc-shj` review. These are the project's primary static defense against RLS bypass and crypto-domain reuse.
- Fix: Before PR 2 merges: (a) rewrite CODEOWNERS to survive the reorg — `/scripts/checks/** @ngc-shj` + `/scripts/refactor/** @ngc-shj` (or broaden to `/scripts/** @ngc-shj`); (b) update CODEOWNERS in the SAME commit as the move; (c) add a post-diff check in PR 2 that, for every moved script, asserts at least one CODEOWNERS rule still matches the new path; (d) dry-run `gh api repos/:o/:r/codeowners/errors` post-push.
- escalate: true
- escalate_reason: Loss of owner-gate on refactor-tooling scripts + RLS/crypto guard scripts is an authorization-boundary / supply-chain-integrity regression. The guards are the project's primary static defense against RLS bypass and crypto-domain reuse — silent loss is Critical.

### [S2] Major — No programmatic CODEOWNERS-drift guard exists
- File: `.github/CODEOWNERS`, `scripts/refactor-phase-verify.mjs:99-111`
- Evidence: `refactor-phase-verify.mjs` runs 13 checks; none validates CODEOWNERS coverage of a declared "must-have-owner" set.
- Fix: Add `scripts/check-codeowners-drift.mjs` that loads `.github/CODEOWNERS`, walks the working tree, and asserts every path in a pre-declared roster matches at least one rule. Wire into `refactor-phase-verify.mjs` as check #14. Add in PR 1 (before any moves).

### [S3] Major — `ci.yml` fetch-basePath grep has literal `src/lib/webhook-dispatcher.ts` and `src/lib/url-helpers.ts` exclusions
- File: `.github/workflows/ci.yml:139-145`
- Evidence: `| grep -v 'src/lib/webhook-dispatcher.ts' | grep -v 'src/lib/url-helpers.ts'` inside "Check fetch basePath compliance" step.
- Problem: PR 5 moves both files. When the literal paths no longer match, either (a) CI false-positives and blocks, or (b) the guard silently allows a non-basePath `fetch()` — an SSRF / URL-misrouting risk.
- Fix: In PR 5, update `ci.yml` `grep -v` clauses to the new paths in the SAME PR. Alternatively, replace with an ESLint rule that tracks imports. Add to PR 5 checklist: `grep -q 'src/lib/url-helpers.ts' .github/workflows/ci.yml && exit 1`.

### [S4] Major — `.git-blame-ignore-revs` has no schema guard
- File: `.git-blame-ignore-revs`, `docs/forensics.md:54-67`
- Evidence: `forensics.md` declares "Only include the SHA of the move commit itself" as policy; no automated check enforces it.
- Problem: A refactor PR could accidentally add a content-edit SHA (e.g., a merge-conflict resolution that landed in the move commit), and `git blame` would forever hide authorship of that content change. Incident-response would surface a wrong author.
- Fix: Add `scripts/check-blame-ignore-revs.mjs` that, for each SHA, runs `git show --stat <sha>` and asserts the commit is rename-only (no content hunks exceeding a trivial threshold). Wire into `refactor-phase-verify.mjs`.

### [S5] Minor — CLAUDE.md operator scripts (incident-response runbook) may invalidate after PR 2
- File: `CLAUDE.md:22-24`, plan Scenario E
- Evidence: CLAUDE.md embeds `scripts/purge-history.sh`, `scripts/rotate-master-key.sh`, `scripts/set-outbox-worker-password.sh`, `scripts/purge-audit-logs.sh` as operator-documented commands. Plan says "likely should NOT be moved" — not a policy.
- Problem: During an active security incident, an operator following CLAUDE.md would fail to rotate the master key or purge history if the documented path no longer exists.
- Fix: Declare operator & incident-response scripts root-fixed in `CONTRIBUTING.md` (PR 1). List them explicitly. Extend `check-doc-paths.mjs` to scan CLAUDE.md references to `scripts/`.

### [S6] Minor — `src/lib/constants/auth/` proposal has no CODEOWNERS coverage
- File: `.github/CODEOWNERS`, plan §"src/lib/constants/ → 5 subdirs"
- Evidence: no `/src/lib/constants/**` rule; auth-policy-adjacent constants (`scope-parser`-referenced scope strings, `mcp.ts` token scopes, `service-account.ts` prefixes) currently sit outside owner gate.
- Problem: A modification to `src/lib/constants/mcp.ts` can widen the scope of an MCP token without crypto/auth owner seeing it.
- Fix: In PR 4, add `/src/lib/constants/auth/** @ngc-shj` (or for specific files). Document rationale in CONTRIBUTING.md.

### [S7] Minor — Stale import path risk after `src/lib/auth/` sub-split (PR 8)
- File: plan Scenario B (line 188)
- Evidence: `move-and-rewrite-imports.mjs` uses `git mv` (atomic); but no check ensures no legacy barrel or path-alias leaves a dual entry-point.
- Fix: After each auth move, assert `grep -R "from '@/lib/auth/<old-file>'" src/` returns zero AND the old file is absent. Audit `src/lib/auth/index.ts` (if any) for stale re-exports.

### [S8] Minor — `scripts/deploy.sh` not declared in root-fixed vs relocatable policy
- File: plan §"Relocatable candidates"
- Fix: Explicitly list `scripts/deploy.sh` as root-of-`scripts/`-fixed in CONTRIBUTING.md.

---

## Testing Findings

### [T1] Major — Test-file co-location not guaranteed by the codemod
- File: `scripts/move-and-rewrite-imports.mjs:272-286`; plan lines 96-110
- Evidence: the codemod moves only literal `moves[]` entries from the phase-config. No auto-pair heuristic co-moves `foo.test.ts` when `foo.ts` moves. `src/lib/constants/` alone has 9+ co-located `*.test.ts` files.
- Problem: If a config omits the test file while moving the impl, test either (a) breaks on relative imports, or (b) silently orphans at an old location (vitest coverage reduced).
- Fix: Hard rule in §"Mechanical edit protocol" step 2: "For every `foo.ts(x)` in `moves[]`, if a sibling `foo.test.ts(x)` exists, the config JSON MUST include the matching move entry." Add a pre-codemod shell guard (or codemod `--check-test-pairs` flag) that fails if any sibling test is missing from the config.

### [T2] Major — `check-dynamic-import-specifiers.mjs --old-prefix` scope gap
**[Merged with F2]** — same underlying gap. Recommendation: extend `refactor-phase-verify.mjs` once in PR 1 covering `src/components/settings` and `src/components/team`.

### [T3] Major — Integration tests not guaranteed to run for `src/lib/prisma|redis|tenant-*|auth/*-token`
- File: plan Testing strategy §2 (line 176); `scripts/pre-pr.sh:46`; `.github/workflows/refactor-phase-verify.yml`
- Evidence: `pre-pr.sh` runs `npx vitest run` (unit only). CI workflow likewise. Integration tests require `npm run test:integration` (live Postgres).
- Problem: PR 5 and PR 8 move DB-touching modules. A stale `vi.mock("@/lib/prisma")` path or integration-test import can land silently.
- Fix: Either (a) add a conditional `run_step` to `pre-pr.sh` invoking `npm run test:integration` on `refactor/*` branches when diff touches the listed paths, OR (b) PR-template requires pasted integration-test summary for refactor PRs touching those paths. Option (a) preferred.

### [T4] Major — `capture-test-counts` baseline advancement procedure not documented
- File: plan Testing strategy §5; `scripts/capture-test-counts.mjs:112-147`; `.github/workflows/refactor-phase-verify.yml:56-66`
- Problem: If an intentional test addition creeps into a large refactor PR (e.g., PR 5), baseline mismatch has no documented resolution. Risk of someone running `--record` to "fix" CI and masking a real test loss.
- Fix: Plan §"Mechanical edit protocol" step 7 adds: "Move-only PRs MUST NOT change test counts. If mismatch, split content into a separate PR. `--record` invocation requires reviewer sign-off in PR body."

### [T5] Major — `src/lib/constants/index.ts` barrel integrity verification missing from plan
- File: `src/lib/constants/index.ts` (115 lines of re-exports); plan §"Testing strategy"
- Evidence: codemod DOES rewrite relative exports in `index.ts` via `rewriteExternalRelativeImports`. 287 import sites use `from "@/lib/constants"` barrel form. 16+ `vi.mock("@/lib/constants/<name>")` deep-mocks exist.
- Problem: The plan never commits to verifying barrel re-export coherence post-move. A missed `export * from "./x"` would silently lose a symbol.
- Fix: Testing strategy §6 adds: "After `src/lib/constants/` split, run `npx tsc --noEmit` and assert every `from \"@/lib/constants\"` symbol still resolves." (No new tool; protocol-only strengthening.)

### [T6] Minor — E2E selector vs import stability wording
- File: plan line 177
- Fix: Rephrase as: "E2E test files (`e2e/tests/*.spec.ts`) do not import component paths. `check-e2e-selectors.sh` guards against `data-testid`/aria-label regressions."

### [T7] Minor — `vitest.config.ts` file-specific `coverage.thresholds` keys
- File: `vitest.config.ts`
- Fix: One-time pre-PR 4 audit — `grep -E "src/lib/constants/[a-z-]+\.ts" vitest.config.ts`. If any exist, list in phase-config.

### [T8] Critical — PR 8 (`src/lib/auth/` split) lacks mandatory integration-test gate
- File: plan lines 77, 170, 176
- Evidence: PR 8 moves `service-account-token.ts`, `scim-token.ts`, `extension-token.ts`, `auth-or-token.ts`, `check-auth.ts`, `delegation.ts`, `team-auth.ts` — heart of Machine Identity. Integration tests at `src/__tests__/integration/{sa-lifecycle,jit-workflow,mcp-oauth-flow,audit-and-isolation}.test.ts` exercise these paths with live DB.
- Problem: Integration tests not in CI. A broken token-auth integration path lands and revoking a broken deployment is expensive (token lifetimes up to 24h).
- Impact: AI-agent / service-account authentication regression in prod.
- Fix: Completion criterion §8 added: "PRs touching `src/lib/auth/**` SHALL NOT merge without `npm run test:integration` green; output pasted in PR body. Additionally, a second `@ngc-shj` reviewer sign-off beyond the CODEOWNERS default is required." Make this explicit in the plan.

### [T9] Minor — Scenario B `--dry-run` guidance needs the phase-config JSON
**[Merged with F16]** — fix: commit phase-config JSON to `docs/archive/review/phases/refactor-second-level-split-phase-N.json` per phase; Scenario B says "re-use that committed config for rebase dry-run."

---

## Adjacent Findings

- **F7 → Security** (RLS allowlist integrity): addressed in S1 scope — already covered.
- **T3 → Functionality** (integration-test gating): addressed as T3; Functionality agrees.
- **F5/F15 → Security** (CLAUDE.md / docs drift): addressed in S5.

---

## Quality Warnings

No `[VAGUE]`, `[NO-EVIDENCE]`, or `[UNTESTED-CLAIM]` flags. All findings include file paths, line numbers, and concrete fixes.

---

## Recurring Issue Check

### Functionality expert
- R1 (Shared utility reimplementation): Checked — no issue (plan reuses existing tooling).
- R2 (Constants hardcoded): Finding F6, F7 — ci.yml & allowlists.
- R3 (Pattern propagation + enumeration): Finding F3 — consumer enumeration incomplete.
- R4 (Event dispatch gaps): N/A.
- R5 (Missing transactions): N/A.
- R6 (Cascade delete orphans): N/A.
- R7 (E2E selector breakage): Checked — plan claim verified (E2E is selector-based, not import-based).
- R8 (UI pattern inconsistency): N/A.
- R9 (Transaction boundary for fire-and-forget): N/A.
- R10 (Circular module dependency): Finding F9 — deferred bucket allocation risks cycles.
- R11: N/A. R12: N/A. R13: N/A. R14: N/A. R15: N/A. R16: N/A for refactor. R17: N/A. R18: Finding F1/F12 — CODEOWNERS sync.
- R19: Testing expert scope.
- R20 (Multi-statement preservation): Checked — codemod uses ts-morph AST; `verify-move-only-diff.mjs` fails-closed on parse failures. NOT a finding on tooling; F3/F4 document out-of-scope files (YAMLs, dotfiles) that need manual edits.
- R21: N/A. R22: N/A. R23: N/A. R24: N/A. R25: N/A. R26: N/A. R27: N/A. R28: N/A.
- R29 (External spec citation accuracy): N/A — no spec citations.
- R30 (Markdown autolink footguns): Checked — no bare `#<n>` / `@<name>` / commit-sha-shaped in plan doc.

### Security expert
- R1-R30: applicable rows covered above; Security expert also flagged:
- RS1 (Timing-safe comparison): N/A — refactor, no new comparisons.
- RS2 (Rate limiter on new routes): N/A — no new routes.
- RS3 (Input validation at boundaries): N/A — no new boundaries.

### Testing expert
- R1-R30: applicable rows covered above; Testing expert also flagged:
- RT1 (Mock-reality divergence): Checked — codemod handles `vi.mock`/`vi.doMock`/`vi.importActual`/`vi.importOriginal`/dynamic `import()`/`typeof import()`. See T2 for scope gap.
- RT2 (Testability): Checked — plan's strategy is achievable in this repo.
- RT3 (Shared constant in tests): Checked — 287 barrel-form imports + 16 deep mocks; codemod rewrites both. See T5 for barrel verification gap.

---

## Round 1 Resolution Status (applied in Round 2 plan revision)

| Finding | Severity | Resolution | Reflected in plan |
|---------|----------|------------|-------------------|
| F1/S1 | Critical | **Fixed** — CODEOWNERS converted to globs in PR 1 (before any move); `check-codeowners-drift.mjs` added as check #14 | §PR 1 item 8; Risks table "Eliminated" |
| T8 | Critical | **Fixed** — PR 8 SKIPPED entirely (threshold policy); integration-test gate documented for any future auth-touching PR (completion criterion §8) | §Current density baseline; §Testing strategy §2; §Completion criteria §8 |
| F2/T2 | Major | **Fixed** — `refactor-phase-verify.mjs --old-prefix` extended for `src/components/settings` and `src/components/team` in PR 1 | §PR 1 item 1 |
| F3 | Major | **Fixed** — PR 2 deliverables enumerate every consumer exhaustively (`pre-pr.sh` 6 calls, workflows, CLAUDE.md, deployment.md, etc.) | §PR 2 deliverables |
| F4 | Major | **Fixed** — `audit-outbox-worker.ts` declared root-of-`scripts/` fixed; `CONTRIBUTING.md` codifies the policy | §Requirements "Root-of-`scripts/` fixed"; §PR 1 item 7 |
| F5 | Major | **Fixed** — `check-doc-paths.mjs` regex extended in PR 1 to cover `scripts/`, `src/components/(settings|team)` | §PR 1 item 2 |
| F6/S3 | Major | **Fixed** — `ci.yml` grep update in PR 5 with post-move assertion | §PR 5 deliverables, "`ci.yml` literal-path update" |
| F7 | Major | **Fixed** — allowlist enumeration required in phase-config; PR body must paste `verify-allowlist-rename-only` output | §PR 5 deliverables, "Allowlist enumeration" |
| F8 | Major | **Fixed** — concrete constants mapping committed; `team-permission`/`team-role` → `team/`, `mcp.ts` → `auth/`; bucket renamed to `integrations/` | §PR 4 deliverables |
| F9 | Major | **Fixed** — phase-config JSONs mandatory before each phase PR opens (`docs/archive/review/phases/refactor-second-level-split-phase-N.json`) | §Mechanical edit protocol step 2 |
| F10 | Major | **Fixed** — `src/lib/auth/webauthn/` sub-dir proposal moot (PR 8 skipped) | §Current density baseline; §Out of scope |
| F11 | Major | **Fixed** — threshold canonicalized (>30 MANDATORY, 25-30 BORDERLINE, target ≤25); `src/lib/auth/` at 29 explicitly NOT split | §Objective; §Current density baseline |
| F12 | Major | **Fixed** — PR 8 skipped; CODEOWNERS discussion moot | §Out of scope |
| S2 | Major | **Fixed** — `check-codeowners-drift.mjs` added as refactor-phase-verify check #14 | §PR 1 item 3 |
| S4 | Major | **Fixed** — `check-blame-ignore-revs.mjs` added as check #15 | §PR 1 item 4 |
| T1 | Major | **Fixed** — `--check-test-pairs` mandatory flag on codemod; hard rule in §Mechanical edit protocol step 3 | §PR 1 item 5; §Mechanical edit protocol step 3 |
| T3 | Major | **Fixed** — conditional integration-test trigger in `pre-pr.sh` driven by diff path-match | §PR 1 item 6 |
| T4 | Major | **Fixed** — move-only invariant documented; `--record` requires reviewer sign-off | §Mechanical edit protocol step 11 |
| T5 | Major | **Fixed** — `npx tsc --noEmit` + barrel smoke check added as step 14 | §Mechanical edit protocol step 14; §Testing strategy §6 |
| F13 | Minor | **Fixed** — PR 3 folded into PR 9 wrap-up | §Phase ordering |
| F14 | Minor | **Fixed** — parallel-branch guard added to `refactor-phase-verify.mjs` in PR 1 (fails if >1 `refactor/*` branches exist simultaneously). Anti-Deferral 30-min rule: ~15 LOC is under the threshold, so deferral not allowed. | §PR 1 item 6 |
| F15/S5 | Minor | **Fixed** — extended `check-doc-paths.mjs` covers CLAUDE.md; operator scripts explicitly root-fixed | §PR 1 item 2; §Requirements |
| F16/T9 | Minor | **Fixed** — phase-config JSONs committed per phase; Scenario B uses them for rebase dry-run | §User operation scenarios B |
| S6 | Minor | **Fixed** — `/src/lib/constants/auth/** @ngc-shj` CODEOWNERS rule added in PR 1 | §PR 1 item 8 |
| S7 | Minor | **Fixed** — PR 8 skipped; stale barrel concern moot | §Out of scope |
| S8 | Minor | **Fixed** — `scripts/deploy.sh` declared root-of-`scripts/` fixed | §Requirements |
| T6 | Minor | **Fixed** — E2E wording clarified (selector-based vs import-based) | §Testing strategy §3 |
| T7 | Minor | **Fixed** — one-time `vitest.config.ts` audit step added | §Testing strategy §10 |

**All Round 1 findings resolved**. No remaining deferrals requiring Anti-Deferral sign-off.

---

# Plan Review: refactor-second-level-split (Round 2)
Date: 2026-04-23
Review round: 2

## Changes from Previous Round
Round 2 plan revision applied all 26 Round 1 findings as "Fixed". Three expert sub-agents re-reviewed the revised plan. Round 2 identified **1 continuing Critical** (S1 — CODEOWNERS regression window resurfaces in new form), **12 new Major** findings, and **6 new Minor** findings. The central theme: PR 1 has internal sequencing defects that the Round 1 fix inadvertently introduced.

## Summary

| Severity | Count | Notes |
|---|---|---|
| Critical | 1 | S1 (continuing) — regression window + self-blocking drift check |
| Major | 12 | Cross-cut: sequencing gaps between PR 1/PR 2/PR 5; CI-side enforcement absent; mapping errors in PR 5 |
| Minor | 6 | Under-specifications, dead rules, unverified claims |

---

## Functionality Findings (Round 2)

### Verification of Round 1 fixes

| F# | Status | Notes |
|----|--------|-------|
| F1/S1 | REGRESSION | See [S1 (continuing)] below — new sequencing gap |
| F2 | Fixed | `refactor-phase-verify.mjs --old-prefix` coverage extended |
| F3 | Partial | See [F17] (`SKIP_GLOBS` still excludes `operations/`), [F19] (`scripts/__tests__/`) |
| F4 | Fixed | root-of-`scripts/` fixed list verified |
| F8 | Fixed | partition sums to 30, no duplicates |
| F9 | Fixed | codemod `--config` flag supported |
| F11 | Fixed | threshold `>30` applied consistently |
| F14 | REGRESSION | See [F20] — parallel-branch guard always fires on actual repo |
| Others | Fixed | — |

### New findings

**[F17] Major — `check-doc-paths.mjs` `SKIP_GLOBS` still excludes `operations/` despite F3/F5 resolution claim**
- File: `scripts/check-doc-paths.mjs:31-37`
- Evidence: `SKIP_GLOBS` contains `/^operations[/\\]/`; `docs/operations/deployment.md` has 5 `scripts/` refs that need scanning after PR 2 moves.
- Problem: Plan's PR 1 item 2 adds `SCRIPT_REF_RE` but doesn't remove `operations` from skip list — the intended check is defeated.
- Fix: PR 1 item 2 must explicitly remove `operations` from `SKIP_GLOBS` for the `SCRIPT_REF_RE` pass (or create a dedicated scan function that bypasses `SKIP_GLOBS`).

**[F18] Major — PR 1 deletes literal CODEOWNERS rules for `scripts/check-*.mjs` BEFORE PR 2 moves the files**
- See [S1 (continuing)] — merged.

**[F19] Major — Consumer enumeration still omits `scripts/__tests__/*.test.mjs`**
- File: `scripts/__tests__/check-licenses.test.mjs:6-8`, `scripts/__tests__/check-crypto-domains.test.mjs`
- Evidence: these test files resolve sibling scripts via `resolve(__dirname, "..", "check-licenses.mjs")`. After PR 2 moves scripts to `scripts/checks/`, these paths become stale.
- Fix: Add `scripts/__tests__/*.test.mjs` to PR 2 consumer list.

**[F20] Major — `git branch -a --list 'refactor/*'` parallel-branch guard always fires**
- File: plan §PR 1 item 6
- Evidence: on the actual repo, `git branch -a --list 'refactor/*' | wc -l` returns 7 (merged local + remote-tracking). The guard `> 1` always triggers.
- Fix: Use `git branch --list 'refactor/*' --no-merged main | grep -v '^\*' | wc -l` OR check open PRs via `gh pr list --state open --json headRefName`. Specify exactly one implementation.

**[F21] Major — PR 5 mapping has `credit-card.ts` duplicated + phantom `validations.ts`**
- File: plan §PR 5 deliverables lines 183, 186, 195
- Evidence: `credit-card.ts` appears in BOTH `ui/` and root-keep. `src/lib/validations.ts` does NOT exist (only `validations.test.ts` + `validations/` dir).
- Fix: (a) commit `credit-card.ts` to `ui/` only, (b) remove phantom `validations.ts` row, (c) specify `validations.test.ts` destination, (d) re-verify sum = 44.

**[F22] Major — PR 5 creates 5 single-file sub-dirs (`redis/`, `openapi/`, `tailscale/`, `extension-bridge/`, partly `events/`) — YAGNI violation**
- File: plan §PR 5 deliverables
- Evidence: 4 NEW subdirs each hold 1 file; `events/` holds 2.
- Fix: Fold `redis.ts`/`tailscale-client.ts` into existing `services/`; keep `openapi-spec.ts` at root; drop `extension-bridge/`. Only NEW subdirs: `http/`, `url/`, `ui/`, `events/`.

**[F23] Major — `/src/lib/tenant-rls.ts` CODEOWNERS rule becomes dead after PR 5 moves file to `src/lib/tenant/tenant-rls.ts`**
- File: `.github/CODEOWNERS:25`, plan §PR 5 deliverables
- Evidence: PR 5 moves `tenant-rls.ts` into `tenant/`; no CODEOWNERS rule for `/src/lib/tenant/**` exists or is added.
- Fix: PR 5 MUST add `/src/lib/tenant/** @ngc-shj` (or `/src/lib/tenant/tenant-rls.ts @ngc-shj`) atomically with the move. Update `check-codeowners-drift.mjs` roster to the new path.

### Minor

**[F25] Minor — `/src/lib/crypto*` and `/src/lib/auth*` flat-file patterns are already dead** — PR 9 wrap-up could remove as optional cleanup.
**[F26] Minor — `/src/lib/constants/auth/** @ngc-shj` added in PR 1 before directory exists** — fragile but benign; preferred move to PR 4.

### Continuing findings
None beyond those re-framed as F17–F26 above.

## Recurring Issue Check (Functionality R1–R30)
- R1: OK. R2: F17/F20/F24 — hardcoded paths in grep. R3: F19/F23 — enumeration incomplete. R18: F18/F23/F26 — CODEOWNERS sync timing. Others: N/A or OK.

---

## Security Findings (Round 2)

### Verification of Round 1 fixes

| S# | Status | Notes |
|----|--------|-------|
| S1 | REGRESSION | See [S1 (continuing)] |
| S2 | Partial | See [S10] (roster omits `.github/workflows/**`, CODEOWNERS itself, `.git-blame-ignore-revs`) |
| S3 | Fixed | `ci.yml` post-move assertion executable |
| S4 | Partial | See [S12] (rename detection mechanism under-specified) |
| S6 | Fixed | `/src/lib/constants/auth/** @ngc-shj` added |

### Continuing

**[S1 (continuing from round 1)] Critical — CODEOWNERS regression window + self-blocking PR 1**
- File: plan §PR 1 item 9 lines 127–134; `.github/CODEOWNERS`; §PR 1 item 3 roster
- Evidence: PR 1 DELETES 11 literal `/scripts/<name>.mjs` rules AND adds `/scripts/checks/** @ngc-shj`. Files stay at `scripts/` root until PR 2 moves them.
- Problem: (1) Between PR 1 merge and PR 2 merge, 7 security-guard scripts (`check-bypass-rls`, `check-crypto-domains`, `check-team-auth-rls`, `check-vitest-coverage-include`, `check-dynamic-import-specifiers`, `check-mjs-imports`, `check-doc-paths`) have NO CODEOWNERS coverage. (2) `check-codeowners-drift.mjs` roster in PR 1 item 3 includes `scripts/{…,check-*}.mjs` — at PR 1 merge time these files still sit at `scripts/check-*.mjs`, roster match, no CODEOWNERS rule → drift check FAILS → **PR 1 is self-blocking as written**.
- Impact: Either authorization-boundary regression on 7 guard scripts OR PR 1 unmergeable. Both outcomes Critical.
- Fix options:
  - (a) **PR 1 ADDS `/scripts/checks/** @ngc-shj` WITHOUT deleting old literal rules**. PR 2 deletes old rules atomically with the `git mv`. Recommended.
  - (b) PR 1 adds transitional glob `/scripts/check-*.mjs @ngc-shj` alongside the new `/scripts/checks/**`; PR 2 removes transitional when no longer needed.
  - (c) Merge PR 1 + PR 2 into a single atomic PR.
- escalate: true
- escalate_reason: RLS/crypto static guards are the project's primary defense against tenant-isolation bypass and crypto-domain reuse; an owner-less window (even transient) is an authorization-boundary regression. Additionally, PR 1 is unmergeable as written, a hard defect that surfaces at first execution.

### New findings

**[S9] Major — `scripts/pre-pr.sh` is not CODEOWNERS-protected despite being the enforcement vehicle**
- File: `.github/CODEOWNERS` (pre- and post-PR-1)
- Evidence: `pre-pr.sh` orchestrates 5 static guards + the conditional integration-test trigger; no CODEOWNERS rule covers it.
- Problem: Weakening `pre-pr.sh` (e.g., removing a `run_step` call) bypasses every downstream guard without editing any owner-gated script.
- Fix: Add `/scripts/pre-pr.sh @ngc-shj` in PR 1 item 9.

**[S10] Major — `check-codeowners-drift.mjs` roster omits existing CODEOWNERS-gated paths**
- File: plan §PR 1 item 3; `.github/CODEOWNERS` lines 16–17, 26–28
- Evidence: roster excludes `src/lib/crypto*` flat pattern, `src/lib/auth*` flat pattern, `.github/workflows/**`, `.github/CODEOWNERS`, `.git-blame-ignore-revs`.
- Fix: Expand roster to include every path currently protected by CODEOWNERS, not just the auth/audit/crypto directories.

**[S11] Major — Integration-test gate is not CI-enforced; `pre-pr.sh` is local-only**
- File: plan §Completion criteria §8; `.github/workflows/ci.yml`; `.github/workflows/refactor-phase-verify.yml`
- Evidence: `pre-pr.sh` runs locally; CI does not invoke `npm run test:integration` under `paths:` filter. A non-refactor feature PR touching `src/lib/auth/**` bypasses the gate entirely.
- Fix: Add a CI job (e.g., `.github/workflows/ci-integration.yml`) that triggers on `paths: ['src/lib/auth/**', 'src/lib/(prisma|redis|tenant)*/**']` and runs `npm run test:integration` with Postgres service. Block merge on failure.

### Minor

**[S12] Minor — `check-blame-ignore-revs.mjs` rename detection under-specified** — specify as `git show --name-status -M100% <sha>` requiring only `R100` entries.
**[S13] Minor — Allowlist enumeration for PR 5 still elides with `[+ others]`** — commit the full 25-file list to phase-config.

## Recurring Issue Check (Security)
- R29: N/A. R30: OK. RS1/RS2/RS3: N/A.

---

## Testing Findings (Round 2)

### Verification of Round 1 fixes

| T# | Status | Notes |
|----|--------|-------|
| T1 | Fixed | `--check-test-pairs` specified |
| T2 | Fixed | prefix coverage extended |
| T3 | Partial | See [T10] (regex breaks after PR 5 moves) |
| T4 | Fixed | baseline advancement actionable |
| T5 | Partial | See [T11] (`node -e 'require("@/..."')` non-executable) |
| T7 | Fixed | vitest.config regex correct |
| T8 | Partial | See [T12] (CI not enforced) |

### New findings

**[T10] Major — `pre-pr.sh` integration-test regex breaks after PR 5 moves `prisma.ts`/`tenant-*.ts`/`redis.ts`**
- File: plan §PR 1 item 7
- Evidence: regex `^src/lib/(prisma|redis|tenant-(context|rls)|auth/.+-token)\.ts` anchored on old paths; PR 5 moves those files into sub-dirs.
- Fix: In PR 5, update regex to `^src/lib/(prisma|redis|tenant|auth)/` or use glob-style directory match.

**[T11] Major — Barrel smoke check command is non-executable**
- File: plan §Mechanical edit protocol step 14
- Evidence: `node -e 'require("@/lib/constants")'` — Node doesn't resolve `@/` alias; `.ts` files need loader.
- Fix: Replace with `npx tsx --tsconfig tsconfig.json -e 'import * as C from "@/lib/constants"; for (const k of Object.keys(C)) console.log(k);'` OR commit `scripts/checks/smoke-constants-barrel.mts`.

**[T12] Major — Auth integration-test gate not machine-enforced in CI (completion criterion §8)**
- Merged with [S11] — same fix applies.

**[T13] Major — `pre-pr.sh` integration-test conditional has no DB-reachability precondition**
- File: plan §PR 1 item 7
- Evidence: `npm run test:integration` requires live Postgres; no fallback if DB unreachable.
- Fix: Wrap conditional with DB-reachability check that skips with clear message if unreachable. Document prerequisite in `CONTRIBUTING.md`.

### Minor

**[T14] Minor — `--check-test-pairs` reverse-case semantics ambiguous** — should fail if `moves[]` has test without impl (or vice versa).
**[T15] Minor — Unverified numeric claims ("287 barrel imports") in testing strategy** — replace with reproducible grep commands.

## Recurring Issue Check (Testing)
- RT1: OK (codemod rewrites mocks). RT2: T12/T13 (gate absence + DX). RT3: T15 (unverified numbers).

---

## Overall Round 2 Verdict

**Plan as currently written is NOT mergeable** — [S1 (continuing)] is a hard implementation defect (PR 1 self-blocks via `check-codeowners-drift.mjs`). Pre-condition before proceeding:

1. **Mandatory (blocks commit)**: Apply the S1 fix (one of a/b/c options above) to resolve the PR 1 sequencing defect.
2. **Strongly recommended (Round 3 or immediate fix)**: F17, F19, F20, F21, F22, F23, S9, S10, S11, T10, T11, T13.
3. **Deferrable to execution-time (phase-config level)**: S12, S13, T14, T15, F25, F26.

---

## Round 2 Resolution Status (applied in Round 3 plan revision)

Additionally referenced PR #392's completed plan (`docs/archive/review/split-overcrowded-feature-dirs-plan.md`) for precedent.

| Finding | Severity | Round 3 Resolution | Reflected in plan |
|---------|----------|-------------------|-------------------|
| S1 (continuing) | Critical | **Fixed** via option (a): PR 1 additive-only CODEOWNERS (transitional glob `/scripts/check-*.mjs` + new `/scripts/checks/**`); PR 2 atomically DELETEs obsolete literals with the `git mv`. No regression window, no self-blocking. | §PR 1 item 9; §PR 2 deliverables |
| F17 | Major | **Fixed** — `check-doc-paths.mjs` two-pass design: Pass B (`SCRIPT_REF_RE`) uses dedicated scan function `scanForScriptRefs()` that bypasses `SKIP_GLOBS`. | §PR 1 item 2 |
| F18 | Major | **Merged with S1** — same fix. | §PR 1 item 9; §PR 2 |
| F19 | Major | **Fixed** — `scripts/__tests__/*.test.mjs` added to PR 2 consumer enumeration; codemod rewrites their `resolve(__dirname, "..", "<script>.mjs")` paths. | §PR 2 deliverables "Consumer enumeration" |
| F20 | Major | **Fixed** — parallel-branch guard uses `gh pr list --state open --json headRefName --jq '.[].headRefName' | grep -c '^refactor/'` with current-branch exclusion. Avoids the false-positive from merged-local + remote-tracking branches. | §PR 1 item 6 |
| F21 | Major | **Fixed** — PR 5 mapping corrected: `credit-card.ts` in `ui/` only; phantom `validations.ts` row removed; `validations.test.ts` at `src/lib/` root declared as legacy orphan (stays). Sum verified = 44. | §PR 5 deliverables; §Requirements "Test-only orphans" |
| F22 | Major | **Fixed** — single-file buckets eliminated per PR #392 precedent. Only 3 NEW sub-dirs: `http/` (7), `url/` (3), `ui/` (6). `redis.ts`/`tailscale-client.ts` → existing `services/`; `openapi-spec.ts`, `inject-extension-bridge-code.ts`, `events.ts` stay at root as single-instance utilities. | §PR 5 deliverables |
| F23 | Major | **Fixed** — PR 5 adds `/src/lib/tenant/** @ngc-shj` + `/src/lib/tenant-context.ts @ngc-shj`; `tenant-rls.ts` pinned at root (existing rule valid). Roster in `check-codeowners-drift.mjs` updated. | §PR 5 "CODEOWNERS update" |
| S9 | Major | **Fixed** — `/scripts/pre-pr.sh @ngc-shj` added in PR 1 item 9. | §PR 1 item 9 |
| S10 | Major | **Fixed** — `check-codeowners-drift.mjs` roster expanded to include `.github/workflows/**`, `.github/CODEOWNERS`, `.git-blame-ignore-revs`, `.trivyignore`, `scripts/check-*.mjs` (pre-PR-2) and `scripts/checks/**` (post-PR-2). | §PR 1 item 3 |
| S11 / T12 | Major | **Fixed** — new `.github/workflows/ci-integration.yml` with `paths:` filter for `src/lib/auth/**`, `src/lib/prisma**`, `src/lib/tenant*`, `src/lib/tenant/**`, `src/lib/redis*`. Machine-enforced; block merge via `required_status_checks`. | §PR 1 item 10; §Testing strategy §2 |
| T10 | Major | **Fixed** — `pre-pr.sh` regex in PR 1 covers BOTH pre- and post-PR-5 paths: `^src/lib/(prisma|redis|tenant-(context|rls)|auth/.+-token)\.ts$|^src/lib/(prisma|redis|tenant|auth)/`. | §PR 1 item 7 |
| T11 | Major | **Fixed** — barrel smoke uses `npx tsx --tsconfig tsconfig.json -e 'import * as C from "@/lib/constants"; ...'`, pre-move vs post-move snapshot diff. `tsx` honors tsconfig.json paths natively. | §Mechanical edit protocol step 14 |
| T13 | Major | **Fixed** — `pre-pr.sh` conditional wrapped with `pg` reachability precondition; skips with clear message if DB unreachable. `CONTRIBUTING.md` documents the expectation. | §PR 1 item 7 |
| S12 | Minor | **Fixed** — `check-blame-ignore-revs.mjs` specified as `git show --name-status -M100% <sha>` requiring only `R100` entries. Any `M`, `A`, `D`, or `R<100>` fails. | §PR 1 item 4 |
| S13 | Minor | **Fixed** — full `check-bypass-rls.mjs` ALLOWED_USAGE disposition committed in plan; notably, PR 5 causes ZERO rename entries (pinning decisions cover all listed paths). PR body pastes `verify-allowlist-rename-only` output as proof. | §PR 5 "`check-bypass-rls.mjs` ALLOWED_USAGE rename list" |
| T14 | Minor | **Fixed** — `--check-test-pairs` made symmetric: fails if impl-without-sibling-test-in-moves OR test-without-sibling-impl-in-moves. | §PR 1 item 5 |
| T15 | Minor | **Fixed** — unverified "287 barrel imports + 16 deep mocks" numbers replaced with reproducible `grep -rn` commands run at PR 4 time and pasted in PR body. | §Testing strategy §11 |
| F25 | Minor | **Fixed** — PR 9 wrap-up removes dead `/src/lib/crypto*` and `/src/lib/auth*` flat-file patterns. | §PR 9 deliverables item 2 |
| F26 | Minor | **Fixed** — `/src/lib/constants/auth/** @ngc-shj` added preemptively in PR 1 as benign empty glob (per GitHub CODEOWNERS semantics; becomes active when PR 4 lands). | §PR 1 item 9 |

**All Round 2 findings resolved**. No remaining Anti-Deferral sign-off required.

### Additional improvements adopted from PR #392 precedent

- **Target relaxation**: `src/lib/` direct-file target set to ≤ 25 (matches PR #392's ≤45 relaxation rationale), acknowledging 9 pinned files + 12 single-instance utilities.
- **9-file pinning list**: adopted verbatim from PR #392 (`tenant-rls.ts`, `tenant-context.ts`, `prisma.ts`, `env.ts`, `load-env.ts`, `password-generator.ts`, `notification.ts`, `webhook-dispatcher.ts`, `url-helpers.ts`).
- **Phase-config JSON format**: matches PR #392's `{ phaseName, moves[] }` structure with explicit impl+test pairs (example: `docs/archive/review/phases/phase-1a-tokens.json`).
- **`scripts/verify-allowlist-rename-only.mjs`**: existing from PR #392, wired into step 6 of mechanical edit protocol.

---

# Plan Review: refactor-second-level-split (Round 3)
Date: 2026-04-23
Review round: 3

## Changes from Previous Round
Round 3 plan rewrite applied all Round 2 Critical/Major/Minor fixes + adopted precedent from PR #392 (pinning list, ≤25 target, phase-config format). Three expert sub-agents re-reviewed. Round 3 identified **1 Critical** (S16 — mechanical impossibility in `check-blame-ignore-revs.mjs` spec verified against real PR #392 move commits), **6 new Major**, **7 new Minor**. Central theme: plan-level specifications survive syntax review but fail empirical verification against actual tooling behavior (codemod capabilities, `tsx` flag semantics, real commit shapes).

## Summary

| Severity | Count | Notes |
|---|---|---|
| Critical | 1 | S16 — `check-blame-ignore-revs.mjs` R100-only spec mechanically impossible |
| Major | 6 | F27/S17 (codemod limit), F28 (PR 2 DELETE line range), F29/T16 (redis path drift), S14 (trivyignore self-block), S15 (required_status_checks codification), T17 (tsx --tsconfig silent) |
| Minor | 7 | S18, T18, T19, T20, T21, T22, F30 |

---

## Functionality Findings (Round 3)

### Verification of Round 2 fixes

| R2# | Status | Notes |
|---|---|---|
| S1/F18 | **Fixed** | Double-coverage at PR 1 merge (old literals + new glob). Drift check passes. |
| F17 | **Fixed** | Two-pass `scanForScriptRefs()` design compatible with existing `check-doc-paths.mjs` structure. |
| F19 | **PARTIAL — F27** | Codemod does NOT rewrite `resolve(__dirname, "..", "check-licenses.mjs")` — verified against `scripts/move-and-rewrite-imports.mjs:662-738` (`resolve` not in `DYNAMIC_CALLEES`; arg doesn't start with `.`). |
| F20 | **Fixed** | `gh pr list` snippet verified shell-valid; single-branch-per-line JSON output confirmed. |
| F21 | **Fixed** | 44-file sum verified by direct count. |
| F22 | **Fixed** | Single-file buckets consolidated. |
| F23 | **Partial — F28** | `/src/lib/tenant/**` addition correct; but PR 2 DELETE directive says "lines 4-14" which would incorrectly include 4 admin-tool rules. |
| S9 | **Fixed** | `/scripts/pre-pr.sh @ngc-shj` added. |
| S10 | **REGRESSION — S14** | `.trivyignore` in roster but no matching CODEOWNERS rule → PR 1 self-blocks. |
| S11/T12 | **Fixed with caveat — S15** | Workflow correct; `required_status_checks` only documented, not codified. |
| T10 | **Partial — F29/T16** | Regex covers `src/lib/(prisma\|redis\|tenant\|auth)/` but `redis.ts` moves to `src/lib/services/redis.ts`, which neither branch matches. |
| T11 | **REGRESSION — T17** | `npx tsx --tsconfig tsconfig.json -e '...'` silently emits NO output; barrel smoke becomes trivially-passes. |
| T13 | **Partial — T18** | Precondition correct but no timeout guard (hung DB blocks indefinitely). |
| T14 | **Partial — T20** | Extension-mismatch case (`foo.ts` ↔ `foo.test.tsx`) unspecified. |
| T15 | **Fixed** | Reproducible grep commands; actual values differ from plan's historical (421 vs 287 / 13 vs 16) but no longer load-bearing. |
| S12/S13/F25/F26 | **Fixed** | — |

### New findings

**[F27 / S17] Major — Codemod does NOT rewrite `resolve(__dirname, "..", "check-licenses.mjs")`; F19 "fixed" status overstated**
- File: `scripts/move-and-rewrite-imports.mjs:662-738` (rewriteExternalRelativeImports); `scripts/__tests__/check-licenses.test.mjs:7`; plan §PR 2 Test siblings + Scenario G
- Evidence: codemod rewrites string-literal args only when (a) specifier starts with `.` AND (b) callee is `import`/`require`/`vi.mock`/`vi.doMock`/`vi.importActual`/`vi.importOriginal`. `resolve()` not in the allowlist; `"check-licenses.mjs"` has no `.` prefix. `check-crypto-domains.test.mjs` uses `import ... from "../check-crypto-domains.mjs"` (ImportDeclaration, handled correctly) — different pattern.
- Fix: Either (a) list `scripts/__tests__/check-licenses.test.mjs:7` explicitly as a MANUAL-edit consumer in PR 2 (simpler), OR (b) refactor test to use static import matching `check-crypto-domains.test.mjs`, OR (c) enhance codemod with dedicated `resolve(__dirname, "..", <literal>)` pattern detection. Remove "codemod rewrites ... via ts-morph string-literal detection" claim from Scenario G.

**[F28] Major — PR 2 CODEOWNERS DELETE directive ambiguity**
- File: plan §PR 2 "CODEOWNERS" — "DELETE lines 4–14"
- Evidence: current `.github/CODEOWNERS:4-14` mixes 7 check-* literal rules (to delete) and 4 admin-tool literal rules (must stay): L4 move-and-rewrite-imports, L8 verify-allowlist-rename-only, L9 verify-move-only-diff, L14 refactor-phase-verify.
- Problem: literal "DELETE lines 4-14" removes admin-tool rules → drift check self-fails OR admin tools become unowned.
- Fix: rewrite as: "DELETE lines 5, 6, 7, 10, 11, 12, 13 (the 7 `check-*.mjs` literal rules). Retain lines 4, 8, 9, 14 (admin tools). Also DELETE the transitional `/scripts/check-*.mjs` glob from PR 1."

**[F29 / T16] Major — Integration-test gate stops covering `redis.ts` after PR 5 moves it to `src/lib/services/redis.ts`**
- File: plan §PR 1 item 7 (pre-pr.sh regex); §PR 1 item 10 (`ci-integration.yml` paths filter); §PR 5 deliverables (services/ row)
- Evidence:
  - pre-pr.sh regex: `^src/lib/(prisma|redis|tenant|auth)/` — doesn't match `src/lib/services/redis.ts`.
  - ci-integration.yml `paths:` lists `src/lib/redis.ts` + `src/lib/redis/**` — neither matches.
- Problem: Post-PR-5 edits to `services/redis.ts` silently bypass the gate, locally AND in CI. Redis is session store + rate-limit backend.
- Fix: Recommended — pin `redis.ts` at `src/lib/` root (matches PR #392 precedent which lists `redis.ts` as single-instance utility, line 27). Add to 9-file pin list, making it 10 pinned + 11 single-instance = 21 post-PR-5 root. Alternative: update BOTH regex and workflow `paths:` in PR 5 to include `src/lib/services/redis.ts`.

### Minor

**[F30] Minor** — `tailscale-client.ts` → `services/` move not in CI; no immediate risk, flag for future hardcoded-exclusion additions.

## Recurring Issue Check (Functionality)
R2: F27 (resolve() path), F29 (redis hardcoded). R3: F28 (line range ambiguity), F19 incomplete. R18: F28.

---

## Security Findings (Round 3)

### Verification of Round 2 fixes

| R2# | Status | Notes |
|---|---|---|
| S1 (continuing) | **Fixed** | Double coverage; glob semantics verified. |
| S9 | **Fixed** | pre-pr.sh covered. |
| S10 | **REGRESSION — S14** | `.trivyignore` roster/rule mismatch. |
| S11/T12 | **Fixed w/ caveat — S15** | codification gap. |
| S12 | **REGRESSION — S16** | R100-only spec mechanically impossible — see below. |
| S13 | **Fixed** | ZERO renames in PR 5 confirmed. |

### New findings

**[S14] Major — `.trivyignore` added to drift-check roster without matching CODEOWNERS rule → PR 1 self-blocks**
- File: plan §PR 1 item 3 (roster) vs §PR 1 item 9 (CODEOWNERS adds) — `.trivyignore` in roster but NOT in adds. Current CODEOWNERS has no `.trivyignore` rule.
- Problem: drift check fails at PR 1 merge.
- Fix: Add `/.trivyignore @ngc-shj` to PR 1 item 9. Closes a pre-existing supply-chain coverage gap at the same time.

**[S15] Major — `required_status_checks` enforcement codified only in PR body text**
- File: plan §PR 1 item 10 line 221
- Problem: branch-protection setting could drift from plan intent; merge-blocking gate is aspirational.
- Fix: PR 1 checklist requires `gh api repos/:owner/:repo/branches/main/protection/required_status_checks` post-merge; output pasted. Optionally add `scripts/checks/verify-branch-protection.mjs` as check #17.

**[S16] Critical — `check-blame-ignore-revs.mjs` R100-only specification is mechanically impossible against real move commits (escalate=true)**
- File: plan §PR 1 item 4
- Evidence: verified against PR #392 move SHA `f4dac45748c2342f8c5c68bac0da4bd60c78f7f6` — `git show --name-status -M100% <sha>` returns:
  - 11× `R100` (actual moves)
  - 1× `A docs/archive/review/phases/phase-1a-tokens.json` (phase-config added same commit)
  - 2× `M scripts/check-bypass-rls.mjs`, `M scripts/check-vitest-coverage-include.mjs` (allowlist rewrites)
  - 30+× `M src/**/*.ts(x)` (consumer import rewrites)
- Problem: the "fail on any `M`, `A`, `D`, `R<100>`" rule blocks EVERY real move commit (past and future). PR 1 unmergeable; every phase PR unmergeable. The spec as written doesn't match how move commits look in this project.
- Impact: Either forensics guard disabled (losing incident-response authorship attribution — genuine security concern), or the entire refactor plan is stuck.
- escalate: true
- escalate_reason: Hard mechanical bug in a security guard the plan depends on; MUST be corrected before PR 1 is authored.
- Fix: Reframe — "renamed files MUST be R100 (no content-changed renames) AND M/A entries are allowed only for paths in an allowlist of refactor-tool-adjacent files: `scripts/check-*.mjs` / `scripts/checks/**`, `scripts/verify-*.mjs`, `docs/archive/review/phases/**`, `vitest.config.ts`, `.git-blame-ignore-revs`, and import-rewrite consumers under `src/**`/`scripts/**`/`.github/workflows/**`". Alternative: allowlist the specific set of paths the codemod itself edits. Reference PR #392's move commits as the empirical baseline. Assert check passes against all existing `.git-blame-ignore-revs` SHAs before merging PR 1.

**[S17] Major** — merged with [F27] — codemod limitation on `resolve()` string-literals.

### Minor

**[S18] Minor — `/src/lib/tenant-context.ts @ngc-shj` addition deferred to PR 5; could fold into PR 1 for zero cost**
- File: plan §PR 5 CODEOWNERS adds vs §PR 1 item 9
- Problem: `tenant-context.ts` is pre-existing unowned security file; between PR 1 and PR 5 merges it remains unowned. One-line fix closes gap earlier.
- Fix: Add `/src/lib/tenant-context.ts @ngc-shj` to PR 1 item 9 (same pattern as `/src/lib/constants/auth/**`). Add to drift roster in PR 1 item 3.

## Recurring Issue Check (Security)
R18: S14, S15, S18 (CODEOWNERS coverage timing/codification). R2: S16 (hardcoded spec vs reality). RS1-RS3: N/A.

---

## Testing Findings (Round 3)

### Verification of Round 2 fixes

| R2# | Status | Notes |
|---|---|---|
| T10 | **Partial — T16** | Same redis path issue. |
| T11 | **REGRESSION — T17** | `--tsconfig` flag silences output. |
| T12 | **Fixed** — see S15 for codification gap |
| T13 | **Partial — T18** | No timeout. |
| T14 | **Partial — T20** | Extension-mismatch. |
| T15 | **Fixed** | Grep reproducibility. |

### New findings

**[T17] Major — `npx tsx --tsconfig tsconfig.json -e '...'` prints NO output; barrel smoke becomes a no-op**
- File: plan §Mechanical edit protocol step 14
- Evidence: empirically verified. `npx tsx -e '<...>'` prints the keys. Adding `--tsconfig tsconfig.json` silences stdout (exit 0). Likely `tsx`'s `--tsconfig` flag changes invocation semantics in a way that swallows eval output.
- Problem: pre-move vs post-move snapshot diff compares two empty strings → trivially identical → zero verification of barrel integrity.
- Fix: Drop `--tsconfig tsconfig.json` — `tsx` auto-detects. Command becomes: `npx tsx -e 'import * as C from "@/lib/constants"; const keys = Object.keys(C).sort(); console.log(JSON.stringify({count: keys.length, keys}, null, 2));'`. Verify the command actually prints in the reviewer's environment before accepting the fix.

**[T16] Major** — see F29 (same finding from testing perspective).

### Minor

**[T18] Minor — DB reachability query has no timeout (hung DB blocks indefinitely)**
- Fix: add `connectionTimeoutMillis: 3000, statement_timeout: 3000` to Pool options or `Promise.race` with `setTimeout(3000)`.

**[T19] Minor — `ci-integration.yml` fork-PR / secrets handling unstated**
- Fix: plan states `DATABASE_URL` constructed inline from service (`postgresql://postgres:postgres@localhost:5432/postgres`), not from secrets. Fork PRs run unchanged.

**[T20] Minor — `--check-test-pairs` cross-extension semantics (`foo.ts` + `foo.test.tsx`) unspecified**
- Fix: document — "pair matching uses stem equality; any sibling `foo.*test.*` counts." OR "exact extension match only; cross-ext pairs must be listed explicitly."

**[T21] Minor — PR 2 consumer list omits `refactor-phase-verify.mjs:111` `cmd` entry for `capture-test-counts`**
- Fix: explicitly call out the entry in PR 2 consumer enumeration.

**[T22] Minor — Completion criterion §8 vs step 13 wording redundancy**
- Fix: clarify "CI is authoritative gate; pre-pr.sh is local preview; PR-body paste is optional evidence."

## Recurring Issue Check (Testing)
RT1: checked — codemod handles vi.mock per precedent. RT2: T16/T17/T18/T19 (gate accuracy). RT3: T15 resolved.

---

## Overall Round 3 Verdict

**Plan is NOT mergeable as written** — 3 blocking issues:
1. **[S16] Critical (escalate=true)** — `check-blame-ignore-revs.mjs` R100-only spec fails empirically on existing `.git-blame-ignore-revs` SHAs AND every future move commit. Re-spec required (allow M/A for refactor-tool-adjacent paths).
2. **[S14] Major** — PR 1 self-blocks via drift check on `.trivyignore`. One-line fix (add CODEOWNERS rule).
3. **[T17] Major** — barrel smoke command silently no-ops. Drop `--tsconfig` flag.

Additional Major items (non-blocking but must-fix before PR 1 execution):
- **[F27/S17]** Codemod does not rewrite `resolve()` literals; manual-edit documented for `check-licenses.test.mjs`.
- **[F28]** PR 2 CODEOWNERS DELETE directive line range ambiguity.
- **[F29/T16]** Redis path drift — recommend pinning `redis.ts` at root.
- **[S15]** Codify `required_status_checks` verification in PR 1 checklist.

Plan convergence: Round 1 → 26 findings, Round 2 → 19, Round 3 → 14 (trajectory decreasing). Remaining issues are mostly empirical-verification misses, not design defects. Convergence to "no findings" likely in 1–2 more rounds.

---

## Round 3 Resolution Status (applied in Round 4 plan revision)

| Finding | Severity | Round 4 Resolution | Reflected in plan |
|---|---|---|---|
| S16 | Critical | **Fixed** — `check-blame-ignore-revs.mjs` re-specified with two-tier rule: R100 required for rename entries; M/A allowed only for refactor-tool-adjacent allowlist (scripts/check-*, scripts/checks/**, scripts/verify-*, phase-config JSONs, vitest.config.ts, .git-blame-ignore-revs, workflows, CODEOWNERS, src/** consumers, scripts/** consumers, docs/**.md, CLAUDE.md, CHANGELOG.md). Validated against PR #392's `f4dac457` move commit shape. | §PR 1 item 4 |
| S14 | Major | **Fixed** — `/.trivyignore @ngc-shj` added to PR 1 item 9 CODEOWNERS additions. Closes pre-existing supply-chain coverage gap. | §PR 1 item 9 |
| T17 | Major | **Fixed** — barrel smoke command changed to `npx tsx -e '...'` (no `--tsconfig` flag; empirically verified to emit output). | §Mechanical edit protocol step 14 |
| F27/S17 | Major | **Fixed** — `scripts/__tests__/check-licenses.test.mjs:7` declared as MANUAL-EDIT consumer in PR 2 deliverables; codemod limitation documented in §Project context. Plan Scenario G clarifies the two patterns (static-import auto-rewrites vs resolve()-literal manual-edits). | §PR 2 "MANUAL-EDIT consumer"; §Scenario G |
| F28 | Major | **Fixed** — PR 2 CODEOWNERS DELETE directive enumerates specific lines (5, 6, 7, 10, 11, 12, 13) instead of "lines 4-14". Admin-tool rules at L4/L8/L9/L14 explicitly retained. | §PR 2 "CODEOWNERS (F28 fix)" |
| F29/T16 | Major | **Fixed** — `redis.ts` pinned at `src/lib/` root (added to 10-file pin list, up from 9). Matches PR #392 "single-instance utility" rationale. Integration-test gate path-matching preserved: both `pre-pr.sh` regex and `ci-integration.yml` `paths:` remain valid. | §Root-of-`src/lib/` pinned |
| S15 | Major | **Fixed** — PR 1 checklist requires `gh api repos/:owner/:repo/branches/main/protection/required_status_checks` output pasted in PR body, confirming `ci-integration` is in the required set. PR 2 blocks until setting is applied. | §PR 1 item 11 |
| S18 | Minor | **Fixed** — `/src/lib/tenant-context.ts @ngc-shj` folded into PR 1 item 9 CODEOWNERS additions; also `/src/lib/tenant/** @ngc-shj`. | §PR 1 item 9 |
| T18 | Minor | **Fixed** — DB reachability uses `connectionTimeoutMillis: 3000, statement_timeout: 3000` + `p.end()` cleanup; 3-second bound. | §PR 1 item 7 |
| T19 | Minor | **Fixed** — `ci-integration.yml` defines `DATABASE_URL: postgresql://postgres:postgres@localhost:5432/passwd_test` inline (no secrets); fork PRs run unchanged. Plan explicitly documents. | §PR 1 item 10 |
| T20 | Minor | **Fixed** — `--check-test-pairs` semantic documented: exact-extension match required; cross-extension pairs (`foo.ts` + `foo.test.tsx`) must be listed explicitly in `moves[]`. Flag help text updated. | §PR 1 item 5 |
| T21 | Minor | **Fixed** — PR 2 consumer enumeration explicitly lists `refactor-phase-verify.mjs:111` `capture-test-counts` cmd entry plus all other cmd entries individually. | §PR 2 "Consumer enumeration" |
| T22 | Minor | **Fixed** — Step 13 reworded: "authoritative gate is `ci-integration.yml` (CI). Local `pre-pr.sh` runs them when DB reachable as preview only. Paste in PR body is OPTIONAL evidence." Completion criterion §8 similarly reworded. | §Mechanical edit protocol step 13; §Completion criteria §8 |
| F30 | Minor | **Acknowledged** (no action needed — `tailscale-client.ts` move to `services/` does not trigger any CI exclusion rule; flagged for future-reviewer awareness). | (no plan change) |

**All Round 3 findings resolved.**

---

# Plan Review: refactor-second-level-split (Round 4)
Date: 2026-04-23
Review round: 4

## Changes from Previous Round
Round 4 plan revision applied all Round 3 Critical/Major/Minor fixes. Three experts re-reviewed with deeper empirical verification (running `git show --name-status` against existing `.git-blame-ignore-revs` SHAs, checking workflow precedent, and grepping for test orphans). Round 4 surfaces **2 new Critical** (F31, T23), **4 new Major**, **9 new Minor**. Convergence is NOT monotonic — deeper verification finds specific-to-this-repo issues that Round 3 couldn't catch.

## Summary

| Severity | Count | Notes |
|---|---|---|
| Critical | 2 | F31 (re-opens S16 against existing SHA), T23 (CI uses wrong Prisma migrate command) |
| Major | 4 | F32 (test-only orphans undercounted), S20 (allowlist root-configs gap), T24 (new scripts ship testless), T25 (--check-test-pairs ships testless), T26 (barrel baseline stale risk) |
| Minor | 9 | F33, S19, S21, S22, S23, T27, T28, T29, T30, T31 |

**Round 1→4 trajectory**: 26 → 19 → 14 → 15. Convergence plateauing; diminishing returns approaching. Remaining issues are empirical gotchas + testing omissions.

---

## Functionality Findings (Round 4)

### Verification of Round 3 fixes

All Round 3 findings marked Fixed verify OK except:
- **S16** → re-opens as **F31** (Critical) — allowlist fails against existing SHA `243cfc0e` (Phase 2 crypto split).

### New findings

**[F31] Critical — `check-blame-ignore-revs.mjs` allowlist FAILS against existing SHA `243cfc0e` in current `.git-blame-ignore-revs`**
- File: plan §PR 1 item 4 `ALLOWED_MA_PATHS`; `.git-blame-ignore-revs:11`
- Evidence: `git show --name-status -M100% 243cfc0ecc7dcb13237850c54d823b7974f64e2d` returns:
  - `M e2e/helpers/crypto.test.ts`
  - `M e2e/helpers/crypto.ts`
  - `M scripts/manual-tests/share-access-audit.ts`
- None match any regex in `ALLOWED_MA_PATHS`:
  - `/^src\/[^/]+.*\.(ts|tsx|mjs|js)$/` — excludes `e2e/`
  - `/^scripts\/[^/]+\.(sh|mjs|ts)$/` — excludes `scripts/manual-tests/` (subdir)
- Plan's S16 fix was validated against ONE SHA (`f4dac457`), not all 24. PR 1 author running `check-blame-ignore-revs.mjs` would fail immediately on SHA #11.
- Impact: PR 1 unmergeable — same failure mode as Round 3 S16.
- Fix: Extend `ALLOWED_MA_PATHS`:
  - `/^e2e\/.+\.(ts|tsx)$/`
  - `/^scripts\/manual-tests\/.+\.ts$/`
- **Validation obligation (newly added)**: PR 1 author runs the proposed `check-blame-ignore-revs.mjs` against ALL 24 existing SHAs BEFORE PR 1 opens; plan must document this pre-flight as a mandatory step.

**[F32] Major — Plan undercounts `src/lib/` test-only orphans by 2 files**
- File: plan §PR 5 "Stays at root — Legacy orphan (1)"
- Evidence: `src/lib/` contains THREE test-only orphans, not one:
  1. `validations.test.ts` (acknowledged)
  2. `callback-url-basepath.test.ts` — tests `./auth/callback-url` via mocked `./url-helpers`
  3. `vault-unlock-error.test.ts` — tests `./vault/vault-context` (VaultUnlockError)
- Note: `url-helpers.server.test.ts` is legitimate second test-file for the pinned `url-helpers.ts`, not an orphan.
- Impact: Reviewer-clarity gap. The Round 3 F21 "44-file sum verified" accounting is correct (orphans aren't counted in the 44) but the plan's "Legacy orphan (1)" undercount misleads.
- Fix: Expand to "Legacy test-only orphans (3): `validations.test.ts`, `callback-url-basepath.test.ts`, `vault-unlock-error.test.ts`. All stay at `src/lib/` root."

**[F33] Minor** — `scripts/manual-tests/` directory unclassified in `§Root-of-scripts/ fixed`. Add "Manual smoke tests" category declaring stay-at-current-path. Optionally add `/scripts/manual-tests/** @ngc-shj` CODEOWNERS rule.

---

## Security Findings (Round 4)

### Verification of Round 3 fixes

All Round 3 S-series verified Fixed (S16 fix correct against `f4dac457` subset; F31 catches the broader gap).

### New findings

**[S19] Minor — CODEOWNERS drift check post-PR-2 roster semantics ambiguous**
- File: plan §PR 1 item 3 (roster lists BOTH `scripts/check-*.mjs` pre-PR-2 and `scripts/checks/**` post-PR-2)
- Problem: post-PR-2, the pre-PR-2 glob matches zero files. Is that PASS or FAIL?
- Fix: Add one-line semantic clarification: "Roster globs enumerate files-that-must-have-owners. Zero-file matches trivial PASS."

**[S20] Major — `check-blame-ignore-revs.mjs` allowlist misses root-level config files touched by PR 2's `package.json` rewrites**
- File: plan §PR 1 item 4 `ALLOWED_MA_PATHS`
- Evidence: PR 2 rewrites `package.json` `scripts` map. When the PR 2 move SHA is appended to `.git-blame-ignore-revs`, check #15 encounters `M package.json` — not in allowlist.
- Also missing: `proxy.ts`, `next.config.ts`, `sentry.*.config.ts`, `instrumentation-client.ts`, `prisma.config.ts`, `postcss.config.mjs`, `eslint.config.mjs`, `package-lock.json`, `tsconfig.json` — all declared rewrite targets per PR #392 codemod scope.
- Fix: Extend `ALLOWED_MA_PATHS` with all listed root-config file patterns.

**[S21] Minor — GitHub Actions `@v4` mutable tag pinning (not SHA)**
- Context: matches existing `ci.yml` precedent, so no immediate regression.
- Fix: out-of-scope for this plan; file follow-up for repo-wide SHA pinning.

**[S22] Minor — `postgres:postgres` weak default credential in `ci-integration.yml`**
- Acceptable (ephemeral service container, not reused). Add inline comment documenting scope.

**[S23] Minor — `ci-integration.yml` omits `permissions:` block**
- Fix: add `permissions: contents: read` per principle of least privilege.

### Continuing
None.

---

## Testing Findings (Round 4)

### Verification of Round 3 fixes

T16, T17, T18, T19, T20, T21, T22 all verified Fixed at plan level. Some depend on orthogonal new findings (T23, T26).

### New findings

**[T23] Critical — `ci-integration.yml` uses `npm run db:migrate` (= `prisma migrate dev`) which is NOT safe for CI**
- File: plan §PR 1 item 10 line 249
- Evidence: `package.json:15`: `"db:migrate": "prisma migrate dev"`. Existing CI precedent at `.github/workflows/ci.yml:270,337,423` uses `npx prisma migrate deploy`.
- Problem: `prisma migrate dev` is interactive-intent (shadow DB, drift-reset prompts, auto-generates migration files). Prisma docs explicitly: "Don't use migrate dev in production or CI."
- Impact: Authoritative auth/DB integration gate runs unpredictably; fork PRs may hang on prompts.
- Fix: Change step to `- run: npx prisma migrate deploy`.

**[T24] Major — No unit tests for the two new ~120-LOC security-critical scripts added in PR 1**
- File: plan §PR 1 items 3 & 4 (`check-codeowners-drift.mjs`, `check-blame-ignore-revs.mjs`)
- Evidence: existing precedent has tests for similar auditors (`scripts/__tests__/check-crypto-domains.test.mjs`, `check-licenses.test.mjs`). No test files planned.
- Impact: security-critical checks without regression tests; combinatorial regex risk in ALLOWED_MA_PATHS.
- Fix: Add to PR 1:
  - `scripts/__tests__/check-codeowners-drift.test.mjs` (fixture-based)
  - `scripts/__tests__/check-blame-ignore-revs.test.mjs` (PR #392 `f4dac457`, `243cfc0e` SHAs as golden fixtures + synthetic failure cases)

**[T25] Major — `--check-test-pairs` flag ships without unit test**
- File: plan §PR 1 item 5; `scripts/__tests__/move-and-rewrite-imports.test.mjs`
- Evidence: no grep hit for `check-test-pairs` anywhere.
- Fix: add to `scripts/__tests__/move-and-rewrite-imports.test.mjs`: (1) pair symmetry forward/reverse, (2) orphan detection, (3) cross-ext intentional, (4) cross-ext accidental documented pass, (5) no-pair legitimate pass.

**[T26] Major — Barrel integrity step 14 vulnerable to legitimate main-branch additions**
- File: plan §Mechanical edit protocol step 14
- Evidence: no "rebase first" instruction before capturing baseline on main.
- Problem: if another PR lands on main adding `export const NEW_CONSTANT` during PR 4 review, post-move barrel includes it, baseline doesn't → false-positive mismatch.
- Fix: Rebase PR branch onto main BEFORE capturing both snapshots; codify in step 14.

**[T27] Minor — Integration tests run twice for developers with local DB**
- Fix: add `PREPR_SKIP_INTEGRATION=1` env var opt-out in `pre-pr.sh`; document in `CONTRIBUTING.md`.

**[T28] Minor — `2>/dev/null` on DB reachability masks misconfig errors**
- Fix: drop `2>/dev/null` OR distinguish `ECONNREFUSED` (skip) from other errors (surface).

**[T29] Minor — PR 1's own test-count baseline doesn't catch PR 1's testless new scripts**
- Fix: combined with T24/T25. After PR 1 merge, `.refactor-test-count-baseline` must increase by the test count from the new fixture tests.

**[T30] Minor — Plan `pre-pr.sh` "lines 32-48 (6 calls)" miscount**
- File: plan §PR 2 "Consumer enumeration"
- Evidence: actual: L32, L34-37 (5 moving) + L48 `refactor-phase-verify.mjs` (stays at root).
- Fix: reword as "lines 32-37 (5 moving calls) rewrite to `scripts/checks/<name>`; line 48 remains at `scripts/` root".

**[T31] Minor — `ci-integration.yml` missing `prisma generate` step**
- File: plan §PR 1 item 10
- Fix: verify `package.json` has `postinstall: prisma generate`; if not, add `- run: npx prisma generate` between `npm ci` and `migrate deploy`.

---

## Overall Round 4 Verdict

**Plan is NOT mergeable** — 2 Critical blockers:
1. **[F31] Critical** — `check-blame-ignore-revs.mjs` ALLOWED_MA_PATHS fails on existing SHA `243cfc0e`. Fix: extend allowlist + run pre-flight against all 24 existing SHAs.
2. **[T23] Critical** — `ci-integration.yml` uses `npm run db:migrate` (dev command); must be `prisma migrate deploy`.

**4 Major** must-fix:
- F32: acknowledge 3 test-only orphans
- S20: extend allowlist for root configs touched by PR 2 `package.json` rewrite
- T24+T25: add unit tests for new security-critical scripts and `--check-test-pairs` flag
- T26: rebase-first instruction for barrel baseline

**9 Minor** clean-ups.

### Convergence trajectory

| Round | Total | Critical | Major | Minor |
|---|---|---|---|---|
| 1 | 26 | 2 | 15 | 9 |
| 2 | 19 | 1 | 12 | 6 |
| 3 | 14 | 1 | 6 | 7 |
| 4 | 15 | 2 | 4 | 9 |

Non-monotonic. Round 4 critical findings came from running actual git commands against existing commits (empirical), not from spec review. The plan has converged at the design level; remaining gaps are empirical edges that deeper verification keeps surfacing.

---

## Round 4 Resolution Status — Critical-only fix (user decision: option 2)

User directive: apply the 2 Critical blockers only; record remaining Major/Minor as execution-time TODOs. Plan revision applied; no Round 5 expert re-review launched.

### Critical (applied to plan)

| Finding | Severity | Fix | Reflected in plan |
|---|---|---|---|
| F31 | Critical | `ALLOWED_MA_PATHS` extended with `/^e2e\/.+\.(ts|tsx)$/` and `/^scripts\/manual-tests\/.+\.ts$/`. Pre-flight obligation added: PR 1 author MUST run check against ALL existing 24 SHAs in `.git-blame-ignore-revs` before opening PR 1. Validated empirically against `f4dac457` + `243cfc0e`. | §PR 1 item 4 lines 160, 169 + pre-flight paragraph |
| T23 | Critical | `ci-integration.yml` step changed from `npm run db:migrate` → `npx prisma migrate deploy`. Matches existing ci.yml:270,337,423 precedent. Inline comment documents rationale. | §PR 1 item 10 workflow step |

### Deferred Major findings (Anti-Deferral compliant TODO markers)

Each entry below follows the mandatory format from `common-rules.md` §"Anti-Deferral Rules".

---

#### [F32] Major: `src/lib/` has 3 test-only orphans, plan enumerates only 1 — Deferred
- **Anti-Deferral check**: acceptable risk (under 30-min execution-time fix)
- **Justification**:
  - Worst case: reviewer confusion over why PR 5's file-count math works; zero runtime impact.
  - Likelihood: low — the plan's 44-file sum is correct; additional orphans are test-only and don't participate in moves.
  - Cost to fix: ~2 lines in plan §PR 5 "Stays at root" section (~1 min). Note that this violates the 30-min rule strictly; should be folded in at plan-execution time for plan hygiene. User opted to defer per "Critical-only" stop directive.
- **Orchestrator sign-off**: user explicitly chose option 2 (Critical-only); plan-edit deferral accepted with explicit TODO.
- **TODO marker**: `TODO(refactor-second-level-split): enumerate 3 test-only orphans in PR 5 deliverables (validations.test.ts, callback-url-basepath.test.ts, vault-unlock-error.test.ts)`

#### [S20] Major: `check-blame-ignore-revs.mjs` allowlist omits root-level config files — Deferred
- **Anti-Deferral check**: NOT PURE "acceptable risk" — this blocks PR 2
- **Justification**:
  - Worst case: **PR 2 fails check #15 on its own move SHA** because PR 2 rewrites `package.json` `scripts` map, and `package.json` is not in `ALLOWED_MA_PATHS`. PR 2 is unmergeable until fix applied.
  - Likelihood: high (certain if PR 2 rewrites `package.json`, which the plan requires).
  - Cost to fix: ~8 regex entries in PR 1 item 4 allowlist (~5 min).
- **Orchestrator sign-off**: User chose option 2; this finding is Critical-adjacent and will surface at PR 2 execution time. **Recommendation to user**: fix before opening PR 2 (before code is written) — this is functionally Critical for PR 2.
- **TODO marker**: `TODO(refactor-second-level-split): extend ALLOWED_MA_PATHS with /^proxy\.ts$/, /^next\.config\.ts$/, /^sentry\..+\.config\.ts$/, /^instrumentation-client\.ts$/, /^prisma\.config\.ts$/, /^postcss\.config\.mjs$/, /^eslint\.config\.mjs$/, /^package(-lock)?\.json$/, /^tsconfig\.json$/ BEFORE PR 2 opens`

#### [T24] Major: `check-codeowners-drift.mjs` and `check-blame-ignore-revs.mjs` ship without unit tests — Deferred
- **Anti-Deferral check**: acceptable risk (tests can land in PR 1 alongside the script code)
- **Justification**:
  - Worst case: regex bug in either script goes undetected; security-critical check silently passes (false-negative) or blocks all refactor PRs (false-positive).
  - Likelihood: medium — two ~120-LOC scripts with complex regex surface.
  - Cost to fix: ~2 test files (~2 hours work). Over 30-min rule threshold; but scope is implementation, not plan-edit.
- **Orchestrator sign-off**: execution-time task; PR 1 implementation includes test files. Not a plan-text issue.
- **TODO marker**: `TODO(refactor-second-level-split): PR 1 implementation MUST include scripts/__tests__/check-codeowners-drift.test.mjs and scripts/__tests__/check-blame-ignore-revs.test.mjs. Golden fixtures: PR #392 SHAs f4dac457 (pass) and 243cfc0e (pass with F31 allowlist); synthetic SHAs for R<100 fail and unapproved M/A paths.`

#### [T25] Major: `--check-test-pairs` flag ships without unit test — Deferred
- **Anti-Deferral check**: acceptable risk (test lands with the code)
- **Justification**:
  - Worst case: flag false-positive blocks phase PRs; false-negative lets orphan tests through.
  - Likelihood: low-medium.
  - Cost to fix: ~5 test cases in existing `scripts/__tests__/move-and-rewrite-imports.test.mjs` (~1 hour).
- **Orchestrator sign-off**: execution-time.
- **TODO marker**: `TODO(refactor-second-level-split): PR 1 implementation MUST extend scripts/__tests__/move-and-rewrite-imports.test.mjs with --check-test-pairs test cases (forward-symmetry, reverse-symmetry, cross-ext intentional/accidental, no-pair legitimate)`

#### [T26] Major: Barrel integrity step 14 vulnerable to legitimate main-branch additions — Deferred
- **Anti-Deferral check**: acceptable risk (under 30-min plan edit)
- **Justification**:
  - Worst case: false-positive mismatch in PR 4 when another PR lands on main between baseline and post snapshots.
  - Likelihood: low (narrow timing window during PR 4 review).
  - Cost to fix: ~3 lines in plan §Mechanical edit protocol step 14 (add "rebase PR onto main first" instruction; ~2 min).
- **Orchestrator sign-off**: user option 2; defer with TODO. Per 30-min rule this should be fixed now — noted as a user-choice exception.
- **TODO marker**: `TODO(refactor-second-level-split): PR 4 — rebase onto latest main BEFORE capturing barrel baseline, to avoid false-positive mismatch with concurrent constant additions`

### Deferred Minor findings (Anti-Deferral compliant)

| ID | Title | Quantified justification | TODO marker |
|----|-------|---------------------------|-------------|
| F33 | `scripts/manual-tests/` directory unclassified | Worst: future reviewer confusion on root-of-scripts policy. Low likelihood. 1-line plan addition. | `TODO(refactor-second-level-split): PR 1 CONTRIBUTING.md — declare scripts/manual-tests/ as a "Manual smoke tests" category under root-of-scripts fixed` |
| S19 | Drift-check roster post-PR-2 glob semantics | Worst: spurious check #14 fail. Low likelihood. 1-line doc clarification. | `TODO(refactor-second-level-split): PR 1 check-codeowners-drift.mjs header comment — "roster globs: zero-file match is trivial PASS"` |
| S21 | GitHub Actions `@v4` mutable tag | Worst: theoretical supply-chain compromise of upstream Action. Matches existing repo precedent. Out-of-scope for this plan. | `TODO(follow-up-repo-wide): pin all .github/workflows/**/*.yml actions to commit SHAs` |
| S22 | `postgres:postgres` weak default credential | Worst: copy-paste reuse. Ephemeral CI-only scope; no real exposure. 1-line comment fix. | `TODO(refactor-second-level-split): PR 1 ci-integration.yml — add comment above env block "# ephemeral service-container credential — scoped to CI runner localhost; DO NOT reuse in any real env"` |
| S23 | `ci-integration.yml` missing `permissions:` block | Worst: token with broader-than-needed scope on CI runner (defense in depth). Low likelihood. 2-line addition. | `TODO(refactor-second-level-split): PR 1 ci-integration.yml — add "permissions: contents: read" at top` |
| T27 | Integration tests run twice (local + CI) | Worst: developer DX friction (~2-16min extra locally). Opt-out is 3-line bash change. | `TODO(refactor-second-level-split): PR 1 pre-pr.sh — add PREPR_SKIP_INTEGRATION=1 opt-out; document in CONTRIBUTING.md` |
| T28 | `2>/dev/null` masks DB misconfig errors | Worst: silent misconfig during dev. 1-line fix. | `TODO(refactor-second-level-split): PR 1 pre-pr.sh — drop 2>/dev/null OR distinguish ECONNREFUSED from other errors` |
| T29 | PR 1 lacks its own test-count guard | Worst: circular dependency on guards PR 1 is building. Resolved jointly with T24/T25 (adding those tests raises baseline). | Combined with T24/T25 |
| T30 | Plan "lines 32-48 (6 calls)" miscount | Worst: reviewer confusion. 1-line reword. | `TODO(refactor-second-level-split): PR 2 Consumer enumeration — reword "lines 32-37 (5 moving calls) rewrite to scripts/checks/<name>; line 48 refactor-phase-verify.mjs remains at scripts/ root"` |
| T31 | `ci-integration.yml` missing `prisma generate` | Worst: integration tests fail at first Prisma client import. Verify-then-fix (check postinstall hook first). 1-line add if needed. | `TODO(refactor-second-level-split): PR 1 implementation — verify package.json has postinstall: prisma generate; if absent, add "- run: npx prisma generate" between npm ci and migrate deploy` |

### Summary

**Status**: plan accepted at Round 5 (Critical-only revision) with 13 deferred items tracked as `TODO(refactor-second-level-split): ...` markers (greppable).

**Blocker warnings for implementation**:
- **S20 Deferred**: functionally Critical for PR 2. PR 2 WILL fail check #15 on its own move SHA unless the root-config allowlist is extended before PR 2 opens.
- **F31 Pre-flight**: MUST run check against all 24 existing `.git-blame-ignore-revs` SHAs before PR 1 opens. If any additional SHA fails, extend allowlist and re-verify.
- **T24/T25**: PR 1 implementation MUST include the listed test files; these are not plan-text issues.

**Convergence final**:
| Round | Total | Critical | Major | Minor | Status |
|---|---|---|---|---|---|
| 1 | 26 | 2 | 15 | 9 | All fixed in Round 2 plan |
| 2 | 19 | 1 | 12 | 6 | All fixed in Round 3 plan |
| 3 | 14 | 1 | 6 | 7 | All fixed in Round 4 plan |
| 4 | 15 | 2 | 4 | 9 | 2 Critical fixed in Round 5 plan; 4 Major + 9 Minor deferred as TODO |
| 5 | — | — | — | — | User directive: stop; execution-time fix for deferred items |
