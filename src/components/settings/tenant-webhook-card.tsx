"use client";

import { useLocale } from "next-intl";
import { apiPath } from "@/lib/constants";
import {
  AUDIT_ACTION_GROUP,
  AUDIT_ACTION_GROUPS_TENANT,
  TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS,
} from "@/lib/constants/audit";
import { BaseWebhookCard } from "@/components/settings/base-webhook-card";

// Keep the same event group filtering logic at module level
const subscribableSet = new Set<string>(TENANT_WEBHOOK_SUBSCRIBABLE_ACTIONS);

const EVENT_GROUPS = Object.entries(AUDIT_ACTION_GROUPS_TENANT)
  .filter(([key]) => key !== AUDIT_ACTION_GROUP.TENANT_WEBHOOK)
  .map(([key, actions]) => ({
    key,
    actions: actions.filter((a) => subscribableSet.has(a)),
  }))
  .filter(({ actions }) => actions.length > 0);

const GROUP_LABEL_MAP: Record<string, string> = {
  [AUDIT_ACTION_GROUP.ADMIN]: "groupAdmin",
  [AUDIT_ACTION_GROUP.SCIM]: "groupScim",
  [AUDIT_ACTION_GROUP.DIRECTORY_SYNC]: "groupDirectorySync",
  [AUDIT_ACTION_GROUP.BREAKGLASS]: "groupBreakglass",
};

export function TenantWebhookCard() {
  const locale = useLocale();

  return (
    <BaseWebhookCard
      config={{
        listEndpoint: apiPath.tenantWebhooks(),
        createEndpoint: apiPath.tenantWebhooks(),
        deleteEndpoint: (id) => apiPath.tenantWebhookById(id),
        eventGroups: EVENT_GROUPS,
        groupLabelMap: GROUP_LABEL_MAP,
        i18nNamespace: "TenantWebhook",
        locale,
      }}
    />
  );
}
