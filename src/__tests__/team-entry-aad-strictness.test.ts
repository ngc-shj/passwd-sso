/**
 * Strict team entry AAD (deviations D67, D72, D73, D77, D80; review rounds
 * 3-5: T11 / S-R3-1, T13 / S-R4-1, T16 / T17 / S-R5-1).
 *
 * A live team entry is always read at AAD 1 (`buildTeamEntryAAD` at the
 * entry's ItemKey version). Choosing the AAD by the server-supplied
 * `aadVersion` lets a DB-write attacker label an entry 0 and substitute a
 * legacy no-AAD ciphertext, so the aadVersion-aware `teamEntryAadFor` is
 * confined to the paths that UPGRADE such a live entry to AAD 1 (rotation,
 * re-key) and the history VIEW (a server-held row that is only displayed).
 * History RESTORE refuses a legacy row (S-R3-2); the re-key pass re-seals a
 * legacy history row under the new ItemKey still without AAD, through the one
 * confined `resealLegacyHistoryRow` (S-R5-2), so the row stays unrestorable.
 *
 * What this guard PROVES. Each rule resolves bindings through a ts-morph
 * Program built from the tree's tsconfig (`@/` aliases, re-exports, renamed
 * imports), not spellings:
 *  (a) Confinement. `teamEntryAadFor` and `resealLegacyHistoryRow` are each
 *      declared once, in their home, and named only in their allow-listed
 *      files: no import / export specifier by its imported name (`as` renames
 *      count), no reference `findReferences` resolves to the declaration
 *      (renamed re-exports, `export *` namespace access), no element access
 *      spelling it, no redeclaration. An import of one that resolves to
 *      nothing fails loudly. `teamEntryAadFor` never supplies an encryptData
 *      AAD; in the history view it is called from handleView only.
 *  (b) Key-independent AAD shape. The decrypt set is every `decryptData`
 *      declaration plus every named function forwarding its own key and AAD
 *      parameters to a member (fixed point: `decryptTeamEntry`, local
 *      `tryDecrypt`s; a forwarding call is checked at its callers). Every
 *      decrypt call whose AAD argument names `buildTeamEntryAAD` — through
 *      aliases, const/let bindings and their assignments, ternary/logical
 *      branches, a local helper's body — must pass either a direct
 *      `buildTeamEntryAAD(...)` call or an identifier bound by `const` to
 *      one, whose arguments never read `aadVersion`. Exempt: the upgrade
 *      functions in EXEMPT_DECRYPT_FUNCTIONS.
 *  (c) Declaration-side reference enumeration of the decrypt set: every
 *      reference is an import / export specifier, a `typeof`, or the direct
 *      callee of a call with no spread argument. A destructuring rename
 *      (incl. of a namespace or a dynamic import), `.call` / `.apply`,
 *      element access, the function passed or bound as a value are
 *      violations — so every decrypt in the tree is a call (b) sees.
 *  (d) A FLOOR, not a derivation: each module in KNOWN_TEAM_READERS (a hand
 *      list) still makes at least one decrypt call whose AAD names
 *      `buildTeamEntryAAD`. A known reader that stops passing the team AAD
 *      fails here.
 *
 * What it does NOT prove. It cannot tell whether a decrypt uses a TEAM key:
 * static key-provenance tracing is undecidable, and the classifier that tried
 * it (D73, D77) escaped four review rounds running, its arms becoming the
 * defect surface; it was removed (D80). A NEW team reader that passes NO AAD,
 * or a non-team builder's AAD, is therefore not detected — the same as main.
 * That residual is covered by each reader's own refusal cells (a no-AAD
 * ciphertext labelled aadVersion 0 is refused) and is the subject of a
 * follow-up: route every team entry decrypt through one strict helper.
 * iOS (Swift) is outside this gate; its refusal cells pin the same rule.
 */
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type { CallExpression, Identifier, SourceFile, Symbol as MorphSymbol, Type } from "ts-morph";

const REPO_ROOT = path.resolve(__dirname, "../..");

