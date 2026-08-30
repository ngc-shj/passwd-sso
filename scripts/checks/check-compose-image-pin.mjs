#!/usr/bin/env node
/**
 * CI guard: no Compose service may resolve to the `latest` tag.
 *
 * #803 pinned mailpit off `:latest` — which had drifted to v1.29.1, inside the
 * range of ten published advisories — up to v1.31.0. Nothing kept it there.
 * Dependabot does not watch these files: `.github/dependabot.yml` declares
 * `github-actions` and `npm` only, no `docker` ecosystem, so a compose image is
 * updated when a human remembers to. `check-runtime-image-assets.mjs` sounds
 * adjacent and is not — it checks assets baked into the app image, not the
 * images the stack pulls.
 *
 * THE PREDICATE IS "NOT latest", NOT "FULLY PINNED". Measured against the files
 * as they are: 9 image references, zero on `:latest`, and three of them
 * (`redis:7-alpine`, `postgres:16-alpine`, `fluent/fluent-bit:3.2`) are
 * deliberate floating MINOR tags — a stack that wants patch releases of Redis 7
 * without a PR each time. Demanding a digest would red the tree on day one and
 * be relaxed by whoever hit it first, which is how a gate becomes decorative.
 * `latest` is different in kind: it floats across MAJOR versions and has no
 * upper bound at all, so "what is deployed" is a function of when the image was
 * last pulled and nothing in the repo records it.
 *
 * TWO SPELLINGS, ONE DEFECT. `image: mailpit` with no tag is `mailpit:latest` —
 * Docker supplies the default. A `grep -c ':latest'` returns 0 for it, which is
 * why the member set here comes from a parse: every object in the document that
 * carries a string `image`, wherever it sits. That reaches the `x-sentinel`
 * top-level anchor in docker-compose.ha.yml, which a `services.*.image` walk
 * would step over — three sentinel services inherit their image from it through
 * a `<<:` merge key.
 *
 * File discovery and the YAML loader are IMPORTED from check-compose-log-caps,
 * not re-derived. Which files Compose reads (all four default names, plus the
 * refusal on an ambiguous pair) and how `<<:` merge keys survive js-yaml 5's
 * CORE_SCHEMA are each decided in exactly one place; a second copy of either
 * would drift, and the copy nobody looks at is the one that drifts.
 *
 * Verified against history rather than a fixture alone: run over the tree at
 * d7a8e6bbe^ (the commit before #803 pinned mailpit) it reports exactly one
 * violation, `services.mailpit.image: EXPLICIT_LATEST`, and over the tree after
 * it, OK — 12 references scanned either way, so the difference is the finding
 * and not the scope.
 *
 * CONTROL CLASS (R49): fail-closed verification gate over a BOUNDED file set.
 * NOT an enforceable boundary — bypassable by editing the gate, by an image
 * reference built at deploy time, or by a compose file outside the tracked set.
 *
 * Refusals, which are NOT the same as a pass:
 *   NO_COMPOSE_FILES     the discovery found nothing — scan root is wrong
 *   NO_IMAGE_REFERENCES  parsed files carry no `image:` at all — the shape
 *                        changed, or the parse silently degraded
 *   UNRESOLVABLE_TAG     the tag comes from a `${VAR}` this gate cannot
 *                        evaluate, so it cannot say the tag is not `latest`
 */
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  findComposeFiles,
  createComposeYamlLoader,
} from "./check-compose-log-caps.mjs";

const ROOT = process.env.COMPOSE_IMAGE_PIN_ROOT ?? ".";

// Env pollution guard (sec-F6): the override exists for the self-test. Left
// ungated it is a way to silently point CI at an empty tree, and "examined
// nothing" prints the same as "found nothing wrong".
if (
  process.env.CI === "true" &&
  process.env.COMPOSE_IMAGE_PIN_ROOT &&
  process.env.COMPOSE_IMAGE_PIN_FIXTURE_MODE !== "1"
) {
  console.error(
    "check-compose-image-pin: COMPOSE_IMAGE_PIN_ROOT must not be set in CI (it " +
      "would narrow the scan). Set COMPOSE_IMAGE_PIN_FIXTURE_MODE=1 only from " +
      "the self-test.",
  );
  process.exit(1);
}

/** Docker's default tag when a reference carries none. */
const DEFAULT_TAG = "latest";

/** `${VAR}` / `$VAR` — Compose interpolates these; this gate cannot. */
const INTERPOLATION_RE = /\$\{[^}]*\}|\$[A-Za-z_]\w*/;

/**
 * Split an image reference into { name, tag, digest }.
 *
 * The colon is ambiguous: `localhost:5000/mailpit` has one in the REGISTRY, not
 * the tag. Only a colon in the last slash-separated segment can introduce a
 * tag, which is the rule the daemon itself applies.
 */
