"use client";

import { useMemo } from "react";
import {
  UserRound,
  Bell,
  Shield,
  KeyRound,
  Fingerprint,
  Monitor,
  RotateCcw,
  Handshake,
  Plane,
  HeartPulse,
  Terminal,
  Key,
  Plug,
  Lock,
} from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";
import { useTranslations } from "next-intl";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("Settings");

  const navItems = useMemo(
    () => [
      {
        href: "/dashboard/settings/account",
        label: t("section.account"),
        icon: UserRound,
        children: [
          { href: "/dashboard/settings/account/profile", label: t("subTab.profile"), icon: UserRound },
          { href: "/dashboard/settings/account/notifications", label: t("subTab.notifications"), icon: Bell },
        ],
      },
      {
        href: "/dashboard/settings/auth",
        label: t("section.auth"),
        icon: Shield,
        children: [
          { href: "/dashboard/settings/auth/passphrase", label: t("subTab.passphrase"), icon: Lock },
          { href: "/dashboard/settings/auth/recovery-key", label: t("subTab.recoveryKey"), icon: KeyRound },
          { href: "/dashboard/settings/auth/passkey", label: t("subTab.passkey"), icon: Fingerprint },
        ],
      },
      {
        href: "/dashboard/settings/devices",
        label: t("section.devices"),
        icon: Monitor,
      },
      {
        href: "/dashboard/settings/vault",
        label: t("section.vault"),
        icon: KeyRound,
        children: [
          { href: "/dashboard/settings/vault/key-rotation", label: t("subTab.keyRotation"), icon: RotateCcw },
          { href: "/dashboard/settings/vault/delegation", label: t("subTab.delegation"), icon: Handshake },
          { href: "/dashboard/settings/vault/travel-mode", label: t("subTab.travelMode"), icon: Plane },
        ],
      },
      {
        href: "/dashboard/settings/sharing/emergency-access",
        label: t("section.sharing"),
        icon: HeartPulse,
      },
      {
        href: "/dashboard/settings/developer",
        label: t("section.developer"),
        icon: Terminal,
        children: [
          { href: "/dashboard/settings/developer/cli-token", label: t("subTab.cliToken"), icon: Terminal },
          { href: "/dashboard/settings/developer/api-keys", label: t("subTab.apiKey"), icon: Key },
          { href: "/dashboard/settings/developer/mcp-connections", label: t("subTab.mcpConnections"), icon: Plug },
        ],
      },
    ],
    [t],
  );

  return (
    <SectionLayout icon={UserRound} title={t("rootTitle")} navItems={navItems}>
      {children}
    </SectionLayout>
  );
}
