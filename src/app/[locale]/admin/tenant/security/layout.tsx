"use client";

import { useTranslations } from "next-intl";
import {
  Archive,
  Bot,
  Clock,
  Globe,
  Handshake,
  Key,
  KeyRound,
  Lock,
  Shield,
  ShieldAlert,
  ShieldBan,
  Webhook,
} from "lucide-react";
import { SectionLayout } from "@/components/settings/section-layout";

export default function TenantSecurityLayout({ children }: { children: React.ReactNode }) {
  const t = useTranslations("AdminConsole");

  const navItems = [
    {
      href: "/admin/tenant/security/session-policy",
      label: t("navGroupAuthentication"),
      icon: Shield,
      children: [
        { href: "/admin/tenant/security/session-policy", label: t("navSessionPolicy"), icon: Clock },
        { href: "/admin/tenant/security/passkey-policy", label: t("navPasskeyPolicy"), icon: KeyRound },
        { href: "/admin/tenant/security/lockout-policy", label: t("navLockoutPolicy"), icon: ShieldAlert },
      ],
    },
    {
      href: "/admin/tenant/security/password-policy",
      label: t("navGroupPolicy"),
      icon: Lock,
      children: [
        { href: "/admin/tenant/security/password-policy", label: t("navPasswordPolicy"), icon: Lock },
        { href: "/admin/tenant/security/retention-policy", label: t("navRetentionPolicy"), icon: Archive },
      ],
    },
    {
      href: "/admin/tenant/security/access-restriction",
      label: t("navGroupNetwork"),
      icon: Globe,
      children: [
        { href: "/admin/tenant/security/access-restriction", label: t("navAccessRestriction"), icon: ShieldBan },
        { href: "/admin/tenant/security/webhooks", label: t("navWebhooks"), icon: Webhook },
      ],
    },
    {
      href: "/admin/tenant/security/token-policy",
      label: t("navGroupMachineIdentity"),
      icon: Bot,
      children: [
        { href: "/admin/tenant/security/token-policy", label: t("navTokenPolicy"), icon: Key },
        { href: "/admin/tenant/security/delegation-policy", label: t("navDelegationPolicy"), icon: Handshake },
      ],
    },
  ];

  return (
    <SectionLayout
      icon={Shield}
      title={t("sectionSecurity")}
      description={t("sectionSecurityDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
