# Plan: bind step-up reauthentication to the credential that established the session

Date: 2026-08-11
Branch: `fix/bind-stepup-to-session-credential`

## Project context

- **Type**: web app (Next.js 16 App Router + Prisma 7 + PostgreSQL 16), with a browser
  extension and a CLI as separate clients of the same API.
- **Test infrastructure**: unit + integration (`vitest`, real-DB integration suite under
  `src/__tests__/db-integration/`) + E2E (Playwright under `e2e/`) + CI/CD.
- **Verification environment constraints**:
  - **VE1 — WebAuthn ceremonies cannot be executed by the automated suites.** The E2E
    harness has no virtual authenticator: `grep -rln 'virtualAuthenticator\|addVirtualAuthenticator' e2e`
    returns nothing, and the only WebAuthn reference in `e2e/` is table cleanup
    (`e2e/helpers/db.ts:429`). Unit tests mock the ceremony; integration tests seed rows
    and call server functions directly. Therefore the *ceremony* half of every contract is
    `blocked-deferred` for automated E2E, while the *server decision* half is
    `verifiable-CI` through the integration suite (assertion payloads are constructed as
    fixtures, not signed by a real authenticator).
    **The deferral covers the cryptographic ceremony only.** Which dialog a given session state
    produces needs no signed assertion — only a seeded `sessions` row and a page load — and the
    harness already seeds session state directly (`makeSessionStale` in `e2e/helpers/db.ts`,
    used by `e2e/tests/step-up-stale-window.spec.ts`). That path is `verifiable-CI` and is in
    scope here, not in `SC5` (finding M11); drawing the deferral any wider would price two
    assertions as an infrastructure PR.
    Anti-Deferral (VE1): cost of closing the ceremony half = adding a Playwright CDP
    virtual-authenticator harness (new helper, new fixture lifecycle, CI browser flags) — a
    separate infrastructure PR, larger than this fix. Cost of not closing = the
    credential-binding decision is proven at the server-decision layer (integration, real DB,
    real FK) and in `verify-authentication-assertion.test.ts` against the real verifier, with
    the ceremony layer covered by the manual test plan in VE2. Owner: `SC5`.
  - **VE2 — manual verification requires two physical authenticators, available.** The
    verification host `mrx33` has two registered security-key credentials for the same user
    plus one platform passkey (see Evidence E2), which is exactly the shape this fix
    discriminates. Manual test plan under "User operation scenarios" is
    `verifiable-local` on that host.
  - **VE3 — integration tests cannot share a database with a running outbox/GC worker**
    (`CLAUDE.md`, and `src/__tests__/db-integration/setup.ts` refuses to run). Stop
    `audit-outbox-worker` and `retention-gc-worker` before running the integration suite.

## Evidence

Every quantitative claim below is reproducible with the command beside it.

- **E1 — the step-up gate is satisfiable by any registered credential of the user, not by
  the one that established the session.** `evaluateStepUpFreshness`
  (`src/lib/auth/session/recent-current-auth-method.ts:43`) branches only on
  `sessionRow.provider === "webauthn"`; the session row records no credential
  (`grep -n 'model Session' -A 20 prisma/schema.prisma` — no credential column), and
  `reauth/options` (`src/app/api/auth/passkey/reauth/options/route.ts:52-68`) puts *every*
  credential of the user into `allowCredentials`.
- **E2 — observed in production-shaped data on `mrx33`.** Session established
  2026-08-08 03:44:56 by the platform passkey `dE3_mzcNZW…`; step-up satisfied on 08-09,
  08-10 and 08-11 by the security key `z2zTNpqevo…`; no `AUTH_LOGIN` on 08-11 at all.
  ```bash
  ssh mrx33 "cd ~/ghq/github.com/ngc-shj/passwd-sso && docker compose exec -T db \
    psql -U passwd_user -d passwd_sso -c \"select created_at, action::text, \
    left(coalesce(metadata::text,'-'),120) from audit_logs \
    where action::text in ('AUTH_LOGIN','AUTH_PASSKEY_REAUTH') order by created_at desc limit 10;\""
  ssh mrx33 "cd ~/ghq/github.com/ngc-shj/passwd-sso && docker compose exec -T db \
    psql -U passwd_user -d passwd_sso -c \"select left(credential_id,10), transports, \
    device_type, backed_up, discoverable, last_used_at from webauthn_credentials order by created_at;\""
  ```
- **E3 — 45 route files depend on this gate**, so the weakness is not extension-specific.
  ```bash
  grep -rln "requireRecentCurrentAuthMethod" src/app --include='*.ts' | grep -v test | wc -l   # 45
  ```
  The set includes `vault/reset`, `webauthn/credentials/[id]` (DELETE — whose own comment
  claims it "re-asserts the SAME auth method"), `mcp/authorize`, `mobile/authorize`,
  `extension/bridge-code`, `tenant/policy`, `tenant/breakglass`,
  `tenant/members/[userId]/reset-vault`, `tenant/service-accounts/[id]/tokens`, `api-keys`.
- **E4 — a second, dormant adjudicator of the same predicate exists with weaker
  semantics.** `requireRecentPasskeyVerification` and `markCurrentSessionPasskeyVerified`
  (`src/lib/auth/webauthn/recent-passkey-verification.ts`) read/write
  `passkeyVerifiedAt` *without* consulting `provider`, and have **zero production
  callers**:
  ```bash
  grep -rn "requireRecentPasskeyVerification\|markCurrentSessionPasskeyVerified" src \
    --include='*.ts' --include='*.tsx' | grep -v "recent-passkey-verification.ts:"
  # → only src/lib/auth/webauthn/recent-passkey-verification.test.ts
  ```

## Objective

Make the step-up gate verify what its name claims: that the human re-proved **the
authenticator that established this session**, not merely that they hold one of the
account's registered credentials. Record the establishing credential on the session row at
sign-in, restrict the reauth ceremony to it, and fail closed when no binding exists.

Non-objective: excluding non-discoverable credentials from authentication (see `SC4`). The
binding predicate deliberately rests on a server-verified fact — which credential actually
produced this session — and not on the browser-reported `credProps.rk` value stored in
`webauthn_credentials.discoverable`, which is unverified and is `NULL` for 3 of the 4
security-key registrations on `mrx33` (E2).

## Requirements

**Functional**

- FR1: A passkey sign-in records the DB row id of the verified credential on the session it
  creates.
- FR2: The reauth ceremony offers exactly the bound credential and no other.
- FR3: A reauth assertion produced by any credential other than the bound one is denied, and
  denial leaves `passkey_verified_at` unchanged.
- FR4: A session with no live binding (legacy row, or the bound credential was deleted)
  cannot step up at all; the user is routed to a fresh sign-in rather than to a ceremony
  that cannot succeed.
- FR5: A session established by a non-WebAuthn provider cannot run the reauth ceremony.
- FR6: A denied reauth caused by credential mismatch is auditable.

**Non-functional**

- NFR1: Deleting a credential must clear every session binding that references it without
  relying on application code running (schema-enforced).
- NFR2: No new fail-open default: every caller of the **shared assertion verifier** in
  `src/lib/auth/webauthn/webauthn-server.ts` names the credential it expects by calling an
  explicitly-named function, never by passing a nullable value into one shared entry point
  (finding M1/M2). Declared non-members of this class, with reasons:
  `authorizeWebAuthn` (`src/lib/auth/webauthn/webauthn-authorize.ts:145-170`) verifies an
  assertion through its own inline `verifyAuthentication` + counter CAS — it is the
  binding-*establishing* event, where "any credential in the system" is the correct scope and
  is also where `C2` reads the row id from; `verifyRegistration` verifies an attestation, not
  an assertion.
- NFR3: One-time cost is bounded and stated: every existing `provider='webauthn'` session
  has `auth_credential_id = NULL` after the migration and must sign in again before its
  next step-up-gated operation. Live sessions on both known deployments at plan time: 0
  (`select count(*) from sessions;` on `gx10-a9c0` and `mrx33`).

## Technical approach

The binding is stored as a real foreign key to `webauthn_credentials(id)` with
`ON DELETE SET NULL`, so NFR1 is enforced by PostgreSQL rather than by remembering to clear
it in every credential-deletion path. The gate's freshness verdict shape does not change
(`fresh` / `stale` / `invalid`); what changes is *which* credential can move a session from
`stale` to `fresh`, plus a fail-closed answer when nothing can.

The predicate "can this session recover via a passkey ceremony?" currently has three
independent implementations (MS3) that would disagree the moment the binding is enforced —
a client probe would open a ceremony dialog that the server then refuses. All three move
together in `C5`; that co-movement is the part of this change most likely to be got wrong,
so it is a contract rather than an implementation detail.

## Member-set derivations (R42)

Each universally-quantified invariant below carries the command that defines its class and
the resulting member list. Conformance greps in Phase 2/3 run over the **working tree**
(`git grep` at HEAD), never over the diff text — a removal diff contains the removed token
on its `-` lines and would false-positive.

- **MS1 — step-up freshness adjudicators** (every reader that turns `passkey_verified_at`
  into an allow/deny decision):
  `grep -rn "passkeyVerifiedAt" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'`
  → (a) `evaluateStepUpFreshness` / `requireRecentCurrentAuthMethod`
  (`src/lib/auth/session/recent-current-auth-method.ts`); (b)
  `requireRecentPasskeyVerification` (`src/lib/auth/webauthn/recent-passkey-verification.ts`,
  zero callers — E4). Both are addressed: (a) by `C5`, (b) by `C6`.
