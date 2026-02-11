import type { EmergencyAccessStatus } from "@prisma/client";

const VALID_TRANSITIONS: Record<EmergencyAccessStatus, EmergencyAccessStatus[]> = {
  PENDING: ["ACCEPTED", "REJECTED", "REVOKED"],
  ACCEPTED: ["IDLE", "REVOKED"],
  IDLE: ["REQUESTED", "REVOKED"],
  REQUESTED: ["ACTIVATED", "IDLE", "REVOKED"],
  ACTIVATED: ["IDLE", "REVOKED"],
  REVOKED: [],
  REJECTED: [],
};

export function canTransition(
  from: EmergencyAccessStatus,
  to: EmergencyAccessStatus
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
