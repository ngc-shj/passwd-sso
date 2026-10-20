/**
 * The forms that would make the shared resolver's answers wrong, refused over
 * all production code rather than assumed absent. They keep the analysis
 * tractable; they do not make it complete, and no further rule is to be added
 * to chase completeness — the runtime guards are the boundary (see the gates'
 * headers).
 *
 * The resolver names a function by its declaration: a member holds what its
 * declaration initialises it to, an interface member is one of the production
 * members that can stand in for it. That is only true while nothing puts a
 * different function there by other means. Following every such write was
 * tried for three review rounds, and each round found a write form it missed
 * (an alias, a cast, a nested path, Object.assign on `this`). These rules
 * refuse the forms instead, so the declaration is the whole answer:
 *
 *   G1  no write to an own member that may hold a function (its type is
 *       callable, `unknown`, `any`, `object`…), or of a function into any
 *       member, other than its declaration's initializer (`ops.run = f`,
 *       `this.run = f`, a destructuring, compound or for-of target), and no
 *       write of a function through a key no declaration names;
 *   G2  no object mutator (Object.assign, defineProperty, setPrototypeOf,
 *       Reflect.set …, recognised by the declaration a reference resolves to)
 *       used other than by a direct call, nor on `this`, an `any`/`unknown`
 *       value, or an object with own members that may hold functions;
 *   G3  no computed-key member that may hold a function;
 *   G4  no constructor parameter property that may hold a function;
 *   G5  no class expression with `extends`, and no `extends` of anything but
 *       the name of a class declaration (an import rename passes, a const
 *       alias does not) — derived classes are enumerated by name;
 *   G6  no object holding own functions (or accessors) widened to a type that
 *       names none of its members (`any`, `unknown`, a type parameter,
 *       `object`, `{}`, a record) — by a cast, an annotation, an assignment,
 *       an argument to an own function or a return;
 *   G7  no value of unknown origin (`any`, `unknown`, a record) narrowed by
 *       those flows to a type holding functions, except a registered external
 *       shape (EXTERNAL_SHAPE_ALLOWLIST) given a value traced to its supplying
 *       package; no own value or class takes a registered shape.
 *
 * An interface member is resolved to every production member of that NAME
 * that may hold a function, so a cast or a structural assignment cannot hide
 * an implementation: neither renames a member.
 *
 * The scan set is deny-by-default: every own code file on disk is production
 * unless NON_PRODUCTION / NON_PRODUCTION_SCRIPTS declares it otherwise
 * (lib/function-resolver.mjs), and must be in the Program; so is every module production
 * code loads (`import()`, `require`, a createRequire loader). A load's
 * specifier is evaluated from its value, never an asserted type. A load the
 * compiler cannot resolve to TypeScript the gates can read — own JavaScript, a declaration
 * shim over own code, an own specifier that does not resolve, a non-literal
 * specifier — is refused, as is production loading declared tooling and
 * tooling whose closure reaches the RLS helpers or the database client.
 */
import { Project, SyntaxKind, ts } from "ts-morph";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  CODE_FILE,
  EXTERNAL_SHAPE_ALLOWLIST,
  FN_KINDS,
  NON_PRODUCTION_SCRIPTS,
  isModuleLoadCall,
  originModules,
  isDeclaredNonProduction,
  isProductionPath,
  mayBeCallable,
  unmatchedNonProduction,
  mayHoldOwnCode,
  specifiersOf,
  toRelPosix,
  unwrap,
} from "./function-resolver.mjs";

// Production modules loaded through a non-literal specifier, with what they
// load. The specifier cannot be resolved, so each entry is a reviewed claim.
export const NON_LITERAL_LOAD_ALLOWLIST = new Map([
  ["src/i18n/messages.ts", "next-intl message JSON under messages/"],
]);

