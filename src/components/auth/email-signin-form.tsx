"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2, Mail, CheckCircle2 } from "lucide-react";

export function EmailSignInForm() {
  const t = useTranslations("Auth");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = email.trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setError(t("emailInvalid"));
      return;
    }

    setLoading(true);
    try {
      // Always show "sent" regardless of whether the email exists or the
      // signIn callback rejects it. This prevents user enumeration — an
      // attacker cannot distinguish valid from invalid addresses.
      await signIn("nodemailer", {
        email: trimmed,
        redirect: false,
      });
      setSent(true);
    } catch {
      setError(t("error"));
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        <CheckCircle2 className="h-10 w-10 text-green-500" />
        <div>
          <p className="font-medium">{t("emailSent")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("emailSentDescription")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="relative">
        <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="email"
          placeholder={t("emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="pl-10 h-12"
          disabled={loading}
          autoComplete="email"
        />
      </div>
      {error && (
        <p className="text-sm text-destructive">{error}</p>
      )}
      <Button
        type="submit"
        className="w-full h-12"
        disabled={loading}
      >
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin" />
        ) : (
          t("signInWithEmail")
        )}
      </Button>
    </form>
  );
}
