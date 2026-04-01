"use client";

import {
  UserRound,
  Monitor,
  Shield,
  Code,
  Cpu,
  Fingerprint,
  Plane,
  KeyRound,
  Terminal,
  Key,
  Handshake,
  Plug,
} from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";
import { useTranslations } from "next-intl";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Sessions");

  const navItems = [
    { href: "/dashboard/settings/account", label: t("tabAccount"), icon: Monitor },
    {
      href: "/dashboard/settings/security",
      label: t("tabSecurity"),
      icon: Shield,
      children: [
        { href: "/dashboard/settings/security/passkey", label: t("subTabPasskey"), icon: Fingerprint },
        { href: "/dashboard/settings/security/travel-mode", label: t("subTabTravelMode"), icon: Plane },
        { href: "/dashboard/settings/security/key-rotation", label: t("subTabKeyRotation"), icon: KeyRound },
      ],
    },
    {
      href: "/dashboard/settings/developer",
      label: t("tabDeveloper"),
      icon: Code,
      children: [
        { href: "/dashboard/settings/developer/cli-token", label: t("subTabCli"), icon: Terminal },
        { href: "/dashboard/settings/developer/api-keys", label: t("subTabApi"), icon: Key },
      ],
    },
    {
      href: "/dashboard/settings/mcp",
      label: t("tabMcp"),
      icon: Cpu,
      children: [
        { href: "/dashboard/settings/mcp/connections", label: t("subTabMcpConnections"), icon: Plug },
        { href: "/dashboard/settings/mcp/delegation", label: t("subTabDelegation"), icon: Handshake },
      ],
    },
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
