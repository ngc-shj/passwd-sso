# Plan Review: admin-ia-redesign

Date: 2026-05-02
Review round: 1

## Changes from Previous Round

Initial review (round 1). Three expert sub-agents (Functionality, Security, Testing) reviewed the plan in parallel after a local-LLM pre-screening pass. The pre-screen produced 10 findings (1 Critical, 4 Major, 5 Minor); the orchestrator evaluated each — 6 valid (applied to plan), 4 false positives (dismissed with verification). Expert review then operated against the pre-screen-corrected plan.

## Summary of round 1

| Severity | Count (deduplicated) |
|---|---|
| Critical | 2 |
| Major | 11 |
| Minor | 14 |

After deduplication of findings reported by multiple experts (F1/S1/T1 same issue, F2/S2 same issue, F7/T6 same issue, F9/T5 same issue, F10/T8 same issue), the unique finding count is 27.

## Functionality Findings

### F1 [Critical]: Redirect-page test files orphaned by directory deletion

- **File**: plan Batch 2 step 8; existing files at `src/app/[locale]/admin/tenant/{mcp,service-accounts}/__tests__/page.test.tsx`
- **Evidence**: Both test files do `import ... from "../page"` and assert `mockReplace` calls. Plan deletes the parent pages but never enumerates the colocated `__tests__/` directories.
- **Problem**: Vitest fails at import time after Batch 2: "Cannot find module '../page'". Test discovery breaks for the entire suite.
- **Impact**: Every batch-1 verification step (`npx vitest run`) fails; cascading rework.
- **Fix**: In Batch 2, explicitly `git rm` both `__tests__/page.test.tsx` files (their assertions reference URLs that no longer exist). Same applies to any other `__tests__/` directories under deleted parents — enumerate during the implementation grep.

(Same finding reported as S1 + T1.)

### F2 [Critical]: Server-side `redirect()` calls miss the locale prefix

- **File**: plan Batch 2/3/4 redirect snippets, "Default landing for sub-tab pages" table, "Group landing redirect pages" table
- **Evidence**: Plan-introduced redirects use bare `redirect("/admin/tenant/...")`. Existing precedent in `src/app/[locale]/admin/tenant/audit-logs/page.tsx` uses `getLocale()` + `redirect(\`/${locale}/admin/tenant/...\`)`. Personal-IA precedent at `src/app/[locale]/dashboard/settings/page.tsx` uses `redirect({href, locale})` from `@/i18n/navigation`.
- **Problem**: A bare `next/navigation` redirect to a path without `/<locale>/` either (a) gets re-prefixed by next-intl middleware causing two HTTP 307 hops, or (b) bounces an `/en/...` user to the default `ja` locale on the redirect target. Inconsistent with existing project pattern.
- **Impact**: User-visible regression for non-default-locale users. Worst case: middleware loop or 404 if locale routing fails. The 7+ new redirect snippets in the plan would all need re-edit.
- **Fix**: Plan must specify ONE canonical redirect pattern. Recommended: match existing `audit-logs/page.tsx` style — `import { redirect } from "next/navigation"; import { getLocale } from "next-intl/server";` then `redirect(\`/${locale}/admin/tenant/...\`)`. Apply to every redirect snippet in plan and update the implementation tables.

(Same finding as S2.)

### F3 [Major]: Moved leaf pages orphan their SectionLayout wrappers

- **File**: plan Batch 3 step 8/9 (retention, access-restriction); Batch 4 steps 5/6 (webhooks, audit-delivery); Batch 5 step 2 (breakglass); Batch 6 steps 4/5/6 (team policy/key-rotation/webhooks)
- **Evidence**: Existing leaf page files are bare `<Card>` renderers; their SectionLayout wrapper comes from a parent `layout.tsx` (e.g. `tenant/security/layout.tsx`). After `git mv` to new directories, no parent layout exists at the new path, so each moved card renders without `<h1>`, description, or icon.
- **Problem**: 8 pages render as bare cards: tenant retention/access-restriction/webhooks/audit-delivery/breakglass; team policy/key-rotation/webhooks. Visible UX regression. Manual-test scenarios fail.
- **Impact**: E2E tests asserting `getByRole("heading", { level: 1 })` will fail on the affected pages. UI inconsistency between sub-tab pages (which keep their layout) and standalone leaves (which lose theirs).
- **Fix**: Add explicit layout creation steps for every moved leaf page. New i18n keys required: `sectionRetentionPolicy*`, `sectionAccessRestriction*`, `sectionTenantWebhooks*`, `sectionAuditDelivery*` (plan has `sectionBreakglass*` already), `teamSectionPolicy*`, `teamSectionKeyRotation*`, `teamSectionWebhooks*`. Each gets a sibling `layout.tsx` rendering `SectionLayout` with appropriate icon/title/description.

