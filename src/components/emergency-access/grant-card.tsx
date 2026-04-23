"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Copy, ShieldOff, ShieldAlert, ShieldCheck, ShieldX, KeyRound, Lock, Loader2, Info } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import { VAULT_STATUS, EA_STATUS, apiPath } from "@/lib/constants";
import type { EaStatusValue } from "@/lib/constants";
import {
  generateECDHKeyPair,
  exportPublicKey,
  exportPrivateKey,
  encryptPrivateKey,
} from "@/lib/crypto/crypto-emergency";
import { eaErrorToI18nKey } from "@/lib/api-error-codes";
import { fetchApi, appUrl } from "@/lib/url-helpers";

interface Grant {
  id: string;
  ownerId: string;
  granteeId: string | null;
  granteeEmail: string;
  status: EaStatusValue;
  waitDays: number;
  token?: string;
  requestedAt: string | null;
  waitExpiresAt: string | null;
  createdAt: string;
  owner: { id: string; name: string | null; email: string | null };
  grantee: { id: string; name: string | null; email: string | null } | null;
}

interface GrantCardProps {
  grant: Grant;
  currentUserId: string;
  onRefresh: () => void;
}

const statusColors: Record<EaStatusValue, string> = {
  [EA_STATUS.PENDING]: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  [EA_STATUS.ACCEPTED]: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  [EA_STATUS.IDLE]: "bg-green-500/10 text-green-700 dark:text-green-400",
  [EA_STATUS.STALE]: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  [EA_STATUS.REQUESTED]: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
  [EA_STATUS.ACTIVATED]: "bg-red-500/10 text-red-700 dark:text-red-400",
  [EA_STATUS.REVOKED]: "bg-gray-500/10 text-gray-500",
  [EA_STATUS.REJECTED]: "bg-gray-500/10 text-gray-500",
};

// Step indicator: maps status to which step (0-based) is active
// Flow: Invite(0) → Accept(1) → Ready(2) → Request(3) → Active(4)
function getActiveStep(status: EaStatusValue): number {
  switch (status) {
    case EA_STATUS.PENDING:
      return 0;
    case EA_STATUS.ACCEPTED:
      return 1;
    case EA_STATUS.IDLE:
    case EA_STATUS.STALE:
      return 2;
    case EA_STATUS.REQUESTED:
      return 3;
    case EA_STATUS.ACTIVATED:
      return 4;
    case EA_STATUS.REVOKED:
    case EA_STATUS.REJECTED:
      return -1; // terminal
    default:
      return 0;
  }
}

