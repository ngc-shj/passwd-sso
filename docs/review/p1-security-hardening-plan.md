# P1: Security Hardening Plan

Source: [external-security-assessment-roadmap.md](../docs/review/external-security-assessment-roadmap.md)

---

## Scope

Four security hardening items: member revocation enforcement, security scanning
in CI, npm audit blocking, and incident response documentation.

---

## Item 1: Revoke + Session/Token Kill (#4)

### Problem

When a team member is removed (`DELETE /api/teams/[teamId]/members/[memberId]`)
or via SCIM (`DELETE /api/scim/v2/Users/[id]`), only the `TeamMemberKey` and
`TeamMember` records are deleted. The removed user's **sessions**, **extension
tokens**, and **API keys** remain valid until natural expiration.

This means a removed member retains:
- Active browser sessions (database sessions)
- Extension tokens (valid until `expiresAt`)
- API keys (valid until revoked)

While TeamMemberKey deletion prevents decrypting team data, the user still has
an authenticated session that could access personal vault endpoints.

### Current Implementation

**Team member removal** (`src/app/api/teams/[teamId]/members/[memberId]/route.ts`):
- Transaction: delete `TeamMemberKey` → delete `ScimExternalMapping` → delete `TeamMember`
- Audit: `TEAM_MEMBER_REMOVE` with `{ removedUserId, removedRole }`
- No session/token invalidation

**SCIM user deletion** (`src/app/api/scim/v2/Users/[id]/route.ts`):
- Transaction: delete all `TeamMemberKey` → delete `ScimExternalMapping` → delete all `TeamMember` → delete `TenantMember`
- Audit: `SCIM_USER_DELETE`
- No session/token invalidation

**Session model** (`prisma/schema.prisma`):
- `Session` with `userId`, `sessionToken`, `expires`
- Manual revoke via `DELETE /api/sessions` and `DELETE /api/sessions/[id]`

**Extension tokens** (`prisma/schema.prisma`):
- `ExtensionToken` with `userId`, `tokenHash`, `revokedAt`, `expiresAt`
- Validation checks `revokedAt === null` and `expiresAt > now`

**API keys** (`prisma/schema.prisma`):
- `ApiKey` with `userId`, `tokenHash`, `revokedAt`

### Solution

#### 1a. Create a reusable session/token invalidation function

Create `src/lib/user-session-invalidation.ts`:

```typescript
/**
 * Invalidate all sessions and tokens for a user.
 * Called on: team member removal, SCIM user deletion, admin vault reset.
 */
export async function invalidateUserSessions(
  userId: string,
  options?: { tenantId?: string; reason?: string }
): Promise<{ sessions: number; extensionTokens: number; apiKeys: number }>;
```

Implementation:
1. Delete `Session` records for `userId` (+ `tenantId` if provided).
   Auth.js standard — sessions are DB rows; deletion IS the invalidation.
2. Set `revokedAt = now()` on active `ExtensionToken` for `userId`
   (+ `tenantId` if provided)
3. Set `revokedAt = now()` on active `ApiKey` for `userId`
   (+ `tenantId` if provided)
4. Return counts for audit logging

Use `withBypassRls()` scoped strictly to the target `userId` WHERE clause.
All three operations filter by `userId` only — no global bypass.

Note on auth artifacts scope: Auth.js v5 uses database sessions (not JWT).
No refresh tokens exist. SSO tokens are session-bound and invalidated when
the session is deleted. This covers all authentication artifacts.

#### 1b. Integrate into team member removal

In `src/app/api/teams/[teamId]/members/[memberId]/route.ts`:
- After the existing transaction (TeamMemberKey/TeamMember deletion), call
  `invalidateUserSessions(target.userId, { tenantId: target.tenantId })`
- Add invalidation counts to audit metadata

Important: Session invalidation is OUTSIDE the transaction since it operates
on the removed user's records, not the team's. If invalidation fails, the
member is still removed (fail-open for removal, not for security — see 1d).

