"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { KeyRound, Lock } from "lucide-react";
import { useVault } from "@/lib/vault/vault-context";
import { VAULT_STATUS } from "@/lib/constants";
import { RecoveryKeyDialog } from "@/components/vault/recovery-key-dialog";
import { Card, CardContent } from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/account/section-card-header";
import { Button } from "@/components/ui/button";

export default function RecoveryKeyPage() {
  const tSettings = useTranslations("Settings");
  const tVault = useTranslations("Vault");
  const { status: vaultStatus } = useVault();
  const [dialogOpen, setDialogOpen] = useState(false);

  const vaultUnlocked = vaultStatus === VAULT_STATUS.UNLOCKED;

  return (
    <>
      <Card>
        <SectionCardHeader
          icon={KeyRound}
          title={tVault("recoveryKey")}
          description={tVault("recoveryKeyDialogDescription")}
        />
        <CardContent>
          <Button
            size="sm"
            disabled={!vaultUnlocked}
            onClick={() => setDialogOpen(true)}
          >
            <KeyRound className="h-4 w-4 mr-2" />
            {tVault("recoveryKey")}
          </Button>
          {!vaultUnlocked && (
            <p className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
              <Lock className="h-3 w-3" />
              {tSettings("vaultLockedPlaceholder.description")}
            </p>
          )}
        </CardContent>
      </Card>
      <RecoveryKeyDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
