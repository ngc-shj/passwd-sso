# Plan Review: bind-stepup-to-session-credential

Date: 2026-08-11
Review round: 1

## Changes from Previous Round

Initial review. Local LLM pre-screening (`pre-review.sh plan`) returned "No issues found";
`merge-findings` reported no `[VAGUE]` / `[NO-EVIDENCE]` / `[UNTESTED-CLAIM]` quality warnings.
The Security expert flagged its Critical with `escalate: true`, so the Security review was
re-run at the Opus tier per the skill's escalation mechanism; both tiers' findings are
preserved below and the higher tier takes precedence where they overlap.

## Merged Findings (deduplicated, convergence-stamped)

Severity floor rule applied: a finding independently reported by two or more perspectives is
at least Major, and the merged severity is the maximum of the reported ones — never the average.

| Merged ID | Severity | Subject | Reported by | Convergence |
|-----------|----------|---------|-------------|-------------|
| M1 | **Critical** | `expectedCredentialRowId: null` means "any credential", and `reauth/verify` fills that slot from a column the FK nulls on credential deletion → the E1 bypass is reachable for the whole 5-minute challenge TTL. The plan's guard is a literal-`null` grep, which cannot see a variable's runtime value (R47/R55). | func F1, sec F-01, sec-opus SO-01 | functionality+security (Opus verdict: CONFIRMED as Critical; Sonnet's remedy necessary but not sufficient) |
| M2 | **Critical** | C4's `id: expectedCredentialRowId` scoping cannot be written literally against a `string \| null`; the compilable fail-open form `id: x ?? undefined` makes Prisma DROP the filter, reverting to any-credential — and it passes types, build, and the plan's own forbidden-pattern grep. `strictUndefinedChecks` is not enabled in this repo. | sec-opus SO-02 | single-perspective (Opus tier) |
| M3 | **Critical** | The binding decision has no ALLOW-side test at any layer: route tests mock the verifier wholesale, the integration list is deny-only, and the one file that reaches the real primitive (`verify-authentication-assertion.test.ts`, 12 call sites that will fail to compile) is absent from the plan because MS4's derivation filters `.test.` files. | test F-01 | single-perspective (RT5/RT7) |
| M4 | Major | FR4 ("a session with no live binding cannot step up at all") is implemented by no contract: C5 explicitly leaves `evaluateStepUpFreshness` untouched, so an unbound session with a fresh `passkey_verified_at` still passes all 45 gated routes, and C5's own acceptance criterion passes on fixture state rather than on the binding (R49/R50). | sec-opus SO-04 | single-perspective |
| M5 | Major | I9's rationale is wrong: `withBypassRls` runs at READ COMMITTED with no row lock taken by the session read; what actually serialises the deletion is the id-scoped lookup plus the counter-CAS row lock. The conclusion holds, the stated reason does not — and the reason is what licenses the next edit (R29). | func F2, sec-opus SO-01(5) | functionality+security |
| M6 | Major | `/api/user/auth-provider`'s `handleGET()` takes no request parameter, so C5(2) has no path to the raw session token `canRecoverSessionWithPasskey` requires. | func F3, sec F-02, sec-opus SO-10(a) | functionality+security (floor: Major) |
| M7 | Major | I12/MS5/C7 cite `audit-action-group-coverage.test.ts` as enforcing `_PERSONAL` placement and both locale files; it checks neither (union of three scope groups, no locale read). The locale half is enforced by `audit-i18n-coverage.test.ts` and `i18n/audit-log-keys.test.ts`. | func F4, test F-06 | functionality+testing (floor: Major) |
| M8 | Major | `operator-token-card.tsx` needs the same `PASSKEY_REAUTH_UNAVAILABLE` mapping (the plan names it as Consumer 4) but has no test assigned, and it reaches the branch from INSIDE the open ceremony dialog, so there is no escape path at all. | test F-03, func F5 | testing+functionality (floor: Major) |
| M9 | Major | Two existing tests assert the exact old positional `userAgent` argument that C4 restructures; MS4's derivation excluded them. | test F-02 | single-perspective |
| M10 | Major | I9's TOCTOU claim has no test; the integration FK tests operate on idle state, not on delete-during-in-flight-verify. | test F-04 | single-perspective (RT7) |
| M11 | Major | VE1's deferral is drawn too wide: which dialog opens needs no signed assertion, and the existing `makeSessionStale` / `e2e/helpers/db.ts` seeding pattern can pin it in CI today. Folding it into SC5 prices a two-assertion job as an infrastructure PR. | test F-05 | single-perspective (RT10) |
| M12 | Major | FR5 is enforced only at ceremony entry; the reauth challenge key is user-scoped (`…:${userId}:${challengeId}`) while the write targets the caller's session. Today only two undocumented couplings prevent cross-session redemption. | sec-opus SO-03 | single-perspective (R48) |
| M13 | Major | C7 puts an unvalidated request-supplied `response.id` into audit metadata as if it were a stored `credential_id`; a ~5 KB crafted value trips `truncateMetadata`, which replaces the WHOLE metadata object, erasing the row's own evidence. | sec-opus SO-05 | single-perspective (RS3) |
| M14 | Major | The denials that matter emit no audit at all — C3's two denials, and (after M1's remedy) the verify-side unbound denial, including the end state of the escalated race. | sec-opus SO-06 | single-perspective |
| M15 | Major | The mismatch denial reaches the user as generic `reauthFailed`, stranding exactly the backup-key population the plan predicts, with the only working recovery never offered. | sec-opus SO-07 (Adjacent) | single-perspective (R37) |
| M16 | Minor | C3's control class overstates `allowCredentials` narrowing as a gate: the challenge is returned in the response body, so credential selection is client-side and C4 is the sole control. | sec-opus SO-08 | single-perspective (R49) |
| M17 | Minor | NFR2's quantifier ("every call site that verifies an assertion") is wider than MS4's derivation; `authorizeWebAuthn`'s inline verifier is an undeclared non-member. | sec-opus SO-09 | single-perspective (R42) |
| M18 | Minor | `canUsePasskeyRecovery`'s `!== false` spelling would carry the old field's fail-open default onto the new `canPasskeyReauth` field by inheritance rather than by decision. | sec-opus SO-10(b) | single-perspective |

## Adjacent Findings

- sec F-02 / sec-opus SO-10(a) → routed to Functionality (merged into M6).
- func F5 → routed to Testing (merged into M8).
- sec-opus SO-07 → routed to Functionality/UX (merged into M15).
- test F-05 → routed to Functionality (verification-scope decision; merged into M11).

## Quality Warnings

None. `merge-findings` reported no `[VAGUE]`, `[NO-EVIDENCE]`, or `[UNTESTED-CLAIM]` flags.

---

## Functionality Findings

## Findings

### F1 — [Critical, design] C4's `expectedCredentialRowId` pass-through reopens the exact vulnerability the plan exists to close, via the deliberately-overloaded `null` sentinel

**File**: `docs/archive/review/bind-stepup-to-session-credential-plan.md:389-391` (contract text); grounding in current code: `src/app/api/auth/passkey/reauth/verify/route.ts:70-92`, `src/app/api/auth/passkey/reauth/options/route.ts:41-92`, `src/lib/auth/webauthn/webauthn-server.ts:447-490`.

**Problem**: C4 defines `expectedCredentialRowId: string | null`, where `null` means "any credential of this user" (correct for the two non-freshness call sites, MS4). For the freshness call site, the contract says: *"`reauth/verify` reads the session's binding in the same transaction it later updates, passes it as `expectedCredentialRowId`"* — i.e. whatever value the session row currently holds is passed straight through, with no explicit branch for "the read came back `null`." Per MS6/C1, the only legal transition for an existing session's `auth_credential_id` is `A → NULL` (deletion cascade); it can never become a *different* non-null value. Sequence: (1) session bound to A; user calls `reauth/options`, which is still bound, so it succeeds and mints a one-shot Redis challenge under `webauthn:challenge:reauth:${userId}:${challengeId}` (5-minute TTL, `WEBAUTHN_CHALLENGE_TTL_SECONDS`) — this challenge value is returned to the client in plaintext JSON; (2) before the client redeems it, credential A is deleted from a *different*, currently-fresh session belonging to the same user (deletion is step-up-gated per-session, not per-credential, so a second fresh session can delete it), which nulls session A's `authCredentialId` via the FK cascade; (3) the client (or any script with access to the browser's WebAuthn API — not the app's own JS, which is exactly why server-side scoping exists) calls `navigator.credentials.get()` directly with that intercepted challenge and a *different* credential C the same user legitimately owns, gets a valid signature, and POSTs it to `reauth/verify`. Per the literal contract, `expectedCredentialRowId` is now `null` (freshly read), so `verifyAuthenticationAssertion` runs in "any credential" mode, the lookup for C succeeds, the assertion verifies, and `session.update({ passkeyVerifiedAt })` fires — refreshing session A's freshness using credential C, exactly the E1 bug ("satisfiable by any registered credential of the user, not the one that established the session") this plan's Objective states it is closing.

**Failure scenario**: A user with two passkeys (A bound to session-1, C registered separately) opens `reauth/options` on session-1 (still bound to A, challenge minted), then in a second tab/device deletes A (from a session freshly authenticated via C) — e.g. simply "I lost key A, let me deregister it" — then returns to session-1 and completes the outstanding ceremony with C. Session-1 becomes fresh via C even though FR4 says "a session with no live binding ... cannot step up at all." No adversary is required; this is reachable by an ordinary user's own credential-management workflow.

**Impact**: Silently defeats FR3/FR4 and the plan's stated Objective under a realistic, non-adversarial ordering. None of the C4 acceptance criteria, the Testing-strategy integration tests, or the User Operation Scenarios (Scenario 4 only covers deletion *before* `reauth/options`, not after) exercise "own binding reads `null` at verify time" — the gap has no test that would catch it either.

**Recommended action**: In `reauth/verify`, read the session's `authCredentialId` and branch *before* calling `verifyAuthenticationAssertion`: if `null`, return 403 `PASSKEY_REAUTH_UNAVAILABLE` immediately (mirroring C3's own gate) without invoking the assertion verifier at all; only when non-null, pass it through as today. This keeps the allow side intact — "session bound to A, assertion from A → 200" is unaffected — while closing the deny side. Add the acceptance criterion explicitly: *"Session bound to A, challenge minted, A deleted before verify, assertion from a different owned credential C → 403, `passkey_verified_at` unchanged"* — and red-prove it by running the race against the naive pass-through first (must show 200) before applying the fix (must show 403). Do not weaken this by relaxing the credential lookup's own `id`-scoping (that path stays correct for the "assertion from B while bound to A" case) — the fix is an additional, earlier branch on the caller's own re-read, not a change to `verifyAuthenticationAssertion`'s null semantics (those must stay correct for MS4's other two call sites).

### F2 — [Major, design] I9's stated rationale ("one transaction, so nothing can land between them") does not match the confirmed isolation level

**File**: `docs/archive/review/bind-stepup-to-session-credential-plan.md:399-403`; grounding: `src/lib/tenant-rls.ts:54-71` (`withBypassRls` wraps the callback in `prisma.$transaction(...)` with no `isolationLevel` option, i.e. Postgres default READ COMMITTED — confirmed by execution, not inferred), `src/app/api/auth/passkey/reauth/verify/route.ts:70-92`, `src/lib/auth/webauthn/webauthn-server.ts:530-537` (counter-CAS `UPDATE ... WHERE id = ... AND counter = ...`).

**Problem**: I9 states: *"the binding read and the `passkeyVerifiedAt` write happen in one transaction, so a concurrent credential deletion cannot land between them and leave a session refreshed by a credential that no longer exists."* Under READ COMMITTED (the confirmed, unmodified default here), each statement inside an interactive transaction takes a fresh snapshot — "one transaction" alone does not give the read-then-write pair snapshot isolation against a concurrent committing DELETE. The invariant does hold in practice, but for a *different* reason than stated: `verifyAuthenticationAssertion`'s credential lookup (scoped by `id` when non-null) and its raw counter-CAS `UPDATE` take a row lock on the specific `webauthn_credentials` row, forcing serialization against a concurrent DELETE of that same row (either the DELETE commits first and the CAS/lookup then finds nothing → deny, or the CAS commits first and the DELETE proceeds after, both fail-safe). The plan's own conclusion is true; its cited mechanism is not what produces the guarantee.

**Impact**: A reason is what licenses the next edit (R29). A future change that trusts "same transaction ⇒ safe against interleaving" — e.g. moving the credential lookup to a separate non-transactional pre-check, or replacing the counter-CAS with an unconditional update — would appear to preserve I9 (still "in one transaction") while actually removing the row-lock serialization that is the real protection, reopening the race silently.

**Recommended action**: Restate I9's rationale to name the actual mechanism (id-scoped lookup + counter-CAS row lock, not transaction boundary alone), and note the confirmed isolation level (READ COMMITTED, no override) explicitly so a future reader does not assume REPEATABLE READ/SERIALIZABLE guarantees exist. Preserve the current structure (lookup and CAS must stay inside the same transaction as the session-binding read and the `passkeyVerifiedAt` write) — the fix here is documentation accuracy, not a code change; verify by executing two concurrent connections around the counter-CAS to confirm the serialization empirically rather than asserting it from the transaction wrapper alone.

### F3 — [Major, design] C5(2)'s `/api/user/auth-provider` change requires a route-handler signature change the plan does not mention

**File**: `docs/archive/review/bind-stepup-to-session-credential-plan.md:427-429`; grounding: `src/app/api/user/auth-provider/route.ts:13` (`async function handleGET() {` — zero parameters), `src/lib/http/with-request-log.ts:29` (confirms the framework *does* pass `NextRequest` as `args[0]`; the handler simply never declares it), `src/lib/auth/session/recent-current-auth-method.ts:83-105` (`canRecoverSessionWithPasskey(sessionToken, userId)` requires the raw cookie token, which it hashes itself).

