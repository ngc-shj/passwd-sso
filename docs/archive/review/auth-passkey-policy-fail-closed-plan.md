# Plan: Fail-closed passkey policy on session-callback fetch failure

## Project context

- **Type**: web app (Next.js 16 App Router + Auth.js v5, database session strategy)
- **Test infrastructure**: unit + integration (vitest) + CI/CD; `src/auth.test.ts` already exists with a full mock topology.
- **Verification environment constraints**: none blocking. The change is exercised entirely by the session-callback unit test (mocked `withBypassRls`); no paid-tier/hardware/multi-tenant-billing path is required. All contracts below are `verifiable-local` + `verifiable-CI`.

## Objective

Make the passkey-enforcement policy resolution in the `src/auth.ts` session callback **fail-closed**: when the DB/Redis fetch of passkey enforcement data fails, the resulting session must drive the enforcement gate to **block** (require passkey) rather than silently disabling enforcement.

## Background / Defect

External security review (2026-07-20, Medium, unresolved). `src/auth.ts` session callback (~L388-455):

1. Initializes `hasPasskey=false`, `requirePasskey=false`, `requirePasskeyEnabledAt=null`, `passkeyGracePeriodDays=null`.
2. Fetches enforcement data via `withBypassRls(prisma, ...)` (L400-424) inside a `try`.
3. On failure, the `catch` only logs `getLogger().warn("auth.session.passkey_data_fetch_failed")` and leaves the unsafe defaults.
4. The session is built with `requirePasskey=false` (L447-449).

Consequence: a passkey-required tenant loses enforcement on any transient fetch failure = **fail-OPEN** (R38: fail-open supersession on session/auth state → Critical class).

## Enforcement path (verified, read from code)

- `src/lib/proxy/page-route.ts:137-142`: blocks (redirect to `/{locale}/dashboard/settings/auth/passkey`) iff
  `session.requirePasskey && !session.hasPasskey && !isPasskeyExemptPath(path) && isPasskeyGracePeriodExpired(enabledAt, graceDays)`.
- `src/lib/auth/policy/passkey-enforcement.ts`:
  - `passkeyEnforcementBlocks(p) = !!p.requirePasskey && !p.hasPasskey && isPasskeyGracePeriodExpired(p.requirePasskeyEnabledAt, p.passkeyGracePeriodDays)`.
  - `isPasskeyGracePeriodExpired(enabledAt, graceDays)` returns **true** (immediate enforcement) when `enabledAt` is null/falsy OR `graceDays` null/≤0.
- `src/lib/proxy/auth-gate.ts:99-107` and the session cache (`session-cache.ts`, 30 s positive TTL) are **consumers** of the session-callback output (they read `data.user.requirePasskey` from the `/api/auth/session` JSON). They are NOT independent DB reads; their `?? false` only applies when the JSON field is absent, which the callback never lets happen.
- `isPasskeyExemptPath` exempts the passkey-setup page and WebAuthn/auth routes, so a fail-closed redirect degrades to "redirected to passkey setup", **not** a total lockout or a redirect loop.

## Member-set derivation (R42)

Class: "every code path that resolves `requirePasskey` (passkey-enforcement policy) from the DB and feeds an enforcement decision must fail closed on fetch error."

Defining-primitive grep (two forms — direct DB reads AND the shared fail-closed helper, so the member-set is reproducible; review MIN-1):

```
# (a) direct DB reads of the policy field
grep -rn "requirePasskey" src --include=*.ts \
  | grep -iE "findUnique|findFirst|\.tenant\b|select:|withBypassRls"
# (b) the shared re-derivation helper + the enforcement predicate (the token-gate class)
grep -rnE "derivePasskeyState\(|passkeyEnforcementBlocks\(" src --include=*.ts
```

Grep (b) enumerates the 7 enforcement call sites the `derivePasskeyState` helper fans out to — all independently verified fail-closed (the helper throws on DB error / missing tenant, and no caller wraps it in a fail-open catch): `extension/bridge-code/route.ts`, `extension/token/refresh/route.ts`, `mobile/authorize/route.ts`, `mcp/authorize/route.ts`, `mcp/authorize/consent/route.ts`, `auth/tokens/mobile-token.ts`, `auth/tokens/oauth-server.ts` (×2).

Members and their status:

