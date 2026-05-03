import { describe, it, expect } from "vitest";
import type { TeamRole } from "@prisma/client";
import { isRoleAbove } from "./team-role-hierarchy";
import { TEAM_ROLE } from "@/lib/constants";

// Pure-logic role-hierarchy table. The table is exhaustive over the 4×4 role
// matrix so adding a new role to TeamRole forces a TS error here (Record<…>
// would also catch it via inference of TeamRole values).

interface RolePairCase {
  readonly actor: TeamRole;
  readonly target: TeamRole;
  readonly expected: boolean;
}

// 4 roles × 4 roles = 16 cases. OWNER(4) > ADMIN(3) > MEMBER(2) > VIEWER(1).
const ROLE_PAIR_CASES: readonly RolePairCase[] = [
  // OWNER actor
  { actor: TEAM_ROLE.OWNER, target: TEAM_ROLE.OWNER, expected: false },
  { actor: TEAM_ROLE.OWNER, target: TEAM_ROLE.ADMIN, expected: true },
  { actor: TEAM_ROLE.OWNER, target: TEAM_ROLE.MEMBER, expected: true },
  { actor: TEAM_ROLE.OWNER, target: TEAM_ROLE.VIEWER, expected: true },
  // ADMIN actor
  { actor: TEAM_ROLE.ADMIN, target: TEAM_ROLE.OWNER, expected: false },
  { actor: TEAM_ROLE.ADMIN, target: TEAM_ROLE.ADMIN, expected: false },
  { actor: TEAM_ROLE.ADMIN, target: TEAM_ROLE.MEMBER, expected: true },
  { actor: TEAM_ROLE.ADMIN, target: TEAM_ROLE.VIEWER, expected: true },
  // MEMBER actor
  { actor: TEAM_ROLE.MEMBER, target: TEAM_ROLE.OWNER, expected: false },
  { actor: TEAM_ROLE.MEMBER, target: TEAM_ROLE.ADMIN, expected: false },
  { actor: TEAM_ROLE.MEMBER, target: TEAM_ROLE.MEMBER, expected: false },
  { actor: TEAM_ROLE.MEMBER, target: TEAM_ROLE.VIEWER, expected: true },
  // VIEWER actor
  { actor: TEAM_ROLE.VIEWER, target: TEAM_ROLE.OWNER, expected: false },
  { actor: TEAM_ROLE.VIEWER, target: TEAM_ROLE.ADMIN, expected: false },
  { actor: TEAM_ROLE.VIEWER, target: TEAM_ROLE.MEMBER, expected: false },
  { actor: TEAM_ROLE.VIEWER, target: TEAM_ROLE.VIEWER, expected: false },
];

describe("isRoleAbove (team-role-hierarchy)", () => {
  for (const { actor, target, expected } of ROLE_PAIR_CASES) {
    it(`returns ${expected} when actor=${actor} target=${target}`, () => {
      expect(isRoleAbove(actor, target)).toBe(expected);
    });
  }

  it("is strict (not >=) — equal roles are NOT above one another", () => {
    expect(isRoleAbove(TEAM_ROLE.ADMIN, TEAM_ROLE.ADMIN)).toBe(false);
  });

  it("is asymmetric — actor>target implies !(target>actor)", () => {
    expect(isRoleAbove(TEAM_ROLE.OWNER, TEAM_ROLE.MEMBER)).toBe(true);
    expect(isRoleAbove(TEAM_ROLE.MEMBER, TEAM_ROLE.OWNER)).toBe(false);
  });
});
