import { NextRequest } from "next/server";

const BODYLESS_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);

/**
 * `tailscale serve` populates `X-Forwarded-Port` with the BACKEND port
 * (the upstream the funnel forwards to, e.g. `3001`) rather than the
 * public ingress port. next-intl's locale-prefix middleware then trusts
 * that header and bakes the backend port into the redirect Location URL,
 * producing user-visible URLs like
 * `https://app.example.com:3001/passwd-sso/ja/dashboard`.
 *
 * Override the X-Forwarded-* trio (and `Host`) against canonical
 * APP_URL/AUTH_URL so downstream redirect builders see a coherent
 * forwarded identity. Scoped to Tailscale-originated requests only —
 * detected via Tailscale's own `Tailscale-*` headers — so production
 * deployments behind nginx / Cloudflare / ALB keep their proxy headers
 * untouched and authoritative.
 *
 * Note: `request.url` is intentionally NOT modified. Mutating the URL
 * breaks Next.js's basePath inference (`/passwd-sso/ja/...` collapses to
 * `/ja/passwd-sso/...`). Headers are the only safe lever.
 */
export function normalizeForwardedHeaders(request: NextRequest): NextRequest {
  if (!isViaTailscaleServe(request)) return request;

  const canonicalRaw = process.env.APP_URL || process.env.AUTH_URL;
  if (!canonicalRaw) return request;

  let canonical: URL;
  try {
    canonical = new URL(canonicalRaw);
  } catch {
    return request;
  }

  // The forwarded host's hostname must match canonical, otherwise we have
  // no business rewriting it (could be a tailnet peer addressing the box
  // by a different MagicDNS name, or an SSRF probe).
  const externalHostRaw =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!externalHostRaw) return request;

  let externalHostname: string;
  try {
    externalHostname = new URL(`http://${externalHostRaw}`).hostname;
  } catch {
    return request;
  }
  if (externalHostname !== canonical.hostname) return request;

  const canonicalProto = canonical.protocol.replace(/:$/, "");
  // canonical.port is "" when AUTH_URL uses the default port for its
  // scheme. Empty is a valid X-Forwarded-Port signal — propagate as
  // header deletion rather than injecting an explicit "443"/"80".
  const canonicalPort = canonical.port;

  const sameXfHost = request.headers.get("x-forwarded-host") === canonical.host;
  const sameXfPort = (request.headers.get("x-forwarded-port") ?? "") === canonicalPort;
  const sameXfProto = request.headers.get("x-forwarded-proto") === canonicalProto;
  const sameHost = request.headers.get("host") === canonical.host;
  if (sameXfHost && sameXfPort && sameXfProto && sameHost) return request;

  const headers = new Headers(request.headers);
  headers.set("x-forwarded-host", canonical.host);
  headers.set("x-forwarded-proto", canonicalProto);
  if (canonicalPort) {
    headers.set("x-forwarded-port", canonicalPort);
  } else {
    headers.delete("x-forwarded-port");
  }
  headers.set("host", canonical.host);

  // `signal`: lib.dom's RequestInit.signal is `AbortSignal | null | undefined`
  // but NextRequest tightens to `AbortSignal | undefined`. Coalesce.
  const signal: AbortSignal | undefined = request.signal ?? undefined;
  // `nextConfig.basePath`: without this, the basePath context is lost when we
  // construct the new NextRequest, and next-intl emits redirects with the
  // locale prefix BEFORE basePath (`/ja/passwd-sso/...` instead of
  // `/passwd-sso/ja/...`). Carry the original basePath forward explicitly.
  const init: Omit<RequestInit, "signal"> & {
    duplex?: "half";
    signal?: AbortSignal;
    nextConfig?: { basePath?: string };
  } = {
    method: request.method,
    headers,
    signal,
    nextConfig: { basePath: request.nextUrl.basePath || undefined },
  };

  if (!BODYLESS_METHODS.has(request.method.toUpperCase())) {
    init.body = request.body;
    init.duplex = "half";
  }

  // Reuse request.url verbatim — see header-only rationale in the docblock.
  return new NextRequest(request.url, init);
}

/**
 * Tailscale serve injects a fixed set of `Tailscale-*` headers (see
 * https://tailscale.com/s/serve-headers) on every forwarded request.
 * These headers are not standard / spoofable from outside the tailnet
 * because they originate after TLS termination at the local
 * `tailscaled` daemon — an external attacker would have to compromise
 * the tailnet to inject them.
 */
function isViaTailscaleServe(request: NextRequest): boolean {
  return (
    request.headers.has("tailscale-headers-info") ||
    request.headers.has("tailscale-user-login")
  );
}
