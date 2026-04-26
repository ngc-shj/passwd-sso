import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  applyCorsHeaders,
  handleApiPreflight,
  isBearerBypassRoute,
} from "./cors-gate";
import { getSessionInfo, hasSessionCookie } from "./auth-gate";
import { classifyRoute, ROUTE_POLICY_KIND } from "./route-policy";
import { shouldEnforceCsrf, assertSessionCsrf } from "./csrf-gate";
import { extractClientIp } from "../auth/policy/ip-access";
import { checkAccessRestrictionWithAudit } from "../auth/policy/access-restriction";

export async function handleApiAuth(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const policy = classifyRoute(pathname);
  // Bearer-bypass eligibility is a code-path concern (which dispatch
  // branch the orchestrator takes), not a classification concern. Routes
  // that accept Bearer as alternative auth are still classified as
  // api-session-required; we ask cors-gate directly whether the bypass
  // dispatch is eligible for this specific path.
  const isBearerRoute = isBearerBypassRoute(pathname);
  const isExchangeRoute = policy.kind === ROUTE_POLICY_KIND.API_EXTENSION_EXCHANGE;

  // Preflight (handled regardless of policy.kind).
  if (request.method === "OPTIONS") {
    return handleApiPreflight(request, { isBearerRoute, isExchangeRoute });
  }

  // Non-CSRF early returns. ALL paths outside the cookie-CSRF threat
  // model MUST short-circuit BEFORE the CSRF gate fires.
  if (policy.kind === ROUTE_POLICY_KIND.PUBLIC_SHARE) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  if (policy.kind === ROUTE_POLICY_KIND.PUBLIC_RECEIVER) {
    return NextResponse.next();
  }
  if (policy.kind === ROUTE_POLICY_KIND.API_V1) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  }

  // Baseline CSRF gate: request-attribute-based, path-independent.
  // Fires whenever a request carries a session cookie AND uses a
  // mutating method, regardless of route classification. This closes
  // pre1 (audit-emit) and the R3 baseline gap structurally.
  const cookieHeader = request.headers.get("cookie") ?? "";
  const cookiePresent = hasSessionCookie(cookieHeader);
  if (shouldEnforceCsrf(request, cookiePresent)) {
    const csrfError = assertSessionCsrf(request);
    if (csrfError) return applyCorsHeaders(request, csrfError);
  }

  const hasBearer = request.headers
    .get("authorization")
    ?.startsWith("Bearer ");

  // Bearer-bypass only applies when no session cookie is present. If both
  // are sent, authOrToken prefers session (auth-or-token.ts:64-68) and the
  // tenant IP restriction must still gate the request — falling through to
  // the session-authenticated path below enforces it. Legitimate Bearer-
  // only clients (extension from chrome-extension:// origin, API key
  // clients, SA / MCP tokens) do not ship the Auth.js session cookie, so
  // the bypass still applies to them.
  if (hasBearer && isBearerRoute && !cookiePresent) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    return applyCorsHeaders(request, res, { allowExtension: true });
  }

  // POST /api/extension/token/exchange — bootstraps a bearer token from a
  // one-time bridge code. No session, no Bearer. Called by the extension
  // content script (isolated world). The route handler validates the code
  // and atomically consumes it. CORS must allow chrome-extension origins.
  if (isExchangeRoute) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    return applyCorsHeaders(request, res, { allowExtension: true });
  }

  // Session-required routes. Bearer-bypass-eligible routes that didn't
  // take the bypass branch above (e.g., session-cookie-only callers to
  // /api/passwords) flow through here too, since they're classified as
  // api-session-required by route-policy. Note: /api/scim/v2/* is
  // intentionally NOT in this classification — SCIM endpoints use their
  // own Bearer token auth in each route handler.
  if (policy.kind === ROUTE_POLICY_KIND.API_SESSION_REQUIRED) {
    const session = await getSessionInfo(request);
    if (!session.valid) {
      return applyCorsHeaders(
        request,
        NextResponse.json(
          { error: "UNAUTHORIZED" },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        ),
      );
    }

    if (session.tenantId) {
      const clientIp = extractClientIp(request);
      const accessResult = await checkAccessRestrictionWithAudit(
        session.tenantId,
        clientIp,
        session.userId ?? null,
        request,
      );
      if (!accessResult.allowed) {
        return applyCorsHeaders(
          request,
          NextResponse.json(
            { error: "ACCESS_DENIED" },
            { status: 403, headers: { "Cache-Control": "no-store" } },
          ),
        );
      }
    }
  }

  // Default (api-default): prevent CDN/proxy from caching authenticated
  // API responses. Route handlers may override with explicit
  // Cache-Control headers.
  const res = NextResponse.next();
  res.headers.set("Cache-Control", "private, no-store");
  return applyCorsHeaders(request, res);
}
