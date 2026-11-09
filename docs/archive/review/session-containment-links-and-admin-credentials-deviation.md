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

## D8 — Backfill cell commits on the shared dev database
It runs the migration's DO block as `passwd_app` and commits (the restored GUCs leave the role unable
to read the rows inside the same transaction), so it may also attribute other NULL-creator JIT
tokens on the dev database — the migration's own intended effect.

## D9 — Not done here
CLAUDE.md's endpoint row was edited by the implementation agent and reverted (CLAUDE.md edits need
the user's approval). The follow-up issue for SC1/SC2 is filed with the PR.

## Red-proof (RT7)
Scratch worktree at `d22755a43` (`.env` exported, not copied), compose workers stopped,
`npx vitest run --config vitest.integration.config.ts src/__tests__/db-integration/tenant-member-passkey-revoke.integration.test.ts -t "<cells>"`:

| Mutant | Red cells |
|--------|-----------|
| M1 SCIM live predicate without `createdById` (both spellings) | cell 3 (scimTokens) |
| M2 service-account / MCP live predicate without `tenantId` (shared literal) | cell 3 (serviceAccounts), cell 3 (mcpClients) |
| M3 emergency-access match without `ownerId` (listing, write) | cell 3 (emergencyAccessGrants) |
| M4 backfill without `app.bypass_rls` | migration backfill cell |

Unmodified tree: integration suite 147 files / 1471 tests green (MinIO).
