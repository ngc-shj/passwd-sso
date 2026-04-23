"use client";

import { apiPath } from "@/lib/constants";
import {
  AUDIT_ACTION_GROUP,
  TEAM_WEBHOOK_EVENT_GROUPS,
} from "@/lib/constants/audit/audit";
import { BaseWebhookCard } from "@/components/settings/base-webhook-card";

const EVENT_GROUPS = Object.entries(TEAM_WEBHOOK_EVENT_GROUPS).map(
  ([key, actions]) => ({ key, actions }),
);

const GROUP_LABEL_MAP: Record<string, string> = {
  [AUDIT_ACTION_GROUP.ENTRY]: "groupEntry",
  [AUDIT_ACTION_GROUP.BULK]: "groupBulk",
  [AUDIT_ACTION_GROUP.TRANSFER]: "groupTransfer",
  [AUDIT_ACTION_GROUP.ATTACHMENT]: "groupAttachment",
  [AUDIT_ACTION_GROUP.FOLDER]: "groupFolder",
  [AUDIT_ACTION_GROUP.HISTORY]: "groupHistory",
  [AUDIT_ACTION_GROUP.TEAM]: "groupTeam",
  [AUDIT_ACTION_GROUP.SHARE]: "groupShare",
  [AUDIT_ACTION_GROUP.ADMIN]: "groupAdmin",
};

interface Props {
  teamId: string;
  locale: string;
}

export function TeamWebhookCard({ teamId, locale }: Props) {
  return (
    <BaseWebhookCard
      config={{
        listEndpoint: apiPath.teamWebhooks(teamId),
        createEndpoint: apiPath.teamWebhooks(teamId),
        deleteEndpoint: (id) => apiPath.teamWebhookById(teamId, id),
        eventGroups: EVENT_GROUPS,
        groupLabelMap: GROUP_LABEL_MAP,
        i18nNamespace: "TeamWebhook",
        locale,
        fetchDeps: [teamId],
      }}
    />
  );
}
