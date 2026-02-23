"use client";

import { useState, useEffect, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import Bowser from "bowser";
import { toast } from "sonner";
import { Monitor, Smartphone, Tablet, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
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
import { API_PATH, apiPath } from "@/lib/constants";
import { formatDateTime } from "@/lib/format-datetime";

interface SessionItem {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  isCurrent: boolean;
}

function parseDevice(ua: string | null) {
  if (!ua) return { browser: null, os: null, deviceType: null };
  const parsed = Bowser.parse(ua);
  const platformType = parsed.platform.type ?? "desktop";
  return {
    browser: parsed.browser.name ?? null,
    os: parsed.os.name
      ? `${parsed.os.name}${parsed.os.versionName ? ` ${parsed.os.versionName}` : ""}`
      : null,
    deviceType: platformType === "mobile" ? "mobile" : platformType === "tablet" ? "tablet" : "desktop",
  };
}

function DeviceIcon({ type }: { type: string | null }) {
  switch (type) {
    case "mobile":
      return <Smartphone className="h-5 w-5" />;
    case "tablet":
      return <Tablet className="h-5 w-5" />;
    default:
      return <Monitor className="h-5 w-5" />;
  }
}

export function SessionsCard() {
  const t = useTranslations("Sessions");
  const locale = useLocale();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [revokeTarget, setRevokeTarget] = useState<string | null>(null);
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch(API_PATH.SESSIONS);
      if (res.ok) {
        setSessions(await res.json());
      } else {
        toast.error(t("fetchError"));
      }
    } catch {
      toast.error(t("fetchError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  const handleRevoke = async (id: string) => {
    setRevoking(true);
    try {
      const res = await fetch(apiPath.sessionById(id), { method: "DELETE" });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== id));
        toast.success(t("revokeSuccess"));
      } else {
        toast.error(t("revokeError"));
      }
    } catch {
      toast.error(t("revokeError"));
    } finally {
      setRevoking(false);
      setRevokeTarget(null);
    }
  };

  const handleRevokeAll = async () => {
    setRevoking(true);
    try {
      const res = await fetch(API_PATH.SESSIONS, { method: "DELETE" });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.isCurrent));
        toast.success(t("revokeAllSuccess"));
      } else {
        toast.error(t("revokeError"));
      }
    } catch {
      toast.error(t("revokeError"));
    } finally {
      setRevoking(false);
      setRevokeAllOpen(false);
    }
  };

  const otherSessions = sessions.filter((s) => !s.isCurrent);

  if (loading) {
    return (
      <Card className="rounded-xl border bg-card/80 p-10">
        <div className="flex justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card className="rounded-xl border bg-card/80 divide-y">
        {sessions.map((session) => {
          const device = parseDevice(session.userAgent);
          return (
            <div
              key={session.id}
              className="px-4 py-3 flex items-center gap-3"
            >
              <div className="shrink-0 text-muted-foreground">
                <DeviceIcon type={device.deviceType} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium truncate">
                    {device.browser ?? t("unknownBrowser")}
                    {device.os ? ` — ${device.os}` : ""}
                  </p>
                  {session.isCurrent && (
                    <Badge variant="secondary" className="shrink-0 text-xs">
                      {t("current")}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("lastActive")}: {formatDateTime(session.lastActiveAt, locale)}
                  {session.ipAddress ? ` · ${session.ipAddress}` : ""}
                </p>
              </div>
              {!session.isCurrent && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={() => setRevokeTarget(session.id)}
                >
                  <X className="h-4 w-4" />
                  <span className="sr-only">{t("revoke")}</span>
                </Button>
              )}
            </div>
          );
        })}
      </Card>

      {otherSessions.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-2">
          {t("noOtherSessions")}
        </p>
      ) : (
        <div className="flex justify-end">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setRevokeAllOpen(true)}
          >
            {t("revokeAll")}
          </Button>
        </div>
      )}

      {/* Single session revoke dialog */}
      <AlertDialog
        open={!!revokeTarget}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revokeConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("revokeConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={revoking}
              onClick={() => revokeTarget && handleRevoke(revokeTarget)}
            >
              {revoking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke all dialog */}
      <AlertDialog open={revokeAllOpen} onOpenChange={setRevokeAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revokeAllConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("revokeAllConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>
              {t("cancel")}
            </AlertDialogCancel>
            <AlertDialogAction disabled={revoking} onClick={handleRevokeAll}>
              {revoking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {t("confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
