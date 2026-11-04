/**
 * Strict team entry AAD (deviations D67, D72, D73, D77; review rounds 3-4:
 * T11 / S-R3-1, T13 / S-R4-1).
 *
 * A live team entry is always read at AAD 1 (`buildTeamEntryAAD` at the
 * entry's ItemKey version). Choosing the AAD by the server-supplied
 * `aadVersion` lets a DB-write attacker label an entry 0 and substitute a
 * legacy no-AAD ciphertext, so the aadVersion-aware `teamEntryAadFor` is
 * confined to the paths that UPGRADE such a live entry to AAD 1 (rotation,
 * re-key) and the history VIEW (a server-held row that is only displayed).
 * History RESTORE is not among them: it refuses a legacy row (S-R3-2), and
 * the re-key pass retains legacy history rows unopened (N-R4-1).
 *
 * The rules resolve BINDINGS, not spellings: each scanned tree is loaded into
 * a ts-morph Project built from its tsconfig (`@/` aliases, re-exports and
 * renamed imports resolve through the type checker's symbols). Where a
 * binding cannot be followed, the guard FAILS CLOSED.
 *
 *  (a) Outside ALLOWED_HELPER_FILES no import / export specifier names
 *      `teamEntryAadFor` (its imported name, so `as` renames count), no
 *      reference resolves to its declaration (findReferences follows renamed
 *      re-exports and namespace access), and no element access spells it. An
 *      import of it that does not resolve fails loudly.
 *  (b) Declaration-side enumeration. The decrypt set is DERIVED: every
 *      `decryptData` declaration, plus every named function whose body
 *      forwards its own key and AAD parameters to a member of the set
 *      (`decryptTeamEntry`, local `tryDecrypt`s; fixed point). Every
 *      reference `findReferences` returns for a member must be an import /
 *      export specifier, a `typeof`, or the direct callee of a call with no
 *      spread argument. Anything else — a destructuring rename (incl. of a
 *      namespace or a dynamic import), `.call` / `.apply`, element access,
 *      the function passed or bound as a value — is a violation, so every
 *      decrypt in the tree is a call the analysis below sees.
 *  (c) Classification of each decrypt call (forwarding calls inside a member
 *      are classified at their callers):
 *      - TEAM when its AAD names `buildTeamEntryAAD` (aliases, const/let
 *        bindings, either branch of a ternary/logical, a local helper's body,
 *        a parameter's arguments), whatever the key — or when its key flows
 *        from a team key getter call. The key trace follows key-material
 *        values only (CryptoKey-carrying, raw bytes, containers of them):
 *        const/let bindings and assignments, destructuring (a parameter
 *        binding by its property), `for...of`, the call sites of a named
 *        function's parameter, what a called function returns (its return
 *        expressions; an interface member's object-literal implementations),
 *        writes into raw bytes, and React stores (`useState` setter calls,
 *        `useRef` `.current` writes, `<Ctx.Provider value>`). A byte
 *        transformation's body is not entered (its arguments are traced).
 *        A team decrypt's AAD argument must be present and be either a direct
 *        `buildTeamEntryAAD(...)` call or an identifier bound by `const` to
 *        one; the builder's arguments never read `aadVersion`. Exempt:
 *        ALLOWED_DECRYPT_FILES and handleView in the history view.
 *      - UNCLASSIFIABLE when the key trace reaches something it cannot follow:
 *        a parameter of a function with no enumerable call sites (a callback,
 *        an object / class method, a property-assigned arrow), a value
 *        written through a property or a mutating method call (a holder
 *        object, a Map cache), a key-returning call through a parameter, a
 *        library call that yields a key from no key material (other than
 *        WebCrypto), `this`, a declaration kind it does not model. Such a site
 *        fails unless it is in NON_TEAM_DECRYPT_SITES, a reviewed list that
 *        must EQUAL the derived set (stale entries fail too).
 *      - NON-TEAM otherwise (a key traced to its sources, none a getter).
 *      The team key getter set is DERIVED: the members of TeamVaultContextValue
 *      whose (awaited) return type carries a CryptoKey within two property
 *      levels, plus every function under extension/src with a `teamId`
 *      parameter returning one.
 *  (d) The strict-reader set is the set of modules (c) found a team decrypt
 *      in; it must contain every KNOWN_READER (an over-narrow derivation —
 *      a getter or decrypt that stopped resolving — fails here).
 *  (e) Each clause is red-proved below by fixture sources run through the
 *      same functions.
 * iOS (Swift) is outside this gate; its refusal cells pin the same rule.
 */
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type { CallExpression, Identifier, SourceFile, Symbol as MorphSymbol, Type } from "ts-morph";

const REPO_ROOT = path.resolve(__dirname, "../..");

const HELPER = "teamEntryAadFor";
const BUILDER = "buildTeamEntryAAD";
const DECRYPT = "decryptData";
const GETTER_INTERFACE = "TeamVaultContextValue";
const HISTORY_VIEW = "src/components/passwords/entry/entry-history-section.tsx";
const HISTORY_VIEW_FN = "handleView";

const ALLOWED_DECRYPT_FILES = new Set([
  // Rotation: v0 entries re-sealed at AAD 1 under the new team key.
  "src/lib/team/rotation-payload.ts",
  // Re-key of the live entry and the v0→v1 upgrade payload (history rows are
  // opened at strict AAD; a legacy one is retained unopened).
  "src/lib/team/rekey-payload.ts",
]);
const HELPER_HOME = "src/lib/team/team-key-resolution.ts";
const ALLOWED_HELPER_FILES = new Set([HELPER_HOME, ...ALLOWED_DECRYPT_FILES, HISTORY_VIEW]);

const KNOWN_READERS = [
  "src/lib/vault/team-vault-list-adapter.ts",
  "src/lib/vault/build-team-get-detail.ts",
  "src/hooks/use-watchtower.ts",
  "src/components/team/management/team-export.tsx",
  "src/components/team/management/team-edit-dialog-loader.tsx",
  "src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx",
  "src/hooks/team/use-team-login-form-state.ts",
  "src/lib/team/team-history-restore.ts",
  "extension/src/background/index.ts",
];
const KNOWN_GETTERS = ["getEntryDecryptionKey", "getTeamEncryptionKey", "getItemEncryptionKey", "getEntryItemKeys"];

/**
 * Decrypt sites whose key the analysis cannot trace, each reviewed by hand as
 * a NON-team key (file:line of the call). Must equal the derived set exactly:
 * a new untraceable site, or a reviewed one that moved or became traceable,
 * fails the tree cell below. Empty today: every decrypt key in the tree is
 * traced to its sources.
 */
const NON_TEAM_DECRYPT_SITES: readonly string[] = [];

interface Tree {
  project: Project;
  /** Scanned (non-test) source files, keyed by repo-relative POSIX path. */
  files: Map<string, SourceFile>;
  /** Files whose `function` declarations with a `teamId` parameter count as team key getters. */
  getterFunctionRoots: string[];
}

interface Analysis {
  getters: Set<string>;
  /** Derived decrypt set, as `file#name` (the decryptData declarations and the forwarding wrappers). */
  decryptFns: string[];
  helperViolations: string[];
  referenceViolations: string[];
  decryptViolations: string[];
  /** Decrypt calls whose key could not be traced, as `file:line` (with the reason). */
  unclassified: { site: string; why: string }[];
  teamDecryptFiles: Set<string>;
  /** Modules with a decryptData call classified NOT team (its key traced, no getter reached). */
  nonTeamDecryptFiles: Set<string>;
  /** handleView sites of the helper in the history view (for its own check). */
  historyViewHelperSites: string[];
}

// ── Tree loading ────────────────────────────────────────────────────────

function isTestPath(rel: string): boolean {
  return rel.includes("/__tests__/") || /\.(test|spec)\.tsx?$/.test(rel);
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name) && !name.endsWith(".d.ts")) out.push(full);
  }
}

/** A Program-backed project over `scanRoot`'s non-test files, compiled with `tsconfig`. */
function loadRepoTree(tsconfig: string, scanRoot: string): { project: Project; files: Map<string, SourceFile> } {
  const project = new Project({ tsConfigFilePath: path.join(REPO_ROOT, tsconfig), skipAddingFilesFromTsConfig: true });
  const abs: string[] = [];
  walk(path.join(REPO_ROOT, scanRoot), abs);
  const files = new Map<string, SourceFile>();
  for (const file of abs) {
    const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    if (isTestPath(rel)) continue;
    files.set(rel, project.addSourceFileAtPath(file));
  }
  return { project, files };
}

// ── Binding resolution ─────────────────────────────────────────────────

function unwrap(node: Node): Node {
  let n = node;
  for (;;) {
    if (Node.isParenthesizedExpression(n) || Node.isAwaitExpression(n) || Node.isNonNullExpression(n)
      || Node.isAsExpression(n) || Node.isSatisfiesExpression(n) || Node.isTypeAssertion(n)) {
      n = n.getExpression();
    } else {
      return n;
    }
  }
}

