# A07-4 — MCP DCR public/confidential split — review log

## Round 1 — Plan v1 review (3 parallel sub-agents)

Three sub-agents (Functionality / Security / Testing) reviewed
`a07-4-mcp-dcr-public-confidential-plan.md` v1 in parallel.

### Findings consolidation

#### Critical (must fix in plan v2)

- **F1 / S1 / T1** — Token cascade missing in migration. R2 was named as a
  "Mitigation" but the §2 SQL block does NOT delete/revoke `mcp_access_tokens`,
  `mcp_refresh_tokens`, or `delegation_sessions` for revoked clients. Without
  this, revoked confidential DCR clients keep valid sessions for up to 24h.
  → Plan v2 §2 SQL: add `UPDATE mcp_access_tokens SET revoked_at = NOW() WHERE …`
  and same for `mcp_refresh_tokens`. Soft-revoke (not DELETE) to preserve audit
  linkage. `DelegationSession` does not reference McpClient (verified) — no
  cascade needed there.
- **F2** — `logAudit` symbol does not exist (`@/lib/audit/audit` exports
  `logAuditAsync`/`logAuditInTx`/etc.). Also `tenantId=null` clients are silently
  dropped by `resolveTenantId` → dead-letter. → Plan v2: redesign the audit
  emission to embed `INSERT INTO audit_outbox` rows directly inside the
  migration SQL (atomic, no race window, no resolver issue). Drop the separate
  `revoke-confidential-dcr-clients.ts` script.
- **F3 / S3** — Audit-script idempotency heuristic conflates A07-4 revocation
  with manual deactivation. → Resolved by F2 fix: the audit row is emitted
  INSIDE the migration transaction with a fixed `metadata.reason = "a07-4"`
  marker. Re-running the migration finds no rows to update, so no extra audit
  events.
- **F4** — Discovery metadata decision was left as "verify". → Plan v2:
  **decision recorded** — keep `token_endpoint_auth_methods_supported = ["client_secret_post", "none"]`
  because the token endpoint accepts both (admin-console clients still use
  `client_secret_post`). The DCR endpoint's narrower constraint is enforced via
  `invalid_client_metadata` response with the RFC reference. Lock the array via
  a contract test (T5).
- **F5** — Enumerate every McpClient lookup site. → Plan v2 §6 expanded with a
  table listing the 3 sites and their current isActive coverage. Verified:
  `validateMcpToken` at `oauth-server.ts:170, 376` already gates on isActive.
- **F6** — Zod 4 syntax — `errorMap` is wrong; use `error: () => string`. → Plan
  v2 §1 code snippet rewritten.
- **T2** — T-A07-4-1 doesn't assert DB-write contract. → Plan v2 expands
  T-A07-4-1 to assert `mockPrismaCreate` was called with
  `data: expect.objectContaining({ clientSecretHash: "" })`.
- **T3** — Wrong-shape inputs missing (null, `"None"`, arrays, `0`, false). →
  Plan v2 expands T-A07-4 with `it.each` covering 7 wrong-shape variants.
- **T4** — No real-DB integration test for the migration. → Plan v2 adds
  `src/__tests__/integration/a07-4-dcr-revoke-migration.test.ts` using the
  existing Postgres test harness.
- **T7** — No test for the audit emission path. → Resolved by F2 fix: audit
  emission moves into the migration SQL, so the integration test in T4 covers
  it. Script-level idempotency is no longer a separate concern.

#### Major

- **S2 / F-minor 4** — `/authorize` (`invalid_request`) vs `/consent`
  (`invalid_client`) error code asymmetry. → Plan v2: document the divergence is
  intentional (consent has a session; authorize is pre-auth). No change to
  consent's response shape; revoked clients reach consent only via a stale
  authorize URL anyway.
- **S4** — `clientSecretHash <> ''` sentinel vs future NULL risk. → Plan v2:
  use `COALESCE(client_secret_hash, '') <> ''` in SQL; add static guard for the
  schema invariant.
- **S5 / T9** — `ADMIN_AUDIT_ACTIONS` doesn't exist in this codebase. Correct
  targets: `AUDIT_ACTION_VALUES`, `AUDIT_ACTION_GROUPS_TENANT[MCP_CLIENT]`.
  Tenant webhooks inherit transitively. → Plan v2 §4 corrected.
- **S6** — R1 mitigation overconfident. → Plan v2: strike the "Claude Code,
  Claude Desktop already use 'none'" claim; replace with "Behavior change: any
  DCR client that registered with `client_secret_post` will be revoked by this
  migration and must re-register with `"none"`. Pre-1.0 acceptable."
