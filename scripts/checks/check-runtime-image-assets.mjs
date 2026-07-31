#!/usr/bin/env node
/**
 * CI guard: every asset a deploy-time script needs at runtime must be in the
 * image — AST, per-reference, with the required set DERIVED from the scripts.
 *
 * ## The class
 *
 * `infra/terraform/ecs.tf` runs the migrate task as
 * `prisma migrate deploy && node scripts/audit-db-grants.mjs`, and
 * `scripts/bootstrap-rds-roles.mjs` is invoked via ECS Exec on a fresh
 * environment. Both read JSON out of `scripts/checks/` and import shared modules
 * out of `scripts/lib/`. The Dockerfile copies those assets one `COPY` line at a
 * time, so adding a reference to a script and forgetting the `COPY` produces an
 * image that passes every local check while the control it implements is inert
 * in production.
 *
 * That is not hypothetical. `scripts/checks/app-role-denied-privileges.json`
 * shipped exactly that way: both consumers treated the absent file as an empty
 * policy, so the deploy runner would have applied the blanket `GRANT` with no
 * `REVOKE` behind it. Extracting `scripts/lib/denied-privileges.mjs` immediately
 * reproduced the shape one level up — `check-mjs-imports.mjs` proves a specifier
 * resolves in the REPO, not in the image.
 *
 * ## Why AST and not grep
 *
 * The first version of this check was a regex over the scripts' raw text. Two
 * failure directions, one of them silent:
 *
 *   - a path named only in a COMMENT or an error message counted as required —
 *     noisy, but loud (`denied-privileges.mjs` mentions its own path in both);
 *   - an import written any way the regex did not anticipate produced NO
 *     requirement at all — silently green, which is the direction that ships the
 *     defect this gate exists for.
 *
 * ts-morph parses `.mjs`, returns import declarations structurally, and yields
 * string literals WITHOUT comments — verified. Per the repo's AST-first rule, a
 * check that classifies code starts from the syntax tree.
 *
 * ## Known limit, pinned rather than implied
 *
 * A path assembled at runtime (`join(dir, name + ".json")`) is invisible to any
 * static pass without type/flow analysis, so this gate cannot see it. That
 * residual is covered at a different layer, not by pretending: both consumers
 * FAIL CLOSED when the policy file is absent, so a missed asset stops the deploy
 * task instead of silently disabling the control. The self-test pins the limit
 * as a boundary case so it stays a known residual rather than an assumed
 * capability.
 *
 * Env: RUNTIME_IMAGE_ASSETS_ROOT overrides the repo root (used by the self-test).
 * Exit 0 = OK, 1 = a referenced asset is missing from the image.
 */
import { SyntaxKind } from "ts-morph";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { createAstProject } from "./lib/ast-project.mjs";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const ROOT = process.env.RUNTIME_IMAGE_ASSETS_ROOT ?? REPO_ROOT;

/**
 * Scripts the deployed image executes. A short, explicit list because it is a
 * statement about the DEPLOYMENT, not about the code: the authority is
 * `infra/terraform/ecs.tf`'s task command and the Dockerfile's own comments, not
 * anything derivable from `scripts/`.
 */
const RUNTIME_SCRIPTS = ["scripts/audit-db-grants.mjs", "scripts/bootstrap-rds-roles.mjs"];

/** Data directories whose files are runtime assets rather than build inputs. */
const ASSET_DIR_RE = /(^|\/)scripts\/(checks|lib)\//;

function sourceFileFor(project, rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return null;
  return project.createSourceFile(rel, readFileSync(abs, "utf8"), { overwrite: true });
}

