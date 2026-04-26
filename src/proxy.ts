import type { NextRequest } from "next/server";
import { API_PATH } from "./lib/constants";
import { applySecurityHeaders } from "./lib/proxy/security-headers";
import {
  setSessionCache,
  extractSessionToken,
  sessionCache,
} from "./lib/proxy/auth-gate";
import { handleApiAuth } from "./lib/proxy/api-route";
import {
  handlePageRoute,
  passkeyAuditEmitted,
  PASSKEY_AUDIT_MAP_MAX,
  PASSKEY_AUDIT_DEDUP_MS,
  recordPasskeyAuditEmit,
  type ProxyOptions,
} from "./lib/proxy/page-route";

export async function proxy(request: NextRequest, options: ProxyOptions) {
  const { pathname } = request.nextUrl;

  // API routes: dispatch to api-route handler (no security headers).
  if (pathname.startsWith(`${API_PATH.API_ROOT}/`)) {
    return handleApiAuth(request);
  }

  // Page routes: i18n, auth, access restriction, passkey enforcement.
  return handlePageRoute(request, options);
}

// Test-only shims: re-export from new module locations so existing tests
// (src/__tests__/proxy.test.ts) continue to import via this path.
export { applySecurityHeaders as _applySecurityHeaders };
export { extractSessionToken as _extractSessionToken };
export { setSessionCache as _setSessionCache };
export { sessionCache as _sessionCache };
export { passkeyAuditEmitted as _passkeyAuditEmitted };
export { PASSKEY_AUDIT_MAP_MAX as _PASSKEY_AUDIT_MAP_MAX };
export { PASSKEY_AUDIT_DEDUP_MS as _PASSKEY_AUDIT_DEDUP_MS };
export { recordPasskeyAuditEmit as _recordPasskeyAuditEmit };