| # | Site | Role | Fail-closed today? | Action |
|---|------|------|--------------------|--------|
| M1 | `src/auth.ts` session callback (~L400-449) | Produces the session enforcement fields | **NO — fail-open** on fetch failure AND on a null-tenant success | **FIX (C1)** — catch bundle + null-tenant now throws into the same catch (SC-followup-1, folded into this PR) |
| M2 | `src/lib/auth/policy/passkey-enforcement.ts` `derivePasskeyState` | Fresh re-derivation for token-issuance gates | YES — throws on error (does not catch) | none |
| M3 | `src/lib/auth/tokens/mobile-token.ts:531` | Mint-point gate | YES — via `derivePasskeyState` throw → `PASSKEY_REQUIRED` | none |
| M4 | `src/app/api/user/passkey-status/route.ts:52` | Banner/status display endpoint | YES — `catch` returns 500 `INTERNAL_ERROR`; not an enforcement decision | none |
| M5 | `src/app/api/tenant/policy/route.ts:145` | Config-display endpoint (settings UI) | N/A — errors propagate; not an enforcement gate | none |

Conclusion: the enforcement fail-open defect is a **single instance** (M1 / auth.ts). The class is already closed everywhere else via `derivePasskeyState` (throw = fail-closed). Only C1 is needed.

## Contracts

### C1 — Fail-closed default in the session callback catch

**File**: `src/auth.ts` session callback (~L388-455).

**Signature** (behavioral, not a new function): the `catch (err)` block, in addition to the existing `getLogger().warn(...)`, sets the enforcement-relevant locals to the safe-blocking bundle:

```
requirePasskey = true;
hasPasskey = false;
requirePasskeyEnabledAt = null;   // → isPasskeyGracePeriodExpired() === true (immediate)
passkeyGracePeriodDays = null;
// fetchFavicons stays false (cosmetic, non-security)
```

The happy path (successful fetch) is unchanged.

**Rationale for the exact bundle**: `passkeyEnforcementBlocks({requirePasskey:true, hasPasskey:false, requirePasskeyEnabledAt:null, passkeyGracePeriodDays:null})` = `true && !false && true` = **true** → the page-route gate redirects to the (exempt) passkey-setup page. This is the minimal state that forces enforcement while remaining self-consistent (no grace-window ambiguity: `enabledAt=null` collapses the grace computation to "immediate", so `graceDays` is never dereferenced into a false "still in grace" verdict).

**Invariants** (app-enforced — this is a runtime callback, not a storage constraint):
- INV-1: On fetch failure, the session's `requirePasskey` is `true` and `hasPasskey` is `false`. (⇒ gate blocks for any tenant.)
- INV-2: On fetch failure, `requirePasskeyEnabledAt` is `null`. (⇒ `isPasskeyGracePeriodExpired` returns true; no accidental "still in grace" pass.)
- INV-3: The existing `warn("auth.session.passkey_data_fetch_failed")` log still fires (ops visibility, A09).
- INV-4: The happy path is byte-for-byte behaviorally unchanged (successful fetch yields the real tenant values).

**Forbidden patterns** (diff must NOT contain):
- `pattern: requirePasskey = false` inside the catch — reason: that is the fail-open default this fix removes.
- `pattern: throw` newly added in the session callback — reason: throwing from the session callback would break session establishment for ALL users (see Rejected Alternatives A); the chosen design keeps the session valid but enforcement-blocking.

**Acceptance criteria**:
- Successful fetch → session carries the real tenant `requirePasskey` / `hasPasskey` / `enabledAt` / `graceDays` (unchanged).
- Failed fetch → session carries `requirePasskey=true`, `hasPasskey=false`, `requirePasskeyEnabledAt=null`, `passkeyGracePeriodDays=null`, and the warn log fired.
- `passkeyEnforcementBlocks(failClosedSession)` === true.

**Consumer-flow walkthrough** (the session shape is consumed downstream):
- Consumer `page-route` (path: `src/lib/proxy/page-route.ts:137-142`) reads `{ requirePasskey, hasPasskey, requirePasskeyEnabledAt, passkeyGracePeriodDays }` and uses them to decide the enforcement redirect. With the fail-closed bundle it redirects to the exempt passkey-setup page — satisfiable from the four fields alone. ✓
- Consumer `auth-gate` (path: `src/lib/proxy/auth-gate.ts:99-107`) reads the same four fields from the `/api/auth/session` JSON and copies them into `SessionInfo` (then into the 30 s session cache). The fail-closed bundle is a normal, in-schema value tuple — it caches and re-serves safely (fail-closed cached is still fail-closed). ✓
- Consumer session cache (path: `src/lib/auth/session/session-cache.ts` `SessionInfoSchema`) validates `requirePasskey: boolean`, `requirePasskeyEnabledAt: string|null`, `passkeyGracePeriodDays: number|null`. The bundle (`true`, `null`, `null`) passes the schema. ✓

