export function normalizeAuditActionKey(action: string): string {
  return action.startsWith("AuditLog.")
    ? action.slice("AuditLog.".length)
    : action;
}
