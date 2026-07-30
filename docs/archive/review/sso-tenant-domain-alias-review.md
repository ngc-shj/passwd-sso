# Plan Review: sso-tenant-domain-alias
Date: 2026-07-29
Review round: 1

## Changes from Previous Round

Initial review.

## Process note (deviation from Step 1-5, recorded deliberately)

The three expert outputs each carried a machine-readable findings index. The
mechanical merge pre-pass (join on file + line ±5 + root cause) was performed
against those indexes, and the merged prose below was authored directly from the
three reports rather than round-tripped through the Ollama `merge-findings` helper.
Reason: all three reports were already in the orchestrator's context in full, and
re-emitting ~30k tokens verbatim to `$TRI_DIR` purely to feed a deduplicator whose
output would then be re-authored is cost without added fidelity. The skill's own
fallback ("when Ollama is unavailable, this json join IS the fallback dedup
skeleton") describes exactly the path taken. The per-expert Recurring Issue Check
sections are preserved verbatim below, as required — they are evidence, not summary.

## Verdict

**No-Go.** Four Critical findings. Two of them (Security F1/F2) invalidate the
authority model the plan is built on, not merely its details.

---

## Perspective convergence

Findings that more than one expert reached independently. Per the convergence rule,
these carry a severity floor at the highest single assessment.

| # | Finding | Func | Sec | Test | Merged |
|---|---|---|---|---|---|
| M1 | `ensureTenantMembershipForSignIn`'s `Promise<boolean>` cannot carry which denial reason to emit | F2 Critical | — | F2 Major | **Critical** |
| M2 | C6's operator-token recovery path cannot exist as specified | F1 Critical | F1 Critical (escalate) | — | **Critical** |
| M3 | "Existing tests pass unchanged" is false | F7 Major | — | F3, F4 Major | **Major** |
| M4 | New routes miss `route-policy-manifest.json`, `fail-closed-manifest.txt`, `check-fail-closed-routes-have-test.sh`, `check-security-matrices.sh` | F6 Major | F11, F15 Major | F7 Major | **Major** |
| M5 | I6's member-set is incomplete and mis-scoped (R42) | F9 Major | F6 Major | — | **Major** |
| M6 | `GOOGLE_WORKSPACE_DOMAINS` is a second adjudicator firing before tenant resolution (R48) | F8 Major | F5 Major | — | **Major** |
| M7 | No step-up reauth on the alias-registration route | F16 Minor [Adjacent] | F11 Major | — | **Major** |
| M8 | C9's fixture root contradicts the existing self-test convention; the `check-gate-selftest-coverage.sh` criterion is N/A | F12 Minor | — | F6 Major | **Major** |

---

## Critical findings

### CR1 (Security F2) — Alias registration requires no proof of domain control; the exploit path bypasses the plan's own decision table

The plan chose "tenant admin role" as the control for a predicate whose meaning is
defined by DNS: *is this tenant entitled to receive IdP claims for this domain?*
That is R47 — a surface-form check standing in for the interpreter that defines the
predicate. SC2 closes the automatic version of the hole; the manual version is
strictly more powerful because it needs no IdP at all.

Path, for a domain not yet known to the system:

1. Attacker (admin of their own tenant A) `POST /api/tenant/domains {domain: victim.example}` → 201.
2. A user of the victim organisation signs in with Google. `userId` is null at
   `src/auth.ts:344`, so `signIn` returns `true` early and stashes the claim.
3. `createUser` (`src/lib/auth/session/auth-adapter.ts:167-210`) calls
   `findOrCreateSsoTenant(pendingClaim, tx)` → after C3 that is
   `resolveSsoTenantByClaim ?? createSsoTenant` → **C2's alias leg resolves to tenant A**.
4. `tx.user.create({ tenantId: A })` + `tx.tenantMember.create({ tenantId: A, role: MEMBER })`.
5. Attacker, as tenant-A admin, has `reset-vault`, `audit-logs`, `policy`, and team
   invitation reach over the victim's account.

Step 3 passes through **no denial gate**. The plan's threat analysis traces C2→C4;
the adapter path never reaches C4, so C4's dispatch table is irrelevant to the
highest-impact case.

Second channel: the C4 row `present / resolved / different, existing is bootstrap →
bootstrap migration (unchanged)` is **not** unchanged. The set of claim strings that
can trigger a bootstrap migration was the IdP namespace; it becomes admin-writable.

escalate: true — multi-step auth flow spanning `signIn` → `createUser` → RLS tenant
assignment, with the exploitable branch outside the plan's decision table.

### CR2 (Security F1 + Functionality F1) — C6 assumes a system operator token that does not exist

`verifyAdminToken` accepts only `op_`-prefixed DB-backed tokens and returns a
`tenantId` read from the row; `src/app/api/tenant/operator-tokens/route.ts:190`
hard-codes `tenantId: actor.tenantId` at mint time; `requireMaintenanceOperator`
re-confirms an active OWNER/ADMIN `TenantMember`. `src/app/api/maintenance/purge-history/route.ts:109-112`
states the invariant in a comment: *"Without this, a tenant-A admin who mints an
op_* token can delete history rows in every other tenant."*

C6's `POST { tenantId, domain }` can only be implemented by honouring a
caller-supplied `tenantId` — deliberately introducing the first cross-tenant
maintenance write, in a request shape, without stating it. Any tenant admin could
then bind an attacker-controlled claim to a victim tenant, and the audit row would
land in the **attacker's** tenant (`tenantAuditBase(req, auth.subjectUserId,
auth.tenantId)`), leaving the victim's audit log empty.

Independently, C6 fails its own purpose: `/api/tenant/operator-tokens` is
`API_SESSION_REQUIRED`, so in the exact state C6 exists for — every member denied at
sign-in — nobody can mint the token. `OPERATOR_TOKEN_DEFAULT_EXPIRES_DAYS = 30`
(max 90), so a pre-existing token is not a reliable escape hatch either.

Both experts converge on the same remedy: an out-of-band CLI
(`scripts/add-tenant-domain.mjs` against `MIGRATION_DATABASE_URL`, the pattern
`scripts/bootstrap-rds-roles.mjs` already uses). No token, no session, no new
cross-tenant HTTP surface, and it names what the HTTP option silently required —
DB access the operator already has, versus a token the locked-out tenant cannot mint.

escalate: true — the HTTP variant's fix is a repo-wide scope-gating change across
every maintenance route (per the standing warning in
`src/lib/auth/tokens/admin-token.ts:19-24`), not a local edit; chains with CR1.

### CR3 (M1 — Functionality F2, Testing F2) — the locked signature cannot carry the denial reason

C4 states the signature is unchanged at `Promise<boolean>` while its dispatch table
assigns two different `reason` values. `ensureTenantMembershipForSignIn` never
emits; the sole emit site is `src/auth.ts:362-369`, which hard-codes
`reason: "tenant_mismatch"` on `!ok`. F6 is unachievable as locked.

Both repairs carry unaccounted consequences:
- Discriminated result — a signature change, contradicting C4's own text, breaking
  every boolean assertion at `src/auth.test.ts:229/256/265/274`.
- Emit inside the function — double-emits, **and** places `emitAuthLoginFailure`
  inside the open `withBypassRls` transaction. `logAuditAsync` → `resolveTenantId`
  → `withBypassRls` opens a second transaction on a second pooled connection while
  the first is held: R9, a pool-exhaustion shape.

Resolution: lock the discriminated result explicitly, returned **out of** the
`withBypassRls` block, with `emitAuthLoginFailure` staying post-transaction.

### CR4 (Testing F1) — nothing asserts that the new denial reason is actually emitted

C4's acceptance criteria never assert `reason: "tenant_claim_unmapped"` rather than
`"tenant_mismatch"`. The whole operator-facing control that justifies the new value
can ship emitting the old one with every stated test green — and C4's Consumer 4
(the recovery tooling) queries on that exact reason, so the recovery path silently
returns nothing.

---

## Functionality Findings

- **F3 (Major)** — `AUDIT_ACTION` is `as const satisfies Record<AuditAction, AuditAction>` where `AuditAction` is imported from `@prisma/client` (`src/lib/constants/audit/audit.ts:1`, `prisma/schema.prisma:890`). New values need the Prisma enum + an `ALTER TYPE ... ADD VALUE` migration (interacting with `check-migration-transaction.mjs` — Postgres will not let a value added in a transaction be used in it), plus `AUDIT_ACTION_VALUES` (`:241`, hand-maintained), which is the input to `audit-i18n-coverage.test.ts` and `audit-action-group-coverage.test.ts`. Omitting it makes both tests pass vacuously. `ACTION_ICONS` is `Partial<Record<...>>` with a documented fallback and needs **no** change — state that so a reviewer does not add one.
- **F4 (Major)** — C4's Consumer 4 reads `metadata->>'tenantId'`, which `emitAuthLoginFailure` never writes (`src/lib/audit/auth-failure.ts:67` emits `{provider, reason, identifierHash}` only). The walkthrough enforcement rule refuses the lock. The alternative already works: `logAuditAsync`'s `resolveTenantId` (`src/lib/audit/audit.ts:167-186`) fills `audit_logs.tenant_id` from `userId`, so an operator query on the **column** needs no payload change.
- **F5 (Major)** — C4's Consumer 1 asserts a `metadata.reason` label path the viewer does not have. `tenant-audit-log-card.tsx:188` renders metadata only through `AuditDelegationDetail`, which reads `reason` for delegation actions only. No existing `AuthLoginFailureReason` has an i18n key anywhere; `AuditLog.json` holds **action** labels only, and a lowercase key would sit outside the orphan-label guard's `^[A-Z][A-Z0-9_]+$` pattern — a permanently dead key. The real gap Consumer 1 should have surfaced: an admin cannot see any failure reason in the dashboard, so F6's actionability depends on DB/CSV access.
- **F6 / M4 (Major)** — see convergence table. `classifyRoute` itself needs **no** change (`/api/tenant/domains` → `api-session-required` via the `/api/tenant` prefix; `/api/maintenance/*` → `api-default` by fallthrough), which is precisely why I9's diagnosis was wrong. The required artifacts are `route-policy-manifest.json` entries (manifest-test assertion 1 is a bijection over `src/app/api/**/route.ts`), assertion 8b's AST-verified `createRateLimiter({failClosedOnRedisError:true})` + `checkRateLimitOrFail` + limiter-flows-into-checker, `fail-closed-manifest.txt` (including its header count comment), an `assertRedisFailClosed` helper-mode sibling test per route, and `docs/security/route-policy-matrix.md` regeneration. `check-permanent-delete-stepup.sh` is **N/A** (it matches vault-entry hard-delete primitives only).
- **F7 / M3 (Major)** — see convergence table and Testing F3/F4.
- **F8 / M6 (Major)** — see convergence table.
- **F9 / M5 (Major)** — see convergence table.
- **F10 (Minor)** — C5's DELETE names neither the Prisma method nor its input type. `delete({where:{id, tenantId}})` is valid only via extendedWhereUnique and signals a miss with a thrown `P2025`; `deleteMany` returns `{count: 0}` and needs an explicit `count === 0 → 404`. I8's "must 404" is satisfied by exactly one of them plus matching handling.
- **F11 (Minor)** — I4's counts verified: `@map("tenant_id")` = 55, manifest non-comment lines = 55, A\B empty. But both files carry a prose count ("Total: 55 tenant-scoped tables") that no gate updates. The `enforce_tenant_id_from_context` trigger is **not** universal (28 of 55), so `tenant_domains` needs none — state it.
- **F12 / M8 (Minor→Major)** — see convergence table.
- **F13 (Minor)** — `TENANT_WEBHOOK_EVENT_GROUPS[ADMIN]` **is** `AUDIT_ACTION_GROUPS_TENANT[ADMIN]` by reference (`audit.ts:787-809`), and `logAuditAsync` dispatches webhooks for all audit actions. The display-grouping edit therefore also decides the subscription surface (R11). R13 is satisfied — `TENANT_WEBHOOK_DELIVERY_FAILED` is not in the new group.
- **F14 (Minor)** — the 409 code lives in `src/lib/http/api-error-codes.ts` (`API_ERROR` + `API_ERROR_STATUS`), and `check-api-error-codes.sh` rule 10 fails an explicit status duplicating the default. `docs/api/error-handling.md:142` already lists `CONFLICT` and the `*_ALREADY_EXISTS` family.
- **F15 (Minor)** — root-cause step 1 cites `src/auth.ts:253` (the `async signIn(params)` declaration) for the email→`userId` lookup, which is at `:329-339`. Every other citation in that section verified exact.

**Verified correct, no finding** — R14 grant completeness (`DEFAULTACL:passwd_user public r passwd_app=arwd/passwd_user` auto-grants the four table privileges; no sequence, no worker, and the `tenants` FK needs only SELECT which `passwd_app` holds); the C7 member-set (recomputed with the gate's own `scanAppEnvReaders`: 94 readers / 117 Zod keys / 11 literals → ten members = the plan's nine + `INTERNAL_TEST_VERIFIER_VERSION`); R15 migration portability; R10 no import cycle.

---

## Security Findings

- **F3 (Major, R49)** — C2 declares `detection or audit only` on the grounds that "the denial decision lives in C4". True on the `ensureTenantMembershipForSignIn` path; **false** on `auth-adapter.ts:174`, where C2 is the sole determinant of which tenant a new user and their vault are created in, with no subsequent gate. On that path C2 is an `enforceable boundary`. A class declared audit-only attracts audit-only rigor — C2's criteria are five return-value assertions and zero assertions about the security consequence of a resolution.
- **F4 (Major, R47)** — the alias leg matches whatever `extractTenantClaimValue` returned, which tries `tenant_id`, `tenantId`, `organization`, `org`, `company`, `company_id` (or `AUTH_TENANT_CLAIM_KEYS`) before falling back to `hd` for Google only. Google's `hd` is DNS-attested by Google; a SAML `organization` attribute is attested by nothing. No column records which source produced a resolution. Remedy: a `source` discriminator on `TenantDomain`, and `extractTenantClaimValue` returning `{value, source}` rather than a bare string — a bare string is the surface form that erases the distinction.
- **F5 / M6 (Major, R48)** — `src/auth.config.ts:207-215` denies any Google sign-in whose `hd` is not in `parseAllowedGoogleDomains()`, as `baseSignIn` at `src/auth.ts:268-279`, producing `reason: "provider_error"`. For deployments with `GOOGLE_WORKSPACE_DOMAINS` set — which `SECURITY.md:85` recommends — the alias mechanism is unreachable via Google, the `tenant_claim_unmapped` branch is dead code, and the recovery runbook recovers nothing. The mis-remediation hazard is the substantive risk: an operator whose documented recovery just failed has one obvious lever — unset `GOOGLE_WORKSPACE_DOMAINS` — which simultaneously accepts `hd` from every Workspace on the internet **and** flips `allowDangerousEmailAccountLinking` to `false`, changing account-linking behaviour mid-incident. On account linking specifically: aliases do not feed that flag; the interaction runs the other way.
- **F6 / M5 (Major, R42)** — I6's own derivation command yields seven sites in `src/auth.ts`; the plan enumerates five. Omitted: `:60` (the `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` denial) and `:233` (`return !!tenant`). `:233` is **the** denial path D2 is about — its walk-back traverses the tenant-creating write at `:71`. The five enumerated members are all in the outer callback, whose bodies contain no writes trivially, so a reviewer checking I6 against the list would find it satisfied *today, before the fix*. The member-set as written is vacuous with respect to the defect it pins. The defining primitive should be "every falsy return of `signIn` **and of every function it awaits**", scoped across `src/auth.ts` + `src/auth.config.ts` + `src/app/api/auth/passkey/verify/route.ts` (the passkey route was checked and does not call `findOrCreateSsoTenant` — record the negative result).
- **F7 (Major)** — refusing to record the claim makes requirement F6 unachievable. The claim is persisted nowhere, so C6's GET ("list unmapped-claim denials") can report *that* tenant T had denials, never *which* claim — the operator cannot act because they do not know what to register. The stated rationale misapplies the logging rule, which targets secrets, credentials, session identifiers and personal data; a hosted-domain claim is organisational metadata, already length-capped and control-character-stripped, and *less* sensitive than the `domain` value C5 already writes into audit metadata. Riders: strip Unicode bidi/zero-width formatting characters in addition to C0/C1/DEL (RS6 — `sanitizeTenantClaimValue` passes U+200B/U+202E through, and the viewer renders this to an admin); state that the field is IdP-controlled and must render as inert text.
- **F8 (Major)** — the `identifierHash` analysis is factually wrong. There are **two** current `tenant_mismatch` call sites and they already disagree: `src/auth.ts:316-322` passes `tenantId`, `:363-368` passes none. One email hitting both already yields two unlinkable hashes under the same reason. Remedy: make the binding a property of the record — an explicit `identifierHashScope: "tenant" | "global"` in the metadata, set from whether `tenantId` was supplied — then normalise the two existing sites.
- **F9 (Major)** — the empty-key HMAC fallback is a control that degrades to zero: an unkeyed hash over an email-address input space is a lookup, not a protection, so "raw email is never persisted" is true in form and false in effect. SC3's cost justification does not hold: `AUTH_SECRET` is already production-required (`src/lib/env-schema.ts:452-457`, min 32 chars), so `HKDF(AUTH_SECRET, info="audit-identifier-pepper")` when the explicit var is unset gives every deployment a real key, breaks no boot, and needs no operator action. Per the no-false-technical-justification rule, SC3's stated cost is not a real constraint once that option exists. C7 is about to ship documentation legitimising the degraded state.
- **F10 (Major, R47)** — the 409 is a system-wide registration oracle. Omitting the owning tenant's name removes one bit; the *distinguishability* of 201 from 409 is the oracle, and any authenticated tenant admin can enumerate the deployment's entire registered-domain set at rate-limit speed — a customer list. The plan decided "is this an oracle?" by inspecting the response body rather than by asking whether the outcomes are distinguishable. Remedy: accept the residual, but treat it as an enumeration surface — strict per-tenant fail-closed limiter, an audit event on **every** 409 (not only on success), and honest wording. DNS verification shrinks it naturally (registration into `PENDING` need not be exclusive).
- **F11 / M7 (Major)** — every comparable tenant-admin privilege primitive carries `@stepup` + `requireRecentCurrentAuthMethod`, enumerated in `scripts/checks/stepup-route-paths.json`: `tenant-policy-patch`, `tenant-webhook-post`, `scim-token-post`, `mcp-client-post`, `service-account-id-put`, `tenant-member-put`, `reset-vault-post`, `operator-tokens-post`. Alias registration is at least as powerful. Also unspecified: `failClosedOnRedisError: true`, the limiter key scheme, `checkRateLimitOrFail` (which emits the rate-limit audit event), and the `fail-closed-manifest.txt` delta.
- **F12 (Major)** — removing an alias does not undo what it granted. The durable effect is `User.tenantId` and `TenantMember` rows created through it, and on the bootstrap branch wholesale row reassignment. After CR1/CR2, "revoke the alias" is the obvious incident response and it leaves the attacker's users inside the victim tenant permanently. C10 needs an incident runbook (enumerate members whose tenant was assigned while the alias existed — both `createdAt` values are available) and must say plainly that the bootstrap-migration case may be irreversible.
- **F13 (Minor, R49)** — C1's class overclaims. Only the case fold is engine-adjudicated. `CHECK (domain = lower(domain))` accepts `" alias.example"`, `"alias.example/path"`, `"https://alias.example"`, `"alias..example"`. Trimming, hostname grammar and scheme rejection stay app-enforced in C5's Zod schema — and C6, the second writer, is specified only as sharing the *normaliser*, which performs no grammar validation. C6 can therefore write a value C5 would reject.
- **F14 (Minor)** — no IDN/punycode canonicalization. `аlias.example` (Cyrillic U+0430) and `alias.example` are distinct rows rendering identically in the admin UI and audit metadata, and the same domain stores under two spellings depending on whether the IdP emits U-label or A-label — silently breaking resolution.
- **F15 (Minor)** — I9 names the wrong artifact. `/api/maintenance/*` falls through to `api-default` (`route-policy.ts:170-174`); there is nothing to register, and `EXTENSION_TOKEN_ROUTES`/`BEARER_RULES` is a different mechanism. The real deltas are the four in M4 plus a new `TENANT_PERMISSION` member (the repo's model is `requireTenantPermission(userId, TENANT_PERMISSION.X)` over a ten-member const object; reusing an unrelated permission silently widens it) and the `check-bypass-rls.mjs` `ALLOWED_USAGE` entry. Also: `/api/maintenance/*` does **not** receive the proxy's tenant IP access restriction, so C6's blast radius is reachable from any source IP.

**Answers to directed questions.** BYPASS_PURPOSE needs no new member (`AUTH_FLOW` covers C2's read, `SYSTEM_MAINTENANCE` covers C6's write) — but the plan must state which, and add the `check-bypass-rls.mjs` allowlist entry. C5/C6 authorization *layering* is correct per CLAUDE.md; the defect is the authority, not the layer. The sign-in read under `withBypassRls` and C5's read under caller-tenant RLS are both correct.

---

## Testing Findings

- **F3 (Major)** — `src/lib/tenant/tenant-management.test.ts` breaks three independent ways, one of them semantic: `:20-22` factory-mocks `@/lib/tenant/tenant-claim` wholesale so `normalizeTenantDomain` is `undefined`; `:4-9` `mockPrisma` has no `tenantDomain` delegate, hitting six of seven tests; and `:101-109` asserts `findUnique` was **not** called, which fails on ordering alone once the resolver reads `externalId` before any slug check. The natural repair — edit mocks until green — converts a behaviour-preservation proof into a test rewritten to match the new code. Where the empty-slug guard lives in the split is an undecided behaviour question the plan must settle.
- **F4 (Major)** — `src/auth.test.ts` does **not** mock `@/lib/tenant/tenant-management`; it exercises the real `findOrCreateSsoTenant`, so it absorbs the full C2/C3/C4 change, and the plan never mentions it. Five cases break: `:241-250`, `:354-370`, `:426-449` (missing `tenantDomain` delegate); `:372-396` (asserts `toHaveBeenCalledTimes(2)` — becomes 3 if `createSsoTenant` keeps its own leading `findUnique`, an unstated design question); and **`:451-459`, where the verdict flips false → true** (the `beforeEach` at `:194-198` makes the resolver succeed, so the row becomes `present/resolved/null` → allow). Positively: `src/lib/auth/session/auth-adapter.test.ts` **does** pass unchanged (it mocks the module with only `findOrCreateSsoTenant`, which is all `auth-adapter.ts:174` calls) — C3's second criterion is correct.
- **F5 (Major)** — the CI `env` paths filter (`.github/workflows/ci.yml:64-74`) does not include `src/**`, and `env-drift-check` is guarded by it. Check 12's trigger is a new env read anywhere under `src/**`; all nine C7 variables live outside the filter. A PR adding an undeclared read without touching a listed path would not run the job — the gate would be structurally incapable in CI of catching the tenth instance of the defect that motivated it. C9's registration criterion is satisfied in letter (already at `pre-pr.sh:328` and `ci.yml:91`) and false in effect.
- **F6 / M8 (Major)** — the established convention is `scripts/__tests__/fixtures/env-drift/<case>/` driven by `scripts/__tests__/check-env-docs.test.mjs:15` with `--root`; `scripts/__fixtures__/` holds unrelated files. Vacuity (RT4): `scanAppEnvReaders` silently returns an empty set when `<root>/src` is absent (`check-env-docs.ts:228-230`), so an `undeclared (fail)` fixture without a `src/` subtree passes as a false green, and the `dynamic-key-only (pass)` case is satisfied equally by a working and a broken scanner. Make the dynamic fixture contain both an invisible dynamic read and a statically-spelled *undeclared* read that flips it to exit 1, pinning the scanner as live. C9's `check-gate-selftest-coverage.sh` claim is inaccurate and should be removed rather than relied on — that meta-gate's member set is `scripts/checks/*.{sh,mjs}` plus `run_step "Static: …" bash -c`, and check-env-docs matches neither.
- **F7 / M4 (Major)** — see convergence table.
- **F8 (Major, RT1)** — the two assertions the plan advances as *proof* of I1 and the CHECK constraint are placed on the mocked side: "duplicate domain → 409" and "`Alias.Example`/`alias.example` → the second is a 409". Against a mocked Prisma both assert the test's own stub. A migration that omits the CHECK leaves both green. Move them to the C1 integration suite; keep a mocked route test for the `P2002 → 409` *mapping* and label it as such.
- **F9 (Major)** — C1 is called "integration (real DB)" but names no `*.integration.test.ts` file; its criteria are six hand-run `psql` invocations. I3 (RLS) is genuinely auto-covered by the existing `rls-smoke` job once the manifest line and seed rows land. I1 has manual coverage only. **I2 (`ON DELETE CASCADE`) has no acceptance criterion at all** — nothing deletes a tenant and asserts the alias rows vanish, and an orphaned alias row means a claim resolving to a deleted tenant's id.
- **F10 (Major, RT8)** — the two 409 paths assert status and body only. A handler that *upserts* (reassigning `tenant_domains.tenantId` to the caller's tenant) and then returns 409 satisfies both criteria while performing exactly the cross-tenant takeover NF1 identifies. Add: after the 409, exactly one row exists and its `tenantId` is unchanged. Separately, C4's deny rows assert only `tenant.create`; I6's scope is "no write other than the audit record", and `tenantMember.upsert` (`src/auth.ts:215`) is the other reachable write — assert it too, or a reorder that denies *after* upserting membership passes.
- **F11 (Major, RT5)** — C2's normalisation criterion would run against a mocked `normalizeTenantDomain`, because the minimal repair for F3(1) is to add it to the factory mock. The test would assert that the fake lowercased — a re-implementation of the logic under test. `normalizeTenantDomain` is the single producer of the stored form shared by three writers; a trim/case bug leaves every stated test green.
- **F12 (Major, R42)** — the seven-row dispatch table is internally consistent but its *outcome* set is incomplete. `createSsoTenant` inherits two `null` returns from the code being moved (empty-slug guard `tenant-management.ts:18-19`; double-P2002 `:57-60`), both producing deny, both with existing tests — no row covers the outcome. And row 1 (`absent`) collapses three distinct tested behaviours (no membership → allow, membership exists → allow, `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` → deny), undercounting by two. Nine rows, not seven.
- **F13 (Major, RT10)** — C6 frames itself as the RT10 case, then covers two of its four declared deny axes (absent, invalid) and omits expired-token and unresolvable-tenant. Its allow side is a single happy path, missing the idempotent re-run that VE2 explicitly requires (C11 runs this script against a shared dev DB) and the domain-owned-by-another-tenant case.
- **F14 (Major)** — user operation scenarios 2–7 map to no contract criterion, no test, and no manual-test step, while VE1's own mitigation argument makes them all `verifiable-CI` at the claim-string seam — silent omission, not justified deferral. Scenario 5's "existing sessions are unaffected" is a security-relevant claim about the blast radius of a DELETE with nothing testing it.
- **F15 (Minor)** — no shared constant module for `primary.example` / `alias.example` across six test surfaces (RT3); the SQL seed and gate fixtures are the deliberate duplication exception. C7's "boot behaves identically to `main`" has no mechanical form — the assertable subset is "the schema parses with each var absent and each parsed value equals the documented default". C9's `--root` scratch-copy proof method is **sound and non-mutating**; the "exactly nine keys" assertion should stay one-off and the committed fixtures should assert on the failure token, not the count.

**Verification-environment classification.** VE1's reasoning is sound — it correctly identifies that the untestable link is upstream of the `extractTenantClaimValue` seam, so every contract below it stays `verifiable-CI`. VE3 accurate. Gap: the eight user operation scenarios are never classified (F14).

---

## Adjacent Findings

- Functionality F16 [Adjacent → Security]: no step-up reauth on `POST /api/tenant/domains`. Independently raised by Security as F11 (Major). Merged as **M7**.
- Testing F2 [Adjacent → Functionality]: the `Promise<boolean>` signature blocks the test design, not only the implementation. Merged as **CR3**.

## Quality Warnings

None. All three reports cite file paths and line numbers, and all recomputed the
claims they contest rather than asserting them.

---

## Recurring Issue Check

### Functionality expert
- R1: OK — `createRateLimiter` reuse specified with a forbidden-pattern guard; `checkRateLimitOrFail` omission folded into F6.
- R2: N/A
- R3: OK — no session-cache-invalidating field touched; `invalidateCachedSessions` at `src/auth.ts:204` is on the untouched bootstrap path.
- R4: N/A
- R5: N/A
- R6: N/A
- R7: OK — C9's self-test proves the gate can fail against a scratch copy, never by mutating real source (fixture path corrected in F12).
- R8: OK — C4/C5/C6 criteria assert the mutation, not only status codes.
- R9: VIOLATION: F2 — emitting the new denial audit inside `ensureTenantMembershipForSignIn` runs `logAuditAsync`→`resolveTenantId`→`withBypassRls` nested inside the open `prisma.$transaction`.
- R10: OK — `normalizeTenantDomain` in `tenant-claim.ts` imported by `tenant-management.ts` follows the existing `slugifyTenant` direction; no cycle.
- R11: VIOLATION: F13 — display grouping and subscription grouping (by-reference) treated as one edit.
- R12: VIOLATION: F3 — new actions missing from the Prisma `AuditAction` enum and from `AUDIT_ACTION_VALUES`.
- R13: OK — `TENANT_WEBHOOK_DELIVERY_FAILED` not added to the new group; no re-trigger loop.
- R14: OK — recomputed against `db-grants-manifest.json`; `DEFAULTACL passwd_app=arwd` covers it, no sequence/worker/FK gap.
- R15: OK — table DDL + RLS + CHECK, no DB name, role, or hostname.
- R16–R20: N/A
- R21: N/A
- R22–R28: N/A
- R29: OK — the plan cites no external spec.
- R30–R41: N/A
- R42: VIOLATION: F9 (I6 missing `src/auth.ts:61, 73, 211, 233`, scoped to one file) and F8 (the domain-keyed-gate class omits `GOOGLE_WORKSPACE_DOMAINS`). I4's and C7's member-sets recomputed and confirmed correct.
- R43–R50: N/A

### Security expert
- R1: OK — shared `createRateLimiter` mandated with a forbidden pattern against reimplementation.
- R2: N/A
- R3: OK — no session-cached field changes; the bootstrap-migration invalidation at `src/auth.ts:204` untouched.
- R4: N/A
- R5: N/A
- R6: N/A
- R7: N/A
- R8: N/A
- R9: N/A
- R10: N/A
- R11: N/A
- R12: OK — C5 lists the enum entry, both group-array sites and both i18n files.
- R13: N/A
- R14: N/A
- R15: N/A
- R16–R41: N/A
- R42: VIOLATION — I6's enumerated set (5) contradicts its own derivation command (7) and omits `src/auth.ts:233`, the site carrying the D2 write.
- R43: N/A
- R44: N/A
- R45: N/A
- R46: N/A
- R47: VIOLATION — domain entitlement decided by the caller's admin role instead of DNS (F2); "is the 409 an oracle" decided by body content instead of outcome distinguishability (F10).
- R48: VIOLATION — `GOOGLE_WORKSPACE_DOMAINS` and `tenant_domains` adjudicate "is this `hd` acceptable" by different semantics, in a fixed order the plan never mentions (F5).
- R49: VIOLATION — C2 declares `detection or audit only` while acting as the sole boundary on the `createUser` path (F3); C1 declares engine adjudication of "normalisation" when only case is engine-enforced (F13).
- R50: N/A
- RS1: OK — new routes reuse `validateOperatorToken`/`hashToken` and `requireTenantPermission`; no new secret comparison.
- RS2: VIOLATION — limiters named but `failClosedOnRedisError`, key scheme, `checkRateLimitOrFail` and the `fail-closed-manifest.txt` delta all unspecified.
- RS3: VIOLATION — C6's `{tenantId, domain}` body has no specified Zod schema or `.strict()`; only C5's shape is defined.
- RS4: OK — `primary.example` / `alias.example` throughout, policy stated in a header block, re-asserted in C10's criteria. No real domain or email appears.
- RS5: VIOLATION — the IdP claim is an untrusted security parameter admitted into an authorization decision with no attestation floor and no source whitelist (F2, F4).
- RS6: VIOLATION — `sanitizeTenantClaimValue` strips C0/C1/DEL but not bidi/zero-width formatting characters, and there is no IDN canonicalization before storage or comparison (F7 rider, F14).

### Testing expert
- R1: OK — C5/C6 reuse `createRateLimiter` with a forbidden-pattern guard.
- R2: N/A
- R3: OK — session-cache invalidation untouched.
- R4–R11: N/A
- R12: OK — new `AUDIT_ACTION` values correctly carry the enum entry, both group arrays and both `AuditLog.json` files, mechanically enforced by `audit-i18n-coverage.test.ts`, `i18n/audit-log-keys.test.ts` and `audit-action-group-coverage.test.ts`. The parallel failure-*reason* surface is not enforced.
- R13–R41: N/A
- R42: VIOLATION — C4's dispatch table omits the `createSsoTenant`-returns-null outcome and collapses three tested behaviours into row 1.
- R43–R50: N/A
- RT1: VIOLATION — C5's duplicate-domain and case-variant 409 assertions sit on the mocked side but are adjudicated only by the unique index and CHECK constraint.
- RT2: N/A
- RT3: VIOLATION — shared `primary.example`/`alias.example` constants not named across six test surfaces.
- RT4: VIOLATION — C9's `undeclared (fail)` fixture passes vacuously without a `src/` subtree; the `dynamic-key-only (pass)` case cannot fail for its stated reason.
- RT5: VIOLATION — C2's normalisation assertion would run against a mocked `normalizeTenantDomain`.
- RT6: VIOLATION — `normalizeTenantDomain` has no direct test; the resolver/creator trio's proof is unexecutable; the route handlers miss gate-mandated fail-closed tests; the new `AuthLoginFailureReason` value has no test asserting it is emitted.
- RT7: VIOLATION — C9's proof method is sound, but C4's dispatch guard, C5's authz guard and C6's operator-token guard have no stated failure proofs, and the repo's mechanised RT7 for rate-limited routes (`assertRedisFailClosed`) is absent from both.
- RT8: VIOLATION — C5's two 409 deny paths assert status/body only; C4's deny rows assert `tenant.create` but not `tenantMember.upsert`.
- RT9: OK — no parallel-implementation twin touches tenant-claim resolution; `normalizeTenantDomain` is server-only.
- RT10: VIOLATION — C6's expired-token and unresolvable-tenant axes untested; the allow side omits the idempotent re-run VE2 requires.

---
---

# Plan Review: sso-tenant-domain-alias — Round 2
Date: 2026-07-29
Review round: 2

## Changes from Previous Round

Revision 2 answered round 1 by removing mechanism rather than adding controls: both HTTP routes
deleted (SC5 rejection + an offline CLI), `findOrCreateSsoTenant` left byte-unchanged so the
`createUser` path cannot see an alias, `Promise<boolean>` replaced by `SignInTenantResult`,
`extractTenantClaimValue` reshaped to `{value, source}`, the dispatch table grown 7 → 9 (+9b), and
the audit pepper derived from `AUTH_SECRET`.

## Verdict

**No-Go**, on entirely different axes from round 1.

The security reviewer states plainly that **all four round-1 Criticals are closed or moot** and that
no cross-tenant exploit could be constructed against revision 2 that does not begin with
database-level access. Round 2 returns **zero** security Criticals. What remains splits three ways:

1. **One design consequence revision 2 created.** Making `createUser` alias-blind — the fix for
   round-1 CR1 — introduced a shadowing-tenant regression that re-locks the tenant and silences the
   plan's own diagnostic (**M9**).
2. **Two feasibility Criticals** in artefacts revision 2 added (**M10**, **M11**).
3. **A long tail of mis-citations and stale member-sets** — including two the plan repeated after
   round 1 flagged the same class.

## Perspective convergence

| # | Finding | Func | Sec | Test | Merged |
|---|---|---|---|---|---|
| M9 | `createUser` creating an `externalId` tenant that shadows a registered alias re-locks the tenant | — | S1 Major | — | **Major (design)** |
| M10 | A `.mjs` script cannot import `enqueueAuditInTx` / `tenantDomainSchema` / Prisma — C7 is unimplementable | N1 Critical | S3 Major | T7 Major | **Critical** |
| M11 | `extractTenantClaimValue`'s `{value,source}` shape breaks unlisted consumers; the factory-mock form is silently truthy | N3 Major | S2 Major | T1 Critical | **Critical** |
| M12 | I6/F4 is enforced by a forbidden pattern no gate runs, and the grep is one-hop blind | — | S5 Major | T2 Critical | **Critical** |
| M13 | `check-critical-audit-atomic.mjs` mis-cited — `SEARCH_DIRS` is `["src/app/api","src/lib"]` | N7 Major | S3 Major | T8 Major | **Major** |
| M14 | `:451-459` does **not** stay `false`; the member set is 10, not 5 (R42) | N4 Major | — | T3+T4 Major | **Major** |
| M15 | Requirement F4 is contradicted by dispatch rows 4 and 6 | N2 Major | S7 Major | — | **Major** |
| M16 | C4's "no mock surface change" contradicts the Verification map | N8 Major | — | T15 Minor | **Major** |
| M17 | `scanAppEnvReaders` walks `.ts` only — `.tsx` is an unenumerated blind spot in a gate declared fail-closed | N12 Minor | S10 Major | — | **Major** |
| M18 | C9's module-scope memo is incompatible with its own four/five-configuration test list | N10 Minor | — | T10 Major | **Major** |

## Critical findings

### CR5 (M10) — C7's artefact cannot be built

`scripts/checks/check-mjs-imports.mjs:124` states the rule in code: `EXTENSIONS = ["", ".mjs",
".js", ".json"]` with the comment *".ts/.tsx are intentionally excluded: .mjs files should not
import TypeScript sources directly."* Plain `node` resolves neither the `@/` alias nor `.ts`.
Verified independently: **zero** `scripts/*.mjs` files import from `src/`. The cited precedents
(`bootstrap-rds-roles.mjs`, `audit-db-grants.mjs`) are `.mjs` *because* they import only `pg`; every
operator script that touches app code is `.ts` under tsx, the exact analogue being
`scripts/migrate-account-tokens-to-encrypted.ts` (`#!/usr/bin/env tsx`, reads
`MIGRATION_DATABASE_URL`, builds its own `PrismaClient` with `PrismaPg`).

The fallback — reimplementing normalisation in the script — is closed by C2's own single-producer
rule, and would be the RT5/RT9 defect C2 exists to prevent.

Consequential deltas the plan must then carry: a dedicated `PrismaClient` over
`MIGRATION_DATABASE_URL` (the `src/lib/prisma.ts` singleton reads `DATABASE_URL`), and a
`withBypassRls`-equivalent GUC set — `enqueueAuditInTx` hard-fails unless
`current_setting('app.bypass_rls') = 'on'` (`src/lib/audit/audit-outbox.ts:25-33`).
`check-bypass-rls.mjs` scans `src/` only, so no allowlist entry is needed — worth stating so a
reviewer does not add one.

### CR6 (M11) — the claim-shape change breaks four unlisted consumers, and the mock form is silently truthy

Enumerated from the repo:

| Site | Under `{value, source}` |
|---|---|
| `src/auth.ts:52` → `:71` | must pass `claim.value` — implied but unstated |
| `src/auth.ts:345-352` | **compile error** — `TenantClaimStore.tenantClaim` is `string \| null` (`src/lib/tenant/tenant-claim-storage.ts:14`). Absent from the plan. |
| `src/lib/auth/session/auth-adapter.ts:167-174` | downstream of the store; must stay a bare string or the adapter writes `externalId: "[object Object]"` |
| `src/lib/tenant/tenant-claim.test.ts` | nine assertions (`:35, :43, :52, :62, :71, :80, :90-92, :101, :110`) break. File named nowhere in the plan. |
| `src/auth.test.ts:97, :148, :192, :531, :562, :577` | untyped `vi.fn()` factory mock returning a bare string |

The test-side failure mode is the severe one. C2 moved `normalizeTenantDomain` to a new module
specifically to avoid a silent-**undefined** trap; changing `extractTenantClaimValue` *in the module
both suites factory-mock* is strictly worse — a missing export is `undefined` (loud), a stale bare
string is **truthy** (silent). `src/auth.ts:52`'s `if (!tenantClaim)` still passes, `claim.value` is
`undefined`, and the row-**7** test at `src/auth.test.ts:262-269` silently becomes a row-**9** test.
C5's own criterion "rows 7 and 9 are asserted mutually exclusive" would then assert one branch
against itself, and `tenant_mismatch` preservation — the NF2 regression case — ships untested.
`vi.mock` factories are not type-checked against the real module, so `tsc` / `next build` cannot
catch any of this.

### CR7 (M12) — the fix for round-1's Critical is enforced by a regex nobody runs, with a one-hop blind spot

I6 ("`auth-adapter.ts` never calls `resolveSsoTenantByClaim`") is discharged by a plan
forbidden-pattern. Nothing under `scripts/checks/` scans plan forbidden patterns, and the plan names
no gate to register it in. Worse, the two functions live in the **same module**
(`src/lib/tenant/tenant-management.ts`), so a natural DRY refactor that has `findOrCreateSsoTenant`
delegate its lookup leg to `resolveSsoTenantByClaim` reopens round-1 CR1 in full while the grep stays
green. The invariant is over the call graph; the check is over a spelling in one file — the repo's
own AST-first rule applies.

`src/lib/auth/session/auth-adapter.test.ts:66-68` factory-mocks `@/lib/tenant/tenant-management` with
only `findOrCreateSsoTenant`, so it cannot see a real alias row either way. The scenario the
Verification map calls *"the round-1 Critical, pinned as a test"* has no test.

## Major findings

- **M9 (Security S1) — the recovery is self-defeating.** After an operator registers
  `alias.example` for tenant T, the next *first-ever* sign-in from that organisation reaches
  `createUser` → `findOrCreateSsoTenant("alias.example")`, which by design does not consult aliases,
  and **creates tenant T2 with `external_id = alias.example`**. Nothing constrains
  `tenants.external_id` against `tenant_domains.domain` — they are unique in separate tables with no
  cross-constraint. From then on every existing member of T resolves through the `externalId` leg to
  T2, hits row 7, and is denied with `tenant_mismatch` — so `list --unmapped`, which filters on
  `tenant_claim_unmapped`, reports **nothing**. The plan states the precedence rule as a static
  acceptance criterion without noticing it is a live regression path.
- **M15 (N2 / S7) — F4 is contradicted by the plan's own dispatch table.** Rows 4 and 6 reach
  `tx.tenantMember.upsert` (`src/auth.ts:215`) and the bootstrap reassignment (`:181`), and in both
  `resolved` may have come from the alias leg. `resolveUserTenantIdFromClient` filters
  `deactivatedAt: null` (`src/lib/tenant-context.ts:8-12`), so an existing user whose memberships
  are all deactivated reaches row 4 and gains a membership in the alias-resolved tenant. The
  structural argument covers `createUser` only.
- **M13 — `check-critical-audit-atomic.mjs` has no jurisdiction.** `SEARCH_DIRS = ["src/app/api",
  "src/lib"]` (`:41`); it keys on `logAuditInTx(...)`, not `enqueueAuditInTx`; and `CRITICAL_ACTIONS`
  is a closed seven-member set — registering the two new actions would make the gate demand a
  `logAuditInTx` call under `src/app/api|src/lib` that will not exist, i.e. a red build. This is the
  round-1 `check-gate-selftest-coverage.sh` mis-citation recurring one contract over.
- **M14 — the `src/auth.test.ts` member set is stale and one claim is backwards.** Under revision 2
  the breaking cause is the return type, so the primitive is "every call site that reads the return
  value": `:231, 258, 267, 276, 343, 386, 408, 422, 443, 456` — ten, not five. And `:451-459` does
  **not** stay `false`: it sets only `mockSlugifyTenant.mockReturnValue("")`, while the `beforeEach`
  at `:194-198` leaves `tenant.findUnique({where:{externalId:"tenant-acme"}})` returning a row, so
  the resolver matches on `externalId` without ever slugifying → row **4** → allow. The verdict flips
  `false → true`, exactly as round 1 said. Separately `:372-396` goes **vacuous**: the resolver
  consumes the queued `mockResolvedValueOnce(null)`, `create` is never called, the P2002 race is no
  longer exercised, and both assertions still pass.
- **M16 — C4 vs the Verification map.** C3's alias tests need `tenantDomain.findUnique` on
  `tenant-management.test.ts`'s hoisted `mockPrisma` (`:3-14`), contradicting C4's "no mock surface
  change". Remedy: put C3's cases in a new file (`resolve-sso-tenant.test.ts`), which also lets them
  use the real `normalizeTenantDomain` — that file factory-mocks `@/lib/tenant/tenant-claim` at
  `:20-22`.
- **M17 — `.tsx` is an unenumerated blind spot.** `scanAppEnvReaders` walks `.ts` only
  (`scripts/check-env-docs.ts:206-212`). Eleven variables are read from `.tsx` today; all happen to
  be declared, so the gate is green by luck. A gate that declares itself fail-closed and enumerates
  its non-members must enumerate this one or close it.
- **M18 — C9's memoisation.** `vitest.config.ts` sets `isolate: true` per **file**, and
  `src/__tests__/setup.ts:20-25` mandates `vi.stubEnv` + `vi.unstubAllEnvs()`; neither reaches a
  value frozen at first call. Whichever configuration runs first pins the memo for the file. The plan
  must specify `vi.resetModules()` + per-case `await import()` (the pattern
  `src/__tests__/audit-logger.test.ts:151` already uses) or a `_reset` seam.
- **N5 — the dispatch table is still not exhaustive.** With a claim **present**,
  `resolveUserTenantIdFromClient` can throw `MULTI_TENANT_MEMBERSHIP_NOT_SUPPORTED` from inside the
  `withBypassRls` block (`src/auth.ts:75`), escaping to the catch at `:371-386` as `provider_error`.
  Row 3 covers that axis for `absent` claims only. This row is also a live D2 instance today — the
  throw happens *after* `findOrCreateSsoTenant` created a tenant at `:71` — so it is precisely where
  the reorder must be proven.
- **N6 — four forbidden patterns are unsatisfiable or not mechanically expressible.** C3's
  `(?s)…*?` spans arbitrary distance and fires on correct code, with a verdict that depends on
  declaration order. C7's `DATABASE_URL` is a substring of `MIGRATION_DATABASE_URL`, the one variable
  the script must read. C2's `\.toLowerCase\(\)` names an unbounded file set. C5's two are scope
  predicates, not regexes. NF3 requires every guard to be provably able to fail.
- **S4 — `remove --domain` has deployment-wide blast radius.** I9 argues uniqueness removes the
  parent-scoping hazard; that inverts it. Because `domain` is globally unique, `remove --domain
  <typo>` reaches into **any** tenant and denies every member at their next sign-in. `add --tenant
  <typo>` is symmetrical, runs as superuser/BYPASSRLS, and has no `--dry-run`, no confirmation, and
  no "here is what will change" output.
- **S6 — C9's dev fallback is a committed public constant.** An HMAC under a published key over the
  email input space is precomputable — round-1 F9's argument in a narrower band. `NODE_ENV`
  distinguishes build mode, not data sensitivity. The repo has already solved this shape differently:
  `src/lib/auth/session/session-cache.ts:84-117` uses dedicated env var → HKDF with a **versioned**
  info string → production throws → dev/test derives from **another real secret**. C9 keeps three legs
  and replaces the fourth with the one the precedent avoids. Also: `getIdentifierPepper` reads
  `AUTH_SECRET` directly, so the ≥32-char floor (enforced only under `isProd`) does not apply, and the
  info string lacks the `-v1` suffix every other HKDF site carries.
- **S8 — C13's remedy widens a global adjudicator with no removal condition.**
  `GOOGLE_WORKSPACE_DOMAINS` is deployment-global while the alias is tenant-scoped; nothing records
  which tenant it was widened for and no step ever removes it. Also, the
  `allowDangerousEmailAccountLinking` analysis is asymmetric: it is
  `allowedGoogleDomains.length > 0` (`src/auth.config.ts:43`), so *adding* changes nothing and
  *unsetting* flips it to `false` — **stricter**, producing a second, different lockout
  (`OAuthAccountNotLinked`). "Changing account-linking behaviour" is not a symptom anyone recognises
  at 3am.
- **S9 / N5 — I7's scan scope excludes two of its own enumerated outcomes.** The defining primitive
  says "every function it awaits" while the scan is pinned to three files, excluding
  `tenant-management.ts:18-19` and `:57-60` — the two falsy returns the plan itself enumerates as row
  9b. A member the plan can name but the scan cannot see makes the grep a spelling check.
- **T6 — the CLI test lands in the unit suite.** `vitest.config.ts` includes
  `scripts/__tests__/**/*.test.mjs`; `vitest.integration.config.ts` includes only
  `src/**/*.integration.test.ts`. `app-ci` runs the unit suite with a redis service and a dummy
  `DATABASE_URL`, so a real-DB test there either reds the job or self-skips. Repo convention is the
  opposite placement — `src/__tests__/db-integration/bootstrap-rds-roles.integration.test.ts` imports
  `../../../scripts/bootstrap-rds-roles.mjs`. `ci-integration.yml`'s paths filter also has no
  `scripts/**`.
- **T9 — C8's mutation proof does not fire.** Removing a value from `AUDIT_ACTION_VALUES` makes
  `audit-action-group-coverage.test.ts`'s subset assertion *smaller* — it stays green. What reds in
  `audit-i18n-coverage.test.ts` is the orphan-label guard (`:63-77`), not the coverage assertion. Three
  distinct mutations are needed, each naming the test it reds.
- **T11 — the "reason is actually emitted" criterion is filed at the wrong level.** Rows 1–9b test
  `ensureTenantMembershipForSignIn`, which only *returns* the reason; the emit is at
  `src/auth.ts:362-369`. A forgotten hard-coded `"tenant_mismatch"` there leaves every row test green
  and the audit trail wrong. `src/auth.test.ts` does not mock `@/lib/audit/auth-failure`, and nothing
  in the repo asserts `AUTH_LOGIN_FAILURE` metadata today.

## Minor findings

N9 (the `ALTER TYPE` justification is wrong — PG16 allows it in a transaction; the real constraint is
the `BEGIN/COMMIT` wrap for `ddlCount = 2`, and a baseline entry would be a regression, not a
remedy), N11 (no Prisma method or input type named for C3's alias read, C7's `remove`, or
`AuditOutboxPayload`'s eleven required fields), N13 / T12 / S11 (`auth-failure.test.ts` does not
exist; `METADATA_BLOCKLIST` is a redaction denylist, not an accept list, so "accepts the new fields"
can only be satisfied by a no-op; "the audit-schema note" names no file and `check-doc-paths.mjs`
will fail an invented one), N14 (`list --unmapped` reads `audit_logs`, populated only by the outbox
worker — a supported-stopped state yields a false-empty at incident time), N15 (`node:punycode` is
DEP0040; `new URL()` gives UTS-46 ToASCII in one primitive), N16 (C1 does not say whether the
migration carries the guarded `passwd_app` GRANT block five existing table migrations use), T13
(`23505`/`23514` need a stated client — a CHECK violation through the Prisma model API maps to no
Prisma code), T14 (C12's liveness companion writes into a committed fixture at runtime; ship a fifth
fixture instead), T16 (row 8 issues the same `externalId` lookup twice), S12 (CLI residuals: dead
unvalidated `note` column, punycode-only display, retention GC can erase the `--unmapped` evidence),
S13 (row 9b's double-P2002 path may be unreachable — the `P2002` aborts the enclosing Prisma
transaction, so the catch's follow-up queries should fail rather than return `null`, surfacing as
`provider_error`).

## Verified correct — recorded so they are not re-litigated

Independently recomputed by two or three reviewers: **I4** (55/55, both prose counts present at
`rls-cross-tenant-tables.manifest:24` and `rls-cross-tenant-seed.sql:5`); **I7's ten members**
(reproduce the plan's grep byte-for-byte, and the passkey negative result holds —
`src/app/api/auth/passkey/verify/route.ts:93-106` has its own bootstrap guard and never calls
`findOrCreateSsoTenant`); **C10's member set** (94 readers, 117 Zod keys, 11 literals + 2 regexes →
exactly ten, the plan's nine plus `INTERNAL_TEST_VERIFIER_VERSION`); **R14** grant delta; **R9**
closed (`withBypassRls<T>` is generic, so the discriminated result carries out and
`emitAuthLoginFailure` stays post-transaction); **R11/R13** (`TENANT_WEBHOOK_EVENT_GROUPS[ADMIN]` is
`AUDIT_ACTION_GROUPS_TENANT[ADMIN]` by reference at `audit.ts:787-789`;
`TENANT_WEBHOOK_DELIVERY_FAILED` is in the `TENANT_WEBHOOK` group, so no loop); **C12's CI-filter
delta** (`dorny/paths-filter` evaluates filters independently; `env` is consumed by one job; nothing
double-runs); `TenantDomainSource` needs no manifest entry (`check-migration-drift.mjs` invariant B
covers it); `check-bypass-rls.mjs` scans `src/` only; `auth-adapter.test.ts` genuinely passes
unchanged; **RS6** (the CSV path is safe — metadata serialises to a leading `{`, so
`CSV_FORMULA_TRIGGER_RE` can never fire, and the bidi strip at `sanitizeTenantClaimValue` is the
correct shared ingest point); **RS4** (no real domain or email anywhere in the plan).

## Quality Warnings

None. All three round-2 reports recomputed the claims they contest.

---
---

# Plan Review: sso-tenant-domain-alias — Round 3
Date: 2026-07-29
Review round: 3

## Changes from Previous Round

Revision 3 unified `tenants.external_id` and the claim registry into one namespace
(`tenant_claims`, backfilled), dropped the `TenantDomainSource` discriminator (SC7) and
the two audit actions (SC8), moved the CLI to `.ts` under tsx, renamed `domain` →
`claim`, and split the storage schema from the operator-input schema.

## Verdict

**No-Go.** All three reviewers endorse the unification itself — security reports **no
Criticals** and states again that no cross-tenant exploit exists that does not begin
with database-level access. Round-2's S1, S5, S7, CR6, CR7, M13, N7, N9 and the F4
self-contradiction are all verified dissolved rather than patched.

Three Criticals remain, and one of them is a three-round recurrence.

## Perspective convergence

| # | Finding | Func | Sec | Test | Merged |
|---|---|---|---|---|---|
| M19 | `P2002` aborts the enclosing Prisma interactive transaction, so C4's recovery arm cannot run | CR8 Critical | S3-2 Major | — | **Critical** |
| M20 | Dispatch row 9 removes the bootstrap→SSO migration path | F6 (partial) | — | T18 Critical | **Critical** |
| M21 | The backfill acceptance criterion cannot fail | — | — | T17 Critical | **Critical** |
| M22 | `Tenant.externalId` keeps an unreconciled `@unique`; `remove` desynchronises the namespaces into a permanent lockout | F2 Major | S3-1 Major | — | **Major** |
| M23 | `lower(btrim())` is not `normalizeTenantClaim`; the CHECK is collation-dependent; C6's strip changes the stored-vs-read form | F3 Major | S3-6 Major | — | **Major** |
| M24 | C4's create names no Prisma input type; the nested-vs-two-statement choice decides the P2002 semantics and the test fate | F5 Major | — | T19 Major | **Major** |
| M25 | `scripts/tenant-domain.ts` misses a `raw-sql-usage.txt` entry | F7 Major | — | T23 Major | **Major** |
| M26 | The CLI cannot be imported as specified — no main guard, no exported commands, no return-code contract | F12 Minor | — | T21 Major | **Major** |
| M27 | Test member sets re-derived from the wrong primitive; `tenant-management.test.ts`'s list is incomplete | F4 Major | — | T20 Major | **Major** |
| M28 | The dispatch table is declared exhaustive and is not | F6 Major | S3-11 Minor | T18 Critical | **Major** |
| M29 | I7's derivation grep cannot produce members the plan itself enumerates | F14 Minor | S3-11 Minor | T26 Minor | **Minor** |
| M30 | The `domain` → `claim` rename is half-applied; one stated Prisma call will not compile | F9 Minor | S3-15 Minor | — | **Minor** |
| M31 | A gate is cited from its name rather than its member set — third consecutive round | F11 Minor | S3-14 Minor | — | **Minor** |

## Critical findings

### CR9 (M19) — `P2002` poisons the transaction; the plan's stated adjudication authority is inoperative

`withBypassRls` is `prisma.$transaction(async (tx) => …)` (`src/lib/tenant-rls.ts:64-71`),
and both call sites hand that `tx` down (`src/auth.ts:70`,
`src/lib/auth/session/auth-adapter.ts:169-175`). Prisma interactive transactions issue
one `BEGIN` on one connection with **no per-statement savepoints**, so a unique
violation leaves the session in `ERROR` and every follow-up statement returns `25P02`.
C4 step 4's re-resolve and the retained slug-suffix retry both run on that `tx`.

The repo already states this in its own code:
`src/__tests__/db-integration/audit-anchor-epoch-migration.integration.test.ts:215-237`
— *"We run this in a SAVEPOINT so we can recover without aborting the outer tx."* All
twelve other `P2002` catches in `src/` sit **outside** a transaction and return 409
without re-querying. `src/lib/tenant/tenant-management.ts:36-61` is the sole exception,
and it is the code C4 carries forward.

**This is the third round.** Round-2 **S13** raised it as a Minor about the old row 9b.
Revision 3 answered *"C4's simpler structure removes the question"* — and simultaneously
promoted the mechanism from an "extremely unlikely double collision" to the declared
authority for **I6**, for C4's `enforceable boundary` control class, and for the
Concurrency section's claim that no new primitive is needed.

Three constraints can fire and one handler cannot distinguish them:

| Constraint | Reachable | Covered |
|---|---|---|
| `tenant_claims_claim_key` | concurrent first sign-in, same claim | described — inoperative |
| `tenants_slug_key` | `slugifyTenant` collapses `[^a-z0-9]+`, so `alias.example` and `alias-example` collide | described — inoperative |
| `tenants_external_id_key` | see M22 | **not covered at all** |

Every criterion that would catch this is on the mocked side, which the plan's own
Mocking-stance paragraph forbids.

**Remedy the repo already has**: `advisoryXactLock(tx, \`tenant-claim:${claim}\`)`
(`src/lib/tenant-rls.ts:88-93`) before the resolve→create sequence — the primitive
`check-count-then-create-lock.mjs` exists to enforce for exactly this read→check→write
shape. It removes the `P2002` path rather than repairing it. Whatever is chosen, the
proof moves to real Postgres.

### CR10 (M20) — row 9 removes the bootstrap→SSO migration path

The table splits the existing-tenant axis into bootstrap / non-bootstrap for the
`resolved` case (rows 6 and 7) but not for the `null` case. Today
`findOrCreateSsoTenant` *creates*, so `found` is always non-null and a bootstrap user's
first SSO sign-in migrates (`src/auth.ts:78-213`). Under revision 3
`resolveTenantByClaim` returns `null` for a claim nobody has presented, and row 9 denies
**before** the bootstrap check.

> A user who signed up via magic link and later signs in with Google for the first time,
> from an organisation whose claim no one has presented yet, is denied
> `tenant_claim_unmapped` where today they are migrated into a new SSO tenant.

The claim is only registered by C4, which is reached only on row 8 — the case a
bootstrap user is not in. `src/auth.test.ts:271-336` does not protect this: its
`beforeEach` already models "claim resolves", so it retargets cleanly to row 6 and the
create-then-migrate combination stays untested. NF2 is violated for every deployment
with bootstrap users.

Row 9 must split: **9a** (`present / null / different, existing is bootstrap`) →
create + migrate → **allow**; **9b** (`present / null / different, not bootstrap`) →
deny `tenant_claim_unmapped`. Creating on an allow path does not conflict with D2, which
is about writes on *denied* paths.

### CR11 (M21) — the backfill criterion cannot fail

*"After migration, every tenant with a non-empty `external_id` has exactly one
`tenant_claims` row … asserted as a set comparison"* — the test runs after the
migration, and both sides are empty:

- `.github/workflows/ci-integration.yml` creates a **fresh** `postgres:16` service DB and
  runs `prisma migrate deploy` before any test, so `tenants` has zero rows when the
  backfill executes.
- `src/__tests__/db-integration/helpers.ts:113-127` — `createTenant()` inserts
  `(id, name, slug, created_at, updated_at)` and never writes `external_id`.

Delete statement 3 from the migration and the assertion is still green. The backfill is
the single step making the registry authoritative for every pre-existing tenant (risk
**R-e**: a missing row is a tenant-wide lockout).

## Major findings

- **M22 (F2 / S3-1)** — `Tenant.externalId` keeps `@unique` and C4 still writes the
  **raw** claim into it while `tenant_claims.claim` holds the **normalised** one. Two
  namespaces, different rules, no cross-constraint — the exact shape the plan says S1
  came from. `remove` (scenario 4) and C13 step 1 both leave `external_id` behind, after
  which a first-ever sign-in presenting that claim hits `P2002` on
  `tenants_external_id_key`, which C4's handler misreads as a slug collision and retries
  with a suffix that changes only the slug. Permanent deny, reported as
  `tenant_mismatch`/`provider_error`, invisible to `unmapped`. Verified: `externalId` is
  read or written in exactly one non-test file, and no seeder, E2E fixture or
  `prisma/seed.ts` touches it — dropping `@unique` is free.
- **M23 (F3 / S3-6)** — three separate breaks in the claimed equivalence:
  `btrim(x)` strips **ASCII space only** while JS `.trim()` strips all Unicode
  whitespace, so a backfilled row can be stored un-trimmed, pass the CHECK, and be
  unreachable at read time; `lower()` is LC_CTYPE-dependent while `toLowerCase()` is
  fixed full-Unicode, so under a `C`-ctype database the CHECK **accepts** `Àbc` alongside
  `àbc` — two rows, one claim, I1 false. Non-ASCII claims are expected:
  `slugifyTenant` carries an explicit *"Fallback for non-ASCII-only inputs (e.g.
  Japanese org names)"* branch. Separately, C6's sanitizer rider extends
  `sanitizeTenantClaimValue`'s strip set without renormalising stored rows, so a claim
  containing U+200B resolves before the PR and not after — a self-inflicted lockout of
  the shape being fixed, produced by a change described as display hardening.
- **S3-3 (Security, unique)** — **the CLI has no RLS context.** C1 puts
  `FORCE ROW LEVEL SECURITY` on `tenant_claims`; `audit_logs` and `audit_outbox` already
  carry it. `FORCE` binds the table owner too — only `SUPERUSER` or `BYPASSRLS` escapes.
  C7 builds a bare `PrismaClient` over `MIGRATION_DATABASE_URL` and sets no GUCs. It
  works in docker dev only because `passwd_user` is a real `SUPERUSER`; on RDS the master
  user holds `rds_superuser` but neither `rolsuper` nor `rolbypassrls`. At incident time
  `list`/`unmapped` print nothing and `deleteMany` returns `count: 0`, which C7 maps to
  "unknown domain" — **silent wrong answers**, not errors. Round-2 CR5 raised this
  requirement via `enqueueAuditInTx`'s GUC hard-fail; SC8 dropped the audit row and the
  requirement went with it. The requirement was never about the audit row.
- **S3-4 (Security, unique)** — **SC8's premise is false.** "The row would record
  `SYSTEM` — attribution that looks present and is not" describes an established, honest
  pattern here: `emitAuthLoginFailure` writes `userId: SYSTEM_ACTOR_ID, actorType:
  ACTOR_TYPE.SYSTEM` for every failed sign-in, as do the outbox, retention-GC and
  anchor-publisher workers. `ACTOR_TYPE.SYSTEM` is a truthful statement. Separately, C7's
  `remove` is a hard `deleteMany` on a model with no `revokedAt`, so the responder's
  first action on discovering a bad claim **destroys `tenant_claims.createdAt`** — one of
  the two timestamps C12's own incident runbook needs. The runbook is unexecutable in the
  order it will be followed.
- **M24 (F5 / T19)** — C4 step 3 says only "Create the tenant **and** its row". The
  nested form (`Prisma.TenantCreateInput` with `claims: { create: … }`) is atomic on any
  `TxOrPrisma` and issues **no** `tenantClaim.create` call, so the stated assertion never
  fires and `src/lib/tenant/tenant-management.test.ts:52-59`'s exact-match breaks. The
  two-statement form re-creates round-2 S1's shadow state if the second failure is
  caught. C4's control class, I6's authority, M22's remedy and
  `src/auth.test.ts:354-370`'s fate all hang on the unstated choice.
- **M25 (F7 / T23)** — `check-raw-sql-usage.mjs:63` sets
  `SCAN_ROOTS = ["src", "scripts"]`. `unmapped` reads `audit_logs` ∪ `audit_outbox` over
  two different JSON shapes (`metadata->>'claim'` vs `payload->'metadata'->>'claim'`),
  which is raw-SQL-shaped and names no Prisma method. Both existing `scripts/*.ts`
  operator tools are already listed in `raw-sql-usage.txt`, one with `ident-markers=2`.
  Recorded negative: the gate's `EXCLUDE_RE` covers `__tests__`, so the integration
  tests' `$executeRawUnsafe` calls need no entry.
- **M26 (T21 / F12)** — the two cited precedents disagree on the load-bearing detail.
  `bootstrap-rds-roles.mjs:238` guards with
  `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)`;
  `migrate-account-tokens-to-encrypted.ts` ends with a bare `main().catch(… process.exit(1))`,
  so **importing it runs the CLI**. Three further gaps: every C7 criterion says "non-zero
  exit", which an imported function cannot express without killing the vitest worker; the
  confirmation prompt has no injectable seam, so tests hang on stdin; and "missing
  `MIGRATION_DATABASE_URL` → no connection attempted" requires a per-call env read, not a
  module-load memo. **Verified positive**: a `#!/usr/bin/env tsx` `.ts` file under
  `scripts/` imports cleanly from a vitest integration test — esbuild handles the
  hashbang. The extension is fine; the module shape is not.
- **M27 (F4 / T20)** — `src/auth.test.ts` never mocks `@/lib/tenant/tenant-management`,
  so the breakage primitive is "every test that reaches the real resolver", not "every
  site that reads the return value". Three more cases break: `:241-250`, `:354-370`
  (the only assertion on the create's argument shape — the thing C4 changes), `:426-449`.
  In `tenant-management.test.ts`, `:111` and `:128` are unlisted, and `:62`'s
  `toHaveBeenCalledTimes(2)` is retargeted with **no restated count** — the identical
  vacuity round 2 raised for `:372-396` and revision 3 fixed there but not here.
  `:451-459`'s rewrite is also under-specified: `src/auth.ts:53` is
  `if (!tenantClaim)`, so an **empty-string** claim is falsy and lands in row 1/2
  (allow), not row 8; the fixture must be truthy-but-invalid.
- **M28 (F6 / T18 / S3-11)** — declared exhaustive, three outcomes uncelled:
  `findOrCreateTenantForClaim` returning `null` (round-2 T12 recurring),
  `assertBootstrapSingleMember`'s throw on row 6 (`src/auth.ts:36-44`), and CR10's
  bootstrap split. Noted: C4 step 2's `storableClaimSchema` reject is **unreachable from
  sign-in** — `sanitizeTenantClaimValue` already trims, rejects empty and bounds at
  `MAX_TENANT_CLAIM_LENGTH`, the same bound the schema applies.
- **F8 (Functionality, unique)** — C5 gives the dispatch table and the result type but
  **never states the control flow**. The reorder is safe only if
  `resolveUserTenantIdFromClient(prisma, userId)` stays inside the `withBypassRls`
  callback: it is called with the global proxy (`src/auth.ts:75`) and works solely
  because `src/lib/prisma.ts:151-180` routes it to the active `tx`. An implementer who
  "resolves the existing tenant first" by hoisting it above `withBypassRls` runs it as
  `passwd_app` under FORCE RLS with no `app.tenant_id`, gets zero rows, and **every
  row-7/row-9 deny silently becomes a row-4/row-8 allow** — a cross-tenant fail-open that
  I7's walk-back would not catch, because the walk-back tests for the absence of
  `findOrCreateTenantForClaim`, which still holds.
- **S3-5 (Security)** — SC7's Anti-Deferral names the wrong barrier. The operator
  controls *whether a connection exists*; the customer controls *what their IdP asserts
  through it*, and the exploit needs only the second. `saml-jackson` is a single
  deployment-wide OIDC client and nothing binds a claim namespace to the connection that
  asserted it. Not escalated to Critical — the primitive is pre-existing, does not fire
  on `hd`-only deployments, and needs a deliberate `AUTH_TENANT_CLAIM_KEYS` naming an
  assertion-sourced attribute — but the plan *leans on* those non-`hd` keys as the reason
  the storage layer must accept non-domain values while deferring their attestation on a
  premise that does not hold.
- **S3-7 (Security)** — row 6 reassigns the signing-in user's **entire personal estate**
  (`passwordEntry`, `vaultKey`, `attachment`, `emergencyAccessGrant`, `passwordShare`,
  `apiKey`, `webAuthnCredential`, `session`, and `audit_logs` via
  `CALL audit_log_tenant_migrate`). Its trigger set now grows to every operator-registered
  claim. `tenant-domain add` prints the tenant and its member count — neither number tells
  the operator that registering a claim can absorb an existing personal vault. C12's
  runbook covers only the reverse direction.
- **T22 (Testing, unique)** — C6 modifies two files that already violate
  `check-test-hygiene.sh` gate (c) (`^\s*process\.env\.[A-Z_]+ *=` in any `.test.ts`
  changed vs main): `src/lib/tenant/tenant-claim.test.ts` has **nine** such lines,
  `src/__tests__/audit-logger.test.ts` one. Both are invisible today because neither file
  has changed. Touching them reds `pre-pr.sh:289` on ten pre-existing violations.
- **T24 (Testing, unique)** — the S1/atomicity proof sits on a passthrough
  `$transaction` mock (`fn => fn(mockPrisma)`, the repo's standard shape) that models no
  rollback, while its adjudication authority is Postgres. `helpers.ts:364`
  `raceTwoClients` exists for exactly this.
- **T25 (Testing, RT8)** — three deny paths assert the verdict without the mutation: C4's
  `storableClaimSchema` reject (which drops that case's two existing no-write
  assertions), C5 row 3, and C7's `remove` of an unknown domain.

## Minor findings

M29 (I7's grep cannot produce `src/lib/tenant-context.ts:17`, `src/auth.ts:41`, or
`tenant-management.ts:68` — the throw-exits and one `return found`); M30 (the rename is
half-applied: `deleteMany({where:{domain,tenantId}})` will not compile against
`Prisma.TenantClaimWhereInput`; I8's stated authority, the One-namespace section, C4's
control class and R-e all still say `domain`); M31 (`check-doc-paths.mjs` validates only
`src/…` and `scripts/…` references inside docs and **skips `docs/security/**` entirely**,
so C6's justification is wrong — third consecutive round of citing a gate from its name
rather than its member set); S3-10 (I8 declared schema-enforced for something
`UNIQUE(claim)` cannot adjudicate — an `UPDATE … SET tenant_id` satisfies the index);
S3-12 (a 2026-02 migration backfilled `external_id = id`, so upgraded deployments have
**tenant UUIDs** in the claim namespace, and `tenant_id` is the first default claim key);
S3-13 (`remove`'s input schema unspecified; the symmetric reading makes legitimately
stored non-domain claims unremovable); S3-8/F10 (C1 cites a C12 migration-abort runbook
that does not exist); S3-9 (the egress boundary for the new `claim` field is
`EXTERNAL_DELIVERY_METADATA_BLOCKLIST`, which already strips the sibling `reason` field
and which C6 does not name); F11 (the cited migration template opens with
`DROP POLICY IF EXISTS`, which `check-destructive-migration.mjs` fires on with no
baselinable route); F13 (`externalIds String[]` is a guard against a design nobody
proposed — NF3 satisfied only trivially; C5 cites `:374-386` where the catch opens at
`:371`); F15 (`UNIQUE(claim)` is deployment-global, so the shared `alias.example`
integration fixture is not isolatable under VE2's shared dev database); T27 (three
citation/count nits: `audit-logger.test.ts:151` has no `resetModules`, the `.tsx` var
count is twelve not eleven, C4 mis-names the `:45` case); T28, T29, T30, T2-cont (eight
forbidden patterns and no runner).

## Verified correct — recorded so they are not re-litigated

Recomputed independently by two or three reviewers this round: **I4** (55→56, all four
greps exact); **I7's return-set** (exactly the twelve enumerated lines); **the C9 env
member set** (94 `.ts` readers; adding `.tsx` gives 95 and leaves `A\B` **unchanged** at
ten — the single new member, `NEXT_PUBLIC_CHROME_STORE_URL`, is already declared, so
M17's closure costs nothing); **`Tenant.externalId`'s reader set** (one non-test file,
four sites; no seeder, no E2E fixture); **tenant creation sites** (three, none on an HTTP
surface — the round-1 Critical stays closed); **C8's production premise**; **S8's linking
direction**; **RS4** (mechanically scanned both documents for real domains and email
addresses — zero); `gen_random_uuid()`/`@db.Uuid`/raw-SQL-insert coexistence; `INSERT` is
not a `DDL_KEYWORD` so it neither inflates `ddlCount` nor trips
`check-destructive-migration.mjs`; `check-bypass-rls.mjs`, `check-count-then-create-lock.mjs`,
`check-critical-audit-atomic.mjs`, `check-migration-drift.mjs` invariant B and the
route-policy/fail-closed artefacts are all **N/A**; `auth-adapter.test.ts` needs only the
mock rename; `helpers.ts` needs no `DELETE FROM tenant_claims` (the `tenants` cascade
covers it); C2's two-schema asymmetry is coherent — nothing in the codebase assumes the
resolution key is a hostname.

## Quality Warnings

None. All three round-3 reports recomputed the claims they contest, and two of them
report empirical probes (a tsx-shebang import from a vitest integration test; the
`.tsx`-extended scanner run).

---
---

# Plan Review: sso-tenant-domain-alias — Round 4
Date: 2026-07-29
Review round: 4

## Changes from Previous Round

Revision 4 answered round 3 with `advisoryXactLock` in C4, `Tenant.externalId` losing its
`@unique`, an ASCII CHECK (SC9), the CLI's RLS GUCs and module shape, `revokedAt` +
`createdBy`, a thirteen-row dispatch, and SC8's justification corrected.

## Verdict

**No-Go on the document; Go on the design.** Security returns **no Criticals** for the
second round running and re-confirms that no cross-tenant path exists short of
database-level access. Round-3's design Criticals (CR9, CR10, CR11) are all closed —
CR9's remedy was **empirically validated** against the dev Postgres.

The distribution is the finding:

| | R1 | R2 | R3 | R4 |
|---|---|---|---|---|
| Criticals against the **design** | 4 | 3 | 1 | **0** |
| Criticals against the **document's mechanisms** | 0 | 0 | 2 | **6** |

Every round-4 Critical is a specification that would not run: `ALTER TABLE … DROP
CONSTRAINT` against an object created as `CREATE UNIQUE INDEX`; an `@import` directive
Prisma does not have; a `SAVEPOINT` placed after the statement that aborts the session;
a mock surface missing `$executeRaw`; a `P2002` acceptance criterion the contract body
already deleted. These are what `npx next build`, `npx vitest run` and
`npm run db:migrate` surface in minutes. At 1650 lines the plan has become the defect
surface, and plan review is the wrong instrument for adjudicating them.

**Disposition**: settle the three items that only plan review can settle, de-specify the
implementation detail back to contracts / invariants / acceptance criteria, and let the
toolchain adjudicate the rest in Phase 2. Phase 3 re-reviews the resulting code with the
same three experts, so verification is deferred, not dropped.

## Empirical probes (Security)

Run against `passwd-sso-db-1` from a scratchpad script; no repo file mutated:

```
A: duplicate key inside prisma.$transaction → follow-up statement 25P02   ← CR9 reproduced
B: SAVEPOINT → failure → ROLLBACK TO SAVEPOINT → continue → COMMIT ✓      ← remedy validated
C: same recovery via the Prisma model API (P2002 surfaced, session usable) ← validated
pg:  lower('İ')            = 'i'          (1 char, pure ASCII)
js:  'İ'.toLowerCase()     = 'i'+U+0307   (2 chars, non-ASCII)
pg:  lower('I' COLLATE "tr-x-icu") = 'ı'  (non-ASCII from ASCII input)
pg:  lower('ABC' COLLATE "C")      = 'abc' (locale-independent fold)
```

## The three items that require plan-level decisions

### D1 — Deploy window (Functionality **N3**, Security **N3**)

`scripts/deploy.sh` is migration-first: the migration runs while the **old** code is
still serving. Old `findOrCreateSsoTenant` writes `tenants.external_id` and no claim row,
and the backfill has already run, so that row is never filled. Concretely, for a claim
first presented during the roll: old pod creates `T_old` with `external_id = X`; the new
pod then resolves `X` → `null`, the user's tenant is non-bootstrap → **row 9b, denied,
permanently**. Recovery is blocked whenever another user reached the create on a new pod,
because `X` is then owned by `T_new` and `add --tenant T_old` is refused by
`UNIQUE(claim)`.

Security adds the inverse for the `DROP CONSTRAINT`: with the unique index gone and old
code live, two concurrent first sign-ins for one claim create **two tenants with the same
`external_id`** — the round-2 **S1** shadow-tenant class, inside its own rollout window.
A rollback leaves the constraint dropped, so the old path runs permanently unguarded.

**Resolution: expand-and-contract.** Release 1 adds `tenant_claims`, the backfill, RLS and
grants; the resolver falls back to `Tenant.externalId` when no claim row matches, and
creation writes **both**. Release 2 removes the fallback, the `externalId` write and the
unique index. Cost: one release in which the two-key hazard persists — bounded, because
the fallback makes the two agree by *reading* rather than by convention.

### D2 — Revoked-claim semantics (Functionality **N4**, Testing **T39**, Security **N2**)

`revokedAt` was added so a claim's lifetime survives the incident response that discovers
it. But the row keeps its slot in `UNIQUE(claim)` while `resolveTenantByClaim` filters
`revokedAt: null`, so:

- **Sign-in**: rows 8 and 9a resolve `null`, proceed to create, and hit `P2002` on
  `tenant_claims_claim_key` — which C4 forbids catching, so it aborts the auth transaction
  and surfaces as `provider_error`. `unmapped` shows nothing. C4's own text asserts the
  opposite ("no `P2002` on `tenant_claims_claim_key` is reachable at all").
- **Recovery**: `add` after `remove` for the same tenant reports success and leaves one
  row, but never clears `revokedAt` — **the tool says it recovered and the tenant is still
  locked out.**

Security also flags C3's stated reason for the filter placement as a false mechanical
justification: index occupancy is a property of the table, not the query;
`findUnique({where:{claim, revokedAt: null}})` would occupy it identically.

**Resolution**: `add` is an upsert that clears `revokedAt` when the tenant matches and
refuses with an explicit *revoked-and-owned-by* message otherwise; C4 checks for a revoked
row under the advisory lock and returns `null` (→ a deny row) rather than colliding. A
partial unique index is rejected — it would permit two revoked rows per claim and weaken
I1 from total to conditional.

### D3 — Normalisation equivalence (Security **N1**)

SC9's central claim — *"restricting the stored form to printable ASCII makes the two
engines agree by construction"* — is **false**, demonstrated in both directions above. The
ASCII filter is applied to the **output** of `lower(btrim(external_id))`, so any value
whose Postgres fold is ASCII but whose JS fold is not passes and is stored. Consequences:
a tenant backfilled as `istanbul.example` whose IdP asserts the U+0130 spelling is locked
out (D1's shape, produced by the fix); and a *different* organisation asserting the plain
ASCII spelling resolves into that tenant — a cross-tenant admission the plan introduces.
C12's pre-flight query cannot surface it, because it tests the folded output too.

**Resolution**: fold with `lower(x COLLATE "C")` in both the CHECK and the backfill, apply
the ASCII filter to the **raw** `external_id`, and test the query on the raw column.

## Convergence, round 4

| Finding | Func | Sec | Test |
|---|---|---|---|
| Deploy window (D1) | N3 Critical | N3 Major | — |
| Revoked claim (D2) | N4 Critical | N2 Major | T39 Major |
| The deleted `P2002` criterion survives in the acceptance criteria | N5 Critical | — | T31 Critical |
| `@import` is not a Prisma mechanism | N16 Major | — | T34 Major |
| Dispatch counted three ways (13 / "twelve" / "ten") | N9 Major | — | T32 Major |
| Deny rows without mutation assertions | N9 Major | R8 | T33 Major |
| Mock surface lacks `$executeRaw` | N14 Major | — | T37 Major |
| I7's grep over-produces — AST trigger fired | N15 Major | N9 Minor | T42 Major |
| `auth.test.ts` delta not re-derived | N13 Major | — | T43 Major |
| A gate cited from its name, not its member set | N2 Critical | N6 Major | T49 Minor |

Mechanism-only findings, deferred to Phase 2 where the toolchain adjudicates: `DROP
CONSTRAINT` vs `DROP INDEX` (**N1**), `SAVEPOINT` ordering (**N6**), the `TxOrPrisma`
default disarming the lock (**N10**/**N4**), `raceTwoClients` specification (**T36**),
`storableClaimSchema`'s missing ASCII predicate (**N5**), the `raw-sql-usage.txt` entry for
`tenant-management.ts` (**N6**), the unscoped `DELETE` in the backfill test (**T35**), row
counts and citations.

## Verified correct — fourth independent recomputation

**I4** (55 → 56, all four sites); **the C9 env member set** (94 `.ts` readers, 95 with
`.tsx`, `A\B` = ten, byte-identical to the plan's table); **`Tenant.externalId`'s reader
set** (one production file, four sites, all deleted by C4; every other `externalId` hit is
`ScimExternalMapping`); **both C4 call sites hold a real transaction** today; **`RS4`**
(mechanically scanned both documents for email addresses and real TLDs — zero); the
`SAVEPOINT` precedent is real but is a *test* file excluded from `check-raw-sql-usage`, so
it carries none of the gate implications a production site does.

## Quality Warnings

None. All three round-4 reports recomputed their claims; security ran live database
probes rather than reasoning from documentation.
