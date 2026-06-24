# Plan: team config step-up + narrow `/api/teams` Bearer-bypass

## Project context

- **Type**: web app / service (Next.js 16 App Router + TypeScript + Prisma) with iOS + browser-extension clients
- **Test infrastructure**: unit (Vitest, mocked Prisma) + integration (real Postgres) + CI; iOS (XCTest) + extension (Vitest)
- **Verification environment constraints**:
  - `VC1` — The Bearer-bypass narrowing (C4) governs which `/api/teams/*` paths an iOS/extension **Bearer** request can reach. Full end-to-end proof (real iOS app + real extension hitting the live proxy with a real Bearer token) is **blocked-deferred** in local dev: it needs a running app instance + a provisioned device/extension token. Mitigation making this acceptable: the bypass-matcher is a pure string function fully `verifiable-local` via unit tests that assert the exact allow/deny set against the enumerated iOS/extension call paths (evidence captured in this plan). The proxy behavior it feeds (`api-route.ts:83`) is already covered by `src/__tests__/proxy.test.ts`. Anti-Deferral justification: writing a stateful live-proxy integration harness for a pure-function change is disproportionate; the unit matrix pins every real client path. Recorded against VC1; Phase 3 cites it.

## Objective

Close two follow-up security findings from the PR #606 review (merged), addressing each as a **class**, not just the flagged instance:

1. **Step-up asymmetry**: PR #606 added `requireRecentCurrentAuthMethod` to tenant-side sensitive config mutations but not their team-side symmetric counterparts. Apply step-up to the team routes that mirror the tenant routes already gated (webhooks create/delete, policy update) — the same "external-sink / security-policy mutation" class, not ordinary vault CRUD.
2. **Over-broad Bearer-bypass**: `EXTENSION_TOKEN_ROUTES` lists `API_PATH.TEAMS` (`/api/teams`), and `isBearerBypassRoute` prefix-matches, making the *entire* `/api/teams/**` subtree Bearer-bypass-eligible. Narrow it to the minimal set iOS/extension actually call, so a future Bearer-accepting subroute does not silently inherit the bypass.

## Requirements

### Functional
- Team webhook create/delete and team policy update require a recent auth ceremony (after authz, before mutation), matching the tenant-side pattern from PR #606.
- The `/api/teams` Bearer-bypass is narrowed to exactly the paths iOS/extension call with a Bearer token; all other `/api/teams/**` paths are no longer Bearer-bypass-eligible.

### Non-functional
- **No regression to shipping iOS/extension clients.** The narrowing must keep every Bearer-fetched team path working (verified call-path inventory below).
- No change to the happy path: a step-up-verified session continues to succeed; web (session-cookie) callers to any team route are unaffected by the bypass change (they never used the bypass).

## Evidence: Bearer-bypass mechanics + real client call paths (grounds C4)

- **What the bypass does** (`src/lib/proxy/api-route.ts:83-87`): when a request has a Bearer token, no session cookie, and `isBearerRoute` is true, the proxy returns `NextResponse.next()` early, **skipping the `API_SESSION_REQUIRED` session-validation gate** (lines 105-131). A Bearer request to a path NOT in the bypass list falls through to line 105, finds no valid cookie session, and **401s at the proxy before reaching the handler**. Handlers still enforce auth themselves via `checkAuth`/`authOrToken` + scope; the bypass only decides *reachability* for cookieless Bearer requests.
- **Real Bearer call paths (the minimal set that MUST stay allowed)** — from iOS `ios/Shared/Network/APIPath.swift` + `MobileAPIClient.swift`, and extension `extension/src/background/index.ts` + `lib/api-paths.ts`:
  1. `GET /api/teams` — team list (iOS `HostSyncService`, extension)
  2. `GET /api/teams/<teamId>/member-key` (± `?keyVersion=`) — wrapped team key (iOS, extension)
  3. `GET /api/teams/<teamId>/passwords` — team entry list (iOS, extension)
  4. `GET /api/teams/<teamId>/passwords/<entryId>` — **single team entry (CHILD path)** — extension `fetchAndDecryptTeamBlob` (`index.ts:1305`)
  - All four handlers are Bearer-aware: `teams` GET (`route.ts:20`), `passwords` GET (`route.ts:24`), `passwords/[id]` GET (`route.ts:25`), `member-key` GET (`route.ts:16`) all call `checkAuth(req, { scope: PASSWORDS_READ })`.
  - **Decisive nuance**: path #4 means `passwords` needs **prefix** allow (children included), NOT exact. A `passwords|member-key`-exact regex would 401 the extension's per-entry fetch — an over-narrowing regression.
