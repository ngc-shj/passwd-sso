import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { withBypassRls } from "@/lib/tenant-rls";
import { MCP_SCOPES, MAX_MCP_CLIENTS_PER_TENANT } from "@/lib/constants/mcp";
import { logAudit } from "@/lib/audit";
import { AUDIT_ACTION, AUDIT_SCOPE } from "@/lib/constants/audit";
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

  // Look up client
  const client = await withBypassRls(prisma, async () =>
    prisma.mcpClient.findFirst({ where: { clientId, isActive: true } }),
  );

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
        <p>{t("errors.noTenant")}</p>
      </div>
    );
  }

  // DCR claiming: bind unclaimed DCR client to user's tenant (atomic CAS)
  if (client.isDcr && !client.tenantId) {
    const claimResult = await withBypassRls(prisma, async () =>
      prisma.$transaction(async (tx) => {
        // Check tenant client cap
        const tenantClientCount = await tx.mcpClient.count({
          where: { tenantId: userTenantId },
        });
        if (tenantClientCount >= MAX_MCP_CLIENTS_PER_TENANT) {
          return { error: "tenant_cap" as const };
        }
        // Check name uniqueness in tenant
        const nameConflict = await tx.mcpClient.findFirst({
          where: { tenantId: userTenantId, name: client.name, id: { not: client.id } },
        });
        if (nameConflict) {
          return { error: "name_conflict" as const };
        }
        // Atomic CAS: only claim if still unclaimed
        const updated = await tx.mcpClient.updateMany({
          where: { id: client.id, tenantId: null },
          data: { tenantId: userTenantId, createdById: session.user.id, dcrExpiresAt: null },
        });
        if (updated.count === 0) {
          return { error: "already_claimed" as const };
        }
        return { error: null as null };
      }),
    );

    if (claimResult.error === "tenant_cap") {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <p className="text-destructive">{t("errors.tenantClientLimit")}</p>
        </div>
      );
    }
    if (claimResult.error === "name_conflict") {
      return (
        <div className="flex items-center justify-center min-h-screen">
          <p className="text-destructive">{t("errors.nameConflict")}</p>
        </div>
      );
    }
    if (claimResult.error === "already_claimed") {
      // Re-fetch client to check tenant
      const refetched = await withBypassRls(prisma, async () =>
        prisma.mcpClient.findUnique({ where: { id: client.id } }),
      );
      if (!refetched || refetched.tenantId !== userTenantId) {
        return (
          <div className="flex items-center justify-center min-h-screen">
            <p className="text-destructive">{t("errors.alreadyClaimedOtherTenant")}</p>
          </div>
        );
      }
      // Already claimed by our tenant — proceed (no audit, we didn't claim it)
    } else {
      // We actually claimed it — audit
      logAudit({
        scope: AUDIT_SCOPE.TENANT,
        action: AUDIT_ACTION.MCP_CLIENT_DCR_CLAIM,
        userId: session.user.id,
        tenantId: userTenantId,
        targetType: "McpClient",
        targetId: client.id,
        metadata: { clientId: client.clientId },
      });
    }
  } else if (client.tenantId !== userTenantId) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>{t("errors.tenantMismatch")}</p>
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
