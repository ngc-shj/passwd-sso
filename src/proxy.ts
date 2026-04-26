import type { NextRequest } from "next/server";
import { API_PATH } from "./lib/constants";
import { handleApiAuth } from "./lib/proxy/api-route";
import { handlePageRoute, type ProxyOptions } from "./lib/proxy/page-route";

export async function proxy(request: NextRequest, options: ProxyOptions) {
  const { pathname } = request.nextUrl;

  // API routes: dispatch to api-route handler (no security headers).
  if (pathname.startsWith(`${API_PATH.API_ROOT}/`)) {
    return handleApiAuth(request);
  }

  // Page routes: i18n, auth, access restriction, passkey enforcement.
  return handlePageRoute(request, options);
}
