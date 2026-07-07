# Plan: step-up client reauth — close the class (guard-first) per (route, method)

## Project context
- Type: web app (Next.js App Router + React client components)
- Test infrastructure: unit + integration + E2E (vitest, @testing-library/react, Playwright)
- Verification environment constraints: none blocking. The step-up 403 path is
  unit-testable by mocking `fetchApi` to return a 403 `SESSION_STEP_UP_REQUIRED`
  body. Manual browser and E2E (let step-up window lapse → mutate → reauth
  prompt) are `verifiable-local`. E2E is outside pre-pr.sh's default gate
  (project_ci_gates_beyond_pre_pr) — call it out explicitly.

## Objective
Close the entire "mutating UI caller whose server route enforces session step-up
but whose client does not handle the `SESSION_STEP_UP_REQUIRED` 403" class.
The class boundary is **(route, method, param-condition)**, NOT per-component:
Phase-1 review (F1 Critical) found that several components already on the
"handled" list wire step-up on only SOME of their gated mutations (e.g.
mcp-client-card handles POST create but not PUT/DELETE; even the reference
api-key-manager handles POST but not DELETE). A per-component enumeration
repeats the prior PR's under-enumeration.

**Guard-first strategy** (user-approved): implement the C1 CI guard FIRST so it
mechanically enumerates the (route, method)→caller class and lists every unhandled
member. The guard's output is the single source of truth for the fix set; we then
fix members until the guard is green. This structurally prevents the hand-list
miss that produced the 8→24+ expansion.

## Background — the primitive and the handling marker
`requireRecentCurrentAuthMethod` (src/lib/auth/session/recent-current-auth-method.ts:26)
is the class-defining server primitive; on a stale window it emits
`API_ERROR.SESSION_STEP_UP_REQUIRED`. A client HANDLES a specific gated mutation
iff the handler for THAT (path, method) branches on
`API_ERROR.SESSION_STEP_UP_REQUIRED` (read via `readApiErrorBody`) and invokes
`useInlineReauth().triggerOnStaleError(...)`. Recipe: api-key-manager.tsx
(:91 hook, :159-160 branch, :212-218 dialogs); handoff doc
docs/archive/review/step-up-client-handoff.md §"Per-component fix recipe".

Sibling guard to model C1 on: `scripts/checks/check-permanent-delete-stepup.sh`
+ its self-test `scripts/__tests__/check-permanent-delete-stepup.test.mjs`, wired
at pre-pr.sh:165 (`run_step "Static: permanent-delete-stepup"`). It is a pure
text/filesystem scan (no `@prisma/client` import — required so it survives the
static-checks CI job that runs without prisma generate,
per project_static_check_ci_no_prisma_generate).

## Contracts

### C1 — Marker-verified client-coverage guard (IMPLEMENT FIRST)
`scripts/checks/check-step-up-client-coverage.sh` (+ exempt allowlist +
`scripts/__tests__/check-step-up-client-coverage.test.mjs`).

**Why marker-based, not inference-based (F7):** a pure grep cannot reliably
resolve a client `fetchApi` call to its gated (route, method). Round-2 review
found three caller path-spellings among NAMED members that defeat token grep:
raw template literals (`team-policy-settings.tsx` uses `` `/api/teams/${teamId}/policy` ``,
no `apiPath` token), prop-indirection (`base-webhook-card.tsx` calls
`fetchApi(createEndpoint, …)` with the path token in a DIFFERENT file), and
helper→canonical-path semantic gaps (`apiPath.tenantMemberById(userId)` has no
`:userId` textual marker). An inference guard would go GREEN while structurally
blind to these members — defeating the guard-first premise. So the guard verifies
an explicit **marker at each end** instead of inferring coverage. Markers make
coverage self-declaring, so the guard needs no path resolution.

- **Two-sided marker scheme**:
  - **Server side** — each gated handler already calls `requireRecentCurrentAuthMethod`.
    Add a one-line marker comment on that call: `// @stepup id:<STABLE_ID> method:<M>`
    where `<STABLE_ID>` is a short stable slug for the (route, method) pair (e.g.
    `tenant-mcp-clients-id-put`). Mechanical to add — the routes are already known.
  - **Client side** — each client call site that invokes a gated (route, method)
    gets `// @stepup id:<STABLE_ID>` immediately above the `fetchApi(` line, and the
    enclosing handler MUST contain a `SESSION_STEP_UP_REQUIRED` branch.
