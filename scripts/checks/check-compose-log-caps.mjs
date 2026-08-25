#!/usr/bin/env node
/**
 * CI guard: every Compose service must resolve to a bounded log driver.
 *
 * Docker's default json-file driver has no rotation limit. A service stuck in a
 * per-second retry loop writes until the disk fills — the incident this guard
 * exists for produced 4.5 GB across two containers in 27 hours, and the only
 * symptom anyone noticed was the disk. The cap in docker-compose.yml fixes
 * today's services; this guard is what keeps the next one from shipping without
 * it, because YAML anchors do not cross compose files and each overlay has to
 * repeat the block by hand.
 *
 * The check is per-file and deliberately stricter than Compose's own merge: a
 * service must carry `logging:` in the file that defines it, or be an overlay
 * fragment of a service the base file already caps. Resolving the real
 * base+overlay merge would mean reimplementing Compose's semantics, and a second
 * implementation of an interpreter's rules is a defect class this repo has been
 * bitten by before (a regex standing in for a SQL lexer).
 *
 * Over the files it examines, that strictness cannot produce a false negative —
 * a service Compose would leave uncapped is never judged capped here. It says
 * nothing about files it does not examine, which is why the member set below
 * covers all four names Compose accepts and refuses an ambiguous pair rather
 * than picking one. Its false positives are services that genuinely inherit
 * from the base file: a fragment with no `logging:` at all, and a fragment that
 * retunes one option of a matching-driver block. Both are admitted explicitly.
 *
 * YAML is parsed, not scanned. `logging: *default-logging` and the
 * `<<: *sentinel` merge key in docker-compose.ha.yml are both invisible to a
 * line scanner, and a scanner would report the sentinels as capped either way.
 */
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";

/**
 * Services that legitimately do NOT use json-file, with the reason. An entry is
 * required rather than accepting any non-json-file driver silently: "ships its
 * logs somewhere else" and "someone typo'd the driver name" look identical
 * otherwise. Entries are checked for staleness — an entry whose service no
 * longer opts out is an error, so removing the opt-out cannot leave a permanent
 * hole behind.
 */
export const OFF_HOST_ALLOW = [
  {
    file: "docker-compose.logging.yml",
    service: "app",
    driver: "fluentd",
    reason: "audit-log forwarding overlay ships app stdout to fluent-bit instead of a local file",
  },
];

/** Compose treats a service with no `driver` as json-file. */
const DEFAULT_DRIVER = "json-file";

/** Both are required: max-size alone rotates forever, max-file alone never rotates. */
const REQUIRED_JSON_FILE_OPTIONS = ["max-size", "max-file"];

/**
 * All four filenames Compose accepts by default, plus their overlay variants.
 * `docker-compose*.yml` alone is NOT the member set: Compose reads
 * `compose.yaml` in PREFERENCE to `docker-compose.yml`, so a project could keep
 * a capped `docker-compose.yml` that Compose ignores entirely while an uncapped
 * `compose.yaml` is what actually runs — and a guard scoped to the first
 * spelling would pass having examined the file nobody uses.
 */
const COMPOSE_FILE_RE = /^(docker-)?compose.*\.ya?ml$/;
const GIT_PATHSPECS = ["docker-compose*.yml", "docker-compose*.yaml", "compose*.yml", "compose*.yaml"];

/** The two default-name families. Both present at one root is ambiguous. */
const DEFAULT_NAMES = {
  compose: ["compose.yaml", "compose.yml"],
  dockerCompose: ["docker-compose.yaml", "docker-compose.yml"],
};

/**
 * Tracked compose files. `git ls-files` keeps an untracked scratch copy out of
 * the member set; the readdir fallback covers a source tarball. An empty result
 * is a refusal, not a pass — a guard that examined nothing must not report the
 * same thing as a guard that found nothing wrong.
 */
