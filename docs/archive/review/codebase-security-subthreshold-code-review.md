# Code Review: codebase-security-subthreshold

Date: 2026-05-30
Review type: Whole-codebase security review (triangulate Phase 3, standalone — no branch diff; `main` clean)
Review round: 1

## Context

Prompted by `/security-review` (full codebase) followed by `/triangulate`. Two prior deep
passes across 9 security domains found **zero exploitable vulnerabilities at confidence >=8**
and reported only 2 sub-threshold observations. The user doubted "only 2" and asked for a
comprehensive enumeration of sub-threshold (confidence <8) observations, hardening gaps, and
defense-layer non-uniformities. Three expert sub-agents (functionality / security / testing)
re-swept the whole codebase. Top findings were independently re-verified by the orchestrator.

**Bottom line:** it was NOT only 2. ~22 items surfaced. One (F1) is an above-threshold real
bug (data-lifecycle, not an exploitable auth/crypto vuln — so the security passes' "no vuln"
conclusion still holds). The rest are genuine defense-in-depth / consistency / coverage items.

---

## Above-threshold finding (verified)

### F1 [Major] Encrypted attachment blobs orphaned in external storage on 4–5 delete paths
- Category: cascade-delete orphan (R6) + incomplete pattern propagation (R3)
- Verified: yes (orchestrator re-grep)
- Only the 30-day GC path cleans external blobs:
  - GOOD: `src/app/api/passwords/route.ts:80-96` — `if (backend !== DB)` → enumerate
    `Attachment.encryptedData` → `blobStore.deleteObject(...)` → then `deleteMany`.
  - MISSING: `src/app/api/passwords/[id]/route.ts:273` (permanent delete)
  - MISSING: `src/app/api/passwords/empty-trash/route.ts:25`
  - MISSING: `src/app/api/teams/[teamId]/passwords/empty-trash/route.ts:40`
  - MISSING: `src/lib/services/team-password-service.ts:532` (delete) and `:223`
    (`purgeExpiredTeamPasswords`)
- `Attachment` (`prisma/schema.prisma:1232`) cascades on `passwordEntryId` /
  `teamPasswordEntryId` (`onDelete: Cascade`), so DB rows vanish but the S3/GCS/Azure objects
  leak forever when `blobStore.backend !== DB`. Harmless with the DB backend (cascade covers
  the bytes column), which is why it went unnoticed.
- Impact: encrypted attachment data that is supposed to be permanently deleted persists in the
  external bucket — storage cost + a residual (encrypted) data footprint after user-requested
  deletion. Privacy/data-lifecycle issue, not an access-control bypass.
- Fix: extract a shared `deleteEntriesWithBlobs(entryIds)` helper (enumerate attachments →
  `deleteObject` via `Promise.allSettled` → cascade delete), call it from all five paths,
  guarded by `backend !== DB` like the GC path.

---

## Security sub-threshold observations (confidence 4–6)

