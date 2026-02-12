import { sendMessage } from "./messaging";
import { getSettings } from "./storage";

/**
 * Ensure the extension has host permission for the configured server URL.
 * Prompts the user if not already granted (optional_host_permissions).
 */
export async function ensureHostPermission(serverUrl: string): Promise<boolean> {
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

  let origin: string;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return null;
  }
  const url = `${origin}${path}`;

  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${token}`,
    },
  });
}
