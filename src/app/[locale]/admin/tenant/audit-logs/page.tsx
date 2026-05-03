"use client";

import { TenantAuditLogCard } from "@/components/settings/account/tenant-audit-log-card";

// Audit logs are tenant-scoped sensitive data — opt out of caching to
// prevent any accidental ISR/CDN cache from serving cross-tenant content.
export const dynamic = "force-dynamic";

export default function TenantAuditLogsPage() {
  return <TenantAuditLogCard variant="logs" />;
}
