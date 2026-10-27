#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph): every PASSKEY_ENFORCEMENT_BLOCKED audit row is
 * written with TENANT scope.
 *
 * Why: the action is listed for tenant admins only (AUDIT_ACTION_GROUPS_TENANT),
 * and /api/tenant/audit-logs returns TENANT and TEAM scope only. A writer that
 * spreads personalAuditBase files the row where no admin can see it, and no test
 * of the refusal itself notices. Eight writers did exactly that (#976), each
 * passing a correct tenantId beside the wrong scope.
 *
 * The class is derived from the action, not from a list of writers: every
 * reference to the action outside its definition file must be the `action:`
 * value of an object literal, and that literal's effective scope, read in
 * property order (later spreads and `scope:` override earlier ones), must be
 * TENANT:
 *   - `...tenantAuditBase(req, userId, tenantId)` with no later `tenantId:`
 *     override, or
 *   - `scope: AUDIT_SCOPE.TENANT` together with a `tenantId` property.
 * A reference anywhere else (a variable, an argument, a comparison) is refused
 * as unclassifiable rather than guessed about: `const a = AUDIT_ACTION.X;
 * write({ action: a })` would otherwise escape.
 *
 * Helper and constant names are matched through each file's imports and
 * scope-aware bindings (lib/scope-bindings.mjs), so a local function that
 * shadows `tenantAuditBase` does not count as the real one. An import specifier
 * is resolved to a repo path (`@/` -> src/, relative -> against the importing
 * file), and matched against the defining module plus every barrel that
 * re-exports the name — derived from the scanned tree, not listed here. A named
 * import of AUDIT_ACTION from any other module is refused: it would otherwise
 * make every reference in that file invisible. So is any use of AUDIT_ACTION
 * other than `AUDIT_ACTION.<member>` / `AUDIT_ACTION[...]` — a destructuring
 * `const { PASSKEY_ENFORCEMENT_BLOCKED } = AUDIT_ACTION` or an alias
 * `const A = AUDIT_ACTION` would carry the action out of sight.
 *
 * Runs without a Program (in-memory project). Not covered: a computed access
 * with a non-literal key (`AUDIT_ACTION[entry.auditAction]`), whose value the
 * file cannot name.
 */
import { SyntaxKind } from "ts-morph";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom, unresolvedTargets } from "./lib/ast-project.mjs";
import { bindingIndex, unwrapExpression, visibleBinding } from "./lib/scope-bindings.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.PASSKEY_BLOCKED_AUDIT_SCOPE_ROOT
  ? process.env.PASSKEY_BLOCKED_AUDIT_SCOPE_ROOT
  : join(__dirname, "..", "..");
const SEARCH_DIRS = ["src"];

const ACTION = "PASSKEY_ENFORCEMENT_BLOCKED";
// The action's definition and its group listings; no writer lives here.
const DEFINITION_FILE = "src/lib/constants/audit/audit.ts";

// Where the names this gate matches are defined; barrels are derived below.
const CONSTANT_ORIGIN = "src/lib/constants/audit/audit";
const AUDIT_ORIGIN = "src/lib/audit/audit";
const BASE_HELPERS = new Map([
  ["tenantAuditBase", "TENANT"],
  ["personalAuditBase", "PERSONAL"],
  ["teamAuditBase", "TEAM"],
]);

console.log(`check-passkey-blocked-audit-scope: ROOT=${REPO_ROOT} SEARCH_DIRS=${SEARCH_DIRS.join(", ")}`);

function fatal(message) {
  console.error(`\nFAIL: ${message}`);
  process.exit(1);
}

const missingTargets = unresolvedTargets(SEARCH_DIRS, REPO_ROOT);
if (missingTargets.length > 0) fatal(`scan target(s) contributed no source file: ${missingTargets.join(", ")}`);

/** A repo path with its extension and a trailing `/index` removed. */
function canonicalModule(path) {
  return path.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\/index$/, "");
}

/**
 * The canonical repo path `specifier` names from the file at `rel`, or null for
 * a package specifier. `@/` is the tsconfig alias for src/.
 */
function resolveSpecifier(specifier, rel) {
  if (specifier.startsWith("@/")) return canonicalModule(`src/${specifier.slice(2)}`);
  if (specifier.startsWith(".")) return canonicalModule(posix.normalize(posix.join(posix.dirname(rel), specifier)));
  return null;
}

/**
 * Named imports (local name -> { module, imported }) and namespace imports
 * (local name -> module), with `module` the resolved canonical path.
 */
