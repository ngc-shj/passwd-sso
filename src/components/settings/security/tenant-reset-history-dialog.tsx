"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2, History, X, Check } from "lucide-react";
import { toast } from "sonner";
import { fetchApi } from "@/lib/url-helpers";
import { apiPath } from "@/lib/constants";
import { formatDateTime } from "@/lib/format/format-datetime";
import {
  RESET_STATUS,
  STATUS_KEY_MAP,
  type ResetStatus,
} from "@/lib/vault/admin-reset-status";
import {
  APPROVE_ELIGIBILITY,
  type ApproveEligibility,
} from "@/lib/vault/admin-reset-eligibility";
import { VAULT_CONFIRMATION_PHRASE } from "@/lib/constants/vault";
import { API_ERROR, apiErrorToI18nKey } from "@/lib/http/api-error-codes";

interface ResetActor {
  id: string;
  name: string | null;
  email: string | null;
}

interface ResetRecord {
  id: string;
  status: ResetStatus;
  createdAt: string;
  expiresAt: string;
  approvedAt: string | null;
  executedAt: string | null;
  revokedAt: string | null;
  initiatedBy: ResetActor;
  approvedBy: ResetActor | null;
  targetEmailAtInitiate: string;
  approveEligibility: ApproveEligibility;
}

interface TenantResetHistoryDialogProps {
  userId: string;
  memberName: string;
  pendingResets: number;
  onRevoke?: () => void;
}

const STATUS_VARIANT: Record<
  ResetStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  [RESET_STATUS.PENDING_APPROVAL]: "default",
  [RESET_STATUS.APPROVED]: "default",
  [RESET_STATUS.EXECUTED]: "destructive",
  [RESET_STATUS.REVOKED]: "secondary",
  [RESET_STATUS.EXPIRED]: "outline",
};

const APPROVE_PHRASE = VAULT_CONFIRMATION_PHRASE.APPROVE;

export function TenantResetHistoryDialog({
  userId,
  memberName,
  pendingResets,
  onRevoke,
}: TenantResetHistoryDialogProps) {
  const t = useTranslations("TenantAdmin");
  const tApi = useTranslations("ApiErrors");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [records, setRecords] = useState<ResetRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [approveTarget, setApproveTarget] = useState<ResetRecord | null>(null);
  const [approveInput, setApproveInput] = useState("");
  const [approveError, setApproveError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

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
    if (!open) return;
    fetchHistory();
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

  const openApproveDialog = (record: ResetRecord) => {
    setApproveTarget(record);
    setApproveInput("");
    setApproveError(null);
  };

  const closeApproveDialog = () => {
    setApproveTarget(null);
    setApproveInput("");
    setApproveError(null);
  };

  const handleApproveSubmit = async () => {
    if (!approveTarget) return;
    // R23 — commit-time validation only.
    if (approveInput !== APPROVE_PHRASE) {
      setApproveError(t("approveConfirmationMismatch"));
      return;
    }
    setApproving(true);
    setApproveError(null);
    try {
      const res = await fetchApi(
        `${apiPath.tenantMemberResetVault(userId)}/${approveTarget.id}/approve`,
        { method: "POST", headers: { "Content-Type": "application/json" } },
      );
      if (res.ok) {
        toast.success(t("approveSuccess"));
        closeApproveDialog();
        await fetchHistory();
        onRevoke?.();
      } else if (res.status === 409) {
        toast.error(t("approveConflict"));
        closeApproveDialog();
        await fetchHistory();
      } else if (res.status === 403) {
        // Surface specific reason when server returns it
        // (e.g. FORBIDDEN_INSUFFICIENT_ROLE — actor's role is not strictly
        // above the target's). Falls back to the generic message for plain
        // FORBIDDEN.
        const body = await res.json().catch(() => ({}));
        toast.error(tApi(apiErrorToI18nKey(body.error ?? API_ERROR.FORBIDDEN)));
      } else {
        toast.error(t("approveFailed"));
      }
    } catch {
      toast.error(t("approveFailed"));
    } finally {
      setApproving(false);
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
            {records.map((r) => {
              const status = r.status;
              const isInitiator =
                r.approveEligibility === APPROVE_ELIGIBILITY.INITIATOR;
              // Hide (vs. disable) for INSUFFICIENT_ROLE — server would 403 anyway.
              const showApprove =
                status === RESET_STATUS.PENDING_APPROVAL &&
                r.approveEligibility !==
                  APPROVE_ELIGIBILITY.INSUFFICIENT_ROLE;

              return (
                <div
                  key={r.id}
                  className="flex items-start justify-between rounded-md border p-3"
                >
                  <div className="space-y-1 text-sm">
                    <div className="flex items-center gap-2">
                      <Badge variant={STATUS_VARIANT[status]}>
                        {t(STATUS_KEY_MAP[status])}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDateTime(r.createdAt, locale)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("initiatedBy")}:{" "}
                      {r.initiatedBy.name ?? r.initiatedBy.email ?? "—"}
                    </p>
                    {r.approvedBy && (
                      <p className="text-xs text-muted-foreground">
                        {t("approvedBy")}:{" "}
                        {r.approvedBy.name ?? r.approvedBy.email ?? "—"}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {t("expiresAt")}: {formatDateTime(r.expiresAt, locale)}
                    </p>
                  </div>

                  <div className="flex flex-col gap-1">
                    {showApprove && (
                      <ApproveButton
                        disabled={isInitiator}
                        tooltip={
                          isInitiator
                            ? t("approveDisabledTooltip")
                            : null
                        }
                        label={t("approveButton")}
                        onClick={() => openApproveDialog(r)}
                      />
                    )}
                    {(status === RESET_STATUS.PENDING_APPROVAL ||
                      status === RESET_STATUS.APPROVED) && (
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
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>

      {/* Approve confirmation dialog */}
      <Dialog
        open={approveTarget !== null}
        onOpenChange={(v) => {
          if (!v) closeApproveDialog();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("approveDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("approveDialogBody", {
                targetEmail: approveTarget?.targetEmailAtInitiate ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <label htmlFor="approve-confirm" className="text-sm">
              {t("approveConfirmationLabel", { phrase: APPROVE_PHRASE })}
            </label>
            <Input
              id="approve-confirm"
              value={approveInput}
              onChange={(e) => {
                setApproveInput(e.target.value);
                // R23 — clear stale error on input change but do NOT
                // re-validate until the user clicks the submit button.
                if (approveError) setApproveError(null);
              }}
              placeholder={APPROVE_PHRASE}
              autoComplete="off"
            />
            {approveError && (
              <p className="text-xs text-destructive">{approveError}</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeApproveDialog}
              disabled={approving}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="default"
              onClick={handleApproveSubmit}
              disabled={approving || approveInput !== APPROVE_PHRASE}
            >
              {approving ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Check className="mr-2 h-4 w-4" />
              )}
              {t("approveButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}

function ApproveButton({
  disabled,
  tooltip,
  label,
  onClick,
}: {
  disabled: boolean;
  tooltip: string | null;
  label: string;
  onClick: () => void;
}) {
  const button = (
    <Button
      variant="ghost"
      size="sm"
      className="h-7 text-xs"
      onClick={onClick}
      disabled={disabled}
    >
      <Check className="mr-1 h-3.5 w-3.5" />
      {label}
    </Button>
  );

  if (!tooltip) return button;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* span wrapper so the tooltip still fires on a disabled button */}
          <span tabIndex={0}>{button}</span>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
