"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useLocale } from "next-intl";
import { ChevronDown, ChevronRight, History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPath } from "@/lib/constants";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

interface HistoryEntry {
  id: string;
  entryId: string;
  encryptedBlob: {
    ciphertext: string;
    iv: string;
    authTag: string;
  };
  keyVersion: number;
  aadVersion: number;
  changedAt: string;
}

interface EntryHistorySectionProps {
  entryId: string;
  onRestore?: () => void;
}

function formatDateTime(dateStr: string, locale: string) {
  return new Date(dateStr).toLocaleString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function EntryHistorySection({ entryId, onRestore }: EntryHistorySectionProps) {
  const t = useTranslations("PasswordDetail");
  const locale = useLocale();
  const [expanded, setExpanded] = useState(false);
  const [histories, setHistories] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<HistoryEntry | null>(null);
  const [restoring, setRestoring] = useState(false);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiPath.passwordHistory(entryId));
      if (res.ok) {
        const data = await res.json();
        setHistories(data);
      }
    } finally {
      setLoading(false);
    }
  }, [entryId]);

  useEffect(() => {
    if (expanded && histories.length === 0) {
      fetchHistory();
    }
  }, [expanded, fetchHistory, histories.length]);

  const handleRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const res = await fetch(
        apiPath.passwordHistoryRestore(entryId, restoreTarget.id),
        { method: "POST" },
      );
      if (res.ok) {
        toast.success(t("restoreVersion"));
        setRestoreTarget(null);
        fetchHistory();
        onRestore?.();
      }
    } finally {
      setRestoring(false);
    }
  };

  return (
    <>
      <div className="space-y-1">
        <button
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
          <History className="h-3 w-3" />
          {t("entryHistory")}
          {histories.length > 0 && ` (${histories.length})`}
        </button>
        {expanded && (
          <div className="space-y-2 pl-5 pt-1">
            {loading && (
              <p className="text-xs text-muted-foreground">Loading...</p>
            )}
            {!loading && histories.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("entryHistoryEmpty")}
              </p>
            )}
            {histories.map((h) => (
              <div
                key={h.id}
                className="flex items-center gap-2 rounded-lg border bg-muted/30 p-2"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-muted-foreground">
                    {t("versionFrom", { date: formatDateTime(h.changedAt, locale) })}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => setRestoreTarget(h)}
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  {t("restoreVersion")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <AlertDialog
        open={!!restoreTarget}
        onOpenChange={(open) => !open && setRestoreTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("restoreVersion")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("restoreConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestore} disabled={restoring}>
              {t("restoreVersion")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
