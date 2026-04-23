"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { KeyRound, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { RotateKeyDialog } from "@/components/vault/rotate-key-dialog";
import { useVault } from "@/lib/vault/vault-context";
import { VAULT_STATUS } from "@/lib/constants";

export function RotateKeyCard() {
  const t = useTranslations("Vault");
  const { status } = useVault();
  const [open, setOpen] = useState(false);

  const vaultUnlocked = status === VAULT_STATUS.UNLOCKED;

  return (
    <>
      <Card>
        <SectionCardHeader icon={KeyRound} title={t("rotateKey")} description={t("rotateKeyDescription")} />
        <CardContent>
          <Button
            variant="destructive"
            size="sm"
            disabled={!vaultUnlocked}
            onClick={() => setOpen(true)}
          >
            <RotateCcw className="h-4 w-4 mr-2" />
            {t("rotateKeyButton")}
          </Button>
          {!vaultUnlocked && (
            <p className="mt-2 text-xs text-muted-foreground">
              {t("vaultMustBeUnlocked")}
            </p>
          )}
        </CardContent>
      </Card>
      <RotateKeyDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