- **Paths that must be EXCLUDED** (no Bearer client; web-session-only; currently inherit the bypass): `/api/teams/<id>/webhooks`, `/api/teams/<id>/policy`, `/api/teams/<id>/members`, `.../invitations`, `.../tags`, `.../folders`, `.../rotate-key`, `.../audit-logs`, `/api/teams/<id>` (PUT/DELETE), etc. — all use `auth()` only; a Bearer request to them today reaches the handler and session-401s there; after narrowing it 401s one layer earlier at the proxy. Same outcome for clients, smaller blast radius.

## Contracts

### C1 — step-up gate on team webhook create
- **File**: `src/app/api/teams/[teamId]/webhooks/route.ts` — `handlePOST`
- **Change**: insert `const stepUpError = await requireRecentCurrentAuthMethod(req); if (stepUpError) return stepUpError;` after the `requireTeamPermission(...TEAM_UPDATE..., req)` try/catch (~line 90), before `parseBody`/the `teamWebhook.create`. Add `import { requireRecentCurrentAuthMethod } from "@/lib/auth/session/recent-current-auth-method";`.
- **Invariants** (app-enforced): step-up runs after authz, before the create mutation; `req: NextRequest` in scope (confirmed).
- **Acceptance**: non-recent session → step-up Response, `teamWebhook.create` NOT called; recent session → existing 201 behavior.

### C2 — step-up gate on team webhook delete
- **File**: `src/app/api/teams/[teamId]/webhooks/[webhookId]/route.ts` — `handleDELETE`
- **Change**: insert the gate after the `if (!webhook) return notFound();` existence check (~line 41), before `teamWebhook.delete`.
- **Acceptance**: non-recent session → step-up Response, `teamWebhook.delete` NOT called.

### C3 — step-up gate on team policy update
- **File**: `src/app/api/teams/[teamId]/policy/route.ts` — `handlePUT`
- **Change**: insert the gate **immediately after the `requireTeamPermission(...)` try/catch, before `parseBody` and the `team.findUnique` existence lookup** (mirrors the tenant `policy` PATCH order — step-up before body parse / DB work; review S3). The existing `if (!teamTenant) return notFound();` still runs after the gate.
- **Acceptance**: non-recent session → step-up Response, `teamPolicy.upsert` NOT called, AND `parseBody` / the `team.findUnique` lookup not reached (gate is the first thing after authz).

### C5 — step-up gate on team member role change (review S2: tenant-symmetric counterpart)
- **File**: `src/app/api/teams/[teamId]/members/[memberId]/route.ts` — `handlePUT` (role change, `TEAM_PERMISSION.MEMBER_CHANGE_ROLE`)
- **Rationale**: the direct symmetric counterpart of `tenant/members/[userId]` PUT, which PR #606 gated. A role elevation to OWNER/ADMIN changes the team's authorization surface (key-access via `requireTeamPermission`); same risk class as the tenant member role change already gated. (Team member DELETE has no tenant counterpart — `tenant/members/[userId]` has only PUT — so it stays in SC1.)
- **Change**: insert `const stepUpError = await requireRecentCurrentAuthMethod(req); if (stepUpError) return stepUpError;` **immediately after the `requireTeamPermission(...MEMBER_CHANGE_ROLE...)` try/catch (~line 63), before the `teamMember.findUnique` existence lookup (~line 65)** — matching the exact ordering of its direct counterpart `tenant/members/[userId]` PUT (step-up before existence), which closes the membership-existence oracle (review S-R2-N1: returning 404-if-absent / 403-if-present before step-up leaks existence to a non-recently-authed caller). The gate still dominates `parseBody` and both mutation branches (OWNER-transfer + regular role-change). `req` in scope (confirmed, line 45).
- **Invariants** (app-enforced): step-up after authz + existence, before the member-update write; `req` in scope.
- **Acceptance**: non-recent session → step-up Response, the member-role-update mutation NOT called.

