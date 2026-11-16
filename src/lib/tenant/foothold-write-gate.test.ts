import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

const { mockLockTenantRows, mockLockUsersAuthArtifacts, mockIsSessionRowLive, order } = vi.hoisted(() => ({
  mockLockTenantRows: vi.fn(),
  mockLockUsersAuthArtifacts: vi.fn(),
  mockIsSessionRowLive: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/team/tenant-row-lock", () => ({ lockTenantRows: mockLockTenantRows }));
vi.mock("@/lib/auth/session/user-auth-serialization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/session/user-auth-serialization")>()),
  lockUsersAuthArtifacts: mockLockUsersAuthArtifacts,
  isSessionRowLive: mockIsSessionRowLive,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {}, withBypassRls: vi.fn() }));

import { lockFootholdWriter } from "./foothold-write-gate";
import { TenantAuthError } from "@/lib/auth/access/tenant-auth";
import { TENANT_PERMISSION } from "@/lib/constants/auth/tenant-permission";
import { UserAuthRevokedError } from "@/lib/auth/session/user-auth-serialization";
import { createLockBudget } from "@/lib/team/team-key-rotation-lock";

const tx = {} as never;
const req = {} as NextRequest;
const row = (role: string | null, extra: Record<string, unknown> = {}) => ({
  hasRow: role !== null,
  role,
  deactivatedAt: null,
  departedAt: null,
  ...extra,
});

function rowsFor(actor: ReturnType<typeof row> | undefined, extra: [string, ReturnType<typeof row>][] = []) {
  const map = new Map<string, ReturnType<typeof row>>(extra);
  if (actor) map.set("actor", actor);
  return map;
}

describe("lockFootholdWriter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    mockLockTenantRows.mockImplementation(async () => {
      order.push("rows");
      return rowsFor(row("ADMIN"));
    });
    mockLockUsersAuthArtifacts.mockImplementation(async () => { order.push("credential"); });
    mockIsSessionRowLive.mockImplementation(async () => { order.push("session"); return true; });
  });

  it("locks every requested row in one FOR SHARE call, then the credential lock, then reads the session", async () => {
    const budget = createLockBudget();
    mockLockTenantRows.mockResolvedValue(rowsFor(row("ADMIN"), [["target", row("MEMBER")]]));

    const rows = await lockFootholdWriter(tx, req, {
      tenantId: "t1", actorId: "actor", permission: TENANT_PERMISSION.MEMBER_VAULT_RESET, alsoLock: ["target"], budget,
    });

    expect(mockLockTenantRows).toHaveBeenCalledTimes(1);
    expect(mockLockTenantRows).toHaveBeenCalledWith(tx, "t1", ["actor", "target"], "share", budget);
    expect(mockLockUsersAuthArtifacts).toHaveBeenCalledWith(tx, ["actor"], { bounded: true });
    expect(mockIsSessionRowLive).toHaveBeenCalledWith(tx, req, "actor");
    expect(rows.get("target")?.role).toBe("MEMBER");
  });

  it("orders the tenant row lock before the credential lock before the session read", async () => {
    await lockFootholdWriter(tx, req, { tenantId: "t1", actorId: "actor", permission: null });
    expect(order).toEqual(["rows", "credential", "session"]);
  });

  it("refuses an actor without a tenant row", async () => {
    mockLockTenantRows.mockResolvedValue(rowsFor(row(null)));
    await expect(lockFootholdWriter(tx, req, { tenantId: "t1", actorId: "actor", permission: null }))
      .rejects.toBeInstanceOf(TenantAuthError);
    expect(mockLockUsersAuthArtifacts).not.toHaveBeenCalled();
  });

  it("refuses a deactivated actor even when permission is null", async () => {
    mockLockTenantRows.mockResolvedValue(rowsFor(row("ADMIN", { deactivatedAt: new Date() })));
    await expect(lockFootholdWriter(tx, req, { tenantId: "t1", actorId: "actor", permission: null }))
      .rejects.toMatchObject({ status: 403 });
  });

  it("refuses an actor whose locked role lacks the permission", async () => {
    mockLockTenantRows.mockResolvedValue(rowsFor(row("MEMBER")));
    await expect(lockFootholdWriter(tx, req, { tenantId: "t1", actorId: "actor", permission: TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE }))
      .rejects.toBeInstanceOf(TenantAuthError);
    expect(mockIsSessionRowLive).not.toHaveBeenCalled();
  });

  it("admits a role-less requirement for a plain member when permission is null", async () => {
    mockLockTenantRows.mockResolvedValue(rowsFor(row("MEMBER")));
    await expect(lockFootholdWriter(tx, req, { tenantId: "t1", actorId: "actor", permission: null }))
      .resolves.toBeInstanceOf(Map);
  });

  it("throws UserAuthRevokedError when the session row is gone", async () => {
    mockIsSessionRowLive.mockResolvedValue(false);
    await expect(lockFootholdWriter(tx, req, { tenantId: "t1", actorId: "actor", permission: TENANT_PERMISSION.SERVICE_ACCOUNT_MANAGE }))
      .rejects.toBeInstanceOf(UserAuthRevokedError);
  });
});
