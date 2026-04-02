"use client";

import { useState, useCallback } from "react";
import { useSession } from "next-auth/react";
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
import { useVault } from "@/lib/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto-client";
import { buildPersonalEntryAAD } from "@/lib/crypto-aad";
import {
  API_PATH,
  AUDIT_ACTION,
  AUDIT_ACTION_EMERGENCY_PREFIX,
  AUDIT_ACTION_GROUP,
  AUDIT_ACTION_GROUPS_PERSONAL,
  AUDIT_TARGET_TYPE,
  type AuditActionValue,
} from "@/lib/constants";
import { formatUserName } from "@/lib/format-user";
import { useAuditDelegationLabel } from "@/components/audit/audit-delegation-detail";
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

type EntryOverviewMap = Record<
  string,
  { ciphertext: string; iv: string; authTag: string; aadVersion: number }
>;
type UserMap = Record<
  string,
  { id: string; name: string | null; email: string | null; image: string | null }
>;

const ACTION_GROUPS = [
  { label: "groupAuth", value: AUDIT_ACTION_GROUP.AUTH, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.AUTH] },
  { label: "groupEntry", value: AUDIT_ACTION_GROUP.ENTRY, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.ENTRY] },
  { label: "groupBulk", value: AUDIT_ACTION_GROUP.BULK, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.BULK] },
  { label: "groupTransfer", value: AUDIT_ACTION_GROUP.TRANSFER, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.TRANSFER] },
  { label: "groupAttachment", value: AUDIT_ACTION_GROUP.ATTACHMENT, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.ATTACHMENT] },
  { label: "groupTeam", value: AUDIT_ACTION_GROUP.TEAM, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.TEAM] },
  { label: "groupShare", value: AUDIT_ACTION_GROUP.SHARE, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.SHARE] },
  { label: "groupSend", value: AUDIT_ACTION_GROUP.SEND, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.SEND] },
  { label: "groupEmergency", value: AUDIT_ACTION_GROUP.EMERGENCY, actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.EMERGENCY] },
  ...(AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.DELEGATION] ? [{
    label: "groupDelegation" as const,
    value: AUDIT_ACTION_GROUP.DELEGATION,
    actions: AUDIT_ACTION_GROUPS_PERSONAL[AUDIT_ACTION_GROUP.DELEGATION],
  }] : []),
] as const;

