"use client";

import { useTranslations } from "next-intl";
import { useParams } from "next/navigation";
import { VAULT_STATUS } from "@/lib/constants";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useRouter } from "@/i18n/navigation";
import { ArrowLeft, KeyRound, Loader2, Lock } from "lucide-react";
import { PasswordCard } from "@/components/passwords/detail/password-card";
import { useEmergencyVault } from "@/hooks/vault/use-emergency-vault";

// No-op handler for read-only mode (stable reference across renders)
const noop = () => {};

export default function EmergencyVaultPage() {
  const t = useTranslations("EmergencyAccess");
  const params = useParams();
  const grantId = params.id as string;
  const router = useRouter();
  const {
    vaultStatus,
    entries,
    ownerName,
    isLoading,
    displayError,
    decryptFailCount,
    expandedId,
    setExpandedId,
    entryCallbackMap,
  } = useEmergencyVault(grantId);

  if (vaultStatus !== VAULT_STATUS.UNLOCKED) {
    return (
      <div className="flex-1 overflow-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-md items-center justify-center pt-16">
          <Card className="w-full rounded-xl border text-center">
          <CardContent className="flex items-center justify-center gap-2 py-8">
            <Lock className="h-5 w-5" />
            <span>{t("vaultUnlockRequired")}</span>
          </CardContent>
        </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => router.push("/dashboard/emergency-access")}>
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div>
              <h1 className="flex items-center gap-2 text-2xl font-bold">
                <KeyRound className="h-5 w-5" />
                {t("readOnlyVault")}
              </h1>
              {ownerName && (
                <p className="text-sm text-muted-foreground">
                  {t("readOnlyVaultDesc", { ownerName })}
                </p>
              )}
            </div>
          </div>
        </Card>

        {isLoading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}

        {displayError && (
          <Card className="rounded-xl border border-red-500/40 bg-red-500/5 p-4 text-center text-red-700 dark:text-red-400">
            {displayError}
          </Card>
        )}

        {!isLoading && decryptFailCount > 0 && (
          <Card className="rounded-xl border border-yellow-500/40 bg-yellow-500/5 p-4 text-center text-yellow-700 dark:text-yellow-400">
            {t("decryptFailWarning", { count: String(decryptFailCount) })}
          </Card>
        )}

        {!isLoading && !displayError && entries.length === 0 && (
          <Card className="rounded-xl border border-dashed p-8 text-center text-muted-foreground">
            {t("noEntries")}
          </Card>
        )}

        <div className="space-y-1">
          {entries.map((entry) => {
            const cb = entryCallbackMap.get(entry.card.id);
            return (
              <PasswordCard
                key={entry.card.id}
                entry={entry.card}
                expanded={expandedId === entry.card.id}
                onToggleFavorite={noop}
                onToggleArchive={noop}
                onDelete={noop}
                onToggleExpand={(id) => setExpandedId((prev) => (prev === id ? null : id))}
                onRefresh={noop}
                getPassword={cb?.getPassword}
                getDetail={cb?.getDetail}
                getUrl={cb?.getUrl}
                canEdit={false}
                canDelete={false}
                canShare={false}
                readOnly
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
