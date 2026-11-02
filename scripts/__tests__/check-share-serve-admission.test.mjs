import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "..", "checks", "check-share-serve-admission.mjs");
const ROUTE = "src/app/api/share-links/serve/route.ts";

const IMPORTS = `
import { withBypassRls } from "@/lib/tenant-rls";
import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";
import { isShareCreatorAdmitted } from "@/lib/share/share-admission";
`;

const UPDATE_OK =
  'await prisma.$executeRaw`UPDATE "password_shares" SET "view_count" = "view_count" + 1 WHERE "id" = ${id} AND share_creator_admitted("id")`;';
const UPDATE_MISSING =
  'await prisma.$executeRaw`UPDATE "password_shares" SET "view_count" = "view_count" WHERE "id" = ${id} AND "revoked_at" IS NULL`;';

/** A compliant serve route: one grant reference, two UPDATEs. */
const COMPLIANT = `${IMPORTS}
export async function GET(id) {
  return withBypassRls(prisma, async (tx) => {
    if (!(await isShareCreatorAdmitted(tx, id))) return null;
    ${UPDATE_OK}
    ${UPDATE_OK}
  }, BYPASS_GRANT.SHARE_LINK_PUBLIC_ACCESS);
}
`;

let root;

function run({ statements = 2, grantRefs = 1 } = {}) {
  try {
    return {
      code: 0,
      out: execFileSync("node", [GATE], {
        encoding: "utf8",
        env: {
          ...process.env,
          SHARE_SERVE_ADMISSION_ROOT: root,
          SHARE_SERVE_ADMISSION_STATEMENTS: String(statements),
          SHARE_SERVE_ADMISSION_GRANT_REFS: String(grantRefs),
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

/** A deny: the gate fails (exit 1) AND names the reason. */
function expectDenied(result, pattern) {
  expect(result.code).toBe(1);
  expect(result.out).toMatch(pattern);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "share-serve-admission-"));
  write(ROUTE, COMPLIANT);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("check-share-serve-admission", () => {
  it("passes a compliant serve route", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/OK \(2 statements, 1 grant references\)/);
  });

  it("fails when the scan target is missing", () => {
    rmSync(join(root, "src"), { recursive: true, force: true });
    expectDenied(run(), /scan target not found/);
  });

  it("fails when the site counts drift from the pinned ones", () => {
    expectDenied(run({ statements: 3 }), /statements = 2, expected 3/);
  });

  describe("rule 1: serving statements call share_creator_admitted", () => {
    it("refuses the second UPDATE of a two-UPDATE file without the call", () => {
      write(ROUTE, COMPLIANT.replace(`${UPDATE_OK}\n  }`, `${UPDATE_MISSING}\n  }`));
      expectDenied(run(), /serve\/route\.ts:\d+: password_shares view_count statement without share_creator_admitted/);
    });

    it("does not accept a comment that names the function", () => {
      write(ROUTE, COMPLIANT.replace(`${UPDATE_OK}\n  }`, `// share_creator_admitted("id")\n    ${UPDATE_MISSING}\n  }`));
      expectDenied(run(), /without share_creator_admitted/);
    });
  });

  describe("rule 2: serve grants are used only where admission is pre-checked", () => {
    it("refuses a serve function that imports the helper but never calls it", () => {
      write(ROUTE, COMPLIANT.replace("if (!(await isShareCreatorAdmitted(tx, id))) return null;", ""));
      expectDenied(run(), /never calls isShareCreatorAdmitted/);
    });

    it("refuses a call that sits only in an unrelated sibling function", () => {
      write(
        ROUTE,
        `${COMPLIANT.replace("if (!(await isShareCreatorAdmitted(tx, id))) return null;", "")}
export async function other(tx, id) { return isShareCreatorAdmitted(tx, id); }
`,
      );
      expectDenied(run(), /never calls isShareCreatorAdmitted/);
    });

    it("refuses a call of a local shadowing the helper", () => {
      write(
        ROUTE,
        COMPLIANT.replace(
          "if (!(await isShareCreatorAdmitted(tx, id))) return null;",
          "const isShareCreatorAdmitted = async () => true; if (!(await isShareCreatorAdmitted(tx, id))) return null;",
        ),
      );
      expectDenied(run(), /never calls isShareCreatorAdmitted/);
    });

    it("accepts an aliased BYPASS_GRANT import", () => {
      write(
        ROUTE,
        COMPLIANT.replace('import { BYPASS_GRANT } from "@/lib/tenant-rls-grants";', 'import { BYPASS_GRANT as G } from "@/lib/tenant-rls-grants";').replace(
          "BYPASS_GRANT.SHARE_LINK_PUBLIC_ACCESS",
          "G.SHARE_LINK_PUBLIC_ACCESS",
        ),
      );
      expect(run().code).toBe(0);
    });

    it("refuses a grant held in a variable", () => {
      write(
        ROUTE,
        COMPLIANT.replace("export async function GET", "const grant = BYPASS_GRANT.SHARE_LINK_PUBLIC_ACCESS;\nexport async function GET").replace(
          "}, BYPASS_GRANT.SHARE_LINK_PUBLIC_ACCESS);",
          "}, grant);",
        ),
      );
      expectDenied(run(), /is not the grant argument of a withBypassRls call/);
    });

    it("refuses a destructured grant", () => {
      write(
        ROUTE,
        COMPLIANT.replace("export async function GET", "const { SHARE_LINK_PUBLIC_ACCESS } = BYPASS_GRANT;\nexport async function GET").replace(
          "}, BYPASS_GRANT.SHARE_LINK_PUBLIC_ACCESS);",
          "}, SHARE_LINK_PUBLIC_ACCESS);",
        ),
      );
      expectDenied(run({ grantRefs: 2 }), /is not read as BYPASS_GRANT\.<grant>/);
    });

    it("counts a grant named by a template-string key (and refuses it)", () => {
      write(ROUTE, COMPLIANT.replace("}, BYPASS_GRANT.SHARE_LINK_PUBLIC_ACCESS);", "}, BYPASS_GRANT[`SHARE_LINK_PUBLIC_ACCESS`]);"));
      expectDenied(run(), /is not read as BYPASS_GRANT\.<grant>/);
    });

    it("refuses an untagged raw call in a serving file", () => {
      write(ROUTE, COMPLIANT.replace(UPDATE_OK, "await prisma.$executeRawUnsafe(sqlText);"));
      expectDenied(run({ statements: 1 }), /\$executeRawUnsafe\(\.\.\.\) called with arguments in a serving file/);
    });

    it("refuses a grant passed to something other than withBypassRls", () => {
      write(ROUTE, COMPLIANT.replace("return withBypassRls(prisma,", "return otherWrapper(prisma,"));
      expectDenied(run(), /is not the grant argument of a withBypassRls call/);
    });
  });
});
