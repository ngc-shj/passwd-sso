"use client";

import { useLocale, useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/passwords/copy-button";
import { Clock, Eye, MessageSquare, Paperclip, Download } from "lucide-react";
import { formatDateTime } from "@/lib/format-datetime";

interface ShareSendViewProps {
  sendType: "TEXT" | "FILE";
  name: string;
  text?: string;
  filename?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  token: string;
  expiresAt: string;
  viewCount: number;
  maxViews: number | null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
}: ShareSendViewProps) {
  const t = useTranslations("Share");
  const locale = useLocale();

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
                <Button asChild className="w-full">
                  <a href={`/s/${token}/download`}>
                    <Download className="mr-2 h-4 w-4" />
                    {t("sendDownload")}
                  </a>
                </Button>
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
            {maxViews && (
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
