"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SectionCardHeader } from "@/components/settings/section-card-header";
import { SectionLayout } from "@/components/settings/section-layout";
import { ScrollText } from "lucide-react";
import {
  AUDIT_ACTION,
  AUDIT_ACTION_GROUP,
  AUDIT_ACTION_GROUPS_TEAM,
  AUDIT_TARGET_TYPE,
  apiPath,
  type AuditActionValue,
} from "@/lib/constants";
import { fetchApi } from "@/lib/url-helpers";
import { useTeamVaultOptional } from "@/lib/team-vault-core";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { unwrapItemKey, deriveItemEncryptionKey } from "@/lib/crypto-team";
import { buildTeamEntryAAD, buildItemKeyWrapAAD } from "@/lib/crypto-aad";
import { useAuditLogs, type AuditLogItem } from "@/hooks/use-audit-logs";
import { getActionLabel } from "@/lib/audit-action-label";
import { getCommonTargetLabel } from "@/lib/audit-target-label";
import { AuditActionFilter } from "@/components/audit/audit-action-filter";
import { AuditDateFilter } from "@/components/audit/audit-date-filter";
import { AuditDownloadButton } from "@/components/audit/audit-download-button";
import { AuditLogList } from "@/components/audit/audit-log-list";
import { AuditLogItemRow } from "@/components/audit/audit-log-item-row";
import { AuditActorTypeBadge } from "@/components/audit/audit-actor-type-badge";
import { ACTION_ICONS, DEFAULT_AUDIT_ICON } from "@/components/audit/audit-action-icons";

const ACTION_GROUPS = [
  { label: "groupEntry", value: AUDIT_ACTION_GROUP.ENTRY, actions: AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.ENTRY] },
  { label: "groupBulk", value: AUDIT_ACTION_GROUP.BULK, actions: AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.BULK] },
  { label: "groupTransfer", value: AUDIT_ACTION_GROUP.TRANSFER, actions: AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.TRANSFER] },
  { label: "groupAttachment", value: AUDIT_ACTION_GROUP.ATTACHMENT, actions: AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.ATTACHMENT] },
  { label: "groupTeam", value: AUDIT_ACTION_GROUP.TEAM, actions: AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.TEAM] },
  { label: "groupShare", value: AUDIT_ACTION_GROUP.SHARE, actions: AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.SHARE] },
  { label: "groupAdmin", value: AUDIT_ACTION_GROUP.ADMIN, actions: AUDIT_ACTION_GROUPS_TEAM[AUDIT_ACTION_GROUP.ADMIN] },
] as const;

interface TeamEntryOverview {
  encryptedOverview: string;
  overviewIv: string;
  overviewAuthTag: string;
  aadVersion: number;
  teamKeyVersion: number;
  encryptedItemKey: string;
  itemKeyIv: string;
  itemKeyAuthTag: string;
  itemKeyVersion: number;
}

export default function TeamAdminAuditLogsPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("AuditLog");
  const tAdmin = useTranslations("AdminConsole");
  const teamVault = useTeamVaultOptional();
  const [exportAllowed, setExportAllowed] = useState(true);

  const resolveTeamEntryNames = useCallback(
    async (overviews: Record<string, TeamEntryOverview>): Promise<Map<string, string>> => {
      if (!teamVault) return new Map();
      const teamKey = await teamVault.getTeamEncryptionKey(teamId);
      if (!teamKey) return new Map();

      const names = new Map<string, string>();
      for (const [entryId, ov] of Object.entries(overviews)) {
        try {
          const ikAad = buildItemKeyWrapAAD(teamId, entryId, ov.teamKeyVersion);
          const rawItemKey = await unwrapItemKey(
            { ciphertext: ov.encryptedItemKey, iv: ov.itemKeyIv, authTag: ov.itemKeyAuthTag },
            teamKey,
            ikAad,
          );
          const itemEncKey = await deriveItemEncryptionKey(rawItemKey);
          rawItemKey.fill(0);

          const overviewAad = ov.aadVersion >= 1
            ? buildTeamEntryAAD(teamId, entryId, "overview", ov.itemKeyVersion)
            : undefined;
          const overview = JSON.parse(
            await decryptData(
              { ciphertext: ov.encryptedOverview, iv: ov.overviewIv, authTag: ov.overviewAuthTag } as EncryptedData,
              itemEncKey,
              overviewAad,
            ),
          );
          if (overview.title) names.set(entryId, overview.title);
        } catch {
          // Decryption failed — entry will show as "deletedEntry"
        }
      }
      return names;
    },
    [teamId, teamVault],
  );

  const resolveEntryNames = useCallback(
    async (data: unknown): Promise<Map<string, string>> => {
      const d = data as { entryOverviews?: Record<string, TeamEntryOverview> };
      if (!d.entryOverviews) return new Map();
      return resolveTeamEntryNames(d.entryOverviews);
    },
    [resolveTeamEntryNames],
  );

  useEffect(() => {
    fetchApi(apiPath.teamPolicy(teamId))
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && data.allowExport === false) setExportAllowed(false);
      })
      .catch(() => {});
  }, [teamId]);

  const audit = useAuditLogs({
    fetchEndpoint: apiPath.teamAuditLogs(teamId),
    downloadEndpoint: `${apiPath.teamAuditLogs(teamId)}/download`,
    downloadFilename: "team-audit-logs",
    actionGroups: ACTION_GROUPS,
    resolveEntryNames,
  });

  const getTargetLabel = useCallback(
    (log: AuditLogItem): string | null => {
      const meta = log.metadata && typeof log.metadata === "object"
        ? (log.metadata as Record<string, unknown>)
        : null;

      const common = getCommonTargetLabel(
        t as Parameters<typeof getCommonTargetLabel>[0],
        log,
        audit.entryNames,
        AUDIT_TARGET_TYPE.TEAM_PASSWORD_ENTRY,
        "exportMetaTeam",
      );
      if (common !== null) return common;

      if (
        (log.action === AUDIT_ACTION.TEAM_MEMBER_INVITE || log.action === AUDIT_ACTION.TEAM_MEMBER_REMOVE) &&
        meta?.email
      ) {
        return String(meta.email);
      }

      return null;
    },
    [t, audit.entryNames],
  );

  const renderItem = useCallback(
    (log: AuditLogItem) => {
      const targetLabel = getTargetLabel(log);
      const user = log.user;
      return (
        <AuditLogItemRow
          key={log.id}
          id={log.id}
          icon={ACTION_ICONS[log.action as AuditActionValue] ?? DEFAULT_AUDIT_ICON}
          actionLabel={getActionLabel(t as Parameters<typeof getActionLabel>[0], log.action, audit.actionLabel)}
          badges={<AuditActorTypeBadge actorType={log.actorType} userId={log.userId ?? undefined} />}
          detail={
            <>
              {user && (
                <p className="text-xs text-muted-foreground truncate">
                  {t("operatedBy", { name: user.email ? `${user.name} (${user.email})` : (user.name ?? "") })}
                </p>
              )}
              {targetLabel && (
                <p className="text-xs text-muted-foreground truncate">
                  {targetLabel}
                </p>
              )}
            </>
          }
          timestamp={audit.formatDate(log.createdAt)}
          ip={log.ip}
        />
      );
    },
    [t, audit, getTargetLabel],
  );

  return (
    <SectionLayout
      icon={ScrollText}
      title={tAdmin("teamSectionAuditLogs")}
      description={tAdmin("teamSectionAuditLogsDesc")}
    >
    <Card>
      <SectionCardHeader icon={ScrollText} title={tAdmin("navAuditLogs")} description={tAdmin("teamSectionAuditLogsDesc")} />
      <CardContent className="space-y-4">
        <div className="rounded-xl border bg-card/80 p-4">
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label className="text-xs">{t("actorTypeLabel")}</Label>
                <Select value={audit.actorTypeFilter} onValueChange={audit.setActorTypeFilter}>
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
                dateFrom={audit.dateFrom}
                dateTo={audit.dateTo}
                setDateFrom={audit.setDateFrom}
                setDateTo={audit.setDateTo}
              />
            </div>
            <AuditActionFilter
              actionGroups={ACTION_GROUPS}
              selectedActions={audit.selectedActions}
              actionSearch={audit.actionSearch}
              filterOpen={audit.filterOpen}
              actionSummary={audit.actionSummary}
              actionLabel={audit.actionLabel}
              filteredActions={audit.filteredActions}
              isActionSelected={audit.isActionSelected}
              toggleAction={audit.toggleAction}
              setGroupSelection={audit.setGroupSelection}
              clearActions={audit.clearActions}
              setActionSearch={audit.setActionSearch}
              setFilterOpen={audit.setFilterOpen}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <AuditDownloadButton
            downloading={audit.downloading}
            onDownload={audit.handleDownload}
            exportAllowed={exportAllowed}
          />
        </div>

        <AuditLogList
          logs={audit.logs}
          loading={audit.loading}
          loadingMore={audit.loadingMore}
          nextCursor={audit.nextCursor}
          onLoadMore={audit.handleLoadMore}
          renderItem={renderItem}
        />
      </CardContent>
    </Card>
    </SectionLayout>
  );
}
