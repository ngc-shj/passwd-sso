# Plan: Share client vault auto-lock default with server cross-bound validation

TODO marker being closed: `TODO(vault-null-autolock-default)`
Tracked in: PR #642 follow-up ("Follow-up (separate PR)" section).

## Project context

- **Type**: web app (Next.js 16 App Router API route + React client component)
- **Test infrastructure**: unit + integration (`vitest`) + E2E (Playwright) + CI/CD (`scripts/pre-pr.sh`, GitHub Actions)
- **Verification environment constraints**: none that block this change. The affected surface is:
  - Pure integer validation in an API route handler → `verifiable-local` via `vitest` route tests.
  - A client-side default constant → `verifiable-local` via the existing `auto-lock-context.test.tsx`.
  - No paid-tier API, no external service, no hardware attestation, no multi-billing-account isolation. All manual-test paths are `verifiable-local`.

## Objective

Close the fail-open gap where the tenant-policy PATCH handler skips the
`vaultAutoLock <= sessionIdle` (and `<= extensionTokenIdle`) cross-bound check
whenever `vaultAutoLockMinutes` is `null`, even though the client applies a
hardcoded 15-minute default in that same null case. An admin can set
`sessionIdleTimeoutMinutes = 5` while leaving `vaultAutoLockMinutes` null; the
server accepts it, and the client then runs a 15-minute auto-lock that exceeds
the 5-minute idle timeout — exactly the "logged out but locally readable"
state the invariant exists to prevent.

## Requirements

Functional:
- R-F1: The client's 15-minute auto-lock default MUST be a single named
  constant shared with the server, not a magic literal duplicated per-side.
- R-F2: When `vaultAutoLockMinutes` resolves to `null` (neither request nor DB
  supplies a value), the server cross-bound check MUST validate against the
  shared default (15), matching the client's effective behavior.
- R-F3: A partial PATCH that lowers `sessionIdleTimeoutMinutes` (or
  `extensionTokenIdleTimeoutMinutes`) below the default MUST be rejected when
  `vaultAutoLockMinutes` is null — the same rejection the user would get if
  they had explicitly set `vaultAutoLockMinutes = 15`.

Non-functional:
- R-N1: No behavior change to the explicit-value path (a non-null
  `vaultAutoLockMinutes` already validated correctly and must keep doing so).
- R-N2: `needsCurrentState` must already fetch the DB row for the paths R-F3
  covers (it does — `vaultAutoLockMinutes`, `sessionIdleTimeoutMinutes`,
  `extensionTokenIdleTimeoutMinutes` each set `needsCurrentState`). No new DB
  read introduced.

## Technical approach

Single shared constant + null-coalescing merge.

1. Add `VAULT_AUTO_LOCK_DEFAULT = 15` to `src/lib/validations/common.ts`,
   adjacent to the existing `VAULT_AUTO_LOCK_MIN` / `VAULT_AUTO_LOCK_MAX`.
   The value is chosen to keep the client's current runtime behavior
   (`DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * MS_PER_MINUTE`) byte-for-byte
   unchanged — this is an extraction, not a value change.

2. Client (`src/lib/vault/auto-lock-context.tsx`): replace the literal `15` in
   `DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * MS_PER_MINUTE` with
   `VAULT_AUTO_LOCK_DEFAULT * MS_PER_MINUTE`. `common.ts` is
   client-import-safe (already imported by the client card
   `tenant-session-policy-card.tsx` for `VAULT_AUTO_LOCK_MIN/MAX`), so no
   server-only code leaks into the client bundle.

3. Server (`src/app/api/tenant/policy/route.ts`): change the
   `mergedVaultAutoLock` fallback from `?? null` to `?? VAULT_AUTO_LOCK_DEFAULT`
   so the merged effective value mirrors the client. The two downstream
   `typeof mergedVaultAutoLock === "number"` guards then fire in the null case
   (they were previously short-circuited by the `null` value being non-numeric).

