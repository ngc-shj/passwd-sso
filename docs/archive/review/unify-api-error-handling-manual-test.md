# Manual Test Plan: unify-api-error-handling — admin page .then→await migration

## Scope

Round 8 of the unify-api-error-handling code review converted `.then()` chain
Response handlers to `await` form across several admin (Tier-1 admin-IA)
pages so that Gate rule 8 covers them. The changes are mechanical —
wire-byte-identical behavior — but R35 Tier-1 requires a manual verification
checklist for any admin-IA touch.

## Pre-conditions

- A logged-in OWNER or ADMIN tenant user (substitute the test tenant's
  operator account).
- At least one team in the tenant with members, audit-log entries, and
  a non-default profile (name / description).
- A second test user reachable for the ownership-transfer flow.

## Steps (verify each admin page renders + handles auth correctly)

### A. `src/app/[locale]/admin/tenant/teams/page.tsx`
1. Navigate to `/dashboard/admin/tenant/teams` while signed in as the
   tenant OWNER.
2. **Expected**: the page lists every team in the tenant with their member
   counts and a link to `/dashboard/admin/teams/<teamId>/...`. No
   "Forbidden" or "Failed to load" message.
3. Sign out and visit the same URL.
4. **Expected**: redirected to the sign-in page (proxy session gate).

### B. `src/app/[locale]/admin/teams/[teamId]/general/profile/page.tsx`
1. As OWNER, navigate to `/dashboard/admin/teams/<teamId>/general/profile`.
2. **Expected**: team name + description load. Field values match
   the team's actual record.
3. Edit the team name to a new value and submit.
4. **Expected**: name updates persist on reload.
5. Sign out, visit the URL again.
6. **Expected**: "Forbidden" toast or redirect to sign-in (the page's
   error-path used to throw on `!r.ok`; verify it still does after the
   await migration).

### C. `src/app/[locale]/admin/teams/[teamId]/general/delete/page.tsx`
1. Create a throwaway team via the standard UI flow.
2. As OWNER, navigate to `/dashboard/admin/teams/<throwawayTeamId>/general/delete`.
3. **Expected**: confirmation form loads with the throwaway team's name.
4. Confirm and submit.
5. **Expected**: team is deleted; redirect away from the page.

### D. `src/app/[locale]/admin/teams/[teamId]/members/list/page.tsx`
1. As OWNER, navigate to `/dashboard/admin/teams/<teamId>/members/list`.
2. **Expected**: member list loads with each member's name, email, role,
   and last-active timestamp.
3. Add a new member via the available UI control.
4. **Expected**: new member appears in the list without page reload.

### E. `src/app/[locale]/admin/teams/[teamId]/members/transfer-ownership/page.tsx`
1. As OWNER, navigate to the transfer-ownership page for a test team.
2. **Expected**: form loads with current OWNER information and a
   dropdown of eligible team members.
3. Select a different member and submit.
4. **Expected**: ownership transfers successfully; the current operator
   is no longer OWNER of that team.

### F. `src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx`
1. As OWNER, navigate to `/dashboard/admin/teams/<teamId>/audit-logs`.
2. **Expected**: audit log entries load with timestamps and actor names.
3. Apply a date-range filter.
4. **Expected**: filtered results render correctly (filter behavior
   unchanged by this migration).

## Expected results

- All admin pages load on the success path identically to before the
  migration (wire-byte-identical).
- All error paths produce the same UX as before:
  - `if (!r.ok) throw new Error("Forbidden")` continues to surface
    "Forbidden" to the user via the surrounding error boundary or toast.
  - `.then((r) => r.json())` unconditional reads on `/api/auth/session`
    that this round added an explicit `!res.ok` guard for now gracefully
    redirect to sign-in instead of crashing on a 401 body parse.

## Rollback

If any admin page regresses, revert commit `0370d8e8`:

```bash
git revert --no-edit 0370d8e8
```

Pages return to the pre-migration `.then()` chain form. No data migration
involved.

## Adversarial scenarios (Tier-2 N/A)

This migration does NOT modify auth flows, authorization decisions,
cryptographic material, session lifecycle, identity-broker trust, or
webhook signing keys. R35 Tier-2 adversarial scenarios are not required.

## Verification log

(operator fills in actual results inline with timestamp + author after live
verification)
