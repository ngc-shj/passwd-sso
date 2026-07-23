# Plan: external-review-2026-07-remediation

Branch: `fix/external-review-2026-07-remediation`
Date: 2026-07-22

## Project context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL)
- Test infrastructure: unit + integration + E2E + CI/CD
- Verification environment constraints:
  - VE1: DB integration tests require a running Postgres (`npm run test:integration`) — verifiable-local (dev Docker stack present).
  - VE2: Team key rotation end-to-end (browser crypto) has no automated E2E harness for the rotation+history flow — client decrypt paths are covered by unit tests against the same crypto primitives; manual browser verification is `blocked-deferred` this round (single-session dev environment; multi-member rotation scenario needs two browser identities). Cost-justification: unit tests exercise the exact key-selection branch with real WebCrypto; the residual risk is wiring-level, mitigated by C1's consumer-flow walkthrough.

## Objective

Close the residual actionable items confirmed by the external-review verification
(`external-review-2026-07-verification.md`), except SC-scoped deferrals:

1. 残2 — team history old-key client wiring + old-key fetch audit (the only user-facing data-loss item)
2. `#2` residual — Tailscale UI help text overstates browser-path enforcement
3. `#3` — pin the 4-field session-callback contract (fail-closed drift test)
4. `#6` residual — standalone admin lockout clear + fallback observability
5. `#4` — retention registry vs pg_policies/relrowsecurity DB cross-check
6. `#5` — toolchain pinning (engines/packageManager, CI Node-22 job alignment)
7. 残3 — AccessRequest PENDING→EXPIRED sweep in retention-gc worker

## Contracts

### C1 — Team history old-key decryption (client)

- `getTeamEncryptionKeyForVersion(teamId: string, keyVersion: number): Promise<CryptoKey | null>` added to team-vault-core context (alongside `getTeamEncryptionKey`).
  - Fetches `GET apiPath.teamMemberKey(teamId, keyVersion)`; **shares the existing fetch+unwrap body with `getTeamEncryptionKey` via one extracted private helper parameterized by optional keyVersion** — a single implementation of the R39 zeroization discipline (`ecdhPrivateKeyBytes.fill(0)` on every exit path, `teamKeyBytes.fill(0)` after derivation, `extractable: false`), two entry points. No second `unwrapTeamKey` call site.
  - **Version assertion**: after parsing the response, assert `memberKeyData.keyVersion === requestedVersion`; on mismatch return null and cache nothing (server version-swap cannot poison the versioned slot or the latest pointer). AAD uses the asserted version.
  - Cache: versioned cache keyed `` `${teamId}:${keyVersion}` `` + latest pointer `` `${teamId}:latest` `` holding the resolved latest version number. `getTeamEncryptionKey` resolves via the pointer. **`getTeamKeyInfo` (team-vault-core.tsx:268-277) is a fourth cacheRef reader** — update it to resolve via the latest pointer (or have `getTeamEncryptionKey` return the cached record so getTeamKeyInfo stops touching cacheRef directly); it feeds team entry create/edit, bulk import, and rotation.
- `getEntryDecryptionKey` gains version awareness: signature unchanged (`entry: EntryItemKeyData` already carries `teamKeyVersion`). **Version normalization: `entry.teamKeyVersion < 1` (legacy schema-default-0 rows; note `0 ?? 1 === 0`) maps to version 1** — pre-versioning rows were sealed under what became version 1 (column added by 20260223053433 with DEFAULT 0, no backfill; team default became 1 in 20260223100000), so `<1 → 1` is semantically correct even for a team that later rotated (whereas "<1 → latest" merely preserves the current always-latest status quo, which is wrong for 0-rows in rotated teams). If version 1 resolves to the current latest, the normal path serves it; otherwise the versioned fetch does. Also prevents the member-key route's `keyVersion < 1` 400.
  - v0 ItemKey path (itemKeyVersion 0) with old teamKeyVersion >= 1: OLD TeamKey-derived encryption key.
  - v>=1 path: `buildItemKeyWrapAAD(teamId, entryId, entry.teamKeyVersion)` unchanged; the unwrap TeamKey becomes the versioned one.
  - ItemKey cache: versioned (non-latest) ItemKey unwraps are NOT cached.
  - `getTeamEncryptionKeyForVersion` returning null (e.g. MEMBER_KEY_NOT_FOUND — member joined after rotation N holds no older rows; verified server-side that no pre-join backfill exists) throws from `getEntryDecryptionKey` as today; **history view shows a distinct i18n message ("この履歴の鍵は利用できません" class, not the generic decrypt-failure toast) when the versioned fetch 404s** — entry-history-section catches and branches on the null/error cause.
