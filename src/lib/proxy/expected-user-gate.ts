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
 * `fetchApi` names the user the page believes it acts for in
 * EXPECTED_USER_HEADER. This gate refuses, before any route runs and for every
 * method, a request that carries a session cookie and that header unless the
 * cookie resolves to a valid session of exactly that user. A session that does
 * not resolve (ended, ambiguous, or unreadable) is refused too: the proxy
 * cannot show the cookie is still the expected user's, and the route would
 * otherwise read the cookie itself.
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
import type { SessionInfo } from "./auth-gate";

/**
 * Returns the refusal, or null to continue. `readSession` is only called when
 * the request carries both the header and a session cookie.
 */
export async function assertExpectedUser(
  request: NextRequest,
  cookiePresent: boolean,
  readSession: () => Promise<SessionInfo>,
): Promise<NextResponse | null> {
  const expectedUserId = request.headers.get(EXPECTED_USER_HEADER);
  if (expectedUserId === null || !cookiePresent) return null;

  const session = await readSession();
  if (session.valid && session.userId !== undefined && session.userId === expectedUserId) {
    return null;
  }
  return errorResponse(API_ERROR.SESSION_CHANGED, undefined, undefined, NO_STORE_HEADERS);
}
