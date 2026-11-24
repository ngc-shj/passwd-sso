/**
 * "May this module specifier load module X", for gates that refuse every way a
 * file can reach a module other than a named import.
 *
 * check-crypto-domains (Check E) and check-mutation-response-read share it, so
 * a form the next review finds is closed in both. Every answer it cannot decide
 * is "may": these gates refuse on "may", so an unreadable specifier fails
 * closed.
 *
 * A specifier is decided by RESOLUTION, not by its text: the TypeScript
 * compiler's own `resolveModuleName`, with the compiler options of the nearest
 * tsconfig.json (its `paths` give `@/`), resolving from the importing file. A
 * string rule lost to `@/lib/../lib/x`, `@/lib//x`, `@/./lib/x` and a trailing
 * `/` — every spelling the resolver normalises and the rule did not.
 *
 * Targets are repo-relative FILE paths (`src/lib/url-helpers.ts`), as a
 * resolution ends. A specifier
 *   - resolving to a target names it;
 *   - resolving into node_modules, or a Node builtin, names none (a package is
 *     not repo code) — judged by where the file really is: a package linked
 *     into the repo (`file:`, a workspace) is repo code the runtime reaches by
 *     package rules, and an installed package whose package.json names a path
 *     leaving node_modules may load repo code; both may name any target;
 *   - resolving to a JSON file names none (data cannot re-export);
 *   - resolving to another repo source file the gate scans names none: that
 *     file is held to the same rule, so a re-export of a target in it is
 *     refused there;
 *   - anything else may name any target — unresolvable, outside the repo, a
 *     declaration file (the runtime loads some other file), a source file the
 *     gate does not scan (it could re-export a target unchecked), a file a
 *     sibling of the same stem shadows (TypeScript prefers `x.ts`, the bundler
 *     may load `x.js`), and every resolution where the compiler and the
 *     bundler may pick different files: a file under a package.json holding a
 *     field some resolver selects an entry by (`types` vs `main`, `exports`
 *     or `imports` conditions; the repo root's own package.json included),
 *     `moduleSuffixes`, or a `paths` pattern with fallback targets.
 *
 * A template literal with a substitution may name any module: a bundler bounds
 * it to the files under its literal head, but Node resolves the substituted
 * string itself (`pkg/${s}` and `../x/${s}` both escape with s = "../../src/…"),
 * and this gate cannot know which runs it. The tree's legitimate ones are
 * named, with reasons, in the gate's template allowlist (templateAllowlist).
 */
import { realpathSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, posix, relative, sep } from "node:path";
import { SyntaxKind, ts } from "ts-morph";
import { unwrapExpression, visibleBinding } from "./scope-bindings.mjs";

const isStringLiteral = (e) =>
  e?.getKind() === SyntaxKind.StringLiteral || e?.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral;

// Extensions a runtime resolver may pick for one stem; `x.d.ts` is not one.
const RUNTIME_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

const toPosix = (p) => p.split(sep).join("/");

// package.json fields no resolver selects a file by. Any other field may be one
// (`main`, `module`, `browser`, `types`, `typesVersions`, `exports`, `imports`,
// and whatever a bundler reads next), so a package.json holding it makes the
// files under it undecided: TypeScript may follow `types` while the bundler
// loads `main`.
const INERT_PACKAGE_FIELDS = new Set([
  "name", "version", "private", "description", "license", "author", "contributors", "repository",
  "homepage", "bugs", "keywords", "funding", "engines", "packageManager", "type", "bin", "files",
  "publishConfig", "scripts", "dependencies", "devDependencies", "peerDependencies",
  "optionalDependencies", "overrides",
]);

