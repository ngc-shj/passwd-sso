"use client";

import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollText } from "lucide-react";
import { AUDIT_ACTION_EMERGENCY_PREFIX, type AuditActionValue } from "@/lib/constants";
import type { AuditLogItem } from "@/hooks/vault/use-audit-logs";
import {
  PERSONAL_AUDIT_ACTION_GROUPS as ACTION_GROUPS,
  usePersonalAuditLogs,
} from "@/hooks/vault/use-personal-audit-logs";
import { getActionLabel } from "@/lib/audit/audit-action-label";
import { AuditActionFilter } from "@/components/audit/audit-action-filter";
import { AuditDateFilter } from "@/components/audit/audit-date-filter";
import { AuditDownloadButton } from "@/components/audit/audit-download-button";
import { AuditLogList } from "@/components/audit/audit-log-list";
import { AuditLogItemRow } from "@/components/audit/audit-log-item-row";
import { AuditActorTypeBadge } from "@/components/audit/audit-actor-type-badge";
import { ACTION_ICONS, DEFAULT_AUDIT_ICON } from "@/components/audit/audit-action-icons";

export default function AuditLogsPage() {
  const t = useTranslations("AuditLog");
  const {
    logs, loading, loadingMore, nextCursor, downloading,
    selectedActions, actionSearch, dateFrom, dateTo, filterOpen, actorTypeFilter,
    setActionSearch, setDateFrom, setDateTo, setFilterOpen, setActorTypeFilter,
    toggleAction, setGroupSelection, clearActions,
    actionSummary, filteredActions, actionLabel, isActionSelected, formatDate,
    handleLoadMore, handleDownload,
    getEmergencyDetail, getTargetLabel,
  } = usePersonalAuditLogs();

  const renderItem = (log: AuditLogItem) => {
    const targetLabel = getTargetLabel(log);
    const emergencyDetail = log.action.startsWith(AUDIT_ACTION_EMERGENCY_PREFIX)
      ? getEmergencyDetail(log)
      : null;

    return (
      <AuditLogItemRow
        key={log.id}
        id={log.id}
        icon={ACTION_ICONS[log.action as AuditActionValue] ?? DEFAULT_AUDIT_ICON}
        actionLabel={getActionLabel(t as never, log.action, actionLabel)}
        badges={<AuditActorTypeBadge actorType={log.actorType} userId={log.userId ?? undefined} />}
        detail={
          <>
            {targetLabel && (
              <p className="text-xs text-muted-foreground truncate">{targetLabel}</p>
            )}
            {emergencyDetail && (
              <p className="text-xs text-muted-foreground">{emergencyDetail}</p>
            )}
          </>
        }
        timestamp={formatDate(log.createdAt)}
        ip={log.ip}
      />
    );
  };

  return (
    <div className="flex-1 overflow-auto p-4 md:p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <Card className="rounded-xl border bg-gradient-to-b from-muted/30 to-background p-4">
          <div className="flex items-center gap-3">
            <ScrollText className="h-6 w-6" />
            <div>
              <h1 className="text-2xl font-bold">{t("title")}</h1>
            </div>
          </div>
        </Card>

        <Card className="rounded-xl border bg-card/80 p-4">
          <div className="space-y-3">
            <div className="flex flex-wrap gap-3 items-end">
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
              actionGroups={ACTION_GROUPS}
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
            />
          </div>
        </Card>

        <div className="flex justify-end">
          <AuditDownloadButton downloading={downloading} onDownload={handleDownload} />
        </div>

        <AuditLogList
          logs={logs}
          loading={loading}
          loadingMore={loadingMore}
          nextCursor={nextCursor}
          onLoadMore={handleLoadMore}
          renderItem={renderItem}
        />
      </div>
    </div>
  );
}
