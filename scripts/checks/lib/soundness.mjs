/**
 * What makes the shared resolver's answers SOUND, checked over all production
 * code rather than assumed.
 *
 * The resolver names a function by its declaration: a member holds what its
 * declaration initialises it to, an interface member is one of the production
 * members that can stand in for it. That is only true while nothing puts a
 * different function there by other means. Following every such write was
 * tried for three review rounds, and each round found a write form it missed
 * (an alias, a cast, a nested path, Object.assign on `this`). These rules
 * refuse the forms instead, so the declaration is the whole answer:
 *
 *   G1  no write to an own member whose type may be a function, other than its
 *       declaration's initializer (`ops.run = f`, `this.run = f`, a
 *       destructuring target), and no write of a function through a key no
 *       declaration names (an index signature, an `any` object);
 *   G2  no object mutator (Object.assign, defineProperty, setPrototypeOf,
 *       Reflect.set …, recognised by the declaration the call resolves to, not
 *       by spelling) on `this`, on an `any`/`unknown` value, or on an object
 *       with own members that may be functions;
 *   G3  no computed-key member that may be a function;
 *   G4  no constructor parameter property that may be a function;
 *   G5  no class expression with `extends`, and no `extends` of anything but
 *       the name of a class declaration (an import rename passes, a const
 *       alias does not) — derived classes are enumerated by name.
 *
 * An interface member is resolved to every production member of that NAME
 * that may hold a function, so a cast or a structural assignment cannot hide
 * an implementation: neither renames a member.
 *
 * The scan set is deny-by-default: every own file the Program holds is
 * production unless NON_PRODUCTION / NON_PRODUCTION_SCRIPTS declares it
 * otherwise (lib/function-resolver.mjs), and so is every module production
 * code loads. A load's specifier is resolved from its literal text or its
 * string-literal type. A load the compiler cannot
 * resolve to TypeScript the gates can read — own JavaScript, a declaration
 * shim over own code, an own specifier that does not resolve, a non-literal
 * specifier — is refused, as is production loading declared tooling and
 * tooling whose closure reaches the RLS helpers or the database client.
 */
import { SyntaxKind, ts } from "ts-morph";
import { existsSync } from "node:fs";
import {
  NON_PRODUCTION_SCRIPTS,
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

// Reviewed exceptions to G1-G5, keyed "file::function <name>::rule" or
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
    const callee = call.getExpression();
    const isLoad =
      callee.getKind() === SyntaxKind.ImportKeyword || (callee.getKind() === SyntaxKind.Identifier && callee.getText() === "require");
    if (!isLoad) continue;
    const specs = specifiersOf(call.getArguments()[0]);
    if (specs) for (const spec of specs) out.push({ node: call, spec });
    else out.push({ node: call, spec: null });
  }
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

  // The declarations must still name something: an entry that matches no file
  // in the Program (and whose path exists — fixture trees lack most of them)
  // would excuse the next file that lands at it without review.
  const ownRels = own.map((sf) => toRelPosix(sf.getFilePath()));
  for (const entry of unmatchedNonProduction(ownRels)) {
    const path = entry.prefix ?? entry.file;
    if (existsSync(path)) violations.push(`${path}  NON_PRODUCTION entry matches no file in the Program; remove it`);
  }
  for (const tool of NON_PRODUCTION_SCRIPTS) {
    if (existsSync(tool) && !ownRels.includes(tool)) violations.push(`${tool}  NON_PRODUCTION_SCRIPTS entry is not in the Program; remove it`);
  }

  /** The own TypeScript module a load resolves to, null for a library or data, or { problem }. */
  function resolveLoad(sf, spec) {
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
      return { problem: `loads ${toRelPosix(target)}, own JavaScript the gates cannot read` };
    }
    if (/\.d\.[cm]?ts$/.test(target)) {
      // A declaration over own JavaScript beside it hides that code; one with
      // no implementation here only types a library.
      const stem = target.replace(/\.d\.[cm]?ts$/, "");
      const impl = [".js", ".mjs", ".cjs", ".jsx"].map((e) => stem + e).find((f) => existsSync(f));
      return impl ? { problem: `loads ${toRelPosix(target)}, a declaration over own JavaScript (${toRelPosix(impl)}) the gates cannot read` } : null;
    }
    const targetSf = program.getSourceFile(target);
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
    const tool = program.getSourceFiles().find((sf) => toRelPosix(sf.getFilePath()) === toolRel);
    if (!tool) continue;
    const seen = new Set([tool.getFilePath()]);
    const toolQueue = [{ sf: tool, via: null }];
    while (toolQueue.length > 0) {
      const { sf, via } = toolQueue.shift();
      for (const { node, spec } of loadsOf(sf)) {
        const r = resolveLoad(sf, spec);
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

/**
 * Violations of G1–G5 in the production files `scope` names, as
 * "file:line  description" strings.
 */
export function functionFlowViolations(program, scope) {
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
