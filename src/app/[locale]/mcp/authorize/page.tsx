import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { MCP_SCOPES } from "@/lib/constants/auth/mcp";
import { getTranslations } from "next-intl/server";
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

  const t = await getTranslations("McpConsent");

  const clientId = params.client_id as string;
  const redirectUri = params.redirect_uri as string;
  const scope = params.scope as string | undefined;
  const state = params.state as string | undefined;
  const codeChallenge = params.code_challenge as string;
  const codeChallengeMethod = (params.code_challenge_method as string) || "S256";

  if (!clientId || !redirectUri || !codeChallenge) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>{t("errors.missingParams")}</p>
      </div>
    );
  }

  // Look up client (bypass RLS — DCR clients may not have a tenant yet)
  const client = await withBypassRls(prisma, async () =>
    prisma.mcpClient.findFirst({ where: { clientId, isActive: true } }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!client) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>{t("errors.unknownClient")}</p>
      </div>
    );
  }

  // Validate redirect_uri
  if (!client.redirectUris.includes(redirectUri)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>{t("errors.invalidRedirectUri")}</p>
      </div>
    );
  }

  // Tenant check for non-DCR (admin-created) clients
  if (client.tenantId) {
    const userRecord = await withBypassRls(prisma, async () =>
      prisma.user.findUnique({
        where: { id: session.user.id },
        select: { tenantId: true },
      }),
    BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
    if (client.tenantId !== userRecord?.tenantId) {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <p>{t("errors.tenantMismatch")}</p>
        </div>
      );
    }
  }
  // DCR unclaimed clients: no tenant check needed here — claiming happens on Allow

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
