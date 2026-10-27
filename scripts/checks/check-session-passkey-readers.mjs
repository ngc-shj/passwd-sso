#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): every route handler that reads the session is
 * accounted for by the proxy's session passkey gate
 * (docs/archive/review/session-api-passkey-gate-plan.md, I1; review S13/T19,
 * T-R3-1, T-R3-2, N-R3-7, R5-3, R5-4, T-R4-6).
 *
 * The proxy refuses a blocked session at `/api/*` (src/lib/proxy/api-route.ts)
 * unless the route is exempt. scripts/checks/route-policy-manifest.json
 * declares, per method, which of those the route is (`sessionPasskeyGate`),
 * and src/__tests__/proxy/route-policy-manifest.test.ts proves each
 * declaration against the real proxy. What the proxy cannot see is whether the
 * HANDLER reads the session; this gate answers that from the source:
 *
 *   1. A session reader declared `tier-a` or `early-return` never meets the
 *      proxy's passkey check. It is either named in READER_EXEMPTIONS below,
 *      with a reason, or it makes an import-bound call to
 *      `passkeyEnforcementBlocks` itself.
 *   2. Every route declared `own-gate` makes an import-bound call to
 *      `passkeyEnforcementBlocks` — the refusing predicate. `derivePasskeyState`
 *      alone only reads the state, so it does not count.
 *   3. A `gated` api-default reader is listed in the proxy's
 *      `API_DEFAULT_SESSION_READERS` (src/lib/proxy/session-passkey-gate.ts),
 *      so an invalid session answers 401 before the route's `auth()` runs; and
 *      that list holds nothing else.
 *
 * A route file is a session reader when it references, by import binding, one
 * of READER_EXPORTS (the module that defines it, not the spelling). A name is
 * resolved scope-aware: a local declaration of the same name (for example
 * src/app/api/v1/passwords/[id]/route.ts's own `checkAuth`) shadows the
 * import, and an aliased import (`import { auth as session }`) is still the
 * reader it names. A namespace import counts through its member access, and a
 * dynamic import of a reader module makes the file a reader.
 *
 * Floor (documented, not enforced): wrappers are NOT followed. A route that
 * reads the session only through a helper of its own module or another
 * module (one that is not in READER_EXPORTS) is not detected here. The reader
 * set is the set of session primitives, so a new primitive must be added to
 * READER_EXPORTS. Reading is per file: a file with any reader reference counts
 * as a reader for every method it declares.
 *
 * Fixture-root override: SESSION_PASSKEY_READERS_ROOT relocates the scan root
 * (src/app/api), the manifest and the proxy list together.
 */
import { SyntaxKind } from "ts-morph";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, walkSourceFiles } from "./lib/ast-project.mjs";
import { bindingIndex, unwrapExpression, visibleBinding } from "./lib/scope-bindings.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = process.env.SESSION_PASSKEY_READERS_ROOT || REPO_ROOT;
const SCAN_ROOT = "src/app/api";
const MANIFEST_PATH = "scripts/checks/route-policy-manifest.json";
const PROXY_LIST_PATH = "src/lib/proxy/session-passkey-gate.ts";
const PROXY_LIST_NAME = "API_DEFAULT_SESSION_READERS";

const GATE_VALUES = new Set(["gated", "tier-a", "tier-b", "own-gate", "early-return"]);
const BYPASSES_PROXY_CHECK = new Set(["tier-a", "early-return"]);
const MIN_REASON = 20;

const ADJUDICATOR = ["src/lib/auth/policy/passkey-enforcement", "passkeyEnforcementBlocks"];

// The session primitives, by defining module. `null` means every value export
// of that module; a RegExp matches export names.
const READER_EXPORTS = new Map([
  ["src/auth", ["auth"]],
  ["src/lib/auth/session/check-auth", ["checkAuth"]],
  ["src/lib/auth/session/auth-or-token", ["authOrToken"]],
  ["src/lib/auth/session/session-cookie", null],
  ["src/app/api/sessions/helpers", [/^getSessionToken/]],
  ["src/lib/auth/session/step-up", ["requireRecentSession"]],
  [
    "src/lib/auth/session/recent-current-auth-method",
    ["requireRecentCurrentAuthMethod", "evaluateStepUpFreshness", "canRecoverSessionWithPasskey"],
  ],
]);

