import { describe, it, expect } from "vitest";
import type { TenantRole } from "@prisma/client";
import { isTenantRoleAbove } from "./tenant-role-hierarchy";

interface RolePairCase {
  readonly actor: TenantRole;
  readonly target: TenantRole;
  readonly expected: boolean;
}

// 3 roles × 3 roles = 9 cases. OWNER(30) > ADMIN(20) > MEMBER(10).
const ROLE_PAIR_CASES: readonly RolePairCase[] = [
  { actor: "OWNER", target: "OWNER", expected: false },
  { actor: "OWNER", target: "ADMIN", expected: true },
  { actor: "OWNER", target: "MEMBER", expected: true },
  { actor: "ADMIN", target: "OWNER", expected: false },
  { actor: "ADMIN", target: "ADMIN", expected: false },
  { actor: "ADMIN", target: "MEMBER", expected: true },
  { actor: "MEMBER", target: "OWNER", expected: false },
  { actor: "MEMBER", target: "ADMIN", expected: false },
  { actor: "MEMBER", target: "MEMBER", expected: false },
];

describe("isTenantRoleAbove (tenant-role-hierarchy)", () => {
  for (const { actor, target, expected } of ROLE_PAIR_CASES) {
    it(`returns ${expected} when actor=${actor} target=${target}`, () => {
      expect(isTenantRoleAbove(actor, target)).toBe(expected);
    });
  }

  it("is strict (not >=) — equal roles are NOT above one another", () => {
    expect(isTenantRoleAbove("ADMIN", "ADMIN")).toBe(false);
    expect(isTenantRoleAbove("OWNER", "OWNER")).toBe(false);
  });

  it("hierarchy is transitive — OWNER > ADMIN AND ADMIN > MEMBER => OWNER > MEMBER", () => {
    expect(isTenantRoleAbove("OWNER", "ADMIN")).toBe(true);
    expect(isTenantRoleAbove("ADMIN", "MEMBER")).toBe(true);
    expect(isTenantRoleAbove("OWNER", "MEMBER")).toBe(true);
  });

  it("denies cross-tenant elevation: a MEMBER cannot dominate an ADMIN even of a different tenant (role-only check)", () => {
    // The function is a pure role compare; cross-tenant tenantId mismatch is
    // enforced in callers. This regression-locks the role-only semantics so
    // we never accidentally treat MEMBER as above ADMIN.
    expect(isTenantRoleAbove("MEMBER", "ADMIN")).toBe(false);
  });
});