- **MS2 — `passkey_verified_at` writers**: same command → (a)
  `src/app/api/auth/passkey/verify/route.ts:154` (sign-in, initial value); (b)
  `src/app/api/auth/passkey/reauth/verify/route.ts:86` (refresh); (c)
  `markCurrentSessionPasskeyVerified` (zero callers). `auth-adapter.ts:updateSession`
  writes only `{expires, lastActiveAt}` and is a deliberate non-member.
- **MS3 — "can recover via passkey" predicates** (the ones that must not disagree):
  (a) server `canRecoverSessionWithPasskey` (`recent-current-auth-method.ts:83`) — used by
  the sign-in reauth panel; (b) server `/api/user/auth-provider` → `canPasskeySignIn`
  (`src/app/api/user/auth-provider/route.ts:31`) — read by the client probe
  `canUsePasskeyRecovery()` (`src/lib/auth/webauthn/can-use-passkey-recovery.ts`), which
  fails **open**; (c) the gate itself, `reauth/options`, which returns `404` when the
  credential list is empty. Derivation:
  `grep -rn "canRecoverSessionWithPasskey\|canUsePasskeyRecovery\|canPasskeySignIn" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'`
- **MS4 — shared-assertion-verifier call sites, INCLUDING test callers.** The derivation must
  not filter tests: a test that calls the changed function is a member of the class, and the
  first version of this plan missed three of them by filtering `.test.` out of the command
  (finding M3/M9).
  `grep -rn "verifyAuthenticationAssertion\|verifyAssertionForCredential\|verifyAssertionAnyCredential" src --include='*.ts' | grep -v 'webauthn-server.ts:'`
  → **production**: `src/app/api/auth/passkey/reauth/verify/route.ts:73` (bound credential),
  `src/app/api/webauthn/authenticate/verify/route.ts:55` (any credential — correct, a generic
  presence ceremony, not a freshness gate),
  `src/app/api/webauthn/credentials/[id]/prf/route.ts:130` (any credential — PRF re-bootstrap).
  → **tests**: `src/lib/auth/webauthn/verify-authentication-assertion.test.ts` (the ONLY test
  that reaches the real verifier; 12 call sites use the 4-positional-arg form and must move to
  the new named functions — this file is where `C4`'s allow/deny pair lives, see Testing
  strategy), `src/app/api/webauthn/authenticate/verify/route.test.ts:148-153` and
  `src/app/api/webauthn/credentials/[id]/prf/route.test.ts:230-237` (both assert the exact old
  positional shape via `toHaveBeenCalledWith` and must assert the new callee/arguments — R19).
- **MS5 — audit-action propagation for `C7`** (adding `AuditAction` values):
  `grep -rn "AUTH_PASSKEY_REAUTH" src prisma messages --include='*.ts' --include='*.json' --include='*.prisma' | grep -v '\.test\.'`
  → `prisma/schema.prisma:895` (DB enum), a new
  `ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS` migration statement,
  `src/lib/constants/audit/audit.ts` at three sites (the `AUDIT_ACTION` map :22,
  `AUDIT_ACTION_VALUES` :245, `AUDIT_ACTION_GROUPS_PERSONAL[AUTH]` :460),
  `messages/en/AuditLog.json`, `messages/ja/AuditLog.json`. **Enforcing gates — three files,
  not one** (finding M7): `src/__tests__/audit-action-group-coverage.test.ts` asserts membership
  in the *union* of `_PERSONAL ∪ _TEAM ∪ _TENANT` and never reads the locale files, so it would
  stay green if a personal-scope action were filed under `_TEAM`; the locale half is enforced by
  `src/__tests__/audit-i18n-coverage.test.ts` and `src/__tests__/i18n/audit-log-keys.test.ts`.
  `C7` therefore also strengthens the group test to assert scope-correct placement.
- **MS6 — session row creators**: `grep -rn "session.create" src --include='*.ts' | grep -v '\.test\.'`
  → `src/app/api/auth/passkey/verify/route.ts:145` (WebAuthn — sets the binding, `C2`) and
  `src/lib/auth/session/auth-adapter.ts:510` (OAuth/email — binding stays `NULL`, correct).
  There is no session-rotation path that would need to carry the binding forward:
  `grep -rn "rotateSession\|regenerateSession\|newSessionToken" src --include='*.ts'` → none.
- **MS7 — checked non-member: the session cache.** `SessionInfoSchema`
  (`src/lib/auth/session/session-cache.ts:43`) carries neither `provider` nor
  `passkeyVerifiedAt`, and `evaluateStepUpFreshness` reads the row with a direct
  `findUnique`. No cache-hit read path can therefore observe a stale binding, and the cache
  schema needs no change. Recorded because a cache-hit read bypassing a fail-closed check is
  a known trap in this codebase.

- **MS9 — API error-code propagation for the two new codes** (`PASSKEY_REAUTH_UNAVAILABLE`,
  `PASSKEY_REAUTH_CREDENTIAL_MISMATCH`). Derived from an existing member of the same class:
  `grep -n "SESSION_STEP_UP_REQUIRED" src/lib/http/api-error-codes.ts` → three sites in that
  file — the `API_ERROR` map (:226), `API_ERROR_STATUS` (:511, both new codes → **403**), and
  `API_ERROR_I18N` (:693) — plus `messages/en/ApiErrors.json` and `messages/ja/ApiErrors.json`.
  Enforcing gate: `src/__tests__/api-errors-i18n-coverage.test.ts`, which resolves every
  `API_ERROR` value through `apiErrorToI18nKey` and additionally asserts the en/ja key sets are
  identical — so a code added without both locale strings reds the suite.
  Checked non-member: `scripts/checks/check-step-up-client-coverage.sh`. Its
  `BRANCH_TOKEN_RE` (:147) polices the class "route returns `SESSION_STEP_UP_REQUIRED`" and
  accepts `handleStepUpError(` as the branch token; the new codes are handled *inside*
  `useInlineReauth` / `operator-token-card`, downstream of that branch, so no guard change is
  needed. Recorded because the guard's own header says it polices only that one code — a future
  round that expects it to cover these two would be relying on a gate that never looks.
- **MS8 — checked non-member: DB role grants (R14).** `passwd_app` holds *table-level*
  SELECT/INSERT/UPDATE/DELETE on `public.sessions`
  (`grep -n 'public.sessions' scripts/checks/db-grants-manifest.json`), not column-scoped
  grants, so a new column is covered automatically and the manifest needs no edit. The FK
  added by `C1` needs no runtime grant either: the constraint check and the
  `ON DELETE SET NULL` action execute as the constraint owner, not as the connecting role.
  Recorded because column-scoped grants on the same table would have made the new column
  unwritable by the app role, and that failure surfaces only at request time.

## Contracts

### C1 — `sessions.auth_credential_id` (schema)

**Change**: add to `model Session`:

```prisma
authCredentialId String? @map("auth_credential_id") @db.Uuid
authCredential   WebAuthnCredential? @relation(fields: [authCredentialId], references: [id], onDelete: SetNull, onUpdate: Cascade)
```

with the reciprocal relation field on `WebAuthnCredential`, plus
`@@index([authCredentialId])`. Migration
`prisma/migrations/20260811120000_add_session_auth_credential_id/migration.sql`: `ADD COLUMN`
(nullable, no default), `ADD CONSTRAINT … FOREIGN KEY … ON DELETE SET NULL ON UPDATE CASCADE`,
`CREATE INDEX`. Additive only — no strict constraint in the same migration (R24).

**Control class**: enforceable boundary (storage-engine-enforced). The constrained actor is
any writer of `sessions` or deleter of `webauthn_credentials`, including ad-hoc SQL.
Adjudication authority: PostgreSQL's referential-integrity checker.

**Invariants**

- I1 (schema-enforced): a session can never reference a credential row that does not exist.
- I2 (schema-enforced): deleting a credential clears every session binding to it, so no
  session silently falls back to "any credential" — it becomes unrecoverable-by-ceremony
  instead (FR4/NFR1).
- I3 (schema-enforced): the column is nullable, and `NULL` means "no binding" — the
  legacy/unbound value. `NULL` is the *only* in-band value with that meaning and it cannot
  collide with a legitimate credential id (UUID domain), so no sentinel collision.

**Forbidden patterns**

- `pattern: onDelete: Cascade` in the new `Session.authCredential` relation — reason:
  deleting a credential must not delete the session; it must unbind it (I2).
- `pattern: NOT NULL` in this migration's `ADD COLUMN` statement — reason: every existing
  row is unbound; a NOT NULL column would fail the migration (R24).

**Acceptance criteria**

- `npm run db:migrate` applies on a database holding `provider='webauthn'` sessions.
- `DELETE FROM webauthn_credentials WHERE id = <bound>` leaves the session row present with
  `auth_credential_id IS NULL`.
- `UPDATE sessions SET auth_credential_id = gen_random_uuid()` is rejected by the FK.

### C2 — record the establishing credential at sign-in

**Signatures**

```ts
// src/lib/auth/webauthn/webauthn-authorize.ts
export interface WebAuthnAuthResult {
  id: string;
  email: string;
  name: string | null;
  /** DB row id (uuid) of the credential that produced the verified assertion. */
  credentialRowId: string;          // required — not optional
  prf?: { prfEncryptedSecretKey: string; prfSecretKeyIv: string; prfSecretKeyAuthTag: string };
}
export async function authorizeWebAuthn(
  credentials: Record<string, unknown>,
): Promise<WebAuthnAuthResult | null>;
```

