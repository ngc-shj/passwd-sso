"use client";

import { useState, useEffect, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, ScrollText, ArrowLeft, ShieldAlert } from "lucide-react";
import { apiPath, type AuditActionValue } from "@/lib/constants";
import { normalizeAuditActionKey } from "@/lib/audit/audit-action-key";
import { formatDateTime } from "@/lib/format/format-datetime";
import { fetchApi } from "@/lib/url-helpers";

interface AuditLogItem {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  user?: { id: string; name: string | null; email: string | null } | null;
}

interface BreakGlassPersonalLogViewerProps {
  grantId: string;
  targetUserName: string;
  expiresAt: string;
  onBack: () => void;
}

export function BreakGlassPersonalLogViewer({
  grantId,
  targetUserName,
  expiresAt,
  onBack,
}: BreakGlassPersonalLogViewerProps) {
  const t = useTranslations("Breakglass");
  const tAudit = useTranslations("AuditLog");
  const locale = useLocale();
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const fetchLogs = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      const res = await fetchApi(
        `${apiPath.tenantBreakglassLogs(grantId)}?${params.toString()}`
      );
      if (!res.ok) return null;
      return res.json();
    },
    [grantId]
  );

  useEffect(() => {
    let cancelled = false;
    fetchLogs().then((data) => {
      if (cancelled) return;
      if (data) {
        setLogs(data.items ?? []);
        setNextCursor(data.nextCursor ?? null);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fetchLogs]);

  const handleLoadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const data = await fetchLogs(nextCursor);
    if (data) {
      setLogs((prev) => [...prev, ...(data.items ?? [])]);
      setNextCursor(data.nextCursor ?? null);
    }
    setLoadingMore(false);
  };

  const actionLabel = (action: AuditActionValue | string) => {
    const key = normalizeAuditActionKey(String(action));
    return tAudit.has(key as never) ? tAudit(key as never) : String(action);
  };

  const getTargetLabel = (log: AuditLogItem): string | null => {
    if (
      log.targetType === "PASSWORD_ENTRY" &&
      log.targetId
    ) {
      return t("encryptedEntry");
    }
    const meta =
      log.metadata && typeof log.metadata === "object"
        ? (log.metadata as Record<string, unknown>)
        : null;
    if (meta?.filename) return String(meta.filename);
    return null;
  };

  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="h-4 w-4 mr-1" />
        {t("backToGrants")}
      </Button>

      <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30 p-3 flex gap-2">
        <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
        <p className="text-amber-700 dark:text-amber-300 text-sm">
          <span className="font-medium">{t("viewingLogs", { userName: targetUserName })}</span>
          {" — "}
          {t("grantExpiresAt", {
            expiresAt: formatDateTime(expiresAt, locale),
          })}
        </p>
      </div>

      {loading ? (
        <Card className="rounded-xl border bg-card/80 p-8">
          <div className="flex justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        </Card>
      ) : logs.length === 0 ? (
        <Card className="rounded-xl border bg-card/80 p-8">
          <p className="text-center text-muted-foreground">{tAudit("noLogs")}</p>
        </Card>
      ) : (
        <>
          <Card className="rounded-xl border bg-card/80 divide-y">
            {logs.map((log) => {
              const targetLabel = getTargetLabel(log);
              return (
                <div
                  key={log.id}
                  className="px-4 py-3 flex items-start gap-3 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50"
                >
                  <div className="shrink-0 text-muted-foreground mt-0.5">
                    <ScrollText className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{actionLabel(log.action as AuditActionValue)}</p>
                    {targetLabel && (
                      <p className="text-xs text-muted-foreground truncate">{targetLabel}</p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(log.createdAt, locale)}
                    </p>
                    {log.ip && (
                      <p className="text-xs text-muted-foreground">{log.ip}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>

          {nextCursor && (
            <div className="flex justify-center pt-2">
              <Button variant="outline" onClick={handleLoadMore} disabled={loadingMore}>
                {loadingMore && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {tAudit("loadMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
