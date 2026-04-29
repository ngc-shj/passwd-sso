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

// Inverse of VALID_TRANSITIONS: for each `to` status, the set of `from` statuses
// from which the transition is permitted. Used by route handlers to express
// the CAS constraint in `updateMany({ where: { id, status: { in: ... } } })`,
// closing the read→check→write race window in `canTransition`-based handlers.
const FROM_STATUSES_FOR: Record<EmergencyAccessStatus, EmergencyAccessStatus[]> = (() => {
  const inverse: Partial<Record<EmergencyAccessStatus, EmergencyAccessStatus[]>> = {};
  for (const [from, tos] of Object.entries(VALID_TRANSITIONS) as [
    EmergencyAccessStatus,
    EmergencyAccessStatus[],
  ][]) {
    for (const to of tos) {
      (inverse[to] ??= []).push(from);
    }
  }
  return inverse as Record<EmergencyAccessStatus, EmergencyAccessStatus[]>;
})();

export function fromStatusesFor(to: EmergencyAccessStatus): EmergencyAccessStatus[] {
  return FROM_STATUSES_FOR[to] ?? [];
}

/** Statuses that hold escrowed key data and can become STALE on keyVersion bump. */
export const STALE_ELIGIBLE_STATUSES: EmergencyAccessStatus[] = [EA_STATUS.IDLE, EA_STATUS.ACTIVATED];
