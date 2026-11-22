"use client";

import { useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useTranslations } from "next-intl";
import { useVault } from "@/lib/vault/vault-context";
import { decryptData, type EncryptedData } from "@/lib/crypto/crypto-client";
import { buildPersonalEntryAAD, VAULT_TYPE } from "@/lib/crypto/crypto-aad";
import {
  API_PATH,
  AUDIT_ACTION,
  AUDIT_ACTION_GROUP,
  AUDIT_ACTION_GROUPS_PERSONAL,
  AUDIT_TARGET_TYPE,
} from "@/lib/constants";
import { formatUserName } from "@/lib/format/format-user";
import { useAuditDelegationLabel } from "@/components/audit/audit-delegation-detail";
import { useAuditLogs, type AuditLogItem } from "@/hooks/vault/use-audit-logs";
import { getCommonTargetLabel } from "@/lib/audit/audit-target-label";

type EntryOverviewMap = Record<
  string,
  { ciphertext: string; iv: string; authTag: string; aadVersion: number }
>;
type UserMap = Record<
  string,
  { id: string; name: string | null; email: string | null; image: string | null }
>;

export const PERSONAL_AUDIT_ACTION_GROUPS = [
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

/**
 * The personal audit log: the shared audit-log list state plus the personal
 * view's entry-name decryption and per-action detail labels.
 */
export function usePersonalAuditLogs() {
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
          const aad = ov.aadVersion >= 1 ? buildPersonalEntryAAD(userId, id, VAULT_TYPE.OVERVIEW) : undefined;
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

  const auditLogs = useAuditLogs({
    fetchEndpoint: API_PATH.AUDIT_LOGS,
    downloadEndpoint: "/api/audit-logs/download",
    downloadFilename: "audit-logs",
    actionGroups: PERSONAL_AUDIT_ACTION_GROUPS,
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
    const common = getCommonTargetLabel(t as never, log, auditLogs.entryNames, AUDIT_TARGET_TYPE.PASSWORD_ENTRY, "exportMeta");
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

  return { ...auditLogs, getEmergencyDetail, getTargetLabel };
}