No cross-field logic beyond the two existing comparisons changes. The
comparison thresholds (`mergedSessionIdle`, `mergedExtIdle`) keep their `?? null`
fallback — when the idle timeout itself is null we still cannot compare, which
is correct because the GET default for session idle (`SESSION_IDLE_TIMEOUT_DEFAULT
= 8h`) is far above 15 and the write path for those fields is non-nullable
anyway.

### Why `mergedVaultAutoLock`'s default changes but the comparison operands don't

The invariant is `effective(vaultAutoLock) <= effective(sessionIdle)`. The
client's `effective(vaultAutoLock)` when the stored value is null is 15 (the
shared default). So the server must compare 15, not skip. For the RHS,
`effective(sessionIdle)` when null is 8h (`SESSION_IDLE_TIMEOUT_DEFAULT`), which
is `>= 15` for any legal config, so leaving the RHS `?? null` (skip when null)
can only ever *under*-reject, never *over*-reject — and since idle-timeout
fields are non-nullable on write (see route.ts:273-284, they reject explicit
null), a null RHS only occurs for a legacy row that predates the non-null
migration, where skipping is the conservative choice. Changing only the LHS
default is the minimal correct fix.

## Contracts

### C1 — Shared default constant

- **Signature**: `export const VAULT_AUTO_LOCK_DEFAULT = 15;` in
  `src/lib/validations/common.ts`.
- **Invariants** (app-enforced):
  - INV-C1a: `VAULT_AUTO_LOCK_MIN <= VAULT_AUTO_LOCK_DEFAULT <= VAULT_AUTO_LOCK_MAX`
    (5 <= 15 <= 1440). A default outside the accepted range would let the
    server derive an effective value the PATCH validator would itself reject.
  - INV-C1b: The numeric value equals the client's pre-change literal (15), so
    the extraction is behavior-preserving.
- **Forbidden patterns** (grep keys for Phase 2-4 conformance):
  - `pattern: 15 \* MS_PER_MINUTE — reason: the client 15-min literal must be replaced by VAULT_AUTO_LOCK_DEFAULT * MS_PER_MINUTE; a surviving literal means the extraction was not applied`
  - `pattern: mergedVaultAutoLock[\s\S]{0,80}\?\? null — reason: the server LHS fallback must coalesce to VAULT_AUTO_LOCK_DEFAULT (wrapping the whole ternary), not null; a surviving ?? null on mergedVaultAutoLock means the fix was not applied or was applied only to the DB branch (S1)`
- **Acceptance criteria**:
  - `grep VAULT_AUTO_LOCK_DEFAULT src/lib/validations/common.ts` returns the export.
  - The constant is imported by both `auto-lock-context.tsx` and
    `route.ts`.

### C2 — Client default uses the shared constant

- **Signature**: `const DEFAULT_INACTIVITY_TIMEOUT_MS = VAULT_AUTO_LOCK_DEFAULT * MS_PER_MINUTE;`
  in `src/lib/vault/auto-lock-context.tsx`.
- **Invariants** (app-enforced):
  - INV-C2a: `DEFAULT_INACTIVITY_TIMEOUT_MS` numeric value is unchanged
    (still 900000 ms). Verified by the existing null-prop test in
    `auto-lock-context.test.tsx` (autoLockMinutes={null} → 15-min behavior).
- **Consumer-flow walkthrough**:
  - Consumer: `AutoLockProvider` (path: `src/lib/vault/auto-lock-context.tsx`)
    reads `autoLockMinutes: number | null` prop and, when null/undefined,
    falls back to `DEFAULT_INACTIVITY_TIMEOUT_MS` for `autoLockMsRef`. It uses
    that ref in `checkInactivity` (`now - lastActivity > autoLockMsRef.current`).
    The change only redefines the constant's *source*; the null→default branch
    logic (lines 29-32) is untouched. No new field required.
