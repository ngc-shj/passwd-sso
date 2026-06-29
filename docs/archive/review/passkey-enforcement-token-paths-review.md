# Plan Review: passkey-enforcement-token-paths
Date: 2026-06-29
Review round: 1

## Changes from Previous Round
Initial review (functionality / security / testing).

## Headline: the plan closes the extension+iOS bypass correctly, but the choke-point set is INCOMPLETE — MCP OAuth is a third unguarded token-mint path (S1, Critical). Must be fixed before implementation.

## Security Findings
- **S1 [Critical, escalate]** — MCP OAuth consent (`/api/mcp/authorize` GET + `/api/mcp/authorize/consent` POST → `createAuthorizationCode`) is a third session-gated token-mint precursor, NOT under `/dashboard` (page-route gate misses it), only `requireRecentSession` step-up (freshness, not passkey). A non-passkey OIDC user post-grace mints MCP tokens (passwords:read/vault scopes — highest value). FIX: gate both MCP authorize entry points with `passkeyEnforcementBlocks`. Update R42 member-set to codebase-derived + CI guard.
- **S3 [Major]** — token-path audit uses logAuditAsync (no dedup); page-route deliberately dedups (PASSKEY_AUDIT_DEDUP_MS) to stop flood. Token routes are retry loops → audit flood. Reuse `recordPasskeyAuditEmit` (extract to shared module).
- **S5 [Minor]** — iOS refusal: use `error=passkey_required` on the FIXED scheme, NOT redirect-to-dashboard (smaller surface, no cookie re-entry). CONTRADICTS F1 (func); security view wins.
- S2 [Minor] classify all session-gated mint routes (admin-gated SA/operator/SCIM = out of scope with reason, not omitted). S4/S6/S7 pass.

## Functionality Findings
- **F1 [Major]** — C3 "mirror existing convention" ill-defined (route has no error-to-scheme precedent). RESOLUTION: per S5, use `error=passkey_required` to fixed scheme. (Func expert preferred web-view redirect; security S5 overrides for surface reduction.)
- F2 [Minor] — coerceErrorCode allowlist is a second gate; add PASSKEY_REQUIRED there.
- F3 [Minor] — pin invariant: token routes use live auth(), never cached session.
- F4 [Minor] — add enabledAt=null immediate-block row to C2/C3 matrices.
- Verified: placement, session fields available, audit reuse, propagation mechanics all sound (modulo S1 completeness).

## Testing Findings
- **T1 [Major]** — MockSession lacks the 4 passkey fields → block branch vacuously uncovered. Extend MockSession + per-test overrides.
- **T3 [Major]** — coerceErrorCode seam untested (component test mocks requestExtensionConnect wholesale). Add direct unit test.
- T2/T4/T5/T6 [Minor] — only isPasskeyGracePeriodExpired moves (dedup helpers stay/shared carefully); enum mock literal update; pin C3 refusal-shape assertion; pin C4 emit cardinality (ONLY PASSKEY_ENFORCEMENT_BLOCKED). T7 mock-alignment enumeration (4 sites).
- Confirmed: all branches unit-testable; R12/RT6 satisfied.

## Cross-cutting consensus (round 1)
- The fix is RIGHT in approach (choke-point enforcement, shared helper) but INCOMPLETE in coverage (MCP). The R42 member-set was hand-anchored to the prompt's two routes — the exact `feedback_triangulate_enumerate_completeness` failure. Re-derive from the codebase primitive (auth() ∩ mint-primitive) and add a CI guard.
- iOS response = error=passkey_required to fixed scheme (S5 > F1).
- Reuse the page-route audit dedup across all sites (S3).

---

# Review round: 2

## Changes from Previous Round
Plan revised per round-1 (added C6 MCP gating, C7 CI guard, shared audit dedup, iOS error method). Round 2 verified the resolutions AND hunted deeper.

## Verdict round 2: round-1 initial-mint findings RESOLVED, but TWO new Critical findings — the fix scope materially expands.

