/**
 * Strict team entry AAD (plan team-key-prune-blob-sweep-strict-aad C5-C7,
 * issue #1012; history: team-key-rotation-rekey deviations D67-D85).
 *
 * A team entry field is sealed and opened at the team entry AAD by
 * construction: the web goes through `sealTeamEntryField` /
 * `openTeamEntryField` (src/lib/crypto/crypto-team.ts), the extension through
 * its `openTeamEntryField` twin (extension/src/lib/crypto-team.ts). The AAD
 * builder takes no defaults and the context is required. Legacy no-AAD access
 * goes through separately named entry points (`openTeamEntryFieldAt`,
 * `openLegacyTeamEntryField`, `sealLegacyTeamEntryField`) that only the
 * paths upgrading or displaying a legacy row may call.
 *
 * What this guard PROVES. Each rule resolves bindings through a ts-morph
 * Program built from the tree's tsconfig (`@/` aliases, re-exports, renamed
 * imports), not spellings:
 *  (a') Builder confinement (I5.1). `buildTeamEntryAAD` is declared only in
 *       its homes (crypto-aad.ts, the extension's crypto-team.ts) and named
 *       only in them and the web crypto-team.ts: no import / export specifier
 *       by its imported name (`as` renames count), no reference
 *       `findReferences` resolves to a declaration (renamed re-exports,
 *       `export *` namespace access), no element access spelling it. So no
 *       module outside the helpers can build a team entry AAD at all.
 *  (b') Legacy confinement (C6). `openTeamEntryFieldAt` and
 *       `openLegacyTeamEntryField` are only CALLED (never referenced as a
 *       value, re-exported or element-accessed), and only directly inside
 *       `reencryptV0`, `buildEntryRekeyPayload`, `buildEntryUpgradePayload`,
 *       `resealLegacyHistoryRow` or the history view's `handleView`;
 *       `sealLegacyTeamEntryField` only inside `resealLegacyHistoryRow`. The
 *       enclosing function is the nearest declared function or
 *       variable-bound arrow / function expression — an unbound closure (the
 *       `tryOpen(() => …)` callback) counts as its enclosing declaration — and
 *       it is matched by its declaration node, not its name.
 *  (d') A FLOOR, not a derivation: each module in KNOWN_TEAM_READERS (a hand
 *       list) still calls one of the helpers.
 * Every rule fails loudly when an import of a guarded name resolves to
 * nothing, or when a guarded declaration cannot be found.
 *
 * What is a TRIPWIRE only:
 *  (c') A scope that calls a team key source (TEAM_KEY_SOURCES) AND a raw
 *       primitive (`encryptData` / `decryptData`, web or extension) fails,
 *       outside src/lib/crypto/crypto-team.ts. The scope is a declared
 *       function, method or top-level variable-bound arrow / function
 *       expression, including every arrow and function expression nested in
 *       it (`.map` callbacks, React handlers); a nested function declaration
 *       or method is its own scope. Key sources are matched by the callee's
 *       name (the name its binding resolves to, or its spelling) — key
 *       provenance is undecidable (D80), so a function that receives a team
 *       key as a plain parameter and calls a raw primitive is NOT detected,
 *       nor is a call to `crypto.subtle` directly. Those are covered by the
 *       floor, each reader's own wrong-context cells (T8) and review.
 *       Measured on the migrated tree: no exemption (TRIPWIRE_EXEMPT empty).
 * iOS (Swift) is outside this gate; its refusal cells and AADParityTests pin
 * the same rule.
 */
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { readdirSync, statSync } from "node:fs";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type { CallExpression, Identifier, SourceFile, Symbol as MorphSymbol } from "ts-morph";

const REPO_ROOT = path.resolve(__dirname, "../..");

const BUILDER = "buildTeamEntryAAD";
const WEB_HELPERS = "src/lib/crypto/crypto-team.ts";
const EXT_HELPERS = "extension/src/lib/crypto-team.ts";
const AAD_REGISTRY = "src/lib/crypto/crypto-aad.ts";
const HISTORY_VIEW = "src/components/passwords/entry/entry-history-section.tsx";
const REKEY_PAYLOAD = "src/lib/team/rekey-payload.ts";
const ROTATION_PAYLOAD = "src/lib/team/rotation-payload.ts";

/** (a') The builder's homes, and the files that may name it. */
const BUILDER_HOMES: ReadonlySet<string> = new Set([AAD_REGISTRY, EXT_HELPERS]);
const BUILDER_ALLOWED: ReadonlySet<string> = new Set([AAD_REGISTRY, WEB_HELPERS, EXT_HELPERS]);

/** The strict and legacy entry points (d'); all declared in the web helpers but the extension twin. */
const STRICT_HELPERS = ["sealTeamEntryField", "openTeamEntryField"] as const;
const OPEN_AT = "openTeamEntryFieldAt";
const OPEN_LEGACY = "openLegacyTeamEntryField";
const SEAL_LEGACY = "sealLegacyTeamEntryField";

