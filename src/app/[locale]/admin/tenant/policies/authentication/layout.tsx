"use client";

import { useTranslations } from "next-intl";
import { Shield, Lock, Clock, KeyRound, ShieldAlert } from "lucide-react";
import { SectionLayout } from "@/components/settings/account/section-layout";

export default function TenantPoliciesAuthenticationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("AdminConsole");

  const navItems = [
    { href: "/admin/tenant/policies/authentication/password", label: t("subTabPassword"), icon: Lock },
    { href: "/admin/tenant/policies/authentication/session", label: t("subTabSession"), icon: Clock },
    { href: "/admin/tenant/policies/authentication/passkey", label: t("subTabPasskey"), icon: KeyRound },
    { href: "/admin/tenant/policies/authentication/lockout", label: t("subTabLockout"), icon: ShieldAlert },
  ];

  return (
    <SectionLayout
      icon={Shield}
      title={t("sectionPolicyAuthentication")}
      description={t("sectionPolicyAuthenticationDesc")}
      navItems={navItems}
    >
      {children}
    </SectionLayout>
  );
}