## Security (round 2)
- **S8 [Critical, escalate]** — the REFRESH grant re-mints tokens with NO passkey re-gating, a 4th bypass class. Web session is re-evaluated per navigation; tokens are NOT re-evaluated on refresh. A non-passkey user who connected once (pre-enforcement / during grace) keeps refreshing AFTER the policy turns on: MCP **forever** (no absolute cap), extension 30d, iOS 7d. C6 gates NEW MCP connections but is useless for ALREADY-connected agents. SC2's "already gated upstream" is FALSE for the refresh grant. → C8 added (gate all 3 refresh routes + add MCP absolute cap).
- **S9 [Major]** — C7 guard grep omitted refresh re-minters → would certify S8 as complete. Also `auth()`-trigger excludes cookieless refresh routes. → C7 primitive set extended; trigger on primitive not auth().
- S10/S11 [Minor] — dedup map sizing across 4 paths; grace-window overhang. Noted.
- S1/S3/S5 confirmed RESOLVED (createAuthorizationCode single-caller, no auto-consent; dedup; iOS fixed-scheme).

## Testing (round 2)
- **T8 [Critical]** — passkey fields are at `session.user.*` for auth()-driven routes, not top-level. Helper read the wrong level → block tests vacuous (round-1 T1 reappears deeper). Mock prereq also misdirected (only bridge-code uses MockSession; mobile/mcp use inline literals). → C1 caller-shape + testing mock-nesting fixed; non-vacuity assertion added.
- **T9 [Major]** — `coerceErrorCode` not exported → direct unit test infeasible. → export it (C5).
- T10/T11 [Minor] — dedup-map reset in new tests; mandatory C7 self-test (repo has the `check-permanent-delete-stepup.test.mjs` precedent).

## Functionality (round 2)
- F1-F4 RESOLVED. F5 (enum member), F6 (GET vs POST error shape differ — disambiguate per route), F7 (consent page mints nothing, GET+POST gate sufficient) — all Minor, folded into C5/C6.

## Status after round-2 revision
All round-1 + round-2 findings reflected in the plan (C8 added, C1/C5/C6/C7 revised, testing strategy corrected). Plan NOT yet re-reviewed in a round 3 — implementation deferred to a fresh session per user decision; a round-3 pass is advisable before/at implementation start since C8 materially expanded scope.

---

# Review round: 3
Date: 2026-06-29

## Changes from Previous Round
Round-3 focused on C8 (refresh-grant gating + MCP absolute family cap — added in round 2, never reviewed) and its ripple into C1/C7. Triggered by a pre-review code-verification finding: the plan's C8 wrongly assumed extension refresh has a cookie session. Three experts (functionality / security / testing) reviewed the plan against the live codebase. Round 3 surfaced 3 Critical + 4 Major findings — the fix scope and prerequisites expand again.

## Verdict round 3: C8 as written is NOT implementable — it omits a required schema migration, misses a 5th token-mint primitive (residual bypass), and its test/guard strategy targets the wrong layer. Several contracts flip to `pending`.

