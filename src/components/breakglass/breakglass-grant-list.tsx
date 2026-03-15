"use client";

import { useState, useEffect, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { Loader2, Eye, X, ChevronDown, ChevronUp } from "lucide-react";
import { apiPath, GRANT_STATUS } from "@/lib/constants";
import type { GrantStatus } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { formatDateTime } from "@/lib/format-datetime";
import { formatUserName } from "@/lib/format-user";
import { toast } from "sonner";
import { BreakGlassPersonalLogViewer } from "./breakglass-personal-log-viewer";

interface BreakGlassGrant {
  id: string;
  status: GrantStatus;
  reason: string;
  incidentRef: string | null;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  requester: { id: string; name: string | null; email: string | null } | null;
  targetUser: { id: string; name: string | null; email: string | null } | null;
}

interface BreakGlassGrantListProps {
  refreshTrigger: number;
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  [GRANT_STATUS.ACTIVE]: "default",
  [GRANT_STATUS.EXPIRED]: "secondary",
  [GRANT_STATUS.REVOKED]: "destructive",
};

export function BreakGlassGrantList({ refreshTrigger }: BreakGlassGrantListProps) {
  const t = useTranslations("Breakglass");
  const tc = useTranslations("Common");
  const locale = useLocale();
  const [grants, setGrants] = useState<BreakGlassGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [viewingLogGrantId, setViewingLogGrantId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTargetId, setRevokeTargetId] = useState<string | null>(null);

  const fetchGrants = useCallback(async () => {
    setLoading(true);
    const res = await fetchApi(apiPath.tenantBreakglass());
    if (res.ok) {
      const data = await res.json();
      setGrants(data.items ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchGrants();
  }, [fetchGrants, refreshTrigger]);

  const handleRevoke = async (grantId: string) => {
    setRevoking(grantId);
    try {
      const res = await fetchApi(apiPath.tenantBreakglassById(grantId), {
        method: "DELETE",
      });
      if (res.ok) {
        toast.success(t("revokeSuccess"));
        fetchGrants();
      } else {
        const data = await res.json().catch(() => null);
        toast.error(data?.error ?? "Error");
      }
    } finally {
      setRevoking(null);
    }
  };

  const statusLabel = (status: string) => {
    if (status === GRANT_STATUS.ACTIVE) return t("statusActive");
    if (status === GRANT_STATUS.EXPIRED) return t("statusExpired");
    if (status === GRANT_STATUS.REVOKED) return t("statusRevoked");
    return status;
  };

  const activeGrants = grants.filter((g) => g.status === GRANT_STATUS.ACTIVE);
  const historyGrants = grants.filter((g) => g.status !== GRANT_STATUS.ACTIVE);

  const viewingGrant = viewingLogGrantId
    ? grants.find((g) => g.id === viewingLogGrantId)
    : null;

  if (viewingGrant) {
    return (
      <BreakGlassPersonalLogViewer
        grantId={viewingGrant.id}
        targetUserName={formatUserName(viewingGrant.targetUser)}
        expiresAt={viewingGrant.expiresAt}
        onBack={() => setViewingLogGrantId(null)}
      />
    );
  }

  if (loading) {
    return (
      <div className="flex justify-center py-6">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const renderGrantRow = (grant: BreakGlassGrant) => (
    <div
      key={grant.id}
      className="px-4 py-3 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4"
    >
      <div className="flex-1 min-w-0 space-y-0.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{formatUserName(grant.targetUser)}</span>
          <Badge variant={STATUS_VARIANT[grant.status] ?? "outline"} className="text-xs">
            {statusLabel(grant.status)}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground truncate">
          {t("requester")}: {formatUserName(grant.requester)}
        </p>
        <p className="text-xs text-muted-foreground truncate" title={grant.reason}>
          {grant.reason.length > 80 ? `${grant.reason.slice(0, 80)}…` : grant.reason}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("createdAt")}: {formatDateTime(grant.createdAt, locale)} /{" "}
          {t("expiresAt")}: {formatDateTime(grant.expiresAt, locale)}
        </p>
      </div>
      {grant.status === GRANT_STATUS.ACTIVE && (
        <div className="flex gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setViewingLogGrantId(grant.id)}
          >
            <Eye className="h-4 w-4 mr-1" />
            {t("viewLogs")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRevokeTargetId(grant.id)}
            disabled={revoking === grant.id}
          >
            {revoking === grant.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <X className="h-4 w-4 mr-1" />
            )}
            {t("revoke")}
          </Button>
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className="space-y-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("activeGrants")}</p>
          {activeGrants.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noActiveGrants")}</p>
          ) : (
            <Card className="rounded-xl border bg-card/80 divide-y">
              {activeGrants.map(renderGrantRow)}
            </Card>
          )}
        </div>

        {historyGrants.length > 0 && (
          <div className="space-y-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs gap-1"
              onClick={() => setShowHistory((v) => !v)}
            >
              {showHistory ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" />
                  {t("hideHistory")}
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" />
                  {t("showHistory")}
                </>
              )}
            </Button>
            {showHistory && (
              <Card className="rounded-xl border bg-card/80 divide-y">
                {historyGrants.map(renderGrantRow)}
              </Card>
            )}
          </div>
        )}

        {grants.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("noGrants")}</p>
        )}
      </div>

      <AlertDialog open={!!revokeTargetId} onOpenChange={(open) => { if (!open) setRevokeTargetId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revoke")}</AlertDialogTitle>
            <AlertDialogDescription>{t("revokeConfirm")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revokeTargetId) handleRevoke(revokeTargetId);
                setRevokeTargetId(null);
              }}
            >
              {t("revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
