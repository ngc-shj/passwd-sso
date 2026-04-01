"use client";

import { useLocale } from "next-intl";
import { apiPath } from "@/lib/constants";
import {
  AUDIT_ACTION_GROUP,
  TENANT_WEBHOOK_EVENT_GROUPS,
} from "@/lib/constants/audit";
import { BaseWebhookCard } from "@/components/settings/base-webhook-card";

const EVENT_GROUPS = Object.entries(TENANT_WEBHOOK_EVENT_GROUPS).map(
  ([key, actions]) => ({ key, actions }),
);

const GROUP_LABEL_MAP: Record<string, string> = {
  [AUDIT_ACTION_GROUP.ADMIN]: "groupAdmin",
  [AUDIT_ACTION_GROUP.SCIM]: "groupScim",
  [AUDIT_ACTION_GROUP.DIRECTORY_SYNC]: "groupDirectorySync",
  [AUDIT_ACTION_GROUP.BREAKGLASS]: "groupBreakglass",
  [AUDIT_ACTION_GROUP.SERVICE_ACCOUNT]: "groupServiceAccount",
  [AUDIT_ACTION_GROUP.MCP_CLIENT]: "groupMcpClient",
  [AUDIT_ACTION_GROUP.DELEGATION]: "groupDelegation",
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
