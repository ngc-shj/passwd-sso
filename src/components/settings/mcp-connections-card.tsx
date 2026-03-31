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

interface McpConnection {
  id: string;
  clientName: string;
  clientId: string;
  scope: string;
  createdAt: string;
  expiresAt: string;
}

export function McpConnectionsCard() {
  const t = useTranslations("MachineIdentity.mcpConnections");
  const locale = useLocale();
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetchApi(API_PATH.USER_MCP_TOKENS);
      if (res.ok) {
        const data = await res.json();
        setConnections(data.tokens);
      }
    } catch {
      // Graceful failure — show empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  const handleRevoke = async (tokenId: string) => {
    try {
      const res = await fetchApi(apiPath.userMcpTokenById(tokenId), {
        method: "DELETE",
      });
      if (res.ok) {
        setConnections((prev) => prev.filter((c) => c.id !== tokenId));
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
        ) : connections.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Unplug className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm font-medium">{t("noConnections")}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t("noConnectionsDescription")}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {connections.map((conn) => (
              <div
                key={conn.id}
                className="flex items-start justify-between rounded-lg border p-3"
              >
                <div className="space-y-1.5 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">
                      {conn.clientName}
                    </span>
                    <span className="text-xs text-muted-foreground font-mono">
                      {conn.clientId}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {conn.scope.split(/[\s,]+/).filter(Boolean).map((s) => (
                      <Badge key={s} variant="secondary" className="text-xs">
                        {s}
                      </Badge>
                    ))}
                  </div>
                  <div className="flex gap-4 text-xs text-muted-foreground">
                    <span>
                      {t("created")}: {formatDateTime(conn.createdAt, locale)}
                    </span>
                    <span>
                      {t("expires")}: {formatDateTime(conn.expiresAt, locale)}
                    </span>
                  </div>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="sm" className="shrink-0 ml-2">
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
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => handleRevoke(conn.id)}>
                        {t("revoke")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
