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
const REPO_ROOT = path.resolve(WORKER_DIR, "../../..");
const EXEMPT = new Set(["enqueueAuditInWorkerTx", "assertSweepBypass"]);
const EXPECTED_MEMBERS = [
  "sweepAuditLogs",
  "sweepAuditProvenanceEntry",
  "sweepExpiredAccessRequests",
  "sweepExpiryEntry",
  "sweepGuardedExpiryEntry",
  "sweepPerTenantAge",
  "sweepTrashTenant",
];
const ENTRY_GATED = new Set(["sweepExpiryEntry", "sweepGuardedExpiryEntry", "sweepAuditProvenanceEntry"]);
const TX_TYPE_RE = /\b(TransactionClient|TxClient|RawExecutor)\b/;

function parse(file: string): SourceFile {
  return parseRouteSource(readFileSync(path.join(WORKER_DIR, file), "utf8"), `retention-gc/${file}`);
}

const sweep = parse("sweep.ts");

function members(): FunctionDeclaration[] {
  return sweep
    .getFunctions()
    // The same transaction-client spellings check-rls-read-context accepts, so
    // a sweep typed through an alias is still a member.
    .filter((fn) => TX_TYPE_RE.test(fn.getParameters()[0]?.getTypeNode()?.getText() ?? ""))
    .filter((fn) => !EXEMPT.has(fn.getName() ?? ""));
}

/** Every `setBypassGucs(...)` call expression in the file — the single writer of the bypass GUCs. */
function setBypassGucsCalls(sf: SourceFile): Node[] {
  return sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((n) => n.getExpression().getText() === "setBypassGucs");
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
      // A statement of its own, directly in the function body: not behind an
      // `if`, a loop or any other branch that could skip it.
      const statement = call?.getParent()?.getParent();
      expect(statement?.getKind()).toBe(SyntaxKind.ExpressionStatement);
      expect(statement?.getParent()).toBe(fn?.getBody());
      // Entry-gated kinds pass the entry's declared state; the rest always need it.
      expect(call?.getArguments()[1]?.getText()).toBe(
        ENTRY_GATED.has(name) ? "entry.globalDelete === true" : "true",
      );
    },
  );

  it("calls setBypassGucs in exactly one place, inside inSweepTx", () => {
    const calls = setBypassGucsCalls(sweep);
    expect(calls).toHaveLength(1);
    const owner = calls[0].getFirstAncestorByKind(SyntaxKind.FunctionDeclaration);
    expect(owner?.getName()).toBe("inSweepTx");
  });

  it("index.ts never calls setBypassGucs", () => {
    expect(setBypassGucsCalls(parse("index.ts"))).toEqual([]);
  });

  it.each(["inSweepTx", "assertSweepBypass"])("%s is module-private", (name) => {
    const fn = sweep.getFunction(name);
    expect(fn, `${name} not found`).toBeDefined();
    // Under any exported name: `export function`, an export list, a default
    // export or an exported alias all resolve to the declaration here.
    const exported = [...sweep.getExportedDeclarations().values()].flat();
    expect(exported).not.toContain(fn);
    expect(
      exported.some((d) => Node.isVariableDeclaration(d) && d.getInitializer()?.getText() === name),
    ).toBe(false);
  });

  it("the integration helper sets the bypass with the same call as inSweepTx", () => {
    const helpers = parseRouteSource(
      readFileSync(path.join(REPO_ROOT, "src/__tests__/db-integration/helpers.ts"), "utf8"),
      "db-integration/helpers.ts",
    );
    const inHelper = setBypassGucsCalls(helpers).filter(
      (n) => n.getFirstAncestorByKind(SyntaxKind.FunctionDeclaration)?.getName() === "inRetentionSweepTx",
    );
    expect(inHelper.map((n) => n.getText())).toEqual(setBypassGucsCalls(sweep).map((n) => n.getText()));
  });
});
