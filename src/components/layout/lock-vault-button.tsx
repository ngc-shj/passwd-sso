"use client";

import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useVault } from "@/lib/vault/vault-context";
import { VAULT_STATUS } from "@/lib/constants";

export function LockVaultButton() {
  const t = useTranslations("Vault");
  const { status: vaultStatus, lock } = useVault();

  if (vaultStatus !== VAULT_STATUS.UNLOCKED) return null;

  function handleClick() {
    // Race defense: vault may have auto-locked between render and click
    if (vaultStatus !== VAULT_STATUS.UNLOCKED) return;

    lock();
    toast.success(t("lockVault"));
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t("lockVault")}
      title={t("lockVault")}
      onClick={handleClick}
    >
      <Lock className="h-5 w-5" />
    </Button>
  );
}
