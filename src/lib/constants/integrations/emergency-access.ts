import type { EmergencyAccessStatus } from "@prisma/client";

export const EA_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  IDLE: "IDLE",
  STALE: "STALE",
  REQUESTED: "REQUESTED",
  ACTIVATED: "ACTIVATED",
  REVOKED: "REVOKED",
  REJECTED: "REJECTED",
} as const satisfies Record<EmergencyAccessStatus, EmergencyAccessStatus>;

export type EaStatusValue = EmergencyAccessStatus;
