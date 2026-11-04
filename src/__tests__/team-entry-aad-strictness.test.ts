/**
 * Strict team entry AAD (deviation D67, round-2 S N1).
 *
 * A live team entry is always read at AAD 1 (`buildTeamEntryAAD` at the
 * entry's ItemKey version). Choosing the AAD by the server-supplied
 * `aadVersion` lets a DB-write attacker label an entry 0 and substitute a
 * legacy no-AAD ciphertext, so the aadVersion-aware `teamEntryAadFor` is
 * confined to the paths that UPGRADE such a row to AAD 1, plus the history
 * VIEW (a server-held row that is only displayed).
 *
 * Member set, derived: every non-test .ts/.tsx module under src/ and
 * extension/src/. Rules, on the AST (comments and strings never match):
 *  1. `teamEntryAadFor` is declared only in team-key-resolution.ts and
 *     referenced only in ALLOWED_AAD_VERSION_AWARE (the history view: only
 *     inside handleView), and never as the AAD of an encryptData call.
 *  2. Outside that allow-list, no `buildTeamEntryAAD(...)` call is a branch of
 *     a conditional / logical expression or an if statement whose condition
 *     reads `aadVersion`, or whose other branch is undefined / null (an inline
 *     re-implementation of the helper under another spelling).
 *  3. Each known reader still calls `buildTeamEntryAAD` (the rule is not
 *     vacuous for a reader that moved).
 * iOS (Swift) is outside this gate; its refusal cells pin the same rule.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";
import { parseRouteSource } from "@/__tests__/proxy/ast-guards";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCAN_ROOTS = ["src", "extension/src"];

const HELPER = "teamEntryAadFor";
const HELPER_HOME = "src/lib/team/team-key-resolution.ts";
const HISTORY_VIEW = "src/components/passwords/entry/entry-history-section.tsx";
const ALLOWED_AAD_VERSION_AWARE = new Set([
  HELPER_HOME,
  // Rotation: v0 entries re-sealed at AAD 1 under the new team key.
  "src/lib/team/rotation-payload.ts",
  // Re-key (decrypt side), the v0→v1 upgrade payload, history rows re-keyed.
  "src/lib/team/rekey-payload.ts",
  // History restore: the row is opened at its AAD and re-sealed at AAD 1.
  "src/lib/team/team-history-restore.ts",
  HISTORY_VIEW,
]);

const STRICT_READERS = [
  "src/lib/vault/team-vault-list-adapter.ts",
  "src/lib/vault/build-team-get-detail.ts",
  "src/hooks/use-watchtower.ts",
  "src/components/team/management/team-export.tsx",
  "src/components/team/management/team-edit-dialog-loader.tsx",
  "src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx",
  "src/hooks/team/use-team-login-form-state.ts",
  "extension/src/background/index.ts",
];

function isTestPath(rel: string): boolean {
  return rel.includes("/__tests__/") || /\.test\.tsx?$/.test(rel);
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
}

function moduleFiles(): string[] {
  const out: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root), out);
  return out.map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/")).filter((rel) => !isTestPath(rel));
}

function parse(rel: string): SourceFile {
  return parseRouteSource(readFileSync(path.join(REPO_ROOT, rel), "utf8"), rel);
}

/** Identifier references to `name`, excluding import/export specifiers and the declaration's own name. */
function references(sf: SourceFile, name: string): Node[] {
  return sf.getDescendantsOfKind(SyntaxKind.Identifier).filter((id) => {
    if (id.getText() !== name) return false;
    const parent = id.getParent();
    if (!parent) return false;
    if (Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent)) return false;
    if (Node.isFunctionDeclaration(parent) && parent.getNameNode() === id) return false;
    return true;
  });
}

function calls(sf: SourceFile, name: string): Node[] {
  return sf
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => call.getExpression().getText() === name);
}

function readsAadVersion(node: Node | undefined): boolean {
  if (!node) return false;
  return node.getDescendantsOfKind(SyntaxKind.Identifier).some((id) => id.getText() === "aadVersion")
    || (Node.isIdentifier(node) && node.getText() === "aadVersion");
}

function isNullish(node: Node | undefined): boolean {
  if (!node) return false;
  const text = node.getText();
  return text === "undefined" || text === "null" || text === "void 0";
}