- `entry-history-section.tsx` handleView: remove the TODO; pass `data.teamKeyVersion` through — correctness now comes from the version-aware `getEntryDecryptionKey`.
- API path helper: `apiPath.teamMemberKey(teamId, keyVersion?)` gains optional second param appending `?keyVersion=N`.
- Restore path note: restore keeps writing back the original blob + original `teamKeyVersion` (server unchanged); after C1, viewing the restored entry decrypts via the same version-aware path. The restored-entry LIST/detail path (`getEntryDecryptionKey` from the entry card) also benefits — the same function serves both.
- Consumer-flow walkthrough (complete caller set of `getEntryDecryptionKey`, code-derived: `rg -l "getEntryDecryptionKey\(" src/` → 4 production call sites + tests):
  - Consumer A (entry-history-section.tsx:201 handleView, team branch) reads `{ encryptedBlob, blobIv, blobAuthTag, itemKeyVersion, encryptedItemKey, itemKeyIv, itemKeyAuthTag, teamKeyVersion, aadVersion }` from the history detail response and passes `teamKeyVersion` into `getEntryDecryptionKey` for key selection — field present since history/[historyId]/route.ts:56-60. Satisfiable.
  - Consumer B (build-team-get-detail.ts:56) passes `teamKeyVersion: raw.teamKeyVersion ?? 1` — post-restore stale-version entries decrypt without re-save. Satisfiable.
  - Consumer C (team-vault-list-adapter.ts:69) passes `teamKeyVersion: rawEntry.teamKeyVersion ?? 1` — overview decrypt version-aware. Satisfiable.
  - Consumer D (team-export.tsx:99) passes the entry's fields including teamKeyVersion — export of stale-version entries works. Satisfiable.
  - Consumer E (`getTeamEncryptionKeyForVersion` → member-key route response) reads `{ encryptedTeamKey, teamKeyIv, teamKeyAuthTag, ephemeralPublicKey, hkdfSalt, keyVersion, wrapVersion }` — all returned by member-key/route.ts:74-82 for versioned lookups. Satisfiable.
  - Consumers F-H (re-derived — full production caller set is 7, not 4): `use-team-login-form-state.ts:43`, `team-edit-dialog-loader.tsx:60`, `team-entry-submit.ts:121` (+ pass-through `use-team-base-form-model.ts`) — all pass `teamKeyVersion` with `?? 1` / pass-through; satisfiable.
  - **Edit-after-restore residual (SC6)**: after C1, a stale-version v>=1 entry becomes VIEWABLE, but editing it fails at save — the edit branch reuses the stored ItemKey with latest `teamKeyVersion` and the server re-wrap guard rejects (team-password-service.ts:412-419 → 400 ITEM_KEY_REQUIRED; server defends, no corruption possible). Scope-declared as SC6 (see Scope contract) — the ItemKey re-wrap-on-edit extension is a follow-up; the failure moves from "can't view" to "can view, save rejected", strictly better than today.
  - Non-consumers (unaffected): personal vault decrypt (vault-context, no teamKeyVersion concept), emergency access (grantor-key path, separate module), share links (link-key path). Version-aware branch fires ONLY when `entry.teamKeyVersion >= 1` AND differs from the fetched latest — all callers passing `?? 1` on a team whose latest is 1 hit the existing path unchanged.