/** Repo-relative path of a specifier/literal that names a `scripts/**` asset. */
function assetPathFrom(value, fromRel) {
  if (typeof value !== "string" || value.length === 0) return null;
  // Whitespace means prose, not a path. Reading literals rather than raw text
  // already keeps comments out; what it does not keep out is a template SPAN
  // that happens to begin with a dot. `…${subject}. ` + "The subject must be…"
  // yields a TemplateTail whose literal text is exactly `". "`, which the
  // relative-resolution below turns into `scripts/lib/. ` — a required asset no
  // Dockerfile can COPY, so the gate reds on an error message.
  //
  // Direction of the risk, stated because narrowing a fail-closed gate is
  // normally the wrong move: this drops a candidate, so it could in principle
  // hide a real asset whose FILENAME contains a space. No file under
  // `scripts/checks/` or `scripts/lib/` has one, and a shell-quoting-hostile
  // name there would be its own problem. The alternative — rewording every
  // sentence that ends a template span with ". " — leaves the trap armed for
  // the next person and costs a review round each time it fires.
  if (/\s/.test(value)) return null;
  const candidate = value.startsWith(".")
    ? normalize(join(dirname(fromRel), value))
    : normalize(value);
  const rel = candidate.startsWith("/") ? relative(ROOT, candidate) : candidate;
  return ASSET_DIR_RE.test(`/${rel}`) ? rel : null;
}

/**
 * Assets a module references directly: imported local modules (structural) plus
 * string literals that name a path under `scripts/checks` or `scripts/lib`.
 *
 * Literals rather than raw text is the whole point — a path mentioned in a
 * comment is not a reference, and ts-morph does not return comments as literals.
 */
function directReferences(project, moduleRel) {
  const sf = sourceFileFor(project, moduleRel);
  if (!sf) return null;
  const out = new Set();
  for (const decl of sf.getImportDeclarations()) {
    const p = assetPathFrom(decl.getModuleSpecifierValue(), moduleRel);
    if (p) out.add(p);
  }
  // Plain strings AND template literals. `audit-db-grants.mjs` names its
  // manifest as `` `${REPO_ROOT}scripts/checks/db-grants-manifest.json` ``, whose
  // path lives in a TemplateTail — a StringLiteral-only sweep derived no
  // requirement for it, so deleting its COPY passed. Reading the literal SPANS
  // of a template covers the interpolated form without needing to evaluate it.
  const LITERAL_KINDS = [
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
    SyntaxKind.TemplateHead,
    SyntaxKind.TemplateMiddle,
    SyntaxKind.TemplateTail,
  ];
  for (const kind of LITERAL_KINDS) {
    for (const lit of sf.getDescendantsOfKind(kind)) {
      const p = assetPathFrom(lit.getLiteralText(), moduleRel);
      if (p) out.add(p);
    }
  }
  return [...out].sort();
}

/**
 * Everything a runtime script needs, following local module imports TRANSITIVELY.
 *
 * A one-level scan is not enough, and the gap is not theoretical: extracting the
 * shared loader moved the policy path OUT of the two entry scripts and into
 * `scripts/lib/denied-privileges.mjs`, so a direct-only scan stopped deriving the
 * JSON requirement entirely — the exact asset whose missing COPY started all of
 * this. The refactor would have silently narrowed the gate that was guarding it.
 *
 * Returns `null` when a referenced module is missing, so a rename fails the gate
 * closed instead of shrinking its input set.
 */
function assetsReferencedBy(project, scriptRel) {
  const seen = new Set();
  const assets = new Set();
  const queue = [scriptRel];
  while (queue.length > 0) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const refs = directReferences(project, current);
    if (refs === null) return null;
    for (const ref of refs) {
      assets.add(ref);
      // Only a module can be traversed further; a data file is a leaf.
      if (ref.endsWith(".mjs") && !seen.has(ref)) queue.push(ref);
    }
  }
  return [...assets].sort();
}

/**
 * The (source, destination) pairs of every COPY in the image's FINAL stage.
 *
 * Both halves matter, and the first version had neither:
 *   - a substring test over the whole COPY line passed a line that names the
 *     asset as its SOURCE and puts it somewhere else entirely, because the
 *     source alone made the substring match;
 *   - COPY lines from earlier build stages are not in the shipped image at all,
 *     so scanning the whole file can vouch for a file the runner never receives.
 *
 * Paths are normalised to repo-relative on both sides: the builder's WORKDIR is
 * `/app`, and the runner's is `/app`, so `/app/x` and `./x` both mean `x`.
 */
