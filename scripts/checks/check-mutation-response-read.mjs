#!/usr/bin/env node
/**
 * CI guard (AST, ts-morph, no Program): client code reads a mutation's
 * response body only through `parseJsonBodyOnce`.
 *
 * ## The class (plan: close-coverage-and-clipboard-gaps, C11)
 *
 * A client mutation whose server-side write has committed (`res.ok`) was
 * reported as failed, or skipped its completion, because `await res.json()`
 * sat in the same `try` as the request and threw. For an endpoint that mints a
 * once-shown secret (an API key; a SCIM, service-account, operator or JIT
 * token; an invite or share link) the secret was lost and the user was told nothing had been created.
 * `parseJsonBodyOnce` never rejects (an unreadable body is `null`), so a site
 * that uses it cannot fail that way.
 *
 * ## What is denied
 *
 * A body read on a Response that comes from a MUTATING source call, in client
 * code (src/components, src/hooks, src/app outside src/app/api, and src/lib
 * except server modules — see "Client code under src/lib"). The body readers
 * are `json`, `text`, `blob`, `arrayBuffer`, `formData` and `bytes`; a read is
 * `res.json`, `res?.json`, `res["json"]` (likewise for each reader), `res[key]`
 * with a computed key, or destructuring a reader out of it (`const { json } =
 * res`, a `{ text }` callback parameter). The Response is followed through:
 *   - `const res = await src(...)` / `res = await src(...)`, and any `const`
 *     or assignment that copies it (`const r2 = res`), wherever the name still
 *     means that binding (scope-aware, lib/scope-bindings);
 *   - `(await src(...)).json()`, `cond ? await a : await b`, `a ?? b`, `a || b`,
 *     and `res.clone()`, which is the same response (`res.clone().json()` is a
 *     read; `parseJsonBodyOnce(res.clone())` passes it on and is not);
 *   - a promise held in a `const`, `.catch(...)` / `.finally(...)` (they pass
 *     the response through) and `.then(cb)` — `cb`'s parameter is the
 *     response, and what `cb` returns is what the `.then` call resolves to, so
 *     `.then((r) => r).then((r) => r.json())` is followed;
 *   - `Promise.all` / `allSettled` element-wise: the request's position in the
 *     literal array argument picks the element of an array-destructured or
 *     index-accessed result (`.value` of a settled record); `race` / `any`
 *     resolve to the response itself. Where the element cannot be resolved —
 *     a spread before the request, a computed index, the result array used any
 *     other way, a destructuring assignment — the site is reported (fails
 *     closed).
 *
 * A SOURCE is a direct call `fetchApi(…)`, a call of the receiver of an
 * allowlisted injection (see "fetchApi is called, never held"), or a call to a
 * RESPONSE HELPER: a function (declaration, a `const` bound to an
 * arrow/function expression or to `useCallback(fn, deps)`, or an anonymous
 * default-exported function or arrow) under src/lib or a scan root that
 * returns a source call, directly or through a local `const` it was awaited
 * into — derived to a fixpoint, not listed by hand. A helper whose returned
 * call takes the request init from one of its own parameters forwards the
 * question to its call site's argument at that position; any other helper is
 * mutating when its returned call is. A local helper resolves through the
 * file's own binding (lib/scope-bindings). An imported one (named, aliased,
 * default, or a member of a namespace import) resolves through its import
 * specifier — by TypeScript's module resolution with the tree's tsconfig
 * (lib/module-specifier), following `export { … } from`, an export clause, and
 * `export default <name>` — to the declaring module, since two
 * modules may export same-named helpers with different verdicts. When the
 * specifier does not resolve to a scanned module, every exported helper of
 * that name could be the one called, and the most conservative verdict wins.
 * A default export the module resolves to no function of its own (`export
 * default wrap(post)`) could be any of that module's helpers, and the most
 * conservative of them wins.
 *
 * ## fetchApi is called, never held (FETCH_API_VALUE_USE)
 *
 * Following fetchApi through aliases lost to a new spelling three rounds
 * running, so it is no longer followed: in every scanned file the name
 * `fetchApi` may appear only as the callee of a direct call, as an import
 * specifier importing it by its own name, in a type position (`typeof
 * fetchApi`), as a declared name or object/type key, or at an allowlisted
 * injection site (FETCH_API_INJECTIONS, keyed by file and shape, each with its
 * reason and the receiver whose calls become sources). Everything else is
 * refused: a renamed import, any re-export, an alias (`const f = fetchApi`,
 * a default, `||=`, a ternary), `.bind`/`.call`/`.apply`, an argument, an
 * object property, `x.fetchApi`, `x["fetchApi"]`, destructuring it off an
 * object, and — for its module, src/lib/url-helpers.ts — a namespace or
 * default import, `export *`, and an `import()` / `require()` /
 * `import x = require()` / `require.context()` that may load it. Whether a
 * specifier may load it is decided by resolution, not its text
 * (lib/module-specifier): `@/lib/../lib/url-helpers` and `@/lib//url-helpers`
 * resolve to it; a specifier that does not resolve, resolves outside the
 * repository, to a declaration file, to a file a same-stem sibling may shadow,
 * or to a source file this gate does not scan (src/app/api, src/i18n, …) may
 * load it; so may a non-`const` argument and any template with a substitution
 * (none is allowlisted: the tree has none in the scan roots). A stale
 * allowlist entry (site or receiver gone) is refused too.
 *
 * The error path is covered too: every body read of such a response is denied,
 * since `readApiErrorBody` reads through `parseJsonBodyOnce` as well.
 *
 * ## When a call is mutating
 *
 * Resolved from the init argument: absent, or an object literal with no
 * `method`, is GET. A `method` that is a string literal, a template without
 * substitutions, a conditional of such, or a local `const` holding one, is read;
 * GET and HEAD are safe, anything else mutates. Everything else — a spread after
 * which no `method` is written, an init the file cannot resolve to a `const`
 * object literal, a `method` that is a parameter or any other expression —
 * counts as mutating, so the gate fails closed.
 *
 * ## Control class (R49)
 *
 * A fail-closed verification gate adjudicated by the TypeScript AST, with
 * name-based helper discovery. fetchApi itself cannot be laundered: every
 * spelling that would carry it under another name is refused above. Known
 * bypasses — each needs a Program and inter-procedural value flow to decide,
 * and refusing the shape outright would deny ordinary code:
 *   - a response HELPER (not fetchApi) carried as a value: aliased (`const
 *     go = save`), wrapped (`export const send = wrap(post)`), or passed as a
 *     callback — React passes handlers as props everywhere, so this is not
 *     refused, and a call through such a value is not a source;
 *   - the request or its Response crosses a function or container boundary:
 *     passed as an argument (including a named `.then(handler)`), returned from
 *     a function that is not a derived helper (an object or class method, a
 *     `useMemo`-built function, a returned `let`), or placed in an array or
 *     object other than the literal argument of a `Promise` combinator;
 *   - a fetcher that never was fetchApi: raw `fetch` (banned in client code by
 *     eslint `CallExpression[callee.name='fetch']`, which misses
 *     `window.fetch`);
 *   - a module loaded by a runtime loader the bundler does not see
 *     (`createRequire`, `eval`) — it cannot resolve `@/…` in a browser bundle.
 *
 * ## Client code under src/lib
 *
 * "Imported only from client code" is not decidable here without a Program and
 * a full import graph, and a `"use client"` directive marks only components
 * (vault-context.tsx has one; passkey-reauth-client.ts does not, yet runs only
 * in the browser). So the rule is the sound over-approximation: every src/lib
 * module is a deny root unless it is SERVER code, recognised by a value import
 * the bundler refuses in a client bundle — `server-only`, `next/headers`, or
 * the Prisma singleton `@/lib/prisma` (it pulls in `pg`). Excluding those loses
 * nothing: `fetchApi` throws outside a browser (`typeof window === "undefined"`),
 * so a source call in a server module never yields a Response to read. A module
 * with no marker is treated as client code even if only the server imports it —
 * it fails closed. `import type` erases and does not count as a marker.
 *
 * Refuses (exit 1) an unparseable file and an empty file list, so "examined
 * nothing" never reads as "found nothing".
 *
 * Run: node scripts/checks/check-mutation-response-read.mjs
 *
 * MUTATION_RESPONSE_READ_ROOT overrides the scan root (self-test fixtures only).
 */
