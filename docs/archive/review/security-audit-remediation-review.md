# Plan Review: security-audit-remediation

Date: 2026-06-10
Review round: 3 (cumulative log; rounds appended below)

---

## Round 6 (final verification)

All three experts: **No findings**. F16/T17 and F17 confirmed resolved (security expert re-verified the C4 factual claims against `vault-context.tsx` code: fetch-before-ceremony ordering and zeroization-N/A reasoning both accurate). Plan review CLOSED after 6 rounds; all 13 contracts flipped to `locked` in the Go/No-Go gate.

---

## Round 5 (verification)

S10, T16 confirmed resolved. Security expert: "No findings" — asset sweep re-run confirmed the constant list (3 routes) is complete; accept/recovery flows carry tokens in POST bodies (out of URL scope); E2E share `#<key>` fragment also covered by unconditional fragment strip. New findings:

- **F16/T17 [Minor]** (dedup — same issue from two experts) The `unlockWithPasskey()` wiring-test exemption rested on a FALSE technical justification ("no-webauthn-mock convention makes direct testing impossible") — the ACCOUNT_LOCKED throw fires on `!dataRes.ok` BEFORE `startPasskeyAuthentication` (:545), so a fetch-mocked wiring test never reaches WebAuthn. → C4 rewritten: all THREE call sites get wiring tests; exemption removed.
- **F17 [Minor]** Fixture (d) with a locale-less URL could go green against an accidentally anchored pattern while real URLs leak. → C11 acceptance: fixture (d) uses locale-prefixed real URL form.

## Round 4 (verification)

F14, F15, S8, S9, T14, T15 confirmed resolved (Functionality: "No findings"). New findings:

- **S10 [Major]** C11's path redact covered only `/s/` while the invariant says "path-carried capability tokens" — same-class misses verified in repo: `/dashboard/teams/invite/<token>` (raw 256-bit token in path), `/dashboard/emergency-access/invite/<token>` (DB stores hash only — path IS the capability), and fragment-carried `#token=` (admin-vault-reset; browser `request.url` may include fragments, query-only strip misses them). → C11 sanitizer generalized: query+fragment strip + CONSTANT LIST of token-route patterns (single exported constant); fixtures add invite-path + fragment cases (pre-change FAIL required).
- **T16 [Minor]** `unlock()` (most-used flow) wiring was left to the helper test alone; the no-webauthn-mock exemption only applies to `unlockWithPasskey()`. → C4 adds an `unlock()` ACCOUNT_LOCKED wiring test (fetchApi-mocked, `notifyUnlockFailure`-test shape); zeroization correctly N/A for passkey path (PRF ceremony runs after data fetch — verified).

Verified-clean: chmod-then-append ordering (no 644-with-secret window, restart-safe), `/s/` redact pattern behavior on non-token URLs, shared-helper feasibility across the three call-site shapes, breadcrumb from/to not handled by existing scrubber (no duplication), C11 red-green via stash compiles.

Recurring Issue Check delta: Security — S10 = S9-class recurrence (asset enumeration narrower than invariant), caught by R34 sweep; Testing — RT1 → T16. Others unchanged.

---

## Round 3 (verification)

F13, S6, S7, T11, T12, T13 confirmed resolved. New findings (all in Round-2-edited text):

- **F14/S8 [Minor]** (dedup) `umask 077` cannot protect `/tmp/sentinel.conf` — umask affects only newly created files; the `cp`'d conf inherits 644 and restart-leftover files keep their mode (verified on redis:7-alpine). → C2 mechanism replaced with `chmod 600` after `cp`; manual-test adds `ls -l` (600) check.
- **F15 [Minor]** "docker inspect" rationale inaccurate — env passing also shows in inspect; the real gain is host-`/proc/cmdline` removal, and env passing matches existing compose secret practice (db `PASSWD_*_PASSWORD`). → C2 rationale corrected.
- **S9 [Major]** C11's query-stripping claim was wrong for the audited asset: share-link tokens are PATH segments (`/s/<token>`), untouched by query stripping; the planned fixture would go green while leaking the path token (decorative test, RT1 class). → C11 rewritten: URL sanitizer = query strip + capability-path redact (`/\/s\/[^/?#]+/` → `/s/[redacted]`), applied to request.url / query_string / url-named span keys / navigation breadcrumbs; fixtures assert path-token redaction and must fail pre-change (red-green via stash).
- **T14 [Minor]** C4's "+ its tests if covered" was conditional although coverage exists (`vault-context.test.tsx:353-559`); new throw path needs the file's per-exit-path `prfOutput` zeroization assert. → C4 files made unconditional with the convention named.
- **T15 [Minor]** `unlockWithPasskey()` has zero test coverage and the no-webauthn-mock convention blocks direct testing. → C4 specifies a shared envelope-parse helper, unit-tested once, wiring-only at call sites; manual-test locked-out scenario explicitly includes the passkey flow.