function aliased(symbol: MorphSymbol): MorphSymbol {
  return symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
}

/** The symbol an identifier names (a shorthand `{ key }` names its value, not the property). */
function symbolOf(id: Identifier): MorphSymbol | undefined {
  const parent = id.getParent();
  if (Node.isShorthandPropertyAssignment(parent) && parent.getNameNode() === id) {
    return id.getProject().getTypeChecker().getShorthandAssignmentValueSymbol(parent);
  }
  return id.getSymbol();
}

/**
 * The declarations an expression names, following import/re-export aliases
 * and `const x = <expr>` bindings (so `const b = buildTeamEntryAAD; b()`
 * resolves to the builder).
 */
function declarationsOf(expr: Node, depth = 0): Node[] {
  const e = unwrap(expr);
  const nameNode = Node.isIdentifier(e) ? e : Node.isPropertyAccessExpression(e) ? e.getNameNode() : undefined;
  if (!nameNode) return [];
  const symbol = nameNode.getSymbol();
  if (!symbol) return [];
  const out: Node[] = [];
  for (const d of aliased(symbol).getDeclarations()) {
    const init = Node.isVariableDeclaration(d) ? d.getInitializer() : undefined;
    if (init && depth < 6 && !Node.isArrowFunction(init) && !Node.isFunctionExpression(init)) {
      const inner = declarationsOf(init, depth + 1);
      out.push(...(inner.length > 0 ? inner : [d]));
    } else {
      out.push(d);
    }
  }
  return out;
}

/** The name a declaration binds, as the getter set spells it (a destructuring rename counts by its property). */
function declaredName(d: Node): string | undefined {
  if (Node.isBindingElement(d)) return (d.getPropertyNameNode() ?? d.getNameNode()).getText();
  if (Node.isPropertySignature(d) || Node.isMethodSignature(d) || Node.isPropertyAssignment(d)
    || Node.isShorthandPropertyAssignment(d) || Node.isPropertyDeclaration(d) || Node.isMethodDeclaration(d)
    || Node.isFunctionDeclaration(d) || Node.isParameterDeclaration(d) || Node.isVariableDeclaration(d)) {
    return d.getName();
  }
  return undefined;
}

function terminalName(expr: Node): string | undefined {
  const e = unwrap(expr);
  if (Node.isIdentifier(e)) return e.getText();
  if (Node.isPropertyAccessExpression(e)) return e.getName();
  return undefined;
}

function callsTo(call: CallExpression, targets: ReadonlySet<Node>): boolean {
  return declarationsOf(call.getExpression()).some((d) => targets.has(d));
}

function readsAadVersion(node: Node): boolean {
  const reads = (n: Node) =>
    (Node.isIdentifier(n) && n.getText() === "aadVersion")
    || (Node.isElementAccessExpression(n) && /^["'`]aadVersion["'`]$/.test(n.getArgumentExpression()?.getText() ?? ""));
  return reads(node) || node.getDescendants().some(reads);
}

function enclosingFunctionName(node: Node): string | null {
  for (let p = node.getParent(); p; p = p.getParent()) {
    if (Node.isFunctionDeclaration(p)) return p.getName() ?? null;
    if ((Node.isArrowFunction(p) || Node.isFunctionExpression(p)) && Node.isVariableDeclaration(p.getParent())) {
      return (p.getParent() as Node & { getName(): string }).getName();
    }
  }
  return null;
}

/** The nearest enclosing function-like node. */
function enclosingFunction(node: Node): Node | undefined {
  return node.getFirstAncestor((a) => Node.isFunctionDeclaration(a) || Node.isArrowFunction(a)
    || Node.isFunctionExpression(a) || Node.isMethodDeclaration(a) || Node.isConstructorDeclaration(a)
    || Node.isGetAccessorDeclaration(a) || Node.isSetAccessorDeclaration(a));
}

/**
 * A function's binding, when its call sites can be enumerated: a named
 * `function` declaration, or an arrow / function expression bound by a
 * variable declaration. A callback, an object or class method and a
 * property-assigned arrow have none.
 */
function functionBinding(fn: Node): { decl: Node; nameNode: Identifier } | undefined {
  if (Node.isFunctionDeclaration(fn)) {
    const nameNode = fn.getNameNode();
    return nameNode ? { decl: fn, nameNode } : undefined;
  }
  if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) {
    const v = fn.getParent();
    if (Node.isVariableDeclaration(v) && Node.isIdentifier(v.getNameNode())) {
      return { decl: v, nameNode: v.getNameNode() as Identifier };
    }
  }
  return undefined;
}

function isBindingOnlyReference(ref: Node): boolean {
  const parent = ref.getParent();
  return Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent) || Node.isImportClause(parent)
    || ref.getAncestors().some((a) => Node.isTypeQuery(a));
}

/** The call `ref` is the direct callee of (`f(...)` or `ns.f(...)`), if any. */
function directCallOf(ref: Node): CallExpression | undefined {
  const parent = ref.getParent();
  if (Node.isCallExpression(parent) && parent.getExpression() === ref) return parent;
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ref) {
    const grand = parent.getParent();
    if (Node.isCallExpression(grand) && grand.getExpression() === parent) return grand;
  }
  return undefined;
}

const ASSIGNMENT_OPERATORS = new Set([
  SyntaxKind.EqualsToken, SyntaxKind.BarBarEqualsToken, SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
]);

// ── Getter set derivation ──────────────────────────────────────────────

function carriesCryptoKey(type: Type, depth = 0): boolean {
  if (type.isUnion()) return type.getUnionTypes().some((t) => carriesCryptoKey(t, depth));
  if (type.getSymbol()?.getName() === "CryptoKey") return true;
  if (depth >= 2 || !type.isObject()) return false;
  return type.getProperties().some((p) => {
    const decl = p.getValueDeclaration();
    return decl ? carriesCryptoKey(p.getTypeAtLocation(decl), depth + 1) : false;
  });
}

const BYTE_TYPES = new Set(["Uint8Array", "ArrayBuffer", "ArrayBufferView", "SharedArrayBuffer", "DataView"]);

/** Key material: a CryptoKey-carrying value, raw key bytes, or a container of them (Map, array, Promise). */
function isKeyMaterial(type: Type, depth = 0): boolean {
  const t = type.getNonNullableType();
  if (t.isUnion()) return t.getUnionTypes().some((u) => isKeyMaterial(u, depth));
  if (BYTE_TYPES.has(t.getSymbol()?.getName() ?? "") || carriesCryptoKey(t)) return true;
  if (depth >= 2) return false;
  if (t.isArray()) return isKeyMaterial(t.getArrayElementTypeOrThrow(), depth + 1);
  return t.getTypeArguments().some((a) => isKeyMaterial(a, depth + 1));
}

function isRawBytes(type: Type): boolean {
  const t = type.getNonNullableType();
  if (t.isUnion()) return t.getUnionTypes().every(isRawBytes);
  return BYTE_TYPES.has(t.getSymbol()?.getName() ?? "");
}

function returnsCryptoKey(type: Type): boolean {
  return type.getCallSignatures().some((sig) => {
    const ret = sig.getReturnType();
    const awaited = ret.getSymbol()?.getName() === "Promise" ? ret.getTypeArguments()[0] : ret;
    return awaited ? carriesCryptoKey(awaited) : false;
  });
}

function deriveGetters(trees: Tree[]): Set<string> {
  const getters = new Set<string>();
  for (const tree of trees) {
    for (const sf of tree.files.values()) {
      for (const iface of sf.getInterfaces().filter((i) => i.getName() === GETTER_INTERFACE)) {
        for (const member of iface.getProperties()) {
          if (returnsCryptoKey(member.getType())) getters.add(member.getName());
        }
      }
    }
    for (const [rel, sf] of tree.files) {
      if (!tree.getterFunctionRoots.some((root) => rel.startsWith(root))) continue;
      for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
        const name = fn.getName();
        if (name && fn.getParameters().some((p) => p.getName() === "teamId") && returnsCryptoKey(fn.getType())) {
          getters.add(name);
        }
      }
    }
  }
  return getters;
}

function isGetterCall(call: CallExpression, getters: ReadonlySet<string>): boolean {
  const name = terminalName(call.getExpression());
  if (name && getters.has(name)) return true;
  return declarationsOf(call.getExpression()).some((d) => {
    const n = declaredName(d);
    return n !== undefined && getters.has(n);
  });
}

// ── The AAD shape of a team decrypt ────────────────────────────────────

