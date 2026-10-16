export const DEFAULT_SERVER_URL = "https://localhost:3000";

/**
 * The server URL rule: https, or http only on localhost / 127.0.0.1. The
 * options page validates input with it, and every path that turns the stored
 * serverUrl into a host-permission request or a fetch checks it again, since
 * `http://*` in optional_host_permissions would otherwise let a stored plain
 * http URL be granted and talked to.
 */
export function validateServerUrl(raw: string): { ok: boolean; value: string; error?: string } {
  const trimmed = raw.trim() || DEFAULT_SERVER_URL;
  try {
    const url = new URL(trimmed);
    const isLocalhost =
      url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
      return { ok: false, value: trimmed, error: "HTTPS_REQUIRED" };
    }
    // Reject double slashes in the path (e.g. https://example.com//path)
    if (/\/\//.test(url.pathname)) {
      return { ok: false, value: trimmed, error: "INVALID_URL" };
    }
    // Strip trailing slash; URL constructor lowercases scheme/host and strips default port.
    const path = url.pathname.replace(/\/+$/, "");
    return { ok: true, value: `${url.origin}${path}` };
  } catch {
    return { ok: false, value: trimmed, error: "INVALID_URL" };
  }
}

/** Whether a stored serverUrl may be granted or fetched (no empty-input default). */
export function isAllowedServerUrl(raw: unknown): raw is string {
  return typeof raw === "string" && raw.trim() !== "" && validateServerUrl(raw).ok;
}