### F4 [Major]: `section-nav.test.tsx` has ~22 hits of old admin URLs, not 5

- **File**: plan Batch 7 step 1, "Files to modify" table
- **Evidence**: `grep -nE '/admin/tenant/security' src/components/settings/account/section-nav.test.tsx` returns ~22 matches: lines 9, 48-50, 55, 60-62, 66, 75, 82, 88, 93, 99, 104, 110, 115, 121, 126.
- **Problem**: Plan's pre-screen-driven step says "5 fixture URLs". Implementor following the plan literally fixes 5 hits and leaves 17 still pointing at deleted URLs.
- **Impact**: Test still passes (it's testing internal logic, not URL existence) but contains stale references — confusing maintainers, hidden landmine for future cleanup.
- **Fix**: Plan should say "all `/admin/tenant/security/*` references in section-nav.test.tsx" (~22 occurrences). The test only exercises path-prefix-matching logic, so swap to non-admin fixtures (e.g. `/dashboard/settings/account`, `/dashboard/settings/auth/passkey`, `/dashboard/settings/auth/sessions`) so future admin IA changes don't pay this cost.

(Same recommendation reinforced by T11.)

### F5 [Major]: `navMachineIdentityOperatorTokens` katakana vs existing kanji

- **File**: plan i18n changes section, naming summary
- **Evidence**: Plan proposes `"navMachineIdentityOperatorTokens": "オペレータートークン"` (katakana). Existing references use `運用者トークン` (kanji) in 8+ locations: `messages/ja/AdminConsole.json:9`, `:50`; `messages/ja/OperatorToken.json:2`; `messages/ja/AuditLog.json:73`; etc.
- **Problem**: After redesign, sidebar reads `オペレータートークン`; page header (from `OperatorToken.json` `title`) reads `運用者トークン`; audit log entries read `運用者トークン`. Same concept, two translations on the same screen.
- **Impact**: User-visible UX regression. Violates project translation-consistency convention (memory: feedback_ja_vault_translation about "vault" → 保管庫 only).
- **Fix**: Use `運用者トークン` in plan (kanji form). English label "Operator tokens" is fine. Add to plan: i18n consistency check during Batch 1 grep that the new key value matches `運用者トークン` exactly to prevent drift in future PRs.

### F6 [Major]: Batch 5 step 5 / Batch 6 step 8 mis-described

- **File**: plan Batch 5 step 5, Batch 6 step 8
- **Evidence**: Both files (`audit-logs/layout.tsx`, `members/layout.tsx`) currently DO NOT have `navItems` props — they wrap children with `SectionLayout` only. The "sub-tab nav" the plan references is in the sidebar (`admin-sidebar.tsx`), not in those layouts.
- **Problem**: Plan instructs to "remove sub-tab navItems" but they don't exist at the named files. Step is a confusing no-op.
- **Impact**: Implementer gets confused; either skips the step or incorrectly modifies the wrong file.
- **Fix**: Replace Batch 5 step 5 with: "Verify `audit-logs/layout.tsx` still wraps with SectionLayout title — no edit needed; sub-tab nav was in the sidebar (already updated in Batch 1). If the intent is to drop the wrapper because audit-logs is now a leaf without sub-nav, state that and require the leaf page to render its own header." Same for Batch 6 step 8.

### F7/T6 [Major]: `aria-current="page"` claim doesn't match codebase reality

- **File**: plan §"Patterns that MUST be followed"; §"Testing strategy"; §"Scenario 12"
- **Evidence**: Plan claims "`aria-current="page"` is set by the existing `Button` `variant="secondary"` active-state pattern in `SidebarNav` — no new aria attributes needed." Reality: `grep -n 'aria-current' src/components/admin/admin-sidebar.tsx` returns zero hits. shadcn `Button` does NOT add `aria-current` based on variant.
- **Problem**: a11y guarantee is false. Scenario 12 ("Active item announces as 'current page'") is unreachable without code change.
- **Impact**: Implementer assumes aria-current works and writes E2E asserting it; test passes via the `or secondary-variant button class` fallback, but the screen-reader scenario is unhonored. R32 testability gap.
- **Fix**: Either (a) update `admin-sidebar.tsx` to render `aria-current={isActive ? "page" : undefined}` on the inner Link element (small low-risk addition; deliver the a11y promise), OR (b) drop the aria-current claim entirely from plan + drop Scenario 12's "current page" announcement claim. **Recommended: (a)** — it's a single-line change in `admin-sidebar.tsx:189, 211` and it's trivially testable.

### F9/T5 [Major]: Sidebar link count math is wrong

- **File**: plan §"Testing strategy" — "22 (11 tenant × 2)"
- **Evidence**: Walking through the new tenant structure:
  - 2 leaves (Members, Teams) at top level
  - 3 group headers (Machine ID, Policies, Integrations) — current pattern at `admin-sidebar.tsx:170` renders group headers as `<div>` (NOT a link)
  - 3 children under Machine ID (SA, MCP, Op tokens)
  - 4 children under Policies (auth-policy, machine-id-policy, retention, access-restriction)
  - 3 children under Integrations (provisioning, webhooks, audit-delivery)
  - 2 leaves (Audit logs, Breakglass) at top level
  - Total `<a>` links per sidebar = 2 + 3 + 4 + 3 + 2 = 14 (group headers are `<div>` not anchors)
  - Mobile + desktop = 28 total links — **NOT 22**
  - For team: 6 leaves × 2 = 12 (plan correct here)
- **Problem**: Implementer writes `expect(links.length).toBe(22)` per the plan, runs test, fails at 28, then ad-hoc fixes the literal — exactly the R20 trap.
- **Impact**: Batch 1 step 4 verification fails; uncertainty about what the "right" count is.
- **Fix**: Recompute the count by walking each `useNavItems` array. Document the calculation in plan's Testing strategy. Better: derive the count from the navItems source (e.g. import a flattening helper) so future IA changes don't drift the assertion. Pattern: `const flatNavCount = countLeafLinks(useNavItems(...)); expect(links.length).toBe(flatNavCount * 2);`. Addresses RT3.

### F10/T8 [Major]: `members/add` extraction grossly under-specified

- **File**: plan Batch 6 step 1
- **Evidence**: `src/app/[locale]/admin/teams/[teamId]/members/add/page.tsx` is 380 lines containing 3 distinct sections: (1) add-from-tenant (search + role select + add); (2) invite-by-email (email + role + link generation); (3) pending-invitations list (with cancel + copy-invite-link). Plan says "refactor the form into a reusable component (`<AddMemberForm teamId={...} onSuccess={...} />`)".
- **Problem**: Three independent UI sections do not become one component called "AddMemberForm". Plan does not articulate which subset goes into the modal vs stays on the page.
- **Impact**: Two divergent implementations possible; either lifts everything (large overwhelming modal) or only inputs (page has no place for pending-list since it's now a list page). Phase 2 design ambiguity.
- **Fix**: Plan should explicitly decompose:
  - Modal contains: add-from-tenant + invite-by-email tabs (or buttons that open separate dialogs)
  - Members list page renders: roster table + "メンバーを追加" button + pending-invitations section below the roster
  - Three new components: `<AddFromTenantSection />`, `<InviteByEmailSection />`, `<PendingInvitationsList />`
  - New unit tests for each (existing add/page.tsx has no `__tests__/` coverage; this is the right time to add)

### F11-T [Minor → routed Testing]: New E2E spec scope unclear

(Largely subsumed by T7. See Testing findings.)

### F12-S [Informational]: Tenant guard inheritance verified

(Confirmed safe by Security expert; no action.)

## Security Findings

### S1 [Minor → upgraded to Critical because matches F1/T1]

(See F1 Critical above. Same issue, three experts caught it. Severity Critical due to immediate CI failure.)

### S2 [Minor → upgraded to Critical because matches F2]

(See F2 Critical above.)

### S3 [Minor]: "Walk admin route tree" regression test too vague

- **File**: plan §"Authorization invariant" step 2
- **Evidence**: Plan: "adding a regression test that walks the new admin route tree and confirms each page's data-fetch call still hits an authz-gated API endpoint" — too vague for an implementer.
- **Problem**: Concrete shape of the test is not specified.
- **Impact**: Test may not actually exercise the cross-tenant boundary; could become a vacuous "every page renders" test.
- **Fix**: Concretize as: "For every URL in the new admin tree (parameterized list), spawn a Next handler with an unauthenticated session AND with a session for a non-admin user. Assert HTTP 404 in both cases. This proves the layout `notFound()` guard is reached."

### S4 [Minor]: Team key-rotation goes from 3 clicks to 1 click; verify confirm UX

- **File**: plan Team admin sidebar (`/admin/teams/[id]/key-rotation` as top-level leaf)
- **Evidence**: Currently key-rotation is at `/admin/teams/[id]/security/key-rotation` (3 clicks: scope-selector → security expand → key-rotation). Plan promotes to top-level (1 click).
- **Problem**: Key rotation is destructive (re-encrypts all team-scope vault entries). Lower bar to accidental destructive action by a tired admin or a malicious insider.
- **Impact**: UI-shape risk; not a new authz boundary.
- **Fix**: Verify `TeamRotateKeyButton` has multi-step confirm (e.g., type-team-name-to-confirm). If not, plan should require adding it. Document the existing confirm UX in the plan.

### S5 [Minor]: Deprecated-key sentinel only checks JSON, not source code

- **File**: plan Batch 7 step 5
- **Evidence**: Plan describes the test asserts deprecated keys do NOT appear in `messages/{ja,en}/AdminConsole.json`. Does NOT assert no `t("oldKey")` calls remain in source.
- **Problem**: A surviving `t("navOldKey")` call after JSON removal causes runtime fallback rendering of the literal key string in the UI. Easy to miss.
- **Impact**: Visible UI bug if a removed key is still referenced.
- **Fix**: Extend the deprecated-keys test to also grep `src/` for `t("<oldKey>"` patterns and assert zero hits. Round-trip the sentinel.

### S6 [Minor]: Force-dynamic on relocated breakglass page

- **File**: plan Batch 5 step 2 (move breakglass to top-level)
- **Evidence**: Break Glass is the highest-impact tenant-admin operation (creates short-lived elevated access for an admin). The new top-level URL is more discoverable.
- **Problem**: Plan does not require `export const dynamic = "force-dynamic"` on the relocated page. If accidentally cached (Vercel ISR, CDN, browser BFCache), tenant-scoped break-glass metadata could be served cross-tenant.
- **Impact**: Defense-in-depth gap; not a known bug, but requires positive setting to prevent.
- **Fix**: Plan should explicitly require `export const dynamic = "force-dynamic"` on the new `/admin/tenant/breakglass/page.tsx`. Same for the inlined `/admin/tenant/audit-logs/page.tsx` (verify caching semantics carry through the inline-overwrite).

### S7-A, S8-A [Minor → routed]

(See Functionality and Testing for routing.)

## Testing Findings

### T1 [Critical]

(Same as F1.)

### T2 [Critical]: Forward-direction sentinel test is vacuous

- **File**: plan §"Cleanup of unused keys", §"Testing strategy", §"Files to create"
- **Evidence**: Plan: "enumerates every new key … and greps `src/` for at least one consumer". The sentinel itself sits at `src/__tests__/admin-i18n-key-coverage.test.ts` and contains the literal key strings to enumerate them. Grep over `src/` finds the test file itself; test always passes.
- **Problem**: The gate provides no coverage. Dead keys can be added to JSON and the test happily greens.
- **Impact**: Plan claims a regression gate that does nothing.
- **Fix**: Specify in the plan that the grep MUST exclude (a) the sentinel test file itself and (b) the deprecated-keys sentinel test file. Use `grep --exclude-dir=__tests__ --exclude='*-i18n-*.test.ts'`. Encode this exclusion as a hard requirement.

### T3 [Major]: Reverse sentinel needs self-validity

- **File**: plan Batch 7 step 5
- **Evidence**: Plan describes the deprecated-keys sentinel reads a hard-coded array and asserts none appear in JSON. No check that the array is non-empty or that entries match the project's naming convention.
- **Problem**: A typo in the deprecated array (`navProvisining` instead of `navProvisioning`) silently passes; the typo'd key won't be detected if added later.
- **Impact**: False assurance.
- **Fix**: Add to the test: assert array non-empty + every entry matches `^(nav|section|subTab)[A-Z][a-zA-Z]+$`. Cheap defensive check.

### T4 [Major]: E2E enumeration incomplete (but verified safe)

- **File**: plan Batch 7 step 8
- **Evidence**: Grep finds additional admin URL hits in `e2e/page-objects/teams.page.ts:99` (waitForURL pattern unchanged), `e2e/page-objects/sidebar-nav.page.ts:190` (regex still matches). All safe — but plan doesn't enumerate.
- **Problem**: Without explicit "audit complete" record, future reviewers re-do the same grep work.
- **Impact**: Process inefficiency; minor risk of next IA change missing the audit.
- **Fix**: Add E2E selector audit table to plan: file, line, current text, action. Include "no-op safe" cases.

### T5 [Major]

(Same as F9.)

### T6 [Major]

(Same as F7.)

### T7 [Major]: New E2E spec under-specifies redirect target verification

- **File**: plan §"Testing strategy"
- **Evidence**: Plan says "navigates to URL, asserts page renders without error" — Playwright doesn't fail on 404/500 by default unless asserted. No `expect(page).toHaveURL(...)` assertion specified.
- **Problem**: A typo in a redirect target (e.g. `passsword`) is caught only by manual click-through. Plan's group-landing redirect feature is the highest-risk new code.
- **Impact**: Redirect cascade silently breaks; E2E still greens because the final page renders something.
- **Fix**: In plan, list the parameterized URL set as a table. For each: `(input_url, expected_final_url)`. Test does `await page.goto(input)` then `await expect(page).toHaveURL(expected_final_url)`. For non-redirecting leaves, expected === input. For group/sub-tab parents, expected === redirect target. Catches typos AND missing redirects.

### T8 [Major]

(Same as F10.)

### T9 [Minor]: i18n parity ≠ dead-key prevention

- **File**: plan §"i18n changes"
- **Evidence**: Existing `messages-consistency.test.ts` enforces ja/en symmetry. It does NOT detect dead keys.
- **Problem**: Plan slightly overstates what the existing gate provides.
- **Fix**: Update plan paragraph to clarify the two gates are orthogonal.

### T10 [Minor]: No mobile E2E for new sidebar group expansion

- **File**: plan §"Testing strategy"
- **Evidence**: Plan's manual-test plan lists "Mobile sidebar behavior" but no automated `@mobile` test for the new IA.
- **Problem**: Group-expansion regressions on mobile slip past CI.
- **Fix**: Add one `@mobile`-tagged variant of `admin-ia.spec.ts`: opens sheet, taps a group, taps a child, asserts navigation.

### T11 [Minor]: section-nav.test.tsx fixtures should switch to non-admin URLs

(See F4 fix recommendation; same surface.)

### T12 [Minor]: Redirect-only page unit-test policy undecided

- **File**: plan §"Files to create" (lists 7 redirect-only pages with no test coverage strategy)
- **Evidence**: Existing `mcp/__tests__/page.test.tsx` shows the project DID unit-test client-side redirect pages. Plan switches to server-side `redirect()` but doesn't say whether to skip unit tests or rewrite them.
- **Problem**: A typo in any redirect target is caught only by E2E.
- **Fix**: Decide and document. **Recommended**: pair with T7 — E2E `toHaveURL` assertion is sufficient; skip unit tests for redirect-only pages.

### T13a [Minor]: pre-pr.sh check for manual-test artifact

- **File**: plan §"Pre-PR" checklist
- **Evidence**: Manual-test artifact required per R35; only enforced by checklist convention.
- **Fix**: Optional — extend pre-pr.sh to fail if `docs/archive/review/admin-ia-redesign-manual-test.md` is missing. Borderline scope; can be deferred.

### T13b [Minor]: "22 destinations" count discrepancy

- **File**: plan §"Final state"
- **Evidence**: Plan says "7 + 11 children + 4 sub-tab parents = 22 destinations". Sub-tab parents are redirect-only — they're not user-facing destinations.
- **Fix**: Distinguish destinations from redirect waypoints in the count.

### T15 [Minor]: tenant-admin.spec.ts beforeAll relies on no-VaultGate; verify still holds

- **File**: existing `e2e/tests/tenant-admin.spec.ts:11-24`
- **Evidence**: beforeAll comments rely on "admin pages don't have VaultGate" (true today). New redirect-only group-landing pages may have different behavior.
- **Fix**: Add to plan testing-strategy: one explicit E2E test that navigates to a group landing URL without unlocking vault, asserts redirect cascade completes and the leaf page renders (vault-locked cards self-gate).

### T16 [Minor]: e2e key-rotation grep needed

- **File**: plan Batch 7 step 8
- **Fix**: Add to grep list: `grep -rn 'key-rotation' e2e/` to catch any spec that references the moved team key-rotation URL.

### T17-A [Major → routed Functionality]

- **File**: `src/__tests__/ui/audit-log-action-groups.test.ts`
- **Evidence**: Test currently reads only `teams/[teamId]/audit-logs/page.tsx`. Tenant audit-logs page is being inlined in Batch 5 — its content moves from `audit-logs/logs/page.tsx`. The test will silently miss any group-value regression on the tenant side.
- **Routed to**: Functionality. Pre-existing gap, but the inlining batch is the right time to extend coverage.
- **Fix**: Extend the test to also read the inlined `tenant/audit-logs/page.tsx` (post Batch 5).

### T18-A [Minor → routed Functionality]

- **File**: `src/hooks/sidebar/use-sidebar-navigation-state.ts:65`
- **Evidence**: Comment references `/admin/teams/[id]/*`. The test on line 105 uses `/audit-logs` (URL unchanged — safe). But the production code's path-matching may need adjustment for `/admin/teams/[id]/policy` (no `/security/` prefix).
- **Fix**: Verify the production path-matching logic still works for the new team URLs.

## Adjacent Findings (routed)

- F11-T → Testing (covered in T7)
- F12-S → Security (verified safe by Security expert; no action)
- S7-A → Functionality (typed routes — out of scope for this PR)
- S8-A → Testing (covered in T7)
- T17-A → Functionality (audit-log-action-groups.test.ts coverage)
- T18-A → Functionality (use-sidebar-navigation-state path matching)

## Quality Warnings

None — all findings include Evidence and concrete Fix. No `[VAGUE]`, `[NO-EVIDENCE]`, or `[UNTESTED-CLAIM]` flags.

## Recurring Issue Check

### Functionality expert
- R1 (shared utility reuse): Clean
- R2 (constants hardcoded): N/A
- R3 (incomplete pattern propagation): F3 — SectionLayout wrappers missing for moved leaf pages
- R4: N/A
- R5/R6: N/A
- R7 (E2E selector breakage): Clean (plan covers tenant-admin.spec.ts; teams.spec.ts URL unchanged)
- R8 (UI pattern inconsistency): F5 — operator tokens label inconsistency
- R9-R11: N/A
- R12 (i18n / enum coverage): F3 implies new section keys missing from plan's i18n list
- R13-R16: N/A
- R17 (helper adoption): Clean
- R18: N/A
- R19 (test mock alignment): F1 — deleted page imports break colocated tests
- R20 (mechanical edit safety): F8/F9 — sidebar test math mismatched
- R21: N/A this phase
- R22 (perspective inversion): Clean
- R23-R30: N/A or covered above
- R31 (destructive ops): minor concern — plan should specify `git rm -r` (tracked file removal)
- R32: N/A
- R33 (CI config drift): Clean
- R34 (adjacent pre-existing bugs): redirect style inconsistency between `audit-logs/page.tsx` (manual locale prefix) and `dashboard/settings/page.tsx` (i18n redirect helper); F2 covers
- R35 (manual test plan, Tier-1): Clean — plan defers to Phase 2

### Security expert
- R1, R3, R7, R12, R17, R20, R22: Clean
- R31 (destructive ops): PASS modulo S1 (test files in deleted dirs)
- R34 (adjacent pre-existing bugs): no missing authz; S4 (key-rotation confirm UX), S6 (caching) noted
- R35 (manual test plan): NEAR-PASS; recommend adversarial scenarios incl. cross-tenant URL probe
- RS1: N/A
- RS2: N/A
- RS3: PASS — AddMemberForm extraction preserves form contract

### Testing expert
- R1, R3, R17: Clean
- R7 (E2E selector breakage): T4 — full enumeration not in plan
- R12 (i18n / enum coverage): T2/T3 — both sentinels need work
- R19 (mock alignment): R19 PARTIAL — lucide-react icons not mocked, smoke check during Batch 1
- R20 (mechanical edit safety): FAIL — see T5
- R32 (testability): FAIL — see T6 (`aria-current` not emitted)
- R34 (pre-existing test bugs): T1 (orphaned redirect tests), T11 (section-nav fixtures stale)
- R35 (manual test plan, Tier-1): ACCEPTABLE — Phase 2 deferral
- RT1 (mock-reality divergence): PARTIAL — sentinels must use existing audit-i18n-coverage.test.ts pattern
- RT2 (testability verification): FAIL — `aria-current`, vacuous sentinel
- RT3 (shared constants in tests): FAIL — link counts hard-coded; should derive from source

## Anti-Deferral Audit

No findings deferred for this round. Out-of-scope items:
- S7-A (typed routes) — separate cleanup PR consideration; not in scope.
- T13a (pre-pr.sh manual-test enforcement) — borderline; flagged for user decision.

## Plan revisions to apply (round 1 → round 2)

The orchestrator will apply ALL Critical/Major findings to the plan AND all Minor findings except T13a (deferred for user decision).

| ID | Severity | Apply? | Reason |
|---|---|---|---|
| F1=S1=T1 | Critical | ✅ | Critical, simple plan edit |
| F2=S2 | Critical | ✅ | Critical, plan specifies redirect pattern |
| F3 | Major | ✅ | Required layouts + i18n keys |
| F4 | Major | ✅ | Plan correction |
| F5 | Major | ✅ | Plan correction |
| F6 | Major | ✅ | Plan correction |
| F7=T6 | Major | ✅ | Update sidebar to emit aria-current; update plan + tests |
| F9=T5 | Major | ✅ | Plan correction; recompute count |
| F10=T8 | Major | ✅ | Plan decomposition + new component split |
| T2 | Critical | ✅ | Plan correction; sentinel exclusion |
| T3 | Major | ✅ | Plan correction; sentinel self-validity |
| T7 | Major | ✅ | Plan correction; E2E toHaveURL |
| T17-A | Major | ✅ | Plan adds extension to audit-log-action-groups.test.ts |
| F8 | Minor | ✅ | Plan correction; describe block updates |
| S3 | Minor | ✅ | Plan correction; concretize regression test |
| S4 | Minor | ✅ | Plan documents key-rotation confirm UX verification |
| S5 | Minor | ✅ | Plan correction; sentinel round-trip |
| S6 | Minor | ✅ | Plan correction; force-dynamic on breakglass |
| T4 | Major | ✅ | Plan correction; E2E audit table |
| T9 | Minor | ✅ | Plan correction; clarify gate |
| T10 | Minor | ✅ | Plan correction; @mobile test |
| T11 | Minor | ✅ | Plan correction; non-admin fixtures |
| T12 | Minor | ✅ | Plan decision; skip unit tests for redirect-only pages |
| T13b | Minor | ✅ | Plan correction; clarify count |
| T15 | Minor | ✅ | Plan correction; vault-locked redirect E2E |
| T16 | Minor | ✅ | Plan correction; e2e grep |
| T18-A | Minor | ✅ | Plan adds verification step |
| T13a | Minor | ⏸️ | Deferred — flagged for user decision |
| F11-T, F12-S, S7-A, S8-A | Adjacent | n/a | Routed to expert; no plan change |

After applying: re-run round 2 review on the updated plan.

---

# Plan Review: admin-ia-redesign — Round 2

Date: 2026-05-02
Review round: 2

## Changes from Previous Round

The orchestrator applied ALL round-1 Critical/Major findings + most Minor findings to the plan. Plan grew from 855 → 1071 lines with ~40 inline `round-1 ...` references for traceability. Round 2 reviewers independently verified each round-1 fix and looked for new issues introduced by the fixes.

## Summary of round 2

| Severity | Count |
|---|---|
| Critical | 0 (all round-1 Critical fixes verified ✅) |
| Major | 4 new |
| Minor | 9 new |

## Functionality round 2 verdict

7/10 round-1 fixes ✅ verified. 3 partial ⚠️ — corrected per-batch step descriptions weren't propagated to summary tables (F4/F5/F6 leftover):
- F13 (Major): "Files to modify" table line 712-714 still said "Remove sub-tab navItems" + "5 fixture URLs" → contradicts F4/F6 corrected steps
- F14 (Major): "Naming summary" line 968 still said `オペレータートークン` (katakana) → contradicts F5 fix
- F16 (Major): 3 new `team-members/` components didn't follow `team-*` prefix convention used in `team/forms/`, `team/management/`
- F11/F12/F15/F17 (Minor): mixed redirect styles persist (largely moot — the only non-canonical pattern was in deleted pages); 10 new layouts repeat boilerplate (premature abstraction); flat-leaf-counter helper undesigned; sentinel grep should also exclude `**/*.test.ts`/`.test.tsx` (not just `*-i18n-*.test.ts`)

All 4 round-2 Majors applied + relevant Minors (F17, F11 dropped as moot, F12 dropped as premature abstraction, F15 → see T22 commit).

## Security round 2 verdict

6/6 round-1 fixes ✅ verified. **No Critical or Major** new findings.

5 new Minor findings:
- S7: name non-admin fixture explicitly in admin-authz.spec.ts (avoid `teamOwner` which is also tenant ADMIN per global-setup.ts) → applied
- S8: rm -rf vs git rm doc drift → applied
- S9: cross-check confirmed all redirect-only admin pages migrated correctly (no missed migrations) → no action needed
- S10: 307 vs 404 distinction — unauthenticated users on redirect-only pages must get 404 (not 307) to prove layout authz fires before redirect → applied
- S11: form decomposition preserves API-boundary validation → no action needed (verification-only)

## Testing round 2 verdict

17/18 round-1 fixes ✅ (T13a deferred). T6 partial: code fix applied but E2E assertion had weakening "or" fallback.

4 new findings:
- T19 (Major): aria-current assertion's "or the secondary-variant button class" fallback masks regressions → applied (strict aria-current-only)
- T20 (Minor non-issue): orchestrator's CI-budget framing was a misread; only 3 Playwright projects exist (chromium + 2 mobile, no firefox/webkit), and only `@mobile`-tagged tests run on mobile → no action
- T21 (Minor): admin-authz "expect 404" too vague; mandate `expect(response?.status()).toBe(404)` → applied
- T22 (Minor): RT3 helper testability — commit to `countLeafLinks` helper with unit test, OR document hard-coded literal → applied (commit to helper)

## Plan revisions applied for round 2

| ID | Severity | Applied? | Notes |
|---|---|---|---|
| F13 | Major | ✅ | "Files to modify" line 712-714 corrected |
| F14 | Major | ✅ | Naming summary table updated to 運用者トークン + sidebar diagram updated |
| F16 | Major | ✅ | Components renamed to `team-add-from-tenant-section.tsx` etc. |
| T19 | Major | ✅ | E2E + unit-test assertion strict `aria-current` only |
| F11 | Minor | ⏸️ | Dropped — non-canonical patterns existed only in deleted pages; concern moot post-migration |
| F12 | Minor | ⏸️ | Dropped — 10 layouts × 4-line boilerplate is premature abstraction; explicit is fine |
| F15 | Minor | ✅ (via T22) | Helper design committed via T22 fix |
| F17 | Minor | ✅ | Sentinel exclusion broadened to `**/*.test.{ts,tsx}` |
| S7 | Minor | ✅ | `vaultReady` fixture named explicitly |
| S8 | Minor | ✅ | `git rm -r` standardized in §"Directories to remove" |
| S9 | Minor | n/a | Verification confirmed; no plan change |
| S10 | Minor | ✅ | 307 vs 404 distinction documented |
| S11 | Minor | n/a | Verification confirmed; no plan change |
| T20 | Minor | n/a | Misread by orchestrator; CI budget OK |
| T21 | Minor | ✅ | `expect(response?.status()).toBe(404)` mandated |
| T22 | Minor | ✅ | `countLeafLinks` helper committed (with unit test) |

## Final findings ledger

| Round | Critical | Major | Minor | Status |
|---|---|---|---|---|
| Pre-screen (LLM) | 1 | 4 | 5 | 6 valid → applied; 4 false positives → dismissed |
| 1 (3 experts) | 2 | 11 | 14 | All Critical/Major + relevant Minor applied |
| 2 (3 experts) | 0 | 4 | 9 | All Major + relevant Minor applied |
| **Total** | **3** | **19** | **28** | All in-scope findings resolved |

## Quality Warnings

None — every finding included Evidence + concrete Fix.

## Anti-Deferral Audit

- T13a (pre-pr.sh manual-test enforcement): user-accepted post-round-2 (decision: include). Plan Batch 7 step 15 now extends `scripts/pre-pr.sh` with a narrow gate: fails iff diff touches `src/app/[locale]/admin/` AND no `docs/archive/review/*-manual-test.md` was added. No deferral remains.
- F11, F12, T20, S9, S11: dropped/no-action with explicit reasons in the table above (non-issues or verification-only findings).

## Recurring Issue Check (round 2)

### Functionality expert
- R1, R3, R7, R12, R17, R19, R20, R22, R34: clean (round-1 issues verified resolved)
- R31: `git rm -r` standardized (S8)
- R35: Tier-1 Phase-2 deferral confirmed acceptable

### Security expert
- All R1-R35 + RS1-RS3: clean
- R31 destructive ops: PASS (`git rm -r`, no security artifacts touched)
- R35 manual test: NEAR-PASS, defer to Phase 2 with adversarial scenarios documented

### Testing expert
- RT1: pattern from `audit-i18n-coverage.test.ts:6-13` reused
- RT2: `aria-current` testability ✅, vacuous-sentinel ✅
- RT3: literal counts replaced with `countLeafLinks` helper (T22)

## Decision

Round 2 closed. All Critical findings resolved across both rounds. No new Critical introduced. Major findings applied; Minor findings either applied or deferred with documented justification.

**Plan ready for Phase 2 implementation.**