import { SyntaxKind } from "ts-morph";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAstProject, sourceFilesFrom } from "./lib/ast-project.mjs";
import { createModuleResolver, loadArgumentMayName, loaderArgument, loaderNodes } from "./lib/module-specifier.mjs";
import {
  FN_KINDS,
  bindingIndex,
  resolveLocalObjectLiteral,
  unwrapExpression,
  visibleBinding,
} from "./lib/scope-bindings.mjs";

const NAME = "check-mutation-response-read";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.MUTATION_RESPONSE_READ_ROOT || join(__dirname, "..", "..");

// The override exists for the self-test; left set in CI it would silently
// point the gate at another tree.
if (
  process.env.CI === "true" &&
  process.env.MUTATION_RESPONSE_READ_ROOT &&
  process.env.MUTATION_RESPONSE_READ_FIXTURE_MODE !== "1"
) {
  console.error(
    `${NAME}: MUTATION_RESPONSE_READ_ROOT must not be set in CI. ` +
      "Set MUTATION_RESPONSE_READ_FIXTURE_MODE=1 only from the self-test.",
  );
  process.exit(1);
}

const DENY_ROOTS = ["src/components", "src/hooks", "src/app", "src/lib"];
const EXCLUDED_PREFIX = "src/app/api/";
const SERVER_MARKER_PACKAGES = new Set(["server-only", "next/headers"]);
const SERVER_MARKER_FILE = "src/lib/prisma.ts";
const SAFE_METHODS = new Set(["GET", "HEAD"]);
const FUNCTION_LIKE = new Set([...FN_KINDS, SyntaxKind.FunctionDeclaration]);

/**
 * True when `sf` value-imports a module a client bundle cannot contain: a
 * marker package by its name, or any specifier that resolves to src/lib/prisma.
 */
function isServerModule(sf, rel, resolver) {
  return sf.getImportDeclarations().some((decl) => {
    if (decl.isTypeOnly()) return false;
    // A side-effect import (`import "server-only"`) binds nothing and still runs
    // the module; otherwise one value binding is enough.
    const valueBinding =
      !decl.getImportClause() ||
      decl.getDefaultImport() ||
      decl.getNamespaceImport() ||
      decl.getNamedImports().some((n) => !n.isTypeOnly());
    if (!valueBinding) return false;
    const spec = decl.getModuleSpecifierValue();
    return SERVER_MARKER_PACKAGES.has(spec) || resolver.names(spec, rel, [SERVER_MARKER_FILE]);
  });
}

let files;
let resolver;
try {
  const project = createAstProject();
  const scanned = [...sourceFilesFrom(project, DENY_ROOTS, ROOT)].filter(({ rel }) => !rel.startsWith(EXCLUDED_PREFIX));
  const scannedRels = new Set(scanned.map(({ rel }) => rel));
  // A specifier is decided by where it resolves (lib/module-specifier); a file
  // outside the scan could re-export fetchApi's module unchecked, so a
  // specifier resolving to one is undecided.
  resolver = createModuleResolver({ root: ROOT, isScanned: (rel) => scannedRels.has(rel) });
  files = scanned.map((f) => ({ ...f, deny: !(f.rel.startsWith("src/lib/") && isServerModule(f.sf, f.rel, resolver)) }));
} catch (err) {
  console.error(`${NAME}: ${err.message}`);
  process.exit(1);
}

const denyCount = files.filter((f) => f.deny).length;
if (denyCount === 0) {
  console.error(`ZERO_FILES_SCANNED: ${NAME} found no source files under ${DENY_ROOTS.join(", ")} (root ${ROOT}).`);
  process.exit(1);
}

const parseErrors = files
  .filter(({ sf }) => {
    const diagnostics = sf.compilerNode.parseDiagnostics;
    return !Array.isArray(diagnostics) || diagnostics.length > 0;
  })
  .map(({ rel }) => rel);
if (parseErrors.length > 0) {
  console.error(`PARSE_ERROR: ${NAME} could not analyse these files:`);
  for (const p of parseErrors) console.error(`  ${p}`);
  process.exit(1);
}

const relBySf = new Map(files.map(({ sf, rel }) => [sf, rel]));
const fileByRel = new Map(files.map((f) => [f.rel, f]));

const bindingCache = new Map();
function bindingsOf(sf) {
  return () => {
    let index = bindingCache.get(sf);
    if (!index) {
      index = bindingIndex(sf);
      bindingCache.set(sf, index);
    }
    return index;
  };
}

// ── Method resolution ────────────────────────────────────────────────────────

/** True when `expr` (a `method` value) may name a mutating method. */
function methodMutates(expr, sf, seen = new Set()) {
  const e = unwrapExpression(expr);
  if (!e) return true;
  switch (e.getKind()) {
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return !SAFE_METHODS.has(e.getLiteralText().toUpperCase());
    case SyntaxKind.ConditionalExpression:
      return methodMutates(e.getWhenTrue(), sf, seen) || methodMutates(e.getWhenFalse(), sf, seen);
    case SyntaxKind.Identifier: {
      const decl = visibleBinding(e.getText(), e, bindingsOf(sf));
      if (!decl || decl.getKind() !== SyntaxKind.VariableDeclaration) return true;
      if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") return true;
      if (seen.has(decl)) return true;
      seen.add(decl);
      return methodMutates(decl.getInitializer(), sf, seen);
    }
    default:
      return true;
  }
}