Verified-clean in Round 3: REDISCLI_AUTH support on redis:7 image, `exec` signal-handling improvement, C10 third-script harness feasibility, C11 red-green discipline practicability, sentinel runtime config-rewrite compatibility, env-var exposure parity with existing compose practice.

Recurring Issue Check delta: Functionality — F14 (declared invariant unmet by mechanism, undetectable by planned acceptance); Security — S9 (protect-target shape vs mechanism mismatch recurrence of T11 class); Testing — R34 → T15, RT1/RT5 → T14. Others unchanged.

---

## Round 2 (incremental)

Resolution verification: 26 of 27 Round 1 findings resolved; F5 continuing (third call site). New findings:

- **F13 [Major]** C4 enumerated only 2 of 3 `VAULT_UNLOCK_DATA` call sites — `unlockWithStoredPrf()` (`vault-context.tsx:693`) also swallows the lockout envelope (single-ceremony PRF flow shows wrong message). → C4 walkthrough rewritten to cover all THREE call sites.
- **S6 [Minor]** Render-time interpolation of the sentinel entrypoint would bake the real password into the long-lived `sh` cmdline (host-readable `/proc`) + `docker inspect`, contradicting C10's invariant; `/tmp/sentinel.conf` would be world-readable. → C2 sentinel mechanism switched to runtime env expansion (`$$REDIS_PASSWORD` + `environment` wiring) + `umask 077` + `exec`; acceptance render-check expectation flipped to literal-`$REDIS_PASSWORD` + env wiring, real-value check moved to manual test.
- **S7 [Minor]** Healthcheck `redis-cli -a` puts the password in argv every probe; `REDISCLI_AUTH` env is the documented safe alternative. → C2 healthcheck switched to `REDISCLI_AUTH` + `redis-cli ping | grep PONG`.
- **T11 [Major]** (T7 was incorrectly-resolved) `scrubSentryEvent` does not process `spans[]` at all, and key-based scrubbing cannot catch token-bearing URL VALUES — the planned fixture would either fail forever or be watered into a decorative test. → C11 now includes `sentry-scrub.ts` itself: spans[].data key-based scrub + URL-query-stripping for `request.url`/`request.query_string`/`url`-named span-data keys; fixtures must fail pre-change.
- **T12 [Major]** Third sibling script `set-audit-anchor-publisher-password.sh` has no test — the quoted-heredoc regression class unguarded on 1 of 3. → C10 adds new third test file.
- **T13 [Minor]** `getRedis()` `globalThis` singleton cache makes a second test case vacuous without reset. → C2 acceptance adds singleton reset requirement.