// Reviewed exceptions to G1-G7, keyed "file::function <name>::rule" or
// "file::method <Class>.<name>::rule" by the declaration the violation is in,
// with the number of sites it excuses. A different count — a new write in the
// same function, or one gone — fails the run, as does an entry that matches nothing.
export const FUNCTION_FLOW_ALLOWLIST = new Map([
  // Conversion traps on a null-prototype object. They run only through an
  // implicit conversion (String(x), JSON.stringify), which neither gate
  // follows, and throwOnConversion only throws.
  ["src/lib/prisma/raw-sql.ts::function createGenuineObject::G1", { sites: 2, why: "conversion traps: toJSON and Symbol.toPrimitive" }],
  // Data copied key by key into a record. The values are `unknown` because
  // they are request, event or row data, never one of our functions; the
  // records are serialised or sent, never called through.
  ["src/lib/security/sentry-scrub.ts::function scrubObject::G1", { sites: 1, why: "scrubbed Sentry event data" }],
  ["src/lib/security/sentry-scrub.ts::function scrubSentryEvent::G1", { sites: 5, why: "scrubbed Sentry event data" }],
  ["src/lib/security/sentry-scrub.ts::function scrubSpanData::G1", { sites: 1, why: "scrubbed Sentry span data" }],
  ["src/lib/security/sentry-scrub.ts::function scrubStreamedAttributes::G1", { sites: 1, why: "scrubbed Sentry span attributes" }],
  ["src/lib/constants/auth/share-permission.ts::function applySharePermissions::G1", { sites: 3, why: "share payload fields filtered by permission" }],
  ["src/lib/vault/entry-save-core.ts::function buildEncryptedEntryBody::G1", { sites: 1, why: "request body fields of an entry save" }],
  ["src/workers/retention-gc-worker/sweep.ts::function sweepAuditProvenanceEntry::G1", { sites: 1, why: "provenance column values of a swept row" }],
  ["src/app/api/tenant/policy/route.ts::function handlePATCH::G1", { sites: 1, why: "policy columns of a Prisma update" }],
  ["src/components/settings/developer/service-account-card.tsx::function ServiceAccountCard::G3", { sites: 1, why: "React state keyed by service-account id" }],
]);

// Tooling must not reach these: it is excluded from the scan on the premise
// that it opens no RLS context and holds no database client.
const TOOLING_FORBIDDEN = ["src/lib/tenant-rls.ts", "src/lib/tenant-context.ts", "src/lib/prisma.ts"];

const DATA_EXTENSIONS = /\.(css|scss|json|svg|png|jpg|jpeg|gif|webp|ico|txt|md)$/;

const isExternalFile = (sf) => sf.isDeclarationFile() || sf.getFilePath().includes("/node_modules/");
const siteOf = (node) => `${toRelPosix(node.getSourceFile().getFilePath())}:${node.getStartLineNumber()}`;

/** Every module load in `sf`: static imports/exports and `import()`/`require()`. */
function loadsOf(sf) {
  const out = [];
  for (const decl of [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]) {
    const spec = decl.getModuleSpecifierValue?.();
    if (spec !== undefined) out.push({ node: decl, spec });
  }
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!isModuleLoadCall(call)) continue;
    const specs = specifiersOf(call.getArguments()[0]);
    if (specs) for (const spec of specs) out.push({ node: call, spec });
    else out.push({ node: call, spec: null });
  }
  return out;
}

const SKIPPED_DIRS = new Set(["node_modules", ".git", ".next"]);

/**
 * Every own code file on disk, cwd-relative: what git tracks or would track
 * (`--exclude-standard`), or, outside a work tree, a walk of the directory.
 */
function ownCodeFilesOnDisk() {
  if (existsSync(".git")) {
    const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return listed.split("\n").filter((f) => CODE_FILE.test(f) && existsSync(f));
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (CODE_FILE.test(entry.name)) out.push(rel);
    }
  };
  walk(".");
  return out;
}

/**
 * The production scan set and the boundary violations found building it.
 * Returns { files: Set<absolute path>, isProduction(node), violations }.
 */
