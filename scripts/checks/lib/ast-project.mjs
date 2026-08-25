/**
 * Shared ts-morph project setup for AST-based CI gates.
 *
 * Every code-classification gate needs the same three things: an in-memory
 * ts-morph Project (no Program — runs without type resolution, per
 * project_ast_guard_tsmorph_no_program), a recursive walk of a source tree that
 * excludes test files, and a source-file per path. Duplicating that boilerplate
 * across gates drifted (one copy excluded only `.test.ts`, not `.test.tsx`,
 * silently including a test tree). This module is the single source of truth.
 *
 * Adopters (re-derive with `grep -l ast-project ../*.mjs` rather than trusting
 * this list to be current): check-critical-audit-atomic, check-session-token-hashed,
 * check-bound-unknown-ip (createAstProject + sourceFiles),
 * check-null-tenant-fail-closed (createAstProject + sourceFilesFrom — its scan
 * set mixes directories with a single-file target `src/auth.ts`, which
 * sourceFilesFrom handles), check-boot-diagnostic-shape, check-cli-shell-safety,
 * check-operator-echo-escaped, check-runtime-image-assets,
 * check-tenant-claim-event-coverage.
 *
 * Partial adopter — createAstProject only, walk NOT migrated:
 *   - check-bypass-rls keeps its own `getSourceFiles()`. The only behavioural
 *     difference is the missing-root case: walkSourceFiles returns `[]`, while
 *     that gate needs readdirSync's throw, because an empty file list there
 *     would otherwise read as "no violations". (It now also refuses a
 *     present-but-empty root explicitly, which no walker can decide for it.)
 *     The exclusion predicates differ in form — `includes(".test.")` /
 *     `includes("__tests__")` there versus the suffix and directory tests here
 *     — but not in effect: over all 2066 files under src/ the two select the
 *     same 1011, and `isScannableSourceFile` already excludes
 *     src/lib/tenant-rls.test.ts. Migrating the walk would be safe on today's
 *     tree and is declined only for the missing-root behaviour.
 *
 * Deliberately NOT adopted (scan intent / Project config genuinely differs —
 * migrating would change behavior, not just shape):
 *   - classify-fail-closed-test: intentionally scans TEST files; walkSourceFiles
 *     excludes them.
 *   - check-dynamic-import-specifiers: Project is tsConfig-based (type-resolving),
 *     not an in-memory no-Program project.
 *   - check-destructive-wrapper-derivation: Project omits compilerOptions on
 *     purpose; adding jsx:ReactJSX would change how its .tsx inputs parse.
 */
import { Project, ts } from "ts-morph";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";

/**
 * True for a source file we scan (.ts/.tsx, excluding test files).
 *
 * `.spec.` is listed alongside `.test.` for the reason the module docblock
 * gives: the drift this file exists to stop was one copy excluding `.test.ts`
 * but not `.test.tsx`. A copy excluding `.test.` but not `.spec.` is the same
 * shape. No `.spec.ts` exists under any current scan root, so this changes no
 * gate's selection today — it removes a way for them to disagree tomorrow.
 */
function isScannableSourceFile(name) {
  const ext = extname(name);
  if (ext !== ".ts" && ext !== ".tsx") return false;
  return !/\.(test|spec)\.(ts|tsx)$/.test(name);
}

/** A fresh in-memory ts-morph project (no Program / no dependency resolution). */
export function createAstProject() {
  return new Project({
    useInMemoryFileSystem: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true, jsx: ts.JsxEmit.ReactJSX },
  });
}

/**
 * Recursively collect .ts/.tsx source files under `dir`, EXCLUDING test files
 * (`*.test.*`, `*.spec.*`) and anything under a `__tests__` directory.
 *
 * Missing directories yield an empty list. A SYMLINK throws — see below; that is
 * the one input this walker refuses rather than guessing about.
 */
export function walkSourceFiles(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    // A Dirent reports a symlink as NEITHER directory nor file, so a symlinked
    // directory used to fall past both branches and its whole subtree went
    // unscanned with no signal — a gate examining less than it claims reports
    // the same green as one that found nothing.
    //
    // Refuse rather than follow. Following looked like the fix and is worse:
    // both exclusions below key on the ENTRY name, so `ln -s ./__tests__ x`
    // and `ln -s ./a.test.ts b.ts` walk straight through them — reopening, for
    // every gate that uses this module, the exact hole the manifest scan was
    // being fixed for. It also removes the walk's boundary: a link to
    // node_modules took one probe from 0 to 14,019 files, and a gate printed
    // the source of a file outside the repository into a CI log under an
    // in-repo path that does not exist.
    //
    // No tracked symlink exists in this repo (`git ls-files -s | awk
    // '$1=="120000"'` is empty), so this costs nothing today. If one is ever
    // added under a scan root, that is a decision about what "shipped source"
    // means, and it should be made deliberately — not resolved by whichever
    // behaviour this walker happens to have.
    if (e.isSymbolicLink()) {
      throw new Error(
        `walkSourceFiles: refusing to decide about a symlink: ${full}\n` +
          `  Following it would let the __tests__ / *.test.* exclusions be bypassed by naming, ` +
          `and would let the walk leave the repository.\n` +
          `  Replace it with a real file or directory, or move it outside the gate scan roots.`,
      );
    }
    if (e.isDirectory()) {
      if (e.name === "__tests__") continue;
      out.push(...walkSourceFiles(full));
      continue;
    }
    if (!e.isFile()) continue;
    if (!isScannableSourceFile(e.name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Collect source files from a list of targets, each a DIRECTORY (walked
 * recursively) or a SINGLE FILE (included directly if it is a scannable source
 * file). Lets a gate scan a mix like ["src/app/api", "src/lib", "src/auth.ts"]
 * without dropping the single-file entry. Paths are resolved against `root`.
 */
export function collectSourceFiles(targets, root) {
  const out = [];
  for (const t of targets) {
    const full = isAbsolute(t) ? t : join(root, t);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      out.push(...walkSourceFiles(full));
    } else if (stat.isFile() && isScannableSourceFile(full)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Walk `srcDir`, add each source file to `project`, and yield `{ file, rel, sf }`
 * where `rel` is the repo-relative POSIX path (stable across platforms) used as
 * the in-memory source name and for diagnostics.
 */
export function* sourceFiles(project, srcDir, repoRoot) {
  yield* sourceFilesFrom(project, [srcDir], repoRoot);
}

/**
 * Like `sourceFiles`, but over a mixed list of directory/single-file `targets`
 * (see collectSourceFiles). `targets` are resolved against `repoRoot`.
 */
export function* sourceFilesFrom(project, targets, repoRoot) {
  for (const file of collectSourceFiles(targets, repoRoot)) {
    const rel = relative(repoRoot, file).split("\\").join("/");
    const sf = project.createSourceFile(rel, readFileSync(file, "utf8"), {
      overwrite: true,
    });
    yield { file, rel, sf };
  }
}
