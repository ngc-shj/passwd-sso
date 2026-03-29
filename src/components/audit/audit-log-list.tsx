"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import type { AuditLogItem } from "@/hooks/use-audit-logs";

interface AuditLogListProps {
  logs: AuditLogItem[];
  loading: boolean;
  loadingMore: boolean;
  nextCursor: string | null;
  onLoadMore: () => void;
  renderItem: (log: AuditLogItem) => ReactNode;
}

export function AuditLogList({
  logs,
  loading,
  loadingMore,
  nextCursor,
  onLoadMore,
  renderItem,
}: AuditLogListProps) {
  const t = useTranslations("AuditLog");

  if (loading) {
    return (
      <Card className="rounded-xl border bg-card/80 p-10">
        <div className="flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </Card>
    );
  }

  if (logs.length === 0) {
    return (
      <Card className="rounded-xl border bg-card/80 p-10">
        <p className="text-center text-muted-foreground">{t("noLogs")}</p>
      </Card>
    );
  }

  return (
    <>
      <Card data-testid="audit-log-list" className="rounded-xl border bg-card/80 divide-y">
        {logs.map((log) => renderItem(log))}
      </Card>

      {nextCursor && (
        <div className="flex justify-center pt-4">
          <Button
            variant="outline"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {t("loadMore")}
          </Button>
        </div>
      )}
    </>
  );
}
