"use client";

import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { Shield, KeyRound, Webhook } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TeamSecurityLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");
  const pathname = usePathname();
  const teamIdMatch = pathname.match(/\/admin\/teams\/([^/]+)\//);
  const teamId = teamIdMatch?.[1] ?? "";

  const navItems = [
    { href: `/admin/teams/${teamId}/security/policy`, label: t("navPolicy"), icon: Shield },
    { href: `/admin/teams/${teamId}/security/key-rotation`, label: t("navKeyRotation"), icon: KeyRound },
    { href: `/admin/teams/${teamId}/security/webhooks`, label: t("navWebhooks"), icon: Webhook },
  ];

  return (
    <SectionLayout
      icon={Shield}
      title={t("teamSectionSecurity")}
      description={t("teamSectionSecurityDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
