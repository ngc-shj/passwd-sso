import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { createAuthorizationCode } from "@/lib/mcp/oauth-server";
import { MCP_SCOPES } from "@/lib/constants/mcp";
import { logAudit, extractRequestMeta } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit";
import { assertOrigin } from "@/lib/csrf";

export async function POST(req: NextRequest) {
  // CSRF protection: Origin header is mandatory for consent (defense-in-depth)
  const origin = req.headers.get("origin");
  if (!origin) {
    return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  }
  const originError = assertOrigin(req);
  if (originError) return originError;

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Parse form data submitted from the consent UI
  const formData = await req.formData();
  const clientId = formData.get("client_id") as string;
  const redirectUri = formData.get("redirect_uri") as string;
  const state = formData.get("state") as string;
  const action = formData.get("action") as string;

  if (!clientId || !redirectUri) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Validate client (must happen before redirect to prevent open redirect)
  const client = await withBypassRls(prisma, async () =>
    prisma.mcpClient.findFirst({ where: { clientId, isActive: true } }),
  );

  if (!client) {
    return NextResponse.json({ error: "invalid_client" }, { status: 400 });
  }

  // Validate redirect_uri (must happen before redirect to prevent open redirect)
  if (!client.redirectUris.includes(redirectUri)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // DCR clients must be claimed before consent
  if (client.isDcr && !client.tenantId) {
    return NextResponse.json(
      { error: "invalid_client", error_description: "DCR client not yet claimed" },
      { status: 400 },
    );
  }

  // Tenant check
  const userRecord = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  );
  const userTenantId = userRecord?.tenantId;
  if (!userTenantId || (client.tenantId && client.tenantId !== userTenantId)) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  // Handle deny action
  if (action === "deny") {
    const { ip, userAgent } = extractRequestMeta(req);
    logAudit({
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.MCP_CONSENT_DENY,
      userId: session.user.id,
      tenantId: userTenantId,
      targetType: "McpClient",
      targetId: client.id,
      metadata: { clientId },
      ip: ip ?? undefined,
      userAgent: userAgent ?? undefined,
    });
    const denyUrl = new URL(redirectUri);
    denyUrl.searchParams.set("error", "access_denied");
    if (state) denyUrl.searchParams.set("state", state);
    return NextResponse.redirect(denyUrl.toString(), 302);
  }

  const scope = formData.get("scope") as string;
  const codeChallenge = formData.get("code_challenge") as string;
  const codeChallengeMethod = (formData.get("code_challenge_method") as string) || "S256";

  if (!scope || !codeChallenge) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  if (codeChallengeMethod !== "S256") {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Validate scopes
  const allowedScopes = client.allowedScopes.split(",").filter(Boolean);
  const requestedScopes = scope.split(" ").filter(Boolean);
  const grantedScopes = requestedScopes.filter(
    (s) => allowedScopes.includes(s) && (MCP_SCOPES as readonly string[]).includes(s),
  );

  if (grantedScopes.length === 0) {
    const url = new URL(redirectUri);
    url.searchParams.set("error", "invalid_scope");
    if (state) url.searchParams.set("state", state);
    return NextResponse.redirect(url.toString(), 302);
  }

  // Create authorization code
  const { code } = await createAuthorizationCode({
    clientId: client.id,
    tenantId: userTenantId,
    userId: session.user.id,
    redirectUri,
    scope: grantedScopes.join(","),
    codeChallenge,
    codeChallengeMethod,
  });

  // Audit the consent grant
  const { ip, userAgent } = extractRequestMeta(req);
  logAudit({
    scope: AUDIT_SCOPE.TENANT,
    action: AUDIT_ACTION.MCP_CONSENT_GRANT,
    userId: session.user.id,
    tenantId: userTenantId,
    targetType: "McpClient",
    targetId: client.id,
    metadata: { clientId: client.clientId, scopes: grantedScopes },
    ip: ip ?? undefined,
    userAgent: userAgent ?? undefined,
  });

  // Redirect back to the OAuth client with the authorization code
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return NextResponse.redirect(url.toString(), 302);
}
