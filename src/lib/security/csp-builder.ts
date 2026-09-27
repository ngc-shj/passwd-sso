// CSP header construction for the Next.js proxy. Extracted from `proxy.ts`
// (root) so it can be unit-tested without pulling in the full Next.js
// middleware import chain (next-intl, etc.).

import { bootStderr } from "@/lib/boot-stderr";
import { BOOT_EVENT } from "@/lib/boot-events";

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
 * unparseable — fail-open is safer than CSP-blocking error reports.
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
  // Module-scope, so this fires during initialization before any logger is
  // guaranteed to exist — same constraint as the env banner. It is also an
  // operator signal about a server env var, not a browser-user signal, so the
  // client logger would be the wrong sink even setting init order aside.
  bootStderr({ event: BOOT_EVENT.CSP_MODE_IGNORED });
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
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
  "report-to csp-endpoint",
  `report-uri ${_reportUri}`,
].join("; ");

/**
 * Loopback sources `form-action` always carries.
 *
 * OAuth consent form-POSTs to /api/mcp/authorize/consent, which returns a 302
 * to the client's registered callback. `form-action` constrains BOTH the form
 * target AND every redirect in the chain, so a callback host missing here is
 * blocked *after* the authorization audit row has been written — a grant the
 * client never receives and the audit trail says it did.
 *
 * RFC 8252 §7.3 mandates the loopback IP literals and "MUST allow any port";
 * §8.3 marks `localhost` NOT RECOMMENDED but real clients (Claude Code,
 * Claude Desktop) use it. Loopback is local-only, so the wildcards widen no
 * network surface.
 *
 * `http://[::1]:*` IS INERT — CSP3's host-source grammar has no IPv6-literal
 * production and Chromium discards it on every page load. It stays because
 * removing it is a behaviour change nobody asked for; nothing may be built on
 * the belief that it grants what RFC 8252 requires. That obligation is met
 * from the other side instead: `LOOPBACK_REDIRECT_RE` refuses `[::1]` at
 * registration, and authorize/consent re-check the stored value.
 *
 * NOT listed: `https:`. A hosted (non-loopback) client's callback is admitted
 * per request instead — see `extraFormActionSources`. Listing `https:` here
 * would let any page in the app submit a form to any https origin, which is
 * the exfiltration this directive exists to stop.
 */
const _formActionBase = "'self' http://localhost:* http://127.0.0.1:* http://[::1]:*";

/**
 * @param extraFormActionSources additional `form-action` origins for THIS
 *   response only. The consent page passes the registered callback origins of
 *   the client being consented to, so a hosted client's 302 is admitted
 *   without `https:` being open on every other page. Callers must supply
 *   origins they have already validated against stored registration data —
 *   never a value taken from the request.
 */
export function buildCspHeader(
  nonce: string,
  extraFormActionSources: readonly string[] = [],
): string {
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
  // hash-wasm (src/lib/crypto/crypto-client.ts → argon2idHash), which is
  // the load-bearing KDF for the vault wrapping key. Removing it breaks
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
  // If hash-wasm is ever replaced with a non-WASM Argon2id (e.g. pure-JS
  // @noble/hashes/argon2id, accepting the speed loss), this string should
  // drop 'wasm-unsafe-eval'.
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
  const formAction = [
    "form-action",
    _formActionBase,
    ...extraFormActionSources,
  ].join(" ");
  return `default-src 'self'; ${scriptSrc}; ${styleSrc}; worker-src 'self'; ${formAction}; ${_staticDirectives}`;
}
