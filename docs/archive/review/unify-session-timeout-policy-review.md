# Plan Review: unify-session-timeout-policy
Date: 2026-04-18
Review round: 1
Reviewer note: **The three expert sub-agents all hit Anthropic rate limits (reset 1pm Asia/Tokyo) and returned no output.** Review performed inline by the main orchestrator across three perspectives. Objectivity is reduced; findings should be re-examined on the next round if rate-limited agents become available again.

## Changes from Previous Round
Initial review.

## Functionality Findings

### [F1] [Major]: Plan misstates how Auth.js database-strategy cookie Max-Age works
- **Evidence**: Plan L53, L87, L109-111 claim "Cookie `Max-Age` = `min(resolved absolute, resolved idle)` at each `updateSession`" and "Auth.js's cookie Max-Age is set from `session.expires - now`. Since we return a per-user `expires` from the adapter, the cookie Max-Age inherits it automatically."
- **Reality**: Verified by reading `node_modules/next-auth/node_modules/@auth/core/lib/actions/session.js` L33, L84, L90: Auth.js computes `newExpires = fromDate(sessionMaxAge)` ALWAYS from the static `session.maxAge` config, not from a per-user adapter return. The adapter's `updateSession` receives this `newExpires` in its `session.expires` argument and writes it to DB. The cookie Max-Age is set at signIn from `sessionMaxAge` (config) and is NOT re-derived from adapter output on each updateSession for the database strategy (cookie only stores the opaque session token).
- **Problem**: The plan's "per-user cookie Max-Age" requirement is not implementable via the adapter alone. It would require custom cookie handling bypassing Auth.js's built-in logic.
- **Impact**: If implemented as written, the claim silently does nothing — cookie lingers at config ceiling (30d) even when the DB row expires in 30min. This is not a security bug (server-side DB check at L70-74 of session.js is authoritative: `if (session.expires.valueOf() < Date.now()) { deleteSession }`) but the plan documents an impossible contract.
- **Fix**: Rewrite the cookie section to acknowledge the Auth.js model: "Cookie Max-Age is bounded by `session.maxAge` config (30d). The DB `session.expires` is the authoritative expiry, checked by Auth.js on every `getSessionAndUser` call — expired DB rows are deleted and the session is cleared. This means the cookie may outlive the DB row briefly in the browser's cookie jar, which is not a security concern because server-side validation rejects the stale token." Remove the "cookie Max-Age = min(...)" requirement from Non-functional.

