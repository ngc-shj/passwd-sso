# Plan: favicon-proxy-optin (Web)

## Project context

- **Type**: web app (Next.js 16 App Router + TypeScript + Prisma 7 + PostgreSQL + Redis)
- **Test infrastructure**: unit + integration (vitest) + CI/CD. `next build` mandatory per CLAUDE.md.
- **Verification environment constraints**:
  - **VEC1** — Outbound favicon fetch to real third-party origins (e.g. `https://www.google.com/s2/favicons`) requires live internet from the dev/CI host. CI runners may have egress restrictions. The favicon *fetch path* against a real remote is `blocked-deferred` for deterministic unit tests → unit tests mock `validateAndFetch`; one manual-test step (`verifiable-local`) exercises a real fetch. Cost-justification: mocking the outbound fetch is the standard pattern already used by HIBP route tests; a real-egress integration test would be flaky and is not worth the maintenance cost (Worst case: a provider URL typo ships; Likelihood: low — covered by manual-test M3; Cost-to-fix if missed: one-line URL edit).
  - **VEC2** — SSRF guard (`resolveAndValidateIps`) does DNS resolution; behavior against a hostname that resolves to a private IP is `verifiable-local` only with a controlled DNS fixture. Reuse existing `external-http` test patterns; do not build new DNS infra.

## Objective

Replace the browser's direct fetch of `https://www.google.com/s2/favicons` with a **server-side favicon proxy** that the app fetches through, and gate favicon fetching behind a **per-user opt-in preference defaulting to OFF**. When the preference is OFF (default), entries render the existing fallback icon (`Globe` / type-specific SF-symbol-style lucide icon) and **no host name leaves the client to any third party or to the server's favicon path**.

### Why (privacy rationale — drives the whole design)

`urlHost` lives inside the E2E-encrypted `encryptedOverview` blob; the server never sees it in plaintext. The current `Favicon` component sends that host directly to Google from the browser on every list render. That hands the user's full list of stored services to a third party — re-exposing exactly what E2E encryption was designed to hide. The proxy keeps host names inside the trust boundary the user already accepts (their own server), and the opt-in default ensures that even the server's favicon-access log is only populated for users who explicitly accept it.

## Requirements

### Functional
- A server route accepts a host, returns favicon image bytes (or a deterministic fallback), fetched server-side and cached.
- The `Favicon` component requests the proxy route instead of Google, **only when** the user's `fetchFavicons` preference is ON.
- When the preference is OFF, `Favicon` renders the `Globe` fallback without any network request.
- A settings toggle lets the user turn favicon fetching ON/OFF; default OFF.
- Existing per-entry-type icon dispatch (`EntryIcon`) is unchanged — only the LOGIN/URL → `Favicon` leaf changes.