Verified-clean in Round 2: compose `$$` escaping mechanics, sentinel entrypoint YAML-list interpolation semantics, `VaultUnlockError(code, lockedUntil)` shape, Prisma composite-key name `tenantId_userId`, C8 scope-exclusion reasoning (admin-reset requires possessing the actual token — stronger than the plan's stated rationale), C10 DRY_RUN harness extensibility, C13 db-integration helper feasibility (`createUser()` + raw UPDATE), `vi.mock("ioredis")` default-import compatibility.

Recurring Issue Check delta: Functionality R22 → F13; Security: C10 argv-invariant class propagates to C2 surfaces (S6/S7); Testing RT1/RT2 → T11, R34 → T12. Others unchanged.

## Round 1

## Changes from Previous Round

Initial review. Deduplication done manually by the orchestrator (Ollama merge skipped: raw-output re-emission cost exceeded benefit; dedup pairs noted inline).

## Functionality Findings (F1–F12-A)

- **F1 [Major]** C1 upgrade path: `REASSIGN OWNED BY passwd_user` fails — `passwd_user` is the bootstrap superuser (`docker-compose.yml:39`); PostgreSQL refuses reassigning bootstrap-superuser-owned objects. → Plan C1 rewritten: drop&recreate jackson DB with OWNER, or ALTER TABLE DO-loop; both in manual-test artifact.
- **F2 [Major]** Redis healthcheck `["CMD","redis-cli","ping"]` (`docker-compose.yml:115`) breaks or goes vacuous under requirepass; app depends on `service_healthy`. → C2 adds authenticated healthcheck (`$$REDIS_PASSWORD` CMD-SHELL) for base + HA replicas.
- **F3 [Major]** (dedup with S2) Sentinel template is statically `cp`'d (`ha.yml:7-11`) — `${REDIS_PASSWORD}` in the template stays literal. → C2 specifies entrypoint `echo "sentinel auth-pass mymaster ${REDIS_PASSWORD}" >> /tmp/sentinel.conf` (compose render-time interpolation).
- **F4 [Major]** (dedup with S1) HA master override (`ha.yml:25-26`) replaces the base command, dropping requirepass; master also needs `--masterauth` for post-failover rejoin. → C2 master signature added.
- **F5 [Major]** `vault-context.tsx:390-396,517-527` swallows non-401 unlock/data errors → lockout UI message would be lost. → C4 adds vault-context change: parse envelope, throw `VaultUnlockError(ACCOUNT_LOCKED, lockedUntil)` in `unlock()` + `unlockWithPasskey()`.
- **F6 [Major]** (dedup with T4, R27) `magic-link.ts:9,13,21,25` hardcodes "24 hours"/「24時間」; test pins it. → C5 adds template+test files, duration interpolated from the same constant.
- **F7 [Major]** `scripts/__tests__/set-*-password.test.mjs` positively assert the old `-v new_password=` argv. → C10 adds both test files; assertions inverted + DRY_RUN captures stdin SQL.
- **F8 [Major]** (overlaps T3) `McpAccessToken.userId` nullable (SA-bound tokens) — bare predicate would kill SA-bound MCP flows; no `user` relation on the model. → C13 SA-bound skip + second-query note.
- **F9 [Major]** (dedup with T10) Real env SSoT files missing: `scripts/env-allowlist.ts`, `scripts/env-descriptions.ts`; `.env.example` is generated. → C1/C2 file lists corrected.
- **F10 [Minor]** `CLAUDE.md:129`, `docs/architecture/machine-identity.md:173,186` say "24h" DCR expiry. → C6 docs propagation added.
- **F11 [Minor]** Register 503 message "ensure dcr-cleanup-worker is running" misleading post-C6. → C6 reword added.
- **F12-A [Adjacent→Security]** `vault/admin-reset/route.ts:86-88`, `tenant/breakglass/[id]/route.ts:53-55` keep `forbidden()`. Security expert evaluated: correctly excluded from C8 (unguessable principal-delivered CUIDs / role denial). → Scope-exclusion record added to C8; Phase 3 revisits.

## Security Findings (S1–S5)

- **S1 [Major]** (= F4) HA master unauthenticated after override replacement — verified via real `docker compose config` render. → C2 fixed as above; HA NOAUTH render check added to acceptance.
- **S2 [Major]** (= F3) Sentinel auth-pass literal `${...}` via `cp`. → C2 fixed; acceptance requires rendered real value.
- **S3 [Major]** Bare `getTenantMembership(userId)` reuse = cross-tenant revocation bypass for multi-tenant users (token models all carry non-null `tenantId`; `TenantMember @@unique([tenantId, userId])`). → C13 rewritten: tenant-scoped `findUnique({ tenantId_userId })`, fail-closed; test case (b) added.
- **S4 [Minor]** "quoted heredoc" would suppress `$escaped` interpolation → wrong password set. → C10 specifies unquoted-delimiter heredoc + DRY_RUN SQL-content assertion.
- **S5 [Minor]** `REDIS_PASSWORD` URL-special chars break `new Redis(url)` parse. → C2 requires URL-safe (hex) generation in init:env + docs note.
- Verified-clean: C4 (no cross-principal oracle; recordFailure omission correct), C5 (maxAge seconds confirmed in `@auth/core` source), C7 (unique backstop + P2002 mapping sound), C8 (all 9 sites are pure ownership checks; non-ownership forbidden() correctly excluded), C9 (parse design sound incl. `=` in value, `__Host-` prefixes), C6 (1h TTL sufficient; tx posture preserved).

## Testing Findings (T1–T10)

- **T1 [Major]** unlock/data test mocks only `@/lib/tenant-rls`; `checkLockout` calls `withBypassRls` → existing tests TypeError. → C4 test-mock note added (mirror `unlock/route.test.ts:43`).
- **T2 [Major]** C6 mocked unit test vacuous (RT5); existing register tests crash without `deleteMany` in tx mock. → C6: arg+order assertions, db-integration test, mock updates.
- **T3 [Major]** C13: lookups use `select` not `include`; existing fixtures lack membership data (fail-closed ⇒ all valid-token tests break) or fail-open ⇒ vacuous pass (RT1); missing `userId:null` + `IOS_APP` cases. → C13 rewritten (with F8/S3).
- **T4 [Major]** (= F6) magic-link template + pinned test.
- **T5 [Major]** `npm run test:integration` / ci-integration.yml missing from gates; triggers hit by this PR; pre-pr.sh silently skips without Postgres. → Testing strategy updated (local run mandatory). CI `redis://localhost:6379` confirmed NOT matching the forbidden pattern — no CI change needed.
- **T6 [Major]** (RT6) `redis.ts` Sentinel branch change had zero automated coverage. → C2 adds `src/lib/redis.test.ts` (ioredis mocked, asserts `password` option).
- **T7 [Minor]** scrubber lacks transaction-shape fixture. → C11 adds one.
- **T8 [Minor]** `it("returns 403 ...")` titles must flip with assertions. → C8 acceptance updated.
- **T9 [Minor]** Manual-test scope: add existing-volume upgrade steps + C3 dev-flow checks; narrow locked-out scenario to UI-only. → Testing strategy manual-test contents enumerated.
- **T10 [Minor]** (= F9) env-allowlist/descriptions.

## Adjacent Findings

- F12-A — routed to Security expert; resolved as documented scope exclusion (see C8 scope-exclusion record). Re-check in Phase 3.

## Quality Warnings

None — all findings carried evidence (file:line) and concrete fixes; none flagged VAGUE / NO-EVIDENCE / UNTESTED-CLAIM.

## Recurring Issue Check

### Functionality expert
R1 ✓, R2 ✓, R3 → F5/F6/F10, R4 ✓, R5 ✓, R6 ✓, R7 N/A, R8 N/A, R9 ✓, R10 ✓, R11 N/A, R12 ✓, R13 N/A, R14 → F1, R15 ✓, R16 ✓, R17 N/A, R18 → F9, R19 → F7, R20 N/A, R21 N/A, R22 ✓ (F12-A enumeration), R23 N/A, R24 N/A, R25 N/A, R26 N/A, R27 → F6, R28 N/A, R29 ✓, R30 ✓, R31 ✓, R32 ✓, R33 N/A, R34 → F12-A, R35 ✓, R36 N/A, R37 ✓

### Security expert
R1 ✓ (S3 caveat), R2 ✓, R3 ✓, R4 ✓, R5 ✓, R6 ✓, R7 N/A, R8 N/A, R9 N/A, R10 N/A, R11 N/A, R12 N/A, R13 N/A, R14 ✓ (C1 no over-privilege), R15 N/A, R16 noted (CI env wiring — plan covers), R17 N/A, R18 N/A, R19 noted (C13 mocks — plan covers), R20 N/A, R21 N/A (phase), R22 N/A, R23 N/A, R24 N/A (no migrations), R25 N/A, R26 N/A, R27 N/A, R28 N/A, R29 ✓ (maxAge verified in `@auth/core` source; RFC 9700 ref pre-existing, unverified, non-load-bearing), R30 ✓, R31 noted (C1 upgrade ops — operator confirmation required), R32 N/A, R33 N/A, R34 ✓ (3 validators swept = S3), R35 Tier-2 — artifact planned; HA checks added, R36 N/A, R37 ✓; RS1 ✓, RS2 ✓ (no new endpoints), RS3 ✓, RS4 noted (placeholders mandatory in manual-test/PR body)

### Testing expert
R1 ✓, R2 ✓, R3 → T4, R4 ✓, R5 → T2, R6 ✓, R7 ✓ (no E2E 403 asserts, grep-verified), R8 N/A, R9 ✓, R10 ✓, R11/R12 ✓, R13 N/A, R14 manual-side (RT2-correct), R15 N/A, R16 ✓ (CI redis URL non-matching), R17/R22 N/A, R18 → T10, R19 → T1/T2/T3, R20 N/A (phase), R21 N/A (phase), R23 N/A, R24 N/A, R25 N/A, R26 N/A, R27 → T4, R28 N/A, R29 ✓, R30 ✓, R31 ✓, R32 ✓ (manual artifact), R33 ✓, R34 ✓ (plan embeds sibling checks), R35 → T9, R36 N/A, R37 ✓; RT1 → T3/T2, RT2 ✓ (all recommended tests verified testable), RT3 ✓ (constant-derived assertions required), RT4 N/A, RT5 → T2, RT6 → T6

## Resolution Status (Round 1)

All 27 findings (12 F + 5 S + 10 T) assessed VALID by the orchestrator; every one reflected in the plan in this round (no skips, no deferrals). Dedup: F3=S2, F4=S1, F6=T4, F9=T10, F8⊂T3. F12-A resolved as a documented scope exclusion with Phase 3 re-check. Plan sections rewritten: C1, C2 (largest), C4, C5, C6, C8, C10, C11, C13, Testing strategy.