/** True when a request with init argument `init` may mutate. */
function initMutates(init, sf) {
  const e = unwrapExpression(init);
  if (!e) return false; // no init: GET
  let literal = null;
  if (e.getKind() === SyntaxKind.ObjectLiteralExpression) literal = e;
  else if (e.getKind() === SyntaxKind.Identifier) literal = resolveLocalObjectLiteral(e.getText(), e, bindingsOf(sf));
  if (!literal) return true;
  // The last write of `method` wins; a spread after it (or with none) may set it.
  let verdict = false;
  for (const prop of literal.getProperties()) {
    const kind = prop.getKind();
    if (kind === SyntaxKind.SpreadAssignment) {
      verdict = true;
      continue;
    }
    if (kind === SyntaxKind.PropertyAssignment) {
      const nameNode = prop.getNameNode();
      if (nameNode.getKind() === SyntaxKind.ComputedPropertyName) {
        verdict = true;
        continue;
      }
      if (prop.getName().replace(/^["']|["']$/g, "") === "method") {
        verdict = methodMutates(prop.getInitializer(), sf);
      }
      continue;
    }
    if (kind === SyntaxKind.ShorthandPropertyAssignment && prop.getName() === "method") {
      verdict = methodMutates(prop.getNameNode(), sf);
      continue;
    }
    if (prop.getName?.() === "method") verdict = true; // accessor or method
  }
  return verdict;
}

// ── Source calls and response helpers ────────────────────────────────────────

/** name → [{ sf, fn, name, exported, isDefault, forward: number | null }] */
const helpers = new Map();

// ── fetchApi is called, never held ───────────────────────────────────────────
//
// Following fetchApi through aliases, re-exports and namespaces lost to a new
// spelling every round, so it is not followed: outside the injection sites
// below, the name may only be called or imported by its own name, and every
// other spelling is refused. A source call is then always spelled `fetchApi(`
// or reaches a receiver listed here.

const isStringLiteral = (e) =>
  e?.getKind() === SyntaxKind.StringLiteral || e?.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral;

const FETCH_API = "fetchApi";
const FETCH_API_MODULE = "src/lib/url-helpers.ts";

/**
 * Where fetchApi is handed to code that takes its fetcher as a dependency.
 * `site` is the one occurrence of the name the entry permits in `file`;
 * `receiver` is where that value is called, and its calls are SOURCES. An
 * entry whose site or receiver is no longer there is refused (stale).
 */
const FETCH_API_INJECTIONS = [
  {
    file: "src/components/passwords/import/password-import-folders.ts",
    site: { kind: "parameter-default", fn: "resolveFolderPathsForImport", param: "fetcher" },
    receiver: { file: "src/components/passwords/import/password-import-folders.ts", kind: "parameter", fn: "resolveFolderPathsForImport", param: "fetcher" },
    reason: "its tests pass a fake fetcher; callers take the fetchApi default",
  },
  {
    file: "src/components/passwords/import/password-import-tags.ts",
    site: { kind: "parameter-default", fn: "resolveTagNameToIdForImport", param: "fetcher" },
    receiver: { file: "src/components/passwords/import/password-import-tags.ts", kind: "parameter", fn: "resolveTagNameToIdForImport", param: "fetcher" },
    reason: "its tests pass a fake fetcher; callers take the fetchApi default",
  },
  {
    file: "src/components/team/forms/team-attachment-section.tsx",
    site: { kind: "argument-property", callee: "uploadTeamAttachment", from: "@/lib/team/team-attachment-upload", property: "fetchApi" },
    receiver: { file: "src/lib/team/team-attachment-upload.ts", kind: "member-call", member: "fetchApi" },
    reason: "the upload flow is React-free and takes its fetcher in its deps object",
  },
  {
    file: "src/components/team/security/team-rekey-finish-control.tsx",
    site: { kind: "argument-property", callee: "runRekeyPass", from: "@/lib/team/rekey-runner", property: "fetch" },
    receiver: { file: "src/lib/team/rekey-runner.ts", kind: "member-call", member: "fetch" },
    reason: "the re-key runner is React-free and takes its fetcher in its deps object",
  },
];

/** The function a declaration or a `const` arrow/function expression names `name`, or null. */
function namedFunction(sf, name) {
  const decl = sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration).find((f) => f.getName() === name);
  if (decl) return decl;
  const v = sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration).find((d) => d.getName() === name);
  const init = unwrapExpression(v?.getInitializer());
  return init && FN_KINDS.has(init.getKind()) ? init : null;
}

const configErrors = [];
const receiverParams = new Set();
const receiverMembers = new Map(); // rel → Set<member>
for (const entry of FETCH_API_INJECTIONS) {
  const { receiver } = entry;
  const target = fileByRel.get(receiver.file);
  if (!target) continue; // refused below when its site is used
  if (receiver.kind === "parameter") {
    const param = namedFunction(target.sf, receiver.fn)?.getParameters().find((p) => p.getName() === receiver.param);
    if (param) receiverParams.add(param);
    else configErrors.push(`${receiver.file}: injection receiver ${receiver.fn}(${receiver.param}) not found (stale FETCH_API_INJECTIONS entry)`);
  } else {
    const calls = target.sf
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .filter((c) => c.getExpression().getKind() === SyntaxKind.PropertyAccessExpression && c.getExpression().getName() === receiver.member);
    if (calls.length === 0) configErrors.push(`${receiver.file}: no .${receiver.member}(…) call receives the injected fetchApi (stale FETCH_API_INJECTIONS entry)`);
    const members = receiverMembers.get(receiver.file) ?? new Set();
    members.add(receiver.member);
    receiverMembers.set(receiver.file, members);
  }
}

/**
 * A source callee: the name `fetchApi` itself (the only spelling the
 * value-use rule leaves), or a receiver of an allowlisted injection.
 */
function isFetchApiCallee(callee, sf) {
  if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
    return receiverMembers.get(relBySf.get(sf))?.has(callee.getName()) ?? false;
  }
  if (callee.getKind() !== SyntaxKind.Identifier) return false;
  if (callee.getText() === FETCH_API) return true;
  const decl = visibleBinding(callee.getText(), callee, bindingsOf(sf));
  return decl?.getKind() === SyntaxKind.Parameter && receiverParams.has(decl);
}

const NAME_KEY_KINDS = new Set([
  SyntaxKind.PropertyAssignment,
  SyntaxKind.PropertySignature,
  SyntaxKind.PropertyDeclaration,
  SyntaxKind.MethodDeclaration,
  SyntaxKind.MethodSignature,
  SyntaxKind.GetAccessor,
  SyntaxKind.SetAccessor,
  SyntaxKind.EnumMember,
  SyntaxKind.JsxAttribute,
]);
const DECLARATION_NAME_KINDS = new Set([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.VariableDeclaration,
  SyntaxKind.Parameter,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.NamespaceImport,
]);