### [F2] [Major]: `updateSession` expires computation treats absolute as rolling
- **Evidence**: Plan L88 states `update expires = now + min(idle, absolute)`.
- **Problem**: The `absolute` axis is measured from `createdAt` (non-rolling per Design §Resolution Order and Considerations §Known risks "absolute cap is NOT rolling"). `now + min(idle, absolute)` computes a rolling absolute, which can extend the session past `createdAt + absolute`. Example: `createdAt = 0h, absolute = 12h`. At `now = 10h`, the formula yields `10h + 12h = 22h`, but correct is `12h`. Results in sessions that survive past their absolute cap.
- **Impact**: Violates [ASVS 5.0 V7.3.2](https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x16-V7-Session-Management.md#v73-session-timeout) absolute-timeout invariant for sessions that are active throughout the window. This is the exact bug the redesign claims to fix — it would reappear.
- **Fix**: Change expires formula to `min(now + idleMinutes, createdAt + absoluteMinutes)`. Equivalently: `new Date(Math.min(Date.now() + idle * MS_PER_MINUTE, createdAt.getTime() + absolute * MS_PER_MINUTE))`. Update Plan L88 and Technical Approach > Auth.js adapter integration.

### [F3] [Minor]: AsyncLocalStorage mutation pattern for `provider` is subtle; add an implementation note
- **Evidence**: Plan §"Session provenance" L99: "accepts a `provider` via `AsyncLocalStorage` (reuse `sessionMetaStorage`). Auth.js provides the provider in the `signIn` callback — we store it in the async store."
- **Problem**: `sessionMetaStorage.run(meta, ...)` is called at route-handler entry (`[...nextauth]/route.ts:46`) with a fixed `meta` object. The `signIn` callback runs inside this scope but `ALS.run` doesn't allow replacing the stored value mid-flow. The only way to propagate `provider` to `createSession` is to mutate the stored object reference. This is sound (ALS.getStore returns the same reference) but non-obvious.
- **Impact**: Future maintainers may try to replace the object and get confused. Minor, but affects code clarity.
- **Fix**: Add to Plan §"Session provenance": "Implementation note: the `provider` field is added to the existing `SessionMeta` interface and set by the `signIn` callback via `const meta = sessionMetaStorage.getStore(); if (meta) meta.provider = params.account?.provider ?? null;`. This relies on ALS returning the same object reference within the async chain."

### [F4] [Major]: Migration step 2 conflates DDL ordering for Tenant columns
- **Evidence**: Plan L157: "Tenant: add 3 new columns ... with server-side defaults (480/43200/10080/43200 respectively). Backfill existing NULL `sessionIdleTimeoutMinutes` to 480. Flip all 4 columns to NOT NULL."
- **Problem**: The 3 NEW columns can be added as `NOT NULL DEFAULT ...` in a single `ALTER TABLE` statement; no backfill needed. The existing `sessionIdleTimeoutMinutes` column requires a different sequence: (1) `UPDATE tenants SET session_idle_timeout_minutes = 480 WHERE session_idle_timeout_minutes IS NULL;` (2) `ALTER TABLE tenants ALTER COLUMN session_idle_timeout_minutes SET NOT NULL;` (3) optionally `ALTER TABLE ... ALTER COLUMN ... SET DEFAULT 480;`. Writing "Flip all 4 columns to NOT NULL" as one bullet invites a migration that fails at UPDATE time because the column is already NOT NULL.
- **Impact**: Migration may fail on production DBs with a mix of tenant rows, some having NULL values.
- **Fix**: Rewrite step 2 with explicit DDL ordering per column. List the three new columns separately from the existing-column flip. Include the corresponding `DOWN` statements where applicable (Prisma `migrate dev` generates `up.sql` only — no rollback — but document the inverse ops for operational clarity).

### [F5] [Major]: Cascade clamp in scenario 6 requires serializable transaction — not mentioned
- **Evidence**: Plan §User Operation Scenarios > Scenario 6 L268-274: tenant PATCH clamps all teams' values in the same transaction.
- **Problem**: If a team admin concurrently updates their team policy during the tenant PATCH, the tenant-side `SELECT` of team values followed by `UPDATE` is a classic read-then-write TOCTOU (R5). The plan does not specify isolation level.
- **Impact**: A team could end up with a value exceeding the new tenant cap after both writes commit under default isolation.
- **Fix**: Specify Serializable isolation for the tenant PATCH transaction when any clamping is required. Add to Technical Approach: "The tenant PATCH uses Prisma `$transaction` with `isolationLevel: 'Serializable'` when the request would lower `sessionIdleTimeoutMinutes` or `sessionAbsoluteTimeoutMinutes`. The existing `createSession` already uses Serializable for concurrent-session eviction — same pattern."

### [F6] [Minor]: Tenant cache invalidation symbol name undefined
- **Evidence**: Plan §Cache Invalidation Contract L148: "a new tenant-session-policy cache" — no name given.
- **Problem**: Implementation sub-agents will invent different names; risk of multiple parallel caches.
- **Fix**: Specify the cache owner explicitly: "New cache keyed by tenantId in `src/lib/session-timeout.ts`, with a named invalidator `invalidateSessionTimeoutCache(tenantId)`. Call from `PATCH /api/tenant/policy` and `PATCH /api/teams/[teamId]/policy` alongside the existing `invalidateTenantPolicyCache`."

### [F7] [Minor]: Extension token family size pruner deferred with a TODO — justify per Anti-Deferral
- **Evidence**: Plan L224: "Out of scope for this plan; tracked as TODO(unify-session-timeout-policy): add family row pruner."
- **Problem**: Anti-Deferral rules require a quantified cost-benefit. With max 3 active tokens + rotation every idle-TTL (default 7d), over 30d absolute a family accumulates 30/7 * 3 = ~13 rows. 10k users * 13 ≈ 130k rows over 30d. Not a scale issue.
- **Fix**: Replace the TODO with an explicit justification: "Worst case: ~130k extension_token rows per 10k-user tenant over 30d (3 active × 30/7d rotations). Likelihood: low (vast majority revoked by idle expiry). Cost to fix: medium (requires a scheduled job). Deferred to a follow-up because table growth is bounded; add an index on `(familyId, revokedAt)` now for cheap lookup."

### [F8] [Minor]: Scenario 1 promises "within the 30s heartbeat" but `updateAge` semantics are different
- **Evidence**: Plan Scenario 1: "existing session whose `lastActiveAt` is older than 60 min is signed out at the next `auth()` call (within the 30s heartbeat)."
- **Problem**: `updateAge: 30` does NOT mean "check every 30s." It means Auth.js calls `updateSession` at most every 30s (throttle). If the user is idle (no HTTP activity), no heartbeat fires. The sign-out happens at the NEXT activity after the idle window lapses — could be minutes or hours later for an idle tab.
- **Impact**: Documentation misleads operators about enforcement timing.
- **Fix**: Rewrite: "signed out at the next auth() call that triggers `updateSession` (i.e., on the user's next HTTP activity after the idle window)."

## Security Findings

### [S1] [Major]: Document that `provider` in sessionMetaStorage is server-controlled only
- **Evidence**: Plan §"Session provenance" does not explicitly state the threat model boundary.
- **Attacker**: A user attempting to elevate their session to AAL3-gated (or demote it to dodge AAL3 clamping).
- **Attack vector**: Inject `provider=webauthn` via a request header, query param, or request body on the signIn path.
- **Preconditions**: `sessionMetaStorage` is writable from the request layer in a way that reaches `createSession`.
- **Impact**: If `provider` could be spoofed, an attacker could either gain AAL3-only UI surfaces without passkey authentication, or avoid AAL3 tightening to keep a long-lived session after passkey auth.
- **Fix**: Add explicit security note: "`provider` is set **only** by server-side code: (a) the `signIn` callback in `src/auth.ts` via `params.account?.provider` (provided by Auth.js after the OAuth/OIDC exchange — not user-controlled), and (b) the passkey verify route via a literal string. No request headers, query params, or body fields feed into this value. Verified by greppng all writes to the provider field." State that any future extension of session-establishment paths (e.g., SAML-only direct flow) must also set provider from a trusted source, not user input.
- **Spec citation**: [OWASP ASVS 5.0 V7.2 (Fundamental Session Management Security)](https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x16-V7-Session-Management.md#v72-fundamental-session-management-security) (session binding / integrity controls), [NIST SP 800-63B Rev 4 §5.1 (Session Bindings)](https://pages.nist.gov/800-63-4/sp800-63b.html): "A session SHOULD inherit the AAL properties of the authentication event that triggered its creation."
- escalate: false
- escalate_reason: standard auth-flow integrity check; not a chained vuln

### [S2] [Major]: Existing sessions with NULL provider after migration permanently escape AAL3 clamp
- **Evidence**: Plan L101: "Backfill migration sets existing Session.provider to `'unknown'` (non-AAL3 → uses the non-clamped policy)."
- **Attacker**: A user whose pre-migration passkey session is still active post-migration.
- **Attack vector**: After tenant enforces AAL3 via the new policy, the user's existing Passkey-established session continues under the non-AAL3 limits until it expires normally (up to 30d absolute).
- **Preconditions**: User had an active passkey session before the migration; tenant has WebAuthn sessions in use.
- **Impact**: AAL3 assurance is not re-established until next passkey auth. Duration of degradation: up to `sessionAbsoluteTimeoutMinutes` (30d default).
- **Fix**: Option A (strict): Delete all existing Session rows in the migration. Forces all users to re-auth. Operationally disruptive.
  Option B (safer default): Accept the one-time degradation; document it clearly in `CHANGELOG.md` and admin release notes; state the longest window ≤ 30d; recommend tenant admins with strict AAL3 needs run `/api/sessions` DELETE for all users post-deploy.
  Plan should pick one. Recommend B with documented acceptance criteria.
- **Spec citation**: [NIST SP 800-63B-4 §2.3.3 (AAL3 Reauthentication)](https://pages.nist.gov/800-63-4/sp800-63b.html) (AAL reauthentication requirements apply to new sessions; existing sessions at a lower AAL are a migration artifact, not a compliance violation).
- escalate: false

### [S3] [Major]: Team PATCH `≤ tenant value` validation must reject ≤0 and NaN
- **Evidence**: Plan §UI changes L106 and step 7: "≤ tenant value" cross-field validation.
- **Attacker**: A team admin attempting DoS via a crafted PATCH body.
- **Attack vector**: Send `sessionIdleTimeoutMinutes: 0` or `sessionIdleTimeoutMinutes: -1` or a non-integer. If only the `≤ tenant` constraint is checked, negative/zero passes (negative is ≤ any positive tenant value).
- **Preconditions**: Team admin permission on any team.
- **Impact**: Team's effective idle = 0 means every session is immediately expired → all team members permanently locked out of their team workspace.
- **Fix**: Add to step 7: "Validation: `value === null || (Number.isInteger(value) && value >= 1 && value <= tenant.sessionIdleTimeoutMinutes)`. Reject 0, negative, non-integer, and values exceeding tenant. Same for absolute."
- **Spec citation**: [ASVS 5.0 V2.2.1 (Input Validation)](https://github.com/OWASP/ASVS/blob/v5.0.0_release/5.0/en/0x11-V2-Validation-and-Business-Logic.md#v22-input-validation) — "input is validated to enforce business or functional expectations".
- escalate: false

### [S4] [Minor]: Extension family revocation must be audited
- **Evidence**: Plan step 8 introduces `revokeExtensionTokenFamily(familyId, reason)` but doesn't mention audit logging.
- **Problem**: Current `extension_token` revocation events appear in audit logs for SCIM user deletion. A new code path via family-expiry or replay detection must also emit an audit event, otherwise we lose forensic visibility into token rotation anomalies (e.g., replay attacks).
- **Fix**: Specify: "`revokeExtensionTokenFamily` must emit an audit event `EXTENSION_TOKEN_FAMILY_REVOKED` with metadata `{ reason, familyId, rowsRevoked }` scoped to the affected user. Register in `AUDIT_ACTION`, `AUDIT_ACTION_GROUPS_PERSONAL[SESSION]`, i18n, and tests (R12)."

## Testing Findings

### [T1] [Major]: Manual/E2E test claims cookie Max-Age matches tenant default — impossible per F1
- **Evidence**: Plan §Testing Strategy > Manual/E2E: "Sign in via Google OIDC, verify session cookie Max-Age matches tenant default (8h on default tenant)."
- **Problem**: Per F1, cookie Max-Age is bound to the static 30d config, not tenant value. This test as written would FAIL even when the implementation is correct.
- **Fix**: Rewrite to test the actual invariant: "Sign in via Google OIDC; verify DB `session.expires` = now + tenant default. Trigger an additional auth() call after `idle + 1s` of idle time; verify the session row is deleted and redirect to signin occurs."

### [T2] [Major]: Off-by-one testing for absolute boundary not specified
- **Evidence**: Integration test bullets in plan L201-205 mention "session deletion on absolute-exceed" but not a boundary case.
- **Problem**: TTL code commonly has off-by-one bugs at millisecond boundaries (e.g., `<=` vs `<`). Without a test at `createdAt + absolute - 1ms` (must survive) and `createdAt + absolute + 1ms` (must be deleted), the implementation could drift silently.
- **Fix**: Add to integration test: "Seed a session with `createdAt` such that `createdAt + absolute === now - 1s` — assert deleted on updateSession. Seed another with `createdAt + absolute === now + 1s` — assert survives and `expires` is updated to `now + min(idle, 1s)`."

### [T3] [Major]: Migration backfill not covered by integration test
- **Evidence**: Plan does not list a migration test scenario.
- **Problem**: Silent migration bugs (wrong default, NOT NULL flip failing on pre-existing NULLs, type coercion) pass unit tests but corrupt production data.
- **Fix**: Add to `src/__tests__/db-integration/session-timeout.integration.test.ts`: "Apply the migration on a seed DB that includes a tenant with `sessionIdleTimeoutMinutes = NULL`, a team with `maxSessionDurationMinutes = 720`, an ExtensionToken row with NULL familyId. Assert post-migration: tenant has 480 (backfilled), new fields have defaults; team has `sessionAbsoluteTimeoutMinutes = 720` (copied from maxSessionDurationMinutes); ExtensionToken has `familyId = id` and `familyCreatedAt = createdAt`."

### [T4] [Minor]: i18n key coverage test for removed keys
- **Evidence**: Plan removes `maxSessionDurationMinutes` and `maxSessionDurationHelp` keys. Plan does not mention whether this breaks an existing coverage test.
- **Problem**: `messages/*/TeamPolicy.json` is enumerated by tests (common pattern in this repo). Removing a key without updating tests breaks CI.
- **Fix**: Add to step 7: "Run the existing i18n coverage test (`grep -rn 'TeamPolicy' src/__tests__/` to find) and update any key enumeration list. If no coverage test exists, add one that asserts the set of keys in `en` == set in `ja`."

### [T5] [Minor]: Scenario 6 cascade-clamp test missing
- **Evidence**: Scenario 6 describes a multi-row transaction but no test case is listed.
- **Problem**: Cascade-clamp logic is non-trivial (lookup affected teams, clamp, audit). Untested.
- **Fix**: Add integration test: "Seed tenant with `sessionAbsoluteTimeoutMinutes = 43200`, two teams with `sessionAbsoluteTimeoutMinutes = 720` and `sessionAbsoluteTimeoutMinutes = null`. PATCH tenant with new value 240. Assert: team1's value clamped to 240, team2's value unchanged (null), audit events emitted per clamped team."

## Adjacent Findings

*(None — inline reviewer covered all three scopes; no cross-scope routing needed.)*

## Quality Warnings

*(None flagged — all findings include concrete evidence and fixes.)*

## Recurring Issue Check

### Functionality expert
- R1 Shared utility reimplementation: Checked — plan explicitly reuses `invalidateTenantPolicyCache`, `sessionMetaStorage`, `withBypassRls`, MCP rotation pattern. No new parallel helpers.
- R2 Constants hardcoded in multiple places: Checked — plan lists all `EXTENSION_TOKEN_TTL_MS` sites; `8 * 60 * 60` verified sole occurrence. Finding F6 addresses the unnamed cache symbol.
- R3 Incomplete pattern propagation: Checked — Finding F1 shows the cookie-Max-Age claim has no propagation plan because it's not implementable. Fix removes the false claim.
- R4 Event/notification dispatch gaps: Finding S4 (audit log for family revoke).
- R5 Missing transaction wrapping: Finding F5 (Serializable for cascade clamp).
- R6 Cascade delete orphans: N/A — no hard deletes introduced; only revocation via `revokedAt`.
- R7 E2E selector breakage: N/A — no E2E framework confirmed in this repo; only manual E2E instructions.
- R8 UI pattern inconsistency: Checked — plan reuses existing `tenant-session-policy-card.tsx` + `team-policy-settings.tsx` patterns.
- R9 Transaction boundary for fire-and-forget: Checked — no new fire-and-forget inside a tx is introduced.
- R10 Circular module dependency: Checked — new `session-timeout.ts` imports team-policy and prisma, same direction as existing.
- R11 Display group ≠ subscription group: N/A — no new audit groups in this plan aside from S4's action.
- R12 Enum/action group coverage gap: Finding S4 covers the new action.
- R13 Re-entrant dispatch loop: N/A — no event-delivery cascade.
- R14 DB role grant completeness: Checked — new columns on existing tables; `passwd_app` has table-level grants that cover new columns automatically for PostgreSQL. New ExtensionToken columns (`familyId`, `familyCreatedAt`) are covered by existing GRANT on extension_tokens. New index on `(familyId, revokedAt)` uses existing grants. No action needed.
- R15 Hardcoded env-specific values in migrations: Plan L161 explicitly calls this out. Good.
- R16 Dev/CI environment parity: Checked — integration tests use `src/__tests__/db-integration/helpers.ts` which seeds a real DB; no privileged-role side-effects relied upon.
- R17 Helper adoption coverage: Finding F6 addresses the unnamed cache helper.
- R18 Config allowlist/safelist synchronization: N/A — no new privileged-operation files added.
- R19 Test mock alignment with helper additions: Flagged implicitly by T-findings; the `session-timeout.ts` module will have mocks added in `auth-adapter.test.ts` that must match the real shape.
- R20 Multi-statement preservation in mechanical edits: N/A — all edits are human-driven per the plan.
- R21 Subagent completion vs verification: Plan mandates `npx vitest run` + `npx next build` + integration tests before commit. Good.
- R22 Perspective inversion for established helpers: Checked — `getStrictestSessionDuration` is being deleted (not duplicated); consumers enumerated.

### Security expert
- R1 Shared utility reimplementation: Checked.
- R2 Constants hardcoded: Checked.
- R3 Pattern propagation: Finding F1 (cookie claim) affects security posture — fixed by acknowledging server-side DB is authoritative.
- R4 Dispatch gaps: Finding S4.
- R5 Missing transactions: Finding F5 (cascade clamp serializable).
- R6 Cascade delete orphans: N/A.
- R7 E2E: N/A.
- R8 UI: N/A.
- R9 Fire-and-forget tx boundary: N/A.
- R10 Circular module: N/A.
- R11 Group leak: N/A.
- R12 Enum/action coverage: Finding S4.
- R13 Re-entrant loop: N/A (no webhook delivery change).
- R14 DB role grants: N/A (see functionality R14).
- R15 Hardcoded env values: N/A (plan explicit).
- R16 Dev/CI parity: Checked — integration tests run against real DB.
- R17 Helper adoption: N/A.
- R18 Allowlist sync: N/A.
- R19 Test mocks: N/A (delegated to Testing).
- R20 Mechanical edits: N/A.
- R21 Subagent verification: Checked.
- R22 Perspective inversion: Checked.
- RS1 Timing-safe comparison: N/A — no secret-equality comparisons introduced. Existing `hashToken` + DB `WHERE` lookup already used for extension tokens.
- RS2 Rate limiter on new routes: N/A — no new HTTP endpoint introduced (family expiry is a server-side check on existing refresh route, which already has `refreshLimiter`).
- RS3 Input validation at boundaries: Finding S3.

### Testing expert
- R1 Shared utility reimplementation: N/A.
- R2 Constants hardcoded: Plan step 1 adds validation constants; tests must import them (not re-hardcode).
- R3 Pattern propagation: Finding T1 (cookie test is wrong per F1).
- R4 Dispatch gaps: Finding S4 requires new audit test.
- R5 Missing transactions: Finding T5 (cascade-clamp concurrency test).
- R6 Cascade delete orphans: N/A.
- R7 E2E selector breakage: Checked — manual E2E steps reference semantic flows, not selectors.
- R8 UI pattern inconsistency: N/A.
- R9 Fire-and-forget tx: N/A.
- R10 Circular module: N/A.
- R11 Display vs subscription group: N/A.
- R12 Enum/action group coverage gap: Finding S4.
- R13 Re-entrant loop: N/A.
- R14 DB role grants: N/A.
- R15 Hardcoded env values: N/A.
- R16 Dev/CI parity: Finding T3 (migration backfill).
- R17 Helper adoption: N/A.
- R18 Allowlist sync: N/A.
- R19 Test mocks alignment: Finding T1, T2, T5 implicitly require mock updates.
- R20 Mechanical edits: N/A.
- R21 Subagent verification: N/A.
- R22 Perspective inversion: N/A.
- RT1 Mock-reality divergence: Finding T3 is the main guard.
- RT2 Testability verification: Checked — all recommended tests are feasible in vitest / vitest.integration.
- RT3 Shared constants in tests: Step 1 adds constants for tests to import — Finding T4 is the i18n analogue.

## Resolution Status (Round 1 → Round 2 input)

### [F1] Major: Cookie Max-Age claim incorrect — Resolved
- Action: Rewrote Non-functional cookie bullet and "Session cookie Max-Age" subsection to document the actual Auth.js DB-strategy model (cookie bound to static config; DB is authoritative).
- Modified: `docs/archive/review/unify-session-timeout-policy-plan.md` Non-functional bullet 4, Technical Approach > Auth.js adapter integration, "Session cookie Max-Age" section removed/subsumed.

### [F2] Major: updateSession expires formula wrong — Resolved
- Action: Rewrote the updateSession pseudocode to use `min(now + idle, createdAt + absolute)`.
- Modified: Technical Approach > Auth.js adapter integration (updateSession bullet).

### [F3] Minor: ALS mutation pattern clarification — Resolved
- Action: Added explicit "Implementation note (ALS mutation pattern)" block explaining the object-reference contract.
- Modified: Technical Approach > Session provenance.

### [F4] Major: Migration DDL ordering — Resolved
- Action: Replaced step 2 with per-table DDL blocks including the separate UPDATE-then-SET-NOT-NULL for the existing `sessionIdleTimeoutMinutes` column.
- Modified: Implementation Steps step 2.

### [F5] Major: Cascade clamp needs Serializable — Resolved
- Action: Step 6 now specifies Serializable isolation for cascade-clamp transaction. Scenario 6 updated.
- Modified: Implementation Steps step 6, Scenario 6.

### [F6] Minor: Unnamed cache helper — Resolved
- Action: Specified named cache and helpers `invalidateSessionTimeoutCache(userId)` and `invalidateSessionTimeoutCacheForTenant(tenantId)` owned by `src/lib/session-timeout.ts`.
- Modified: Cache Invalidation Contract.

### [F7] Minor: Family pruner TODO needs justification — Resolved
- Action: Added quantified worst case, likelihood, cost in Known risks; added index in migration step 2.
- Modified: Considerations > Known risks; Implementation Steps step 2 (index).

### [F8] Minor: "30s heartbeat" scenario wording — Resolved
- Action: Rewrote Scenario 1 to correct the updateAge semantics.
- Modified: Scenario 1.

### [S1] Major: Provider spoofing threat note — Resolved
- Action: Added explicit Security boundary block stating provider is server-controlled only with ASVS/NIST citation.
- Modified: Technical Approach > Session provenance.

### [S2] Major: Post-migration AAL3 degradation window — Resolved
- Action: Changed backfill from `"unknown"` to `NULL` (no cost/complexity difference, clearer intent). Documented the degradation window and NIST rationale explicitly.
- Modified: Technical Approach > Session provenance.

### [S3] Major: Team PATCH validation bounds — Resolved
- Action: Step 7 now enumerates all validation rules: null accepted, else integer ≥ 1 AND ≤ tenant value.
- Modified: Implementation Steps step 7.

### [S4] Minor: Family revocation audit logging — Resolved
- Action: Step 8 now registers `EXTENSION_TOKEN_FAMILY_REVOKED` with metadata, group membership, i18n keys, and tests.
- Modified: Implementation Steps step 8.

### [T1] Major: Wrong cookie E2E test — Resolved
- Action: Rewrote Manual/E2E test to verify DB `session.expires` and deletion-on-next-activity flow.
- Modified: Testing Strategy > Manual/E2E.

### [T2] Major: Absolute-boundary off-by-one test — Resolved
- Action: Added explicit boundary test cases to unit tests for auth-adapter.
- Modified: Testing Strategy > Unit.

### [T3] Major: Migration backfill integration test — Resolved
- Action: Added scenario (f) to integration test list covering NULL → 480 backfill, team copy, extension_tokens family backfill.
- Modified: Testing Strategy > Integration.

### [T4] Minor: i18n key parity test — Resolved
- Action: Added parity test requirement under step 7 and under Testing > Unit.
- Modified: Implementation Steps step 7; Testing Strategy > Unit.

### [T5] Minor: Cascade-clamp test — Resolved
- Action: Added scenario (g) to integration tests and a unit-level clamp test in step 6 route tests.
- Modified: Testing Strategy > Integration; Implementation Steps step 6.

---

## Round 2

### Changes from Previous Round
Plan updated per Round 1 fixes (F1-F8, S1-S4, T1-T5). Round 2 is inline verification + regression sweep.

### Round 2 Findings

**[F9] Major: Cache tenant-scoped invalidation needs tenantId stored per entry (new in round 2)**
- Evidence: Cache Invalidation Contract added `invalidateSessionTimeoutCacheForTenant(tenantId)` in Round 1 F6 fix but did not specify how tenantId is looked up on invalidation.
- Problem: If the cache stores only `{idle, absolute, expiresAt}` keyed by userId, tenant-scoped invalidation requires N DB queries to look up each user's tenantId — defeats the purpose.
- Fix: Cache entry stores `{idleMinutes, absoluteMinutes, tenantId, expiresAt}`. Bulk invalidation iterates Map and deletes matches in one pass.
- Status: Resolved in Round 2. Modified: Cache Invalidation Contract.

**[F10] Minor: Existing SESSION_IDLE_TIMEOUT_MIN reuse (new in round 2)**
- Evidence: Step 1 listed new validation constants but did not clarify whether existing `SESSION_IDLE_TIMEOUT_MIN`/MAX at common.ts:157-158 are reused or duplicated.
- Problem: Risk of duplicate constants with slightly different values.
- Fix: Step 1 now explicitly states reuse.
- Status: Resolved in Round 2. Modified: Implementation Steps step 1.

**[F11] Major: Orphan "Session cookie Max-Age" subsection contradicted the Round 1 fix (new in round 2)**
- Evidence: After F1 rewrite of Non-functional cookie semantics, the separate "Session cookie Max-Age" subsection at plan L115-117 still contained the wrong claim.
- Problem: Two contradictory passages in the plan.
- Fix: Deleted the orphan subsection. Updated `src/auth.ts` config guidance to 30d ceiling consistent with DB-authoritative model.
- Status: Resolved in Round 2.

**[F12] Minor: revokeExtensionTokenFamily signature needed userId/tenantId for audit (new in round 2)**
- Evidence: S4 added audit but did not specify helper signature.
- Problem: Without userId/tenantId, helper would need extra DB fetch to scope audit.
- Fix: Helper signature is now `revokeExtensionTokenFamily(familyId, userId, tenantId, reason)`.
- Status: Resolved in Round 2.

**[F13] Minor: Cascade clamp query scope unspecified (new in round 2)**
- Evidence: Scenario 6 / step 6 said "enumerate team_policies where the column exceeds" but no query.
- Problem: Implementation-time ambiguity.
- Fix: Step 6 now contains the explicit Prisma where-clause.
- Status: Resolved in Round 2.

**[F14] Minor: Scenario 3 "re-auth prompt" phrasing misleading (new in round 2)**
- Evidence: Scenario 3 said "The user sees a re-auth prompt after 15 min idle" — implies a client-side pre-warning, which doesn't exist.
- Fix: Rewrote to match Scenario 1's "on next HTTP activity" phrasing.
- Status: Resolved in Round 2.

### Recurring Issue Check (Round 2 — regression sweep)
All checks from Round 1 re-verified against the updated plan. No regressions detected. R3 (propagation): F11 caught one orphan passage; resolved. R12 (action groups): F12 clarified audit helper surface.

### Round 2 Resolution Summary
All Round 1 findings resolved. Round 2 found 6 new issues (2 Major / 4 Minor), all resolved inline. No Critical findings in either round. Termination check: **all findings resolved; exit review loop.**
