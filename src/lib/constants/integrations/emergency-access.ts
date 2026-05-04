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

export const EA_ACTOR = {
  OWNER: "OWNER",
  GRANTEE: "GRANTEE",
  SYSTEM: "SYSTEM",
} as const;

export type EaActor = (typeof EA_ACTOR)[keyof typeof EA_ACTOR];
