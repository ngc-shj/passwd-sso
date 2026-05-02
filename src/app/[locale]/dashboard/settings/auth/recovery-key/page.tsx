"use client";

import { useTranslations } from "next-intl";
import { KeyRound } from "lucide-react";
import { RecoveryKeyDialog } from "@/components/vault/recovery-key-dialog";
import { VaultActionCard } from "@/components/settings/vault-action-card";

export default function RecoveryKeyPage() {
  const t = useTranslations("Vault");

  return (
    <VaultActionCard
      icon={KeyRound}
      title={t("recoveryKey")}
      description={t("recoveryKeyDialogDescription")}
      buttonIcon={KeyRound}
      buttonLabel={t("recoveryKey")}
      Dialog={RecoveryKeyDialog}
    />
  );
}