/** The injection entry whose site `id` (a `fetchApi` reference in `rel`) is, or null. */
function injectionAt(id, rel, sf) {
  const parent = id.getParent();
  for (const entry of FETCH_API_INJECTIONS) {
    if (entry.file !== rel) continue;
    const { site } = entry;
    if (site.kind === "parameter-default") {
      if (parent.getKind() !== SyntaxKind.Parameter || parent.getInitializer() !== id || parent.getName() !== site.param) continue;
      if (namedFunction(sf, site.fn) === parent.getParent()) return entry;
      continue;
    }
    // argument-property: `{ fetchApi }` / `{ fetch: fetchApi }` in an object
    // literal passed straight to the receiver's entry point, imported from its module.
    const isShorthand = parent.getKind() === SyntaxKind.ShorthandPropertyAssignment && site.property === FETCH_API;
    const isAssigned = parent.getKind() === SyntaxKind.PropertyAssignment && parent.getInitializer() === id && parent.getName() === site.property;
    if (!isShorthand && !isAssigned) continue;
    const call = parent.getParent().getParent();
    if (call?.getKind() !== SyntaxKind.CallExpression || !call.getArguments().includes(parent.getParent())) continue;
    const callee = call.getExpression();
    if (callee.getKind() !== SyntaxKind.Identifier || callee.getText() !== site.callee) continue;
    if (visibleBinding(site.callee, callee, bindingsOf(sf))) continue;
    if (importOf(site.callee, sf)?.spec === site.from) return entry;
  }
  return null;
}

/**
 * Why the identifier `id` spelled `fetchApi` is a refused value use, or null
 * when it is permitted: a direct call, an import by its own name, a
 * declaration or key of that name, a type position, an injection site.
 */
function fetchApiValueUse(id, rel, sf, sitesUsed) {
  if (id.getFirstAncestorByKind(SyntaxKind.TypeQuery)) return null;
  const parent = id.getParent();
  const kind = parent.getKind();
  if (kind === SyntaxKind.CallExpression && parent.getExpression() === id) return null;
  if (kind === SyntaxKind.ImportSpecifier) {
    if (parent.isTypeOnly() || parent.getImportDeclaration().isTypeOnly()) return null;
    const alias = parent.getAliasNode();
    return parent.getName() === FETCH_API && (!alias || alias.getText() === FETCH_API) ? null : "renamed import";
  }
  if (kind === SyntaxKind.ExportSpecifier) return "re-export";
  if (kind === SyntaxKind.BindingElement && parent.getInitializer() !== id) {
    // `{ fetchApi } = x` and `{ fetchApi: f } = x` read it off an object;
    // `{ other: fetchApi } = x` only declares a local of that name. A default
    // (`{ f = fetchApi }`) is a value use, refused below.
    const property = parent.getPropertyNameNode();
    return property === id || (!property && parent.getNameNode() === id) ? "read off an object by destructuring" : null;
  }
  if (kind === SyntaxKind.ImportClause) return null; // `import fetchApi from "…"` declares a local
  if (DECLARATION_NAME_KINDS.has(kind) && parent.getNameNode() === id) return null;
  if (NAME_KEY_KINDS.has(kind) && parent.getNameNode() === id) return null;
  if (kind === SyntaxKind.PropertyAccessExpression && parent.getNameNode() === id) {
    const call = parent.getParent();
    const called = call?.getKind() === SyntaxKind.CallExpression && call.getExpression() === parent;
    return called && receiverMembers.get(rel)?.has(FETCH_API) ? null : "property access .fetchApi";
  }
  const entry = injectionAt(id, rel, sf);
  if (entry) {
    sitesUsed.set(entry, (sitesUsed.get(entry) ?? 0) + 1);
    return null;
  }
  if (kind === SyntaxKind.PropertyAccessExpression) return `member .${parent.getName()} of fetchApi`;
  return "held, passed or stored";
}

const valueUses = [];
const sitesUsed = new Map();
for (const { rel, sf } of files) {
  const refuse = (at, why) => valueUses.push({ rel, line: at.getStartLineNumber(), why });
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (id.getText() !== FETCH_API) continue;
    const why = fetchApiValueUse(id, rel, sf, sitesUsed);
    if (why) refuse(id, why);
  }
  // `x["fetchApi"]`, `{ ["fetchApi"]: f } = x`: the member under a string key.
  for (const lit of [...sf.getDescendantsOfKind(SyntaxKind.StringLiteral), ...sf.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral)]) {
    if (lit.getLiteralText() !== FETCH_API) continue;
    const p = lit.getParent();
    if (p.getKind() === SyntaxKind.ElementAccessExpression || p.getKind() === SyntaxKind.ComputedPropertyName) refuse(lit, "member read by a string key");
  }
  // The defining module only by named import: a namespace or default import, an
  // `export *` and a dynamic load would hand out a member under any key.
  for (const decl of sf.getImportDeclarations()) {
    if (decl.isTypeOnly() || !resolver.mayName(decl.getModuleSpecifierValue(), rel, [FETCH_API_MODULE])) continue;
    if (decl.getNamespaceImport()) refuse(decl, "namespace import of its module");
    if (decl.getDefaultImport()) refuse(decl, "default import of its module");
  }
  for (const decl of sf.getExportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    if (spec && !decl.isTypeOnly() && !decl.hasNamedExports() && resolver.mayName(spec, rel, [FETCH_API_MODULE])) refuse(decl, "export * of its module");
  }
  // No template loader is allowlisted here: the tree's one (src/i18n/messages.ts)
  // is outside this gate's scan roots.
  for (const { node, loader } of loaderNodes(sf)) {
    if (loadArgumentMayName(loaderArgument(node), rel, [FETCH_API_MODULE], bindingsOf(sf), resolver)) refuse(node, `${loader} that may load its module`);
  }
}
for (const entry of FETCH_API_INJECTIONS) {
  const n = sitesUsed.get(entry) ?? 0;
  if (n === 0 && !fileByRel.has(entry.file) && process.env.MUTATION_RESPONSE_READ_FIXTURE_MODE === "1") continue;
  if (n !== 1) {
    configErrors.push(`${entry.file}: injection site ${JSON.stringify(entry.site)} matched ${n} time(s), expected 1 (stale FETCH_API_INJECTIONS entry)`);
  } else if (!fileByRel.has(entry.receiver.file)) {
    configErrors.push(`${entry.receiver.file}: receiver of the fetchApi injected in ${entry.file} is not a scanned file (stale FETCH_API_INJECTIONS entry)`);
  }
}

