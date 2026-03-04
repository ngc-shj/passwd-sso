export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

/**
 * Prepend basePath to a path (for fetch, window.location.href, etc.).
 * Client-side only — do NOT use inside server-side route handlers.
 */
export function withBasePath(path: string): string {
  if (process.env.NODE_ENV !== "production" && path && !path.startsWith("/")) {
    console.warn(`withBasePath: path should start with "/", got "${path}"`);
  }
  return `${BASE_PATH}${path}`;
}

/**
 * Fetch wrapper that automatically prepends basePath.
 * Client-side only — do NOT use inside server-side route handlers.
 */
export function fetchApi(path: string, init?: RequestInit): Promise<Response> {
  if (typeof window === "undefined") {
    throw new Error("fetchApi is client-only. Use absolute URLs on the server.");
  }
  const url = withBasePath(path);
  return init !== undefined ? fetch(url, init) : fetch(url);
}

/**
 * Build a full URL (origin + basePath + path) for clipboard / sharing.
 * Browser-only (references window.location.origin).
 */
export function appUrl(path: string): string {
  return `${window.location.origin}${BASE_PATH}${path}`;
}

/**
 * Build a full URL (APP_URL + basePath + path) for server-side use
 * (e.g. email links). Uses APP_URL/AUTH_URL env vars instead of window.
 */
export function serverAppUrl(path: string): string {
  const origin = process.env.APP_URL || process.env.AUTH_URL || "";
  return `${origin}${BASE_PATH}${path}`;
}
