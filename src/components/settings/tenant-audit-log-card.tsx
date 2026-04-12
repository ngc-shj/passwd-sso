"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ScrollText, ShieldAlert, Users } from "lucide-react";
import { ACTION_ICONS, DEFAULT_AUDIT_ICON } from "@/components/audit/audit-action-icons";
import {
  AUDIT_ACTION_GROUP,
  AUDIT_ACTION_GROUPS_TENANT,
  AUDIT_ACTION_GROUPS_TEAM,
  type AuditActionValue,
  apiPath,
  API_PATH,
} from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { formatUserName } from "@/lib/format-user";
import { useAuditLogs, type AuditLogItem } from "@/hooks/use-audit-logs";
import { AuditActionFilter } from "@/components/audit/audit-action-filter";
import { AuditDateFilter } from "@/components/audit/audit-date-filter";
import { AuditDownloadButton } from "@/components/audit/audit-download-button";
import { AuditLogList } from "@/components/audit/audit-log-list";
import { AuditLogItemRow } from "@/components/audit/audit-log-item-row";
import { AuditActorTypeBadge } from "@/components/audit/audit-actor-type-badge";
import { AuditDelegationDetail } from "@/components/audit/audit-delegation-detail";
import { BreakGlassDialog } from "@/components/breakglass/breakglass-dialog";
import { BreakGlassGrantList } from "@/components/breakglass/breakglass-grant-list";

// Build scope-specific action groups
function buildActionGroups(scope: "ALL" | "TENANT" | "TEAM") {
  if (scope === "TENANT") {
    return Object.entries(AUDIT_ACTION_GROUPS_TENANT).map(
      ([value, actions]) => ({ label: value, value, actions: actions as AuditActionValue[] })
    );
  }
  if (scope === "TEAM") {
    return Object.entries(AUDIT_ACTION_GROUPS_TEAM).map(
      ([value, actions]) => ({ label: value, value, actions: actions as AuditActionValue[] })
    );
  }
  // ALL: merge both
  const merged: Record<string, AuditActionValue[]> = {};
  for (const [group, actions] of Object.entries(AUDIT_ACTION_GROUPS_TENANT)) {
    merged[group] = [...(actions as AuditActionValue[])];
  }
  for (const [group, actions] of Object.entries(AUDIT_ACTION_GROUPS_TEAM)) {
    const existing = merged[group];
    if (existing) {
      const set = new Set(existing);
      for (const a of actions as AuditActionValue[]) {
        if (!set.has(a)) existing.push(a);
      }
    } else {
      merged[group] = [...(actions as AuditActionValue[])];
    }
  }
  return Object.entries(merged).map(
    ([value, actions]) => ({ label: value, value, actions: actions as AuditActionValue[] })
  );
}

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
  [AUDIT_ACTION_GROUP.SERVICE_ACCOUNT]: "groupServiceAccount",
  [AUDIT_ACTION_GROUP.MCP_CLIENT]: "groupMcpClient",
  [AUDIT_ACTION_GROUP.DELEGATION]: "groupDelegation",
  [AUDIT_ACTION_GROUP.TENANT_WEBHOOK]: "groupTenantWebhook",
  [AUDIT_ACTION_GROUP.MAINTENANCE]: "groupMaintenance",
};

interface TenantAuditLogCardProps {
  variant: "logs" | "breakglass";
}

