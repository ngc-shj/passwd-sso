"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Loader2, Lock, Eye, EyeOff } from "lucide-react";

export function VaultLockScreen() {
  const t = useTranslations("Vault");
  const { unlock } = useVault();

  const [passphrase, setPassphrase] = useState("");
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase) return;

    setLoading(true);
    setError("");
    try {
      const success = await unlock(passphrase);
      if (!success) {
        setError(t("wrongPassphrase"));
        setPassphrase("");
      }
    } catch {
      setError(t("unlockError"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-b from-muted/30 to-background p-4">
      <Card className="w-full max-w-sm rounded-xl border">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <Lock className="h-6 w-6 text-muted-foreground" />
          </div>
          <CardTitle>{t("locked")}</CardTitle>
          <CardDescription>{t("lockedDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="unlock-passphrase">{t("passphrase")}</Label>
              <div className="relative">
                <Input
                  id="unlock-passphrase"
                  type={showPassphrase ? "text" : "password"}
                  value={passphrase}
                  onChange={(e) => {
                    setPassphrase(e.target.value);
                    setError("");
                  }}
                  placeholder={t("enterPassphrase")}
                  autoComplete="current-password"
                  autoFocus
                  required
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                  onClick={() => setShowPassphrase(!showPassphrase)}
                >
                  {showPassphrase ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive text-center">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={!passphrase || loading}
            >
              {loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("unlock")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