function aadShapeViolation(arg: Node | undefined, builders: ReadonlySet<Node>): string | null {
  if (!arg) return "missing AAD argument";
  const builderCallOk = (node: Node): string | null => {
    if (!Node.isCallExpression(node) || !callsTo(node, builders)) return null;
    return node.getArguments().some(readsAadVersion) ? "the builder's arguments read aadVersion" : "";
  };
  const direct = builderCallOk(unwrap(arg));
  if (direct !== null) return direct || null;
  const a = unwrap(arg);
  if (!Node.isIdentifier(a)) return `AAD is a ${a.getKindName()}, not a direct ${BUILDER} call or a const bound to one`;
  const decls = a.getSymbol()?.getDeclarations() ?? [];
  if (decls.length !== 1 || !Node.isVariableDeclaration(decls[0])) return "AAD identifier is not a variable bound to the builder";
  const decl = decls[0];
  const list = decl.getParent();
  if (!Node.isVariableDeclarationList(list) || (list.getFlags() & ts.NodeFlags.Const) === 0) return "AAD binding is not const";
  const init = decl.getInitializer();
  const bound = init ? builderCallOk(init) : null;
  if (bound === null) return `AAD const is bound to ${init ? init.getKindName() : "nothing"}, not a direct ${BUILDER} call`;
  return bound || null;
}

// ── The analysis ───────────────────────────────────────────────────────

function findFunctionDeclarations(trees: Tree[], name: string): Node[] {
  return trees.flatMap((t) => [...t.files.values()].flatMap((sf) => sf.getFunctions().filter((f) => f.getName() === name)));
}

interface DecryptFn {
  decl: Node;
  nameNode: Identifier;
  keyIndex: number;
  aadIndex: number;
}

/** Why a key trace stopped; null when it was followed to its sources. */
type Trace = { team: boolean; untraceable: string | null; via?: string };
const TRACED: Trace = { team: false, untraceable: null };
const untraceable = (why: string): Trace => ({ team: false, untraceable: why });
const MAX_DEPTH = 40;
/** WebCrypto makes a fresh key from no key material. */
const WEBCRYPTO_CALLEE = /^(globalThis\.|self\.|window\.)?crypto\.(subtle\.\w+|getRandomValues)$/;

/** A function's return expressions (an arrow's expression body counts). */
function returnExpressions(fn: Node): Node[] {
  if (Node.isArrowFunction(fn)) {
    const body = fn.getBody();
    if (!Node.isBlock(body)) return [body];
  }
  return fn.getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((r) => enclosingFunction(r) === fn)
    .flatMap((r) => {
      const e = r.getExpression();
      return e ? [e] : [];
    });
}