function importMaps(sf, rel) {
  const named = new Map();
  const namespaces = new Map();
  for (const decl of sf.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    const target = resolveSpecifier(specifier, rel);
    const ns = decl.getNamespaceImport();
    if (ns) namespaces.set(ns.getText(), target);
    for (const spec of decl.getNamedImports()) {
      const imported = spec.getName();
      const local = spec.getAliasNode()?.getText() ?? imported;
      named.set(local, { module: target, specifier, imported, line: spec.getStartLineNumber() });
    }
  }
  return { named, namespaces };
}

/**
 * Every module that exports `name` under that name from `origin`: the origin
 * plus each barrel that re-exports it (`export { name } from`, `export * from`,
 * or an import followed by `export { name }`), to a fixpoint. A re-export under
 * another name, or as a namespace, is reported instead: a reference through it
 * could not be matched.
 */
function exportersOf(name, origin, files, problems) {
  const modules = new Set([origin]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { rel, sf, imports } of files) {
      const self = canonicalModule(rel);
      if (modules.has(self)) continue;
      for (const decl of sf.getExportDeclarations()) {
        const specifier = decl.getModuleSpecifierValue();
        let exports = false;
        if (specifier !== undefined) {
          if (!modules.has(resolveSpecifier(specifier, rel))) continue;
          if (decl.getNamespaceExport()) {
            problems.add(`${rel}:${decl.getStartLineNumber()}  re-exports ${name} inside a namespace; the gate cannot follow it`);
            continue;
          }
          if (!decl.hasNamedExports()) exports = true;
        }
        for (const spec of decl.getNamedExports()) {
          if (spec.getName() !== name) continue;
          if (specifier === undefined) {
            const entry = imports.named.get(name);
            if (!entry || entry.imported !== name || !modules.has(entry.module)) continue;
          }
          const alias = spec.getAliasNode()?.getText();
          if (alias && alias !== name) {
            problems.add(`${rel}:${spec.getStartLineNumber()}  re-exports ${name} as ${alias}; the gate cannot follow it`);
            continue;
          }
          exports = true;
        }
        if (exports) {
          modules.add(self);
          grew = true;
          break;
        }
      }
    }
  }
  return modules;
}

/**
 * True when `expr` stands for the export `name` of one of `modules` at its
 * position: a named import of it, or `<namespace>.<name>`, not shadowed by a
 * local declaration.
 */
function refersTo(expr, name, modules, ctx) {
  if (expr.getKind() === SyntaxKind.Identifier) {
    const local = expr.getText();
    const entry = ctx.imports.named.get(local);
    if (!entry || entry.imported !== name || !modules.has(entry.module)) return false;
    return !visibleBinding(local, expr, ctx.bindingsFor);
  }
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression && expr.getName() === name) {
    const recv = expr.getExpression();
    if (recv.getKind() !== SyntaxKind.Identifier) return false;
    const target = ctx.imports.namespaces.get(recv.getText());
    if (!target || !modules.has(target)) return false;
    return !visibleBinding(recv.getText(), recv, ctx.bindingsFor);
  }
  return false;
}

/** The base helper a callee names (tenantAuditBase / ...), or null. */
function baseHelperName(callee, ctx) {
  for (const name of BASE_HELPERS.keys()) {
    if (refersTo(callee, name, ctx.modules.audit, ctx)) return name;
  }
  return null;
}

/** True when `expr` is `<AUDIT_ACTION>.<ACTION>` or `<AUDIT_ACTION>["<ACTION>"]`. */
function isActionReference(expr, ctx) {
  const kind = expr.getKind();
  if (kind === SyntaxKind.PropertyAccessExpression) {
    if (expr.getName() !== ACTION) return false;
  } else if (kind === SyntaxKind.ElementAccessExpression) {
    const arg = expr.getArgumentExpression();
    if (!arg || arg.getKind() !== SyntaxKind.StringLiteral || arg.getLiteralText() !== ACTION) return false;
  } else {
    return false;
  }
  return refersTo(unwrapExpression(expr.getExpression()), "AUDIT_ACTION", ctx.modules.action, ctx);
}

/**
 * Uses of AUDIT_ACTION itself that are not the receiver of a member access —
 * destructuring, aliasing, spreading, passing it along. Each can carry the
 * action to a write this gate never sees.
 */
