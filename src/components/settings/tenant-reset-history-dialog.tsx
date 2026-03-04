"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Loader2, History, X } from "lucide-react";
import { toast } from "sonner";
import { fetchApi } from "@/lib/url-helpers";
import { apiPath } from "@/lib/constants";
import { formatDateTime } from "@/lib/format-datetime";

interface ResetRecord {
  id: string;
  status: "pending" | "executed" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string;
  executedAt: string | null;
  revokedAt: string | null;
  initiatedBy: { name: string | null; email: string | null };
}

interface TenantResetHistoryDialogProps {
  userId: string;
  memberName: string;
  pendingResets: number;
  onRevoke?: () => void;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "default",
  executed: "destructive",
  revoked: "secondary",
  expired: "outline",
};

export function TenantResetHistoryDialog({
  userId,
  memberName,
  pendingResets,
  onRevoke,
}: TenantResetHistoryDialogProps) {
  const t = useTranslations("TenantAdmin");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<ResetRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchApi(apiPath.tenantMemberResetVault(userId));
      if (res.ok) {
        const data = await res.json();
        setRecords(Array.isArray(data) ? data : []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    if (open) fetchHistory();
  }, [open, fetchHistory]);

  const handleRevoke = async (resetId: string) => {
    setRevokingId(resetId);
    try {
      const res = await fetchApi(
        apiPath.tenantMemberResetVaultRevoke(userId, resetId),
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      if (res.ok) {
        toast.success(t("revokeSuccess"));
        await fetchHistory();
        onRevoke?.();
      } else if (res.status === 409) {
        toast.error(t("revokeConflict"));
        await fetchHistory();
      } else {
        toast.error(t("revokeFailed"));
      }
    } catch {
      toast.error(t("revokeFailed"));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2">
          <History className="h-3.5 w-3.5" />
          {pendingResets > 0 && (
            <Badge variant="default" className="h-5 px-1.5 text-xs">
              {pendingResets}
            </Badge>
          )}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t("resetHistoryTitle")} — {memberName}
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : records.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("noResetHistory")}
          </p>
        ) : (
          <div className="max-h-80 space-y-3 overflow-y-auto">
            {records.map((r) => (
              <div
                key={r.id}
                className="flex items-start justify-between rounded-md border p-3"
              >
                <div className="space-y-1 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_VARIANT[r.status]}>
                      {t(`status${r.status.charAt(0).toUpperCase() + r.status.slice(1)}` as `statusPending` | `statusExecuted` | `statusRevoked` | `statusExpired`)}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(r.createdAt, locale)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("initiatedBy")}: {r.initiatedBy.name ?? r.initiatedBy.email ?? "—"}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("expiresAt")}: {formatDateTime(r.expiresAt, locale)}
                  </p>
                </div>

                {r.status === "pending" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs text-destructive"
                    onClick={() => handleRevoke(r.id)}
                    disabled={revokingId === r.id}
                  >
                    {revokingId === r.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <X className="mr-1 h-3.5 w-3.5" />
                    )}
                    {t("revokeButton")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