## Security (round 3)
- **S11 [Critical, escalate — VERIFIED by orchestrator]** — `issueAutofillToken` is a 5th token-mint primitive missing from both the C8 gate list and the C7 guard set. `src/app/api/mobile/autofill-token/route.ts:85` mints an `IOS_AUTOFILL` `extensionToken` (`src/lib/auth/tokens/mobile-token.ts:262` `tx.extensionToken.create`) with `passwords:write` scope, authenticated by a cookieless Bearer `IOS_APP` token (`checkAuth`, no `auth()`, no passkey check). R42 member-set miss (clause ③: the mint primitive is reached via the `issueAutofillToken` lib wrapper, so a route-file grep for `extensionToken.create` misses it). A non-passkey user (grace expired) holding a still-valid host `IOS_APP` token can POST `/api/mobile/autofill-token` and mint a `passwords:write` token for up to the host token's idle window (~24 h) after its last successful refresh — bypassing C2/C3/C8. **DESIGN TENSION**: this route's stated purpose is *passkey-registration upload*; a naive `passkeyEnforcementBlocks` gate risks a registration deadlock (a non-passkey user needs this token to register their first passkey, mirroring the `PASSKEY_EXEMPT_PATHS` rationale). Resolution requires a gate-vs-exempt decision informed by the iOS registration flow. FIX: add to C7 guard primitive (lib-aware) + decide gate-or-exempt for C8.
- **S12 [Critical] (== F8 == T13)** — `McpRefreshToken` has NO `familyCreatedAt` column (`prisma/schema.prisma:1972-1995`; only `ExtensionToken` has it at L215-217). C8's "MCP absolute family cap" is therefore unimplementable without a schema migration + backfill (`familyCreatedAt = MIN(createdAt) per familyId`). The plan claims the cap is "verified" but omits the migration. Using per-row `createdAt` resets the cap on every rotation → no cap. **Orchestrator note**: C8's *re-gating* (live re-derivation of `hasPasskey` at refresh) already blocks a non-passkey or passkey-removed user at the next refresh — the absolute cap is a separate token-hygiene hardening, NOT required to close the passkey bypass. Whether to keep the migration-bearing cap in this PR is a scope decision.
- **S13 [Major]** — the session passkey fetch FAILS OPEN: `src/auth.ts:425-439` wraps the `webAuthnCredential.count` + tenant-policy read in a `try/catch` that, on a DB error, leaves `requirePasskey:false`/`hasPasskey:false`. C2/C3/C6 (auth()-driven) inherit this — during a DB blip the session says "no enforcement" and tokens issue. C8's fail-closed invariant must NOT be replicated as fail-open in the cookieless re-derivation. Pre-existing behavior (logs `auth.session.passkey_data_fetch_failed`); decision: accept+document vs flip to fail-closed (availability cost: blocks all issuance during DB blip).
- **S14 [Major]** — `recordPasskeyAuditEmit` dedups by `userId` only (`page-route.ts:61,107`). With C8 adding 4 paths, a user blocked across multiple paths within the 5-min window produces ONE audit row → under-reports multi-path attempts (OWASP A09). FIX: key the dedup by `${userId}:${blockedPath}` (signature change rippling to C1 + all call sites) OR document the limitation.
- **S15 [Minor]** — extension-refresh re-derivation must read the tenant policy from the **token row's `tenantId`**, not `activeSession.tenantId` (`extension/token/refresh/route.ts:43` vs L63-75) — a multi-tenant user who switched active tenant could otherwise have the wrong tenant's policy applied.
- **S16 [Minor]** — the SA-skip `userId === null` mirror of C13 treats a `(userId null, serviceAccountId null)` corruption row as SA (skipped). Pre-existing C13 behavior; document, optional defensive assertion (likely over-engineering pre-1.0 — essence-filter candidate).
- **R35 gap [Major, Adjacent→Testing]** — this is a Tier-2 auth-flow change; no `*-manual-test.md` artifact exists. R35 requires one before merge (adversarial scenarios: token replay, cross-tenant, post-grace refresh).

## Functionality (round 3)
- **F8 [Major] (== S12)** — MCP absolute cap requires the `familyCreatedAt` migration the plan omits; pick schema-column (preferred) vs `MIN(createdAt)` subquery + index.
- **F9 [Major]** — C8 does not specify the gate LAYER (route vs lib). C13 lives in the lib for MCP (`oauth-server.ts:393-398`) but in the route for iOS (`mobile/token/refresh/route.ts:152-163`). A lib-level MCP gate makes the C7 route-file grep miss `passkeyEnforcementBlocks` → forces a spurious allowlist entry for a route that IS gated. FIX: mandate route-level gating for all (MCP route pre-reads the refresh-token row for `userId`/`tenantId` before `exchangeRefreshToken`; the Phase-1 CAS still detects concurrent rotation), keeping C7's route scope sufficient.
- **F10 [Major]** — MCP cap value/derivation unspecified ("mirror extension/iOS" is ambiguous: extension = tenant-configurable 30 d default; iOS = hardcoded 7 d). Name a constant computed from `SEC_PER_DAY` (`feedback_time_constants_computed`).
- **F11 [Minor]** — `requirePasskeyEnabledAt` is a Prisma `Date | null`; the C1 helper expects `string | null`. Cookieless callers must `.toISOString()` (mirror `auth.ts:422`) or the helper must widen its param.
- **F12 [Minor]** — C1 should export a second helper `derivePasskeyState({tenantId, userId, tx})` encapsulating the `Promise.all([webAuthnCredential.count, tenant.findUnique])` + `.toISOString()` recipe, so the 3 (or 4) cookieless callers don't each reimplement it (R1/R17). Resolves F11 + S15 (token-tenantId) + S13 (fail-closed) in one place.
- **F13 [Minor]** — `createRefreshToken` is an INITIAL-issue primitive (`mcp/token/route.ts:124`, authorization_code branch), not a refresh re-mint; remove it from C7's refresh set (the actual MCP rotation is `exchangeRefreshToken` → `tx.mcpRefreshToken.create`, already covered).
- **F14 [Minor] (overlaps F9/T14)** — if the iOS gate goes in `refreshIosToken` (lib) the route grep misses it; pin route-level (after C13 check L163, before `refreshIosToken` L215).