// Session readers the proxy never passkey-checks (declared tier-a or
// early-return) and that do not check the passkey themselves. Pinned here, not
// in the manifest: adding one is a contract change, not a data edit.
const READER_EXEMPTIONS = new Map([
  [
    "src/app/api/auth/[...nextauth]/route.ts",
    "Auth.js's own handler: it reads the session cookie to sign in, sign out and answer /api/auth/session, " +
      "which the proxy's own session read depends on. Classified by this entry (R5-4); its gated concretePaths " +
      "spellings reach the proxy gate and do not make it an API_DEFAULT_SESSION_READERS member.",
  ],
]);

const failures = [];
const fail = (message) => failures.push(message);

function fatal(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

console.log(`check-session-passkey-readers: ROOT=${ROOT}`);

// ─── Inputs ──────────────────────────────────────────────────

const manifestAbs = join(ROOT, MANIFEST_PATH);
if (!existsSync(manifestAbs)) fatal(`manifest not found at ${manifestAbs}.`);
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestAbs, "utf8"));
} catch (e) {
  fatal(`manifest at ${manifestAbs} is not valid JSON: ${e.message}`);
}
if (!manifest || typeof manifest.routes !== "object" || Array.isArray(manifest.routes)) {
  fatal(`manifest at ${manifestAbs} has no "routes" object.`);
}

const project = createAstProject();

/** The literal `{ method, path }` entries of the proxy's reader list. */
function readProxyList() {
  const abs = join(ROOT, PROXY_LIST_PATH);
  if (!existsSync(abs)) fatal(`${PROXY_LIST_PATH} not found under ${ROOT}.`);
  const sf = project.createSourceFile(PROXY_LIST_PATH, readFileSync(abs, "utf8"), { overwrite: true });
  const decl = sf.getVariableDeclaration(PROXY_LIST_NAME);
  if (!decl) fatal(`${PROXY_LIST_PATH} declares no ${PROXY_LIST_NAME}.`);
  const array = unwrapExpression(decl.getInitializer());
  if (array?.getKind() !== SyntaxKind.ArrayLiteralExpression) {
    fatal(`${PROXY_LIST_NAME} is not an array literal: this gate reads it as written.`);
  }
  return array.getElements().map((el) => {
    const obj = unwrapExpression(el);
    const prop = (name) => {
      const p = obj?.getKind() === SyntaxKind.ObjectLiteralExpression ? obj.getProperty(name) : undefined;
      const init = p?.getKind() === SyntaxKind.PropertyAssignment ? unwrapExpression(p.getInitializer()) : undefined;
      return init?.getKind() === SyntaxKind.StringLiteral ? init.getLiteralText() : null;
    };
    const method = prop("method");
    const path = prop("path");
    if (!method || !path) {
      fatal(`${PROXY_LIST_NAME} entry at line ${el.getStartLineNumber()} is not a literal { method, path }.`);
    }
    return { method, path };
  });
}

const proxyReaders = readProxyList();

// ─── Helpers ─────────────────────────────────────────────────

/** Repo-relative module path a specifier names (extension and /index stripped), or null for a package. */
function resolveSpecifier(fromRel, spec) {
  let p;
  if (spec.startsWith("@/")) p = `src/${spec.slice(2)}`;
  else if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
    p = posix.normalize(posix.join(posix.dirname(fromRel), spec));
  } else return null;
  return p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "").replace(/\/index$/, "");
}

/** Every value import binding in the file. */
function importsOf(sf, rel) {
  const out = [];
  for (const decl of sf.getImportDeclarations()) {
    if (decl.isTypeOnly()) continue;
    const from = resolveSpecifier(rel, decl.getModuleSpecifierValue());
    const ns = decl.getNamespaceImport();
    if (ns) out.push({ local: ns.getText(), imported: "*", from });
    const def = decl.getDefaultImport();
    if (def) out.push({ local: def.getText(), imported: "default", from });
    for (const s of decl.getNamedImports()) {
      if (s.isTypeOnly()) continue;
      out.push({ local: s.getAliasNode()?.getText() ?? s.getName(), imported: s.getName(), from });
    }
  }
  return out;
}