### C4 — narrow the `/api/teams` Bearer-bypass to the real client set
- **File**: `src/lib/proxy/cors-gate.ts`
- **Change**: remove `API_PATH.TEAMS` from the broad-prefix arm of `EXTENSION_TOKEN_ROUTES`/`isBearerBypassRoute` and replace with a dedicated team-path matcher allowing ONLY:
  - `/api/teams` (exact) — list
  - `/api/teams/<teamId>/member-key` (exact, one dynamic segment) — wrapped key
  - `/api/teams/<teamId>/passwords` and `/api/teams/<teamId>/passwords/<...>` (prefix — children included) — entry list + single entry
  Everything else under `/api/teams/**` returns false.
- **Signature**: a pure helper, e.g. `function isBearerBypassTeamPath(pathname: string): boolean`, called from `isBearerBypassRoute`. Implementation may be a single anchored regex OR a segment-aware matcher — chosen at implementation time; the acceptance matrix below is the contract, not the regex literal.
- **Invariants** (app-enforced): the matcher returns `true` for exactly the 4 real client path shapes (incl. `passwords` children) and `false` for every other `/api/teams/*` path. Query strings are already stripped from `pathname` by the proxy (`nextUrl.pathname`).
- **Forbidden patterns**:
  - `pattern: API_PATH\.TEAMS,` in `EXTENSION_TOKEN_ROUTES` array — reason: the broad team prefix must be gone from the generic list after C4 (it moves into the dedicated matcher).