`src/app/api/auth/passkey/verify/route.ts` passes `authCredentialId: user.credentialRowId`
into its `tx.session.create({ data: … })`.

**Control class**: fail-closed verification gate. The field is required in the return type,
so TypeScript — not a runtime check — is the adjudication authority for "the id is always
present when a passkey sign-in succeeds". If a future path ever creates a WebAuthn session
without it, the binding is `NULL` and `C3`/`C5` deny step-up rather than widening it.

**Invariants**

- I4 (type-enforced): `authorizeWebAuthn` cannot return a success result without a
  credential row id.
- I5 (app-enforced): a session row with `provider='webauthn'` created by this route always
  carries a non-null `auth_credential_id`. Not schema-enforceable as a CHECK without
  constraining the OAuth/email rows too (`provider` is nullable for legacy sessions and
  `auth-adapter` legitimately writes `NULL`); stated here as the weaker form deliberately,
  with `C5` as the fail-closed backstop.
- I5b (app-enforced, recorded because `C4` leans on it — finding M12): **at most one
  `provider='webauthn'` session exists per user**, because this route deletes every session of
  the user inside the same transaction before creating its own
  (`src/app/api/auth/passkey/verify/route.ts:131`). The reauth challenge key is user-scoped
  (`webauthn:challenge:reauth:${userId}:${challengeId}`), so without this coupling a challenge
  minted by one WebAuthn session could be redeemed by another. `C4` does not rely on the
  coupling alone — it re-checks `provider` and the binding on the redeeming session — but the
  coupling is stated here so that relaxing the eviction, or adding a second session-creating
  path that writes `provider='webauthn'`, fails review instead of silently widening redemption.

**Consumer-flow walkthrough**

- Consumer 1 (`src/app/api/auth/passkey/verify/route.ts:84,145`) reads
  `{ id, email, name, credentialRowId, prf }` and uses `credentialRowId` as the
  `authCredentialId` of the session row it creates, and `prf` for the PRF response body.
  Sole production consumer:
  `grep -rn "authorizeWebAuthn" src --include='*.ts' | grep -v '\.test\.'` → this file only.
  Its docstring claiming it is "Called by the 'webauthn' Credentials provider's authorize
  function" is stale; correct it in the same edit (R29 — a false rationale is what licenses
  the next wrong edit).
- Consumer 2 (`src/lib/auth/webauthn/webauthn-authorize.test.ts`) asserts the returned
  shape; the mock in `src/app/api/auth/passkey/verify/route.test.ts:61` must return the new
  required field or the route test compiles against a shape production never produces (R19,
  RT1).

**Forbidden patterns**

- `pattern: credentialRowId\?:` — reason: an optional binding is a fail-open default (I4).

**Acceptance criteria**

- A successful passkey sign-in produces a session row whose `auth_credential_id` equals the
  `id` of the `webauthn_credentials` row matching the asserted `credentialId`.
- `authorizeWebAuthn` returns `null` (unchanged) on every existing failure path.

### C3 — `reauth/options` offers exactly the bound credential

**Behaviour** (`src/app/api/auth/passkey/reauth/options/route.ts`), after the existing
session + rate-limit + Redis + RP-ID checks:

1. Load the session row for the request's own token: `{ provider, authCredentialId }`.
2. `provider !== "webauthn"` → `403 API_ERROR.SESSION_STEP_UP_REQUIRED`. (FR5. Today such a
   session can run the ceremony and write a `passkey_verified_at` that no adjudicator reads.)
3. `authCredentialId === null` → `403` with the **new** error code
   `API_ERROR.PASSKEY_REAUTH_UNAVAILABLE` (FR4) — distinct from
   `SESSION_STEP_UP_REQUIRED` precisely so the client can tell "re-prove your key" from
   "this session can never be re-proved; sign in again".
4. Otherwise `allowCredentials` = the single row found by
   `findFirst({ where: { id: authCredentialId, userId } })`, written as a **literal `where`
   object inside the non-null branch** — never `id: authCredentialId ?? undefined`, which
   Prisma treats as "filter not supplied" and which would silently widen the lookup to any
   credential of the user (finding M2; `strictUndefinedChecks` is not enabled in this repo:
   `grep -rn strictUndefinedChecks . --include='*.ts' --include='*.json' --include='*.prisma'`
   → no hits). Row absent → same `403 PASSKEY_REAUTH_UNAVAILABLE` with
   `reason: "credential_missing"`. This branch is **reachable**, not defensive dead code: steps 1
   and 4 are two statements with no lock between them, so a credential deleted in between lands
   here. Saying "the FK makes it unreachable" would be the same false-safety reasoning I9 was
   corrected for (finding N9) — the outcome is fail-closed either way, but the reason has to be
   the true one, because the reason is what licenses the next edit.
5. PRF extension input is built from that one credential only.
6. Both denials (steps 2 and 3/4) emit an audit event — see `C7`. A denial that leaves no
   trace is indistinguishable from a user closing the dialog (finding M14), and step 2 closes
   a path that succeeds today, so its first observable effect must not be silence.

**Control class**: **fail-closed admission gate + ceremony shaping** — two things, and only the
first is a control. The admission half (provider must be `webauthn`, binding must be present and
still resolve to a row) is a fail-closed verification gate whose adjudication authority is the DB
row read inside the request; unresolved and absent-subject cases all deny. The shaping half
(`allowCredentials` narrowed to one entry) is **not a control**: `reauth/options` returns the
challenge in its response body, so any script in the page origin can call
`navigator.credentials.get` with an `allowCredentials` of its own choosing. Which credential may
actually satisfy the ceremony is decided by `C4` alone (finding M16) — a reviewer who reads I6 as
a gate stops auditing the one place the gate lives.

**Invariants**

- I6 (app-enforced, shaping only): the response's `allowCredentials` has length exactly 1 and
  its id is the session's bound credential. This determines what a cooperating browser offers
  the user; it constrains nothing about what the server will accept.
- I7 (app-enforced): no response body distinguishes "user has other credentials" from "user
  has only this one" — the shape is a single entry either way, so the change introduces no
  new enumeration oracle.

**Consumer-flow walkthrough**

- Consumer 1 `reauthenticateWithPasskey()`
  (`src/lib/auth/webauthn/passkey-reauth-client.ts:19-27`) reads `{ challengeId, options }`
  and passes `options` to `startPasskeyAuthentication`; on `!res.ok` it reads
  `body.error` and returns `{ ok: false, error }`. It therefore already propagates the new
  code without a shape change — but the two UI consumers below must map it.
- Consumer 2 `useInlineReauth` (`src/hooks/auth/use-inline-reauth.ts:96-103`) currently maps
  every non-cancel error to `tAuth("reauthFailed")`, which would strand the user in a dialog
  that can never succeed. It must map `PASSKEY_REAUTH_UNAVAILABLE` to the
  recent-session/sign-in-again path (`setReauthOpen(false)` + `setRecentSessionOpen(true)`),
  with a new `Auth` message key in `messages/{en,ja}/Auth.json`.
- Consumer 3 `SignInReauthPanel` (`src/components/auth/signin-reauth-panel.tsx`), reached
  from `src/app/[locale]/auth/signin/page.tsx:83-96`, receives `canUsePasskey` from the
  server (`C5`) and so must not normally see this code; it must still surface the
  sign-in-again fallback if it does.
- Consumer 4 `operator-token-card.tsx` calls `reauthenticateWithPasskey()` directly (it
  deliberately does not use the hook) and needs the same mapping.
- Derivation of the consumer set:
  `grep -rln "passkey-reauth-client\|reauthenticateWithPasskey" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'`
  → `use-inline-reauth.ts`, `signin-reauth-panel.tsx`, `operator-token-card.tsx`,
  `auto-extension-connect.tsx` (the extension-connect surface from E2 — it consumes the
  hook's result and needs no additional mapping beyond Consumer 2's).

**Forbidden patterns**

- `pattern: tx.webAuthnCredential.findMany` in `reauth/options/route.ts` — reason: the
  ceremony must never enumerate the user's credentials again (I6).
- `pattern: \?\? undefined` inside any `where` in `reauth/options/route.ts` and
  `src/lib/auth/webauthn/webauthn-server.ts` — reason: an optional Prisma filter is the
  fail-open form of the binding lookup (M2). The check must name itself and exit non-zero when
  it cannot parse a target file: "examined nothing" must not be spelled like "found nothing".

**Acceptance criteria**

- Session bound to credential A → response contains exactly one `allowCredentials` entry,
  equal to A.
- `provider='nodemailer'` session → 403 `SESSION_STEP_UP_REQUIRED`, no Redis challenge
  written, one `AUTH_PASSKEY_REAUTH_UNAVAILABLE` audit row naming the provider reason.
- `auth_credential_id IS NULL` → 403 `PASSKEY_REAUTH_UNAVAILABLE`, no Redis challenge
  written, one `AUTH_PASSKEY_REAUTH_UNAVAILABLE` audit row naming the no-binding reason.
- Allow side, so the gate is not merely "always deny": a bound `provider='webauthn'` session
  still gets a challenge written to Redis and **zero** denial audit rows (assert the count).

### C4 — `reauth/verify` enforces the binding

