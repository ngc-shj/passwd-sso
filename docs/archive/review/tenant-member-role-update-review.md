# Plan Review: tenant-member-role-update
Date: 2026-03-11
Review rounds: 2

## Pre-screening (Local LLM)

9 findings identified and addressed before expert review:
- Critical: SCIM guard, concurrent transfer safety, IDOR risk
- Major: audit metadata completeness, request body validation
- Minor: UI scope, test coverage, OpenAPI spec, translation references

All addressed in plan update before Round 1.

## Round 1

### Functionality Findings

1. **[Major → Resolved]** Self-change ordering risk: self-change prevention must precede ownership transfer logic to prevent OWNER-less tenant. → Added explicit ordering note in Step 7.
2. **[Major → Resolved]** RLS + transaction nesting: `withTenantRls` already wraps in `$transaction`; nesting would cause errors. → Changed to sequential updates inside `withTenantRls`, matching team pattern.
3. **[Minor → Resolved]** UI redundancy: separate ownership transfer section unnecessary. → Integrated OWNER option into Select with AlertDialog confirmation.
4. **[Minor → Resolved]** tenantId filter: explicit `where` clause needed for defense-in-depth. → Added explicit `tenantId: actor.tenantId` filter alongside RLS.

### Security Findings

1. **[Major → Resolved]** Transaction nesting with RLS (same as Functionality #2). → Resolved with sequential updates inside `withTenantRls`.
2. **[Major → Resolved]** Missing explicit tenant isolation (same as Functionality #4). → Resolved with defense-in-depth filter.
3. **[Minor → Resolved]** Session cache behavior undocumented. → Added to Considerations section.

### Testing Findings

1. **[Major → Resolved]** No unit tests for new API route. → Added Step 7b with 13 comprehensive test cases.
2. **[Major → Resolved]** `audit.test.ts` missing `AUDIT_ACTION_GROUPS_TENANT` validation. → Added to Step 3.
3. **[Minor → Deferred]** Tenant role constants test. → `satisfies` provides type-level checking; deferred.
4. **[Minor → Noted]** Custom hook extraction for testability. → Not required; follows existing pattern.

## Round 2

### Functionality Findings

1. **[Minor → Resolved]** Step 10 (scimManaged response) should precede Step 9 (UI). → Reordered to Step 9/10.

### Security Findings

1. **[Minor → Resolved]** Ownership transfer operation order reversed from reference. → Changed to demote-first (actor → ADMIN, then target → OWNER).
2. **[Minor → Accepted]** TOCTOU race condition on concurrent ownership transfers. → Existing pattern issue (same in team route); out of scope for this change.

### Testing Findings

No findings.
