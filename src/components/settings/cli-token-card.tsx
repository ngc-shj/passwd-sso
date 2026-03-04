"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Terminal, Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { API_PATH } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";

export function CliTokenCard() {
  const t = useTranslations("CliToken");
  const [generating, setGenerating] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const res = await fetchApi(API_PATH.EXTENSION_TOKEN, { method: "POST" });
      if (res.ok) {
        const data = await res.json();
        setToken(data.token);
        toast.success(t("generated"));
      } else if (res.status === 429) {
        toast.error(t("rateLimited"));
      } else {
        toast.error(t("generateError"));
      }
    } catch {
      toast.error(t("generateError"));
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied
    }
  };

  return (
    <Card className="p-6 space-y-4">
      <section>
        <div className="flex items-center gap-2">
          <Terminal className="h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("title")}</h2>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          {t("description")}
        </p>
      </section>

      {token ? (
        <section className="border rounded-md p-4 bg-muted/50 space-y-2">
          <p className="text-sm font-medium">{t("tokenReady")}</p>
          <div className="flex items-center gap-2">
            <Input value={token} readOnly className="font-mono text-xs" />
            <Button variant="ghost" size="icon" onClick={handleCopy}>
              {copied ? (
                <Check className="h-4 w-4 text-green-500" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("tokenOnce")}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setToken(null)}
          >
            OK
          </Button>
        </section>
      ) : (
        <Button onClick={handleGenerate} disabled={generating} size="sm">
          {generating && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          {t("generate")}
        </Button>
      )}

      <section className="space-y-1">
        <p className="text-xs text-muted-foreground">{t("usage")}</p>
        <code className="block text-xs bg-muted rounded px-2 py-1 font-mono">
          passwd-sso login
        </code>
      </section>
    </Card>
  );
}
