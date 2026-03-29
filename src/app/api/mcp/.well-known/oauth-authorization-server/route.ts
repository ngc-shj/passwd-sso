import { NextResponse } from "next/server";
import { MCP_SCOPES } from "@/lib/constants/mcp";
import { serverAppUrl, getAppOrigin } from "@/lib/url-helpers";

export async function GET() {
  return NextResponse.json({
    issuer: getAppOrigin() ?? "",
    authorization_endpoint: serverAppUrl("/api/mcp/authorize"),
    token_endpoint: serverAppUrl("/api/mcp/token"),
    registration_endpoint: serverAppUrl("/api/mcp/register"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    scopes_supported: MCP_SCOPES,
  });
}