- **Acceptance criteria**:
  - `auto-lock-context.test.tsx` passes unchanged (behavior preserved).
  - No literal `15 * MS_PER_MINUTE` remains in the source file.
  - **Value-regression guard (T4, round 1)**: `auto-lock-context.test.tsx`
    currently re-derives `DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * MS_PER_MINUTE`
    locally (line 9), so a wrong value in the C2 extraction could pass
    vacuously (the local literal and the behavioral `advanceTimersByTime` margin
    move together). Add a direct assertion that imports the shared constant:
    `import { VAULT_AUTO_LOCK_DEFAULT } from "@/lib/validations/common";` then
    `expect(VAULT_AUTO_LOCK_DEFAULT).toBe(15);` (and/or
    `expect(VAULT_AUTO_LOCK_DEFAULT * MS_PER_MINUTE).toBe(900_000);`). This
    catches an accidental unit/value change (INV-C2a, INV-C1b) by direct import
    rather than by re-deriving the same literal in two places.

### C3 — Server cross-bound check validates the null case

- **Signature** (the changed expression, no new function):
  ```
  const mergedVaultAutoLock =
    (vaultAutoLockMinutes !== undefined
      ? vaultAutoLockMinutes
      : currentTenant?.vaultAutoLockMinutes) ?? VAULT_AUTO_LOCK_DEFAULT;
  ```
  in `src/app/api/tenant/policy/route.ts` (was `... ?? null`).

  **The `?? VAULT_AUTO_LOCK_DEFAULT` MUST wrap the ENTIRE ternary**, not just
  the DB-fallback branch. If it sits only on the DB branch (as an earlier draft
  of this plan mistakenly specified — `vaultAutoLockMinutes !== undefined ?
  vaultAutoLockMinutes : currentTenant?.vaultAutoLockMinutes ?? DEFAULT`), an
  explicit `null` in the request body takes the first branch (`null !==
  undefined` is true), yielding `mergedVaultAutoLock = null`, and the downstream
  `typeof === "number"` guard skips the check — the exact fail-open this fix
  exists to close would persist for the explicit-null API path (S1, round 1).
- **Invariants** (app-enforced):
  - INV-C3a: When the PATCH would leave `vaultAutoLockMinutes` null AND
    `effective(sessionIdle) < VAULT_AUTO_LOCK_DEFAULT`, the handler returns
    `VALIDATION_ERROR` (400). This is the fail-open closure.
  - INV-C3b: When `vaultAutoLockMinutes` is explicitly null in the request
    (user disabling the per-tenant override), the merge coalesces null →
    `VAULT_AUTO_LOCK_DEFAULT` because the `??` wraps the whole ternary, so an
    explicit-null PATCH is validated identically to an unset one — there is no
    way to bypass the check by sending `null`. (This invariant is FALSE for the
    DB-branch-only placement; the whole-ternary placement above is what makes it
    hold.)
  - INV-C3c: The stored DB value is still `null` (line 828-830 writes
    `vaultAutoLockMinutes ?? null`); only the *validation* uses the default.
    The GET response still returns `null` (line 138) so the client can
    distinguish "unset (apply 15 default)" from "explicitly 15". This preserves
    the round-trip the client card relies on
    (`autoLockEnabledVal = !(autoLockVal === null || undefined)`).
- **Edge cases**:
  - EC1: `vaultAutoLockMinutes` explicitly null in request, `sessionIdle = 5`
    → 400 (previously 200 — the bug; the whole-ternary `??` placement is what
    makes this case reject, per INV-C3b). New behavior.
  - EC2: `sessionIdleTimeoutMinutes = 5` in request, `vaultAutoLockMinutes`
    absent from request, DB null → 400 (previously 200 — the bug). New behavior.
  - EC2b: `extensionTokenIdleTimeoutMinutes = 5` in request, `vaultAutoLockMinutes`
    absent from request, DB null → 400 (previously 200 — same bug, extension-token
    variant; both guards share `mergedVaultAutoLock`, so the single LHS-default
    fix closes both, but this variant is tested independently so a future
    refactor of one branch cannot silently regress the other — T3, round 1).
    New behavior.
  - EC3: `vaultAutoLockMinutes = 10`, `sessionIdle = 20` → 200 (unchanged).
  - EC4: both absent, DB both null → merged autoLock 15, merged sessionIdle
    null (RHS skip) → 200 (unchanged; no over-rejection).
  - EC5: `vaultAutoLockMinutes = 20`, `sessionIdle = 15` → 400 (unchanged).
  - EC6 (legacy-null-idle skip, SC1 proof): DB `sessionIdleTimeoutMinutes = null`
    (pre-migration legacy row), request `vaultAutoLockMinutes = 10`, no idle field
    in request → 200 (RHS null → comparison skipped, conservative). Proves the
    RHS `?? null` skip path is intentional, not an accident (F1, round 1).
