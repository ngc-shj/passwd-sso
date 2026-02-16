/**
 * Application display name.
 *
 * Configurable via `NEXT_PUBLIC_APP_NAME` environment variable.
 * Falls back to "passwd-sso" when unset.
 */
export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "passwd-sso";