- Cache & invalidation contract (explicit):
  - `cacheRef` key becomes `` `${teamId}:${keyVersion}` `` plus a latest-pointer entry `` `${teamId}:latest` `` storing the resolved latest version number; `getTeamEncryptionKey` resolves latest via the pointer.
  - `invalidateTeamKey(teamId)` (team-vault-core.tsx:159) iterates `cacheRef` keys with prefix `` `${teamId}:` `` and deletes all — versioned entries AND the latest pointer — plus the existing `itemKeyCacheRef` clear. Rotation (team-rotate-key-button) already calls invalidateTeamKey; no caller change needed.
  - ItemKey cache: versioned (non-latest) ItemKey unwraps are NOT cached (history views are rare; avoids cross-version contamination in `itemKeyCacheRef`, which stays keyed by entryId only).
- Invariants:
  - (app-enforced) The versioned key fetch path is reachable ONLY for the requesting user's own membership (server: `requireTeamMember` + `deactivatedAt: null` + `keyDistributed` — pre-existing, unchanged).
  - (app-enforced) Non-latest TeamKeys are never written to the "latest" cache slot; response keyVersion mismatch → no cache write.
  - (app-enforced, R39) Every exit path of the shared fetch+unwrap helper zero-fills `ecdhPrivateKeyBytes` and `teamKeyBytes`; exactly one `unwrapTeamKey` call site in team-vault-core.
- Acceptance (test placement explicit):
  - **New file `src/lib/team/team-vault-core.crypto.test.tsx`** (jsdom, real WebCrypto — the existing team-vault-core.test.tsx vi.mocks crypto-team/crypto-aad module-wide and cannot host real-crypto cases): real TeamVaultProvider, crypto UNMOCKED, fetch stubbed; fixtures built with real `wrapTeamKeyForMember` (pattern: crypto-team.test.ts:170-230). Cases: (a) history record with `teamKeyVersion = N-1` decrypts via versioned key; (b) v0 ItemKey row with old teamKeyVersion uses old TeamKey directly; (c) `teamKeyVersion = 0` legacy fixture resolves to VERSION 1's key (normalization `<1 → 1`); (d) response-version-mismatch → null, nothing cached; (e) MEMBER_KEY_NOT_FOUND → null.
  - Existing mocked suite (team-vault-core.test.tsx): cache semantics — after latest fetch (1 call) + versioned fetch (2nd call), a further `getTeamEncryptionKey` makes NO 3rd fetch AND returns the identical CryptoKey object from step 1 (fetch-count + key-identity pinned, not decorative); `getTeamKeyInfo` still returns `{key, keyVersion}` under the new key scheme; `invalidateTeamKey` clears versioned entries + pointer.
  - Component test (entry-history-section.test.tsx): history detail fixture with `teamKeyVersion: <old>` asserts `getEntryDecryptionKey` RECEIVES `teamKeyVersion: <old>` (call-arg pin — hardcoding 1 must go red); distinct message on member-key 404.
- Forbidden patterns:
  - pattern: `keyVersion=\$\{` in a template URL outside apiPath helper — reason: URL construction must go through apiPath (R1).
  - pattern: second `unwrapTeamKey(` call site in team-vault-core.tsx — reason: single zeroization implementation (R39).

### C2 — Old-key fetch audit (server)

- `member-key/route.ts`: in the `keyVersionParam` branch ONLY, fetch the team's current `teamKeyVersion` (comparator = `team.teamKeyVersion` — simpler than member-latest and strictly more inclusive: audits more, never less; one extra query confined to the cold versioned branch, hot no-param path stays single-query). When `resolvedKey.keyVersion < team.teamKeyVersion`, emit `logAuditAsync` with action **`TEAM_MEMBER_KEY_OLD_VERSION_READ`** (UPPER_SNAKE per repo convention — dotted names break next-intl flat-key label lookup) and metadata `{ teamId, keyVersion, latestKeyVersion }` (no key material).
  - Latest-version fetch (no param, or param equal to latest) stays un-audited (normal high-frequency path; avoids log flood — only old-version reads are anomaly-relevant for post-rotation forensics).
