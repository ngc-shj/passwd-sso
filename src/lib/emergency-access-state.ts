import type { EmergencyAccessStatus } from "@prisma/client";
import { EA_STATUS } from "@/lib/constants";

const VALID_TRANSITIONS: Record<EmergencyAccessStatus, EmergencyAccessStatus[]> = {
  [EA_STATUS.PENDING]: [EA_STATUS.ACCEPTED, EA_STATUS.REJECTED, EA_STATUS.REVOKED],
  [EA_STATUS.ACCEPTED]: [EA_STATUS.IDLE, EA_STATUS.REVOKED],
  [EA_STATUS.IDLE]: [EA_STATUS.REQUESTED, EA_STATUS.STALE, EA_STATUS.REVOKED],
  [EA_STATUS.STALE]: [EA_STATUS.IDLE, EA_STATUS.REVOKED],
  [EA_STATUS.REQUESTED]: [EA_STATUS.ACTIVATED, EA_STATUS.IDLE, EA_STATUS.REVOKED],
  [EA_STATUS.ACTIVATED]: [EA_STATUS.STALE, EA_STATUS.REVOKED],
  [EA_STATUS.REVOKED]: [],
  [EA_STATUS.REJECTED]: [],
};

export function canTransition(
  from: EmergencyAccessStatus,
  to: EmergencyAccessStatus
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses that hold escrowed key data and can become STALE on keyVersion bump. */
export const STALE_ELIGIBLE_STATUSES: EmergencyAccessStatus[] = [EA_STATUS.IDLE, EA_STATUS.ACTIVATED];
