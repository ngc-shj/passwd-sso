/**
 * Unit tests for sweepTrashEntry (SC2 / C3 / T1).
 *
 * workerPrisma + the attachment blob store are mocked. Asserts:
 *   - tenant enumeration skips NULL trashRetentionDays (only configured tenants).
 *   - cutoff math: deleted_at < now() - retention days is passed to the SELECT.
 *   - F4 multi-team grouping: a tenant with trashed team entries across 2 teams
 *     calls collectEntryAttachmentRefs once per team with correctly partitioned
 *     ids + the right teamId (this is where a single-team test would mask the
 *     grouping bug).
 *
 * getAttachmentBlobStore is mocked to a NON-DB backend so
 * collectEntryAttachmentRefs does not early-return [] — otherwise the per-team
 * findMany calls (which carry the partition evidence) would be skipped.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MS_PER_DAY } from "@/lib/constants/time";
import { BLOB_STORAGE } from "@/lib/blob-store/types";

const deleteObject = vi.fn(async () => {});
const getAttachmentBlobStore = vi.fn(() => ({
  backend: BLOB_STORAGE.S3,
  deleteObject,
}));

vi.mock("@/lib/blob-store", () => ({
  get BLOB_STORAGE() {
    return BLOB_STORAGE;
  },
  getAttachmentBlobStore: () => getAttachmentBlobStore(),
}));

import { sweepTrashEntry } from "../sweep";
import type { PerTenantTrashEntry } from "../registry";

/** The subset of the attachment.findMany arg the sweeper passes (via collectEntryAttachmentRefs). */
interface AttachmentFindManyArg {
  where: {
    teamPasswordEntryId?: { in: string[] };
    passwordEntryId?: { in: string[] };
  };
}

type AttachmentFindManyMock = ReturnType<
  typeof vi.fn<(arg: AttachmentFindManyArg) => Promise<unknown[]>>
>;

const PERSONAL_ENTRY: PerTenantTrashEntry = {
  kind: "PER_TENANT_TRASH",
  table: "password_entries",
  scopeKind: "personal",
  tenantRetentionColumn: "trashRetentionDays",
};

const TEAM_ENTRY: PerTenantTrashEntry = {
  kind: "PER_TENANT_TRASH",
  table: "team_password_entries",
  scopeKind: "team",
  tenantRetentionColumn: "trashRetentionDays",
};

/**
 * Build a mock workerPrisma. `selectRows` is what the trashed-entry SELECT
 * returns; the audit-emit $queryRaw calls (bypass_rls check, tenant existence)
 * are distinguished from the SELECT by the query text.
 */
function buildMockPrisma(opts: {
  tenants: Array<{ id: string; trashRetentionDays: number | null }>;
  selectRows: Record<string, unknown>[];
  attachmentFindMany: AttachmentFindManyMock;
}) {
  const teamDeleteMany = vi.fn(async () => ({ count: 0 }));
  const personalDeleteMany = vi.fn(async () => ({ count: 0 }));
  const auditCreate = vi.fn(async () => ({}));

  const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const text = strings.join("");
    if (text.includes("current_setting")) {
      return [{ bypass_rls: "on", tenant_id: "" }];
    }
    if (text.includes("SELECT EXISTS")) {
      return [{ ok: true }];
    }
    // The trashed-entry SELECT.
    return opts.selectRows;
  });

  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: queryRaw,
    teamPasswordEntry: { deleteMany: teamDeleteMany },
    passwordEntry: { deleteMany: personalDeleteMany },
    attachment: { findMany: opts.attachmentFindMany },
    auditOutbox: { create: auditCreate },
  };

  const workerPrisma = {
    tenant: {
      findMany: vi.fn(async () =>
        opts.tenants.filter((t) => t.trashRetentionDays !== null),
      ),
    },
    $transaction: vi.fn(async (cb: (t: typeof tx) => Promise<unknown>) =>
      cb(tx),
    ),
  };

  return {
    workerPrisma,
    tx,
    teamDeleteMany,
    personalDeleteMany,
    auditCreate,
    queryRaw,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAttachmentBlobStore.mockReturnValue({
    backend: BLOB_STORAGE.S3,
    deleteObject,
  });
});