/** The scanned file an import specifier resolves to, or null. */
function moduleFile(spec, fromRel) {
  const rel = resolver.fileOf(spec, fromRel);
  return rel ? fileByRel.get(rel) : null;
}

/** How the module-level name `local` is imported into `sf`: { spec, exported }, or null. */
function importOf(local, sf) {
  for (const decl of sf.getImportDeclarations()) {
    if (decl.isTypeOnly()) continue;
    const spec = decl.getModuleSpecifierValue();
    if (decl.getDefaultImport()?.getText() === local) return { spec, exported: "default" };
    const named = decl.getNamedImports().find((n) => !n.isTypeOnly() && (n.getAliasNode()?.getText() ?? n.getName()) === local);
    if (named) return { spec, exported: named.getName() };
  }
  return null;
}

/** The namespace import `local` binds in `sf` (`import * as local from spec`): its spec, or null. */
function namespaceImportOf(local, sf) {
  const decl = sf.getImportDeclarations().find((d) => !d.isTypeOnly() && d.getNamespaceImport()?.getText() === local);
  return decl ? decl.getModuleSpecifierValue() : null;
}

/**
 * The helper an import of `exported` from `spec` names: { found: true, helper }
 * when the specifier resolves to the declaring module (helper null when that
 * function is not a response helper), { found: false } when it cannot be
 * resolved. Follows `export { x as y } from "…"` and `export { x }`.
 */
function resolveExport(spec, exported, fromRel, seen = new Set()) {
  const target = moduleFile(spec, fromRel);
  if (!target) return { found: false };
  const key = `${target.rel}:${exported}`;
  if (seen.has(key)) return { found: false };
  seen.add(key);
  const own = candidatesBySf.get(target.sf) ?? [];
  const helperOf = (c) => helpers.get(c.name)?.find((h) => h.fn === c.fn) ?? null;
  const declared = own.find((c) => isExportNamed(c, exported));
  if (declared) return { found: true, helper: helperOf(declared) };
  if (exported === "default") {
    // `export default send;` names a module-level binding: a local candidate,
    // or an import followed to its own module. Any other default expression
    // (`export default wrap(post)`) could be any of the module's helpers.
    const assignment = target.sf.getExportAssignments().find((a) => !a.isExportEquals());
    if (assignment) {
      const expr = unwrapExpression(assignment.getExpression());
      if (expr?.getKind() === SyntaxKind.Identifier) {
        const decl = visibleBinding(expr.getText(), expr, bindingsOf(target.sf));
        const local = moduleCandidate(decl, own);
        if (local) return { found: true, helper: helperOf(local) };
        const imported = decl ? null : importOf(expr.getText(), target.sf);
        if (imported) return resolveExport(imported.spec, imported.exported, target.rel, seen);
      }
      return { found: true, helper: conservativeOf(own.map(helperOf).filter(Boolean)) };
    }
  }
  for (const decl of target.sf.getExportDeclarations()) {
    const el = decl.getNamedExports().find((n) => (n.getAliasNode()?.getText() ?? n.getName()) === exported);
    if (!el) continue;
    const from = decl.getModuleSpecifierValue();
    if (from) return resolveExport(from, el.getName(), target.rel, seen);
    const local = moduleCandidate(visibleBinding(el.getName(), el, bindingsOf(target.sf)), own);
    if (local) return { found: true, helper: helperOf(local) };
  }
  return { found: false };
}

/** The candidate a module-level declaration `decl` binds, or null (not a function, or no binding). */
function moduleCandidate(decl, own) {
  if (!decl) return null;
  const fn = decl.getKind() === SyntaxKind.VariableDeclaration ? hookWrapped(unwrapExpression(decl.getInitializer())) : decl;
  return own.find((c) => c.fn === fn) ?? null;
}

/** Whether a declaration is the module's export under `exported` ("default" for the default export). */
function isExportNamed(decl, exported) {
  return exported === "default" ? decl.isDefault : decl.exported && decl.name === exported;
}

/**
 * The most conservative reading of a name that could be any exported helper
 * spelled `exported`: mutating when one of them is, or when they forward
 * different arguments; null when none is a helper.
 */
function conservativeHelper(exported) {
  return conservativeOf([...helpers.values()].flat().filter((h) => isExportNamed(h, exported)));
}

/** The most conservative reading of a call that could be any helper in `bucket`. */
function conservativeOf(bucket) {
  if (bucket.length === 0) return null;
  const forward = bucket[0].forward;
  if (forward !== null && bucket.every((h) => h.forward === forward)) return bucket[0];
  return { ...bucket[0], forward: null };
}

/** The helper record a call's callee names, or null. */
function helperFor(call, sf) {
  const callee = call.getExpression();
  const rel = relBySf.get(sf);
  // `ns.send(...)` through `import * as ns from spec`.
  if (callee.getKind() === SyntaxKind.PropertyAccessExpression) {
    const ns = callee.getExpression();
    if (ns.getKind() !== SyntaxKind.Identifier || visibleBinding(ns.getText(), ns, bindingsOf(sf))) return null;
    const spec = namespaceImportOf(ns.getText(), sf);
    if (spec === null) return null;
    const resolved = resolveExport(spec, callee.getName(), rel);
    return resolved.found ? resolved.helper : conservativeHelper(callee.getName());
  }
  if (callee.getKind() !== SyntaxKind.Identifier) return null;
  const name = callee.getText();
  const local = visibleBinding(name, callee, bindingsOf(sf));
  if (local) {
    const fn = local.getKind() === SyntaxKind.VariableDeclaration ? hookWrapped(unwrapExpression(local.getInitializer())) : local;
    return helpers.get(name)?.find((h) => h.fn === fn) ?? null;
  }
  // Not bound in this file: an import, resolved through its specifier to the
  // declaring module. Two modules may export helpers of the same name, so a
  // name alone decides nothing; when the specifier cannot be resolved (a
  // module outside the scan, an `export *`, a global), every exported helper
  // of that name could be the one called, and the most conservative wins.
  const imported = importOf(name, sf);
  if (!imported) return conservativeHelper(name);
  const resolved = resolveExport(imported.spec, imported.exported, rel);
  return resolved.found ? resolved.helper : conservativeHelper(imported.exported);
}

/**
 * How `call` requests: null when it is not a source call; otherwise
 * { mutates, initIndex } where initIndex is the argument carrying the init.
 */
function sourceShape(call, sf) {
  const callee = call.getExpression();
  if (isFetchApiCallee(callee, sf)) return { helper: null, initIndex: 1 };
  const helper = helperFor(call, sf);
  if (!helper) return null;
  return { helper, initIndex: helper.forward };
}