- Invariants: (app-enforced) audit emission is post-authorization, fire-and-forget via logAuditAsync (never inside a tx — R9 n/a, no tx here).
- Acceptance: route unit test — `?keyVersion=<old>` emits the audit action with `{ teamId, keyVersion, latestKeyVersion }`; latest fetch emits none.
- R12 member-set (re-derived; applies to BOTH new actions `TEAM_MEMBER_KEY_OLD_VERSION_READ` and `TENANT_MEMBER_LOCKOUT_CLEAR`):
  1. **Prisma `enum AuditAction` addition in schema.prisma (:1117) + `ALTER TYPE "AuditAction" ADD VALUE` migration** (pattern: 20260510145100_add_audit_action_passkey_reauth) — without it, outbox drain inserts FAIL at the DB. Shares the branch's migration step with C7's grant migration; `npm run db:migrate` on the dev DB verifies.
  2. Action constant in `src/lib/constants/audit/audit.ts` (style: `TEAM_MEMBER_KEY_DISTRIBUTE`).
  3. Group array membership (team group / tenant group respectively).
  4. en/ja labels in `messages/{en,ja}/AuditLog.json`; coverage tests `src/__tests__/audit-i18n-coverage.test.ts` + `src/__tests__/i18n/audit-log-keys.test.ts` go red until labels land (R12 guard proven real).

### C3 — Tailscale UI help text correction

- `messages/en/TenantAdmin.json` + `messages/ja/TenantAdmin.json`:
  - `tailscaleEnabledHelp` — state the actual boundary: browser access allows any Tailscale-network (CGNAT) source; the tailnet name is verified only for API/token access. Recommend combining with allowed IPs for strict tenant scoping (mirrors docs/security/policy-enforcement.md:49-51).
  - `tailscaleTailnetHelp` — note the tailnet name applies to API/token connections.
- No logic change. Both locales updated together (i18n parity).
- Acceptance: strings match the documented boundary; no internal jargon (Edge/WhoIs/CGNAT unless glossed) in user-facing text (R37); ja uses 保管庫-style natural wording. RT7 exception (declared): wording content has no automated failing-test path — key parity is guarded by existing i18n coverage tests; content is review-gated. Security review confirmed the wording discloses nothing beyond docs/security/policy-enforcement.md.

### C4 — Session-callback 4-field contract + consumer fail-closed hardening

- **The producer-contract test ALREADY EXISTS**: `src/auth.test.ts:775-897` captures the real session callback via NextAuth init args and asserts all four fields on both catch (fail-closed bundle) and success paths — removing `requirePasskey` from the catch bundle is red TODAY. No duplicate suite, no AST-gate fallback (dropped).
- New work scoped to the CONSUMER (`auth-gate.ts:124-132`, currently untested for shape drift):
  - **Bundle-level fail-closed substitution** (upgrade over pin-only, per security review; USER-approved behavior change): **scoped to `valid === true` responses** — if ANY of the four passkey fields is missing from `data.user`, substitute the entire fail-closed bundle (`requirePasskey: true, hasPasskey: false, requirePasskeyEnabledAt: null, passkeyGracePeriodDays: null`) — mirroring src/auth.ts's own catch path — and log a warn (the valid-scope keeps the warn from firing on every invalid session; negative-cache routing ignores passkey fields anyway). Per-field `?? true` explicitly rejected (fragile recombination; the auth.ts comment itself warns a partial set can land in "still in grace" and not block). **Intended cache behavior (recorded)**: the substituted bundle keeps `valid: true` and lands in the positive session cache up to session TTL — a sticky fail-closed block until TTL/invalidation is deliberate (fail-closed persistence, never fail-open; mirrors what happens today when auth.ts's own catch bundle flows through). Update the auth-gate.ts:118-123 comment accordingly.
  - Tests in `auth-gate.test.ts`: for each of the four fields, a session JSON missing that field → SessionInfo carries the full fail-closed bundle (requirePasskey true). Full-shape response → values pass through unchanged (regression pin for existing behavior).
- Acceptance: (a) auth.test.ts contract suite stays green and is cited as the producer guard; (b) dropping a field from a mocked session response flips auth-gate to the blocking bundle (mutation: removing the bundle-substitution branch → tests red).

### C5 — Standalone admin lockout clear + fallback observability