- **Consumer-flow walkthrough** (server response shape unchanged):
  - Consumer: `tenant-session-policy-card.tsx` (path:
    `src/components/settings/security/`) reads `vaultAutoLockMinutes` from both
    GET and PATCH JSON. It derives `autoLockEnabledVal = !(val === null ||
    undefined)`. Because C3 does NOT change the stored/returned value (still
    null when unset — INV-C3c), the card's enable-toggle round-trip is
    unaffected. The only observable change is that a PATCH which *would* have
    silently accepted an inconsistent config now returns a 400 the card already
    surfaces via its existing `errorResponseWithMessage` toast path
    (the card already renders server validation messages, see line ~263 comment
    "errors (e.g. vaultAutoLock...)").
- **Acceptance criteria**:
  - Route tests live in `src/__tests__/api/tenant/tenant-policy.test.ts` (the
    file that ALREADY owns the cross-bound invariant tests — the ext-idle case
    at its `Cross-field invariant` describe block, ~lines 331-370). Add EC1,
    EC2, EC2b, EC3, EC4, EC5, EC6 as new `it()` blocks in that same describe
    block, reusing its `mockTenantFindUnique` fixture pattern. Do NOT add them to
    `src/app/api/tenant/policy/route.test.ts` (a separate sibling file that has
    no cross-bound tests — splitting them across two files causes drift; T1,
    round 1).
  - EC1, EC2, EC2b → 400 with the `must be <= sessionIdleTimeoutMinutes` /
    `must be <= extensionTokenIdleTimeoutMinutes` message. EC3-EC6 behavior as
    stated.
  - **Red-before/green-after gate (T2, round 1)**: EC2 (the reported bug) MUST be
    added and run BEFORE the C3 code change, and observed to FAIL (returns 200,
    not 400). Only then apply the whole-ternary `?? VAULT_AUTO_LOCK_DEFAULT` and
    re-run to confirm 400. The PR must make this checkable — commit the test
    first, or paste the pre-fix failure in the PR body. A test added after the
    fix that "happens to pass" is a decorative test and does not satisfy this
    criterion.
  - **EC1 is the placement-footgun proof (T6, round 2)**: the red-green gate MUST
    ALSO cover EC1 (explicit-null request). EC1 and EC2 exercise DIFFERENT
    branches of the merge ternary — EC2 hits the DB-fallback branch, EC1 hits the
    request branch. The DB-branch-only `??` misplacement this plan warns against
    (C3 Signature note) would make EC2 pass while EC1 stays broken. So EC2 alone
    does NOT prove the whole-ternary placement; EC1 does. Require observing EC1
    fail pre-fix (200) and pass post-fix (400) as the mechanized proof of
    INV-C3b, not just a review-time prose check.

## Go/No-Go Gate

| ID | Subject                                             | Status |
|----|-----------------------------------------------------|--------|
| C1 | Shared `VAULT_AUTO_LOCK_DEFAULT` constant            | locked |
| C2 | Client default consumes the shared constant          | locked |
| C3 | Server cross-bound check validates the null case     | locked |

C3 was re-opened in round 2 for the S1 signature correction (whole-ternary `??`
placement) and re-locked after the security round-2 re-verification confirmed the
explicit-null bypass is closed. All three contracts are in final form.

## Testing strategy

