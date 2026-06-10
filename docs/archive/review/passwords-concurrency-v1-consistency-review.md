# Plan Review: passwords-concurrency-v1-consistency

Date: 2026-06-11
Review round: 2 (cumulative)

## Round 1

Local LLM pre-screen findings dispositioned: team-race ADOPTED (C1 extended to team), SA-throttle-constant-reuse rejected, $queryRaw injection addressed, mock-ordering addressed, Date.now-vs-now() rejected.

### Functionality (F1-F3)
- **F1/F2 [Minor]** column-parity wording implied `$queryRaw` must cover EVERY `History.create` field, but `tenantId` (invariant) and team's `changedById` (= current updater) are NOT past-state and must NOT come from `cur`. → C1 step-2 + parity note rewritten to source only crypto-metadata from `cur`.
- **F3 [Minor]** team `FOR UPDATE` should carry `AND team_id` for symmetry with the update where. → added.
- **R19 [Adjacent→Testing]** existing api-key.test.ts findUnique mocks need `lastUsedAt`. → recorded in C4.
- Verified-clean by functionality: READ COMMITTED + FOR UPDATE prevents the lost snapshot (second writer re-reads first's committed value after lock release — EvalPlanQual), tenant→tenant tx nesting folds GUC, RLS covers raw SELECT (id+GUC suffices), C2 4-arg form + sentinel guard correct, C3 all 4 sites enumerated + complete, C4 throttle off the auth path.

### Security — No findings
Confirmed: $queryRaw `${id}::uuid` is a bound param; RLS (`FORCE ROW LEVEL SECURITY` + all-command policy + GUC) covers the raw FOR UPDATE — no explicit tenant predicate needed (cross-tenant rows invisible/unlockable); no lock-wait existence oracle (early 404 gate precedes the lock); C2's `actorType` does NOT branch IP enforcement (audit-field only) so SA gets the same enforcement as humans; sentinel guard doesn't misfire with tenantId passed; C4 throttle never touches the validity decision and `lastUsedAt` is display-only (no anomaly signal); C3 dedupe has no authz angle (Set preserves the unowned tag). S-info: optional team `teamId` predicate on FOR UPDATE (= F3, adopted).

### Testing (T1-T4)
- **T1 [Critical]** `raceTwoClients` races service/direct-DB callbacks, NOT route handlers; personal's snapshot+update is inline in `handlePUT` (no service) so the personal lock can't be exercised by the race helper — only team's `updateTeamPassword` is a raceable service. → C1 db-integration representative switched to TEAM; personal/v1 real SQL covered by a column-validity integration test + unit SQL-text guard. (Service-extraction for personal rejected as over-scoped for a Low fix.)
- **T2 [Major]** `$queryRaw` mock can't validate real SQL (RT1); v1's prisma mock lacks `$queryRaw`. → unit tests assert the captured tagged-template SQL text (FOR UPDATE + table + columns); add `$queryRaw` to v1/personal mocks; db-integration column-validity test added; RT5 note that integration is the SQL guard.
- **T3 [Major]** RT4 guard "both-outcomes + lost-snapshot=0" can pass if contentions never overlap. → strengthened to assert EXACTLY 2 new history rows per iteration (cumulative 2*N) — the necessary condition that the lock serialized the writers.
- **T4 [Minor]** db-integration should use team as representative. → folded into T1.

## Round 2 (incremental)

Functionality F1/F2/F3 confirmed resolved (column carve-out matches team's actual payload exactly; team FOR UPDATE teamId symmetric). Testing T1/T2/T4 confirmed resolved. New:
- **F4 [Minor]** unit source-distinctness was payload-level — could miss a partial regression (only some crypto fields left as `existing.*`). → C1 unit assertion strengthened to FIELD-LEVEL (each crypto field individually distinct from `existing`, sourced from `cur`).
- **T5 [Major]** the "cumulative 2*N history rows" RT4 guard conflicts with trim-to-20 (breaks at iteration 21 once an entry exceeds 20 history rows). → restructured: per-iteration FRESH entry, assert exactly 2 history rows for THAT entry (below trim), PLUS a content guard (the two snapshots = `{v0, firstWriter}`, `firstWriter != v0`) — the direct lost-update detector that a count-only guard misses. Both-outcomes retained.
- Verified-clean R2: racing team is a valid representative (item-key/key-version logic widens the snapshot payload but does not touch the FOR-UPDATE serialization primitive); `$queryRaw` first-arg is `TemplateStringsArray` so SQL-text assertion is implementable (precedent purge-audit-logs test); column-validity integration feasible via `createPrismaForRole` + GUC.

## Resolution Status (Round 2)

F4, T5 reflected in C1 acceptance (field-level unit assertion + per-entry content-guard race). No skips.

## Round 3 — verification round below.

## Resolution Status (Round 1)

All findings reflected in the plan this round (no skips). Dedup: F3=S-info; R19 routed to C4. Plan sections rewritten: C1 (mechanism step-2, parity note, team FOR UPDATE teamId, acceptance/testing fully reworked for T1-T4), C4 (R19 fixture note).