**Signatures** (`src/lib/auth/webauthn/webauthn-server.ts`) — **two named functions, not one
function with a nullable parameter**:

```ts
/** Freshness path: only the credential identified by `credentialRowId` may satisfy this. */
export async function verifyAssertionForCredential(
  tx: TxOrPrisma,
  userId: string,
  credentialRowId: string,                 // never nullable
  response: AuthenticationResponseJSON,
  challengeKey: string,
  opts?: { userAgent?: string | null },
): Promise<VerifyAssertionResult>;

/** Presence ceremonies: any credential of this user may satisfy this. */
export async function verifyAssertionAnyCredential(
  tx: TxOrPrisma,
  userId: string,
  response: AuthenticationResponseJSON,
  challengeKey: string,
  opts?: { userAgent?: string | null },
): Promise<VerifyAssertionResult>;
```

The first version of this contract had one entry point taking
`expectedCredentialRowId: string | null`, where `null` meant "any credential". Two independent
reviews and an escalated third rejected it (findings M1, M2), for two reasons worth recording
because both defeat a check that looks sufficient:

- The value `reauth/verify` would pass comes out of `sessions.auth_credential_id`, which `C1`'s
  FK sets to `NULL` the moment the bound credential is deleted. A deletion landing inside the
  5-minute challenge TTL (`WEBAUTHN_CHALLENGE_TTL_SECONDS`, `webauthn-server.ts:48`) therefore
  turns the binding into the "no restriction" sentinel, and the E1 bypass returns — reachable by
  an ordinary user with two keys who deregisters the one they lost while a reauth prompt is open,
  and by anyone holding the session cookie inside a live step-up window, since the credential
  DELETE is gated by that same window (`src/app/api/webauthn/credentials/[id]/route.ts:39`).
- A forbidden-pattern grep for the literal `expectedCredentialRowId: null` cannot fail for that
  case, because the call site passes a variable (R47). Neither does a `{ mode }` sum type help:
  `{ mode: x ? "bound" : "any" }` type-checks. Only a **distinct callee name** makes the choice
  decidable by grep, which is why the contract is two functions.

Both functions build their `where` as a **literal object inside an explicit branch** — the bound
one `{ id: credentialRowId, userId, credentialId: responseCredentialId }`, the any one
`{ userId, credentialId: responseCredentialId }`. Never an optional filter: Prisma reads
`undefined` as "filter not supplied", so `id: x ?? undefined` silently reverts the bound lookup to
any-credential while passing types, `next build`, and the old grep (M2).

`src/app/api/auth/passkey/reauth/verify/route.ts`, inside the transaction it later updates:

1. Read `{ provider, authCredentialId }` for the request's own session digest.
2. Session row absent → `401` (matching `requireRecentCurrentAuthMethod`). "No row" must never be
   spelled the same as "no restriction".
3. `provider !== "webauthn"` **or** `authCredentialId === null` → `403
   PASSKEY_REAUTH_UNAVAILABLE`, the verifier is **not called**, and the Redis challenge is **not
   consumed** (the `getdel` lives inside the verifier, so an early return preserves the
   one-shot). Emit the `C7` unavailable audit event. Re-checking `provider` here rather than
   trusting `C3`'s entry check is what stops the two adjudicators of FR5 from drifting (M12).
   Step 1 reads through the session's `authCredential` relation, so `boundCredentialId` (the
   base64url `credential_id`, needed by `C7`) is captured **before** the race window rather than
   by a later lookup keyed by the FK — which would come back empty in exactly the case the audit
   row is most needed (finding N4).
4. Otherwise call `verifyAssertionForCredential(tx, userId, authCredentialId, …)`.
5. Only when `assertion.ok` — unchanged from today — write `passkeyVerifiedAt`.
6. **Denials are classified on a structured discriminator, never on `details` text.** Round 2
   specified three outcomes distinguished partly by the verifier's free-text `details` string.
   Round 3 rejected that (findings P1/P3-adjacent, raised independently by the functionality and
   security reviews): re-deriving the verifier's actual `!ok` surface from
   `webauthn-server.ts:454-546` gives **seven** returns, **four** of which share the identical
   `{ status: 400, code: "VALIDATION_ERROR" }` shape and differ only in `details` — challenge
   expired/already used, missing credential id in the response, generic verification failure, and
   counter mismatch. Discriminating those by message text is the same surface-form defect this
   plan replaced the literal-`null` grep for (R47), and it would let an ordinary double-submit
   (expired challenge, bound row untouched) be reclassified and logged as a clone-suspicion or
   wrong-key event.

   So `VerifyAssertionResult`'s failure variant gains a structured
   `reason: "redis_unavailable" | "rp_id_unconfigured" | "challenge_missing" |
   "response_credential_id_missing" | "credential_not_found" | "signature_invalid" |
   "counter_mismatch"` — one member per existing return, assigned at each return site, and the
   route switches on it. Nothing branches on `details`; `details` stays a human-readable
   companion. The two non-freshness call sites ignore `reason` and are unaffected.

   The route's mapping, exhaustive over that union (a `default` branch denies closed and emits
   nothing rather than falling into whichever label the last `else` produced):

   | verifier `reason` | re-check `{ id: credentialRowId, userId }` | response | audit |
   |---|---|---|---|
   | `credential_not_found` | row **gone** | `403 PASSKEY_REAUTH_UNAVAILABLE` | unavailable / `credential_missing` |
   | `credential_not_found` | row **present** | `403 PASSKEY_REAUTH_CREDENTIAL_MISMATCH` | mismatch / `presented_credential` |
   | `signature_invalid` | not run | unchanged `400 VALIDATION_ERROR` | mismatch / `signature_invalid` |
   | `counter_mismatch` | row **gone** | `403 PASSKEY_REAUTH_UNAVAILABLE` | unavailable / `credential_missing` |
   | `counter_mismatch` | row **present** | unchanged clone-mismatch `400` | mismatch / `counter_mismatch` |
   | `challenge_missing`, `response_credential_id_missing`, `redis_unavailable`, `rp_id_unconfigured` | not run | **unchanged, pass through** | **none** |

   Three points this table exists to fix, each from a separate finding:
   - `signature_invalid` is its own row. It is reached when the presented `credentialId` **is** the
     bound one but the signature does not verify — the shape that most resembles a real forgery or
     replay, and the one a caller holding only the session cookie can reach without any
     authenticator (the bound credential id is not secret; `C3` already returns it in
     `allowCredentials`). Round 2's scheme had no label for it: it would have gone unaudited, or
     been logged as `presented_credential` with `presentedCredentialId === boundCredentialId` — a
     row contradicting its own reason (finding P1).
   - The four unrelated reasons pass through untouched — no re-check, no audit row, and the
     **verifier's own `status` and `code` forwarded unchanged**. Describing them by behaviour
     rather than by code matters: two of them (`challenge_missing`,
     `response_credential_id_missing`) are `400 VALIDATION_ERROR`, but `redis_unavailable` and
     `rp_id_unconfigured` are `503 SERVICE_UNAVAILABLE` (`webauthn-server.ts:456,471`) — which is
     why the route's existing ternary (`reauth/verify/route.ts:96-97`) special-cases
     `SERVICE_UNAVAILABLE` today. An earlier revision of this bullet called all four
     "`VALIDATION_ERROR`" (finding Q1); hard-coding that would turn a real service outage into a
     client error. A retry against an expired challenge must not acquire a security-incident label
     either.
   - The existence re-check runs only on the two reasons where "did the row vanish?" is the actual
     question. It cannot manufacture a success: it runs after `assertion.ok === false` and has no
     path back to `session.update`, and `webauthn_credentials.id` is a server-generated UUID so a
     deleted row cannot reappear under the same id.

**Control class**: fail-closed verification gate, in two layers over one resolution path — the
route's binding branch (step 3) and the SQL predicate of the bound lookup (step 4). Adjudication
authority is the database: the deny is the absence of a row, not a TypeScript inequality someone
can invert. Every ordering of a concurrent credential deletion resolves to a deny or to a
genuine-binding success:

| deletion commits… | outcome |
|---|---|
| before step 1's read | binding reads `NULL` → step 3 denies |
| between step 1 and the lookup | bound lookup finds no row → deny |
| between the lookup and the counter CAS | `UPDATE … WHERE id = … AND counter = …` matches 0 rows → deny (`webauthn-server.ts:530-546`) |
| after the counter CAS | the deleting statement blocks on our row lock until we commit; the reauth was performed by the genuine binding, and the now-unbound session is denied by `C5`'s gate change on its next gated request |

**Considered and not adopted**: pinning `authCredentialId` (and the session digest) into the Redis
challenge *value* at mint time, so no re-read at verify could degrade it. It is strictly stronger
than step 3 and would close M12 structurally, but the challenge value stops being a bare string,
which changes the wire shape at all three verifier call sites (R40) and at both challenge writers.
The ordering table above shows step 3 plus the bound lookup already denies every ordering, so the
extra coupling is not bought by a gap — recorded here so a future round can weigh it rather than
rediscover it.

**Invariants**

- I8 (app-enforced): a reauth assertion from a credential other than the binding cannot reach
  the `session.update`, so `passkey_verified_at` is unchanged on denial (FR3).
