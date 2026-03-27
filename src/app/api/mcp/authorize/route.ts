import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { createAuthorizationCode } from "@/lib/mcp/oauth-server";
import { MCP_SCOPES } from "@/lib/constants/mcp";

// GET /api/mcp/authorize?client_id=...&redirect_uri=...&response_type=code&scope=...&code_challenge=...&code_challenge_method=S256&state=...
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    // Redirect to login — include return URL
    const loginUrl = new URL("/api/auth/signin", req.url);
    loginUrl.searchParams.set("callbackUrl", req.url);
    return NextResponse.redirect(loginUrl);
  }

  const sp = req.nextUrl.searchParams;
  const clientId = sp.get("client_id");
  const redirectUri = sp.get("redirect_uri");
  const responseType = sp.get("response_type");
  const scope = sp.get("scope") ?? "";
  const codeChallenge = sp.get("code_challenge");
  const codeChallengeMethod = sp.get("code_challenge_method") ?? "S256";
  const state = sp.get("state");

  // Validate required params
  if (!clientId || !redirectUri || responseType !== "code" || !codeChallenge) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  if (codeChallengeMethod !== "S256") {
    return NextResponse.json({ error: "invalid_request", error_description: "Only S256 code_challenge_method is supported" }, { status: 400 });
  }

  // Look up client
  const client = await withBypassRls(prisma, async () =>
    prisma.mcpClient.findFirst({
      where: { clientId, isActive: true },
    }),
  );

  if (!client) {
    return NextResponse.json({ error: "invalid_client" }, { status: 400 });
  }

  // Validate redirect_uri
  if (!client.redirectUris.includes(redirectUri)) {
    return NextResponse.json({ error: "invalid_request", error_description: "redirect_uri not registered" }, { status: 400 });
  }

  // Verify client belongs to user's tenant
  const userRecord = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({ where: { id: session.user.id }, select: { tenantId: true } }),
  );

  const userTenantId = userRecord?.tenantId;
  if (!userTenantId || client.tenantId !== userTenantId) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  // Validate requested scopes against allowed
  const allowedScopeSet = new Set(client.allowedScopes.split(",").map((s) => s.trim()).filter(Boolean));
  const requestedScopes = scope.split(" ").filter(Boolean);
  const grantedScopes = requestedScopes.filter((s) => allowedScopeSet.has(s) && (MCP_SCOPES as string[]).includes(s));

  // Issue authorization code
  const { code } = await createAuthorizationCode({
    clientId: client.id,
    tenantId: client.tenantId,
    userId: session.user.id,
    redirectUri,
    scope: grantedScopes.join(","),
    codeChallenge,
    codeChallengeMethod,
  });

  // Redirect to client with code
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) redirectUrl.searchParams.set("state", state);

  return NextResponse.redirect(redirectUrl);
}
