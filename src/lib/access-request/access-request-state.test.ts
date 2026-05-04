import { describe, test, expect } from "vitest";
import { AccessRequestStatus } from "@prisma/client";
import { MATRIX, canTransition, AR_ACTOR } from "./access-request-state";

const ALL_STATUSES = Object.values(AccessRequestStatus) as AccessRequestStatus[];
const AR_ACTORS = Object.values(AR_ACTOR);
const allFromTos = ALL_STATUSES.flatMap((from) =>
  ALL_STATUSES.map((to) => [from, to] as const),
);

// EXPECTED_TRANSITIONS is the matrix-table from the plan, transcribed verbatim.
// Drift from the MATRIX implementation surfaces as a test failure (T15).
const EXPECTED_TRANSITIONS: Record<
  AccessRequestStatus,
  Record<AccessRequestStatus, ReadonlyArray<ArActor>>
> = {
  PENDING: {
    APPROVED: ["ADMIN"],
    DENIED: ["ADMIN"],
    EXPIRED: ["SYSTEM"],
    PENDING: [],
  },
  APPROVED: {
    PENDING: [],
    APPROVED: [],
    DENIED: [],
    EXPIRED: [],
  },
  DENIED: {
    PENDING: [],
    APPROVED: [],
    DENIED: [],
    EXPIRED: [],
  },
  EXPIRED: {
    PENDING: [],
    APPROVED: [],
    DENIED: [],
    EXPIRED: [],
  },
};

test.each(allFromTos)(
  "matrix permits exactly the documented (%s, %s, actor) tuples",
  (from, to) => {
    for (const actor of AR_ACTORS) {
      const expected = EXPECTED_TRANSITIONS[from][to].includes(actor);
      expect(canTransition(from, to, actor)).toBe(expected);
    }
  },
);

describe("actor exhaustiveness", () => {
  test("every ArActor value appears in at least one matrix cell", () => {
    for (const actor of AR_ACTORS) {
      const used = ALL_STATUSES.some((from) =>
        ALL_STATUSES.some((to) => MATRIX[from][to].includes(actor)),
      );
      expect(used, `${actor} must appear in matrix`).toBe(true);
    }
  });
});

describe("terminal states", () => {
  test("APPROVED has no outgoing transitions", () => {
    for (const to of ALL_STATUSES) {
      for (const actor of AR_ACTORS) {
        expect(canTransition("APPROVED", to, actor)).toBe(false);
      }
    }
  });

  test("DENIED has no outgoing transitions", () => {
    for (const to of ALL_STATUSES) {
      for (const actor of AR_ACTORS) {
        expect(canTransition("DENIED", to, actor)).toBe(false);
      }
    }
  });

  test("EXPIRED has no outgoing transitions", () => {
    for (const to of ALL_STATUSES) {
      for (const actor of AR_ACTORS) {
        expect(canTransition("EXPIRED", to, actor)).toBe(false);
      }
    }
  });
});

// EXPIRED is registered in the matrix for a future cron; verify it accepts the transition.
describe("future EXPIRED cron readiness", () => {
  test("PENDING → EXPIRED is permitted for SYSTEM (future cron placeholder)", () => {
    expect(canTransition("PENDING", "EXPIRED", "SYSTEM")).toBe(true);
  });
});
