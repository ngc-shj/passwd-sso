// Sunset = 30 days post-deploy. Update at PR-merge time.
// CI freshness assertion in migration-banner-config.test.ts ensures this stays fresh.
export const BANNER_SUNSET_TS = new Date("2026-06-15T00:00:00Z");
export const BANNER_DISMISS_KEY = "psso:settings-ia-redesign-banner-dismissed";
