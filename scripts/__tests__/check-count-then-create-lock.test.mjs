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

// The broadened-primitive shapes. The class is "read a per-scope table → gate on
// a cap → write it", NOT the .count()+MAX_ spelling. These four real-code shapes
// were invisible to the count()+.create() guard and must all go RED without a lock.

// evict-oldest: findMany().length + N - CAP > 0, then updateMany (revoke) + create.
const EVICT_OLDEST_NO_LOCK = `
import { withTenantRls } from "@/lib/tenant-rls";
import { WIDGET_MAX_ACTIVE } from "@/lib/constants";
async function h() {
  return withTenantRls(prisma, t, async (tx) => {
    const active = await tx.widget.findMany({ where: { t } });
    const overflow = active.length + 1 - WIDGET_MAX_ACTIVE;
    if (overflow > 0) await tx.widget.updateMany({ where: {}, data: { revoked: true } });
    return tx.widget.create({ data: {} });
  });
}`;

// byte-quota: aggregate()._sum vs *_TOTAL_BYTES, then create.
const BYTE_QUOTA_NO_LOCK = `
import { withTenantRls } from "@/lib/tenant-rls";
import { SEND_MAX_ACTIVE_TOTAL_BYTES } from "@/lib/constants";
async function h() {
  return withTenantRls(prisma, t, async (tx) => {
    const agg = await tx.send.aggregate({ _sum: { bytes: true } });
    if ((agg._sum.bytes ?? 0) >= SEND_MAX_ACTIVE_TOTAL_BYTES) throw new Err();
    return tx.send.create({ data: {} });
  });
}`;

// DCR-consent claim: count vs MAX_, then updateMany claim (flips FK) — NO .create.
const CLAIM_UPDATEMANY_NO_LOCK = `
import { withBypassRls } from "@/lib/tenant-rls";
import { MAX_CLIENTS_PER_TENANT } from "@/lib/constants";
async function h() {
  return withBypassRls(prisma, async (tx) => {
    const n = await tx.mcpClient.count({ where: { tenantId } });
    if (n >= MAX_CLIENTS_PER_TENANT) throw new Err();
    return tx.mcpClient.updateMany({ where: { id }, data: { tenantId } });
  });
}`;

// dynamic per-tenant cap in a lowercase var (maxSessions) — matches no naming rule.
const DYNAMIC_SESSION_CAP_NO_LOCK = `
import { withTenantRls } from "@/lib/tenant-rls";
async function h(maxSessions) {
  return withTenantRls(prisma, t, async (tx) => {
    const sessions = await tx.session.findMany({ where: { t } });
    if (sessions.length >= maxSessions) throw new Err();
    return tx.session.create({ data: {} });
  });
}`;

// False-cap decoys that MUST stay exit 0: a bare rows.length > 20 pagination check,
// MAX_CACHE_ENTRIES (in-memory Map size cap), a *_THROTTLE_MS interval, and an
// unrelated updateMany — none of these gate a per-scope table count.
const NON_CAP_LENGTH_AND_UPDATEMANY = `
import { withTenantRls } from "@/lib/tenant-rls";
import { MAX_CACHE_ENTRIES, MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS } from "@/lib/constants";
async function h() {
  const rows = await withTenantRls(prisma, t, async (tx) => tx.widget.findMany());
  if (rows.length > 20) return err();
  if (cache.size > MAX_CACHE_ENTRIES) cache.clear();
  if (now - last > MAX_MCP_TOKEN_LAST_USED_THROTTLE_MS) throttle();
  return withTenantRls(prisma, t, async (tx) => tx.widget.updateMany({ where: {}, data: {} }));
}`;

// A broadened shape WITH the lock present — must pass.
const EVICT_OLDEST_WITH_LOCK = `
import { withTenantRls } from "@/lib/tenant-rls";
import { WIDGET_MAX_ACTIVE } from "@/lib/constants";
async function h() {
  return withTenantRls(prisma, t, async (tx) => {
    await tx.$executeRaw\`SELECT pg_advisory_xact_lock(hashtext(\${t}::text))\`;
    const active = await tx.widget.findMany({ where: { t } });
    if (active.length + 1 - WIDGET_MAX_ACTIVE > 0) await tx.widget.updateMany({ where: {}, data: {} });
    return tx.widget.create({ data: {} });
  });
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

  it("fails the evict-oldest findMany().length cap shape with no lock", () => {
    const r = run("src/app/api/x/route.ts", EVICT_OLDEST_NO_LOCK);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing a pg_advisory_xact_lock");
  });

  it("fails the byte-quota aggregate vs *_TOTAL_BYTES cap shape with no lock", () => {
    const r = run("src/app/api/x/route.ts", BYTE_QUOTA_NO_LOCK);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing a pg_advisory_xact_lock");
  });

  it("fails the claim-style updateMany cap shape (no .create) with no lock", () => {
    const r = run("src/app/api/x/route.ts", CLAIM_UPDATEMANY_NO_LOCK);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing a pg_advisory_xact_lock");
  });

  it("fails the dynamic maxSessions cap shape with no lock", () => {
    const r = run("src/app/api/x/route.ts", DYNAMIC_SESSION_CAP_NO_LOCK);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing a pg_advisory_xact_lock");
  });

  it("does not flag false-cap decoys (pagination length, Map-size cap, throttle interval)", () => {
    const r = run("src/app/api/x/route.ts", NON_CAP_LENGTH_AND_UPDATEMANY);
    expect(r.code).toBe(0);
  });

  it("passes a broadened cap shape that has the advisory lock", () => {
    const r = run("src/app/api/x/route.ts", EVICT_OLDEST_WITH_LOCK);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-count-then-create-lock: OK");
  });
});