const HELPER = "teamEntryAadFor";
const RESEAL = "resealLegacyHistoryRow";
const BUILDER = "buildTeamEntryAAD";
const DECRYPT = "decryptData";
const HISTORY_VIEW = "src/components/passwords/entry/entry-history-section.tsx";
const HISTORY_VIEW_FN = "handleView";
const REKEY_PAYLOAD = "src/lib/team/rekey-payload.ts";
const ROTATION_PAYLOAD = "src/lib/team/rotation-payload.ts";

/** Each confined name: its one home, and the files that may name it. */
const CONFINED: readonly { name: string; home: string; allowed: ReadonlySet<string> }[] = [
  // Rotation (v0 re-seal), re-key (live entry, v0→v1 upgrade), the history view.
  { name: HELPER, home: "src/lib/team/team-key-resolution.ts", allowed: new Set(["src/lib/team/team-key-resolution.ts", ROTATION_PAYLOAD, REKEY_PAYLOAD, HISTORY_VIEW]) },
  // The re-key pass's no-AAD re-seal of a legacy history row (D80).
  { name: RESEAL, home: REKEY_PAYLOAD, allowed: new Set([REKEY_PAYLOAD]) },
];

/** The functions whose decrypts open a legacy live entry by its aadVersion (rule (b) exempt). */
const EXEMPT_DECRYPT_FUNCTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [ROTATION_PAYLOAD, new Set(["reencryptV0"])],
  [REKEY_PAYLOAD, new Set(["buildEntryRekeyPayload", "buildEntryUpgradePayload"])],
  [HISTORY_VIEW, new Set([HISTORY_VIEW_FN])],
]);

/** Floor (d): a hand list of the known team reader modules, not a derivation. */
const KNOWN_TEAM_READERS = [
  "src/lib/vault/team-vault-list-adapter.ts",
  "src/lib/vault/build-team-get-detail.ts",
  "src/hooks/use-watchtower.ts",
  "src/components/team/management/team-export.tsx",
  "src/components/team/management/team-edit-dialog-loader.tsx",
  "src/app/[locale]/admin/teams/[teamId]/audit-logs/page.tsx",
  "src/hooks/team/use-team-login-form-state.ts",
  "src/lib/team/team-history-restore.ts",
  REKEY_PAYLOAD,
  "extension/src/background/index.ts",
];

interface Tree {
  project: Project;
  /** Scanned (non-test) source files, keyed by repo-relative POSIX path. */
  files: Map<string, SourceFile>;
}

