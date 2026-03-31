import { redirect } from "@/i18n/navigation";
import { setRequestLocale } from "next-intl/server";

const TAB_MAP: Record<string, string> = {
  security: "/dashboard/settings/security",
  developer: "/dashboard/settings/developer",
  account: "/dashboard/settings/account",
};

export default async function SettingsRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const { tab } = await searchParams;
  const target = TAB_MAP[tab ?? ""] ?? "/dashboard/settings/account";
  return redirect({ href: target, locale });
}
