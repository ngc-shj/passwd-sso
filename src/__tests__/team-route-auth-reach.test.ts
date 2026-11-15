/**
 * Every handler under src/app/api/teams/[teamId]/ reaches the team membership
 * gate (leftover-team-actor-authority C5).
 *
 * `getTeamMembership` is where a leftover membership (an active team row whose
 * user left the team's tenant) is refused, and it is reached only through
 * `requireTeamMember` / `requireTeamPermission`. A handler that skips both
 * serves every leftover, so this test resolves each exported HTTP-method
 * handler to its function body and requires a call to one of them, imported
 * from the team-auth module.
 *
 * What this PROVES: a gate call is present in each handler's own body, not in
 * a closure nested inside it (a callback that may never run). It does not
 * classify `team_members` reads, so code outside this tree that decides
 * authority from `team_members` itself stays a convention
 * (getTeamMembership's doc comment). Static limits: a call in a dead branch
 * or whose result is ignored still counts. Verified without a Program:
 * ts-morph resolves only same-file bindings here.
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { readdirSync } from "node:fs";
import { Node, Project, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";

const REPO_ROOT = path.resolve(__dirname, "../..");
const TEAM_ROUTES_DIR = path.join(REPO_ROOT, "src/app/api/teams/[teamId]");

const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
/** Next.js route-segment config: not handlers, allowed beside them. */
const SEGMENT_CONFIG: ReadonlySet<string> = new Set([
  "runtime", "dynamic", "revalidate", "maxDuration", "fetchCache", "preferredRegion",
]);
const GATES: ReadonlySet<string> = new Set(["requireTeamMember", "requireTeamPermission"]);
const GATE_MODULE = "@/lib/auth/access/team-auth";

/** `route.ts` files under `dir`, by an fs walk (the `[teamId]` brackets break glob matching). */
function walkRouteFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkRouteFiles(full));
    else if (entry.name === "route.ts") found.push(full);
  }
  return found.sort();
}

/** The function node a handler export resolves to, through wrappers like `withRequestLog(handleX)`; null when it cannot be found. */
function resolveFunction(node: Node | undefined, seen = new Set<Node>()): Node | null {
  if (!node || seen.has(node)) return null;
  seen.add(node);
  if (Node.isFunctionDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return node;
  if (Node.isVariableDeclaration(node)) return resolveFunction(node.getInitializer(), seen);
  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isNonNullExpression(node) || Node.isSatisfiesExpression(node)) {
    return resolveFunction(node.getExpression(), seen);
  }
  if (Node.isIdentifier(node)) {
    for (const decl of node.getSymbol()?.getDeclarations() ?? []) {
      const resolved = resolveFunction(decl, seen);
      if (resolved) return resolved;
    }
    return null;
  }
  if (Node.isCallExpression(node)) {
    for (const arg of node.getArguments()) {
      const resolved = resolveFunction(arg, seen);
      if (resolved) return resolved;
    }
    return null;
  }
  return null;
}

/** The innermost function-like node enclosing `node`. */
function enclosingFunction(node: Node): Node | undefined {
  return node.getFirstAncestor(
    (a) =>
      Node.isArrowFunction(a) ||
      Node.isFunctionDeclaration(a) ||
      Node.isFunctionExpression(a) ||
      Node.isMethodDeclaration(a),
  );
}

/** Whether `fn` itself (not a closure nested in it) calls a gate function imported from the team-auth module. */
function callsGate(fn: Node): boolean {
  return fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((call) => {
    if (enclosingFunction(call) !== fn) return false;
    const callee = call.getExpression();
    if (!Node.isIdentifier(callee)) return false;
    return (callee.getSymbol()?.getDeclarations() ?? []).some(
      (decl) =>
        Node.isImportSpecifier(decl) &&
        GATES.has(decl.getName()) &&
        decl.getImportDeclaration().getModuleSpecifierValue() === GATE_MODULE,
    );
  });
}

/** What is wrong with `sf` as a team route file, empty when nothing is. */
function reachProblems(sf: SourceFile): string[] {
  const where = sf.getFilePath();
  const problems: string[] = [];
  let handlers = 0;
  for (const [name, decls] of sf.getExportedDeclarations()) {
    if (SEGMENT_CONFIG.has(name)) continue;
    if (!HTTP_METHODS.has(name)) {
      problems.push(`${where}: unknown export "${name}"`);
      continue;
    }
    handlers += 1;
    const fn = decls.map((decl) => resolveFunction(decl)).find((resolved) => resolved !== null) ?? null;
    if (!fn) {
      problems.push(`${where}: cannot resolve the function behind handler ${name}`);
    } else if (!callsGate(fn)) {
      problems.push(`${where}: handler ${name} calls neither requireTeamMember nor requireTeamPermission`);
    }
  }
  if (handlers === 0) problems.push(`${where}: no HTTP-method handler`);
  return problems;
}

