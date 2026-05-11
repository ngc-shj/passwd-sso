import type { NextRequest } from "next/server";
import { API_PATH } from "./lib/constants";
import { handleApiAuth } from "./lib/proxy/api-route";
import { handlePageRoute, type ProxyOptions } from "./lib/proxy/page-route";
import { normalizeForwardedHeaders } from "./lib/proxy/forwarded-headers";

export async function proxy(request: NextRequest, options: ProxyOptions) {
  // `tailscale serve` mis-populates X-Forwarded-Port with the backend port
  // (e.g. `3001` instead of the public ingress port). next-intl trusts that
  // header and bakes the wrong port into Location URLs. Realign the
  // forwarded headers against canonical APP_URL/AUTH_URL — Tailscale only
  // (production reverse proxies stay authoritative).
  const normalized = normalizeForwardedHeaders(request);
  const { pathname } = normalized.nextUrl;

  // API routes: dispatch to api-route handler (no security headers).
  if (pathname.startsWith(`${API_PATH.API_ROOT}/`)) {
    return handleApiAuth(normalized);
  }

  // Page routes: i18n, auth, access restriction, passkey enforcement.
  return handlePageRoute(normalized, options);
}
