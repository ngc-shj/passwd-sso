"use client";

import { useState, useEffect, useCallback } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, ScrollText, Download, ChevronDown, ShieldAlert } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AUDIT_ACTION_GROUP,
  AUDIT_ACTION_GROUPS_TENANT,
  AUDIT_ACTION_GROUPS_TEAM,
  type AuditActionValue,
  apiPath,
  API_PATH,
} from "@/lib/constants";
import { normalizeAuditActionKey } from "@/lib/audit-action-key";
import { formatDateTime } from "@/lib/format-datetime";
import { fetchApi } from "@/lib/url-helpers";
import { BreakGlassDialog } from "@/components/breakglass/breakglass-dialog";
import { BreakGlassGrantList } from "@/components/breakglass/breakglass-grant-list";

interface AuditLogItem {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: string;
  user?: { id: string; name: string | null; email: string | null } | null;
}

// Merge TENANT + TEAM action groups for filter UI (tenant logs show both scopes)
const MERGED_GROUPS: Record<string, AuditActionValue[]> = {};
for (const [group, actions] of Object.entries(AUDIT_ACTION_GROUPS_TENANT)) {
  MERGED_GROUPS[group] = [...(actions as AuditActionValue[])];
}
for (const [group, actions] of Object.entries(AUDIT_ACTION_GROUPS_TEAM)) {
  const existing = MERGED_GROUPS[group];
  if (existing) {
    const set = new Set(existing);
    for (const a of actions as AuditActionValue[]) {
      if (!set.has(a)) existing.push(a);
    }
  } else {
    MERGED_GROUPS[group] = [...(actions as AuditActionValue[])];
  }
}

const ACTION_GROUPS = Object.entries(MERGED_GROUPS).map(
  ([value, actions]) => ({ value, actions })
);

const GROUP_LABEL_MAP: Record<string, string> = {
  [AUDIT_ACTION_GROUP.ADMIN]: "groupAdmin",
  [AUDIT_ACTION_GROUP.SCIM]: "groupScim",
  [AUDIT_ACTION_GROUP.DIRECTORY_SYNC]: "groupDirectorySync",
  [AUDIT_ACTION_GROUP.BREAKGLASS]: "groupBreakglass",
  [AUDIT_ACTION_GROUP.ENTRY]: "groupEntry",
  [AUDIT_ACTION_GROUP.BULK]: "groupBulk",
  [AUDIT_ACTION_GROUP.TRANSFER]: "groupTransfer",
  [AUDIT_ACTION_GROUP.ATTACHMENT]: "groupAttachment",
  [AUDIT_ACTION_GROUP.FOLDER]: "groupFolder",
  [AUDIT_ACTION_GROUP.HISTORY]: "groupHistory",
  [AUDIT_ACTION_GROUP.TEAM]: "groupTeam",
  [AUDIT_ACTION_GROUP.SHARE]: "groupShare",
  [AUDIT_ACTION_GROUP.WEBHOOK]: "groupWebhook",
};

