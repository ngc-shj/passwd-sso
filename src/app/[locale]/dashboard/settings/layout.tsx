"use client";

import { UserRound, Monitor, Shield, Code } from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";
import { useTranslations } from "next-intl";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Sessions");

  const navItems = [
    { href: "/dashboard/settings/account", label: t("tabAccount"), icon: Monitor },
    { href: "/dashboard/settings/security", label: t("tabSecurity"), icon: Shield },
    { href: "/dashboard/settings/developer", label: t("tabDeveloper"), icon: Code },
  ];

  return (
    <SectionLayout
      icon={UserRound}
      title={t("settingsTitle")}
      description={t("settingsDescription")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
