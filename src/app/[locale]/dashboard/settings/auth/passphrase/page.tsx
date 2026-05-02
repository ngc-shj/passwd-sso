"use client";

import { useTranslations } from "next-intl";
import { Lock } from "lucide-react";
import { ChangePassphraseDialog } from "@/components/vault/change-passphrase-dialog";
import { VaultActionCard } from "@/components/settings/vault-action-card";

export default function PassphrasePage() {
  const t = useTranslations("Vault");

  return (
    <VaultActionCard
      icon={Lock}
      title={t("changePassphrase")}
      description={t("changePassphraseDescription")}
      buttonIcon={Lock}
      buttonLabel={t("changePassphraseButton")}
      Dialog={ChangePassphraseDialog}
    />
  );
}
