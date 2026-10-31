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

/** Every exempted site of the gate, so a synthetic root keeps the exemptions matched. */
const EXEMPT_FILES = {
  "src/app/api/teams/[teamId]/members/route.ts": `
export const reactivate = withTeamTenantRls(teamId, async () => {
  await prisma.$transaction([
    prisma.teamMemberKey.deleteMany({ where: { teamId, userId } }),
    prisma.teamMember.update({ where: { id }, data: { deactivatedAt: null, keyDistributed: false } }),
  ]);
});
`,
  "src/app/api/teams/invitations/accept/route.ts": `
export const accept = withBypassRls(prisma, async (tx) => {
  await tx.teamMember.upsert({ where: { id }, create: {}, update: { deactivatedAt: null, keyDistributed: false } });
});
`,
  "src/app/api/teams/[teamId]/member-key/route.ts": `
async function handleGET() {
  await requireTeamMember(userId, teamId);
  return withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findFirst({ where: { teamId, userId }, select: { keyDistributed: true } }));
}
`,
};
/** Sites the exempt files contribute: 3 writes, 1 read. */
const BASE = { writes: 3, reads: 1 };

let root;

function run({ writes = BASE.writes, reads = BASE.reads, targets } = {}) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [GATE], {
        encoding: "utf8",
        env: {
          ...process.env,
          TEAM_ROTATION_INPUT_LOCK_ROOT: root,
          TEAM_ROTATION_INPUT_LOCK_WRITES: String(writes),
          TEAM_ROTATION_INPUT_LOCK_READS: String(reads),
          ...(targets ? { TEAM_ROTATION_INPUT_LOCK_TARGETS: targets } : {}),
        },
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
  write("src/workers/worker.ts", "export {};\n");
  write("src/auth.ts", "export {};\n");
  for (const [rel, body] of Object.entries(EXEMPT_FILES)) write(rel, body);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-team-rotation-input-lock — writes", () => {
  it("passes a removal that locks the team before deleting the member's keys", () => {
    write(SUBJECT, `
export async function remove(tx) {
  await lockTeamsAgainstRotation(tx, [teamId]);
  await tx.teamMemberKey.deleteMany({ where: { teamId, userId } });
  await tx.teamMember.delete({ where: { id } });
}
`);
    const r = run({ writes: BASE.writes + 2 });
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 covered, 4 exempt");
  });

  it("fails a removal with no lock, naming each write", () => {
    write(SUBJECT, `
export async function remove(tx) {
  await tx.teamMemberKey.deleteMany({ where: { teamId, userId } });
  await tx.teamMember.delete({ where: { id } });
}
`);
    const r = run({ writes: BASE.writes + 2 });
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
    const r = run({ writes: BASE.writes + 1 });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}::remove::teamMember.delete`);
  });

  it("accepts rotation's own lock", () => {
    write(SUBJECT, `
export async function rotate(tx) {
  await lockTeamForRotation(tx, teamId);
  await tx.teamMember.updateMany({ where: { teamId }, data: { keyDistributed: false } });
}
`);
    expect(run({ writes: BASE.writes + 1 }).code).toBe(0);
  });

  it("passes a write whose every same-file caller locks before calling it", () => {
    write(SUBJECT, `
async function deactivate(tx) {
  await tx.teamMember.updateMany({ where: { id }, data: { deactivatedAt: new Date() } });
}
export async function patch(tx) {
  await lockTeamsAgainstRotation(tx, [teamId]);
  await deactivate(tx);
}
`);
    expect(run({ writes: BASE.writes + 1 }).code).toBe(0);
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
    const r = run({ writes: BASE.writes + 1 });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}::deactivate::teamMember.updateMany`);
  });

  it("counts a member update setting keyDistributed, and one whose data it cannot read; not one setting only the role", () => {
    write(SUBJECT, `
export async function f(tx) {
  await tx.teamMember.updateMany({ where: { id }, data: { role } });
  await tx.teamMember.updateMany({ where: { id }, data: { keyDistributed: true } });
  await tx.teamMember.update({ where: { id }, data: { ...changes } });
  await tx.teamMember.update({ where: { id }, data: changes });
}
`);
    // Line 3 sets the role only; 4 keyDistributed; 5 a spread; 6 an identifier.
    const r = run({ writes: BASE.writes + 3 });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}:4 `);
    expect(r.out).toContain(`${SUBJECT}:5 `);
    expect(r.out).toContain(`${SUBJECT}:6 `);
    expect(r.out).not.toContain(`${SUBJECT}:3 `);
  });

  it("counts a member upsert whose update sets deactivatedAt, not one whose update is empty", () => {
    write(SUBJECT, `
export async function f(tx) {
  await tx.teamMember.upsert({ where: { id }, create: {}, update: {} });
  await tx.teamMember.upsert({ where: { id }, create: {}, update: { deactivatedAt: new Date() } });
}
`);
    // Line 3 has an empty update; 4 sets deactivatedAt.
    const r = run({ writes: BASE.writes + 1 });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}:4 `);
    expect(r.out).not.toContain(`${SUBJECT}:3 `);
  });

  it("counts raw deletes and updates of team_members and team_member_keys, schema-qualified too", () => {
    write(SUBJECT, `
export async function f(tx) {
  await tx.$queryRaw\`DELETE FROM team_members WHERE user_id = \${userId}::uuid RETURNING team_id\`;
  await tx.$executeRaw\`UPDATE public.team_member_keys SET x = 1\`;
  await tx.$executeRaw\`UPDATE "team_members" SET key_distributed = false\`;
  await tx.$queryRaw\`SELECT team_id FROM team_members\`;
}
`);
    const r = run({ writes: BASE.writes + 3 });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}::f::team_members.raw`);
    expect(r.out).toContain(`${SUBJECT}::f::team_member_keys.raw`);
    expect(r.out).not.toContain(`${SUBJECT}:6 `);
  });

  it("does not scan the lock and departure implementations", () => {
    write("src/lib/team/team-key-rotation-lock.ts", `
export async function revoke(tx) {
  await tx.$queryRaw\`UPDATE team_members SET key_distributed = false\`;
}
`);
    expect(run().code).toBe(0);
  });
});