interface Analysis {
  /** Derived decrypt set, as `file#name` (the decryptData declarations and the forwarding wrappers). */
  decryptFns: string[];
  confinementViolations: string[];
  shapeViolations: string[];
  referenceViolations: string[];
  /** Modules with a non-exempt decrypt call whose AAD names the builder. */
  teamAadFiles: string[];
  /** handleView sites of the helper in the history view. */
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
function loadRepoTree(tsconfig: string, scanRoot: string): Tree {
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

/** A named function's binding: a `function` declaration, or a function bound by a variable declaration. */
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

const BYTE_TYPES = new Set(["Uint8Array", "ArrayBuffer", "ArrayBufferView"]);

/** A value an AAD can be built from: bytes, or something callable (a builder alias, a local helper). */
function isAadLike(type: Type): boolean {
  const t = type.getNonNullableType();
  if (t.isUnion()) return t.getUnionTypes().some(isAadLike);
  return BYTE_TYPES.has(t.getSymbol()?.getName() ?? "") || t.getCallSignatures().length > 0;
}

// ── (b) The strict AAD shape ───────────────────────────────────────────

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

const MAX_DEPTH = 40;

function analyze(trees: Tree[]): Analysis {
  const builders = new Set(findFunctionDeclarations(trees, BUILDER));
  const baseDecrypts = findFunctionDeclarations(trees, DECRYPT);
  const confinedDecls = new Map(CONFINED.map((c) => [c.name, new Set(findFunctionDeclarations(trees, c.name))]));
  if (builders.size === 0 || baseDecrypts.length === 0 || [...confinedDecls.values()].some((s) => s.size === 0)) {
    throw new Error(`guard targets did not resolve: ${BUILDER}=${builders.size} ${DECRYPT}=${baseDecrypts.length} `
      + [...confinedDecls].map(([n, s]) => `${n}=${s.size}`).join(" "));
  }

  const relOf = new Map<SourceFile, string>();
  for (const tree of trees) for (const [rel, sf] of tree.files) relOf.set(sf, rel);
  const where = (n: Node) => `${relOf.get(n.getSourceFile()) ?? n.getSourceFile().getFilePath()}:${n.getStartLineNumber()}`;
  const scanned = (n: Node) => relOf.has(n.getSourceFile());
  const referencesOf = (nameNode: Identifier): Node[] =>
    nameNode.findReferencesAsNodes().filter((r) => r !== nameNode && scanned(r));

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

  // ── (c) Every reference to a decrypt function is a direct call.
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

  /** The expressions a scanned declaration binds: an initializer and its assignments, a function body. */
  const bindingSources = (d: Node): Node[] => {
    if (Node.isVariableDeclaration(d)) {
      const sources: Node[] = [];
      const init = d.getInitializer();
      if (init) sources.push(init);
      const nameNode = d.getNameNode();
      if (!Node.isIdentifier(nameNode)) return sources;
      for (const ref of referencesOf(nameNode)) {
        const parent = ref.getParentOrThrow();
        if (Node.isBinaryExpression(parent) && parent.getLeft() === ref && ASSIGNMENT_OPERATORS.has(parent.getOperatorToken().getKind())) {
          sources.push(parent.getRight());
        }
      }
      return sources;
    }
    if (Node.isBindingElement(d)) {
      const init = d.getFirstAncestorByKind(SyntaxKind.VariableDeclaration)?.getInitializer();
      return init ? [init] : [];
    }
    if (Node.isFunctionDeclaration(d)) {
      const body = d.getBody();
      return body ? [body] : [];
    }
    return [];
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
      if (!isAadLike(n.getType())) continue;
      for (const d of decls) {
        if (scanned(d) && bindingSources(d).some((s) => namesBuilder(s, seen, depth + 1))) return true;
      }
    }
    return false;
  };

  const confinementViolations: string[] = [];
  const shapeViolations: string[] = [];
  const teamAadFiles = new Set<string>();
  const historyViewHelperSites: string[] = [];

  for (const tree of trees) {
    for (const [rel, sf] of tree.files) {
      // (a) spellings of each confined name: imported / exported names, element access.
      for (const c of CONFINED) {
        const decls = confinedDecls.get(c.name) as Set<Node>;
        for (const spec of [...sf.getDescendantsOfKind(SyntaxKind.ImportSpecifier), ...sf.getDescendantsOfKind(SyntaxKind.ExportSpecifier)]) {
          // getNameNode() is the IMPORTED / re-exported name in both specifier kinds (the `as` name is the alias node).
          if (spec.getNameNode().getText() !== c.name) continue;
          const symbol = spec.getSymbol();
          const resolved = symbol ? aliased(symbol).getDeclarations() : [];
          if (!resolved.some((d) => decls.has(d))) confinementViolations.push(`${where(spec)} unresolved import of ${c.name}`);
          else if (!c.allowed.has(rel)) confinementViolations.push(`${where(spec)} names ${c.name}`);
        }
        for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
          const arg = ea.getArgumentExpression();
          if (arg && Node.isStringLiteral(arg) && arg.getLiteralText() === c.name && !c.allowed.has(rel)) {
            confinementViolations.push(`${where(ea)} element access to ${c.name}`);
          }
        }
      }

      // (b) the strict shape of every decrypt whose AAD names the builder.
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const fn = decryptFnOf(call);
        if (!fn || forwardCalls.has(call)) continue;
        if (EXEMPT_DECRYPT_FUNCTIONS.get(rel)?.has(enclosingFunctionName(call) ?? "")) continue;
        const aad = call.getArguments()[fn.aadIndex];
        if (aad === undefined || !namesBuilder(aad, new Set(), 0)) continue;
        teamAadFiles.add(rel);
        const why = aadShapeViolation(aad, builders);
        if (why) shapeViolations.push(`${where(call)} ${why}`);
      }
    }

