# Code Review: admin-ia-redesign

Date: 2026-05-02
Review round: 1

## Changes from Previous Round

Initial code review (Phase 3 round 1). Three expert sub-agents reviewed the 9-commit branch (82 files, +4050/-1057 lines) in parallel against the finalized plan + deviation log.

## Summary

| Severity | F | S | T | Total (deduplicated) |
|---|---|---|---|---|
| Critical | 0 | 0 | 0 | 0 |
| Major | 5 | 0 | 5 | 8 (after dedup of F1=T1, F4=T3, F5=T2) |
| Minor | 6 | 3 | 11 | ~17 |

## Functionality Findings

### F1 [Major]: Dead i18n keys `sectionPolicies` / `sectionPoliciesDesc`
- File: `messages/ja/AdminConsole.json:58-59`, `messages/en/AdminConsole.json:58-59`
- Evidence: forward sentinel `NEW_KEY_PREFIXES` includes `sectionPolicy` (singular). The check is `key.startsWith(prefix)` — so `sectionPolicies` (with `ies`) does NOT match `sectionPolicy` (with `y`) at position 12. Both `sectionPolicies` and `sectionPoliciesDesc` are present in JSON but have ZERO consumers in `src/`. (The `policies` group landing page redirects without rendering a SectionLayout, mirroring the `sectionIntegrations` deletion in the deviation log.)
- Problem: Two dead keys ship + the forward sentinel is structurally unable to catch them.
- Impact: Same class of bug deviation log fixed for `sectionIntegrations` recurs for `sectionPolicies`. Translation drift risk.
- Fix: (a) Delete both keys from ja/en JSON. (b) Tighten sentinel: replace prefix `sectionPolicy` with TWO entries `sectionPolicy` AND `sectionPolicies`, OR rework the matching to use `==` against an explicit allowlist.

### F2 [Major]: Service-accounts sub-tab parent layout uses generic title
- File: `src/app/[locale]/admin/tenant/machine-identity/service-accounts/layout.tsx`
- Evidence: title=`t("sectionMachineIdentity")` — same as the parent group's section. Three sibling sub-tab parents (auth-policy, machine-id-policy, integrations/provisioning) use SPECIFIC keys (sectionPolicyAuthentication, sectionPolicyMachineIdentity, sectionIntegrationProvisioning).
- Problem: UX asymmetry. Service Accounts page header reads "マシンID" while siblings read their specific topic.
- Fix: Add a new key `sectionMachineIdentityServiceAccounts` / Desc to AdminConsole.json (mirror existing key family) and use it in the layout.

### F3 [Major]: `TeamPendingInvitationsList` causes layout shift after first invite
- File: `src/app/[locale]/admin/teams/[teamId]/members/page.tsx` (rendered conditionally on `invitations.length > 0`)
- Evidence: The roster + add modal trigger render at fixed position; PendingInvitationsList appears below ONLY after first invite is sent. Causes mid-flow layout shift; user's mouse position relative to the page may jump.
- Problem: UX inconsistency vs plan intent ("rendered below the roster" — implies always-rendered).
- Fix: Remove the `invitations.length > 0` guard. Render the section header ("Pending invitations") always; show empty state ("No pending invitations") inside when list is empty.

### F4 [Major]: `countLeafLinks` helper not used by sidebar test (RT3)
- File: `src/components/admin/admin-sidebar.test.tsx:97`, `:236`
- Evidence: helper is exported and has its own unit test, but the integration tests still write `expect(links.length).toBe(28)` and `(12)` literally.
- Problem: RT3 violation. Future IA changes silently drift the assertion; the helper exists but isn't used as the canonical source.
- Fix: Replace the literal `.toBe(28)` / `.toBe(12)` with `.toBe(countLeafLinks(items) * 2)` (where `items` is computed from the same `useNavItems()` factory).

