import { sendMessage } from "./messaging";
import { getSettings } from "./storage";

/**
 * Ensure the extension has host permission for the configured server URL.
 * Prompts the user if not already granted (optional_host_permissions).
 */
async function ensureHostPermission(serverUrl: string): Promise<boolean> {
  const origin = new URL(serverUrl).origin;
  const has = await chrome.permissions.contains({
    origins: [`${origin}/*`],
  });
  if (has) return true;

  return chrome.permissions.request({ origins: [`${origin}/*`] });
}

/**
 * Fetch with Bearer token from service worker.
 * Returns null if no token is available or host permission is denied.
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response | null> {
  const { token } = await sendMessage({ type: "GET_TOKEN" });
  if (!token) return null;

  const { serverUrl } = await getSettings();

  const granted = await ensureHostPermission(serverUrl);
  if (!granted) return null;

  const url = `${serverUrl}${path}`;

  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}