- I9 (app-enforced): a credential deletion concurrent with a reauth cannot leave a session
  refreshed by a credential other than its binding. **The mechanism is the id-scoped lookup and
  the counter-CAS row lock — not the transaction boundary.** `withBypassRls` opens a plain
  `prisma.$transaction` with no `isolationLevel` (`src/lib/tenant-rls.ts:64-70`), i.e. PostgreSQL
  default READ COMMITTED, where every statement takes a fresh snapshot and the session read takes
  no lock on `webauthn_credentials`; "same transaction" alone would fence nothing (finding M5).
  Recorded this precisely because the false reason is what would license a future edit to move
  the lookup out of the transaction, or to replace the CAS with an unconditional update, while
  appearing to preserve the invariant.
- I9b (app-enforced): the challenge is consumed only on paths that actually call the verifier, so
  a step-3 denial does not burn the user's outstanding ceremony.

**Forbidden patterns**

- `pattern: verifyAssertionAnyCredential` under `src/app/api/auth/passkey/reauth/` — reason: the
  freshness path must use the bound verifier (I8). Decidable on the callee symbol, which is the
  point: this is what replaces the literal-`null` grep that could not fail (M1).
- `pattern: \?\? undefined` inside any `where` in `src/lib/auth/webauthn/webauthn-server.ts` —
  reason: M2. Checked against the corrected code, which uses two literal `where` objects, so the
  pattern does not match its own fix.

**Consumer-flow walkthrough** (added in round 2 — the mismatch code's client mapping previously
existed only as Testing-strategy prose, so a contract-faithful implementer had no instruction to
route it anywhere but the generic failure message, which is the dead end M15 was filed to close —
finding N3):

- Consumer 1 `reauthenticateWithPasskey()` (`src/lib/auth/webauthn/passkey-reauth-client.ts:47-49`)
  reads `body.error` from the non-ok response and returns `{ ok: false, error }`. Both new codes
  reach the same slot as `PASSKEY_REAUTH_UNAVAILABLE`; no shape change.
- Consumer 2 `useInlineReauth` (`src/hooks/auth/use-inline-reauth.ts:96-103`) must give
  `PASSKEY_REAUTH_CREDENTIAL_MISMATCH` the **same** transition as `PASSKEY_REAUTH_UNAVAILABLE`
  (`setReauthOpen(false)` + `setRecentSessionOpen(true)`), with its own message key.
  `AUTHENTICATION_CANCELLED` still shows `reauthCancelled` and a genuine transport failure still
  shows `reauthFailed`: collapsing any of the three makes the new codes worthless.
- Consumer 3 `SignInReauthPanel` — must surface the sign-in-again fallback if it ever sees either
  code, though `C5` should keep it from doing so.
- Consumer 4 `operator-token-card.tsx` (`:187-199`) — same mapping, implemented separately since
  it deliberately does not use the hook, and it reaches the branch from **inside** the open
  ceremony dialog, so without the mapping there is no escape at all.

**Acceptance criteria**

- Session bound to A, row A present, assertion from B (both owned by the user) → `403
  PASSKEY_REAUTH_CREDENTIAL_MISMATCH`, `select passkey_verified_at from sessions` byte-identical
  before and after, and one mismatch audit row **with a non-empty `boundCredentialId`**.
- Session bound to A, row A deleted after step 1's read → `403 PASSKEY_REAUTH_UNAVAILABLE` with
  `reason: "credential_missing"` — **not** the mismatch code and not the clone warning — **and a
  non-empty `boundCredentialId` on that row despite the bound row being gone.** That last clause is
  the only assertion in the whole plan that can distinguish step 1's relation capture from a later
  FK-keyed lookup: in every other tuple the row is still present, so a late lookup would find it
  too and the assertion would pass either way (finding P4). Red-proof: move the capture to a
  post-denial lookup and only this assertion reddens.
- Counter-CAS matches 0 rows with row A still present → the pre-existing clone-mismatch response,
  plus one mismatch audit row with `reason: "counter_mismatch"`.
- Counter-CAS matches 0 rows with row A **gone** → `403 PASSKEY_REAUTH_UNAVAILABLE` /
  `credential_missing`, the same tuple as the `credential_not_found`+gone row. This state had no
  criterion until round 4 (finding Q2), and it needs its own test even though its expected output
  coincides with another row's: without one, a `counter_mismatch` arm that skips the existence
  re-check and always returns the clone warning is indistinguishable from a correct
  implementation. Drive it from the `counter_mismatch` reason specifically, not from
  `credential_not_found`.
- Presented credential **is** the bound one but the signature does not verify → unchanged `400
  VALIDATION_ERROR`, plus one mismatch audit row with `reason: "signature_invalid"` and
  `presentedCredentialId === boundCredentialId` (the row is truthful about that, rather than
  claiming a different credential was presented).
- An already-consumed challenge, or a response body with no `id`, with row A still present →
  **unchanged** response and **zero** new audit rows. This is the no-op side of the classification
  and the criterion that would catch an over-broad re-check (P1).
- The six denial states above produce **five** distinct `(status, error code, audit action,
  reason)` tuples, not six: `credential_not_found`+gone and `counter_mismatch`+gone deliberately
  coincide, because both mean "the bound credential no longer exists" and the user needs the same
  answer either way. The count is stated exactly because an earlier revision claimed one tuple per
  state (finding Q2, raised by the functionality and testing lanes independently), which would push
  an implementer either to invent a difference that contradicts the mapping table or to conclude
  the isolation red-proof is broken. Each of the six states still needs its own test — two of them
  assert the same expected tuple from different triggers. A test asserting only "denied" cannot
  tell any of them apart and is not evidence (N4).
- Session bound to A, assertion from A → 200, `passkey_verified_at` advances, zero denial audit
  rows (assert the count, or an added emission is invisible).
- Binding nulled between `reauth/options` and `reauth/verify`, assertion from any credential →
  `403 PASSKEY_REAUTH_UNAVAILABLE`, verifier never invoked, challenge still present in Redis,
  `passkey_verified_at` unchanged.
- A bound-mode call with a syntactically valid but foreign UUID denies by row absence — it does
  not throw.
- `verifyAssertionAnyCredential` still returns `ok` for any credential of the user, and the two
  non-freshness call sites' existing tests stay green — proving the change did not simply narrow
  everything.

### C5 — one predicate for "can this session recover via passkey"

Four members move together — the gate itself plus the three MS3 predicates:

0. **`evaluateStepUpFreshness` gains the binding check**: its `provider === "webauthn"` branch
   returns `stale` when `authCredentialId === null`, in addition to the existing
   `passkeyVerifiedAt` window test. **The Prisma `select` must add `authCredentialId`**
   (`recent-current-auth-method.ts:54`); forgetting it makes the branch compare `undefined` to
   `null`, which is `false`, so the gate silently keeps its old behaviour — and the existing unit
   fixtures would not catch it, because they set no `authCredentialId` either (finding N5). The
   check must be `=== null` against a selected field, and the fixtures must carry the field. Without this, FR4 is a claim no contract implements: an
   unbound session whose `passkey_verified_at` is still inside the 15-minute window keeps full
   access to all 45 gated routes, and C5's own acceptance criterion would pass because of a
   fixture's timestamp rather than because of the binding (finding M4). It returns `stale`, never
   `invalid` — `invalid` means 401 "no such session", which would sign the user out of a live
   session. The window comparison stays `> maxAgeMs`, so exactly-at-window remains fresh; stated
   because that is where the next off-by-one enters.
1. `canRecoverSessionWithPasskey(sessionToken, userId)` becomes: session exists AND
   `provider === "webauthn"` AND `authCredentialId !== null` AND that credential row still
   exists for this `userId`. The current `credentialCount > 0` test is replaced, not
   augmented — "the account has some credential" is the wrong question.
2. `/api/user/auth-provider` gains `canPasskeyReauth: boolean` computed from the same
   predicate for the requesting session. This requires a signature change the first version of
   this contract omitted (finding M6): `handleGET()` currently takes **no parameter**
   (`src/app/api/user/auth-provider/route.ts:13`) and reads nothing from the request, while
   `canRecoverSessionWithPasskey` needs the raw cookie token. It becomes
   `handleGET(req: NextRequest)` and obtains the token with the same `getSessionToken(req)`
   helper the other step-up paths use; `withRequestLog` already forwards the request as
   `args[0]` (`src/lib/http/with-request-log.ts:29`), so no wrapper change is needed. The answer
   must be computed from the **request's own** session, not from any session of the same user.
   Because `withRequestLog`'s return type is the wrapped handler's own type, the exported `GET`
   gains a required parameter, and all **8** zero-argument `GET()` calls in
   `src/app/api/user/auth-provider/route.test.ts` (lines 30, 36, 46, 56, 67, 77, 85, 91) stop
   compiling (TS2554). That file is a member of this contract, not incidental fallout
   (finding N2): the calls take a request, and the file gains the allow/deny pair it has never
   had — bound session with a live credential → `canPasskeyReauth: true`; absent token, unbound
   session, or non-webauthn provider → `false`. Red-proof: `tsc` reports TS2554 at all 8 sites
   before the edit and none after.
   `canPasskeySignIn` keeps its present meaning and its present consumer
   (`passkey-credentials-card.tsx:141-145`).
