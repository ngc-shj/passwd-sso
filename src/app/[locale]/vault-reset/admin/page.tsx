"use client";

import { useTranslations } from "next-intl";
import { preventIMESubmit } from "@/lib/ui/ime-guard";
import { useAdminVaultReset } from "@/hooks/vault/use-admin-vault-reset";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";

export default function AdminVaultResetPage() {
  const t = useTranslations("VaultReset");
  const { token, confirmation, setConfirmation, loading, error, isValid, handleSubmit } =
    useAdminVaultReset();

  if (token === null) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-4">
        <div className="w-full max-w-md space-y-4 text-center">
          <ShieldAlert className="mx-auto h-10 w-10 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {t("adminResetNoToken")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center gap-2 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <h1 className="text-2xl font-bold">{t("adminResetTitle")}</h1>
        </div>

        <form
          onSubmit={handleSubmit}
          onKeyDown={preventIMESubmit}
          className="space-y-4 rounded-lg border border-destructive/30 bg-card p-6 shadow-sm"
        >
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {t("adminResetWarning")}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-admin-reset">{t("confirmationLabel")}</Label>
            <p className="text-sm font-mono text-muted-foreground">
              {t("confirmationText")}
            </p>
            <Input
              id="confirm-admin-reset"
              type="text"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder={t("confirmationPlaceholder")}
              className="font-mono"
              autoComplete="off"
              required
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            type="submit"
            variant="destructive"
            className="w-full"
            disabled={!isValid || loading}
          >
            {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {loading ? t("resetting") : t("resetButton")}
          </Button>
        </form>
      </div>
    </div>
  );
}
