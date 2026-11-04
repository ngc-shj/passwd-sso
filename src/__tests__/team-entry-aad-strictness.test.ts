/**
 * Strict team entry AAD (deviations D67, D72, D73; round-3 T11 / S-R3-1).
 *
 * A live team entry is always read at AAD 1 (`buildTeamEntryAAD` at the
 * entry's ItemKey version). Choosing the AAD by the server-supplied
 * `aadVersion` lets a DB-write attacker label an entry 0 and substitute a
 * legacy no-AAD ciphertext, so the aadVersion-aware `teamEntryAadFor` is
 * confined to the paths that UPGRADE such a row to AAD 1 (rotation, re-key)
 * and the history VIEW (a server-held row that is only displayed). History
 * RESTORE is not among them: it refuses a legacy row (S-R3-2).
 *
 * The rules resolve BINDINGS, not spellings: each scanned tree is loaded into
 * a ts-morph Project built from its tsconfig (`@/` aliases, re-exports and
 * renamed imports resolve through the type checker's symbols).
 *
 *  (a) Outside ALLOWED_HELPER_FILES no import / export specifier names
 *      `teamEntryAadFor` (its imported name, so `as` renames count), no
 *      reference resolves to its declaration (findReferences follows renamed
 *      re-exports and namespace access), and no element access spells it. An
 *      import of it that does not resolve fails loudly.
 *  (b) Positive rule. A "team decrypt" is a `decryptData` call (callee resolved
 *      through aliases to a decryptData declaration) whose key argument flows
 *      from a team key getter call (through const/let bindings, assignments,
 *      and the callers of a local function's parameter). Its AAD argument must
 *      be present and be either a direct `buildTeamEntryAAD(...)` call
 *      (resolved through aliases) or an identifier bound by `const` to one;
 *      the builder's arguments never read `aadVersion` (identifier, property
 *      or element access). Exempt: ALLOWED_DECRYPT_FILES and handleView in
 *      the history view.
 *      The team key getter set is DERIVED: the members of TeamVaultContextValue
 *      whose (awaited) return type carries a CryptoKey within two property
 *      levels, plus every function under extension/src with a `teamId`
 *      parameter returning one.
 *  (c) The strict-reader set is the set of modules (b) found a team decrypt
 *      in; it must contain every KNOWN_READER (an over-narrow derivation —
 *      a getter or decrypt that stopped resolving — fails here).
 *  (d) Each clause is red-proved below by fixture sources run through the
 *      same functions.
 * iOS (Swift) is outside this gate; its refusal cells pin the same rule.
 */
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type { CallExpression, SourceFile, Symbol as MorphSymbol, Type } from "ts-morph";

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
  // Re-key (decrypt side), the v0→v1 upgrade payload, history rows re-keyed.
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

interface Tree {
  project: Project;
  /** Scanned (non-test) source files, keyed by repo-relative POSIX path. */
  files: Map<string, SourceFile>;
  /** Files whose `function` declarations with a `teamId` parameter count as team key getters. */
  getterFunctionRoots: string[];
}

