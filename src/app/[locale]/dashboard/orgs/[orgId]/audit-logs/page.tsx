"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Upload,
  UserPlus,
  UserMinus,
  ShieldCheck,
  ScrollText,
  Loader2,
  Link as LinkIcon,
  Link2Off,
} from "lucide-react";

interface OrgAuditLogItem {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  user: { id: string; name: string | null; image: string | null };
}

const ACTION_ICONS: Record<string, React.ReactNode> = {
  AUTH_LOGIN: <LogIn className="h-4 w-4" />,
  AUTH_LOGOUT: <LogOut className="h-4 w-4" />,
  ENTRY_CREATE: <Plus className="h-4 w-4" />,
  ENTRY_UPDATE: <Pencil className="h-4 w-4" />,
  ENTRY_DELETE: <Trash2 className="h-4 w-4" />,
  ENTRY_RESTORE: <RotateCcw className="h-4 w-4" />,
  ENTRY_EXPORT: <Download className="h-4 w-4" />,
  ATTACHMENT_UPLOAD: <Upload className="h-4 w-4" />,
  ATTACHMENT_DELETE: <Trash2 className="h-4 w-4" />,
  ORG_MEMBER_INVITE: <UserPlus className="h-4 w-4" />,
  ORG_MEMBER_REMOVE: <UserMinus className="h-4 w-4" />,
  ORG_ROLE_UPDATE: <ShieldCheck className="h-4 w-4" />,
  SHARE_CREATE: <LinkIcon className="h-4 w-4" />,
  SHARE_REVOKE: <Link2Off className="h-4 w-4" />,
};

const ACTION_GROUPS = [
  {
    label: "groupEntry",
    value: "group:entry",
    actions: ["ENTRY_CREATE", "ENTRY_UPDATE", "ENTRY_DELETE", "ENTRY_RESTORE"],
  },
  { label: "groupAttachment", value: "group:attachment", actions: ["ATTACHMENT_UPLOAD", "ATTACHMENT_DELETE"] },
  { label: "groupOrg", value: "group:org", actions: ["ORG_MEMBER_INVITE", "ORG_MEMBER_REMOVE", "ORG_ROLE_UPDATE"] },
  { label: "groupShare", value: "group:share", actions: ["SHARE_CREATE", "SHARE_REVOKE"] },
] as const;

