import type { NotificationType } from "@prisma/client";

export const NOTIFICATION_TYPE = {
  SECURITY_ALERT: "SECURITY_ALERT",
  NEW_DEVICE_LOGIN: "NEW_DEVICE_LOGIN",
  EMERGENCY_ACCESS: "EMERGENCY_ACCESS",
  SHARE_ACCESS: "SHARE_ACCESS",
  TEAM_INVITE: "TEAM_INVITE",
  ENTRY_EXPIRING: "ENTRY_EXPIRING",
  WATCHTOWER_ALERT: "WATCHTOWER_ALERT",
  POLICY_UPDATE: "POLICY_UPDATE",
} as const satisfies Record<NotificationType, NotificationType>;

export type NotificationTypeValue =
  (typeof NOTIFICATION_TYPE)[keyof typeof NOTIFICATION_TYPE];

export const NOTIFICATION_TYPE_VALUES = Object.values(
  NOTIFICATION_TYPE,
) as NotificationTypeValue[];
