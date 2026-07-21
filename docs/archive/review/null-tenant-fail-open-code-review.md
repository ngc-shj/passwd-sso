# Code Review: null-tenant-fail-open

Date: 2026-07-21
Review rounds: 2 (triangulate: 3 experts × derive+judge, then 3 experts × verify-fixes)

## Summary

Follow-on to PR #685. Closed the **null-tenant fail-open enforcement class**: an
enforcement decision reads a tenant/team security policy and, on a null/missing
row, falls back to the unsafe (permissive) side. The controlling distinction:
null = "operator never configured" → permissive default is correct; null =
"fetch failed / row vanished / corruption" on an FK-backed path → must fail closed.

Class member-set expanded 4 → 5 → 7 across review (R42 accretion signature),
which triggered the mutation-verified CI-guard convergence requirement.

## Member-set (R42, three-expert converged, then extended in Round 2)

| # | Member | file | Verdict | Action |
|---|--------|------|---------|--------|
| 1 | `getTenantAccessPolicy` null-tenant → empty permissive policy (cached) | `src/lib/auth/policy/access-restriction.ts` | FAIL-OPEN | throw on null row; don't cache |
| 2 | proxy `getSessionInfo` swallows `resolveUserTenantId` throw → IP gate skipped | `src/lib/proxy/auth-gate.ts` | FAIL-OPEN | `{valid:false}` on throw (null return unchanged) |
| 3 | `checkTeamAccessRestriction` inherit path, null tenant CIDR fetch → allow | `src/lib/team/team-policy.ts` | FAIL-OPEN | throw `PolicyViolationError` on null resolution/row |
| 4 | `getLockoutThresholds` `catch → DEFAULT` silent swallow | `src/lib/auth/policy/account-lockout.ts` | Silent-swallow (Major) | warn-log before default (default is already fail-safe) |
| 5 | `createSession` `tenant?.maxConcurrentSessions` → cap skipped on null | `src/lib/auth/session/auth-adapter.ts` | FAIL-OPEN | throw on null row |
| 6 | `webauthn/register/verify` `tenant?.requireMinPinLength ?? null` → PIN gate skipped | `src/app/api/webauthn/register/verify/route.ts` | FAIL-OPEN | throw on null relation |
| 7 | `issueExtensionToken` + refresh `tenant?.…Timeout ?? DEFAULT` → longer TTL on null | `src/lib/auth/tokens/extension-token.ts`, `src/app/api/extension/token/refresh/route.ts` | FAIL-OPEN | throw on null row; keep `?? DEFAULT` field-floor |

### Verified FAIL-SAFE (no change)

- `session-timeout.ts` `if (!user)` → `{idle:1, absolute:1}` — restrictive default (model pattern).
- `account-lockout.ts` `if (!tenant)` → DEFAULT_LOCKOUT_THRESHOLDS — still enforces lockout.
- `passkey-enforcement.ts` `if (!tenant) throw` — PR #685.
- `auth-gate.ts` `?? false`/`?? null` passkey fields — contract-documented (session callback emits all 4).
- `team-policy.ts:60` `if (!policy) return DEFAULT_POLICY` — intended permissive default; corruption fails closed upstream via `withTeamTenantRls`.
- `mcp/token/route.ts` `if (codeTenantId)` — null code → downstream `invalid_grant`, no mint.

### Excluded (display / config-write, per PR #685 precedent)

- `tenant/policy/route.ts` — admin PATCH reads OWN tenant to compute unchanged fields for the write; not a subject access decision.
- `teams/[teamId]/policy/route.ts`, `vault/status`, `vault/unlock/data`, `user/passkey-status`, `sessions/route.ts` — client-display echoes in response bodies.

## Round 2 verification (3 experts)

- **Security**: all 7 fixes reach a DENY outcome (throw → proxy/route 500 or 403; `{valid:false}` → 401/redirect). No R43 boundary widening (only tightening). No legitimate no-tenant/no-membership flow broken (null return path unchanged). Surfaced member #5 (`auth-adapter`) as an uncovered same-class sibling → folded in.
- **Functionality**: `tsc --noEmit` clean; the whole class now consistent (access-restriction no longer fails open while passkey-enforcement fails closed on the same signal). Error messages leak nothing sensitive.
- **Testing**: 9 new regression tests, all mutation-verified (revert the fix → test goes red). No vacuous assertions (each asserts the denied/valid:false value + the load-bearing side effect).

## R42 convergence — mutation-verified CI guard (≥2× accretion)

The member-set expanded 4→5→7, so per the triangulate termination check the class
is closed only by a mutation-verified CI guard, not "no findings" alone.

- **Guard**: `scripts/checks/check-null-tenant-fail-closed.mjs` — a completeness
  manifest. It enumerates every enforcement-field `tenant.findUnique` /
  `tenant: { select }` from the defining primitive and fails when the live set
  diverges from the reviewed MANIFEST (a new unclassified member, or a vanished
  stale entry). Currently green: **16 enforcement reads, all classified**
  (matches the hand-enumerated `tenant.findUnique` count — completeness cross-check).
- **Red-proven** (via `NTFC_CHECK_ROOT` throwaway fixture, no repo residue):
  - Mutation A — inject a new unclassified enforcement read → exit 1 (flags the new file).
  - Mutation B — remove a manifest'd site → exit 1 (flags the stale entry).
  - Restore → exit 0.
