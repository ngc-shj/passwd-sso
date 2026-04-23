import { AUDIT_ACTION } from "@/lib/constants";

type TranslationFn = (key: never, params?: Record<string, unknown>) => string;

interface AuditLogEntry {
  action: string;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Returns the target label for common audit actions shared across
 * personal and team audit log pages.
 *
 * Returns a plain-text string (not HTML-safe — React escapes by default,
 * but callers outside JSX must escape manually).
 *
 * @param t - Translation function from useTranslations("AuditLog")
 * @param log - The audit log entry
 * @param entryNames - Resolved entry names (from decryption)
 * @param targetType - The target type to match for entry lookups (PASSWORD_ENTRY or TEAM_PASSWORD_ENTRY)
 * @param exportKey - The i18n key for export metadata ("exportMeta" for personal, "exportMetaTeam" for team)
 */
export function getCommonTargetLabel(
  t: TranslationFn,
  log: AuditLogEntry,
  entryNames: Map<string, string> | Record<string, string>,
  targetType: string,
  exportKey: "exportMeta" | "exportMetaTeam" = "exportMeta",
): string | null {
  const meta = log.metadata && typeof log.metadata === "object"
    ? (log.metadata as Record<string, unknown>)
    : null;

  if (log.action === AUDIT_ACTION.ENTRY_BULK_TRASH && meta) {
    const requestedCount = typeof meta.requestedCount === "number" ? meta.requestedCount : 0;
    const movedCount = typeof meta.movedCount === "number" ? meta.movedCount : 0;
    const notMovedCount = Math.max(0, requestedCount - movedCount);
    return t("bulkTrashMeta" as never, { requestedCount, movedCount, notMovedCount });
  }

  if (log.action === AUDIT_ACTION.ENTRY_EMPTY_TRASH && meta) {
    const deletedCount = typeof meta.deletedCount === "number" ? meta.deletedCount : 0;
    return t("emptyTrashMeta" as never, { deletedCount });
  }

  if (log.action === AUDIT_ACTION.ENTRY_BULK_ARCHIVE && meta) {
    const requestedCount = typeof meta.requestedCount === "number" ? meta.requestedCount : 0;
    const archivedCount = typeof meta.archivedCount === "number" ? meta.archivedCount : 0;
    const notArchivedCount = Math.max(0, requestedCount - archivedCount);
    return t("bulkArchiveMeta" as never, { requestedCount, archivedCount, notArchivedCount });
  }

  if (log.action === AUDIT_ACTION.ENTRY_BULK_UNARCHIVE && meta) {
    const requestedCount = typeof meta.requestedCount === "number" ? meta.requestedCount : 0;
    const unarchivedCount = typeof meta.unarchivedCount === "number" ? meta.unarchivedCount : 0;
    const alreadyActiveCount = Math.max(0, requestedCount - unarchivedCount);
    return t("bulkUnarchiveMeta" as never, { requestedCount, unarchivedCount, alreadyActiveCount });
  }

  if (log.action === AUDIT_ACTION.ENTRY_BULK_RESTORE && meta) {
    const requestedCount = typeof meta.requestedCount === "number" ? meta.requestedCount : 0;
    const restoredCount = typeof meta.restoredCount === "number" ? meta.restoredCount : 0;
    const notRestoredCount = Math.max(0, requestedCount - restoredCount);
    return t("bulkRestoreMeta" as never, { requestedCount, restoredCount, notRestoredCount });
  }

  if (log.action === AUDIT_ACTION.ENTRY_IMPORT && meta) {
    const requestedCount = typeof meta.requestedCount === "number" ? meta.requestedCount : 0;
    const successCount = typeof meta.successCount === "number" ? meta.successCount : 0;
    const failedCount = typeof meta.failedCount === "number" ? meta.failedCount : 0;
    const filename = typeof meta.filename === "string" ? meta.filename : "-";
    const format = typeof meta.format === "string" ? meta.format : "-";
    const encrypted = meta.encrypted === true;
    return t("importMeta" as never, {
      requestedCount, successCount, failedCount,
      filename, format,
      encrypted: encrypted ? t("yes" as never) : t("no" as never),
    });
  }

  if (log.action === AUDIT_ACTION.ENTRY_EXPORT && meta) {
    const filename = typeof meta.filename === "string" ? meta.filename : null;
    const encrypted = meta.encrypted === true;
    const format = typeof meta.format === "string" ? meta.format : "-";
    const entryCount = typeof meta.entryCount === "number" ? meta.entryCount : 0;

    if (exportKey === "exportMeta") {
      const includeTeams = meta.includeTeams === true;
      return t("exportMeta" as never, {
        filename: filename ?? "-", format, entryCount,
        encrypted: encrypted ? t("yes" as never) : t("no" as never),
        teams: includeTeams ? t("included" as never) : t("notIncluded" as never),
      });
    }
    return t("exportMetaTeam" as never, {
      filename: filename ?? "-", format, entryCount,
      encrypted: encrypted ? t("yes" as never) : t("no" as never),
    });
  }

  // Entry operations: show resolved entry name
  if (log.targetType === targetType && log.targetId) {
    const name = entryNames instanceof Map
      ? entryNames.get(log.targetId)
      : entryNames[log.targetId];
    if (name) {
      if (
        log.action === AUDIT_ACTION.ENTRY_PERMANENT_DELETE ||
        (log.action === AUDIT_ACTION.ENTRY_DELETE && meta?.permanent === true)
      ) {
        return `${name}（${t("permanentDelete" as never)}）`;
      }
      return name;
    }
    return t("deletedEntry" as never);
  }

  // Attachment operations: show filename
  if (meta?.filename) {
    return String(meta.filename);
  }

  // Role updates: show role change
  if (log.action === AUDIT_ACTION.TEAM_ROLE_UPDATE && meta?.previousRole && meta?.newRole) {
    return t("roleChange" as never, {
      from: String(meta.previousRole),
      to: String(meta.newRole),
    });
  }

  return null;
}
