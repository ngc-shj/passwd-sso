import { redirect } from "@/i18n/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { auth } from "@/auth";
import { getTenantRole, isTenantAdminRole } from "@/lib/auth/access/tenant-auth";
import { getAdminTeamMemberships } from "@/lib/auth/access/team-auth";
import { AdminShell } from "@/components/admin/admin-shell";
import { SessionStateUnavailable } from "@/components/auth/session-state-unavailable";
import { passkeyEnforcementBlocks } from "@/lib/auth/policy/passkey-enforcement";
import { PASSKEY_PAGE_PATH } from "@/lib/constants/auth/page-path";
import { pickMessages } from "@/i18n/pick-messages";
import { NS_ADMIN_ALL } from "@/i18n/namespace-groups";

export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await auth();
  if (!session?.user?.id) {
    return redirect({ href: "/auth/signin", locale });
  }
  const userId = session.user.id;

  // Decided on the raw session fields with the server clock (this auth() is
  // fresh, where the proxy's view may be cached), never on the display verdict
  // `passkeyBlocked`. Degraded first: an outage keeps the URL and offers a
  // retry instead of sending the user to the passkey page.
  if (session.user.passkeyStateDegraded) {
    const messages = await getMessages();
    return (
      <NextIntlClientProvider messages={pickMessages(messages, NS_ADMIN_ALL)}>
        <SessionStateUnavailable />
      </NextIntlClientProvider>
    );
  }
  if (passkeyEnforcementBlocks(session.user)) {
    return redirect({ href: PASSKEY_PAGE_PATH, locale });
  }

  const [tenantRole, adminTeams] = await Promise.all([
    getTenantRole(userId),
    getAdminTeamMemberships(userId),
  ]);

  if (!tenantRole && adminTeams.length === 0) {
    return redirect({ href: "/dashboard", locale });
  }

  const messages = await getMessages();

  return (
    <NextIntlClientProvider messages={pickMessages(messages, NS_ADMIN_ALL)}>
      <AdminShell
        adminTeams={adminTeams}
        hasTenantRole={isTenantAdminRole(tenantRole)}
      >
        {children}
      </AdminShell>
    </NextIntlClientProvider>
  );
}