function callMutates(call, sf) {
  const shape = sourceShape(call, sf);
  if (!shape) return false;
  if (shape.initIndex === null) return true; // a helper that mutates on its own
  return initMutates(call.getArguments()[shape.initIndex], sf);
}

function isSourceCall(node, sf) {
  return node?.getKind() === SyntaxKind.CallExpression && sourceShape(node, sf) !== null;
}

/** The function-like node `node` belongs to (null at module level). */
function enclosingFunction(node) {
  return node.getFirstAncestor((a) => FUNCTION_LIKE.has(a.getKind()) || a.getKind() === SyntaxKind.MethodDeclaration) ?? null;
}

/** Expressions `fn` returns: `return x` at its own level, or an arrow's expression body. */
function returnedExpressions(fn) {
  const body = fn.getBody?.();
  if (!body) return [];
  if (body.getKind() !== SyntaxKind.Block) return [body];
  return body
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((r) => enclosingFunction(r) === fn)
    .map((r) => r.getExpression())
    .filter(Boolean);
}

function stripAwait(expr) {
  let e = unwrapExpression(expr);
  while (e?.getKind() === SyntaxKind.AwaitExpression) e = unwrapExpression(e.getExpression());
  return e;
}

/** `useCallback(fn, deps)` names `fn`; anything else is returned as is. */
function hookWrapped(init) {
  if (init?.getKind() !== SyntaxKind.CallExpression) return init;
  const callee = init.getExpression();
  const name = callee.getKind() === SyntaxKind.PropertyAccessExpression ? callee.getName() : callee.getText();
  if (name !== "useCallback") return init;
  return unwrapExpression(init.getArguments()[0]);
}

/**
 * The source call a returned expression carries: the call itself, or the
 * awaited call a local `const` returned by name was initialised with.
 */
function returnedCall(ret, sf) {
  const e = stripAwait(ret);
  if (e?.getKind() !== SyntaxKind.Identifier) return e;
  const decl = visibleBinding(e.getText(), e, bindingsOf(sf));
  if (decl?.getKind() !== SyntaxKind.VariableDeclaration) return e;
  if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") return e;
  return stripAwait(decl.getInitializer());
}

function functionCandidates(sf) {
  const out = [];
  for (const fn of sf.getDescendantsOfKind(SyntaxKind.FunctionDeclaration)) {
    if (!fn.getBody()) continue;
    // An anonymous `export default function () {}` is reachable only as the default.
    if (fn.getName()) out.push({ name: fn.getName(), fn, exported: fn.isExported(), isDefault: fn.isDefaultExport() });
    else if (fn.isDefaultExport()) out.push({ name: "default", fn, exported: false, isDefault: true });
  }
  for (const assignment of sf.getExportAssignments()) {
    if (assignment.isExportEquals()) continue;
    const init = hookWrapped(unwrapExpression(assignment.getExpression()));
    if (init && FN_KINDS.has(init.getKind())) out.push({ name: "default", fn: init, exported: false, isDefault: true });
  }
  for (const decl of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    if (decl.getNameNode().getKind() !== SyntaxKind.Identifier) continue;
    if (decl.getVariableStatement?.()?.getDeclarationKind() !== "const") continue;
    const init = hookWrapped(unwrapExpression(decl.getInitializer()));
    if (!init || !FN_KINDS.has(init.getKind())) continue;
    out.push({ name: decl.getName(), fn: init, exported: decl.getVariableStatement()?.isExported() ?? false, isDefault: false });
  }
  return out;
}

/** The helper record `fn` earns from its returned source calls, or null. */
function classifyHelper({ name, fn, exported, isDefault }, sf) {
  let forward = null;
  let mutating = false;
  let any = false;
  for (const ret of returnedExpressions(fn)) {
    const call = returnedCall(ret, sf);
    if (!isSourceCall(call, sf)) continue;
    any = true;
    const shape = sourceShape(call, sf);
    if (shape.initIndex === null) {
      mutating = true;
      continue;
    }
    const init = unwrapExpression(call.getArguments()[shape.initIndex]);
    const params = fn.getParameters();
    const paramIndex =
      init?.getKind() === SyntaxKind.Identifier
        ? params.findIndex((p) => p.getName() === init.getText() && visibleBinding(init.getText(), init, bindingsOf(sf)) === p)
        : -1;
    if (paramIndex >= 0 && forward === null) forward = paramIndex;
    else if (paramIndex >= 0 && forward !== paramIndex) mutating = true;
    else if (initMutates(init, sf)) mutating = true;
  }
  if (!any) return null;
  if (mutating) return { sf, fn, name, exported, isDefault, forward: null };
  if (forward !== null) return { sf, fn, name, exported, isDefault, forward };
  return null; // only GET requests
}

const candidatesBySf = new Map(files.map(({ sf }) => [sf, functionCandidates(sf)]));
const candidates = [...candidatesBySf].flatMap(([sf, list]) => list.map((c) => ({ ...c, sf })));
for (let changed = true; changed; ) {
  changed = false;
  for (const c of candidates) {
    const bucket = helpers.get(c.name) ?? [];
    const existing = bucket.find((h) => h.fn === c.fn);
    const next = classifyHelper(c, c.sf);
    if (!next) continue;
    if (!existing) {
      helpers.set(c.name, [...bucket, next]);
      changed = true;
    } else if (existing.forward !== next.forward) {
      existing.forward = next.forward;
      changed = true;
    }
  }
}

// ── Response tracking ────────────────────────────────────────────────────────
//
// A tracked value has a KIND: a promise of a Response, a Response, a
// `Promise.all`/`allSettled` result (a list, awaited or not, whose element
// `index` is the response — or, settled, a `{ status, value }` record holding
// it), or such a record. Each flow below moves a value to the expression that
// now holds it, until it is read, stored, or leaves the function.

const sites = [];

const PROMISE = { t: "promise" };
const RESPONSE = { t: "response" };
const RECORD = { t: "record" };
const THEN_TRANSPARENT = new Set(["catch", "finally"]);
const BODY_READERS = new Set(["json", "text", "blob", "arrayBuffer", "formData", "bytes"]);
const PROMISE_COMBINATORS = new Set(["all", "allSettled", "race", "any"]);

const isPromiseLike = (k) => k.t === "promise" || (k.t === "list" && !k.awaited);
const awaitOf = (k) => (k.t === "promise" ? RESPONSE : k.t === "list" ? { ...k, awaited: true } : k);
const elementOf = (list) => (list.settled ? RECORD : RESPONSE);
const kindKey = (k) => (k.t === "list" ? `list:${k.awaited}:${k.settled}:${k.index}` : k.t);

/** What a `.then`/`.catch` call resolves to when its callback returns a value of kind `k`. */
function promiseOf(k) {
  if (k.t === "response" || k.t === "promise") return PROMISE;
  if (k.t === "list") return { ...k, awaited: false };
  return null;
}