export function productionScope(program) {
  const options = program.getCompilerOptions();
  const own = program.getSourceFiles().filter((sf) => !isExternalFile(sf));
  const seeds = own.filter((sf) => isProductionPath(toRelPosix(sf.getFilePath())));
  const files = new Set(seeds.map((sf) => sf.getFilePath()));
  const violations = [];

  // The denominator is the disk, not the Program: a production file the
  // Program does not hold (excluded by tsconfig, an extension `include` does
  // not match, an entry nothing imports) is code neither gate reads.
  const onDisk = ownCodeFilesOnDisk();
  const ownRels = new Set(own.map((sf) => toRelPosix(sf.getFilePath())));
  for (const rel of onDisk) {
    if (isProductionPath(rel) && !ownRels.has(rel)) {
      violations.push(`${rel}  production code the gates cannot read: the Program does not hold it (add it to tsconfig, or declare it in NON_PRODUCTION with a reason)`);
    }
  }

  // The declarations must still name something: an entry that matches no file
  // on disk or in the Program (generated, gitignored) would excuse the next file that lands at it without review. (A
  // path absent altogether is a fixture tree's; the repository test pins
  // that every entry exists in the real one.)
  for (const entry of unmatchedNonProduction([...onDisk, ...ownRels])) {
    const path = entry.prefix ?? entry.file;
    if (existsSync(path)) violations.push(`${path}  NON_PRODUCTION entry matches no file; remove it`);
  }
  for (const tool of NON_PRODUCTION_SCRIPTS) {
    if (existsSync(tool) && !onDisk.includes(tool)) violations.push(`${tool}  NON_PRODUCTION_SCRIPTS entry is not an own code file; remove it`);
  }

  // Tooling outside the Program is parsed on its own for its closure check.
  let side = null;
  const parsedAt = (abs) =>
    program.getSourceFile(abs) ??
    (side ??= new Project({
      skipAddingFilesFromTsConfig: true,
      skipFileDependencyResolution: true,
      compilerOptions: { allowJs: true, jsx: ts.JsxEmit.ReactJSX },
    })).addSourceFileAtPathIfExists(abs);

  /** The own TypeScript module a load resolves to, null for a library or data, or { problem }. */
  function resolveLoad(sf, spec, lookup = (abs) => program.getSourceFile(abs), { readsJs = false } = {}) {
    if (spec === null) return { problem: "loads a module through a non-literal specifier" };
    const resolved = ts.resolveModuleName(spec, sf.getFilePath(), options, ts.sys).resolvedModule;
    if (!resolved) {
      if (DATA_EXTENSIONS.test(spec)) return null;
      if (spec.startsWith(".") || spec.startsWith("@/") || spec.startsWith("/")) return { problem: `loads ${spec}, which does not resolve` };
      return null; // a bare package the compiler cannot see is a library
    }
    const target = resolved.resolvedFileName;
    if (resolved.isExternalLibraryImport || target.includes("/node_modules/")) return null;
    if (/\.[cm]?jsx?$/.test(target)) {
      // Tooling's closure is read whatever it is written in.
      if (readsJs) return lookup(target) ? { sf: lookup(target) } : { problem: `loads ${toRelPosix(target)}, which cannot be read` };
      return { problem: `loads ${toRelPosix(target)}, own JavaScript the gates cannot read` };
    }
    if (/\.d\.[cm]?ts$/.test(target)) {
      // A declaration over own JavaScript beside it hides that code; one with
      // no implementation here only types a library.
      const stem = target.replace(/\.d\.[cm]?ts$/, "");
      const impl = [".js", ".mjs", ".cjs", ".jsx"].map((e) => stem + e).find((f) => existsSync(f));
      return impl ? { problem: `loads ${toRelPosix(target)}, a declaration over own JavaScript (${toRelPosix(impl)}) the gates cannot read` } : null;
    }
    const targetSf = lookup(target);
    if (!targetSf) return { problem: `loads ${toRelPosix(target)}, which is not in the Program` };
    return { sf: targetSf };
  }

  const queue = [...seeds];
  const usedNonLiteral = new Set();
  while (queue.length > 0) {
    const sf = queue.shift();
    const rel = toRelPosix(sf.getFilePath());
    for (const { node, spec } of loadsOf(sf)) {
      const r = resolveLoad(sf, spec);
      if (!r) continue;
      if (r.problem) {
        if (spec === null && NON_LITERAL_LOAD_ALLOWLIST.has(rel)) {
          usedNonLiteral.add(rel);
          continue;
        }
        violations.push(`${siteOf(node)}  production code ${r.problem}`);
        continue;
      }
      const targetRel = toRelPosix(r.sf.getFilePath());
      if (isDeclaredNonProduction(targetRel)) {
        violations.push(`${siteOf(node)}  production code imports ${targetRel}, which is declared non-production`);
        continue;
      }
      if (!files.has(r.sf.getFilePath())) {
        files.add(r.sf.getFilePath());
        queue.push(r.sf);
      }
    }
  }

  for (const rel of NON_LITERAL_LOAD_ALLOWLIST.keys()) {
    if (!usedNonLiteral.has(rel) && existsSync(rel)) {
      violations.push(`${rel}  NON_LITERAL_LOAD_ALLOWLIST entry matches no load the specifier's type leaves unnamed; remove it`);
    }
  }

  // Tooling: its own closure must stay clear of the RLS helpers and the client.
  for (const toolRel of NON_PRODUCTION_SCRIPTS) {
    if (!existsSync(toolRel)) continue;
    const tool = parsedAt(resolve(toolRel));
    const seen = new Set([tool.getFilePath()]);
    const toolQueue = [{ sf: tool, via: null }];
    while (toolQueue.length > 0) {
      const { sf, via } = toolQueue.shift();
      for (const { node, spec } of loadsOf(sf)) {
        const r = resolveLoad(sf, spec, parsedAt, { readsJs: true });
        if (!r || r.problem) continue;
        const targetRel = toRelPosix(r.sf.getFilePath());
        const from = via ?? siteOf(node);
        if (TOOLING_FORBIDDEN.includes(targetRel)) {
          violations.push(`${from}  ${toolRel} is listed as non-production tooling but its imports reach ${targetRel}`);
          continue;
        }
        if (!seen.has(r.sf.getFilePath())) {
          seen.add(r.sf.getFilePath());
          toolQueue.push({ sf: r.sf, via: from });
        }
      }
    }
  }

  const isProduction = (node) => files.has(node.getSourceFile().getFilePath());
  return { files, isProduction, violations: [...new Set(violations)] };
}