function analyze(trees: Tree[]): Analysis {
  const getters = deriveGetters(trees);
  const helpers = new Set(findFunctionDeclarations(trees, HELPER));
  const builders = new Set(findFunctionDeclarations(trees, BUILDER));
  const baseDecrypts = findFunctionDeclarations(trees, DECRYPT);
  if (helpers.size === 0 || builders.size === 0 || baseDecrypts.length === 0) {
    throw new Error(`guard targets did not resolve: ${HELPER}=${helpers.size} ${BUILDER}=${builders.size} ${DECRYPT}=${baseDecrypts.length}`);
  }

  const relOf = new Map<SourceFile, string>();
  for (const tree of trees) for (const [rel, sf] of tree.files) relOf.set(sf, rel);
  const where = (n: Node) => `${relOf.get(n.getSourceFile()) ?? n.getSourceFile().getFilePath()}:${n.getStartLineNumber()}`;
  const scanned = (n: Node) => relOf.has(n.getSourceFile());

  const refCache = new Map<Node, Node[]>();
  const referencesOf = (nameNode: Identifier): Node[] => {
    let refs = refCache.get(nameNode);
    if (!refs) {
      refs = nameNode.findReferencesAsNodes().filter((r) => r !== nameNode && scanned(r));
      refCache.set(nameNode, refs);
    }
    return refs;
  };

  // ── The decrypt set (fixed point over forwarding wrappers).
  const decryptFns = new Map<Node, DecryptFn>();
  for (const d of baseDecrypts) {
    if (Node.isFunctionDeclaration(d)) decryptFns.set(d, { decl: d, nameNode: d.getNameNodeOrThrow(), keyIndex: 1, aadIndex: 2 });
  }
  const allCalls = trees.flatMap((t) => [...t.files.values()].flatMap((sf) => sf.getDescendantsOfKind(SyntaxKind.CallExpression)));
  const decryptFnOf = (call: CallExpression): DecryptFn | undefined => {
    for (const d of declarationsOf(call.getExpression())) {
      const fn = decryptFns.get(d);
      if (fn) return fn;
    }
    return undefined;
  };
  const forwardCalls = new Set<CallExpression>();
  for (let grown = true; grown;) {
    grown = false;
    for (const call of allCalls) {
      if (forwardCalls.has(call)) continue;
      const fn = decryptFnOf(call);
      if (!fn) continue;
      const host = enclosingFunction(call);
      const binding = host ? functionBinding(host) : undefined;
      if (!host || !binding) continue;
      const params = (host as Node & { getParameters(): Node[] }).getParameters();
      const paramIndex = (arg: Node | undefined) => {
        const a = arg ? unwrap(arg) : undefined;
        if (!a || !Node.isIdentifier(a)) return -1;
        const decls = a.getSymbol()?.getDeclarations() ?? [];
        return decls.length === 1 ? params.indexOf(decls[0]) : -1;
      };
      const keyIndex = paramIndex(call.getArguments()[fn.keyIndex]);
      const aadIndex = paramIndex(call.getArguments()[fn.aadIndex]);
      if (keyIndex < 0 || aadIndex < 0) continue;
      forwardCalls.add(call);
      if (!decryptFns.has(binding.decl)) {
        decryptFns.set(binding.decl, { decl: binding.decl, nameNode: binding.nameNode, keyIndex, aadIndex });
        grown = true;
      }
    }
  }

  // ── (b) Every reference to a decrypt function is a direct call.
  const referenceViolations: string[] = [];
  const decryptNames = new Set([...decryptFns.values()].map((f) => f.nameNode.getText()));
  for (const tree of trees) {
    for (const sf of tree.files.values()) {
      for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
        const arg = ea.getArgumentExpression();
        if (arg && Node.isStringLiteral(arg) && decryptNames.has(arg.getLiteralText())) {
          referenceViolations.push(`${where(ea)} ${arg.getLiteralText()} is used as a value (ElementAccessExpression), not called directly`);
        }
      }
    }
  }
  for (const fn of decryptFns.values()) {
    const name = fn.nameNode.getText();
    for (const ref of referencesOf(fn.nameNode)) {
      // Element access is reported above, by its spelling.
      if (isBindingOnlyReference(ref) || Node.isElementAccessExpression(ref.getParent())) continue;
      const call = directCallOf(ref);
      if (!call) {
        referenceViolations.push(`${where(ref)} ${name} is used as a value (${ref.getParentOrThrow().getKindName()}), not called directly`);
      } else if (call.getArguments().some((a) => Node.isSpreadElement(a))) {
        referenceViolations.push(`${where(call)} ${name} is called with a spread argument`);
      }
    }
  }

  // ── Parameter sources: the arguments at every enumerable call site.
  const paramSources = (param: Node): { args: Node[] } | { why: string } => {
    if (!Node.isParameterDeclaration(param)) return { why: "not a parameter" };
    if (param.isRestParameter()) return { why: `rest parameter ${param.getName()}` };
    const fn = param.getParentOrThrow();
    const binding = functionBinding(fn);
    if (!binding) return { why: `parameter ${param.getName()} of a ${fn.getKindName()} with no enumerable call sites` };
    const index = (fn as Node & { getParameters(): Node[] }).getParameters().indexOf(param);
    const refs = referencesOf(binding.nameNode).filter((r) => !isBindingOnlyReference(r));
    if (refs.length === 0) return { why: `${binding.nameNode.getText()} has no call sites` };
    const args: Node[] = [];
    for (const ref of refs) {
      const call = directCallOf(ref);
      if (!call) return { why: `${binding.nameNode.getText()} is passed as a value` };
      const callArgs = call.getArguments();
      if (callArgs.slice(0, index + 1).some((a) => Node.isSpreadElement(a))) return { why: "a spread argument" };
      if (callArgs[index]) args.push(callArgs[index]);
    }
    return { args };
  };

  /** The values a variable takes, or why they cannot be enumerated (property writes, mutating calls, destructuring writes). */
  const variableSources = (decl: Node, nameNode: Identifier | undefined, isConst: boolean): { sources: Node[] } | { why: string } => {
    const sources: Node[] = [];
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      const react = init ? reactStoreSources(decl, nameNode) : undefined;
      if (react) {
        if ("why" in react) return react;
        sources.push(...react.sources);
      } else if (init) {
        sources.push(init);
      }
      const loop = decl.getParentOrThrow().getParent();
      if (Node.isForOfStatement(loop) || Node.isForInStatement(loop)) sources.push(loop.getExpression());
    }
    if (!nameNode) return { sources };
    for (const ref of referencesOf(nameNode)) {
      const parent = ref.getParentOrThrow();
      if (Node.isBinaryExpression(parent) && parent.getLeft() === ref && ASSIGNMENT_OPERATORS.has(parent.getOperatorToken().getKind())) {
        if (isConst) return { why: "assigned" };
        sources.push(parent.getRight());
        continue;
      }
      if ((Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent)) && parent.getExpression() === ref) {
        const grand = parent.getParent();
        if (Node.isBinaryExpression(grand) && grand.getLeft() === parent && ASSIGNMENT_OPERATORS.has(grand.getOperatorToken().getKind())) {
          // Raw bytes take what is written into them (`bytes[i] = ...`); a
          // holder object or container may take any key.
          if (isRawBytes(ref.getType()) || (isReactRef(decl) && Node.isPropertyAccessExpression(parent) && parent.getName() === "current")) {
            sources.push(grand.getRight());
            continue;
          }
          return { why: `${nameNode.getText()} holds a key written through a property` };
        }
        if (Node.isCallExpression(grand) && grand.getExpression() === parent && grand.getArguments().length > 0) {
          // Raw bytes take what their methods write (`fill(0)`, `set(bytes)`);
          // a container (Map, array, holder object) may take any key.
          if (isRawBytes(ref.getType())) {
            sources.push(...grand.getArguments());
            continue;
          }
          return { why: `${nameNode.getText()} is filled by a method call (${parent.getText()})` };
        }
      }
      const destructuringWrite = ref.getAncestors().some((a) => Node.isBinaryExpression(a)
        && a.getOperatorToken().getKind() === SyntaxKind.EqualsToken
        && (Node.isArrayLiteralExpression(a.getLeft()) || Node.isObjectLiteralExpression(a.getLeft()))
        && a.getLeft().getDescendants().includes(ref));
      if (destructuringWrite) return { why: `${nameNode.getText()} is written by a destructuring assignment` };
    }
    if (sources.length === 0) return { why: `${nameNode.getText()} has no traceable value` };
    return { sources };
  };

  /**
   * The part of an argument a destructured parameter binding takes: the
   * matching property of an object literal (a top-level `{ a, b: c }`
   * pattern); the whole argument otherwise.
   */
  const bindingValue = (binding: Node, param: Node, arg: Node): Node => {
    const a = unwrap(arg);
    if (!Node.isBindingElement(binding) || !Node.isObjectLiteralExpression(a)) return arg;
    const pattern = binding.getParent();
    if (!Node.isObjectBindingPattern(pattern) || pattern.getParent() !== param) return arg;
    if (a.getProperties().some((p) => Node.isSpreadAssignment(p))) return arg;
    const name = (binding.getPropertyNameNode() ?? binding.getNameNode()).getText();
    for (const p of a.getProperties()) {
      if (Node.isPropertyAssignment(p) && p.getName() === name) return p.getInitializer() ?? arg;
      if (Node.isShorthandPropertyAssignment(p) && p.getName() === name) return p.getNameNode();
    }
    return arg;
  };

  /** `const ref = useRef(init)`: its value is `init` and every `ref.current = ...`. */
  const isReactRef = (decl: Node): boolean => {
    const init = Node.isVariableDeclaration(decl) ? decl.getInitializer() : undefined;
    return !!init && Node.isCallExpression(unwrap(init)) && terminalName((unwrap(init) as CallExpression).getExpression()) === "useRef";
  };

  /**
   * React stores, whose value is set away from the declaration: the state of
   * `const [value, setValue] = useState(init)` takes `init` and every argument
   * passed to `setValue`; a `createContext(default)` takes `default` and every
   * `<Ctx.Provider value={...}>`; a `useRef(init)` takes `init` (and its
   * `.current` writes). undefined when `decl` is none of them.
   */
  const reactStoreSources = (decl: Node, nameNode: Identifier | undefined): { sources: Node[] } | { why: string } | undefined => {
    if (!Node.isVariableDeclaration(decl)) return undefined;
    const init = decl.getInitializer();
    const call = init ? unwrap(init) : undefined;
    if (!call || !Node.isCallExpression(call)) return undefined;
    const hook = terminalName(call.getExpression());
    // useRef: the initial value here; `ref.current = ...` writes are added by variableSources.
    if (hook === "useRef") return { sources: [...call.getArguments()] };
    if (hook === "useState" && Node.isArrayBindingPattern(decl.getNameNode())) {
      const [valueEl, setterEl] = (decl.getNameNode() as Node & { getElements(): Node[] }).getElements();
      if (!nameNode || !Node.isBindingElement(valueEl) || valueEl.getNameNode() !== nameNode) return undefined;
      const sources: Node[] = [...call.getArguments()];
      const setterName = Node.isBindingElement(setterEl) ? setterEl.getNameNode() : undefined;
      if (!setterName || !Node.isIdentifier(setterName)) return { sources };
      for (const ref of referencesOf(setterName)) {
        const setCall = directCallOf(ref);
        if (!setCall) return { why: `the state setter ${setterName.getText()} is passed as a value` };
        sources.push(...setCall.getArguments());
      }
      return { sources };
    }
    if (hook === "createContext" && nameNode) {
      const sources: Node[] = [...call.getArguments()];
      for (const ref of referencesOf(nameNode)) {
        const access = ref.getParent();
        if (!Node.isPropertyAccessExpression(access) || access.getName() !== "Provider") continue;
        const opening = access.getParent();
        if (Node.isJsxClosingElement(opening)) continue;
        if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) {
          return { why: `${nameNode.getText()}.Provider is used other than as a JSX element` };
        }
        for (const attr of opening.getAttributes()) {
          if (Node.isJsxSpreadAttribute(attr)) return { why: `${nameNode.getText()}.Provider takes a spread` };
          if (attr.getNameNode().getText() !== "value") continue;
          const value = attr.getInitializer();
          if (Node.isJsxExpression(value) && value.getExpression()) sources.push(value.getExpression() as Node);
        }
      }
      return { sources };
    }
    return undefined;
  };

  const isConstDecl = (d: Node): boolean => {
    const v = Node.isBindingElement(d) ? d.getFirstAncestorByKind(SyntaxKind.VariableDeclaration) : d;
    const list = v?.getParent();
    return !!list && Node.isVariableDeclarationList(list) && (list.getFlags() & ts.NodeFlags.Const) !== 0;
  };

  const traceKey = (expr: Node, seen: Set<Node>, depth: number): Trace => {
    const e = unwrap(expr);
    if (depth > MAX_DEPTH) return untraceable("the key trace is too deep");
    if (seen.has(e)) return TRACED;
    seen.add(e);
    const nodes = [e, ...e.getDescendants()];
    const calls = nodes.filter(Node.isCallExpression);
    const getterCall = calls.find((c) => isGetterCall(c, getters));
    if (getterCall) return { team: true, untraceable: null, via: where(getterCall) };
    if (nodes.some((n) => n.getKind() === SyntaxKind.ThisKeyword)) return untraceable("a key read through `this`");
    let out = TRACED;
    // A key-returning call: what the callee returns (its return expressions,
    // or the implementations of an interface member), unless it is a callback
    // or a library call that makes a key from no key material.
    for (const c of calls) {
      if (!isKeyMaterial(c.getType())) continue;
      const t = traceCall(c, seen, depth);
      if (t.team) return t;
      if (!out.untraceable && t.untraceable) out = t;
    }
    for (const id of nodes.filter(Node.isIdentifier)) {
      const parent = id.getParent();
      if ((Node.isPropertyAccessExpression(parent) || Node.isPropertyAssignment(parent)) && parent.getNameNode() === id) continue;
      if (id.getAncestors().some((a) => Node.isTypeNode(a))) continue;
      if (!isKeyMaterial(id.getType())) continue;
      const t = traceIdentifier(id, seen, depth);
      if (t.team) return t;
      if (!out.untraceable && t.untraceable) out = t;
    }
    return out;
  };

  const traceCall = (c: CallExpression, seen: Set<Node>, depth: number): Trace => {
    const callee = c.getExpression();
    const decls = declarationsOf(callee);
    if (decls.length === 0) return untraceable(`the key comes from an unresolved call (${callee.getText()})`);
    let out = TRACED;
    for (const d of decls) {
      let t: Trace;
      if (Node.isParameterDeclaration(d) || Node.isBindingElement(d)) {
        t = untraceable(`the key comes from a call through a ${d.getKindName()} (${callee.getText()})`);
      } else if (!scanned(d)) {
        // A library call: a key made from key material in its arguments (traced
        // with the identifiers below), or WebCrypto making a fresh one.
        const fromKeys = c.getArguments().some((a) => [a, ...a.getDescendants()].some((n) => Node.isIdentifier(n) && isKeyMaterial(n.getType())));
        t = fromKeys || WEBCRYPTO_CALLEE.test(callee.getText()) || isRawBytes(c.getType())
          ? TRACED
          : untraceable(`the key comes from a library call that holds it (${callee.getText()})`);
      } else if (isRawBytes(c.getType())) {
        // A byte transformation (hexDecode, toArrayBuffer): its key material is
        // in its arguments, traced with the identifiers below. Tracing its body
        // would follow its parameter to every caller in the tree.
        t = TRACED;
      } else {
        const values = implementationValues(d);
        t = "why" in values ? untraceable(values.why) : traceSources(values.values, seen, depth);
      }
      if (t.team) return t;
      if (!out.untraceable && t.untraceable) out = t;
    }
    return out;
  };

  /** The values a scanned callee returns: a function's return expressions, an interface member's implementations. */
  const implementationValues = (d: Node): { values: Node[] } | { why: string } => {
    const fn = Node.isVariableDeclaration(d) ? d.getInitializer() : d;
    if (fn && (Node.isFunctionDeclaration(fn) || Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isMethodDeclaration(fn))) {
      return { values: returnExpressions(fn) };
    }
    if (Node.isPropertyAssignment(d)) {
      const init = d.getInitializer();
      return init ? implementationValues(init) : { why: `${d.getName()} has no value` };
    }
    if (Node.isArrowFunction(d) || Node.isFunctionExpression(d)) return { values: returnExpressions(d) };
    if (Node.isPropertySignature(d) || Node.isMethodSignature(d)) {
      const nameNode = d.getNameNode();
      if (!Node.isIdentifier(nameNode)) return { why: `${d.getKindName()} with a computed name` };
      const values: Node[] = [];
      for (const ref of referencesOf(nameNode)) {
        const parent = ref.getParentOrThrow();
        if (directCallOf(ref) || (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === ref)) continue;
        if (Node.isPropertySignature(parent) || Node.isMethodSignature(parent)) continue;
        if (Node.isPropertyAssignment(parent) && parent.getNameNode() === ref) {
          const impl = implementationValues(parent);
          if ("why" in impl) return impl;
          values.push(...impl.values);
        } else if (Node.isMethodDeclaration(parent) && parent.getNameNode() === ref && Node.isObjectLiteralExpression(parent.getParent())) {
          values.push(...returnExpressions(parent));
        } else if (Node.isShorthandPropertyAssignment(parent)) {
          values.push(ref);
        } else {
          return { why: `${nameNode.getText()} is implemented by a ${parent.getKindName()} the trace does not follow` };
        }
      }
      return values.length > 0 ? { values } : { why: `${nameNode.getText()} has no implementation the trace can enumerate` };
    }
    return { why: `the key comes from a call to a ${d.getKindName()}` };
  };

  const traceSources = (sources: Node[], seen: Set<Node>, depth: number): Trace => {
    let out = TRACED;
    for (const s of sources) {
      const t = traceKey(s, seen, depth + 1);
      if (t.team) return t;
      if (!out.untraceable && t.untraceable) out = t;
    }
    return out;
  };

  const traceIdentifier = (id: Identifier, seen: Set<Node>, depth: number): Trace => {
    const symbol = symbolOf(id);
    if (!symbol) return untraceable(`${id.getText()} has no symbol`);
    const decls = aliased(symbol).getDeclarations();
    if (decls.length === 0) return untraceable(`${id.getText()} has no declaration`);
    let out = TRACED;
    for (const d of decls) {
      let t: Trace;
      if (Node.isVariableDeclaration(d) || Node.isBindingElement(d)) {
        // A destructured binding takes its value from the nearest declaration
        // or parameter it is bound in.
        const owner = Node.isBindingElement(d)
          ? d.getFirstAncestor((a) => Node.isVariableDeclaration(a) || Node.isParameterDeclaration(a))
          : d;
        const nameNode = d.getNameNode();
        if (owner && Node.isParameterDeclaration(owner)) {
          const p = paramSources(owner);
          t = "why" in p ? untraceable(p.why) : traceSources(p.args.map((a) => bindingValue(d, owner, a)), seen, depth);
        } else if (owner) {
          const v = variableSources(owner, Node.isIdentifier(nameNode) ? nameNode : undefined, isConstDecl(d));
          t = "why" in v ? untraceable(v.why) : traceSources(v.sources, seen, depth);
        } else {
          t = untraceable(`${id.getText()} is a binding outside a declaration`);
        }
      } else if (Node.isParameterDeclaration(d)) {
        const p = paramSources(d);
        t = "why" in p ? untraceable(p.why) : traceSources(p.args, seen, depth);
      } else {
        t = untraceable(`${id.getText()} is a ${d.getKindName()}`);
      }
      if (t.team) return t;
      if (!out.untraceable && t.untraceable) out = t;
    }
    return out;
  };

  /** True when an AAD expression names the team builder, however bound. */
  const namesBuilder = (expr: Node, seen: Set<Node>, depth: number): boolean => {
    const e = unwrap(expr);
    if (depth > MAX_DEPTH || seen.has(e)) return false;
    seen.add(e);
    for (const n of [e, ...e.getDescendants()].filter(Node.isIdentifier)) {
      const symbol = symbolOf(n);
      if (!symbol) continue;
      const decls = aliased(symbol).getDeclarations();
      if (decls.some((d) => builders.has(d))) return true;
      const t = n.getType();
      if (!isKeyMaterial(t) && t.getCallSignatures().length === 0) continue;
      for (const d of decls) {
        let sources: Node[] = [];
        if (Node.isVariableDeclaration(d)) {
          const nameNode = d.getNameNode();
          const v = variableSources(d, Node.isIdentifier(nameNode) ? nameNode : undefined, false);
          sources = "sources" in v ? v.sources : (d.getInitializer() ? [d.getInitializer() as Node] : []);
        } else if (Node.isBindingElement(d)) {
          const init = d.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getInitializer();
          if (init) sources = [init];
        } else if (Node.isParameterDeclaration(d)) {
          const p = paramSources(d);
          if ("args" in p) sources = p.args;
        } else if (Node.isFunctionDeclaration(d) && scanned(d)) {
          const body = d.getBody();
          if (body) sources = [body];
        }
        if (sources.some((s) => namesBuilder(s, seen, depth + 1))) return true;
      }
    }
    return false;
  };

  const helperViolations: string[] = [];
  const decryptViolations: string[] = [];
  const unclassified: { site: string; why: string }[] = [];
  const teamDecryptFiles = new Set<string>();
  const nonTeamDecryptFiles = new Set<string>();
  const historyViewHelperSites: string[] = [];

  for (const tree of trees) {
    for (const [rel, sf] of tree.files) {
      // (a) spellings of the helper's imported/exported name, and element access.
      for (const spec of [...sf.getDescendantsOfKind(SyntaxKind.ImportSpecifier), ...sf.getDescendantsOfKind(SyntaxKind.ExportSpecifier)]) {
        // getNameNode() is the IMPORTED / re-exported name in both specifier kinds (the `as` name is the alias node).
        if (spec.getNameNode().getText() !== HELPER) continue;
        const symbol = spec.getSymbol();
        const resolved = symbol ? aliased(symbol).getDeclarations() : [];
        if (!resolved.some((d) => helpers.has(d))) helperViolations.push(`${where(spec)} unresolved import of ${HELPER}`);
        else if (!ALLOWED_HELPER_FILES.has(rel)) helperViolations.push(`${where(spec)} names ${HELPER}`);
      }
      for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
        if (/^["'`]teamEntryAadFor["'`]$/.test(ea.getArgumentExpression()?.getText() ?? "") && !ALLOWED_HELPER_FILES.has(rel)) {
          helperViolations.push(`${where(ea)} element access to ${HELPER}`);
        }
      }

      // (c) classify every decrypt call.
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const fn = decryptFnOf(call);
        if (!fn || forwardCalls.has(call)) continue;
        const args = call.getArguments();
        const key = args[fn.keyIndex];
        const aad = args[fn.aadIndex];
        const teamByAad = aad !== undefined && namesBuilder(aad, new Set(), 0);
        const trace = key ? traceKey(key, new Set(), 0) : untraceable("missing key argument");
        const exempt = ALLOWED_DECRYPT_FILES.has(rel) || (rel === HISTORY_VIEW && enclosingFunctionName(call) === HISTORY_VIEW_FN);
        if (!trace.team && !teamByAad) {
          if (!trace.untraceable) nonTeamDecryptFiles.add(rel);
          else if (!exempt) unclassified.push({ site: where(call), why: trace.untraceable });
          continue;
        }
        if (exempt) continue;
        teamDecryptFiles.add(rel);
        const why = aadShapeViolation(aad, builders);
        if (why) decryptViolations.push(`${where(call)} ${why}${trace.team ? ` (team key via ${trace.via})` : " (team AAD)"}`);
      }
    }

    // (a) every reference to the helper's declaration, however spelled.
    for (const helper of helpers) {
      const home = relOf.get(helper.getSourceFile());
      if (home !== undefined && home !== HELPER_HOME) helperViolations.push(`${where(helper)} declares ${HELPER} outside ${HELPER_HOME}`);
      if (!Node.isFunctionDeclaration(helper) || !tree.project.getSourceFile(helper.getSourceFile().getFilePath())) continue;
      for (const ref of referencesOf(helper.getNameNodeOrThrow())) {
        const rel = relOf.get(ref.getSourceFile());
        if (rel === undefined || !tree.files.has(rel)) continue;
        if (rel === HISTORY_VIEW && Node.isCallExpression(ref.getParent())) {
          historyViewHelperSites.push(enclosingFunctionName(ref) ?? "<top level>");
        }
        if (!ALLOWED_HELPER_FILES.has(rel)) helperViolations.push(`${where(ref)} references ${HELPER}`);
        const inEncrypt = ref.getAncestors().some((a) => Node.isCallExpression(a) && terminalName(a.getExpression()) === "encryptData");
        if (inEncrypt) helperViolations.push(`${where(ref)} ${HELPER} supplies an encryptData AAD`);
      }
    }
  }
  const decryptFnNames = [...decryptFns.values()].map((f) => `${relOf.get(f.decl.getSourceFile()) ?? f.decl.getSourceFile().getFilePath()}#${f.nameNode.getText()}`);
  return {
    getters, decryptFns: decryptFnNames.sort(), helperViolations, referenceViolations, decryptViolations,
    unclassified, teamDecryptFiles, nonTeamDecryptFiles, historyViewHelperSites,
  };
}