- **S1 — passwords-child forward-risk note (locked constraint, not a behavior change)**: the `passwords` prefix arm makes mutating children (`passwords/bulk-import`, `empty-trash`, `bulk-trash`, `bulk-archive`, `bulk-restore`, `[id]` PUT/DELETE) Bearer-*reachable* at the proxy. This is SAFE today because every such handler is `auth()`-only (session) and 401s a cookieless Bearer at the handler. The prefix is kept (not single-segment-restricted) because `passwords/<entryId>` and `passwords/bulk-import` are both single-segment — no clean structural split, and an exclusion list is fragile. **Locked constraint**: none of these mutating `passwords` children may be migrated to `checkAuth` with a write scope (`PASSWORDS_WRITE` / `TEAM_PASSWORDS_WRITE`) without simultaneously narrowing this matcher — doing so would make them Bearer-WRITABLE. Add as a code comment at the matcher AND a grep-able marker. Tracked: `TODO(team-config-stepup): if any teams/*/passwords mutating child gains checkAuth write scope, narrow isBearerBypassTeamPath (S1)`.
- **Acceptance matrix** (the locked contract — every row is a unit assertion in C4's test):
  | pathname | expected | reason |
  |---|---|---|
  | `/api/teams` | allow | list (iOS+ext) |
  | `/api/teams/t1/member-key` | allow | wrapped key (iOS+ext) |
  | `/api/teams/t1/passwords` | allow | entry list (iOS+ext) |
  | `/api/teams/t1/passwords/e1` | allow | single entry (ext `teamPasswordById`) |
  | `/api/teams/t1/passwords/bulk-import` | allow | child of passwords (acceptable — `auth()`-only handler session-gates a Bearer; see S1 locked constraint). `bulk-purge`/`bulk-trash`/`bulk-archive`/`bulk-restore`/`empty-trash` are the same class, same allow+constraint. |
  | `/api/teams/t1/webhooks` | **deny** | web-only sensitive config |
  | `/api/teams/t1/policy` | **deny** | web-only |
  | `/api/teams/t1/members` | **deny** | web-only |
  | `/api/teams/t1` | **deny** | team CRUD, web-only |
  | `/api/teams/t1/member-key/extra` | **deny** | member-key is leaf-exact |
  | `/api/teams-export` | **deny** | sibling-collision guard (no `teams` + `/` boundary) |
- **Consumer-flow walkthrough**: the consumer is `isBearerBypassRoute` (same file) → `api-route.ts:83`. It reads only the boolean. No shape change. The downstream effect (allow→reach handler / deny→proxy 401) is covered by `proxy.test.ts`.

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | step-up on team webhook POST | locked |
| C2 | step-up on team webhook DELETE | locked |
| C3 | step-up on team policy PUT | locked |
| C4 | narrow `/api/teams` Bearer-bypass to real client set (incl. passwords children) | locked |
| C5 | step-up on team member role change PUT (tenant-symmetric, review S2) | locked |

## Testing strategy

- **C1–C3, C5** (mocked unit, per route + the centralized policy test): add a hoisted `mockRequireRecentSession` (default `mockResolvedValue(null)` pass-through) + `vi.mock("@/lib/auth/session/recent-current-auth-method", () => ({ requireRecentCurrentAuthMethod: mockRequireRecentSession }))`. Add a reject test per handler asserting status 403 AND the mutation spy (`mockPrismaTeamWebhook.create` / `.delete` / `mockPrismaTeamPolicy.upsert` / the member-update spy) `.not.toHaveBeenCalled()`. Mirror `src/app/api/tenant/webhooks/route.test.ts` step-up reject (`mockResolvedValueOnce(Response.json({error:"SESSION_STEP_UP_REQUIRED"},{status:403}))`).
  - **R19 — exact files needing the mock (enumerated, review T3 — prevents the PR #606 tenant-policy.test.ts recurrence)**: the 4 route-level test files (`teams/[teamId]/webhooks/route.test.ts`, `.../webhooks/[webhookId]/route.test.ts`, `.../policy/route.test.ts`, `.../members/[memberId]/route.test.ts`) — none currently mock the helper — PLUS the centralized **`src/__tests__/api/teams/team-policy.test.ts`** (imports the policy `PUT`; confirmed no step-up mock; all its PUT tests 401 without the pass-through). The webhook + member routes have NO centralized test (verified). Add the pass-through mock to all 5.
  - **Non-vacuous reject setup (review T4 + R2 T-R2-1/2/3)**: each reject test MUST drive PAST authz + existence so the 403 is genuinely from step-up, not a 404/403-from-prior-gate. Concretely:
    - C2 reject: `mockPrismaTeamWebhook.findFirst.mockResolvedValue({ id, url, ... })` (else 404 before the gate); assert `mockPrismaTeamWebhook.delete` not called.
    - C3 reject: `team.findUnique` mock returns a row; assert `mockPrismaTeamPolicy.upsert` not called.
    - C5 reject: because step-up now fires **before** the existence lookup (C5 ordering), the reject test does NOT need `findUnique` to return a row — `mockRequireTeamPermission` passes, step-up returns 403, and the handler returns before `findUnique`. Assert **both** mutation spies not called: `mockPrismaTeamMember.update` (regular role-change) AND `mockTransaction` (owner-transfer) — the gate dominates both branches. (The C5 *happy-path* tests still need `findUnique` to return a non-OWNER row + body `{ role: TEAM_ROLE.ADMIN }` as before — those are the existing passing tests, unaffected once the pass-through mock is in `beforeEach`.)
    - All reject tests set `mockRequireTeamPermission` to pass.
  - **Happy-path (review T5)**: once the pass-through mock is in `beforeEach`, the existing success tests (create-201 / delete-200 / put-200) ARE the happy-path regression guard proving the gate doesn't break success. No new happy-path test needed; state this so the implementer adds the mock to `beforeEach`, not per-test.
- **C4** (mocked unit on the matcher — `src/lib/proxy/cors-gate.test.ts`, the EXISTING truth-table file; extend its `CASES` array): add ALL 11 Acceptance-matrix rows as explicit assertions (review T2 — the file currently has only the 3 `allow` rows; the 8 others incl. every `deny` row are absent). The load-bearing rows: `passwords/e1` → allow (fails on over-narrow regex), `passwords/bulk-import` → allow, `webhooks`/`policy`/`members`/`teams/t1` → deny (fail on the current broad prefix), `member-key/extra` → deny (leaf-exact), `teams-export` → deny (sibling collision).
- **C4 proxy-level (review F1/T1/T6)** — `src/__tests__/proxy.test.ts`: (a) update the existing line-206 test whose description (`"does NOT bypass for Bearer + /api/teams (not in allowlist)"`) is now misleading — it 401s only because it sends a session Cookie alongside Bearer (the N2 cookie+Bearer guard); rename to reflect the N2 reason. (b) ADD positive cookieless-Bearer bypass tests for the 4 real client paths (`/api/teams`, `/api/teams/t1/passwords`, `/api/teams/t1/passwords/e1`, `/api/teams/t1/member-key`) → reach handler (no proxy 401), AND a deny test for `/api/teams/t1/webhooks` (cookieless Bearer → proxy 401). Without these, a broken `isBearerBypassTeamPath` wiring silently 401s every client with no proxy-level test catching it.
- **Mandatory**: `npx vitest run`, `npx next build`, all `check:*` gates, `scripts/pre-pr.sh`.

## Considerations & constraints

### Scope contract
- `SC1` — **team-specific high-privilege ops WITHOUT a tenant-symmetric counterpart** are OUT of scope: `rotate-key` POST (key custody — no tenant analog) and team `DELETE` (destroys all team vault data, attachment blobs, team key material — higher-impact than any gated route, but no tenant counterpart since tenants are not deleted via this API). `members/[memberId]` **DELETE** (member removal) also stays out — `tenant/members/[userId]` has only PUT, no DELETE, so there is no symmetric precedent. NOTE (review S2): `members/[memberId]` **PUT** (role change) WAS initially scoped out here on a "no counterpart" basis — that was wrong (`tenant/members/[userId]` PUT is gated in #606); it is now **in scope as C5**. Tracked: `TODO(team-config-stepup): evaluate step-up for rotate-key / team-DELETE / member-DELETE — team-DELETE is the highest-impact (bulk vault + key-custody destruction) (SC1)`.
- `SC2` — **other `/api/teams/*` web-only routes losing Bearer-bypass** is the *intended* effect of C4, not a regression: they were never Bearer-reachable in practice (handlers are `auth()`-only and session-401 a Bearer today). C4 just moves the 401 to the proxy. Not deferred — it is the fix.
- `SC3` — the broader question "should step-up be a centralized operation-sensitivity guard instead of per-handler" (raised as SC2 in PR #606) remains OUT of scope; this PR continues the enumerate-and-cover approach.

### Known risks
- **Over-narrowing C4** is the primary risk — mitigated by the verified call-path inventory (esp. the `passwords/<entryId>` child path the extension uses). The Acceptance matrix pins it.
- **project memory `project_bearer_route_proxy_gate`**: new Bearer routes must be IN the bypass list. C4 narrows but keeps all 4 real client paths; the matcher's `passwords` prefix arm leaves room for future per-entry password subroutes without re-widening to all of `/api/teams`.
- R19 mock omission in team test files (and centralized ones) is the most likely Phase-2 failure — flagged in the testing strategy.

## User operation scenarios

1. **Hijacked non-step-up team admin** creates a team webhook (external sink + secret) → step-up required, no create. (C1)
2. **Legit recently-authed team admin** deletes a team webhook / updates team policy → succeeds. (C2/C3 happy path)
3. **iOS app** syncs: `GET /api/teams` → `/api/teams/<id>/member-key` → `/api/teams/<id>/passwords` with a Bearer token → all reach handlers and succeed (C4 allow rows).
4. **Extension** fetches a single team entry `GET /api/teams/<id>/passwords/<entryId>` with Bearer → reaches handler (C4 `passwords` child allow).
5. **Bearer request to `/api/teams/<id>/webhooks`** → 401 at the proxy (C4 deny); web session user is unaffected.
6. **Hijacked non-step-up team admin** promotes a member to OWNER (ownership transfer) → step-up required, no role change. (C5)