function bareActionObjectUses(sf, ctx) {
  const sites = [];
  const candidates = [
    ...sf.getDescendantsOfKind(SyntaxKind.Identifier),
    ...sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression),
  ];
  for (const node of candidates) {
    const parent = node.getParent();
    if (!parent) continue;
    // Declaration and property-name positions, and type-level queries, hold no value.
    if (node.getKind() === SyntaxKind.Identifier) {
      const pk = parent.getKind();
      if (pk === SyntaxKind.ImportSpecifier || pk === SyntaxKind.ExportSpecifier || pk === SyntaxKind.NamespaceImport) continue;
      if (pk === SyntaxKind.PropertyAccessExpression && parent.getNameNode() === node) continue;
      if (pk !== SyntaxKind.ShorthandPropertyAssignment && parent.getNameNode?.() === node) continue;
    }
    if (node.getFirstAncestorByKind(SyntaxKind.TypeQuery)) continue;
    if (!refersTo(node, "AUDIT_ACTION", ctx.modules.action, ctx)) continue;
    const outer = outerExpression(node);
    const holder = outer.getParent();
    const hk = holder?.getKind();
    if ((hk === SyntaxKind.PropertyAccessExpression || hk === SyntaxKind.ElementAccessExpression) && holder.getExpression() === outer) {
      continue;
    }
    sites.push(node);
  }
  return sites;
}

/** The outermost expression `node` is the value of, past type-level wrappers. */
function outerExpression(node) {
  let current = node;
  while (current.getParent() && isWrapperOf(current.getParent(), current)) {
    current = current.getParent();
  }
  return current;
}

function isWrapperOf(parent, child) {
  switch (parent.getKind()) {
    case SyntaxKind.ParenthesizedExpression:
    case SyntaxKind.AsExpression:
    case SyntaxKind.NonNullExpression:
    case SyntaxKind.SatisfiesExpression:
      return parent.getExpression() === child;
    default:
      return false;
  }
}

/**
 * What a spread contributes: its scope (TENANT / PERSONAL / TEAM, or null when
 * unknown), whether that scope came from tenantAuditBase, whether it carries a
 * tenantId, and whether a tenantId inside it overrides its own tenantAuditBase.
 * Only a tenantAuditBase call supplies a tenantId by itself; an object literal
 * or a const bound to one carries exactly what its own properties carry.
 */
function spreadContribution(expr, ctx, seen) {
  const unknown = { scope: null, fromHelper: false, hasTenantId: false, overridesHelper: false };
  const inner = unwrapExpression(expr);
  if (inner.getKind() === SyntaxKind.CallExpression) {
    const helper = baseHelperName(unwrapExpression(inner.getExpression()), ctx);
    if (!helper) return unknown;
    const isTenant = helper === "tenantAuditBase";
    return { scope: BASE_HELPERS.get(helper), fromHelper: isTenant, hasTenantId: isTenant, overridesHelper: false };
  }
  if (inner.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const e = effectiveScope(inner, ctx, seen);
    return {
      scope: e.scope,
      fromHelper: e.scopeFromHelper,
      hasTenantId: e.hasTenantId,
      overridesHelper: e.tenantIdAfterHelper,
    };
  }
  if (inner.getKind() === SyntaxKind.Identifier) {
    const decl = visibleBinding(inner.getText(), inner, ctx.bindingsFor);
    if (!decl || decl.getKind() !== SyntaxKind.VariableDeclaration) return unknown;
    if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") return unknown;
    const id = `${decl.getStart()}:${decl.getEnd()}`;
    if (seen.has(id)) return unknown;
    seen.add(id);
    const init = decl.getInitializer();
    return init ? spreadContribution(init, ctx, seen) : unknown;
  }
  return unknown;
}

/** The value a `scope:` initializer names, or null when it is not a literal scope. */
function scopeValue(init, ctx) {
  const expr = unwrapExpression(init);
  if (expr.getKind() === SyntaxKind.StringLiteral) return expr.getLiteralText();
  if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  if (!refersTo(unwrapExpression(expr.getExpression()), "AUDIT_SCOPE", ctx.modules.scope, ctx)) return null;
  return expr.getName();
}

/**
 * Walk the literal's properties in order. Returns the last scope written, and
 * whether the tenant comes from tenantAuditBase without a later override or
 * from an explicit `tenantId` property.
 */
