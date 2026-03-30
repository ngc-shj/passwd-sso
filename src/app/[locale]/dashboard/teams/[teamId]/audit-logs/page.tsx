import { redirect } from "@/i18n/navigation";

export default async function TeamAuditLogsRedirectPage({
  params,
}: {
  params: Promise<{ teamId: string; locale: string }>;
}) {
  const { teamId, locale } = await params;
  redirect({ href: `/admin/teams/${teamId}/audit-logs`, locale });
}