function finalStageCopies(dockerfile) {
  const lines = dockerfile.split("\n");
  const lastFrom = lines.reduce(
    (acc, l, i) => (/^\s*FROM\s/i.test(l) ? i : acc),
    -1,
  );
  const strip = (p) => p.replace(/^\.\//, "").replace(/^\/app\//, "").replace(/\/+$/, "");
  const out = [];
  for (const line of lines.slice(lastFrom + 1)) {
    if (!/^\s*COPY\s/i.test(line)) continue;
    const tokens = line.trim().split(/\s+/).slice(1).filter((t) => !t.startsWith("--"));
    if (tokens.length < 2) continue;
    const dest = strip(tokens[tokens.length - 1]);
    for (const src of tokens.slice(0, -1)) out.push({ src: strip(src), dest });
  }
  return out;
}

/**
 * True when a COPY in the final stage places `repoPath` at the SAME relative
 * location in the image.
 *
 * Same-location is the invariant, not merely "is copied": these scripts resolve
 * their assets relative to their own file (`new URL("..", import.meta.url)`), so
 * a correct source landing at a different destination is exactly as broken as no
 * COPY at all. A directory COPY covers the files beneath it, provided it lands
 * at the matching directory.
 */
function copiedIntoImage(copies, repoPath) {
  return copies.some(({ src, dest }) => {
    if (src === repoPath) return dest === repoPath;
    if (!repoPath.startsWith(`${src}/`)) return false;
    // Directory copy: the remainder of the path must hang off the destination.
    return repoPath === `${dest}/${repoPath.slice(src.length + 1)}`;
  });
}

function main() {
  const dockerfilePath = join(ROOT, "Dockerfile");
  if (!existsSync(dockerfilePath)) {
    console.error(`runtime-image-assets: Dockerfile not found under ${ROOT}`);
    process.exit(1);
  }
  const copies = finalStageCopies(readFileSync(dockerfilePath, "utf8"));
  const project = createAstProject();

  const problems = [];
  // A GLOBAL unique set, not a per-entry sum: two entry scripts sharing one
  // module made the old counter read 4 while only 2 distinct assets existed, so
  // it would have stayed non-zero even if one script's derivation went dead.
  const allAssets = new Set();

  for (const scriptRel of RUNTIME_SCRIPTS) {
    const assets = assetsReferencedBy(project, scriptRel);
    if (assets === null) {
      // Fail closed: a runtime script — or a module it imports — that has moved
      // or been renamed must stop the gate, not silently reduce its input set.
      problems.push(`${scriptRel}: the script or a module it imports was not found under ${ROOT}`);
      continue;
    }
    if (!copiedIntoImage(copies, scriptRel)) {
      problems.push(
        `${scriptRel}: the script itself is not COPYd to that path in the final stage`,
      );
    }
    for (const asset of assets) {
      allAssets.add(asset);
      if (!copiedIntoImage(copies, asset)) {
        problems.push(
          `${scriptRel} references ${asset}, which the final stage does not COPY to that path`,
        );
      }
    }
  }

  // Anti-vacuity: a parser or path-resolution change that stopped yielding
  // references would make every check above trivially pass.
  if (allAssets.size === 0) {
    problems.push(
      "no runtime assets were derived from any script — the extraction is dead, " +
        "so the COPY assertions above proved nothing",
    );
  }

  if (problems.length > 0) {
    console.error("Runtime image is missing assets a deploy-time script needs:\n");
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      "\nAdd a COPY line to the Dockerfile's runtime stage. A script that reads a " +
        "file at deploy time but is shipped without it fails closed at best, and " +
        "silently disables the control it implements at worst.\n",
    );
    process.exit(1);
  }

  console.log(
    `runtime-image-assets: OK (${RUNTIME_SCRIPTS.length} script(s), ${allAssets.size} distinct asset(s))`,
  );
}

main();