- **Guard checks (pure text+filesystem scan, no `@prisma/client` import)**:
  1. **Coverage (server→client)**: collect all server `@stepup id:X` markers (set S)
     and all client `@stepup id:X` markers (set C). Every id in S MUST appear in C,
     unless id is exempt-allowlisted. `S \ C` (a gated server mutation with no client
     marker = the付け漏れ/missed-member case) → FAIL. This is the completeness gate
     that closes F7: it does not need to resolve paths, only to match stable ids.
  2. **Handling (client marker → branch, ADJACENCY-scoped — C1-R3-2/3)**: bash cannot
     reliably scope to "the enclosing handler function body" (brace-matching across
     nested arrow callbacks is not grep-able), and a whole-FILE grep false-PASSes the
     live F1 case — mcp-client-card contains `SESSION_STEP_UP_REQUIRED` once (handleCreate)
     but its handleEdit/PUT and handleDelete/DELETE lack it, yet a file grep returns TRUE
     for all three. So instead: for each client `@stepup id:X` marker on line L (placed
     immediately above the `fetchApi(` call), a `SESSION_STEP_UP_REQUIRED` reference MUST
     appear within N lines below L (N≈40; pick by measuring the largest real
     marker→branch gap in the fixed set and adding margin; document N in the header).
     Mechanism: `awk -v L=<line> 'NR>=L && NR<=L+N && /SESSION_STEP_UP_REQUIRED/{f=1}
     END{exit !f}'`. A marker with no branch in its window → FAIL. This is parser-free,
     deterministic, and fails in the SAFE direction (a too-far branch forces a real fix
     or a documented restructure). Escalation if adjacency proves noisy: rewrite the
     guard in Node with ts-morph (already used parser-free in ast-guards.ts per
     project_ast_guard_tsmorph_no_program) for true function-scoping — but adjacency is
     the default.
  3. **Anti-orphan (client→server)**: every client `@stepup id:X` MUST match a server
     id (else the client marks a stale/renamed id) → FAIL. `C \ S` with no exempt → FAIL.
  4. **Server marker completeness (LINE-BOUND, per call — C1-R3-4)**: every
     `requireRecentCurrentAuthMethod(` call (matched with the sibling's boundary regex
     `(^|[^A-Za-z0-9_])requireRecentCurrentAuthMethod\(` so `DISABLED_…`/imports don't
     match) on line H MUST carry a `@stepup id:… method:…` marker on line H or H-1.
     Do NOT use a file-level call-count==marker-count check — a route file with two gated
     calls (e.g. mcp-clients/[id] PUT:92 + DELETE:161) needs TWO distinct-id markers, and
     a count check would let one marker cover both. Require each marker to carry a
     `method:` token and assert per-file id uniqueness. Header note (mirroring sibling):
     a commented-out call still matches the call regex — left to code review by design.
  - Param-conditional gating (`passwords/[id]` DELETE gated only inside `if (permanent)`)
    needs no special handling now: the marker sits on the `requireRecentCurrentAuthMethod`
    call inside the `if (permanent)` branch, and the client permanent-delete call carries
    the matching id. The ungated soft-delete caller simply has no marker — nothing to resolve.
- **Exempt allowlist** (`stepup-client-exempt.txt`): a server `@stepup` id may be
  exempted from requiring a client marker (custom-recovery or non-interactive members)
  with a ≥10-char reason. Per S4 hardening, each exempt entry names the custom marker
  its handler file must still contain (operator-token → `OPERATOR_TOKEN_STALE_SESSION`;
  auto-extension → `EXTENSION_CONNECT_ERROR_CODE.SESSION_STEP_UP_REQUIRED`;
  team-vault-core poller → a documented "background poller" marker); anti-drift fails
  if the named marker disappears. Exempt these 3.
