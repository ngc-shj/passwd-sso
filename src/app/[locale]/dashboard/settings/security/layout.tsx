"use client";

import { useTranslations } from "next-intl";
import { Fingerprint, Plane, KeyRound } from "lucide-react";
import { SectionNav } from "@/components/settings/section-nav";

export default function SecurityLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Sessions");

  const navItems = [
    { href: "/dashboard/settings/security/passkey", label: t("subTabPasskey"), icon: Fingerprint },
    { href: "/dashboard/settings/security/travel-mode", label: t("subTabTravelMode"), icon: Plane },
    { href: "/dashboard/settings/security/key-rotation", label: t("subTabKeyRotation"), icon: KeyRound },
  ];

  return (
    <div className="space-y-4">
      <SectionNav items={navItems} />
      {children}
    </div>
  );
}