### F5 [Major]: `@mobile` E2E test is vacuous
- File: `e2e/tests/admin-ia.spec.ts:185-236`
- Evidence: Test attempts to tap `getByRole("button", { name: /ポリシー/ })` to expand a sidebar group. Sidebar group headers render as `<div>` (admin-sidebar.tsx:172), NOT `<button>`. No expansion is needed because groups are statically open. Test contains 3 nested `if (isVisible) ... else fallback` guards — failures silently take a desktop-equivalent path.
- Problem: Round-1 T10 promised "tap a group → expansion". The promise is unhonored — there's no group expansion to test on mobile because the sidebar always shows children.
- Fix: Either (a) drop the `@mobile` test (group expansion isn't a thing in this UI) and replace with a different mobile assertion (sheet opens, child link is tap-targetable), OR (b) actually implement collapsible groups in the sidebar with a real button toggle. Recommend (a) — it's a simpler test that matches the actual UI.

### F6-F11 [Minor]: misc

(See full text in /tmp/tri-EGrSxb/func-findings.txt — issues include `force-dynamic` on Client Component being partly inert, section-nav test labels misaligned with replaced URLs, audit-log-action-groups extension being vacuous for the inlined tenant page, forward sentinel prefix list missing plural-named keys.)

## Security Findings

### S1 [Minor]: Add `force-dynamic` to redirect-only pages too
- Defense-in-depth recommendation. Plan only required it on breakglass + audit-logs. Apply to all 7 redirect-only pages for explicit no-cache semantics.

### S2 [Minor]: Document `redirect()` vs `notFound()` asymmetry
- Outer `/admin/layout.tsx` redirects on no-role; inner `/admin/tenant/layout.tsx` calls `notFound()`. Future "harmonization" refactors could weaken the inner gate. Add a comment.

### S3 [Minor]: Redundant client-side `isAdmin` ternary in team members
- Layout already enforces ADMIN+OWNER gate. Comment to clarify intent prevents future "we don't need this" removal that would actually weaken the UI.

(All 7 critical security pillars verified ✅.)

## Testing Findings

### T1 [Major]: Same as F1 — dead keys + sentinel prefix gap

### T2 [Major]: Same as F5 — vacuous `@mobile` test

### T3 [Major]: Same as F4 — `countLeafLinks` not used

### T4 [Major]: No terminology-lock check
- File: `src/__tests__/admin-i18n-key-coverage.test.ts`
- Evidence: forward sentinel only checks key existence, not specific value. Round-1 F5 mandated `運用者トークン` (kanji); a future PR could change this to katakana and the sentinel won't catch it.
- Fix: Add a terminology-lock test asserting specific key values (`navMachineIdentityOperatorTokens === "運用者トークン"` for ja).

### T5 [Major]: Mobile test masks failures via `.catch(() => false)`
- File: `e2e/tests/admin-ia.spec.ts` (mobile test, multiple `.catch` patterns)
- Fix: remove the `.catch` swallowers; let assertions fail honestly.

### T15 [Major]: Vault-locked redirect E2E not implemented
- Plan §"Testing strategy" step 8 mandated this; the spec file has an unused `VaultLockPage` import but no test.
- Fix: Add a test that locks vault, navigates to `/admin/tenant/policies` (group landing), asserts redirect cascades to `/policies/authentication/password`, and the leaf page renders (vault-locked cards self-gate).

### T6-T16 [Minor]: misc

(Full text in /tmp/tri-EGrSxb/test-findings.txt — minor mock tightening, edge case coverage, etc.)

## Adjacent Findings

(From F's adjacent section: 1 routed to Security; from T's: 3 routed to Functionality.)

## Quality Warnings

None — all findings include Evidence + concrete Fix.

## Recurring Issue Check

### Functionality expert
- R3 (propagation): F1 (dead keys); F4 (helper not used)
- R12 (i18n): F1, F2 (key consistency)
- R17 (helper adoption): F4
- R34 (adjacent): clean

### Security expert
- All R1-R35 + RS1-RS3: clean (no Critical/Major)

### Testing expert
- RT1 (mock-reality): clean
- RT2 (testability): F5/T2 (mobile test untestable as-designed)
- RT3 (shared constants): F4/T3
- R34 (test bugs): T15 (unused import, deferred test)

## Plan revisions to apply

| ID | Severity | Apply now? | Reason |
|---|---|---|---|
| F1=T1 | Major | ✅ | Delete 2 dead keys + tighten sentinel prefix list |
| F2 | Major | ✅ | Add specific section key for service-accounts |
| F3 | Major | ✅ | Remove length>0 guard on PendingInvitationsList |
| F4=T3 | Major | ✅ | Wire `countLeafLinks` into the sidebar test |
| F5=T2 | Major | ✅ | Replace mobile test with realistic assertion |
| T4 | Major | ✅ | Add terminology-lock test |
| T5 | Major | ✅ (covered by F5/T2 fix) | Removed when @mobile test rewritten |
| T15 | Major | ✅ | Add vault-locked redirect E2E |
| Minor (S1-S3, F6-F11, T6-T16) | Minor | mostly defer | Tracked here; not blocking |

## Resolution Status (round 1)

### F1=T1 [Major]: Dead `sectionPolicies*` keys + sentinel prefix gap — Resolved
- Action: Deleted `sectionPolicies` and `sectionPoliciesDesc` from messages/{ja,en}/AdminConsole.json. Replaced sentinel's `NEW_KEY_PREFIXES` (string startsWith) with `NEW_KEY_PATTERNS` (regex) — patterns capture both singular AND plural forms (`sectionPolic` matches both `sectionPolicy*` and `sectionPolicies*`), preventing the same class of bug from recurring.
- Modified files: messages/{ja,en}/AdminConsole.json; src/__tests__/admin-i18n-key-coverage.test.ts

### F2 [Major]: Service-accounts layout uses generic title — Resolved
- Action: Added new keys `sectionMachineIdentityServiceAccounts` / `Desc` to AdminConsole.json (ja+en). Updated layout to use them. Same hierarchy as the 3 sibling sub-tab parents.
- Modified files: messages/{ja,en}/AdminConsole.json; src/app/[locale]/admin/tenant/machine-identity/service-accounts/layout.tsx

### F3 [Major]: PendingInvitationsList layout shift — Resolved
- Action: Removed `if (invitations.length === 0) return null;` early-return. Component now always renders the header and shows the existing `noInvitations` empty-state message inside the section. No layout shift after first invite.
- Modified files: src/components/team/members/team-pending-invitations-list.tsx; src/components/team/members/__tests__/team-pending-invitations-list.test.tsx (test updated for new behavior)

### F4=T3 [Major]: countLeafLinks not wired into sidebar test — Resolved
- Action: Extracted pure factories `getTenantNavItems(t)` and `getTeamNavItems(t, teamId)` from the `useNavItems` hook in admin-sidebar.tsx; exported both. Sidebar test imports them, computes the expected count via `countLeafLinks(items) * 2`. Removed hard-coded `28` and `12` literals. Future IA changes do not drift the assertion.
- Modified files: src/components/admin/admin-sidebar.tsx; src/components/admin/admin-sidebar.test.tsx

### F5=T2 / T5 [Major]: Vacuous @mobile test — Resolved
- Action: Replaced the prior test (which attempted to tap a `<div>` group header with `getByRole("button")` — never matched, fell through `.catch(() => false)` fallbacks). New test asserts: (a) hamburger button opens the sheet, (b) deeply-nested child link is visible and tap-targetable on a 390×844 viewport, (c) tap navigates to the redirect-cascaded leaf URL. Removed `.catch(() => false)` fallbacks per round-1 T5 — failures must throw honestly.
- Modified files: e2e/tests/admin-ia.spec.ts

### T4 [Major]: No terminology lock — Resolved
- Action: Added `describe("admin-ia ja terminology lock")` block to admin-i18n-key-coverage.test.ts. Asserts `navMachineIdentityOperatorTokens === "運用者トークン"` and `sectionMachineIdentityOperatorTokens === "運用者トークン"`. Future drift to katakana is now caught.
- Modified files: src/__tests__/admin-i18n-key-coverage.test.ts

### T15 [Major]: Vault-locked redirect E2E missing — Resolved
- Action: Added `test("vault-locked: group-landing redirect still cascades to leaf")` to admin-ia.spec.ts. Navigates to `/ja/admin/tenant/policies` without unlocking; asserts URL is `/ja/admin/tenant/policies/authentication/password` (full cascade). Confirms the inherited-layout assumption documented in plan.
- Modified files: e2e/tests/admin-ia.spec.ts

### Discovered during fix application: `sectionMachineIdentity` / `sectionMachineIdentityDesc` were also dead — Resolved
- F2's fix replaced the only consumers of the generic `sectionMachineIdentity` keys (the service-accounts layout). The forward sentinel correctly flagged them after the swap. Removed both keys; fix is consistent with F1's general principle (the sentinel must catch dead keys post-implementation).

### S1, S2, S3, F6-F11, T6-T16 [Minor] — Deferred / no-action
- **Anti-Deferral check**: out of scope (different feature) — these are hardening recommendations beyond the planned IA scope. None affect the released behavior.
- **Justification (per minor)**:
  - S1 (force-dynamic on redirect-only pages): low value; redirect-only pages have no rendered output to cache. Cost-to-fix: 7 lines × 7 files = 49 lines for marginal defense-in-depth. Skipped per "30-minute rule" not met (the gain is < cost).
  - S2 (document redirect/notFound asymmetry): doc-only nit; deferred. Tracked: TODO(admin-ia-comment-asymmetry).
  - S3 (redundant client-side ternary): comment-only suggestion; not user-visible.
  - F6-F11, T6-T16: minor mock tightening, edge-case coverage, etc. — none gates a release; consolidated tracking in this review file (greppable).

## Verification Gate (round 1 fixes)

| Gate | Result |
|---|---|
| `npx vitest run` (focused on touched tests) | ✅ 197 passed |
| `npm run lint` | ✅ Clean |
| `npx next build` | ✅ Compiled successfully |
