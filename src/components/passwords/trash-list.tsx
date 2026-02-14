"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Trash2, Loader2, RotateCcw, FileText, CreditCard, IdCard } from "lucide-react";
import { toast } from "sonner";
import { API_PATH, ENTRY_TYPE, apiPath } from "@/lib/constants";
import {
  reconcileTrashSelectedIds,
  toggleTrashSelectAllIds,
  toggleTrashSelectOneId,
} from "./trash-list-selection";
import type { EntryTypeValue } from "@/lib/constants";

interface TrashEntry {
  id: string;
  entryType: EntryTypeValue;
  title: string;
  username: string | null;
  snippet: string | null;
  brand: string | null;
  lastFour: string | null;
  fullName: string | null;
  idNumberLast4: string | null;
  deletedAt: string;
}

interface TrashListProps {
  refreshKey: number;
}

export function TrashList({ refreshKey }: TrashListProps) {
  const t = useTranslations("Trash");
  const tl = useTranslations("PasswordList");
  const { encryptionKey, userId } = useVault();
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const allSelected = entries.length > 0 && selectedIds.size === entries.length;

  const fetchTrash = useCallback(async () => {
    if (!encryptionKey) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_PATH.PASSWORDS}?trash=true`);
      if (!res.ok) return;
      const data = await res.json();

      const decrypted: TrashEntry[] = [];
      for (const entry of data) {
        if (!entry.encryptedOverview) continue;
        try {
          const aad = entry.aadVersion >= 1 && userId
            ? buildPersonalEntryAAD(userId, entry.id)
            : undefined;
          const overview = JSON.parse(
            await decryptData(
              entry.encryptedOverview as EncryptedData,
              encryptionKey,
              aad
            )
          );
          decrypted.push({
            id: entry.id,
            entryType: entry.entryType ?? ENTRY_TYPE.LOGIN,
            title: overview.title,
            username: overview.username ?? null,
            snippet: overview.snippet ?? null,
            brand: overview.brand ?? null,
            lastFour: overview.lastFour ?? null,
            fullName: overview.fullName ?? null,
            idNumberLast4: overview.idNumberLast4 ?? null,
            deletedAt: entry.deletedAt,
          });
        } catch {
          // Skip entries that fail to decrypt
        }
      }
      setEntries(decrypted);
    } catch {
      // Network error
    } finally {
      setLoading(false);
    }
  }, [encryptionKey]);

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash, refreshKey]);

  useEffect(() => {
    setSelectedIds((prev) => {
      return reconcileTrashSelectedIds(prev, entries.map((entry) => entry.id));
    });
  }, [entries]);

  const handleRestore = async (id: string) => {
    try {
      const res = await fetch(apiPath.passwordRestore(id), { method: "POST" });
      if (res.ok) {
        toast.success(t("restored"));
        setEntries((prev) => prev.filter((e) => e.id !== id));
      } else {
        toast.error(t("failedAction"));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleDeletePermanently = async (id: string) => {
    try {
      const res = await fetch(`${apiPath.passwordById(id)}?permanent=true`, {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success(t("deletedPermanently"));
        setEntries((prev) => prev.filter((e) => e.id !== id));
      } else {
        toast.error(t("failedAction"));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleEmptyTrash = async () => {
    try {
      const res = await fetch(apiPath.passwordsEmptyTrash(), { method: "POST" });
      if (!res.ok) {
        toast.error(t("failedAction"));
        return;
      }
      toast.success(t("emptyTrashSuccess"));
      setEntries([]);
      setSelectedIds(new Set());
    } catch {
      toast.error(t("networkError"));
    }
  };

  const toggleSelectOne = (id: string, checked: boolean) => {
    setSelectedIds((prev) => toggleTrashSelectOneId(prev, id, checked));
  };

  const toggleSelectAll = (checked: boolean) => {
    setSelectedIds(toggleTrashSelectAllIds(entries.map((entry) => entry.id), checked));
  };

  const handleBulkRestore = async () => {
    if (selectedIds.size === 0) return;
    try {
      const res = await fetch(apiPath.passwordsBulkRestore(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      });
      if (!res.ok) {
        toast.error(t("bulkRestoreFailed"));
        return;
      }
      const json = await res.json();
      toast.success(
        t("bulkRestored", { count: json.restoredCount ?? selectedIds.size })
      );
      setEntries((prev) => prev.filter((entry) => !selectedIds.has(entry.id)));
      setSelectedIds(new Set());
    } catch {
      toast.error(t("bulkRestoreFailed"));
    }
  };

  if (loading) {
    return (
      <Card className="rounded-xl border bg-card/80 p-10">
        <div className="flex items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </Card>
    );
  }

  if (entries.length === 0) {
    return (
      <Card className="rounded-xl border bg-card/80 p-10">
        <div className="flex flex-col items-center justify-center text-center">
          <Trash2 className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <p className="text-muted-foreground">{tl("noTrash")}</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t("description")}</p>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="destructive" size="sm">
              {t("emptyTrash")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("emptyTrash")}</DialogTitle>
              <DialogDescription>{t("emptyTrashConfirm")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="destructive" onClick={handleEmptyTrash}>
                {t("emptyTrash")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {selectedIds.size > 0 && (
        <div className="sticky top-4 z-40 flex items-center justify-between rounded-md border bg-background/95 px-3 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="flex items-center gap-3">
            <Checkbox
              checked={allSelected}
              onCheckedChange={(v) => toggleSelectAll(Boolean(v))}
              aria-label={tl("selectAll")}
            />
            <span className="text-sm text-muted-foreground">
              {tl("selectedCount", { count: selectedIds.size })}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedIds(new Set())}
            >
              {tl("clearSelection")}
            </Button>
            <Button size="sm" onClick={handleBulkRestore}>
              <RotateCcw className="h-3.5 w-3.5 mr-1" />
              {t("restoreSelected")}
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {entries.map((entry) => (
          <Card key={entry.id} className="rounded-xl border bg-background/80 transition-colors hover:bg-muted/30">
            <CardContent className="flex items-center gap-4 p-4">
              <Checkbox
                checked={selectedIds.has(entry.id)}
                onCheckedChange={(v) => toggleSelectOne(entry.id, Boolean(v))}
                aria-label={tl("selectEntry", { title: entry.title })}
              />
              {entry.entryType === ENTRY_TYPE.IDENTITY ? (
                <IdCard className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : entry.entryType === ENTRY_TYPE.CREDIT_CARD ? (
                <CreditCard className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : entry.entryType === ENTRY_TYPE.SECURE_NOTE ? (
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : null}
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{entry.title}</p>
                {entry.entryType === ENTRY_TYPE.IDENTITY ? (
                  (entry.fullName || entry.idNumberLast4) && (
                    <p className="text-sm text-muted-foreground truncate">
                      {entry.fullName}{entry.fullName && entry.idNumberLast4 ? " " : ""}{entry.idNumberLast4 ? `•••• ${entry.idNumberLast4}` : ""}
                    </p>
                  )
                ) : entry.entryType === ENTRY_TYPE.CREDIT_CARD ? (
                  (entry.brand || entry.lastFour) && (
                    <p className="text-sm text-muted-foreground truncate">
                      {entry.brand}{entry.brand && entry.lastFour ? " " : ""}{entry.lastFour ? `•••• ${entry.lastFour}` : ""}
                    </p>
                  )
                ) : entry.entryType === ENTRY_TYPE.SECURE_NOTE ? (
                  entry.snippet && (
                    <p className="text-sm text-muted-foreground truncate">
                      {entry.snippet}
                    </p>
                  )
                ) : (
                  entry.username && (
                    <p className="text-sm text-muted-foreground truncate">
                      {entry.username}
                    </p>
                  )
                )}
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRestore(entry.id)}
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1" />
                  {t("restore")}
                </Button>
                <Dialog>
                  <DialogTrigger asChild>
                    <Button variant="destructive" size="sm">
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      {t("deletePermanently")}
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>{t("deletePermanently")}</DialogTitle>
                      <DialogDescription>
                        {t("deleteConfirm", { title: entry.title })}
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button
                        variant="destructive"
                        onClick={() => handleDeletePermanently(entry.id)}
                      >
                        {t("deletePermanently")}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
