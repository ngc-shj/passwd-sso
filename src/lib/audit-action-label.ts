import { AUDIT_ACTION } from "@/lib/constants";

type TranslationFn = {
  (key: never): string;
  has(key: never): boolean;
};

/**
 * Returns the display label for an audit action, with special handling
 * for bulk/trash actions that need explicit translation keys.
 * Used by personal and team audit log pages.
 *
 * @param t - Translation function from useTranslations("AuditLog")
 * @param action - The audit action string
 * @param actionLabel - The fallback label resolver (normalizeAuditActionKey-based)
 */
export function getActionLabel(
  t: TranslationFn,
  action: string,
  actionLabel: (action: string) => string,
): string {
  switch (action) {
    case AUDIT_ACTION.ENTRY_BULK_TRASH:
      return t("ENTRY_BULK_TRASH" as never);
    case AUDIT_ACTION.ENTRY_EMPTY_TRASH:
      return t("ENTRY_EMPTY_TRASH" as never);
    case AUDIT_ACTION.ENTRY_BULK_ARCHIVE:
      return t("ENTRY_BULK_ARCHIVE" as never);
    case AUDIT_ACTION.ENTRY_BULK_UNARCHIVE:
      return t("ENTRY_BULK_UNARCHIVE" as never);
    case AUDIT_ACTION.ENTRY_BULK_RESTORE:
      return t("ENTRY_BULK_RESTORE" as never);
    case AUDIT_ACTION.ENTRY_TRASH:
      return t("ENTRY_TRASH" as never);
    case AUDIT_ACTION.ENTRY_PERMANENT_DELETE:
      return t("ENTRY_PERMANENT_DELETE" as never);
    default:
      return actionLabel(action);
  }
}
