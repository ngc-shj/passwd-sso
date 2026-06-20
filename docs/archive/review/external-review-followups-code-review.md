# Code Review: external-review-followups
Date: 2026-06-20
Review round: 3

## Round 3 — SA token limit concurrency hardening

A third external observation noted the SA token limit was not strictly
concurrency-safe: under READ COMMITTED, two concurrent issuance transactions
(approve and/or direct token-create) could both read a sub-limit `count` and
each `create`, momentarily exceeding `MAX_SA_TOKENS_PER_ACCOUNT`. Low severity
(quota/abuse control, not a hard security boundary; pre-existing, not worsened
by this PR). RESOLVED: both issuance transactions now take a per-SA advisory
lock — `pg_advisory_xact_lock(hashtext(serviceAccountId))` — as the first
statement, reusing the codebase's established serialization pattern (PRF/key
rotation, attachments). Both paths share the same lock key, so approve and
direct-create serialize against each other too. Added an ordering regression
test (lock acquired before count) and `$executeRaw` to the route + integration
test mocks. Manual-verification note: the advisory-lock shape is identical to
three existing production routes; mocked tests assert call ordering, not the
real PG lock.

## Round 2 — second external review pass

A second external review of the open PR confirmed all four code fixes plus the
challengeId consolidation, and raised two further items:

- **WebAuthn `userVerification` mismatch (Low)** — options requested `preferred`
  while every verify path requires UV (`requireUserVerification: true`), causing
  a late-reject UX trap for UV-incapable authenticators. RESOLVED: `generateRegistrationOpts`
  and `generateAuthenticationOpts` now request `userVerification: "required"`, matching
  `generateDiscoverableAuthOpts` and the app's actual UV-required model. (This reverses
  the Round-1 "#4 false positive" judgment — re-analysis showed all verify paths require
  UV, so `preferred` was a genuine latent inconsistency, not a deliberate non-UV-key
  trade-off.) Added regression tests pinning options↔verify UV consistency.
- **`tx` shadowing in approve/tokens (maintainability)** — `withTenantRls(..., async (tx) =>
  prisma.$transaction(async (tx) => ...))` had an unused outer `tx` shadowed by a redundant
  nested `prisma.$transaction`. RESOLVED essentially (not cosmetically): `withTenantRls`
  already opens the transaction and provides `tx`, so the redundant inner `prisma.$transaction`
  was removed and the provided `tx` used directly. Rewired the route + integration test mocks
  (`mockWithTenantRls` passes the prisma tx; SA-token/access-request write methods moved onto
  the prisma mock) so the tests exercise the real single-transaction structure.

---

# (Round 1 below)
Review round: 1

## Changes from Previous Round
Initial review. Branch `fix/external-review-followups` implements 4 external-review
follow-up fixes plus a horizontal-propagation (横展開) consolidation of the
challengeId pattern.

Implemented fixes:
1. **sign-authorize body cap** — `src/app/api/vault/ssh/sign-authorize/route.ts`
   switched from raw `request.json()` to `readJsonWithCap(request, 16*1024)`,
   keeping the route's own `{authorized:false,reason}` envelope
   (`payload_too_large`/413, `invalid_params`/400).
2. **tagIds dedup in write path** — 5 sites now dedupe the Prisma relation write:
   personal-password-service (create), team-password-service (create+update),
   v1/passwords (create), v1/passwords/[id] (update), passwords/[id] (update).
3. **SA token expired-exclusion** — `access-requests/[id]/approve` and
   `service-accounts/[id]/tokens` token-limit `count` now adds
   `expiresAt: { gt: new Date() }` alongside `revokedAt: null`, matching
   extension/operator/SCIM token-limit semantics.
4. **WebAuthn challengeId scoping** — register/authenticate options mint a per-flow
   `challengeId`; challenge stored under `…:${userId}:${challengeId}`; verify routes
   require `challengeId` (regex). Clients round-trip it.

Horizontal propagation: extracted `CHALLENGE_ID_RE` + `generateChallengeId()` into
`webauthn-server.ts` (SSoT) and consolidated all 6 challengeId generation sites and
5 validation sites (webauthn register/authenticate + passkey signin/email/reauth).

