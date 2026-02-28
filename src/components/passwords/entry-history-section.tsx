"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { useLocale } from "next-intl";
import { ChevronDown, ChevronRight, Eye, EyeOff, History, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiPath } from "@/lib/constants";
import { useVault } from "@/lib/vault-context";
import { useTeamVault } from "@/lib/team-vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD, buildTeamEntryAAD } from "@/lib/crypto-aad";
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { useReprompt } from "@/hooks/use-reprompt";
import { formatDateTime, formatDate } from "@/lib/format-datetime";
import { DISPLAY_KEYS, SENSITIVE_KEYS, DATE_KEYS, TRANSLATED_VALUE_KEYS } from "./entry-history-keys";

interface HistoryEntry {
  id: string;
  entryId: string;
  encryptedBlob: EncryptedData;
  keyVersion?: number;
  aadVersion: number;
  changedAt: string;
  changedBy?: { id: string; name: string | null; email: string | null };
}

interface EntryHistorySectionProps {
  entryId: string;
  teamId?: string;
  requireReprompt?: boolean;
  onRestore?: () => void;
}

function ViewContent({ data }: { data: Record<string, unknown> }) {
  const t = useTranslations("PasswordDetail");
  const locale = useLocale();
  const [revealedKeys, setRevealedKeys] = useState<Set<string>>(new Set());
  const entries = DISPLAY_KEYS
    .filter((key) => data[key] != null && data[key] !== "")
    .map((key) => {
      let value = String(data[key]);
      if (DATE_KEYS.has(key)) {
        value = formatDate(value, locale);
      } else if (TRANSLATED_VALUE_KEYS[key]?.[value]) {
        value = t(TRANSLATED_VALUE_KEYS[key][value]);
      }
      return [key, value];
    });

  const toggleReveal = (key: string) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        setTimeout(() => {
          setRevealedKeys((p) => {
            const n = new Set(p);
            n.delete(key);
            return n;
          });
        }, 30_000);
      }
      return next;
    });
  };

  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => (
        <div key={key}>
          <p className="text-xs font-medium text-muted-foreground">{t(key)}</p>
          {SENSITIVE_KEYS.has(key) ? (
            <div className="flex items-center gap-1">
              <p className="text-sm break-all whitespace-pre-wrap font-mono">
                {revealedKeys.has(key) ? value : "••••••••"}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                onClick={() => toggleReveal(key)}
              >
                {revealedKeys.has(key) ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          ) : (
            <p className="text-sm break-all whitespace-pre-wrap">{value}</p>
          )}
        </div>
      ))}
      {entries.length === 0 && (
        <p className="text-xs text-muted-foreground">No data</p>
      )}
    </div>
  );
}

export function EntryHistorySection({
  entryId,
  teamId: scopedTeamId,
  requireReprompt,
  onRestore,
}: EntryHistorySectionProps) {
  const t = useTranslations("PasswordDetail");
  const locale = useLocale();
  const { encryptionKey, userId } = useVault();
  const { getTeamEncryptionKey } = useTeamVault();
  const { requireVerification, repromptDialog } = useReprompt();
  const [expanded, setExpanded] = useState(false);
  const [histories, setHistories] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<HistoryEntry | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [viewData, setViewData] = useState<Record<string, unknown> | null>(null);
  const [viewLoading, setViewLoading] = useState(false);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const url = scopedTeamId
        ? apiPath.teamPasswordHistory(scopedTeamId, entryId)
        : apiPath.passwordHistory(entryId);
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setHistories(data);
      }
    } finally {
      setLoading(false);
    }
  }, [entryId, scopedTeamId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const handleRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const url = scopedTeamId
        ? apiPath.teamPasswordHistoryRestore(scopedTeamId, entryId, restoreTarget.id)
        : apiPath.passwordHistoryRestore(entryId, restoreTarget.id);
      const res = await fetch(url, { method: "POST" });
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

  const handleView = async (h: HistoryEntry) => {
    setViewLoading(true);
    try {
      if (scopedTeamId) {
        // Team entries: fetch encrypted blob, then decrypt client-side.
        // TODO: If h.teamKeyVersion !== current team version, fetch old key via
        // GET /member-key?keyVersion=N for correct decryption.
        // Currently uses latest key only — history from before key rotation
        // will fail to decrypt until re-encryption is implemented.
        const res = await fetch(apiPath.teamPasswordHistoryById(scopedTeamId, entryId, h.id));
        if (!res.ok) return;
        const data = await res.json();
        const teamKey = await getTeamEncryptionKey(scopedTeamId);
        if (!teamKey) return;
        const aad = data.aadVersion >= 1
          ? buildTeamEntryAAD(scopedTeamId, entryId, "blob")
          : undefined;
        const plaintext = await decryptData(
          {
            ciphertext: data.encryptedBlob,
            iv: data.blobIv,
            authTag: data.blobAuthTag,
          },
          teamKey,
          aad,
        );
        setViewData(JSON.parse(plaintext));
      } else {
        // Personal entries: client-side decryption
        if (!encryptionKey || !userId) return;
        const aad = h.aadVersion >= 1
          ? buildPersonalEntryAAD(userId, entryId)
          : undefined;
        const plaintext = await decryptData(h.encryptedBlob, encryptionKey, aad);
        setViewData(JSON.parse(plaintext));
      }
    } catch {
      toast.error("Failed to decrypt history version");
    } finally {
      setViewLoading(false);
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
                  {h.changedBy && (
                    <p className="text-xs text-muted-foreground">
                      {h.changedBy.name || h.changedBy.email}
                    </p>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  disabled={viewLoading}
                  onClick={() => requireVerification(entryId, requireReprompt ?? false, () => handleView(h))}
                >
                  <Eye className="h-3 w-3 mr-1" />
                  {t("viewVersion")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 shrink-0 text-xs"
                  onClick={() => requireVerification(entryId, requireReprompt ?? false, () => setRestoreTarget(h))}
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  {t("restoreVersion")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* View Dialog */}
      <Dialog open={!!viewData} onOpenChange={(open) => !open && setViewData(null)}>
        <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("viewVersion")}</DialogTitle>
          </DialogHeader>
          {viewData && <ViewContent data={viewData} />}
        </DialogContent>
      </Dialog>

      {/* Restore Confirmation */}
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

      {repromptDialog}
    </>
  );
}