export function findComposeFiles(root = ".") {
  try {
    const tracked = execFileSync("git", ["ls-files", "-z", ...GIT_PATHSPECS], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\0")
      .filter(Boolean);
    if (tracked.length > 0) return [...new Set(tracked)].map((f) => join(root, f));
  } catch {
    // not a git checkout, or git is absent
  }
  return readdirSync(root)
    .filter((f) => COMPOSE_FILE_RE.test(f))
    .map((f) => join(root, f));
}

/**
 * Compose picks ONE default file and warns when both families exist; which one
 * it picked is then invisible in the guard's output. Refuse instead of guessing.
 */
export function findAmbiguousDefaults(basenames) {
  const present = new Set(basenames);
  const compose = DEFAULT_NAMES.compose.filter((n) => present.has(n));
  const dockerCompose = DEFAULT_NAMES.dockerCompose.filter((n) => present.has(n));
  const clashes = [];
  if (compose.length > 0 && dockerCompose.length > 0) {
    clashes.push(
      `${compose.join("/")} and ${dockerCompose.join("/")} both exist — Compose reads the compose.* one and ignores the other, so which file this guard's verdict describes is ambiguous. Keep one.`,
    );
  }
  for (const family of Object.values(DEFAULT_NAMES)) {
    const both = family.filter((n) => present.has(n));
    if (both.length > 1) {
      clashes.push(`${both.join(" and ")} both exist — Compose reads only one of them. Keep one.`);
    }
  }
  return clashes;
}

/**
 * Classify one service's resolved `logging` block.
 * Returns {kind:"capped"} | {kind:"missing"} | {kind:"off-host",driver}
 * | {kind:"incomplete",missing:[...]}.
 */
export function classifyLogging(logging) {
  if (logging === undefined || logging === null) return { kind: "missing" };
  const driver = logging.driver ?? DEFAULT_DRIVER;
  if (driver !== DEFAULT_DRIVER) return { kind: "off-host", driver };
  const options = logging.options ?? {};
  const missing = REQUIRED_JSON_FILE_OPTIONS.filter(
    (k) => options[k] === undefined || options[k] === null || String(options[k]).trim() === "",
  );
  // Presence, not a numeric floor: pinning "20m"/"5" here would make a
  // deliberate retune a build failure, which is how gates get disabled.
  return missing.length > 0 ? { kind: "incomplete", missing } : { kind: "capped" };
}

/**
 * @param {Map<string, any>} docs file basename -> parsed YAML document
 * @returns {string[]} violations
 */
export function findViolations(docs, baseFile = "docker-compose.yml") {
  const violations = [];
  const matchedAllow = new Set();

  const base = docs.get(baseFile);
  const baseServices = Object.entries(base?.services ?? {});
  const cappedInBase = new Set(
    baseServices
      .filter(([, svc]) => classifyLogging(svc?.logging).kind === "capped")
      .map(([name]) => name),
  );
  const baseDriver = new Map(
    baseServices.map(([name, svc]) => [name, svc?.logging?.driver ?? DEFAULT_DRIVER]),
  );

  violations.push(...findAmbiguousDefaults([...docs.keys()]));

  for (const [file, doc] of docs) {
    const services = doc?.services;
    if (!services || Object.keys(services).length === 0) {
      violations.push(`${file}: no services found — the file did not parse as a compose file`);
      continue;
    }
    for (const [name, svc] of Object.entries(services)) {
      const verdict = classifyLogging(svc?.logging);
      if (verdict.kind === "capped") continue;

      if (verdict.kind === "off-host") {
        const allow = OFF_HOST_ALLOW.find((a) => a.file === file && a.service === name);
        if (!allow) {
          violations.push(
            `${file}: service '${name}' uses the '${verdict.driver}' log driver with no OFF_HOST_ALLOW entry — add one naming where those logs go, or give it a bounded json-file block`,
          );
        } else if (allow.driver !== verdict.driver) {
          // Still a matched entry — only its driver drifted. Recording it here
          // too keeps the staleness loop below from ALSO reporting the entry as
          // unused, which would tell the operator to remove the entry and update
          // it in the same output.
          matchedAllow.add(`${file}:${name}`);
          violations.push(
            `${file}: service '${name}' is allowed off-host as '${allow.driver}' but now uses '${verdict.driver}' — update the OFF_HOST_ALLOW entry`,
          );
        } else {
          matchedAllow.add(`${file}:${name}`);
        }
        continue;
      }

      if (verdict.kind === "incomplete") {
        // Compose merges logging.options key-by-key when the driver matches, so
        // an overlay may legally set just one option — `max-size: 1g` on top of
        // a capped base is fully bounded. Rejecting that would be a false
        // positive on a normal prod-overlay retune, and the message would be
        // factually wrong about the merged result.
        const mergedWithBase =
          file !== baseFile &&
          cappedInBase.has(name) &&
          baseDriver.get(name) === (svc?.logging?.driver ?? DEFAULT_DRIVER);
        if (!mergedWithBase) {
          violations.push(
            `${file}: service '${name}' has a json-file logging block missing ${verdict.missing.join(" and ")} — an unbounded option is the same as no cap`,
          );
        }
        continue;
      }

      // kind === "missing": only an overlay fragment of an already-capped base
      // service may omit it. A service that exists nowhere else is uncapped.
      if (file === baseFile) {
        violations.push(
          `${baseFile}: service '${name}' has no logging block — its container writes an unbounded json-file log`,
        );
      } else if (!cappedInBase.has(name)) {
        violations.push(
          `${file}: service '${name}' has no logging block and is not a capped service from ${baseFile} — its container writes an unbounded json-file log`,
        );
      }
    }
  }

  for (const allow of OFF_HOST_ALLOW) {
    // Only judge an entry whose file is in the set being checked. A partial set
    // (a fixture root, a single-file run) cannot tell "the service stopped
    // opting out" from "that file was not scanned", and reporting the second as
    // the first would make every scoped run red for the wrong reason.
    if (!docs.has(allow.file)) continue;
    if (!matchedAllow.has(`${allow.file}:${allow.service}`)) {
      violations.push(
        `stale OFF_HOST_ALLOW entry: ${allow.file}: '${allow.service}' no longer uses a non-json-file driver — remove the entry so it cannot mask a future regression`,
      );
    }
  }

  return violations;
}

async function loadYaml() {
  try {
    const mod = await import("js-yaml");
    return mod.default ?? mod;
  } catch {
    // js-yaml is a declared devDependency. This gate runs in the always-on CI
    // static-checks job, so refuse loudly rather than falling back to a line
    // scanner — a scanner cannot see `logging: *anchor` or `<<: *merge` and
    // would report a green it has not earned.
    console.error(
      "check-compose-log-caps: YAML_PARSER_UNAVAILABLE — cannot import js-yaml. Run `npm ci`.",
    );
    process.exit(1);
  }
}

async function main(root = process.env.COMPOSE_LOG_CAPS_ROOT ?? ".") {
  console.log(`check-compose-log-caps: ROOT=${root}`);
  const yaml = await loadYaml();
  const files = findComposeFiles(root);
  if (files.length === 0) {
    console.error(
      `check-compose-log-caps: NO_COMPOSE_FILES — no docker-compose*.yml under ${root}. Refusing to pass on an empty member set.`,
    );
    process.exit(1);
  }

  const docs = new Map();
  for (const path of files) {
    let doc;
    try {
      doc = yaml.load(readFileSync(path, "utf8"));
    } catch (err) {
      console.error(`check-compose-log-caps: PARSE_FAILED ${path} — ${err.message}`);
      process.exit(1);
    }
    docs.set(basename(path), doc);
  }

  const violations = findViolations(docs);
  if (violations.length > 0) {
    console.error("compose log cap guard failed:");
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      "\nSee the x-logging block in docker-compose.yml — each compose file repeats it because YAML anchors do not cross files.",
    );
    process.exit(1);
  }

  const serviceCount = [...docs.values()].reduce(
    (n, d) => n + Object.keys(d?.services ?? {}).length,
    0,
  );
  console.log(
    `compose log cap guard passed (${files.length} file(s), ${serviceCount} service block(s)).`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv[2]);
}
