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
 *   - naming an installed package, or a Node builtin, names none (a package is
 *     not repo code) — judged by every copy a runtime or the compiler could
 *     load, not by the one TypeScript picked: Node and bundlers fall through
 *     to a farther `node_modules/<pkg>` when a nearer one lacks the subpath or
 *     an entry, and the compiler likewise through `@types/<pkg>`, so every
 *     `node_modules/<pkg>` and `node_modules/@types/<pkg>` from the importing
 *     directory up to the repository root is examined (see `runtimePackage`),
 *     and so is the package the compiler's file is in. A copy linked into the
 *     repo, one that is really another package, one whose package.json names a
 *     path leaving node_modules, one the repository patches, or one its
 *     lockfile does not pin to a registry tarball may load repo code and may
 *     name any target;
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
import { realpathSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, posix, relative, sep } from "node:path";
import { SyntaxKind, ts } from "ts-morph";
import { unwrapExpression, visibleBinding } from "./scope-bindings.mjs";

const isStringLiteral = (e) =>
  e?.getKind() === SyntaxKind.StringLiteral || e?.getKind() === SyntaxKind.NoSubstitutionTemplateLiteral;

// Extensions a runtime resolver may pick for one stem; `x.d.ts` is not one.
const RUNTIME_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

const toPosix = (p) => p.split(sep).join("/");

// A repo-relative real path inside an installed package: below a node_modules
// directory within the repository (`node_modules/<pkg>` itself counts).
const insideNodeModules = (rel) =>
  !(rel.startsWith("../") || rel === ".." || posix.isAbsolute(rel)) && rel.split("/").slice(0, -1).includes("node_modules");