## Rejected alternatives

- **A. Throw from the session callback / fail session establishment entirely.** Rejected: an Auth.js session callback throw breaks session validation for **all** users of **all** tenants (including tenants that do not require passkey) on a transient blip, and there is no exempt-path escape hatch — a harder outage than the chosen design. The chosen design keeps the session valid and only routes to passkey setup, which is exempt.
- **B. Suppress caching / force re-fetch next request.** Rejected as unnecessary: the session-callback output is cached downstream for ≤30 s; a cached fail-closed state is still safe (blocks), and the next re-fetch after cache expiry self-heals once the DB/Redis recovers. Adding a no-cache signal would be extra surface for no security gain.
- **C. Per-field partial fail-closed (e.g., set only `requirePasskey=true` but keep a stale `enabledAt`).** Rejected: mixing a fail-closed `requirePasskey=true` with a non-null `enabledAt`/`graceDays` could land in "still in grace" and NOT block — a partial fail-open. The bundle is all-or-nothing precisely to avoid that inconsistency (INV-2).

## Testing strategy

Add session-callback tests to `src/auth.test.ts` (extend the existing mock topology; the callback is reachable via `nextAuthInitArgs[0].callbacks.session`, same pattern the file uses for `signIn`).

**Shared fixtures (RT3 — review F4)**: define the expected fail-closed bundle once so T1's four-field expectation lives in a single place:

```
const FAIL_CLOSED = {
  requirePasskey: true,
  hasPasskey: false,
  requirePasskeyEnabledAt: null,
  passkeyGracePeriodDays: null,
} as const;
```

**Real predicate (RT5 — review F1)**: T1/T2b import the REAL `passkeyEnforcementBlocks` from `@/lib/auth/policy/passkey-enforcement` and must NOT `vi.mock` it or re-implement the condition inline. The predicate is a pure function that touches no mocked collaborator, so importing it un-mocked is safe and keeps RT5 auditable in the diff.

**Logger mock (RT1 — review F5)**: the current logger mock returns a fresh object with fresh spies on every `getLogger()` call, so a test cannot observe `getLogger().warn(...)`. Before T3, hoist a stable spy in the `vi.hoisted` block and have the logger mock return it:

```
// in vi.hoisted: const mockLoggerWarn = vi.fn();
// getLogger mock: () => ({ info: vi.fn(), warn: mockLoggerWarn, error: vi.fn() })
```

- **T1 (RT8 — fail-closed denial path, real behavior not just status; RT7 — INV-2 provable)**: make `mockWithBypassRls` reject (throw). Invoke the session callback. Assert the returned `session.user` matches `FAIL_CLOSED` on **all four** fields — `requirePasskey === true`, `hasPasskey === false`, `requirePasskeyEnabledAt === null`, `passkeyGracePeriodDays === null` (asserting all four, not just `requirePasskey`, is what makes INV-2 mutation-provable: a partial fail-open that left a stale non-null `enabledAt` would fail the `requirePasskeyEnabledAt === null` assertion). Additionally assert `passkeyEnforcementBlocks(session.user) === true` using the real production predicate (RT5). Mutation check: reverting C1 (restoring any fail-open field) must fail this test.
- **T2 (happy path — INV-4)**: `mockWithBypassRls` resolves with a tenant requiring passkey (`requirePasskey=true`, some `enabledAt`, `graceDays`) and `credCount=0`. Assert the session carries those real values through unchanged (guards against the fix clobbering the success path).
- **T2b (allow-path verdict — review F2, Major)**: `mockWithBypassRls` resolves with `credCount=1` (user HAS a passkey) and a `requirePasskey=true` tenant with expired grace. Assert `session.user.hasPasskey === true` AND `passkeyEnforcementBlocks(session.user) === false` (real predicate). This pins the allow path through the same production primitive as T1 and proves the fix is *fail-closed*, not *always-closed* — a fix that accidentally forced `hasPasskey=false` on the success path would fail here.
- **T3 (log visibility, INV-3)**: on the failure path, assert the hoisted `mockLoggerWarn` was called with `"auth.session.passkey_data_fetch_failed"` (ops A09 visibility preserved).