function isReaderExport(from, name) {
  if (!READER_EXPORTS.has(from)) return false;
  const names = READER_EXPORTS.get(from);
  if (names === null) return name !== "default";
  return names.some((n) => (n instanceof RegExp ? n.test(name) : n === name));
}

/** The import `id` refers to here, or null when a local binding shadows it or none matches. */
function importAt(id, file) {
  if (id.getKind() !== SyntaxKind.Identifier) return null;
  const name = id.getText();
  if (visibleBinding(name, id, file.bindingsFor)) return null;
  return file.imports.find((i) => i.local === name) ?? null;
}

/** True when `id` is a name in a position that is not a reference to a binding. */
function isNonReference(id) {
  const parent = id.getParent();
  const pk = parent.getKind();
  if (pk === SyntaxKind.ImportSpecifier || pk === SyntaxKind.ImportClause || pk === SyntaxKind.NamespaceImport) return true;
  if (pk === SyntaxKind.PropertyAccessExpression && parent.getNameNode() === id) return true;
  if (
    (pk === SyntaxKind.PropertyAssignment ||
      pk === SyntaxKind.MethodDeclaration ||
      pk === SyntaxKind.PropertySignature ||
      pk === SyntaxKind.PropertyDeclaration) &&
    parent.getNameNode() === id
  ) {
    return true;
  }
  if (pk === SyntaxKind.BindingElement && parent.getPropertyNameNode() === id) return true;
  if (pk === SyntaxKind.TypeQuery || pk === SyntaxKind.QualifiedName || pk === SyntaxKind.TypeReference) return true;
  return false;
}

/** The reader references in the file: `{ line, what }` for each. */
function readerReferences(file) {
  const { sf, rel } = file;
  const refs = [];
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (isNonReference(id)) continue;
    const imp = importAt(id, file);
    if (!imp || !imp.from) continue;
    if (imp.imported === "*") {
      // A namespace import reads through its member: `ns.auth()`.
      const parent = id.getParent();
      if (parent.getKind() === SyntaxKind.PropertyAccessExpression && parent.getExpression() === id) {
        if (isReaderExport(imp.from, parent.getName())) refs.push({ line: id.getStartLineNumber(), what: `${imp.local}.${parent.getName()}` });
      } else if (READER_EXPORTS.has(imp.from)) {
        refs.push({ line: id.getStartLineNumber(), what: `namespace ${imp.local} of ${imp.from} used as a value` });
      }
      continue;
    }
    if (isReaderExport(imp.from, imp.imported)) refs.push({ line: id.getStartLineNumber(), what: `${imp.imported} from ${imp.from}` });
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const isDynamic = callee.getKind() === SyntaxKind.ImportKeyword;
    const isRequire = callee.getKind() === SyntaxKind.Identifier && callee.getText() === "require" && !visibleBinding("require", callee, file.bindingsFor);
    if (!isDynamic && !isRequire) continue;
    const arg = unwrapExpression(call.getArguments()[0]);
    if (arg?.getKind() !== SyntaxKind.StringLiteral && arg?.getKind() !== SyntaxKind.NoSubstitutionTemplateLiteral) {
      fail(`${rel}:${call.getStartLineNumber()}  dynamic import/require with a specifier this gate cannot read: it could load a session reader`);
      continue;
    }
    const from = resolveSpecifier(rel, arg.getLiteralText());
    if (from && READER_EXPORTS.has(from)) refs.push({ line: call.getStartLineNumber(), what: `dynamic import of ${from}` });
  }
  return refs;
}

/** True when the file calls `passkeyEnforcementBlocks` from its defining module (aliases followed, shadows refused). */
function callsAdjudicator(file) {
  const [module, name] = ADJUDICATOR;
  for (const call of file.sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = unwrapExpression(call.getExpression());
    if (callee.getKind() === SyntaxKind.Identifier) {
      const imp = importAt(callee, file);
      if (imp && imp.from === module && imp.imported === name) return true;
    } else if (callee.getKind() === SyntaxKind.PropertyAccessExpression && callee.getName() === name) {
      const imp = importAt(unwrapExpression(callee.getExpression()), file);
      if (imp && imp.from === module && imp.imported === "*") return true;
    }
  }
  return false;
}

