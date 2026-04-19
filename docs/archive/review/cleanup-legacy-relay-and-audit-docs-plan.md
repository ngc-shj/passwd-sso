# Plan: cleanup-legacy-relay-and-audit-docs

Date: 2026-04-19
Plan name: `cleanup-legacy-relay-and-audit-docs`
Branch: `refactor/cleanup-legacy-relay-and-audit-docs`

## Project context

- **Type**: web app (Next.js 16 + Prisma 7 + PostgreSQL 16, multi-tenant SaaS, with a separate browser extension sub-project under `extension/`)
- **Test infrastructure**: unit + integration + production build + lint
  - `npx vitest run` — unit tests
  - `npx vitest run --config vitest.integration.config.ts` — DB integration tests (require running Postgres)
  - `npx next build` — production build
  - `npx next lint` — lint (zero-warning gate in CI)
  - `scripts/pre-pr.sh` — full pre-PR aggregator (9-check)
- **E2E**: none (no Playwright / Cypress in this repo)

This plan only modifies code, tests, and docs — no schema migrations, no DB roles, no new endpoints. The "config-only experts must not push for new test infrastructure" exception does NOT apply here; this repo has full unit + integration coverage already.

## Objective

Three independent cleanups bundled into one PR:

1. **Remove the legacy `PASSWD_SSO_TOKEN_RELAY` postMessage path** from the extension content script. The web app no longer emits this message (it was replaced by `PASSWD_SSO_BRIDGE_CODE` in PR #357 / extension-bridge-code-exchange). The receiver code in the extension is now dead surface that only widens the attack surface and confuses readers.
2. **Update the audit-pipeline documentation** (`docs/security/threat-model.md`, `docs/security/security-review.md`, plus a stale comment in `src/lib/audit-logger.ts`) to match the current implementation. The docs still describe an "in-memory FIFO retry buffer" backed by `src/lib/audit-retry.ts`, but that file no longer exists — application-emitted audit events now flow through the durable `audit_outbox` table and are drained by `src/workers/audit-outbox-worker.ts`.
3. **Clarify the `NIL_UUID` and `audit_logs.userId` semantics in code comments.** Today `NIL_UUID` has three actual use sites in the codebase: (a) primary — RLS-bypass `app.tenant_id` sentinel inside the audit-outbox transaction (`src/lib/audit-outbox.ts:56,74`, `src/lib/tenant-rls.ts:49`, `src/workers/audit-outbox-worker.ts:61`); (b) timing-balanced no-match WHERE filter for anti-enumeration in passkey lookup (`src/app/api/auth/passkey/options/email/route.ts:118`); (c) **residual** — audit `userId` in the MCP refresh-token replay branch (`src/app/api/mcp/token/route.ts:125`), which is inconsistent with the surrounding code that uses `resolveAuditUserId(..., "system")` → `SYSTEM_ACTOR_ID`. Use case (c) is a known inconsistency that should migrate to `SYSTEM_ACTOR_ID` — tracked as an out-of-scope follow-up in this plan. And `audit_logs.userId` is no longer a strict user identifier — it carries actor IDs of any `ActorType` (HUMAN / SERVICE_ACCOUNT / MCP_AGENT / SYSTEM / ANONYMOUS). The full rename `userId → actorId` is **out of scope** for this PR (tracked separately).

## Requirements

### Functional

- F1: Remove `PASSWD_SSO_TOKEN_RELAY` handling from `extension/src/content/token-bridge-lib.ts` and `extension/src/content/token-bridge.js`. After this PR, the extension content script accepts only `PASSWD_SSO_BRIDGE_CODE`.
- F2: Remove the `TOKEN_BRIDGE_MSG_TYPE` constant from `extension/src/lib/constants.ts` and `src/lib/constants/extension.ts`. Remove the re-export from `src/lib/constants/index.ts`. Remove related references from sync tests.
- F3: Remove `legacy token relay (TOKEN_BRIDGE_MSG_TYPE)` describe-block from `extension/src/__tests__/content/token-bridge.test.ts`. Remove the legacy assertion in `extension/src/__tests__/content/token-bridge-js-sync.test.ts`. Remove the `TOKEN_BRIDGE_MSG_TYPE matches between web app and extension` test case from `src/__tests__/i18n/extension-constants-sync.test.ts`.
- F4: Update `docs/architecture/extension-token-bridge.md` to remove the "Migration period (Phase 1)" subsection's claim that `TOKEN_BRIDGE_MSG_TYPE` is still operational, and remove the row referring to it from the validation-checks table and the file-map table.
- F5: Update `docs/security/threat-model.md` §5 item 3 ("In-memory audit retry") to describe the current outbox + worker architecture.
- F6: Update `docs/security/security-review.md` §5 (audit retry section, lines ~210–228) to describe the current architecture.
- F7: Fix the stale comment in `src/lib/audit-logger.ts` (`// or were dropped due to buffer overflow`) — there is no buffer anymore.
- F8: Replace the misleading `NIL_UUID` JSDoc in `src/lib/constants/app.ts`. The new doc names the RLS-bypass `app.tenant_id` use case as primary, names the timing-balanced no-match WHERE filter use as a secondary legitimate pattern, and explicitly notes that audit `userId` placeholders SHOULD use `ANONYMOUS_ACTOR_ID` / `SYSTEM_ACTOR_ID` (the one residual exception in `src/app/api/mcp/token/route.ts:125` is called out as a known follow-up, not as the prescribed pattern).
- F9: Add a clarifying comment near `prisma/schema.prisma` `AuditLog.userId` and near `src/lib/audit.ts` `AuditLogParams.userId` stating that the field carries an actor ID of any `ActorType`. Add a single grep-able TODO marker (`TODO(actorId-rename)`) recording that the column rename is deferred to a future PR.

### Non-functional

- N1: All three of `vitest run`, `next build`, `next lint` MUST pass. Integration tests must also pass (no behavior change, but the audit-outbox integration tests still need to remain green).
- N2: No new dependencies, no schema migrations, no DB role changes.
- N3: The PR diff must be small enough to keep review tractable — no opportunistic refactors outside the three cleanup areas.

## Technical approach

### F1–F4: Legacy relay removal

Strategy: hard-delete, not deprecation period. Justification:

- The web app **no longer emits** `PASSWD_SSO_TOKEN_RELAY`. Verified by absence of `injectExtensionToken` (only `injectExtensionBridgeCode` exists in `src/lib/inject-extension-bridge-code.ts`, used by `src/components/extension/auto-extension-connect.tsx`). The single emitter on the web-app side was already removed in PR #357.
- The legacy receiver is dead code on the extension side: any postMessage with `type: "PASSWD_SSO_TOKEN_RELAY"` could only come from a XSS-injected attacker page running in the same origin as the web app. Keeping the dead handler accepts a bearer token from such an attacker without an exchange step — it widens the trust surface. Removing it tightens it.
- The "Migration period" doc claim that older extensions only listening for `TOKEN_BRIDGE_MSG_TYPE` "will not be able to receive a token" is **already true today** — the web app stopped emitting before this PR, so the user-facing behavior of pre-bridge-code extensions has already broken. Removing the receiver does not change end-user behavior; it only removes the unused acceptance path inside the extension.

What to delete vs. what to keep:

- Delete: `handleLegacyTokenMessage()`, `LEGACY_MSG_TYPE` constant, the legacy if-branch in `handlePostMessage()`, `TOKEN_BRIDGE_MSG_TYPE` export, the legacy test describe block, the legacy sync test assertion, the legacy doc rows.
- Keep (out of scope, do NOT touch in this PR):
  - `POST /api/extension/token` route — different concern (session-based bearer issuance). Whether to also remove this is tracked elsewhere.
  - `TOKEN_ELEMENT_ID`, `TOKEN_READY_EVENT` constants — also `@deprecated` and reference a non-existent `TOKEN_BRIDGE_EVENT`, but their removal is a separate cleanup. Listed in "Out of scope" below.
- TBD in plan review: the `extractStringConst("TOKEN_BRIDGE_MSG_TYPE")` helper sync test currently catches drift between the two repos. After deletion, the constant no longer exists in either file — the test case is removed entirely (not "kept as a regression guard against re-introduction"), because reintroducing the constant would itself be the bug we'd want to flag at review time, not at test time.

### F5–F7: Audit-pipeline doc sync

Strategy: rewrite the offending paragraphs in `threat-model.md` and `security-review.md` to match observed implementation. The new text states:

- All application-emitted audit events flow through the `audit_outbox` table (`src/lib/audit-outbox.ts`).
- `enqueueAudit*()` writes the outbox row in the same DB transaction as the business write (atomicity guarantee).
- A separate worker process (`src/workers/audit-outbox-worker.ts`, run via `npm run worker:audit-outbox` or the `audit-outbox-worker` Docker service) drains `audit_outbox` rows into `audit_logs`.
- On worker failure, rows are retried with exponential backoff (capped at `max_attempts`, default 8). Permanently failed rows are dead-lettered via `writeDirectAuditLog()` emitting an `AUDIT_OUTBOX_DEAD_LETTER` audit_log entry, AND via the pino `deadLetterLogger`.
- The worker's own meta-events (`AUDIT_OUTBOX_REAPED`, `AUDIT_OUTBOX_RETENTION_PURGED`, `AUDIT_OUTBOX_DEAD_LETTER`, `AUDIT_DELIVERY_DEAD_LETTER`) bypass the outbox and write directly via `writeDirectAuditLog()` because they describe the outbox itself; an outbox failure must not block the worker from reporting the outbox failure (avoids R13: re-entrant dispatch loop).
- The existing `audit_chain` mechanism (`src/lib/audit-chain.ts` + `prisma/migrations/20260413110000_add_audit_chain/`) provides tamper-evident hash chaining of `audit_logs` rows; verification is exposed via `/api/maintenance/audit-chain-verify`. This is already-implemented hardening on top of the durable outbox.
- External-sink delivery is supported via the pluggable `AuditDeliverer` interface in `src/workers/audit-delivery.ts` (webhook / HEC / S3-object). Use the **full** path `src/workers/audit-delivery.ts` in the doc rewrite (NOT bare `audit-delivery.ts`).
- AUDIT_OUTBOX_DEAD_LETTER metadata includes a 256-char truncated `lastError` from the failing write (see `src/workers/audit-outbox-worker.ts:451`); this is intended for operator diagnostics and bypasses the standard `METADATA_BLOCKLIST`. Adding blocklist scrubbing to `lastError` is tracked as a follow-up — call this out in the doc so readers do not infer that dead-letter rows are blocklist-scrubbed.
- Further compliance-grade hardening (e.g., external WORM-backed sink) is **not implemented** in this repo. If cited, qualify it as "not implemented".
- `src/lib/audit-retry.ts` does NOT exist in this codebase — any doc that names it is stale.

`audit-logger.ts` comment fix: the `deadLetterLogger` JSDoc currently says "or were dropped due to buffer overflow" — there is no buffer; just delete that clause and replace it with "or whose tenantId could not be resolved". Verified against `src/lib/audit.ts:212-217` and `:221-224`.

### F8–F9: NIL_UUID / actorId clarification

Strategy: comment-only changes. No symbol renames, no signature changes. **In-scope for this PR only**: comments in `src/lib/constants/app.ts`, `prisma/schema.prisma`, and `src/lib/audit.ts`. The mcp/token/route.ts:125 inconsistency is out of scope but noted in §"Out of scope" below.

- `src/lib/constants/app.ts` `NIL_UUID` JSDoc — rewrite to (preserve the existing first-line RFC citation, then add new content below):
  > Nil UUID (RFC 4122 §4.1.7).
  >
  > **Note**: previously this constant was documented as the audit `userId` placeholder; that guidance was superseded in 2026-04 by `ANONYMOUS_ACTOR_ID` / `SYSTEM_ACTOR_ID`. The single residual call site (`src/app/api/mcp/token/route.ts:125`) is tracked as TODO(actorId-rename).
  >
  > Used as:
  > - **Primary**: RLS-bypass sentinel for `app.tenant_id` GUC inside transactions that need to write across tenant boundaries (audit outbox, worker meta-events, integration test helpers). See `src/lib/audit-outbox.ts`, `src/lib/tenant-rls.ts`, `src/workers/audit-outbox-worker.ts`.
  > - **Secondary**: Timing-balanced no-match WHERE filter for anti-enumeration database probes (e.g., dummy passkey lookup in `src/app/api/auth/passkey/options/email/route.ts`). The all-zero structural UUID guarantees no row matches while preserving the query's wall-clock cost. This relies on the invariant that `users.id` is generated via `gen_random_uuid()` (UUIDv4) and therefore can never equal `NIL_UUID` — **structural impossibility**, since UUIDv4 forces version nibble `4` and variant bits `10`, while `NIL_UUID` has both set to zero. The guarantee carries through `webAuthnCredential.userId` (and any other table) via the FK constraint to `users.id`.
  >
  > **NOT prescribed for audit `userId` placeholders.** Use `ANONYMOUS_ACTOR_ID` / `SYSTEM_ACTOR_ID` (defined below) — those are valid UUIDv4-structural sentinels and are listed in `SENTINEL_ACTOR_IDS` for filter exclusion in human audit-log views.
- `prisma/schema.prisma` `AuditLog.userId` — add a `///` triple-slash doc comment block above the field stating the actorId semantics. Verified: Prisma 7 already uses `///` extensively in this schema (e.g., `Session.authMethod`, `RefreshToken.familyId`), so this is the established pattern, no fallback needed.
- `src/lib/audit.ts` `AuditLogParams.userId` — add a JSDoc above the field with the same statement.
- TODO marker — embed the literal string `TODO(actorId-rename)` in the comments at all three sites (NIL_UUID JSDoc, schema, audit.ts). This makes future cleanup grep-able. The marker text:
  > `TODO(actorId-rename): rename audit_logs.userId column to actor_id (and corresponding TS field). Tracked separately — out of scope for this PR.`

## Implementation steps

**Commit grouping (R-F5)**: Steps 2–4 MUST land in a single commit titled `refactor(extension): remove legacy PASSWD_SSO_TOKEN_RELAY postMessage path` to avoid a transient broken-build state at any commit boundary (deleting the constant exporter before deleting the test importers would break vitest module load). Steps 5–10 may each be their own commit (independent files).

1. **Branch creation.** From clean main, create `refactor/cleanup-legacy-relay-and-audit-docs`.
2. **F1 — Extension content script (TS+JS pair, edit both per `project_extension_parallel_impl.md`):**
   - `extension/src/content/token-bridge-lib.ts`: remove `TOKEN_BRIDGE_MSG_TYPE` import; remove `handleLegacyTokenMessage()`; remove the legacy if-branch in `handlePostMessage()`; rewrite the JSDoc that names two message types.
   - `extension/src/content/token-bridge.js`: remove `LEGACY_MSG_TYPE` var; remove `handleLegacyTokenMessage()` function; remove the legacy if-branch; rewrite the head-comment listing supported message types.
3. **F2 — Constants:**
   - `extension/src/lib/constants.ts`: delete the `TOKEN_BRIDGE_MSG_TYPE` line (line 7). Also touch up the surrounding comment block (lines 1–12): drop the "New token bridge: postMessage…" framing on line 6 (the line being deleted), and rephrase the "Bridge code flow" comment so it stands alone without a contrasting "legacy"/"new" distinction.
   - `src/lib/constants/extension.ts`: delete the `TOKEN_BRIDGE_MSG_TYPE` line (line 9) and its preceding section comment (lines 7–9). Rephrase the comment for `BRIDGE_CODE_MSG_TYPE` (lines 11–13) to stand alone — drop "Replaces TOKEN_BRIDGE_MSG_TYPE for new clients" since no "legacy" branch exists anymore.
   - `src/lib/constants/index.ts`: remove `TOKEN_BRIDGE_MSG_TYPE` from the re-export list (the line within the lines 37–45 export block).
4. **F3 — Tests:**
   - `extension/src/__tests__/content/token-bridge.test.ts`: **first port the three security/guard tests to bridge-code shape** (placed inside the surviving `bridge code exchange` describe block or as a sibling `describe("shared guards", …)` block):
     - `it("rejects bridge code message from a different origin", …)` using `makeEvent({ type: BRIDGE_CODE_MSG_TYPE, code: VALID_CODE, expiresAt: 123 }, window, "https://evil.com")`; assert `false`; assert `mockFetch` not called.
     - `it("rejects bridge code message with wrong type", …)` using `{ type: "OTHER_MSG", code: VALID_CODE, expiresAt: 123 }`; assert `false`; assert `mockFetch` not called.
     - `it("does not respond to bridge code messages with invalid type (oracle prevention)", …)` using `{ type: "WRONG" }` from a different source; assert `chrome.runtime.sendMessage` not called AND `mockFetch` not called.

     Then delete the entire `describe("legacy token relay (TOKEN_BRIDGE_MSG_TYPE)", …)` block (lines 46–107). Remove the `TOKEN_BRIDGE_MSG_TYPE` import on line 7.
   - `extension/src/__tests__/content/token-bridge-js-sync.test.ts`: remove `TOKEN_BRIDGE_MSG_TYPE` from the import statement (line 3); delete the `it("keeps hardcoded legacy MSG_TYPE aligned …")` test case (lines 8–11).
   - `src/__tests__/i18n/extension-constants-sync.test.ts`: remove the `TOKEN_BRIDGE_MSG_TYPE matches between web app and extension` it-block (lines 53–55) and remove `TOKEN_BRIDGE_MSG_TYPE` from the import statement (line 24). Rewrite the file's leading JSDoc (lines 11–14): replace "covers the legacy string constant in the bundled JS" with "covers `BRIDGE_CODE_MSG_TYPE` in the bundled JS" (forward-looking; do NOT use past tense — past tense would describe deleted behavior).
5. **F4 — Architecture doc:**
   - `docs/architecture/extension-token-bridge.md`:
     - Validation-checks table row (line 146): drop the `(or legacy PASSWD_SSO_TOKEN_RELAY)` clause.
     - File-map table row for `src/lib/constants/extension.ts` (line 213): remove `TOKEN_BRIDGE_MSG_TYPE (legacy)`.
     - "Migration period (Phase 1)" subsection (lines 223–229) and the legacy-POST telemetry paragraph (lines 231–233): rewrite to a single shorter paragraph that says (a) the postMessage relay path has been removed in this PR, (b) the `POST /api/extension/token` legacy endpoint and its `event: extension_token_legacy_issuance` telemetry remain operational and continue to feed the eventual endpoint-removal decision, (c) cleanup of that endpoint is tracked separately.
     - The "old direct token (legacy)" column in the threat-model attack-vector table (lines 195–204): keep the column for historical context. Insert one sentence as a paragraph **immediately following the table** (between the table and the next `## File Map` heading): "After the 2026-04 cleanup the postMessage column is no longer reachable from any in-tree code; the column is retained for historical comparison."
6. **F5 — Threat model:**
   - `docs/security/threat-model.md` §5 item 3: replace the entire bullet with the new outbox-architecture description (see Technical approach §F5).
7. **F6 — Security review:**
   - `docs/security/security-review.md` lines ~214–228: rewrite the "Audit write failures do not break primary operation" subsection. Remove references to `src/lib/audit-retry.ts`. Replace the in-memory FIFO description with the durable outbox + worker description. Remove the "compliance-hardening would require a durable delivery mechanism" sentence — the durable mechanism is already in place via the outbox table.
   - The replacement compliance paragraph MUST mention all of the following accurate properties (do NOT invent new ones):
     1. The durable `audit_outbox` table guarantees write atomicity with the business operation.
     2. The existing `audit_chain` mechanism (`src/lib/audit-chain.ts` + `prisma/migrations/20260413110000_add_audit_chain/`) provides tamper-evident hash chaining of `audit_logs` rows; verification is exposed via `/api/maintenance/audit-chain-verify`.
     3. External-sink delivery is supported via the pluggable `AuditDeliverer` interface in `src/workers/audit-delivery.ts` (webhook / HEC / S3-object). Use the **full** path `src/workers/audit-delivery.ts` (NOT bare `audit-delivery.ts`).
     4. Further compliance-grade hardening (e.g., external WORM-backed sink) is **not implemented**; if cited, qualify it as "not implemented".
   - Add one sentence immediately before "Conclusion (Section 5)" noting: "AUDIT_OUTBOX_DEAD_LETTER metadata includes a 256-char truncated error string from the failing write; this is intended for operator diagnostics and bypasses the standard `METADATA_BLOCKLIST`. Adding blocklist scrubbing to `lastError` is tracked as a follow-up."
8. **F7 — audit-logger.ts comment:**
   - `src/lib/audit-logger.ts` lines 89–93: remove `or were dropped due to buffer overflow`; replace with `or whose tenantId could not be resolved`.
9. **F8 — NIL_UUID JSDoc:**
   - `src/lib/constants/app.ts` lines 9–17: replace the JSDoc with the new wording (see Technical approach §F8 — wording updated to incorporate F3 supersedes-prefix and S5 gen_random_uuid invariant).
10. **F9 — actorId clarification comments:**
    - `prisma/schema.prisma` line ~974 (`userId String @map("user_id") @db.Uuid` inside `model AuditLog`): add a `///` triple-slash comment block above the field. **Verified pattern**: the schema already uses `///` extensively (e.g., `Session.authMethod` line 44, `RefreshToken.familyId` line 188, `TeamPolicy.maxSessionDurationMinutes` line 1355). No fallback needed.
    - `src/lib/audit.ts` `AuditLogParams.userId` (line 39): add a JSDoc above the field.
    - Both comments include the literal `TODO(actorId-rename)` marker.
11. **Run lint, tests, build:**
    - `npx next lint`
    - `npx vitest run`
    - `npx vitest run --config vitest.integration.config.ts` (requires `docker compose up -d db` if not running)
    - `npx next build`
    - All four must pass.

## Testing strategy

- **F1–F3 (extension)**: existing test file `extension/src/__tests__/content/token-bridge.test.ts` will lose 7 test cases (the `legacy token relay` describe block) and retain the 8 `bridge code exchange` cases. **However**, three of the deleted tests cover SHARED `handlePostMessage` guards (cross-origin rejection, unknown-message-type rejection, oracle-prevention behavior on invalid messages) that the bridge-code describe block does NOT exercise. To avoid a real coverage regression on security-critical guards, the three guard tests MUST be re-homed (see Implementation step 4 §F3 first bullet): port them to `BRIDGE_CODE_MSG_TYPE` shape, place them in the surviving describe block (or a sibling `describe("shared guards", …)`), and assert the same silent-drop behavior. Net test count after re-home: 8 (bridge-code-specific) + 3 (shared-guard) = 11 cases retained, vs. the current 15.
- **F2 (sync test)**: removing the `TOKEN_BRIDGE_MSG_TYPE` assertion in `src/__tests__/i18n/extension-constants-sync.test.ts` reduces test count from 4 to 3. The remaining 3 (`BRIDGE_CODE_MSG_TYPE`, `BRIDGE_CODE_TTL_MS`, `BRIDGE_CODE_MAX_ACTIVE`) still guard against drift on every constant the runtime depends on.
- **F4–F8 (docs and comments)**: no functional behavior change; the only verification is `next build` succeeds (catches Prisma schema syntax errors from the `///` doc comment) and `next lint` reports no new warnings.
- **F5–F7 (audit doc sync)**: also a doc-only change. We do NOT add test cases — the change is asserting that the docs match the implementation, and the audit-outbox integration tests already validate the implementation behavior. Adding doc-validation tests would be over-engineering.
- **Pre-PR check**: run `bash scripts/pre-pr.sh` if present, to mirror CI gates locally.

## Considerations & constraints

### Risks

- **R0 (security hardening, not a risk)**: Removal converts what was a one-postMessage token leak under XSS (legacy: attacker captures the bearer in a single message handler) into a multi-step exchange that the attacker must complete before token expiry (current: attacker must trigger the bridge-code-issue endpoint, intercept the code, and complete the exchange at `/api/extension/token/exchange` before either expiry or the **server-side** single-use UPDATE consumes it — single-use enforcement is server-side, not in the extension). Document this in the PR commit message body.
- **R1 (low)**: An extension user running an *old* extension build (pre-bridge-code) loses the ability to connect to a server running this version of the web app. **Mitigation**: this regression already exists today (the web app stopped emitting `PASSWD_SSO_TOKEN_RELAY` in PR #357). This PR removes only the receiver, so end-user behavior is unchanged. The fix for affected users is to update the extension.
- **R2 (low)**: A future contributor reads the deleted `PASSWD_SSO_TOKEN_RELAY` symbol in a log line or audit trail and is confused. **Mitigation**: a single sentence in the commit message describing the removal anchors the search trail. The CHANGELOG (auto-generated by release-please from the commit message) preserves the breadcrumb.
- **R3 (resolved)**: Originally suspected the `///` Prisma triple-slash comment on `AuditLog.userId` could cause a `prisma validate` warning. **Verified false**: Prisma 7 supports `///` as the standard doc-comment syntax, and the project's schema already uses it on at least three other fields. No mitigation needed.
- **R4 (very low)**: A reader of `docs/security/security-review.md` after the rewrite may interpret "the durable mechanism is in place" as a compliance attestation. **Mitigation**: phrase carefully — "the durable in-DB outbox is in place; certifications still require external sink integration." Avoid claims like "audit-compliant".

### Out of scope

- `POST /api/extension/token` legacy endpoint removal — tracked separately. Web-side emitter is gone; the endpoint's other callers (if any) need to be confirmed before removal.
- `TOKEN_ELEMENT_ID` and `TOKEN_READY_EVENT` constant removal — these are also `@deprecated` and reference a non-existent `TOKEN_BRIDGE_EVENT`. Belongs in a follow-up cleanup.
- **MCP refresh-token replay audit `userId` consistency fix** (`src/app/api/mcp/token/route.ts:125`) — currently passes `NIL_UUID`, should pass `SYSTEM_ACTOR_ID` (or `resolveAuditUserId(null, "system")`) to match the success branch on line 139 and to be filterable via `SENTINEL_ACTOR_IDS`. This is a one-line code fix in an UNCHANGED file (not in this PR's diff), so it falls under [Adjacent] / out-of-scope rather than the pre-existing-in-changed-file rule. Tracked as a follow-up; the TODO(actorId-rename) marker in F9 will remain grep-able after the rename PR replaces the column.
- `audit_logs.userId → actor_id` column rename and TS field rename — large change touching prisma migrations, all callers, and grep patterns. Planned for a future PR (issue to be filed). The TODO marker added by F9 is the breadcrumb.
- Renaming `src/__tests__/audit-fifo-flusher.test.ts` (the file itself is a stale name from the FIFO era — its tests now correctly verify outbox routing). Renaming requires updating CI test discovery patterns; not worth the diff. Listed here as a known stale name, not a deferred task.

### Why no regression-guard test for `TOKEN_BRIDGE_MSG_TYPE` re-introduction

Local LLM pre-screening Minor #4 suggested adding a test that asserts the constant is absent. We deliberately do NOT add such a test. Rationale: nothing else in the tree imports `TOKEN_BRIDGE_MSG_TYPE` after this PR, so any reintroduction (a new `import { TOKEN_BRIDGE_MSG_TYPE }` line) would either fail at compile time (missing export) or be obviously dead code on review. A "constant must not exist" test is a tautology layer over the build itself — it adds maintenance burden without catching anything the build doesn't catch. If we accidentally re-export the constant from `extension/src/lib/constants.ts` years from now, the resulting unused export would be flagged by the project's lint rules (or by a reviewer noticing a dead symbol), not by a test snapshotting absence.

### Repo-wide reference enumeration (verified)

Local LLM pre-screening Minor #1 asked for an explicit "search the entire repo" step. Verified: `grep -n TOKEN_BRIDGE_MSG_TYPE` across all source/test/active-doc files yields the following 8 active locations (all already covered in §Implementation steps 2–4):

1. `extension/src/lib/constants.ts:7`
2. `extension/src/content/token-bridge-lib.ts:2,82,99`
3. `extension/src/__tests__/content/token-bridge.test.ts:7,46-107` (entire describe block)
4. `extension/src/__tests__/content/token-bridge-js-sync.test.ts:3,8-11`
5. `src/__tests__/i18n/extension-constants-sync.test.ts:24,53-55`
6. `src/lib/constants/extension.ts:9,12`
7. `src/lib/constants/index.ts:40`
8. `docs/architecture/extension-token-bridge.md:213,225,227`

Hits in `docs/archive/review/extension-bridge-code-exchange-{plan,review}.md` are **historical archive documents** and MUST NOT be modified — they record the design context at the time the bridge-code path was introduced, not the current state.

### Constraints

- C1: Keep the diff to the listed files only. No opportunistic refactor.
- C2: Do not commit on `main`. All work goes on `refactor/cleanup-legacy-relay-and-audit-docs`.
- C3: Do not amend pushed commits. Each phase makes its own commit.
- C4: English-only branch name and commit messages (per global rules).
- C5: The `audit-fifo-flusher.test.ts` file name remains as-is — flagged here only as documentation of a known legacy artifact.

## User operation scenarios

This PR has near-zero user-facing change — it is removal of dead code and doc sync. Scenarios to confirm during code review:

1. **Web-app login on a fresh extension install**: User logs into the web app, the extension auto-connects via `injectExtensionBridgeCode()`. Expected: identical behavior to before this PR (extension receives token via the bridge-code exchange path).
2. **Web-app login with the extension closed**: Web app emits a single `PASSWD_SSO_BRIDGE_CODE` postMessage; nobody receives it; the bridge code expires after 60s. Expected: identical to before this PR.
3. **Old extension version (pre-bridge-code) on the new web-app build**: Web app emits `PASSWD_SSO_BRIDGE_CODE` only; old extension only listens for `PASSWD_SSO_TOKEN_RELAY`; no token transfer occurs. Expected: this is the existing post-PR-#357 behavior; this PR does not regress it further.
4. **Page hosting a malicious script that sends `PASSWD_SSO_TOKEN_RELAY` postMessage**: Before this PR, the extension would accept and forward the token (security concern). After this PR, the extension silently drops the message. Expected: tightens trust surface.
5. **Audit outbox worker stopped**: Audit events accumulate in `audit_outbox` with status `PENDING`. The web app continues to function. Documentation now correctly describes this state instead of "in-memory buffer overflow". Expected: behavior unchanged; only the doc explanation matches reality.
6. **Audit outbox worker dead-letters a row**: Worker writes an `AUDIT_OUTBOX_DEAD_LETTER` row directly via `writeDirectAuditLog()` AND emits a `deadLetterLogger.warn(...)`. Expected: behavior unchanged; documentation now mentions both surfaces instead of only the in-memory dead-letter path.