/** Every string in a package.json value (an `exports` map nests them under conditions). */
function stringsIn(value) {
  if (typeof value === "string") return [value];
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

/** The stem of a runtime module file name, or null for a declaration or non-module file. */
function runtimeStem(name) {
  if (/\.d\.[mc]?ts$/.test(name)) return null;
  const ext = RUNTIME_EXTENSIONS.find((x) => name.endsWith(x));
  return ext ? name.slice(0, -ext.length) : null;
}

/**
 * A resolver for specifiers written in files under `root`. `isScanned(rel)` is
 * whether the gate holds the repo file `rel` to its own rule.
 *
 * resolve(spec, fromRel) → { kind: "target-able", rel } for a scanned source
 * file, { kind: "none" } for a package, builtin or data file, { kind: "opaque",
 * why } otherwise. Memoised per (directory of the importing file, spec): a
 * resolution depends on nothing else.
 */
export function createModuleResolver({ root, isScanned }) {
  const realRoot = realpathSync(root);
  const configs = new Map(); // directory → { options, cache } | Error
  const resolutions = new Map(); // `${dir}\0${spec}` → result
  const siblings = new Map(); // directory → Map<stem, count>
  const packages = new Map(); // directory → why its package.json may redirect, or null
  const escapes = new Map(); // installed package directory → why it may load repo code, or null

  function configFor(dir) {
    if (configs.has(dir)) return configs.get(dir);
    let config;
    const file = join(dir, "tsconfig.json");
    if (existsSync(file)) {
      const raw = ts.readConfigFile(file, ts.sys.readFile);
      if (raw.error) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(raw.error.messageText, "\n")}`);
      const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, dir, undefined, file);
      const options = parsed.options;
      config = { options, cache: ts.createModuleResolutionCache(dir, (f) => f, options) };
    } else {
      const parent = dirname(dir);
      // No tsconfig.json at or above the importing file within the root: the
      // compiler options (and so `@/`) are unknown, which no answer may hide.
      if (dir === realRoot || parent === dir) throw new Error(`no tsconfig.json at or above ${dir} within ${realRoot}`);
      config = configFor(parent);
    }
    configs.set(dir, config);
    return config;
  }

  // The root's own options are required up front, so a tree without them is
  // refused when the resolver is made, not at the first specifier.
  configFor(realRoot);

  function shadowed(abs) {
    const dir = dirname(abs);
    let stems = siblings.get(dir);
    if (!stems) {
      stems = new Map();
      for (const name of readdirSync(dir)) {
        const stem = runtimeStem(name);
        if (stem !== null) stems.set(stem, (stems.get(stem) ?? 0) + 1);
      }
      siblings.set(dir, stems);
    }
    return (stems.get(runtimeStem(abs.slice(dir.length + 1))) ?? 0) > 1;
  }

  /** Why the package.json in `dir` may make a resolver pick a file TypeScript did not, or null. */
  function packageRedirect(dir) {
    if (packages.has(dir)) return packages.get(dir);
    const file = join(dir, "package.json");
    let why = null;
    if (existsSync(file)) {
      try {
        const fields = Object.keys(JSON.parse(readFileSync(file, "utf-8")));
        const field = fields.find((f) => !INERT_PACKAGE_FIELDS.has(f));
        if (field !== undefined) why = `${toPosix(relative(realRoot, file))} has "${field}"`;
      } catch {
        why = `${toPosix(relative(realRoot, file))} is unreadable`;
      }
    }
    packages.set(dir, why);
    return why;
  }

  /**
   * Why the installed package holding `abs` (a real path under node_modules)
   * may load a file outside node_modules, or null. Any field may name the
   * entry a runtime takes (`main`, an `exports` condition TypeScript skips),
   * so every path its non-inert fields can name is followed: a symlink inside
   * the package, or a `..` target, reaches repo code TypeScript never saw.
   */
  function packageEscape(abs) {
    const segments = abs.split(sep);
    const at = segments.lastIndexOf("node_modules");
    const depth = segments[at + 1]?.startsWith("@") ? 3 : 2;
    if (at + depth >= segments.length) return null; // a loose file in node_modules
    const pkgDir = segments.slice(0, at + depth).join(sep);
    if (escapes.has(pkgDir)) return escapes.get(pkgDir);
    const file = join(pkgDir, "package.json");
    let why = null;
    if (existsSync(file)) {
      const name = toPosix(relative(realRoot, file));
      try {
        const manifest = JSON.parse(readFileSync(file, "utf-8"));
        const targets = Object.entries(manifest).flatMap(([field, value]) => (INERT_PACKAGE_FIELDS.has(field) ? [] : stringsIn(value)));
        for (const target of targets) {
          // A pattern or an extensionless target loads a file under the
          // deepest directory it names that exists.
          let p = join(pkgDir, target.split("*")[0]);
          while (!existsSync(p) && p !== pkgDir) p = dirname(p);
          const real = toPosix(relative(realRoot, realpathSync(p)));
          if (!real.split("/").includes("node_modules")) {
            why = `${name} names ${JSON.stringify(target)}, which leaves node_modules`;
            break;
          }
        }
      } catch {
        why = `${name} is unreadable or names a path that cannot be followed`;
      }
    }
    escapes.set(pkgDir, why);
    return why;
  }

  // A `paths` pattern with several targets: TypeScript takes the first that
  // resolves, a bundler need not try them in that order or at all.
  function pathsFallback(spec, options) {
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      if (targets.length < 2) continue;
      const star = pattern.indexOf("*");
      const matches =
        star === -1
          ? spec === pattern
          : spec.length >= pattern.length - 1 && spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1));
      if (matches) return pattern;
    }
    return null;
  }

  function decide(spec, dir) {
    const { options, cache } = configFor(dir);
    // TypeScript tries `x.ios.ts` before `x.ts`; no runtime does.
    if ((options.moduleSuffixes ?? []).some((s) => s !== "")) return { kind: "opaque", why: "moduleSuffixes is set" };
    const fallback = pathsFallback(spec, options);
    if (fallback !== null) return { kind: "opaque", why: `paths pattern ${fallback} has several targets` };
    // The containing file need not exist; resolution reads only its directory.
    const { resolvedModule } = ts.resolveModuleName(spec, join(dir, "__from__.ts"), options, ts.sys, cache);
    if (!resolvedModule) {
      return isBuiltin(spec) ? { kind: "none" } : { kind: "opaque", why: "does not resolve" };
    }
    // Where the file really is decides, not how it was reached: a package
    // linked into the repo resolves through node_modules to repo code.
    let abs = resolvedModule.resolvedFileName;
    try {
      abs = realpathSync(abs);
    } catch {
      return { kind: "opaque", why: "resolves to no file" };
    }
    const rel = toPosix(relative(realRoot, abs));
    if (rel.startsWith("../") || rel === ".." || posix.isAbsolute(rel)) return { kind: "opaque", why: "resolves outside the repository" };
    if (rel.split("/").includes("node_modules")) {
      const why = packageEscape(abs);
      return why === null ? { kind: "none" } : { kind: "opaque", why: `resolves into a package, but ${why}` };
    }
    // Reached by package rules (exports, conditions, symlink handling) that the
    // bundler applies itself.
    if (resolvedModule.isExternalLibraryImport) return { kind: "opaque", why: `resolves to ${rel} through a package linked into the repository` };
    for (let d = dirname(abs); ; d = dirname(d)) {
      const why = packageRedirect(d);
      if (why !== null) return { kind: "opaque", why: `resolves to ${rel}, but ${why}: a runtime may pick another entry` };
      if (d === realRoot) break;
    }
    if (rel.endsWith(".json")) return { kind: "none" };
    if (runtimeStem(rel) === null) return { kind: "opaque", why: `resolves to ${rel}, which is not the module that runs` };
    if (shadowed(abs)) return { kind: "opaque", why: `resolves to ${rel}, which a same-stem sibling may shadow` };
    if (!isScanned(rel)) return { kind: "opaque", why: `resolves to ${rel}, which this gate does not scan` };
    return { kind: "file", rel };
  }

  function resolve(spec, fromRel) {
    const dir = dirname(join(realRoot, fromRel));
    const key = `${dir}\0${spec}`;
    let result = resolutions.get(key);
    if (!result) {
      result = decide(spec, dir);
      resolutions.set(key, result);
    }
    return result;
  }

  /** Whether `spec` in `fromRel` resolves to one of `targets` (for an exemption: "may" is not enough). */
  function names(spec, fromRel, targets) {
    const r = resolve(spec, fromRel);
    return r.kind === "file" && targets.includes(r.rel);
  }

  /** Whether `spec` in `fromRel` may load one of `targets` (for a refusal). */
  function mayName(spec, fromRel, targets) {
    const r = resolve(spec, fromRel);
    return r.kind === "opaque" || (r.kind === "file" && targets.includes(r.rel));
  }

  /** The scanned repo file `spec` in `fromRel` resolves to, or null. */
  function fileOf(spec, fromRel) {
    const r = resolve(spec, fromRel);
    return r.kind === "file" ? r.rel : null;
  }

  return { resolve, names, mayName, fileOf };
}

/**
 * A template-loader allowlist: `{ file, template, count, reason }` entries,
 * each naming a `import(`…`)` / `require(`…`)` argument by its exact source text
 * in one file, and how many such loads the file holds. A template is otherwise
 * refused (see the module docblock); an entry whose file holds its template a
 * different number of times is stale.
 */
export function templateAllowlist(entries) {
  const seen = new Map(entries.map((e) => [e, new Set()]));
  return {
    /** Whether the template node `node` in `rel` is an allowlisted load (and records it). */
    allows(node, rel) {
      const entry = entries.find((e) => e.file === rel && e.template === node.getText());
      if (!entry) return false;
      seen.get(entry).add(node.getStart());
      return true;
    },
    /**
     * Stale-entry messages: an entry whose file is in `scannedRels` but holds
     * its template a different number of times, and — with `whole`, when
     * `scannedRels` is the gate's whole scan — an entry whose file is not in it.
     */
    stale(scannedRels, whole) {
      const out = [];
      for (const entry of entries) {
        const n = seen.get(entry).size;
        if (!scannedRels.has(entry.file)) {
          if (whole) out.push(`${entry.file}: template loader allowlist entry names a file that is not scanned (stale)`);
        } else if (n !== entry.count) out.push(`${entry.file}: template ${entry.template} matched ${n} time(s), expected ${entry.count} (stale template loader allowlist entry)`);
      }
      return out;
    },
  };
}

/**
 * "import()", "require()", "import x = require()" or "require.context()" when
 * `node` loads a module by an argument, else null. `require.context` loads
 * every module under a directory, so it is a loader whose argument never rules
 * a target out.
 */
export function moduleLoaderOf(node) {
  if (node.getKind() === SyntaxKind.ImportEqualsDeclaration) {
    return node.getModuleReference().getKind() === SyntaxKind.ExternalModuleReference ? "import = require()" : null;
  }
  if (node.getKind() !== SyntaxKind.CallExpression) return null;
  const callee = node.getExpression();
  if (callee.getKind() === SyntaxKind.ImportKeyword) return "import()";
  if (callee.getKind() === SyntaxKind.Identifier && callee.getText() === "require") return "require()";
  if (callee.getKind() === SyntaxKind.PropertyAccessExpression && callee.getName() === "context" && callee.getExpression().getText() === "require") {
    return "require.context()";
  }
  return null;
}

/**
 * Every loader in `sf` that loads at run time, as `{ node, loader }`: a
 * type-only `import x = require()` loads nothing.
 */
export function* loaderNodes(sf) {
  for (const node of [...sf.getDescendantsOfKind(SyntaxKind.CallExpression), ...sf.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)]) {
    const loader = moduleLoaderOf(node);
    if (!loader || (node.getKind() === SyntaxKind.ImportEqualsDeclaration && node.isTypeOnly())) continue;
    yield { node, loader };
  }
}

/** The module argument of a loader node `moduleLoaderOf` named. */
export function loaderArgument(node) {
  if (node.getKind() === SyntaxKind.ImportEqualsDeclaration) return node.getModuleReference().getExpression();
  return node.getArguments()[0];
}

/**
 * Whether the module argument `arg` of a loader in `fromRel` may load any of
 * `targets`: a string is resolved, and an identifier followed to the `const`
 * string it is bound to. A template with a substitution may load any module
 * unless `templates` (a templateAllowlist) names it. A missing argument or any
 * other expression may name any module. `bindingsFor` is the memoizing thunk
 * scope-bindings' `visibleBinding` takes.
 */
export function loadArgumentMayName(arg, fromRel, targets, bindingsFor, resolver, templates) {
  const e = unwrapExpression(arg);
  if (!e) return true;
  if (isStringLiteral(e)) return resolver.mayName(e.getLiteralText(), fromRel, targets);
  if (e.getKind() === SyntaxKind.TemplateExpression) return !(templates?.allows(e, fromRel) ?? false);
  if (e.getKind() === SyntaxKind.Identifier) {
    const decl = visibleBinding(e.getText(), e, bindingsFor);
    // Only a plain `const name = "…"` holds the string itself: a destructuring
    // (`const [s] = "./x"`) binds a piece of it, which may be "." or "@".
    const init =
      decl?.getKind() === SyntaxKind.VariableDeclaration &&
      decl.getNameNode().getKind() === SyntaxKind.Identifier &&
      decl.getVariableStatement?.()?.getDeclarationKind() === "const"
        ? unwrapExpression(decl.getInitializer())
        : null;
    if (isStringLiteral(init)) return resolver.mayName(init.getLiteralText(), fromRel, targets);
  }
  return true;
}
