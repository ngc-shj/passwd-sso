import { type NextRequest, NextResponse } from "next/server";
import { hashToken } from "@/lib/crypto-server";
import { exchangeCodeForToken } from "@/lib/mcp/oauth-server";

export async function POST(req: NextRequest) {
  let body: Record<string, string>;
  const contentType = req.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      body = Object.fromEntries(new URLSearchParams(text));
    } else {
      body = await req.json() as Record<string, string>;
    }
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const { grant_type, code, redirect_uri, client_id, client_secret, code_verifier } = body;

  if (grant_type !== "authorization_code") {
    return NextResponse.json({ error: "unsupported_grant_type" }, { status: 400 });
  }
  if (!code || !redirect_uri || !client_id || !client_secret || !code_verifier) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const clientSecretHash = hashToken(client_secret);

  const result = await exchangeCodeForToken({
    code,
    clientId: client_id,
    clientSecretHash,
    redirectUri: redirect_uri,
    codeVerifier: code_verifier,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  return NextResponse.json({
    access_token: result.data.accessToken,
    token_type: result.data.tokenType,
    expires_in: result.data.expiresIn,
    scope: result.data.scope,
  });
}
