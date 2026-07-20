# Plan: null-tenant fail-open enforcement class propagation

Follow-on to PR #685 (which fixed only the `requirePasskey` session-callback path).

## Class definition

Enforcement decisions that read a tenant/team **security policy** from the DB and,
when the tenant/policy row is null / missing / unfetchable, fall back to the
**unsafe (lenient / access-granting / restriction-skipping)** side instead of the
safe (blocking / restrictive) side.

The controlling distinction (from PR #685):
- null because **"operator never configured this optional restriction"** →
  permissive default is the *correct documented intent* (NOT fail-open).
  e.g. empty `allowedCidrs` = no IP restriction.
- null because **"fetch failed / tenant row vanished / data corruption"** on a
  path where the tenant MUST exist (tenantId sourced from an FK-RESTRICT-backed
  session/token row) → MUST fail closed.

## Member-set (R42, three-expert converged)

| Member | file:line | Verdict | Action |
|---|---|---|---|
| `getTenantAccessPolicy` null-tenant → empty policy (cached) | `access-restriction.ts:79-83` | **FAIL-OPEN** | Fix: throw on null tenant, do not cache |
| proxy `getSessionInfo` swallows `resolveUserTenantId` throw | `auth-gate.ts:92-96` | **FAIL-OPEN** | Fix: on throw → `{valid:false}` (fail-closed re-auth) |
| `checkTeamAccessRestriction` inherit path, tenant CIDR fetch null | `team-policy.ts:135-156` | **FAIL-OPEN (low)** | Fix: throw when inherit relies on tenant CIDRs but tenant fetch null |
| `getLockoutThresholds` `catch → DEFAULT` (no log) | `account-lockout.ts:97-99` | **Silent-swallow (Major)** | Fix: log before returning default (observability; default itself is fail-safe) |
| `enforceAccessRestriction` `if (!tenantId) return null` | `access-restriction.ts:263-264` | **Bounded** | Keep skip for genuine no-membership; the throw path already 500s (fail-closed). Fix 1 removes the swallow that fed this. |
| `auth-gate.ts:99-112` `?? false`/`?? null` passkey | verified | FAIL-SAFE | none (contract-documented) |
| `session-timeout.ts:102-110` `{idle:1,abs:1}` | verified | FAIL-SAFE | none (model pattern) |
| `passkey-enforcement.ts:109` throw | verified | FAIL-SAFE | none (PR #685) |
| `account-lockout.ts:77-83` missing-row → DEFAULT | verified | FAIL-SAFE | none (still enforces lockout) |
| `team-policy.ts:60` `if(!policy) return DEFAULT_POLICY` | verified | FAIL-SAFE | none (intended permissive default; corruption fails closed upstream via `withTeamTenantRls` TENANT_NOT_RESOLVED) |
| `mcp/token/route.ts:148-152` `if (codeTenantId)` | verified | FAIL-SAFE | none (invalid code → invalid_grant, no mint) |
| display/audit/notification members | — | NOT-ENFORCEMENT | excluded |

## Fixes (fail-safe direction only; no boundary widening — R43)

1. **`getTenantAccessPolicy`** — throw `Error` when `findUnique` returns null for a
   tenantId that must exist; skip cache-write of a null-derived policy. Callers
   (`checkAccessRestriction`, `enforceAccessRestriction`) already propagate/deny.
2. **`auth-gate.ts getSessionInfo`** — replace the silent `catch {}` around
   `resolveUserTenantId` with a fail-closed `return { valid: false }` (do not cache),
   matching the `!res.ok` transient-error handling directly above. A `null` *return*
   (no active membership) is unchanged — that is a legitimate no-tenant user.
3. **`checkTeamAccessRestriction`** — when `inheritTenantCidrs` is true and it is the
   sole restriction source, throw `PolicyViolationError` if `resolveTeamTenantId`
   or the tenant fetch returns null (`Team.tenantId` is non-null FK → null = corruption).
4. **`getLockoutThresholds`** — log a warn line in the `catch` before returning
   `DEFAULT_LOCKOUT_THRESHOLDS` so enforcement degradation is observable
   (the default is already fail-safe; this closes the silent-swallow finding).

## Regression tests (mutation-verified)

- `access-restriction.test.ts`: `getTenantAccessPolicy`/`checkAccessRestriction`
  with `findUnique → null` must **throw / deny** (mutation: revert to `?? []` → test fails).
- `auth-gate` proxy test: `resolveUserTenantId` throws → `getSessionInfo` returns
  `valid:false` (mutation: restore `catch {}` swallow → test fails).
- `team-policy.test.ts`: `inheritTenantCidrs=true`, empty teamAllowedCidrs,
  tenant fetch → null → throws `PolicyViolationError` (mutation: restore silent allow → fails).
- `account-lockout.test.ts`: DB throw in threshold fetch → warn logged + default returned.

## Non-goals

- Do NOT tighten `enforceAccessRestriction`'s genuine no-membership skip to a deny —
  a no-tenant user has no CIDR policy to enforce; denying would break legitimate flows.
- Do NOT touch display/config routes (`tenant/policy`, `teams/[teamId]/policy` GET).
