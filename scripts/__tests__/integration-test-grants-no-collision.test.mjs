/**
 * The evidence consumer (scripts/checks/check-rls-grant-evidence.ts) keys what
 * the integration suite exercised by (purpose, tables), so a test-local
 * `defineGrant` whose pair equals a BYPASS_GRANT member's pair credits that
 * member with evidence it did not earn. A test that means the production
 * member names it (`BYPASS_GRANT.X`); a test-local grant must carry a pair no
 * member has. This reads every `defineGrant(` call under the integration
 * tests from the parse tree and resolves only what is statically decidable: a
 * call whose purpose or models are not literals fails as undecidable unless
 * UNDECIDABLE_ALLOWED lists it with a reason.
 *
 * What this is: a catch for the plain mistake, a literal `defineGrant` in a
 * test under src/__tests__/db-integration that repeats a member's pair. It
 * does not follow a local alias or re-export of `defineGrant`, a grant built
 * as an object literal or by spreading a member, the bypass statement sent by
 * hand, or an integration test outside that directory; and a listed call is
 * excused as written, so a row added to its `it.each` table is not read. For
 * those, review of the test change is the control.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Node } from "ts-morph";
import { createAstProject } from "../checks/lib/ast-project.mjs";
import { BYPASS_GRANT, MODEL_TABLE } from "@/lib/tenant-rls-grants";
import { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TESTS_DIR = join(ROOT, "src/__tests__/db-integration");

/** `<path>::<call text, whitespace collapsed>` -> why its pair cannot be read statically. */
const UNDECIDABLE_ALLOWED = new Map([
  [
    "src/__tests__/db-integration/helpers.ts::defineGrant( BYPASS_PURPOSE.AUDIT_WRITE, Object.keys(MODEL_TABLE) as BypassModel[], )",
    "TEST_SETUP_GRANT names every table; no member lists them all",
  ],
  [
    "src/__tests__/db-integration/rls-bypass-grants.integration.test.ts::defineGrant(BYPASS_PURPOSE.AUTH_FLOW, [model])",
    "it.each over delegationSession and serviceAccount with AUTH_FLOW; no member has either pair (checked by hand when listed: a new row needs the same check)",
  ],
  [
    "src/__tests__/db-integration/rls-bypass-grants.integration.test.ts::defineGrant(purpose as BypassPurpose, [\"session\"])",
    "it.each over forged purpose strings that are not purposes, with the session table",
  ],
]);

const pairKey = (purpose, tables) => `${purpose}|${tables.split(",").map((t) => t.trim()).sort().join(",")}`;

const memberPairs = () =>
  new Map(Object.entries(BYPASS_GRANT).map(([name, g]) => [pairKey(g.purpose, g.tables), name]));

function* walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.tsx?$/.test(e.name)) yield full;
  }
}

/**
 * @returns {{ collisions: string[], undecidable: string[] }} one entry per
 * offending call, named by file and call text.
 */
export function analyzeSource(rel, text, pairs) {
  const sf = createAstProject().createSourceFile(rel, text, { overwrite: true });
  // Local name -> constructor, so an import alias is still a call.
  const callees = new Map([["defineGrant", "defineGrant"], ["grantForTables", "grantForTables"]]);
  for (const imp of sf.getImportDeclarations()) {
    for (const spec of imp.getNamedImports()) {
      if (callees.has(spec.getName()) && spec.getAliasNode()) {
        callees.set(spec.getAliasNode().getText(), spec.getName());
      }
    }
  }
  const collisions = [];
  const undecidable = [];
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return;
    const callee = node.getExpression();
    const local = Node.isPropertyAccessExpression(callee) ? callee.getName() : callee.getText();
    const name = callees.get(local);
    if (!name) return;
    const call = node.getText().replace(/\s+/g, " ");
    const id = `${rel}::${call}`;
    const [purposeArg, modelsArg] = node.getArguments();
    let purpose;
    if (name !== "defineGrant") {
      undecidable.push(id);
      return;
    }
    if (purposeArg && Node.isStringLiteral(purposeArg)) purpose = purposeArg.getLiteralValue();
    else if (
      purposeArg &&
      Node.isPropertyAccessExpression(purposeArg) &&
      purposeArg.getExpression().getText() === "BYPASS_PURPOSE"
    ) {
      purpose = BYPASS_PURPOSE[purposeArg.getName()];
    }
    const models =
      modelsArg && Node.isArrayLiteralExpression(modelsArg) &&
      modelsArg.getElements().every((el) => Node.isStringLiteral(el))
        ? modelsArg.getElements().map((el) => el.getLiteralValue())
        : null;
    if (purpose === undefined || models === null || models.some((m) => !(m in MODEL_TABLE))) {
      undecidable.push(id);
      return;
    }
    const tables = [...new Set(models.map((m) => MODEL_TABLE[m]))].sort().join(",");
    const member = pairs.get(pairKey(purpose, tables));
    if (member) collisions.push(`${id} has the pair of BYPASS_GRANT.${member}`);
  });
  return { collisions, undecidable };
}

