/**
 * Regression tests for check-count-then-create-lock.mjs.
 *
 * The guard flags any RLS-wrapped file that does count/aggregate → cap-check →
 * create WITHOUT a pg_advisory_xact_lock. These tests pin its detection so a
 * future edit can't silently disable it (the class it protects expanded from 1
 * to 17 sites during review precisely because completeness wasn't mechanized).
 * Each case runs the real CLI against an isolated fixture tree via CTC_CHECK_ROOT.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CHECKER = fileURLToPath(new URL("../checks/check-count-then-create-lock.mjs", import.meta.url));

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ctc-check-"));
  mkdirSync(join(dir, "src/app/api/x"), { recursive: true });
  mkdirSync(join(dir, "src/lib/quota"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(relPath, source) {
  mkdirSync(join(dir, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(dir, relPath), source, "utf8");
  try {
    const stdout = execFileSync("node", [CHECKER], {
      env: { ...process.env, CTC_CHECK_ROOT: dir },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "", stdout };
  } catch (e) {
    return { code: e.status, stderr: e.stderr?.toString() ?? "", stdout: e.stdout?.toString() ?? "" };
  }
}

const CAP_THEN_CREATE_NO_LOCK = `
import { withTenantRls } from "@/lib/tenant-rls";
import { MAX_WIDGETS_PER_TENANT } from "@/lib/constants";
async function handlePOST() {
  const n = await withTenantRls(prisma, t, async (tx) => tx.widget.count({ where: { t } }));
  if (n >= MAX_WIDGETS_PER_TENANT) return err();
  return withTenantRls(prisma, t, async (tx) => tx.widget.create({ data: {} }));
}`;

const CAP_THEN_CREATE_WITH_LOCK = `
import { withTenantRls } from "@/lib/tenant-rls";
import { MAX_WIDGETS_PER_TENANT } from "@/lib/constants";
async function handlePOST() {
  return withTenantRls(prisma, t, async (tx) => {
    await tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtext(\${t}::text))\`;
    const n = await tx.widget.count({ where: { t } });
    if (n >= MAX_WIDGETS_PER_TENANT) throw new Err();
    return tx.widget.create({ data: {} });
  });
}`;

// Length/size validation bounds paired with a create — NOT a count cap.
const LENGTH_GUARD_ONLY = `
import { withTenantRls } from "@/lib/tenant-rls";
import { MAX_LENGTH, MAX_FILE_SIZE } from "@/lib/constants";
async function handlePOST(name, size) {
  if (name.length > MAX_LENGTH || size > MAX_FILE_SIZE) return err();
  const n = await withTenantRls(prisma, t, async (tx) => tx.widget.count());
  return withTenantRls(prisma, t, async (tx) => tx.widget.create({ data: {} }));
}`;

describe("check-count-then-create-lock", () => {
  it("fails a cap-then-create site with no advisory lock", () => {
    const r = run("src/app/api/x/route.ts", CAP_THEN_CREATE_NO_LOCK);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing a pg_advisory_xact_lock");
    expect(r.stderr).toContain("src/app/api/x/route.ts");
  });

  it("passes a cap-then-create site that has the advisory lock", () => {
    const r = run("src/app/api/x/route.ts", CAP_THEN_CREATE_WITH_LOCK);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-count-then-create-lock: OK");
  });

  it("does not flag a length/size guard paired with count+create (no count cap)", () => {
    const r = run("src/app/api/x/route.ts", LENGTH_GUARD_ONLY);
    expect(r.code).toBe(0);
  });

  it("does not flag a file that only creates (no count cap at all)", () => {
    const r = run(
      "src/app/api/x/route.ts",
      `import { withTenantRls } from "@/lib/tenant-rls";
       async function h() { return withTenantRls(prisma, t, async (tx) => tx.widget.create({})); }`,
    );
    expect(r.code).toBe(0);
  });
});