export function parseImageRef(ref) {
  const text = String(ref).trim();
  const at = text.indexOf("@");
  if (at !== -1) {
    return { name: text.slice(0, at), tag: null, digest: text.slice(at + 1) };
  }
  const lastSlash = text.lastIndexOf("/");
  const lastSegment = text.slice(lastSlash + 1);
  const colon = lastSegment.indexOf(":");
  if (colon === -1) return { name: text, tag: null, digest: null };
  return {
    name: text.slice(0, lastSlash + 1 + colon),
    tag: lastSegment.slice(colon + 1),
    digest: null,
  };
}

/**
 * Judge one image reference.
 *
 * Returns null when it is acceptable, otherwise a reason string. A digest
 * reference is acceptable whatever tag rides alongside it — the digest is what
 * the daemon resolves.
 */
export function judgeImageRef(ref) {
  if (INTERPOLATION_RE.test(String(ref))) {
    return `UNRESOLVABLE_TAG: '${ref}' interpolates a variable, so this gate cannot rule out latest. Write the tag literally, or pin by digest.`;
  }
  const { tag, digest } = parseImageRef(ref);
  if (digest) return null;
  if (tag === null) {
    return `IMPLICIT_LATEST: '${ref}' carries no tag, so Docker resolves it to '${ref}:${DEFAULT_TAG}'. Name a version.`;
  }
  if (tag === DEFAULT_TAG) {
    return `EXPLICIT_LATEST: '${ref}' floats across major versions with no upper bound. Name a version.`;
  }
  return null;
}

/**
 * Every `image:` string in a parsed document, with the key path that reached it.
 *
 * Walks the whole document rather than `services.*.image`: the HA overlay parks
 * one under the top-level `x-sentinel` anchor, and three services take it from
 * there through a merge key.
 */
export function collectImageRefs(doc, path = [], out = []) {
  if (!doc || typeof doc !== "object") return out;
  if (Array.isArray(doc)) {
    doc.forEach((item, i) => collectImageRefs(item, [...path, String(i)], out));
    return out;
  }
  for (const [key, value] of Object.entries(doc)) {
    if (key === "image" && typeof value === "string") {
      out.push({ where: [...path, key].join("."), ref: value });
      continue;
    }
    collectImageRefs(value, [...path, key], out);
  }
  return out;
}

/** Violations across { file, doc } pairs. Pure, so the self-test can drive it. */
export function findViolations(docs) {
  const violations = [];
  let refCount = 0;
  for (const { file, doc } of docs) {
    for (const { where, ref } of collectImageRefs(doc)) {
      refCount++;
      const reason = judgeImageRef(ref);
      if (reason) violations.push(`${file}: ${where}: ${reason}`);
    }
  }
  return { violations, refCount };
}

async function main() {
  console.log(`check-compose-image-pin: ROOT=${ROOT}`);
  const loadComposeYaml = await createComposeYamlLoader();

  const files = findComposeFiles(ROOT);
  if (files.length === 0) {
    console.error(
      `check-compose-image-pin: NO_COMPOSE_FILES — no compose file under ${ROOT}. Refusing to pass on an empty member set.`,
    );
    process.exit(1);
  }

  const docs = [];
  for (const path of files) {
    let doc;
    try {
      doc = loadComposeYaml(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(
        `check-compose-image-pin: PARSE_FAILED — ${relative(ROOT, path)}: ${err instanceof Error ? err.name : "error"}`,
      );
      process.exit(1);
    }
    docs.push({ file: relative(ROOT, path) || path, doc });
  }

  const { violations, refCount } = findViolations(docs);

  if (refCount === 0) {
    // "Recognised no subject" must not print like "found nothing wrong": a
    // renamed key, a degraded parse, and a genuinely image-less stack all land
    // here, and only the last is benign.
    console.error(
      `check-compose-image-pin: NO_IMAGE_REFERENCES — parsed ${files.length} compose file(s) and found no 'image:' at all. The gate is not seeing its subject.`,
    );
    process.exit(1);
  }

  console.log(
    `check-compose-image-pin: checked ${refCount} image reference(s) across ${files.length} compose file(s)`,
  );

  if (violations.length > 0) {
    console.error(
      `\ncheck-compose-image-pin: ${violations.length} image reference(s) resolve to '${DEFAULT_TAG}':\n`,
    );
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      `\nNothing watches these files: .github/dependabot.yml declares no docker
ecosystem, so an unpinned image is whatever the last pull happened to fetch.
mailpit sat on :latest at v1.29.1, inside the range of ten advisories, until
someone looked. A floating MINOR tag (redis:7-alpine) is fine — it has an upper
bound. 'latest' has none.\n`,
    );
    process.exit(1);
  }

  console.log("check-compose-image-pin: OK");
}

await main();
