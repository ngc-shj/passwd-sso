"use client";

import { use, useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  LogIn,
  LogOut,
  Plus,
  Archive,
  Pencil,
  Trash2,
  RotateCcw,
  Download,
  Upload,
  UserPlus,
  UserMinus,
  ShieldCheck,
  ScrollText,
  Link as LinkIcon,
  Link2Off,
} from "lucide-react";
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

const ACTION_ICONS: Partial<Record<AuditActionValue, React.ReactNode>> = {
  [AUDIT_ACTION.AUTH_LOGIN]: <LogIn className="h-4 w-4" />,
  [AUDIT_ACTION.AUTH_LOGOUT]: <LogOut className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_BULK_TRASH]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_EMPTY_TRASH]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_BULK_ARCHIVE]: <Archive className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_BULK_UNARCHIVE]: <RotateCcw className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_BULK_RESTORE]: <RotateCcw className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_IMPORT]: <Upload className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_CREATE]: <Plus className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_UPDATE]: <Pencil className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_DELETE]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_TRASH]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_PERMANENT_DELETE]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_RESTORE]: <RotateCcw className="h-4 w-4" />,
  [AUDIT_ACTION.ENTRY_EXPORT]: <Download className="h-4 w-4" />,
  [AUDIT_ACTION.ATTACHMENT_UPLOAD]: <Upload className="h-4 w-4" />,
  [AUDIT_ACTION.ATTACHMENT_DELETE]: <Trash2 className="h-4 w-4" />,
  [AUDIT_ACTION.TEAM_MEMBER_INVITE]: <UserPlus className="h-4 w-4" />,
  [AUDIT_ACTION.TEAM_MEMBER_REMOVE]: <UserMinus className="h-4 w-4" />,
  [AUDIT_ACTION.TEAM_ROLE_UPDATE]: <ShieldCheck className="h-4 w-4" />,
  [AUDIT_ACTION.SHARE_CREATE]: <LinkIcon className="h-4 w-4" />,
  [AUDIT_ACTION.SHARE_REVOKE]: <Link2Off className="h-4 w-4" />,
};

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

export default function TeamAuditLogsPage({
  params,
}: {
  params: Promise<{ teamId: string }>;
}) {
  const { teamId } = use(params);
  const t = useTranslations("AuditLog");
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

      // Member operations: show email
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
          icon={ACTION_ICONS[log.action as AuditActionValue] ?? <ScrollText className="h-4 w-4" />}
          actionLabel={getActionLabel(t as Parameters<typeof getActionLabel>[0], log.action, audit.actionLabel)}
          badges={
            user ? (
              <Avatar className="h-6 w-6 shrink-0">
                <AvatarImage src={user.image ?? undefined} />
                <AvatarFallback className="text-xs">
                  {user.name?.[0]?.toUpperCase() ?? "?"}
                </AvatarFallback>
              </Avatar>
            ) : undefined
          }
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
            <div className="flex flex-wrap items-end gap-3">
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
        </Card>

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
      </div>
    </div>
  );
}
