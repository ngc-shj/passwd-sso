/**
 * Expected-user binding for cookie-bearing API requests.
 *
 * The session cookie is shared by every tab of the origin, so a page rendered
 * for user A sends whatever cookie the browser holds now. When B signs in in
 * another tab, A's page keeps running (timers, focus handlers, multi-step
 * flows holding A's key material) and its requests authenticate as B — routes
 * see a valid session and act on it. Zero-knowledge routes cannot tell that a
 * ciphertext was built from A's keys.
 *
 * `fetchApi` names the user the page was bound to in EXPECTED_USER_HEADER.
 * This gate asks one question, before any route runs and for every method:
 * whose session is this cookie? It decides on the cookie's identity, not on
 * whether the session is usable — validity (tenant, IP, passkey) stays the
 * session gate's call, so a user the proxy cannot resolve a tenant for is
 * still that user here, not a changed session.
 *
 * - The named user: continue.
 * - Another user (an empty header names nobody, so it is another user too):
 *   409 SESSION_CHANGED, on which `fetchApi` reloads the page.
 * - Nobody: continue, with every session cookie removed from the request the
 *   route sees. Pre-auth routes (passkey sign-in) must stay reachable with a
 *   dead cookie. But "nobody" is not a fact about the cookie: Auth.js answers
 *   200 with a null body both for a session that ended and when its own
 *   session lookup throws (@auth/core lib/actions/session.js swallows the
 *   error). A route that called `auth()` itself a moment later could then
 *   resolve the same cookie to another user. Stripping it makes the route see
 *   what the gate decided on: no session.
 * - The session read gave no answer: 503 SERVICE_UNAVAILABLE — a fault, which
 *   a reload would not fix.
 * - The cookie header reads as more than one session: 401 UNAUTHORIZED, the
 *   session gate's answer for the same cookie; a reload resends it unchanged.
 *
 * Out of scope by construction: a request without the header (the page does
 * not know its user yet, or the caller is not the web app), and a request
 * without a session cookie — Bearer, extension, CLI and SCIM callers
 * authenticate as their token's principal, which no cookie swap can change.
 */

import type { NextRequest } from "next/server";
import type { NextResponse } from "next/server";
import { EXPECTED_USER_HEADER } from "@/lib/constants/auth/expected-user";
import { errorResponse } from "@/lib/http/api-response";
import { NO_STORE_HEADERS } from "@/lib/http/cache-headers";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { withoutSessionCookies } from "@/lib/auth/session/session-cookie";
import { SESSION_IDENTITY, type ProxySessionInfo } from "./auth-gate";

export interface ExpectedUserDecision {
  /** The refusal, or null to continue. */
  refusal: NextResponse | null;
  /** The request headers the route must see instead of the request's own, or null to forward those untouched. */
  forwardHeaders: Headers | null;
}

const CONTINUE: ExpectedUserDecision = { refusal: null, forwardHeaders: null };

function refuse(response: NextResponse): ExpectedUserDecision {
  return { refusal: response, forwardHeaders: null };
}

/**
 * `readSession` is only called when the request carries both the header and a
 * session cookie.
 */
export async function assertExpectedUser(
  request: NextRequest,
  cookiePresent: boolean,
  readSession: () => Promise<ProxySessionInfo>,
): Promise<ExpectedUserDecision> {
  const expectedUserId = request.headers.get(EXPECTED_USER_HEADER);
  if (expectedUserId === null || !cookiePresent) return CONTINUE;

  const { identity } = await readSession();
  switch (identity.kind) {
    case SESSION_IDENTITY.USER:
      return identity.userId === expectedUserId
        ? CONTINUE
        : refuse(errorResponse(API_ERROR.SESSION_CHANGED, undefined, undefined, NO_STORE_HEADERS));
    case SESSION_IDENTITY.NONE:
      return { refusal: null, forwardHeaders: withoutSessionCookies(request.headers) };
    case SESSION_IDENTITY.AMBIGUOUS:
      return refuse(errorResponse(API_ERROR.UNAUTHORIZED, undefined, undefined, NO_STORE_HEADERS));
    case SESSION_IDENTITY.UNAVAILABLE:
      return refuse(errorResponse(API_ERROR.SERVICE_UNAVAILABLE, undefined, undefined, NO_STORE_HEADERS));
  }
}
