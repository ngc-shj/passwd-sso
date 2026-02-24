"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { VAULT_STATUS } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { AlertTriangle, X } from "lucide-react";
import { RecoveryKeyDialog } from "./recovery-key-dialog";

const DISMISS_KEY = "psso:recovery-key-banner-dismissed";
const DISMISS_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

/** @internal Exported for testing */
export function isDismissedInStorage(): boolean {
  try {
    const ts = localStorage.getItem(DISMISS_KEY);
    if (ts) {
      const elapsed = Date.now() - Number(ts);
      return elapsed >= 0 && elapsed < DISMISS_DURATION_MS;
    }
  } catch {
    // Ignore storage errors
  }
  return false;
}

export function RecoveryKeyBanner() {
  const t = useTranslations("Vault");
  const { status, hasRecoveryKey } = useVault();
  const [manuallyDismissed, setManuallyDismissed] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  const visible =
    status === VAULT_STATUS.UNLOCKED &&
    !hasRecoveryKey &&
    !manuallyDismissed &&
    !isDismissedInStorage();

  if (!visible) return null;

  function handleDismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      // Ignore
    }
    setManuallyDismissed(true);
  }

  return (
    <>
      <div className="mx-4 mt-4 flex items-center gap-3 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-4 py-3 text-sm md:mx-6 md:mt-6">
        <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
        <p className="flex-1 text-yellow-800 dark:text-yellow-300">
          {t("recoveryKeyBannerMessage")}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDialogOpen(true)}
        >
          {t("recoveryKeyBannerAction")}
        </Button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label={t("recoveryKeyBannerDismiss")}
          className="ml-1 text-yellow-600 hover:text-yellow-800 dark:text-yellow-400 dark:hover:text-yellow-200"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <RecoveryKeyDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
