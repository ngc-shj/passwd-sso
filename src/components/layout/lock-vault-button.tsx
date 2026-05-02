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

  // The render-time guard below is the sole gate — when status is not
  // UNLOCKED, the button does not render and `handleClick` cannot run.
  // No additional in-handler check is needed because `vaultStatus` here is
  // captured via closure at render time and matches the gate above.
  if (vaultStatus !== VAULT_STATUS.UNLOCKED) return null;

  function handleClick() {
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