### Non-functional
- No host name reaches any third party from the browser (the browser only ever talks to the app's own origin).
- The proxy MUST be SSRF-safe (reuse `validateAndFetch` from `src/lib/http/external-http.ts`).
- The proxy MUST be rate-limited per user (reuse `createRateLimiter`).
- Favicon responses cached server-side (Redis when available, in-memory fallback) with a TTL.
- List rendering must not regress: many rows fetch favicons; requests must be cancelable/cacheable by the browser (HTTP cache headers on the proxy response).

## Technical approach

- **Provider behind the proxy**: the proxy server fetches the upstream favicon. Keep the upstream provider configurable via a single server-side constant. **The default provider URL MUST be a non-redirecting endpoint** — see the redirect constraint below. The browser never contacts the provider; only the server does. This isolates the provider choice to one server-side location and lets a future change swap providers without touching the client.
- **Redirect constraint (blocking design decision — verified)**: the shared SSRF helper `validateAndFetch` (`src/lib/http/external-http.ts:175`) hardcodes `redirect: "error"` (its docstring is literally "redirect blocking") — it **rejects on any 3xx**. The classic `https://www.google.com/s2/favicons?domain=...` endpoint **always 301-redirects** to `t1.gstatic.com/faviconV2` (verified live), so routing it through `validateAndFetch` would throw on every request and the proxy would return its failure fallback 100% of the time — the feature would render no icons (R41). Two valid resolutions; **this plan picks (A)**:
  - **(A, chosen)** Point the default provider constant at the **already-final, non-redirecting** Google endpoint `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=<n>&url=https://<host>`. Implementer MUST verify (manual-test M3) it returns 200 + image bytes directly with no 3xx; then `validateAndFetch` works unmodified and the SSRF guard stays intact. `t1.gstatic.com` resolves to public IPs, so it passes `resolveAndValidateIps`.
  - **(B, NOT chosen — recorded so it is not reached for under time pressure)** Extending `validateAndFetch` with `redirect: "follow"` is **FORBIDDEN** by this plan: the pinned dispatcher only validates/pins the *first* hop's IPs; a followed redirect re-resolves the new origin **unpinned**, so a redirect to `http://169.254.169.254/` (cloud metadata) or any private IP bypasses the SSRF guard entirely. If a future provider genuinely requires redirects, that is a separate plan that adds a bounded redirect mode re-running `resolveAndValidateIps` + re-pinning on EVERY hop (cap 2–3) with a golden test that a redirect to a metadata/loopback IP is rejected mid-chain. Do NOT inline `redirect: "follow"`.
- **Preference storage**: add `fetchFavicons Boolean @default(false)` to the `User` model (a new boolean column alongside `User.locale`). Surfaced to the client via the live `session()` callback (C5 — NOT the locale path, which is server-read-only) and toggled through a new `PUT /api/user/favicon-pref` route (route-handler shape mirrors `PUT /api/user/locale`).
- **Route placement + classification (corrected)**: `/api/user/favicon` (GET, image bytes) and `/api/user/favicon-pref` (PUT, toggle). **There is NO broad `/api/user` session-required prefix** — `SESSION_REQUIRED_PREFIXES` (`route-policy.ts:54-76`) lists only specific paths (`USER_LOCALE`, `USER_MCP_TOKENS`, `USER_AUTH_PROVIDER`). A new `/api/user/favicon*` route would otherwise fall through to `API_DEFAULT`, which means the proxy would **not** run `getSessionInfo` and — critically — would **not** run `checkAccessRestrictionWithAudit` (tenant IP allowlist enforcement, `api-route.ts:116-130`). See **C8**: both new paths MUST be registered in `SESSION_REQUIRED_PREFIXES` so they get the proxy session gate + tenant IP restriction. Do NOT add to `EXTENSION_TOKEN_ROUTES` (favicons are account-level UX, not extension-token traffic).
- **Caching key**: `favicon:<normalizedHost>:<size>` in Redis; value is the image bytes + content-type, TTL ~7 days. In-memory `Map` fallback with size cap + TTL eviction (mirror HIBP route's cache pattern). **Host normalization (strict allowlist — S8/S9 VERIFIED gap)**: lowercase, strip a leading `www.`, then require the result to match `^[a-z0-9.-]+$` (length ≤253, per DNS) — **reject everything else**, including `& ? # % @ / : \\`, whitespace, and scheme. Rationale: the host is interpolated into the upstream `url=https://<host>` query param; a host like `github.com&size=16` would otherwise **smuggle attacker-controlled params into the gstatic request** (defeating the C2 `size` whitelist) and **pollute the cache key** (`new URL("https://github.com&size=16").hostname` keeps the `&` — verified). The strict `[a-z0-9.-]` allowlist is fail-closed and subsumes the old `/:`+whitespace bans. Additionally reject IP-literal hosts (`net.isIP(host) !== 0`) so a future direct-host provider swap (SC3) cannot reintroduce SSRF via the inner host. Define this as a single helper reused by C2 — the cache key and the validated host MUST derive from the same normalized value.
- **Reused helpers (exact import paths, R1/R2)**: `validateAndFetch` from `@/lib/http/external-http` (`src/lib/http/external-http.ts`); `createRateLimiter` from `@/lib/security/rate-limit` (`src/lib/security/rate-limit.ts`); `getRedis` from `@/lib/redis`; `parseBody` + `unauthorized`/`rateLimited` response helpers as used by `/api/user/locale` and `/api/watchtower/hibp`; `withUserTenantRls` for the preference write.
- **HTTP cache headers on the proxy 200 response**: `Cache-Control: private, max-age=86400` (per-user, browser-cached so list re-renders and scroll don't refetch) and a weak `ETag` derived from the cached bytes; 204 responses get `Cache-Control: private, max-age=3600` so a missing favicon isn't retried on every render.
- **Fallback on upstream failure**: if upstream fetch fails / times out / returns non-image / returns a 3xx, the proxy returns **204 No Content** (chosen over a 1×1 transparent pixel so the client `Favicon` `onError`/empty-body path falls back to `Globe` rather than rendering a blank box).

## Contracts

### C1 — `User.fetchFavicons` preference column
- **Schema**: `prisma/schema.prisma` — add to `User` model:
  `fetchFavicons Boolean @default(false)`
- **Invariant** (schema-enforced): column NOT NULL with default `false`; a user with no explicit choice never fetches favicons. Chosen schema-enforced over app-default because a forgotten read path must fail closed (privacy-safe) by construction.
- **Migration**: additive, non-breaking — new column with a default; existing rows backfill to `false` automatically. Single migration is safe here because the column is **additive with a default** (R24 split rule applies to *required-without-default* columns; this is not one). No consumer breaks: code that doesn't read the column is unaffected; code that reads it sees `false` until the user opts in.
- **Forbidden patterns**:
  - `pattern: fetchFavicons\s+Boolean(?!.*@default\(false\))` — reason: the column must default false (fail-closed privacy default).
- **Acceptance**: `prisma migrate` applies cleanly on a populated dev DB; `SELECT fetchFavicons FROM "User"` returns `false` for all pre-existing rows.

### C2 — Favicon proxy route `GET /api/user/favicon`
- **Signature**: `GET /api/user/favicon?host=<string>&size=<32|64>` → `Response`
  - 200 with `Content-Type: image/*` + body = favicon bytes on success
  - 204 No Content when upstream has no favicon / fetch fails / times out / non-image content-type / upstream returns a 3xx (client falls back to `Globe`)
  - 400 when `host` missing/malformed or `size` not in the allowed **enum** `{32, 64}`
  - 401 when no session (proxy gate after C8; handler also calls `auth()` defensively)
  - 403 when the user's `fetchFavicons` preference is OFF (server-side enforcement of the privacy contract — see rationale below)
  - 429 when rate limit exceeded → `rateLimited(retryAfterMs)`
- **`size` allowed set**: `{32, 64}` only, enforced as a **literal whitelist** (`z.enum(["32","64"])` or `Set.has`), NOT `parseInt` + range (RS5 — prevents resource amplification and cache-key cardinality explosion). The client maps its render size to one of these two **buckets** (NOT `renderPx * 2` directly — see C3/F6): `renderPx * 2 <= 32 ? 32 : 64`. The two-bucket set keeps cache cardinality low while covering all real render sizes.
- **Invariants**:
  - (app-enforced) Every upstream fetch goes through `validateAndFetch` (SSRF guard) — never raw `fetch` against the host-derived URL; redirects are NOT followed (a 3xx from upstream surfaces as the 204 fallback, never a second hop).
  - (app-enforced) `host` passes the shared **strict-allowlist** normalization helper (`^[a-z0-9.-]+$` after lowercase + `www.` strip, ≤253, reject IP literals — see Technical approach / S8) before being used to build the upstream URL AND the cache key — the SAME normalized value feeds both, so the guard and the cache cannot disagree, and `& ? # % @` cannot smuggle params into the upstream `url=` or pollute the cache key.
  - (app-enforced) Response is cached under `favicon:<normalizedHost>:<size>` before return; cache consulted before any upstream fetch. **Shared cache key is intentional and correct** — favicons are public, no per-user namespacing (per-user keys would defeat the cache and increase outbound provider exposure); the cached bytes carry no per-user secret (S5 confirmed no cross-user confidentiality leak).
  - (app-enforced) **Per-entry stored-byte cap**: reject/skip caching any upstream body larger than a fixed cap (e.g. 256 KB — a favicon is normally <100 KB; the cap bounds the memory-amplification surface, S5). Over-cap → treat as 204.
  - (app-enforced) The handler returns 403 when `user.fetchFavicons === false`. **Rationale (corrected per S4)**: this is NOT an "oracle" defense (an opted-out client never sends the host). It enforces the privacy contract *server-side* so that a rogue / stale-tab / buggy / extension-injected client that sends the host anyway still cannot cause an outbound provider fetch, an access-log entry, or a cache population for a user who has opted out. The OFF preference's privacy guarantee holds regardless of client behavior.
- **Burst / stampede handling**: (1) **browser HTTP cache** (`Cache-Control`/`ETag` below) — a host already fetched is not re-requested on re-render/scroll; (2) **server cache-first** — concurrent requests for the same host short-circuit to cached bytes after the first upstream fetch; (3) **required single-flight dedup** (security-relevant per S3, NOT optional): N concurrent cache-misses for the same normalized host MUST trigger exactly ONE upstream fetch, not N — otherwise an authenticated user becomes an outbound-fan-out amplifier; (4) **per-user rate limiter** `createRateLimiter({ windowMs, max })` keyed `rl:favicon:<userId>` — `max` chosen to exceed a realistic on-screen row count (≈120/window) so first-paint of a large list isn't throttled; (5) **global outbound budget** (per S3) — a SECOND limiter keyed `rl:favicon:global` with a ceiling well above aggregate legitimate traffic, so one account (or colluding accounts) cannot turn the server into an outbound scanner / cache-flooder via attacker-chosen distinct hosts. Both limiters **fail-open** (do NOT set `failClosedOnRedisError` — a cosmetic feature must not 503 on a Redis blip; matches the HIBP precedent). **Caveat (S10)**: the global budget is exact only while Redis is up; on a Redis outage `createRateLimiter` falls back to a per-process in-memory `Map`, so the "global" ceiling degrades to per-process (×N instances). This is the accepted fail-open posture for a cosmetic feature — do not overclaim it as an absolute aggregate ceiling.
- **Forbidden patterns**:
  - `pattern: redirect:\s*["']follow["']` in `src/app/api/user/favicon/route.ts` and `src/lib/http/external-http.ts` — reason: following redirects re-opens SSRF (the pinned dispatcher only validates the first hop). See Redirect constraint.
  - `pattern: fetch\((?:`|")https?://` in `src/app/api/user/favicon/route.ts` — reason: outbound favicon fetch must go through `validateAndFetch`, not raw `fetch`.
  - `pattern: google\.com/s2/favicons` in `src/components/` — reason: no client component may contact the provider directly after this change.
- **Acceptance**: M3 (manual test) confirms the chosen non-redirecting upstream returns real bytes; unit tests cover 200/204/400/403/429 + cache-hit single-fetch (see Testing strategy).

### C3 — `Favicon` component points at the proxy and respects the preference
- **Signature**: `Favicon({ host, size, className }: FaviconProps)` — **props unchanged** (`host`/`size`/`className`). The preference is read INTERNALLY via `useSession()` (`session.user.fetchFavicons`, C5), NOT threaded through props.
- **Three render states** (F3 — the loading state must be distinguished from resolved-OFF):
  - `useSession().status === "loading"` (preference not yet known on first client paint): render a **neutral sized placeholder** (empty box of `size`px), NOT the `Globe` and NOT an `<img>`. This avoids a list-wide globe→favicon flicker for opted-in users on every page load.
  - resolved **OFF** (`status` resolved AND `fetchFavicons !== true`): render `Globe`, **no `<img>` emitted**.
  - resolved **ON** (`fetchFavicons === true`): render `<img src="/api/user/favicon?host=<host>&size=<bucket>">`, `onError` → `Globe` fallback retained.
- **Retina sizing + bucket-snapping (F5/F6 — VERIFIED gap)**: the `<img>` width/height stay at the true render `size`, but the proxy `size` query snaps to a bucket: `const proxySize = renderPx * 2 <= 32 ? 32 : 64`. This is required because the real call sites render at **four** distinct sizes, not just 16/32 — verified: `entry-icon.tsx:27` default 16, `password-row.tsx:204` 16, `login-section.tsx:91` **12**, `password-card.tsx:517` **20**, `password-detail-pane.tsx:158` **28** (via EntryIcon). A naive `renderPx*2` would produce 24/40/56 → C2's 400 → globe in the detail pane, card grid, and login section for opted-in users. Bucket-snapping maps {12,16}→32 and {20,28}→64, all valid. The fetched bitmap resolution snaps to a bucket; the rendered box stays at the true px (still sharp on HiDPI since the bitmap is ≥ the CSS px). This is why C2's allowed set is exactly `{32, 64}`.
- **Invariants**:
  - (app-enforced) When the preference is **resolved-OFF**, the component emits NO `<img>` element (asserted in tests) — guarantees zero network request and zero host leakage. (The `loading` placeholder also emits no `<img>`, so the privacy invariant "no img unless resolved-ON" holds across both non-ON states.)
  - (app-enforced) `<img src>` is a same-origin relative path (`/api/user/favicon?...`), never an absolute third-party URL.
- **`referrerPolicy` (F4)**: now that `src` is same-origin, `referrerPolicy="no-referrer"` no longer prevents any third-party referer leak (there is no third party). Keep it as inert defense-in-depth OR drop it — implementer's choice; do NOT document it as an active privacy control.
- **Forbidden patterns**:
  - `pattern: www\.google\.com` in `src/components/passwords/shared/favicon.tsx` — reason: provider URL must be removed from the client.
  - `pattern: t1\.gstatic\.com` in `src/components/` — reason: the upstream provider (including the redirect-final form) lives ONLY server-side; no client component may name it.
- **Consumer-flow walkthrough**:
  - Consumer `EntryIcon` (path: `src/components/passwords/detail/entry-icon.tsx`) reads `{ host }` (passed as `urlHost`) and renders `<Favicon host={urlHost} size={size} />` for LOGIN/URL types. Unchanged — `EntryIcon` only forwards `urlHost`; it does not read the preference itself.
  - Consumer `login-section.tsx`, `password-card.tsx`, `password-row.tsx` (via `EntryIcon`), `password-detail-pane.tsx` (via `EntryIcon`) — all render `Favicon`/`EntryIcon` with a `urlHost`. None construct the favicon URL themselves; all rely on `Favicon` to read the preference and build the same-origin URL. **No consumer needs a field absent from the contract** — they already pass `host`; the preference is read inside `Favicon` from C5's context, not threaded through props.

### C4 — Preference toggle route `PUT /api/user/favicon-pref`
- **Signature**: `PUT /api/user/favicon-pref` body `{ fetchFavicons: boolean }` → `Response`
  - 200 `{ fetchFavicons: boolean }` on success
  - 400 on schema violation. **Schema MUST be `z.strictObject({ fetchFavicons: z.boolean() })` (or `z.object({...}).strict()`)** — a plain `z.object` SILENTLY STRIPS unknown keys rather than rejecting them (Zod 4 behavior, verified by T2), which would make the "reject unknown fields" contract untestable/false. `.strict()` is required for the unknown-field rejection to actually fire (and to be assertable as a 400).
  - 401 when no session
- **Invariants**:
  - (app-enforced) Body validated via `parseBody(req, strictSchema)` (mirrors `/api/user/locale`, but with `.strict()`); write scoped via `withUserTenantRls(session.user.id, ...)`.
- **Forbidden patterns**:
  - `pattern: req\.json\(\)` in `src/app/api/user/favicon-pref/route.ts` — reason: must use `parseBody` cap helper (CI-enforced body-cap contract), not raw `req.json()`.
- **Consumer-flow walkthrough**:
  - Consumer = the settings toggle UI (C6). It reads the current `fetchFavicons` from the session-derived preference (C5), and on toggle issues `PUT /api/user/favicon-pref` with `{ fetchFavicons }`, then triggers a client-side preference refresh so open `Favicon` components re-render. Required field `fetchFavicons` is present in the response.

### C5 — Preference exposure to the client (RESOLVED — live session callback; CORRECTED per F2)
- **Decision**: expose `fetchFavicons` on `session.user`, matching `hasPasskey` / `requirePasskey`. **The session data path is LIVE-DB, not cache-fed** (F2, verified): `src/auth.ts`'s `session({ session, user })` callback runs a `withBypassRls` `tx.user.findUnique` on *every* invocation, and `SessionSync` (`src/components/providers/session-provider.tsx:24-27`) calls `update()` on *every navigation*. There is no `session-cache.ts` TTL between this callback and `session.user`. Two files change (NOT three):
  1. `src/types/next-auth.d.ts` — add `fetchFavicons?: boolean` to the `Session.user` interface.
  2. `src/auth.ts` — add `fetchFavicons: true` to the existing `tx.user.findUnique` `select` in the session callback (~line 401-410, alongside the tenant passkey select), and include `fetchFavicons` in the returned `user` object (~line 446).
  - **Do NOT touch `src/lib/auth/session/session-cache.ts`** — its `SessionInfo` is a separate minimal projection consumed only by the proxy gate; it does not feed `session.user`. Adding the field there would be dead, and if a future consumer read from it, it WOULD introduce the very TTL-staleness the earlier draft wrongly assumed (F2). Leave it out.
- **Staleness**: none for cross-navigation. After a toggle (C4), the next navigation's `SessionSync.update()` re-runs the live callback and `session.user.fetchFavicons` reflects the new value. The C6 optimistic PUT-response update is a **UX nicety** for instant in-place feedback *without* waiting for a navigation — framed as an optimization, NOT as compensation for a cache window.
- **Invariants**:
  - (app-enforced) The value defaults to `false` on the client when `undefined` (fail-closed — matches the schema default). The `Session.user` field is optional; the consuming component treats `undefined`/`loading` as not-ON (no `<img>`).
  - (R25 persist/hydrate) The DB column is the durable store; `session.user.fetchFavicons` is a live projection (re-read each callback), not a persisted client copy — so there is no write-only/hydrate-gap risk.
- **Acceptance**: toggling then navigating reflects the persisted value via `session.user.fetchFavicons`; a brand-new user sees `undefined` → OFF with no favicon `<img>`; toggling within a session flips icons immediately via the optimistic PUT-response value, and reconciles to the same value on next navigation.

### C6 — Settings toggle UI
- **Signature**: a toggle control in the personal settings area (the profile/preferences page — currently a stub at `src/app/[locale]/dashboard/settings/account/profile/page.tsx`). Label + privacy-explanation footer from i18n (C7).
- **Invariants**:
  - (R26 disabled-state cue) N/A unless the toggle has a disabled state; if it does, pair a visible style.
  - (R28 label grammar) Toggle label form consistent with adjacent toggles in the same settings area (verify against the auto-copy-TOTP-style toggles if any exist on web; enumerate adjacent toggle labels before finalizing).
- **Optimistic update**: on toggle, after `PUT /api/user/favicon-pref` resolves `{ fetchFavicons }`, drive an immediate client re-render of open `Favicon` components from the PUT response value (a UX nicety — full reconciliation comes from `SessionSync` on the next navigation, per C5). If `Favicon` reads only `useSession()`, either call `useSession().update()` after the PUT (forces a session refetch in-place) or wire a lightweight context the toggle sets and `Favicon` reads; pick whichever avoids a stale-until-navigation icon.
- **Acceptance**: toggle reflects current value, flips it via C4, open favicons update without a full reload (optimistic), and the privacy footer explains that enabling favicons sends host names to **your own server** for icon lookup and that the server then fetches the icon from the upstream provider on the user's behalf (no host name goes from the browser to any third party).

### C7 — i18n strings
- **Signature**: add keys under `messages/en/Settings.json` and `messages/ja/Settings.json` for the toggle label, the ON/OFF description, and the privacy-explanation footer.
- **Invariants**:
  - (R37 no internal jargon) Strings must not leak `urlHost`, `encryptedOverview`, `s2/favicons`, "proxy" as a raw term users won't parse, etc. Use user-domain language ("site icons", localized appropriately).
  - (ja policy) "vault" → 保管庫 if referenced; favicon → localize as サイトアイコン (no raw English jargon where avoidable).
  - (R27 numeric-in-string) N/A — no numeric limits embedded.
- **Acceptance**: both locale files have parallel keys; `npm run` i18n/build does not report missing keys.

### C8 — Route classification registration (proxy session gate + tenant IP restriction)
- **Signature**: register the two new paths so the proxy classifies them `API_SESSION_REQUIRED`:
  1. `src/lib/constants/auth/api-path.ts` — add `USER_FAVICON: "/api/user/favicon"` and `USER_FAVICON_PREF: "/api/user/favicon-pref"`.
  2. `src/lib/proxy/route-policy.ts` — add BOTH constants to `SESSION_REQUIRED_PREFIXES`. **Both are required** because `pathMatchesPrefix` enforces segment boundaries: `/api/user/favicon-pref` is NOT under the `/api/user/favicon` prefix (the `-pref` suffix breaks the segment match). Registering only `/api/user/favicon` would leave the toggle route at `API_DEFAULT`.
- **Invariants**:
  - (app-enforced) After registration, the proxy runs `getSessionInfo` (session gate, 401 pre-handler) AND `checkAccessRestrictionWithAudit` (tenant IP allowlist) for both routes — matching every other session-required `/api/*` route.
  - (app-enforced) Neither path is added to `EXTENSION_TOKEN_ROUTES` / any Bearer-bypass list.
- **Forbidden patterns**: none new.
- **Acceptance**: a `route-policy.test.ts` case asserts `classifyRoute("/api/user/favicon")` and `classifyRoute("/api/user/favicon-pref")` both return `API_SESSION_REQUIRED` (RT7: this test goes red if a prefix registration is dropped).

## Go/No-Go Gate

| ID | Subject | Status |
|----|---------|--------|
| C1 | `User.fetchFavicons` column (default false) | locked |
| C2 | `GET /api/user/favicon` SSRF-safe (non-redirecting upstream), cached, pref-gated, byte-capped, dual rate-limited proxy | locked |
| C3 | `Favicon` → same-origin proxy; loading/OFF/ON states; OFF+loading emit no img; retina 2× | locked |
| C4 | `PUT /api/user/favicon-pref` toggle route (`.strict()` schema) | locked |
| C5 | Preference via live `session()` callback (NOT session-cache); 2 files | locked |
| C6 | Settings toggle UI + privacy footer + optimistic update | locked |
| C7 | i18n strings (en + ja), no internal jargon | locked |
| C8 | Route classification registration (proxy session gate + tenant IP) | locked |

## Testing strategy

- **C1 migration (T8 — split into two distinct checks)**:
  1. **Executability gate** (manual/CI, per `feedback_run_migration_on_dev_db`): run `npm run db:migrate` against the populated dev DB — a unit test cannot catch a migration that fails to apply on real data.
  2. **Default-false invariant** (integration test, `npm run test:integration`, REAL Postgres — NOT mocked): insert a `User` omitting `fetchFavicons`, read back, assert `=== false`. Do NOT assert the default in a mocked unit test (it would only echo a value the test itself wrote — decorative).
- **C2 route unit tests** (mock `validateAndFetch`, `createRateLimiter`; reset module-singleton cache + limiter in `beforeEach`):
  - **Mock shape (T1)**: `validateAndFetch` returns `Promise<Response>` (verified) — the mock MUST resolve a real `Response`, e.g. `new Response(pngBytes, { headers: { "content-type": "image/png" } })`. The 204 test resolves a `Response` with a non-image `content-type`; a separate test resolves `{ ok: false }`-style / rejects to exercise the failure→204 path; a 3xx-upstream test confirms it maps to 204 (since `redirect:"error"` rejects). Type the mock against `typeof validateAndFetch`.
  - **Cache-hit (T7)**: two sequential requests for the same host assert `expect(mockValidateAndFetch).toHaveBeenCalledTimes(1)` — proves cache short-circuit, not just a 200 status. Reset the module cache between tests (`vi.resetModules()` + dynamic import, or an exported `__clearFaviconCache` test hook) so cache state doesn't leak into the 204/403 tests.
  - **403-when-OFF (T5, RT7 fail-red)**: pin the gate read source = `session.user.fetchFavicons` (mock `auth`/`getSessionInfo` to return `{ user: { id, fetchFavicons: false } }`). PAIRED assertions: OFF → 403 AND `expect(mockValidateAndFetch).not.toHaveBeenCalled()`; ON → `expect(mockValidateAndFetch).toHaveBeenCalled()`. The `not.toHaveBeenCalled()` is what makes removing the gate detectable (OFF test flips to 204/200).
  - **400 malformed host** — include the S8 smuggling cases: `host="github.com&size=16"` → 400 (strict allowlist rejects `&`), `host="169.254.169.254"` → 400 (IP literal rejected), and `expect(cacheKey).not.toContain("&")`.
  - **429** (mock `createRateLimiter().check` → `{ allowed: false, retryAfterMs }`).
  - **Byte cap (T15)**: mock `validateAndFetch` to resolve an over-cap (>256 KB) `Response`; assert 204 AND nothing cached.
  - **Single-flight (T15, security-relevant)**: fire N concurrent same-host requests against a slow-resolving `validateAndFetch` mock; assert `toHaveBeenCalledTimes(1)` (proves N misses collapse to one upstream fetch — the anti-amplification invariant). The global limiter may be deferred to manual verification if a unit harness is costly.
- **C3 component tests (T3 — the privacy invariant; highest-priority fail-red)**: `Favicon` consumes `useSession()`; tests mock `next-auth/react` per the `header.test.tsx:18-29` pattern (`vi.hoisted` + `vi.mock("next-auth/react", () => ({ useSession: mockUseSession }))`). THREE explicit tests so no path passes vacuously:
  - `status:"loading"` → assert NO `<img>` AND NO globe `svg` (neutral placeholder).
  - resolved OFF (`{ data: { user: { fetchFavicons: false } }, status: "authenticated" }`) → assert `container.querySelector("img")` is `null` AND globe `svg` present.
  - resolved ON (`fetchFavicons: true`) → assert `<img>` present with `src` that **startsWith `/api/user/favicon?`**.
  - **Bucket-snapping (F6/F7 — must be fail-red)**: assert a non-{16,32} render size maps to the right bucket — e.g. `<Favicon size={28} ...>` requests `size=64` (NOT `size=56`), and `<Favicon size={12} ...>` requests `size=32` (NOT `size=24`). Without this, the size-whitelist/retina collision ships green (favicon.test.tsx's default size 32 happens to map to a valid bucket and would not catch it).
- **C3 RT7-a flip (T4 — favicon.test.tsx restriction test)**: replace the current Google-URL assertions. The stale `toContain("sz=64")` MUST be deleted (proxy uses `size=`, not `sz=`). Concrete negative guard so a re-introduced third-party URL goes red: `expect(src).not.toMatch(/^https?:\/\//)` AND `expect(src).not.toContain("google")` AND `expect(src.startsWith("/api/user/favicon")).toBe(true)`.
- **R19 mock note (T6)**: the 4 test files that `vi.mock` the favicon module (`entry-icon.test.tsx:9`, `password-row.test.tsx:22`, `login-section.test.tsx:20`, `password-card.test.tsx:43`) require **NO change** — `Favicon` props are unchanged (host/size/className); the preference is read internally via `useSession`. Do NOT add a `fetchFavicons` prop to these mocks (prevents mock-vs-real drift).
- **C4 route tests**: valid body → 200 + `prisma.user.update` called with `{ fetchFavicons }`; **unknown field → 400** (requires `.strict()` per T2 — assert status 400 + `VALIDATION_ERROR`, not a stripped 200); no session → 401. **(T10)** the INVALID_JSON test spies `req.json` per `locale route.test.ts:39` — this reaches `parseBody`'s no-stream fallback and does NOT violate C4's route-level `req.json()` forbidden pattern (which targets route source, not test code).
- **C6 optimistic-update (T9)**: render the toggle + a `Favicon`, mock the PUT to resolve `{ fetchFavicons: true }`, click, assert the favicon `<img>` now renders (driven by optimistic state / the wired context, not by `useSession`).
- **C8 classification (RT7)**: `route-policy.test.ts` asserts both new paths classify `API_SESSION_REQUIRED` — goes red if a prefix registration is dropped.
- **Manual test** (`docs/archive/review/favicon-proxy-optin-manual-test.md`, R35 Tier-1): M1 default-OFF new user shows no favicons + zero requests to `/api/user/favicon` (DevTools network); M2 toggle ON → favicons load via same-origin proxy, confirm **zero** requests to `www.google.com` / `gstatic.com` from the browser; M3 the chosen non-redirecting upstream returns a real icon for a known host (this is the safety net that catches the S1/F1 redirect bug if the wrong provider URL ships); M4 navigate-away-and-back persists the toggle; M5 an entry whose host has no favicon → 204 → globe, no broken-image.

## Considerations & constraints

- **SC1** — iOS favicon support is a **separate effort owned by the iOS workstream** (MacBook). Out of scope here. The provider/proxy decision should stay consistent across platforms but is tracked independently.
- **SC2** — Browser extension does NOT render favicons today and is out of scope; no change.
- **SC3** — Migrating the *provider* from Google to a self-hosted icon source or DuckDuckGo is out of scope; the proxy isolates the provider to one server-side constant so a future PR can swap it without client changes. Tracked as a follow-up. **Security note for that future swap (S9)**: today the SSRF guard (`resolveAndValidateIps`) only validates `t1.gstatic.com` (the fixed provider host), NOT the inner user host. A swap to a *direct-host* fetch shape (`https://<host>/favicon.ico`) MUST route the inner host through `resolveAndValidateIps` — the strict-allowlist normalization (rejecting IP literals) is necessary but not sufficient for that shape.
- **R3 propagation scan (done)** — `grep -rn "s2/favicons" src` returns exactly one hit: `src/components/passwords/shared/favicon.tsx:22`. No folder/settings/other list view contacts the provider directly. `Favicon` is consumed only via `entry-icon.tsx`, `login-section.tsx`, `password-card.tsx` (and `password-row`/`password-detail-pane` through `EntryIcon`). Updating `favicon.tsx` is sufficient to remove all third-party client fetches; no other source file needs the provider URL removed.
- **Risk** — Server-side favicon cache could grow unbounded; mitigated by Redis TTL + in-memory count cap + per-entry byte cap (C2).
- **Privacy — residual leak audited (S6, verified)**: `withRequestLog` logs `url.pathname` only, NOT the query string (`with-request-log.ts:34-40`), so the `?host=` param does NOT land in standard request logs — confirm the favicon route uses `withRequestLog` and does not `logger.*({ host })` anywhere. `validateAndFetch` sends only a `User-Agent` (no `Referer`) to the upstream, so the dashboard URL does not leak to the provider. Net: the proxy genuinely improves privacy — the provider sees the *server's* IP fetching a single host, never the user's browser sending the full service list. The OFF default + C7 footer cover the remaining (disclosed) fact that opted-in hosts reach the user's own server and, via the server, the provider.
- **SSRF — IP-literal hosts handled (S5/S1, verified)**: `resolveAndValidateIps` already rejects IPv4 private ranges, loopback, link-local/metadata (`169.254.0.0/16`), and IPv4-mapped IPv6 (`::ffff:0:0/96` covers `[::ffff:169.254.169.254]`). The only SSRF gap was the redirect-follow temptation, closed by the non-redirecting-upstream decision (C2 Redirect constraint) + the `redirect:"follow"` forbidden pattern.

## Implementation Checklist (Step 2-1)

### Files to create
- `src/app/api/user/favicon/route.ts` — C2 GET proxy.
- `src/app/api/user/favicon-pref/route.ts` — C4 PUT toggle.
- `src/lib/favicon/` (or colocated) — shared host-normalization helper + provider-URL builder + cache helper (reused by C2; single source for normalization so cache key and SSRF URL agree).
- Test files: `favicon/route.test.ts`, `favicon-pref/route.test.ts`, updated `favicon.test.tsx`, `route-policy.test.ts` cases.
- `prisma/migrations/<ts>_add_user_fetch_favicons/migration.sql` (generated by `db:migrate`).
- `docs/archive/review/favicon-proxy-optin-manual-test.md` (R35 Tier-1).

### Files to modify
- `prisma/schema.prisma` — `User.fetchFavicons Boolean @default(false)` (C1).
- `src/auth.ts` — add `fetchFavicons: true` to the session callback's `tx.user.findUnique` select (sibling of `tenant`, ~line 402) + include in returned `user` (~line 446) (C5/F2).
- `src/types/next-auth.d.ts` — `fetchFavicons?: boolean` on `Session.user` (C5).
- `src/components/passwords/shared/favicon.tsx` — three render states + bucket-snap + same-origin src via `withBasePath` (C3).
- `src/lib/constants/auth/api-path.ts` — `USER_FAVICON`, `USER_FAVICON_PREF` (C8).
- `src/lib/proxy/route-policy.ts` — register both in `SESSION_REQUIRED_PREFIXES` (C8).
- `src/app/[locale]/dashboard/settings/account/profile/page.tsx` — replace stub `comingSoon` with the favicon toggle (C6); follow the existing `Card`+`SectionCardHeader`+`CardContent` settings-card pattern (guarded by `check-settings-card-layout.sh`).
- `messages/en/Settings.json`, `messages/ja/Settings.json` — toggle label + privacy footer (C7).

### Shared utilities to REUSE (R1 — do NOT reimplement)
- `validateAndFetch` from `@/lib/http/external-http` — SSRF-safe outbound fetch (returns `Response`; `redirect:"error"`).
- `createRateLimiter` from `@/lib/security/rate-limit` — per-user + global limiters.
- `getRedis` from `@/lib/redis` — cache backend (null when unset → in-memory fallback).
- `parseBody` from `@/lib/http/parse-body` — C4 body read (NOT `req.json()`; `check-raw-body-read.sh`).
- `withUserTenantRls` — C4 preference write scoping.
- `withBasePath` from `@/lib/url-helpers` — prefix the `<img src>` `/api/user/favicon` path (basePath compliance; the `<img>` is not a `fetch()` so the fetchApi grep won't catch a miss — must be correct by construction).
- `unauthorized` / `rateLimited` API response helpers (mirror `/api/user/locale`, `/api/watchtower/hibp`).
- API error envelope helpers (`check-api-error-codes.sh` / `check-api-error-body-drift.sh` conformance).

### CI / pre-PR parity (Step 2-1)
- Local `scripts/pre-pr.sh` is a **superset** of CI gates — running it satisfies CI parity. No parity gap.
- Plan-relevant static gates to satisfy by construction: `check-raw-body-read.sh` (C4 → `parseBody`), `check-fail-closed-routes-have-test.sh` (C2 403/400 paths need tests), `check-settings-card-layout.sh` (C6), `check-api-error-*` (C2/C4 envelopes), `fetch basePath compliance` (C3 `<img src>` via `withBasePath`).
- Run `scripts/pre-pr.sh` at Step 2-4; re-inspect `git status`/`git diff` after (it runs formatters/codegen).

## User operation scenarios

1. **New user, never touches the setting**: list view shows globe/type icons only; no favicon network requests anywhere; opening DevTools shows zero requests to `/api/user/favicon` and zero to `www.google.com`.
2. **Privacy-conscious user enables, then disables**: enabling loads icons via same-origin proxy; disabling immediately stops further favicon requests (open `Favicon` components re-render to globe on next render).
3. **User with an entry whose host has no favicon**: proxy returns 204; client shows globe — no broken-image icon.
4. **User behind a network that blocks the upstream provider**: proxy times out → 204 → globe fallback; no console errors, no hanging requests.
5. **Malicious entry URL (`http://169.254.169.254/...` style host)**: SSRF guard rejects; proxy returns 204/400; no internal network access.