// A specifier a runtime looks up as a package by name: not relative, absolute,
// a package `imports` key, or a URL.
const isBareSpecifier = (spec) => !/^(\.\.?(\/|$)|\/|#|[a-zA-Z][a-zA-Z\d+.-]*:)/.test(spec);

/** `{ name, subpath }` of a bare specifier (`@scope/name/sub` or `name/sub`), or null. */
function packageOfSpecifier(spec) {
  const segments = spec.split("/");
  const length = spec.startsWith("@") ? 2 : 1;
  if (segments.length < length || segments.slice(0, length).some((s) => s === "")) return null;
  return { name: segments.slice(0, length).join("/"), subpath: segments.slice(length).join("/") };
}

// `@types/<x>` describes `<x>` (`@types/scope__name` describes `@scope/name`);
// no runtime loads the `@types` package itself.
const runtimeName = (name) =>
  name.startsWith("@types/") ? (name.includes("__") ? `@${name.slice(7).replace("__", "/")}` : name.slice(7)) : name;

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

  const insideRepo = (abs) => abs === realRoot || abs.startsWith(realRoot + sep);

  /**
   * Why the installed package `real` (a real directory inside node_modules,
   * holding `manifest`) may load a file outside node_modules, or null: every
   * path its non-inert fields can name must stay there. Any field may name the
   * entry a runtime takes (`main`, `browser`, an `exports` condition TypeScript
   * skips), so all of them are followed whatever the condition: a symlink
   * inside the package, or a `..` target, reaches repo code TypeScript never
   * saw.
   */
  function packageEscape(real, manifest) {
    const name = toPosix(relative(realRoot, join(real, "package.json")));
    const targets = Object.entries(manifest).flatMap(([field, value]) => (INERT_PACKAGE_FIELDS.has(field) ? [] : stringsIn(value)));
    for (const target of targets) {
      // A pattern or an extensionless target loads a file under the deepest
      // directory it names that exists.
      let p = join(real, target.split("*")[0]);
      while (!existsSync(p) && p !== real) p = dirname(p);
      let reached;
      try {
        reached = realpathSync(p);
      } catch {
        return `${name} names ${JSON.stringify(target)}, which cannot be followed`;
      }
      if (!insideNodeModules(toPosix(relative(realRoot, reached)))) return `${name} names ${JSON.stringify(target)}, which leaves node_modules`;
    }
    return null;
  }

  // What stays trusted, by design: the contents of a package published to a
  // registry the repository configures, installed as the lockfile pins it (a
  // registry tarball, checked against its `integrity`), and everything it
  // depends on. Neither gate reads that code, and what it loads is its
  // publisher's, not this repository's: a publisher shipping code that
  // requires `../../src/...` is a supply-chain compromise, which these gates
  // do not claim to detect. Code the repository authors into an installed
  // package is not trusted, by the facts checked here: a package the
  // postinstall `patch-package` patches (patches/<name>+<version>.patch,
  // beside the repository's root or the package's own lockfile), one whose
  // installed dependencies reach a patched package (it loads the patched
  // code), and one the lockfile records as installed from anywhere but a
  // registry tarball (`file:`, a link, git, a URL, another host, no source) —
  // a source the repository may author.
  //
  // What this cannot see — the trust boundary: a module a runtime finds
  // outside the repository (a node_modules above its root that is really
  // outside it, NODE_PATH, Node's global folders, a global install); a
  // resolution configured outside tsconfig.json and package.json (a bundler's
  // `resolve.alias` or `resolve.modules`, Turbopack's `resolveAlias`, Yarn
  // PnP, an import map, a loader hook); a registry named only in a user's or
  // global npmrc (its tarballs are refused, not trusted); and an installed
  // directory whose files differ from the tarball its lockfile entry pins
  // (edited by hand, or by a package's own install script): node_modules is
  // judged by its location, manifest and lockfile entry, not by its bytes.
  const patchDirs = new Map(); // directory → Map<package name, patch file>, or why its patches/ cannot be read
  function readPatches(dir) {
    if (!patchDirs.has(dir)) {
      const patchDir = join(dir, "patches");
      const label = toPosix(relative(realRoot, patchDir));
      let patched;
      try {
        patched = new Map();
        const files = existsSync(patchDir) ? readdirSync(patchDir, { recursive: true }).map(toPosix).filter((f) => f.endsWith(".patch")) : [];
        for (const file of files) {
          // patch-package's file name: `a+1.0.0`, `@s+a+1.0.0`, nested
          // `a+1.0.0++b+2.0.0` (b under a); every package of a chain loads
          // the patched code.
          for (const part of posix.basename(file).replace(/(\.dev)?\.patch$/, "").split("++")) {
            const segments = part.split("+").filter(Boolean);
            const name = segments[0]?.startsWith("@") ? (segments.length > 2 ? `${segments[0]}/${segments[1]}` : null) : segments.length > 1 ? segments[0] : null;
            if (name === null) throw new Error(`${label}/${file} names no package`);
            patched.set(name, `${label}/${file}`);
          }
        }
      } catch (e) {
        patched = `${label}/ cannot be read (${e instanceof Error ? e.message : String(e)})`;
      }
      patchDirs.set(dir, patched);
    }
    return patchDirs.get(dir);
  }

  /** The packages patched for the project whose lockfile is in `dir`: the root's patches/ and its own. */
  function patchesFor(dir) {
    const own = readPatches(dir);
    const root = readPatches(realRoot);
    if (typeof own === "string") return own;
    if (typeof root === "string") return root;
    return new Map([...own, ...root]);
  }

  function patchOf(name, lock) {
    const patched = typeof lock === "string" ? readPatches(realRoot) : lock.patched;
    if (typeof patched === "string") return patched;
    const file = patched.get(name);
    return file === undefined ? null : `${name} is patched by ${file}`;
  }

  /**
   * The registry URL prefixes the project in `dir` installs from: its own
   * .npmrc's `registry` (npm's default https://registry.npmjs.org/ when
   * unset) and each `@scope:registry`. A value this cannot read as a URL (an
   * environment reference) adds none and replaces the default.
   */
  function registriesOf(dir) {
    const file = join(dir, ".npmrc");
    let main = "https://registry.npmjs.org/";
    const scoped = [];
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
        const m = /^\s*(@[^:=\s]+:)?registry\s*=\s*(.*?)\s*$/.exec(line);
        if (!m) continue;
        const url = /^https?:\/\/[^\s$]+$/.test(m[2]) ? m[2].replace(/\/?$/, "/") : null;
        if (m[1]) {
          if (url !== null) scoped.push(url);
        } else main = url;
      }
    }
    return [main, ...scoped].filter((url) => url !== null);
  }

  const locks = new Map(); // directory → its governing lockfile, or why there is none
  /**
   * The package-lock.json nearest above `dir` within the repository, as
   * `{ dir, rel, packages, patched, registries, tainted }` (`tainted`:
   * lockfile key → the patched package its installed dependencies reach), or
   * why it cannot be used.
   */
  function lockFor(dir) {
    if (locks.has(dir)) return locks.get(dir);
    let lock;
    const file = join(dir, "package-lock.json");
    if (existsSync(file)) {
      const rel = toPosix(relative(realRoot, file));
      try {
        const { lockfileVersion, packages } = JSON.parse(readFileSync(file, "utf-8"));
        if (!(lockfileVersion >= 2) || packages === null || typeof packages !== "object") throw new Error("no lockfileVersion 2+ packages map");
        const patched = patchesFor(dir);
        lock = { dir, rel, packages, patched, registries: registriesOf(dir), tainted: typeof patched === "string" ? new Map() : taintedKeys(packages, patched) };
      } catch (e) {
        lock = `${rel} cannot be read (${e instanceof Error ? e.message : String(e)})`;
      }
    } else if (dir === realRoot || dirname(dir) === dir) {
      lock = `no package-lock.json at or above ${toPosix(relative(realRoot, dir)) || "."} within the repository`;
    } else {
      lock = lockFor(dirname(dir));
    }
    locks.set(dir, lock);
    return lock;
  }

  /**
   * Every lockfile key whose installed dependency closure (dependencies,
   * optional and peer dependencies, each found as Node finds it from the
   * dependent's own node_modules upward) holds a package `names` patches,
   * mapped to that package's name.
   */
  function taintedKeys(packages, names) {
    const tainted = new Map();
    const dependents = new Map(); // key → keys that depend on it
    for (const [key, entry] of Object.entries(packages)) {
      if (key === "") continue;
      const deps = { ...entry.dependencies, ...entry.optionalDependencies, ...entry.peerDependencies };
      for (const dep of Object.keys(deps)) {
        for (let base = key; ; base = base.includes("/node_modules/") ? base.slice(0, base.lastIndexOf("/node_modules/")) : "") {
          const found = base === "" ? `node_modules/${dep}` : `${base}/node_modules/${dep}`;
          if (found in packages) {
            let keys = dependents.get(found);
            if (!keys) dependents.set(found, (keys = []));
            keys.push(key);
            break;
          }
          if (base === "") break;
        }
      }
    }
    const queue = Object.keys(packages).flatMap((key) => {
      const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
      return key !== "" && names.has(name) ? [[key, name]] : [];
    });
    for (const [key, name] of queue) {
      if (tainted.has(key)) continue;
      tainted.set(key, name);
      for (const dependent of dependents.get(key) ?? []) queue.push([dependent, name]);
    }
    return tainted;
  }

  // npm's lockfile records a registry install as the tarball URL
  // `<registry>/<name>/-/<file>.tgz` beside its `integrity`.
  const TARBALL_PATH = /^(@[^/]+\/)?[^/]+\/-\/[^/]+\.tgz$/;

  /** Why `lock` does not show the installed package `real` installed from a configured registry, unpatched, or null. */
  function lockedSource(real, lock) {
    if (typeof lock === "string") return lock;
    let key = toPosix(relative(lock.dir, real));
    const dependsOn = lock.tainted.get(key);
    if (dependsOn !== undefined) return `${key} depends on patched ${dependsOn}`;
    let entry = lock.packages[key];
    // A bundled dependency ships inside its parent's tarball: the parent's
    // source is its source. One with no parent inside node_modules ships in
    // the project's own package, which the repository authors.
    while (entry?.inBundle) {
      if (!key.includes("/node_modules/")) return `${key} is bundled by the project ${lock.rel} pins, which the repository authors`;
      key = key.slice(0, key.lastIndexOf("/node_modules/"));
      entry = lock.packages[key];
    }
    if (entry === undefined) return `${key} is not in ${lock.rel}`;
    if (entry.link) return `${key} is installed from a link to ${entry.resolved}, not the registry`;
    const fromRegistry = typeof entry.resolved === "string" && lock.registries.some((r) => entry.resolved.startsWith(r) && TARBALL_PATH.test(entry.resolved.slice(r.length)));
    if (!fromRegistry || typeof entry.integrity !== "string") {
      return `${key} is installed from ${entry.resolved ?? "an unrecorded source"}${typeof entry.integrity === "string" ? "" : " with no integrity"}, not the registry`;
    }
    return null;
  }

  const judged = new Map(); // `${pkgDir}\0${name}` → why it may load repo code, or null
  /**
   * Why the installed copy `pkgDir` of the package `name` may load repo code,
   * or null. It is judged by the directory it really is: that must be inside
   * node_modules (a package linked from the repo is repo code) and be `name`
   * both by its path and by its package.json (a `node_modules/foo` that is
   * really `bar`, by a link or an npm alias, loads `bar`); its patches, entry
   * paths and lockfile entry are that directory's, and the lockfile is the one
   * governing where it is installed — the nearest package-lock.json above the
   * outermost node_modules holding it — keyed relative to that lockfile.
   */
  function installedPackage(name, pkgDir) {
    const memo = `${pkgDir}\0${name}`;
    if (!judged.has(memo)) judged.set(memo, judgeInstalled(name, pkgDir));
    return judged.get(memo);
  }

  function judgeInstalled(name, pkgDir) {
    const at = toPosix(relative(realRoot, pkgDir));
    let real;
    try {
      real = realpathSync(pkgDir);
    } catch {
      return `${at} cannot be followed`;
    }
    const relReal = toPosix(relative(realRoot, real));
    if (!insideNodeModules(relReal)) return `${at} is really ${relReal}, outside node_modules`;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(real, "package.json"), "utf-8"));
    } catch {
      manifest = null;
    }
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return `${relReal}/package.json is missing or unreadable`;
    const realName = relReal.slice(relReal.lastIndexOf("node_modules/") + "node_modules/".length);
    if (realName !== name) return `${at} is really ${relReal}, not ${name}`;
    if ((manifest.name ?? name) !== name) return `${at} is really ${JSON.stringify(manifest.name)} by its package.json, not ${name}`;
    const segments = relReal.split("/");
    const lock = lockFor(join(realRoot, ...segments.slice(0, segments.indexOf("node_modules"))));
    return patchOf(name, lock) ?? packageEscape(real, manifest) ?? lockedSource(real, lock);
  }

  // What a runtime may take for `node_modules/<name>`: Node tries it as a
  // file, then with each extension, before the directory; TypeScript tries
  // its own extensions likewise.
  const NODE_MODULES_SUFFIXES = ["", ...RUNTIME_EXTENSIONS, ".node", ".d.ts", ".d.mts", ".d.cts"];

  const candidates = new Map(); // `${dir}\0${name}` → { dirs, why }
  /**
   * Every `node_modules/<name>` a runtime or the compiler may take for an
   * importer in `dir`, in `dir` and in each directory above it — not only the
   * nearest: Node and bundlers fall through to a farther copy when a nearer
   * one lacks the subpath or an entry. `dirs` are the package directories
   * inside the repository, each to be judged. A module file there
   * (`node_modules/<name>.js`) is no package, so it is a `why`. Above the
   * repository's root a copy is outside what these gates answer for and is
   * ignored, unless it is really inside the repository, which is a `why`.
   */
  function candidatesOf(name, dir) {
    const memo = `${dir}\0${name}`;
    if (!candidates.has(memo)) {
      const dirs = [];
      let why = null;
      for (let d = dir; why === null; d = dirname(d)) {
        const inside = insideRepo(d);
        for (const suffix of existsSync(join(d, "node_modules")) ? NODE_MODULES_SUFFIXES : []) {
          const p = join(d, "node_modules", name) + suffix;
          let real;
          try {
            real = realpathSync(p);
          } catch {
            continue;
          }
          if (!inside) {
            if (insideRepo(real)) why = `${p}, above the repository, is really ${toPosix(relative(realRoot, real)) || "."} inside it`;
          } else if (suffix === "" && statSync(real).isDirectory()) dirs.push(p);
          else why = `${toPosix(relative(realRoot, p))} is a module file, not a package`;
          if (why !== null) break;
        }
        if (dirname(d) === d) break;
      }
      candidates.set(memo, { dirs, why });
    }
    return candidates.get(memo);
  }

  // `@types/<x>` describes `<x>` (`@types/scope__name` describes `@scope/name`).
  const typesName = (name) => (name.startsWith("@types/") ? null : `@types/${name.startsWith("@") ? name.slice(1).replace("/", "__") : name}`);

  /**
   * Why a package a runtime or the compiler may load for the bare specifier
   * `spec`, from `dir`, may be repo code, or null: every candidate
   * (candidatesOf) of the package and of its `@types` package must pass
   * installedPackage, whatever subpath or condition picks the file inside it.
   * `optional`: a missing package is no answer (an unprefixed builtin, which
   * the runtime provides).
   */
  function runtimePackage(spec, dir, optional) {
    const pkg = packageOfSpecifier(spec);
    if (pkg === null) return `${JSON.stringify(spec)} names no package`;
    // `pkg/../other` loads from a directory beside the candidates judged here.
    if (posix.normalize(`./${pkg.subpath}`).startsWith("../")) return `${JSON.stringify(spec)} leaves package ${pkg.name}`;
    const runtime = candidatesOf(pkg.name, dir);
    if (runtime.why !== null) return runtime.why;
    if (runtime.dirs.length === 0 && !optional) return `no package ${pkg.name} is installed where a runtime looks for it`;
    for (const pkgDir of runtime.dirs) {
      const why = installedPackage(pkg.name, pkgDir);
      if (why !== null) return why;
    }
    const types = typesName(pkg.name);
    if (types === null) return null;
    const typed = candidatesOf(types, dir);
    if (typed.why !== null) return typed.why;
    for (const pkgDir of typed.dirs) {
      const why = installedPackage(types, pkgDir);
      if (why !== null) return why;
    }
    return null;
  }

  /**
   * Why the installed package holding the compiler's file `abs` (a real path
   * under node_modules) may load repo code, or null. It must be the package
   * the runtime looks up (`@types/<x>` describes `<x>`): if the compiler took
   * another (a `paths` mapping), the two load different code.
   */
  function compilerPackage(spec, abs) {
    const segments = abs.split(sep);
    const at = segments.lastIndexOf("node_modules");
    const depth = segments[at + 1]?.startsWith("@") ? 3 : 2;
    const rel = toPosix(relative(realRoot, abs));
    if (at + depth >= segments.length) return `${rel} is in no package`;
    const name = segments.slice(at + 1, at + depth).join("/");
    if (runtimeName(name) !== packageOfSpecifier(spec)?.name) return `${rel} is in ${name}, not the package a runtime looks up`;
    return installedPackage(name, segments.slice(0, at + depth).join(sep));
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
      if (!isBuiltin(spec)) return { kind: "opaque", why: "does not resolve" };
      if (spec.startsWith("node:")) return { kind: "none" };
      // A bundler building for the browser may take an installed package of
      // a builtin's unprefixed name instead.
      const why = runtimePackage(spec, dir, true);
      return why === null ? { kind: "none" } : { kind: "opaque", why: `names a builtin, but ${why}` };
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
      if (!isBareSpecifier(spec)) return { kind: "opaque", why: `resolves to ${rel} by path, not to a package a runtime looks up by name` };
      // The runtime's package decides first: the compiler's file may be in
      // `@types/<pkg>`, which says nothing of what `<pkg>` loads.
      const why = runtimePackage(spec, dir, false) ?? compilerPackage(spec, abs);
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