/** Drift between the derived unclassifiable sites and the reviewed list (both directions). */
function reviewedSiteDrift(unclassified: Analysis["unclassified"], reviewed: readonly string[]): string[] {
  const derived = new Set(unclassified.map((u) => u.site));
  const listed = new Set(reviewed);
  return [
    ...unclassified.filter((u) => !listed.has(u.site)).map((u) => `${u.site} unclassifiable decrypt key (${u.why}); trace it to its source or review it into NON_TEAM_DECRYPT_SITES`),
    ...reviewed.filter((s) => !derived.has(s)).map((s) => `${s} stale NON_TEAM_DECRYPT_SITES entry: no unclassifiable decrypt there`),
  ];
}

// ── The repository ─────────────────────────────────────────────────────

describe("team entry AAD strictness (D67, D73, D77)", () => {
  let result: Analysis;
  let extensionGetters: Set<string>;
  let scanned = 0;

  beforeAll(() => {
    const app = loadRepoTree("tsconfig.json", "src");
    const ext = loadRepoTree("extension/tsconfig.json", "extension/src");
    scanned = app.files.size + ext.files.size;
    const extTree = { ...ext, getterFunctionRoots: ["extension/src/"] };
    result = analyze([{ ...app, getterFunctionRoots: [] }, extTree]);
    extensionGetters = deriveGetters([extTree]);
  }, 180_000);

  it("scans every module under src/ and extension/src/ (non-vacuous)", () => {
    expect(scanned).toBeGreaterThan(500);
  });

  it("derives the team key getter set from TeamVaultContextValue and the extension's teamId key functions", () => {
    for (const name of KNOWN_GETTERS) expect(result.getters).toContain(name);
    // The extension's own team key function (it has no TeamVaultContextValue).
    expect(extensionGetters).toContain("getTeamEncryptionKey");
    // Not a key getter: a void member stays out.
    expect(result.getters).not.toContain("invalidateTeamKey");
  });

  it("derives the decrypt set: both decryptData declarations and the forwarding wrappers", () => {
    expect(result.decryptFns).toEqual(expect.arrayContaining([
      "src/lib/crypto/crypto-client.ts#decryptData",
      "extension/src/lib/crypto.ts#decryptData",
      "src/lib/crypto/crypto-team.ts#decryptTeamEntry",
    ]));
  });

  it(`(a) ${HELPER} is reached only from the upgrade paths and the history view`, () => {
    expect(result.helperViolations).toEqual([]);
  });

  it("(a) the history view uses it only to display a history row (handleView)", () => {
    expect(result.historyViewHelperSites).toEqual([HISTORY_VIEW_FN]);
  });

  it("(b) every reference to a decrypt function is a direct call with no spread", () => {
    expect(result.referenceViolations).toEqual([]);
  });

  it("(c) every team decrypt opens at a direct buildTeamEntryAAD (or a const bound to one)", () => {
    expect(result.decryptViolations).toEqual([]);
  });

  it("(c) every decrypt key is traced, or its site is in the reviewed NON_TEAM_DECRYPT_SITES (exactly)", () => {
    expect(reviewedSiteDrift(result.unclassified, NON_TEAM_DECRYPT_SITES)).toEqual([]);
  });

  it("(d) the derived strict-reader set contains every known reader", () => {
    expect(result.teamDecryptFiles.size).toBeGreaterThan(0);
    for (const rel of KNOWN_READERS) expect([...result.teamDecryptFiles]).toContain(rel);
    for (const rel of [...ALLOWED_DECRYPT_FILES]) expect([...result.teamDecryptFiles]).not.toContain(rel);
  });

  it("(d) personal-entry decrypts are examined and classified non-team (not flagged)", () => {
    for (const rel of [
      "src/hooks/use-watchtower.ts",
      "src/components/passwords/entry/entry-history-section.tsx",
      "extension/src/background/index.ts",
      "extension/src/background/login-save.ts",
      "extension/src/background/passkey-provider.ts",
    ]) {
      expect([...result.nonTeamDecryptFiles]).toContain(rel);
    }
  });
});