/** Climb from `expr` past parentheses, type wrappers and value-forwarding operators to the expression a parent sees. */
function outermost(expr) {
  let e = expr;
  for (let p = e.getParent(); p; p = e.getParent()) {
    const k = p.getKind();
    if (k === SyntaxKind.ParenthesizedExpression || k === SyntaxKind.AsExpression || k === SyntaxKind.NonNullExpression || k === SyntaxKind.SatisfiesExpression) {
      e = p;
      continue;
    }
    // `cond ? await a : await b` holds whichever branch ran.
    if (k === SyntaxKind.ConditionalExpression && p.getCondition() !== e) {
      e = p;
      continue;
    }
    // `a ?? b`, `a || b`: either side; `a && b`: the right side.
    if (k === SyntaxKind.BinaryExpression) {
      const op = p.getOperatorToken().getKind();
      if (op === SyntaxKind.QuestionQuestionToken || op === SyntaxKind.BarBarToken || (op === SyntaxKind.AmpersandAmpersandToken && p.getRight() === e)) {
        e = p;
        continue;
      }
    }
    break;
  }
  return e;
}

/**
 * The member of `outer` its parent reads: a name for `.x`, `?.x` and `["x"]`,
 * COMPUTED for any other key that may name one, or null when there is none.
 */
const COMPUTED = Symbol("computed");
function memberRead(outer) {
  const parent = outer.getParent();
  if (parent?.getKind() === SyntaxKind.PropertyAccessExpression && parent.getExpression() === outer) {
    return parent.getName();
  }
  if (parent?.getKind() === SyntaxKind.ElementAccessExpression && parent.getExpression() === outer) {
    const key = unwrapExpression(parent.getArgumentExpression());
    if (isStringLiteral(key)) return key.getLiteralText();
    return key?.getKind() === SyntaxKind.NumericLiteral ? null : COMPUTED;
  }
  return null;
}

/** The `.then`/`.catch` call whose callback returns `outer`, or null. */
function thenCallReturning(outer) {
  const parent = outer.getParent();
  let fn = null;
  if (parent?.getKind() === SyntaxKind.ArrowFunction && parent.getBody() === outer) fn = parent;
  else if (parent?.getKind() === SyntaxKind.ReturnStatement) fn = enclosingFunction(parent);
  if (!fn || !FN_KINDS.has(fn.getKind())) return null;
  const call = outermost(fn).getParent();
  if (call?.getKind() !== SyntaxKind.CallExpression || !call.getArguments().includes(outermost(fn))) return null;
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  return callee.getName() === "then" || callee.getName() === "catch" ? call : null;
}

/** `Promise.<combinator>(...)`'s combinator name, or null. */
function combinatorOf(call) {
  if (call?.getKind() !== SyntaxKind.CallExpression) return null;
  const callee = call.getExpression();
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
  if (callee.getExpression().getText() !== "Promise" || !PROMISE_COMBINATORS.has(callee.getName())) return null;
  return callee.getName();
}

/** Identifiers that refer to the binding `name` declared by `decl` (scope-aware). */
function referencesTo(name, decl, nameNode, sf) {
  const scope = decl.getFirstAncestor((a) => a.getKind() === SyntaxKind.SourceFile || a.getKind() === SyntaxKind.Block || FUNCTION_LIKE.has(a.getKind())) ?? sf;
  return scope.getDescendantsOfKind(SyntaxKind.Identifier).filter((id) => {
    if (id.getText() !== name || id === nameNode) return false;
    const parent = id.getParent();
    // `x.name` and `{ name: v }` spell the name without referring to the binding.
    if (parent?.getKind() === SyntaxKind.PropertyAccessExpression && parent.getNameNode() === id) return false;
    if (parent?.getKind() === SyntaxKind.PropertyAssignment && parent.getNameNode() === id) return false;
    return visibleBinding(name, id, bindingsOf(sf)) === decl;
  });
}