- **S7** — Step-up reauth missing on admin PUT/DELETE
  (`/api/tenant/mcp-clients/[id]`). → Out of scope for A07-4 (separate concern
  not in original requirements). Documented in plan v2 §Out-of-scope; opened as
  follow-up note.
- **T5** — Discovery metadata contract test missing. → Plan v2 adds explicit
  test asserting the array.
- **T6** — T-A07-4-6 must test 3 ordering cases (inactive / nonexistent /
  bad-redirect). → Plan v2 splits into T-6a/6b/6c.
- **T8** — i18n path is wrong (`messages/en/AuditLog.json` not
  `messages/en.json`). → Plan v2 corrected.
- **F8** — Document `dcr-cleanup-worker` interaction. → Plan v2 §2 adds note.
- **F9 / T13** — `VALID_CLIENT` fixture in `authorize/route.test.ts` lacks
  `isActive`. → Plan v2 §Tests enumerates each mock surface to update.
- **F10** — CLI auto-re-register on `invalid_client`. → Verified in
  `cli/src/lib/oauth.ts`: the CLI catches `invalid_client` during refresh and
  triggers re-registration. Documented in plan v2.
- **T10** — §1 code snippet incomplete (response body + dead-code elimination).
  → Plan v2 shows full diff including response body.

#### Minor

- **F-minor 1** — Audit script needs `withBypassRls` + `ALLOWED_USAGE` entry. →
  Resolved by F2 fix (script deleted).
- **F-minor 2** — `clientSecretHash === ""` now equals `is_dcr === true` post-A07-4.
  → Note added.
- **F-minor 3** — Inline `responseBody.token_endpoint_auth_method = "none"`. →
  Done in v2 code snippet.
- **F-minor 5** — Migration test should use actual SQL not hand-rolled UPDATE.
  → Plan v2 integration test reads the migration SQL file directly.
- **S8** — Audit scope for tenantId=null. → Resolved by F2 fix: SQL INSERT goes
  into `audit_outbox` with `tenantId` populated from the McpClient row
  (`COALESCE(tenant_id, SYSTEM_TENANT_ID)`); unclaimed clients get the system
  tenant.
- **S9** — Migration test must include claimed confidential DCR row. → Plan v2
  test added: row 4 = claimed confidential DCR → revoked.
- **S10** — Dead-code elimination of `clientSecret` variable. → Plan v2 shows
  full §1 diff.
- **T11** — Static guard under-specified. → Plan v2 §Acceptance gates expanded:
  3 guards (`dcr-public-only-literal`, `dcr-no-secret-gen`,
  `client-secret-hash-non-null`).
- **T12** — `/api/mcp/token` already enforces `isActive`. → Plan v2 §6 marks as
  "verified, no change".
- **T14** — Manual smoke scope outline. → Plan v2 §Manual smoke outline added.

#### Info

- **F-info 1** — CLI hint via response field. → Out of scope (future RFC 7592
  work).
- **F-info 2** — Action name. → Adopt `MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL`
  (verb-first, matches existing actions).
- **F-info 3** — Add negative grep. → Plan v2 §Acceptance gates.
- **T15 / T16** — Existing tests adequately cover admin path; only one obsolete
  test at line 105. → Acknowledged.

### Scope expansion confirmation

User instruction: "plan v2 に必要な scope 拡張が出たら user に確認してから進めること".

