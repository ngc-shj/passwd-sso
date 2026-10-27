import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  applyCorsHeaders,
  handleApiPreflight,
  isBearerBypassRoute,
  isBearerBypassPath,
} from "./cors-gate";
import { getSessionInfo, hasSessionCookie } from "./auth-gate";
import { classifyRoute, ROUTE_POLICY_KIND } from "./route-policy";
import { shouldEnforceCsrf, assertSessionCsrf } from "./csrf-gate";
import { extractClientIp } from "../auth/policy/ip-access";
import { checkAccessRestrictionWithAudit } from "../auth/policy/access-restriction";
import { errorResponse } from "@/lib/http/api-response";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { API_ERROR, type ApiErrorCode } from "@/lib/http/api-error-codes";
import { passkeyEnforcementBlocks } from "../auth/policy/passkey-enforcement";
import {
  auditSessionPasskeyBlock,
  blockedPath,
  isApiDefaultSessionReader,
  isSessionGateOwnGate,
  isSessionGateTierA,
  isSessionGateTierB,
} from "./session-passkey-gate";

export async function handleApiAuth(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const policy = classifyRoute(pathname);
  // Bearer-bypass eligibility is a code-path concern (which dispatch
  // branch the orchestrator takes), not a classification concern. Routes
  // that accept Bearer as alternative auth are still classified as
  // api-session-required; we ask cors-gate directly whether the bypass
  // dispatch is eligible for this specific path.
  // Method-aware bypass eligibility for the actual request. Preflight uses
  // the path-only variant below — an OPTIONS request's method is never an
  // allowlisted method, so a method-aware check would wrongly deny preflight.
  const isBearerRoute = isBearerBypassRoute(pathname, request.method);
  const isExchangeRoute = policy.kind === ROUTE_POLICY_KIND.API_EXTENSION_EXCHANGE;
  const isBridgeCodeRoute = policy.kind === ROUTE_POLICY_KIND.API_EXTENSION_BRIDGE_CODE;

  // Preflight (handled regardless of policy.kind). CORS preflight grants no
  // server-side auth, so it gates on path-eligibility (any allowed method);
  // the real request still passes through the method-aware gate above.
  if (request.method === "OPTIONS") {
    return handleApiPreflight(request, {
      isBearerRoute: isBearerBypassPath(pathname),
      isExchangeRoute,
      isBridgeCodeRoute,
    });
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

  // POST /api/extension/bridge-code — chrome-extension Origin + session
  // cookie + DPoP. The CSRF gate would otherwise reject the cookie+POST
  // request because Origin is chrome-extension://<id>, not APP_URL. The
  // route handler enforces its own Origin allowlist check + auth() + DPoP
  // + tenant IP restriction. MUST short-circuit BEFORE the CSRF gate fires
  // — see plan C2 (Round-2 S14/T16 load-bearing wiring).
  if (isBridgeCodeRoute) {
    const res = NextResponse.next();
    res.headers.set("Cache-Control", "private, no-store");
    return applyCorsHeaders(request, res, { allowExtensionCredentials: true });
  }

  // Baseline CSRF gate: request-attribute-based, path-independent.
  // Fires whenever a request carries a session cookie AND uses a
  // mutating method, regardless of route classification. This closes
  // pre1 (a mutating route without its own Origin check) and the R3
  // baseline gap structurally.
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

  // Session gate. Session-required routes are always evaluated; an
  // API_DEFAULT route only when a session cookie is present, since without
  // one there is nothing to gate. Bearer-bypass-eligible routes that didn't
  // take the bypass branch above (e.g., session-cookie-only callers to
  // /api/passwords, or a cookie beside a junk Bearer) flow through here too.
  // Note: /api/scim/v2/* is intentionally NOT session-required — SCIM
  // endpoints use their own Bearer token auth in each route handler.
  //
  // Tier A is decided first, before any session read: the proxy's own
  // requests (getSessionInfo's fetch to /api/auth/session lands here) and
  // Auth.js's handler paths.
  const isSessionRequired = policy.kind === ROUTE_POLICY_KIND.API_SESSION_REQUIRED;
  if (
    (isSessionRequired || cookiePresent) &&
    !isSessionGateTierA(request.method, pathname)
  ) {
    const refusal = await gateSession(request, pathname, isSessionRequired);
    if (refusal) return applyCorsHeaders(request, refusal);
  }

  // Default (api-default): prevent CDN/proxy from caching authenticated
  // API responses. Route handlers may override with explicit
  // Cache-Control headers.
  const res = NextResponse.next();
  res.headers.set("Cache-Control", "private, no-store");
  return applyCorsHeaders(request, res);
}

/**
 * The session gate after Tier A. Returns the refusal, or null to pass the
 * request on to the route.
 */
async function gateSession(
  request: NextRequest,
  pathname: string,
  isSessionRequired: boolean,
): Promise<NextResponse | null> {
  const { method } = request;
  const session = await getSessionInfo(request);
  if (!session.valid) {
    if (isSessionRequired) return noStoreError(API_ERROR.UNAUTHORIZED);
    // API_DEFAULT: keyed on whether the route reads the session, not on why
    // the session is invalid — the proxy cannot tell "no session" from a
    // fault. Own-gate routes run their own auth; a route that reads no
    // session cannot be authenticated by a stale cookie.
    if (isSessionGateOwnGate(method, pathname)) return null;
    if (isApiDefaultSessionReader(method, pathname)) {
      return noStoreError(API_ERROR.UNAUTHORIZED);
    }
    return null;
  }

  if (isSessionRequired && session.tenantId) {
    const clientIp = extractClientIp(request);
    const accessResult = await checkAccessRestrictionWithAudit(
      session.tenantId,
      clientIp,
      session.userId ?? null,
      request,
    );
    if (!accessResult.allowed) return noStoreError(API_ERROR.ACCESS_DENIED);
  }

  // Tier B and own-gate routes decide on the raw passkey fields themselves,
  // so they stay closed while the bundle is degraded.
  if (isSessionGateTierB(method, pathname)) return null;
  if (isSessionGateOwnGate(method, pathname)) return null;

  // The session callback could not read the passkey state: an outage, not a
  // requirement. Still refused, but neither as PASSKEY_REQUIRED nor audited.
  if (session.passkeyStateDegraded) return noStoreError(API_ERROR.SERVICE_UNAVAILABLE);

  if (passkeyEnforcementBlocks(session)) {
    // A valid session with a userId always carries its tenant: getSessionInfo
    // refuses one whose tenant does not resolve, and the session cache evicts a
    // positive entry without one. The check narrows the type.
    if (session.userId && session.tenantId) {
      await auditSessionPasskeyBlock({
        req: request,
        userId: session.userId,
        tenantId: session.tenantId,
        blockedPath: blockedPath(method, pathname),
      });
    }
    return noStoreError(API_ERROR.PASSKEY_REQUIRED);
  }
  return null;
}

function noStoreError(code: ApiErrorCode): NextResponse {
  return errorResponse(code, undefined, undefined, NO_STORE_HEADERS);
}
