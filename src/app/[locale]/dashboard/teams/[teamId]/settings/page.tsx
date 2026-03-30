import { redirect } from "@/i18n/navigation";

export default async function TeamSettingsPage({
  params,
}: {
  params: Promise<{ teamId: string; locale: string }>;
}) {
  const { teamId, locale } = await params;
  redirect({ href: `/admin/teams/${teamId}/general`, locale });
}
