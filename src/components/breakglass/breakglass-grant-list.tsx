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
import { Loader2, Eye, X } from "lucide-react";
import { InactiveItemsSection } from "@/components/settings/shared/inactive-items-section";
import { apiPath, GRANT_STATUS } from "@/lib/constants";
import { apiErrorToI18nKey, API_ERROR } from "@/lib/http/api-error-codes";
import { readApiErrorBody } from "@/lib/http/read-api-error-body";
import type { GrantStatus } from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { RecentSessionRequiredDialog } from "@/components/auth/recent-session-required-dialog";
import { PasskeyReauthDialog } from "@/components/auth/passkey-reauth-dialog";
import { useInlineReauth } from "@/hooks/auth/use-inline-reauth";
import { DISPLAY_REASON_PREVIEW } from "@/lib/validations/common";
import { formatDateTime } from "@/lib/format/format-datetime";
import { formatUserName } from "@/lib/format/format-user";
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
  const tApi = useTranslations("ApiErrors");
  const locale = useLocale();
  const [grants, setGrants] = useState<BreakGlassGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const [viewingLogGrantId, setViewingLogGrantId] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeTargetId, setRevokeTargetId] = useState<string | null>(null);

  // Inline step-up reauth — revoking a break-glass grant is server-side
  // step-up-gated. The retry target remembers which grant was being revoked so
  // the post-reauth retry replays the same revoke.
  const [reauthRevokeId, setReauthRevokeId] = useState<string | null>(null);
  const inlineReauth = useInlineReauth(async () => {
    const id = reauthRevokeId;
    setReauthRevokeId(null);
    if (id) await handleRevoke(id);
  });

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
      } else if (res.status === 403) {
        const body = await readApiErrorBody(res);
        if (body?.error === API_ERROR.SESSION_STEP_UP_REQUIRED) {
          setReauthRevokeId(grantId);
          await inlineReauth.triggerOnStaleError();
        } else {
          toast.error(body?.error ? tApi(apiErrorToI18nKey(body.error)) : tApi("unknownError"));
        }
      } else {
        const data = await res.json().catch(() => null);
        const code = typeof data?.error === "string" ? data.error : null;
        toast.error(code ? tApi(apiErrorToI18nKey(code)) : tApi("unknownError"));
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
          {grant.reason.length > DISPLAY_REASON_PREVIEW ? `${grant.reason.slice(0, DISPLAY_REASON_PREVIEW)}…` : grant.reason}
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
          {activeGrants.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noActiveGrants")}</p>
          ) : (
            <Card className="rounded-xl border bg-card/80 divide-y">
              {activeGrants.map(renderGrantRow)}
            </Card>
          )}
        </div>

        {historyGrants.length > 0 && (
          <InactiveItemsSection
            open={showHistory}
            onOpenChange={setShowHistory}
            triggerLabel={`${t("showHistory")} (${historyGrants.length})`}
          >
            <Card className="rounded-xl border bg-card/80 divide-y">
              {historyGrants.map(renderGrantRow)}
            </Card>
          </InactiveItemsSection>
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

      <RecentSessionRequiredDialog
        {...inlineReauth.recentSessionDialogProps}
        cancelLabel={tc("cancel")}
      />
      <PasskeyReauthDialog
        {...inlineReauth.reauthDialogProps}
        onOpenChange={(open) => {
          inlineReauth.reauthDialogProps.onOpenChange(open);
          if (!open) setReauthRevokeId(null);
        }}
        cancelLabel={tc("cancel")}
      />
    </>
  );
}
