"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { preventIMESubmit } from "@/lib/ime-guard";
import { API_PATH } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@/i18n/navigation";
import { ArrowLeft, Loader2, AlertTriangle } from "lucide-react";

const CONFIRMATION_TOKEN = "DELETE MY VAULT";

export default function VaultResetPage() {
  const locale = useLocale();
  const tCommon = useTranslations("Common");
  const t = useTranslations("VaultReset");
  const tApi = useTranslations("ApiErrors");

  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isValid = confirmation === CONFIRMATION_TOKEN;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch(API_PATH.VAULT_RESET, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.error) {
          setError(tApi(apiErrorToI18nKey(err.error)));
        } else {
          setError(tApi("unknownError"));
        }
        return;
      }

      // Full reload to re-initialize VaultProvider (client-side nav keeps stale state)
      window.location.href = `/${locale}/dashboard`;
    } catch {
      setError(tApi("unknownError"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md space-y-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {tCommon("back")}
        </Link>

        <div className="flex flex-col items-center gap-2 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <h1 className="text-2xl font-bold">{t("title")}</h1>
        </div>

        <form onSubmit={handleSubmit} onKeyDown={preventIMESubmit} className="space-y-4 rounded-lg border border-destructive/30 bg-card p-6 shadow-sm">
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {t("warning")}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-reset">{t("confirmationLabel")}</Label>
            <p className="text-sm font-mono text-muted-foreground">
              {t("confirmationText")}
            </p>
            <Input
              id="confirm-reset"
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