function effectiveScope(obj, ctx, seen = new Set()) {
  let scope = "missing";
  let scopeFromHelper = false;
  let tenantIdAfterHelper = false;
  let hasTenantId = false;
  for (const prop of obj.getProperties()) {
    const kind = prop.getKind();
    if (kind === SyntaxKind.SpreadAssignment) {
      const c = spreadContribution(prop.getExpression(), ctx, seen);
      scope = c.scope ?? "unresolved spread";
      scopeFromHelper = c.fromHelper;
      tenantIdAfterHelper = c.overridesHelper;
      if (c.hasTenantId) hasTenantId = true;
      continue;
    }
    const name = prop.getName?.();
    if (name === "scope") {
      scope =
        kind === SyntaxKind.PropertyAssignment ? scopeValue(prop.getInitializer(), ctx) ?? "unresolved" : "unresolved";
      scopeFromHelper = false;
    } else if (name === "tenantId") {
      hasTenantId = true;
      if (scopeFromHelper) tenantIdAfterHelper = true;
    }
  }
  return { scope, scopeFromHelper, tenantIdAfterHelper, hasTenantId };
}

const project = createAstProject();
const failures = [];
let writers = 0;

const files = [];
for (const { rel, sf } of sourceFilesFrom(project, SEARCH_DIRS, REPO_ROOT)) {
  files.push({ rel, sf, imports: importMaps(sf, rel) });
}
const scanned = files.length;

const exportProblems = new Set();
const modules = {
  action: exportersOf("AUDIT_ACTION", CONSTANT_ORIGIN, files, exportProblems),
  scope: exportersOf("AUDIT_SCOPE", CONSTANT_ORIGIN, files, exportProblems),
  audit: new Set(
    [...BASE_HELPERS.keys()].flatMap((name) => [...exportersOf(name, AUDIT_ORIGIN, files, exportProblems)]),
  ),
};
failures.push(...exportProblems);

for (const { rel, sf, imports } of files) {
  if (rel === DEFINITION_FILE) continue;
  let bindings = null;
  const ctx = {
    imports,
    modules,
    bindingsFor: () => (bindings ??= bindingIndex(sf)),
  };

  for (const entry of imports.named.values()) {
    if (entry.imported === "AUDIT_ACTION" && !modules.action.has(entry.module)) {
      failures.push(`${rel}:${entry.line}  imports AUDIT_ACTION from "${entry.specifier}", which is not a module this gate recognises as defining it`);
    }
  }
  for (const site of bareActionObjectUses(sf, ctx)) {
    failures.push(`${rel}:${site.getStartLineNumber()}  uses AUDIT_ACTION other than as \`AUDIT_ACTION.<member>\`; the gate cannot follow ${ACTION} out of it`);
  }

  const references = [
    ...sf.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression),
    ...sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression),
  ].filter((expr) => isActionReference(expr, ctx));
  // A bare string spelling of the action is a reference too, but only the
  // `action:` position can be classified.
  const literals = [
    ...sf.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ].filter((lit) => lit.getLiteralText() === ACTION && lit.getParent()?.getKind() !== SyntaxKind.ElementAccessExpression);

  for (const ref of [...references, ...literals]) {
    const where = `${rel}:${ref.getStartLineNumber()}`;
    const value = outerExpression(ref);
    const prop = value.getParent();
    if (
      !prop ||
      prop.getKind() !== SyntaxKind.PropertyAssignment ||
      prop.getName() !== "action" ||
      prop.getInitializer() !== value ||
      prop.getParent()?.getKind() !== SyntaxKind.ObjectLiteralExpression
    ) {
      failures.push(`${where}  references ${ACTION} outside an \`action:\` property of an object literal; the gate cannot tell which scope it is written with`);
      continue;
    }
    writers++;
    const { scope, scopeFromHelper, tenantIdAfterHelper, hasTenantId } = effectiveScope(prop.getParent(), ctx);
    if (scope !== "TENANT") {
      failures.push(`${where}  writes ${ACTION} with scope ${scope}; spread tenantAuditBase(req, userId, tenantId) so tenant admins see the row`);
    } else if (scopeFromHelper && tenantIdAfterHelper) {
      failures.push(`${where}  overrides the tenantId given to tenantAuditBase with a later \`tenantId:\``);
    } else if (!hasTenantId) {
      failures.push(`${where}  sets scope TENANT without a tenantId`);
    }
  }
}

if (scanned === 0) fatal("scanned zero source files.");
if (writers === 0 && failures.length === 0) {
  fatal(`found no ${ACTION} writer — the scan set or the action's spelling no longer matches the tree.`);
}

if (failures.length > 0) {
  for (const f of failures) console.error(`ERROR: ${f}`);
  fatal(`${failures.length} ${ACTION} writer(s) not TENANT-scoped.`);
}

console.log(`check-passkey-blocked-audit-scope: files=${scanned} writers=${writers}`);
console.log(`OK (every ${ACTION} writer spreads tenantAuditBase or sets TENANT scope with a tenantId)`);