// ── (e) Red proofs on fixture sources ──────────────────────────────────

const FIXTURE_BASE: Record<string, string> = {
  "src/lib/crypto/crypto-client.ts": `
    export interface CryptoKey { readonly algorithm: unknown }
    export async function decryptData(e: unknown, k: CryptoKey, aad?: Uint8Array): Promise<string> { void e; void k; void aad; return ""; }
    export async function encryptData(p: string, k: CryptoKey, aad?: Uint8Array): Promise<unknown> { void p; void k; void aad; return {}; }`,
  "src/lib/crypto/crypto-team.ts": `
    import { decryptData, type CryptoKey } from "@/lib/crypto/crypto-client";
    export async function decryptTeamEntry(e: unknown, k: CryptoKey, aad?: Uint8Array): Promise<string> { return decryptData(e, k, aad); }`,
  "src/lib/crypto/crypto-aad.ts": `
    export function buildTeamEntryAAD(t: string, e: string, s: string, v: number): Uint8Array { void t; void e; void s; void v; return new Uint8Array(); }
    export function buildPersonalEntryAAD(u: string, e: string, s: string): Uint8Array { void u; void e; void s; return new Uint8Array(); }`,
  "src/lib/team/team-key-resolution.ts": `
    import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
    export function teamEntryAadFor(t: string, e: string, s: string, v: number, a: number): Uint8Array | undefined {
      return a >= 1 ? buildTeamEntryAAD(t, e, s, v) : undefined;
    }`,
  "src/lib/team/team-vault-core.tsx": `
    import type { CryptoKey } from "@/lib/crypto/crypto-client";
    export interface TeamVaultContextValue {
      getEntryDecryptionKey: (teamId: string, entryId: string, entry: unknown) => Promise<CryptoKey>;
      getTeamEncryptionKey: (teamId: string) => Promise<CryptoKey | null>;
      getItemEncryptionKey: (teamId: string, entryId: string) => Promise<{ keys: { encryptionKey: CryptoKey } }>;
      getEntryItemKeys: (teamId: string, entryId: string, entry: unknown) => Promise<{ encryptionKey: CryptoKey }>;
      invalidateTeamKey: (teamId: string) => void;
    }
    export function useTeamVault(): TeamVaultContextValue { throw new Error("fixture"); }
    export function useVault(): { encryptionKey: CryptoKey } { throw new Error("fixture"); }`,
};

const STRICT_READER = `
  import { decryptData } from "@/lib/crypto/crypto-client";
  import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
  import { useTeamVault } from "@/lib/team/team-vault-core";
  export async function read(row: { aadVersion: number; itemKeyVersion: number }) {
    const { getEntryDecryptionKey } = useTeamVault();
    const key = await getEntryDecryptionKey("t", "e", row);
    const aad = buildTeamEntryAAD("t", "e", "blob", row.itemKeyVersion);
    return decryptData({}, key, aad);
  }`;

/** Imports for the one-line fixtures below; their decrypt is on the line after it (line 6). */
const H = `import { decryptData } from "@/lib/crypto/crypto-client";
import type { CryptoKey } from "@/lib/crypto/crypto-client";
import { buildTeamEntryAAD, buildPersonalEntryAAD } from "@/lib/crypto/crypto-aad";
import { useTeamVault, useVault } from "@/lib/team/team-vault-core";
void buildTeamEntryAAD; void buildPersonalEntryAAD; void useVault;
`;

/**
 * A fixture reader (plus extra files) analysed with the same functions as the
 * tree. `library` files are in the project but not scanned, as node_modules is.
 */
function analyzeFixture(files: Record<string, string>, library: Record<string, string> = {}): Analysis {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, baseUrl: "/", paths: { "@/*": ["src/*"] } },
  });
  const map = new Map<string, SourceFile>();
  for (const [rel, text] of Object.entries({ ...FIXTURE_BASE, ...files })) {
    map.set(rel, project.createSourceFile(`/${rel}`, text));
  }
  for (const [rel, text] of Object.entries(library)) project.createSourceFile(`/${rel}`, text);
  return analyze([{ project, files: map, getterFunctionRoots: ["extension/src/"] }]);
}