describe("check-team-rotation-input-lock — key-holder reads", () => {
  it("passes a key-holder read whose handler applies the departure predicate", () => {
    write(SUBJECT, `
export async function handleGET() {
  const holders = await withTeamTenantRls(teamId, async () =>
    prisma.teamMember.findMany({ where: { teamId, keyDistributed: true } }));
  const departed = await departedFromTenant(prisma, tenantId, holders.map((m) => m.userId));
  return holders.filter((m) => !departed.has(m.userId));
}
`);
    expect(run({ reads: BASE.reads + 1 }).code).toBe(0);
  });

  it("fails a key-holder read whose handler never applies it", () => {
    write(SUBJECT, `
export async function handleGET() {
  return prisma.teamMember.findMany({ where: { teamId, keyDistributed: true } });
}
`);
    const r = run({ reads: BASE.reads + 1 });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}::handleGET::teamMember.read`);
  });

  it("counts a read selecting keyDistributed, not a member read that does neither", () => {
    write(SUBJECT, `
export async function handleGET() {
  await prisma.teamMember.findFirst({ where: { teamId, userId }, select: { role: true } });
  await prisma.teamMember.findFirst({ where: { teamId, userId }, select: { keyDistributed: true } });
}
`);
    const r = run({ reads: BASE.reads + 1 });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${SUBJECT}:4 `);
    expect(r.out).not.toContain(`${SUBJECT}:3 `);
  });
});

describe("check-team-rotation-input-lock — completeness", () => {
  it("fails when the site counts differ from the pinned ones", () => {
    const r = run({ writes: BASE.writes + 1 });
    expect(r.code).toBe(1);
    expect(r.out).toContain("pinned 4 and 1");
  });

  it("fails an exemption that matches no site", () => {
    rmSync(join(root, "src/app/api/teams/invitations/accept/route.ts"));
    const r = run({ writes: BASE.writes - 1 });
    expect(r.code).toBe(1);
    expect(r.out).toContain("exemption(s) matching no site, or several");
  });

  it("fails an exemption that matches several sites", () => {
    write("src/app/api/teams/[teamId]/members/route.ts", EXEMPT_FILES["src/app/api/teams/[teamId]/members/route.ts"].repeat(2));
    const r = run({ writes: BASE.writes + 2 });
    expect(r.code).toBe(1);
    expect(r.out).toContain("exemption(s) matching no site, or several");
  });

  it("scans src/workers", () => {
    write("src/workers/worker.ts", `
export async function sweep(tx) {
  await tx.teamMemberKey.deleteMany({ where: { teamId } });
}
`);
    const r = run({ writes: BASE.writes + 1 });
    expect(r.code).toBe(1);
    expect(r.out).toContain("src/workers/worker.ts::sweep::teamMemberKey.deleteMany");
  });

  it("fails when a scan target is missing", () => {
    rmSync(join(root, "src/auth.ts"));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("scan target not found");
  });
});
