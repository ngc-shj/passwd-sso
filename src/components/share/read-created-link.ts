import { readNonEmptyStringField } from "@/lib/http/read-body-field";

/**
 * The link and access password in a create response, or null when either is
 * missing. A password-protected link is useless without its password, so a
 * response lacking it counts as unreadable too.
 */
export function readCreatedLink(
  data: unknown,
  requirePassword: boolean,
): { url: string; accessPassword: string | null } | null {
  const url = readNonEmptyStringField(data, "url");
  if (url === null) return null;
  const accessPassword = readNonEmptyStringField(data, "accessPassword");
  if (accessPassword !== null) return { url, accessPassword };
  return requirePassword ? null : { url, accessPassword: null };
}