RT5/RT8 note: T1 asserts the **mutation** (all four fail-closed field values + the real `passkeyEnforcementBlocks` verdict), not merely that "the callback returned without throwing". T2b asserts the complementary allow verdict so the suite distinguishes fail-closed from always-closed.

## Considerations & constraints

- **UX cost (accepted)**: on a transient DB/Redis blip, users of tenants that do NOT require passkey are unaffected in steady state — but during the blip window their session ALSO gets `requirePasskey=true` and would be redirected to passkey setup for up to the cache TTL (≤30 s). This is the deliberate fail-closed tradeoff: a brief, self-healing over-block is preferred to silently dropping enforcement for tenants that DO require it. Documented so reviewers weigh it explicitly. (R43 note: this is a fail-SAFE widening — it blocks more, never grants more — so it does not widen a security boundary in the dangerous direction.)
- **Self-heal mechanism (review func-F1)**: recovery is gated on DB/Redis health, not on the redirect itself. During a *sustained* outage the user reaches the exempt setup page but cannot complete passkey registration there (the WebAuthn/register endpoints also need the DB) — they are *parked* at setup, not locked out. Once the DB/Redis recovers, the next session-callback fetch succeeds and the ≤30 s session cache expires, restoring normal routing with no manual intervention. A DB outage degrades the whole app regardless; this change does not make that worse, it only ensures enforcement is not silently dropped meanwhile.
- **Log level (review sec-MIN-2, non-blocking, out of scope for this PR)**: the fetch-failure path keeps the existing `warn` level (INV-3). A sustained occurrence forces tenant-wide fail-closed blocking and is both security-relevant and an availability signal, so operators may want to alert on `auth.session.passkey_data_fetch_failed` at page-worthy thresholds. Changing the log level or wiring alerting is deferred (SC4) — this PR preserves existing logging behavior and does not regress it.
- **No redirect loop**: the passkey-setup page and WebAuthn/auth routes are `isPasskeyExemptPath`, so a fail-closed user reaches setup and is not looped.
- **Scope contract**:
  - SC1 — `derivePasskeyState` / token-issuance gates (M2/M3): already fail-closed; out of scope, owned by the existing fail-closed design.
  - SC2 — display endpoints (M4/M5): not enforcement decisions; out of scope.
  - SC3 — session-cache no-cache signalling: out of scope (Rejected Alternative B).
  - SC4 — raising the fetch-failure log level / wiring page-worthy alerting on `auth.session.passkey_data_fetch_failed`: deferred (review sec-MIN-2); this PR preserves the existing `warn` behavior and does not regress it.

## User operation scenarios

1. Tenant requires passkey; user has a passkey; DB healthy → normal login, no redirect. (happy path)
2. Tenant requires passkey; user has NO passkey; grace expired; DB healthy → redirected to passkey setup. (existing behavior)
3. Tenant requires passkey; user has NO passkey; **DB fetch fails** in session callback → fail-closed: redirected to passkey setup (previously: fail-open, let through). (the fix)
4. Tenant does NOT require passkey; **DB fetch fails** → user is over-blocked to passkey setup for ≤30 s until cache expiry / DB recovery, then normal. (accepted UX cost)

## Implementation Checklist (Phase 2)

Files modified:
- `src/auth.ts` — session-callback `catch` now sets the fail-closed bundle (`requirePasskey=true, hasPasskey=false, requirePasskeyEnabledAt=null, passkeyGracePeriodDays=null`) + keeps the existing warn log. (C1)
- `src/auth.test.ts` — added `describe("session callback — passkey enforcement fail-closed")` with T1 (fail-closed, all four fields + real `passkeyEnforcementBlocks`), T2 (happy-path pass-through), T2b (passkey-holder not blocked), T3 (warn log fired). Added `webAuthnCredential.count` to `mockPrisma`; hoisted stable `mockLoggerWarn` and wired it into the `getLogger` mock (review F5/RT1).

Reused (no reimplementation):
- Real `passkeyEnforcementBlocks` imported from `@/lib/auth/policy/passkey-enforcement` (not mocked, not re-implemented) — RT5.
- Existing `mockWithBypassRls` / `nextAuthInitArgs[0].callbacks.session` topology.

Contract conformance (forbidden patterns): both absent in the diff — `requirePasskey = false` (in catch) and newly-added `throw` in the session callback.

Mutation evidence (RT7/RT8): reverting C1 to `requirePasskey=false` makes T1 fail; verified on the real file then restored (no residue).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | Fail-closed safe-blocking bundle in session-callback catch | locked |