interface Analysis {
  getters: Set<string>;
  helperViolations: string[];
  decryptViolations: string[];
  teamDecryptFiles: Set<string>;
  /** Modules with a decryptData call classified NOT team (its key does not flow from a getter). */
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

function isKeyMaterial(type: Type): boolean {
  const t = type.getNonNullableType();
  if (t.isUnion()) return t.getUnionTypes().some(isKeyMaterial);
  const name = t.getSymbol()?.getName();
  return name === "Uint8Array" || name === "ArrayBuffer" || carriesCryptoKey(t);
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

// ── Key flow: does this decrypt's key come from a team key getter? ─────

function isGetterCall(call: CallExpression, getters: ReadonlySet<string>): boolean {
  const name = terminalName(call.getExpression());
  if (name && getters.has(name)) return true;
  return declarationsOf(call.getExpression()).some((d) => {
    const n = declaredName(d);
    return n !== undefined && getters.has(n);
  });
}

function assignedValues(symbol: MorphSymbol, sf: SourceFile): Node[] {
  return sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)
    .filter((b) => b.getOperatorToken().getKind() === SyntaxKind.EqualsToken)
    .filter((b) => Node.isIdentifier(b.getLeft()) && b.getLeft().getSymbol()?.compilerSymbol === symbol.compilerSymbol)
    .map((b) => b.getRight());
}

/** The arguments passed for `param` at every resolvable call of its function. */
function argumentsFor(param: Node): Node[] {
  if (!Node.isParameterDeclaration(param)) return [];
  const fn = param.getParent();
  const index = (fn as Node & { getParameters?(): Node[] }).getParameters?.().indexOf(param) ?? -1;
  let nameNode: Node | undefined;
  if (Node.isFunctionDeclaration(fn)) nameNode = fn.getNameNode();
  else if ((Node.isArrowFunction(fn) || Node.isFunctionExpression(fn)) && Node.isVariableDeclaration(fn.getParent())) {
    nameNode = (fn.getParent() as Node & { getNameNode(): Node }).getNameNode();
  }
  if (!nameNode || index < 0 || !Node.isIdentifier(nameNode)) return [];
  return nameNode.findReferencesAsNodes().flatMap((ref) => {
    const call = ref.getParent();
    if (!Node.isCallExpression(call) || call.getExpression() !== ref) return [];
    const arg = call.getArguments()[index];
    return arg ? [arg] : [];
  });
}

function flowsFromGetter(expr: Node, getters: ReadonlySet<string>, seen: Set<Node>, depth = 0): boolean {
  const e = unwrap(expr);
  if (seen.has(e) || depth > 8) return false;
  seen.add(e);
  const calls = [e, ...e.getDescendants()].filter(Node.isCallExpression);
  if (calls.some((c) => isGetterCall(c, getters))) return true;
  // Only key material is followed (a CryptoKey-carrying value or raw key
  // bytes): a key derived from a team key is a team key, a key looked up BY a
  // value that merely came from team code (a user id) is not.
  const identifiers = [e, ...e.getDescendants()].filter(Node.isIdentifier).filter((id) => {
    const parent = id.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === id) return false;
    return isKeyMaterial(id.getType());
  });
  return identifiers.some((id) => {
    const symbol = id.getSymbol();
    if (!symbol) return false;
    return aliased(symbol).getDeclarations().some((d) => {
      const sources: Node[] = [];
      if (Node.isVariableDeclaration(d)) {
        const init = d.getInitializer();
        if (init) sources.push(init);
        sources.push(...assignedValues(symbol, d.getSourceFile()));
      } else if (Node.isBindingElement(d)) {
        const decl = d.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
        const init = decl?.getInitializer();
        if (init) sources.push(init);
      } else if (Node.isParameterDeclaration(d)) {
        sources.push(...argumentsFor(d));
      }
      return sources.some((s) => flowsFromGetter(s, getters, seen, depth + 1));
    });
  });
}

// ── The AAD shape of a team decrypt ────────────────────────────────────

