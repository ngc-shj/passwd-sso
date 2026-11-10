# Coding Deviation Log: session-containment-links-and-admin-credentials

## D1 — Live predicates spelled twice as object literals
`listMemberContainment` and `containMemberInTx` each spell the per-kind live predicate as an object
literal. A helper-built `where` is unreadable to `check-bypass-rls` and added two "unreadable
relation argument" sites (GET route, `member-passkey-revoke`), weakening its grant check;
`member-containment.test.ts` holds the two spellings equal.

## D2 — `parseOptionalBody` added to `src/lib/http/parse-body.ts`
The plan requires an absent/empty body to mean "no containment"; `parseBody` answers 400 to an empty
body. The new helper returns `null` for no/zero-byte body and otherwise caps, parses and validates
like `parseBody`.

## D3 — Break-glass rows hidden from GET for non-OWNER actors
One rule (`mayContainKind`) decides both listing and revoking per kind, so an ADMIN never sees a
break-glass row; the 403 stays reachable through the API and is tested.

## D4 — MCP token refusal value
The validator checks `revokedAt` before the client's `isActive`, and containment revokes the
client's tokens, so cell 3 asserts `token_revoked` (not `invalid_token`). Either is a refusal.

## D5 — Atomicity cell asserts a rejected promise
The route rethrows (`withRequestLog`); the framework turns it into the 500.

## D6 — Metadata names and notification key
Revoke-all row: `<kind>Contained` / `<kind>Skipped`, `unlinkedAccountIds` (first 10) and
`unlinkedAccountIdsOmitted`; other-tenant SYSTEM rows: `accountsUnlinked`,
`emergencyAccessGrantsRevoked`; per-row containment audits carry `targetUserId` (and
`revokedById` on the TENANT `EMERGENCY_ACCESS_REVOKE`). Email extent `"one" | "all" | "sessions"`;
notification key `SESSIONS_ALL_REVOKED_BY_ADMIN`.

## D7 — Members card unchanged
It already withholds the dialog trigger for deactivated members (pinned by its test), which is the
active-only rule.

## D8 — Backfill cell runs inside a rolled-back transaction (superseded in review round 1)
It runs the migration's DO block as `passwd_app` inside an open transaction, asserts the block
restored the GUCs (`app.bypass_rls` / `app.bypass_tables` empty, the row invisible again), re-sets a
bypass locally on the same connection to read `created_by_id`, and rolls back, so nothing reaches the
shared database. The block restores `app.tenant_id` to `''`, which the policies cannot cast to uuid:
any RLS read after it in the same transaction errors until a tenant id is set. The migration commits
straight after, so this affects only the test, which sets a nil tenant id before its visibility read.

## D9 — Not done here
CLAUDE.md's endpoint row was edited by the implementation agent and reverted (CLAUDE.md edits need
the user's approval). The follow-up issue for SC1/SC2 is filed with the PR.

## D10 — Review round 1 (N1, F1, F3)
- N1: each kind is one `updateManyAndReturn` on `{ id: { in }, ...live }` (accounts: read on the
  predicate, `deleteMany` the rows read, count verified or the transaction throws), audited with one
  `logAuditBulkInTx` per kind; emergency-access grants stay a loop through `transition()`, bounded
  by `MEMBER_CONTAINMENT_MAX_IDS`. The revoke transaction runs under
  `MEMBER_PASSKEY_REVOKE_TX_TIMEOUT_MS` (15 s, `src/lib/constants/auth/member-containment.ts`).
  The bulk audit write first made `member-passkey-revoke.ts` an "unreadable relation argument" site
  of `check-bypass-rls`: `enqueueAuditBulkInTx` writes `createMany({ data: payloads.map(...) })`, and
  an array-typed `data` has an index signature, which the typed reading refuses. Rather than accept
  that blind spot, the relation walk (`scripts/checks/lib/prisma-relation-reach.mjs`) now reads a
  `data` given as `<array>.map((r) => <expr>)` as `<expr>` per element; the unreadable count is back
  to 3. Self-tests cover a relation charged through the mapped element, a scalar-only element read
  as reaching nothing, and three shapes kept unreadable (block body, non-array receiver, named
  callback); dropping the array check or the mapped read each turns its cells red.
- F1: a named token already revoked with its contained service account counts as contained and gets
  its own `SERVICE_ACCOUNT_TOKEN_REVOKE` row marked `revokedWithServiceAccount: true` when it matches
  the token live predicate (the member's, unexpired), so the kind's count equals its rows.
- F3: `DELETE /api/webauthn/credentials/[id]` takes `lockUserAuthArtifacts` inside its tenant
  transaction and deletes by `deleteMany` (404 on count 0); revoke-all additionally throws when the
  delete count differs from the credentials read.

## Red-proof (RT7)
Scratch worktree at `d22755a43` (`.env` exported, not copied), compose workers stopped,
`npx vitest run --config vitest.integration.config.ts src/__tests__/db-integration/tenant-member-passkey-revoke.integration.test.ts -t "<cells>"`:

| Mutant | Red cells |
|--------|-----------|
| M1 SCIM live predicate without `createdById` (both spellings) | cell 3 (scimTokens) |
| M2 service-account / MCP live predicate without `tenantId` (shared literal) | cell 3 (serviceAccounts), cell 3 (mcpClients) |
| M3 emergency-access match without `ownerId` (listing, write) | cell 3 (emergencyAccessGrants) |
| M4 backfill without `app.bypass_rls` | migration backfill cell |

Round 1 (code review F2), scratch worktree at `a7e5b385c`, the whole file per mutant (31 tests; the
unmutated baseline 31/31 green). Each predicate mutant edits only the containment write's copy:

| Mutant | Red cells |
|--------|-----------|
| M5 service-account write without `createdById` | cell 3 (serviceAccounts) |
| M6 service-account-token write without `createdById` | cell 3 (serviceAccountTokens) |
| M7 MCP-client write without `createdById` | cell 3 (mcpClients) |
| M8 break-glass write without `requesterId` | cell 3 (breakglassGrants) |
| M9 account read and delete without `userId` | cell 3 (unlinking) |
| M10 SCIM write without `tenantId` | cell 3 (scimTokens) |
| M11 service-account-token write without `tenantId` | cell 3 (serviceAccountTokens) |
| M12 break-glass write without `tenantId` | cell 3 (breakglassGrants) |
| M13 containment moved to its own transaction after the revoke commits | cell 4, and every cell 3 asserting the revoke-all row's `contained` fields |

The relation-walk extension in `check-bypass-rls` is red-proved in its self-tests (D10).

Unmodified tree: integration suite 147 files / 1471 tests green (MinIO).
