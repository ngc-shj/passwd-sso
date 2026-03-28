"use client";

import { useTranslations } from "next-intl";

/**
 * Resolve delegation audit log detail text.
 * Used by both personal and tenant audit log views.
 */
export function useDelegationAuditLabel() {
  const t = useTranslations("AuditLog");

  return function getDelegationLabel(
    action: string,
    metadata: Record<string, unknown> | null,
  ): string | null {
    if (!metadata) return null;
    const entryCount = typeof metadata.entryCount === "number" ? metadata.entryCount : 0;

    if (action === "DELEGATION_READ" && metadata.tool === "list") {
      return t("delegationListMeta", { entryCount });
    }
    if (action === "DELEGATION_READ" && metadata.tool === "search") {
      const query = typeof metadata.query === "string" ? metadata.query : "";
      return query
        ? t("delegationSearchMeta", { query, entryCount })
        : t("delegationListMeta", { entryCount });
    }
    if (action === "DELEGATION_READ" && metadata.tool === "get") {
      return t("delegationGetMeta");
    }
    if (action === "DELEGATION_CREATE") {
      return t("delegationCreateMeta", { entryCount });
    }
    if (action === "DELEGATION_REVOKE") {
      const revokedCount = typeof metadata.revokedCount === "number" ? metadata.revokedCount : 1;
      const reason = typeof metadata.reason === "string" ? metadata.reason : "manual";
      return t("delegationRevokeMeta", { revokedCount, reason });
    }
    return null;
  };
}

interface Props {
  action: string;
  metadata: Record<string, unknown> | null;
}

export function DelegationAuditDetail({ action, metadata }: Props) {
  const getLabel = useDelegationAuditLabel();
  const label = getLabel(action, metadata);
  if (!label) return null;
  return <p className="text-xs text-muted-foreground">{label}</p>;
}
