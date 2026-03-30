"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";

interface AuditActorTypeBadgeProps {
  actorType?: string;
}

export function AuditActorTypeBadge({ actorType }: AuditActorTypeBadgeProps) {
  const t = useTranslations("AuditLog");

  if (!actorType || actorType === "HUMAN") return null;

  return (
    <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4 shrink-0">
      {actorType === "SERVICE_ACCOUNT" ? t("actorTypeSa")
        : actorType === "MCP_AGENT" ? t("actorTypeMcp")
        : actorType}
    </Badge>
  );
}
