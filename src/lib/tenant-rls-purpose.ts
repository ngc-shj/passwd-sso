// A leaf module so that both tenant-rls.ts and tenant-rls-grants.ts can import
// the purposes without importing each other. tenant-rls.ts re-exports them, so
// existing `@/lib/tenant-rls` imports keep working.

export const BYPASS_PURPOSE = {
  AUTH_FLOW: "auth_flow",
  CROSS_TENANT_LOOKUP: "cross_tenant_lookup",
  SYSTEM_MAINTENANCE: "system_maintenance",
  AUDIT_WRITE: "audit_write",
  WEBHOOK_DISPATCH: "webhook_dispatch",
  TOKEN_LIFECYCLE: "token_lifecycle",
  AUDIT_ANCHOR_PUBLISH: "audit-anchor-publish",
} as const;

export type BypassPurpose = (typeof BYPASS_PURPOSE)[keyof typeof BYPASS_PURPOSE];

// Database-side purpose, not a BypassPurpose: "share_admission" is set inside
// public.share_creator_admitted(uuid) for the duration of its call (migrations
// 20261102000000, 20261108000000), never by TypeScript. Recorded here so the full set of
// purposes that can appear in an rls_bypass_not_granted report stays in one place.
