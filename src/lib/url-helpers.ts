export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

/**
 * Resolve the canonical app origin from environment.
 * Priority: APP_URL > AUTH_URL.
 *
 * Returns the raw env value (may contain trailing slash or path).
 * Callers that need only the origin should use `new URL(url).origin`.
 *
 * Server-side only — reads process.env at call time for testability.
 */
export function getAppOrigin(): string | undefined {
  return process.env.APP_URL || process.env.AUTH_URL || undefined;
}

/**
 * Whether the app is served over HTTPS.
 * Determined by the AUTH_URL scheme — not NODE_ENV, which can be
 * "production" even on http://localhost via `npm start`.
 */
export const isHttps = (process.env.AUTH_URL ?? "http://localhost:3000").startsWith("https://");

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
  const origin = getAppOrigin() ?? "";
  return `${origin}${BASE_PATH}${path}`;
}