export function TenantAuditLogCard({ variant }: TenantAuditLogCardProps) {
  const t = useTranslations("AuditLog");
  const tb = useTranslations("Breakglass");
  const [grantRefreshTrigger, setGrantRefreshTrigger] = useState(0);
  const [scopeFilter, setScopeFilter] = useState<"ALL" | "TENANT" | "TEAM">("ALL");
  const [teamFilter, setTeamFilter] = useState<string>("");
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);

  const actionGroups = useMemo(() => buildActionGroups(scopeFilter), [scopeFilter]);

  // Fetch teams list once on mount
  useEffect(() => {
    fetchApi(API_PATH.TEAMS)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: { id: string; name: string }[]) => {
        if (Array.isArray(data)) setTeams(data);
      });
  }, []);

  const buildExtraParams = useCallback(() => {
    const params = new URLSearchParams();
    if (scopeFilter !== "ALL") params.set("scope", scopeFilter);
    if (teamFilter) params.set("teamId", teamFilter);
    return params;
  }, [scopeFilter, teamFilter]);

  const {
    logs,
    loading,
    loadingMore,
    nextCursor,
    downloading,
    selectedActions,
    actionSearch,
    dateFrom,
    dateTo,
    filterOpen,
    actorTypeFilter,
    setActionSearch,
    setDateFrom,
    setDateTo,
    setFilterOpen,
    setActorTypeFilter,
    toggleAction,
    setGroupSelection,
    clearActions,
    actionSummary,
    filteredActions,
    actionLabel,
    isActionSelected,
    formatDate,
    handleLoadMore,
    handleDownload,
  } = useAuditLogs({
    fetchEndpoint: API_PATH.TENANT_AUDIT_LOGS,
    downloadEndpoint: apiPath.tenantAuditLogsDownload(),
    downloadFilename: "tenant-audit-logs",
    actionGroups,
    buildExtraParams,
  });

  const renderItem = (log: AuditLogItem) => (
    <AuditLogItemRow
      key={log.id}
      id={log.id}
      icon={ACTION_ICONS[log.action as AuditActionValue] ?? DEFAULT_AUDIT_ICON}
      actionLabel={actionLabel(log.action as AuditActionValue)}
      badges={
        <>
          <Badge
            variant={log.scope === "TEAM" ? "secondary" : "outline"}
            className="text-[10px] px-1.5 py-0 h-4 shrink-0"
          >
            {log.scope === "TEAM" ? t("scopeTeam") : t("scopeTenant")}
          </Badge>
          <AuditActorTypeBadge actorType={log.actorType} />
        </>
      }
      detail={
        <>
          <AuditDelegationDetail action={log.action} metadata={log.metadata} />
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {log.user && (
              <span className="truncate">{formatUserName(log.user)}</span>
            )}
            {log.team && (
              <>
                {log.user && <span>·</span>}
                <span className="flex items-center gap-0.5 shrink-0">
                  <Users className="h-3 w-3" />
                  {log.team.name}
                </span>
              </>
            )}
          </div>
        </>
      }
      timestamp={formatDate(log.createdAt)}
      ip={log.ip}
    />
  );

  if (variant === "logs") {
    return (
      <Card>
        <SectionCardHeader icon={ScrollText} title={t("subTabTenantLogs")} description={t("tenantDescription")} />
        <CardContent className="space-y-4">
          {/* Filters */}
          <div className="rounded-xl border bg-card/80 p-4">
            <div className="space-y-3">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="space-y-1">
                  <Label className="text-xs">{t("scopeLabel")}</Label>
                  <Select
                    value={scopeFilter}
                    onValueChange={(v) => {
                      const scope = v as "ALL" | "TENANT" | "TEAM";
                      setScopeFilter(scope);
                      setTeamFilter("");
                      clearActions();
                    }}
                  >
                    <SelectTrigger className="w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">{t("scopeAll")}</SelectItem>
                      <SelectItem value="TENANT">{t("scopeTenant")}</SelectItem>
                      <SelectItem value="TEAM">{t("scopeTeam")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {(scopeFilter === "TEAM" || scopeFilter === "ALL") && teams.length > 0 && (
                  <div className="space-y-1">
                    <Label className="text-xs">{t("scopeTeam")}</Label>
                    <Select
                      value={teamFilter || "__all__"}
                      onValueChange={(v) => setTeamFilter(v === "__all__" ? "" : v)}
                    >
                      <SelectTrigger className="w-[180px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__all__">{t("scopeAllTeams")}</SelectItem>
                        {teams.map((team) => (
                          <SelectItem key={team.id} value={team.id}>
                            {team.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="space-y-1">
                  <Label className="text-xs">{t("actorTypeLabel")}</Label>
                  <Select value={actorTypeFilter} onValueChange={setActorTypeFilter}>
                    <SelectTrigger className="w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="ALL">{t("actorTypeAll")}</SelectItem>
                      <SelectItem value="HUMAN">{t("actorTypeHuman")}</SelectItem>
                      <SelectItem value="SERVICE_ACCOUNT">{t("actorTypeSa")}</SelectItem>
                      <SelectItem value="MCP_AGENT">{t("actorTypeMcp")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <AuditDateFilter
                  dateFrom={dateFrom}
                  dateTo={dateTo}
                  setDateFrom={setDateFrom}
                  setDateTo={setDateTo}
                />
              </div>
              <AuditActionFilter
                actionGroups={actionGroups}
                selectedActions={selectedActions}
                actionSearch={actionSearch}
                filterOpen={filterOpen}
                actionSummary={actionSummary}
                actionLabel={actionLabel}
                filteredActions={filteredActions}
                isActionSelected={isActionSelected}
                toggleAction={toggleAction}
                setGroupSelection={setGroupSelection}
                clearActions={clearActions}
                setActionSearch={setActionSearch}
                setFilterOpen={setFilterOpen}
                groupLabelResolver={(v) => GROUP_LABEL_MAP[v]}
              />
            </div>
          </div>

          {/* Download */}
          <div className="flex justify-end">
            <AuditDownloadButton
              downloading={downloading}
              onDownload={handleDownload}
            />
          </div>

          {/* Audit log list */}
          <AuditLogList
            logs={logs}
            loading={loading}
            loadingMore={loadingMore}
            nextCursor={nextCursor}
            onLoadMore={handleLoadMore}
            renderItem={renderItem}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <SectionCardHeader icon={ShieldAlert} title={tb("title")} description={tb("description")} />
      <CardContent className="space-y-4">
        <div className="flex justify-end">
          <BreakGlassDialog
            onGrantCreated={() => setGrantRefreshTrigger((n) => n + 1)}
          />
        </div>
        <BreakGlassGrantList refreshTrigger={grantRefreshTrigger} />
      </CardContent>
    </Card>
  );
}