describe("sweepTrashEntry — tenant enumeration (C3)", () => {
  it("enumerates only tenants with trashRetentionDays NOT NULL", async () => {
    const attachmentFindMany: AttachmentFindManyMock = vi.fn(
      async () => [],
    );
    const { workerPrisma } = buildMockPrisma({
      tenants: [
        { id: "11111111-1111-4111-8111-111111111111", trashRetentionDays: 30 },
        { id: "22222222-2222-4222-8222-222222222222", trashRetentionDays: null },
      ],
      selectRows: [],
      attachmentFindMany,
    });

    await sweepTrashEntry(
      workerPrisma as unknown as Parameters<typeof sweepTrashEntry>[0],
      PERSONAL_ENTRY,
      100,
    );

    expect(workerPrisma.tenant.findMany).toHaveBeenCalledWith({
      where: { trashRetentionDays: { not: null } },
      select: { id: true, trashRetentionDays: true },
    });
    // The NULL-retention tenant is filtered out → only one tenant tx opened.
    expect(workerPrisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("sweepTrashEntry — cutoff math (C3)", () => {
  it("passes deleted_at < (now - retention days) as the SELECT bind", async () => {
    const retention = 30;
    const before = Date.now();
    const attachmentFindMany: AttachmentFindManyMock = vi.fn(
      async () => [],
    );
    const { workerPrisma, queryRaw } = buildMockPrisma({
      tenants: [
        { id: "11111111-1111-4111-8111-111111111111", trashRetentionDays: retention },
      ],
      selectRows: [],
      attachmentFindMany,
    });

    await sweepTrashEntry(
      workerPrisma as unknown as Parameters<typeof sweepTrashEntry>[0],
      PERSONAL_ENTRY,
      100,
    );
    const after = Date.now();

    // Find the SELECT call (the one whose text references deleted_at) and read
    // its cutoff bind (the Date interpolated after the template strings).
    const selectCall = queryRaw.mock.calls.find((c) =>
      (c[0] as TemplateStringsArray).join("").includes("deleted_at"),
    );
    expect(selectCall).toBeDefined();
    const cutoff = selectCall!.find((arg) => arg instanceof Date) as Date;
    expect(cutoff).toBeInstanceOf(Date);

    const expectedMin = before - retention * MS_PER_DAY;
    const expectedMax = after - retention * MS_PER_DAY;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(cutoff.getTime()).toBeLessThanOrEqual(expectedMax);
  });
});

describe("sweepTrashEntry — F4 multi-team grouping (T1)", () => {
  it("calls collectEntryAttachmentRefs once per team with partitioned ids + right teamId", async () => {
    const TEAM_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const TEAM_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    // Two entries in team A, one in team B (interleaved to prove grouping, not order).
    const selectRows = [
      { id: "entry-a1", team_id: TEAM_A },
      { id: "entry-b1", team_id: TEAM_B },
      { id: "entry-a2", team_id: TEAM_A },
    ];
    // attachment.findMany is the observable surface of collectEntryAttachmentRefs.
    const attachmentFindMany: AttachmentFindManyMock = vi.fn(
      async () => [],
    );
    const { workerPrisma, teamDeleteMany } = buildMockPrisma({
      tenants: [
        { id: "11111111-1111-4111-8111-111111111111", trashRetentionDays: 30 },
      ],
      selectRows,
      attachmentFindMany,
    });

    await sweepTrashEntry(
      workerPrisma as unknown as Parameters<typeof sweepTrashEntry>[0],
      TEAM_ENTRY,
      100,
    );

    // One findMany per team group (2 teams → 2 calls).
    expect(attachmentFindMany).toHaveBeenCalledTimes(2);

    // Extract the partitioned id lists each call received.
    const idLists = attachmentFindMany.mock.calls.map(
      (c) => c[0].where.teamPasswordEntryId?.in ?? [],
    );
    const teamAList = idLists.find((ids) => ids.includes("entry-a1"));
    const teamBList = idLists.find((ids) => ids.includes("entry-b1"));

    // Team A group: exactly its two ids, partitioned away from team B.
    expect(teamAList).toBeDefined();
    expect([...teamAList!].sort()).toEqual(["entry-a1", "entry-a2"]);
    // Team B group: exactly its one id.
    expect(teamBList).toEqual(["entry-b1"]);

    // All three ids are deleted in a single deleteMany.
    expect(teamDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["entry-a1", "entry-b1", "entry-a2"] } },
    });
  });
});
