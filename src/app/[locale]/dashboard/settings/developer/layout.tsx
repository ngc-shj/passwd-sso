"use client";

import { useTranslations } from "next-intl";
import { Terminal, Key, Handshake } from "lucide-react";
import { SectionNav } from "@/components/settings/section-nav";

export default function DeveloperLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Sessions");

  const navItems = [
    { href: "/dashboard/settings/developer/cli-token", label: t("subTabCli"), icon: Terminal },
    { href: "/dashboard/settings/developer/api-keys", label: t("subTabApi"), icon: Key },
    { href: "/dashboard/settings/developer/delegation", label: t("subTabDelegation"), icon: Handshake },
  ];

  return (
    <div className="space-y-4">
      <SectionNav items={navItems} />
      {children}
    </div>
  );
}
