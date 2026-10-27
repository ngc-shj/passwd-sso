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
 * Helper and constant names are matched through this file's imports and
 * scope-aware bindings (lib/scope-bindings.mjs), so a local function that
 * shadows `tenantAuditBase` does not count as the real one.
 *
 * Runs without a Program (in-memory project). Not covered: a reference reached
 * through a namespace import or a re-exported alias of AUDIT_ACTION, which no
 * call site in this tree uses.
 */
import { SyntaxKind } from "ts-morph";
import { join, dirname } from "node:path";
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

const AUDIT_MODULE = "@/lib/audit/audit";
const CONSTANT_MODULES = new Set(["@/lib/constants", "@/lib/constants/audit/audit"]);
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

/** local name -> { module, imported } for every named import in the file. */
function importMap(sf) {
  const map = new Map();
  for (const decl of sf.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    for (const spec of decl.getNamedImports()) {
      const imported = spec.getName();
      const local = spec.getAliasNode()?.getText() ?? imported;
      map.set(local, { module: specifier, imported });
    }
  }
  return map;
}

/**
 * The exported name `local` stands for at `at`, when it is the named import
 * from one of `modules` and no local declaration shadows it there.
 */
function importedName(local, at, ctx, modules) {
  const entry = ctx.imports.get(local);
  if (!entry || !modules.has(entry.module)) return null;
  if (visibleBinding(local, at, ctx.bindingsFor)) return null;
  return entry.imported;
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
  const recv = expr.getExpression();
  return (
    recv.getKind() === SyntaxKind.Identifier &&
    importedName(recv.getText(), recv, ctx, CONSTANT_MODULES) === "AUDIT_ACTION"
  );
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

/** The scope a spread contributes: TENANT / PERSONAL / TEAM, or null when unknown. */
function spreadScope(expr, ctx, seen) {
  const inner = unwrapExpression(expr);
  if (inner.getKind() === SyntaxKind.CallExpression) {
    const callee = inner.getExpression();
    if (callee.getKind() !== SyntaxKind.Identifier) return null;
    const name = importedName(callee.getText(), callee, ctx, new Set([AUDIT_MODULE]));
    return BASE_HELPERS.get(name) ?? null;
  }
  if (inner.getKind() === SyntaxKind.ObjectLiteralExpression) {
    return effectiveScope(inner, ctx, seen).scope;
  }
  if (inner.getKind() === SyntaxKind.Identifier) {
    const decl = visibleBinding(inner.getText(), inner, ctx.bindingsFor);
    if (!decl || decl.getKind() !== SyntaxKind.VariableDeclaration) return null;
    if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") return null;
    const id = `${decl.getStart()}:${decl.getEnd()}`;
    if (seen.has(id)) return null;
    seen.add(id);
    const init = decl.getInitializer();
    return init ? spreadScope(init, ctx, seen) : null;
  }
  return null;
}

/** The value a `scope:` initializer names, or null when it is not a literal scope. */
function scopeValue(init, ctx) {
  const expr = unwrapExpression(init);
  if (expr.getKind() === SyntaxKind.StringLiteral) return expr.getLiteralText();
  if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  const recv = expr.getExpression();
  if (recv.getKind() !== SyntaxKind.Identifier) return null;
  if (importedName(recv.getText(), recv, ctx, CONSTANT_MODULES) !== "AUDIT_SCOPE") return null;
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
      const s = spreadScope(prop.getExpression(), ctx, seen);
      scope = s ?? "unresolved spread";
      scopeFromHelper = s === "TENANT";
      if (scopeFromHelper) {
        hasTenantId = true;
        tenantIdAfterHelper = false;
      }
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
let scanned = 0;
let writers = 0;

for (const { rel, sf } of sourceFilesFrom(project, SEARCH_DIRS, REPO_ROOT)) {
  scanned++;
  if (rel === DEFINITION_FILE) continue;
  let bindings = null;
  const ctx = {
    imports: importMap(sf),
    bindingsFor: () => (bindings ??= bindingIndex(sf)),
  };

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
