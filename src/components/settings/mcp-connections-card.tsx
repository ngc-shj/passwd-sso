"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Plug, Loader2, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { API_PATH, apiPath } from "@/lib/constants/api-path";
import { fetchApi } from "@/lib/url-helpers";
import { formatDateTime } from "@/lib/format-datetime";
import { ScopeBadges } from "@/components/settings/scope-badges";

interface McpClientConnection {
  id: string;
  clientId: string;
  name: string;
  isDcr: boolean;
  connection: {
    tokenId: string;
    scope: string;
    createdAt: string;
    expiresAt: string;
  } | null;
}

export function McpConnectionsCard() {
  const t = useTranslations("MachineIdentity.mcpConnections");
  const locale = useLocale();
  const [clients, setClients] = useState<McpClientConnection[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchClients = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.USER_MCP_TOKENS);
      if (res.ok) {
        const data = await res.json();
        setClients(data.clients);
      }
    } catch {
      // Graceful failure — show empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchClients();
  }, [fetchClients]);

  const handleRevoke = async (tokenId: string, clientDbId: string) => {
    try {
      const res = await fetchApi(apiPath.userMcpTokenById(tokenId), {
        method: "DELETE",
      });
      if (res.ok) {
        setClients((prev) =>
          prev.map((c) =>
            c.id === clientDbId ? { ...c, connection: null } : c,
          ),
        );
        toast.success(t("revokeSuccess"));
      } else {
        toast.error(t("revokeError"));
      }
    } catch {
      toast.error(t("revokeError"));
    }
  };

  return (
    <Card>
      <SectionCardHeader
        icon={Plug}
        title={t("title")}
        description={t("description")}
      />
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : clients.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Unplug className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm font-medium">{t("noClients")}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t("noClientsDescription")}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {clients.map((client) => (
              <div
                key={client.id}
                className="flex items-start justify-between border rounded-md p-3"
              >
                <div className="space-y-1.5 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {client.name}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      {client.clientId}
                    </span>
                    {client.isDcr && (
                      <Badge variant="outline" className="text-xs">
                        DCR
                      </Badge>
                    )}
                    <Badge
                      variant={client.connection ? "default" : "secondary"}
                      className="text-xs"
                    >
                      {client.connection ? t("connected") : t("notConnected")}
                    </Badge>
                  </div>
                  {client.connection && (
                    <>
                      <ScopeBadges scopes={client.connection.scope} separator={/[\s,]+/} />
                      <div className="flex gap-4 text-xs text-muted-foreground">
                        <span>
                          {t("created")}:{" "}
                          {formatDateTime(client.connection.createdAt, locale)}
                        </span>
                        <span>
                          {t("expires")}:{" "}
                          {formatDateTime(client.connection.expiresAt, locale)}
                        </span>
                      </div>
                    </>
                  )}
                </div>
                {client.connection && (
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 ml-2"
                      >
                        {t("revoke")}
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("revokeTitle")}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("revokeDescription")}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() =>
                            handleRevoke(client.connection!.tokenId, client.id)
                          }
                        >
                          {t("revoke")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
