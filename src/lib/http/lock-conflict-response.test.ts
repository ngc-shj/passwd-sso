import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { membershipConflictResponse } from "./lock-conflict-response";
import { TeamRotationInProgressError, TeamRotationLockError } from "@/lib/team/team-key-rotation-lock";
import { TenantMemberLockTimeoutError } from "@/lib/team/tenant-row-lock";

describe("membershipConflictResponse", () => {
  it("answers TEAM_BUSY with Retry-After for a team-row wait that ran out", async () => {
    const res = membershipConflictResponse(new TeamRotationInProgressError());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("TEAM_BUSY");
    expect(res.headers.get("Retry-After")).toBe("3");
  });

  it.each([
    ["a team row that could not be locked", () => new TeamRotationLockError(1)],
    ["a tenant-row wait that ran out", () => new TenantMemberLockTimeoutError()],
    ["a deadlock", () => Object.assign(new Error("deadlock detected"), { code: "40P01" })],
    [
      "an expired transaction",
      () => new Prisma.PrismaClientKnownRequestError("tx expired", { code: "P2028", clientVersion: "7.0.0" }),
    ],
  ])("answers CONFLICT without Retry-After for %s", async (_label, makeError) => {
    const res = membershipConflictResponse(makeError());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("CONFLICT");
    expect(res.headers.get("Retry-After")).toBeNull();
  });
});