export default function AuditLogsPage() {
  const t = useTranslations("AuditLog");
  const { data: session } = useSession();
  const { encryptionKey } = useVault();
  const [relatedUsers, setRelatedUsers] = useState<UserMap>({});
  const getDelegationLabel = useAuditDelegationLabel();

  const resolveEntryNames = useCallback(
    async (data: unknown) => {
      const overviews = (data as { entryOverviews?: EntryOverviewMap })?.entryOverviews;
      if (!overviews || !encryptionKey || !session?.user?.id) return new Map<string, string>();
      const userId = session.user.id;
      const names = new Map<string, string>();
      for (const [id, ov] of Object.entries(overviews)) {
        try {
          const aad = ov.aadVersion >= 1 ? buildPersonalEntryAAD(userId, id) : undefined;
          const overview = JSON.parse(
            await decryptData(ov as EncryptedData, encryptionKey, aad)
          );
          names.set(id, overview.title);
        } catch {
          // Decryption failed — skip
        }
      }
      return names;
    },
    [encryptionKey, session]
  );

  const onDataReceived = useCallback((data: unknown) => {
    const users = (data as { relatedUsers?: UserMap })?.relatedUsers;
    if (users) {
      setRelatedUsers((prev) => ({ ...prev, ...users }));
    }
  }, []);

  const {
    logs, loading, loadingMore, nextCursor, entryNames, downloading,
    selectedActions, actionSearch, dateFrom, dateTo, filterOpen, actorTypeFilter,
    setActionSearch, setDateFrom, setDateTo, setFilterOpen, setActorTypeFilter,
    toggleAction, setGroupSelection, clearActions,
    actionSummary, filteredActions, actionLabel, isActionSelected, formatDate,
    handleLoadMore, handleDownload,
  } = useAuditLogs({
    fetchEndpoint: API_PATH.AUDIT_LOGS,
    downloadEndpoint: "/api/audit-logs/download",
    downloadFilename: "audit-logs",
    actionGroups: ACTION_GROUPS,
    resolveEntryNames,
    onDataReceived,
  });

  const resolveUser = (id?: string, fallbackEmail?: string | null) => {
    if (id && relatedUsers[id]) {
      return formatUserName(relatedUsers[id], "") || null;
    }
    if (fallbackEmail) return fallbackEmail;
    return null;
  };

  const getEmergencyDetail = (log: AuditLogItem): string | null => {
    const meta = log.metadata as { ownerId?: string; granteeId?: string; granteeEmail?: string; permanent?: boolean; entryCount?: number } | null;
    const owner = resolveUser(meta?.ownerId) ?? t("unknownUser");
    const grantee = resolveUser(meta?.granteeId, meta?.granteeEmail ?? null) ?? t("unknownUser");
    const viewer = (log.user ? formatUserName(log.user, "") || null : null) ?? t("unknownUser");

    switch (log.action) {
      case AUDIT_ACTION.EMERGENCY_GRANT_CREATE:
        return t("eaGrantCreatedFor", { user: grantee });
      case AUDIT_ACTION.EMERGENCY_GRANT_ACCEPT:
        return t("eaGrantAcceptedBy", { viewer, owner });
      case AUDIT_ACTION.EMERGENCY_GRANT_REJECT:
        return t("eaGrantRejectedBy", { viewer, owner });
      case AUDIT_ACTION.EMERGENCY_GRANT_CONFIRM:
        return t("eaGrantConfirmedFor", { user: grantee });
      case AUDIT_ACTION.EMERGENCY_ACCESS_REQUEST:
        return t("eaAccessRequestedBy", { viewer, owner });
      case AUDIT_ACTION.EMERGENCY_ACCESS_ACTIVATE:
        return t("eaAccessActivatedFor", { user: meta?.granteeId ? grantee : owner });
      case AUDIT_ACTION.EMERGENCY_ACCESS_REVOKE:
        return t("eaAccessRevokedFor", { user: grantee });
      case AUDIT_ACTION.EMERGENCY_VAULT_ACCESS: {
        const base = t("viewedByOwner", { viewer, owner });
        const entryCount = typeof meta?.entryCount === "number" ? meta.entryCount : null;
        return entryCount !== null
          ? `${base} — ${t("eaVaultAccessMeta", { entryCount })}`
          : base;
      }
      default:
        return null;
    }
  };

  const getTargetLabel = (log: AuditLogItem): string | null => {
    const common = getCommonTargetLabel(t as never, log, entryNames, AUDIT_TARGET_TYPE.PASSWORD_ENTRY, "exportMeta");
    if (common !== null) return common;

    const meta = log.metadata && typeof log.metadata === "object"
      ? (log.metadata as Record<string, unknown>)
      : null;

    // Auth login: show provider
    if (log.action === AUDIT_ACTION.AUTH_LOGIN && meta?.provider) {
      return t("providerMeta", { provider: String(meta.provider) });
    }

    // Vault unlock failed: show attempts
    if (log.action === AUDIT_ACTION.VAULT_UNLOCK_FAILED && typeof meta?.attempts === "number") {
      return t("attemptsMeta", { attempts: meta.attempts });
    }

    // Vault lockout: show attempts and lock duration
    if (log.action === AUDIT_ACTION.VAULT_LOCKOUT_TRIGGERED && meta) {
      const attempts = typeof meta.attempts === "number" ? meta.attempts : 0;
      const lockMinutes = typeof meta.lockMinutes === "number" ? meta.lockMinutes : 0;
      return t("lockoutMeta", { attempts, lockMinutes });
    }

    // Delegation: show tool-specific detail
    const delegationLabel = getDelegationLabel(log.action, meta);
    if (delegationLabel) return delegationLabel;

    // Session revoke all: show revoked count
    if (log.action === AUDIT_ACTION.SESSION_REVOKE_ALL && typeof meta?.revokedCount === "number") {
      return t("revokedSessionsMeta", { revokedCount: meta.revokedCount });
    }

    // Vault reset: show deleted counts
    if (log.action === AUDIT_ACTION.VAULT_RESET_EXECUTED && meta) {
      const deletedEntries = typeof meta.deletedEntries === "number" ? meta.deletedEntries : 0;
      const deletedAttachments = typeof meta.deletedAttachments === "number" ? meta.deletedAttachments : 0;
      return t("vaultResetMeta", { deletedEntries, deletedAttachments });
    }

    return null;
  };

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
        badges={<AuditActorTypeBadge actorType={log.actorType} />}
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
