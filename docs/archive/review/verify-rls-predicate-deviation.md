# Coding Deviation Log: verify-rls-predicate

## Block 4: `RESET app.tenant_id` → `SET LOCAL app.tenant_id = nil-UUID`

**Plan said**: Block 4 of `scripts/rls-cross-tenant-verify.sql` would `RESET app.tenant_id` to neutralize the tenant-filter clause, then `SET LOCAL app.bypass_rls = 'on'` to admit all rows via the bypass branch.

**Implementation does**: `SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000'` (the nil UUID) instead of RESET.

**Why**: Postgres quirk discovered during empirical verification — once a custom GUC (`app.tenant_id`) has been SET (or `SET LOCAL`'d) in a session, subsequent calls to `current_setting('app.tenant_id', true)` return the empty string `''` rather than NULL — even after `RESET` or `DISCARD ALL`. The tenant_isolation policy evaluates `tenant_id = current_setting('app.tenant_id', true)::uuid`, which raises `invalid input syntax for type uuid: ""` BEFORE the OR-bypass clause can short-circuit. The error halts the verify file before any per-table count is computed.

**Net effect**: same semantic intent ("tenant filter neutralized; bypass clause exclusively drives visibility"). The nil UUID parses cleanly, matches no real tenant_id (real tenants use `…000A0` / `…000B0`), and lets the OR-bypass branch admit all rows. Block 4's `count = 2` (or 3 for `mcp_clients`) assertion semantics are preserved.

**Files affected**:
- `scripts/rls-cross-tenant-verify.sql` — Block 4 implementation uses nil-UUID
- `docs/archive/review/verify-rls-predicate-plan.md` — Block 4 description updated to match

**Verification**: empirical re-test against the local docker DB (`postgres:16-alpine`) shows the verify file now exits 0 against a correctly-seeded DB; the negative-test gate self-check passes all 6 cases including Case 4 (`[E-RLS-BYPASS]` fires correctly when the bypass clause is dropped from the throwaway policy).

---

## Seed: `SET app.bypass_rls = 'on'` for trigger bypass

**Plan said**: seed runs as `passwd_user` (SUPERUSER) which bypasses RLS.

**Implementation does**: also sets `SET app.bypass_rls = 'on'` at the top of the seed file.

**Why**: SUPERUSER bypasses RLS but does NOT bypass `BEFORE INSERT` triggers. 27 of the 53 tenant-scoped tables have an `enforce_tenant_id_from_context()` trigger that raises `tenant_id missing and app.tenant_id is not set` regardless of role unless `app.bypass_rls = 'on'` is set. The trigger explicitly short-circuits when this GUC is on. The seed file needs to bypass this trigger to insert rows directly with deterministic tenant_ids (without `SET LOCAL app.tenant_id` per insert).

**Files affected**: `scripts/rls-cross-tenant-seed.sql` (top of file).

---

## Verify SQL: `:'expected_tables'` → bridged via `SET app.expected_tables`

**Plan said**: Block 1 of the verify SQL reads `:'expected_tables'` directly inside DO blocks (per the literal SQL in plan §"Block 1 manifest parity").

**Implementation does**: bridges the psql variable to a session GUC at the top of the file (`SET app.expected_tables TO :'expected_tables';`), then DO blocks read it via `current_setting('app.expected_tables', true)`.

**Why**: PostgreSQL psql does NOT re-scan dollar-quoted string contents (the bodies of `DO $$ … $$` blocks) for `:'var'` substitution. Using `:'expected_tables'` directly inside a DO block raises `syntax error at or near ":"`. The GUC bridge preserves the plan's intent — the comma-separated list reaches the DO block via `current_setting()` instead of psql variable substitution. Behaviorally identical for the manifest-parity assertions.

**Files affected**: `scripts/rls-cross-tenant-verify.sql` (top of file + Block 1 ASSERT bodies).

---

## Seed: enum value corrections

**Plan said**: nothing specific about enum values.

**Implementation does**: uses correct enum values per the live schema:
- `DirectorySyncProvider`: `GOOGLE_WORKSPACE` (NOT `GOOGLE`)
- `NotificationType`: `SECURITY_ALERT` (no `INFO` value exists)
- `AuditAction`: `AUTH_LOGIN` (no `PASSWORD_VIEWED`)
- `audit_outbox.status`: `'SENT'` with `sent_at = NOW()` so the cleanup trigger guard (`status IN ('SENT','FAILED')`) permits cleanup DELETEs
- `audit_logs.actor_type`: `'SYSTEM'` to satisfy the `audit_logs_outbox_id_actor_type_check` constraint without needing a separate outbox→audit_log linkage

**Why**: discovered during seed-file authoring against the live schema; these are not deviations from the plan's intent (the plan didn't specify enum values), but they're recorded here for traceability.

**Files affected**: `scripts/rls-cross-tenant-seed.sql`.
