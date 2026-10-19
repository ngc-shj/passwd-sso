/**
 * Team authorization inside a tenant RLS context is refused at run time.
 *
 * `requireTeamMember` opens its own `withTeamTenantRls` (via
 * `getTeamMembership`), so calling it — or `requireTeamPermission` — from inside
 * `withTeamTenantRls` / `withUserTenantRls` reaches `assertNoActiveRlsContext`
 * and throws INVALID_RLS_NESTING before any membership query runs. That guard
 * keys on the active AsyncLocalStorage context, not on how the call is spelled,
 * so every spelling below must fail the same way. This file replaced a
 * text-matching static check that missed the aliased, computed-key and
 * parenthesized forms.
 *
 * Only the Prisma client is mocked; tenant-rls, tenant-context and team-auth
 * run for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const TEAM_ID = "team-1";
const USER_ID = "user-1";

const { mockTx, mockTeamMemberFindFirst } = vi.hoisted(() => {
  const mockTeamMemberFindFirst = vi.fn();
  const mockTx = {
    $executeRaw: vi.fn(),
    team: { findUnique: vi.fn() },
    tenantMember: { findMany: vi.fn() },
    teamMember: { findFirst: mockTeamMemberFindFirst },
  };
  return { mockTx, mockTeamMemberFindFirst };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    ...mockTx,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockTx)),
  },
}));

import * as tenantContext from "@/lib/tenant-context";
import { withTeamTenantRls, withUserTenantRls } from "@/lib/tenant-context";
import { requireTeamMember, requireTeamPermission } from "@/lib/auth/access/team-auth";
import { TEAM_PERMISSION, TEAM_ROLE } from "@/lib/constants";

beforeEach(() => {
  vi.clearAllMocks();
  mockTx.$executeRaw.mockResolvedValue(undefined);
  mockTx.team.findUnique.mockResolvedValue({ tenantId: TENANT_ID });
  mockTx.tenantMember.findMany.mockResolvedValue([{ tenantId: TENANT_ID }]);
  mockTeamMemberFindFirst.mockResolvedValue({ userId: USER_ID, teamId: TEAM_ID, role: TEAM_ROLE.OWNER });
});

const checkPermission = () =>
  requireTeamPermission(USER_ID, TEAM_ID, TEAM_PERMISSION.PASSWORD_READ);

describe("team authorization under a tenant RLS context", () => {
  // Positive control: the same mocks let the call succeed when no context is
  // active, so the rejections below are the nesting guard and not a broken setup.
  it("resolves the membership when called outside any RLS context", async () => {
    await expect(checkPermission()).resolves.toMatchObject({ role: TEAM_ROLE.OWNER });
    expect(mockTeamMemberFindFirst).toHaveBeenCalledOnce();
  });

  const gate = withTeamTenantRls;
  const key = "withTeamTenantRls" as const;

  it.each([
    ["a direct call", () => withTeamTenantRls(TEAM_ID, checkPermission)],
    ["an aliased reference", () => gate(TEAM_ID, checkPermission)],
    ["a computed property", () => tenantContext[key](TEAM_ID, checkPermission)],
    ["a parenthesized callee", () => (withTeamTenantRls)(TEAM_ID, checkPermission)],
  ])("rejects requireTeamPermission inside withTeamTenantRls via %s", async (_label, nested) => {
    await expect(nested()).rejects.toThrow(/INVALID_RLS_NESTING/);
    expect(mockTeamMemberFindFirst).not.toHaveBeenCalled();
  });

  it("rejects requireTeamMember inside withUserTenantRls", async () => {
    await expect(
      withUserTenantRls(USER_ID, () => requireTeamMember(USER_ID, TEAM_ID)),
    ).rejects.toThrow(/INVALID_RLS_NESTING/);
    expect(mockTeamMemberFindFirst).not.toHaveBeenCalled();
  });
});
