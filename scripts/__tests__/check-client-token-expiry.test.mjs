/**
 * Regression tests for check-client-token-expiry.mjs.
 *
 * The guard flags any file under `src/` that creates or expiry-updates an
 * ExtensionToken row without importing `computeClientTokenExpiry`. These
 * tests pin its detection (RT7) so a future edit can't silently disable it —
 * a helper-wrapped write in one file must not license a bare
 * `now.getTime() + idleMinutes * MS_PER_MINUTE` bypass in another.
 * Each case runs the real CLI against an isolated fixture tree via
 * CTE_CHECK_ROOT / CTE_EXEMPTIONS_FILE.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  extractCallArgs,
  isClientTokenExpirySite,
  parseExemptions,
} from "../checks/check-client-token-expiry.mjs";

const CHECKER = fileURLToPath(new URL("../checks/check-client-token-expiry.mjs", import.meta.url));

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cte-check-"));
  mkdirSync(join(dir, "src/lib/auth/tokens"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(relPath, source, { exemptions } = {}) {
  mkdirSync(join(dir, relPath.split("/").slice(0, -1).join("/")), { recursive: true });
  writeFileSync(join(dir, relPath), source, "utf8");
  const env = { ...process.env, CTE_CHECK_ROOT: dir };
  if (exemptions !== undefined) {
    writeFileSync(join(dir, "exemptions.txt"), exemptions, "utf8");
    env.CTE_EXEMPTIONS_FILE = "exemptions.txt";
  } else {
    // No exemptions file on disk at all — the checker must treat ENOENT as
    // "no exemptions", not fail. Point at a path we never create.
    env.CTE_EXEMPTIONS_FILE = "no-such-exemptions.txt";
  }
  try {
    const stdout = execFileSync("node", [CHECKER], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stderr: "", stdout };
  } catch (e) {
    return { code: e.status, stderr: e.stderr?.toString() ?? "", stdout: e.stdout?.toString() ?? "" };
  }
}

const BYPASS_INLINE_EXPIRY = `
import { MS_PER_MINUTE } from "@/lib/constants/time";
export async function issueToken(tx, now, idleMinutes) {
  return tx.extensionToken.create({
    data: {
      expiresAt: new Date(now.getTime() + idleMinutes * MS_PER_MINUTE),
    },
  });
}`;

const CONFORMING_CREATE = `
import { computeClientTokenExpiry } from "@/lib/auth/tokens/client-token-expiry";
export async function issueToken(tx, now, presenceAt, familyCreatedAt, idleMinutes, absoluteMinutes) {
  const expiresAt = computeClientTokenExpiry({ now, presenceAt, familyCreatedAt, idleMinutes, absoluteMinutes });
  return tx.extensionToken.create({ data: { expiresAt } });
}`;

const REVOKE_ONLY_UPDATE = `
export async function revoke(tx, id) {
  return tx.extensionToken.updateMany({ where: { id }, data: { revokedAt: new Date() } });
}`;

const UPDATE_WRITES_EXPIRY_NO_IMPORT = `
export async function bumpExpiry(tx, id, now, idleMinutes) {
  return tx.extensionToken.update({
    where: { id },
    data: { expiresAt: new Date(now.getTime() + idleMinutes * 60000) },
  });
}`;

const UPDATE_WRITES_EXPIRY_WITH_IMPORT = `
import { computeClientTokenExpiry } from "@/lib/auth/tokens/client-token-expiry";
export async function bumpExpiry(tx, id, params) {
  return tx.extensionToken.update({
    where: { id },
    data: { expiresAt: computeClientTokenExpiry(params) },
  });
}`;

describe("check-client-token-expiry", () => {
  it("fails a create() site that inlines now + idleMinutes * MS_PER_MINUTE with no helper import", () => {
    const r = run("src/lib/auth/tokens/extension-token.ts", BYPASS_INLINE_EXPIRY);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing a computeClientTokenExpiry import");
    expect(r.stderr).toContain("src/lib/auth/tokens/extension-token.ts");
  });

  it("passes a create() site that imports and uses computeClientTokenExpiry", () => {
    const r = run("src/lib/auth/tokens/extension-token.ts", CONFORMING_CREATE);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-client-token-expiry: OK");
  });

  it("does not flag a revoke-only updateMany (no expiresAt in its data)", () => {
    const r = run("src/lib/auth/tokens/extension-token.ts", REVOKE_ONLY_UPDATE);
    expect(r.code).toBe(0);
  });

  it("fails an update() whose data writes expiresAt with no helper import", () => {
    const r = run("src/lib/auth/tokens/extension-token.ts", UPDATE_WRITES_EXPIRY_NO_IMPORT);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("missing a computeClientTokenExpiry import");
  });

  it("passes an update() whose data writes expiresAt via the helper", () => {
    const r = run("src/lib/auth/tokens/extension-token.ts", UPDATE_WRITES_EXPIRY_WITH_IMPORT);
    expect(r.code).toBe(0);
  });

  it("honours an exemption entry for a file that would otherwise fail", () => {
    const r = run(
      "src/lib/auth/tokens/extension-token.ts",
      BYPASS_INLINE_EXPIRY,
      { exemptions: "src/lib/auth/tokens/extension-token.ts # reviewed: legacy path pending removal\n" },
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-client-token-expiry: OK");
  });

  it("fails with STALE exemption reporting when an exempted file no longer matches", () => {
    // File has neither create( nor an expiry-writing update( — the exemption
    // no longer names a client-token expiry site and must be reported stale.
    const r = run(
      "src/lib/auth/tokens/extension-token.ts",
      `export function noop() { return 1; }`,
      { exemptions: "src/lib/auth/tokens/extension-token.ts # reviewed: legacy path pending removal\n" },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no longer match");
  });

  it("fails loudly on a malformed exemptions file (missing '# reason')", () => {
    const r = run(
      "src/lib/auth/tokens/extension-token.ts",
      CONFORMING_CREATE,
      { exemptions: "src/lib/auth/tokens/extension-token.ts\n" },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("malformed exemption line");
  });

  it("fails loudly on a malformed exemptions file (reason too short)", () => {
    const r = run(
      "src/lib/auth/tokens/extension-token.ts",
      CONFORMING_CREATE,
      { exemptions: "src/lib/auth/tokens/extension-token.ts # short\n" },
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("malformed exemption line");
  });

  it("does not flag a file with neither create( nor an expiry-writing update(", () => {
    const r = run(
      "src/lib/auth/tokens/unrelated.ts",
      `export function noop() { return 1; }`,
    );
    expect(r.code).toBe(0);
  });
});

describe("extractCallArgs", () => {
  it("extracts a nested-paren call argument up to its matching close paren", () => {
    const src = `foo(bar(1, 2), { a: baz(3) }); trailing();`;
    const openIdx = src.indexOf("(");
    const args = extractCallArgs(src, openIdx);
    expect(args).toBe(`(bar(1, 2), { a: baz(3) })`);
  });

  it("does not terminate on a paren inside a string literal", () => {
    const src = `f("has ) inside", 2)`;
    const openIdx = src.indexOf("(");
    const args = extractCallArgs(src, openIdx);
    expect(args).toBe(`("has ) inside", 2)`);
  });
});

describe("isClientTokenExpirySite", () => {
  it("returns true for a bare create( call", () => {
    expect(isClientTokenExpirySite(`tx.extensionToken.create({ data: { expiresAt } })`)).toBe(true);
  });

  it("returns false for an update( call whose data has no expiresAt", () => {
    expect(isClientTokenExpirySite(`tx.extensionToken.updateMany({ where: {}, data: { revokedAt: now } })`)).toBe(false);
  });

  it("returns true for an updateMany( call whose data writes expiresAt", () => {
    expect(isClientTokenExpirySite(`tx.extensionToken.updateMany({ where: {}, data: { expiresAt: x } })`)).toBe(true);
  });
});

describe("parseExemptions", () => {
  it("parses path # reason lines and skips blanks/comments", () => {
    const map = parseExemptions(`
# header comment
path/a.ts # a real reviewed reason

path/b.ts # another real reason
`);
    expect(map.get("path/a.ts")).toBe("a real reviewed reason");
    expect(map.get("path/b.ts")).toBe("another real reason");
    expect(map.size).toBe(2);
  });

  it("throws on a line with a path but no # reason", () => {
    expect(() => parseExemptions("path/a.ts\n")).toThrow(/malformed/);
  });

  it("throws on a reason shorter than 10 chars", () => {
    expect(() => parseExemptions("path/a.ts # short\n")).toThrow(/malformed/);
  });
});
