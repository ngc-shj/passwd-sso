# Handoff: step-up client reauth — lateral expansion (横展開)

## Status at handoff (2026-07-01)

Two pieces of work on branch `fix/admin-vault-reset-approve-stepup`:

### Piece A — reset-vault M1/M2/F2 (DONE, uncommitted, verified)
Triangulate review of an external security report on the admin vault reset
dual-approval flow. All applied, all green (vitest 11921 pass, `next build` ok,
`pre-pr.sh` 40 checks pass). NOT yet committed. 7 files changed:

- `src/app/api/tenant/members/[userId]/reset-vault/[resetId]/approve/route.ts`
  — M1: added `requireRecentCurrentAuthMethod(req)` step-up, placed AFTER
  eligibility checks, BEFORE the rate-limit block (so a stale session does not
  burn the low per-target limiter).
- `src/components/settings/security/tenant-reset-history-dialog.tsx`
  — M1 client: `useInlineReauth` wired into approve handler (403
  SESSION_STEP_UP_REQUIRED -> triggerOnStaleError -> retry). Simplified to the
  plain-closure convention (no submitRef/useRef apparatus).
- `src/components/settings/security/tenant-vault-reset-button.tsx`
  — F2: same wiring on the initiate button (it was already server-side
  step-up-gated but the client had no reauth path — a pre-existing prod bug).
- `src/app/api/tenant/members/[userId]/reset-vault/route.ts`
  — M2: comment documenting the intentional view(permission-gate)/action
  (hierarchy-gate) authz split on GET. No behavior change (M2 is NOT a real
  gap — no secret leak, cross-rank read is the codebase norm).
- 3 test files: approve step-up denial test (RT8: 403 + limiter/decrypt/
  updateMany/notification/email all not-called) + ordering test; GET M2 intent
  test (cross-rank read 200 + insufficient_role); button test next-intl
  `useLocale` mock added.

**DECISION: Piece A goes in its OWN PR first.** Commit + `/pr-create` this.
Do NOT bundle Piece B into it.

### Piece B — lateral expansion (NOT STARTED, next session's work)
Same bug class as F2: routes that enforce server-side step-up but whose UI
caller does NOT handle the SESSION_STEP_UP_REQUIRED 403 (generic error toast,
no reauth recovery path — a UX dead-end on a stale session).

**This goes on a SEPARATE branch + SEPARATE PR.** User instruction.

## Piece B — verified gap list (8 REAL gaps, already triple-checked)

Two false positives already eliminated during verification:
- `share-dialog.tsx` — only does GET teamPolicy, no mutating step-up call. NOT a gap.
- `operator-token-card.tsx` — already has a custom-but-correct reauth flow. NOT a gap.

Reference implementation to copy: `src/components/settings/developer/api-key-manager.tsx`
(line 91 `useInlineReauth(() => handleCreate())`, lines 159-160 the 403 branch,
lines 214-218 the two dialogs render). Convention is INLINE per-component (7
existing consumers all inline — do NOT extract a shared wrapper). Use the
plain-closure form `useInlineReauth(() => handler())`, NOT a useRef/submitRef
apparatus (reverted in Piece A as unnecessary — the hook memoizes nothing, so a
fresh closure each render always captures the latest handler).