function aadShapeViolation(call: CallExpression, builders: ReadonlySet<Node>): string | null {
  const arg = call.getArguments()[2];
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

function analyze(trees: Tree[]): Analysis {
  const getters = deriveGetters(trees);
  const helpers = new Set(findFunctionDeclarations(trees, HELPER));
  const builders = new Set(findFunctionDeclarations(trees, BUILDER));
  const decrypts = new Set(findFunctionDeclarations(trees, DECRYPT));
  if (helpers.size === 0 || builders.size === 0 || decrypts.size === 0) {
    throw new Error(`guard targets did not resolve: ${HELPER}=${helpers.size} ${BUILDER}=${builders.size} ${DECRYPT}=${decrypts.size}`);
  }
  const helperViolations: string[] = [];
  const decryptViolations: string[] = [];
  const teamDecryptFiles = new Set<string>();
  const nonTeamDecryptFiles = new Set<string>();
  const historyViewHelperSites: string[] = [];

  for (const tree of trees) {
    const relByFile = new Map([...tree.files].map(([rel, sf]) => [sf, rel] as const));
    const where = (n: Node) => `${relByFile.get(n.getSourceFile()) ?? n.getSourceFile().getFilePath()}:${n.getStartLineNumber()}`;

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

      // (b) team decrypts.
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (!callsTo(call, decrypts)) continue;
        const key = call.getArguments()[1];
        if (!key || !flowsFromGetter(key, getters, new Set())) {
          nonTeamDecryptFiles.add(rel);
          continue;
        }
        if (ALLOWED_DECRYPT_FILES.has(rel)) continue;
        if (rel === HISTORY_VIEW && enclosingFunctionName(call) === HISTORY_VIEW_FN) continue;
        teamDecryptFiles.add(rel);
        const why = aadShapeViolation(call, builders);
        if (why) decryptViolations.push(`${where(call)} ${why}`);
      }
    }

    // (a) every reference to the helper's declaration, however spelled.
    for (const helper of helpers) {
      const home = relByFile.get(helper.getSourceFile());
      if (home !== undefined && home !== HELPER_HOME) helperViolations.push(`${where(helper)} declares ${HELPER} outside ${HELPER_HOME}`);
      if (!Node.isFunctionDeclaration(helper) || !tree.project.getSourceFile(helper.getSourceFile().getFilePath())) continue;
      const nameNode = helper.getNameNodeOrThrow();
      for (const ref of nameNode.findReferencesAsNodes()) {
        if (ref === nameNode) continue;
        const rel = relByFile.get(ref.getSourceFile());
        if (rel === undefined) continue; // test files are not scanned
        if (rel === HISTORY_VIEW && Node.isCallExpression(ref.getParent())) {
          historyViewHelperSites.push(enclosingFunctionName(ref) ?? "<top level>");
        }
        if (!ALLOWED_HELPER_FILES.has(rel)) helperViolations.push(`${where(ref)} references ${HELPER}`);
        const inEncrypt = ref.getAncestors().some((a) => Node.isCallExpression(a) && terminalName(a.getExpression()) === "encryptData");
        if (inEncrypt) helperViolations.push(`${where(ref)} ${HELPER} supplies an encryptData AAD`);
      }
    }
  }
  return { getters, helperViolations, decryptViolations, teamDecryptFiles, nonTeamDecryptFiles, historyViewHelperSites };
}

// ── The repository ─────────────────────────────────────────────────────

