# Coding Deviation Log: step-up-client-policy-card

## D1 — Member-set is 45 gated (route, method) server call sites, not the plan's ~24
The plan estimated ~24 members and warned of ≥2× expansion. The authoritative
`grep -rnE '(^|[^A-Za-z0-9_])requireRecentCurrentAuthMethod\(' src/app` yields **45**
server call sites across 35 route files. This is the expected R42 expansion, not a
re-scope: the guard-first marker scheme is the convergence artifact the plan mandated
for exactly this. Classification: 3 EXEMPT + ~19 already-HANDLED (marker-only) + 23 FIX
(new client branch). Full table in the plan's Implementation Checklist.

## D2 — Shared client helper extracted (reverses the handoff's "do not extract a wrapper")
The handoff doc (docs/archive/review/step-up-client-handoff.md §"Per-component fix
recipe") said "Convention is INLINE per-component ... do NOT extract a shared wrapper."
That convention was OVERRIDDEN by an explicit user instruction on 2026-07-08:
「共通処理にできる箇所は？を意識してコーディングしてください」. Extracted
`src/lib/http/handle-step-up-error.ts`: `handleStepUpError(res, trigger, arg?)`,
`isStepUpRequired(body)`, plus a typed-error layer for non-hook adapters
(`StepUpRequiredError`, `isStepUpRequiredError`, `throwIfStepUp`). ~23 FIX sites and the
~19 HANDLED sites use it (a few keep the raw-literal branch where the parsed body is
reused for other error codes — a clean handleStepUpError swap there would double-consume
`res.json()`). The C1 guard's client-branch token set accepts the helper tokens
(`handleStepUpError(`, `throwIfStepUp(`, `isStepUpRequiredError(`) in addition to the raw
`SESSION_STEP_UP_REQUIRED` literal.

## D3 — C4 uses a typed error, not just the fetch helper (F4 contract)
The vault-list adapters (`personal`/`team-vault-list-adapter.ts`) are non-hook async
methods that cannot open a dialog. Their two gated methods (deletePermanently,
emptyTrash) call `throwIfStepUp(res)` → throw `StepUpRequiredError`; the sole consumer
`entry-list-view.tsx` catches it with `isStepUpRequiredError(e)` and opens reauth. Bulk-
purge goes through `use-bulk-action.ts` (a hook) via a new `onStepUpRequired` option.

## D4 — Review-round fixes (2026-07-08, two external review passes)
- **F1 (Medium, security-UX)**: entry-list-view optimistically removed the row BEFORE
  the permanent-delete server call and, on step-up 403, opened reauth and returned
  WITHOUT rollback — a purged-looking-but-still-alive secret. Fixed: `reload()` rolls
  back the optimistic removal before opening reauth; the reauth-success retry commits the
  removal (onEntryRemoved + notifyDataChanged + onDataChange) for real. Regression test
  added (asserts the entry is still visible after a step-up denial).
- **F2 (Low/Med, guard strength)**: `throwIfStepUp(` alone satisfied the client-branch
  check without proving any consumer catches it. Added a `STEPUP_THROWER_WITHOUT_CATCHER`
  existence-level pairing check (thrower present ⇒ `isStepUpRequiredError(` catcher must
  exist) + self-test fixture (viii). Documented the residual limitations honestly in the
  guard header: coverage is a set comparison (a shared route-id like `tenant-policy-patch`
  is satisfied by ONE of its 8 cards; all 8 are wired here, review-verified), and the
  thrower↔catcher pairing is existence-level not per-call-site (call-site ids are the
  escalation if that becomes a real regression).
- **E2E hygiene note**: the new stale-window spec mutates the shared `vaultReady` session;
  added `afterAll` → `refreshSessionRecency` so a later-ordered spec isn't left stale.

## D5 — E2E authored but not executed (verifiable-local gate)
`e2e/tests/step-up-stale-window.spec.ts` (+ `makeSessionStale` helper in e2e/helpers/db.ts)
is authored and type-consistent with the page objects, but NOT run: the full E2E stack
(Postgres + Redis + Jackson + Next.js server, seeded via global-setup) is not up, and E2E
is outside pre-pr's default gate (project_ci_gates_beyond_pre_pr). Existing
`e2e/tests/trash.spec.ts` (empty-trash on a refreshed session) is unchanged and covered by
the same infra. Run both when the stack is available.

## D6 — Stray test file removed
A sub-agent created a misnamed duplicate `src/components/settings/security/debug-token.test.tsx`
that actually rendered `TenantTokenPolicyCard` (duplicate of tenant-token-policy-card.test.tsx).
Deleted — coverage already lives in the correctly-named file.