- Unit (route): add EC1-EC6 to `src/__tests__/api/tenant/tenant-policy.test.ts`
  in its existing `Cross-field invariant` describe block (~lines 331-370), NOT
  to `src/app/api/tenant/policy/route.test.ts` (T1). Assert status code and, for
  the 400 cases, the error message substring (`sessionIdleTimeoutMinutes` for
  EC1/EC2, `extensionTokenIdleTimeoutMinutes` for EC2b). Reuse the file's
  `mockTenantFindUnique` fixture and set a complete `currentTenant` including all
  three relevant fields (`vaultAutoLockMinutes`, `sessionIdleTimeoutMinutes`,
  `extensionTokenIdleTimeoutMinutes`) in every case — not just the one being
  varied — so no field silently resolves `undefined` vs `null` (T5).
- Unit (client): `auto-lock-context.test.tsx` already covers `autoLockMinutes={null}`
  → 15-min behavior; it must stay green (proves INV-C2a). Additionally add the
  direct-import value-regression assertion required by C2 acceptance (T4) so a
  wrong extraction value cannot pass vacuously.
- Regression discipline (T2): EC2 is the exact reported bug. Its test MUST be
  added and observed to FAIL on the pre-fix `?? null` (returns 200) BEFORE the
  C3 change, then pass (400) after `?? VAULT_AUTO_LOCK_DEFAULT` (per
  common/testing.md: bug fix ships a regression test red-before / green-after).
  This is a checkable gate, not prose — see C3 acceptance criteria.
- Full suite: `npx vitest run` + `npx next build` (mandatory per CLAUDE.md).

## Considerations & constraints

- **Scope contract**:
  - SC1: The RHS (`mergedSessionIdle` / `mergedExtIdle`) null-fallback is
    deliberately NOT changed to a default — owned by this plan's "Why the
    comparison operands don't change" rationale. Legacy null idle rows skip the
    check conservatively; changing this is out of scope and unnecessary because
    write-path idle fields are non-nullable.
  - SC2: No schema migration. `vaultAutoLockMinutes` stays nullable in the DB;
    the default lives only in application code (client + server validation).
    A CHECK-constraint / schema-enforced form is out of scope because the
    invariant is cross-column and cross-effective-default (it depends on the
    client's runtime default, which the DB cannot know).
- **Known risk**: an existing tenant with `vaultAutoLockMinutes = null` and a
  `sessionIdleTimeoutMinutes < 15` already persisted (set before this fix) will
  now get a 400 on their *next* policy PATCH even if they didn't touch either
  field — because `needsCurrentState` fetches the row and the merge re-validates.
  Worst case: an admin editing an unrelated field (e.g. a retention day) is
  blocked until they either raise sessionIdle to >= 15 or set an explicit
  vaultAutoLock <= sessionIdle. Likelihood: low (requires a pre-existing
  sub-15-min idle timeout with null auto-lock, an unusual combination — the
  idle-timeout min is well below 15 so it is *possible*). Cost to fix if it
  bites: the error message already tells the admin exactly what to set. This is
  the correct fail-closed direction (the config was already inconsistent). We
  accept it as the intended behavior, not a defect. Documented here so Phase 3
  does not re-raise it as a surprise.

## User operation scenarios

1. Admin opens Security → Session Policy, leaves "vault auto-lock" toggle OFF
   (null), sets session idle timeout to 5 minutes, saves → now blocked with
   "vaultAutoLockMinutes (15) must be <= sessionIdleTimeoutMinutes (5)". Before
   this fix: silently saved, then the vault ran a 15-min auto-lock over a 5-min
   session. After: admin either raises idle to >= 15 or turns the auto-lock
   toggle ON and picks a value <= 5.
2. Admin with a healthy config (idle 480 min, auto-lock OFF) edits an unrelated
   retention field → still saves fine (merged autoLock 15 <= 480).
3. Admin explicitly sends `vaultAutoLockMinutes: null` via API with idle 5 →
   400 (cannot bypass the check by disabling the override).
