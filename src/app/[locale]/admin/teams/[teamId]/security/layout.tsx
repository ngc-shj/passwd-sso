"use client";

import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { Shield, KeyRound, Webhook } from "lucide-react";
import { AdminSectionLayout } from "@/components/admin/admin-section-layout";

export default function TeamSecurityLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");
  const tTeam = useTranslations("Team");
  const pathname = usePathname();
  const teamIdMatch = pathname.match(/\/admin\/teams\/([^/]+)\//);
  const teamId = teamIdMatch?.[1] ?? "";

  const navItems = [
    { href: `/admin/teams/${teamId}/security/policy`, label: t("navPolicy"), icon: Shield },
    { href: `/admin/teams/${teamId}/security/key-rotation`, label: t("navKeyRotation"), icon: KeyRound },
    { href: `/admin/teams/${teamId}/security/webhooks`, label: t("navWebhooks"), icon: Webhook },
  ];

  return (
    <AdminSectionLayout
      icon={Shield}
      title={tTeam("securityPolicy")}
      description={tTeam("tabPolicyDesc")}
      navItems={navItems}
    >
      {children}
    </AdminSectionLayout>
  );
}
