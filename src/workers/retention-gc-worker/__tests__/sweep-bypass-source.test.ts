/**
 * Source invariants for the retention-gc RLS bypass (#874, C2 invariants / T8),
 * read from sweep.ts and index.ts as they stand.
 *
 * - The member set is derived, not listed: every function declaration whose
 *   first parameter's WRITTEN type annotation is `Prisma.TransactionClient`
 *   (so unannotated `(tx) =>` callbacks are not selected), minus the two
 *   helpers exempt by name. A new tx-taking sweep joins it automatically.
 * - Each member's first expression referencing its tx parameter is
 *   `await assertSweepBypass(<tx>, …)`.
 * - Exactly one `set_config('app.bypass_rls'` literal in sweep.ts, inside
 *   inSweepTx; none in index.ts.
 * - inSweepTx and assertSweepBypass are not exported (an exported "open a
 *   bypass transaction" would be a generic RLS bypass no gate covers).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import type { FunctionDeclaration, SourceFile } from "ts-morph";
import { parseRouteSource } from "@/__tests__/proxy/ast-guards";

const WORKER_DIR = path.resolve(__dirname, "..");
const EXEMPT = new Set(["enqueueAuditInWorkerTx", "assertSweepBypass"]);
const EXPECTED_MEMBERS = [
  "sweepAuditLogs",
  "sweepAuditProvenanceEntry",
  "sweepExpiredAccessRequests",
  "sweepExpiryEntry",
  "sweepGuardedExpiryEntry",
  "sweepPerTenantAge",
];
const ENTRY_GATED = new Set(["sweepExpiryEntry", "sweepGuardedExpiryEntry", "sweepAuditProvenanceEntry"]);
const BYPASS_SET_CONFIG = /set_config\s*\(\s*'app\.bypass_rls'/;

function parse(file: string): SourceFile {
  return parseRouteSource(readFileSync(path.join(WORKER_DIR, file), "utf8"), `retention-gc/${file}`);
}

const sweep = parse("sweep.ts");

function members(): FunctionDeclaration[] {
  return sweep
    .getFunctions()
    .filter((fn) => fn.getParameters()[0]?.getTypeNode()?.getText() === "Prisma.TransactionClient")
    .filter((fn) => !EXEMPT.has(fn.getName() ?? ""));
}

/** Every string/template literal node in the file whose text sets app.bypass_rls. */
function bypassSetConfigLiterals(sf: SourceFile): Node[] {
  return sf
    .getDescendants()
    .filter(
      (n) =>
        Node.isStringLiteral(n) ||
        Node.isNoSubstitutionTemplateLiteral(n) ||
        Node.isTemplateHead(n) ||
        Node.isTemplateMiddle(n) ||
        Node.isTemplateTail(n),
    )
    .filter((n) => BYPASS_SET_CONFIG.test(n.getText()));
}

describe("retention-gc sweep.ts bypass invariants (C2)", () => {
  it("the derived member set is the six tx-taking sweeps", () => {
    expect(members().map((fn) => fn.getName()).sort()).toEqual(EXPECTED_MEMBERS);
  });

  it.each(EXPECTED_MEMBERS)(
    "%s: its first reference to its tx is `await assertSweepBypass(<tx>, <declared state>)`",
    (name) => {
      const fn = members().find((m) => m.getName() === name);
      expect(fn, `${name} not found among derived members`).toBeDefined();
      const txName = fn?.getParameters()[0]?.getName() ?? "";
      const firstRef = fn
        ?.getBody()
        ?.getDescendantsOfKind(SyntaxKind.Identifier)
        .find((id) => id.getText() === txName);
      expect(firstRef, `${name} never references ${txName}`).toBeDefined();

      const call = firstRef?.getParentIfKind(SyntaxKind.CallExpression);
      expect(call?.getExpression().getText()).toBe("assertSweepBypass");
      expect(call?.getArguments()[0]).toBe(firstRef);
      expect(call?.getParent()?.getKind()).toBe(SyntaxKind.AwaitExpression);
      // Entry-gated kinds pass the entry's declared state; the rest always need it.
      expect(call?.getArguments()[1]?.getText()).toBe(
        ENTRY_GATED.has(name) ? "entry.globalDelete === true" : "true",
      );
    },
  );

  it("sets app.bypass_rls in exactly one place, inside inSweepTx", () => {
    const literals = bypassSetConfigLiterals(sweep);
    expect(literals).toHaveLength(1);
    const owner = literals[0].getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);
    expect(owner?.getName()).toBe("inSweepTx");
  });

  it("index.ts never sets app.bypass_rls", () => {
    expect(bypassSetConfigLiterals(parse("index.ts"))).toEqual([]);
  });

  it.each(["inSweepTx", "assertSweepBypass"])("%s is module-private", (name) => {
    const fn = sweep.getFunction(name);
    expect(fn, `${name} not found`).toBeDefined();
    expect(fn?.isExported()).toBe(false);
    // Nor re-exported through an export list (`export { inSweepTx }`).
    const listed = sweep
      .getExportDeclarations()
      .flatMap((d) => d.getNamedExports())
      .map((s) => s.getName());
    expect(listed).not.toContain(name);
  });
});