- **S1 [conf 6] CLI agent-decrypt socket dir: ownership checked, mode not** —
  `cli/src/commands/agent-decrypt.ts:84-110` re-stats dir uid but not mode for a pre-existing
  dir; sibling `cli/src/lib/ssh-agent-socket.ts:63-66` enforces `mode === 0o700`. Compensated
  by `/run/user/<uid>` being OS-managed 0o700 + socket file later chmod 0o600. (Was item #1.)
- **S2 [conf 6] Extension DPoP handlers have no production sender** —
  `extension/src/background/index.ts:2583-2605` (`GET_DPOP_JKT` / `GET_DPOP_PROOF`) are dead;
  a compromised content script could mint token-bound DPoP proofs. No `externally_connectable`.
  Delete or gate on `sender.id`. (Was item #2.)
- **S3 [conf 6] MCP gateway does not apply tenant IP-access restriction** — `enforceAccessRestriction`
  is applied on v1 / extension-token / SCIM / delegation-check / access-requests and the session
  path, but NOT in `/api/mcp` (POST `route.ts` nor SSE `handleGET`). MCP tokens carry `tenantId`,
  so a leaked `mcp_` token is usable from any IP even when a tenant has configured `allowedCidrs`.
  **Highest-priority of the security items.** Verified: yes.
- **S4 [conf 5] Send/share-link master-key encryption binds no AAD** —
  `src/lib/crypto/crypto-server.ts:182-209` (`encryptShareData`/`Binary`) takes no AAD, whereas
  webhook-secret / audit-target / delegation / dirsync master-key callers all bind an AAD to
  row/tenant. Cross-row ciphertext substitution would require DB write to exploit.
- **S5 [conf 5] DPoP jti replay cache fails open across instances on Redis error** —
  `src/lib/auth/dpop/jti-cache.ts:99-109` falls back to a per-process Map on Redis failure →
  bounded replay (once per instance) during a Redis outage in a multi-instance deploy.
- **S6 [conf 5] `shareDataSchema.password` has no `.max()`** — `src/lib/validations/share.ts:28`;
  every sibling field is capped. Bounded only by the global JSON body cap.
- **S7 [conf 4] `teamHistoryReencryptSchema.encryptedItemKey` uncapped** —
  `src/lib/validations/common.ts:101`; sibling `encryptedBlob` is `.max(HISTORY_BLOB_MAX)`.
- **S8 [conf 5] `mcp/register` (pre-auth DCR) + `webauthn/authenticate/options` use raw
  `req.json()`** — `mcp/register/route.ts:83`, `webauthn/authenticate/options/route.ts:55` skip
  the `readJsonWithCap(MAX_JSON_BODY_BYTES)` pattern nearly all other routes (incl. `mcp/route.ts:29`)
  use. IP-rate-limited but per-request body size unbounded on a pre-auth endpoint.
- **S9 [conf 5] CLI `loadCredentials` read path lacks the symlink / O_NOFOLLOW hardening its
  write path has** — `cli/src/lib/config.ts:113-116` (read) vs `:85-100` (write rejects symlink,
  uses O_NOFOLLOW, 0o600). A pre-planted symlink / world-readable legacy file is consumed silently.
- **S10 [conf 4] share-link `verify-access` distinguishes not-found from wrong-password** —
  `verify-access/route.ts:82-120` → existence oracle on unguessable IDs, rate-limited.
- **S11 [conf 4] CLAUDE.md claims a CSRF "Host-header fallback" that the code does not implement** —
  `src/lib/auth/session/csrf.ts:37-38` is fail-closed (no Host fallback). Code is safer than the
  doc; risk is a future maintainer re-introducing the documented (insecure) fallback. Doc drift.

Verified clean / uniform (so the "only 2" doubt is partly answered — NOT issues): RLS wrapping
across all API routes, token comparison (hash-keyed DB lookup, no `===` on secrets), all 10
`timingSafeEqual` sites length-guarded + constant-time, PKCE/redirect_uri exact-match, IP-access
fail-closed on null IP, `parseBody` streaming byte cap, `withBypassRls` requires explicit purpose,
PBKDF2 600k uniform with a `< minimum` guard.

## Functionality sub-threshold observations (confidence 3–6)

- **F2 [conf 6] Audit-outbox "same transaction as business logic" invariant not upheld at the
  route layer** — `enqueueAuditInTx` (`src/lib/audit/audit-outbox.ts:20`) is used by no route;
  all 127 routes call `logAuditAsync` → `enqueueAudit` in its own tx AFTER the business tx
  commits. A crash in the window loses the audit event (mitigated by the sync structured-log
  emit). CLAUDE.md's atomicity claim is stronger than the implementation. Fix: thread the tx in
  at high-value routes, or soften the doc wording.
- **F3 [conf 6] `success` field type differs between bulk-import (number) and sibling bulk
  routes (boolean)** — `passwords/bulk-import/route.ts:138` & team `:110` return
  `{ success: <count> }`; trash/archive/restore/empty-trash return `success: true`. Current UI
  reads it correctly; latent footgun for generic `if (res.success)` consumers.
- **F4 [conf 4] emergency-access `confirm` is the only transition with no email notification** —
  every other action emails; only `emergency-access/[id]/confirm/route.ts` omits it. Decide
  intentional vs gap.
- **F5 [conf 3] `maxViews` number input clamps/clears mid-stroke (R23)** —
  `send-dialog.tsx:393-399`, `share-dialog.tsx:518-524`. Final value always valid; jumpy UX.
- **F6 [conf 3] Personal bulk-import inlines folder/tag check + create with bare `prisma`
  while team path uses a service** — `passwords/bulk-import/route.ts:54-110`. Structural
  inconsistency; future create-semantics changes must be made twice.

Verified clean: bulk endpoints re-derive IDs from scoped `findMany` (no trust-the-list),
atomic view-count UPDATEs, uniform UUID IDs, `await params` everywhere, no circular deps,
persist/hydrate symmetry in CLI/extension storage.

## Testing sub-threshold observations (confidence 3–7)

- **T1 [conf 7] Redis-backed integration tests silently skip in CI** — `ci-integration.yml:36`
  provisions only Postgres; `session-revocation-cache.integration.test.ts:68` and
  `admin-vault-reset-cross-tenant-sessions.integration.test.ts` `skipIf(!REDIS_URL)` → the
  real-Redis session-tombstone + cross-tenant-reset-revocation flows report green by skipping.
  **Highest-leverage testing fix.** Verified: yes. Fix: add a `redis:7` service + `REDIS_URL`.
- **T2 [conf 6] ci-integration path filter omits most DB-touching route handlers** —
  `ci-integration.yml:10-26` excludes `src/app/api/passwords|teams|share-links|tenant|sends/**`.
  Route-handler-only PRs run no integration tests.
- **T3 [conf 6] Cross-tenant RLS adversarial probe covers 2 of ~54 RLS tables** —
  `tenant-swap.adversarial.integration.test.ts` only `passwordEntry` / `teamPasswordEntry`;
  machine-identity tables (`mcp_*`, `service_account*`, `extension_tokens`, `delegation_sessions`,
  `api_keys`) have no cross-tenant probe.
- **T4 [conf 6] `withTenantRls` stubbed to passthrough in ~28 route tests** — e.g.
  `tenant/mcp-clients/[id]/route.test.ts:16`; "404 when not found" can't distinguish absent vs
  other-tenant because the predicate never runs. Acceptable iff integration covers it (→ T3).
- **T5 [conf 5] `admin-ia.spec.ts` 8 tests silently skip on UI-discovered teamId** —
  `e2e/tests/admin-ia.spec.ts:137-173`; seed deterministically instead.
- **T6 [conf 5] Extension userActivation gate behavior tested only against `-lib.ts`** —
  shipped `token-bridge.js` gets a substring-presence check only
  (`token-bridge-js-sync.test.ts:35-36`); an inverted gate in the `.js` would pass. C15-v2 control.
- **T7 [conf 5] CLI agent-decrypt authorization tested only on deny path** —
  `agent-decrypt-ipc.test.ts` mocks `apiRequest` to always fail; no authorized-→-decrypt or
  HTTP-ok-but-delegation-denied case.
- **T8 [conf 5] Coverage gate is lines-only at 60%, no branch/function floor** —
  `vitest.config.ts:61-66`; negative/denied branches can erode silently.
- **T9 [conf 4] MCP token-route success mock omits real return fields (RT1)** —
  `mcp/token/route.test.ts:180-188` lacks `accessTokenId`/`refreshTokenId`/`familyId`; untyped.
- **T10 [conf 3] SKIP-LOCKED worker test lacks per-worker lower-bound guard (RT4)** —
  `audit-outbox-skip-locked.integration.test.ts:108-118`; safe only by current arithmetic.
- **T11 [conf 3] Sidebar landmark E2E asserts visibility, not landmark element type** —
  `sidebar-insights-landmark.spec.ts:34-35`.

Verified clean: race tests carry proper RT4 lower-bound guards, proxy CSRF tests pair
`not.toBe(403)` with real `toBe(200)`, audit-action coverage is SSoT-derived, no missing
`await` on `.resolves`/`.rejects`.

---

## Resolution Status

All 22 items fixed on branch `fix/review-subthreshold-findings`.

Verification (all green):
- `npx vitest run` — 887 files, 10,724 passed / 1 skipped
- CLI `npx vitest run` — 215 passed
- `npx next build` — success
- `scripts/pre-pr.sh` — 29/29 passed
- `npx vitest run --coverage` — no threshold violations (new `branches: 50` global + `70` per-file floors hold)

Per-item:
- **F1** — `src/lib/blob-store/cleanup.ts` (`collectEntryAttachmentRefs` + `deleteAttachmentBlobs`); wired into the GC path, `[id]` permanent delete, personal + team `empty-trash`, and `team-password-service` delete/purge.
- **S1** — `agent-decrypt.ts` `prepareSocket` now rejects dir mode ≠ 0700.
- **S2** — dead `GET_DPOP_PROOF`/`GET_DPOP_JKT` handlers + unused `signDpopProof` import + their test block removed.
- **S3** — `enforceAccessRestriction` applied to `/api/mcp` POST + SSE GET; tests mock it and assert the deny path.
- **S4** — `encryptShareData/Binary` + `decryptShareData/Binary` AAD-bound to tenant with legacy no-AAD decrypt fallback; 6 call sites updated; cross-tenant-substitution + legacy-fallback regression tests added.
- **S5** — DPoP jti cache fails closed (reject) on Redis error instead of per-instance memory; fail-closed test added.
- **S6/S7** — `.max(ENTRY_SECRET_MAX)` on share password; `.max(ENCRYPTED_ITEM_KEY_MAX)` on `encryptedItemKey`.
- **S8** — `mcp/register` + `webauthn/authenticate/options` route bodies through `readJsonWithCap`.
- **S9** — CLI `loadCredentials` reads with `O_NOFOLLOW` + symlinked-dir rejection.
- **S10** — `verify-access` no-password branch collapsed to 404 (anti-enumeration); test updated.
- **S11** — CLAUDE.md CSRF Host-header claim corrected (fail-closed, no fallback).
- **F2** — CLAUDE.md audit-outbox section rewritten to describe `enqueueAuditInTx` vs `logAuditAsync` durability accurately.
- **F3** — bulk-import returns `{ success: true, importedCount, failedCount }`; importer consumer + tests updated.
- **F4** — emergency-access `confirm` no-email omission documented as intentional.
- **F5** — `maxViews` inputs clamp on blur, not mid-stroke (both dialogs).
- **F6** — `createPersonalPasswordEntry` service extracted; bulk-import delegates to it.
- **T1/T2** — `ci-integration.yml` gains a `redis:7` service + `REDIS_URL`, and `src/app/api/**` + `src/lib/services/**` path triggers.
- **T3** — cross-tenant RLS adversarial probe extended to `serviceAccount` (machine-identity family).
- **T4** — mcp-clients/[id] test asserts `withTenantRls` receives the authenticated tenantId.
- **T5** — admin-ia E2E uses the deterministic `E2E_TEAM_ID` (exported) instead of UI scrape + silent skips.
- **T6** — token-bridge.js userActivation gate test asserts fail-closed structure + absence of `hasBeenActive`.
- **T7** — CLI agent-decrypt gains server-denied + authorized-advances test cases.
- **T8** — vitest `branches` floors (50 global, 70 for crypto/auth overrides).
- **T9** — MCP refresh-token mock includes the real `accessTokenId`/`refreshTokenId`/`familyId`/`serviceAccountId` fields.
- **T10** — SKIP-LOCKED worker test gains per-worker lower-bound guards.
- **T11** — sidebar landmark E2E asserts unique `<section aria-label="Security">`.