    // (a) every reference to each confined declaration, however spelled.
    for (const c of CONFINED) {
      for (const decl of confinedDecls.get(c.name) as Set<Node>) {
        const home = relOf.get(decl.getSourceFile());
        if (home !== undefined && home !== c.home) confinementViolations.push(`${where(decl)} declares ${c.name} outside ${c.home}`);
        if (!Node.isFunctionDeclaration(decl) || !tree.project.getSourceFile(decl.getSourceFile().getFilePath())) continue;
        for (const ref of referencesOf(decl.getNameNodeOrThrow())) {
          const rel = relOf.get(ref.getSourceFile());
          if (rel === undefined || !tree.files.has(rel)) continue;
          // Specifiers and element access are reported above, by their spelling.
          const spelled = Node.isImportSpecifier(ref.getParent()) || Node.isExportSpecifier(ref.getParent())
            || Node.isElementAccessExpression(ref.getParent());
          if (!c.allowed.has(rel) && !spelled) confinementViolations.push(`${where(ref)} references ${c.name}`);
          if (c.name !== HELPER) continue;
          if (rel === HISTORY_VIEW && Node.isCallExpression(ref.getParent())) {
            historyViewHelperSites.push(enclosingFunctionName(ref) ?? "<top level>");
          }
          const inEncrypt = ref.getAncestors().some((a) => Node.isCallExpression(a) && terminalName(a.getExpression()) === "encryptData");
          if (inEncrypt) confinementViolations.push(`${where(ref)} ${HELPER} supplies an encryptData AAD`);
        }
      }
    }
  }
  const decryptFnNames = [...decryptFns.values()].map((f) => `${relOf.get(f.decl.getSourceFile()) ?? f.decl.getSourceFile().getFilePath()}#${f.nameNode.getText()}`);
  return {
    decryptFns: decryptFnNames.sort(), confinementViolations, shapeViolations, referenceViolations,
    teamAadFiles: [...teamAadFiles].sort(), historyViewHelperSites,
  };
}

/** (d) The known readers that no longer make a decrypt call at a team AAD. */
function floorViolations(teamAadFiles: readonly string[], known: readonly string[]): string[] {
  const found = new Set(teamAadFiles);
  return known.filter((rel) => !found.has(rel)).map((rel) => `${rel} makes no decrypt call at a ${BUILDER} AAD`);
}

// ── The repository ─────────────────────────────────────────────────────

describe("team entry AAD strictness (D67, D73, D80)", () => {
  let result: Analysis;
  let scannedCount = 0;

  beforeAll(() => {
    const app = loadRepoTree("tsconfig.json", "src");
    const ext = loadRepoTree("extension/tsconfig.json", "extension/src");
    scannedCount = app.files.size + ext.files.size;
    result = analyze([app, ext]);
  }, 180_000);

  it("scans every module under src/ and extension/src/ (non-vacuous)", () => {
    expect(scannedCount).toBeGreaterThan(500);
  });

  it("derives the decrypt set: both decryptData declarations and the forwarding wrappers", () => {
    expect(result.decryptFns).toEqual(expect.arrayContaining([
      "src/lib/crypto/crypto-client.ts#decryptData",
      "extension/src/lib/crypto.ts#decryptData",
      "src/lib/crypto/crypto-team.ts#decryptTeamEntry",
    ]));
  });

  it(`(a) ${HELPER} and ${RESEAL} are named only in their allow-listed files`, () => {
    expect(result.confinementViolations).toEqual([]);
  });

  it(`(a) the history view calls ${HELPER} only to display a history row (handleView)`, () => {
    expect(result.historyViewHelperSites).toEqual([HISTORY_VIEW_FN]);
  });

  it(`(b) every decrypt whose AAD names ${BUILDER} opens at a direct call (or a const bound to one)`, () => {
    expect(result.shapeViolations).toEqual([]);
  });

  it("(c) every reference to a decrypt function is a direct call with no spread", () => {
    expect(result.referenceViolations).toEqual([]);
  });

  it("(d) floor: every known team reader still decrypts at a team AAD", () => {
    expect(floorViolations(result.teamAadFiles, KNOWN_TEAM_READERS)).toEqual([]);
  });
});