/** Why `call` is chosen conditionally on aadVersion (or by an inline helper re-implementation), or null. */
function conditionalChoice(call: Node): string | null {
  let child: Node = call;
  for (let parent = call.getParent(); parent; child = parent, parent = parent.getParent()) {
    if (Node.isConditionalExpression(parent)) {
      if (child === parent.getCondition()) continue;
      const other = child === parent.getWhenTrue() ? parent.getWhenFalse() : parent.getWhenTrue();
      if (readsAadVersion(parent.getCondition())) return "ternary on aadVersion";
      if (isNullish(other)) return "ternary with an undefined/null branch";
    } else if (Node.isBinaryExpression(parent)) {
      const op = parent.getOperatorToken().getKind();
      const logical = op === SyntaxKind.AmpersandAmpersandToken || op === SyntaxKind.BarBarToken
        || op === SyntaxKind.QuestionQuestionToken;
      if (logical && child === parent.getRight() && readsAadVersion(parent.getLeft())) {
        return "logical expression on aadVersion";
      }
    } else if (Node.isIfStatement(parent)) {
      if (child !== parent.getExpression() && readsAadVersion(parent.getExpression())) {
        return "if statement on aadVersion";
      }
    } else if (Node.isFunctionLikeDeclaration(parent) || Node.isSourceFile(parent)) {
      return null;
    }
  }
  return null;
}

/** The name of the nearest enclosing named function / variable-bound arrow. */
function enclosingFunctionName(node: Node): string | null {
  for (let p = node.getParent(); p; p = p.getParent()) {
    if (Node.isFunctionDeclaration(p)) return p.getName() ?? null;
    if ((Node.isArrowFunction(p) || Node.isFunctionExpression(p)) && Node.isVariableDeclaration(p.getParent())) {
      return (p.getParent() as Node & { getName(): string }).getName();
    }
  }
  return null;
}

const FILES = moduleFiles();
const SOURCES = new Map(
  FILES.filter((rel) => {
    const text = readFileSync(path.join(REPO_ROOT, rel), "utf8");
    return text.includes(HELPER) || text.includes("buildTeamEntryAAD");
  }).map((rel) => [rel, parse(rel)] as const),
);

describe("team entry AAD strictness (D67)", () => {
  it("scans every module under src/ and extension/src/ (non-vacuous)", () => {
    expect(FILES.length).toBeGreaterThan(500);
    expect(FILES).toContain("extension/src/background/index.ts");
  });

  it(`${HELPER} is declared only in ${HELPER_HOME}`, () => {
    const declaredIn = [...SOURCES]
      .filter(([, sf]) => sf.getFunctions().some((fn) => fn.getName() === HELPER)
        || sf.getVariableDeclarations().some((v) => v.getName() === HELPER))
      .map(([rel]) => rel);
    expect(declaredIn).toEqual([HELPER_HOME]);
  });

  it(`${HELPER} is referenced only by the upgrade paths and the history view`, () => {
    const offenders = [...SOURCES]
      .filter(([rel, sf]) => !ALLOWED_AAD_VERSION_AWARE.has(rel) && references(sf, HELPER).length > 0)
      .map(([rel]) => rel);
    expect(offenders).toEqual([]);
  });

  it("the history view uses it only to display a history row (handleView)", () => {
    const sf = SOURCES.get(HISTORY_VIEW);
    expect(sf).toBeDefined();
    const sites = calls(sf as SourceFile, HELPER).map(enclosingFunctionName);
    expect(sites).toEqual(["handleView"]);
  });

  it(`${HELPER} never supplies the AAD of an encryptData call (writers seal at AAD 1)`, () => {
    const offenders = [...SOURCES].flatMap(([rel, sf]) =>
      calls(sf, HELPER)
        .filter((call) => call.getAncestors().some((a) => Node.isCallExpression(a) && a.getExpression().getText() === "encryptData"))
        .map((call) => `${rel}:${call.getStartLineNumber()}`),
    );
    expect(offenders).toEqual([]);
  });

  it("outside the allow-list, buildTeamEntryAAD is never chosen by aadVersion", () => {
    const offenders = [...SOURCES]
      .filter(([rel]) => !ALLOWED_AAD_VERSION_AWARE.has(rel))
      .flatMap(([rel, sf]) =>
        calls(sf, "buildTeamEntryAAD").flatMap((call) => {
          const why = conditionalChoice(call);
          return why ? [`${rel}:${call.getStartLineNumber()} (${why})`] : [];
        }),
      );
    expect(offenders).toEqual([]);
  });

  it.each(STRICT_READERS)("%s reads team entries through buildTeamEntryAAD", (rel) => {
    const sf = SOURCES.get(rel);
    expect(sf, `${rel} no longer references buildTeamEntryAAD`).toBeDefined();
    expect(calls(sf as SourceFile, "buildTeamEntryAAD").length).toBeGreaterThan(0);
  });
});