const literalKeyOf = (access) => {
  const arg = unwrap(access.getArgumentExpression?.());
  const k = arg?.getKind();
  return k === SyntaxKind.StringLiteral || k === SyntaxKind.NoSubstitutionTemplateLiteral || k === SyntaxKind.NumericLiteral
    ? arg.getLiteralText()
    : null;
};
const typeText = (t) => t.getText(undefined, ts.TypeFormatFlags.NoTruncation).replace(/\s+/g, " ").slice(0, 60);
const isAssignmentOperator = (op) => op >= SyntaxKind.FirstAssignment && op <= SyntaxKind.LastAssignment;
const isMemberTarget = (e) => e?.getKind() === SyntaxKind.PropertyAccessExpression || e?.getKind() === SyntaxKind.ElementAccessExpression;

/**
 * The member expressions `node` writes, each with the value written when one
 * is visible: `a.b = v`, `a[k] += v`, the member leaves of a destructuring
 * assignment (`({ x: a.b } = o)`, `[a.b] = arr`), a `for (a.b of …)` target.
 */
function writeTargetsOf(node) {
  const out = [];
  const leaves = (pattern) => {
    const e = unwrap(pattern);
    if (isMemberTarget(e)) {
      out.push({ target: e, value: null });
    } else if (e?.getKind() === SyntaxKind.ObjectLiteralExpression) {
      for (const p of e.getProperties()) {
        if (p.getKind() === SyntaxKind.PropertyAssignment) leaves(p.getInitializer());
        else if (p.getKind() === SyntaxKind.SpreadAssignment) leaves(p.getExpression());
      }
    } else if (e?.getKind() === SyntaxKind.ArrayLiteralExpression) {
      for (const el of e.getElements()) leaves(el.getKind() === SyntaxKind.SpreadElement ? el.getExpression() : el);
    }
    // A default (`({ x: a.b = d } = o)`) is an `=` the traversal visits on its own.
  };
  const k = node.getKind();
  if (k === SyntaxKind.BinaryExpression && isAssignmentOperator(node.getOperatorToken().getKind())) {
    const left = unwrap(node.getLeft());
    if (isMemberTarget(left)) out.push({ target: left, value: node.getRight() });
    else if (node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) leaves(left);
  } else if (k === SyntaxKind.ForOfStatement || k === SyntaxKind.ForInStatement) {
    const init = node.getInitializer();
    if (init && init.getKind() !== SyntaxKind.VariableDeclarationList) leaves(init);
  }
  return out;
}

/**
 * Whether a TARGET type names none of a value's members: `any`, `unknown`, a
 * type parameter (by its constraint), `object`, `{}`, an index-signature-only
 * record. A union is loose when any member is.
 */
function isLooseTarget(t, depth = 0) {
  if (depth > 3) return true;
  if (t.isAny() || t.isUnknown()) return true;
  if (t.isUnion()) return t.getUnionTypes().some((u) => !u.isNull() && !u.isUndefined() && isLooseTarget(u, depth + 1));
  if (t.isTypeParameter()) {
    const c = t.getConstraint();
    return c ? isLooseTarget(c, depth + 1) : true;
  }
  if (t.getFlags() & ts.TypeFlags.NonPrimitive) return true;
  if (t.isIntersection()) return t.getIntersectionTypes().every((u) => isLooseTarget(u, depth + 1));
  return t.isObject() && !t.isArray() && !t.isTuple() && t.getProperties().length === 0 &&
    t.getCallSignatures().length === 0 && t.getConstructSignatures().length === 0;
}

/**
 * The value flows `node` makes, each as { source, target } with the target's
 * declared type: a type assertion, an annotated initializer, an assignment,
 * an argument to an own function (its parameter's DECLARED type, so a type
 * parameter counts as such), a returned value against a declared return type.
 */
