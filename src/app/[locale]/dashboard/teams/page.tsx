import { redirect } from "@/i18n/navigation";
import { setRequestLocale } from "next-intl/server";

export default async function TeamsRedirectPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  return redirect({ href: "/admin/tenant/teams", locale });
}
