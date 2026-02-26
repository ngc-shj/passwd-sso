"use client";

import { useEffect, useState, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Building2, Trash2, RotateCcw, FileText, CreditCard, IdCard } from "lucide-react";
import { toast } from "sonner";
import { ORG_ROLE, ENTRY_TYPE, API_PATH, apiPath } from "@/lib/constants";
import type { EntryTypeValue } from "@/lib/constants";
import {
  compareEntriesByDeletedAt,
  type EntrySortOption,
} from "@/lib/entry-sort";
import { useOrgVault } from "@/lib/org-vault-context";
import { decryptData } from "@/lib/crypto-client";
import { buildOrgEntryAAD } from "@/lib/crypto-aad";

interface OrgTrashEntry {
  id: string;
  entryType: EntryTypeValue;
  orgId: string;
  orgName: string;
  role: string;
  title: string;
  username: string | null;
  snippet: string | null;
  brand: string | null;
  lastFour: string | null;
  fullName: string | null;
  idNumberLast4: string | null;
  deletedAt: string;
}

interface OrgTrashListProps {
  orgId?: string;
  searchQuery?: string;
  refreshKey: number;
  sortBy?: EntrySortOption;
}

export function OrgTrashList({
  orgId,
  searchQuery = "",
  refreshKey,
  sortBy = "updatedAt",
}: OrgTrashListProps) {
  const t = useTranslations("Trash");
  const tOrg = useTranslations("Team");
  const { getOrgEncryptionKey } = useOrgVault();
  const [entries, setEntries] = useState<OrgTrashEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTrash = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(API_PATH.TEAMS_TRASH);
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;

      const decrypted = await Promise.all(
        data.map(async (entry: Record<string, unknown>) => {
          try {
            const entryOrgId = entry.orgId as string;
            const orgKey = await getOrgEncryptionKey(entryOrgId);
            if (!orgKey) throw new Error("No org key");
            const aad = buildOrgEntryAAD(entryOrgId, entry.id as string, "overview");
            const json = await decryptData(
              {
                ciphertext: entry.encryptedOverview as string,
                iv: entry.overviewIv as string,
                authTag: entry.overviewAuthTag as string,
              },
              orgKey,
              aad,
            );
            const overview = JSON.parse(json);
            return {
              id: entry.id,
              entryType: entry.entryType,
              orgId: entryOrgId,
              orgName: entry.orgName,
              role: entry.role,
              title: overview.title ?? "",
              username: overview.username ?? null,
              snippet: overview.snippet ?? null,
              brand: overview.brand ?? null,
              lastFour: overview.lastFour ?? null,
              fullName: overview.fullName ?? null,
              idNumberLast4: overview.idNumberLast4 ?? null,
              deletedAt: entry.deletedAt,
            } as OrgTrashEntry;
          } catch {
            return {
              id: entry.id as string,
              entryType: entry.entryType as EntryTypeValue,
              orgId: entry.orgId as string,
              orgName: entry.orgName as string,
              role: entry.role as string,
              title: "(decryption failed)",
              username: null,
              snippet: null,
              brand: null,
              lastFour: null,
              fullName: null,
              idNumberLast4: null,
              deletedAt: entry.deletedAt as string,
            } as OrgTrashEntry;
          }
        }),
      );
      setEntries(decrypted);
    } catch {
      // Network error
    } finally {
      setLoading(false);
    }
  }, [getOrgEncryptionKey]);

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash, refreshKey]);

  const handleRestore = async (entry: OrgTrashEntry) => {
    try {
      const res = await fetch(
        apiPath.teamPasswordRestore(entry.orgId, entry.id),
        { method: "POST" }
      );
      if (res.ok) {
        toast.success(t("restored"));
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      } else {
        toast.error(t("failedAction"));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleDeletePermanently = async (entry: OrgTrashEntry) => {
    try {
      const res = await fetch(
        `${apiPath.teamPasswordById(entry.orgId, entry.id)}?permanent=true`,
        { method: "DELETE" }
      );
      if (res.ok) {
        toast.success(t("deletedPermanently"));
        setEntries((prev) => prev.filter((e) => e.id !== entry.id));
      } else {
        toast.error(t("failedAction"));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const filtered = entries.filter((entry) => {
    if (orgId && entry.orgId !== orgId) return false;
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      entry.title.toLowerCase().includes(q) ||
      entry.username?.toLowerCase().includes(q) ||
      entry.snippet?.toLowerCase().includes(q) ||
      entry.brand?.toLowerCase().includes(q) ||
      entry.lastFour?.includes(q) ||
      entry.fullName?.toLowerCase().includes(q) ||
      entry.idNumberLast4?.includes(q) ||
      entry.orgName.toLowerCase().includes(q)
    );
  });

  const sortedFiltered = [...filtered].sort((a, b) =>
    compareEntriesByDeletedAt(a, b, sortBy)
  );

  if (loading || sortedFiltered.length === 0) return null;

  return (
    <div className="mt-6">
      {!orgId && (
        <div className="mb-3 flex items-center gap-2">
          <Building2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-muted-foreground">
            {tOrg("trash")}
          </h2>
        </div>
      )}
      <div className="space-y-2">
        {sortedFiltered.map((entry) => (
          <Card key={entry.id} className="transition-colors hover:bg-accent">
            <CardContent className="flex items-center gap-3 px-4 py-2">
              {entry.entryType === ENTRY_TYPE.IDENTITY ? (
                <IdCard className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : entry.entryType === ENTRY_TYPE.CREDIT_CARD ? (
                <CreditCard className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : entry.entryType === ENTRY_TYPE.SECURE_NOTE ? (
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : null}
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{entry.title}</p>
                <div className="flex items-center gap-2">
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
                  <span className="text-xs text-muted-foreground">
                    {entry.orgName}
                  </span>
                </div>
              </div>
              {(entry.role === ORG_ROLE.OWNER || entry.role === ORG_ROLE.ADMIN) && (
                <div className="flex gap-2 shrink-0">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRestore(entry)}
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
                          onClick={() => handleDeletePermanently(entry)}
                        >
                          {t("deletePermanently")}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