Note on time window: Between TeamMemberKey deletion and session invalidation,
a brief window exists where the user has a valid session but no team key.
This is harmless — without TeamMemberKey, team data cannot be decrypted.
Personal vault access during this window is acceptable (user's own data).

#### 1c. Integrate into SCIM user deletion and deactivation

In `src/app/api/scim/v2/Users/[id]/route.ts`:

- **DELETE**: After the existing transaction, call
  `invalidateUserSessions(member.userId, { tenantId: member.tenantId })`
- **PUT handler** (`active: false`): The PUT handler returns `auditAction`
  from `withTenantRls`. After the RLS block, if
  `auditAction === SCIM_USER_DEACTIVATE`, call
  `invalidateUserSessions(member.userId, { tenantId: member.tenantId })`.
- **PATCH handler** (`active: false`): Same pattern — check `auditAction`
  after the RLS block and call `invalidateUserSessions()` on deactivation.
- PUT and PATCH are **separate code paths** — both must be updated.
- Reactivation (`active: true`) does NOT trigger invalidation.
- Add counts to audit metadata for DELETE, PUT-deactivate, and
  PATCH-deactivate actions.

Note on multi-tenancy: `invalidateUserSessions()` accepts an optional
`tenantId` parameter. When provided, only sessions belonging to that
tenant are deleted (Session model has `tenantId`). For SCIM operations,
always pass `tenantId` to avoid invalidating sessions in other tenants.
For team member removal, pass `tenantId` from the team's tenant context.

#### 1d. Error handling strategy

Session/token invalidation should NOT block member removal:

- If `invalidateUserSessions()` fails, log with BOTH:
  - `getLogger().error({ userId, error }, "session-invalidation-failed")` —
    for monitoring/alerting (pino structured log, always written)
  - `logAudit()` with existing action (e.g. `TEAM_MEMBER_REMOVE`) and
    `metadata: { ...existing, sessionInvalidationFailed: true }` — no new
    enum value needed
- The member is already removed from the team (TeamMemberKey deleted)
- No retry — if it fails, admin intervention is required (rare edge case)

#### 1e. Constraints on `withBypassRls` usage

`invalidateUserSessions()` uses `withBypassRls()` internally. Constraints:

- Must be called OUTSIDE `withTenantRls`/`withTeamTenantRls` callbacks
  to avoid nested transactions
- The `withBypassRls` callback must contain ONLY the three
  DELETE/UPDATE queries (Session, ExtensionToken, ApiKey) — no other
  queries allowed
- All queries must filter by `userId` (and optionally `tenantId`)
- `npm run check:bypass-rls` CI script must include the new file in
  its allowlist

#### 1f. Team key rotation prompt (out of P1 scope)

The roadmap mentions "mandatory team key rotation prompt" after member
removal. This is a frontend UX concern. The rotation API already exists
at `POST /api/teams/[teamId]/rotate-key`. Frontend integration is
deferred to a separate task.

### Testing

- Unit: `invalidateUserSessions()` deletes sessions, revokes tokens and API keys
- Unit: `invalidateUserSessions()` uses `withBypassRls()` and filters by `userId`
- Unit: `invalidateUserSessions()` with `tenantId` filters queries by tenant
- Unit: team member DELETE triggers `invalidateUserSessions()`
- Unit: SCIM user DELETE triggers `invalidateUserSessions()`
- Unit: SCIM PATCH `active: false` triggers `invalidateUserSessions()`
- Unit: SCIM PATCH `active: true` does NOT trigger `invalidateUserSessions()`
- Unit: invalidation failure — response still returns 200 (member removed)
- Unit: invalidation failure — `getLogger().error()` called with userId + error
- Unit: invalidation failure — audit metadata includes `sessionInvalidationFailed`
- Unit: audit metadata includes invalidation counts on success

Note: Each test file's `vi.hoisted()` block must include
`mockInvalidateUserSessions: vi.fn()` and a corresponding `vi.mock()` for
`@/lib/user-session-invalidation`.

Fixture helpers needed: `makeSession()`, `makeExtensionToken()`, `makeApiKey()`
in `src/__tests__/helpers/fixtures.ts`.

### Risk

Medium — session invalidation is a security-critical operation. Must verify
that `withBypassRls()` is used correctly and that race conditions with
concurrent session creation are acceptable (new sessions created after
removal are harmless since TeamMemberKey is already deleted).

---

## Item 2: Security Scanning in CI (#5)

### Problem

No SAST or container scanning in CI. Security vulnerabilities in code patterns
or Docker images are not automatically detected.

### Current CI

`.github/workflows/ci.yml` has:
- ESLint
- Custom scripts: `check-team-auth-rls`, `check-bypass-rls`, `check-crypto-domains`
- License audit (strict mode)
- npm audit (non-blocking, `continue-on-error: true`)
- No SAST, no container scanning

### Solution

#### 2a. Add CodeQL analysis

Add `.github/workflows/codeql.yml`:
- Trigger: push to main, PRs to main, weekly schedule
- Languages: `javascript-typescript`
- Use `github/codeql-action/init`, `autobuild`, `analyze`
- Default query suite (`security-and-quality`)

CodeQL is free for public repos and included in GitHub Advanced Security
for private repos. It detects:
- SQL injection, XSS, path traversal
- Prototype pollution, ReDoS
- Insecure randomness, hardcoded credentials

#### 2b. Add Trivy container scanning

Add a `container-scan` job to `.github/workflows/ci.yml`:
- Build Docker image
- Run `aquasecurity/trivy-action@<commit-sha>` (pinned, NOT `@master`) with:
  - `scan-type: image`
  - `severity: CRITICAL,HIGH`
  - `exit-code: 1` (fail on critical/high)
  - `ignore-unfixed: true` (skip vulnerabilities without patches)
- Trigger: PRs with Dockerfile/package-lock changes, AND weekly schedule
  (weekly catches base image CVEs even without code changes)

#### 2c. Add crypto domain verification to CI

`check-crypto-domains.mjs` already exists but is not in CI.

- Add `"check:crypto-domains": "node scripts/check-crypto-domains.mjs"`
  to `package.json` scripts
- Add `npm run check:crypto-domains` to the `app-ci` job in CI workflow

#### 2d. Enable GitHub Secret Scanning

Enable secret scanning in repository settings (Settings → Code security).
This is free for public repos and detects leaked API keys, tokens, and
credentials in commits. No workflow file needed — it's a repo setting.

### Testing

- Verify CodeQL workflow runs on a test PR
- Verify Trivy scans the Docker image and reports findings
- No application code tests needed (CI-only changes)

### Risk

Low — CI-only changes. CodeQL and Trivy are read-only analysis tools.
False positives may require `.codeql/config.yml` or `.trivyignore` tuning.

---

## Item 3: npm audit Blocking (#6)

### Problem

`npm audit --omit=dev` runs in CI but with `continue-on-error: true`.
High/critical vulnerabilities do not block merges.

### Current Implementation

Three audit jobs in `.github/workflows/ci.yml` (lines 235-298):
- `audit-app`, `audit-ext`, `audit-cli`
- All use `continue-on-error: true`
- Run `npm audit --omit=dev`

### Solution

#### 3a. Verify current audit status locally

Before changing CI, run `npm audit --omit=dev --audit-level=high` locally
for all three packages (app, extension, cli) to identify and fix any
existing high/critical vulnerabilities. This prevents immediate CI breakage.

#### 3b. Make audit blocking for high/critical

Change the three audit jobs:

- Remove `continue-on-error: true`
- Change command to `npm audit --omit=dev --audit-level=high`
- This fails the job only for high or critical severity
- Low and moderate findings remain warnings

#### 3c. Add npm audit script to package.json

Add `"audit:ci"` script for consistency:
```json
"audit:ci": "npm audit --omit=dev --audit-level=high"
```

#### 3d. Exception handling

If a high/critical vulnerability has no fix available:
- Document in a new `scripts/audit-allowlist.json` (package, version, reason, expires)
- Wrap audit in a script that filters known exceptions
- Alternative: use `npm audit --omit=dev --audit-level=high || true` with
  a post-check script that parses output and allows specific CVEs

For P1, keep it simple: change to `--audit-level=high` and handle exceptions
case-by-case with `npm audit fix` or `overrides` in package.json.

### Testing

- Verify CI fails on a PR that introduces a high-severity dependency
- No application code tests needed

### Risk

Low — may cause initial CI failures if existing dependencies have known
high/critical vulnerabilities. Run `npm audit --omit=dev --audit-level=high`
locally first to identify and fix any existing issues before enabling.

---

## Item 4: Incident Runbook (#7)

### Problem

No documented incident response procedures. Key compromise, data breach,
or service degradation have no predefined response steps.

### Solution

Create `docs/operations/incident-runbook.md` covering:

#### 4a. Key Compromise Response

- **Master key compromise**: Rotate via `npm run generate:key`, redeploy, trigger
  admin mass vault reset if needed
- **User passphrase compromise**: User changes passphrase (vault key rotation)
- **Team key compromise**: Admin rotates team key (existing flow)
- **Database encryption key**: PostgreSQL-level; rotate via pg_dump/restore

#### 4b. Database Breach Procedure

- Assess scope (which tables/data exposed)
- If `users` table: passphrase verifiers are HMAC'd (not plaintext), but force
  all users to change passphrases
- If `sessions` table: delete all sessions (mass logout)
- If `audit_logs` table: metadata may contain PII — notify affected users
- Encrypted vault data is AES-256-GCM; without secret keys, data is safe

#### 4c. Service Degradation Escalation

- **Redis down**: Rate limiting and session validation degrade; Auth.js falls
  back to database sessions. Switch to database-only mode.
- **PostgreSQL down**: Full outage. Restore from backup.
- **Jackson (SAML) down**: SAML SSO login fails; Google OIDC and passkey
  continue working. Restart Jackson container.
- **App down**: Redeploy from latest stable image.

#### 4d. Communication Templates

- Internal incident notification template
- User notification template (for data breach)
- Status page update template

### Testing

No code changes — documentation only.

### Risk

None.

---

## Implementation Steps

1. Add `makeSession()`, `makeExtensionToken()`, `makeApiKey()` to fixtures
2. Create `src/lib/user-session-invalidation.ts` with `invalidateUserSessions()`
3. Add `user-session-invalidation.test.ts` (unit tests for the function)
4. Integrate into team member removal route + update tests
   (add `mockInvalidateUserSessions` to `vi.hoisted()` + `vi.mock()`)
5. Integrate into SCIM DELETE route + update tests (same mock pattern)
6. Integrate into SCIM PATCH/PUT `active: false` + update tests
7. Add `user-session-invalidation.ts` to `check:bypass-rls` allowlist
8. Add `"check:crypto-domains"` npm script to `package.json`
9. Add `npm run check:crypto-domains` to CI `app-ci` job
10. Create CodeQL workflow (`.github/workflows/codeql.yml`)
11. Add Trivy container scan job to CI (SHA-pinned action)
12. Enable GitHub Secret Scanning (repo settings)
13. Run `npm audit --omit=dev --audit-level=high` locally for app/ext/cli
14. Fix any existing high/critical audit findings
15. Change CI audit jobs: remove `continue-on-error`, add `--audit-level=high`
16. Create incident runbook (`docs/operations/incident-runbook.md`)

---

## Acceptance Criteria

- [ ] `invalidateUserSessions()` function created and tested
- [ ] `invalidateUserSessions()` supports optional `tenantId` scoping
- [ ] Team member removal triggers session/token/API key invalidation
- [ ] SCIM user DELETE triggers session/token/API key invalidation
- [ ] SCIM user DEACTIVATE (`active: false`) triggers invalidation
- [ ] SCIM user REACTIVATE (`active: true`) does NOT trigger invalidation
- [ ] Invalidation failure does not block member removal (200 returned)
- [ ] Invalidation failure logs error AND sets audit metadata flag
- [ ] `withBypassRls` queries filter by `userId` (+ `tenantId` if provided)
- [ ] New file added to `check:bypass-rls` allowlist
- [ ] Audit metadata includes invalidation counts on success
- [ ] CodeQL workflow added and runs on PRs
- [ ] Trivy container scan added to CI (SHA-pinned)
- [ ] GitHub Secret Scanning enabled
- [ ] `check:crypto-domains` npm script + CI integration added
- [ ] npm audit blocks on high/critical vulnerabilities
- [ ] All existing npm audit checks pass with `--audit-level=high`
- [ ] `docs/operations/incident-runbook.md` created
- [ ] Incident runbook covers key compromise, DB breach, service degradation
- [ ] All existing tests pass with no regressions
