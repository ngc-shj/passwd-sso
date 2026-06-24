# Plan Review: favicon-proxy-optin (Web)
Date: 2026-06-24
Review rounds: 2

## Changes from Previous Round
Round 1: initial review (3 expert sub-agents) + local-LLM pre-screen → F1-F5, S1-S7, T1-T10 all resolved.
Round 2: incremental verification. F1-F5/S1-S7/T1-T10 verified resolved (live-probed t1.gstatic.com=200, source-checked auth.ts/route-policy.ts/with-request-log.ts). Two NEW blocking findings + advisories — all now resolved:
- **F6 (Major)**: retina `size*2` collides with `{32,64}` whitelist — real call sites render at 12/16/20/28 → 24/40/56 would 400→globe in detail pane / card / login. FIX: C3 bucket-snap `*2 <= 32 ? 32 : 64`; F6/F7 fail-red test added.
- **S8 (Major)**: host normalization didn't reject `& ? # % @` → query-param smuggling into gstatic `url=` + cache-key pollution (verified `new URL("https://github.com&size=16").hostname` keeps `&`). FIX: strict `^[a-z0-9.-]+$` allowlist + reject IP literals (also closes S9 latent SSRF); 400 smuggling tests added.
- **S9 (Minor)**: SSRF guard only validates t1.gstatic.com not inner host → latent on future direct-host provider swap. FIX: SC3 security note.
- **S10 (Minor)**: global limiter degrades per-process on Redis outage. FIX: documented caveat in C2.
- **T15 (Minor advisory)**: byte-cap + single-flight had no unit test. FIX: both added to C2 tests.
All contracts re-confirmed lockable by all three experts after round-1 fixes; round-2 fixes are localized and do not reopen any contract.

## Pre-screen (local LLM, already addressed before expert review)
- C5 deferral → resolved; burst handling → added to C2; R3 scan → recorded; cache-key normalization → specified; import paths → added; HTTP cache headers → specified.

## Functionality Findings
- **F1 [Critical]** `validateAndFetch` sets `redirect:"error"`; Google `s2/favicons` always 301→`t1.gstatic.com` → every fetch throws → proxy 204s 100% → no icon ever renders (R41). VERIFIED live + at `external-http.ts:192`. → Fixed: C2 Redirect constraint picks non-redirecting upstream `t1.gstatic.com/faviconV2`; `redirect:"follow"` forbidden-pattern added.
- **F2 [Major]** C5 staleness reasoning factually wrong — `session.user` is live-DB from `auth.ts` session() callback (verified `auth.ts:388-451`), refreshed by `SessionSync` on every navigation; NOT `session-cache.ts`. → Fixed: C5 rewritten to 2 files (next-auth.d.ts + auth.ts findUnique select); session-cache.ts edit DROPPED; optimistic update reframed as UX nicety.
- **F3 [Major]** First-paint flicker: `useSession()` undefined before hydration → opted-in user sees globe→favicon flicker list-wide. → Fixed: C3 three render states; `loading` → neutral placeholder.
- **F4 [Minor]** `referrerPolicy="no-referrer"` now inert (same-origin). → Fixed: C3 notes it's inert defense-in-depth, not an active control.
- **F5 [Minor]** Retina 2× (`sz=size*2`) must be preserved. → Fixed: C3 retina sizing; C2 size set `{32,64}`.