export function TenantAuditLogCard() {
  const t = useTranslations("AuditLog");
  const td = useTranslations("AuditDownload");
  const tb = useTranslations("Breakglass");
  const locale = useLocale();
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedActions, setSelectedActions] = useState<Set<AuditActionValue>>(new Set());
  const [actionSearch, setActionSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const [grantRefreshTrigger, setGrantRefreshTrigger] = useState(0);

  const actionLabel = (action: AuditActionValue | string) => {
    const key = normalizeAuditActionKey(String(action));
    return t.has(key as never) ? t(key as never) : String(action);
  };

  const buildFilterParams = useCallback(() => {
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
    return params;
  }, [selectedActions, dateFrom, dateTo]);

  const fetchLogs = useCallback(
    async (cursor?: string) => {
      const params = buildFilterParams();
      if (cursor) params.set("cursor", cursor);
      const res = await fetchApi(`${API_PATH.TENANT_AUDIT_LOGS}?${params.toString()}`);
      if (!res.ok) return null;
      return res.json();
    },
    [buildFilterParams]
  );

  useEffect(() => {
    setLoading(true);
    fetchLogs().then((data) => {
      if (data) {
        setLogs(data.items ?? []);
        setNextCursor(data.nextCursor ?? null);
      }
      setLoading(false);
    });
  }, [fetchLogs]);

  const handleLoadMore = async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    const data = await fetchLogs(nextCursor);
    if (data) {
      setLogs((prev) => [...prev, ...(data.items ?? [])]);
      setNextCursor(data.nextCursor ?? null);
    }
    setLoadingMore(false);
  };

  const handleDownload = async (format: "jsonl" | "csv") => {
    setDownloading(true);
    try {
      const params = buildFilterParams();
      params.set("format", format);
      const res = await fetchApi(`${apiPath.tenantAuditLogsDownload()}?${params.toString()}`);
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `tenant-audit-logs.${format === "csv" ? "csv" : "jsonl"}`;
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloading(false);
    }
  };

  const toggleAction = (action: AuditActionValue, checked: boolean) => {
    setSelectedActions((prev) => {
      const next = new Set(prev);
      if (checked) next.add(action);
      else next.delete(action);
      return next;
    });
  };

  const setGroupSelection = (actions: AuditActionValue[], checked: boolean) => {
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

  const filteredActions = (actions: AuditActionValue[]) => {
    if (!actionSearch) return actions;
    const q = actionSearch.toLowerCase();
    return actions.filter(
      (a) => actionLabel(a).toLowerCase().includes(q) || a.toLowerCase().includes(q)
    );
  };

  const isActionSelected = (action: AuditActionValue) => selectedActions.has(action);

  const selectedCount = selectedActions.size;
  const actionSummary =
    selectedCount === 0
      ? t("allActions")
      : selectedCount === 1
        ? actionLabel(Array.from(selectedActions)[0])
        : t("actionsSelected", { count: selectedCount });

  const formatUser = (
    user?: { name: string | null; email: string | null } | null
  ) => {
    if (!user) return null;
    return user.name?.trim() || user.email || null;
  };

  return (
    <Tabs defaultValue="tenant-logs" className="space-y-4">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="tenant-logs">
          <ScrollText className="h-4 w-4 mr-2" />
          {t("subTabTenantLogs")}
        </TabsTrigger>
        <TabsTrigger value="breakglass">
          <ShieldAlert className="h-4 w-4 mr-2" />
          {t("subTabBreakglass")}
        </TabsTrigger>
      </TabsList>

      {/* Tenant Logs sub-tab */}
      <TabsContent value="tenant-logs" className="space-y-4">
        {/* Filters */}
        <Card className="rounded-xl border bg-card/80 p-4">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3 items-end">
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
              <div className="space-y-1">
                <Label className="text-xs invisible">&#8203;</Label>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" disabled={downloading}>
                      {downloading ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4 mr-2" />
                      )}
                      {downloading ? td("downloading") : td("download")}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start">
                    <DropdownMenuItem onClick={() => handleDownload("csv")}>
                      {td("formatCsv")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDownload("jsonl")}>
                      {td("formatJsonl")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <Collapsible open={filterOpen} onOpenChange={setFilterOpen}>
              <div className="flex items-center gap-2">
                <CollapsibleTrigger asChild>
                  <Button variant="outline" size="sm" className="justify-between gap-2">
                    <span className="text-xs">
                      {t("action")}: {actionSummary}
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 transition-transform ${filterOpen ? "rotate-180" : ""}`}
                    />
                  </Button>
                </CollapsibleTrigger>
                {selectedActions.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={clearActions}
                  >
                    {t("allActions")}
                  </Button>
                )}
              </div>
              <CollapsibleContent>
                <div className="mt-2 space-y-2">
                  <Input
                    placeholder={t("actionSearch")}
                    value={actionSearch}
                    onChange={(e) => setActionSearch(e.target.value)}
                  />
                  <div className="max-h-64 overflow-y-auto border rounded-md p-3 space-y-1">
                    {ACTION_GROUPS.map((group) => {
                      const actions = filteredActions(group.actions);
                      if (actions.length === 0) return null;
                      const allSelected = group.actions.every((a) =>
                        selectedActions.has(a)
                      );
                      const labelKey = GROUP_LABEL_MAP[group.value] ?? group.value;
                      return (
                        <Collapsible key={group.value}>
                          <div className="flex items-center gap-2 py-1">
                            <Checkbox
                              checked={allSelected}
                              onCheckedChange={(checked) =>
                                setGroupSelection(group.actions, !!checked)
                              }
                            />
                            <CollapsibleTrigger className="flex items-center gap-1 text-sm font-medium hover:underline">
                              {t.has(labelKey as never) ? t(labelKey as never) : labelKey}
                              <ChevronDown className="h-3.5 w-3.5" />
                            </CollapsibleTrigger>
                          </div>
                          <CollapsibleContent className="pl-6 space-y-1">
                            {actions.map((action) => (
                              <label
                                key={action}
                                className="flex items-center gap-2 text-sm py-0.5"
                              >
                                <Checkbox
                                  checked={isActionSelected(action)}
                                  onCheckedChange={(checked) =>
                                    toggleAction(action, !!checked)
                                  }
                                />
                                {actionLabel(action)}
                              </label>
                            ))}
                          </CollapsibleContent>
                        </Collapsible>
                      );
                    })}
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </Card>

        {/* Audit log list */}
        {loading ? (
          <Card className="rounded-xl border bg-card/80 p-10">
            <div className="flex justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          </Card>
        ) : logs.length === 0 ? (
          <Card className="rounded-xl border bg-card/80 p-10">
            <p className="text-center text-muted-foreground">{t("noLogs")}</p>
          </Card>
        ) : (
          <>
            <Card className="rounded-xl border bg-card/80 divide-y">
              {logs.map((log) => (
                <div
                  key={log.id}
                  className="px-4 py-3 flex items-start gap-3 transition-colors hover:bg-accent/30 dark:hover:bg-accent/50"
                >
                  <div className="shrink-0 text-muted-foreground mt-0.5">
                    <ScrollText className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">
                      {actionLabel(log.action as AuditActionValue)}
                    </p>
                    {log.user && (
                      <p className="text-xs text-muted-foreground truncate">
                        {formatUser(log.user)}
                      </p>
                    )}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(log.createdAt, locale)}
                    </p>
                    {log.ip && (
                      <p className="text-xs text-muted-foreground">{log.ip}</p>
                    )}
                  </div>
                </div>
              ))}
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
      </TabsContent>

      {/* Break-Glass sub-tab */}
      <TabsContent value="breakglass" className="space-y-4">
        <Card className="rounded-xl border bg-card/80 p-4">
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-destructive" />
                <div>
                  <p className="text-sm font-medium">{tb("title")}</p>
                  <p className="text-xs text-muted-foreground">{tb("description")}</p>
                </div>
              </div>
              <BreakGlassDialog
                onGrantCreated={() => setGrantRefreshTrigger((n) => n + 1)}
              />
            </div>
            <BreakGlassGrantList refreshTrigger={grantRefreshTrigger} />
          </div>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