3. `canUsePasskeyRecovery()` reads `canPasskeyReauth` instead of `canPasskeySignIn`, and reads it
   as `data.canPasskeyReauth === true` with an explicit `true` fallback on probe failure — not
   the inherited `!== false` spelling, under which a missing field (older server, cached bundle)
   would read as "capable" by accident rather than by decision (finding M18). The
   fail-**open**-on-probe-error behaviour is retained deliberately: the probe only selects which
   dialog to show, and `C3`/`C4` are the actual gates — a wrong dialog choice now ends in
   `PASSKEY_REAUTH_UNAVAILABLE` and the sign-in-again path, not in a bypass. Recorded because a
   fail-open probe in front of a fail-closed gate is exactly the shape that reads like a defect
   at review time.

**Control class**: (0), (1) and (2) are fail-closed verification gates; (3) is a best-effort
tripwire whose only known bypass — probe failure → wrong dialog — is recovered by `C3`/`C4`.

**Invariants**

- I10 (app-enforced): (0), (1), (2) and (3) answer identically for the same session. Enforced by
  (1) and (2) calling one shared server function and (0) reading the same column; (3) consumes
  (2)'s output rather than re-deriving it.

**Consumer-flow walkthrough**

- Consumer 1 `src/app/[locale]/auth/signin/page.tsx:79-96` reads the boolean and picks
  `canUsePasskey` for `SignInReauthPanel`; with an unbound session it now renders the
  sign-in-again branch, which is what breaks the redirect loop the panel exists to avoid.
- Consumer 2 `useInlineReauth.triggerOnStaleError` (`use-inline-reauth.ts:82-90`) reads
  `canUsePasskeyRecovery()` and opens either dialog.

**Acceptance criteria** — each names its fixture, so a criterion cannot pass for a reason other
than the one it claims:

- Unbound WebAuthn session **with `passkey_verified_at = now()`** (fresh timestamp, `NULL`
  binding): gate → 403. Nulling the binding on an otherwise-fresh row is what flips it; this is
  the criterion the previous revision could not fail (M4).
- Allow side: bound session with `passkey_verified_at = now()` → gate returns `fresh`; and a
  `provider='nodemailer'` session's `createdAt` path is byte-identical to today.
- Unbound WebAuthn session: sign-in page → sign-in-again panel, not the ceremony;
  `/api/user/auth-provider` → `canPasskeyReauth: false`.
- Bound session whose credential row was deleted: all four members answer "no" without any
  application code having cleared the binding (I2 did it).
- `/api/user/auth-provider` answers for the requesting session: with two sessions of the same
  user (one bound, one not — constructible directly in the integration harness), each request
  gets its own answer.

### C6 — remove the dormant parallel adjudicator

Delete `requireRecentPasskeyVerification` and `markCurrentSessionPasskeyVerified` together
with `src/lib/auth/webauthn/recent-passkey-verification.test.ts`, keeping
`PASSKEY_VERIFICATION_WINDOW_MS` (imported by `recent-current-auth-method.ts:12`) — move the
constant to that module's own file only if the import direction becomes awkward, otherwise
leave the module in place holding just the constant.

**Rationale**: it decides the same predicate as MS1(a) with weaker semantics (no `provider`
check, and after this change no binding check), and it has zero production callers (E4). A
future route adopting it would silently reopen exactly the divergence this plan closes.
Removing it is cheaper than binding it, and leaving it is the option with no upside.

**Control class**: not a control — the removal of one. The *invariant* it serves is I11.

**Invariants**

- I11 (app-enforced): exactly one function in the tree turns `passkey_verified_at` into an
  allow/deny verdict. Check:
  `grep -rn "passkeyVerifiedAt" src --include='*.ts' | grep -v '\.test\.'` → writers from
  MS2(a)(b) and the single reader `evaluateStepUpFreshness`.

**Forbidden patterns**

- `pattern: requireRecentPasskeyVerification` — reason: I11.
- `pattern: markCurrentSessionPasskeyVerified` — reason: I11.

**Acceptance criteria**

- `npx next build` and `npx vitest run` pass with both symbols absent from the tree.

### C7 — audit every step-up denial this change introduces

**Two** new `AuditAction` values, not one — the first revision audited only the mismatch, which
left the escalated race's end state and the whole of `C3` producing denials indistinguishable
from a user closing a dialog (finding M14):

- `AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH` — emitted by `reauth/verify` when the bound lookup
  denies. Metadata `{ boundCredentialId, presentedCredentialId }`.
- `AUTH_PASSKEY_REAUTH_UNAVAILABLE` — emitted by **both** `C3` (options: non-webauthn provider,
  or no binding) and `C4` (step 3's nulled binding, and step 6's existence re-check finding the
  bound row gone), with a `reason: "provider" | "no_binding" | "credential_missing"`
  discriminator in metadata. The mismatch action carries
  `reason: "presented_credential" | "counter_mismatch" | "signature_invalid"` (findings N4, P1).
  These are metadata values, not new `AuditAction` members, so MS5's propagation set is unchanged.

`boundCredentialId` is read from our own row and is a `webauthn_credentials.credential_id`
(base64url) — a non-secret public identifier. **It is bounded by the same 512 characters, and for
the same reason** (finding Q4): "read from our own row" is not "bounded". The column is `@db.Text`
(`prisma/schema.prisma:1877`), the registration path caps only the whole JSON body, and the
WebAuthn wire format allows a credential id of up to 65,535 raw bytes — self-registerable by
anyone against their own account, since `fmt: "none"` attestation has no signature to forge. So a
single oversized *registered* id can trip `truncateMetadata` on its own, erasing the whole
metadata object including the other field — exactly the M13 failure mode through the sibling field
the M13 fix left unguarded. Over the bound, record
`boundCredentialId: <first 512 chars>` plus `boundCredentialIdTruncated: true`; a value of exactly
512 is kept whole. Both fields' checks run at audit-write time, not only at registration, because
credentials registered before any registration-time cap must also be covered.

`presentedCredentialId` is **not** from our own row: on a denial no
row matched, so it can only come from the request body (`response.id`), which is bounded only by
`WEBAUTHN_RESPONSE_MAX = 10_000` over the whole `credentialResponse` string
(`src/lib/validations/common.ts:62`) and is charset-unvalidated. It is therefore validated
against the base64url charset **and a bound of 512 characters** before it reaches metadata, and on
rejection recorded as `presentedCredentialId: null` plus `presentedCredentialIdRejected: true` —
"not recorded" must not be spelled like "absent". The number is stated because the contract
previously said only "a length bound" (finding P2), and the nearest existing constant
(`WEBAUTHN_RESPONSE_MAX = 10_000`) bounds the whole response string, not this field — borrowing it
would not close the gap. 512 sits far above any real credential id (the ones on `mrx33` are tens of
characters) and far below the 10,240-byte metadata ceiling even with both ids and a `reason`
present. A value of exactly 512 is accepted; 513 is rejected. Without that, a ~5 KB crafted `id` (JSON-escaping of
quote/control characters roughly doubles the serialized length) pushes the object past
`METADATA_MAX_BYTES = 10_240`, and `truncateMetadata` replaces the **entire** metadata object with
`{ _truncated: true, _originalSize }` (`src/lib/audit/audit.ts:64-71`) — letting the attacker
erase the evidence of their own attempt, including `boundCredentialId` (finding M13). State which
side an id of exactly the maximum length falls on.

Propagation set is MS5, applied to both values — and the group test is strengthened to assert
scope-correct placement, because the cited gate as it stands would stay green with a personal
action filed under `_TEAM` (finding M7).

**Control class**: detection/audit only. No denial depends on it. An audit-emit failure is routed
to a warning that names the path rather than to silence.

**Invariants**

- I12 (app-enforced, gate-checked): every `AUDIT_ACTION` value appears in `AUDIT_ACTION_VALUES`
  and in one scope group — enforced by `src/__tests__/audit-action-group-coverage.test.ts`, which
  today checks only the *union* of `_PERSONAL ∪ _TEAM ∪ _TENANT` — and in both locale
  `AuditLog.json` files, enforced by `src/__tests__/audit-i18n-coverage.test.ts` and
  `src/__tests__/i18n/audit-log-keys.test.ts`. Both new values are personal-scope, so this
  contract also adds a scope-correct assertion for them.

**Acceptance criteria**

- Mismatch attempt → exactly one `AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH` row; the personal
  audit-log UI renders a label in both locales.
- Each of the three unavailable reasons → exactly one `AUTH_PASSKEY_REAUTH_UNAVAILABLE` row
  carrying its own `reason`.
- Allow side: a successful reauth → exactly one `AUTH_PASSKEY_REAUTH` row and **zero** denial
  rows (assert the count).
- A `presentedCredentialId` of 5 KB of quote characters → the row still carries
  `boundCredentialId`, and `presentedCredentialIdRejected: true`.
- A **bound** credential whose `credential_id` is 600 characters, driven through a mismatch denial
  → the row carries `boundCredentialId` as its first 512 characters plus
  `boundCredentialIdTruncated: true`, and the row survives (`truncateMetadata` did not fire).
  A bound id of exactly 512 characters is kept whole with **no** marker. Red-proof: remove the
  truncation and this assertion reddens — either the marker is absent or the whole metadata object
  has collapsed to `{ _truncated: true, _originalSize }`. Without this criterion the guard that
  actually closes the M13 evidence-erasure path ships unproven, while its sibling field's identical
  guard is tested (finding R5-1, raised by the functionality and testing lanes independently).
- `npx vitest run src/__tests__/audit-action-group-coverage.test.ts src/__tests__/audit-i18n-coverage.test.ts src/__tests__/i18n/audit-log-keys.test.ts`
  passes — all three, since no one of them covers the whole of I12.

## Testing strategy