// ── Red proofs on fixture sources ──────────────────────────────────────

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
  [REKEY_PAYLOAD]: `
    export async function resealLegacyHistoryRow(): Promise<null> { return null; }`,
  "src/lib/team/team-vault-core.tsx": `
    import type { CryptoKey } from "@/lib/crypto/crypto-client";
    export function useVault(): { encryptionKey: CryptoKey } { throw new Error("fixture"); }`,
};

const STRICT_READER = `
  import { decryptData } from "@/lib/crypto/crypto-client";
  import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
  import { useVault } from "@/lib/team/team-vault-core";
  export async function read(row: { aadVersion: number; itemKeyVersion: number }) {
    const { encryptionKey: key } = useVault();
    const aad = buildTeamEntryAAD("t", "e", "blob", row.itemKeyVersion);
    return decryptData({}, key, aad);
  }`;

/** Imports for the one-line fixtures below; their code starts on line 6. */
const H = `import { decryptData } from "@/lib/crypto/crypto-client";
import type { CryptoKey } from "@/lib/crypto/crypto-client";
import { buildTeamEntryAAD, buildPersonalEntryAAD } from "@/lib/crypto/crypto-aad";
import { useVault } from "@/lib/team/team-vault-core";
void buildTeamEntryAAD; void buildPersonalEntryAAD; void useVault;
`;

/** A fixture reader (plus extra files) analysed with the same function as the tree. */
function analyzeFixture(files: Record<string, string>): Analysis {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, baseUrl: "/", paths: { "@/*": ["src/*"] } },
  });
  const map = new Map<string, SourceFile>();
  for (const [rel, text] of Object.entries({ ...FIXTURE_BASE, ...files })) {
    map.set(rel, project.createSourceFile(`/${rel}`, text));
  }
  return analyze([{ project, files: map }]);
}

const READER = "src/fixture/reader.ts";

/** Every rule's outcome for a fixture, so each cell is one exact assertion. */
function outcome(r: Analysis) {
  return {
    confinement: r.confinementViolations,
    shape: r.shapeViolations,
    reference: r.referenceViolations,
    teamAad: r.teamAadFiles.filter((f) => f.startsWith("src/fixture/")),
  };
}
const CLEAN = { confinement: [], shape: [], reference: [] };

