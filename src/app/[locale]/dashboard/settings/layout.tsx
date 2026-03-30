"use client";

import { UserRound, Monitor, Shield, Code } from "lucide-react";
import { Card } from "@/components/ui/card";
import { SectionNav } from "@/components/settings/section-nav";
import { useTranslations } from "next-intl";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Sessions");

  const navItems = [
    { href: "/dashboard/settings/account", label: t("tabAccount"), icon: Monitor },
    { href: "/dashboard/settings/security", label: t("tabSecurity"), icon: Shield },
    { href: "/dashboard/settings/developer", label: t("tabDeveloper"), icon: Code },
  ];

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center gap-3">
            <UserRound className="h-6 w-6" />
            <div>
              <h1 className="text-2xl font-bold">{t("settingsTitle")}</h1>
              <p className="text-sm text-muted-foreground">{t("settingsDescription")}</p>
            </div>
          </div>
        </Card>
        <div className="flex flex-col md:flex-row gap-6">
          <SectionNav items={navItems} />
          <div className="flex-1 space-y-4">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