Every new guard is proven able to fail before it is trusted (RT7): write the assertion, run
it against the unfixed code, see it red, then fix.

**The binding decision's own test — the one the first revision omitted (finding M3).** The
decision lives in one place: the `where` of the bound lookup inside
`verifyAssertionForCredential`. Route tests cannot reach it — `reauth/verify/route.test.ts:43-46`
mocks `@/lib/auth/webauthn/webauthn-server` wholesale — and the integration layer cannot produce a
validly-signed assertion (VE1). The one test that reaches the real verifier with only crypto and
Prisma stubbed is `src/lib/auth/webauthn/verify-authentication-assertion.test.ts`; it is a member
of MS4 and its 12 call sites move to the new named functions. There:

- Make `makeTxStub`'s `findFirst` **argument-aware** (return the stored row only when `where.id`
  is absent or equals the row's id — what Postgres does). A stub that ignores the filter makes any
  assertion about scoping vacuous (RT1).
- DENY: `verifyAssertionForCredential` with a different row id, same `credentialId` → `ok === false`,
  404 `NOT_FOUND`.
- ALLOW: `verifyAssertionForCredential` with the matching row id → `ok === true`. Without this the
  control is unverified in the direction that gets it deleted (RT10/RT5).
- ALLOW: `verifyAssertionAnyCredential` still accepts any credential of the user.
- Red-proof, one mutation per clause (RT7): (i) drop the `id` from the bound `where` → the DENY
  case reddens; (ii) rewrite it as `id: credentialRowId ?? undefined` → the DENY case reddens (if
  it stays green the test is asserting status only, and is not evidence — M2); (iii) point
  `reauth/verify` at `verifyAssertionAnyCredential` → the route-level mismatch test reddens.

**Unit (`vitest`, mocked Prisma/Redis)**

- `reauth/options`: length-1 `allowCredentials` equal to the binding; non-webauthn provider →
  403 `SESSION_STEP_UP_REQUIRED`; null binding → 403 `PASSKEY_REAUTH_UNAVAILABLE`; and for
  both denials, **no Redis `set`** (RT8 — assert the absence of the side effect, not only the
  status).
- `reauth/verify`: mismatch → 403 `PASSKEY_REAUTH_CREDENTIAL_MISMATCH` **and** `session.update`
  never called (RT8); binding nulled before verify → 403 `PASSKEY_REAUTH_UNAVAILABLE` and the
  verifier **not called**; missing session row → 401; match → 200 and `session.update` called
  once. Note what this layer can and cannot see: `redis.getdel` lives *inside* the verifier
  (`webauthn-server.ts:459`), which this test file mocks wholesale, so "the challenge was not
  consumed" is **not** an assertion distinct from "the verifier was not called" here — claiming
  both would be one fact under two names (finding N7). I9b's real observable is Redis key
  survival, and it is asserted in the integration list below.
- **Mock scaffolding both route tests need first (finding N6)**: neither route reads the session
  today, so neither test file's `@/lib/prisma` mock has the method the new step 1 calls —
  `reauth/verify/route.test.ts:58-66` provides only `$transaction` + `session.update`, and
  `reauth/options/route.test.ts:44-48` only `webAuthnCredential.findMany`. Add
  `session.findUnique` (and for options, the session-then-credential pair), and update the
  existing ALLOW-path tests to return `{ provider: "webauthn", authCredentialId: <bound> }` so
  they still reach the verifier they exist to exercise. **`reauth/verify/route.test.ts` also needs
  a `webAuthnCredential.findFirst` mock** with the literal `{ id: credentialRowId, userId }` where
  shape: that is the existence re-check of `C4` step 6, a second Prisma call the mock has no entry
  for, and without it the row-gone / row-present split throws a `TypeError` instead of denying —
  so two of the six denial states cannot be constructed at all (finding Q3).
- `recent-current-auth-method.test.ts` — a member of `C5`, not incidental fallout (finding N5):
  the three existing webauthn-branch fixtures (`:60-65`, `:72-77`, `:82-87`) set no
  `authCredentialId`, so after member 0 lands they would keep passing through the old
  timestamp-only logic on a row shape (`authCredentialId: undefined`) Postgres cannot produce —
  a vacuous pass over the new gate (RT1). Give all three a concrete bound id, add a fourth case
  (fresh `passkeyVerifiedAt`, `authCredentialId: null` → `stale`), and red-prove by reverting the
  branch. The five `canRecoverSessionWithPasskey` cases (`:207-262`) drive
  `webAuthnCredential.count`, which member 1 replaces with a row-existence check by id — rewrite
  the mock to the new query shape and add the "bound, but the credential row was deleted" case.
- `webauthn-authorize`: success result carries `credentialRowId`; the `passkey/verify` route
  test's mock returns it (RT1 — a mock that omits a required field encodes a shape production
  never produces).
- MS4's two exact-shape assertions (`authenticate/verify/route.test.ts:148-153`,
  `credentials/[id]/prf/route.test.ts:230-237`) move to the new callee and argument list (R19).
- `use-inline-reauth`: `PASSKEY_REAUTH_UNAVAILABLE` and `PASSKEY_REAUTH_CREDENTIAL_MISMATCH` each
  switch to the sign-in-again dialog; `AUTHENTICATION_CANCELLED` still shows `reauthCancelled`;
  and a generic transport failure still shows `reauthFailed` — collapse any of the three and the
  new codes buy nothing (RT10).
- `operator-token-card`: the same mapping, tested separately (finding M8). It calls
  `reauthenticateWithPasskey()` directly (`operator-token-card.tsx:187-199`) and reaches the
  branch from **inside** the already-open ceremony dialog, so it has no automatic escape; model
  the test on its existing "opens RecentSessionRequiredDialog when …" case.

**Integration (real DB, `src/__tests__/db-integration/`)**

Extend `require-recent-session.integration.test.ts` or add a sibling, following its existing
seeding pattern — raw `INSERT INTO sessions` with `hashSessionToken(token)` for the digest
column (`require-recent-session.integration.test.ts:61-81`), since the stored value is a
digest and a seeder that inserts the raw token tests nothing:

- FK: `DELETE` of the bound credential nulls the binding and leaves the session row (I2).
- FK: inserting a session with a random `auth_credential_id` is rejected (I1).
- Gate end-to-end at the server-decision layer: session bound to A, mismatch path denies and
  `passkey_verified_at` is unchanged (I8).
- **Ordering test for I9 (finding M10)**: seed a session bound to A with a challenge already in
  Redis (the state `reauth/options` leaves), delete A via raw SQL, then run the verify path.
  Expected: deny, `passkey_verified_at` unchanged, and no fallback to any-credential. Red-prove by
  mutating the route to read the binding **once before** the transaction and pass that stale value
  in — the test must redden for exactly that reason.
- Gate binding check (C5 member 0): `passkey_verified_at = now()` with `NULL` binding → 403;
  same row with the binding restored → allowed (M4).
- **I9b, against real Redis (finding N7)**: with a challenge stored and the session's binding
  already `NULL` at read time, the step-3 denial must leave `redis.get(challengeKey)` returning
  the stored challenge. Red-prove by moving the consumption ahead of the binding check and
  confirming this assertion — and only this one — reddens. This is a different scenario from the
  ordering test above (binding already null vs. deleted mid-transaction); both are needed.
- Denial discrimination, **split by tier because the tiers can reach different states** (findings
  N4, P3). The integration tier can seed and reach only the states denied *before* the signature
  check — bound row present + wrong credential (`credential_not_found`, row present) and bound row
  deleted after the binding read (`credential_not_found`, row gone) — because reaching the
  counter-CAS at `webauthn-server.ts:530` requires `verifyAuthenticationResponse` to have already
  returned `verified: true`, which VE1 says this tier cannot produce. Two options for the
  `counter_mismatch` and `signature_invalid` states, and the plan takes the second: (a) mock
  `@simplewebauthn/server` in the integration test as
  `verify-authentication-assertion.test.ts:53-59` already does, or (b) **assert those two at the
  route tier**, where the verifier module is already mocked and what is under test is the route's
  classification of a `reason`, not the crypto. (b) is the honest assignment: the classification is
  the new logic, the crypto is not. State this split explicitly so an implementer who seeds a
  counter-mismatch fixture at the integration tier and gets a generic verification failure does not
  "fix" it by loosening the assertion to whatever error actually occurred — which would delete
  exactly the coverage this bullet adds.
- Route tier, over the structured `reason` union: five denial `reason`s → five distinct
  `(status, error code, audit action, audit reason)` tuples, plus the four pass-through reasons →
  unchanged response and zero audit rows. Red-prove per row: force each `reason` from the mocked
  verifier and confirm only that row's assertion moves.
- Legacy row (`auth_credential_id IS NULL`, `provider='webauthn'`): gate 403,
  `canRecoverSessionWithPasskey` false.
- Two sessions of the same user, one bound and one not → `/api/user/auth-provider` answers
  per-request (C5 member 2).
- Run per VE3 with both compose workers stopped.

**E2E (Playwright) — inside scope, NOT deferred with `SC5` (finding M11)**

