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
import { Copy, ShieldOff, ShieldAlert, ShieldCheck, ShieldX, KeyRound, Lock, Loader2 } from "lucide-react";
import { useRouter } from "@/i18n/navigation";
import { useVault } from "@/lib/vault-context";
import {
  generateECDHKeyPair,
  exportPublicKey,
  exportPrivateKey,
  encryptPrivateKey,
} from "@/lib/crypto-emergency";
import { eaErrorToI18nKey } from "@/lib/api-error-codes";

type GrantStatus = "PENDING" | "ACCEPTED" | "IDLE" | "STALE" | "REQUESTED" | "ACTIVATED" | "REVOKED" | "REJECTED";

interface Grant {
  id: string;
  ownerId: string;
  granteeId: string | null;
  granteeEmail: string;
  status: GrantStatus;
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

const statusColors: Record<GrantStatus, string> = {
  PENDING: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400",
  ACCEPTED: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  IDLE: "bg-green-500/10 text-green-700 dark:text-green-400",
  STALE: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  REQUESTED: "bg-orange-500/10 text-orange-700 dark:text-orange-400",
  ACTIVATED: "bg-red-500/10 text-red-700 dark:text-red-400",
  REVOKED: "bg-gray-500/10 text-gray-500",
  REJECTED: "bg-gray-500/10 text-gray-500",
};

function getTimeRemaining(waitExpiresAt: string): string {
  const diff = new Date(waitExpiresAt).getTime() - Date.now();
  if (diff <= 0) return "0";
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  if (days > 0) return `${days}d ${hours}h`;
  return `${hours}h`;
}

export function GrantCard({ grant, currentUserId, onRefresh }: GrantCardProps) {
  const t = useTranslations("EmergencyAccess");
  const router = useRouter();
  const { status: vaultStatus, encryptionKey } = useVault();
  const [accepting, setAccepting] = useState(false);
  const isOwner = grant.ownerId === currentUserId;
  const waitExpired =
    grant.status === "REQUESTED" &&
    !!grant.waitExpiresAt &&
    new Date(grant.waitExpiresAt) <= new Date();
  const displayName = isOwner
    ? grant.grantee?.name || grant.granteeEmail
    : grant.owner.name || grant.owner.email || "";

  const handleCopyLink = async () => {
    if (!grant.token) return;
    const url = `${window.location.origin}/dashboard/emergency-access/invite/${grant.token}`;
    await navigator.clipboard.writeText(url);
    toast.success(t("copyLink"));
  };

  const handleRevoke = async (permanent: boolean) => {
    try {
      const res = await fetch(`/api/emergency-access/${grant.id}/revoke`, {
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
      const res = await fetch(`/api/emergency-access/${grant.id}/approve`, {
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
      const res = await fetch(`/api/emergency-access/${grant.id}/request`, {
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

      const res = await fetch(`/api/emergency-access/${grant.id}/accept`, {
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
      const res = await fetch(`/api/emergency-access/${grant.id}/decline`, {
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

  const vaultLocked = vaultStatus !== "unlocked";

  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 py-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{displayName}</span>
            <Badge variant="outline" className={statusColors[grant.status]}>
              {t(`status${grant.status.charAt(0) + grant.status.slice(1).toLowerCase()}`)}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("waitDays")}: {grant.waitDays}{t("waitDaysUnit")}
            {grant.status === "REQUESTED" && grant.waitExpiresAt && (
              <> &middot; {t("waitingPeriod", { remaining: getTimeRemaining(grant.waitExpiresAt) })}</>
            )}
          </p>
        </div>

        <div className="flex items-center gap-1">
          {/* Owner actions */}
          {isOwner && grant.status === "PENDING" && grant.token && (
            <Button variant="ghost" size="icon" onClick={handleCopyLink} title={t("copyLink")}>
              <Copy className="h-4 w-4" />
            </Button>
          )}

          {isOwner && grant.status === "REQUESTED" && (
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

          {isOwner && !["REVOKED", "REJECTED"].includes(grant.status) && (
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
          {!isOwner && grant.status === "PENDING" && (
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

          {!isOwner && grant.status === "IDLE" && (
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

          {!isOwner && (grant.status === "ACTIVATED" || waitExpired) && (
            <Button
              size="sm"
              onClick={() => router.push(`/dashboard/emergency-access/${grant.id}/vault`)}
            >
              <KeyRound className="mr-1 h-4 w-4" />
              {t("accessVault")}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