function memoryProject(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  for (const [file, text] of Object.entries(files)) project.createSourceFile(file, text);
  return project;
}

const GATE_IMPORT = `import { requireTeamMember, requireTeamPermission } from "${GATE_MODULE}";\n`;

describe("team route handlers reach the membership gate", () => {
  it("reaches requireTeamMember or requireTeamPermission from every handler under the team routes", () => {
    const files = walkRouteFiles(TEAM_ROUTES_DIR);
    expect(files.length, "the walk found no route.ts").toBeGreaterThan(0);

    // Syntax only: the check reads each route file's own handlers, so the
    // files' imports are not loaded (resolving them parsed much of src/ and
    // ran past the default timeout under CI coverage).
    const project = new Project({ skipAddingFilesFromTsConfig: true, skipFileDependencyResolution: true });
    project.addSourceFilesAtPaths(files);
    expect(project.getSourceFiles().map((sf) => sf.getFilePath()).sort()).toEqual(
      files.map((file) => file.split(path.sep).join("/")).sort(),
    );

    expect(project.getSourceFiles().flatMap(reachProblems)).toEqual([]);
    // Parsing 40-odd route files takes several seconds under coverage
    // instrumentation, past vitest's 10 s default on a CI shard.
  }, 60_000);
});

describe("the reach check itself", () => {
  const problemsOf = (text: string) =>
    reachProblems(memoryProject({ "/route.ts": text }).getSourceFileOrThrow("/route.ts"));

  it.each([
    ["a wrapped handler", `${GATE_IMPORT}async function handleGET() { await requireTeamMember("u", "t"); }\nexport const GET = withRequestLog(handleGET);`],
    ["a direct arrow handler", `${GATE_IMPORT}export const POST = async () => { await requireTeamPermission("u", "t", "p"); };`],
    ["an exported function declaration", `${GATE_IMPORT}export async function PUT() { await requireTeamMember("u", "t"); }`],
    ["a renamed export", `${GATE_IMPORT}async function remove() { await requireTeamMember("u", "t"); }\nexport { remove as DELETE };`],
    ["an aliased gate import", `import { requireTeamMember as gate } from "${GATE_MODULE}";\nexport async function GET() { await gate("u", "t"); }`],
    ["a top-level gate beside an unrelated nested closure", `${GATE_IMPORT}export async function GET() { await requireTeamMember("u", "t"); const f = () => 1; return f(); }`],
    ["route-segment config beside a handler", `${GATE_IMPORT}export const runtime = "nodejs";\nexport async function GET() { await requireTeamMember("u", "t"); }`],
  ])("accepts %s", (_label, text) => {
    expect(problemsOf(text)).toEqual([]);
  });

  it.each([
    ["a wrapped handler without the gate call", `${GATE_IMPORT}async function handleGET() { return null; }\nexport const GET = withRequestLog(handleGET);`, /handler GET calls neither/],
    ["a renamed export without the gate call", `async function remove() { return null; }\nexport { remove as DELETE };`, /handler DELETE calls neither/],
    ["a gate name that is not the team-auth import", `const requireTeamMember = async () => null;\nexport async function GET() { await requireTeamMember(); }`, /handler GET calls neither/],
    ["a gate imported from another module", `import { requireTeamMember } from "./local-auth";\nexport async function GET() { await requireTeamMember(); }`, /handler GET calls neither/],
    ["a gate called only inside a nested closure", `${GATE_IMPORT}async function handleGET() { const f = () => requireTeamMember("u","t"); return null; }\nexport const GET = withRequestLog(handleGET);`, /handler GET calls neither/],
    ["a handler it cannot resolve", `import { handler } from "./elsewhere";\nexport const GET = handler;`, /cannot resolve the function behind handler GET/],
    ["an unknown export", `${GATE_IMPORT}export async function GET() { await requireTeamMember("u", "t"); }\nexport const helper = 1;`, /unknown export "helper"/],
    ["a default export", `${GATE_IMPORT}export default async function () { await requireTeamMember("u", "t"); }`, /unknown export "default"/],
    ["a file with no handler", `export const runtime = "nodejs";`, /no HTTP-method handler/],
  ])("refuses %s", (_label, text, message) => {
    expect(problemsOf(text).join("\n")).toMatch(message);
  });
});