const READER = "src/fixture/reader.ts";
const sites = (r: Analysis) => r.unclassified.map((u) => u.site);

describe("team entry AAD strictness guard (red proofs)", () => {
  // ── Allow side ──

  it("control: a strict reader passes and is derived as a strict reader", () => {
    const r = analyzeFixture({ [READER]: STRICT_READER });
    expect(r.helperViolations).toEqual([]);
    expect(r.referenceViolations).toEqual([]);
    expect(r.decryptViolations).toEqual([]);
    expect(r.unclassified).toEqual([]);
    expect([...r.teamDecryptFiles]).toEqual([READER]);
  });

  it("control: a personal decrypt with a conditional personal AAD in a team-reading module is not flagged", () => {
    const r = analyzeFixture({
      [READER]: `${STRICT_READER}
        import { buildPersonalEntryAAD } from "@/lib/crypto/crypto-aad";
        import { useVault } from "@/lib/team/team-vault-core";
        export async function personal(raw: { aadVersion: number }) {
          const { encryptionKey } = useVault();
          const aad = raw.aadVersion >= 1 ? buildPersonalEntryAAD("u", "e", "blob") : undefined;
          return decryptData({}, encryptionKey, aad);
        }`,
    });
    expect(r.decryptViolations).toEqual([]);
    expect(r.unclassified).toEqual([]);
    expect([...r.nonTeamDecryptFiles]).toEqual([READER]);
  });

  it("control (T15): alias following — a strict reader through an import-renamed builder and a const-aliased builder passes", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER
        .replace(`import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";`, `import { buildTeamEntryAAD as b } from "@/lib/crypto/crypto-aad";\n  const bb = b;`)
        .replace(`const aad = buildTeamEntryAAD("t", "e", "blob", row.itemKeyVersion);`, `const aad = bb("t", "e", "blob", row.itemKeyVersion);`),
    });
    expect(r.decryptViolations).toEqual([]);
    expect([...r.teamDecryptFiles]).toEqual([READER]);
  });

  it("control: a team key through the derived decryptTeamEntry wrapper at strict AAD passes and counts as a team decrypt", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER
        .replace(`import { decryptData } from "@/lib/crypto/crypto-client";`, `import { decryptTeamEntry } from "@/lib/crypto/crypto-team";`)
        .replace("return decryptData({}, key, aad);", "return decryptTeamEntry({}, key, aad);"),
    });
    expect(r.decryptFns).toEqual(["src/lib/crypto/crypto-client.ts#decryptData", "src/lib/crypto/crypto-team.ts#decryptTeamEntry"]);
    expect(r.decryptViolations).toEqual([]);
    expect([...r.teamDecryptFiles]).toEqual([READER]);
  });

  it("control: a reviewed unclassifiable site is not drift; an unreviewed one and a stale entry are", () => {
    const r = analyzeFixture({ [READER]: `${H}export const open = (k: CryptoKey) => [k].map((x) => decryptData({}, x));` });
    expect(sites(r)).toEqual([`${READER}:6`]);
    expect(reviewedSiteDrift(r.unclassified, [`${READER}:6`])).toEqual([]);
    expect(reviewedSiteDrift(r.unclassified, [])).toEqual([expect.stringMatching(/reader\.ts:6 unclassifiable decrypt key/)]);
    expect(reviewedSiteDrift([], [`${READER}:6`])).toEqual([expect.stringMatching(/reader\.ts:6 stale NON_TEAM_DECRYPT_SITES entry/)]);
  });

  // ── (a) the helper ──

  it("(a) an aliased import of the helper is a violation", () => {
    const r = analyzeFixture({
      [READER]: `import { teamEntryAadFor as strictAad } from "@/lib/team/team-key-resolution";
        export const f = strictAad;`,
    });
    expect(r.helperViolations).toEqual(expect.arrayContaining([expect.stringMatching(/reader\.ts:1 names teamEntryAadFor/)]));
  });

  it("(a) a barrel re-export under another name is a violation in the barrel and at the use site", () => {
    const r = analyzeFixture({
      "src/fixture/barrel.ts": `export { teamEntryAadFor as strictAad } from "@/lib/team/team-key-resolution";`,
      [READER]: `import { strictAad } from "@/fixture/barrel";
        export const aad = strictAad("t", "e", "blob", 1, 0);`,
    });
    expect(r.helperViolations).toEqual(expect.arrayContaining([
      expect.stringMatching(/barrel\.ts:1 names teamEntryAadFor/),
      expect.stringMatching(/reader\.ts:2 references teamEntryAadFor/),
    ]));
  });

  it("(a) namespace access through an `export *` barrel is a violation", () => {
    const r = analyzeFixture({
      "src/fixture/barrel.ts": `export * from "@/lib/team/team-key-resolution";`,
      [READER]: `import * as keys from "@/fixture/barrel";
        export const aad = keys.teamEntryAadFor("t", "e", "blob", 1, 0);`,
    });
    expect(r.helperViolations).toEqual([expect.stringMatching(/reader\.ts:2 references teamEntryAadFor/)]);
  });

  it("(a) a second declaration of the helper outside its home is a violation", () => {
    const r = analyzeFixture({
      [READER]: `export function teamEntryAadFor(): undefined { return undefined; }`,
    });
    expect(r.helperViolations).toEqual([expect.stringMatching(/reader\.ts:1 declares teamEntryAadFor outside/)]);
  });

  it("(a) an unresolvable import of the helper fails loudly", () => {
    const r = analyzeFixture({
      [READER]: `import { teamEntryAadFor } from "@/lib/team/no-such-module";
        export const f = teamEntryAadFor;`,
    });
    expect(r.helperViolations).toEqual([expect.stringMatching(/unresolved import of teamEntryAadFor/)]);
  });

  // ── (b) declaration-side enumeration: every decrypt reference is a direct call ──

  it.each([
    ["dynamic_import_destructure", `export async function r() { const { decryptData: d } = await import("@/lib/crypto/crypto-client"); return d; }`, /reader\.ts:6 decryptData is used as a value \(BindingElement\)/],
    ["ns_destructure", `import * as cc from "@/lib/crypto/crypto-client";\nconst { decryptData: d } = cc; export const f = d;`, /reader\.ts:7 decryptData is used as a value \(BindingElement\)/],
    ["dot_call", `export async function r(k: CryptoKey) { return decryptData.call(null, {}, k); }`, /reader\.ts:6 decryptData is used as a value \(PropertyAccessExpression\)/],
    ["apply_call", `export async function r(k: CryptoKey) { return decryptData.apply(null, [{}, k]); }`, /reader\.ts:6 decryptData is used as a value \(PropertyAccessExpression\)/],
    ["element_access", `import * as cc from "@/lib/crypto/crypto-client";\nexport async function r(k: CryptoKey) { return cc["decryptData"]({}, k); }`, /reader\.ts:7 decryptData is used as a value/],
    ["passed_as_value", `export async function r(ks: CryptoKey[]) { return ks.map(decryptData.bind(null, {})); }`, /reader\.ts:6 decryptData is used as a value/],
    ["const_alias", `const open = decryptData; export const f = open;`, /reader\.ts:6 decryptData is used as a value \(VariableDeclaration\)/],
    ["spread_args", `export async function r(k: CryptoKey) { const a = [{}, k] as const; return decryptData(...a); }`, /reader\.ts:6 decryptData is called with a spread argument/],
    ["wrapper_as_value", `import { decryptTeamEntry } from "@/lib/crypto/crypto-team";\nexport const f = [decryptTeamEntry];`, /reader\.ts:7 decryptTeamEntry is used as a value/],
  ])("(b) %s is a reference violation", (_name, body, pattern) => {
    const r = analyzeFixture({ [READER]: `${H}${body}` });
    expect(r.referenceViolations).toEqual([expect.stringMatching(pattern)]);
  });

  // ── (c) key-independent strict-AAD clause ──

  it.each([
    ["a ternary over the builder at the decrypt site", `export async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); return decryptData({}, encryptionKey, row.aadVersion >= 1 ? buildTeamEntryAAD("t", "e", "blob", 0) : undefined); }`, /reader\.ts:6 AAD is a ConditionalExpression/],
    ["a const bound to a ternary over an aliased builder", `import { buildTeamEntryAAD as b } from "@/lib/crypto/crypto-aad";\nexport async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); const aad = row.aadVersion && b("t", "e", "blob", 0); return decryptData({}, encryptionKey, aad || undefined); }`, /reader\.ts:7 AAD is a BinaryExpression/],
    ["a team builder in one branch, a personal builder in the other", `export async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); return decryptData({}, encryptionKey, row.aadVersion ? buildTeamEntryAAD("t", "e", "blob", 0) : buildPersonalEntryAAD("u", "e", "blob")); }`, /reader\.ts:6 AAD is a ConditionalExpression/],
    ["a local helper choosing the builder", `function pick(v: number) { return v >= 1 ? buildTeamEntryAAD("t", "e", "blob", 0) : undefined; }\nexport async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); return decryptData({}, encryptionKey, pick(row.aadVersion)); }`, /reader\.ts:7 AAD is a CallExpression/],
  ])("(c) %s is held to the strict shape whatever the key", (_name, body, pattern) => {
    const r = analyzeFixture({ [READER]: `${H}${body}` });
    expect(r.decryptViolations).toEqual([expect.stringMatching(pattern)]);
  });

  // ── (c) fail closed on untraceable keys (no AAD: only this rule can catch them) ──

  it.each([
    ["then_callback", `export async function r() { const { getEntryDecryptionKey } = useTeamVault(); return getEntryDecryptionKey("t", "e", {}).then((k) => decryptData({}, k)); }`],
    ["map_callback", `export async function r() { const { getEntryDecryptionKey } = useTeamVault(); const ks = [await getEntryDecryptionKey("t", "e", {})]; return Promise.all(ks.map((k) => decryptData({}, k))); }`],
    ["object_method_wrapper", `const c = { open(k: CryptoKey) { return decryptData({}, k); } };\nexport async function r() { const { getEntryDecryptionKey } = useTeamVault(); return c.open(await getEntryDecryptionKey("t", "e", {})); }`],
    ["object_arrow_wrapper", `const c = { open: (k: CryptoKey) => decryptData({}, k) };\nexport async function r() { const { getEntryDecryptionKey } = useTeamVault(); return c.open(await getEntryDecryptionKey("t", "e", {})); }`],
    ["class_method_wrapper", `class C { open(k: CryptoKey) { return decryptData({}, k); } }\nexport async function r() { const { getEntryDecryptionKey } = useTeamVault(); return new C().open(await getEntryDecryptionKey("t", "e", {})); }`],
    ["property-held key", `export async function r() { const box: { k?: CryptoKey } = {}; box.k = await useTeamVault().getEntryDecryptionKey("t", "e", {});\n  return decryptData({}, box.k as CryptoKey); }`],
    ["callback-param key", `async function openRow(getKey: () => Promise<CryptoKey>) { const k = await getKey(); return decryptData({}, k); }\nexport async function r() { const v = useTeamVault(); return openRow(() => v.getEntryDecryptionKey("t", "e", {})); }`],
    ["array holder filled by push", `export async function r() { const ks: CryptoKey[] = []; ks.push(await useTeamVault().getEntryDecryptionKey("t", "e", {}));
  return decryptData({}, ks[0]); }`],
    ["Map-cache key", `const cache = new Map<string, CryptoKey>();\nexport async function warm() { cache.set("t", await useTeamVault().getEntryDecryptionKey("t", "e", {})); }\nexport async function r() { return decryptData({}, cache.get("t") as CryptoKey); }`],
    ["class field key", `class Holder { key?: CryptoKey; async read() { return decryptData({}, this.key as CryptoKey); } }\nexport const h = new Holder();`],
  ])("(c) %s is unclassifiable (fails unless reviewed)", (name, body) => {
    const r = analyzeFixture({ [READER]: `${H}${body}` });
    const line = `${H}${body}`.split("\n").findIndex((l) => l.includes("decryptData({}")) + 1;
    expect(sites(r), name).toEqual([`${READER}:${line}`]);
  });

  // ── (c) the strict shape at a team decrypt (key from a getter) ──

  it("(c) a ternary at the decrypt site over an aliased builder is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(
        "return decryptData({}, key, aad);",
        "return decryptData({}, key, row.aadVersion >= 1 ? b(\"t\", \"e\", \"blob\", 0) : undefined);",
      ).replace(`import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";`,
        `import { buildTeamEntryAAD, buildTeamEntryAAD as b } from "@/lib/crypto/crypto-aad";`),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/AAD is a ConditionalExpression/)]);
  });

  it("(c) an early-return wrapper choosing the AAD is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(
        `const aad = buildTeamEntryAAD("t", "e", "blob", row.itemKeyVersion);`,
        `const pick = (v: number) => { if (v < 1) return undefined; return buildTeamEntryAAD("t", "e", "blob", 0); };
         const aad = pick(row.aadVersion);`,
      ),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/AAD const is bound to CallExpression, not a direct buildTeamEntryAAD call/)]);
  });

  it("(c) element access on \"aadVersion\" choosing the AAD is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(
        `const aad = buildTeamEntryAAD("t", "e", "blob", row.itemKeyVersion);`,
        `const aad = row["aadVersion"] ? buildTeamEntryAAD("t", "e", "blob", 0) : undefined;`,
      ),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/AAD const is bound to ConditionalExpression/)]);
  });

  it("(c) a builder argument read from element access on \"aadVersion\" is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(
        `buildTeamEntryAAD("t", "e", "blob", row.itemKeyVersion)`,
        `buildTeamEntryAAD("t", "e", "blob", row["aadVersion"])`,
      ),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/the builder's arguments read aadVersion/)]);
  });

  it("(c) a hoisted conditional at the decrypt site over a const-bound builder is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace("return decryptData({}, key, aad);", "return decryptData({}, key, row.aadVersion < 1 ? undefined : aad);"),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/AAD is a ConditionalExpression/)]);
  });

  it("(c) a let binding (reassignable) is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(`const aad = buildTeamEntryAAD`, `let aad = buildTeamEntryAAD`),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/AAD binding is not const/)]);
  });

  it("(c) a missing AAD through an import-renamed decrypt and a destructuring-renamed getter is a violation", () => {
    const r = analyzeFixture({
      [READER]: `
        import { decryptData as open } from "@/lib/crypto/crypto-client";
        import { useTeamVault } from "@/lib/team/team-vault-core";
        export async function read() {
          const { getEntryDecryptionKey: entryKey } = useTeamVault();
          const k = await entryKey("t", "e", {});
          return open({}, k);
        }`,
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/missing AAD argument/)]);
  });

  it("(c) a key from a library store (a library call with no key-material argument) is unclassifiable", () => {
    const r = analyzeFixture(
      { [READER]: `${H}import { readKey } from "@/vendor/keystore";\nexport async function r() { return decryptData({}, readKey("t")); }` },
      { "src/vendor/keystore.d.ts": `import type { CryptoKey } from "@/lib/crypto/crypto-client";\nexport declare function readKey(name: string): CryptoKey;` },
    );
    expect(r.unclassified).toEqual([{ site: `${READER}:7`, why: expect.stringMatching(/library call that holds it \(readKey\)/) }]);
  });

  it("(c) a team key put in React state through its setter is a team decrypt", () => {
    const r = analyzeFixture(
      { [READER]: `${H}import { useState } from "@/vendor/react";\nexport function useR() { const [k, setK] = useState<CryptoKey | null>(null);\n  const load = async () => setK(await useTeamVault().getEntryDecryptionKey("t", "e", {}));\n  return { load, read: () => decryptData({}, k as CryptoKey) }; }` },
      { "src/vendor/react.d.ts": `export declare function useState<T>(init: T): [T, (v: T) => void];` },
    );
    expect(r.decryptViolations).toEqual([expect.stringMatching(/reader\.ts:9 missing AAD argument \(team key via/)]);
  });

  it("(c) a team key through a named local wrapper forwarding key and AAD is checked at the wrapper's call site", () => {
    const r = analyzeFixture({
      [READER]: `
        import { decryptData } from "@/lib/crypto/crypto-client";
        import type { CryptoKey } from "@/lib/crypto/crypto-client";
        import { useTeamVault } from "@/lib/team/team-vault-core";
        async function openWith(k: CryptoKey, aad?: Uint8Array) { return decryptData({}, k, aad); }
        export async function read() {
          const vault = useTeamVault();
          return openWith(await vault.getTeamEncryptionKey("t") as CryptoKey);
        }`,
    });
    expect(r.decryptFns).toContain(`${READER}#openWith`);
    expect(r.decryptViolations).toEqual([expect.stringMatching(/reader\.ts:8 missing AAD argument/)]);
  });

  it("(c) a team key through a function parameter (enumerated call sites) is still a team decrypt", () => {
    const r = analyzeFixture({
      [READER]: `${H}export function useX(props: { k: CryptoKey }) { return decryptData({}, props.k); }
export async function r() { const { getEntryDecryptionKey } = useTeamVault(); return useX({ k: await getEntryDecryptionKey("t", "e", {}) }); }`,
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/reader\.ts:6 missing AAD argument/)]);
  });

  it("(d) a decrypt that no longer resolves to a team key getter drops out of the derived reader set", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(`const { getEntryDecryptionKey } = useTeamVault();`, `const localKey = async (..._a: unknown[]) => ({ algorithm: 0 });`)
        .replace(`await getEntryDecryptionKey(`, `await localKey(`)
        // No team AAD either: the AAD alone would classify it team.
        .replace("return decryptData({}, key, aad);", "void aad; return decryptData({}, key);"),
    });
    expect([...r.teamDecryptFiles]).not.toContain(READER);
  });
});
