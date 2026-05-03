"use client";

import { TenantAuditLogCard } from "@/components/settings/account/tenant-audit-log-card";

// Break Glass page handles tenant-scoped emergency-grant data — opt out
// of caching to prevent accidental cross-tenant cache hits.
export const dynamic = "force-dynamic";

export default function TenantBreakglassPage() {
  return <TenantAuditLogCard variant="breakglass" />;
}
