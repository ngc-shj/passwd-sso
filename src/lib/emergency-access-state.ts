import type { EmergencyAccessStatus } from "@prisma/client";

const VALID_TRANSITIONS: Record<EmergencyAccessStatus, EmergencyAccessStatus[]> = {
  PENDING: ["ACCEPTED", "REJECTED", "REVOKED"],
  ACCEPTED: ["IDLE", "REVOKED"],
  IDLE: ["REQUESTED", "STALE", "REVOKED"],
  STALE: ["IDLE", "REVOKED"],
  REQUESTED: ["ACTIVATED", "IDLE", "REVOKED"],
  ACTIVATED: ["STALE", "REVOKED"],
  REVOKED: [],
  REJECTED: [],
};

export function canTransition(
  from: EmergencyAccessStatus,
  to: EmergencyAccessStatus
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
