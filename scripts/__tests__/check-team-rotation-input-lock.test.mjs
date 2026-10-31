import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const GATE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "checks",
  "check-team-rotation-input-lock.mjs",
);
const SUBJECT = "src/lib/team/subject.ts";
/** The exempted reactivation site, as the gate's EXEMPTIONS name it. */
const EXEMPT = "src/app/api/teams/[teamId]/members/route.ts";
const EXEMPT_BODY = `
export const reactivate = withTeamTenantRls(teamId, async () => {
  await prisma.$transaction([
    prisma.teamMemberKey.deleteMany({ where: { teamId, userId } }),
    prisma.teamMember.update({ where: { id }, data: { deactivatedAt: null, keyDistributed: false } }),
  ]);
});
`;

let root;

function run(floor = "1") {
  try {
    return {
      code: 0,
      out: execFileSync("node", [GATE], {
        encoding: "utf8",
        env: { ...process.env, TEAM_ROTATION_INPUT_LOCK_ROOT: root, TEAM_ROTATION_INPUT_LOCK_FLOOR: floor },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function write(rel, body) {
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "team-rotation-input-lock-"));
  // A target that contributes no source file reads as missing, so each one
  // carries a file with no sites.
  write("src/app/layout.ts", "export {};\n");
  write("src/lib/util.ts", "export {};\n");
  write("src/auth.ts", "export {};\n");
  write(EXEMPT, EXEMPT_BODY);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-team-rotation-input-lock", () => {
  it("passes a removal that locks the team before deleting the member's keys", () => {
    write(SUBJECT, `
export async function remove(tx) {
  await lockTeamsAgainstRotation(tx, [teamId]);
  await tx.teamMemberKey.deleteMany({ where: { teamId, userId } });
  await tx.teamMember.delete({ where: { id } });
}
`);
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK (4 member-set write site(s): 2 locked, 2 exempt)");
  });

  it("fails a removal with no lock, naming each write", () => {
    write(SUBJECT, `
export async function remove(tx) {
  await tx.teamMemberKey.deleteMany({ where: { teamId, userId } });
  await tx.teamMember.delete({ where: { id } });
}
`);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}::remove::teamMemberKey.deleteMany`);
    expect(r.out).toContain(`${SUBJECT}::remove::teamMember.delete`);
  });

  it("fails a lock taken after the write", () => {
    write(SUBJECT, `
export async function remove(tx) {
  await tx.teamMember.delete({ where: { id } });
  await lockTeamsAgainstRotation(tx, [teamId]);
}
`);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}::remove::teamMember.delete`);
  });

  it("passes a write whose caller in the same file locks before calling it", () => {
    write(SUBJECT, `
async function deactivate(tx) {
  await tx.teamMember.updateMany({ where: { id }, data: { deactivatedAt: new Date() } });
}
export async function patch(tx) {
  await lockTeamsAgainstRotation(tx, [teamId]);
  await deactivate(tx);
}
`);
    expect(run().code).toBe(0);
  });

  it("fails when one of the write's callers does not lock", () => {
    write(SUBJECT, `
async function deactivate(tx) {
  await tx.teamMember.updateMany({ where: { id }, data: { deactivatedAt: new Date() } });
}
export async function patch(tx) {
  await lockTeamsAgainstRotation(tx, [teamId]);
  await deactivate(tx);
}
export async function replace(tx) {
  await deactivate(tx);
}
`);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}::deactivate::teamMember.updateMany`);
  });

  it("does not count a member update that changes neither deactivation nor key distribution", () => {
    write(SUBJECT, `
export async function promote(tx) {
  await tx.teamMember.updateMany({ where: { id }, data: { role } });
  await tx.tenantMember.update({ where: { id }, data: { lastScimSyncedAt: new Date() } });
}
`);
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain("OK (2 member-set write site(s)");
  });

  it("counts a member update whose data it cannot read", () => {
    write(SUBJECT, `
export async function patch(tx) {
  await tx.tenantMember.update({ where: { id }, data: updateData });
}
`);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}::patch::tenantMember.update`);
  });

  it("fails an unlocked raw delete from team_members", () => {
    write(SUBJECT, `
export async function remove(tx) {
  await tx.$queryRaw\`DELETE FROM team_members WHERE user_id = \${userId}::uuid RETURNING team_id\`;
}
`);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}::remove::team_members.raw`);
  });

  it("fails an exemption that matches no site", () => {
    rmSync(join(root, EXEMPT));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("exemption(s) matching no site");
  });

  it("fails a scan that found fewer sites than the floor", () => {
    const r = run("12");
    expect(r.code).toBe(1);
    expect(r.out).toContain("fewer than the floor of 12");
  });

  it("fails when a scan target is missing", () => {
    rmSync(join(root, "src/auth.ts"));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("scan target not found");
  });
});
