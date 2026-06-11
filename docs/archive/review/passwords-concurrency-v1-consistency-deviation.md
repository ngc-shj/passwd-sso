# Coding Deviation Log: passwords-concurrency-v1-consistency

## Phase 2 implementation deviations

- C1 implementation agent was interrupted mid-run (user pause); on resume the 3 primary unit files (personal/v1/team) + production + the lost-update integration test were already complete and green (114 unit + 2 integration). The interruption left two SIBLING test files broken by R19 mock-propagation (they exercise the same handlers but their mocks lacked the new `$queryRaw`): `src/app/api/teams/[teamId]/passwords/[id]/route.test.ts` (3) and `src/__tests__/api/passwords/write-scope.test.ts` (2). Fixed by adding `$queryRaw` mocks (R19) — no assertion weakened.
- C1 db-integration: the lock-semantics proof races `updateTeamPassword` (the only raceable service of the three) per the locked plan; personal/v1 inline-handler SQL is covered by the column-validity check + unit SQL-text guard. Recorded as the plan's deliberate representative choice (avoids over-scoped service extraction for a Low fix).
- Full `npm run test:integration` shows 5 pre-existing failures (audit-anchor manifest count, audit-sentinel backfill actor, mobile cache-rollback 401s, dcr-cleanup-worker-sweep audit-row count) — identical to the set documented in the #530 deviation log, all reproduce on an origin/main baseline against the same shared dev DB (stale-data / parallel contention), none are this PR's files. Authoritative gate: CI integration job on a fresh DB. This PR's two new integration tests pass in isolation.
- C3: inlined `[...new Set(tagIds)]` at all 4 personal/v1 sites rather than extracting a shared helper (heterogeneous db-handle + error mapping) — accepted DRY exception per plan SC2.
- C4: dedicated `API_KEY_LAST_USED_THROTTLE_MS` (not reusing the SA constant); both derive from `MS_PER_MINUTE`.

## Follow-up tracked (NOT this PR)

- Post-#530 hardening review produced 5 items (Redis HA app `REDIS_PASSWORD` explicit env, Sentry span.description/event.transaction scrub, Jackson `REVOKE CONNECT FROM PUBLIC`, DCR per-IP unclaimed cap = SC7, `.env.example` asymmetry). User directed: handle ALL of them in a SEPARATE follow-up PR after this concurrency PR merges.