export function flowsOf(node, checker, holdsFunctions) {
  const k = node.getKind();
  if (k === SyntaxKind.AsExpression || k === SyntaxKind.TypeAssertionExpression) {
    if (node.getTypeNode?.()?.getText() === "const") return [];
    return [{ source: node.getExpression(), target: node.getType() }];
  }
  if (k === SyntaxKind.VariableDeclaration && node.getTypeNode?.() && node.getInitializer()) {
    return [{ source: node.getInitializer(), target: node.getType() }];
  }
  if (k === SyntaxKind.BinaryExpression && node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
    const left = node.getLeft();
    if (left.getKind() === SyntaxKind.ObjectLiteralExpression || left.getKind() === SyntaxKind.ArrayLiteralExpression) return [];
    return [{ source: node.getRight(), target: left.getType() }];
  }
  if (k === SyntaxKind.CallExpression || k === SyntaxKind.NewExpression) {
    // Typing the arguments is the costly step, so first the callee: only an
    // own one is judged (a library is handed values; reach covers those).
    const callee = unwrap(node.getExpression());
    const nameNode = callee?.getKind() === SyntaxKind.PropertyAccessExpression ? callee.getNameNode() : callee;
    let symbol = nameNode?.getSymbol?.();
    if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
    const calleeDecls = symbol?.getDeclarations() ?? [];
    if (calleeDecls.length > 0 && calleeDecls.every((d) => isExternalFile(d.getSourceFile()))) return [];
    if (!(node.getArguments?.() ?? []).some((a) => holdsFunctions(a.getType()))) return [];
    const decl = checker.getResolvedSignature(node)?.getDeclaration();
    if (!decl || isExternalFile(decl.getSourceFile())) return [];
    const params = decl.getParameters?.() ?? [];
    if (params.length === 0) return [];
    return (node.getArguments?.() ?? []).flatMap((arg, i) => {
      const p = params[Math.min(i, params.length - 1)];
      if (i >= params.length && !p.getDotDotDotToken()) return [];
      const declared = p.getType();
      const target = p.getDotDotDotToken() ? (declared.getArrayElementType?.() ?? declared) : declared;
      return arg.getKind() === SyntaxKind.SpreadElement ? [] : [{ source: arg, target }];
    });
  }
  if (k === SyntaxKind.ReturnStatement && node.getExpression()) {
    const fn = node.getFirstAncestor((a) => FN_KINDS.has(a.getKind()));
    if (!fn?.getReturnTypeNode?.()) return [];
    let target = fn.getReturnType();
    if (fn.isAsync?.() && target.getTypeArguments?.().length === 1) target = target.getTypeArguments()[0];
    return [{ source: node.getExpression(), target }];
  }
  return [];
}

