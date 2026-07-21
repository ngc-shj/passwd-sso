# Deviation Log: null-tenant-fail-open

## D1 — Member-set grew from 4 (plan) to 7 (implementation)

The plan scoped 5 fixes + several fail-safe/excluded members. Round 2 security
review surfaced `auth-adapter.ts` (concurrent-session cap, #5) as an uncovered
same-class sibling; a subsequent exhaustive sweep from the primitive surfaced the
webauthn PIN gate (#6) and the extension-token TTL pair (#7). All three are the
same class (FK-backed tenantId, null-row → permissive side) and were folded in
per "close the defect class, not instances." This 3× accretion triggered the
mutation-verified CI-guard convergence requirement (R42 ①b).

## D2 — extension-token: throw on null ROW, keep `?? DEFAULT` for null FIELD

The columns are non-nullable with schema defaults, so `?? DEFAULT` only ever
fired on a null ROW (corruption). The fix throws on the null row but retains the
field-level `?? DEFAULT` as a defensive floor (a field-null would otherwise yield
a 0-minute TTL). This keeps the pre-existing `field-null → DEFAULT` unit test
valid while closing the corruption fail-open.

## D3 — webauthn test default mock corrected

The shared `beforeEach` mock used `tenant: null`, which the fix now treats as
corruption. Since `User.tenantId` is a non-null FK (Prisma always joins the row),
the realistic default is `tenant: { requireMinPinLength: null }` ("no PIN policy
set"). Updated the shared default and reserved `tenant: null` for the dedicated
corruption regression test.

## D4 — CI guard is a manifest, not a `throw`-requirement grep

An initial guard draft required a literal `if (!tenant) throw` on every
enforcement read. That falsely flagged the fail-SAFE members (account-lockout,
session-timeout return a restrictive default, not a throw) and the display
routes. Redesigned to a completeness manifest: every enforcement read carries a
reviewed disposition (throw / failsafe-default / display-exempt); the guard fails
on divergence (new unclassified read or vanished stale entry). This mechanizes
completeness without falsely mandating one specific fail-closed spelling.

## D5 — External review round: 3 fail-open/guard-strength findings fixed

See Round 3 in the code-review doc. Summary of decisions:
- auth-gate null-tenant → fail closed (deactivated member = revoked membership,
  not a legit no-tenant user; symmetric with extension-token C13).
- lockout fetch-failure → strictest threshold (lock at 1 / max duration), NOT the
  schema-default and NOT a throw (throw would drop the unrecorded attempt).
- CI guard → ts-morph AST per-read-site with disposition-vs-implementation
  verification, replacing the file-set-only manifest (closed the 3 intra-file
  mutation blind spots).
