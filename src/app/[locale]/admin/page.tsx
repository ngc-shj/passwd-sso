import { redirect } from "@/i18n/navigation";
import { setRequestLocale } from "next-intl/server";
import { auth } from "@/auth";
import { getTenantRole, isTenantAdminRole } from "@/lib/tenant-auth";
import { getAdminTeamMemberships } from "@/lib/team-auth";

export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const session = await auth();
  if (!session?.user?.id) {
    return redirect({ href: "/auth/signin", locale });
  }

  const tenantRole = await getTenantRole(session.user.id);
  if (isTenantAdminRole(tenantRole)) {
    return redirect({ href: "/admin/tenant/members", locale });
  }

  // Team-only admin — redirect to first admin team
  const adminTeams = await getAdminTeamMemberships(session.user.id);
  if (adminTeams.length > 0) {
    return redirect({ href: `/admin/teams/${adminTeams[0].team.id}/general`, locale });
  }

  return redirect({ href: "/dashboard", locale });
}
