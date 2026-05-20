// CSP header construction for the Next.js proxy. Extracted from `proxy.ts`
// (root) so it can be unit-tested without pulling in the full Next.js
// middleware import chain (next-intl, etc.).

// Pre-compute static CSP parts at module init time to avoid per-request work.
// Only the nonce value is injected per-request.
const _isProd = process.env.NODE_ENV === "production";

/**
 * L2: Narrow Sentry's connect-src from `https://*.ingest.us.sentry.io
 * https://*.ingest.sentry.io` (whole infra) to the specific org-ingest
 * host derived from the DSN. The DSN format is
 *   https://<publicKey>@<host>/<projectId>
 * where <host> is org-specific (e.g. `o123456.ingest.us.sentry.io`).
 * Falling back to the broad wildcard is acceptable when the DSN is
 * unparseable — fail-open is safer than CSP-blocking error reports —
 * but we log so misconfig is visible.
 */
function sentryConnectSrc(): string {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return "";
  try {
    const u = new URL(dsn);
    // Org-specific host like o123.ingest.us.sentry.io — exact, no wildcard.
    return ` https://${u.hostname}`;
  } catch {
    // Malformed DSN — keep Sentry working with the broad pattern but
    // accept the wider CSP surface as a deliberate fail-open.
    return " https://*.ingest.us.sentry.io https://*.ingest.sentry.io";
  }
}
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
  `connect-src 'self'${sentryConnectSrc()}`,
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
  //
  // M2 NOTE on 'wasm-unsafe-eval' in strict mode: this is required by
  // argon2-browser (src/lib/crypto/crypto-client.ts → argon2idHash), which
  // is the load-bearing KDF for the vault wrapping key. Removing it breaks
  // vault setup / unlock entirely. The residual risk — XSS payload could
  // compile a WebAssembly module bypassing strict-dynamic — is accepted in
  // threat-model.md §5.7. Mitigations in place:
  //   - 'unsafe-eval' (legacy JS eval) is NOT permitted in strict mode.
  //   - 'strict-dynamic' still constrains which scripts can boot in the
  //     first place; an XSS must clear that gate before it can even attempt
  //     to instantiate WASM.
  //   - 'worker-src 'self'' (below) blocks loading worker scripts from any
  //     other origin, so even WASM-in-Worker payloads must originate from
  //     this app's served bundles.
  // If argon2-browser is ever replaced with a non-WASM Argon2id (or with
  // PBKDF2-via-WebCrypto, accepting the memory-hardness loss), this string
  // should drop 'wasm-unsafe-eval'.
  const scriptSrc = _cspMode === "dev"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'"
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`;
  const styleSrc = _cspMode === "dev"
    ? _stylePrefix
    : `${_stylePrefix}${nonce}${_styleSuffix}`;
  // worker-src defaults to child-src which defaults to default-src. Pin it
  // explicitly to 'self' so a future change to default-src can't accidentally
  // widen where workers can load from — relevant because WASM compilation
  // can happen inside a Worker context and we want both paths constrained.
  return `default-src 'self'; ${scriptSrc}; ${styleSrc}; worker-src 'self'; ${_staticDirectives}`;
}
