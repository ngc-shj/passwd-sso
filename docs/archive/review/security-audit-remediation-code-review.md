# Code Review: security-audit-remediation

Date: 2026-06-11
Review round: 3 (cumulative; rounds appended)

## Round 2 (incremental, on commit `c42f29b0`)

All 17 Round-1 findings verified **resolved** (functionality re-traced scrubber pass composition for double-processing — none; security re-verified helper semantics equivalence, mobile check placement, sentinel peer-auth model, dequote edges; testing spot-verified every new test's detection power incl. reasoning the Referer fixture red against the pre-fix scrubber). New findings → fixed in `9a0ee0da`:

- **F6 [Minor]** `foreignOwned` lookup lacked the self-exclusion guard → same-user double-submit misreported as name_conflict instead of reaching the already_claimed recovery. Fixed via shared `sameNameWhereBase` (class-level fix: the invariant lives in ONE where object spread into both lookups) + new test.
- **S6 [Minor]** auto-captured `exception.values[].value` / `event.message` free text could carry capability URLs. Fixed: `redactCapabilityPaths()` helper (TOKEN_ROUTE_PATTERNS only — no query truncation on free text; char class tightened to `[^\s/?#:]`), applied to both; reused by sanitizeUrl; red-able fixtures.
- **T10 [Minor]** integration tests don't run under pre-pr on this branch name — both PR-owned integration files explicitly re-run against real Postgres: 5/5 PASS.
- **T11 [Info]** limiter vi.mock moved to top level. **T12/F7 [Info]** recorded, no action (existing-pattern parity / SDK-guaranteed shape).

Post-round: merged `origin/main` (#529 iOS host-server integration + codeql bump) — zero file overlap with this branch; `npx prisma generate` re-run; pre-pr now 32/32 PASS (includes the new iOS gate from main).

## Round 3 (verification, on `9a0ee0da` + main merge)

Functionality: **No findings** (F6 flow re-traced incl. already_claimed recovery; char-class change proven non-weakening — all three token kinds are 64-char lowercase hex; #529 semantic-interaction check clean). Security: **No findings** (#529's bridge-code flow needs no C13 — 60s single-use CAS + step-up at issuance, downstream tokens C13-covered at use AND rotation; no bypass of cookie hardening or unlock/data lockout; S6 char class bypass-free). Testing: mutation-tested the round-2 fixes — S6 fixtures all red under 3 mutations (healthy), but **T13**: the F6 test stayed GREEN with the guard reverted (order-based mock, where-blind); **T14 [Minor]**: array-form exception branch decorative.

→ Fixed in `5bbb973c`: T13 nth-call where assertion (+createdById absence) — red verified under guard removal; T14 bare-array fixture — red verified under branch removal.

## Round 1

## Changes from Previous Round

Initial review (incremental on the Phase 2 self-R-check baseline). Ollama seeds: func/sec truncated (fallback full-diff); test seed 10 findings — all 10 rejected on verification, 4 adjacent real issues adopted under new IDs. Dedup: F2⊂S2, F5⊂S1.

## Functionality Findings

- **F1 [Major]** `sentry-scrub.ts:131-144` — navigation-breadcrumb branch rebuilds `data` from the RAW `bc.data`, discarding the key-based scrub applied two lines earlier. Fix: base the from/to sanitize on the already-scrubbed data.
- **F2 [Minor→merged into S2]** residual URL carriers (contexts.trace.data, `http.target`/`url.full`, fetch/xhr breadcrumb `data.url`).
- **F3 [Minor]** consent claim same-user double-submit race (pre-existing, changed file): T2's own claimed row matches the owner-scoped `existing` findFirst → self-delete → 403 + dead auth code. Fix: `id: { not: clientIdDb }` in the where.
- **F4 [Minor]** `.env.example` renders `# REDIS_PASSWORD=` (optional-looking) while compose hard-requires it. Fix: sidecar description note + regenerate.
- **F5 [Minor→merged into S1]** issuance paths lack membership check.
- Verified-clean: C1/C2 compose render (real merge render checked), C4 verbatim parity + 3 wired call sites, C7 re-registration flows, C8 complete + import-level guarantee, C12/C9/C13 contract conformance, sibling sweeps (rotate-key/data correctly out of class; no other timeout-less fetches; no other substring cookie parse).

## Security Findings

- **S1 [Major]** C13 not propagated to token ROTATION paths: `oauth-server.ts` `exchangeRefreshToken` (Phase 1 checks) and `src/app/api/mobile/token/refresh/route.ts` validate rotation without the tenant-membership predicate — a deactivated user keeps rotating families indefinitely (access tokens still die at validation ⇒ no resource access, but live families survive re-activation and keep writing token rows + audit events). Fix: same tenant-scoped fail-closed check in both, mapped to `invalid_grant`/`unauthorized`.
- **S2 [Major]** scrubber residuals vs C11 invariant: (a) `request.headers` Referer (full URL incl. `/s/<token>` pages) never scrubbed; (b) `URL_KEY_NAMES` misses OTel-shaped `url.full`/`http.target`/`url.query`; (c) fetch/xhr breadcrumb `data.url` bypasses sanitizeUrl. Fix: sanitize Referer/referer (or drop), extend key set, sanitize all breadcrumb `data.url`, process `contexts.trace.data` like span data.
- **S3 [Minor]** `01-create-jackson-db.sql` fallback creates LOGIN role with hardcoded `'jackson_pass'` when env missing (fail-open outside compose). Fix: fail-closed (warn+quit or NOLOGIN); check 02-create-app-role.sql sibling convention.
- **S4 [Minor]** Sentinel control plane (26379) unauthenticated — internal-network actor can force failover / rewrite auth-pass. Fix: append `requirepass` to sentinel conf + wire `REDIS_SENTINEL_PASSWORD` for the app in ha.yml; render-check + manual-test note (VE2).
- **S5 [Minor]** quoted-cookie-value aliasing: Auth.js dequotes, proxy cache keys raw value → quoted variant escapes tombstone invalidation for up to 30 s. Fix: dequote in extractSessionToken.
- Verified-clean: C7 TOCTOU/P2002 scope, name_conflict disclosure acceptable, C4 ordering parity, C10 heredoc safety incl. newlines/backslashes, C13 validators exact, %23/encoding bypass of sanitizeUrl not constructible, withBypassRls+$transaction proxy folding correct.

## Testing Findings

- **T1 [Major]** `failClosedOnRedisError` wiring has ZERO test (deviation-log "constant-export assertion" substitute does not exist in code); deleting the line keeps 11147 tests green. REQUIRED now: vi.mock `createRateLimiter`, capture options.
- **T2 [Major]** C7 tests are regression-blind: findFirst where args never asserted (order-dependent mockResolvedValueOnce), tx delete is an anonymous fn — removing `createdById` keeps all green. Fix: assert where args; named delete mock with not-called/called-with asserts.
- **T3 [Major]** C6 integration test re-implements the cleanup as raw SQL (tautology; also drifts from the deviation-log description "direct Prisma transaction"). Fix: use the real Prisma `deleteMany`/`count` shapes (minimum), ideally a shared helper with the route.
- **T4 [Major]** C12 `signal` attachment unasserted — deleting it keeps tests green. Fix: assert fetch called with `signal: expect.any(AbortSignal)`.
- **T5 [Major]** C11 implemented-but-untested behaviors: navigation from/to sanitize + `request.query_string` wipe. Fix: two red-able fixtures.
- **T6 [Minor]** redis non-Sentinel test runs without REDIS_PASSWORD set → regression class undetectable. Fix: set env in test.
- **T7 [Minor]** decorative stdout assert (`not.toContain` on always-empty stdout) + stale "JSON array" header comments in the 3 password scripts.
- **T8 [Minor]** magic-link TTL asserted on text only, html uncovered.
- **T9 [Minor]** register test name "inside transaction" unproven (mock aliased to both top-level and tx). Fix: separate tx mock.
- Acceptance-conformance table: all other plan acceptance items verified present (C2 reset/red-green, C4 full matrix, C8 18 flips + duplicates, C9, C10, C11 (a)-(e), C13 matrices + db-int).

## Adjacent Findings

None tagged this round (F2/F5 routed to Security and merged).

## Quality Warnings

None.

## Recurring Issue Check

### Functionality expert
R1/R2 ✓, R3 → F5(=S1), R10 ✓ (cycle fix verified), R18 ✓, R19 ✓, R27 ✓, R31 N/A, R34 ✓ (sibling sweeps documented), R35 ✓, others ✓/N/A per report.

### Security expert
R3 → S1 (rotation-path propagation), R10 ✓, R18 ✓, R27 ✓, R34 noted (rotate-key/data plan item — covered by Functionality sweep this round), RS1-RS4 ✓; S2/S4 = reach-shortfall of the fixes, not new holes opened.

### Testing expert
RT5 → T2/T3 (recurrence in integration/mock form), RT3 ✓, R19 ✓, test-title honesty → T9, mock-reset/await/exact-shape red flags ✓ none.

## Seed Finding Disposition

- Functionality: Seed unavailable — no dispositions to record.
- Security: Seed unavailable — no dispositions to record. (FYI items: compose env exposure — accepted as existing practice; %23 fragment bypass — verified not constructible.)
- Testing: seeds 1-10 ALL Rejected (stale/hallucinated vs actual diff — each with reason in expert report); adjacent real issues adopted as T5 (≠seed 6's claim), T7 (≠seed 10), T8 (≠seed 5), T9 (≠seed 8).

## Environment Verification Report

- VE1 (Jackson/SAML IdP): **blocked-deferred** — per plan VE1; container boot + dedicated-role DB connectivity covered by manual-test artifact steps (Anti-Deferral: live IdP unavailable locally; boot/connectivity is the verifiable subset).
- VE2 (HA/Sentinel live): **blocked-deferred** — per plan VE2; compose merge RENDER verification executed this round (verified-local: `docker compose -f docker-compose.yml -f docker-compose.ha.yml config`); live failover remains operator manual-test.
- VE3 (ps visibility): **blocked-deferred** — per plan VE3; manual-test artifact carries the two-shell procedure.
- All other acceptance paths: verified-local (vitest 11147 green, pre-pr 31 gates, targeted db-integration runs).

## Resolution Status

### Round 1 — all 17 findings fixed in commit `c42f29b0` (no skips)

- F1 [Major] navigation scrub-loss — fixed (base on scrubbed data); red-green verified. `sentry-scrub.ts`
- S2/F2 [Major] residual URL carriers — fixed: Referer/referer sanitized, URL_KEY_NAMES + url.full/http.target, URL_WIPE for url.query/url.path, all breadcrumb data.url, contexts.trace.data processed; 5 new red-able fixtures. `sentry-scrub.ts` + tests
- S1/F5 [Major] rotation-path C13 — fixed: shared `checkTenantMembership` helper; exchangeRefreshToken Phase-1 check → invalid_grant; mobile refresh route check → 401; bypass-rls allowlist synced; 6 new tests incl. SA-bound skip; follow-up R19 miss in `src/__tests__/lib/mcp/refresh-token.test.ts` also fixed.
- S3 [Minor] initdb fallback — fail-closed (\warn + NOLOGIN); siblings 02/03 share the legacy fail-open pattern (compose-guarded; noted, not modified — same standalone-initdb exposure class, tracked for follow-up).
- S4 [Minor] sentinel control plane — requirepass appended + REDIS_SENTINEL_PASSWORD wired to app (redis.ts already passes sentinelPassword); render-verified; manual-test updated (VE2).
- S5 [Minor] cookie dequote — fixed + tests.
- F3 [Minor] consent self-claim race — `id: { not: clientIdDb }` + test.
- F4 [Minor] REDIS_PASSWORD description note + .env.example regenerated; check:env-docs green.
- T1 [Major] failClosed wiring test via createRateLimiter capture — red-green verified.
- T2 [Major] consent where/delete assertions — red-green verified (createdById removal now fails tests).
- T3 [Major] integration test now exercises the real Prisma deleteMany/count shapes.
- T4 [Major] signal assertion — red-green verified.
- T5 [Major] navigation/query_string fixtures added (within the S2 fixture set).
- T6/T7/T8/T9 [Minor] all fixed as specified (env teeth via vi.stubEnv after hygiene-gate conversion; stderr-redaction asserts; html asserts; split tx mock proving in-transaction).
- Gate re-run: pre-pr.sh 31/31 PASS (after fixing a type error, the refresh-token.test R19 miss, and converting redis.test.ts to vi.stubEnv per the test-hygiene gate).

## Round 4 (final verification)

All three experts: **No findings** on the `5bbb973c` test-only diff. Code review CLOSED after 4 rounds. Cumulative: Round 1 — 17 findings (8 Major / 9 Minor, dedup'd), Round 2 — 4 (2 Minor / 2 Info), Round 3 — 2 (T13 detection-power, T14 Minor); all resolved with red/mutation evidence; zero skipped or deferred findings requiring Anti-Deferral entries beyond the documented scope-exclusion (C8 admin-reset/breakglass) and the recorded sibling note (initdb 02/03 legacy fallback — compose-guarded, follow-up).
