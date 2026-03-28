"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault-context";
import { API_PATH, apiPath } from "@/lib/constants/api-path";
import { fetchApi } from "@/lib/url-helpers";
import { VAULT_STATUS } from "@/lib/constants";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface DelegationSession {
  id: string;
  mcpTokenId: string;
  mcpClientName: string;
  mcpClientId: string;
  entryCount: number;
  note: string | null;
  expiresAt: string;
  createdAt: string;
}

export function DelegationManager() {
  const t = useTranslations("MachineIdentity.delegation");
  const { status } = useVault();
  const [sessions, setSessions] = useState<DelegationSession[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // Update "now" every 30s for TTL display
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const fetchSessions = useCallback(async (): Promise<DelegationSession[] | undefined> => {
    try {
      const res = await fetchApi(API_PATH.VAULT_DELEGATION);
      if (!res.ok) return undefined;
      const data = await res.json();
      return data.sessions ?? [];
    } catch {
      return undefined;
    }
  }, []);

  useEffect(() => {
    if (status !== VAULT_STATUS.UNLOCKED) return;
    let cancelled = false;
    const load = async () => {
      const data = await fetchSessions().catch(() => undefined);
      if (!cancelled && data) setSessions(data);
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, fetchSessions]);

  const handleRevoke = async (sessionId: string) => {
    try {
      const res = await fetchApi(apiPath.vaultDelegationById(sessionId), {
        method: "DELETE",
      });
      if (res.ok) {
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        toast.success(t("revoked"));
      }
    } catch {
      // Ignore
    }
  };

  const handleRevokeAll = async () => {
    try {
      const res = await fetchApi(API_PATH.VAULT_DELEGATION, { method: "DELETE" });
      if (res.ok) {
        setSessions([]);
        toast.success(t("revokedAll"));
      }
    } catch {
      // Ignore
    }
  };

  const getRemainingMinutes = (expiresAt: string) => {
    return Math.max(
      0,
      Math.floor((new Date(expiresAt).getTime() - now) / 60_000),
    );
  };

  if (status !== VAULT_STATUS.UNLOCKED) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          {sessions.length > 0 && (
            <Button variant="destructive" size="sm" onClick={handleRevokeAll}>
              {t("revokeAll")}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {sessions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noSessions")}</p>
        ) : (
          <div className="space-y-3">
            {sessions.map((session) => {
              const minutes = getRemainingMinutes(session.expiresAt);
              return (
                <div
                  key={session.id}
                  className="flex items-center justify-between rounded-lg border p-3"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {session.mcpClientName}
                      </span>
                      <Badge variant="secondary">
                        {t("entries", { count: session.entryCount })}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {minutes > 0
                        ? t("expiresIn", { minutes })
                        : t("expired")}
                      {session.note && ` · ${session.note}`}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleRevoke(session.id)}
                  >
                    {t("revoke")}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