**Problem**: C5(2) says the route "gains `canPasskeyReauth: boolean` computed from the same predicate for the requesting session" — i.e. via `canRecoverSessionWithPasskey(sessionToken, userId)`. That function needs the *raw session-cookie token*; `auth()` (used by this route today) does not expose it. The current `handleGET()` takes no request parameter at all, so there is currently no code path in this file that could obtain the token. Every other route this plan touches (`reauth/options`, `reauth/verify`) already declares `req: NextRequest` and already extracts the token via `getSessionToken`/`getSessionTokenDigest`; this route is the one outlier, and the plan's contract text does not flag the needed signature change.

**Impact**: Not a logic defect once implemented, but the contract as written cannot be implemented without an unstated change; an implementer following the plan literally will hit a missing-token wall at exactly the one call site this sub-contract is supposed to add.

**Recommended action**: Change `handleGET()` to `handleGET(req: NextRequest)`, extract the token via the existing `getSessionToken(req)` helper (matching the pattern already used elsewhere in this plan's touched routes), and pass it with `session.user.id` into `canRecoverSessionWithPasskey`. Pair the allow/deny sides: a present, bound session → `canPasskeyReauth: true`; an absent token, unbound session, or non-webauthn provider → `false` (matches `canRecoverSessionWithPasskey`'s existing fail-closed default) — add a unit test for both.

### F4 — [Major, design] I12's enforcement claim is stronger than what the cited test verifies

**File**: `docs/archive/review/bind-stepup-to-session-credential-plan.md:511-513`; grounding: `src/__tests__/audit-action-group-coverage.test.ts:9-18` (checks membership in the *union* of `AUDIT_ACTION_GROUPS_PERSONAL ∪ _TEAM ∪ _TENANT`, not specifically `_PERSONAL`), `src/__tests__/audit-i18n-coverage.test.ts` and `src/__tests__/i18n/audit-log-keys.test.ts` (these two — not the cited test — are what actually enforce the "both locale `AuditLog.json` files" requirement).

**Problem**: I12 states: *"every `AUDIT_ACTION` value appears in `AUDIT_ACTION_VALUES`, in one `AUDIT_ACTION_GROUPS_PERSONAL` group, and in both locale `AuditLog.json` files — enforced by `src/__tests__/audit-action-group-coverage.test.ts`."* That single test only asserts "in at least one of the three scope groups" — it would pass unchanged if `AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH` were registered in `AUDIT_ACTION_GROUPS_TEAM` or `_TENANT` instead of `_PERSONAL`. It does not touch the locale files at all; that half of the claim is true only because two *other*, uncited tests happen to cover it.

**Impact**: C7's acceptance criterion ("the mismatch attempt ... the personal audit-log UI renders a label for it") depends on `_PERSONAL` placement specifically. If C7 is implemented with the new action accidentally added to the wrong scope group, every gate the plan cites for this invariant stays green while the acceptance criterion silently fails — exactly the class of gap R12/R42 exist to catch.

**Recommended action**: Correct the citation to name all three tests. More importantly, strengthen `audit-action-group-coverage.test.ts` (or add a sibling) to check *scope-correct* placement — e.g. assert that `AUTH_PASSKEY_REAUTH_CREDENTIAL_MISMATCH` (and, ideally, a canonical scope-to-group mapping for all personal-only actions) lands in `_PERSONAL` specifically, not merely "some group." Red-prove by moving the new action to `_TEAM` only and confirming the strengthened test reds, then moving it back — while confirming the ~30 existing correctly-placed `_PERSONAL` actions still pass (pairs the deny direction with the existing allow baseline).

### F5 — [Minor, design, Adjacent] `operator-token-card.tsx`'s identical fail-strand bug is specified in C3 but has no corresponding unit test in the Testing Strategy