- New route `POST /api/tenant/members/[userId]/clear-lockout`:
  - Authorization: `requireTenantPermission(TENANT_PERMISSION.MEMBER_MANAGE)` (NOT MEMBER_VAULT_RESET — lockout clear is member management, not vault destruction). **Check order (explicit — reset-vault's ordering would invert it): `if (targetUserId === session.user.id) { /* self-target allowed, skip hierarchy */ } else { require isTenantRoleAbove(actor, target) }`** — strict-above returns false for equal roles, so the self case MUST bypass it. Self-target rationale: an admin clearing their own lockout is legitimate recovery (no key-custody conflict, unlike vault reset); still step-up-gated, and R43-assessed as a deliberate bounded widening (route reachable while vault-locked; hijacked-session residual bounded by the per-target 2/day fail-closed cap + untouched Redis unlock throttle).
  - Step-up: `requireRecentCurrentAuthMethod` + `@stepup` annotation (same guard reset-vault uses at route.ts:116-118; the route weakens an active security control). Check step-up client-coverage gate impact at implementation (new route may add a member to the tracked open client class — record in deviation log).
  - Mutation: verify active `TenantMember` row for `(actor.tenantId, targetUserId)` first (lockout fields live on the global `User` model — "tenant scoping" concretely means membership verification, then `User` update by id). Sets `failedUnlockAttempts: 0, accountLockedUntil: null, lastFailedUnlockAt: null` (three fields — parity with `resetLockout()` and vault-reset).
  - Rate limit (RS2, dual-limiter mirroring reset-vault's shape — dropping dual-approval is acceptable ONLY with this): per-admin limiter (5/day) AND **per-target limiter (2/day, `failClosedOnRedisError: true`)**. Rationale: without the per-target cap, a compromised admin can loop clear-lockout to grant a victim's vault unlimited passphrase-guess budget (each clear resets the attempt counter). With the cap, the loop yields at most ~2×threshold extra attempts/day.
  - Do NOT touch the Redis vault-unlock limiter (`rl:vault_unlock:*`) — it is an independent throttle and must survive an admin lockout clear.
  - Audit: `logAuditAsync` action **`TENANT_MEMBER_LOCKOUT_CLEAR`** (UPPER_SNAKE; R12 full registration — constant, group, en/ja labels, coverage tests).
- Fallback observability: in `account-lockout.ts`, extend the two existing `warn` log calls with a stable `metric` field (`{ metric: "lockout_strictest_fallback", reason: "tenant_row_missing" | "fetch_failed" }`) so log-based alerting can key on one name. No new metrics infra (none exists in repo; YAGNI).
- UI: add a "Clear lockout" action to the tenant member management UI ONLY if a natural slot exists next to reset-vault; otherwise API-only this round (record in deviation log). Keep scope minimal.
- Acceptance:
  - Route tests: non-admin 403; ADMIN-targets-OWNER 403 (hierarchy); **OWNER clears own lockout → 200 AND ADMIN clears own lockout → 200 (self-exemption pinned on both sides)**; cross-tenant target 404; stale-auth session → step-up 403; success clears all three fields (mutation asserted); audit emitted; per-admin AND per-target limiters enforced (fail-closed on Redis error for per-target).
  - Existing lockout tests unaffected.

### C6 — Retention registry vs DB RLS ground truth (integration)

- New DB integration test `src/__tests__/db-integration/retention-registry-rls-parity.integration.test.ts`:
  - **Parity logic extracted as a pure function `assertRegistryRlsParity(registry, rlsFreeTables, catalogRows)`** (validateRegistry does NOT cover RLS parity — the new check is separate code; the pure-function boundary is what makes the negative fixture injectable).
  - Query `pg_class.relrowsecurity` (joined via `pg_policies` presence) for every table named in `RETENTION_REGISTRY` entries that carry `globalDelete` semantics (EXPIRY / EXPIRY_GUARDED / EXPIRY_AUDIT_PROVENANCE and the per-tenant kinds' tables).
  - Assert: every table in `RLS_FREE_EXPIRY_TABLES` has `relrowsecurity = false`; every registry EXPIRY-family table NOT in the set has `relrowsecurity = true`.
  - Assert: every registry table exists in the DB (catch renamed-table drift).
- Privileges: `pg_class.relrowsecurity` is readable by any role for visible tables (no superuser needed). If the CI role cannot see a table, the exists-assertion fails loudly — acceptable fail-closed behavior.
- Runs under the existing `npm run test:integration` job (VE1); ci-integration path filters already cover `src/__tests__/db-integration/**`.
- Acceptance (RT7 mutation): negative sub-tests call `assertRegistryRlsParity` with injected fixtures — (a) fake table name, (b) RLS table moved into the rls-free set — both must throw against the real catalog rows; redness proven in-suite.

### C7 — AccessRequest PENDING→EXPIRED sweep

- New retention-registry-adjacent sweep in the retention-gc worker loop (NOT a delete — a status transition), implemented as a small dedicated step `sweepExpiredAccessRequests(client)` invoked each cycle before registry processing:
  - `UPDATE access_requests SET status = 'EXPIRED' WHERE status = 'PENDING' AND expires_at < now()` — static `$executeRaw` template (no interpolated values → injection-free by construction), CAS by construction, idempotent. Runs in-tx with the worker's bypass_rls GUC (RLS-enabled table, NOBYPASSRLS role).
  - **Grant migration (blocking — the worker role currently holds only SELECT, DELETE on access_requests; migration 20260619001000:9)**: new migration `GRANT UPDATE (status) ON TABLE "access_requests" TO passwd_retention_gc_worker;` — column-scoped so the bypass-RLS role can flip status but cannot rewrite tenant_id / requested scope / expires_at / approver fields. Update `scripts/checks/worker-policy-manifest.json` (or whichever gate asserts grants↔code parity) in the same change. Follow R15: role name via the migration's existing dynamic-resolution pattern if one exists (inspect sibling grant migrations).
  - SSoT note: the raw SQL forks the transition from `bulkTransition()` (access-request-state.ts:134-165) because the bulk primitive's bypass guard requires a tenantId predicate a global sweep lacks. Chosen: raw SQL + a comment cross-referencing the MATRIX (PENDING→EXPIRED by SYSTEM, :33-34) + a unit test asserting the SQL's from/to pair is in the MATRIX (parity guard). A SYSTEM-sweep carve-out in `hasScopeUnderBypass` is rejected — relaxing the guard risks route-path callers inheriting it.
  - Audit: one worker-log line with affected count (>0 only). No per-row audit (terminal retention hard-delete records status provenance — registry.ts:345-357).
  - Update the TODO comment in `access-request-state.ts:33` to point at the worker implementation.
- Consumer-flow walkthrough: Consumer A (tenant access-requests list UI) reads `status` and renders EXPIRED via existing badge + labels — **verified present** (access-request-card.tsx outline variant; `arStatusExpired` in messages/{en,ja}/MachineIdentity.json). Consumer B (approve route) already 410s on expired; transition makes the pre-check redundant but harmless — do not remove it (defense in depth).
- Acceptance:
  - **New DB integration test `src/__tests__/db-integration/retention-gc-access-request-expiry-sweep.integration.test.ts`** (the mocked jit-workflow suite cannot host a row-mutation assertion), **connecting as the worker role `passwd_retention_gc_worker`** (a superuser connection would false-green past the missing grant): PENDING row past expiry → one cycle → row status EXPIRED (mutation asserted); PENDING row before expiry unchanged; APPROVED row past expiry unchanged (status filter proven — RT8).
  - State-matrix test already permits PENDING→EXPIRED by SYSTEM — no matrix change; SQL↔MATRIX parity unit test per the SSoT note above.

### C8 — Toolchain pinning

- Root `package.json`: add `"engines": { "node": ">=20" }` — a floor, not a major pin. Rationale: the release workflow intentionally publishes on Node 24.18.0 (release.yml:22, hard-asserted at :72), so `"20.x"` would declare the publish pipeline out-of-contract (EBADENGINE warnings; hard failure under engine-strict). All-workflow sweep performed: app CI jobs use `.nvmrc` (Node 20), env-drift-check floats on 22 (fixed below), release publishes on 24 — `>=20` is the only truthful envelope. Also add `"packageManager": "npm@<version from local `npm -v` on Node 20>"` (no corepack usage anywhere in repo — field is advisory; record chosen value in deviation log).
- `.github/workflows/ci.yml:86` `env-drift-check`: change `node-version: '22'` → `node-version-file: ".nvmrc"` — verified the job has no Node-22-only step (runs `tsx scripts/check-env-docs.ts`, plain node:fs/path).
- `.nvmrc` stays `20` (not patch-pinned): patch pinning forces lockstep bumps for zero reproducibility gain given Docker digest pinning; external review's patch-pin recommendation REJECTED (Anti-Deferral: worst case = patch-level behavioral drift between dev machines; likelihood low; recurring lockstep maintenance cost — documented tradeoff).
- Acceptance: `npm ci` succeeds under Node 20; CI env-drift-check green on .nvmrc Node; `bash scripts/checks/check-publish-toolchain.sh` (if executable standalone) and the version-check CI job unaffected by the new fields.

## Scope contract

- SC1 — 残1 (gate self-test debt, 24 entries incl. 6 security gates): owned by the tracked SC7 extraction follow-up already recorded in `gate-selftest-debt.txt`; separate multi-PR effort, not this branch.
- SC2 — Browser-path Tailscale WhoIs enforcement (real fix beyond wording): owned by the documented intentional boundary (access-restriction.ts:162-175, PR `#651`) and its future revisit; this branch changes only the UI disclosure (C3).
- SC3 — Metrics infrastructure (Prometheus/OTel counters) for lockout fallback: no metrics stack exists in the repo; C5 delivers a stable log key instead. Introducing a metrics stack is out of scope.
- SC4 — Server-side history re-encryption on team key rotation (the alternative fix for 残2): C1 implements lazy old-key decryption instead; bulk re-encryption is a design alternative deliberately not chosen (client-side E2E crypto makes server re-encryption impossible by design; client-driven bulk re-encrypt is a future UX feature).
- SC5 — EXPIRED-status UI polish beyond existing status badge rendering.
- SC6 — ItemKey re-wrap-on-edit for stale-version entries: after C1, editing a restored stale-version v>=1 entry fails at save (server re-wrap guard 400 ITEM_KEY_REQUIRED — server defends, no corruption). The re-wrap extension in team-entry-submit.ts (re-wrap the ItemKey under the latest TeamKey when editData.teamKeyVersion !== latest) is a follow-up; C1 already improves the state from "can't view" to "can view, save rejected".

## Testing strategy

Contract→test mapping (every contract has a failing-test path except declared exceptions):
- C1: new `team-vault-core.crypto.test.tsx` (real WebCrypto) + mocked-suite cache cases + component call-arg pin — RT7 mutations enumerated in-contract.
- C2: route unit test + audit-i18n coverage tests (red until labels).
- C3: RT7 exception declared (review-gated wording; key parity automated).
- C4: existing `src/auth.test.ts` producer suite (already red-proven) + new auth-gate bundle-substitution tests.
- C5: route tests incl. hierarchy / step-up / dual-limiter / mutation assertions.
- C6: db-integration parity test + injected-fixture negatives via pure `assertRegistryRlsParity`.
- C7: db-integration sweep test as worker role + SQL↔MATRIX parity unit test.
- C8: process-gated (`npm ci`, CI green, publish-toolchain check) — declared RT7 exception.

Full gates before commit: `npx vitest run`, `npx next build`, migration check, lint, `scripts/pre-pr.sh` via cache-aware wrapper; `npm run test:integration` for C6/C7; `npm run db:migrate` against the real dev DB for the C7 grant migration (per repo practice).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Team history old-key client decryption | locked |
| C2 | Old-key fetch audit action | locked |
| C3 | Tailscale UI help text correction (en/ja) | locked |
| C4 | Session-callback 4-field contract pin | locked |
| C5 | Admin lockout clear route + fallback log key | locked |
| C6 | Retention registry RLS parity integration test | locked |
| C7 | AccessRequest PENDING→EXPIRED sweep | locked |
| C8 | Toolchain pinning (engines/packageManager/CI) | locked |