Which dialog opens needs no signed assertion, only a seeded session row, and the harness already
seeds session state directly: `e2e/tests/step-up-stale-window.spec.ts` uses `makeSessionStale` /
`refreshSessionRecency` (`e2e/helpers/db.ts`) and asserts on `role=alertdialog`. Add a helper that
seeds a `provider='webauthn'` session with a chosen `auth_credential_id` plus a minimal
`webauthn_credentials` row, and one test asserting: (a) a session whose bound credential was
deleted renders the sign-in-again path on a gated action, never a ceremony dialog; (b) a session
with a live binding renders the ceremony dialog — the positive branch
`step-up-stale-window.spec.ts` currently lacks. This is the only full-stack proof of the reported
regression, and it costs two assertions, not a virtual-authenticator harness.

**Fixture isolation is the hard part here, and the first revision got it wrong (finding N1).**
There is no `deleteTestData` in `e2e/helpers/db.ts` — that name belongs to the integration
harness (`src/__tests__/db-integration/helpers.ts`). The E2E cleanup is `cleanup()`
(`e2e/helpers/db.ts:403`), called exactly twice per run (`e2e/global-setup.ts:191`,
`e2e/global-teardown.ts:17`), never per spec. And `TEST_USERS.vaultReady` — the user the
`makeSessionStale` pattern uses — is shared by 25 spec files, with `fullyParallel: false` /
`workers: 1` (`e2e/playwright.config.ts:18,21`), so leaving it in a `provider='webauthn'`, bound
state is a **deterministic** contamination of every later spec in the run. The spec most damaged
would be `step-up-stale-window.spec.ts` itself, whose assertion is deliberately "robust to which
dialog opens" precisely because its user has no passkey today — it would render the ceremony
dialog and still pass, which is RT11's Critical shape: contamination that makes a security
control's test pass for the wrong reason. Therefore: **use a dedicated `TEST_USERS` entry**,
matching the file's own convention for state-incompatible tests (`lockout`, `reset`,
`passphraseChange`, `keyRotation`) — not `vaultReady`. If a future change does reuse a shared
user, it must restore `provider` and `auth_credential_id` in `afterAll`, the way
`refreshSessionRecency` restores `created_at`. Red-proof for the isolation itself: run the new
spec immediately before `step-up-stale-window.spec.ts` in one invocation without the dedicated
user and confirm the sibling's dialog changes family — `role=alertdialog` alone will not show it.

**Full-suite gates (mandatory, per CLAUDE.md)**: `npx vitest run` and `npx next build`, plus
`scripts/pre-pr.sh` before the PR.

## Considerations & constraints

- The one-time sign-in cost (NFR3) is real for any deployment with live WebAuthn sessions,
  even though both known deployments have zero at plan time. It is the intended
  fail-closed direction: an unbound session cannot prove which key made it.
- Backup-authenticator UX changes by design: a second key can no longer step up a session the
  first key established. The correct path is a fresh sign-in with the backup key, which the
  reauth panel already offers. This is the behaviour the fix exists to produce, and it is
  worth stating plainly because it will read as a regression to anyone who does not know why.
  It is also why `C4` gives the mismatch its own error code rather than reusing the verifier's
  generic 404: the population most likely to hit this denial is legitimate users presenting a
  backup key, and a generic "reauthentication failed" would leave them retrying a ceremony that
  cannot succeed with the only working recovery never offered (finding M15).
- `PASSKEY_VERIFICATION_WINDOW_MS` and `STEP_UP_WINDOW_MS` are both 15 min and unchanged.

**Scope contract**

- `SC1` — raising registration to `residentKey: "required"`
  (`src/lib/auth/webauthn/webauthn-server.ts:129`). Anti-Deferral: cost of doing it here =
  it invalidates the registration path's contract for keys whose resident slots are full and
  needs its own migration story for the 3 `discoverable IS NULL` credentials on `mrx33`;
  cost of deferring = a security key can still be registered in a state where the
  discoverable sign-in button cannot use it. Owner: separate PR, "passkey registration
  discoverability" .
- `SC2` — sign-in-page guidance when the discoverable ceremony ends in `NotAllowedError`
  (route the user to the email-based security-key form instead of an OS-dialog dead end).
  Anti-Deferral: cost of doing it here = unrelated client surface, its own i18n strings;
  cost of deferring = the misleading "that YubiKey can't sign you in" experience persists.
  Owner: same separate PR as `SC1`.
- `SC3` — the browser extension's own-app WebAuthn bypass is fail-open in five ways
  (raw `chrome.storage.local.get("serverUrl")` with no default at
  `extension/src/content/webauthn-bridge.ts:14`; strict origin equality; `document_start`
  interceptor vs `document_idle` bridge; throw/failure paths; and no own-app exclusion in
  `extension/src/background/passkey-provider.ts`). Anti-Deferral: cost of doing it here =
  a second, independent defect class in a different runtime with its own test harness;
  cost of deferring = with a mismatched or unsaved `serverUrl`, the extension can intercept
  passwd-sso's own ceremonies. **Not the cause of the reported symptom** (E2 shows a real
  hardware credential, and no extension-created credential row exists on either
  deployment). Owner: separate PR.
- `SC4` — excluding non-discoverable credentials from authentication entirely. Anti-Deferral:
  cost of doing it here = it needs a trustworthy predicate, and the only server-verified one
  available would be newly recorded ("this credential completed a discoverable ceremony at
  least once"); `discoverable` is a browser self-report, `NULL` for 3 of 4 security-key
  registrations on `mrx33`. Cost of deferring = a credential usable only through the
  email-based form remains a full authentication factor. Owner: future decision, blocked on
  `SC1`'s outcome.
- `SC6` — a registration-time length cap on `webauthn_credentials.credential_id`
  (`src/app/api/webauthn/register/verify/route.ts`, whose `response: z.record(z.string(), z.unknown())`
  caps no individual field). Anti-Deferral: worst case = a user registers a multi-KB credential id
  and inflates every row that stores or logs it; likelihood = low (requires a deliberate custom
  authenticator, and the account holder gains nothing they cannot already do to their own audit
  trail); cost to fix = one Zod refinement plus a decision about pre-existing rows, i.e. its own
  migration question about data already stored. `C7`'s audit-write-time bound (finding Q4) closes
  the consequence this plan is responsible for regardless of whether the cap lands. Owner: future
  issue, tracked as `TODO(bind-stepup-to-session-credential): SC6 registration-time credential_id cap`.
- `SC5` — Playwright virtual-authenticator harness, i.e. driving a real signed ceremony in E2E
  (VE1). Explicitly **excludes** the dialog-selection E2E test, which needs no authenticator and
  is in scope above. Owner: separate infrastructure PR.

## User operation scenarios

Manual verification on `mrx33` (VE2), using the platform passkey `dE3…` and the two security
keys `-a7H…` (discoverable) and `z2zT…` (`discoverable IS NULL`):

1. **The reported case, now denied.** Sign in with the platform passkey. Press *connect* in
   the extension → sign-in page shows the reauth panel → present `z2zT`. Expected: `403
   PASSKEY_REAUTH_CREDENTIAL_MISMATCH` (not the verifier's generic 404 — finding N8), one
   `AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH` audit row with `reason: "presented_credential"` and a
   populated `boundCredentialId`, the sign-in-again dialog rather than a retry prompt, and
   `passkey_verified_at` unchanged. Before the fix this succeeded (E2).
2. **The same flow with the establishing key.** Same session, present the platform passkey.
   Expected: 200, `passkey_verified_at` advances, bridge-code issued.
3. **`z2zT` as the establishing credential.** Sign in via the *security key* (email) form with
   `z2zT`, then run a step-up-gated operation and present `z2zT`. Expected: success — the
   binding, not discoverability, is what the gate tests.
4. **Deleted binding.** With a session established by `-a7H`, delete `-a7H` in settings (that
   deletion is itself step-up-gated, so do it in the same fresh window), then trigger a gated
   operation. Expected: sign-in-again dialog, never a ceremony dialog.
5. **Legacy session.** Insert a `provider='webauthn'`, `auth_credential_id IS NULL` row (or
   use a session created before the migration) and open the sign-in page with an API
   callback. Expected: sign-in-again panel; no redirect loop.
6. **Non-WebAuthn session.** Sign in via magic link (mailpit), then trigger a gated
   operation. Expected: recent-session dialog; the reauth ceremony is refused with
   `SESSION_STEP_UP_REQUIRED` and writes no challenge.
7. **The ordering the first revision missed (finding M1).** Sign in with the platform passkey,
   trigger a gated operation so the reauth prompt opens (challenge minted), then — in a second
   tab, inside the same fresh window — delete that platform credential in settings. Return to
   the first tab and complete the outstanding ceremony with `z2zT`. Expected: `403
   PASSKEY_REAUTH_UNAVAILABLE`, the sign-in-again path, one
   `AUTH_PASSKEY_REAUTH_UNAVAILABLE` audit row with `reason: "no_binding"`, and
   `passkey_verified_at` unchanged. This is the scenario that separates the fixed design from
   the first revision, which would have accepted `z2zT` here.

## Go/No-Go Gate

| ID  | Subject                                                        | Status |
|-----|----------------------------------------------------------------|--------|
| C1  | `sessions.auth_credential_id` column + FK ON DELETE SET NULL   | pending |
| C2  | record the establishing credential at passkey sign-in          | pending |
| C3  | `reauth/options` offers exactly the bound credential           | pending |
| C4  | `reauth/verify` enforces the binding inside the shared verifier | pending |
| C5  | one predicate for "can recover via passkey" (3 members)        | pending |
| C6  | remove the dormant parallel adjudicator                        | pending |
| C7  | audit the mismatch denial                                      | pending |
