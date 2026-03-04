"use client";

import { useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { preventIMESubmit } from "@/lib/ime-guard";
import { API_PATH } from "@/lib/constants";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, Loader2, ShieldAlert } from "lucide-react";
import { fetchApi, withBasePath } from "@/lib/url-helpers";

const CONFIRMATION_TOKEN = "DELETE MY VAULT";

export default function AdminVaultResetPage() {
  const locale = useLocale();
  const t = useTranslations("VaultReset");
  const tApi = useTranslations("ApiErrors");

  const [token, setToken] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Extract token from URL fragment and immediately remove it
  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/token=([a-f0-9]+)/);
    if (match) {
      setToken(match[1]);
      // Remove token from URL and browser history
      history.replaceState(null, "", window.location.pathname);
    }
  }, []);

  const isValid = confirmation === CONFIRMATION_TOKEN;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isValid || !token) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetchApi(API_PATH.VAULT_ADMIN_RESET, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, confirmation }),
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

      // Full reload to re-initialize VaultProvider
      window.location.href = withBasePath(`/${locale}/dashboard`);
    } catch {
      setError(tApi("unknownError"));
    } finally {
      setLoading(false);
    }
  }

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