- **Wired** into `scripts/pre-pr.sh` (Static: null-tenant-fail-closed) which CI
  runs verbatim via `PRE_PR_STATIC_ONLY=1 bash scripts/pre-pr.sh` (ci.yml) — same
  definition local and CI (R33), authoritative gate (RT7).
- **Guard self-test**: `scripts/__tests__/check-null-tenant-fail-closed.test.mjs`
  (5 cases: baseline-green, new-unlisted-read → red, vanished-manifest → red,
  benign non-enforcement tenant read ignored, non-tenant enforcement-named field
  ignored). Required by the repo's `check-gate-selftest-coverage` gate — every
  guard must ship a self-test proving it can fail.

`R42 class null-tenant-fail-open: member-set expanded 3× (4→5→7) — closed by
mutation-verified CI guard scripts/checks/check-null-tenant-fail-closed.mjs
(red-proven: new unclassified read + vanished manifest entry), wired in
scripts/pre-pr.sh + CI static-checks.`

## Resolution Status

All 7 members fixed fail-safe (throw / restrictive-default / log). All fixes
mutation-verified. CI guard authored, red-proven, wired. Anti-Deferral: no
findings deferred. No boundary widened (R43).

---

## Round 3 — external review follow-up (3 findings addressed)

An external security review of PR #693 raised 3 findings; all fixed.

### F-EXT-1 [High] Deactivated member's session cached as valid, bypassing IP restriction
`auth-gate.ts getSessionInfo` treated `resolveUserTenantId → null` as a legitimate
no-tenant user (`valid:true, tenantId:undefined`). But that null means NO active
`TenantMember` (deactivatedAt != null) — a de-provisioned member — and
`User.tenantId` is a non-null FK, so it is a revoked membership, not a no-tenant
user. A stale cookie (or a session whose deletion was missed on deactivation)
then passed session validation AND skipped the tenant CIDR/Tailscale gate
(undefined tenantId → the api-route/page-route gate is bypassed). The extension-
token path already rejects deactivated members (C13); the session path did not.
**Fix**: `resolved === null` → `{ valid: false }` (fail closed, uncached). The
prior test that fixed the unsafe behavior was inverted to assert the block.
Mutation-verified. Blast radius checked: signup creates user + TenantMember in
one tx (no window); proxy/CSRF tests updated to a real-membership default.

### F-EXT-2 [Medium] Lockout fetch-failure reverted a tightened tenant to a weaker default
`getLockoutThresholds` fell back to the schema-default (lock at 5) on a missing
row / DB error. A tenant may tighten to lock-at-1, so the default GRANTS extra
attempts — fail-open. **Fix**: `STRICTEST_LOCKOUT_THRESHOLDS`
(`{ attempts: LOCKOUT_THRESHOLD_MIN, lockMinutes: LOCKOUT_DURATION_MAX }`) on all
three fallback paths (missing row, catch, unresolved user tenant), never cached.
A throw is NOT viable here: `recordFailure` is a post-failure side effect, so
throwing would leave the attempt unrecorded (the counter never advances — itself
fail-open). Strictest fallback records the attempt under a threshold guaranteed
no weaker than the tenant's real policy. Mutation-verified.

### F-EXT-3 [Medium] CI guard detected only file add/remove, not intra-file mutations
The manifest guard tracked only the SET of files with an enforcement read, so:
reverting a `throw` to a permissive coalesce in a listed file, adding a fail-open
read to a listed file, or adding an access decision to a `display-exempt` file
all passed; the disposition values were unused. **Fix**: rewrote the guard as
ts-morph AST, per-read-site. It now verifies each read's declared disposition
against the implementation — `throw` requires a null-tenant `if (!tenant)
{ throw|return }` guard in the enclosing function; `failsafe-default` forbids a
permissive `tenant?.<enforcementField> ?? <lenient>` coalesce; `display-exempt`
forbids an access-restriction / deny call. The self-test grew to 7 cases
including the 3 intra-file mutations, each red-proven. (Aligns with the AST-first
rule for code-classifying gates.)

## Round 4 — external review follow-up (guard read-site precision)

The AST guard's `throw`-disposition check accepted a file as long as SOME
`if (!<tenant-ish>) { throw|return }` existed in the enclosing function — so a
guarded read plus a SIBLING unguarded enforcement read in the same function
passed (external review Medium). **Fix**: per-read variable tracking. Each
enforcement read now records the exact variable it is bound to
(`bindingVarName`), including the two real binding shapes — RLS-wrapped
(`const t = await withBypassRls(prisma, (tx) => tx.tenant.findUnique(...))`) and
`Promise.all` array-destructuring (`const [c, t] = await Promise.all([...])`).
`hasNullTenantThrowGuard(read)` now requires an `if (!<that var>)` /
`if (!<that var>.tenant)` guard that throws/returns — a guard on a different
variable, or a sibling unguarded read, no longer vouches for it. Self-test grew
to 10 cases (added: sibling-unguarded → red, wrong-variable guard → red,
Promise.all relation-join `if (!user?.tenant)` → accepted). Real tree still green
at 16 reads.