/** Whether a call resolves to one of the library's object mutators. */
const MUTATOR_OWNERS = new Map([
  ["ObjectConstructor", new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"])],
  ["Reflect", new Set(["set", "defineProperty", "setPrototypeOf"])],
]);
const MUTATOR_NAMES = new Set([...MUTATOR_OWNERS.values()].flatMap((names) => [...names]));

/** "Owner.name" when `decl` is one of the library's object mutators, else null. */
function libraryMutatorName(decl) {
  if (!decl || !isExternalFile(decl.getSourceFile())) return null;
  const name = decl.getName?.();
  let owner = decl.getParent();
  if (owner?.getKind() === SyntaxKind.ModuleBlock) owner = owner.getParent();
  const ownerName = owner?.getName?.();
  return name && MUTATOR_OWNERS.get(ownerName)?.has(name) ? `${ownerName}.${name}` : null;
}

/**
 * The library mutator a node REFERS to, by the declaration it resolves to,
 * as { name, access }: `Object.assign` (the name of a member access),
 * `Object[key]` with a key whose type is a literal or a literal union, a
 * destructure `const { assign } = Object`. A key on an object holding a
 * mutator that is not reduced to literals may name one, and counts. Names
 * only pre-filter.
 */
function mutatorReferencedBy(node) {
  const k = node.getKind();
  const parent = node.getParent();
  const first = (decls) => decls.map(libraryMutatorName).find(Boolean) ?? null;
  if (k === SyntaxKind.Identifier && MUTATOR_NAMES.has(node.getText())) {
    if (parent?.getKind() === SyntaxKind.BindingElement && (parent.getPropertyNameNode() ?? parent.getNameNode()) === node) {
      const holder = parent.getParent()?.getParent();
      const source = holder?.getKind() === SyntaxKind.VariableDeclaration ? holder.getInitializer() : null;
      const name = first(source?.getType().getProperty(node.getText())?.getDeclarations() ?? []);
      return name ? { name, access: parent } : null;
    }
    if (parent?.getKind() === SyntaxKind.PropertyAccessExpression && parent.getNameNode() === node) {
      let symbol = node.getSymbol();
      if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
      const name = first(symbol?.getDeclarations() ?? []);
      return name ? { name, access: parent } : null;
    }
    return null;
  }
  if (k === SyntaxKind.ElementAccessExpression) {
    const receiver = node.getExpression().getType();
    const held = [...MUTATOR_NAMES].map((n) => first(receiver.getProperty(n)?.getDeclarations() ?? [])).filter(Boolean);
    if (held.length === 0) return null; // not an object that holds a mutator
    const keyType = node.getArgumentExpression()?.getType();
    const parts = keyType ? (keyType.isUnion() ? keyType.getUnionTypes() : [keyType]) : [];
    if (parts.length === 0 || !parts.every((u) => u.isStringLiteral())) return { name: `${held[0]} (by a key that may name it)`, access: node };
    const name = parts.map((u) => first(receiver.getProperty(u.getLiteralValue())?.getDeclarations() ?? [])).find(Boolean);
    return name ? { name, access: node } : null;
  }
  return null;
}

/** The call a member reference is the direct callee of, through parentheses, or null. */
function directCallOf(access) {
  let cur = access;
  while (cur.getParent()?.getKind() === SyntaxKind.ParenthesizedExpression) cur = cur.getParent();
  const call = cur.getParent();
  return call?.getKind() === SyntaxKind.CallExpression && call.getExpression() === cur ? call : null;
}

/** The EXTERNAL_SHAPE_ALLOWLIST key a type is declared as, or null. */
function externalShapeKeyOf(type) {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  for (const d of symbol?.getDeclarations() ?? []) {
    const k = d.getKind();
    if (k !== SyntaxKind.InterfaceDeclaration && k !== SyntaxKind.TypeAliasDeclaration) continue;
    const key = `${toRelPosix(d.getSourceFile().getFilePath())}::${d.getName()}`;
    if (EXTERNAL_SHAPE_ALLOWLIST.has(key)) return key;
  }
  return null;
}

/**
 * Violations of G1–G7 in the production files `scope` names, as
 * "file:line  description" strings.
 */
/**
 * The global-singleton idiom: `globalThis as unknown as { prisma?: PrismaClient }`
 * — the library's `globalThis`, by its declaration, cast on to a type whose
 * members are all named and none may hold a function. A write through it
 * lands on one of those members and G1 judges it. Cast on to a record or any
 * other loose type, it is a plain widening.
 */
function isGlobalSingletonHolder(source) {
  const e = unwrap(source);
  if (e?.getKind() !== SyntaxKind.Identifier || e.getText() !== "globalThis") return false;
  const decls = e.getSymbol()?.getDeclarations() ?? [];
  if (decls.length > 0 && !decls.every((d) => isExternalFile(d.getSourceFile()))) return false;
  let outer = e.getParent();
  while (outer?.getKind() === SyntaxKind.ParenthesizedExpression) outer = outer.getParent();
  let cur = outer?.getParent();
  while (cur?.getKind() === SyntaxKind.ParenthesizedExpression) cur = cur.getParent();
  if (cur?.getKind() !== SyntaxKind.AsExpression) return false;
  const props = cur.getType().getProperties();
  return props.length > 0 && props.every((p) => !mayHoldOwnCode(p.getTypeAtLocation(cur)));
}

export function functionFlowViolations(program, scope, usedShapes = new Set()) {
  const checker = program.getTypeChecker();
  const isOwn = (node) => !isExternalFile(node.getSourceFile());
  const found = [];
  const excused = new Map(); // key -> sites seen
  const out = {
    push(line) {
      const node = currentNode;
      const rule = line.match(/ (G\d):/)?.[1];
      const fn = node.getFirstAncestor((a) => a.getKind() === SyntaxKind.FunctionDeclaration || a.getKind() === SyntaxKind.MethodDeclaration);
      const owner =
        fn?.getKind() === SyntaxKind.MethodDeclaration
          ? `method ${fn.getParent()?.getName?.() ?? "<anonymous>"}.${fn.getName()}`
          : fn
            ? `function ${fn.getName() ?? "<anonymous>"}`
            : "<module>";
      const key = `${toRelPosix(node.getSourceFile().getFilePath())}::${owner}::${rule}`;
      if (FUNCTION_FLOW_ALLOWLIST.has(key)) excused.set(key, (excused.get(key) ?? 0) + 1);
      else found.push(line);
    },
  };
  let currentNode = null;
  const memberMayBeFunction = (symbol) => {
    const decls = symbol.getDeclarations();
    if (decls.length === 0 || !decls.some(isOwn)) return false;
    const at = symbol.getValueDeclaration() ?? decls[0];
    return mayHoldOwnCode(symbol.getTypeAtLocation(at));
  };
  // G6's source: own members typed callable. (A function in a member typed
  // `unknown` got there by a write G1 refuses, or by an initializer whose
  // literal type is callable.)
  const callableMemo = new Map();
  const hasCallableOwnMembers = (type, depth = 0) => {
    if (depth > 2) return false;
    const key = type.compilerType;
    if (depth === 0 && callableMemo.has(key)) return callableMemo.get(key);
    const result = hasCallableOwnMembersUncached(type, depth);
    if (depth === 0) callableMemo.set(key, result);
    return result;
  };
  const hasCallableOwnMembersUncached = (type, depth) => {
    const t = type.getNonNullableType();
    if (t.isUnion()) return t.getUnionTypes().some((u) => hasCallableOwnMembers(u, depth + 1));
    if (t.isIntersection()) return t.getIntersectionTypes().some((u) => hasCallableOwnMembers(u, depth + 1));
    return t.getProperties().some((p) => {
      const decls = p.getDeclarations();
      if (decls.length === 0 || !decls.some(isOwn)) return false;
      // An accessor runs code when read, a constructor when called with new.
      if (decls.some((d) => isOwn(d) && (d.getKind() === SyntaxKind.GetAccessor || d.getKind() === SyntaxKind.SetAccessor))) return true;
      const pt = p.getTypeAtLocation(p.getValueDeclaration() ?? decls[0]);
      return mayBeCallable(pt) || pt.getConstructSignatures().length > 0;
    });
  };
  const hasOwnFunctionMembers = (type, depth = 0) => {
    if (depth > 2) return false;
    const t = type.getNonNullableType();
    if (t.isUnion()) return t.getUnionTypes().some((u) => hasOwnFunctionMembers(u, depth + 1));
    if (t.isIntersection()) return t.getIntersectionTypes().some((u) => hasOwnFunctionMembers(u, depth + 1));
    return t.getProperties().some(memberMayBeFunction);
  };

  for (const path of scope.files) {
    const sf = program.getSourceFile(path);
    if (!sf) continue;
    sf.forEachDescendant((node) => {
      const kind = node.getKind();
      currentNode = node;

      if (kind === SyntaxKind.PropertyAssignment || kind === SyntaxKind.MethodDeclaration || kind === SyntaxKind.PropertyDeclaration) {
        if (node.getNameNode().getKind() === SyntaxKind.ComputedPropertyName && mayHoldOwnCode(node.getType())) {
          out.push(`${siteOf(node)}  G3: computed-key member holding a function`);
        }
        return;
      }

      // G6: an object holding own functions widened to a type that names
      // none of its members. Through the wider type it can be written by key
      // or by a mutator in ways G1/G2 judge by that type, and miss.
      // An argument is worth typing when it holds functions (G6) or nobody
      // named it (G7: `use(built)` with `built: any` narrows as surely as a cast).
      for (const { source, target } of flowsOf(node, checker, (t) => hasCallableOwnMembers(t) || isLooseTarget(t))) {
        const sourceType = source.getType();
        currentNode = source;
        if (isLooseTarget(target) && hasCallableOwnMembers(sourceType) && !isGlobalSingletonHolder(source)) {
          out.push(`${siteOf(source)}  G6: object holding functions widened to ${typeText(target)}`);
          continue;
        }
        // G7: a value nobody named, narrowed to a type that holds functions.
        // Only a declared external shape may be, and only with a value from
        // its package; no own value may take that type.
        const shape = externalShapeKeyOf(target);
        if (shape) {
          usedShapes.add(shape);
          if (!isLooseTarget(sourceType)) {
            out.push(`${siteOf(source)}  G7: own value given the external shape ${shape}`);
            continue;
          }
          const pkg = EXTERNAL_SHAPE_ALLOWLIST.get(shape);
          const origin = originModules(source);
          if (!origin || ![...origin].every((m) => m === pkg)) {
            const from = origin ? [...origin].join(", ") : "nothing traceable";
            out.push(`${siteOf(source)}  G7: ${shape} is supplied by ${pkg}, but this value comes from ${from}`);
          }
          continue;
        }
        if (isLooseTarget(sourceType) && hasCallableOwnMembers(target)) {
          out.push(`${siteOf(source)}  G7: value nobody named narrowed to ${typeText(target)}, which holds functions`);
        }
      }

      // G1, by write site: every member a write lands on.
      const targets = writeTargetsOf(node);
      for (const { target, value } of targets) {
        currentNode = target;
        const key = target.getKind() === SyntaxKind.ElementAccessExpression ? literalKeyOf(target) : null;
        const symbol =
          target.getKind() === SyntaxKind.PropertyAccessExpression
            ? target.getNameNode().getSymbol()
            : key !== null
              ? target.getExpression().getType().getProperty(key)
              : null;
        const decls = symbol?.getDeclarations() ?? [];
        if (decls.length > 0 && decls.every((d) => !isOwn(d))) continue; // a library member (`ref.current`, `img.onload`)
        if (decls.length > 0) {
          // The slot's declared type, or the value written: a member declared
          // `unknown`/`any`/`object` holds a function as well as one declared callable.
          if (mayHoldOwnCode(target.getType()) || (value && mayBeCallable(value.getType()))) {
            out.push(`${siteOf(target)}  G1: write to member ${symbol.getName()}, which may hold a function`);
          }
          continue;
        }
        // No declaration names the key: an index signature, an `any` object.
        // The value decides: a loose one (`unknown`, `any`) may be a function.
        if (mayBeCallable(target.getType()) || (value && mayHoldOwnCode(value.getType()))) {
          out.push(`${siteOf(target)}  G1: write of a function through a key no declaration names`);
        }
      }
      if (targets.length > 0) return;

      const referenced = mutatorReferencedBy(node);
      if (referenced) {
        // Called directly, its target is judged. Any other use — `.call`,
        // `.apply`, `.bind`, an alias, a destructure, an argument — would let
        // it run on a target nobody can see, and is refused.
        const { name: mutator, access } = referenced;
        const call = access.getKind() === SyntaxKind.BindingElement ? null : directCallOf(access);
        if (!call) {
          out.push(`${siteOf(node)}  G2: object mutator ${mutator} used other than by a direct call`);
          return;
        }
        const target = unwrap(call.getArguments()[0]);
        if (!target) return;
        // Object.assign onto a fresh literal builds a new object from members
        // that keep their names. The others put a value under a key a
        // descriptor or a string names, which no declaration does.
        if (target.getKind() === SyntaxKind.ObjectLiteralExpression && mutator === "ObjectConstructor.assign") return;
        const t = target.getType();
        if (target.getKind() === SyntaxKind.ThisKeyword || t.isAny() || t.isUnknown() || hasOwnFunctionMembers(t)) {
          out.push(`${siteOf(call)}  G2: object mutator on a value that holds or may hold functions`);
        }
        return;
      }

      if (kind === SyntaxKind.Parameter && node.getParent()?.getKind() === SyntaxKind.Constructor && node.isParameterProperty?.()) {
        if (mayHoldOwnCode(node.getType())) out.push(`${siteOf(node)}  G4: constructor parameter property holding a function`);
        return;
      }

      if (kind === SyntaxKind.ClassExpression && node.getExtends?.()) {
        out.push(`${siteOf(node)}  G5: class expression with extends`);
        return;
      }
      if (kind === SyntaxKind.ClassDeclaration) {
        for (const impl of node.getImplements?.() ?? []) {
          const shape = externalShapeKeyOf(impl.getType());
          if (shape) out.push(`${siteOf(node)}  G7: own class implements the external shape ${shape}`);
        }
        const base = node.getExtends?.();
        const e = base ? unwrap(base.getExpression()) : null;
        if (!e) return;
        if (e.getKind() !== SyntaxKind.Identifier && e.getKind() !== SyntaxKind.PropertyAccessExpression) {
          out.push(`${siteOf(node)}  G5: extends an expression that is not a class name`);
          return;
        }
        // Derived classes are found through references to the base CLASS's
        // name; an own base reached through a const (`const B = Base`) hides
        // them. Import renames are references and pass; a library base is
        // the library's.
        let symbol = e.getKind() === SyntaxKind.PropertyAccessExpression ? e.getNameNode().getSymbol() : e.getSymbol();
        if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
        const decls = symbol?.getDeclarations() ?? [];
        if (decls.length > 0 && decls.every((d) => !isOwn(d))) return;
        if (!decls.some((d) => d.getKind() === SyntaxKind.ClassDeclaration)) {
          out.push(`${siteOf(node)}  G5: extends ${e.getText()}, which is not declared as a class`);
        }
        return;
      }
    });
  }
  // An entry for a file absent from the tree scanned (a fixture) is not judged.
  for (const [key, { sites }] of FUNCTION_FLOW_ALLOWLIST) {
    if (!existsSync(key.split("::")[0])) continue;
    const seen = excused.get(key) ?? 0;
    if (seen === 0) found.push(`${key}  FUNCTION_FLOW_ALLOWLIST entry matches no violation; remove it`);
    else if (seen !== sites) found.push(`${key}  FUNCTION_FLOW_ALLOWLIST entry excuses ${sites} site(s), but ${seen} were found; review the new ones`);
  }
  return [...new Set(found)];
}