## Security Findings
- **S1 [Critical, escalate:true]** Redirect-vs-SSRF contradiction — same root as F1; the "follow redirects" escape reopens SSRF (pinned dispatcher validates first hop only). → Fixed: non-redirecting upstream chosen; `redirect:"follow"` forbidden; per-hop-revalidation recorded as the only acceptable future alternative.
- **S2 [Major]** `/api/user/favicon*` NOT auto-session-protected — no `/api/user` prefix in `SESSION_REQUIRED_PREFIXES` (verified `route-policy.ts:54-76`); falls to `API_DEFAULT` → no proxy session gate, no tenant IP restriction. → Fixed: new C8 registers both paths; false C2 claim corrected; `route-policy.test.ts` case required.
- **S3 [Major]** Rate limiter: declare fail-open; per-user key allows outbound-fan-out amplification. → Fixed: C2 adds global `rl:favicon:global` budget, required single-flight dedup, fail-open declared.
- **S4 [Minor]** 403-when-OFF "oracle" rationale wrong. → Fixed: C2 reframes as server-side privacy-contract enforcement vs rogue/stale client.
- **S5 [Minor→Conditional]** Shared cache key correct (no cross-user leak); needs per-entry byte cap + `size` enum whitelist. → Fixed: C2 byte cap (256KB) + `z.enum` size.
- **S6 [Minor]** Privacy residual-leak audit: `withRequestLog` logs pathname only (verified); no Referer to provider. → Recorded in Considerations as verified-clean.
- **S7 [Adjacent, Minor]** defensive `auth()` is only enforcement until S2 fixed. → Subsumed by C8.

## Testing Findings
- **T1 [Critical]** `validateAndFetch` returns `Response`, not `{bytes,contentType}` — mock shape. → Fixed: C2 test pins real-`Response` mock.
- **T2 [Critical]** `z.object` strips (not rejects) unknown fields — "reject unknown" untested/false. → Fixed: C4 requires `.strict()` + 400 assertion.
- **T3 [Critical]** Privacy invariant (OFF emits no img) had no session-mock mechanism; risked vacuous OFF-only coverage. → Fixed: C3 tests mock `next-auth/react` per `header.test.tsx`; three explicit states.
- **T4 [Major]** RT7-a flip under-specified (`toContain` stays green). → Fixed: concrete negative guards; delete stale `sz=64`.
- **T5 [Major]** 403-gate test mechanism unspecified. → Fixed: pin `session.user.fetchFavicons`; paired `not.toHaveBeenCalled()` / `toHaveBeenCalled()`.
- **T6 [Major]** R19: 4 favicon-mock files — clarify NO change, no `fetchFavicons` prop. → Fixed: R19 mock note in Testing strategy.
- **T7 [Major]** Cache-hit must assert `toHaveBeenCalledTimes(1)`; module-singleton cache/limiter need `beforeEach` reset. → Fixed: C2 test discipline.
- **T8 [Major]** C1 migration split (executability vs default-false integration test). → Fixed: Testing strategy split.
- **T9 [Minor]** Optimistic-update path untested. → Fixed: C6 test.
- **T10 [Minor]** INVALID_JSON test spies `req.json` — not a forbidden-pattern violation. → Fixed: note added.

## Adjacent Findings
- S7 (→ C8). F1/S1 share root cause (redirect). [Adjacent func→sec] any future redirect-follow must re-validate per hop.

## Recurring Issue Check
### Functionality expert
R1 reuse: Checked (helpers verified; F1 = incomplete reuse re redirect). R2: Checked (paths exist). R3: Checked (1 hit favicon.tsx:22). R4: F1,F3. R5/R9: N/A. R24: Checked (additive+default). R25: F2. R26/R27/R28: N/A/Checked. R35: Checked (manual M1-M5). R37: Checked. R41: F1. R6-R23,R29-R34,R36,R38-R40: N/A.

### Security expert
RS2: S3 (global budget gap). RS3: Checked (host normalize + size enum). RS5: S5 (size enum) + S1 (redirect Location untrusted). R6: S5 (byte cap). R24: Checked. R31: N/A. R37: Checked. RS1/RS4: N/A. Remainder: no new findings.

### Testing expert
RT1: T1. RT2: no over-reach (session read testable). RT3: T7 (singleton pollution). RT6: C5 session field needs no separate test after session-cache edit dropped. RT7: T3,T4,T5 (cluster). R19: T6. R24: Checked. R35: Checked. Remainder: addressed/out of scope.