/** (b') C6: each legacy entry point, and the `file#function` declarations that may call it. */
const LEGACY_OPEN_CALLERS = [
  `${ROTATION_PAYLOAD}#reencryptV0`,
  `${REKEY_PAYLOAD}#buildEntryRekeyPayload`,
  `${REKEY_PAYLOAD}#buildEntryUpgradePayload`,
  `${REKEY_PAYLOAD}#resealLegacyHistoryRow`,
  `${HISTORY_VIEW}#handleView`,
];
const LEGACY_CALLERS: ReadonlyMap<string, readonly string[]> = new Map([
  [OPEN_AT, LEGACY_OPEN_CALLERS],
  [OPEN_LEGACY, LEGACY_OPEN_CALLERS],
  [SEAL_LEGACY, [`${REKEY_PAYLOAD}#resealLegacyHistoryRow`]],
]);

/**
 * (c') Team key sources, re-derived by `rg -n 'Promise<CryptoKey( \| null)?>'`
 * over src/lib/team, the crypto-team modules and the extension background,
 * plus the ItemKey / team key unwrap and derive steps.
 */
const TEAM_KEY_SOURCES: ReadonlySet<string> = new Set([
  "getEntryDecryptionKey",
  "getEntryItemKeys",
  "getItemEncryptionKey",
  "getTeamEncryptionKey",
  "getTeamEncryptionKeyForVersion",
  "resolveTeamKey",
  "requireTeamKey",
  "unwrapItemKey",
  "deriveItemEncryptionKey",
  "deriveTeamEncryptionKey",
]);
const RAW_PRIMITIVES = ["encryptData", "decryptData"] as const;
/** (c') is not applied inside the web helper module itself. */
const TRIPWIRE_EXEMPT_FILES: ReadonlySet<string> = new Set([WEB_HELPERS]);
/** (c') scopes exempted after measurement, `file#scope` → reason. Empty: the migrated tree has no hit. */
const TRIPWIRE_EXEMPT: ReadonlyMap<string, string> = new Map();

/** (d') Floor: a hand list of the known team reader / writer modules, not a derivation. */
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
  "src/lib/team/team-entry-save.ts",
  "src/components/passwords/import/password-import-importer.ts",
  "src/lib/team/rotation-payload.ts",
  "src/components/passwords/entry/entry-history-section.tsx",
];

interface Tree {
  project: Project;
  /** Scanned (non-test) source files, keyed by repo-relative POSIX path. */
  files: Map<string, SourceFile>;
}

interface Analysis {
  builderViolations: string[];
  legacyViolations: string[];
  /** (c') `file#scope` of every scope calling a team key source and a raw primitive. */
  tripwireScopes: string[];
  /** Modules with a direct call to a strict or legacy helper. */
  helperCallFiles: string[];
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

/**
 * The declarations an expression names, following import/re-export aliases
 * and `const x = <expr>` bindings (so `const d = decryptData; d()` resolves
 * to the primitive).
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

/** The name a declaration binds: a destructured `{ a: b }` binds `a` of its source. */
function declaredName(d: Node): string | undefined {
  if (Node.isBindingElement(d)) return d.getPropertyNameNode()?.getText() ?? d.getName();
  const named = d as Node & { getName?: () => string | undefined };
  return typeof named.getName === "function" ? named.getName() : undefined;
}

function isFunctionBoundary(n: Node): boolean {
  return Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n) || Node.isConstructorDeclaration(n)
    || Node.isGetAccessorDeclaration(n) || Node.isSetAccessorDeclaration(n);
}

/** The nearest declared function or variable-bound arrow / function expression; unbound closures are skipped. */
function enclosingDeclaration(node: Node): Node | undefined {
  for (let p = node.getParent(); p; p = p.getParent()) {
    if (isFunctionBoundary(p)) return p;
    if ((Node.isArrowFunction(p) || Node.isFunctionExpression(p)) && Node.isVariableDeclaration(p.getParent())) {
      return p.getParentOrThrow();
    }
  }
  return undefined;
}

/**
 * (c') The scope root of a node: the nearest declared function or method, else
 * the outermost arrow / function expression, else the source file.
 */
function scopeRoot(node: Node): Node {
  let outermostExpression: Node | undefined;
  for (let p = node.getParent(); p; p = p.getParent()) {
    if (isFunctionBoundary(p)) return p;
    if (Node.isArrowFunction(p) || Node.isFunctionExpression(p)) outermostExpression = p;
  }
  return outermostExpression ?? node.getSourceFile();
}

