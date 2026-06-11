# Plan: dcr-dos-ttl-cap-rework

Branch: `fix/dcr-dos-ttl-cap-rework`
Worktree: `passwd-sso-ord`

## Project context

- Type: web app (Next.js 16 + Prisma 7 + PostgreSQL 16 + Redis).
- Test infrastructure: unit (vitest) + real-DB integration (`npm run test:integration`) + CI (`scripts/pre-pr.sh`).
- Verification environment constraints: none specific — this is a two-constant + docs change; the DCR register/cleanup behavior is covered by existing unit + db-integration tests.

## Objective

Mitigate the cross-tenant DCR-DoS (SC7 / `#530`-review item 4) at its ROOT instead of fighting unwinnable per-source counting. The security review established that NO per-source cap (per-IP, per-/64) defeats an IPv6 attacker — a single `/48` allocation yields 65 536 `/64`s, so per-source limits are trivially rotated. Registration is unauthenticated by design (RFC 7591 open DCR), so a legit registration and an attacker's are indistinguishable at register time; every mitigation is therefore partial.

The harm is not "an attacker creates ephemeral rows" — it is that those rows convert into a **503 to legitimate registrations**. That conversion is caused by two things: (1) a LOW, HARD, SHARED global ceiling (100) that 503s everyone when hit, and (2) a LONG (1 h) unclaimed-hold window that lets an attacker fill and hold the pool with a one-shot burst. This PR attacks both — with NO schema change and NO IP storage (the rejected IP-hash per-IP-cap approach added privacy cost for a benefit IPv6 rotation defeats anyway):

1. **Shorten the unclaimed TTL** toward the real claim time so the attacker's pool drains fast and the pool can only be held full by a SUSTAINED (not one-shot) attack, and the window in which any legit user could 503 shrinks proportionally.
2. **Raise the global cap** so it stops being a tight chokepoint that normal volume can hit, reframing it as a table-bloat backstop (the real growth bound is already TTL + lazy-cleanup + the existing 20/h-per-/64 rate limit).

This is the layered, honest, proportionate fix. The residual (a large SUSTAINED IPv6 botnet can still pressure the pool) is the SC1-accepted limit of open DCR.

## Requirements

Functional: DCR registration behaves identically except (a) an unclaimed client now expires after the new shorter TTL, and (b) the 503 "global cap reached" path only fires at the new higher threshold. The claim flow, rate limit (20/h/64), lazy cleanup, and worker are unchanged. No client-contract change (the DCR client already handles re-registration and the 503/Retry-After path).

Non-functional: no schema migration, no IP data stored. The TTL must remain comfortably above the human OAuth-consent time (a registrant must be able to register → read the consent screen → click Allow without the client expiring mid-flow); the cap must remain a real bloat backstop.

## Technical approach

Two constant changes in `src/lib/constants/auth/mcp.ts` (both already imported by the register route), plus test + docs updates. No new code paths.

## Contracts

### C1 — Shorten the unclaimed-DCR TTL

- Files: `src/lib/constants/auth/mcp.ts` (+ `register/route.test.ts` and any test asserting the expiry).
- Signature: `MCP_DCR_UNCLAIMED_EXPIRY_SEC: SEC_PER_HOUR (3600)` → `15 * SEC_PER_MINUTE (900)`. Consumed at `register/route.ts:134` (`dcrExpiresAt = now + TTL*1000`) and by the lazy cleanup / worker (which delete `dcrExpiresAt < now`).
- Rationale for 15 min: the DCR register→consent→claim is a single continuous human flow (the client registers, redirects the user to `/authorize`, the user reads the consent screen and clicks Allow — "claiming happens here", `machine-identity.md:169`). Seconds-to-a-couple-minutes in practice; 15 min is generous for human consent delay (incl. a Deny+retry) while draining 4× faster than 1 h. A slow user whose client expires simply re-registers (Claude Code already re-registers, new `client_id`). **Reviewer attention: confirm 15 min clears the human-consent UX floor for all supported flows (Claude Code CLI, web MCP authorize); if any flow decouples register from authorize by >15 min, raise the value.**
- Invariants: (app-enforced) an unclaimed DCR client lives at most the new TTL; the attacker cannot hold the pool full without sustained re-registration.
- Forbidden patterns:
  - pattern: a bare numeric TTL (e.g. `900`/`3600`) — reason: must be `15 * SEC_PER_MINUTE` from the time constants (R2/R27).
- Acceptance: the register route computes `dcrExpiresAt ≈ now + 15 min`; the lazy-cleanup + worker sweep tests (which seed explicit expired/fresh timestamps, not the constant) stay green; any test asserting the 1 h value is updated to derive from the constant (RT3). vitest green.

### C1.5 — Fix the 503 message's stale time-window (R34/R27, register/route.ts is in-diff)

- Files: `src/app/api/mcp/register/route.ts:176` (+ `register/route.test.ts:321` comment).
- Root cause: the global-cap 503 `error_description` reads "Too many unclaimed client registrations **in the last hour** — try again later." — the "in the last hour" drifts once the TTL is 15 min (S1/F1). register/route.ts is already a changed file (C1/C2), so this adjacent string bug is in-scope (R34, 1-line fix).
- Signature: replace "in the last hour" with a time-window-independent phrasing, e.g. "Too many unclaimed client registrations right now — try again later." (no embedded duration → no future drift; R27). Update the `register/route.test.ts:321` comment ("...reflects the 1-hour window...") and keep/adjust the `toContain("unclaimed")` assertion accordingly.
- Acceptance: the 503 body carries no stale duration; the test comment/assertion match. vitest green.