## Testing (round 3)
- **T12 [Critical]** — the 3 refresh-route tests have ZERO mock coverage for passkey re-derivation, AND the plan's mock-alignment site (6) wrongly treats them as `session.user`-nested (T8). They are COOKIELESS — mocks live at the Prisma layer. Split into: (6a) extension `route.test.ts` — extend `mockTenantFindUnique` (`route.test.ts:27-30`, currently only TTL fields) with the 3 passkey fields + add a `webAuthnCredential.count` mock; (6b) mobile `route.test.ts` — add `mockTenantFindUnique` + `webAuthnCredential.count` (the route has no tenant-policy read today; C8 adds one); (6c) MCP — target `oauth-server.test.ts` (NOT `mcp/token/route.test.ts`, which mocks `exchangeRefreshToken` wholesale → RT5 violation), following the C13 precedent (`oauth-server.test.ts:793-830`). Add a non-vacuity assertion per route (block actually fires; off-case still rotates).
- **T13 [Major] (== S12/F8)** — the MCP cap test needs a `familyCreatedAt` fixture (post-migration) AND/OR an injectable `now` on `exchangeRefreshToken` (mirror `refreshIosToken`'s `now?: () => number`, `mobile-token.ts:449`) to assert "chain stops at cap" deterministically without `vi.useFakeTimers` contaminating Prisma timestamp defaults.
- **T14 [Major]** — the C7 self-test (mandatory, T11) must include a REFRESH-route tampered negative fixture (not just a mint route) and resolve the lib-file scope question (route-level gating per F9 keeps the route-scope self-test sufficient). Add positive allowlisted-refresh-route fixture too.
- **T15 [Major]** — RT8: each "refused" test must assert BOTH the denial signal AND that the mint primitive was NOT called (`mockExtTokenCreate` / `mockRefreshIosToken` / `mockDelegates(prisma).mcpRefreshToken.create`). The C13 precedent (`oauth-server.test.ts:828`) only asserts `result.ok===false` — insufficient for a security gate.
- **T16 [Minor]** — wire the C7 guard into `scripts/pre-pr.sh` (after L165, the `permanent-delete-stepup` step) — an authored-but-unwired check runs nowhere (RT7 shape b).
- **T17 [Minor]** — grace-period branches in the refresh tests should be fixture-driven (`requirePasskeyEnabledAt = now - graceDays*2*MS_PER_DAY` for expired) rather than fake-timer-driven.

## Cross-cutting consensus (round 3)
- **Triple-confirmed (independent)**: S12 == F8 == T13 — `McpRefreshToken.familyCreatedAt` does not exist; the MCP absolute cap needs a migration the plan omits.
- **The R42 member-set is STILL incomplete** — round 1 caught MCP (S1), round 3 caught `issueAutofillToken` (S11). Both were lib-wrapped mint primitives invisible to a route-file grep of the ORM call. The C7 guard must grep the *defining primitive across src/lib too*, or be lib-aware, or the autofill route must be explicitly classified (gate/exempt). This is the recurring `feedback_triangulate_enumerate_completeness` failure.
- **Cookieless everywhere**: all refresh routes + the autofill mint are cookieless Bearer — none read `session.user`. C8's design and its tests must use DB re-derivation (`derivePasskeyState`), not session nesting. The plan's session-nesting guidance (T8) applies ONLY to the initial-mint routes (C2/C3/C6).
- **Scope decisions surfaced to user** (do not silently resolve): (1) keep vs drop the migration-bearing MCP absolute cap given re-gating already closes the bypass; (2) gate vs exempt `issueAutofillToken` given the passkey-registration-deadlock tension; (3) accept-document vs flip the `auth.ts` fail-open.

## Status after round 3
C8 and its ripple require substantial revision before implementation. Pending these revisions + the 3 scope/design decisions, the following contracts flip `locked → pending`: **C1** (add `derivePasskeyState` + dedup-key change), **C4** (audit dedup key), **C7** (primitive-set fix + lib-awareness + pre-pr wiring + refresh self-test fixture), **C8** (migration, cap value, gate layer, cookieless re-derivation, autofill, fail-closed). C2/C3/C5/C6 remain `locked` (initial-mint session-path unaffected). A round-4 pass should confirm the revised C1/C4/C7/C8 before Phase 2.

**3 user decisions (post-round-3):** (1) MCP absolute cap KEPT — implemented properly as MCP token-lifetime parity (familyCreatedAt migration + backfill + constant + injectable now); (2) autofill-token EXEMPT (C9) — transitively protected via the IOS_APP host token (C3/C8) + a direct gate deadlocks first-passkey-save; classified + C7-allowlisted; (3) fail-open resolved by UNIFYING all token gates on a fail-closed `derivePasskeyState` re-derivation (C2/C3/C6/C8 re-derive, no `session.user`), web page-route fail-open scoped out as SC5.

---

# Review round: 4
Date: 2026-06-29

## Changes from Previous Round
Plan revised per round 3 + the 3 decisions: unified `derivePasskeyState` re-derivation (C1, fail-closed), C2/C3/C6 re-derive instead of reading `session.user`, route-level gating for all 3 refresh paths (C8), MCP `familyCreatedAt` migration + cap + injectable clock, per-path audit dedup key (C4/S14), autofill exemption (C9), C7 primitive-set fix + autofill allowlist + pre-pr wiring + refresh self-test. Round 4 verified the resolutions AND scrutinized the NEW unified-re-derivation design.

## Verdict round 4: all round-3 Critical/Major findings RESOLVED. The core design (unified re-derivation, route-level gating, fail-closed, per-path dedup, autofill exemption, MCP cap) is sound. Round 4 surfaced precision/implementation findings — 2 Critical (F15, T18) + 2 Major (F16, F17, T19) — all resolved by plan-language corrections (no design change). Security independently re-derived the R42 member-set: NO 6th token path; complete.

## Functionality (round 4)
- **F8-F14: all RESOLVED** (migration spec, route-level gating, cap value, Date→string, derivePasskeyState helper, createRefreshToken removed from refresh set, iOS gate pinned to route).
- **F15 [Critical]** — `session.user` carries NO `tenantId` (`next-auth.d.ts`; `auth.ts:441-454`). The plan's "active tenantId from the auth() session" was factually wrong. Each initial-mint route already resolves `tenantId` via its own DB read (C2 `userRecord.tenantId` ~L155; C3 `withUserTenantRls` ~L169; C6-consent `user.findUnique` ~L70-76). FIX (applied): C2/C3/C6 read `tenantId` from the route's existing DB-resolved value, not the session.
- **F16 [Major]** — extension refresh REBINDS the new token to `activeSession.tenantId` (TTL read ~L80, create ~L103/L129), which can differ from the token row's `tenantId` (~L43). FIX (applied): gate extension refresh on `activeSession.tenantId` (the destination tenant) — this REVERSES the round-3 S15 wording for extension only (iOS/MCP keep the token-row tenantId; they don't rebind). Verified no bypass: a user switching to a non-passkey tenant gets a token scoped to that tenant and cannot mint a passkey-tenant token without a passkey.
- **F17 [Major]** — the MCP route pre-read of `McpRefreshToken` MUST use `withBypassRls(...TOKEN_LIFECYCLE)`; a bare `prisma.mcpRefreshToken.findUnique` is RLS-filtered → null → would fail-closed ALL MCP refreshes. FIX (applied): the MCP route wraps the pre-read + `derivePasskeyState(tx)` in one `withBypassRls(...TOKEN_LIFECYCLE)`; `derivePasskeyState` uses the passed `tx`.
- **F18 [Minor]** — page-route test matrix needs "same user, different page path → two emits" (the new per-path behavior). FIX (applied).
- **F19 [Minor]** — the MCP GET authorize route has no `tenantId` at the gate point and must add a `user.findUnique({select:{tenantId}})`. FIX (applied).
- **F20 [Minor]** — clarify `derivePasskeyState`'s bypass purpose. FIX (applied): uses the passed `tx` if provided (token-lifecycle callers), else opens its own `withBypassRls(AUTH_FLOW)`.

