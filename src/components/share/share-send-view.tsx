"use client";

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/passwords/copy-button";
import { Clock, Eye, MessageSquare, Paperclip, Download, AlertTriangle } from "lucide-react";
import { formatDateTime } from "@/lib/format/format-datetime";
import { formatFileSize } from "@/lib/format/format-file-size";
import { fetchApi, withBasePath } from "@/lib/url-helpers";

interface ShareSendViewProps {
  sendType: "TEXT" | "FILE";
  name: string;
  text?: string;
  filename?: string | null;
  sizeBytes?: number | null;
  token: string;
  expiresAt: string;
  viewCount: number;
  maxViews: number | null;
  accessToken?: string;
}

export function ShareSendView({
  sendType,
  name,
  text,
  filename,
  sizeBytes,
  token,
  expiresAt,
  viewCount,
  maxViews,
  accessToken,
}: ShareSendViewProps) {
  const t = useTranslations("Share");
  const locale = useLocale();
  const [downloadError, setDownloadError] = useState(false);

  const handleDownload = useCallback(async () => {
    if (!accessToken) {
      // Non-protected share: direct download
      window.location.href = withBasePath(`/s/${token}/download`);
      return;
    }

    // Protected share: fetch with Authorization header
    setDownloadError(false);
    try {
      const res = await fetchApi(`/s/${token}/download`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!res.ok) {
        setDownloadError(true);
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename ?? "download";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError(true);
    }
  }, [accessToken, token, filename]);

  return (
    <div className="min-h-screen bg-gradient-to-b from-muted/30 to-background p-4">
      <div className="mx-auto max-w-4xl py-6">
        <Card className="w-full space-y-5 rounded-xl border bg-card/80 p-6">
          {/* Header */}
          <div className="flex items-center gap-3 rounded-lg border bg-muted/20 p-3">
            <div className="text-muted-foreground shrink-0">
              {sendType === "TEXT" ? (
                <MessageSquare className="h-5 w-5" />
              ) : (
                <Paperclip className="h-5 w-5" />
              )}
            </div>
            <div className="flex-1 min-w-0">
              <h1 className="text-lg font-semibold truncate tracking-tight">
                {name}
              </h1>
            </div>
          </div>

          {/* Content */}
          <div className="space-y-4 rounded-lg border bg-gradient-to-b from-muted/20 to-background p-4">
            {sendType === "TEXT" && text != null && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm text-muted-foreground">
                    {t("sendContent")}
                  </label>
                  <CopyButton getValue={() => text} />
                </div>
                <div className="rounded-lg border bg-muted/30 p-3">
                  <pre className="text-sm whitespace-pre-wrap break-words font-mono">
                    {text}
                  </pre>
                </div>
              </div>
            )}

            {sendType === "FILE" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  {filename && (
                    <div className="space-y-1">
                      <label className="text-sm text-muted-foreground">
                        {t("sendFile")}
                      </label>
                      <p className="text-sm break-all">{filename}</p>
                    </div>
                  )}
                  {sizeBytes != null && (
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(sizeBytes)}
                    </p>
                  )}
                </div>
                {downloadError && (
                  <div className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-2.5 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span>{t("contentLoadError")}</span>
                  </div>
                )}
                {accessToken ? (
                  <Button className="w-full" onClick={handleDownload}>
                    <Download className="mr-2 h-4 w-4" />
                    {t("sendDownload")}
                  </Button>
                ) : (
                  <Button asChild className="w-full">
                    <a href={withBasePath(`/s/${token}/download`)}>
                      <Download className="mr-2 h-4 w-4" />
                      {t("sendDownload")}
                    </a>
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Footer metadata */}
          <div className="border-t pt-3 space-y-1 rounded-lg bg-muted/10 px-3 py-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3.5 w-3.5" />
              <span>
                {t("expiresAt", {
                  date: formatDateTime(expiresAt, locale),
                })}
              </span>
            </div>
            {maxViews != null && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Eye className="h-3.5 w-3.5" />
                <span>
                  {t("viewCount", { current: viewCount, max: maxViews })}
                </span>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
