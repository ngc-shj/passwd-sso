# Plan: csp-form-action-loopback-scoping

Branch: `refactor/csp-form-action-loopback-scoping`
Plan file: `docs/archive/review/csp-form-action-loopback-scoping-plan.md`

## Project context

- **Type**: web app (Next.js 16 + Prisma 7 + PostgreSQL 16)
- **Test infrastructure**: unit + integration (vitest)
- The product hosts an OAuth 2.1 Authorization Code (PKCE) endpoint for MCP clients. The consent flow involves a browser form-POST that triggers a server-side 302 redirect to a loopback `redirect_uri` registered by the client (Claude Code, Claude Desktop, the project's own CLI).

## Objective

Resolve **S2** from the [PR #398 review log](csrf-admin-token-cache-review.md). The CSP `form-action` directive in production allows `'self' http://localhost:* http://127.0.0.1:*` so the consent form's 302 redirect to a loopback callback succeeds. Investigation surfaced three follow-on issues:

- **B1 (Major)** — DCR (`/api/mcp/register`) accepts `http://[::1]:<port>/` redirect URIs, but the CSP `form-action` directive omits `http://[::1]:*`. An IPv6-loopback OAuth client would silently fail at the consent-form-redirect step (CSP-blocked). DCR-accepted redirect URIs MUST all be CSP-allowed.
- **B2 (Minor)** — Manual MCP client management (`POST/PUT /api/tenant/mcp-clients[/...]`) only accepts `http://localhost:<port>/` redirect URIs. DCR accepts `localhost` AND `127.0.0.1` AND `[::1]`. The same model rows can have different validation surfaces depending on the registration path. Unify by extracting and reusing the DCR regex.
- **B3 (Info)** — Strengthen the CSP `form-action` rationale comment to explain the RFC 8252 §8.3 trade-off (RFC marks `localhost` as NOT RECOMMENDED, but Claude Code uses it; we keep `localhost` for compatibility). The expanded comment becomes the canonical record so future security review does not have to re-derive the trade-off.

## Requirements

### Functional

1. **CSP** in `proxy.ts` MUST list `http://[::1]:*` alongside `http://localhost:*` and `http://127.0.0.1:*` so the OAuth consent form-POST can 302-redirect to any DCR-accepted loopback redirect URI without CSP-blocking.
2. **Manual MCP client schemas** (`POST /api/tenant/mcp-clients`, `PUT /api/tenant/mcp-clients/[id]`) MUST accept the same loopback redirect URI patterns as DCR: `http://(127.0.0.1|localhost|[::1]):<port>/...`.
3. The validation regex MUST live in a single shared location so DCR and the manual routes import it. The shared module is the source of truth — drift cannot accumulate across handlers.
4. **Comment** on the CSP `form-action` line in `proxy.ts` MUST cite RFC 8252 §7.3 (loopback IP literal MUST be allowed) and §8.3 (`localhost` NOT RECOMMENDED but kept for Claude Code compatibility), and reference DCR's regex as the security-invariant pair.

### Non-functional

- Backward compat: any redirect URI currently accepted by DCR or the manual routes MUST continue to be accepted.
- No schema migration (no DB changes).
- The CSP change applies in all environments (dev + strict), matching the existing line.
- Test count baseline: tests added (boundary cases), no tests removed.

### Out of scope

- Extending the CSP `form-action` to include arbitrary HTTPS redirect targets — `'self'` already covers them via the implicit "redirect to same origin" rule, and the server's own 302 handlers redirect to URIs that are validated upstream against the registered `redirectUris`. The new directive only widens the loopback case.
- Tightening the CSP further (dropping `localhost`, RFC §8.3 alignment) — explicitly deferred per the existing comment; Claude Code/Desktop compatibility takes precedence.
- Migrating any registered DCR clients with `localhost:*` URIs to `127.0.0.1:*`.
- Changing the CLI's loopback choice (`127.0.0.1` only) — separate concern.

## Technical approach

### 1. Shared regex module

Create or extend a constants module to host the loopback redirect regex. The natural home is `src/lib/constants/auth/mcp.ts` (already houses `MCP_SCOPES`).

Add a single named export:

```ts
// RFC 8252 §7.3 mandates loopback IP literal support; §8.3 marks "localhost"
// as NOT RECOMMENDED but real OAuth clients (Claude Code, Claude Desktop)
// use it. Pair with the CSP form-action directive in proxy.ts — any host
// pattern accepted here MUST appear there or the consent-form 302 redirect
// is CSP-blocked.
export const LOOPBACK_REDIRECT_RE = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//;
```

### 2. DCR consumer

Replace the inline regex in `src/app/api/mcp/register/route.ts:31` with the imported constant. Behavior unchanged.

### 3. Manual MCP client schemas

In both `src/app/api/tenant/mcp-clients/route.ts` and `src/app/api/tenant/mcp-clients/[id]/route.ts`, replace:

```ts
.refine(
  (u) => {
    try {
      const url = new URL(u);
      return url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
    } catch { return false; }
  },
  { message: "redirect_uri must use https:// or http://localhost" },
)
```

with the DCR-equivalent shape:

```ts
.refine(
  (u) => {
    try {
      const url = new URL(u);
      return url.protocol === "https:" || LOOPBACK_REDIRECT_RE.test(u);
    } catch { return false; }
  },
  { message: "redirect_uri must use https:// or http://(127.0.0.1|localhost|[::1]):<port>/" },
)
```

**Editor note (F5)**: apply `Edit` per-file rather than `replace_all` across the whole repo. The two files contain the textually-identical refine block exactly once each; per-file edits avoid wider unintended substitution.

### 3b. DCR error message unification (F2/S1)

`src/app/api/mcp/register/route.ts:51` currently reads:

```ts
"redirect_uris must use https:// or http://localhost:<port>/ or http://127.0.0.1:<port>/"
```

This message omits `[::1]` even though the regex accepts it. Update to the same canonical message used by the manual routes:

```ts
"redirect_uris must use https:// or http://(127.0.0.1|localhost|[::1]):<port>/"
```

### 3c. Frontend validator parity (F1)

`src/components/settings/developer/mcp-client-card.tsx:68-76` contains a client-side `validateRedirectUris` that mirrors the OLD server predicate (only `localhost` accepted). After the server schema broadens, this client guard would still reject `127.0.0.1` and `[::1]` URIs — admin cannot enter the URI they want.

Update the client validator to use the same regex predicate as the server. Since `src/lib/constants/auth/mcp.ts` is a leaf constants module (string + regex only, no server runtime), it is safe to import from a `"use client"` component. Verify by reading the module's imports during Phase 2 Step 2-1; if the module gains a server-only dependency later, fall back to inlining the regex literal with a `// see: LOOPBACK_REDIRECT_RE in @/lib/constants/auth/mcp` reference comment.

### 4. CSP

In `proxy.ts:37`, update the directive:

```ts
"form-action 'self' http://localhost:* http://127.0.0.1:* http://[::1]:*",
```

And replace the existing `localhost/127.0.0.1 required in all environments...` comment block with the strengthened B3 version that cross-references DCR and cites RFC 8252 §7.3 / §8.3.

### 5. Tests

Add the following test cases:

- **DCR** (`src/app/api/mcp/register/route.test.ts`):
  - Positive: `http://[::1]:<port>/callback` accepted.
  - Negative: `http://[::1]/` (no port) rejected — symmetric with the existing `http://127.0.0.1/` and `http://localhost/` no-port reject tests (T3 — non-optional).
- **Manual MCP client POST** (`src/app/api/tenant/mcp-clients/route.test.ts`):
  - Positive: `http://127.0.0.1:<port>/` and `http://[::1]:<port>/` accepted (currently rejected).
  - Negative (T2): `http://127.0.0.1/`, `http://localhost/`, `http://[::1]/` (no port) rejected. The current test file has no redirect-URI rejection tests at all — adding them establishes a regression guard against future schema regressions.
- **Manual MCP client PUT** (`src/app/api/tenant/mcp-clients/[id]/route.test.ts`): same positive + negative matrix as POST.
- **CSP regression** (T1 — critical to get right):
  - DO NOT extend the existing `_applySecurityHeaders` test pattern that uses a hardcoded `dummyOptions.cspHeader` string — that pattern bypasses `buildCspHeader()` and gives a false-negative if the production CSP forgets `[::1]`.
  - Instead: either (a) export `buildCspHeader` from `proxy.ts` as a named export and unit-test its output directly, or (b) write a test that calls the exported `proxy(request)` function with a mock `NextRequest` and asserts the response header includes `http://[::1]:*` in `form-action`.
  - Pin all three loopback host literals (`localhost:*`, `127.0.0.1:*`, `[::1]:*`) so accidental removal of any one is caught.

## Implementation steps

1. **Add shared regex constant** to `src/lib/constants/auth/mcp.ts` with the explanatory comment cited in §1 above. Verify the file has no server-only imports so it remains client-safe (consumed by `mcp-client-card.tsx`).
2. **Switch DCR** to import from the shared module (drop the inline `LOOPBACK_REDIRECT_RE`). Also update the DCR error message at `register/route.ts:51` to the unified form (per §3b).
3. **Update manual MCP client schemas** (POST `/route.ts` + PUT `/[id]/route.ts`) to import the regex and broaden the `refine` predicate; unify the error message.
4. **Update frontend validator** `src/components/settings/developer/mcp-client-card.tsx:68-76` (`validateRedirectUris`) to use the same predicate. Import `LOOPBACK_REDIRECT_RE` from the shared module (verified client-safe in step 1).
5. **Update CSP** in `proxy.ts`: add `http://[::1]:*` to the `form-action` directive (place after `127.0.0.1:*`) and rewrite the adjacent comment block per §4 above. The comment MUST name `LOOPBACK_REDIRECT_RE` so a future grep finds the CSP-side mirror from the regex side.
6. **Refactor for testability** (T1): export `buildCspHeader` from `proxy.ts` as a named export so the CSP regression test can unit-test it without relying on the hardcoded `dummyOptions.cspHeader` pattern.
7. **Add positive + negative tests** per §5 above (DCR `[::1]` accept + no-port reject; manual MCP POST/PUT three accept + three reject; CSP regression pinning all three loopback hosts).
8. **Verify**:
   - `npx vitest run src/app/api/mcp/register src/app/api/tenant/mcp-clients src/__tests__/proxy.test.ts src/components/settings/developer` (targeted)
   - `npx next build` (catches TypeScript errors, especially the new import in four files)
   - `bash scripts/pre-pr.sh` (11/11)

## Testing strategy

| Layer | Test |
|-------|------|
| DCR redirect URI accept | Positive: `http://[::1]:<port>/`. Existing tests for `127.0.0.1` and `localhost` remain. |
| DCR redirect URI reject | Existing reject tests unchanged. Add: `http://[::1]/` rejected (no port) — symmetric with the existing `127.0.0.1` and `localhost` no-port reject cases. |
| Manual MCP client POST | Positive cases for `127.0.0.1` and `[::1]` (newly accepted post-fix). Existing `localhost` case unchanged. |
| Manual MCP client PUT | Same as POST. |
| CSP shape | Assert response `Content-Security-Policy` header contains `http://[::1]:*` in `form-action`. Pin existing `localhost:*` and `127.0.0.1:*` to prevent accidental removal. |
| Regex unit (optional) | If `mcp.test.ts` accumulates regex tests, add `LOOPBACK_REDIRECT_RE` cases there directly to avoid spreading the matrix across route tests. |

## Considerations & constraints

### CSP `form-action` and 302 redirects

CSP `form-action` controls form-submit targets AND any 302 redirect chain that follows. The OAuth consent flow uses:

1. JS-built `<form method="POST" action="/api/mcp/authorize/consent">`.
2. The route returns `NextResponse.redirect(redirect_uri, 302)` where `redirect_uri` is a registered loopback URI.

If the redirect target is not in `form-action`, the browser blocks the navigation **after** the form POST has reached the server (audit log writes succeed, but the user is stranded with a CSP violation). This is the failure mode being fixed.

### Why `[::1]` only, not all-IPv6?

`[::1]` is the IPv6 loopback literal. There is no IPv6 wildcard host syntax in CSP source expressions, and routable IPv6 redirect URIs are not part of the loopback flow per RFC 8252 §7.3. Adding only the literal matches DCR's accept list.

### R3 propagation (other consumers of the loopback pattern)

After this change, `LOOPBACK_REDIRECT_RE` is referenced from:

- `src/lib/constants/auth/mcp.ts` (definition)
- `src/app/api/mcp/register/route.ts` (DCR)
- `src/app/api/tenant/mcp-clients/route.ts` (manual create)
- `src/app/api/tenant/mcp-clients/[id]/route.ts` (manual update)

The CSP directive in `proxy.ts` is the **header-side mirror**. The strengthened comment in `proxy.ts` MUST name the regex constant so a future contributor adding a host (e.g., `127.0.0.2`) updates both sides.

### R29 spec citations

- **RFC 8252 §7.3** ("Loopback Interface Redirection"): paraphrase — "the authorization server MUST allow any port to be specified at the time of the request for loopback IP redirect URIs". The `:*` port wildcard in CSP and the `:\d+/` requirement in the regex satisfy this.
- **RFC 8252 §8.3** ("Loopback Redirect Considerations"): paraphrase — "The use of 'localhost' is NOT RECOMMENDED. ... avoids inadvertently listening on network interfaces other than the loopback interface."
- These citations exist in DCR (route.ts:29-30). The plan author has not re-verified them against the live RFC in this environment — flagged `citation unverified — please confirm` per Common Rules R29 / "Verify citations, do not fabricate them". During Phase 2 Step 2-1, fetch RFC 8252 from `https://www.rfc-editor.org/rfc/rfc8252.html` and confirm both section numbers and the paraphrased claims still appear there.

### Edge cases (regex)

- **Port :0**: the regex `:\d+/` matches `:0`. No real client registers before binding to an OS-assigned port, so `:0` would never appear in a registered URI. Accepted as-is; no additional validation needed.
- **Port > 65535**: the regex matches arbitrary digit sequences. Pre-filter: Zod `z.string().url()` calls `new URL(...)` which throws on invalid ports (>65535), so the upstream guard catches `http://127.0.0.1:99999/` before the regex fires. The two-stage check (URL constructor + regex) is the correct chain.
- **Trailing path/query/hash**: the regex anchors at the first `/` after the port, so `http://127.0.0.1:8080/callback?state=foo` and similar are correctly accepted.
- **Alias forms**: `127.000.000.001`, `127.1`, `0177.0.0.1`, `0x7f.0.0.1` are NOT matched by the literal-text regex (correct security posture — these forms can evade naive host comparisons but are blocked here).

### R12 / R13 / R9 / R24 / R25 — N/A

No new audit actions, no new event dispatch surface, no new DB transactions, no migration, no persisted-state field.

## User operation scenarios

1. **Claude Desktop registers via DCR with `http://localhost:8765/callback`** (existing behavior).
   Pre-fix: works. Post-fix: works (no behavior change for the dominant case).

2. **A new IPv6-only OAuth client registers via DCR with `http://[::1]:8765/callback`**.
   Pre-fix: DCR accepts; CSP blocks the consent-form 302 → user stranded.
   Post-fix: DCR accepts; CSP allows; redirect succeeds.

3. **Tenant admin manually creates an MCP client with `http://127.0.0.1:9000/callback`** via the dashboard.
   Pre-fix: rejected by manual schema (only `localhost` allowed); admin must use `localhost` instead.
   Post-fix: accepted (matches DCR).

4. **Tenant admin updates an existing MCP client to add `http://[::1]:9001/callback`** to its redirect URI list.
   Pre-fix: rejected.
   Post-fix: accepted.

5. **The project CLI** (`cli/src/lib/oauth.ts`) registers via DCR with `http://127.0.0.1:<port>/callback`.
   Pre-fix and post-fix: works. The CLI binds to `127.0.0.1` only, never `localhost` or `[::1]`. No CLI change needed.

## Implementation Checklist
(Populated in Phase 2 Step 2-1.)
