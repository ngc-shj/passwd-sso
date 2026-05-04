import { describe, test, expect } from "vitest";
import { EmergencyAccessStatus } from "@prisma/client";
import { MATRIX, canTransition } from "./emergency-access-state";
import { EA_STATUS, EA_ACTOR, type EaActor } from "@/lib/constants";

const ALL_STATUSES = Object.values(EmergencyAccessStatus) as EmergencyAccessStatus[];
const EA_ACTORS = Object.values(EA_ACTOR);
const allFromTos = ALL_STATUSES.flatMap((from) =>
  ALL_STATUSES.map((to) => [from, to] as const),
);

// EXPECTED_TRANSITIONS is the matrix-table from the plan, transcribed verbatim.
// Drift from the MATRIX implementation surfaces as a test failure (T15).
const EXPECTED_TRANSITIONS: Record<
  EmergencyAccessStatus,
  Record<EmergencyAccessStatus, ReadonlyArray<EaActor>>
> = {
  PENDING: {
    ACCEPTED: ["GRANTEE"],
    REJECTED: ["GRANTEE"],
    REVOKED: ["OWNER"],
    IDLE: [],
    STALE: [],
    REQUESTED: [],
    ACTIVATED: [],
    PENDING: [],
  },
  ACCEPTED: {
    IDLE: ["OWNER"],
    REVOKED: ["OWNER"],
    PENDING: [],
    REJECTED: [],
    STALE: [],
    REQUESTED: [],
    ACTIVATED: [],
    ACCEPTED: [],
  },
  IDLE: {
    REQUESTED: ["GRANTEE"],
    STALE: ["SYSTEM"],
    REVOKED: ["OWNER"],
    PENDING: [],
    ACCEPTED: [],
    REJECTED: [],
    ACTIVATED: [],
    IDLE: [],
  },
  STALE: {
    IDLE: ["OWNER"],
    REVOKED: ["OWNER"],
    PENDING: [],
    ACCEPTED: [],
    REJECTED: [],
    REQUESTED: [],
    ACTIVATED: [],
    STALE: [],
  },
  REQUESTED: {
    ACTIVATED: ["OWNER", "SYSTEM"],
    IDLE: ["OWNER"],
    STALE: ["SYSTEM"],
    REVOKED: ["OWNER"],
    PENDING: [],
    ACCEPTED: [],
    REJECTED: [],
    REQUESTED: [],
  },
  ACTIVATED: {
    STALE: ["SYSTEM"],
    REVOKED: ["OWNER"],
    PENDING: [],
    ACCEPTED: [],
    REJECTED: [],
    IDLE: [],
    REQUESTED: [],
    ACTIVATED: [],
  },
  REVOKED: {
    PENDING: [],
    ACCEPTED: [],
    REJECTED: [],
    IDLE: [],
    STALE: [],
    REQUESTED: [],
    ACTIVATED: [],
    REVOKED: [],
  },
  REJECTED: {
    PENDING: [],
    ACCEPTED: [],
    REJECTED: [],
    IDLE: [],
    STALE: [],
    REQUESTED: [],
    ACTIVATED: [],
    REVOKED: [],
  },
};

test.each(allFromTos)(
  "matrix permits exactly the documented (%s, %s, actor) tuples",
  (from, to) => {
    for (const actor of EA_ACTORS) {
      const expected = EXPECTED_TRANSITIONS[from][to].includes(actor);
      expect(canTransition(from, to, actor)).toBe(expected);
    }
  },
);

// Drift detector: EA_STATUS constant must stay in sync with the Prisma enum.
describe("EA_STATUS constant drift detector", () => {
  test("EA_STATUS values match EmergencyAccessStatus enum", () => {
    expect(Object.values(EA_STATUS).sort()).toEqual(ALL_STATUSES.sort());
  });
});

// PR #433/S1 invariant: REQUESTED → STALE must remain permitted for SYSTEM.
// Removing this row allows a grantee to wait out waitExpiresAt post-rotation
// and unwrap the owner's pre-rotation secretKey via the stale escrow.
describe("security invariants", () => {
  test("REQUESTED → STALE is permitted (SYSTEM) — PR #433/S1 invariant", () => {
    expect(canTransition("REQUESTED", "STALE", "SYSTEM")).toBe(true);
  });

  test("matrix derivation for (STALE, SYSTEM) yields the PR #433/S1 invariant set", () => {
    const derived = ALL_STATUSES.filter((from) =>
      MATRIX[from]["STALE"].includes("SYSTEM"),
    );
    expect(derived.sort()).toEqual(["IDLE", "REQUESTED", "ACTIVATED"].sort());
  });

  test("every EaActor value appears in at least one matrix cell", () => {
    for (const actor of EA_ACTORS) {
      const used = ALL_STATUSES.some((from) =>
        ALL_STATUSES.some((to) => MATRIX[from][to].includes(actor)),
      );
      expect(used, `${actor} must appear in matrix`).toBe(true);
    }
  });
});
