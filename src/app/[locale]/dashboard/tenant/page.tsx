import { redirect } from "@/i18n/navigation";

export default async function TenantSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  redirect({ href: "/admin/tenant/members", locale });
}