describe("test-local defineGrant calls under the integration tests", () => {
  const files = [...walk(TESTS_DIR)];

  it("scanned the integration tests at all", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("none has the (purpose, tables) pair of a BYPASS_GRANT member", () => {
    const pairs = memberPairs();
    const collisions = [];
    for (const file of files) {
      collisions.push(...analyzeSource(relative(ROOT, file), readFileSync(file, "utf8"), pairs).collisions);
    }
    expect(collisions).toEqual([]);
  });

  it("every call it cannot read statically is listed with a reason", () => {
    const pairs = memberPairs();
    const unlisted = [];
    const seen = new Set();
    for (const file of files) {
      for (const id of analyzeSource(relative(ROOT, file), readFileSync(file, "utf8"), pairs).undecidable) {
        seen.add(id);
        if (!UNDECIDABLE_ALLOWED.has(id)) unlisted.push(id);
      }
    }
    expect(unlisted).toEqual([]);
    // A stale entry would excuse a call that no longer exists.
    expect([...UNDECIDABLE_ALLOWED.keys()].filter((k) => !seen.has(k))).toEqual([]);
  });

  describe("the analyzer", () => {
    const pairs = memberPairs();
    const src = (call) =>
      `import { defineGrant } from "@/lib/tenant-rls-grants";\nimport { BYPASS_PURPOSE } from "@/lib/tenant-rls-purpose";\nconst g = ${call};\n`;

    it("flags a call with a member's pair", () => {
      const r = analyzeSource("x.ts", src("defineGrant(BYPASS_PURPOSE.SYSTEM_MAINTENANCE, [\"tenant\"])"), pairs);
      expect(r.collisions).toHaveLength(1);
      expect(r.collisions[0]).toContain("BYPASS_GRANT.SYSTEM_MAINTENANCE_TENANT_LOOKUP");
    });

    it("flags a collision through a string-literal purpose and an import alias", () => {
      const r = analyzeSource(
        "x.ts",
        `import { defineGrant as dg } from "@/lib/tenant-rls-grants";\nconst g = dg("system_maintenance", ["auditLog"]);\n`,
        pairs,
      );
      expect(r.collisions).toHaveLength(1);
    });

    it("passes a call whose pair no member has", () => {
      const r = analyzeSource("x.ts", src("defineGrant(BYPASS_PURPOSE.AUTH_FLOW, [\"session\", \"tenant\", \"user\"])"), pairs);
      expect(r).toEqual({ collisions: [], undecidable: [] });
    });

    it.each([
      ["a computed purpose", "defineGrant(purposeVar as BypassPurpose, [\"session\"])"],
      ["a computed model list", "defineGrant(BYPASS_PURPOSE.AUTH_FLOW, models)"],
      ["a spread model list", "defineGrant(BYPASS_PURPOSE.AUTH_FLOW, [...models])"],
      ["an unknown model", "defineGrant(BYPASS_PURPOSE.AUTH_FLOW, [\"noSuchModel\"])"],
    ])("fails %s as undecidable", (_name, call) => {
      expect(analyzeSource("x.ts", src(call), pairs).undecidable).toHaveLength(1);
    });
  });
});
