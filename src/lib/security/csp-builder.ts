// CSP header construction for the Next.js proxy. Extracted from `proxy.ts`
// (root) so it can be unit-tested without pulling in the full Next.js
// middleware import chain (next-intl, etc.).

// Pre-compute static CSP parts at module init time to avoid per-request work.
// Only the nonce value is injected per-request.
const _isProd = process.env.NODE_ENV === "production";
// Safety guard: in production, never allow CSP_MODE=dev to downgrade the CSP.
// Ops mistakes (wrong .env.production, Docker env, etc.) must not silently
// disable strict-dynamic + nonce in prod. Only "strict" is accepted in prod.
const _rawCspMode = process.env.CSP_MODE ?? (_isProd ? "strict" : "dev");
const _cspMode = _isProd && _rawCspMode !== "strict" ? "strict" : _rawCspMode;
if (_isProd && _rawCspMode !== _cspMode) {
  console.warn(
    `[CSP] CSP_MODE="${_rawCspMode}" is ignored in production builds; using "strict"`,
  );
}
const _reportUri = `${process.env.NEXT_PUBLIC_BASE_PATH || ""}/api/csp-report`;
// In dev mode style-src and script-src use 'unsafe-inline'; in strict mode
// nonce + 'strict-dynamic' is injected. Dev uses 'unsafe-inline' because the
// per-request nonce flow via cookie is not reliable for Next.js HMR/dev-overlay
// inline scripts (Next.js 16.2+ tightened cookie propagation to server components).
// Note: the per-request nonce is still generated and set as the `csp-nonce`
// cookie in dev (read by `src/app/layout.tsx` for a <meta name="csp-nonce">),
// but plays no CSP role in dev because the header uses 'unsafe-inline'.
// Production never hits this branch.
const _stylePrefix = _cspMode === "dev" ? "style-src 'self' 'unsafe-inline'" : "style-src 'self' 'nonce-";
const _styleSuffix = _cspMode === "dev" ? "" : "'";
const _staticDirectives = [
  "img-src 'self' data: https:",
  "font-src 'self'",
  `connect-src 'self'${process.env.NEXT_PUBLIC_SENTRY_DSN ? " https://*.ingest.us.sentry.io https://*.ingest.sentry.io" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  // OAuth consent form-POSTs back to /api/mcp/authorize/consent which then
  // returns a 302 redirect to the registered native-app callback URI. CSP
  // form-action constrains BOTH the form target AND any subsequent 302 in
  // the redirect chain, so every loopback host accepted by DCR's
  // LOOPBACK_REDIRECT_RE (see src/lib/constants/auth/mcp.ts) MUST be listed
  // here — otherwise the consent flow appears to succeed but the browser
  // blocks the final redirect after the audit log has already been written.
  //
  // RFC 8252 §7.3 mandates the loopback IP literal forms (127.0.0.1, [::1])
  // and "MUST allow any port"; §8.3 marks `localhost` as NOT RECOMMENDED but
  // real OAuth clients (Claude Code, Claude Desktop) use it, so we keep it.
  // Loopback is local-only — these wildcards do not widen the network attack
  // surface.
  "form-action 'self' http://localhost:* http://127.0.0.1:* http://[::1]:*",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
  "report-to csp-endpoint",
  `report-uri ${_reportUri}`,
].join("; ");

export function buildCspHeader(nonce: string): string {
  // Dev mode: 'unsafe-inline' + 'unsafe-eval' (no nonce, no strict-dynamic).
  //   Necessary because Next.js HMR, Turbopack dev overlay, and React Fast Refresh
  //   inject inline scripts that cannot receive the per-request CSP nonce.
  //   This is the standard Next.js dev CSP configuration.
  // Strict mode: per-request nonce + 'strict-dynamic'.
  //   Inline scripts without the nonce are blocked. 'unsafe-eval' is intentionally
  //   NOT included even when strict mode is selected via CSP_MODE=strict in a
  //   non-prod NODE_ENV — strict mode approximates prod CSP and prod has no
  //   need for 'unsafe-eval' (Turbopack dev overlay uses eval() and will be
  //   blocked, but in that case the caller should use dev mode instead).
  const scriptSrc = _cspMode === "dev"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`;
  const styleSrc = _cspMode === "dev"
    ? _stylePrefix
    : `${_stylePrefix}${nonce}${_styleSuffix}`;
  return `default-src 'self'; ${scriptSrc}; ${styleSrc}; ${_staticDirectives}`;
}
