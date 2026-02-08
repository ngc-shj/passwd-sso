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
import { Building2, Trash2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

interface OrgTrashEntry {
  id: string;
  orgId: string;
  orgName: string;
  role: string;
  title: string;
  username: string | null;
  deletedAt: string;
}

interface OrgTrashListProps {
  refreshKey: number;
}

export function OrgTrashList({ refreshKey }: OrgTrashListProps) {
  const t = useTranslations("Trash");
  const tOrg = useTranslations("Org");
  const [entries, setEntries] = useState<OrgTrashEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTrash = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/orgs/trash");
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data)) setEntries(data);
    } catch {
      // Network error
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTrash();
  }, [fetchTrash, refreshKey]);

  const handleRestore = async (entry: OrgTrashEntry) => {
    try {
      const res = await fetch(
        `/api/orgs/${entry.orgId}/passwords/${entry.id}/restore`,
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
        `/api/orgs/${entry.orgId}/passwords/${entry.id}?permanent=true`,
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

  if (loading || entries.length === 0) return null;

  return (
    <div className="mt-6">
      <div className="flex items-center gap-2 mb-3">
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-muted-foreground">
          {tOrg("organizationTrash")}
        </h2>
      </div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <Card key={entry.id}>
            <CardContent className="flex items-center gap-4 p-4">
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{entry.title}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  {entry.username && (
                    <p className="text-sm text-muted-foreground truncate">
                      {entry.username}
                    </p>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {entry.orgName}
                  </span>
                </div>
              </div>
              {(entry.role === "OWNER" || entry.role === "ADMIN") && (
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