function StepIndicator({ status, t }: { status: EaStatusValue; t: ReturnType<typeof useTranslations<"EmergencyAccess">> }) {
  const activeStep = getActiveStep(status);
  const isTerminal = activeStep === -1;
  const labels = [t("stepInvite"), t("stepAccept"), t("stepReady"), t("stepRequest"), t("stepActive")];

  return (
    <div className="flex items-center gap-0.5 shrink-0">
      {labels.map((label, i) => {
        const isComplete = !isTerminal && i < activeStep;
        const isCurrent = !isTerminal && i === activeStep;
        return (
          <div key={i} className="flex items-center gap-0.5">
            {i > 0 && (
              <div
                className={`h-px w-4 ${
                  isComplete || isCurrent ? "bg-primary" : "bg-muted-foreground/30"
                }`}
              />
            )}
            <div className="flex flex-col items-center">
              <div
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
                  isTerminal
                    ? "bg-muted-foreground/20 text-muted-foreground"
                    : isComplete
                      ? "bg-primary text-primary-foreground"
                      : isCurrent
                        ? "border-2 border-primary bg-background text-primary"
                        : "bg-muted-foreground/20 text-muted-foreground"
                }`}
              >
                {i + 1}
              </div>
              <span
                className={`mt-0.5 text-[10px] leading-tight ${
                  isCurrent ? "font-medium text-foreground" : "text-muted-foreground"
                }`}
              >
                {label}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function getTimeRemaining(waitExpiresAt: string): string {
  const diff = new Date(waitExpiresAt).getTime() - Date.now();
  if (diff <= 0) return "0";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

function getHintKey(status: EaStatusValue, isOwner: boolean): string {
  const prefix = isOwner ? "ownerHint" : "granteeHint";
  switch (status) {
    case EA_STATUS.PENDING:
      return `${prefix}Pending`;
    case EA_STATUS.ACCEPTED:
      return `${prefix}Accepted`;
    case EA_STATUS.IDLE:
      return `${prefix}Idle`;
    case EA_STATUS.STALE:
      return `${prefix}Stale`;
    case EA_STATUS.REQUESTED:
      return `${prefix}Requested`;
    case EA_STATUS.ACTIVATED:
      return `${prefix}Activated`;
    case EA_STATUS.REVOKED:
      return `${prefix}Revoked`;
    case EA_STATUS.REJECTED:
      return `${prefix}Rejected`;
    default:
      return `${prefix}Pending`;
  }
}

export function GrantCard({ grant, currentUserId, onRefresh }: GrantCardProps) {
  const t = useTranslations("EmergencyAccess");
  const router = useRouter();
  const { status: vaultStatus, encryptionKey } = useVault();
  const [accepting, setAccepting] = useState(false);
  const isOwner = grant.ownerId === currentUserId;
  // Client-side wait-period check. When true, the "Access Vault" button is shown
  // even though status is still REQUESTED. The server auto-promotes to ACTIVATED
  // when the vault endpoint is accessed (see /api/emergency-access/[id]/vault/route.ts).
  // Server-side authorization is the source of truth — this is a UI convenience only.
  const waitExpired =
    grant.status === EA_STATUS.REQUESTED &&
    !!grant.waitExpiresAt &&
    new Date(grant.waitExpiresAt) <= new Date();
  const displayName = isOwner
    ? grant.grantee?.name || grant.granteeEmail
    : grant.owner.name || grant.owner.email || "";

  const handleCopyLink = async () => {
    if (!grant.token) return;
    const url = appUrl(`/dashboard/emergency-access/invite/${grant.token}`);
    await navigator.clipboard.writeText(url);
    toast.success(t("copyLink"));
  };

  const handleRevoke = async (permanent: boolean) => {
    try {
      const res = await fetchApi(apiPath.emergencyGrantAction(grant.id, "revoke"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permanent }),
      });
      if (res.ok) {
        toast.success(permanent ? t("revoked") : t("requestRejected"));
        onRefresh();
      } else {
        const data = await res.json().catch(() => null);
        toast.error(translateApiError(data?.error));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleApprove = async () => {
    try {
      const res = await fetchApi(apiPath.emergencyGrantAction(grant.id, "approve"), {
        method: "POST",
      });
      if (res.ok) {
        toast.success(t("approved"));
        onRefresh();
      } else {
        const data = await res.json().catch(() => null);
        toast.error(translateApiError(data?.error));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleRequest = async () => {
    try {
      const res = await fetchApi(apiPath.emergencyGrantAction(grant.id, "request"), {
        method: "POST",
      });
      if (res.ok) {
        toast.success(t("requested"));
        onRefresh();
      } else {
        const data = await res.json().catch(() => null);
        toast.error(translateApiError(data?.error));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const handleAcceptGrant = async () => {
    if (!encryptionKey) {
      toast.error(t("vaultUnlockRequired"));
      return;
    }
    setAccepting(true);
    try {
      const keyPair = await generateECDHKeyPair();
      const publicKeyJwk = await exportPublicKey(keyPair.publicKey);
      const privateKeyBytes = await exportPrivateKey(keyPair.privateKey);
      const encryptedPrivKey = await encryptPrivateKey(privateKeyBytes, encryptionKey);

      const res = await fetchApi(apiPath.emergencyGrantAction(grant.id, "accept"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          granteePublicKey: publicKeyJwk,
          encryptedPrivateKey: {
            ciphertext: encryptedPrivKey.ciphertext,
            iv: encryptedPrivKey.iv,
            authTag: encryptedPrivKey.authTag,
          },
        }),
      });

      if (res.ok) {
        toast.success(t("accepted"));
        onRefresh();
      } else {
        const data = await res.json().catch(() => null);
        toast.error(translateApiError(data?.error));
      }
    } catch {
      toast.error(t("networkError"));
    } finally {
      setAccepting(false);
    }
  };

  const handleDeclineGrant = async () => {
    try {
      const res = await fetchApi(apiPath.emergencyGrantAction(grant.id, "decline"), {
        method: "POST",
      });
      if (res.ok) {
        toast.success(t("declined"));
        onRefresh();
      } else {
        const data = await res.json().catch(() => null);
        toast.error(translateApiError(data?.error));
      }
    } catch {
      toast.error(t("networkError"));
    }
  };

  const translateApiError = (error: unknown) => t(eaErrorToI18nKey(error));

  const vaultLocked = vaultStatus !== VAULT_STATUS.UNLOCKED;

  const hintKey = getHintKey(grant.status, isOwner);
  const hintParams = grant.status === EA_STATUS.REQUESTED && !isOwner
    ? { days: String(grant.waitDays) }
    : undefined;

  return (
    <Card>
      <CardContent className="space-y-3 py-3">
        {/* Header row: name + badge + actions */}
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{displayName}</span>
              <Badge variant="outline" className={statusColors[grant.status]}>
                {t(`status${grant.status.charAt(0) + grant.status.slice(1).toLowerCase()}`)}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("waitDays")}: {grant.waitDays}{t("waitDaysUnit")}
              {grant.status === EA_STATUS.REQUESTED && grant.waitExpiresAt && (
                <> &middot; {t("waitingPeriod", { remaining: getTimeRemaining(grant.waitExpiresAt) })}</>
              )}
            </p>
          </div>

          <div className="flex items-center gap-1">
            {/* Owner actions */}
            {isOwner && grant.status === EA_STATUS.PENDING && grant.token && (
              <Button variant="ghost" size="icon" onClick={handleCopyLink} title={t("copyLink")}>
                <Copy className="h-4 w-4" />
              </Button>
            )}

            {isOwner && grant.status === EA_STATUS.REQUESTED && (
              <>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm">
                      <ShieldCheck className="mr-1 h-4 w-4" />
                      {t("approveRequest")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("approveRequest")}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("approveRequestConfirm", { name: displayName })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={handleApprove}>
                        {t("approveRequest")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm">
                      <ShieldAlert className="mr-1 h-4 w-4" />
                      {t("rejectRequest")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("rejectRequest")}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("rejectRequestConfirm", { name: displayName })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleRevoke(false)}>
                        {t("rejectRequest")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}

            {isOwner && !([EA_STATUS.REVOKED, EA_STATUS.REJECTED] as EaStatusValue[]).includes(grant.status) && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="icon" title={t("revoke")}>
                    <ShieldOff className="h-4 w-4" />
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("revoke")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("revokeConfirm", { name: displayName })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={() => handleRevoke(true)}>
                      {t("revoke")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}

            {/* Grantee actions */}
            {!isOwner && grant.status === EA_STATUS.PENDING && (
              <div className="flex items-center gap-1">
                {vaultLocked && (
                  <span title={t("vaultUnlockRequired")}>
                    <Lock className="h-4 w-4 text-yellow-500" />
                  </span>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleAcceptGrant}
                  disabled={accepting || vaultLocked}
                >
                  {accepting ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="mr-1 h-4 w-4" />
                  )}
                  {t("accept")}
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" disabled={accepting}>
                      <ShieldX className="mr-1 h-4 w-4" />
                      {t("decline")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("decline")}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("declineConfirm", { name: displayName })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={handleDeclineGrant}>
                        {t("decline")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}

            {!isOwner && grant.status === EA_STATUS.IDLE && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline" size="sm">
                    <ShieldAlert className="mr-1 h-4 w-4" />
                    {t("requestAccess")}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t("requestAccess")}</AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("requestAccessConfirm", {
                        name: displayName,
                        days: String(grant.waitDays),
                      })}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                    <AlertDialogAction onClick={handleRequest}>
                      {t("requestAccess")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}

            {!isOwner && (grant.status === EA_STATUS.ACTIVATED || waitExpired) && (
              <Button
                size="sm"
                onClick={() => router.push(`/dashboard/emergency-access/${grant.id}/vault`)}
              >
                <KeyRound className="mr-1 h-4 w-4" />
                {t("accessVault")}
              </Button>
            )}
          </div>
        </div>

        {/* Step indicator + contextual hint */}
        <div className="flex items-start gap-3 rounded-lg bg-muted/50 px-3 py-2">
          <StepIndicator status={grant.status} t={t} />
          <div className="flex-1 min-w-0 flex items-start gap-1.5">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              {t(hintKey, hintParams)}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