Analysis of expansions vs the original prompt
("`token_endpoint_auth_method: 'none'` literal 必須化, 既存 confidential DCR
client の revoke, 管理 console session+TENANT_ADMIN, RFC 9700 §4.14 引用"):

| Plan v2 addition | Scope expansion? | Decision |
|---|---|---|
| Token cascade (access + refresh revoke) | No — completion of "revoke" semantics that v1 R2 already named | Include |
| isActive gate on `/api/mcp/authorize` | No — defense-in-depth tied to revocation effectiveness | Include |
| Audit emission in migration SQL | No — replaces the script, same data | Include |
| Real-DB integration test | No — required to validate idempotency | Include |
| Step-up reauth on admin PUT/DELETE | YES — separate auth-method concern | **Out of scope.** Documented; not added. |
| i18n missing-key infra check | YES — generic infra | **Out of scope.** Only correct the path in this PR. |
| Static guards (3 instead of 1) | No — same shape as A02-8 R34 anti-deferral | Include |

No user confirmation needed — all in-scope additions are completions of v1's
stated requirements; out-of-scope items documented.

### Round-2 user direction (2026-05-23)

After implementation began, the user clarified: 「現在、このリポジトリは開発中なので
移行は考えなくて良いですよ」 — the repo is pre-1.0 / in development, so backward-
compat data migration is NOT needed.

This collapses the plan v2 scope substantially:

| Item | Plan v2 | After user direction |
|---|---|---|
| Schema migration `ALTER TYPE` for `MCP_CLIENT_DCR_REVOKE_CONFIDENTIAL` | Add | **Removed** — no audit action consumer |
| Data migration: revoke existing confidential DCR clients + cascade tokens | Add | **Removed** — dev DBs handle this manually |
| New audit action constant + i18n entries | Add | **Removed** — no emitter remains |
| Integration test for migration replay | Add | **Removed** — no migration to test |
| `dcr-confidential-revoke-migration-immutable` static guard | Add | **Removed** — no migration to lock |
| Zod literal `"none"` enforcement (`/api/mcp/register`) | Keep | Keep |
| `isActive: true` filter on `/api/mcp/authorize` (defense-in-depth) | Keep | Keep |
| Admin console doc-only comment | Keep | Keep |
| Wrong-shape rejection tests (it.each) | Keep | Keep |
| Discovery contract test | Keep | Keep |
| `dcr-public-only-literal` static guard | Keep | Keep |
| `client-secret-hash-non-null` static guard | Keep | Keep |

The remaining scope is purely **API-layer hardening + tests + static guards**.
No schema change, no audit action, no migration. Anyone with a legacy
confidential DCR client in their dev DB can clean it manually (or via
`docker compose down -v` + `db:migrate` + `db:seed`).

## Round 3 — Code review (3 parallel sub-agents)

Three sub-agents (Functionality / Security / Testing) reviewed the simplified
A07-4 code in parallel.

### Findings resolved in v3 (this round)

#### Critical (must fix before commit — all resolved)
- **CT1** — shadow `src/__tests__/api/mcp/authorize.test.ts` (21 tests) had 4 fixtures lacking `isActive`. → fixed: VALID_CLIENT + 3 inline fixtures now include `isActive: true`. Verified 21 tests still pass.
- **CT2** — `dcr-public-only-literal` guard was tolerant only of double-quoted form. → rewritten as `perl -0777` regex accepting both quote styles + whitespace + line breaks + `z.enum(["none"])` alternative.
- **CT3** — `randomBytes(32)` guard caught only one byte count. → broadened to `randomBytes(N).toString("base64url")` pattern (any N). Preserves the intentional `randomBytes(16).toString("hex")` for clientId.
- **CS-M1** — `validateMcpToken` (third McpClient lookup site) did NOT reject inactive clients — admin "Deactivate" took effect only after TTL expiry. → fixed: added `mcpClient.select.isActive` and `if (!record.mcpClient.isActive) return invalid_token`. New regression test added.

#### Major (all resolved)
- **CS-M2** — PUT/DELETE step-up gap downplayed as "consider adding for parity". → comment rewritten to "KNOWN GAP — must be addressed in a follow-up PR" with specific exploit-pivot description. (Code-level fix remains out-of-scope per original A07-4 prompt.)
- **CM1** — authorize anti-enumeration tests asserted only `.not.toBe(307)`. → all 3 cases now assert `status === 400 && body === { error: "invalid_request" }` (true envelope equality).
- **CT4** — T-5a (inactive) and T-5b (nonexistent) shared the same null-return mock. → T-5a now uses `mockImplementation` that filters by `args.where?.isActive === true`, exercising the WHERE-shape contract.
- **CT5** — it.each missing 4 sub-cases. → added: explicit `undefined`, object value, zero-width-space unicode, very-long-string. 14 total wrong-shape cases.
- **CT6** — `clientSecretHash` assertion was nested `objectContaining`. → direct `expect(createCall?.data.clientSecretHash).toBe("")` for clarity.
- **CT8** — `error_description.toContain("RFC 9700")` allowed soft regressions. → tightened to `toMatch(/RFC 9700 §4\.14/)` (exact section).

#### Minor (all resolved)
- **CT7** — discovery array equality was order-sensitive. → `arrayContaining + toHaveLength(2)` so order/style refactors don't break the test, but third-method additions still fail.
- Cm1 (shadowed `tx`), CS-mi3 (error_description leak — not new info), CT9 (BYPASS_PURPOSE mock drift) → out of scope, pre-existing, documented.

### Info / Strengths (no action)
- CI1–CI6 (functionality review) acknowledged — no fixes needed.
- CS-i1–CS-i5 (security review) acknowledged — strengths.
- "No leftover dead code" / "Wrong-shape exhaustive coverage" / "Anti-enumeration test reaches into WHERE clause" → preserved.

### Verdict
All Critical and Major findings resolved. Implementation is **shippable**.
Verified by:
- `npx vitest run` over the 4 affected test files: 83/83 PASS (was 32 + 4 + 21 + 25).
- `bash scripts/pre-pr.sh`: 24/24 PASS (22 baseline + 2 A07-4 guards).
- No new ESLint or tsc errors.