| # | Component | Route/method | fetchApi line(s) | current 403 handling | cancelLabel |
|---|-----------|--------------|------------------|----------------------|-------------|
| 1 | src/components/settings/developer/directory-sync-card.tsx | PUT+DELETE directory-sync/[id] | PUT:202, DELETE:254 | generic `t("syncFailed")` | `tCommon("cancel")` (imported) or `DirectorySync.cancel` |
| 2 | src/components/team/security/team-rotate-key-button.tsx | POST rotate-key | 241 | generic `t("rotateKeyFailed")` | `Teams` has NO `cancel` — add `useTranslations("Common")` -> `tCommon("cancel")`, or reuse `Teams.rotateKeyCancel` |
| 3 | src/components/team/members/team-add-from-tenant-section.tsx | POST teams/[teamId]/members | 85 | throws -> catch -> `t("addMemberFailed")` | `t("cancel")` (Team has cancel) |
| 4 | src/components/breakglass/breakglass-dialog.tsx | POST tenant/breakglass | 91 | generic apiError toast (else) | `tc("cancel")` = Common.cancel (wired line 238) |
| 5 | src/components/breakglass/breakglass-grant-list.tsx | DELETE tenant/breakglass/[id] | 81 (handleRevoke) | generic apiError toast | `tc("cancel")` = Common.cancel (wired line 215) |
| 6 | src/components/settings/security/passkey-credentials-card.tsx | DELETE+PATCH webauthn/credentials/[id] | DELETE:260, PATCH:276 | `t("deleteError")` / `t("nicknameUpdateError")` | `t("cancel")` (WebAuthn has cancel) |
| 7 | src/components/settings/developer/audit-delivery-target-card.tsx | POST + PATCH(toggle) tenant/audit-delivery-targets[/[id]] | POST:182, PATCH:203 | `t("createFailed")` / `t("updateFailed")` | `tCommon("cancel")` (wired) |
| 8 | src/app/[locale]/vault-reset/page.tsx | POST vault/reset | 39 | inline `setError(...)` string | `tCommon("cancel")` (wired). Standalone full-page form, not dialog-in-card — wire dialogs into page JSX; locale provider already present |

Notes:
- #2: rotate-key POST takes no per-row arg, so `() => handleRotate()` suffices.
- #6 has TWO mutating step-up methods (DELETE delete-credential, PATCH rename);
  both handlers (handleDelete:260, handleRename:276) need the 403 branch. Either
  a small retry-target state (like access-request-card's reauthApproveTargetId)
  or two handlers each calling triggerOnStaleError — judge during impl.
- #8 is a page not a card; render the two reauth dialogs in page JSX.
- The PRF-rebootstrap POST in #6 (webauthn/credentials/[id]/prf, lines 358/399)
  is NOT step-up-gated — out of scope.

## Per-component fix recipe
1. imports: `useInlineReauth` from `@/hooks/auth/use-inline-reauth`;
   `RecentSessionRequiredDialog` from `@/components/auth/recent-session-required-dialog`;
   `PasskeyReauthDialog` from `@/components/auth/passkey-reauth-dialog`;
   `readApiErrorBody` from `@/lib/http/read-api-error-body`;
   `API_ERROR` from `@/lib/http/api-error-codes`.
2. `const inlineReauth = useInlineReauth(() => handler());` (lazy closure above handler).
3. In the 403 branch: `const body = await readApiErrorBody(res); if (body?.error
   === API_ERROR.SESSION_STEP_UP_REQUIRED) { await inlineReauth.triggerOnStaleError();
   return; }` then fall through to existing generic error.
4. Render both dialogs in JSX with `cancelLabel={...}` from the table.
5. Tests: rendering the component pulls in RecentSessionRequiredDialog -> internal
   `useLocale()`. If a test mocks `next-intl` without `useLocale`, add
   `useLocale: () => "en"` (exact fix needed in Piece A's button test). Add a
   step-up denial test per component (RT8): 403 SESSION_STEP_UP_REQUIRED ->
   triggerOnStaleError path, mutation not committed.

## Verification gates
- `npx vitest run` (full) ; `npx next build` ; `bash scripts/pre-pr.sh` (40 checks)
- Security boundary (step-up) -> re-run affected route/component tests explicitly (R21).

## Recommended next-session entry point
Start at triangulate Phase 2 (coding) with THIS list as the finalized plan —
discovery + verification (Phase 1) already done and recorded above. Do NOT redo
the Explore/verify fan-out. After Piece A's PR is up:
`git checkout main && git pull && git checkout -b fix/step-up-client-reauth-lateral`
then implement #1-#8, test, build, pre-pr, one PR.
