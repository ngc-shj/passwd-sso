import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { createAuthorizationCode } from "@/lib/mcp/oauth-server";
import { MCP_SCOPES, MAX_MCP_CLIENTS_PER_TENANT } from "@/lib/constants/mcp";
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
  const foundClient = await withBypassRls(prisma, async () =>
    prisma.mcpClient.findFirst({ where: { clientId, isActive: true } }),
  );

  if (!foundClient) {
    return NextResponse.json({ error: "invalid_client" }, { status: 400 });
  }

  // Validate redirect_uri (must happen before redirect to prevent open redirect)
  if (!foundClient.redirectUris.includes(redirectUri)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // Tenant check
  const userRecord = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  );
  const userTenantId = userRecord?.tenantId;
  if (!userTenantId || (foundClient.tenantId && foundClient.tenantId !== userTenantId)) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  // Handle deny action (before claiming — deny should not bind the client)
  if (action === "deny") {
    const { ip, userAgent } = extractRequestMeta(req);
    logAudit({
      scope: AUDIT_SCOPE.TENANT,
      action: AUDIT_ACTION.MCP_CONSENT_DENY,
      userId: session.user.id,
      tenantId: userTenantId,
      targetType: "McpClient",
      targetId: foundClient.id,
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

  // The effective client for authorization — may be replaced by reuse during claiming
  let effectiveClient = foundClient;

  // DCR claiming: bind unclaimed client to user's tenant on Allow (not on page load)
  if (foundClient.isDcr && !foundClient.tenantId) {
    const clientIdDb = foundClient.id;
    const clientName = foundClient.name;

    const claimResult = await withBypassRls(prisma, async () =>
      prisma.$transaction(async (tx) => {
        const tenantClientCount = await tx.mcpClient.count({
          where: { tenantId: userTenantId },
        });
        if (tenantClientCount >= MAX_MCP_CLIENTS_PER_TENANT) {
          return { error: "tenant_cap" as const };
        }
        // If a same-name DCR client already exists in this tenant, replace it.
        // Claude Code registers a new client on each auth attempt — without
        // replacement, deny → retry would always hit a name conflict.
        // We delete the OLD client and claim the NEW one so that Claude Code's
        // client_id matches (it only knows the latest registered client_id).
        const existing = await tx.mcpClient.findFirst({
          where: { tenantId: userTenantId, name: clientName, isDcr: true },
        });
        if (existing) {
          await tx.mcpClient.delete({ where: { id: existing.id } });
        }
        // Atomic CAS: only claim if still unclaimed
        const updated = await tx.mcpClient.updateMany({
          where: { id: clientIdDb, tenantId: { equals: null } },
          data: { tenantId: userTenantId, createdById: session.user.id, dcrExpiresAt: null },
        });
        if (updated.count === 0) {
          return { error: "already_claimed" as const };
        }
        return { error: null as null };
      }),
    );

    if (claimResult.error === "tenant_cap") {
      return NextResponse.json(
        { error: "invalid_client", error_description: "tenant_cap" },
        { status: 400 },
      );
    }
    if (claimResult.error === "already_claimed") {
      const refetched = await withBypassRls(prisma, async () =>
        prisma.mcpClient.findUnique({ where: { id: clientIdDb } }),
      );
      if (!refetched || refetched.tenantId !== userTenantId) {
        return NextResponse.json({ error: "access_denied" }, { status: 403 });
      }
      effectiveClient = refetched;
    } else {
      // Freshly claimed
      const { ip: claimIp } = extractRequestMeta(req);
      logAudit({
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION.MCP_CLIENT_DCR_CLAIM,
        userId: session.user.id,
        tenantId: userTenantId,
        targetType: "McpClient",
        targetId: clientIdDb,
        metadata: { clientId: foundClient.clientId },
        ip: claimIp ?? undefined,
      });
    }
  }

  // Validate scopes (use effectiveClient which may differ from foundClient after reuse)
  const allowedScopes = effectiveClient.allowedScopes.split(",").filter(Boolean);
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
    clientId: effectiveClient.id,
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
    targetId: effectiveClient.id,
    metadata: { clientId: effectiveClient.clientId, scopes: grantedScopes },
    ip: ip ?? undefined,
    userAgent: userAgent ?? undefined,
  });

  // Redirect back to the OAuth client with the authorization code
  const url = new URL(redirectUri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  return NextResponse.redirect(url.toString(), 302);
}
