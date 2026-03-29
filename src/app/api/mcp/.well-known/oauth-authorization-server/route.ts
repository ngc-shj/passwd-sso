import { type NextRequest, NextResponse } from "next/server";
import { MCP_SCOPES } from "@/lib/constants/mcp";

export async function GET(req: NextRequest) {
  const baseUrl = new URL("/", req.url).origin;

  return NextResponse.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/api/mcp/authorize`,
    token_endpoint: `${baseUrl}/api/mcp/token`,
    registration_endpoint: `${baseUrl}/api/mcp/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post"],
    scopes_supported: MCP_SCOPES,
  });
}
