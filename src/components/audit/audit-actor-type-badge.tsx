"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { resolveActorDisplay } from "@/lib/audit-display";

interface AuditActorTypeBadgeProps {
  actorType?: string;
  userId?: string;
}

export function AuditActorTypeBadge({ actorType, userId }: AuditActorTypeBadgeProps) {
  const t = useTranslations("AuditLog");

  // Sentinel UUIDs override actorType-based rendering
  if (userId) {
    const { i18nKey, isSentinel } = resolveActorDisplay(userId);
    if (isSentinel && i18nKey) {
      return (
        <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
          {t(i18nKey)}
        </Badge>
      );
    }
  }

  if (!actorType || actorType === "HUMAN") return null;

  const key =
    actorType === "SERVICE_ACCOUNT" ? "actorTypeSa"
    : actorType === "MCP_AGENT" ? "actorTypeMcp"
    : actorType === "SYSTEM" ? "actorTypeSystem"
    : actorType === "ANONYMOUS" ? "actorTypeAnonymous"
    : null;

  return (
    <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
      {key ? t(key) : actorType}
    </Badge>
  );
}
