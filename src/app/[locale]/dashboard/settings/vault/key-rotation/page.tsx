"use client";

import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault/vault-context";
import { VAULT_STATUS } from "@/lib/constants";
import { RotateKeyCard } from "@/components/settings/security/rotate-key-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Lock } from "lucide-react";

export default function KeyRotationPage() {
  const t = useTranslations("Settings");
  const { vaultStatus } = useVault();

  if (vaultStatus !== VAULT_STATUS.UNLOCKED) {
    return (
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
    );
  }

  return <RotateKeyCard />;
}
