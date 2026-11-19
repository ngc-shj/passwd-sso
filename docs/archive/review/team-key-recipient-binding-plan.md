# Plan: team-key-recipient-binding (issue #1076)

Review rounds and finding dispositions: `team-key-recipient-binding-review.md`. Finding IDs cited
below: `FN*` functionality, `S*` security, `T*` testing (round 1).

## Project context

- Type: `web app` (Next.js 16 + Prisma 7 + PostgreSQL 16), with browser-side E2E crypto.
- Test infrastructure: `unit + integration + E2E + CI/CD` (vitest unit, real-DB integration under
  `src/__tests__/db-integration`, Playwright E2E, GitHub Actions with a fresh-DB integration job).
- Verification environment constraints:
  - **VE1** — the worktree database `passwd_sso_wt_1060` (enforce-mode RLS, own roles) is the local
    real-DB target. It grants CONNECT to the retired `passwd_dcr_cleanup_worker`, so `audit-db-grants`
    / `retire-dcr-cleanup-worker` / `revoke-public-connect` T3 fail locally for environment reasons
    only (#1060 deviation log D4). CI runs them clean.
  - **VE2** — no MinIO locally: the S3-backed integration files fail locally; CI provides MinIO.
  - **VE3** — the red-proof runner clones the worktree database, which carries residue; the new
    integration file must also pass once on a freshly migrated, empty database (#1060 D15: an
    InitPlan made a cell vacuous on CI's empty table).
  - No path is blocked-deferred: every contract is `verifiable-local` and `verifiable-CI`. iOS, the
    extension and the CLI do not write team keys (C7), so no device build is needed.

## Objective

Close #1076's honest-client race: a wrapped team key is written for a recipient only if the
fingerprint of the public key **the distributing client says it wrapped to** equals the fingerprint
of the recipient's current `users.ecdh_public_key`, and the recipient's key cannot change while any
wrapped key or distributed flag for them survives. A vault reset (or reset and set-up again) between
a client reading the key and the server committing the wrapped key then makes the write fail instead
of leaving the member `keyDistributed = true` with a key wrapped to a retired key pair.

Not in the objective (S3): the server cannot see what a ciphertext was wrapped to. A malicious
distributor — who already holds the team key — can claim the right fingerprint and wrap to anything,
wedging the member exactly as garbage ciphertext can today. Binding the wrap cryptographically is SC1.

## Requirements

- **FR1** Every insert or rewrite of a wrapped team key carries the fingerprint the client wrapped
  to; the database refuses it unless it equals the fingerprint of the recipient's current key.
- **FR2** A non-NULL key cannot change while the user has a `team_member_keys` row or a
  `team_members` row with `key_distributed = true` (S1; restricted to a non-NULL OLD key in round 2 —
  S2-F1/FN2-F1/T2-N3). Together with FR1 this makes "a surviving key row was checked against the key
  the user still holds" a database invariant, independent of which code path retires the key. The
  flag half holds because every writer that sets `key_distributed = true` writes a key row in the same
  transaction and so holds the user's row `FOR KEY SHARE` (S2-F2; member set in C7).
- **FR2a** Rows already bound to a NULL key (pre-fix race residue: a key row or `key_distributed =
  true` for a user with no key) are repaired once by the migration (C9), so those users are pending
  again and get a fresh distribution after their next vault setup.
- **FR3** The comparison and the key change are serialised: a key change that commits before the
  write is seen by the comparison; a key change that starts while a writer holds the recipient's row
  waits for that writer and then sees its row (and is refused by FR2).
- **FR4** The writers answer a refused comparison with HTTP 409 and a dedicated code, so the client
  refetches the key and re-wraps.
- **NFR1** No new lock-order edge on the writer side: the comparison locks the recipient's `users`
  row `FOR KEY SHARE`, the mode and point the existing FK check on `team_member_keys.user_id`
  already uses (teams → users → team_members, `team-key-rotation-lock.ts`).
- **NFR2** No cross-tenant read from route code: a cross-tenant guest's `users` row is invisible
  under team-tenant RLS, and `withBypassRls` cannot nest inside `withTeamTenantRls`, so the checks
  live in the database.

## Technical approach

### Schema-enforced, in two triggers

The application alternative (each writer reads the recipient's key in its transaction) is per-writer
and unavailable (NFR2). Both triggers follow `departed_member_guard()`
(`prisma/migrations/20261117000100_departed_member_guard/migration.sql`): `SECURITY INVOKER`,
`SET search_path = public, pg_temp`, schema-qualified relation names (S2: without the pin the app
role can shadow `users` with a temp table — verified by S), save/scope/restore of
`app.bypass_rls` / `app.bypass_tables` / `app.bypass_purpose`, SQLSTATE `23514` with message
`TEAM_KEY_RECIPIENT_GUARD:<arm>:` carrying only row ids.

### Fingerprint

Lowercase hex SHA-256 of the UTF-8 bytes of the **exact string** in `users.ecdh_public_key`. No JWK
canonicalisation: every endpoint that serves the key (`pending-key-distributions`,
`rotate-key/data`, `vault/unlock/data`) returns the stored string unchanged and the client's own ref
holds the string it sent at setup (verified by FN), so the client hashes the string it imported and
the database hashes the string it stores. A differently spelled JWK for the same key can only cause a
false refusal (fail closed). SQL: `encode(sha256(convert_to(ecdh_public_key, 'UTF8')), 'hex')`
(`server_encoding` is UTF8).

### Serialisation

- **Writer side** — C2 reads the recipient's row `FOR KEY SHARE` (NFR1).
- **Key-change side** — a plain `UPDATE users SET ecdh_public_key` takes `FOR NO KEY UPDATE`, which
  `FOR KEY SHARE` does not block; on retiring a key (`P → NULL`) C3 therefore upgrades its own row
  to `FOR UPDATE` before checking FR2. Under READ COMMITTED each statement in the plpgsql body takes a
  fresh snapshot, so after waiting for a writer the FR2 read sees the writer's committed key row and
  refuses. The upgrade happens inside the UPDATE (after its `FOR NO KEY UPDATE`), so a transaction
  that holds KEY SHARE on the row and then updates the same row could deadlock with it (FN2-F2,
  reproduced on scratch tables). The only legitimate `P → NULL` writer, vault reset, takes `users
  FOR UPDATE` first, so its upgrade is a no-op; vault setup (`NULL → P`) takes no upgrade at all.
- **Isolation** — Prisma interactive transactions default to READ COMMITTED. Under REPEATABLE READ
  or SERIALIZABLE a `FOR KEY SHARE` that waited on a concurrently updated row fails with `40001`,
  which fails closed (FN8: #1060's guard checks the level only on its activation and AFTER branches,
  so that is not the argument).
- **Probe** (`docs/archive/review/team-key-recipient-binding-probe.mjs`, run as
  `node docs/archive/review/team-key-recipient-binding-probe.mjs "$MIGRATION_DATABASE_URL"`,
  scratch table; A holds `FOR KEY SHARE`, B changes the key):

  ```
  key change, trigger disabled: proceeded while KEY SHARE held
  key change, trigger upgrades to FOR UPDATE: BLOCKED (sessions waiting on a lock: 1)
  ```

  The authoritative evidence is the integration race cells (Testing, T1).

## Contracts

### C1 — `team_member_keys.recipient_key_fingerprint`

- `varchar(64) NULL` with `CHECK (recipient_key_fingerprint IS NULL OR recipient_key_fingerprint ~ '^[0-9a-f]{64}$')`;
  Prisma `recipientKeyFingerprint String? @map("recipient_key_fingerprint") @db.VarChar(64)`.
- Existing rows stay `NULL` (legacy: what they were wrapped to is unknown; a backfill from the
  current key would assert a binding nobody checked).
- Invariant (via C2): no wrap is inserted or rewritten without a fingerprint (FN10).

### C2 — `public.team_key_recipient_guard()` on `team_member_keys`

- `BEFORE INSERT OR UPDATE` row trigger `trg_team_member_keys_recipient_guard`.
- Judged: every INSERT; an UPDATE in which any of `user_id`, `encrypted_team_key`, `team_key_iv`,
  `team_key_auth_tag`, `ephemeral_public_key`, `hkdf_salt`, `wrap_version`, `key_version`,
  `recipient_key_fingerprint` is distinct from OLD. Other UPDATEs (e.g. `updated_at`) are not key
  writes.
- Arms:
  - `fingerprint_missing` — NEW fingerprint NULL;
  - `fingerprint_rebind` — an UPDATE that changes the fingerprint while every wrap column and
    `user_id`/`key_version` is unchanged (S4: attaching a fingerprint to an existing wrap asserts a
    binding nobody checked);
  - `recipient_no_key` — the recipient's `ecdh_public_key` is NULL or the row is not found;
  - `recipient_key_changed` — fingerprints differ, compared with `IS DISTINCT FROM` after the
    `recipient_no_key` check has handled NULL (T3-P1 pins the operator).
- Reads `public.users` for `NEW.user_id` `FOR KEY SHARE` under a scoped bypass
  (`app.bypass_tables = 'users'`, purpose `team_key_recipient_guard`), restored before return.
- Inherited fingerprint on a wrap rewrite (S4): an UPDATE that rewrites the wrap but carries OLD's
  fingerprint is compared like any other. It is safe because of FR2: while the row exists the user's
  key cannot have changed, so a fingerprint equal to the current key names the key the user has held
  since the row was written. Writers still send the fingerprint in the update branch (C4).
- Trigger order (FN6): same-event BEFORE triggers fire by name —
  `trg_enforce_tenant_id_team_member_keys`, `trg_team_member_keys_departed_member_guard`, then this
  one. A recipient who both departed and reset gets the departed guard's `key_inactive` first; that is
  intended (the membership is the stronger refusal), and every route tests `departedMemberGuardArm`
  before the new parser. Distinct prefixes keep the parsers apart.
- Control class: **enforceable boundary** for every role that is not the table owner (the app role
  cannot `DISABLE TRIGGER`; `session_replication_role` is refused by `audit-db-grants` since #1074;
  the search_path pin closes temp-table shadowing). Adjudication authority: PostgreSQL's read of the
  stored string under the row lock, against the client-claimed fingerprint (S3).
- Forbidden patterns:
  - pattern: `SECURITY DEFINER` in the new migration — reason: invoker + scoped bypass is the
    reviewed pattern.
  - pattern: `FOR (NO KEY )?UPDATE|FOR SHARE` inside `team_key_recipient_guard` — reason: NFR1.
  - pattern: a `CREATE FUNCTION` in the new migration without `SET search_path` — reason: S2.
- Acceptance: each arm refuses with `23514` and its token; allow cases: matching fingerprint (same
  tenant, and a cross-tenant guest recipient — T4a), a wrap-untouched UPDATE of a legacy NULL row, a
  DELETE.

### C3 — `public.users_ecdh_key_guard()` on `users`

- `BEFORE UPDATE` row trigger `trg_users_ecdh_key_guard` (plain `BEFORE UPDATE`, value test inside —
  S5a: a column-list trigger misses a change made by another BEFORE trigger).
- When `NEW.ecdh_public_key IS DISTINCT FROM OLD.ecdh_public_key`:
  1. both non-NULL → refuse `ecdh_key_overwrite` (no legitimate `P → P'`; a racing second vault setup);
  2. OLD NULL (`NULL → P`, vault setup) → allow, no lock, no read: no wrap can be bound to a NULL
     key (C2 refuses it), so there is nothing to protect, and residue from before this change is
     repaired by C9 instead of wedging setup (S2-F1/FN2-F1/T2-N3);
  3. OLD non-NULL, NEW NULL (`P → NULL`): take `SELECT 1 FROM public.users WHERE id = NEW.id FOR
     UPDATE` under a scoped bypass and raise if `NOT FOUND` (S5b); then refuse
     `ecdh_key_change_with_keys` if a `team_member_keys` row exists for `NEW.id` or a
     `team_members` row for `NEW.id` has `key_distributed = true` (S1/FR2), read under the same
     scoped bypass (`app.bypass_tables = 'users,team_members,team_member_keys'`, purpose
     `users_ecdh_key_guard`), restored before return.
- When the value is unchanged: nothing — no lock, no read (no contention on ordinary `users` updates).
- Legitimate writers pass: vault setup is `NULL → P`; vault reset (`vault-reset.ts`) deletes the
  user's `team_member_keys` and sets `key_distributed = false` with filters on `userId` only, under
  `VAULT_RESET_EXECUTE` (which grants `teamMember` and `teamMemberKey` across tenants), **before**
  nulling the key, all after its explicit `users FOR UPDATE` — so C3 reads zero rows (FN2-F3: the
  tenant-scoped reset's outside-tenant count deliberately excludes team rows, so it is not the reason).
- Vault setup mapping: setup's `vaultSetupAt` check is outside its write (pre-existing TOCTOU); a
  racing second setup now fails on `ecdh_key_overwrite`, mapped to `VAULT_ALREADY_SETUP` (409) in
  `src/app/api/vault/setup/route.ts`. Its `prisma.$transaction([...])` array rejects with the adapter
  error, which the parser reads (T5).
- Control class: **enforceable boundary** (as C2). Adjudication authority: OLD/NEW values and the
  rows read after the lock.
- Acceptance: `P → P'` refused; `P → NULL` with a key row refused and with only a distributed flag
  refused; `NULL → P` allowed (also for a user holding residue flags); reset's `P → NULL` allowed;
  `SET ecdh_public_key = ecdh_public_key` and an unrelated column update allowed without blocking on
  a `FOR KEY SHARE` holder.
- Residue (S5 of round 1): BEFORE triggers fire by name; the only other BEFORE UPDATE trigger on
  `users` (`trg_enforce_tenant_id_users`) sorts first and writes only `tenant_id`. A future trigger
  sorting after this one that rewrites `ecdh_public_key` would bypass it — noted in the migration
  header.

### C9 — One-time residue repair (migration data step)

- In the same migration, after the triggers, in a `DO $$ … $$` body that saves `app.bypass_*`, sets
  `app.bypass_rls = 'on'`, `app.bypass_tables = 'users,team_members,team_member_keys'` and a purpose,
  runs the two statements and restores (the pattern of
  `20261117000000_audit_delivery_target_creator`): for every user with `ecdh_public_key IS NULL`,
  delete their `team_member_keys` rows and set `key_distributed = false` on their `team_members`
  rows; `RAISE NOTICE` the two counts (no ids). Without the bypass the three FORCE-RLS tables are
  invisible to the RDS NOSUPERUSER NOBYPASSRLS owner and the repair is a silent no-op (S3-N1/FN3-F1).
  The block sits between `-- BEGIN BACKFILL team_key_residue` / `-- END BACKFILL team_key_residue`
  markers and also saves, sets (nil UUID) and restores `app.tenant_id`, as
  `20261116200000_revoke_departed_member_credential_residue` does.
- Placement (FN3-F2): after `CREATE TRIGGER … ON team_member_keys`, whose SHARE ROW EXCLUSIVE lock is
  held to the migration's commit — it waits for any old-instance transaction that already wrote a key
  row, so the repair (READ COMMITTED) sees that write, and blocks new key writes until commit, after
  which C2 refuses them. Run before the triggers, residue committed in between would be missed. The
  migration header says so.
- Counts (FN3-F3): `prisma migrate deploy` does not print NOTICEs; the counts reach the server log at
  `log_min_messages <= notice` or a psql run. The PR's deployment notes carry a read-only count query
  to run before and after.
- Why it is safe (R31): the only `P → NULL` writer, vault reset, erases the encrypted private key in
  the same UPDATE, so a residue wrap targets a key pair the server erased; no key the user holds can
  open it (vault rotate-key rewrites only the private key and never touches a NULL public key's
  row's wraps — S3-N2). The rows only block redistribution (`KEY_ALREADY_DISTRIBUTED`) and, for a
  flagged member with no key, every rotation of their team (`missingKeyFor`). After the repair the member is pending and the next
  distribution after their vault setup wraps to their new key.
- Completeness across the rollout window: after `migrate`, C2 refuses every fingerprint-less insert
  from old instances, and the flag is only set behind a key write (FR2), so no new residue arrives.
- Users with a non-NULL key whose rows were bound to an earlier key (reset **and** set up before this
  change) cannot be detected (fingerprint NULL) — SC2.
- Acceptance: a seeded residue user (NULL key, key row, `key_distributed = true`) has neither after
  the migration's repair statement runs; a user with a key is untouched. Tested by running the repair
  block (read with the existing `readBackfillBlock`, `helpers.ts`) in an integration cell **as a
  NOSUPERUSER NOBYPASSRLS role**, as the existing residue cells do, with the `gucSentinels` check that
  the settings are restored — so a missing or narrowed bypass shows as residue still present.

### C4 — Request field `recipientKeyFingerprint`

- `teamMemberKeySchema` (`src/lib/validations/team.ts`) gains
  `recipientKeyFingerprint: z.string().regex(/^[0-9a-f]{64}$/)` (required). It is shared by the
  confirm-key body, rotate-key `memberKeys[]` (`.merge`), and team creation's `teamMemberKey`.
- Writers pass it: confirm-key `upsert` create **and** update data; rotate-key `createMany` data;
  teams POST nested `memberKeys.create` (input type `TeamMemberKeyUncheckedCreateWithoutTeamInput`;
  the other two use the unchecked create/update and `TeamMemberKeyCreateManyInput` shapes — FN
  verified the field fits each).
- Consumer-flow walkthrough (request shape; consumers are the server and C2):
  - confirm-key (`src/app/api/teams/[teamId]/members/[memberId]/confirm-key/route.ts`) reads
    `{ wrap fields, keyVersion, recipientKeyFingerprint }` and writes the fingerprint into both
    upsert branches;
  - rotate-key (`src/app/api/teams/[teamId]/rotate-key/route.ts`) reads `memberKeys[].{ userId, wrap,
    recipientKeyFingerprint }` into `createMany`;
  - teams POST (`src/app/api/teams/route.ts`) reads `teamMemberKey.{ wrap, recipientKeyFingerprint }`
    into the nested create;
  - C2 reads `{ user_id, recipient_key_fingerprint }` of the new row and derives the comparison from
    `users.ecdh_public_key` alone.
- Response shapes are unchanged; nothing reads the fingerprint back.
- Client transition: a browser holding the previous bundle gets 400 `VALIDATION_ERROR` — shown as
  "members changed" on rotation and the generic validation message on creation; distribution
  retries silently (FN7). Accepted: pre-1.0, the web app is the only writer and ships in the same
  deploy; a reload fixes it.

### C5 — Error mapping `TEAM_KEY_RECIPIENT_CHANGED`

- `API_ERROR.TEAM_KEY_RECIPIENT_CHANGED` (409) in `src/lib/http/api-error-codes.ts` (code, status and
  i18n maps) and `messages/{en,ja}/ApiErrors.json` (FN5). The user-facing text names no internal term
  (no "ECDH", "fingerprint") — e.g. "A member's vault changed while the key was being shared. Try
  again."
- One parser: generalise `departedMemberGuardArm` (`src/lib/team/departed-member-guard.ts`) into a
  prefix-parameterised helper both guards use (R1); the existing export keeps its behaviour.
- Mapping, after the existing `departedMemberGuardArm` checks:
  - confirm-key, rotate-key, teams POST: `recipient_key_changed` / `recipient_no_key` → 409
    `TEAM_KEY_RECIPIENT_CHANGED`; `fingerprint_missing` / `fingerprint_rebind` are unreachable through
    the schema and rethrown (500);
  - rotate-key refuses the **whole** rotation (one transaction requiring a key for every key-holding
    member). Reached only when the member reset, set up again and was redistributed between
    `rotate-key/data` and the POST; a reset alone is refused earlier by the existing
    `keyDistributed` member check (400), and `recipient_no_key` cannot occur there (FN9);
  - vault setup: `ecdh_key_overwrite` → `VAULT_ALREADY_SETUP`;
  - `ecdh_key_change_with_keys` is unreachable from routes (only vault reset retires a key, and it
    clears the rows first) and is rethrown (S2-F3).
- confirm-key keeps its out-of-transaction `VAULT_NOT_READY` pre-check as an early answer; the
  trigger is the only adjudicator (no second comparison in route code).
- Client: the rotation button's existing default arm (`apiErrorToI18nKey` → `tApi`) shows the new
  `ApiErrors` text, so no dedicated toast (FN7); auto-distribution skips and the next poll refetches;
  creation shows the mapped API error.

### C6 — Client fingerprint

- New export `recipientKeyFingerprint(publicKeyJwk: string): Promise<string>` in
  `src/lib/crypto/crypto-team.ts` (`crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))`
  → lowercase hex). `createTeamKeyEscrow` returns it, computed over the same string it imports.
- Callers send it: `src/lib/team/team-vault-core.tsx` (auto-distribution → confirm-key),
  `src/components/team/security/team-rotate-key-button.tsx`,
  `src/components/team/management/team-create-dialog.tsx`.

### C7 — Member sets (R42)

Derivations (zsh-safe quoting):

- **`team_member_keys` writers**: `grep -rnE "teamMemberKey\.(create|upsert|createMany|update|updateMany)|memberKeys:\s*\{|INSERT INTO\s+\"?team_member_keys|UPDATE\s+\"?team_member_keys" src scripts --include='*.ts' --include='*.mjs' --include='*.sql'`
  minus tests → confirm-key `upsert`, rotate-key `createMany`, teams POST nested create, and the CI
  seed `scripts/rls-cross-tenant-seed.sql`. Deleters (vault reset, retention prune, cascades) are not
  judged. The issue's fourth item, `/api/teams/[teamId]/member-key`, is GET-only (FN3; the CLAUDE.md
  table's "GET, POST" is stale and is corrected in this change).
- **`users.ecdh_public_key` writers**: `grep -rnE "ecdh_public_key|ecdhPublicKey\s*:" src scripts e2e prisma --include='*.ts' --include='*.mjs' --include='*.sql'`,
  each hit classified in Phase 2 as `NULL → P` / `P → NULL` / read. Known: vault setup (`NULL → P`),
  `vault-reset.ts` (`P → NULL`; reached from `/api/vault/reset`, `/api/vault/admin-reset`, tenant
  `reset-vault` and its approve route), integration `setEcdhKey`-style raw UPDATEs on fresh users
  (`NULL → P`), and `e2e/helpers/db.ts` `seedUser`, whose `ON CONFLICT … SET ecdh_public_key =
  EXCLUDED…` is a `P → P'` path that C3 refuses. `seedUser` fails loudly when the user already
  exists with a key (cleanup is expected to have removed it) rather than keeping the public key while
  rewriting the private key, which would leave a mismatched pair (FN2/S6/T12/T2-N5).
- **Writers of `key_distributed = true`** (FR2's flag half): `grep -rnE "keyDistributed:\s*true|key_distributed\s*=\s*true" src scripts prisma --include='*.ts' --include='*.mjs' --include='*.sql'`
  minus tests and `where` filters → confirm-key's CAS (after the C2-judged upsert in the same
  transaction) and teams POST (nested key create); rotate-key only clears the flag. Each holds the user's row `FOR KEY SHARE` before setting the flag. Phase 2 re-derives and records it.
- **Client wrappers**: `grep -rn "createTeamKeyEscrow(" src extension/src cli/src ios` → the three
  web call sites (C6). The extension, iOS and CLI only unwrap.
- **Test and seed adopters** — two classes (T6):
  1. *Key-row seeders* (`grep -rlnE "INSERT INTO\s+\"?team_member_keys|teamMemberKey\.(create|createMany|upsert)" src/__tests__ e2e scripts`):
     the integration files that insert key rows, `user-owned-rows-seed.ts`, `e2e/helpers/team-rekey.ts`
     (and its `team-rekey.test.ts` text assertion), `scripts/rls-cross-tenant-seed.sql` (whose users
     also need a key set first), and #1074 red-proof patch `R1z…`.
  2. *Route-body builders* (`grep -rlnE "encryptedTeamKey" src/__tests__/db-integration`): files that
     POST confirm-key / rotate-key / teams bodies; each must send the recipient's real fingerprint and
     each recipient must hold a key.
  One shared integration helper owns both: it sets the recipient's key only when NULL and returns the
  stored string (idempotent — a second call must not hit `ecdh_key_overwrite`; `NULL → P` is allowed
  regardless of the user's memberships after the round-2 C3 change), and computes the
  fingerprint with the production `recipientKeyFingerprint` (T2). Files that only DELETE key rows
  (`e2e/helpers/db.ts`, `helpers.ts`) or name the table in prose are not adopters; Phase 2 records the
  per-file classification table in the deviation log.
- #1074 red-proof rows that patch the confirm-key / rotate-key sources (R1, R1y, R1z, R3) are
  refreshed and re-run (T6).

### C8 — Gates, grants, RLS

- `scripts/rls-cross-tenant-verify.sql`: allowlist both functions with exact-table assertions
  (`team_key_recipient_guard` → `users`; `users_ecdh_key_guard` → `users,team_members,team_member_keys`),
  and add an assertion that every function whose body calls `set_config('app.bypass…` carries a
  `search_path` in `proconfig` (S2; readers such as `enforce_tenant_id_from_context` only read the
  setting and are not in the class — round-2 security R34).
- `scripts/checks/check-bypass-rls.mjs`: its `FUNCTION_RULE_ALLOWLIST` covers only files that create
  routines **outside** migrations (FN4) — entries are needed for any race cell or red-proof runner of
  this change that installs a routine, not for the migration.
- `scripts/checks/db-grants-manifest.json`: regenerate and diff. R14: `FOR KEY SHARE` / `FOR UPDATE`
  need `UPDATE` on `users`; `passwd_app` has it and is the only non-owner role that writes
  `team_member_keys` or updates `users` (FN/S verified); the new column inherits table-level grants.
- AST gates (`check-team-rotation-input-lock` and siblings): re-run; no rule change expected.

## Testing strategy

New file `src/__tests__/db-integration/team-key-recipient-binding.integration.test.ts` (app role,
real DB). Every refusal asserts the token **and** the absence of the write (RT8); every guard has a
paired allow case (RT10).

- **C2 arms**: each of the four arms refused; allows: matching fingerprint (same tenant), matching
  fingerprint for a **cross-tenant guest** recipient (T4a — fails if the scoped bypass is removed),
  a DELETE, a wrap-untouched UPDATE of a legacy NULL row (seeded via `writeRefusedState`,
  `helpers.ts` — T4f).
- **C2 column list** (T4d): `it.each` over the nine judged columns on a row whose recipient's key no
  longer matches — a state FR2 forbids, so the fixture changes the user's key through
  `writeRefusedState` (`helpers.ts`, `session_replication_role = replica`) (T2-N4). Expected tokens:
  `recipient_key_changed` for the wrap columns and `key_version`; `fingerprint_rebind` for
  `recipient_key_fingerprint` alone; for `user_id`, a re-point to a user whose key does not match →
  `recipient_key_changed`. One non-judged column is allowed. The confirm-key "row with an old
  fingerprint" cell is seeded the same way.
- **Bypass restore** (T4b): after a guarded INSERT and after a C3-checked `P → NULL` UPDATE of a
  user with no keys (the only C3 path that sets the bypass — T3-P1), the three
  `app.bypass_*` settings in the same transaction equal their prior values and a following `users`
  read is still RLS-filtered.
- **search_path** (S2): the app role creates `TEMP TABLE users` holding a matching key; the write is
  still refused.
- **C3**: `P → P'` refused; `P → NULL` with a key row refused and with only a `key_distributed = true`
  member refused; `NULL → P` allowed, including for a user who holds a `key_distributed = true`
  membership; `executeVaultReset` on a user with keys in two tenants passes (unscoped) — reset still
  works end to end.
- **C9** (T3-P3): the `BEGIN/END BACKFILL team_key_residue` block, read with `readBackfillBlock`
  (exactly one marker pair; its red-proof override generalised to a per-block variable), executed as
  the app role (NOSUPERUSER NOBYPASSRLS) inside a rolled-back transaction as
  `session-revocation-residue-migration.integration.test.ts` does, so the all-tenant sweep leaves no
  side effects. Fixtures: a residue user (NULL key, key row, `key_distributed = true`), a residue
  user whose membership is ended — both seeded via `writeRefusedState`, since C2/C3 refuse that state
  (T4-M1) — and a keyed user with a key row
  and `key_distributed = true`. Assertions on seeded ids only: both residue users repaired, the keyed
  user untouched, `gucSentinels` restored.
- **Trigger order** (round-1 FN6, T2-N2, T3-P2): a raw app-role INSERT of a key row for a recipient
  whose team membership is ended (`deactivated_at` set — the state that yields `key_inactive`; a
  tenant-departed leftover would yield `key_leftover`, T4-M2) and whose fingerprint also mismatches is refused with `DEPARTED_MEMBER_GUARD:key_inactive`,
  not the new token. (Through confirm-key the route refuses a departed recipient itself before any
  write, so a route cell cannot see the order.)
- **No-added-lock** (T9): with A holding `FOR KEY SHARE`, B
  under `lock_timeout` runs `SET name = …` and `SET ecdh_public_key = ecdh_public_key` (both complete)
  and, as the positive control, `SET ecdh_public_key = NULL` (hits `55P03`).
- **Races** (T1, RT4), two connections, waits witnessed the #1074 way (`pg_blocking_pids` names the
  holder, the waiting lock is `tuple`/`transactionid`, the waiting statement is checked, waiter under
  `lock_timeout`), holders released in `finally`:
  - *raw key change vs guarded insert, writer first*: A inserts a matching key row (holds KEY SHARE);
    B (app role, no explicit lock) runs `UPDATE users SET ecdh_public_key = NULL` — B waits, then is
    refused `ecdh_key_change_with_keys` after A commits. Mutation "drop C3's `FOR UPDATE`" → B does
    not wait, commits, A's row survives bound to a retired key → red.
  - *key change first*: B nulls (no key rows) and holds; A's guarded insert waits on KEY SHARE, then
    is refused `recipient_no_key`. Mutation "drop C2's `FOR KEY SHARE`" → A reads the old key and
    commits → red.
  - The setup race cell of round 0 is dropped (T1: its outcome does not depend on any lock).
- **Twin vector** (T2, RT9): a fixed JWK-shaped string containing a non-ASCII character is written to
  `users.ecdh_public_key`; a key row with the fingerprint from the production JS
  `recipientKeyFingerprint` is accepted; the same with one nibble flipped is refused. A unit test pins
  the same vector's hex.
- **Endpoint round trip** (T3, R40): for confirm-key and rotation, GET the real serving endpoint
  (`pending-key-distributions`, `rotate-key/data`) through its route handler, take `ecdhPublicKey`
  from the JSON, fingerprint it with the production function, POST the real writer route → success,
  and the stored fingerprint equals the trigger's view.
- **Writer routes** (RT8, T8): each of confirm-key, rotate-key and teams POST with a mismatching
  fingerprint → 409 `TEAM_KEY_RECIPIENT_CHANGED`:
  - confirm-key: no key row, `keyDistributed` still false; the **upsert update branch** both ways
    (over a legacy NULL row and over a row with an old fingerprint — T4c);
  - rotate-key: two members, mismatch on the non-first; `team_key_version` unchanged, no new key row
    for any member, entries not re-wrapped, no audit row; the sequence is reset → set up →
    redistribute between data and POST (FN9);
  - teams POST: no `teams` / `team_members` row.
- **Vault setup** (T5): drive the real `src/app/api/vault/setup/route.ts` into `ecdh_key_overwrite`
  (seed a user with a key but `vault_setup_at` NULL so the pre-check passes) → 409
  `VAULT_ALREADY_SETUP`, no `users` column changed.
- **Unit**: schema (field required, format); the generalised guard-arm parser with a fixture in the
  real nested adapter shape (`meta.driverAdapterError.cause`, T5); route mappings incl. precedence
  after `departedMemberGuardArm` and rethrow of the unreachable arms; `recipientKeyFingerprint` vector;
  caller tests whose escrow double computes the fingerprint from the JWK argument it receives (T3,
  RT1).
- **Red-proof** (T7) — rows on a scratch clone, verdict as in #1074 (base green, listed cells red with
  their token, no unlisted reds), reusing the #1074 runner's mechanism with a separate rows directory.
  Each row lists the cells it **must** turn red (with the failing assertion); a dry run in Phase 2
  then records any further red cell as a `+` collateral line with a one-line reason, as the #1074
  runner supports — the exact collateral set is an execution output, not a plan decision (T3-P1).
  Required cells:
  1 `fingerprint_missing` removed → its refusal cell; 2 `recipient_no_key` removed → its refusal cell
  and the key-change-first race (token); 3 `recipient_key_changed` removed → its refusal cell;
  4 `fingerprint_rebind` removed → its refusal cell; 5 comparison inverted → the match allow cell;
  6 C2 `FOR KEY SHARE` removed → key-change-first race at its **outcome** assertion (the FK check still
  waits, so the witness passes); 7 C3 overwrite arm removed → `P → P'` cell and the setup-route cell;
  8 C3 `FOR UPDATE` removed → both race cells and the no-added-lock positive control; 9 C3
  keys/distributed check removed → writer-first race, `P → NULL` with a key row, `P → NULL` with a
  flag; 10 C2 column list minus one column → that column's `it.each` case; 11a C2 bypass not
  restored, 11b C3 bypass not restored → the bypass-restore cell's matching half; 13b pin removed
  **and** names unqualified → the TEMP-table cell; 14–16 each writer mapping removed → that route's
  409 cell; 17 setup mapping removed → setup-route cell; 18 fingerprint omitted from the upsert update
  branch → the update-branch allow cell over a legacy NULL row (refused `fingerprint_missing`); 19 C2
  trigger renamed to sort before the departed guard → the trigger-order cell; 20 C9 block body emptied
  (markers kept) → the C9 residue assertions; 20b C9 `ecdh_public_key IS NULL` predicate dropped →
  the C9 keyed-user-untouched assertion; 21 C9 bypass grant dropped → the C9 residue assertions;
  22 C9 restore removed → the C9 `gucSentinels` check.
  Confirm-key's update-branch cells: over a legacy NULL row with the current fingerprint → allow;
  over a row with an old fingerprint (seeded via `writeRefusedState`) and a request carrying the
  current matching fingerprint → allow (row 18 also reds it: the row then inherits the old one).
  Rows 12 (bypass tables widened) and 13a (pin removed) are judged by `scripts/rls-cross-tenant-verify.sql`,
  outside the vitest runner: `psql -f` on the unmutated scratch clone is green, on the mutated clone
  it fails with the named assertion message; both outputs go into the deviation log (T3-P4).
- **Adopters**: full `npm run test:integration` after the shared helper lands, base vs final by cell;
  the new file also once on a freshly migrated empty database (VE3). Fixture cleanup is registered by
  the helper per tenant (T11). E2E team specs stay green with the real client.

## Considerations & constraints

- **Rolling deploy window (FN1)**: `migrate` runs before the app instances roll, so until every
  instance runs this release, old instances' team-key writes carry no fingerprint and are refused
  (`fingerprint_missing`) — a 500 on team creation, rotation and distribution for the rollout's
  length (compose: the app restart after `migrate`; ECS: the rolling update). It fails closed, writes
  nothing, and the client retries (distribution on its next poll; creation and rotation by the user).
  A failed rotation also consumes a `teamRotateKeyFailureLimiter` slot, so an admin retrying through
  the window can be rate-limited briefly afterwards. The alternative (FN2-F4): a split release would
  accept NULL-fingerprint writes for one release from old instances and raw SQL (release N's own
  writers send the field). Accepted for the rollout window; stated in the PR's deployment notes.
- Legacy rows (NULL fingerprint) are not judged retroactively; reset deletes a user's rows, so a
  legacy row bound to a retired key exists only from the pre-fix race (SC2).
- C3 adds a lock and reads only when `ecdh_public_key` actually changes (setup, reset).

### Scope contract

- **SC1** — Cryptographic binding of the wrap to the recipient key (fingerprint in the wrap AAD,
  `wrapVersion` 2, every unwrapper incl. iOS/extension). Needed only against a malicious distributor
  (S3), who already holds the team key. Owner: none planned.
- **SC2** — Detecting legacy rows already bound to a retired key: their fingerprint is NULL, so no
  query can tell. Recovery stays a rotation or the member's reset. Owner: none (server cannot recover).
- **SC3** — The rest of vault setup's TOCTOU: C3 refuses the racing second setup's single UPDATE, so
  none of its fields land; no route-level CAS added. Owner: C3.

## User operation scenarios

1. Admin A's tab fetched pending distributions (member M's key P). M resets and sets up again (P').
   A's distribution posts a key wrapped to P → 409, nothing written, M stays pending; the next poll
   wraps to P' and succeeds.
2. Same, but M only resets: the pre-check answers `VAULT_NOT_READY`; a reset committing after the
   pre-check makes the trigger answer `recipient_no_key` → 409.
3. M's reset starts while A's confirm-key holds M's row: the reset (users `FOR UPDATE` first) waits,
   then deletes the new key and clears the flag — M is pending again.
4. Rotation while M resets, sets up and is redistributed → whole rotation 409; retry refetches.
5. Double-submitted vault setup → second gets `VAULT_ALREADY_SETUP`.
6. An operator runs `UPDATE users SET ecdh_public_key = NULL` for a user who still holds team keys →
   refused; the supported path is a vault reset.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `recipient_key_fingerprint` column | locked |
| C2 | team_member_keys recipient guard | locked |
| C3 | users ECDH key guard (no overwrite, no change with keys, FOR UPDATE) | locked |
| C4 | Request field on the three writers | locked |
| C5 | Error mapping `TEAM_KEY_RECIPIENT_CHANGED` | locked |
| C6 | Client fingerprint | locked |
| C7 | Member sets | locked |
| C8 | Gates, grants, RLS | locked |
| C9 | One-time residue repair | locked |

## Implementation Checklist

Production (done by the orchestrator, batch A):
- `prisma/migrations/20261119000000_team_key_recipient_binding/migration.sql` (C1–C3, C9); `prisma/schema.prisma` field.
- `src/lib/prisma/database-guard-arm.ts` (new, one parser — R1); `src/lib/team/departed-member-guard.ts` (now a wrapper); `src/lib/team/team-key-recipient-guard.ts` (new: arm const-object, `teamKeyRecipientGuardArm`, `isTeamKeyRecipientChanged`).
- `src/lib/http/api-error-codes.ts` (three maps), `messages/{en,ja}/ApiErrors.json`.
- `src/lib/validations/team.ts` `teamMemberKeySchema.recipientKeyFingerprint`.
- Routes: confirm-key (both upsert branches + mapping), rotate-key (`createMany` + mapping), teams POST (nested create + mapping), vault setup (`ecdh_key_overwrite` → `VAULT_ALREADY_SETUP`).
- Client: `src/lib/crypto/crypto-team.ts` (`recipientKeyFingerprint`, escrow field); `team-vault-core.tsx`, `team-rotate-key-button.tsx`, `team-create-dialog.tsx` send it.

Tests (batches U, I, N, R):
- U — unit: escrow doubles computing from their JWK argument (`team-create-dialog.test.tsx`, `team-vault-core.test.tsx`, `team-rotate-key-button.test.tsx`), route tests of the four routes (bodies + mappings, nested adapter fixtures), validation, parser, fingerprint vector (non-ASCII).
- I — integration adopters: one helper in `src/__tests__/db-integration/helpers.ts` (idempotent recipient key, production fingerprint); 17 key-row seeders / 13 route-body builders listed by the C7 derivations, `user-owned-rows-seed.ts`, `e2e/helpers/{team-rekey.ts,team-rekey.test.ts,db.ts}`, `scripts/rls-cross-tenant-seed.sql`, #1074 red-proof rows touching confirm-key/rotate-key sources.
- N — new `team-key-recipient-binding.integration.test.ts` per Testing strategy.
- R — red-proof rows (separate rows dir, #1074 runner mechanism).

Gates (batch G): `scripts/rls-cross-tenant-verify.sql` (allowlist + exact tables + proconfig assertion), `check-bypass-rls.mjs` allowlist only for routines created outside migrations, `db-grants-manifest.json` regen/diff, CLAUDE.md member-key row.

Shared utilities to reuse: `pgErrorCode`/`SQLSTATE_CHECK_VIOLATION` (prisma-error.ts), `writeRefusedState`, `readBackfillBlock`, `gucSentinels`/`setGucs`/`readGucs`, #1074 race witness helpers (`expectAdvisoryWait`-style) in `departed-member-db-invariants.integration.test.ts`, `hexEncode`/`textEncode` (crypto-utils.ts).

CI parity (Step 2-1 item 7): CI-only gates relevant to this diff, run locally in 2-4 — `check:bypass-rls`, `check:crypto-domains`, `check:migration-drift`, `check:rls-grant-evidence`, `check:rls-nesting`, `db:check-drift`, `check-state-mutation-centralization.sh`. Not relevant (no dependency/terraform change): npm audit, licenses, terraform test counts.