### C2 — Raise the global unclaimed cap (reframe as a bloat backstop)

- Files: `src/lib/constants/auth/mcp.ts` (+ `register/route.test.ts`).
- Signature: `MAX_UNCLAIMED_DCR_CLIENTS: 100` → `1000` with a rationale comment: this is a TABLE-BLOAT BACKSTOP, not a tight chokepoint — the real growth bound is the 15-min TTL + lazy cleanup + the 20/h-per-/64 rate limit; 1000 gives ~10× headroom over any realistic legit registration volume (each MCP client registers once) so legit registrations never hit it, while weaponizing it now requires a SUSTAINED ~200 distinct /64s (1000 ÷ (20/h × 15min/60) per /64) rather than a one-shot 20 — a 10× cost increase. 1000 tiny ephemeral rows is negligible for Postgres; the per-register global `COUNT` stays trivial.
- Invariants: (app-enforced) the global 503 path fires only at the new threshold; normal volume does not reach it.
- Forbidden patterns: none grep-able.
- Acceptance: the register route 503s at 1000 (not 100); the existing 503 unit test (`register/route.test.ts`, currently `mockResolvedValueOnce(100)`) updates to derive the threshold from `MAX_UNCLAIMED_DCR_CLIENTS` (RT3 — import the constant, not a literal), asserting `count = MAX → 503` and `count = MAX-1 → success`. vitest green.

### C3 — Docs: reflect the new TTL/cap and honest DoS posture

- Files: `CLAUDE.md:129` ("unclaimed clients expire after 1 h"), `docs/architecture/machine-identity.md:173,186,188` (1 h expiry × 2, "Global cap: 100").
- Signature: update "1 h" → "15 min" and "100" → "1000"; add a one-line note that the cap is a bloat backstop (not a complete cross-tenant-DoS defense — open DCR per RFC 7591 makes full prevention impossible; TTL + cleanup + rate-limit + the high cap raise the attack cost). Use user-domain wording; no internal jargon.
- Acceptance: no stale "1 h" / "100" DCR-cap wording remains; the honest residual is recorded.

## Go/No-Go Gate

| ID | Subject                                              | Status |
|----|------------------------------------------------------|--------|
| C1 | Shorten unclaimed-DCR TTL to 15 min                  | locked |
| C1.5| Fix 503 message stale time-window                  | locked |
| C2 | Raise global unclaimed cap to 1000 (bloat backstop)  | locked |
| C3 | Docs: new TTL/cap + honest DoS posture               | locked |

## Testing strategy

- Unit: C1/C2 via `register/route.test.ts` (expiry derived from the constant; 503 at the new cap, success below) — import the constants (RT3), do not hardcode 900/1000.
- db-integration: the existing `dcr-cleanup-worker-sweep.integration.test.ts` (seeds explicit timestamps; imports `MAX_UNCLAIMED_DCR_CLIENTS` so it auto-follows) and the lazy-cleanup test continue to validate the sweep/cap mechanics against real Postgres — no new integration test needed (value-only change, mechanism unchanged). **T2: the cap test loops `MAX_UNCLAIMED_DCR_CLIENTS` individual INSERTs — at 1000 that is 10× slower in CI; refactor the seed loop to a single bulk/multi-row INSERT (or `createMany`) so the cost is constant regardless of the cap value.**
- Gates: `npx vitest run`, `npx next build`, `npm run lint`, `scripts/pre-pr.sh`, `npm run test:integration` (confirm the DCR sweep/cap tests still pass with the new values).
- No migration (R24 N/A), no deployment artifact (R35 N/A — constants + docs only).

## Considerations & constraints

- TTL UX floor: 15 min must exceed the human consent time across all supported flows. If a future flow registers long before authorizing, this value must rise — reviewers verify.
- The cap raise does not eliminate the cross-tenant DoS for a determined sustained IPv6 attacker (SC1); it raises the cost ~10× and, combined with the shorter TTL, forces a sustained rather than one-shot attack while keeping legit registrations clear of the ceiling. Documented honestly (C3).
- No IP data is stored (the IP-hash per-IP-cap approach was evaluated and rejected: it adds privacy cost for a benefit IPv6 /64-rotation defeats).
- Worker interval (`DCR_CLEANUP_INTERVAL_MS`, default 1 h) is intentionally longer than the 15-min TTL and is NOT changed: the register-route lazy cleanup runs `dcrExpiresAt < now()` before every count, so cap recovery is guaranteed at registration time independent of the worker (the worker is a secondary sweeper). TTL < worker-interval is by design, not a bug (S3).

### Scope contract

- SC1: complete elimination of cross-tenant DCR DoS is OUT of scope — it requires authenticating registration, which breaks RFC 7591 open DCR. This PR is the proportionate root-cause mitigation (shorter hold window + non-chokepoint cap), not a complete defense.

## User operation scenarios

1. Claude Code / CLI registers and the user clicks Allow within ~minutes → unchanged; well within the 15-min TTL.
2. A user denies and retries after 10 min → still within TTL (or simply re-registers if expired — cheap).
3. A one-shot attacker fills 100 from 20 /64s → no longer enough (cap is 1000) AND their rows drain in 15 min, so they must SUSTAIN ~200 /64s to keep the pool full — a far higher, ongoing cost for a residual that open DCR cannot fully prevent.
4. Normal operation → the global 503 path effectively never fires for legit volume.