/** The request path a route file serves (dynamic segments kept as written). */
const routePathOf = (rel) => `/${posix.dirname(rel).replace(/^src\/app\//, "")}`;

// ─── Scan ────────────────────────────────────────────────────

const routeFiles = walkSourceFiles(join(ROOT, SCAN_ROOT))
  .filter((abs) => abs.endsWith("/route.ts"))
  .map((abs) => relative(ROOT, abs).split("\\").join("/"))
  .sort();
if (routeFiles.length === 0) fatal(`scanned zero route files under ${join(ROOT, SCAN_ROOT)}: nothing was examined.`);

const listedReaders = new Set(proxyReaders.map((e) => `${e.method} ${e.path}`));
const apiDefaultReaders = new Set();
const usedExemptions = new Set();
let readerFiles = 0;
let ownGateMethods = 0;

for (const rel of routeFiles) {
  const entry = manifest.routes[rel];
  if (!entry) {
    fail(`${rel}  has no route-policy-manifest.json entry`);
    continue;
  }
  const sf = project.createSourceFile(rel, readFileSync(join(ROOT, rel), "utf8"), { overwrite: true });
  let bindings;
  const file = { sf, rel, imports: importsOf(sf, rel), bindingsFor: () => (bindings ??= bindingIndex(sf)) };
  const refs = readerReferences(file);
  const isReader = refs.length > 0;
  if (isReader) readerFiles += 1;
  const adjudicates = callsAdjudicator(file);
  const routePath = routePathOf(rel);
  const where = isReader ? ` (reads the session: ${refs[0].what}, line ${refs[0].line})` : "";

  for (const method of entry.methods ?? []) {
    const value = entry.sessionPasskeyGate?.[method]?.value;
    if (!GATE_VALUES.has(value)) {
      fail(`${rel} [${method}]  has no valid sessionPasskeyGate declaration`);
      continue;
    }
    if (value === "own-gate") {
      ownGateMethods += 1;
      if (!adjudicates) {
        fail(`${rel} [${method}]  is own-gate but makes no import-bound call to passkeyEnforcementBlocks`);
      }
      continue;
    }
    if (!isReader) continue;
    if (BYPASSES_PROXY_CHECK.has(value)) {
      if (READER_EXEMPTIONS.has(rel)) usedExemptions.add(rel);
      else if (!adjudicates) {
        fail(
          `${rel} [${method}]  is ${value}, so the proxy never checks its passkey, and it neither calls passkeyEnforcementBlocks nor has a READER_EXEMPTIONS entry${where}`,
        );
      }
      continue;
    }
    if (value === "gated" && entry.kind === "api-default") {
      const key = `${method} ${routePath}`;
      apiDefaultReaders.add(key);
      if (!listedReaders.has(key)) {
        fail(`${rel} [${method}]  is a gated api-default session reader missing from ${PROXY_LIST_NAME}${where}`);
      }
    }
  }
}

for (const key of listedReaders) {
  if (!apiDefaultReaders.has(key)) {
    fail(`${PROXY_LIST_NAME} lists ${key}, which is not a gated api-default route that reads the session`);
  }
}

for (const [rel, reason] of READER_EXEMPTIONS) {
  if (reason.length < MIN_REASON) fail(`READER_EXEMPTIONS ${rel}: reason shorter than ${MIN_REASON} chars`);
  if (!usedExemptions.has(rel)) {
    fail(`READER_EXEMPTIONS ${rel}: stale — not a tier-a / early-return route that reads the session`);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`ERROR: ${f}`);
  console.error(`\nFAIL: ${failures.length} session-reader violation(s).`);
  process.exit(1);
}

console.log(
  `check-session-passkey-readers: routes=${routeFiles.length} readers=${readerFiles} api-default-readers=${apiDefaultReaders.size} own-gate=${ownGateMethods} exemptions=${usedExemptions.size}`,
);
console.log("OK (every session reader is gated by the proxy, listed, exempt with a reason, or adjudicates itself)");
