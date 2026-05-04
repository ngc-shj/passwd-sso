import type { AccessRequestStatus } from "@prisma/client";

export const AR_STATUS = {
  PENDING: "PENDING",
  APPROVED: "APPROVED",
  DENIED: "DENIED",
  EXPIRED: "EXPIRED",
} as const satisfies Record<AccessRequestStatus, AccessRequestStatus>;

export type ArStatusValue = AccessRequestStatus;

export const AR_ACTOR = {
  ADMIN: "ADMIN",
  SYSTEM: "SYSTEM",
} as const;

export type ArActor = (typeof AR_ACTOR)[keyof typeof AR_ACTOR];
