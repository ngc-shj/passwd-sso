export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || "";

/**
 * Prepend basePath to a path (for fetch, window.location.href, etc.).
 * Client-side only — do NOT use inside server-side route handlers.
 */
export function withBasePath(path: string): string {
  return `${BASE_PATH}${path}`;
}

/**
 * Fetch wrapper that automatically prepends basePath.
 * Client-side only — do NOT use inside server-side route handlers.
 */
export function fetchApi(path: string, init?: RequestInit): Promise<Response> {
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
