import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { withBypassRls, BYPASS_PURPOSE } from "@/lib/tenant-rls";
import { resolveOwningTenantIdFromClient } from "@/lib/tenant-context";
import { MCP_SCOPES, isAcceptableRedirectUri } from "@/lib/constants/auth/mcp";
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
  const client = await withBypassRls(prisma, async (tx) =>
    tx.mcpClient.findFirst({ where: { clientId, isActive: true } }),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);

  if (!client) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>{t("errors.unknownClient")}</p>
      </div>
    );
  }

  // Validate redirect_uri — membership AND shape, the same pair the authorize
  // GET and the consent POST apply. This page is the third adjudicator of
  // "may we send a user here", and the only one that can leave the origin
  // without a click (the invalid_scope arm below), so it must not be the one
  // that decides by membership alone.
  if (
    !client.redirectUris.includes(redirectUri) ||
    !isAcceptableRedirectUri(redirectUri)
  ) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>{t("errors.invalidRedirectUri")}</p>
      </div>
    );
  }

  // The same adjudicator the consent POST uses. This comparison is an
  // authorization decision, and against the stale `User.tenantId` column it
  // admits or refuses on a tenant the user may hold no active membership in.
  //
  // Resolved for EVERY client, not only the tenant-bound ones. The POST refuses
  // an unresolvable tenant outright (`!userTenantId || …` → 403), and this page
  // used to resolve nothing on the DCR path — so on that one arm the screen it
  // rendered promised a consent the authoritative gate would then deny. Two
  // readers of the same fact must not disagree about it, least of all when one
  // of them is the one the user sees.
  const userTenantId = await withBypassRls(prisma, async (tx) =>
    resolveOwningTenantIdFromClient(tx, session.user.id),
  BYPASS_PURPOSE.CROSS_TENANT_LOOKUP);
  if (!userTenantId || (client.tenantId && client.tenantId !== userTenantId)) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>{t("errors.tenantMismatch")}</p>
      </div>
    );
  }
  // DCR unclaimed clients carry no tenantId of their own: claiming happens on Allow

  // Calculate granted scopes
  const allowedScopes = client.allowedScopes.split(",").filter(Boolean);
  const requestedScopes = scope ? scope.split(" ").filter(Boolean) : allowedScopes;
  const grantedScopes = requestedScopes.filter(
    (s) => allowedScopes.includes(s) && (MCP_SCOPES as readonly string[]).includes(s),
  );

  if (grantedScopes.length === 0) {
    // Redirecting the error back to the client is the OAuth-conformant
    // behaviour, and a conforming client needs it (plus `state`) to surface a
    // usable message. But it is the one arm on this page that leaves the
    // origin with no user interaction, so it is restricted to a client the
    // viewer's own tenant has claimed.
    //
    // An UNCLAIMED DCR client carries `tenantId === null`, which the tenant
    // gate above passes by short-circuit — deliberately, because claiming
    // happens on Allow. Registration is pre-auth, so without this restriction
    // anyone could register a client pointing anywhere, request a scope the
    // client does not hold, and use this page to bounce a signed-in user
    // off-origin from the password manager's own domain. Nothing secret
    // crosses (no code, no token, and Referrer-Policy is
    // strict-origin-when-cross-origin), but the pretext is the product's own
    // URL, which is the whole value of a phishing hop.
    if (client.tenantId === userTenantId) {
      const errorUrl = new URL(redirectUri);
      errorUrl.searchParams.set("error", "invalid_scope");
      if (state) errorUrl.searchParams.set("state", state);
      redirect(errorUrl.toString());
    }
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p>{t("errors.invalidScope")}</p>
      </div>
    );
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
