# Code Review: full-repo-security-audit

Date: 2026-07-09
Review round: 1 (whole-repository security audit, not a diff review)
Scope: entire codebase reviewed by 6 parallel security-expert sub-agents partitioned by attack surface (crypto/E2EE, auth/session/proxy, authz/tenant-isolation, MCP/OAuth/tokens, CLI/extension, injection/validation/SSRF).

## Summary

Overall posture: **mature and heavily hardened.** No Critical findings. 2 Major, 8 Minor.
The core E2E-encryption, RLS multi-tenant isolation, OAuth/PKCE, session/proxy, and
CLI/extension trust boundaries all hold up under adversarial inspection. Most candidate
vulnerabilities (CSRF fail-open, session-cache poisoning, WebAuthn replay, SSRF, SQLi,
IDOR, prototype pollution, IP spoofing) resolved to non-issues on inspection.

## Security Findings

### Major

**[S1] Major: MCP consent screen never displays redirect_uri → authorization-code phishing via attacker-registered DCR clients**
- File: src/app/[locale]/mcp/authorize/consent-form.tsx:72,97,119 (redirectUri only in hidden inputs); page.tsx:94-105; api/mcp/register/route.ts:35-53; api/mcp/authorize/consent/route.ts:321-324
- Problem: Consent card renders clientName + DCR badge + scopes but NOT the redirect destination. DCR accepts arbitrary https/loopback redirect_uris from an unauthenticated registrant, and the code is delivered to that URI.
- Impact: Attacker registers DCR client named "Claude Code" with redirect_uris=[attacker], lures victim to /api/mcp/authorize, victim sees plausible consent, clicks Allow, code lands at attacker, public client exchanges it for an mcp_ token with granted scopes. PKCE does not help (attacker's own verifier). The missing redirect_uri display removes the one signal a careful user could use to detect the wrong destination.
- Fix: Render the redirectUri host prominently on the consent card; for isDcr clients add an explicit "newly self-registered application — verify the destination" warning.

**[S2] Major: Delegation session creation accepts a credentials:list-only MCP token → grants decrypt authorization to a documented metadata-only scope**
- File: src/app/api/vault/delegation/route.ts:129-132 (and duplicate display-flag at :350-352)
- Problem: hasDelegationScope = LIST || USE. Creating a DelegationSession bound to mcpTokenId is what authorizes the CLI agent's decrypt; /delegation/check returns authorized:true on session existence. Admitting a list-only token contradicts the scope contract (constants/auth/mcp.ts:32 classifies credentials:list as risk "read"; docs/architecture/machine-identity.md:302-303 states list = metadata only, no decrypt).
- Impact: Intra-user least-privilege violation (not cross-user/tenant → Major, not Critical). A user who issued a token believing it is metadata-read-only can still delegate real entries to it; the agent then passes /delegation/check and decrypts. The duplicate predicate at :350-352 shows list-only tokens as hasDelegationScope:true in the UI, nudging the user toward the escalation.
- Fix: Require credentials:use only at both sites. Legacy credentials:decrypt expands to list+use at consent, so it is unaffected.

### Minor

**[S3] Minor: Vault/team CSV export omits formula-injection neutralization (inconsistent with audit-log CSV)**
- File: src/lib/format/export-format-common.ts:86-92 (vs src/lib/audit/audit-csv.ts:10-16 which guards)
- Problem: Two independent escapeCsvValue implementations. The vault/team password-export variant only quote-wraps cells containing ,"\n and does NOT prefix cells beginning with `= + - @ \t \r` with a leading apostrophe.
- Impact: Attacker-controlled text in a shared team field (title/username/folder/notes) or a crafted imported entry lands verbatim in a victim's CSV export; opening in Excel/Sheets evaluates formulas (HYPERLINK/WEBSERVICE exfiltration, DDE). E2E model bounds it to Minor, but team-shared fields cross a trust boundary and the codebase already fixes this in the audit path.
- Fix: Apply the same guard; best, extract one shared CSV-escape helper and delete the duplicate. Preserve RS6 escape ordering (`"`→`""` doubling first, then formula-prefix on the quoted string, as audit-csv.ts already does).

**[S4] Minor: SW-side autofill trusts content-supplied entryId without re-binding it to the sender tab's origin**
- File: extension/src/background/index.ts:2411-2467 (AUTOFILL_FROM_CONTENT), performAutofillForEntry 1389-1777
- Problem: Handler validates only entryId charset; host filtering exists only in the suggestion/dropdown path (resolveInlineMatches, untrusted content script), not on the fill path. No comparison of entry.urlHost vs extractHost(_sender.tab.url).
- Impact: XSS on a trusted page where the content script runs can post AUTOFILL_FROM_CONTENT with a known entryId → that site's password is filled into attacker DOM and read back. Precondition: vault unlocked + known high-entropy entryId; no externally_connectable. Held to Minor.
- Fix: After decrypt, verify isHostMatch(entry.urlHost, extractHost(_sender.tab.url)) for EXT_ENTRY_TYPE.LOGIN and reject ORIGIN_MISMATCH, mirroring isSenderAuthorizedForRpId on the passkey path.

**[S5] Minor: Proxy-layer Tailscale access restriction skips exact-tailnet WhoIs for browser/session flows**
- File: src/lib/auth/policy/access-restriction.ts:140-151 (via proxy/api-route.ts:128, page-route.ts:119)
- Problem: checkAccessRestriction allows any CGNAT (100.64.0.0/10) IP; the exact-tailnet verifyTailscalePeer WhoIs runs only in enforceAccessRestriction (Bearer/token path), never in the proxy Edge path.
- Impact: A client on a different tailnet (or CGNAT XFF through a trusted proxy) passes the tenant Tailscale restriction for browser/session traffic. Default fail-closed posture (TRUST_PROXY_HEADERS=false → null IP → deny) makes it unreachable → Minor.
- Fix: Have the proxy path perform verifyTailscalePeer for tailscaleTailnet-scoped tenants, or document CGNAT-range trust as the intended proxy-layer bound.

**[S6] Minor: Route classification hand-maintains per-path /api/user/* enumeration; new sibling routes silently fall to api-default (no proxy session gate)**
- File: src/lib/proxy/route-policy.ts:54-79
- Problem: SESSION_REQUIRED_PREFIXES lists each /api/user/* leaf individually. All 6 current routes are covered, but a future /api/user/foo would classify as api-default with no proxy-enforced session validation or tenant IP restriction — the same propagation-gap class the CSRF gate was redesigned to eliminate structurally.
- Impact: Latent (no current route exposed). A future route added without the entry and without in-handler auth would be reachable unauthenticated.
- Fix: Classify the whole /api/user subtree via one pathMatchesPrefix entry, OR add a CI guard asserting every session-required route dir is present in SESSION_REQUIRED_PREFIXES (mirror the Bearer-rule/step-up coverage guards already in the repo).

**[S7] Minor: normalizeForwardedHeaders trusts spoofable Tailscale-* headers when the app is directly reachable**
- File: src/lib/proxy/forwarded-headers.ts:130-132,40-93
- Problem: isViaTailscaleServe returns true if the request merely carries tailscale-headers-info / tailscale-user-login — spoofable if any ingress path is not exclusively via tailscaled (dev :3001 off-tailnet, or a misconfigured prod). Self-limited (only rewrites Host/XFP to canonical, requires hostname==canonical) → no host pivot, no auth bypass.
- Fix: Gate on a TRUST_TAILSCALE_SERVE_HEADERS opt-in, or verify the socket peer is a tailscaled loopback/Tailscale IP, consistent with the TRUST_PROXY_HEADERS fail-closed pattern.

**[S8] Minor: MCP passkey-enforcement block in exchangeCodeForToken fires after the code is consumed**
- File: src/lib/mcp/oauth-server.ts:269-293
- Problem: The CAS consume (usedAt: null→now, line 269) runs before the passkey re-derivation (280); on a block it returns access_denied without rolling back the consume, so a legitimate retry within the code TTL hits invalid_grant. The refresh path (529-552) gates passkey BEFORE the claim — inconsistent.
- Impact: Self-inflicted DoS on the OAuth flow, not an authz bypass. Low likelihood (passkey state rarely flips inside a 5-min TTL).
- Fix: Move the passkey check before the updateMany consume, mirroring the refresh-path ordering.

**[S9] Minor: .well-known/oauth-authorization-server emits issuer:"" when APP_URL/AUTH_URL is unset**
- File: src/app/api/mcp/.well-known/oauth-authorization-server/route.ts:7
- Problem: issuer: getAppOrigin() ?? "" — an empty issuer ships an RFC 8414-invalid discovery doc with a 200, whereas sibling origin-dependent paths fail closed (admin-reset 500, consent INTERNAL_ERROR).
- Fix: Return 500 (or omit the doc) when getAppOrigin() is null.

**[S10] Minor: KDF/crypto invariant gaps (2 sub-items, both defense-in-depth)**
- (a) Argon2id KDF setup path is dead code — vault-context.tsx:424, crypto-client.ts:191-196, api/vault/setup/route.ts:49-60. Setup persists kdfType=1 but every derive path hardcodes PBKDF2-600k, so DB metadata disagrees with the actual KDF. Not an attacker-exploitable downgrade (600k is the real floor everywhere), but an availability landmine if a future client honors kdfType, and it is security theater (users think Argon2id, get PBKDF2). Fix: remove the Argon2id branch until wired E2E, or wire deriveWrappingKeyWithParams everywhere + add a golden round-trip test.
- (b) deriveAuthKey produces an extractable HMAC key (crypto-client.ts:231-255, exportKey at 331), deviating from the "extractable:false everywhere" invariant. No concrete break (domain-separated; an attacker who sees the raw bytes already holds the secret key). Fix: derive the auth hash via HKDF deriveBits + digest instead of an exported CryptoKey.

## Verified-Clean Areas (negative results, so they read as checked-not-skipped)

- Crypto/E2EE: KDF floor 600k enforced write+derive; fresh 12-byte IVs via getRandomValues/randomBytes, no Math.random; length-prefixed AAD registry binds ciphertext to user/entry/tenant/version (cross-entry/user/tenant transplant blocked), module-private, CI-enforced, no no-AAD fallback; RS1 timing-safe on verifier/access-password/unlock/recovery; R39 zeroization on lock/pagehide/unmount/bfcache; admin-reset is destructive-delete not decrypt (E2E preserved); recovery proves possession before returning key; strict envelope version regex + no plaintext fallback; ECDH P-256 pinned + per-op salt.
- Auth/session/proxy: CSRF gate request-attribute-gated + path-independent, assertOrigin fails closed 403 when APP_URL/AUTH_URL unset, no method-override honored; session cache HMAC-keyed, tombstone-first, NX-write, Zod-validated, no cross-tenant bleed; WebAuthn challenges single-use getdel + expectedOrigin/RPID + UV:true + counter CAS + timing equalization; Bearer/cookie confusion falls through to session path when both present; IP extraction fails closed to null; open redirect rejects protocol-relative/cross-origin; token lookups by hash/unique-index not JS compare; baseline security headers on every API response.
- Authz/tenant: RLS tx-local set_config + symmetric bypass/tenant guards + injection-safe advisory lock, prismaBase never used outside export, DB policies fail closed on NULL; personal + child/grandchild routes scope by parent FK, re-assert userId, 403→404 oracle collapse, FOR UPDATE lost-update safety; team mirror surfaces consistent; tenant-admin/breakglass/SA scope by tenantId + full parent chain + step-up on destructive; share-link atomic TOCTOU-safe conditional UPDATE; emergency-access grantee + ACTIVATED gate; token scope enforcement with checkAuth C1 guard forbidding unscoped token auth.
- MCP/OAuth: PKCE S256 enforced (plain rejected), auth codes single-use via CAS bound to client_id+redirect_uri+PKCE, refresh rotation fail-closed family revocation with correctly-ordered IP gate (skips already-rotated tokens so theft detection is never suppressed), 256-bit tokens hashed at rest, redirect_uri exact-match, DCR public-only + unclaimed-expiry + global cap, credential-minting Bearer routes self-enforce tenant IP restriction before mint, delegation/check + ssh/sign-authorize intra-user IDOR guards.
- CLI/extension: cred storage O_NOFOLLOW+0600 write&read + refuse symlink dir + 0700 dir; OAuth PKCE loopback binds state timingSafeEqual + 127.0.0.1 + S256 + HTTPS-except-loopback; vault key via IPC not argv/env + fill(0) on lock + spawn argv array (no shell injection); SSH sign per-signature server authorize (no cache, fail-closed) + requireReprompt + session-bind; ext WebAuthn terminal actions gated by single-use TTL identity-bound in-bridge approvals + SW re-binds clientDataJSON.origin/rpId; token storage chrome.storage.session TRUSTED_CONTEXTS + DPoP-bound, no SET_TOKEN route; strict manifest CSP, no externally_connectable.
- Injection/SSRF: no production raw SQL with user input; SCIM filter → parameterized Prisma AST; SSRF surfaces (external-http, webhook, directory-sync, favicon) block internal ranges; favicon MIME allowlist rejects image/svg+xml on ingestion AND cache-hit; attachment extension/content-type/filename/size caps; bulk-import 50-entry cap; SCIM PATCH reads fixed keys (no prototype pollution); open redirect handled in callback-url.

## Resolution Status
Pending — findings reported to user for prioritization. No fixes applied yet (this was a read-only audit request; the user asked for a review, not a fix).
