import { isAllowedServerUrl } from "./server-url";

/**
 * Ensure the extension has host permission for the configured server URL.
 * Prompts the user if not already granted (optional_host_permissions). A URL
 * the server-URL rule refuses (plain http off localhost) is never requested.
 */
export async function ensureHostPermission(serverUrl: string): Promise<boolean> {
  if (!isAllowedServerUrl(serverUrl)) return false;
  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return false;
  }
  const has = await chrome.permissions.contains({
    origins: [`${origin}/*`],
  });
  if (has) return true;

  return chrome.permissions.request({ origins: [`${origin}/*`] });
}
