"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Plug, Loader2, Unplug, Search } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { API_PATH, apiPath } from "@/lib/constants/api-path";
import { fetchApi } from "@/lib/url-helpers";
import { formatDateTime } from "@/lib/format/format-datetime";
import { ScopeBadges } from "@/components/settings/scope-badges";

interface McpClientConnection {
  id: string;
  clientId: string;
  name: string;
  isDcr: boolean;
  allowedScopes: string;
  clientCreatedAt: string;
  connection: {
    tokenId: string;
    scope: string;
    createdAt: string;
    expiresAt: string;
    lastUsedAt: string | null;
  } | null;
}

export function McpConnectionsCard() {
  const t = useTranslations("MachineIdentity.mcpConnections");
  const locale = useLocale();
  const [clients, setClients] = useState<McpClientConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [revokeAllOpen, setRevokeAllOpen] = useState(false);
  const [revokingAll, setRevokingAll] = useState(false);

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

  const handleRevokeAll = async () => {
    setRevokingAll(true);
    try {
      const res = await fetchApi(API_PATH.USER_MCP_TOKENS, {
        method: "DELETE",
      });
      if (res.ok) {
        const data = await res.json();
        setClients((prev) =>
          prev.map((c) => ({ ...c, connection: null })),
        );
        toast.success(t("revokeAllSuccess", { count: data.revokedCount }));
      } else {
        toast.error(t("revokeAllError"));
      }
    } catch {
      toast.error(t("revokeAllError"));
    } finally {
      setRevokingAll(false);
      setRevokeAllOpen(false);
    }
  };

  const filteredClients = searchQuery
    ? clients.filter(
        (c) =>
          c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
          c.clientId.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : clients;

  const hasConnections = clients.some((c) => c.connection !== null);

  return (
    <Card>
      <SectionCardHeader
        icon={Plug}
        title={t("title")}
        description={t("description")}
        action={
          hasConnections ? (
            <AlertDialog open={revokeAllOpen} onOpenChange={setRevokeAllOpen}>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm">
                  {t("revokeAll")}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("revokeAllTitle")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("revokeAllDescription")}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                  <AlertDialogAction onClick={handleRevokeAll} disabled={revokingAll}>
                    {revokingAll && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
                    {t("revokeAll")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : undefined
        }
      />
      <CardContent>
        {!loading && clients.length > 0 && (
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder={t("searchPlaceholder")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>
        )}
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
            {filteredClients.map((client) => (
              <div
                key={client.id}
                className="flex items-start justify-between border rounded-md p-3"
              >
                <div className="space-y-1.5 min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate max-w-[12rem]">
                      {client.name}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono truncate max-w-[10rem]" title={client.clientId}>
                      {client.clientId.length > 16
                        ? `${client.clientId.slice(0, 16)}…`
                        : client.clientId}
                    </span>
                    {client.isDcr && (
                      <Badge variant="outline" className="text-xs shrink-0">
                        DCR
                      </Badge>
                    )}
                    <Badge
                      variant={client.connection ? "default" : "secondary"}
                      className="text-xs shrink-0"
                    >
                      {client.connection ? t("connected") : t("notConnected")}
                    </Badge>
                  </div>
                  <ScopeBadges
                    scopes={client.connection?.scope ?? client.allowedScopes}
                    separator={/[\s,]+/}
                  />
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span>
                      {t("registeredAt", { date: formatDateTime(client.clientCreatedAt, locale) })}
                    </span>
                  </div>
                  {client.connection && (
                    <>
                      <div className="flex gap-4 text-xs text-muted-foreground">
                        <span>
                          {t("created")}:{" "}
                          {formatDateTime(client.connection.createdAt, locale)}
                        </span>
                        <span>
                          {t("expires")}:{" "}
                          {formatDateTime(client.connection.expiresAt, locale)}
                        </span>
                        <span>
                          {client.connection.lastUsedAt
                            ? t("lastUsed", { date: formatDateTime(client.connection.lastUsedAt, locale) })
                            : t("neverUsed")}
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
            {filteredClients.length === 0 && searchQuery && (
              <p className="text-sm text-center text-muted-foreground py-4">
                {t("noMatchingConnections")}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