- **Self-test** (`.test.mjs`, mandatory — T1, expanded per T8/T9/C1-R3-5 to 7 fixtures):
  (i) server id + matching client marker + branch within window → PASS;
  (ii) server id with NO client marker (付け漏れ) → FAIL (coverage gate, the F7 case);
  (iii) client marker present but NO `SESSION_STEP_UP_REQUIRED` within the adjacency window → FAIL;
  (iv) exempt entry whose named custom marker is absent → FAIL (S4 anti-drift);
  (v) a `requireRecentCurrentAuthMethod(` call with NO server `@stepup` marker on line H/H-1 → FAIL (server completeness);
  (vi) a client `@stepup id:X` whose id has no server match (renamed/stale) → FAIL (anti-orphan);
  (vii) **ONE file, TWO marked handlers — handler A has `SESSION_STEP_UP_REQUIRED` in its
  window, handler B (also marked) does NOT — guard FAILs pointing at B (C1-R3-5).** This is
  the ONLY fixture that passes under file-scoping and fails under adjacency-scoping; it is
  the direct regression lock for the live mcp-client-card gap (model it on POST-handled /
  DELETE-unhandled). Without it a refactor back to file-scoped grep passes all other fixtures
  while silently reopening F1.
  Use `STEPUP_CLIENT_GUARD_*` env overrides to point at fixtures (mirror the sibling's `STEPUP_GUARD_*`).
- **Wiring (T2)**: add `run_step "Static: step-up-client-coverage" bash
  scripts/checks/check-step-up-client-coverage.sh` in pre-pr.sh next to the
  permanent-delete-stepup entry; and to the CI static-checks job. Confirm it runs
  with NO prisma generate.
- **Mutation-verified (T1)**: demonstrate RED two ways — (a) remove the client
  `@stepup` marker from one member (coverage gate goes RED via `S \ C`), and (b)
  keep the marker but delete its `SESSION_STEP_UP_REQUIRED` branch on a MULTI-mutation
  component (mcp-client-card) so the handling check goes RED — proving both gates
  fire independently — then restore.
- **Acceptance**: after server markers are added to all gated handlers, the guard's
  coverage gate (S\C) emits EXACTLY the set of gated mutations lacking a client
  marker — this list IS the C2-C4 work-list. Guard green after C2-C4 fixes; guard
  RED under each of the 6 self-test fixtures.

### C2 — Fix all standard card/dialog + hook callers the guard lists
Apply the recipe to every (component, method) the C1 coverage gate reports as
lacking a client marker. The Phase-1 re-derivation below is the EXPECTED work-list;
the guard's `S \ C` output is authoritative. Note (F6): the full gated-route universe
is ~2× this list — the difference is the ~15 already-handled (route, method) pairs
(directory-sync-card, audit-delivery-target-card, team-rotate-key-button, breakglass-*,
tenant-vault-reset-button, team-add-from-tenant-section, passkey-credentials-card DELETE,
service-account token-POST, scim-token POST, access-request approve, api-key create).
Those already carry (or will carry) a client marker, so they correctly do NOT appear in
`S \ C`. Their absence from the work-list is expected, NOT a guard miss.

Members to fix (per gated method):

Fully-unhandled or partially-unhandled components (per gated method):
- Tenant policy PATCH (8 cards): tenant-session-policy-card, tenant-passkey-policy-card,
  tenant-token-policy-card, tenant-lockout-policy-card, tenant-access-restriction-card,
  tenant-password-policy-card, tenant-delegation-policy-card, tenant-retention-policy-card.
- tenant-members-card — PUT member role.
- team-policy-settings — PUT team policy.
- base-webhook-card — POST create + DELETE (shared; covers tenant AND team webhooks).
- **Partial gaps in "handled" components (F1)**: mcp-client-card PUT + DELETE;
  service-account-card SA-PUT + SA-DELETE + token-DELETE; team-scim-token-manager
  DELETE; access-request-card POST-deny; api-key-manager DELETE.

For each: `useInlineReauth(() => handler())` (or a per-target discriminator when a
component has multiple gated mutations — e.g. mcp-client-card needs create/edit/
delete replay targets, like access-request-card's retry-target state). Add the
`SESSION_STEP_UP_REQUIRED` branch inside the `!res.ok` block (NOT the catch — the
forbidden bare-catch pattern must not trip on pre-existing catches). Render both
dialogs with `cancelLabel` from the component's existing i18n namespace (verify
the key exists).

Exclusions confirmed by re-derivation (do NOT add branches — over-inclusion guard):
- passkey-credentials-card PATCH (rename) — route PATCH NOT gated (only DELETE).
- service-account POST create — NOT gated.
- access-request-card POST create, vault/delegation — NOT gated.

**Marker obligation covers the ALREADY-handled members too (F6):** the ~15
already-handled (route, method) pairs must ALSO receive their server `@stepup`
marker and a client `@stepup` marker on the existing handled call site — otherwise
the coverage gate would flag them as `S \ C` (server marked, client unmarked). So
the marker rollout spans every gated mutation, not only the newly-fixed ones. The
already-handled call sites already have the `SESSION_STEP_UP_REQUIRED` branch, so
adding their client marker is a one-line comment each; no logic change.

### C3 — Admin full-page callers (pages, not cards)
- src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx — PUT role + DELETE remove (two gated mutations).
- src/app/[locale]/admin/teams/[teamId]/members/transfer-ownership/page.tsx — PUT member.
- src/app/[locale]/admin/teams/[teamId]/general/delete/page.tsx — DELETE team (PUT profile NOT gated).
Render the two dialogs in page JSX (mirrors vault-reset/page.tsx). Multi-mutation
pages use a retry-target discriminator.

### C4 — Vault permanent-delete / empty-trash / bulk-purge (G15/G16)
- G15 `src/hooks/bulk/use-bulk-action.ts` — CAN use the hook; wire the 403 branch
  for the `deletePermanently` bulk action (bulk-purge, personal + team).
- G16 adapters `src/lib/vault/{personal,team}-vault-list-adapter.ts`
  `deletePermanently` (:216/:256) + `emptyTrash` (:223/:261) throw bare
  `new Error(text)`, LOSING the code. Sole consumer (F4-verified):
  `src/components/passwords/detail/entry-list-view.tsx` (:418 deletePermanently,
  :430 emptyTrash), which today `catch { reload() }`.
  - **Consumer-flow walkthrough (locked)**: entry-list-view needs the `error` code
    string to branch on step-up; the adapter currently discards it. Contract: the
    two gated adapter throw-sites throw a typed error exposing
    `.code === "SESSION_STEP_UP_REQUIRED"`; entry-list-view's catch reads `.code`
    and calls `triggerOnStaleError` instead of a silent reload. The ungated
    adapter methods (restore/softDelete/setFavorite/setArchived) keep throwing
    plain Error — only the two gated sites change (F4).
  - entry-list-view wires `useInlineReauth` for both flows (or reuses the G15 hook
    where applicable).

### C5 — Base-webhook shared wiring (locked, F3)
base-webhook-card.tsx OWNS both gated fetchApi calls (create :155, delete :191);
tenant-webhook-card/team-webhook-card only inject endpoint strings. Wire once in
base. (This is a member of C2's list; called out separately because it closes two
route families with one edit.)

## Forbidden patterns
- pattern: a `catch\s*\{` block that contains the NEW step-up branch — reason:
  the 403 branch must live in the `!res.ok` block; `res.ok===false` is not a throw.
- pattern: hardcoded `"cancel"` literal as cancelLabel — reason: use i18n key.
- pattern: `import .*@prisma/client` in check-step-up-client-coverage.sh/.mjs —
  reason: must survive the no-prisma-generate static-checks CI job.

## Testing strategy
- **Per standalone (component, method)**: a step-up denial unit test (RT8) — mock
  `fetchApi` → 403 `SESSION_STEP_UP_REQUIRED`; assert the reauth dialog opens and
  the mutation is not reported as generic failure. ~14 standalone components/pages
  (do NOT collapse the 8 policy cards — each has its own handler). Multi-mutation
  components (mcp-client-card, service-account-card, admin members page) get one
  test PER gated method.
- **Test-count reconciliation (T7)**: fix-granularity is per (component, method).
  Test count = one denial test per gated method, NOT per component. Explicit total:
  8 policy cards (1 each) + tenant-members PUT + team-policy PUT + mcp-client
  {PUT, DELETE} (2) + service-account {PUT, DELETE, token-DELETE} (3) + scim-token
  DELETE + access-request deny + api-key DELETE + admin members {PUT, DELETE} (2) +
  transfer-ownership PUT + team-delete DELETE + base-webhook {POST, DELETE} per
  consumer (see below) + vault {permanent-delete, empty-trash, bulk-purge}. A
  multi-mutation member gets one test per gated method — do not collapse.
- **Shared abstractions need per-consumer, per-method tests (T3)**:
  - base-webhook-card: 403 tests in BOTH tenant-webhook-card.test.tsx AND
    team-webhook-card.test.tsx, each covering BOTH gated methods (POST create AND
    DELETE) — DELETE-webhook is a distinct F1-class gap from POST-create (T7). The
    two card tests diverge on the next-intl `useLocale` mock — a base-only test
    misses a variant that fails to supply dialog context.
  - G15/G16: an entry-list-view.test.tsx test that overrides use-bulk-action /
    adapter to return 403 for permanent-delete + empty-trash and asserts the dialog
    renders. entry-list-view.test.tsx currently mocks next-intl WITHOUT `useLocale`
    (:41) — either reuse `setupPasskeyReauthDialogMocks()` (stubs dialogs, sidesteps
    the gotcha) OR add `useLocale: () => "en"`; state which per new test file (T4).
- **C1 guard**: the `.test.mjs` self-test (7 fixtures in C1) IS the guard's
  regression proof (T1/T8/T9/C1-R3-5): handled-PASS, no-client-marker-FAIL,
  marker-without-adjacent-branch-FAIL, exempt-marker-absent-FAIL,
  server-call-without-marker-FAIL, orphan-client-marker-FAIL, and the
  two-handlers-one-file fixture (F1 regression lock). Plus the two-way mutation demo
  (remove marker → coverage RED; remove branch → handling RED on the multi-mutation
  mcp-client-card, which now goes RED correctly under adjacency-scoping).
- **E2E (T6)**: (a) run `e2e/tests/trash.spec.ts` after C4 — it already exercises
  empty-trash step-up via `refreshSessionRecency` and could regress on the happy
  path. (b) Add one E2E asserting the reauth dialog appears when empty-trash /
  permanent-delete runs on a STALE window (omit `refreshSessionRecency`), mirroring
  vault-reset.spec.ts. E2E is outside pre-pr default gate — run explicitly.
- Full `npx vitest run`, `npx next build`, `bash scripts/pre-pr.sh`.

## Considerations & constraints

### Scope contract
- SC1: OAuth/mobile direct-`requireRecentSession` routes (mcp/authorize,
  mcp/authorize/consent, mobile/authorize) — out of scope; not mutating-UI cards.
- SC2: S1 null-vaultAutoLock cross-bound gap (auto-lock PR) — separate PR
  `TODO(vault-null-autolock-default)`.
- SC3: team-vault-core background confirm-key poller — allowlisted in C1, not
  user-facing (no awaiting gesture).
- SC4: operator-token-card — uses `OPERATOR_TOKEN_STALE_SESSION` custom recovery;
  allowlisted, not a `SESSION_STEP_UP_REQUIRED` consumer. Not unifying in this PR.

### Risk
- Large blast radius (~24 (component,method) fixes + a marker on every gated
  mutation across ~16+ files). Mitigation: guard-first with a MARKER-based coverage
  gate (not path-inference — F7). The gate matches stable `@stepup id:X` markers
  between server and client, so it needs no fragile path resolution and cannot go
  blind to raw-literal / prop-indirection / helper callers. "Did we get them all"
  = the coverage gate's `S \ C` is empty. R42 ①b: member-set expanded ≥2×
  (8→16→24+), so a mutation-verified CI guard is the REQUIRED convergence artifact.
- Marker-scheme cost: adding a server marker to every gated handler and a client
  marker to every gated call site is one comment line each (no logic change for the
  ~15 already-handled members). This up-front cost buys the fail-closed coverage gate.

## User operation scenarios
1. Admin edits any tenant security policy / mcp-client / service-account / api-key /
   webhook / scim-token after the 15-min step-up window lapses → expects a reauth
   prompt, not a silent/generic error.
2. Admin permanently deletes a trashed entry / empties trash / bulk-purges after
   the window lapses → expects reauth, not a silent list reload.
3. Team owner transfers ownership / removes a member / deletes a team from the admin
   pages after the window lapses → expects reauth.

## Go/No-Go Gate
| ID | Subject | Status |
|----|---------|--------|
| C1 | Marker-verified client-coverage guard (adjacency-scoped, implement FIRST) | locked (Round 3: adjacency-window + line-bound server marker + fixture vii) |
| C2 | Fix all card/dialog/hook callers + marker rollout | locked (member-set verified; guard S\C authoritative) |
| C3 | Admin full-page callers | locked |
| C4 | Vault permanent-delete / empty-trash / bulk-purge | locked (F4 typed-error contract) |
| C5 | Base-webhook shared wiring | locked (F3 base owns fetchApi) |
