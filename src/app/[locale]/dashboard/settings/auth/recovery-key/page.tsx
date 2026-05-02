"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault/vault-context";
import { VAULT_STATUS } from "@/lib/constants";
import { RecoveryKeyDialog } from "@/components/vault/recovery-key-dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Lock } from "lucide-react";

export default function RecoveryKeyPage() {
  const t = useTranslations("Settings");
  const { status: vaultStatus } = useVault();
  const [dialogOpen, setDialogOpen] = useState(false);

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

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{t("subTab.recoveryKey")}</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Button trigger approach: opens RecoveryKeyDialog on demand. */}
          <Button onClick={() => setDialogOpen(true)}>
            {t("subTab.recoveryKey")}
          </Button>
        </CardContent>
      </Card>
      <RecoveryKeyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