## Security (round 4)
- **S11-S16: all RESOLVED.** S11 transitive-protection VERIFIED — `issueIosToken` has exactly 2 call sites (initial exchange SC2, `refreshIosToken` C8); `mobile/autofill-token` is hard-gated to `clientKind==="IOS_APP"`; no other IOS_APP mint path. Residual ≤24h `passwords:write` after C8 blocks host refresh, bounded + documented.
- **R42 member-set re-derived independently** (grep across `src/app/api` + `src/lib`): the 8 surfaces are complete — NO 6th token-producing path. `issueExtensionToken`/`issueIosToken` call sites all accounted (SC2 exchange or C8 refresh).
- **S17 [Minor]** — the MCP `familyCreatedAt` migration must follow the 2-step `ExtensionToken` precedent (nullable+backfill, then NOT NULL+default) to avoid a window where a >30 d family refreshing mid-migration is wrongly treated as new. FIX (applied): C8 now specs the 2-step migration.
- **S18 [Minor]** — the per-path dedup key lets a single blocked user fill the page-route dedup map (1000 LRU entries) via distinct `/dashboard/*` URLs → audit INFLATION (not a bypass; token routes unaffected, hardcoded paths). FIX (applied): accepted + documented in Known risks.
- S13 fail-closed verified (the bridge-code try/catch wraps only the create, not the pre-mint gate; a derivePasskeyState throw propagates to a 500). S14 verified server-set blockedPath for token routes.

