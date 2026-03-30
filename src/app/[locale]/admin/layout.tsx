import { redirect } from "@/i18n/navigation";
import { NextIntlClientProvider } from "next-intl";
import { getMessages, setRequestLocale } from "next-intl/server";
import { auth } from "@/auth";
import { getTenantRole } from "@/lib/tenant-auth";
import { getAdminTeamMemberships } from "@/lib/team-auth";
import { AdminShell } from "@/components/admin/admin-shell";
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
      <AdminShell adminTeams={adminTeams} hasTenantRole={!!tenantRole}>{children}</AdminShell>
    </NextIntlClientProvider>
  );
}
