"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Fingerprint, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { fetchApi } from "@/lib/url-helpers";
import { apiPath } from "@/lib/constants";
import { formatDateTime } from "@/lib/format/format-datetime";
import { handleStepUpError } from "@/lib/http/handle-step-up-error";
import { useInlineReauth } from "@/hooks/auth/use-inline-reauth";
import { RecentSessionRequiredDialog } from "@/components/auth/recent-session-required-dialog";
import { PasskeyReauthDialog } from "@/components/auth/passkey-reauth-dialog";

interface MemberPasskey {
  id: string;
  nickname: string | null;
  deviceType: string;
  registeredDevice: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

interface TenantMemberPasskeysDialogProps {
  userId: string;
  memberName: string;
  disabled?: boolean;
}

// A tenant admin's view of a member's passkeys, to revoke a compromised one
// (#974). Revoking also signs the member out of this tenant.
export function TenantMemberPasskeysDialog({ userId, memberName, disabled }: TenantMemberPasskeysDialogProps) {
  const t = useTranslations("TenantAdmin");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [passkeys, setPasskeys] = useState<MemberPasskey[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [target, setTarget] = useState<MemberPasskey | null>(null);
  const [revoking, setRevoking] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await fetchApi(apiPath.tenantMemberPasskeys(userId));
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { passkeys: MemberPasskey[] };
      setPasskeys(body.passkeys);
    } catch {
      setLoadFailed(true);
    }
  }, [userId]);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      setPasskeys(null);
      void load();
    }
  };

  // Inline step-up reauth, as the clear-lockout button: the confirm dialog
  // stays open through a stale session and the hook re-runs the revoke.
  const revokeRetryRef = useRef<() => Promise<void>>(async () => {});
  const inlineReauth = useInlineReauth(() => revokeRetryRef.current());

  const handleRevoke = async () => {
    if (!target) return;
    setRevoking(true);
    try {
      // @stepup id:tenant-member-passkey-delete
      const res = await fetchApi(apiPath.tenantMemberPasskeyById(userId, target.id), { method: "DELETE" });
      if (res.ok) {
        toast.success(t("revokePasskeySuccess"));
        setTarget(null);
        await load();
        return;
      }
      if (await handleStepUpError(res, inlineReauth.triggerOnStaleError)) return;
      toast.error(t("revokePasskeyFailed"));
    } catch {
      toast.error(t("revokePasskeyFailed"));
    } finally {
      setRevoking(false);
    }
  };

  useEffect(() => {
    revokeRetryRef.current = () => handleRevoke();
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={disabled} title={t("memberPasskeysTitle")}>
          <Fingerprint className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("memberPasskeysTitle")}</DialogTitle>
          <DialogDescription>{t("memberPasskeysDescription", { name: memberName })}</DialogDescription>
        </DialogHeader>
        {loadFailed ? (
          <p className="text-sm text-destructive">{t("memberPasskeysLoadFailed")}</p>
        ) : passkeys === null ? (
          <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" />
        ) : passkeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("memberPasskeysEmpty")}</p>
        ) : (
          <div className="space-y-2">
            {passkeys.map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.nickname ?? p.registeredDevice ?? p.deviceType}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("memberPasskeyLastUsed", {
                      date: p.lastUsedAt ? formatDateTime(p.lastUsedAt, locale) : t("memberPasskeyNeverUsed"),
                    })}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setTarget(p)}>
                  {t("revokePasskey")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>

      <AlertDialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revokePasskeyTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("revokePasskeyDescription", { name: memberName })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <Button variant="destructive" onClick={handleRevoke} disabled={revoking}>
              {revoking && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("revokePasskey")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <RecentSessionRequiredDialog {...inlineReauth.recentSessionDialogProps} cancelLabel={t("cancel")} />
      <PasskeyReauthDialog {...inlineReauth.reauthDialogProps} cancelLabel={t("cancel")} />
    </Dialog>
  );
}
