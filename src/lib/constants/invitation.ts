import type { InvitationStatus } from "@prisma/client";

export const INVITATION_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
  EXPIRED: "EXPIRED",
} as const satisfies Record<InvitationStatus, InvitationStatus>;

export type InvitationStatusValue = InvitationStatus;
