"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault/vault-context";
import { API_PATH, apiPath } from "@/lib/constants/auth/api-path";
import { fetchApi } from "@/lib/url-helpers";
import { VAULT_STATUS } from "@/lib/constants";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Handshake, Plus } from "lucide-react";
import { CreateDelegationDialog } from "@/components/settings/create-delegation-dialog";

interface AvailableToken {
  id: string;
  mcpClientName: string;
  mcpClientId: string;
  hasDelegationScope: boolean;
  expiresAt: string;
}

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
  const [availableTokens, setAvailableTokens] = useState<AvailableToken[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Update "now" every 30s for TTL display
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.VAULT_DELEGATION);
      if (!res.ok) return undefined;
      return await res.json() as { sessions: DelegationSession[]; availableTokens: AvailableToken[] };
    } catch {
      return undefined;
    }
  }, []);

  const reload = useCallback(async () => {
    const data = await fetchData();
    if (data) {
      setSessions(data.sessions ?? []);
      setAvailableTokens(data.availableTokens ?? []);
    }
  }, [fetchData]);

  useEffect(() => {
    if (status !== VAULT_STATUS.UNLOCKED) return;
    let cancelled = false;
    const load = async () => {
      const data = await fetchData();
      if (!cancelled && data) {
        setSessions(data.sessions ?? []);
        setAvailableTokens(data.availableTokens ?? []);
      }
    };
    load();
    const interval = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [status, fetchData]);

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
    <>
    <Card>
      <SectionCardHeader
        icon={Handshake}
        title={t("title")}
        description={t("description")}
        action={
          <div className="flex gap-2">
            {sessions.length > 0 && (
              <Button variant="destructive" size="sm" onClick={handleRevokeAll}>
                {t("revokeAll")}
              </Button>
            )}
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="mr-1 h-4 w-4" />
              {t("newDelegation")}
            </Button>
          </div>
        }
      />
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
                  className="flex items-center justify-between border rounded-md p-3"
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
    <CreateDelegationDialog
      open={dialogOpen}
      onOpenChange={setDialogOpen}
      availableTokens={availableTokens}
      onCreated={reload}
    />
    </>
  );
}
