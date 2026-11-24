import { describe, test, expect, vi } from "vitest";
import { AccessRequestStatus, type Prisma } from "@prisma/client";
import { tenantRlsStorage } from "@/lib/tenant-rls";
import {
  MATRIX,
  canTransition,
  transition,
  bulkTransition,
  AR_ACTOR,
  AR_STATUS,
  type ArActor,
} from "./access-request-state";

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

describe("transition() return-value strictness", () => {
  function makeDb(updateManyCount: number) {
    return {
      accessRequest: {
        updateMany: vi.fn().mockResolvedValue({ count: updateManyCount }),
      },
    } as unknown as Parameters<typeof transition>[0]["db"];
  }

  test("count === 1 returns ok:true", async () => {
    const result = await transition({
      db: makeDb(1),
      where: { id: "req-1", tenantId: "tenant-1" },
      to: AR_STATUS.APPROVED,
      actor: AR_ACTOR.ADMIN,
    });
    expect(result).toEqual({ ok: true });
  });

  test("count === 0 returns ok:false", async () => {
    const result = await transition({
      db: makeDb(0),
      where: { id: "req-1", tenantId: "tenant-1" },
      to: AR_STATUS.APPROVED,
      actor: AR_ACTOR.ADMIN,
    });
    expect(result).toEqual({ ok: false });
  });

  test("count > 1 throws — non-unique where is a programmer error", async () => {
    await expect(
      transition({
        db: makeDb(2),
        where: { tenantId: "tenant-1" },
        to: AR_STATUS.APPROVED,
        actor: AR_ACTOR.ADMIN,
      }),
    ).rejects.toThrow(/where matched >1 row/);
  });
});

// Recording db fake: captures the updateMany arguments so the tests can pin
// the from-status filter and the data written.
function makeRecordingDb(count: number) {
  const calls: Array<{ where: Prisma.AccessRequestWhereInput; data: Prisma.AccessRequestUncheckedUpdateManyInput }> = [];
  const db = {
    accessRequest: {
      updateMany: async (args: (typeof calls)[number]) => {
        calls.push(args);
        return { count };
      },
    },
  } as unknown as Parameters<typeof transition>[0]["db"];
  return { db, calls };
}

function underBypass<T>(fn: () => Promise<T>): Promise<T> {
  return tenantRlsStorage.run(
    { tx: {} as Prisma.TransactionClient, tenantId: null, bypass: true, refusedNesting: false },
    fn,
  );
}

describe("transition() filter and refusal arms", () => {
  test("restricts the update to the statuses the actor may leave", async () => {
    const { db, calls } = makeRecordingDb(1);
    await transition({
      db,
      where: { id: "req-1" },
      to: AR_STATUS.APPROVED,
      actor: AR_ACTOR.ADMIN,
      extraData: { approvedById: "admin-1" },
    });
    expect(calls).toEqual([
      {
        where: { id: "req-1", status: { in: [AR_STATUS.PENDING] } },
        data: { approvedById: "admin-1", status: AR_STATUS.APPROVED },
      },
    ]);
  });

  test("refuses a transition no actor may make, without writing", async () => {
    const { db, calls } = makeRecordingDb(1);
    const result = await transition({ db, where: { id: "req-1" }, to: AR_STATUS.PENDING, actor: AR_ACTOR.ADMIN });
    expect(result).toEqual({ ok: false });
    expect(calls).toEqual([]);
  });

  test("refuses SYSTEM approving a request, without writing", async () => {
    const { db, calls } = makeRecordingDb(1);
    const result = await transition({ db, where: { id: "req-1" }, to: AR_STATUS.APPROVED, actor: AR_ACTOR.SYSTEM });
    expect(result).toEqual({ ok: false });
    expect(calls).toEqual([]);
  });

  test("throws under bypass RLS when where lacks tenantId, without writing", async () => {
    const { db, calls } = makeRecordingDb(1);
    await expect(
      underBypass(() => transition({ db, where: { id: "req-1" }, to: AR_STATUS.APPROVED, actor: AR_ACTOR.ADMIN })),
    ).rejects.toThrow(/under withBypassRls, where must include/);
    expect(calls).toEqual([]);
  });

  test("proceeds under bypass RLS when where carries tenantId", async () => {
    const { db, calls } = makeRecordingDb(1);
    const result = await underBypass(() =>
      transition({ db, where: { id: "req-1", tenantId: "t-1" }, to: AR_STATUS.APPROVED, actor: AR_ACTOR.ADMIN }),
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
  });
});

describe("bulkTransition()", () => {
  test("returns the updated row count and filters by allowed from-statuses", async () => {
    const { db, calls } = makeRecordingDb(3);
    const result = await bulkTransition({
      db,
      where: { tenantId: "t-1" },
      to: AR_STATUS.EXPIRED,
      actor: AR_ACTOR.SYSTEM,
    });
    expect(result).toEqual({ updated: 3 });
    expect(calls[0]).toEqual({
      where: { tenantId: "t-1", status: { in: [AR_STATUS.PENDING] } },
      data: { status: AR_STATUS.EXPIRED },
    });
  });

  test("returns 0 without writing for a forbidden transition", async () => {
    const { db, calls } = makeRecordingDb(3);
    const result = await bulkTransition({ db, where: { tenantId: "t-1" }, to: AR_STATUS.EXPIRED, actor: AR_ACTOR.ADMIN });
    expect(result).toEqual({ updated: 0 });
    expect(calls).toEqual([]);
  });

  test("throws under bypass RLS when where lacks tenantId, without writing", async () => {
    const { db, calls } = makeRecordingDb(3);
    await expect(
      underBypass(() => bulkTransition({ db, where: { id: "req-1" }, to: AR_STATUS.EXPIRED, actor: AR_ACTOR.SYSTEM })),
    ).rejects.toThrow(/under withBypassRls, where must include/);
    expect(calls).toEqual([]);
  });

  test("proceeds under bypass RLS when where carries tenantId", async () => {
    const { db } = makeRecordingDb(2);
    await expect(
      underBypass(() => bulkTransition({ db, where: { tenantId: "t-1" }, to: AR_STATUS.EXPIRED, actor: AR_ACTOR.SYSTEM })),
    ).resolves.toEqual({ updated: 2 });
  });
});
