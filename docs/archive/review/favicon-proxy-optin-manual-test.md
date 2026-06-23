# Manual Test Plan: favicon-proxy-optin (Web)

R35 Tier-1 (user-preference / UX surface). Two-filter rule applied: only steps that
automated tests cannot exercise are listed — the unit/route tests already cover
200/204/400/403/429, cache-hit single-fetch, strict-host rejection, the privacy
invariant (OFF emits no `<img>`), and bucket-snapping. What remains here is
browser-observable network behavior and the real upstream fetch.

## Pre-conditions
- Dev server running on :3001 (`npm run dev -- -p 3001`), DB + Redis up.
- A test account with the vault unlocked and at least 3 LOGIN entries whose URLs
  have well-known favicons (e.g. github.com, google.com, stripe.com) and one entry
  whose host has no favicon.
- Browser DevTools → Network tab open, "Disable cache" OFF (we want to observe HTTP cache).

## Steps & Expected results

### M1 — Default OFF: no favicon traffic, no third-party leak
1. Sign in as a brand-new user (or one who never toggled the setting). Open the vault list.
- **Expected**: all entries show the Globe / type icon. Network tab shows **zero**
  requests to `/api/user/favicon` and **zero** requests to `www.google.com` /
  `gstatic.com`. (Confirms the OFF default + the privacy guarantee.)

### M2 — Toggle ON: favicons load via same-origin proxy only
1. Go to Settings → Profile, enable "Show site icons".
2. Return to the vault list.
- **Expected**: LOGIN entries' icons become real favicons. Network tab shows
  requests to `/api/user/favicon?host=...&size=32|64` (same-origin) and **zero**
  requests to `www.google.com` / `gstatic.com` **from the browser**. The host names
  never leave the browser to a third party.
3. Scroll the list / navigate away and back.
- **Expected**: already-fetched favicons are served from browser HTTP cache
  (`Cache-Control: private, max-age=86400`) — no repeated `/api/user/favicon`
  requests for the same host.

### M3 — Real upstream fetch returns a real icon (SAFETY NET for S1/F1)
1. With the setting ON, open an entry for a host with a known favicon that has NOT
   been cached yet (clear Redis or use a fresh host).
- **Expected**: the favicon renders (a real image, not the globe). This proves the
  chosen non-redirecting upstream (`t1.gstatic.com/faviconV2`) returns 200 image
  bytes directly. **If every favicon falls back to globe, the upstream provider URL
  is wrong** (the redirect bug the plan's S1/F1 guards against) — STOP and check the
  provider constant in `src/lib/favicon/favicon-proxy.ts`.

### M4 — Preference persists across navigation/reload
1. With the setting ON, hard-reload the page (or sign out and back in).
- **Expected**: favicons still render — `session.user.fetchFavicons` persisted to the
  DB and re-projected into the session on the live `session()` callback.
2. Toggle OFF, reload.
- **Expected**: icons revert to globe; no `/api/user/favicon` requests.

### M5 — Host with no favicon → graceful globe (no broken image)
1. With the setting ON, view the entry whose host has no favicon.
- **Expected**: the proxy returns 204; the client shows the globe fallback — NO
  broken-image icon, NO console error, NO hanging request.

## Rollback
- Setting is per-user and defaults OFF; no destructive action. To revert the feature,
  the migration `20260623152753_add_user_fetch_favicons` is additive (a nullable-with-
  default column) and can remain — code reverting to the old client simply ignores it.

## Results (fill in after live verification)
- M1: [ ]
- M2: [ ]
- M3: [ ]  ← the critical one (upstream-not-redirecting)
- M4: [ ]
- M5: [ ]