export default function OrgAuditLogsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = use(params);
  const t = useTranslations("AuditLog");
  const [orgName, setOrgName] = useState<string>("");
  const [logs, setLogs] = useState<OrgAuditLogItem[]>([]);
  const [entryNames, setEntryNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedActions, setSelectedActions] = useState<Set<string>>(new Set());
  const [actionSearch, setActionSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  useEffect(() => {
    fetch(`/api/orgs/${orgId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.name) setOrgName(data.name);
      })
      .catch(() => {});
  }, [orgId]);

  const fetchLogs = useCallback(
    async (cursor?: string) => {
      const params = new URLSearchParams();
      if (selectedActions.size > 0) {
        params.set("actions", Array.from(selectedActions).join(","));
      }
      if (dateFrom) params.set("from", new Date(dateFrom).toISOString());
      if (dateTo) {
        const endOfDay = new Date(dateTo);
        endOfDay.setHours(23, 59, 59, 999);
        params.set("to", endOfDay.toISOString());
      }
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(
        `/api/orgs/${orgId}/audit-logs?${params.toString()}`
      );
      if (!res.ok) return null;
      return res.json();
    },
    [orgId, selectedActions, dateFrom, dateTo]
  );

  useEffect(() => {
    setLoading(true);
    fetchLogs().then((data) => {
      if (data) {
        setLogs(data.items);
        setNextCursor(data.nextCursor);
        if (data.entryNames) {
          setEntryNames(data.entryNames);
        }
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
      if (data.entryNames) {
        setEntryNames((prev) => ({ ...prev, ...data.entryNames }));
      }
    }
    setLoadingMore(false);
  };

  const formatDate = (iso: string) => new Date(iso).toLocaleString();

  const getTargetLabel = (log: OrgAuditLogItem): string | null => {
    const meta = log.metadata;

    // Entry operations: show resolved entry name
    if (log.targetType === "OrgPasswordEntry" && log.targetId) {
      const name = entryNames[log.targetId];
      if (name) {
        if (log.action === "ENTRY_DELETE" && meta?.permanent) {
          return `${name}（${t("permanentDelete")}）`;
        }
        return name;
      }
      return t("deletedEntry");
    }

    // Attachment operations: show filename
    if (meta?.filename) {
      return String(meta.filename);
    }

    // Member operations: show email
    if (
      (log.action === "ORG_MEMBER_INVITE" || log.action === "ORG_MEMBER_REMOVE") &&
      meta?.email
    ) {
      return String(meta.email);
    }

    // Role updates: show role change
    if (log.action === "ORG_ROLE_UPDATE" && meta?.previousRole && meta?.newRole) {
      return t("roleChange", {
        from: String(meta.previousRole),
        to: String(meta.newRole),
      });
    }

    return null;
  };

  const actionLabel = (action: string) => t(action as never);

  const filteredActions = (actions: readonly string[]) => {
    if (!actionSearch) return actions;
    const q = actionSearch.toLowerCase();
    return actions.filter((a) => {
      const label = actionLabel(a).toLowerCase();
      return label.includes(q) || a.toLowerCase().includes(q);
    });
  };

  const isActionSelected = (action: string) => selectedActions.has(action);

  const toggleAction = (action: string, checked: boolean) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (checked) next.add(action);
      else next.delete(action);
      return next;
    });
  };

  const setGroupSelection = (actions: readonly string[], checked: boolean) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      for (const action of actions) {
        if (checked) next.add(action);
        else next.delete(action);
      }
      return next;
    });
  };

  const clearActions = () => setSelectedActions(new Set());

  const selectedCount = selectedActions.size;
  const actionSummary =
    selectedCount === 0
      ? t("allActions")
      : selectedCount === 1
        ? actionLabel(Array.from(selectedActions)[0])
        : t("actionsSelected", { count: selectedCount });

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <ScrollText className="h-6 w-6" />
        <div>
          <h1 className="text-2xl font-bold">{t("orgAuditLog", { orgName: orgName || "..." })}</h1>
          <p className="text-sm text-muted-foreground">{t("orgAuditLogDesc", { orgName: orgName || "..." })}</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3 items-end">
        <div className="space-y-1">
          <Label className="text-xs">{t("action")}</Label>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" className="w-[240px] justify-between">
                <span className="truncate">{actionSummary}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-[280px] p-2" align="start">
              <div className="px-2 pb-2">
                <Input
                  placeholder={t("actionSearch")}
                  value={actionSearch}
                  onChange={(e) => setActionSearch(e.target.value)}
                />
              </div>
              <DropdownMenuCheckboxItem
                checked={selectedActions.size === 0}
                onCheckedChange={() => clearActions()}
              >
                {t("allActions")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {ACTION_GROUPS.map((group) => {
                const actions = filteredActions(group.actions);
                if (actions.length === 0) return null;
                const allSelected = group.actions.every((a) => selectedActions.has(a));
                return (
                  <div key={group.value}>
                    <DropdownMenuLabel className="px-2 pt-2 text-xs">
                      {t(group.label as never)}
                    </DropdownMenuLabel>
                    <DropdownMenuCheckboxItem
                      checked={allSelected}
                      onCheckedChange={(checked) => setGroupSelection(group.actions, !!checked)}
                      className="font-medium"
                    >
                      {t("selectGroup")}
                    </DropdownMenuCheckboxItem>
                    {actions.map((action) => (
                      <DropdownMenuCheckboxItem
                        key={action}
                        checked={isActionSelected(action)}
                        onCheckedChange={(checked) => toggleAction(action, !!checked)}
                        className="pl-6"
                      >
                        {actionLabel(action)}
                      </DropdownMenuCheckboxItem>
                    ))}
                  </div>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
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
        <>
          <Card className="divide-y">
            {logs.map((log) => {
              const targetLabel = getTargetLabel(log);
              return (
                <div key={log.id} className="px-4 py-2 flex items-start gap-3">
                  <div className="shrink-0 text-muted-foreground mt-0.5">
                    {ACTION_ICONS[log.action] ?? <ScrollText className="h-4 w-4" />}
                  </div>
                  <Avatar className="h-6 w-6 shrink-0">
                    <AvatarImage src={log.user.image ?? undefined} />
                    <AvatarFallback className="text-xs">
                      {log.user.name?.[0]?.toUpperCase() ?? "?"}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      <span className="text-muted-foreground">{log.user.name}</span>
                      {" · "}
                      {t(log.action as never)}
                    </p>
                    {targetLabel && (
                      <p className="text-xs text-muted-foreground truncate">
                        {targetLabel}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDate(log.createdAt)}
                    </p>
                    {log.ip && (
                      <p className="text-xs text-muted-foreground">{log.ip}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </Card>

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
        </>
      )}
    </div>
  );
}