**File**: `docs/archive/review/bind-stepup-to-session-credential-plan.md:346-347` (Consumer 4) vs. `:526-538` (Unit test list); grounding: `src/components/settings/developer/operator-token-card.tsx:191-198` (has the same `result.error === "AUTHENTICATION_CANCELLED" ? ... : tAuth("reauthFailed")` pattern as `use-inline-reauth.ts:96-103`, and needs the identical `PASSKEY_REAUTH_UNAVAILABLE` branch per the plan's own Consumer 4 note).

**Problem/Impact**: This is squarely test-coverage scope (a separate Testing expert covers it), flagged here only because the Functionality-owned consumer-flow walkthrough explicitly names this component as needing the same code change, and the Testing section lists a unit test for `use-inline-reauth` but not for this second, independently-implemented consumer of the same fix.

**Recommended action**: Add a unit test for `operator-token-card.tsx`'s `handleReauthenticate` mirroring the `use-inline-reauth` one (PASSKEY_REAUTH_UNAVAILABLE → dialog switch, not `reauthFailed`).

## Recurring Issue Check

- R1 (Shared utility reimplementation): N/A — the pre-existing `webauthn-authorize.ts` vs `verifyAuthenticationAssertion` duplication is not introduced or touched by this plan.
- R2 (Constants hardcoded in multiple places): Checked — no issue.
- R3 (Incomplete pattern propagation): Checked — no issue (comprehensive member-set derivation; see F3 for a related but distinct implementation-detail gap).
- R4 (Event/notification dispatch gaps): N/A.
- R5 (Missing transaction wrapping): Checked — see F2 (transaction exists; rationale for what it guarantees is inaccurate).
- R6 (Cascade delete orphans): Checked — no issue (`ON DELETE SET NULL`, no external storage).
- R7 (E2E selector breakage): N/A.
- R8 (UI pattern inconsistency): N/A.
- R9 (Transaction boundary fire-and-forget): N/A.
- R10 (Circular module dependency): N/A.
- R11 (Display group ≠ subscription group): N/A.
- R12 (Enum/action group coverage gap): Finding F4.
- R13 (Re-entrant dispatch loop): N/A.
- R14 (DB role grant completeness): Checked — no issue (MS8 verified correct against `db-grants-manifest.json`).
- R15 (Hardcoded env-specific values in migrations): Checked — no issue.
- R16 (Dev/CI environment parity): N/A — addressed by VE1–VE3.
- R17 (Helper adoption coverage): N/A.
- R18 (Config allowlist/safelist sync): N/A.
- R19 (Test mock alignment): Checked — no issue (Consumer 2 of C2 verified: exactly the two files the plan names reference `WebAuthnAuthResult`/`authorizeWebAuthn`).
- R20 (Multi-statement preservation in mechanical edits): N/A.
- R21 (Subagent completion vs verification): N/A.
- R22 (Perspective inversion for established helpers): N/A.
- R23 (Mid-stroke input mutation in UI controls): N/A.
- R24 (Single migration mixing additive + strict): Checked — no issue (C1 explicit additive-only).
- R25 (Persist/hydrate symmetry): Checked — no issue (MS7 session-cache non-membership verified correct).
- R26 (Disabled-state UI without visible cue): N/A.
- R27 (Numeric range hardcoded in user strings): N/A.
- R28 (Grammatical inconsistency toggle labels): N/A.
- R29 (Citation/derived-claim/rationale accuracy): Findings F2, F4 (all other spot-checked citations — E1–E4, MS1–MS8, schema/audit.ts line numbers — verified exact).
- R30 (Markdown autolink footguns): N/A.
- R31 (Destructive ops without confirmation): N/A.
- R32 (New long-running runtime artifact): N/A.
- R33 (CI config drift across duplicates): N/A.
- R34 (Pre-existing bug deferred w/o justification): N/A — SC1–SC5 all carry Anti-Deferral cost-justifications.
- R35 (Production-deployed component w/o manual test plan): Checked — no issue (VE2 manual plan exists).
- R36 (Suppression substitute for fix): N/A.
- R37 (Internal jargon in user strings): N/A.
- R38 (Async/persisted state machine): Finding F1 is a fail-open-supersession instance (the superseded "any credential" guard resurfaces at the one resume-after-null write site that should re-check binding).
- R39 (Lifecycle secret/metadata zeroization): N/A.
- R40 (Cross-boundary serialization shape vs strict consumer): Checked — no issue.
- R41 (Declared capability without working backing path): N/A.
- R42 (Class-membership derivation): Checked extensively — no gaps found (MS1–MS8, E3/E4 counts, C3/C5 consumer sets all reproduced exactly).
- R43 (Fix-induced security-boundary widening): Finding F1 (the fix's own `null` semantics widen "who can refresh freshness" under the race).
- R44 (Gate exit status lossy channel): N/A.
- R45 (Repo-wide gate scaling): N/A.
- R46 (Scope-blind binding resolution): N/A.
- R47 (Surface-form vs interpreter-defined meaning): N/A.
- R48 (Parallel adjudicators): Checked for MS1/MS3 (plan correctly unifies them); Finding F1 is a related but distinct new instance (one sentinel value collapsing two intended meanings at one call site).
- R49 (Undeclared control class / claim stronger than implementation): Finding F4.
- R50 (Verification preconditions unverified): N/A.
- R51 (Decision bound to name not object): N/A.
- R52 (Control reach extended without re-auditing): N/A.
- R53 (Numeric gate threshold w/o headroom): N/A.
- R54 (Control suspension via ambient context): N/A.
- R55 (In-band sentinel collision): Finding F1.
- R56 (Progress-marker heal direction): N/A.
- R57 (Ordering/cursor key without total order): N/A.

```json
[
  {"id": "F1", "severity": "Critical", "title": "C4's null-binding pass-through reopens the any-credential step-up bug via a credential-deletion race", "file": "docs/archive/review/bind-stepup-to-session-credential-plan.md", "line": 389, "adjacent": false, "escalate": null},
  {"id": "F2", "severity": "Major", "title": "I9's rationale misattributes the race protection to the transaction boundary rather than the counter-CAS row lock", "file": "docs/archive/review/bind-stepup-to-session-credential-plan.md", "line": 401, "adjacent": false, "escalate": null},
  {"id": "F3", "severity": "Major", "title": "C5(2) requires a session-token extraction the current auth-provider route handler has no parameter to obtain", "file": "src/app/api/user/auth-provider/route.ts", "line": 13, "adjacent": false, "escalate": null},
  {"id": "F4", "severity": "Major", "title": "I12 attributes locale- and personal-group enforcement to a test that checks neither", "file": "src/__tests__/audit-action-group-coverage.test.ts", "line": 10, "adjacent": false, "escalate": null},
  {"id": "F5", "severity": "Minor", "title": "operator-token-card.tsx's identical PASSKEY_REAUTH_UNAVAILABLE fix has no listed unit test", "file": "src/components/settings/developer/operator-token-card.tsx", "line": 193, "adjacent": true, "escalate": null}
]
```

---

## Security Findings (Sonnet tier)

# Findings

## F-01 — [design] `expectedCredentialRowId`'s dual meaning of `null` lets a mid-ceremony credential deletion silently reopen the any-credential bypass this plan exists to close

**Severity**: Critical

**Problem**: `verifyAuthenticationAssertion`'s new `opts.expectedCredentialRowId: string | null` parameter is defined with exactly one semantic for `null`: "any credential of this user" (plan `docs/archive/review/bind-stepup-to-session-credential-plan.md:383`, C4). That meaning is correct for the two non-freshness call sites (MS4 b/c, `src/app/api/webauthn/authenticate/verify/route.ts:55`, `src/app/api/webauthn/credentials/[id]/prf/route.ts:130`), which pass it deliberately.

`reauth/verify`, however, does not pass a literal — it "reads the session's binding in the same transaction it later updates, [and] passes it as `expectedCredentialRowId`" (plan lines 389–391). That binding is `sessions.auth_credential_id`, and by I2/C1 that column is set to `NULL` by Postgres itself the instant the bound credential is deleted (`ON DELETE SET NULL`). If a session's bound credential A is deleted after `reauth/options` (C3) already admitted the ceremony but before `reauth/verify` (C4) executes its read — a window bounded only by `WEBAUTHN_CHALLENGE_TTL_SECONDS` (5 minutes, `src/lib/auth/webauthn/webauthn-server.ts:48`), not by anything C3/C4 coordinate — the fresh in-tx read at C4 returns `authCredentialId = null`. That `null` is then passed into `verifyAuthenticationAssertion`, which reads it as "any credential of this user" and will happily verify an assertion from a *different* credential B of the same user. The freshness gate is thereby satisfied by a credential other than the one that established the session — exactly the defect E1 describes, reopened in a race window instead of unconditionally.

FR4 states plainly: "A session with no live binding ... cannot step up at all." The C4 contract does not implement that for the case where the binding disappears *between* C3 and C4 (as opposed to being absent *at* C3) — no branch in C4's text handles a freshly-read `null`, and no acceptance criterion (C1/C3/C4) or manual scenario (1–6) exercises "credential deleted after the reauth challenge was issued, before it was consumed." The plan's own forbidden-pattern check for this ("`pattern: expectedCredentialRowId: null` ... Verified not to match the corrected reauth code, which passes a variable") is a textual/surface-form check (R47): it confirms no *literal* `null` appears in the source, which says nothing about what the *variable* evaluates to at runtime — the exact gap this defect lives in. I3's sentinel-collision analysis ("`NULL` is the only in-band value with that meaning and it cannot collide") is proven only for the storage column's own domain; it is never re-run for the `expectedCredentialRowId` parameter's domain, where `null` legitimately means two different things depending on which caller produced it (R55), and C4 is not one of the callers entitled to mean "any credential."

**Impact**: A session established by credential A can be stepped up (fresh-passkey-verified) by a *different* registered credential B of the same user, provided an attacker/co-holder can arrange for A's row to be deleted while a `reauth/options` challenge for that session is outstanding (e.g. a tenant admin or the account owner revoking a compromised key from another device mid-incident, or a bot/automation racing credential rotation against an open tab). Every one of the 45 gated routes (E3) — including `vault/reset`, `webauthn/credentials/[id]` DELETE, `mcp/authorize`, `tenant/breakglass`, `tenant/service-accounts/[id]/tokens` — inherits this bypass through `requireRecentCurrentAuthMethod` → `evaluateStepUpFreshness`, since a successful C4 write refreshes `passkey_verified_at` regardless of which credential produced it. This is the same class of bug E1 documents, reintroduced by the fix at the one point (concurrent deletion) the fix's own FK cascade (I2) creates a live transition into the "unbound" state.

**Recommended action**: In `reauth/verify`'s transaction, read `sessions.authCredentialId` first and branch explicitly on it *before* calling `verifyAuthenticationAssertion`: if it is `null`, deny immediately (the same `PASSKEY_REAUTH_UNAVAILABLE`-shaped response C3 already returns for this condition) and do not call the verifier at all — never let a value read from the DB flow into the "any credential" parameter slot that only MS4(b)/(c) are entitled to use; give the two call-site families distinct wire shapes (e.g. a two-case sum type `{ mode: "bound"; credentialRowId: string } | { mode: "any" }` rather than a shared `string | null`) so a future reviewer cannot repeat the collision on the same value. Pair this with the allow side that must keep working: session bound to A at C4-read-time, assertion from A, still succeeds unaffected. Prove the deny side by execution, not by code reading: seed a session row with `auth_credential_id` already `NULL` (simulating post-deletion) and a live credential B for the same user, run `reauth/verify` with a valid assertion from B, and assert the response denies (mirroring the `require-recent-session.integration.test.ts` raw-INSERT seeding pattern) — a passing suite that never constructs this exact row shape is not evidence the deny fires. Add an audit entry for this specific deny path too (it is a credential-mismatch-shaped event that today's C7 design would otherwise miss, since C7 only fires when "the session had a non-null binding" at the point it checks).

escalate: true
escalate_reason: chained defect spanning two request phases (`reauth/options` admission and `reauth/verify` execution) plus a concurrent DB-triggered state transition (FK `ON DELETE SET NULL`); reproducing or reasoning about it requires holding the whole multi-step step-up flow in mind, and it reopens the auth-bypass class (E1) that is this plan's entire stated purpose to close.

## F-02 — [prose] C5's second predicate consumer (`/api/user/auth-provider`) needs a session token the current handler signature has no access to

**Severity**: Minor (QUESTION) — [Adjacent]

**Problem**: C5 point 2 requires `/api/user/auth-provider` to compute `canPasskeyReauth` "from the same predicate" as `canRecoverSessionWithPasskey(sessionToken, userId)` (`src/lib/auth/session/recent-current-auth-method.ts:83`), which takes the raw cookie session token as its first argument. Today's handler, `handleGET()` in `src/app/api/user/auth-provider/route.ts:13`, takes no request parameter at all and has no code path that reads the session cookie — it only calls `auth()` for the Auth.js-derived `session.user.id`. The plan's Consumer-flow walkthrough for C5 does not say how this route obtains the raw token.

This is answerable and cheap to fix — `withRequestLog` (`src/lib/http/with-request-log.ts:31`) already forwards `req` as `args[0]` to whatever arity the wrapped handler declares, so adding `req: NextRequest` and reading it the same way `requireRecentCurrentAuthMethod` does via `getSessionToken(req)` is a mechanical, same-pattern change — but the plan doesn't name it as a required edit, so it is not verifiable against the plan text itself (Finding Floor: this is a requirement about code the change does not yet specify, not a proven defect).

**Impact**: If unimplemented or implemented by fetching the wrong token source (e.g. reusing the Auth.js JWT `sub` instead of the raw digest-keyed cookie), `canRecoverSessionWithPasskey` would look up a nonexistent session row and return `false` — which fails closed (routes the client to the sign-in-again dialog rather than the ceremony), not open, so the security consequence of getting this wrong is UX friction rather than a bypass. Flagged as Adjacent because closing it is a Functionality-scope concern; noted here because it sits on a security-relevant probe.

**Recommended action**: State explicitly in C5 (or C3's Consumer 2 walkthrough) that `handleGET` gains a `req: NextRequest` parameter and reads the token via the same `getSessionToken(req)` helper other step-up code paths use, so the implementer isn't left to invent a token source. Add a test asserting `canPasskeyReauth` is computed from the *request's own* session cookie (not from any other session of the same user) — pairing the allow case (bound session, matching credential still present → `true`) with the deny case already implied by C5's acceptance criteria.

## Recurring Issue Check

- R1 (Shared utility reimplementation): Checked — no issue
- R2 (Constants hardcoded in multiple places): Checked — no issue
- R3 (Incomplete pattern propagation): Checked — no issue
- R4 (Event/notification dispatch gaps): N/A — no event dispatch touched
- R5 (Missing transaction wrapping): Checked — no issue
- R6 (Cascade delete orphans): Checked — no issue
- R7 (E2E selector breakage): N/A — no E2E selectors touched
- R8 (UI pattern inconsistency): N/A
- R9 (Transaction boundary for fire-and-forget): N/A
- R10 (Circular module dependency): Checked — no issue
- R11 (Display group ≠ subscription group): N/A
- R12 (Enum/action group coverage gap): Checked — no issue
- R13 (Re-entrant dispatch loop): N/A
- R14 (DB role grant completeness): Checked — no issue
- R15 (Hardcoded environment-specific values in migrations): Checked — no issue
- R16 (Dev/CI environment parity): N/A
- R17 (Helper adoption coverage): Checked — no issue
- R18 (Config allowlist/safelist synchronization): N/A
- R19 (Test mock alignment with helper additions): Checked — no issue
- R20 (Multi-statement preservation in mechanical edits): N/A
- R21 (Subagent completion vs verification): N/A — plan review, not implementation
- R22 (Perspective inversion for established helpers): N/A
- R23 (Mid-stroke input mutation in UI controls): N/A
- R24 (Single migration mixing additive + strict constraint): Checked — no issue
- R25 (Persist/hydrate symmetry + access scope): Checked — no issue
- R26 (Disabled-state UI without visible cue): N/A
- R27 (Numeric range hardcoded in user-facing strings): N/A
- R28 (Grammatical inconsistency in toggle labels): N/A
- R29 (Citation, derived-claim, and rationale accuracy): Checked — no issue
- R30 (Markdown autolink footguns): N/A
- R31 (Destructive operations without explicit confirmation): N/A
- R32 (New long-running runtime artifact without boot smoke test): N/A
- R33 (CI configuration drift across duplicates): N/A
- R34 (Pre-existing bug deferred without Anti-Deferral justification): Checked — no issue (SC1–SC5 all carry Anti-Deferral cost-justification)
- R35 (Production-deployed component without manual test plan): Checked — no issue
- R36 (Suppression as substitute for fix): N/A
- R37 (Internal jargon in user-facing strings): N/A
- R38 (Async/persisted state machine failure modes): Checked — no issue
- R39 (Lifecycle secret/metadata zeroization): N/A
- R40 (Cross-boundary serialization shape vs strict consumer): N/A
- R41 (Declared capability without a working backing path): Finding F-02
- R42 (Class-membership derivation): Checked — no issue (MS1–MS8 re-derived and match)
- R43 (Fix-induced security-boundary widening): Checked — no issue
- R44 (Gate exit status through lossy channel): N/A
- R45 (Repo-wide gate scaling super-linearly): N/A
- R46 (Scope-blind binding resolution in a security analyzer): N/A
- R47 (Surface-form adjudication where an interpreter defines meaning): Finding F-01
- R48 (Parallel adjudicators deciding one predicate by different semantics): Finding F-01
- R49 (Undeclared control class, or claim stronger than implementation): Finding F-01
- R50 (Verification preconditions unverified): N/A
- R51 (Decision bound to a name, not the object used): N/A
- R52 (Control reach extended without re-auditing): Finding F-02
- R53 (Numeric gate threshold without headroom measurement): N/A
- R54 (Control suspension via ambient context state): N/A
- R55 (In-band sentinel colliding with a legitimate value of its own domain): Finding F-01
- R56 (Progress-marker heal direction): N/A
- R57 (Ordering/cursor key without total order): N/A
- RS1 (Timing-safe comparison): Checked — no issue
- RS2 (Rate limiter on new routes): N/A — no new routes
- RS3 (Input validation at boundaries): Checked — no issue
- RS4 (Personal-identifying data in committed artifacts): Checked — no issue
- RS5 (Untrusted externally-supplied security parameter without floor/whitelist): N/A
- RS6 (Incomplete sanitization — escape-character ordering): N/A
- RT1 (Mock-reality divergence): Checked — no issue
- RT2 (Testability verification): Checked — no issue (VE1–VE3 justified)
- RT3 (Shared constant in tests): N/A
- RT4 (Race-test vacuous-pass guard): Finding F-01 (remedy must include a real race-proof test)
- RT5 (Test call-path includes production primitive): Checked — no issue
- RT6 (Newly added production exports without test diff): Checked — no issue
- RT7 (New guard/test/gate must be proven able to fail): Finding F-01 (the missing branch has no test to prove failure)
- RT8 (Vacuous denial-path test): Finding F-01 (uncovered denial path)
- RT9 (Parallel-implementation twin drift): Checked — no issue
- RT10 (Guard tested only on deny side): Checked — no issue for the branches the plan does cover
- RT11 (Test fixture outlives its own run): N/A

```json
[
  {"id": "F-01", "severity": "Critical", "title": "expectedCredentialRowId null-collision lets a mid-ceremony credential deletion fall back to any-credential acceptance", "file": "docs/archive/review/bind-stepup-to-session-credential-plan.md", "line": 383, "adjacent": false, "escalate": true},
  {"id": "F-02", "severity": "Minor", "title": "auth-provider route lacks a stated path to the session token C5 requires", "file": "src/app/api/user/auth-provider/route.ts", "line": 13, "adjacent": true, "escalate": false}
]
```

---

## Security Findings (escalated — Opus tier)

# Security Expert — ESCALATED TIER (Opus)

## Escalated finding — verdict

**CONFIRMED as Critical.** Sonnet's remedy is **necessary but not sufficient as written** (details in SO-01/SO-02).

Verification performed against code, not the description:

- `withBypassRls` opens a plain `prisma.$transaction` with no `isolationLevel` (`src/lib/tenant-rls.ts:64-70`), so the transaction runs at PostgreSQL's default **READ COMMITTED**. Each statement takes a fresh snapshot; the session read takes no row lock on `webauthn_credentials`. A same-transaction read therefore does not fence a concurrent credential deletion.
- The verifier's credential lookup today is `findFirst({ where: { userId, credentialId: responseCredentialId } })` (`src/lib/auth/webauthn/webauthn-server.ts:484-486`) — user-scoped only. With `expectedCredentialRowId === null` that is exactly E1.
- The challenge minted by `reauth/options` lives 5 minutes (`WEBAUTHN_CHALLENGE_TTL_SECONDS = 5 * SEC_PER_MINUTE`, `webauthn-server.ts:48`) and is returned **in the response body** (`reauth/options/route.ts:89-92`), so the client — not the server — chooses which credential signs it. `allowCredentials` narrowing is not a control (SO-08).
- Who can delete a credential: the session owner, via `DELETE /api/webauthn/credentials/[id]`, gated by `requireRecentCurrentAuthMethod` (`src/app/api/webauthn/credentials/[id]/route.ts:39-40`) — i.e. anyone holding the session cookie *inside a live 15-minute step-up window*, which is precisely the state a user is in while a reauth prompt is open. No admin route, no second actor needed.
- Preconditions, complete: (1) a `provider='webauthn'` session bound to A; (2) `reauth/options` succeeds while the binding is live, minting the challenge; (3) credential A is deleted (own-session DELETE, or the ordinary two-tab flow the Functionality expert described); (4) `reauth/verify` is called within the 5-minute TTL with an assertion from any other credential B of the same user. No race against a tight window is required — step (3) has up to 5 minutes.

Ordering analysis of Sonnet's early branch (each ordering traced through the real code):

| deletion commits… | outcome with the branch |
|---|---|
| before the session read | read yields `NULL` → branch denies ✓ |
| after the read, before the credential lookup | lookup scoped by `id: A` → no row → 404 ✓ (also for a presented B) |
| after the lookup, before the counter CAS | `UPDATE … WHERE id = A AND counter = …` → 0 rows → 400 ✓ (`webauthn-server.ts:530-546`; message misleadingly says "may be cloned") |
| after the counter CAS | the deleting statement blocks on our row lock until we commit; the reauth was performed by the genuine binding ✓ (leaves a fresh window on a now-unbound session — SO-04) |

So the branch does close every ordering — **conditional on the `id` scoping actually being applied**, which is where the contract as written fails (SO-02). Sonnet's sum type is not over-broad: both non-freshness call sites (`webauthn/authenticate/verify/route.ts:55`, `webauthn/credentials/[id]/prf/route.ts:130`) keep "any credential of this user", and the PRF site additionally re-compares (`prf/route.ts:147`), so neither changes behaviour. It is, however, weaker than it looks: the discriminant is a *value*, so `{ mode: x ? "bound" : "any" }` remains spellable and the R47 blindness survives.

---

## Findings

### SO-01 — Critical — the freshness verifier's `null` slot makes the E1 bypass reachable for the whole 5-minute challenge TTL — **design**

**Problem.** `docs/archive/review/bind-stepup-to-session-credential-plan.md:378` gives the shared verifier `opts: { expectedCredentialRowId: string | null }` where `null` means "any credential of this user", and `:389` has `reauth/verify` fill that slot from a value read out of `sessions.auth_credential_id` — a column C1 (`:202`) sets to `NULL` on credential deletion. The plan's only guard against the `null` reaching that slot is a surface-form grep for the literal `expectedCredentialRowId: null` (`:407-409`), which the plan itself notes "passes a variable" — a check that cannot fail for the case it is written to catch (R47). I9 (`:401-403`) claims the same-transaction read closes the window, but the transaction is READ COMMITTED with no lock (`src/lib/tenant-rls.ts:64-70`), and I9 only speaks to "a credential that no longer exists", never to a *different* credential.

**Impact.** For up to 5 minutes after `reauth/options` admitted a ceremony, an assertion from credential B refreshes `passkey_verified_at` on a session credential B never established — the exact defect E1, restored, with all 45 step-up-gated routes behind it (`grep -rln requireRecentCurrentAuthMethod src/app | grep -v test | wc -l` → 45, verified). Reachable by an ordinary user by accident, and by a session-cookie holder who possesses any one of the account's credentials.

**Recommended action.** Preserve the one-shot `getdel` challenge semantics and keep the deny inside the shared verifier's SQL (do not move it to a caller-side comparison), and:
1. In `reauth/verify`, read `{ provider, authCredentialId }` for the request's own session digest and branch **before** the verifier is called: `provider !== "webauthn"` or `authCredentialId === null` → `403 PASSKEY_REAUTH_UNAVAILABLE`, verifier not invoked, challenge **not** consumed. Session row absent → `401`, matching `requireRecentCurrentAuthMethod` — "no row" must never be spelled the same as "no restriction".
2. Replace the nullable slot with two exported symbols rather than one symbol carrying a mode value: `verifyAssertionForCredential(tx, userId, credentialRowId: string, …)` and `verifyAssertionAnyCredential(tx, userId, …)`. Delete the `expectedCredentialRowId: null` grep and put in its place an import/callee rule ("no reference to `verifyAssertionAnyCredential` under `src/app/api/auth/passkey/reauth/`"), which is decidable on the symbol rather than on what a variable evaluates to. A `{ mode }` sum type does not achieve this — `{ mode: x ? "bound" : "any" }` type-checks.
3. Allow side, pinned: session bound to A + assertion from A → 200 and `passkey_verified_at` advances; both non-freshness call sites still accept any credential of the user, with their existing tests unchanged and green.
4. Red-prove separately, by execution: (i) remove the null/provider branch → the "binding nulled between options and verify, assertion from B" test reddens; (ii) point `reauth/verify` at `verifyAssertionAnyCredential` → the mismatch test reddens; (iii) drop the `id` scoping inside the bound verifier → the B-assertion test reddens. Three mutations, three assertions.
5. Boundary and tie: state that the decisive value is the binding observed by the request that consumes the challenge; a deletion committing after the branch is denied by the `id`-scoped lookup, and one committing after the counter CAS serialises behind our row lock and yields a fresh window on a session that is now unbound — that residue is SO-04's, and must be named as such rather than left implied by I9.
6. Optional and stronger, with its cost named: pin `authCredentialId` (and the session digest) into the Redis challenge **value** at mint time and have verify enforce the binding that was true when the ceremony was admitted, so no re-read can degrade it. Cost: the challenge value stops being a bare string, which touches all three verifier call sites (R40/RT9) — weigh it, do not adopt it silently.

`escalate: false`

### SO-02 — Critical — C4's `id` scoping, as specified, is most directly implemented as a filter Prisma silently drops — **design**

**Problem.** `:387-388` specifies "the credential lookup is additionally scoped by `id: expectedCredentialRowId`" while the parameter's type is `string | null` (`:378`). That cannot be written literally: Prisma's generated `where.id` for a non-nullable `String` rejects `null` at the type level. The two compilable forms are an explicit branch (fail-closed) or `id: expectedCredentialRowId ?? undefined` (fail-open) — and `undefined` in a Prisma filter means *filter not supplied*, so the lookup silently reverts to `{ userId, credentialId }`, i.e. any credential of the user. `strictUndefinedChecks` is not enabled anywhere in this repo (`grep -rn strictUndefinedChecks . --include='*.ts' --include='*.json' --include='*.prisma'` → no hits; `prisma.config.ts` and `prisma/schema.prisma:1-3` declare no preview features), so there is no runtime backstop. The fail-open form type-checks, passes `npx next build`, and passes the plan's `expectedCredentialRowId: null` grep.

Member-set derivation for this shape (values from DB/request/cache flowing into a slot whose `null`/absent case means "no restriction"), over everything the plan adds or changes rather than over the two instances supplied:
- C4 `expectedCredentialRowId` (SO-01) and its Prisma expression (this finding) — **members**.
- C3 step 4 `findFirst({ id: authCredentialId, userId })` (`:314`) — **member**, same `?? undefined` trap; safe only because step 3 branches first, which makes the branch load-bearing rather than defensive.
- C5(3) `data.canPasskeyReauth !== false` (`src/lib/auth/webauthn/can-use-passkey-recovery.ts:18`) — **member**, absent field reads as "capable" (SO-10).
- `options.maxAgeMs ?? PASSKEY_VERIFICATION_WINDOW_MS` (`recent-current-auth-method.ts:65`), `userAgent: string | null = null` (`webauthn-server.ts:452`), `Session.provider = NULL` (`prisma/schema.prisma:47`) — **non-members**: absent selects a default or a different gate, not an unrestricted one.
- `auth_credential_id = NULL` as "no binding" (I3, `:222-223`) — sentinel in the UUID domain, non-colliding, correctly reasoned.

**Impact.** The single most likely implementation of the plan's central control silently verifies against any credential of the user, with every stated gate (types, forbidden pattern, build) green.

**Recommended action.** Specify the lookup as two explicitly-branched `where` objects — never an optional filter — inside the two functions of SO-01(2), and forbid `?? undefined` / conditional-spread inside any `where` in `webauthn-server.ts` with a check that names itself when it cannot parse the file (a missing parser must fail loudly, not report clean). Deny side: assertion from B against a session bound to A → 404, `passkey_verified_at` byte-identical. Allow side: `verifyAssertionAnyCredential` still returns `ok` for any of the user's credentials, proving the branch did not simply narrow everything. Red-prove by rewriting the bound branch as `id: credentialRowId ?? undefined` and confirming the B-assertion test goes red — if it stays green, the test is asserting status only (RT8) and is not evidence. Boundary: state that "bound" mode with a syntactically valid but foreign UUID must deny (no row), not throw.

`escalate: false`

### SO-03 — Major — FR5 is enforced only at the ceremony's entry, and the challenge is user-scoped rather than session-scoped — **design**

**Problem.** C3 step 2 (`:307-308`) denies `provider !== "webauthn"` at `reauth/options`; C4 (`:389-391`) adds no provider check at `reauth/verify`. The reauth challenge key is `webauthn:challenge:reauth:${userId}:${challengeId}` (`reauth/options/route.ts:74`, `reauth/verify/route.ts:77`) — scoped to the user, not to the session row that requested it — while `reauth/verify` writes `passkey_verified_at` on *the caller's* session (`reauth/verify/route.ts:84-87`). Two adjudicators of one predicate with different member sets (R48); post-fix, verify's compliance rests on an implicit coupling (`auth-adapter.ts:510` never writes the binding) rather than on a check.

**Impact.** Today the gap is closed only incidentally — a non-WebAuthn session has a `NULL` binding, and `passkey/verify` deletes all of the user's sessions before creating its own (`passkey/verify/route.ts:131`), so two `provider='webauthn'` sessions cannot coexist. Both facts are outside C3/C4 and neither is stated as an invariant, so any future session-creating path that sets `provider='webauthn'`, or any relaxation of the all-sessions eviction, silently reopens cross-session challenge redemption.

**Recommended action.** Have `reauth/verify` assert `provider === "webauthn"` **and** a non-null binding in the same read that SO-01(1) introduces, so both adjudicators decide the predicate identically, and record the coupling ("at most one webauthn session per user, enforced by the eviction at `passkey/verify/route.ts:131`") as an invariant of C2 so a future change to it fails review. Deny side: a `nodemailer` session presenting a challenge minted by a webauthn session → 403, no `session.update`. Allow side: the webauthn session that minted the challenge still succeeds. Red-prove by deleting the provider clause and observing the cross-session test redden. If challenge-value pinning (SO-01(6)) is adopted, include the session digest in the pinned value and this finding closes structurally.

### SO-04 — Major — FR4 claims more than any contract delivers: an unbound session with a recent timestamp still passes the gate — **design**

**Problem.** FR4 (`:99-101`) says a session with no live binding "cannot step up at all". No contract implements that: C5 (`:437-439`) explicitly leaves `evaluateStepUpFreshness` alone, and that function's webauthn branch reads only `{ provider, createdAt, passkeyVerifiedAt }` (`src/lib/auth/session/recent-current-auth-method.ts:52-68`). MS1(a) lists it as "addressed by C5", but C5 changes only `canRecoverSessionWithPasskey`. Consequently C5's own acceptance criterion "Unbound WebAuthn session: gate → 403" (`:460`) is true only when `passkey_verified_at` happens to be stale — a fixture detail, not the binding, decides the verdict, so the criterion cannot fail for the reason it claims (R49; RT8-adjacent).

**Impact.** A session whose bound credential is deleted keeps full access to all 45 step-up-gated routes for the remainder of its 15-minute window; and at deployment, an unbound legacy row with a recent `passkey_verified_at` is admitted rather than routed to sign-in — NFR3 (`:110-114`) reports that population as 0 on the two known deployments today, which bounds the incident, not the contract.

**Recommended action.** Add `authCredentialId !== null` to the webauthn branch of `evaluateStepUpFreshness` (unbound → `STALE`, never `INVALID`, preserving the "do not sign the user out of a live session" property C5 argues for at `:437-439`), and make C5's acceptance criterion name the fixture: `passkey_verified_at = now()`, binding `NULL` → 403. Deny side: nulling the column on a row with a fresh timestamp flips the gate to 403. Allow side: bound + fresh timestamp still returns `fresh` for a gated route, and a non-webauthn session's `createdAt` path is byte-identical. Boundary: the comparison stays `> maxAgeMs`, so exactly-at-window remains fresh — state it, since this is where the next off-by-one enters. Red-prove each clause separately (one mutation nulls the binding, one ages the timestamp). If the authors instead choose to keep the window, then FR4's "at all" and C5's acceptance criterion must be restated with the window condition — the weaker option, because it leaves a fail-closed claim standing over code that does not make it true.

### SO-05 — Major — C7 logs an unvalidated request-supplied string as if it were a stored `credential_id`, and an attacker can use it to erase the row's own evidence — **design**

**Problem.** C7 (`:501-503`) states that both metadata values "are `webauthn_credentials.credential_id` (base64url) values, i.e. non-secret public identifiers". On the denial path no credential row matched, so `presentedCredentialId` can only come from the parsed request body (`response.id`), which is bounded only by `WEBAUTHN_RESPONSE_MAX = 10_000` (`src/lib/validations/common.ts:62`) on the whole `credentialResponse` string and is not charset- or length-validated anywhere. `truncateMetadata` replaces the **entire** metadata object with `{ _truncated: true, _originalSize }` once the JSON exceeds `METADATA_MAX_BYTES = 10_240` (`src/lib/audit/audit.ts:64-71`, `src/lib/validations/common.server.ts:24`), and JSON escaping of attacker-chosen quote/control characters roughly doubles the serialized length, so a ~5 KB crafted `id` pushes the row over the cap.

**Impact.** The audit row C7 exists to produce loses `boundCredentialId` and `presentedCredentialId` at the attacker's choosing, leaving a mismatch attempt recorded with no identifying detail; and raw request data enters a field operators read and log pipelines index, against this project's own "no full request bodies in logs" rule.

**Recommended action.** Validate `presentedCredentialId` against the base64url shape and a length bound before it reaches metadata; on rejection record `presentedCredentialId: null` with an explicit `presentedCredentialIdRejected: true` so "not recorded" is not spelled the same as "absent". Deny side: an oversized/malformed id still produces exactly one audit row that still carries `boundCredentialId`. Allow side: a well-formed foreign credential id is still recorded verbatim — do not fix this by dropping the field, which is the evidence that makes the mismatch investigable. Boundary: state which side an id of exactly the maximum length falls on. Red-prove with a fixture id of quote characters and assert `boundCredentialId` survives.

### SO-06 — Major — the denial paths that matter most are unaudited, including the one SO-01 describes — **design**

**Problem.** C7 (`:498-501`) scopes the new action to "when C4's lookup denies **and** the session had a non-null binding", and reasons that the no-binding case "is already covered by `PASSKEY_REAUTH_UNAVAILABLE` at C3" — but C3 (`:301-320`) emits no audit for either of its denials, and after SO-01's remedy the verify-side unbound denial emits none either. FR6 (`:103`) covers only the mismatch case.

**Impact.** The end state of the escalated race — ceremony admitted, binding destroyed mid-flight, another key presented — produces a denial with no audit trace, indistinguishable from a user closing a dialog. So does a non-WebAuthn session probing the ceremony (`:307-308`), which today succeeds and is precisely the pre-existing weakness C3 closes: it will be closed silently, with no signal that anything was ever attempted.

**Recommended action.** Emit one action for the bound-but-non-matching denial and one for the unavailable denial (no binding, or non-webauthn provider), at both C3 and C4, with the discriminating reason in metadata; add both to the MS5 propagation set and the `audit-action-group-coverage` gate (verified present: `src/__tests__/audit-action-group-coverage.test.ts`). Deny side: each of the three denials produces exactly one row naming its own reason. Allow side: a successful reauth still produces exactly one `AUTH_PASSKEY_REAUTH` and zero denial rows — assert the count, or the added emission is invisible to the test. Red-prove per path, and route an audit-emit failure to a warning that names the path rather than to silence.

### SO-07 — Major [Adjacent] — the mismatch denial reaches the user as "reauth failed", stranding the exact population the plan predicts will hit it — **design**

**Problem.** C4 routes the mismatch to the shared verifier's generic `404 NOT_FOUND` (`:388`, acceptance criterion `:414`). `reauthenticateWithPasskey` collapses that into `PASSKEY_REAUTH_FAILED` (`src/lib/auth/webauthn/passkey-reauth-client.ts:47-49`) and `useInlineReauth` renders `tAuth("reauthFailed")` (`src/hooks/auth/use-inline-reauth.ts:96-103`). The plan solved exactly this problem for the unbound case by minting a distinct code (`:309-312`, "precisely so the client can tell 're-prove your key' from 'this session can never be re-proved'") and did not for the mismatch case, even though its Considerations section (`:563-566`) predicts backup-key users will land there and read it as a regression.

**Impact.** A legitimate user presenting their backup key sees a generic failure and will retry the same doomed ceremony; the only working recovery — a fresh sign-in with that key — is never offered. The dialog dead-end is the same class of defect that `check-step-up-client-coverage.sh` exists to prevent on the server-403 path.

**Recommended action.** Give the bound-but-non-matching denial its own code (403), mapped in C3's Consumers 2–4 to the sign-in-again path with its own message key. This discloses nothing: the caller chose the credential it presented. Deny side: `passkey_verified_at` still unchanged and the audit row still written. Allow side: the correct credential still returns 200 and replays the pending mutation. Red-prove by asserting the hook switches dialogs on the new code and still shows `reauthFailed` for a genuine transport failure — do not collapse the two, or the new code buys nothing.

### SO-08 — Minor — C3's control class overstates `allowCredentials` narrowing as a gate — **prose**

I6/FR2 (`:324-325`, `:95`) and C3's control class (`:317`) read as a restriction on which credential can produce an assertion. It is not one: `reauth/options` returns the challenge in the response body (`reauth/options/route.ts:89-92`), and any script in the page origin can call `navigator.credentials.get` with its own `allowCredentials`. The sole control is C4. Recommended action: restate C3's control class as "ceremony-shaping + fail-closed admission (provider, binding presence)" and say in one line that credential selection is not enforced client-side — a reviewer who believes I6 is a gate stops auditing C4, which is where SO-01 and SO-02 live.

### SO-09 — Minor — NFR2's quantifier is wider than MS4's derivation — **prose**

NFR2 (`:111-112`) binds "every call site that verifies an assertion"; MS4 (`:157-164`) derives only callers of the shared helper. `authorizeWebAuthn` verifies an assertion with its own inline `verifyAuthentication` + counter CAS (`src/lib/auth/webauthn/webauthn-authorize.ts:145-170`) and is not in the set. Nothing is fail-open — that path is the binding-*establishing* event, where "any credential in the system" is correct, and it is also the path C2 must read `storedCredential.id` from — but the class as stated has an undeclared non-member, which is how the next assertion-verifying, session-creating path slips past I4. Recommended action: restate NFR2 over callers of the shared verifier and list `webauthn-authorize.ts:145` (and `verifyRegistration`) as declared non-members with their reasons, as MS7/MS8 already do for the cache and the grants.

### SO-10 — Minor — C5(2) does not say how a per-session predicate reaches a handler that has no request, and C5(3)'s absent-field default is inherited rather than chosen — **prose**

(a) `/api/user/auth-provider`'s handler takes no arguments and computes `canPasskeySignIn` purely from `Account` rows (`src/app/api/user/auth-provider/route.ts:13-33`); C5(2) (`:427-429`) requires it to answer `canPasskeyReauth` "for the requesting session", which needs the raw cookie token. Unstated, an implementer may substitute a user-scoped answer and break I10 — recovered by C3, hence Minor. (b) `canUsePasskeyRecovery` reads `data.canPasskeySignIn !== false` (`src/lib/auth/webauthn/can-use-passkey-recovery.ts:18`); switching the field name to `canPasskeyReauth` keeps that spelling, so a response from a not-yet-deployed server or a cached bundle reads as "capable". The plan chooses fail-open here deliberately (`:430-435`) — make that choice explicit for the new field (`=== true` plus a stated fallback) rather than inheriting it from the old field's comparison, so the next reader can tell a decision from an accident.

---

## Recurring Issue Check

- R1 (Shared utility reimplementation): Finding SO-09 — `authorizeWebAuthn` is a second assertion-verifier outside MS4; no fail-open member.
- R2 (Constants hardcoded): Checked — no issue (`PASSKEY_VERIFICATION_WINDOW_MS` / `STEP_UP_WINDOW_MS` reused, `:567`).
- R3 (Incomplete pattern propagation): Finding SO-03, SO-06.
- R4 (Event/notification dispatch gaps): Checked — no issue.
- R5 (Missing transaction wrapping): Checked — the write is in `withBypassRls`; the isolation-level gap is SO-01, not a missing wrapper.
- R6 (Cascade delete orphans): Checked — `ON DELETE SET NULL` is correct; forbidden pattern against `Cascade` present (`:227-228`).
- R7 (E2E selector breakage): N/A — out of scope (test strategy).
- R8 (UI pattern inconsistency): N/A.
- R9 (Transaction boundary for fire-and-forget): Checked — `logAuditAsync` denial rows are best-effort by design; SO-06 concerns coverage, not durability.
- R10 (Circular module dependency): Checked — C6 keeps `PASSKEY_VERIFICATION_WINDOW_MS` in place, avoiding the cycle.
- R11 (Display group ≠ subscription group): N/A.
- R12 (Enum/action group coverage gap): Checked — MS5's seven sites and the coverage test verified present.
- R13 (Re-entrant dispatch loop): N/A.
- R14 (DB role grant completeness): Checked — MS8's table-level grant claim verified in `scripts/checks/db-grants-manifest.json`.
- R15 (Hardcoded env values in migrations): Checked — no issue.
- R16 (Dev/CI parity): N/A — VE1/VE3 handled by the test expert.
- R17 (Helper adoption coverage): Finding SO-04 (MS1(a) listed as addressed by C5, which does not touch it).
- R18 (Config allowlist sync): Checked — `check-step-up-client-coverage.sh`'s `BRANCH_TOKEN_RE` still matches, since the new code is handled inside `use-inline-reauth`.
- R19 (Test mock alignment): Checked — plan requires the `passkey/verify` route mock to return `credentialRowId` (`:286-289`).
- R20 (Multi-statement preservation): N/A.
- R21 (Subagent completion vs verification): N/A.
- R22 (Perspective inversion): Checked — no issue.
- R23 (Mid-stroke input mutation): N/A.
- R24 (Additive + strict constraint in one migration): Checked — C1 is additive only, forbidden pattern present.
- R25 (Persist/hydrate symmetry): Checked — MS7 verified: `SessionInfoSchema` (`session-cache.ts:43-52`) carries no binding, and the gate reads via `findUnique`.
- R26–R28 (UI cues, numeric ranges in strings, toggle grammar): N/A.
- R29 (Citation/derived-claim accuracy): Checked — every cited line and every derivation command re-run and reproduced (E3 = 45; MS2's three writers; MS5's seven sites; MS6's two creators; MS7; the four reauth consumers). No inaccuracy found.
- R30 (Markdown autolink footguns): Checked — no issue.
- R31 (Destructive ops without confirmation): Checked — C6's deletions are code, gated by build+suite (`:494`).
- R32 (Runtime artifact without boot smoke test): N/A.
- R33 (CI config drift): Checked — no issue.
- R34 (Adjacent pre-existing bug deferred without cost): Checked — SC1–SC5 all carry Anti-Deferral entries.
- R35 (Deployed component without manual test plan): Checked — six manual scenarios on `mrx33` (`:602-624`); scenario 1 does not assert the SO-01 ordering, which SO-01's remedy covers.
- R36 (Suppression as substitute for fix): Checked — no issue.
- R37 (Internal jargon in user strings): Finding SO-07 (generic failure blocks safe recovery in a security flow).
- R38 (Async/persisted state machine fail-open): Finding SO-04 (fresh window persists after the binding is destroyed).
- R39 (Zeroization): N/A.
- R40 (Cross-boundary serialization vs strict consumer): Checked — flagged as the cost of SO-01(6) if challenge-value pinning is adopted.
- R41 (Declared capability without backing path): Finding SO-04.
- R42 (Class-membership derivation): Findings SO-02 (null-means-no-restriction class derived from code), SO-09.
- R43 (Fix-induced boundary widening): Finding SO-01 (the widening is the `null` slot).
- R44 (Gate exit status through lossy channel): Checked — no issue.
- R45 (Gate scaling): N/A.
- R46 (Scope-blind binding resolution): N/A.
- R47 (Surface-form adjudication): Findings SO-01, SO-02 — the `expectedCredentialRowId: null` grep cannot see a variable's value; replaced with a symbol-level rule.
- R48 (Parallel adjudicators): Findings SO-03 (options vs verify on `provider`), SO-04 (gate vs recovery predicate on the binding); C6 correctly removes the third.
- R49 (Overstated control class): Findings SO-04, SO-08.
- R50 (Verification preconditions unverified): Finding SO-04 (C5's acceptance criterion passes on fixture state, not on the binding).
- R51 (Decision bound to a name, not the object): Finding SO-01 — the binding is re-resolved at verify time, with an attacker-schedulable 5-minute interval between admission and use.
- R52 (Control reach extended without re-audit): Checked — no issue.
- R53 (Threshold without headroom): N/A.
- R54 (Suspension via ambient context): Checked — `withBypassRls` nesting guard intact; no new bypass introduced.
- R55 (In-band sentinel collision): Findings SO-01, SO-02 — `NULL` binding is non-colliding in the UUID domain (I3 correct), but the branch on it disables the control on the path where it is the legitimate value.
- R56 (Progress-marker heal direction): N/A.
- R57 (Ordering/cursor without total order): N/A.
- RS1 (Timing-safe comparison): Checked — the deny is a SQL row absence, not a string compare; sign-in's timing-equalization dummy path is untouched.
- RS2 (Rate limiter on new routes): Checked — no new routes; both reauth routes keep 10/min per user, fail-closed on Redis error.
- RS3 (Input validation at boundaries): Finding SO-05.
- RS4 (Personal data in committed artifacts): Checked — E2/VE2 use truncated credential-id prefixes and a hostname, no secrets.
- RS5 (Untrusted security parameter without floor): Checked — no issue; the plan deliberately refuses to trust browser-reported `credProps.rk` (`:85-88`).
- RS6 (Escape-character ordering): N/A.

```json
[
  {"id":"SO-01","severity":"Critical","title":"Freshness verifier's null slot makes the E1 bypass reachable for the whole 5-minute challenge TTL","file":"docs/archive/review/bind-stepup-to-session-credential-plan.md","line":378,"adjacent":false,"escalate":false},
  {"id":"SO-02","severity":"Critical","title":"C4's id scoping, as specified, is most directly implemented as a Prisma filter that undefined silently drops","file":"docs/archive/review/bind-stepup-to-session-credential-plan.md","line":387,"adjacent":false,"escalate":false},
  {"id":"SO-03","severity":"Major","title":"FR5 enforced only at ceremony entry; reauth challenge is user-scoped, not session-scoped","file":"docs/archive/review/bind-stepup-to-session-credential-plan.md","line":389,"adjacent":false,"escalate":false},
  {"id":"SO-04","severity":"Major","title":"FR4 claims more than any contract delivers: unbound session with a recent timestamp still passes the gate","file":"docs/archive/review/bind-stepup-to-session-credential-plan.md","line":437,"adjacent":false,"escalate":false},
  {"id":"SO-05","severity":"Major","title":"C7 logs unvalidated request input as a stored credential_id, enabling attacker-chosen metadata truncation","file":"docs/archive/review/bind-stepup-to-session-credential-plan.md","line":501,"adjacent":false,"escalate":false},
  {"id":"SO-06","severity":"Major","title":"Denial paths that matter — including the race path — emit no audit at all","file":"docs/archive/review/bind-stepup-to-session-credential-plan.md","line":499,"adjacent":false,"escalate":false},
  {"id":"SO-07","severity":"Major","title":"Mismatch denial surfaces as generic reauthFailed, stranding backup-key users with no recovery route","file":"docs/archive/review/bind-stepup-to-session-credential-plan.md","line":414,"adjacent":true,"escalate":false},
  {"id":"SO-08","severity":"Minor","title":"C3 overstates allowCredentials narrowing as a fail-closed gate","file":"docs/archive/review/bind-stepup-to-session-credential-plan.md","line":324,"adjacent":false,"escalate":false},
  {"id":"SO-09","severity":"Minor","title":"NFR2's quantifier is wider than MS4's derivation (authorizeWebAuthn's inline verifier)","file":"docs/archive/review/bind-stepup-to-session-credential-plan.md","line":157,"adjacent":false,"escalate":false},
  {"id":"SO-10","severity":"Minor","title":"C5(2) omits how a per-session predicate reaches a request-less handler; C5(3)'s absent-field default is inherited","file":"docs/archive/review/bind-stepup-to-session-credential-plan.md","line":427,"adjacent":false,"escalate":false}
]
```

---

## Testing Findings

# Testing Expert Review — Round 1

## Findings

### F-01 [Critical, design] — C4's actual credential-binding decision (the security control this entire plan exists to add) has no test on its ALLOW side anywhere in the plan, at any layer

**Problem**: The binding decision C4 adds lives entirely in one place: the `id: expectedCredentialRowId` filter added to the `tx.webAuthnCredential.findFirst({ where: { userId, credentialId: responseCredentialId } })` call in `src/lib/auth/webauthn/webauthn-server.ts:484-490`. Tracing every test that could exercise this line:

- `src/app/api/auth/passkey/reauth/verify/route.test.ts` mocks `@/lib/auth/webauthn/webauthn-server` wholesale (`verifyAuthenticationAssertion: mockVerifyAuthenticationAssertion`, line 43-46) — the route-level "match → 200" and "mismatch → 404" tests the plan's Testing Strategy proposes (line 532 of the plan) never call the real WHERE clause; they only check the route's handling of a canned mock return value.
- The plan's Integration list (plan lines 546-551) proposes only the **deny** case at the real-DB layer ("Gate end-to-end at the server-decision layer: session bound to A, mismatch path denies…") — no allow case ("assertion from A → 200") is listed, presumably because a genuine ALLOW requires a validly-signed WebAuthn assertion, which VE1 says the suite cannot produce.
- The one test file that calls the real `verifyAuthenticationAssertion` directly with everything except crypto and Prisma mocked out — `src/lib/auth/webauthn/verify-authentication-assertion.test.ts` — is where an allow/deny pair on the `id` scope could be added with zero new infrastructure (the crypto layer, `verifyAuthenticationResponse`, is already mocked at line 53-59; only `makeTxStub`'s `findFirst` at line 97-118 needs to become args-aware). **The plan never mentions this file.** It is invisible to the plan's own audit trail because MS4's derivation command (plan line 159) is `grep -rn "verifyAuthenticationAssertion" src --include='*.ts' | grep -v '\.test\.\|webauthn-server.ts'` — which explicitly filters out every `.test.ts` file, including this one.

Compounding this: `verify-authentication-assertion.test.ts` calls the function with only 4 positional args in all 12 of its test cases (e.g. line 124-130), relying on the current `userAgent: string | null = null` default (`webauthn-server.ts:452`). C4 replaces that parameter with a **required** `opts: { expectedCredentialRowId: string | null; userAgent?: … }` (plan line 372-380, "required (not defaulted)") — every one of those 12 calls will fail to compile. The plan's acceptance criteria for C4/C6 ("`npx next build` and `npx vitest run` pass") will force *some* fix here, but nothing in the plan tells the implementer to *add* the new scoping assertions while fixing the break — the path of least resistance is to bolt `{ expectedCredentialRowId: null }` onto all 12 calls and move on, leaving the scoping logic exactly as untested as before.

**Impact**: After this plan lands, the mechanism that makes the whole feature work — "does the DB lookup actually reject a credential whose `id` doesn't match the bound one, and actually accept one that does" — is unverified by construction. A future refactor that drops the `id` filter, inverts it, or scopes it with OR instead of AND regresses silently back to the reported vulnerability (E2), and every existing test (route-level mocked, integration deny-only) stays green.

**Recommended action**: In `verify-authentication-assertion.test.ts`, make `makeTxStub`'s `findFirst` mock honor a `where.id` filter (return the stored row only when `where.id` is absent or equals the row's `id`, mirroring what Postgres does), then add a paired case:
- ALLOW: `expectedCredentialRowId` equal to `storedCredential.id` → `result.ok === true` (extends the existing "returns ok … on success" case at line 301 with the new required opts).
- DENY: `expectedCredentialRowId` set to a different UUID, same `credentialId` otherwise → `result.ok === false`, `status 404`, `code "NOT_FOUND"`.

Red-prove the DENY case by reverting the `id` filter from the production WHERE clause and confirming that specific test — and only that one — goes red (RT7). Add this file to MS4's enumeration explicitly; its own filtered grep will not surface it.

---

### F-02 [Major, design] — Two existing tests hold exact-shape assertions on the parameter C4 removes; the plan's MS4 enumeration omits them

**Problem**: `verifyAuthenticationAssertion`'s signature changes from `(tx, userId, response, challengeKey, userAgent?)` to `(tx, userId, response, challengeKey, opts)` (plan lines 372-380). Two production call sites keep `expectedCredentialRowId: null` (MS4, plan line 161-164) and both have existing tests asserting the *exact* old positional shape via `toHaveBeenCalledWith`:

- `src/app/api/webauthn/authenticate/verify/route.test.ts:148-153` — `expect(mockVerifyAuthenticationAssertion).toHaveBeenCalledWith(expect.anything(), "user-1", validBody.response, ..., "Test/1.0")`.
- `src/app/api/webauthn/credentials/[id]/prf/route.test.ts:230-237` — same pattern, 5th positional arg `null`.

Per R19's exact-shape-assertion obligation, both need updating to assert the new `{ expectedCredentialRowId: null, userAgent: … }` object at that position. The plan's MS4 (which enumerates the production call sites needing the `expectedCredentialRowId: null` edit) never mentions the parallel test-file edits, and its own derivation grep (`| grep -v '\.test\.'`) structurally excludes them.

**Impact**: Both assertions will fail (loudly, at test time) the moment the route code is updated to the new options-object call shape — this is a compile-then-red break, not a silent one, so it will be caught. But the plan's own completeness claim ("every MS4 member states its choice at the call site") is understated: the person implementing it has no signal from the plan that these two `.test.ts` files need editing until the suite reds, adding unplanned rework right where the plan claims a closed member-set.

**Recommended action**: Add these two files to MS4's list explicitly, alongside the two production call-site edits they mirror. Update the assertions to the new opts-object shape.

---

### F-03 [Major, design] — `operator-token-card.tsx`'s reauth-error mapping needs the same fix C3 calls for, but has zero named test

**Problem**: C3's Consumer 4 walkthrough (plan lines 346-347) states plainly: "`operator-token-card.tsx` calls `reauthenticateWithPasskey()` directly (it deliberately does not use the hook) and needs the same mapping" that Consumer 2 (`useInlineReauth`) gets. Reading the current code confirms why this matters — `operator-token-card.tsx:187-199` (`handleReauthenticate`):

```ts
const result = await reauthenticateWithPasskey();
if (!result.ok) {
  setReauthError(
    result.error === "AUTHENTICATION_CANCELLED"
      ? tAuth("reauthCancelled")
      : tAuth("reauthFailed"),
  );
  return;
}
```

This is the exact "map every non-cancel error to a generic failure message, leave the ceremony dialog open" pattern the plan explicitly diagnoses as a dead end for `useInlineReauth` (plan lines 339-341, "would strand the user in a dialog that can never succeed") — and this component reaches this branch from *inside* the open `PasskeyReauthDialog`, not from the initial `handleCreate` probe, so a `PASSKEY_REAUTH_UNAVAILABLE` here has no automatic escape to `RecentSessionRequiredDialog` at all.

The plan's Testing Strategy (lines 526-538) names a test for `use-inline-reauth` covering exactly this branch (RT10 called out explicitly) but names **nothing** for `operator-token-card.tsx`, despite the plan itself identifying the component as needing the identical fix.

**Impact**: Operator tokens mint maintenance-scope admin credentials (used by `scripts/purge-history.sh`, `scripts/rotate-master-key.sh` per CLAUDE.md). An admin whose bound credential was deleted gets stuck retrying a ceremony that can never succeed, with no test proving the fix landed or catching a regression.

**Recommended action**: Extend `handleReauthenticate`'s error branch to route `PASSKEY_REAUTH_UNAVAILABLE` to `setReauthOpen(false); setRecentSessionOpen(true)` (mirroring the retry-path's existing `else { setReauthOpen(false); setRecentSessionOpen(true); }` at line 210-213). Add a test to `operator-token-card.test.tsx` modeled on the existing "opens RecentSessionRequiredDialog when stale-session occurs and canPasskeySignIn is false" case (line 360-390): mock `reauthenticateWithPasskey` to resolve `{ ok: false, error: "PASSKEY_REAUTH_UNAVAILABLE" }` *from inside* the open dialog, assert `recent-session-dialog` appears. Pair it with the existing "shows reauth failure message when the ceremony is cancelled" case as the allow-analog (an `AUTHENTICATION_CANCELLED` result must still show the local `reauthCancelled` message, not the fallback).

---

### F-04 [Major, design] — I9's TOCTOU-closing claim has no test

**Problem**: I9 (plan lines 401-403) claims: "the binding read and the `passkeyVerifiedAt` write happen in one transaction, so a concurrent credential deletion cannot land between them and leave a session refreshed by a credential that no longer exists." This is a specific, falsifiable claim about a race between `reauth/options` issuing a ceremony for credential A and `reauth/verify` being called after A is deleted mid-flight. Nothing in the Testing Strategy's unit list or integration list (plan lines 526-556) exercises this interleaving — the integration list's FK tests operate on idle state (delete-then-check), not delete-during-an-in-flight-verify. Per RT7, a newly-claimed invariant needs a red-provable check, not a narrative about why the transaction boundary makes it true.

**Impact**: The transaction-boundary reasoning is subtle (it depends on `reauth/verify` re-reading `session.authCredentialId` live inside its own transaction rather than trusting a value read earlier or cached from `reauth/options`) and is exactly the kind of claim that silently breaks under a future refactor (e.g., someone "optimizes" by passing the credential id from the request instead of re-reading it) with no test to catch it.

**Recommended action**: Add one integration test to the new sibling test file: seed a session bound to credential A with a Redis challenge already stored (as `reauth/options` would leave it), delete credential A via raw SQL (mirroring the plan's own FK test), then call the reauth/verify transaction logic with an assertion carrying A's `credentialId`. Assert the result denies via the primary `credentialId` lookup miss (not a silent "any credential" fallback). Red-prove it by mutating the route to read the binding once, before the transaction, and passing that stale value in as `expectedCredentialRowId` instead of re-reading inside the transaction — confirm the test goes red for that specific reason.

---

### F-05 [Major, design] — VE1's blanket deferral folds a CI-runnable dialog-selection path into the ceremony-only deferral, leaving the reported regression (E2) untested end-to-end

**Problem**: VE1 (plan lines 13-25) defers "the ceremony half of every contract" to manual testing because the E2E harness has no virtual authenticator. That is correct for the cryptographic half. But part of what C5 changes — which dialog opens for a given session state (`PasskeyReauthDialog` vs `RecentSessionRequiredDialog`) — needs no signed assertion at all, only a seeded `sessions` row (`provider`, `auth_credential_id`) and a page load. The existing harness already does exactly this kind of seeding: `e2e/tests/step-up-stale-window.spec.ts` uses `makeSessionStale`/`refreshSessionRecency` (`e2e/helpers/db.ts`) to manipulate session state directly via SQL and assert on `role=alertdialog`, deliberately "robust to which dialog opens" (its own comment, lines 75-80) because the seeded user in that test has no passkey at all.

No test — unit, integration, or E2E — currently exercises the specific regression this plan fixes (E2: a `provider='webauthn'` session recoverable by *any* credential) through the real browser + real DB + real dialog-selection stack. Unit tests (`use-inline-reauth.test.tsx`, `signin-reauth-panel.test.tsx`) mock `reauthenticateWithPasskey`/`canUsePasskeyRecovery` directly; integration tests call server functions, never a page. C5's own acceptance criteria ("Unbound WebAuthn session: … sign-in page → sign-in-again panel, not the ceremony") is stated as a UI-observable fact but has no full-stack proof.

**Impact**: This is not the ceremony VE1 correctly defers — it is the specific "which credential can recover this session" decision surfacing correctly in the UI, achievable with the existing DB-seeding pattern and zero new infrastructure. Folding it into VE1's Anti-Deferral (which prices the fix at "a separate infrastructure PR") risks it never getting done, since the actual cost here is a couple of assertions, not a virtual-authenticator harness.

**Recommended action**: Add a new e2e helper paralleling `makeSessionStale` that inserts/updates a `provider='webauthn'` session with a given `auth_credential_id` (and a companion helper to insert a minimal `webauthn_credentials` row, cleaned up by the existing user-cascade in `deleteTestData`/`db.ts`). Add one test asserting: (a) a session bound to a since-deleted credential renders the sign-in-again path on a gated action, never a ceremony dialog; (b) a session with a live binding renders the ceremony dialog (not sign-in-again) — giving `step-up-stale-window.spec.ts`'s `role=alertdialog` assertion the positive-branch sibling it currently lacks. State explicitly that this is out of `SC5`'s scope (no virtual authenticator needed) so it isn't accidentally deferred with it.

---

### F-06 [Minor, prose] — MS5/I12 cites the wrong test as the locale-coverage enforcing gate

**Problem**: MS5 (plan lines 165-172) and I12 (plan lines 509-513) both state that `src/__tests__/audit-action-group-coverage.test.ts` enforces that a new `AuditAction` value appears "in one `AUDIT_ACTION_GROUPS_PERSONAL` group... and in both locale `AuditLog.json` files." Reading the actual file (`audit-action-group-coverage.test.ts:1-19`) shows it only checks group-membership (`AUDIT_ACTION_GROUPS_PERSONAL/TEAM/TENANT`) — it never reads `messages/*/AuditLog.json`. The locale-file half of I12 is actually enforced by two other files: `src/__tests__/audit-i18n-coverage.test.ts` and `src/__tests__/i18n/audit-log-keys.test.ts`.

**Impact**: Bounded — the mandatory full-suite gate (`npx vitest run`, required by CLAUDE.md) runs all three files regardless, so a missing locale key is still caught overall. But C7's acceptance criterion names only the one (wrong) file as "the enforcing gate" to run (plan line 519: "`npx vitest run src/__tests__/audit-action-group-coverage.test.ts` passes"); an implementer treating that line as the specific red-proof for I12's i18n half gets a false green.

**Recommended action**: Correct MS5/I12 and C7's acceptance criteria to name `audit-i18n-coverage.test.ts` and `src/__tests__/i18n/audit-log-keys.test.ts` for the locale-file half, keeping `audit-action-group-coverage.test.ts` for the group-membership half.

---

## Answers to the specific questions

- **RT7**: Every guard *except* I9 (F-04) has a stated, executable mutation-based red-proof plan (the "write red, run against unfixed code, see red" framing at plan line 523 plus per-contract acceptance criteria). I9 is the one invariant asserted without a corresponding test.
- **RT8**: The claimed denial-path assertions ("no Redis set", "session.update never called") are correctly ordered against the actual route code (`reauth/options/route.ts`'s `redis.set` at line 73 comes after where the new checks would be inserted per plan line 302-304; `reauth/verify/route.ts`'s `tx.session.update` at line 84-87 comes after the assertion check at line 80-82) — verified against the real files, not just the plan's prose. No vacuous-fixture risk found here.
- **RT10**: F-03 and F-05 are direct instances — a newly-required allow/deny pairing (operator-token-card's fallback; the bound-vs-unbound dialog choice) with zero test coverage of any kind, not merely deny-only coverage.
- **RT1 / R19**: F-01 and F-02. The plan's own MS4 derivation command structurally excludes `.test.ts` files, which is exactly how it missed the one file (`verify-authentication-assertion.test.ts`) most central to the changed function, and the two files (`authenticate/verify`, `prf`) with exact-shape assertions on the parameter being restructured.
- **RT5**: Confirmed the integration tests reach the production DB and (for the FK contracts) genuinely exercise Postgres's own constraint enforcement. For the credential-binding decision itself, no test in the plan reaches the real `verifyAuthenticationAssertion` on its allow side (F-01) — RT5 is unmet for exactly the piece that matters most.
- **RT11**: Checked the proposed integration additions against `helpers.ts`'s `deleteTestData`/`cleanup` pattern. `webauthn_credentials` rows a new test would seed are cleaned up transitively via the existing `WebAuthnCredential.user onDelete: Cascade` relation when `deleteTestData` deletes the tenant's users (`helpers.ts:541`) — no separate leak path found; `cleanup()`'s tenant-sweep backstop covers the abort-before-afterEach case as it already does for the existing tests. No finding here.
- **VE1**: See F-05 — the ceremony-half deferral is sound, but the deferral's boundary is drawn too wide, sweeping in a dialog-selection path that is CI-runnable today with the existing DB-seeding pattern.
- **Acceptance criteria mechanical-checkability**: All acceptance criteria across C1–C7 are mechanically checkable (DB queries, HTTP status/body assertions, `grep` absence checks) — none require human interpretation. The one exception in spirit is C4's "Session bound to A, assertion from A → 200" criterion, which is mechanically checkable in principle but, per F-01, is not actually checked by anything the plan proposes.

## Recurring Issue Check

- R1 (Shared utility reimplementation): N/A — no new utility duplication introduced by this plan.
- R2 (Constants hardcoded in multiple places): N/A — `PASSKEY_VERIFICATION_WINDOW_MS`/`STEP_UP_WINDOW_MS` handling addressed by plan text, not a testing concern.
- R3 (Incomplete pattern propagation): Checked — no issue beyond F-02/F-03 (already captured under RT1/R19/RT10).
- R4 (Event/notification dispatch gaps): N/A.
- R5 (Missing transaction wrapping): Checked — C4's binding read + write are correctly co-located in one `withBypassRls` transaction (verified against `reauth/verify/route.ts:70-92`); F-04 concerns the *test* of this claim, not the wrapping itself.
- R6 (Cascade delete orphans): Checked — no issue (I2's `ON DELETE SET NULL` verified consistent with schema intent).
- R7 (E2E selector breakage): N/A — no selector changes proposed.
- R8 (UI pattern inconsistency): N/A.
- R9 (Transaction boundary for fire-and-forget): N/A.
- R10 (Circular module dependency): N/A.
- R11 (Display group ≠ subscription group): N/A.
- R12 (Enum/action group coverage gap): Finding F-06.
- R13 (Re-entrant dispatch loop): N/A.
- R14 (DB role grant completeness): N/A — addressed by plan's MS8, outside Testing scope; no issue found.
- R15 (Hardcoded environment-specific values in migrations): N/A.
- R16 (Dev/CI environment parity): Checked — no issue; VE3 (worker-conflict refusal in `setup.ts`) already covers this class.
- R17 (Helper adoption coverage): N/A.
- R18 (Config allowlist / safelist synchronization): N/A.
- R19 (Test mock alignment with helper additions): Finding F-02 (and F-01's compile-break aspect).
- R20 (Multi-statement preservation in mechanical edits): N/A.
- R21 (Subagent completion vs verification): N/A — not applicable to a plan review.
- R22 (Perspective inversion for established helpers): N/A.
- R23 (Mid-stroke input mutation in UI controls): N/A.
- R24 (Single migration mixing additive + strict constraint): Checked — no issue; C1 explicitly states additive-only, consistent with the migration description.
- R25 (Persist / hydrate symmetry + access scope): N/A.
- R26 (Disabled-state UI without visible cue): N/A.
- R27 (Numeric range hardcoded in user-facing strings): N/A.
- R28 (Grammatical inconsistency in toggle/switch labels): N/A.
- R29 (Citation/derived-claim accuracy): Finding F-06 (adjacent instance — MS5/I12's test citation is inaccurate).
- R30 (Markdown autolink footguns): N/A.
- R31 (Destructive operations without confirmation): N/A.
- R32 (New long-running runtime artifact without boot smoke test): N/A.
- R33 (CI config drift across duplicates): N/A.
- R34 (Pre-existing bug deferred without cost-justification): N/A — SC1-SC5 all carry Anti-Deferral justifications.
- R35 (Production-deployed component without manual test plan): Checked — no issue; VE2 supplies a manual plan.
- R36 (Suppression as substitute for fix): N/A.
- R37 (Internal jargon in user-facing strings): N/A.
- R38 (Async/persisted state machine hazards): N/A — the freshness verdict stays synchronous per-request.
- R39 (Lifecycle secret/metadata zeroization): N/A.
- R40 (Cross-boundary serialization shape vs strict consumer): N/A.
- R41 (Declared capability without working backing path): N/A.
- R42 (Class-membership derivation): Checked — MS1-MS8's derivations are largely sound (verified MS4's set against `grep`, confirmed exact 3-site membership), but F-01/F-02 show the derivation commands' `grep -v '\.test\.'` filter created a blind spot for test-file members of the same class; flagged there rather than duplicated here.
- R43 (Fix-induced security-boundary widening): N/A — out of Testing scope; no widening observed in test changes.
- R44 (Gate exit status read through lossy channel): N/A.
- R45 (Repo-wide gate scaling): N/A.
- R46 (Scope-blind binding resolution): N/A.
- R47 (Surface-form adjudication): N/A.
- R48 (Parallel adjudicators, different semantics): N/A — C6 explicitly collapses this class (checked against E4); the removal is correctly scoped.
- R49 (Undeclared control class / overstated claim): Checked — no issue; each contract states its control class explicitly and accurately as far as verified.
- R50 (Verification preconditions unverified): Checked — no issue found in the proposed integration harness beyond what's captured in F-01/F-04.
- R51 (Decision bound to name not object): N/A.
- R52 (Control reach extended without re-audit): N/A.
- R53 (Numeric gate threshold without headroom measurement): N/A.
- R54 (Control suspension via ambient context): N/A.
- R55 (In-band sentinel collision): Checked — no issue; I3 explicitly rules out `NULL`/UUID collision.
- R56 (Progress-marker heal direction): N/A.
- R57 (Ordering/cursor key without total order): N/A.
- RS1-RS6 (security-specific rules): N/A — out of Testing scope, deferred to the Security expert.
- RT1 (Mock-reality divergence): Finding F-01 (the compile-break aspect makes this partially self-catching, but the deeper divergence — a mock harness blind to the new WHERE-clause field — survives it).
- RT2 (Testability verification): Checked — all findings in this review are testable in the existing harness (vitest unit, real-DB integration, Playwright e2e) with no new infrastructure; none rejected under RT2.
- RT3 (Shared constant in tests): N/A.
- RT4 (Race-test vacuous-pass guard): N/A — no race test proposed by the plan (that itself is F-04's complaint).
- RT5 (Test call-path must include the production primitive): Finding F-01.
- RT6 (Newly added production exports without test diff): Checked — `WebAuthnAuthResult.credentialRowId` and `canPasskeyReauth` are both named with test obligations in the plan; no bare-export gap beyond F-01/F-03's deeper issues.
- RT7 (New guard must be proven able to fail): Finding F-04.
- RT8 (Vacuous denial-path test): Checked — no issue; verified against actual route code that denial precedes the guarded mutation in both `reauth/options` and `reauth/verify`.
- RT9 (Parallel-implementation twin drift): N/A — no test-importable production twin identified in this diff.
- RT10 (Guard tested only on deny side): Findings F-03, F-05.
- RT11 (Test fixture outlives its own run): Checked — no issue; cascade-based cleanup via `helpers.ts` covers the new fixtures the plan's integration tests would create.

```json
[
  {"id": "F-01", "severity": "Critical", "title": "No test exercises the ALLOW side of C4's credential-scoping WHERE clause; the one file that could is unmentioned and will break on compile", "file": "src/lib/auth/webauthn/verify-authentication-assertion.test.ts", "line": 217, "adjacent": false, "escalate": null},
  {"id": "F-02", "severity": "Major", "title": "Two test files assert the exact old positional userAgent arg that C4 replaces with an opts object; omitted from MS4", "file": "src/app/api/webauthn/authenticate/verify/route.test.ts", "line": 148, "adjacent": false, "escalate": null},
  {"id": "F-03", "severity": "Major", "title": "operator-token-card.tsx needs the same PASSKEY_REAUTH_UNAVAILABLE fallback mapping as useInlineReauth, but has zero named test", "file": "src/components/settings/developer/operator-token-card.tsx", "line": 187, "adjacent": false, "escalate": null},
  {"id": "F-04", "severity": "Major", "title": "I9's TOCTOU-closing claim (credential deleted mid-ceremony) has no test in unit or integration lists", "file": "src/app/api/auth/passkey/reauth/verify/route.ts", "line": 70, "adjacent": false, "escalate": null},
  {"id": "F-05", "severity": "Major", "title": "VE1's ceremony-only deferral is drawn too wide, sweeping in a CI-runnable dialog-selection path that could pin the reported regression end-to-end", "file": "e2e/tests/step-up-stale-window.spec.ts", "line": 75, "adjacent": true, "escalate": null},
  {"id": "F-06", "severity": "Minor", "title": "MS5/I12 cite audit-action-group-coverage.test.ts as the locale-file enforcing gate; it only checks group membership", "file": "docs/archive/review/bind-stepup-to-session-credential-plan.md", "line": 171, "adjacent": false, "escalate": null}
]
```

---

# Round 1 → Resolution Status

All 18 merged findings were reflected in the plan. No finding was Skipped, Accepted, Out of scope,
or Pre-existing, so no Anti-Deferral entry is required for this round.

| Merged ID | Severity | Disposition | Where in the revised plan |
|-----------|----------|-------------|---------------------------|
| M1 | Critical | Fixed — design changed | `C4` replaced the single nullable entry point with two named functions (`verifyAssertionForCredential` / `verifyAssertionAnyCredential`); `reauth/verify` now branches on `{ provider, authCredentialId }` **before** the verifier, does not consume the challenge on that denial (I9b), and the forbidden pattern is now the callee symbol instead of a literal `null` |
| M2 | Critical | Fixed | `C3` step 4 and `C4` both specify literal `where` objects inside explicit branches; `?? undefined` inside any `where` is a forbidden pattern in both files, with the check required to fail loudly when it cannot parse a target |
| M3 | Critical | Fixed | MS4's derivation no longer filters `.test.`; `verify-authentication-assertion.test.ts` is now a named member, with an argument-aware `findFirst` stub, an ALLOW/DENY pair, and three separate red-proofs |
| M4 | Major | Fixed | `C5` gained member 0: `evaluateStepUpFreshness`'s webauthn branch returns `stale` when the binding is `NULL`; acceptance criteria now name the fixture (`passkey_verified_at = now()` + `NULL` binding → 403) so they cannot pass for the wrong reason |
| M5 | Major | Fixed | I9 restated: the mechanism is the id-scoped lookup plus the counter-CAS row lock, with READ COMMITTED named explicitly (`src/lib/tenant-rls.ts:64-70`) |
| M6 | Major | Fixed | `C5` member 2 now specifies `handleGET(req: NextRequest)` + `getSessionToken(req)`, notes `withRequestLog` already forwards the request, and requires the answer to be per-request |
| M7 | Major | Fixed | MS5 and I12 now name all three gates and state what each does NOT check; `C7` strengthens the group test to assert scope-correct placement; the acceptance criterion runs all three test files |
| M8 | Major | Fixed | `operator-token-card` has its own named unit test in the Testing strategy, with the reason it has no automatic escape |
| M9 | Major | Fixed | Both exact-shape test files are named MS4 members with the assertion update called out (R19) |
| M10 | Major | Fixed | Integration list gained an ordering test for I9 with its own red-proof (read the binding once before the transaction) |
| M11 | Major | Fixed | VE1's deferral narrowed to the cryptographic ceremony; a Playwright dialog-selection test is in scope with `SC5` explicitly excluding it |
| M12 | Major | Fixed | `C4` re-checks `provider` on the redeeming session; I5b records the at-most-one-webauthn-session coupling as a `C2` invariant so relaxing the eviction fails review |
| M13 | Major | Fixed | `C7` validates `presentedCredentialId` (base64url + length) before metadata, records `presentedCredentialIdRejected: true` on rejection, and cites the truncation mechanism |
| M14 | Major | Fixed | `C7` adds `AUTH_PASSKEY_REAUTH_UNAVAILABLE` with a three-value `reason`, emitted at both `C3` and `C4`; acceptance criteria assert exactly-one-row per denial and zero on success |
| M15 | Major | Fixed | `C4` gives the mismatch its own `403 PASSKEY_REAUTH_CREDENTIAL_MISMATCH`, mapped by the consumers to the sign-in-again path; recorded in Considerations with the population it protects |
| M16 | Minor | Fixed | `C3`'s control class split into "fail-closed admission + ceremony shaping", stating that `allowCredentials` narrowing is not a control and `C4` is the sole one |
| M17 | Minor | Fixed | NFR2 restated over callers of the shared verifier, with `authorizeWebAuthn` and `verifyRegistration` as declared non-members and their reasons |
| M18 | Minor | Fixed | `C5` member 3 specifies `=== true` with an explicit fail-open fallback, so the default is a decision rather than an inheritance |

Additional change made by the orchestrator, not requested by any finding: **MS9** was added,
deriving the propagation set for the two new API error codes (`API_ERROR` map,
`API_ERROR_STATUS` → 403, `API_ERROR_I18N`, both locale `ApiErrors.json`, gate
`src/__tests__/api-errors-i18n-coverage.test.ts`) and recording
`scripts/checks/check-step-up-client-coverage.sh` as a checked non-member. The revised plan
introduces those codes, so the class existed and was undeclared.

---

# Round 2 (incremental)

## Changes from Previous Round

The plan was revised for all 18 round-1 findings (see the resolution table above). The revision
itself added new surface: `C4` restructured into two named verifier functions plus an early
binding branch; `C5` gained member 0 (a change to `evaluateStepUpFreshness`); two new API error
codes; a second audit action; a `handleGET(req)` signature change; and an E2E test pulled out of
the VE1 deferral. Round 2 was scoped to verifying the fixes and attacking what they introduced.

## Merged Findings (deduplicated, convergence-stamped)

| Merged ID | Severity | Subject | Reported by | Convergence |
|-----------|----------|---------|-------------|-------------|
| N1 | **Critical** | The E2E addition cites `deleteTestData`, which does not exist in `e2e/helpers/db.ts` (it belongs to the integration harness). The real cleanup, `cleanup()` (`e2e/helpers/db.ts:403`), runs twice per whole run (`global-setup.ts:191`, `global-teardown.ts:17`), never per spec — and the plan's own analogy points at `TEST_USERS.vaultReady`, shared by 25 specs under `workers: 1`. Leaving it `provider='webauthn'` would make `step-up-stale-window.spec.ts` render the ceremony dialog and still pass, because its assertion is deliberately dialog-agnostic. RT11's Critical shape. | test F-03 | single-perspective |
| N2 | Major | `handleGET(req: NextRequest)` gives the exported `GET` a required parameter, breaking all 8 zero-argument `GET()` calls in `src/app/api/user/auth-provider/route.test.ts` (TS2554). Round 1 named this class for two other files (M9) and missed this one. | func F1 | single-perspective (R19) |
| N3 | Major | `C4` has no Consumer-flow walkthrough, so `PASSKEY_REAUTH_CREDENTIAL_MISMATCH`'s client mapping exists only as Testing-strategy prose — a contract-faithful implementer would leave it on the generic failure message, which is the dead end M15 was filed to close. | func F2 | single-perspective |
| N4 | Major | The single compound `where` returns one null-or-row result, so `C4` cannot distinguish "the bound credential vanished mid-flight" (ordering row 2 — the plan's own headline Scenario 7) from "a different credential was presented". Both map to `CREDENTIAL_MISMATCH`, so a benign credential-management race is logged as a wrong-key attempt, with `boundCredentialId` at risk of being empty if captured by a later lookup. Ordering row 3 (counter-CAS 0 rows) exits through the pre-existing "may be cloned" `VALIDATION_ERROR` with **no audit at all** — M14 reopened for one ordering. | func F3, sec R2-S1 | **functionality+security** |
| N5 | Major | `C5` members 0/1 rewrite two functions that already have a unit-test suite the plan never names. Three webauthn-branch fixtures set no `authCredentialId`, so `undefined === null` is false and they keep passing through the old logic — a vacuous pass over the new gate on a row shape Postgres cannot produce (RT1). Five `canRecoverSessionWithPasskey` cases drive `webAuthnCredential.count`, which member 1 removes. | test F-01 | single-perspective |
| N6 | Major | Neither reauth route reads the session today, so neither route test's `@/lib/prisma` mock has the method the new step 1 calls; the Testing strategy names the assertions but not the mock scaffolding that makes them reachable. | test F-02 | single-perspective (R19) |
| N7 | Major | At the route-test layer the whole `webauthn-server` module is mocked, and `redis.getdel` lives inside it — so "challenge not consumed" is not an assertion distinct from "verifier not called". I9b's real observable (Redis key survival) had no named test at any tier, and the M10 ordering test covers a different scenario. | test F-04 | single-perspective (RT7/RT8) |
| N8 | Minor | Manual Scenario 1 still expected "404 / mismatch", the pre-M15 status. | func F4 | single-perspective (R29) |
| N9 | Minor | `C3`'s "belt to the FK's braces" reads as unreachable defensive code, but steps 1 and 4 are two statements with no lock between them — the same false-safety reasoning I9 was corrected for. | func F5 | single-perspective (R29) |

Security's round-2 verdict on the two round-1 Criticals: **still closed** by the revised design;
the four-row ordering table re-traced against the real code, I9b confirmed structurally
achievable, and the C5-member-0 wedge check (R38) traced end-to-end through both the route gate
and the sign-in page with a working escape hatch in each. No re-escalation requested.

## Adjacent Findings

None tagged `[Adjacent]` this round; N4 arrived independently in two lanes and is merged rather
than routed.

## Quality Warnings

None.

## Round 2 → Resolution Status

All nine merged findings reflected in the plan. Nothing Skipped, Accepted, Out of scope, or
Pre-existing, so no Anti-Deferral entry is required.

| Merged ID | Disposition | Where in the revised plan |
|-----------|-------------|---------------------------|
| N1 | Fixed | The E2E section now states there is no `deleteTestData` in `e2e/helpers/db.ts`, that `cleanup()` runs twice per run, and requires a **dedicated `TEST_USERS` entry** (the file's own convention for state-incompatible specs) rather than `vaultReady`; a restoration `afterAll` is required if a shared user is ever reused, with a red-proof that runs the new spec before its sibling |
| N2 | Fixed | `C5` member 2 now names `auth-provider/route.test.ts` with all 8 call sites, the allow/deny pair it never had, and a TS2554 red-proof |
| N3 | Fixed | `C4` gained a Consumer-flow walkthrough covering all four consumers, requiring the mismatch code to take the same transition as the unavailable code while keeping `reauthCancelled` and `reauthFailed` distinct |
| N4 | Fixed | `C4` step 6 now specifies an in-transaction existence re-check and three distinct outcomes (`credential_missing` / `presented_credential` / `counter_mismatch`), `boundCredentialId` captured through step 1's relation read rather than a later lookup, and acceptance criteria demanding three distinct `(status, code, action, reason)` tuples; `C7`'s discriminators extended to match |
| N5 | Fixed | `C5` member 0 now states the Prisma `select` must add the field and why `undefined === null` would silently no-op the gate; the Testing strategy names `recent-current-auth-method.test.ts` with the three fixture updates, the new null-binding case, and the five-case rewrite |
| N6 | Fixed | Testing strategy now names the `@/lib/prisma` mock scaffolding both route tests need before any of the new assertions are reachable |
| N7 | Fixed | The unit-level claim was narrowed to "verifier not called" with an explicit note that the two are one fact at that layer; a real-Redis integration assertion for challenge survival was added, distinct from the M10 ordering test |
| N8 | Fixed | Scenario 1's expected result now names the 403 code, the audit `reason`, `boundCredentialId`, and the dialog |
| N9 | Fixed | `C3` step 4's parenthetical replaced with the true reason (reachable via a deletion between two unlocked statements; fail-closed either way) |

---

# Round 3 (incremental)

## Changes from Previous Round

All nine round-2 findings were reflected. The revision's own new surface — `C4` step 6's
three-outcome denial classification, `C7`'s extended discriminators, `C5` member 2's test
obligations, the `C4` consumer walkthrough and the E2E dedicated-user requirement — was the
review target.

## Merged Findings

| Merged ID | Severity | Subject | Reported by | Convergence |
|---|---|---|---|---|
| P1 | Major | `C4` step 6's "three denial outcomes" is not exhaustive over the verifier's real `!ok` surface: seven returns, four sharing `{400, VALIDATION_ERROR}` and distinguishable only by free-text `details`. Discriminating on message text is the surface-form defect the plan replaced the literal-`null` grep for (R47); an expired-challenge double-submit would be reclassified as a clone/wrong-key event. The `signature_invalid` shape — presented credential IS the bound one, signature fails, reachable by a session-cookie holder with no authenticator since the bound id is not secret — had no label at all, so it would be unaudited or logged as `presented_credential` with `presentedCredentialId === boundCredentialId`, a row contradicting its own reason. | func F1, sec R3-S1 | **functionality+security** |
| P2 | Minor | `C7` required "a length bound" on `presentedCredentialId` without a number; the nearest existing constant bounds the whole response string, not the field. | sec R3-S2 | single-perspective (RS3) |
| P3 | Major | The `counter_mismatch` tuple was assigned to the integration tier, which cannot reach it: the counter-CAS runs only after `verifyAuthenticationResponse` returns `verified: true`, which VE1 says that tier cannot produce. An implementer would get a red for the wrong reason and "fix" it by loosening the assertion. | test T-01 | single-perspective (RT7/R50) |
| P4 | Major | `boundCredentialId`'s early-capture decision had an assertion only on the mismatch tuple — the one case where a late FK lookup would also succeed. The `credential_missing` tuple, the only case that distinguishes the two implementations, had none. | test T-02 | single-perspective (RT8-shaped) |

## Round 3 → Resolution Status

All four fixed; nothing deferred.

| ID | Where |
|---|---|
| P1 | `C4` step 6 replaced: `VerifyAssertionResult`'s failure variant gains a structured seven-member `reason` union assigned at each return site; the route switches on it through an exhaustive mapping table with a closed `default`; `signature_invalid` became its own audited row; the four unrelated reasons pass through with no re-check and no audit; the existence re-check runs on exactly two reasons |
| P2 | 512 characters, with 512 accepted / 513 rejected stated, and why `WEBAUTHN_RESPONSE_MAX` cannot be borrowed |
| P3 | Testing strategy split by tier: integration covers only the two pre-signature states; `counter_mismatch` and `signature_invalid` move to the route tier where the verifier is mocked, with the reason stated so nobody loosens a wrong-reason red |
| P4 | `C4` acceptance criteria gained the `boundCredentialId`-non-empty assertion on the `credential_missing` row, with its own red-proof |

---

# Round 4 (incremental)

## Merged Findings

| Merged ID | Severity | Subject | Reported by | Convergence |
|---|---|---|---|---|
| Q1 | Major | The pass-through group was described as "four unrelated `VALIDATION_ERROR`s"; two of the four are `503 SERVICE_UNAVAILABLE` (`webauthn-server.ts:456,471`) — which is why the route's existing ternary special-cases it. Hard-coding the prose's claim would turn a service outage into a client error (R29). | func F2 | single-perspective |
| Q2 | Major | "Five denial states → five distinct tuples" was false by the mapping table's own design: `credential_not_found`+gone and `counter_mismatch`+gone produce the identical tuple. The claim pushes an implementer either to invent a difference contradicting the table or to conclude the isolation red-proof is broken. The `counter_mismatch`+gone state also had no acceptance criterion at all. | func F1, test F1 | **functionality+testing** |
| Q3 | Major | `C4` step 6's existence re-check is a second Prisma call; `reauth/verify/route.test.ts`'s mock has no `webAuthnCredential` entry, and the N6 scaffolding note named only `session.findUnique`. Without it the row-gone/row-present split throws instead of denying, so two of the states cannot be constructed. | test F1 | (same finding, second half) |
| Q4 | Major | `C7` bounded only `presentedCredentialId`. `boundCredentialId` comes from an unbounded `@db.Text` column, the registration path caps only the whole JSON body, and the WebAuthn wire format permits ~65,535 raw bytes — self-registerable, since `fmt: "none"` has no signature to forge. One oversized registered id alone can trip `truncateMetadata` and erase the whole row: the M13 failure mode through the sibling field the M13 fix left unguarded. | sec Q1 | single-perspective (R42/R29) |

## Round 4 → Resolution Status

All four fixed; nothing deferred. One new scope-out entry was created.

| ID | Where |
|---|---|
| Q1 | The pass-through bullet now describes the group by behaviour, names which two are 503, and requires the verifier's own `status`/`code` to be forwarded unchanged |
| Q2 | Corrected to six states → five distinct tuples, with the reason two coincide and the requirement that each state still has its own test; a `counter_mismatch`+gone acceptance criterion was added, driven from that reason specifically |
| Q3 | The mock-scaffolding note now names `webAuthnCredential.findFirst` with its literal `{ id, userId }` where shape and says what breaks without it |
| Q4 | `C7` bounds `boundCredentialId` at 512 too, truncating rather than dropping (`boundCredentialIdTruncated: true`), with both checks at audit-write time so pre-existing credentials are covered; `SC6` records the registration-time cap with a quantified Anti-Deferral entry and a grep-able TODO |

---

# Round 5 (incremental — saturation check)

## Findings

| Merged ID | Severity | Subject | Reported by | Convergence |
|---|---|---|---|---|
| R5-1 | Major | `C7`'s two truncation guards are tested asymmetrically: `presentedCredentialId`'s oversized case has a driving acceptance criterion, `boundCredentialId`'s has none — and the untested one is the guard that actually closes the M13 evidence-erasure path. An implementation that forgets the truncation, misnames the marker, or picks the wrong boundary passes every stated criterion (RT7). | func (1 finding), test (1 finding) | **functionality+testing** |

**Security expert: No findings**, with an explicit verdict that the plan is ready to implement and
no Critical remains open anywhere. It independently re-verified: the `boundCredentialId` remedy
(truncate-and-flag preserves forensic value and keeps "not recorded" distinguishable from
"absent"), the metadata byte budget against `METADATA_MAX_BYTES` with both fields plus a `reason`
(~1.1–2.2 KB worst case against a 10,240 ceiling), `SC6`'s deferral quantification, the
pass-through forwarding, and a final R42/R55 re-derivation.

Both filers of R5-1 stated that closing it settles the plan.

## Round 5 → Resolution Status

| ID | Disposition | Where |
|---|---|---|
| R5-1 | Fixed | `C7` gained the symmetric acceptance criterion: a 600-character bound `credential_id` through a mismatch denial → first 512 characters plus `boundCredentialIdTruncated: true`, the row surviving; exactly 512 kept whole with no marker; red-proof by removing the truncation |

## Saturation call

**Saturated at round 5.** Recorded per the skill's saturation criteria:

1. At least two rounds completed — five.
2. No Critical or Major finding is open in any category. All 37 merged findings across five rounds
   (18 / 9 / 5 / 4 / 1) are reflected in the plan; none carries an Anti-Deferral disposition.
   `SC1`–`SC6` are scope-out entries with quantified justifications, not deferred findings.
3. No finding is against the design itself. The last round produced one test-coverage gap, now
   closed, and the security lane returned clean with an explicit ready verdict.
4. Nothing remains outstanding, so criterion 4 (the character of remaining Minors) is vacuous.

Finding character across the five rounds, which is what the criterion actually measures: rounds 1–2
were against the control (`C1`–`C5`) and produced three Criticals; rounds 3–5 were entirely against
the audit-classification refinement the earlier rounds' own fixes introduced (`C4` step 6, `C7`
metadata), produced no Criticals, and shrank 5 → 4 → 1. Two of round 4's findings were
overclaiming prose in the orchestrator's own text rather than defects in the design.

No `## Carried-Forward Plan Findings` section is needed: nothing is open.