describe("team entry AAD strictness (D67, D73)", () => {
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

  it(`(a) ${HELPER} is reached only from the upgrade paths and the history view`, () => {
    expect(result.helperViolations).toEqual([]);
  });

  it("(a) the history view uses it only to display a history row (handleView)", () => {
    expect(result.historyViewHelperSites).toEqual([HISTORY_VIEW_FN]);
  });

  it("(b) every team decrypt opens at a direct buildTeamEntryAAD (or a const bound to one)", () => {
    expect(result.decryptViolations).toEqual([]);
  });

  it("(c) the derived strict-reader set contains every known reader", () => {
    expect(result.teamDecryptFiles.size).toBeGreaterThan(0);
    for (const rel of KNOWN_READERS) expect([...result.teamDecryptFiles]).toContain(rel);
    for (const rel of [...ALLOWED_DECRYPT_FILES]) expect([...result.teamDecryptFiles]).not.toContain(rel);
  });

  it("(c) personal-entry decrypts are examined and classified non-team (not flagged)", () => {
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

// ── (d) Red proofs on fixture sources ──────────────────────────────────

const FIXTURE_BASE: Record<string, string> = {
  "src/lib/crypto/crypto-client.ts": `
    export interface CryptoKey { readonly algorithm: unknown }
    export async function decryptData(e: unknown, k: CryptoKey, aad?: Uint8Array): Promise<string> { void e; void k; void aad; return ""; }
    export async function encryptData(p: string, k: CryptoKey, aad?: Uint8Array): Promise<unknown> { void p; void k; void aad; return {}; }`,
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

/** A fixture reader (plus extra files) analysed with the same functions as the tree. */
function analyzeFixture(files: Record<string, string>): Analysis {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, baseUrl: "/", paths: { "@/*": ["src/*"] } },
  });
  const map = new Map<string, SourceFile>();
  for (const [rel, text] of Object.entries({ ...FIXTURE_BASE, ...files })) {
    map.set(rel, project.createSourceFile(`/${rel}`, text));
  }
  return analyze([{ project, files: map, getterFunctionRoots: ["extension/src/"] }]);
}

const READER = "src/fixture/reader.ts";

describe("team entry AAD strictness guard (red proofs)", () => {
  it("control: a strict reader passes and is derived as a strict reader", () => {
    const r = analyzeFixture({ [READER]: STRICT_READER });
    expect(r.helperViolations).toEqual([]);
    expect(r.decryptViolations).toEqual([]);
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
  });

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

  it("(b) an aliased builder chosen in a ternary at the decrypt site is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(
        "return decryptData({}, key, aad);",
        "return decryptData({}, key, row.aadVersion >= 1 ? b(\"t\", \"e\", \"blob\", 0) : undefined);",
      ).replace(`import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";`,
        `import { buildTeamEntryAAD, buildTeamEntryAAD as b } from "@/lib/crypto/crypto-aad";`),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/AAD is a ConditionalExpression/)]);
  });

  it("(b) an early-return wrapper choosing the AAD is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(
        `const aad = buildTeamEntryAAD("t", "e", "blob", row.itemKeyVersion);`,
        `const pick = (v: number) => { if (v < 1) return undefined; return buildTeamEntryAAD("t", "e", "blob", 0); };
         const aad = pick(row.aadVersion);`,
      ),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/AAD const is bound to CallExpression, not a direct buildTeamEntryAAD call/)]);
  });

  it("(b) element access on \"aadVersion\" choosing the AAD is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(
        `const aad = buildTeamEntryAAD("t", "e", "blob", row.itemKeyVersion);`,
        `const aad = row["aadVersion"] ? buildTeamEntryAAD("t", "e", "blob", 0) : undefined;`,
      ),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/AAD const is bound to ConditionalExpression/)]);
  });

  it("(b) a builder argument read from element access on \"aadVersion\" is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(
        `buildTeamEntryAAD("t", "e", "blob", row.itemKeyVersion)`,
        `buildTeamEntryAAD("t", "e", "blob", row["aadVersion"])`,
      ),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/the builder's arguments read aadVersion/)]);
  });

  it("(b) a hoisted conditional at the decrypt site over a const-bound builder is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace("return decryptData({}, key, aad);", "return decryptData({}, key, row.aadVersion < 1 ? undefined : aad);"),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/AAD is a ConditionalExpression/)]);
  });

  it("(b) a let binding (reassignable) is a violation", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(`const aad = buildTeamEntryAAD`, `let aad = buildTeamEntryAAD`),
    });
    expect(r.decryptViolations).toEqual([expect.stringMatching(/AAD binding is not const/)]);
  });

  it("(b) a missing AAD argument is a violation, through an aliased decrypt and an aliased getter", () => {
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

  it("(b) a team key passed through a local helper's parameter is still a team decrypt", () => {
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
    expect(r.decryptViolations).toEqual([expect.stringMatching(/AAD is a|AAD identifier is not a variable/)]);
  });

  it("(c) a decrypt that no longer resolves to a team key getter drops out of the derived reader set", () => {
    const r = analyzeFixture({
      [READER]: STRICT_READER.replace(`const { getEntryDecryptionKey } = useTeamVault();`, `const localKey = async (..._a: unknown[]) => ({ algorithm: 0 });`).replace(`await getEntryDecryptionKey(`, `await localKey(`),
    });
    expect([...r.teamDecryptFiles]).not.toContain(READER);
  });
});
