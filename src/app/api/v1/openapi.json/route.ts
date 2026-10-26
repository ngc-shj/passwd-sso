import { NextRequest, NextResponse } from "next/server";
import { buildOpenApiSpec } from "@/lib/openapi-spec";
import { authOrToken } from "@/lib/auth/session/auth-or-token";
import { withRequestLog } from "@/lib/http/with-request-log";
import { errorResponse } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";
import { getAppOrigin, resolveBasePath } from "@/lib/url-helpers";
import { withUserTenantRls } from "@/lib/tenant-context";
import { logAuditAsync, personalAuditBase } from "@/lib/audit/audit";
import { AUDIT_ACTION } from "@/lib/constants";
import {
  derivePasskeyState,
  passkeyEnforcementBlocks,
  recordPasskeyAuditEmit,
} from "@/lib/auth/policy/passkey-enforcement";

const OPENAPI_PASSKEY_BLOCKED_PATH = "/api/v1/openapi.json";

// GET /api/v1/openapi.json — OpenAPI 3.1 specification
async function handleGET(req: NextRequest) {
  const isPublic = process.env.OPENAPI_PUBLIC !== "false";

  if (!isPublic) {
    // Intentional any-auth gate: this endpoint is a non-scoped resource — any valid
    // auth token (session / extension / api_key / mcp / SA) is acceptable. NOT a
    // scope-gated resource; do NOT pass a scope to authOrToken here.
    const result = await authOrToken(req);
    if (!result) {
      return errorResponse(API_ERROR.UNAUTHORIZED, undefined, undefined, { "Cache-Control": "no-store" });
    }
    if (result.type === "passkey_required") {
      return errorResponse(API_ERROR.PASSKEY_REQUIRED, undefined, undefined, { "Cache-Control": "no-store" });
    }
    // Own-gate route (#959 S7): this early return never reaches the proxy's
    // session passkey gate, so a session result re-derives the block itself
    // instead of trusting the proxy to have already checked it. A Bearer
    // result is already covered above — authOrToken's token validators each
    // run their own per-use passkey gate (passkeyGateBlocks, #965).
    if (result.type === "session") {
      const tenantId = await withUserTenantRls(result.userId, async (tid) => tid);
      const pkState = await derivePasskeyState({ userId: result.userId, tenantId });
      if (passkeyEnforcementBlocks(pkState)) {
        if (recordPasskeyAuditEmit(result.userId, OPENAPI_PASSKEY_BLOCKED_PATH, Date.now())) {
          await logAuditAsync({
            ...personalAuditBase(req, result.userId),
            tenantId,
            action: AUDIT_ACTION.PASSKEY_ENFORCEMENT_BLOCKED,
            metadata: { blockedPath: OPENAPI_PASSKEY_BLOCKED_PATH },
          });
        }
        return errorResponse(API_ERROR.PASSKEY_REQUIRED, undefined, undefined, { "Cache-Control": "no-store" });
      }
    }
  }

  // Derive the servers[].url from the configured canonical origin
  // (APP_URL/AUTH_URL), never from the request Host header. A request-derived
  // host lets a Host-header-poisoning request inject an attacker domain into
  // the spec's servers[], which the public cache below would then serve to
  // other clients. This mirrors the host policy used elsewhere (e.g. the
  // mobile authorize redirect helper). When no origin is configured, fall back
  // to a request-derived base but never public-cache it.
  const origin = getAppOrigin();
  let baseUrl: string;
  let hostIsCanonical: boolean;
  if (origin) {
    const base = new URL(origin);
    baseUrl = `${base.origin}${resolveBasePath(base)}`;
    hostIsCanonical = true;
  } else {
    const url = new URL(req.url);
    const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
    baseUrl = `${url.protocol}//${url.host}${basePath}`;
    hostIsCanonical = false;
  }
  const spec = buildOpenApiSpec(baseUrl);

  // Public-cache only when the servers[] host came from configured origin.
  // A request-derived host must not be cached (would poison other clients).
  const publicCacheable = isPublic && hostIsCanonical;
  const headers: Record<string, string> = {
    "Cache-Control": publicCacheable
      ? "public, max-age=3600"
      : isPublic
        ? "no-store"
        : "private, no-store",
  };
  if (isPublic) {
    headers["Vary"] = "Authorization";
  }

  return NextResponse.json(spec, { headers });
}

export const GET = withRequestLog(handleGET);
