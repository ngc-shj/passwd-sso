"use client";

import { useLocale } from "next-intl";
import { ScimTokenManager } from "@/components/team/team-scim-token-manager";

export function ScimProvisioningCard() {
  const locale = useLocale();

  return <ScimTokenManager locale={locale} />;
}
