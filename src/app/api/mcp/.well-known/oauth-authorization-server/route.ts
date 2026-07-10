import { NextResponse } from "next/server";
import { MCP_SCOPES } from "@/lib/constants/auth/mcp";
import { serverAppUrl, getAppOrigin } from "@/lib/url-helpers";
import { errorResponse } from "@/lib/http/api-response";
import { API_ERROR } from "@/lib/http/api-error-codes";

export async function GET() {
  const issuer = getAppOrigin();
  // RFC 8414 §2 requires `issuer` to be a valid absolute URL equal to the
  // metadata origin. With no configured origin, issuer would be "" and every
  // endpoint below would collapse to a relative path — a malformed 200
  // document. Fail closed instead, matching the origin-dependent consent route.
  if (!issuer) return errorResponse(API_ERROR.INTERNAL_ERROR);

  return NextResponse.json({
    issuer,
    authorization_endpoint: serverAppUrl("/api/mcp/authorize"),
    token_endpoint: serverAppUrl("/api/mcp/token"),
    registration_endpoint: serverAppUrl("/api/mcp/register"),
    revocation_endpoint: serverAppUrl("/api/mcp/revoke"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    scopes_supported: MCP_SCOPES,
  });
}
