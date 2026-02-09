"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  LogIn,
  LogOut,
  Plus,
  Pencil,
  Trash2,
  RotateCcw,
  Download,
  UserPlus,
  UserMinus,
  ShieldCheck,
  ScrollText,
  Loader2,
  Link as LinkIcon,
  Link2Off,
} from "lucide-react";

interface AuditLogItem {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
}

const ACTION_ICONS: Record<string, React.ReactNode> = {
  AUTH_LOGIN: <LogIn className="h-4 w-4" />,
  AUTH_LOGOUT: <LogOut className="h-4 w-4" />,
  ENTRY_CREATE: <Plus className="h-4 w-4" />,
  ENTRY_UPDATE: <Pencil className="h-4 w-4" />,
  ENTRY_DELETE: <Trash2 className="h-4 w-4" />,
  ENTRY_RESTORE: <RotateCcw className="h-4 w-4" />,
  ENTRY_EXPORT: <Download className="h-4 w-4" />,
  ORG_MEMBER_INVITE: <UserPlus className="h-4 w-4" />,
  ORG_MEMBER_REMOVE: <UserMinus className="h-4 w-4" />,
  ORG_ROLE_UPDATE: <ShieldCheck className="h-4 w-4" />,
  SHARE_CREATE: <LinkIcon className="h-4 w-4" />,
  SHARE_REVOKE: <Link2Off className="h-4 w-4" />,
};

const ACTIONS = [
  "AUTH_LOGIN",
  "AUTH_LOGOUT",
  "ENTRY_CREATE",
  "ENTRY_UPDATE",
  "ENTRY_DELETE",
  "ENTRY_RESTORE",
  "ENTRY_EXPORT",
  "ORG_MEMBER_INVITE",
  "ORG_MEMBER_REMOVE",
  "ORG_ROLE_UPDATE",
  "SHARE_CREATE",
  "SHARE_REVOKE",
] as const;

export default function AuditLogsPage() {
  const t = useTranslations("AuditLog");
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [actionFilter, setActionFilter] = useState<string>("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const fetchLogs = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams();
      if (actionFilter !== "all") params.set("action", actionFilter);
      if (dateFrom) params.set("from", new Date(dateFrom).toISOString());
      if (dateTo) {
        const endOfDay = new Date(dateTo);
        endOfDay.setHours(23, 59, 59, 999);
        params.set("to", endOfDay.toISOString());
      }
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`/api/audit-logs?${params.toString()}`);
      if (!res.ok) return null;
      return res.json();
    },
    [actionFilter, dateFrom, dateTo]
  );

  useEffect(() => {
    setLoading(true);
    fetchLogs().then((data) => {
      if (data) {
        setLogs(data.items);
        setNextCursor(data.nextCursor);
      }
      setLoading(false);
    });
  }, [fetchLogs]);

  const handleLoadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const data = await fetchLogs(nextCursor);
    if (data) {
      setLogs((prev) => [...prev, ...data.items]);
      setNextCursor(data.nextCursor);
    }
    setLoadingMore(false);
  };

  const formatDate = (iso: string) => {
    const d = new Date(iso);
    return d.toLocaleString();
  };

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <ScrollText className="h-6 w-6" />
        <div>
          <h1 className="text-2xl font-bold">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="space-y-1">
          <Label className="text-xs">{t("action")}</Label>
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("allActions")}</SelectItem>
              {ACTIONS.map((action) => (
                <SelectItem key={action} value={action}>
                  {t(action)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("dateFrom")}</Label>
          <Input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-[160px]"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("dateTo")}</Label>
          <Input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-[160px]"
          />
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : logs.length === 0 ? (
        <p className="text-center text-muted-foreground py-12">{t("noLogs")}</p>
      ) : (
        <div className="space-y-2">
          {logs.map((log) => (
            <Card key={log.id} className="p-3 flex items-center gap-3">
              <div className="shrink-0 text-muted-foreground">
                {ACTION_ICONS[log.action] ?? <ScrollText className="h-4 w-4" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{t(log.action as never)}</p>
                {log.targetType && (
                  <p className="text-xs text-muted-foreground truncate">
                    {log.targetType}
                    {log.targetId ? ` · ${log.targetId.slice(0, 8)}…` : ""}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-muted-foreground">
                  {formatDate(log.createdAt)}
                </p>
                {log.ip && (
                  <p className="text-xs text-muted-foreground">{log.ip}</p>
                )}
              </div>
            </Card>
          ))}

          {nextCursor && (
            <div className="flex justify-center pt-4">
              <Button
                variant="outline"
                onClick={handleLoadMore}
                disabled={loadingMore}
              >
                {loadingMore && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {t("loadMore")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