function createTracker(origin, sf, rel) {
  const visited = new Set();

  function trackBinding(name, decl, nameNode, k) {
    const key = `${decl.getStart()}:${name}:${kindKey(k)}`;
    if (visited.has(key)) return;
    visited.add(key);
    for (const id of referencesTo(name, decl, nameNode, sf)) track(id, k);
  }

  function bindName(nameNode, decl, k) {
    switch (nameNode.getKind()) {
      case SyntaxKind.Identifier:
        trackBinding(nameNode.getText(), decl, nameNode, k);
        return;
      case SyntaxKind.ObjectBindingPattern:
        destructureObject(nameNode, decl, k);
        return;
      case SyntaxKind.ArrayBindingPattern:
        destructureArray(nameNode, decl, k);
        return;
    }
  }

  function destructureObject(pattern, decl, k) {
    if (k.t !== "response" && k.t !== "record") return;
    const wanted = k.t === "response" ? BODY_READERS : new Set(["value"]);
    for (const el of pattern.getElements()) {
      // A rest element copies own properties only; the body readers live on the prototype.
      if (el.getDotDotDotToken()) {
        if (k.t === "record") bindName(el.getNameNode(), decl, k);
        continue;
      }
      const prop = el.getPropertyNameNode();
      if (prop?.getKind() === SyntaxKind.ComputedPropertyName) {
        const key = unwrapExpression(prop.getExpression());
        if (!isStringLiteral(key)) {
          report(el, "unresolvable destructuring of");
          continue;
        }
        if (!wanted.has(key.getLiteralText())) continue;
      } else if (!wanted.has(prop ? prop.getText().replace(/^["']|["']$/g, "") : el.getName())) {
        continue;
      }
      if (k.t === "response") report(el);
      else bindName(el.getNameNode(), decl, RESPONSE);
    }
  }

  function destructureArray(pattern, decl, k) {
    if (k.t !== "list" || !k.awaited) return;
    const elements = pattern.getElements();
    for (let j = 0; j < elements.length && j <= k.index; j++) {
      const el = elements[j];
      if (el.getKind() !== SyntaxKind.BindingElement) continue; // a hole
      if (el.getDotDotDotToken()) {
        bindName(el.getNameNode(), decl, { ...k, index: k.index - j });
        return;
      }
      if (j === k.index) bindName(el.getNameNode(), decl, elementOf(k));
    }
  }

  /** `outer` is stored: `const x = e`, `const { a } = e`, `x = e`. True when handled. */
  function store(outer, k) {
    const parent = outer.getParent();
    if (parent?.getKind() === SyntaxKind.VariableDeclaration && parent.getInitializer() === outer) {
      bindName(parent.getNameNode(), parent, k);
      return true;
    }
    if (parent?.getKind() === SyntaxKind.BinaryExpression && parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken && parent.getRight() === outer) {
      const left = unwrapExpression(parent.getLeft());
      if (left.getKind() === SyntaxKind.Identifier) {
        const decl = visibleBinding(left.getText(), left, bindingsOf(sf));
        if (decl) {
          const nameNode = decl.getNameNode().getKind() === SyntaxKind.Identifier
            ? decl.getNameNode()
            : decl.getNameNode().getDescendantsOfKind(SyntaxKind.BindingElement).find((el) => el.getName() === left.getText())?.getNameNode();
          trackBinding(left.getText(), decl, nameNode, k);
        }
      } else {
        report(parent, "unresolvable destructuring of"); // `({ json } = res)`, `[a, b] = await Promise.all(...)`
      }
      return true;
    }
    return false;
  }

  /** `e` is an expression whose value has kind `k`. */
  function track(e, k) {
    const outer = outermost(e);
    const parent = outer.getParent();

    if (k.t === "response") {
      const member = memberRead(outer);
      if (member === COMPUTED || BODY_READERS.has(member)) {
        report(e);
        return;
      }
      // `res.clone()` is the same response: reading the copy consumes nothing
      // else, and a committed mutation fails the same way.
      const call = member === "clone" ? parent.getParent() : null;
      if (call?.getKind() === SyntaxKind.CallExpression && call.getExpression() === parent) {
        track(call, RESPONSE);
        return;
      }
    }

    if (parent?.getKind() === SyntaxKind.AwaitExpression) {
      track(parent, awaitOf(k));
      return;
    }

    if (isPromiseLike(k) && parent?.getKind() === SyntaxKind.PropertyAccessExpression && parent.getExpression() === outer) {
      const call = parent.getParent();
      if (call?.getKind() !== SyntaxKind.CallExpression || call.getExpression() !== parent) return;
      if (THEN_TRANSPARENT.has(parent.getName())) {
        track(call, k); // `.catch`/`.finally` pass the response through
        return;
      }
      if (parent.getName() !== "then") return;
      const cb = unwrapExpression(call.getArguments()[0]);
      if (!cb || cb.getText() === "undefined" || cb.getKind() === SyntaxKind.NullKeyword) {
        track(call, k);
        return;
      }
      if (!FN_KINDS.has(cb.getKind())) return; // a named handler: crosses a function boundary
      const param = cb.getParameters()[0];
      if (param) bindName(param.getNameNode(), param, awaitOf(k));
      return; // what the callback returns is followed from the returned expression
    }

    if (k.t === "record" && parent?.getKind() === SyntaxKind.PropertyAccessExpression && parent.getExpression() === outer && parent.getName() === "value") {
      track(parent, RESPONSE);
      return;
    }

    if (k.t === "list" && k.awaited && parent?.getKind() === SyntaxKind.ElementAccessExpression && parent.getExpression() === outer) {
      const index = unwrapExpression(parent.getArgumentExpression());
      if (index?.getKind() !== SyntaxKind.NumericLiteral) report(parent, "unresolvable element of");
      else if (Number(index.getLiteralText()) === k.index) track(parent, elementOf(k));
      return;
    }

    const thenCall = thenCallReturning(outer);
    if (thenCall) {
      const next = promiseOf(k);
      if (next) track(thenCall, next);
      return;
    }

    if ((k.t === "promise" || k.t === "response") && parent?.getKind() === SyntaxKind.ArrayLiteralExpression) {
      const list = outermost(parent);
      const call = list.getParent();
      const combinator = combinatorOf(call);
      if (!combinator || call.getArguments()[0] !== list) return; // a container: crosses the boundary
      if (combinator === "race" || combinator === "any") {
        track(call, PROMISE);
        return;
      }
      const elements = parent.getElements();
      const index = elements.indexOf(outer);
      if (elements.slice(0, index).some((el) => el.getKind() === SyntaxKind.SpreadElement)) {
        report(outer, "unresolvable position in Promise." + combinator + " of");
        return;
      }
      track(call, { t: "list", awaited: false, settled: combinator === "allSettled", index });
      return;
    }

    if (store(outer, k)) return;

    // An awaited Promise.all result used any other way (`.map`, a spread, an
    // argument) cannot be followed element-wise.
    if (k.t === "list" && k.awaited) {
      const access = parent?.getKind() === SyntaxKind.PropertyAccessExpression && parent.getExpression() === outer;
      if (!(access && parent.getName() === "length")) report(outer, "unresolvable use of");
    }
  }

  function report(at, what = "body read on") {
    sites.push({ rel, line: at.getStartLineNumber(), what, origin: `${origin.getExpression().getText()}(…) line ${origin.getStartLineNumber()}` });
  }

  return track;
}

for (const { rel, sf, deny } of files) {
  if (!deny) continue;
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (!callMutates(call, sf)) continue;
    createTracker(call, sf, rel)(call, PROMISE);
  }
}

// One row per read; a read reached from two requests (`c ? await a : await b`) names both.
const reads = new Map();
for (const s of sites) {
  const key = `${s.rel}:${s.line}`;
  const row = reads.get(key) ?? { rel: s.rel, line: s.line, what: s.what, origins: [] };
  if (!row.origins.includes(s.origin)) row.origins.push(s.origin);
  reads.set(key, row);
}
const unique = [...reads.values()].sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);

let failed = false;
if (configErrors.length > 0) {
  failed = true;
  console.error(`FETCH_API_INJECTION_STALE: ${NAME} allowlist entries that no longer match the tree:`);
  for (const e of configErrors) console.error(`  ${e}`);
}
if (valueUses.length > 0) {
  failed = true;
  valueUses.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line);
  console.error(`FETCH_API_VALUE_USE: ${valueUses.length} use(s) of fetchApi other than a direct call or an import by its own name:`);
  for (const u of valueUses) console.error(`  ${u.rel}:${u.line}  fetchApi used as a value (${u.why})`);
  console.error(
    "\nCall fetchApi directly. A module that must take its fetcher as a dependency is an injection site: " +
      "add it to FETCH_API_INJECTIONS with its receiver, so the receiver's calls stay checked.",
  );
}
if (unique.length > 0) {
  failed = true;
  console.error(`MUTATION_RESPONSE_JSON_READ: ${unique.length} read(s) of a mutation response body outside parseJsonBodyOnce:`);
  for (const s of unique) console.error(`  ${s.rel}:${s.line}  ${s.what} the response of ${s.origins.join(" / ")}`);
  console.error(
    "\nA mutation that committed must not be reported as failed because its body could not be read. " +
      "Run the completion (refresh, onSuccess, reset) right after res.ok, then read the body with " +
      "`await parseJsonBodyOnce(res)` (src/lib/http/read-api-error-body.ts) and handle `null`.",
  );
}
if (failed) process.exit(1);

const helperCount = [...helpers.values()].reduce((n, b) => n + b.length, 0);
console.log(`${NAME}: OK (${denyCount} files, ${helperCount} response helper(s))`);
