import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { MCP_SCOPES } from "@/lib/constants/mcp";
import { ConsentForm } from "./consent-form";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function McpConsentPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const session = await auth();
  if (!session?.user?.id) {
    const callbackUrl = `/mcp/authorize?${new URLSearchParams(params as Record<string, string>).toString()}`;
    redirect(`/api/auth/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`);
  }

  const clientId = params.client_id as string;
  const redirectUri = params.redirect_uri as string;
  const scope = params.scope as string | undefined;
  const state = params.state as string | undefined;
  const codeChallenge = params.code_challenge as string;
  const codeChallengeMethod = (params.code_challenge_method as string) || "S256";

  if (!clientId || !redirectUri || !codeChallenge) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>Missing required parameters</p>
      </div>
    );
  }

  // Look up client
  const client = await withBypassRls(prisma, async () =>
    prisma.mcpClient.findFirst({ where: { clientId, isActive: true } }),
  );

  if (!client) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>Unknown client</p>
      </div>
    );
  }

  // Validate redirect_uri
  if (!client.redirectUris.includes(redirectUri)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>Invalid redirect URI</p>
      </div>
    );
  }

  // Fetch user's tenant
  const userRecord = await withBypassRls(prisma, async () =>
    prisma.user.findUnique({
      where: { id: session.user.id },
      select: { tenantId: true },
    }),
  );
  const userTenantId = userRecord?.tenantId;
  if (!userTenantId) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>No tenant</p>
      </div>
    );
  }

  // DCR claiming: bind unclaimed DCR client to user's tenant
  if (client.isDcr && !client.tenantId) {
    const existing = await withBypassRls(prisma, async () =>
      prisma.mcpClient.findFirst({ where: { tenantId: userTenantId, name: client.name } }),
    );
    if (existing) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <p>Client name conflict in tenant</p>
        </div>
      );
    }
    await withBypassRls(prisma, async () =>
      prisma.mcpClient.update({
        where: { id: client.id },
        data: { tenantId: userTenantId, createdById: session.user.id, dcrExpiresAt: null },
      }),
    );
  } else if (client.tenantId !== userTenantId) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>Tenant mismatch</p>
      </div>
    );
  }

  // Calculate granted scopes
  const allowedScopes = client.allowedScopes.split(",").filter(Boolean);
  const requestedScopes = scope ? scope.split(" ").filter(Boolean) : allowedScopes;
  const grantedScopes = requestedScopes.filter(
    (s) => allowedScopes.includes(s) && (MCP_SCOPES as readonly string[]).includes(s),
  );

  if (grantedScopes.length === 0) {
    const errorUrl = new URL(redirectUri);
    errorUrl.searchParams.set("error", "invalid_scope");
    if (state) errorUrl.searchParams.set("state", state);
    redirect(errorUrl.toString());
  }

  return (
    <ConsentForm
      clientName={client.name}
      clientId={clientId}
      isDcr={client.isDcr}
      scopes={grantedScopes}
      redirectUri={redirectUri}
      state={state ?? ""}
      codeChallenge={codeChallenge}
      codeChallengeMethod={codeChallengeMethod}
    />
  );
}
