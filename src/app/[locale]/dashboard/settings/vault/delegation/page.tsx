"use client";

import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault/vault-context";
import { VAULT_STATUS } from "@/lib/constants";
import { DelegationManager } from "@/components/settings/developer/delegation-manager";
import { MovedPageNotice } from "@/components/settings/moved-page-notice";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Lock } from "lucide-react";

export default function DelegationPage() {
  const t = useTranslations("Settings");
  const { vaultStatus } = useVault();

  if (vaultStatus !== VAULT_STATUS.UNLOCKED) {
    return (
      <>
        <MovedPageNotice section="vault" destinationPath="/dashboard/settings/vault/delegation" />
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Lock className="h-5 w-5" />
              {t("vaultLockedPlaceholder.title")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {t("vaultLockedPlaceholder.description")}
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      <MovedPageNotice section="vault" destinationPath="/dashboard/settings/vault/delegation" />
      <DelegationManager />
    </>
  );
}