function scopeLabel(root: Node): string {
  if (Node.isSourceFile(root)) return "<module>";
  const owner = Node.isArrowFunction(root) || Node.isFunctionExpression(root) ? root.getParent() : root;
  const name = owner ? declaredName(owner) : undefined;
  return name ?? `<anonymous:${root.getStartLineNumber()}>`;
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

// ── The analysis ───────────────────────────────────────────────────────

function findFunctionDeclarations(trees: Tree[], name: string): Node[] {
  return trees.flatMap((t) => [...t.files.values()].flatMap((sf) => sf.getFunctions().filter((f) => f.getName() === name)));
}

/** `file#name` → the declared functions and variable-bound arrows of that name in that file. */
function findNamedDeclarations(trees: Tree[], key: string): Node[] {
  const [rel, name] = key.split("#");
  const sf = trees.map((t) => t.files.get(rel)).find((f) => f !== undefined);
  if (!sf) return [];
  return sf.getDescendants().filter((n) => {
    if (Node.isFunctionDeclaration(n)) return n.getName() === name;
    if (Node.isVariableDeclaration(n) && n.getName() === name) {
      const init = n.getInitializer();
      return init !== undefined && (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
    }
    return false;
  });
}

function analyze(trees: Tree[]): Analysis {
  const relOf = new Map<SourceFile, string>();
  for (const tree of trees) for (const [rel, sf] of tree.files) relOf.set(sf, rel);
  const relOfNode = (n: Node) => relOf.get(n.getSourceFile()) ?? n.getSourceFile().getFilePath();
  const where = (n: Node) => `${relOfNode(n)}:${n.getStartLineNumber()}`;
  const scanned = (n: Node) => relOf.has(n.getSourceFile());
  const referencesOf = (nameNode: Identifier): Node[] =>
    nameNode.findReferencesAsNodes().filter((r) => r !== nameNode && scanned(r));

  const builders = findFunctionDeclarations(trees, BUILDER);
  const legacyDecls = new Map([...LEGACY_CALLERS.keys()].map((n) => [n, findFunctionDeclarations(trees, n)]));
  const legacyCallers = new Map([...LEGACY_CALLERS].map(([n, keys]) => [n, new Set(keys.flatMap((k) => findNamedDeclarations(trees, k)))]));
  const helperDecls = new Set([...STRICT_HELPERS, OPEN_AT, OPEN_LEGACY, SEAL_LEGACY].flatMap((n) => findFunctionDeclarations(trees, n)));
  const primitives = new Set(RAW_PRIMITIVES.flatMap((n) => findFunctionDeclarations(trees, n)));
  const unresolvedCallers = [...LEGACY_CALLERS.values()].flat().filter((k) => findNamedDeclarations(trees, k).length === 0);
  if (builders.length === 0 || primitives.size === 0 || [...legacyDecls.values()].some((d) => d.length === 0) || unresolvedCallers.length > 0) {
    throw new Error(`guard targets did not resolve: ${BUILDER}=${builders.length} primitives=${primitives.size} `
      + [...legacyDecls].map(([n, d]) => `${n}=${d.length}`).join(" ")
      + (unresolvedCallers.length > 0 ? ` unresolved callers: ${unresolvedCallers.join(", ")}` : ""));
  }

  // ── (a') builder confinement; (b') legacy confinement — spellings first.
  const builderViolations: string[] = [];
  const legacyViolations: string[] = [];
  const builderSet = new Set(builders);
  const confined: { name: string; decls: ReadonlySet<Node>; out: string[]; allowedFile: (rel: string) => boolean }[] = [
    { name: BUILDER, decls: builderSet, out: builderViolations, allowedFile: (rel) => BUILDER_ALLOWED.has(rel) },
    ...[...legacyDecls].map(([name, decls]) => {
      const callerFiles = new Set([...(legacyCallers.get(name) ?? [])].map(relOfNode));
      return { name, decls: new Set(decls), out: legacyViolations, allowedFile: (rel: string) => rel === WEB_HELPERS || callerFiles.has(rel) };
    }),
  ];
  for (const tree of trees) {
    for (const [rel, sf] of tree.files) {
      for (const c of confined) {
        for (const spec of sf.getDescendantsOfKind(SyntaxKind.ImportSpecifier)) {
          // getNameNode() is the IMPORTED name (the `as` name is the alias node).
          if (spec.getNameNode().getText() !== c.name) continue;
          const symbol = spec.getSymbol();
          const resolved = symbol ? aliased(symbol).getDeclarations() : [];
          if (!resolved.some((d) => c.decls.has(d))) c.out.push(`${where(spec)} unresolved import of ${c.name}`);
          else if (!c.allowedFile(rel)) c.out.push(`${where(spec)} imports ${c.name}`);
        }
        for (const spec of sf.getDescendantsOfKind(SyntaxKind.ExportSpecifier)) {
          if (spec.getNameNode().getText() === c.name) c.out.push(`${where(spec)} re-exports ${c.name}`);
        }
        for (const ea of sf.getDescendantsOfKind(SyntaxKind.ElementAccessExpression)) {
          const arg = ea.getArgumentExpression();
          if (arg && Node.isStringLiteral(arg) && arg.getLiteralText() === c.name) c.out.push(`${where(ea)} element access to ${c.name}`);
        }
      }
    }
  }

  // (a') every reference to the builder, however spelled; a declaration outside its homes.
  for (const decl of builders) {
    if (!BUILDER_HOMES.has(relOfNode(decl))) builderViolations.push(`${where(decl)} declares ${BUILDER} outside its homes`);
    if (!Node.isFunctionDeclaration(decl)) continue;
    for (const ref of referencesOf(decl.getNameNodeOrThrow())) {
      if (isSpelled(ref)) continue;
      if (!BUILDER_ALLOWED.has(relOfNode(ref))) builderViolations.push(`${where(ref)} references ${BUILDER}`);
    }
  }

  // (b') every reference to a legacy entry point is a direct call inside an allowed declaration.
  for (const [name, decls] of legacyDecls) {
    const allowed = legacyCallers.get(name) ?? new Set<Node>();
    for (const decl of decls) {
      if (relOfNode(decl) !== WEB_HELPERS) legacyViolations.push(`${where(decl)} declares ${name} outside ${WEB_HELPERS}`);
      if (!Node.isFunctionDeclaration(decl)) continue;
      for (const ref of referencesOf(decl.getNameNodeOrThrow())) {
        if (isSpelled(ref)) continue;
        const call = directCallOf(ref);
        if (!call) {
          legacyViolations.push(`${where(ref)} ${name} is used as a value (${ref.getParentOrThrow().getKindName()}), not called`);
          continue;
        }
        const host = enclosingDeclaration(call);
        if (!host || !allowed.has(host)) {
          legacyViolations.push(`${where(call)} ${name} is called from ${host ? declaredName(host) ?? "<anonymous>" : "<top level>"}`);
        }
      }
    }
  }

  // (c') tripwire; (d') helper calls.
  const keySourceCall = (call: CallExpression): boolean => {
    const name = terminalName(call.getExpression());
    if (name !== undefined && TEAM_KEY_SOURCES.has(name)) return true;
    return declarationsOf(call.getExpression()).some((d) => TEAM_KEY_SOURCES.has(declaredName(d) ?? ""));
  };
  const callsAny = (call: CallExpression, targets: ReadonlySet<Node>) =>
    declarationsOf(call.getExpression()).some((d) => targets.has(d));
  const helperCallFiles = new Set<string>();
  const tripwire = new Map<Node, { keySource: boolean; primitive: boolean }>();
  for (const tree of trees) {
    for (const [rel, sf] of tree.files) {
      for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        if (callsAny(call, helperDecls)) helperCallFiles.add(rel);
        if (TRIPWIRE_EXEMPT_FILES.has(rel)) continue;
        const keySource = keySourceCall(call);
        const primitive = callsAny(call, primitives);
        if (!keySource && !primitive) continue;
        const root = scopeRoot(call);
        const seen = tripwire.get(root) ?? { keySource: false, primitive: false };
        tripwire.set(root, { keySource: seen.keySource || keySource, primitive: seen.primitive || primitive });
      }
    }
  }
  const tripwireScopes = [...tripwire]
    .filter(([, s]) => s.keySource && s.primitive)
    .map(([root]) => `${relOfNode(root)}#${scopeLabel(root)}`);

  return {
    builderViolations, legacyViolations,
    tripwireScopes: [...new Set(tripwireScopes)].sort(),
    helperCallFiles: [...helperCallFiles].sort(),
  };
}

/** Specifier and element-access references are reported by their spelling. */
function isSpelled(ref: Node): boolean {
  const parent = ref.getParent();
  return Node.isImportSpecifier(parent) || Node.isExportSpecifier(parent) || Node.isElementAccessExpression(parent);
}

/** (d') The known modules that no longer call a helper. */
function floorViolations(helperCallFiles: readonly string[], known: readonly string[]): string[] {
  const found = new Set(helperCallFiles);
  return known.filter((rel) => !found.has(rel)).map((rel) => `${rel} calls no team entry helper`);
}

/** (c') The measured hits minus the listed exemptions. */
function tripwireViolations(scopes: readonly string[], exempt: ReadonlyMap<string, string>): string[] {
  return scopes.filter((s) => !exempt.has(s)).map((s) => `${s} calls a team key source and a raw primitive`);
}

// ── The repository ─────────────────────────────────────────────────────

describe("team entry AAD strictness (C5-C7)", () => {
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

  it(`(a') ${BUILDER} is named only by the helper modules`, () => {
    expect(result.builderViolations).toEqual([]);
  });

  it("(b') the legacy entry points are called only from their allowed functions", () => {
    expect(result.legacyViolations).toEqual([]);
  });

  it("(c') no scope outside the helpers calls a team key source and a raw primitive", () => {
    expect(tripwireViolations(result.tripwireScopes, TRIPWIRE_EXEMPT)).toEqual([]);
  });

  it("(c') every exemption still matches a measured hit (none stale)", () => {
    expect([...TRIPWIRE_EXEMPT.keys()].filter((s) => !result.tripwireScopes.includes(s))).toEqual([]);
  });

  it("(d') floor: every known team reader / writer still calls a team entry helper", () => {
    expect(floorViolations(result.helperCallFiles, KNOWN_TEAM_READERS)).toEqual([]);
  });
});

// ── Red proofs on fixture sources ──────────────────────────────────────

const FIXTURE_BASE: Record<string, string> = {
  "src/lib/crypto/crypto-client.ts": `
    export interface CryptoKey { readonly algorithm: unknown }
    export interface EncryptedData { ciphertext: string }
    export async function decryptData(e: EncryptedData, k: CryptoKey, aad?: Uint8Array): Promise<string> { void e; void k; void aad; return ""; }
    export async function encryptData(p: string, k: CryptoKey, aad?: Uint8Array): Promise<EncryptedData> { void p; void k; void aad; return { ciphertext: "" }; }`,
  [AAD_REGISTRY]: `
    export function buildTeamEntryAAD(t: string, e: string, s: string, v: number): Uint8Array { void t; void e; void s; void v; return new Uint8Array(); }
    export function buildPersonalEntryAAD(u: string, e: string, s: string): Uint8Array { void u; void e; void s; return new Uint8Array(); }`,
  [WEB_HELPERS]: `
    import { decryptData, encryptData, type CryptoKey, type EncryptedData } from "@/lib/crypto/crypto-client";
    import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";
    export interface Ctx { teamId: string; entryId: string; vaultType: string; itemKeyVersion: number }
    const aad = (c: Ctx) => buildTeamEntryAAD(c.teamId, c.entryId, c.vaultType, c.itemKeyVersion);
    export async function sealTeamEntryField(p: string, k: CryptoKey, c: Ctx) { return encryptData(p, k, aad(c)); }
    export async function openTeamEntryField(e: EncryptedData, k: CryptoKey, c: Ctx) { return decryptData(e, k, aad(c)); }
    export async function openTeamEntryFieldAt(e: EncryptedData, k: CryptoKey, c: Ctx, v: unknown) { return v === 0 ? decryptData(e, k) : decryptData(e, k, aad(c)); }
    export async function openLegacyTeamEntryField(e: EncryptedData, k: CryptoKey) { return decryptData(e, k); }
    export async function sealLegacyTeamEntryField(p: string, k: CryptoKey) { return encryptData(p, k); }
    export async function deriveItemEncryptionKey(raw: Uint8Array): Promise<CryptoKey> { void raw; return { algorithm: null }; }`,
  "src/lib/team/team-vault-core.tsx": `
    import type { CryptoKey } from "@/lib/crypto/crypto-client";
    export function useTeamVault(): { getEntryDecryptionKey: (t: string, e: string) => Promise<CryptoKey> } { throw new Error("fixture"); }`,
  [ROTATION_PAYLOAD]: `
    import { openTeamEntryFieldAt, type Ctx } from "@/lib/crypto/crypto-team";
    import type { CryptoKey, EncryptedData } from "@/lib/crypto/crypto-client";
    export async function reencryptV0(e: EncryptedData, k: CryptoKey, c: Ctx) { return openTeamEntryFieldAt(e, k, c, 0); }`,
  [REKEY_PAYLOAD]: `
    import { openLegacyTeamEntryField, openTeamEntryFieldAt, sealLegacyTeamEntryField, type Ctx } from "@/lib/crypto/crypto-team";
    import type { CryptoKey, EncryptedData } from "@/lib/crypto/crypto-client";
    async function tryOpen(open: () => Promise<string>) { try { return await open(); } catch { return null; } }
    export async function buildEntryRekeyPayload(e: EncryptedData, k: CryptoKey, c: Ctx) { return tryOpen(() => openTeamEntryFieldAt(e, k, c, 1)); }
    export async function buildEntryUpgradePayload(e: EncryptedData, k: CryptoKey, c: Ctx) { return tryOpen(() => openTeamEntryFieldAt(e, k, c, 0)); }
    export async function resealLegacyHistoryRow(e: EncryptedData, k: CryptoKey) {
      const p = await tryOpen(() => openLegacyTeamEntryField(e, k));
      return p === null ? null : sealLegacyTeamEntryField(p, k);
    }`,
  [HISTORY_VIEW]: `
    import { openTeamEntryFieldAt } from "@/lib/crypto/crypto-team";
    import type { CryptoKey, EncryptedData } from "@/lib/crypto/crypto-client";
    export function EntryHistorySection(e: EncryptedData, k: CryptoKey) {
      const handleView = async () => openTeamEntryFieldAt(e, k, { teamId: "t", entryId: "e", vaultType: "blob", itemKeyVersion: 1 }, 1);
      return handleView;
    }`,
};

/** A reader through the strict helper: passes every rule and counts toward the floor. */
const STRICT_READER = `
  import { openTeamEntryField } from "@/lib/crypto/crypto-team";
  import { useTeamVault } from "@/lib/team/team-vault-core";
  export async function read(row: { ciphertext: string; itemKeyVersion: number }) {
    const key = await useTeamVault().getEntryDecryptionKey("t", "e");
    return openTeamEntryField(row, key, { teamId: "t", entryId: "e", vaultType: "blob", itemKeyVersion: row.itemKeyVersion });
  }`;

/** Imports for the one-line fixtures below; their code starts on line 7. */
const H = `import { decryptData, encryptData } from "@/lib/crypto/crypto-client";
import type { CryptoKey, EncryptedData } from "@/lib/crypto/crypto-client";
import { openTeamEntryField, deriveItemEncryptionKey } from "@/lib/crypto/crypto-team";
import { useTeamVault } from "@/lib/team/team-vault-core";
void decryptData; void encryptData; void openTeamEntryField; void deriveItemEncryptionKey; void useTeamVault;
export type Fixture = [CryptoKey, EncryptedData];
`;

/** A fixture tree (plus extra files) analysed with the same function as the repository. */
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

/** Rules (a')-(c') for a fixture, so each cell is one exact assertion; the floor has its own cells. */
function outcome(r: Analysis) {
  return {
    builder: r.builderViolations,
    legacy: r.legacyViolations,
    tripwire: tripwireViolations(r.tripwireScopes, new Map()),
  };
}
const CLEAN = { builder: [], legacy: [], tripwire: [] };

describe("team entry AAD strictness guard (red proofs)", () => {
  // ── Controls ──

  it("control: the fixture base alone passes every rule", () => {
    expect(outcome(analyzeFixture({}))).toEqual(CLEAN);
  });

  it("control: a reader through the strict helper passes every rule", () => {
    expect(outcome(analyzeFixture({ [READER]: STRICT_READER }))).toEqual(CLEAN);
  });

  it("(a') an unresolvable import of the builder fails loudly", () => {
    const r = analyzeFixture({
      [READER]: `import { buildTeamEntryAAD } from "@/lib/crypto/no-such-module";\nexport const f = buildTeamEntryAAD;`,
    });
    expect(outcome(r)).toEqual({ ...CLEAN, builder: [`${READER}:1 unresolved import of buildTeamEntryAAD`] });
  });

  it("(b') an unresolvable import of a legacy entry point fails loudly", () => {
    const r = analyzeFixture({
      [READER]: `import { openTeamEntryFieldAt } from "@/lib/crypto/no-such-module";\nexport const f = openTeamEntryFieldAt;`,
    });
    expect(outcome(r)).toEqual({ ...CLEAN, legacy: [`${READER}:1 unresolved import of openTeamEntryFieldAt`] });
  });

  it("an unresolvable allowed caller fails loudly (the guard throws)", () => {
    expect(() => analyzeFixture({ [ROTATION_PAYLOAD]: "export const nothing = 0;" }))
      .toThrow(`unresolved callers: ${ROTATION_PAYLOAD}#reencryptV0`);
  });

  // ── (a') builder confinement ──

  it.each([
    ["a direct import and call", {
      [READER]: `import { buildTeamEntryAAD } from "@/lib/crypto/crypto-aad";\nexport const aad = buildTeamEntryAAD("t", "e", "blob", 1);`,
    }, [`${READER}:1 imports buildTeamEntryAAD`, `${READER}:2 references buildTeamEntryAAD`]],
    ["an aliased import", {
      [READER]: `import { buildTeamEntryAAD as b } from "@/lib/crypto/crypto-aad";\nexport const aad = b("t", "e", "blob", 1);`,
    }, [`${READER}:1 imports buildTeamEntryAAD`, `${READER}:2 references buildTeamEntryAAD`]],
    ["a barrel re-export under another name", {
      "src/fixture/barrel.ts": `export { buildTeamEntryAAD as teamAad } from "@/lib/crypto/crypto-aad";`,
      [READER]: `import { teamAad } from "@/fixture/barrel";\nexport const aad = teamAad("t", "e", "blob", 1);`,
    }, ["src/fixture/barrel.ts:1 re-exports buildTeamEntryAAD", `${READER}:2 references buildTeamEntryAAD`]],
    ["namespace access through an `export *` barrel", {
      "src/fixture/barrel.ts": `export * from "@/lib/crypto/crypto-aad";`,
      [READER]: `import * as aads from "@/fixture/barrel";\nexport const aad = aads.buildTeamEntryAAD("t", "e", "blob", 1);`,
    }, [`${READER}:2 references buildTeamEntryAAD`]],
    ["element access spelling the builder", {
      [READER]: `import * as aads from "@/lib/crypto/crypto-aad";\nexport const aad = aads["buildTeamEntryAAD"]("t", "e", "blob", 1);`,
    }, [`${READER}:2 element access to buildTeamEntryAAD`]],
    ["a second declaration outside its homes", {
      [READER]: `export function buildTeamEntryAAD(): Uint8Array { return new Uint8Array(); }`,
    }, [`${READER}:1 declares buildTeamEntryAAD outside its homes`]],
  ])("(a') %s is a builder violation", (_name, files, expected) => {
    expect(outcome(analyzeFixture(files))).toEqual({ ...CLEAN, builder: expected });
  });

  it("(a') control: a personal builder import is not confined", () => {
    const r = analyzeFixture({
      [READER]: `import { buildPersonalEntryAAD } from "@/lib/crypto/crypto-aad";\nexport const aad = buildPersonalEntryAAD("u", "e", "blob");`,
    });
    expect(outcome(r)).toEqual(CLEAN);
  });

  // ── (b') legacy confinement ──

  it.each([
    ["a call from a function outside the allow-list", {
      [READER]: `import { openTeamEntryFieldAt } from "@/lib/crypto/crypto-team";\nexport async function read(k: never) { return openTeamEntryFieldAt(k, k, k, 0); }`,
    }, [`${READER}:1 imports openTeamEntryFieldAt`, `${READER}:2 openTeamEntryFieldAt is called from read`]],
    ["a call from another function of an allowed file", {
      [REKEY_PAYLOAD]: `${FIXTURE_BASE[REKEY_PAYLOAD]}
    export async function resealHistoryRow(e: EncryptedData, k: CryptoKey) { return tryOpen(() => openLegacyTeamEntryField(e, k)); }`,
    }, [`${REKEY_PAYLOAD}:11 openLegacyTeamEntryField is called from resealHistoryRow`]],
    ["the legacy sealer outside resealLegacyHistoryRow", {
      [REKEY_PAYLOAD]: `${FIXTURE_BASE[REKEY_PAYLOAD]}
    export async function buildEntryUpgradeBody(k: CryptoKey) { return sealLegacyTeamEntryField("p", k); }`,
    }, [`${REKEY_PAYLOAD}:11 sealLegacyTeamEntryField is called from buildEntryUpgradeBody`]],
    ["the legacy sealer from an allowed opener that is not resealLegacyHistoryRow", {
      [ROTATION_PAYLOAD]: `import { openTeamEntryFieldAt, sealLegacyTeamEntryField, type Ctx } from "@/lib/crypto/crypto-team";
    import type { CryptoKey, EncryptedData } from "@/lib/crypto/crypto-client";
    export async function reencryptV0(e: EncryptedData, k: CryptoKey, c: Ctx) { return sealLegacyTeamEntryField(await openTeamEntryFieldAt(e, k, c, 0), k); }`,
    }, [`${ROTATION_PAYLOAD}:1 imports sealLegacyTeamEntryField`, `${ROTATION_PAYLOAD}:3 sealLegacyTeamEntryField is called from reencryptV0`]],
    ["a same-named function in another file", {
      [READER]: `import { openTeamEntryFieldAt } from "@/lib/crypto/crypto-team";\nexport async function handleView(k: never) { return openTeamEntryFieldAt(k, k, k, 0); }`,
    }, [`${READER}:1 imports openTeamEntryFieldAt`, `${READER}:2 openTeamEntryFieldAt is called from handleView`]],
    ["the entry point passed as a value inside an allowed function", {
      [ROTATION_PAYLOAD]: `import { openTeamEntryFieldAt, type Ctx } from "@/lib/crypto/crypto-team";
    import type { CryptoKey, EncryptedData } from "@/lib/crypto/crypto-client";
    export async function reencryptV0(e: EncryptedData, k: CryptoKey, c: Ctx) { const open = openTeamEntryFieldAt; return open(e, k, c, 0); }`,
    }, [`${ROTATION_PAYLOAD}:3 openTeamEntryFieldAt is used as a value (VariableDeclaration), not called`]],
    ["a re-export", {
      "src/fixture/barrel.ts": `export { openLegacyTeamEntryField as openRow } from "@/lib/crypto/crypto-team";`,
    }, ["src/fixture/barrel.ts:1 re-exports openLegacyTeamEntryField"]],
    ["namespace access from a non-allowed function", {
      [READER]: `import * as ct from "@/lib/crypto/crypto-team";\nexport async function read(k: never) { return ct.openLegacyTeamEntryField(k, k); }`,
    }, [`${READER}:2 openLegacyTeamEntryField is called from read`]],
    ["element access spelling a legacy entry point", {
      [READER]: `import * as ct from "@/lib/crypto/crypto-team";\nexport const f = ct["openTeamEntryFieldAt"];`,
    }, [`${READER}:2 element access to openTeamEntryFieldAt`]],
    ["a top-level call", {
      [READER]: `import * as ct from "@/lib/crypto/crypto-team";\nexport const p = ct.openLegacyTeamEntryField({ ciphertext: "" }, { algorithm: null });`,
    }, [`${READER}:2 openLegacyTeamEntryField is called from <top level>`]],
    ["a second declaration outside the helper module", {
      [READER]: `export async function openLegacyTeamEntryField(): Promise<string> { return ""; }`,
    }, [`${READER}:1 declares openLegacyTeamEntryField outside ${WEB_HELPERS}`]],
  ])("(b') %s is a legacy violation", (_name, files, expected) => {
    expect(outcome(analyzeFixture(files))).toEqual({ ...CLEAN, legacy: expected });
  });

  it("(b') control: a call inside a tryOpen closure counts as its enclosing allowed function", () => {
    const r = analyzeFixture({
      [REKEY_PAYLOAD]: `${FIXTURE_BASE[REKEY_PAYLOAD]}
    export const unused = 0;`,
    });
    expect(outcome(r)).toEqual(CLEAN);
  });

  // ── (c') function-scoped tripwire ──

  it.each([
    ["a key source and decryptData in one function", `export async function r(e: EncryptedData) { const k = await useTeamVault().getEntryDecryptionKey("t", "e"); return decryptData(e, k); }`, `${READER}#r`],
    ["the key source in the outer function, decryptData in a .map callback", `export async function r(es: EncryptedData[]) { const k = await useTeamVault().getEntryDecryptionKey("t", "e"); return Promise.all(es.map((e) => decryptData(e, k))); }`, `${READER}#r`],
    ["a derived ItemKey and encryptData in a variable-bound arrow", `export const seal = async (raw: Uint8Array) => encryptData("p", await deriveItemEncryptionKey(raw));`, `${READER}#seal`],
    ["a destructured, renamed key source and a const-aliased primitive", `export async function r(e: EncryptedData) { const { getEntryDecryptionKey: g } = useTeamVault(); const open = decryptData; return open(e, await g("t", "e")); }`, `${READER}#r`],
    ["a key source and a primitive in a nested React-style handler", `export function C(e: EncryptedData) { const onClick = async () => { const k = await useTeamVault().getEntryDecryptionKey("t", "e"); return decryptData(e, k); }; return onClick; }`, `${READER}#C`],
  ])("(c') %s trips the wire", (_name, body, scope) => {
    expect(outcome(analyzeFixture({ [READER]: `${H}${body}` }))).toEqual({
      ...CLEAN,
      tripwire: [`${scope} calls a team key source and a raw primitive`],
    });
  });

  it.each([
    ["the key source and the primitive in two module functions", `async function key() { return useTeamVault().getEntryDecryptionKey("t", "e"); }\nexport async function r(e: EncryptedData, k: CryptoKey) { void key; return decryptData(e, k); }`],
    ["a nested function declaration is its own scope", `export async function r() { async function open(e: EncryptedData, k: CryptoKey) { return decryptData(e, k); } const k = await useTeamVault().getEntryDecryptionKey("t", "e"); return open({ ciphertext: "" }, k); }`],
    ["a key source with the strict helper", `export async function r(e: EncryptedData) { const k = await useTeamVault().getEntryDecryptionKey("t", "e"); return openTeamEntryField(e, k, { teamId: "t", entryId: "e", vaultType: "blob", itemKeyVersion: 1 }); }`],
  ])("(c') control: %s does not trip the wire", (_name, body) => {
    expect(outcome(analyzeFixture({ [READER]: `${H}${body}` }))).toEqual(CLEAN);
  });

  it("(c') the helper module itself is not a tripwire scope", () => {
    const r = analyzeFixture({
      [WEB_HELPERS]: `${FIXTURE_BASE[WEB_HELPERS]}
    export async function sealWithItemKey(raw: Uint8Array) { return encryptData("p", await deriveItemEncryptionKey(raw)); }`,
    });
    expect(outcome(r)).toEqual(CLEAN);
  });

  // ── (d') the floor ──

  it("(d') a known reader that calls the raw primitive instead of a helper falls below the floor", () => {
    const r = analyzeFixture({
      [READER]: `import { decryptData, type CryptoKey, type EncryptedData } from "@/lib/crypto/crypto-client";\nexport async function read(e: EncryptedData, k: CryptoKey) { return decryptData(e, k); }`,
    });
    expect(floorViolations(r.helperCallFiles, [READER])).toEqual([`${READER} calls no team entry helper`]);
  });

  it("(d') control: a known reader calling the strict helper through a namespace meets the floor", () => {
    const r = analyzeFixture({
      [READER]: `import * as ct from "@/lib/crypto/crypto-team";\nimport type { CryptoKey, EncryptedData } from "@/lib/crypto/crypto-client";\nexport async function read(e: EncryptedData, k: CryptoKey) { return ct.openTeamEntryField(e, k, { teamId: "t", entryId: "e", vaultType: "blob", itemKeyVersion: 1 }); }`,
    });
    expect(floorViolations(r.helperCallFiles, [READER])).toEqual([]);
  });
});
