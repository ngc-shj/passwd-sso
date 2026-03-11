"use client";

import { useState, useRef } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, Loader2, AlertTriangle } from "lucide-react";
import { apiErrorToI18nKey } from "@/lib/api-error-codes";
import { fetchApi } from "@/lib/url-helpers";

interface SharePasswordGateProps {
  token: string;
  onVerified: (accessToken: string) => void;
  error?: string | null;
}

export function SharePasswordGate({
  token,
  onVerified,
  error: externalError,
}: SharePasswordGateProps) {
  const t = useTranslations("Share");
  const tApi = useTranslations("ApiErrors");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const MAX_ATTEMPTS = 5;

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text").trim();
    if (pasted) {
      setPassword(pasted);
    }
  };

  const handleSubmit = async () => {
    if (!password || loading || attempts >= MAX_ATTEMPTS) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetchApi("/api/share-links/verify-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => null);
        setAttempts((a) => a + 1);
        if (err?.error === "RATE_LIMIT_EXCEEDED") {
          setError(t("tooManyAttempts"));
        } else {
          setError(t("wrongPassword"));
        }
        return;
      }

      const data = await res.json();
      // Persist for potential page refresh recovery
      try {
        sessionStorage.setItem(`share-access:${token}`, data.accessToken);
      } catch {
        // sessionStorage unavailable (e.g. private browsing) — proceed anyway
      }
      onVerified(data.accessToken);
    } catch {
      setError(tApi(apiErrorToI18nKey("unknownError")));
    } finally {
      setLoading(false);
    }
  };

  const displayError = externalError || error;

  return (
    <div className="min-h-screen bg-gradient-to-b from-muted/30 to-background p-4">
      <div className="mx-auto max-w-md py-20">
        <Card className="w-full space-y-5 rounded-xl border bg-card/80 p-6">
          {/* Header */}
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <Lock className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                {t("passwordRequired")}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("passwordRequiredDesc")}
              </p>
            </div>
          </div>

          {/* Password input */}
          <div className="space-y-3">
            <div className="space-y-2">
              <Label className="text-xs">{t("accessPasswordLabel")}</Label>
              <Input
                ref={inputRef}
                type="text"
                value={password}
                readOnly
                onPaste={handlePaste}
                onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
                onClick={() => inputRef.current?.focus()}
                placeholder={t("pasteOnly")}
                className="font-mono text-sm"
                autoComplete="off"
              />
            </div>

            {displayError && (
              <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-2.5 text-xs text-destructive">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>{displayError}</span>
              </div>
            )}

            <Button
              onClick={handleSubmit}
              disabled={!password || loading || attempts >= MAX_ATTEMPTS}
              className="w-full"
            >
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("unlock")}
            </Button>

            {attempts >= MAX_ATTEMPTS && (
              <p className="text-xs text-center text-muted-foreground">
                {t("tooManyAttempts")}
              </p>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