describe("team entry AAD strictness guard (red proofs)", () => {
  // ── Controls ──

  it("control: a strict reader passes every rule and counts as a team-AAD module", () => {
    expect(outcome(analyzeFixture({ [READER]: STRICT_READER }))).toEqual({ ...CLEAN, teamAad: [READER] });
  });

  it("control: a decrypt with a conditional personal AAD is outside rule (b)", () => {
    const r = analyzeFixture({
      [READER]: `${H}export async function personal(raw: { aadVersion: number }) {
        const { encryptionKey } = useVault();
        const aad = raw.aadVersion >= 1 ? buildPersonalEntryAAD("u", "e", "blob") : undefined;
        return decryptData({}, encryptionKey, aad); }`,
    });
    expect(outcome(r)).toEqual({ ...CLEAN, teamAad: [] });
  });

  it("control (T15): an import-renamed builder behind a const alias is followed and passes", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER
        .replace(`import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";`, `import { buildTeamEntryAAD as b } from "@/lib/crypto/crypto-aad";\n  const bb = b;`)
        .replace(`const aad = buildTeamEntryAAD("t", "e", "blob", row.itemKeyVersion);`, `const aad = bb("t", "e", "blob", row.itemKeyVersion);`),
    });
    expect(outcome(r)).toEqual({ ...CLEAN, teamAad: [READER] });
  });

  it("control: the derived decryptTeamEntry wrapper at strict AAD passes and counts as a team-AAD module", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER
        .replace(`import { decryptData } from "@/lib/crypto/crypto-client";`, `import { decryptTeamEntry } from "@/lib/crypto/crypto-team";`)
        .replace("return decryptData({}, key, aad);", "return decryptTeamEntry({}, key, aad);"),
    });
    expect(outcome(r)).toEqual({ ...CLEAN, teamAad: [READER] });
  });

  // ── (a) confinement ──

  it.each([
    ["an aliased import of the helper", {
      [READER]: `import { teamEntryAadFor as strictAad } from "@/lib/team/team-key-resolution";\nexport const f = strictAad;`,
    }, [/^src\/fixture\/reader\.ts:1 names teamEntryAadFor$/, /^src\/fixture\/reader\.ts:2 references teamEntryAadFor$/]],
    ["a barrel re-export under another name", {
      "src/fixture/barrel.ts": `export { teamEntryAadFor as strictAad } from "@/lib/team/team-key-resolution";`,
      [READER]: `import { strictAad } from "@/fixture/barrel";\nexport const aad = strictAad("t", "e", "blob", 1, 0);`,
    }, [/^src\/fixture\/barrel\.ts:1 names teamEntryAadFor$/, /^src\/fixture\/reader\.ts:2 references teamEntryAadFor$/]],
    ["namespace access through an `export *` barrel", {
      "src/fixture/barrel.ts": `export * from "@/lib/team/team-key-resolution";`,
      [READER]: `import * as keys from "@/fixture/barrel";\nexport const aad = keys.teamEntryAadFor("t", "e", "blob", 1, 0);`,
    }, [/^src\/fixture\/reader\.ts:2 references teamEntryAadFor$/]],
    ["element access spelling the helper", {
      [READER]: `import * as keys from "@/lib/team/team-key-resolution";\nexport const aad = keys["teamEntryAadFor"]("t", "e", "blob", 1, 0);`,
    }, [/^src\/fixture\/reader\.ts:2 element access to teamEntryAadFor$/]],
    ["a second declaration of the helper outside its home", {
      [READER]: `export function teamEntryAadFor(): undefined { return undefined; }`,
    }, [/^src\/fixture\/reader\.ts:1 declares teamEntryAadFor outside src\/lib\/team\/team-key-resolution\.ts$/]],
    ["an unresolvable import of the helper", {
      [READER]: `import { teamEntryAadFor } from "@/lib/team/no-such-module";\nexport const f = teamEntryAadFor;`,
    }, [/^src\/fixture\/reader\.ts:1 unresolved import of teamEntryAadFor$/]],
    ["the helper supplying an encryptData AAD in an allowed file", {
      [REKEY_PAYLOAD]: `import { encryptData, type CryptoKey } from "@/lib/crypto/crypto-client";
import { teamEntryAadFor } from "@/lib/team/team-key-resolution";
export async function resealLegacyHistoryRow(): Promise<null> { return null; }
export const seal = (k: CryptoKey) => encryptData("p", k, teamEntryAadFor("t", "e", "blob", 1, 0));`,
    }, [/^src\/lib\/team\/rekey-payload\.ts:4 teamEntryAadFor supplies an encryptData AAD$/]],
    ["an import of the legacy re-seal outside the re-key payload", {
      [READER]: `import { resealLegacyHistoryRow } from "@/lib/team/rekey-payload";\nexport const f = resealLegacyHistoryRow();`,
    }, [/^src\/fixture\/reader\.ts:1 names resealLegacyHistoryRow$/, /^src\/fixture\/reader\.ts:2 references resealLegacyHistoryRow$/]],
    ["a second declaration of the legacy re-seal", {
      [READER]: `export async function resealLegacyHistoryRow(): Promise<null> { return null; }`,
    }, [/^src\/fixture\/reader\.ts:1 declares resealLegacyHistoryRow outside src\/lib\/team\/rekey-payload\.ts$/]],
  ])("(a) %s is a confinement violation", (_name, files, patterns) => {
    const r = analyzeFixture(files);
    expect(outcome(r)).toEqual({ ...CLEAN, teamAad: [], confinement: patterns.map((p) => expect.stringMatching(p)) });
  });

  // ── (b) the strict AAD shape, whatever the key ──

  it.each([
    ["a ternary over the builder at the decrypt site", `export async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); return decryptData({}, encryptionKey, row.aadVersion >= 1 ? buildTeamEntryAAD("t", "e", "blob", 0) : undefined); }`, /^src\/fixture\/reader\.ts:6 AAD is a ConditionalExpression/],
    ["a const bound to `&&` over an aliased builder", `import { buildTeamEntryAAD as b } from "@/lib/crypto/crypto-aad";\nexport async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); const aad = row.aadVersion && b("t", "e", "blob", 0); return decryptData({}, encryptionKey, aad || undefined); }`, /^src\/fixture\/reader\.ts:7 AAD is a BinaryExpression/],
    ["a team builder in one branch, a personal builder in the other", `export async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); return decryptData({}, encryptionKey, row.aadVersion ? buildTeamEntryAAD("t", "e", "blob", 0) : buildPersonalEntryAAD("u", "e", "blob")); }`, /^src\/fixture\/reader\.ts:6 AAD is a ConditionalExpression/],
    ["a local function declaration choosing the builder", `function pick(v: number) { return v >= 1 ? buildTeamEntryAAD("t", "e", "blob", 0) : undefined; }\nexport async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); return decryptData({}, encryptionKey, pick(row.aadVersion)); }`, /^src\/fixture\/reader\.ts:7 AAD is a CallExpression/],
    ["an early-return arrow choosing the builder", `export async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); const pick = (v: number) => { if (v < 1) return undefined; return buildTeamEntryAAD("t", "e", "blob", 0); }; const aad = pick(row.aadVersion); return decryptData({}, encryptionKey, aad); }`, /^src\/fixture\/reader\.ts:6 AAD const is bound to CallExpression, not a direct buildTeamEntryAAD call/],
    ["element access on \"aadVersion\" choosing the builder", `export async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); const aad = row["aadVersion"] ? buildTeamEntryAAD("t", "e", "blob", 0) : undefined; return decryptData({}, encryptionKey, aad); }`, /^src\/fixture\/reader\.ts:6 AAD const is bound to ConditionalExpression/],
    ["a builder argument read from element access on \"aadVersion\"", `export async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); const aad = buildTeamEntryAAD("t", "e", "blob", row["aadVersion"]); return decryptData({}, encryptionKey, aad); }`, /^src\/fixture\/reader\.ts:6 the builder's arguments read aadVersion$/],
    ["a hoisted conditional at the decrypt site over a const-bound builder", `export async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); const aad = buildTeamEntryAAD("t", "e", "blob", 1); return decryptData({}, encryptionKey, row.aadVersion < 1 ? undefined : aad); }`, /^src\/fixture\/reader\.ts:6 AAD is a ConditionalExpression/],
    ["a let binding (reassignable)", `export async function r() { const { encryptionKey } = useVault(); let aad = buildTeamEntryAAD("t", "e", "blob", 1); return decryptData({}, encryptionKey, aad); }`, /^src\/fixture\/reader\.ts:6 AAD binding is not const$/],
    ["a let assigned the builder after its declaration", `export async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); let aad: Uint8Array | undefined; if (row.aadVersion) aad = buildTeamEntryAAD("t", "e", "blob", 1); return decryptData({}, encryptionKey, aad); }`, /^src\/fixture\/reader\.ts:6 AAD binding is not const$/],
    ["a conditional AAD through a named local wrapper forwarding key and AAD", `async function openWith(k: CryptoKey, aad?: Uint8Array) { return decryptData({}, k, aad); }\nexport async function r(row: { aadVersion: number }) { const { encryptionKey } = useVault(); return openWith(encryptionKey, row.aadVersion ? buildTeamEntryAAD("t", "e", "blob", 1) : undefined); }`, /^src\/fixture\/reader\.ts:7 AAD is a ConditionalExpression/],
  ])("(b) %s is a strict-shape violation", (_name, body, pattern) => {
    const r = analyzeFixture({ [READER]: `${H}${body}` });
    expect(outcome(r)).toEqual({ ...CLEAN, teamAad: [READER], shape: [expect.stringMatching(pattern)] });
  });

  it("(b) the exemption is per function: a ternary AAD elsewhere in an exempt file is a violation", () => {
    const r = analyzeFixture({
      [REKEY_PAYLOAD]: `${H}export async function resealLegacyHistoryRow(): Promise<null> { return null; }
export async function openHistoryRow(row: { aadVersion: number }) { const { encryptionKey } = useVault(); return decryptData({}, encryptionKey, row.aadVersion ? buildTeamEntryAAD("t", "e", "blob", 1) : undefined); }
export async function buildEntryRekeyPayload(row: { aadVersion: number }) { const { encryptionKey } = useVault(); return decryptData({}, encryptionKey, row.aadVersion ? buildTeamEntryAAD("t", "e", "blob", 1) : undefined); }`,
    });
    expect(outcome(r)).toEqual({ ...CLEAN, teamAad: [], shape: [expect.stringMatching(/^src\/lib\/team\/rekey-payload\.ts:7 AAD is a ConditionalExpression/)] });
  });

  // ── (c) declaration-side enumeration: every decrypt reference is a direct call ──

  it.each([
    ["a destructured dynamic import", `export async function r() { const { decryptData: d } = await import("@/lib/crypto/crypto-client"); return d; }`, /^src\/fixture\/reader\.ts:6 decryptData is used as a value \(BindingElement\)/],
    ["a namespace destructure", `import * as cc from "@/lib/crypto/crypto-client";\nconst { decryptData: d } = cc; export const f = d;`, /^src\/fixture\/reader\.ts:7 decryptData is used as a value \(BindingElement\)/],
    ["`.call`", `export async function r(k: CryptoKey) { return decryptData.call(null, {}, k); }`, /^src\/fixture\/reader\.ts:6 decryptData is used as a value \(PropertyAccessExpression\)/],
    ["`.apply`", `export async function r(k: CryptoKey) { return decryptData.apply(null, [{}, k]); }`, /^src\/fixture\/reader\.ts:6 decryptData is used as a value \(PropertyAccessExpression\)/],
    ["element access", `import * as cc from "@/lib/crypto/crypto-client";\nexport async function r(k: CryptoKey) { return cc["decryptData"]({}, k); }`, /^src\/fixture\/reader\.ts:7 decryptData is used as a value \(ElementAccessExpression\)/],
    ["`.bind` passed as a value", `export async function r(ks: CryptoKey[]) { return ks.map(decryptData.bind(null, {})); }`, /^src\/fixture\/reader\.ts:6 decryptData is used as a value \(PropertyAccessExpression\)/],
    ["a const alias", `const open = decryptData; export const f = open;`, /^src\/fixture\/reader\.ts:6 decryptData is used as a value \(VariableDeclaration\)/],
    ["a spread argument", `export async function r(k: CryptoKey) { const a = [{}, k] as const; return decryptData(...a); }`, /^src\/fixture\/reader\.ts:6 decryptData is called with a spread argument$/],
    ["a derived wrapper held as a value", `import { decryptTeamEntry } from "@/lib/crypto/crypto-team";\nexport const f = [decryptTeamEntry];`, /^src\/fixture\/reader\.ts:7 decryptTeamEntry is used as a value \(ArrayLiteralExpression\)/],
  ])("(c) %s is a reference violation", (_name, body, pattern) => {
    const r = analyzeFixture({ [READER]: `${H}${body}` });
    expect(outcome(r)).toEqual({ ...CLEAN, teamAad: [], reference: [expect.stringMatching(pattern)] });
  });

  // ── (d) the floor ──

  it("(d) a known reader that stops passing the team AAD falls below the floor", () => {
    const r = analyzeFixture({ [READER]: STRICT_READER.replace("return decryptData({}, key, aad);", "void aad; return decryptData({}, key);") });
    expect(floorViolations(r.teamAadFiles, [READER])).toEqual([`${READER} makes no decrypt call at a ${BUILDER} AAD`]);
  });

  it("(d) control: a strict reader meets the floor", () => {
    const r = analyzeFixture({ [READER]: STRICT_READER });
    expect(floorViolations(r.teamAadFiles, [READER])).toEqual([]);
  });
});