## Functionality Findings
[F1] Major: "personal create path missed tagIds dedup" — **REJECTED (false positive)**.
The functionality sub-agent was misled by an `rtk`-cached stale `git diff` (it
self-noted the stale diff but drew the wrong conclusion). Direct file read confirms
`personal-password-service.ts:81-82` uses `uniqueTagIds`; the full test suite passes.

All other functionality checks: no findings. Fix #1/#3/#4 verified correct and complete;
no missed client caller for the challengeId change (only vault-context.tsx and
passkey-credentials-card.tsx call the 4 endpoints; PRF re-bootstrap uses its own key).

## Security Findings
No Critical/Major. Two Minor observations, both addressed or non-actionable:
- [S1] Minor: challengeId regex char-class drift (`[a-f0-9]` vs `[0-9a-f]`) — **RESOLVED**
  by the 横展開 consolidation into the shared `CHALLENGE_ID_RE` constant.
- [S2] Minor: `readJsonWithCap` no-stream fallback bypasses cap — unreachable in
  production (Content-Length precheck rejects oversized declared length; null body
  stream is test-only). No action.

Verified sound: gate ordering preserved (auth→scope→access-restriction→rate-limit→
body read→DB lookup); cap fires before DB lookup; challengeId key keeps server-derived
userId (no cross-user swap); regex excludes `:`/wildcards (no key traversal); 128-bit
entropy; getdel still atomic; PRF-salt envelope binding intact; SA expired-exclusion
does not expand privilege (expired == unusable); tagIds dedup does not weaken ownership.

## Testing Findings
- [T1] Major: team-password-service write-path dedup had NO regression test (proven
  vacuous — reverting the dedup kept the suite green). **RESOLVED**: added a `connect`
  assertion to the create dedup test and a new update-set dedup test.
- [T2] Minor: WebAuthn `challengeId` zod regex was never exercised (verify tests mock
  parseBody). **RESOLVED**: added `generateChallengeId`/`CHALLENGE_ID_RE` unit tests in
  `webauthn-server.test.ts` covering the validation contract (accept/reject incl.
  uppercase, wrong length, non-hex, colon traversal) — the SSoT every consumer depends on.

Regression validity confirmed by the testing sub-agent (reverted impl to main; all 4
landed test groups fail on old code with the intended assertions).

## Recurring Issue Check
- R3 (incomplete propagation): the 横展開 consolidation propagated `CHALLENGE_ID_RE`/
  `generateChallengeId` to all 6+5 sites; stale JSDoc key-shape comments in
  prf/options and webauthn-server also updated.
- R19 (test mock alignment with helper additions): the new `generateChallengeId`/
  `CHALLENGE_ID_RE` exports broke 11 `vi.mock("…/webauthn-server")` factories
  (58 failures). Fixed by converting each to `importOriginal`-spread so new pure
  exports pass through automatically — future-proofs against R19 recurrence.
- R25 (persist/hydrate symmetry): challengeId returned at JSON top level, read by both
  clients, posted back, required by verify. Symmetric.
- R31 (destructive ops): N/A.

## Resolution Status
### [T1] Major team write-path dedup untested — RESOLVED
- Action: added write-side `connect` assertion to the team create dedup test; added a
  new `updateTeamPassword` dedup test asserting `set: [{id:"tag-1"}]`.
- Modified file: src/lib/services/team-password-service.test.ts

### [T2] Minor challengeId regex untested — RESOLVED
- Action: added a `generateChallengeId / CHALLENGE_ID_RE` describe block with format,
  entropy, accept, and reject (uppercase/length/non-hex/colon) cases.
- Modified file: src/lib/auth/webauthn/webauthn-server.test.ts

### [S1] Minor regex char-class drift — RESOLVED (via 横展開)
- Action: extracted shared `CHALLENGE_ID_RE` + `generateChallengeId()`; all sites import them.
- Modified files: src/lib/auth/webauthn/webauthn-server.ts (+11 consumers)

### [F1] Major (REJECTED — false positive)
- Anti-Deferral check: not a deferral — rejected as unreproducible.
- Justification: direct file read (personal-password-service.ts:81-82 uses uniqueTagIds)
  and a green full suite contradict the finding; root cause was a stale rtk-cached diff.

### Verification
- npx tsc --noEmit: clean
- npm run lint: 0 errors (49 pre-existing warnings, all in untouched files)
- npx vitest run: 11522 passed, 1 skipped
- npx next build: success