## Testing (round 4)
- **T12-T17: all RESOLVED** (Prisma-layer mock seam, cap clock seam, self-test refresh fixture, RT8 dual assertion, pre-pr wiring, fixture-driven grace).
- **T18 [Critical]** — the MCP gate-matrix test target was wrong: the passkey gate is ROUTE-level (per F9), so it must be tested in `mcp/token/route.test.ts` (where the wholesale `exchangeRefreshToken` mock IS the correct RT8 spy: assert `mockExchangeRefreshToken.not.toHaveBeenCalled()`), NOT `oauth-server.test.ts` (RT5-disconnected from the route gate). Only the LIB-level behaviors (absolute cap, C13 SA-membership skip) belong in `oauth-server.test.ts`. FIX (applied): testing strategy split by gate layer.
- **T19 [Major]** — the dedup-key change breaks the `_passkeyAuditHasForTests(userId)` / `_passkeyAuditFirstKeyForTests()` probes + their `proxy.test.ts` callers (composite key now). FIX (applied): C1 specs updating the probe signatures + callers.

## Status after round 4
All round-3 + round-4 findings are reflected in the plan. The round-4 fixes are precision/implementation corrections (tenantId sources, RLS context, test targets, migration steps, probe helpers), NOT design changes — the unified-re-derivation design was validated as sound by all three experts and the R42 member-set was independently confirmed complete. A focused round-5 confirmation targets the one judgment-heavy reversal (F16 extension `activeSession.tenantId`) before contracts re-lock for Phase 2.

---

# Review round: 5 (focused confirmation)
Date: 2026-06-29

## Changes from Previous Round
Round-4 fixes applied to the plan. Round 5 is a focused single-reviewer confirmation of the 4 judgment-heavy corrections (not a full 3-expert pass), against the live codebase.

## Verdict round 5: CONFIRMED — all 4 corrections correct, no new findings.
- **F16 (extension `activeSession.tenantId`) — CONFIRMED.** `extension/token/refresh/route.ts:43` destructures the token-row `tenantId`; `:63-71` reads the live `Session` row's `tenantId`; `:78-86` TTL read and `:129` new-token `create` BOTH use `activeSession.tenantId`. The refreshed token is bound to `activeSession.tenantId`, so gating on it (the destination tenant) is unambiguously correct; the token-row tenantId would be WRONG (source tenant). Both multi-tenant scenarios (active=A/old=B, active=B/old=A) confirm no non-passkey user can mint/refresh a token operating in a passkey-requiring tenant.
- **F17 (MCP RLS) — CONFIRMED.** `mcp_refresh_tokens` has FORCE ROW LEVEL SECURITY (migration `20260330000000_add_delegation_sessions` L70-82); `exchangeRefreshToken` reads inside `withBypassRls` (`oauth-server.ts:354`). A bare pre-read returns null → the route's pre-read MUST use `withBypassRls(...TOKEN_LIFECYCLE)`.
- **T18 (test target) — CONFIRMED.** `mcp/token/route.test.ts` wholesale-mocks `exchangeRefreshToken` (valid RT8 spy for the route gate); `oauth-server.test.ts` calls it directly (right place for the lib-level cap test, wrong place for the route-level passkey gate).
- **iOS token-row tenantId — CONFIRMED.** `mobile/token/refresh/route.ts` is fully cookieless (no `auth()`/`activeSession`); uses `oldRow.tenantId` exclusively. The ext-vs-iOS distinction is correct.
- **R42 sanity grep — COMPLETE.** All token-mint routes map to C2/C3/C6/C8/C9 (exempt) or SC2/SC4 (scoped out). No unaccounted route.

## Final status (Phase 1 complete)
5 review rounds. All Critical/Major findings resolved and code-verified. Contracts C1-C9 re-locked. Ready for Phase 2 implementation against the locked plan.
