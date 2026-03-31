"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { KeyRound, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { RotateKeyDialog } from "@/components/vault/rotate-key-dialog";
import { useVault } from "@/lib/vault-context";
import { VAULT_STATUS } from "@/lib/constants";

export function RotateKeyCard() {
  const t = useTranslations("Vault");
  const { status } = useVault();
  const [open, setOpen] = useState(false);

  const vaultUnlocked = status === VAULT_STATUS.UNLOCKED;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5" />
            <CardTitle>{t("rotateKey")}</CardTitle>
          </div>
          <CardDescription>{t("rotateKeyDescription")}</CardDescription>
        </CardHeader>
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
