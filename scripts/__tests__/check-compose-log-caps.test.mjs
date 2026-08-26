/**
 * RT7 self-test for check-compose-log-caps.mjs.
 *
 * The guard's whole value is going red when a compose service ships without a
 * bounded log driver, so every shape that can produce an unbounded container log
 * is mutated here and asserted to fail — plus the allow side, because a guard
 * that reds on everything is satisfied by universal denial and tells you
 * nothing.
 *
 * The shapes come from the files as they actually are: an alias
 * (`logging: *default-logging`), a merge key (`<<: *sentinel` in the HA
 * overlay), an overlay fragment that inherits from the base file, and a
 * deliberate off-host driver (`app` under the logging overlay).
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OFF_HOST_ALLOW,
  createComposeYamlLoader,
  classifyLogging,
  findAmbiguousDefaults,
  findComposeFiles,
  findStaleFixtureEntries,
  findViolations,
  isTestFixturePath,
  parseMaxSize,
  FIXTURE_ALLOW,
} from "../checks/check-compose-log-caps.mjs";

const GATE = join(process.cwd(), "scripts/checks/check-compose-log-caps.mjs");

const CAPPED = { driver: "json-file", options: { "max-size": "20m", "max-file": "5" } };

/** An overlay fragment that carries its own block, as the gate now requires. */
const CAPPED_OVERLAY = `services:
  db:
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
    ports:
      - "5432:5432"
`;

/**
 * Build a docs map the way main() does, from YAML text so aliases resolve.
 *
 * The loader comes from the gate rather than being rebuilt here: the merge-key
 * case below only proves anything if the test parses with the same schema the
 * gate does.
 */
const loadComposeYaml = await createComposeYamlLoader();

function docsFrom(files) {
  return new Map(Object.entries(files).map(([name, text]) => [name, loadComposeYaml(text)]));
}

const BASE_YAML = `
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "20m"
    max-file: "5"
services:
  app:
    image: app
    logging: *default-logging
  db:
    image: postgres
    logging: *default-logging
`;

describe("classifyLogging", () => {
  it("accepts a json-file block carrying both max-size and max-file", () => {
    expect(classifyLogging(CAPPED)).toMatchObject({ kind: "capped" });
  });

  it("reports a service with no logging block at all", () => {
    expect(classifyLogging(undefined)).toEqual({ kind: "missing" });
  });

  it("treats a block with options but no driver as json-file, since Compose does", () => {
    expect(classifyLogging({ options: { "max-size": "20m", "max-file": "5" } })).toMatchObject({
      kind: "capped",
    });
  });

  it("rejects max-size without max-file, which rotates but never drops a file", () => {
    expect(classifyLogging({ driver: "json-file", options: { "max-size": "20m" } })).toEqual({
      kind: "incomplete",
      missing: ["max-file"],
    });
  });

  it("rejects max-file without max-size, which never rotates in the first place", () => {
    expect(classifyLogging({ driver: "json-file", options: { "max-file": "5" } })).toEqual({
      kind: "incomplete",
      missing: ["max-size"],
    });
  });

  it("rejects an empty option value, which Compose does not treat as a bound", () => {
    expect(
      classifyLogging({ driver: "json-file", options: { "max-size": "  ", "max-file": "5" } }),
    ).toEqual({ kind: "incomplete", missing: ["max-size"] });
  });

  it("reports a non-json-file driver as off-host rather than judging it capped", () => {
    expect(classifyLogging({ driver: "fluentd", options: { tag: "x" } })).toEqual({
      kind: "off-host",
      driver: "fluentd",
    });
  });

  it("accepts a deliberate retune within the ceiling", () => {
    expect(
      classifyLogging({ driver: "json-file", options: { "max-size": "100m", "max-file": "2" } }),
    ).toMatchObject({ kind: "capped" });
  });

  it("rejects values the daemon itself rejects, instead of deferring to deploy time", () => {
    // Measured against `docker run --log-opt max-size=X`: -1, 0 and 2Ommm are
    // rejected with `invalid size`, so the container refuses to start. Passing
    // them here moves a config error from review to deploy.
    for (const bad of ["-1", "0", "2Ommm", "twenty"]) {
      expect(
        classifyLogging({ driver: "json-file", options: { "max-size": bad, "max-file": "5" } }),
        `max-size ${bad}`,
      ).toMatchObject({ kind: "unparseable", option: "max-size" });
    }
    for (const bad of ["0", "-1", "abc", "1.5"]) {
      expect(
        classifyLogging({ driver: "json-file", options: { "max-size": "20m", "max-file": bad } }),
        `max-file ${bad}`,
      ).toMatchObject({ kind: "unparseable", option: "max-file" });
    }
  });

  it("accepts every spelling the daemon accepts", () => {
    for (const good of ["20m", "20M", "20mb", "1g", "1048576"]) {
      expect(
        classifyLogging({ driver: "json-file", options: { "max-size": good, "max-file": "1" } }),
        good,
      ).toMatchObject({ kind: "capped" });
    }
  });

  it("rejects a valid but enormous value — the case a syntax check cannot catch", () => {
    // `max-size: 999g` is accepted by the daemon and is unbounded in every sense
    // the incident cared about. A cap has to be a number.
    expect(
      classifyLogging({ driver: "json-file", options: { "max-size": "999g", "max-file": "1" } }),
    ).toMatchObject({ kind: "oversized" });
    expect(
      classifyLogging({ driver: "json-file", options: { "max-size": "200m", "max-file": "50" } }),
    ).toMatchObject({ kind: "oversized" });
  });
});

describe("findViolations — allow side", () => {
  it("passes a base file whose services all carry the anchor", () => {
    expect(findViolations(docsFrom({ "docker-compose.yml": BASE_YAML }))).toEqual([]);
  });

  it("requires the block even on a fragment that only adds ports", () => {
    // Inheritance from the base file is NOT admitted. A per-file rule cannot
    // tell an overlay from a standalone file, and a tracked
    // docker-compose.recovery.yml run on its own renders logging: null.
    const overlay = `
services:
  db:
    ports:
      - "127.0.0.1:5432:5432"
`;
    const violations = findViolations(
      docsFrom({ "docker-compose.yml": BASE_YAML, "docker-compose.override.yml": overlay }),
    );
    expect(violations.join("\n")).toContain("docker-compose.override.yml");
    expect(violations.join("\n")).toContain("this file may be run on its own");
  });

  it("resolves a merge key, so a service built from <<: *anchor counts as capped", () => {
    const ha = `
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "20m"
    max-file: "5"
x-sentinel: &sentinel
  image: redis
  logging: *default-logging
services:
  sentinel-1:
    <<: *sentinel
  sentinel-2:
    <<: *sentinel
`;
    expect(
      findViolations(docsFrom({ "docker-compose.yml": BASE_YAML, "docker-compose.ha.yml": ha })),
    ).toEqual([]);
  });

  it("requires both options on a retune, since the file may be read alone", () => {
    const overlay = `
services:
  db:
    logging:
      driver: json-file
      options:
        max-size: "1g"
`;
    expect(
      findViolations(
        docsFrom({ "docker-compose.yml": BASE_YAML, "docker-compose.override.yml": overlay }),
      ).join("\n"),
    ).toContain("missing max-file");
  });

  it("passes an off-host driver that has a matching OFF_HOST_ALLOW entry", () => {
    const logging = `
services:
  app:
    logging:
      driver: fluentd
      options:
        fluentd-address: "localhost:24224"
`;
    expect(
      findViolations(
        docsFrom({ "docker-compose.yml": BASE_YAML, "docker-compose.logging.yml": logging }),
      ),
    ).toEqual([]);
  });
});

describe("findViolations — deny side", () => {
  it("reds on a new service added to the base file without a logging block", () => {
    const mutated = `${BASE_YAML}
  newsvc:
    image: whatever
`;
    const violations = findViolations(docsFrom({ "docker-compose.yml": mutated }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'newsvc'");
    // The base-file wording, not the overlay one: a service defined here has no
    // base to inherit from, and saying "is not a capped service from
    // docker-compose.yml" about docker-compose.yml itself reads as nonsense.
    expect(violations[0]).toContain("has no logging block");
    expect(violations[0]).toContain("this file may be run on its own");
  });

  it("reds on an overlay-only service with no logging block, since it inherits nothing", () => {
    const overlay = `
services:
  mailpit:
    image: axllent/mailpit
`;
    const violations = findViolations(
      docsFrom({ "docker-compose.yml": BASE_YAML, "docker-compose.override.yml": overlay }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("'mailpit'");
  });

  it("reds when the base service it would inherit from is itself uncapped", () => {
    const base = `
services:
  app:
    image: app
`;
    const overlay = `
services:
  app:
    ports:
      - "3000:3000"
`;
    const violations = findViolations(
      docsFrom({ "docker-compose.yml": base, "docker-compose.override.yml": overlay }),
    );
    // Both the base definition and the fragment that cannot inherit a cap.
    expect(violations).toHaveLength(2);
    expect(violations.join("\n")).toContain("docker-compose.yml");
    expect(violations.join("\n")).toContain("docker-compose.override.yml");
  });

  it("reds on a half-configured json-file block, naming the missing option", () => {
    const mutated = BASE_YAML.replace('    max-file: "5"\n', "");
    const violations = findViolations(docsFrom({ "docker-compose.yml": mutated }));
    expect(violations.join("\n")).toContain("max-file");
  });

  it("reds on an off-host driver with no allow entry, so a typo'd driver cannot pass", () => {
    const overlay = `
services:
  db:
    logging:
      driver: fluentdd
`;
    const violations = findViolations(
      docsFrom({ "docker-compose.yml": BASE_YAML, "docker-compose.override.yml": overlay }),
    );
    expect(violations.join("\n")).toContain("fluentdd");
    expect(violations.join("\n")).toContain("OFF_HOST_ALLOW");
  });

  it("reds when an allowlisted service switches to a different off-host driver", () => {
    // The entry says fluentd; a silent switch to another driver means the logs
    // now go somewhere nobody reviewed. Pins the driver-equality branch.
    const logging = `
services:
  app:
    logging:
      driver: gelf
      options:
        gelf-address: "udp://127.0.0.1:12201"
`;
    const violations = findViolations(
      docsFrom({ "docker-compose.yml": BASE_YAML, "docker-compose.logging.yml": logging }),
    );
    expect(violations.join("\n")).toContain("allowed off-host as 'fluentd' but now uses 'gelf'");
    // and NOT also told to remove the entry it just told us to update
    expect(violations.join("\n")).not.toContain("stale OFF_HOST_ALLOW entry");
  });

  it("reds on an off-host service in a file the allow entry does not name", () => {
    // The entry is scoped to docker-compose.logging.yml; the same service name
    // going off-host in the base file is a different decision entirely.
    const base = BASE_YAML.replace(
      "  app:\n    image: app\n    logging: *default-logging",
      "  app:\n    image: app\n    logging:\n      driver: gelf",
    );
    const violations = findViolations(docsFrom({ "docker-compose.yml": base }));
    expect(violations.join("\n")).toContain("docker-compose.yml");
    expect(violations.join("\n")).toContain("no OFF_HOST_ALLOW entry");
  });

  it("reds on a stale allow entry once the service stops opting out", () => {
    // The logging overlay exists but app is back on json-file: the entry now
    // guards nothing and would mask a future off-host regression.
    const logging = `
services:
  app:
    logging:
      driver: json-file
      options:
        max-size: "20m"
        max-file: "5"
`;
    const violations = findViolations(
      docsFrom({ "docker-compose.yml": BASE_YAML, "docker-compose.logging.yml": logging }),
    );
    expect(violations.join("\n")).toContain("stale OFF_HOST_ALLOW entry");
  });

  it("reds on a file that parses but declares no services", () => {
    const violations = findViolations(
      docsFrom({ "docker-compose.yml": BASE_YAML, "docker-compose.override.yml": "volumes: {}\n" }),
    );
    expect(violations.join("\n")).toContain("no services found");
  });
});

describe("the real compose files", () => {
  it("enumerates every tracked compose file at any depth, minus test fixtures", () => {
    // Compared against a RECURSIVE listing, not against the gate's own pathspec.
    // The earlier form used the same root-anchored pattern the gate used, so it
    // agreed with the bug: `deploy/docker-compose.yml` was invisible to both.
    const files = findComposeFiles(".").map((f) => f.replace(/^\.\//, ""));
    const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((f) => /(^|\/)(docker-)?compose.*\.ya?ml$/.test(f));
    const fixtures = tracked.filter((f) => isTestFixturePath(f));

    expect(files.sort()).toEqual(tracked.filter((f) => !isTestFixturePath(f)).sort());
    expect(files.length).toBeGreaterThan(0);
    // Non-vacuous: fixtures exist, so the exclusion is doing work rather than
    // filtering an empty set.
    expect(fixtures.length).toBeGreaterThan(0);
    for (const f of fixtures) expect(files).not.toContain(f);
  });

  it("passes on the tree as it stands", () => {
    const out = execFileSync("node", [GATE], { encoding: "utf8" });
    expect(out).toContain("compose log cap guard passed");
  });

  it("gives every allow entry a reviewable reason", () => {
    // Guards the entry list itself: a reason is what makes the exemption
    // reviewable, and an entry without one is indistinguishable from an
    // oversight. The length assertion is only meaningful over a non-empty list —
    // a `for` over `[]` asserts nothing at all.
    expect(OFF_HOST_ALLOW.length).toBeGreaterThan(0);
    for (const entry of OFF_HOST_ALLOW) {
      expect(entry.reason.length).toBeGreaterThan(20);
      expect(entry.file).toMatch(/^(docker-)?compose.*\.ya?ml$/);
    }
  });
});

describe("findAmbiguousDefaults", () => {
  it("refuses a root holding both compose.yaml and docker-compose.yml", () => {
    // Compose reads compose.yaml and ignores the other, so a verdict about
    // "the compose file" would not say which one it is about.
    const clashes = findAmbiguousDefaults(["compose.yaml", "docker-compose.yml"]);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toContain("ambiguous");
  });

  it("refuses two spellings within one family", () => {
    expect(findAmbiguousDefaults(["docker-compose.yml", "docker-compose.yaml"])).toHaveLength(1);
  });

  it("accepts a single default plus any number of overlays", () => {
    expect(
      findAmbiguousDefaults([
        "docker-compose.yml",
        "docker-compose.override.yml",
        "docker-compose.ha.yml",
      ]),
    ).toEqual([]);
  });
});

describe("end-to-end refusals", () => {
  let dir;
  const run = (root) => {
    try {
      const stdout = execFileSync("node", [GATE, root], { encoding: "utf8" });
      return { code: 0, out: stdout };
    } catch (err) {
      return { code: err.status, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  };

  it("refuses an empty directory instead of passing on an empty member set", () => {
    dir = mkdtempSync(join(tmpdir(), "compose-caps-"));
    try {
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("NO_COMPOSE_FILES");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a broken alias instead of reporting zero uncapped services", () => {
    dir = mkdtempSync(join(tmpdir(), "compose-caps-"));
    try {
      writeFileSync(
        join(dir, "docker-compose.yml"),
        BASE_YAML.replace("logging: *default-logging", "logging: *default-loggin"),
      );
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("PARSE_FAILED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reds with a non-zero exit when a fixture service is uncapped", () => {
    dir = mkdtempSync(join(tmpdir(), "compose-caps-"));
    try {
      writeFileSync(join(dir, "docker-compose.yml"), `${BASE_YAML}\n  newsvc:\n    image: x\n`);
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("'newsvc'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans compose.yaml, the name Compose reads in preference to docker-compose.yml", () => {
    // Discovery, not classification: a guard scoped to one spelling would pass
    // here having read nothing.
    dir = mkdtempSync(join(tmpdir(), "compose-caps-"));
    try {
      writeFileSync(join(dir, "compose.yaml"), "services:\n  runaway:\n    image: x\n");
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("'runaway'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a root where two default filenames disagree about which file runs", () => {
    dir = mkdtempSync(join(tmpdir(), "compose-caps-"));
    try {
      writeFileSync(join(dir, "docker-compose.yml"), BASE_YAML);
      writeFileSync(join(dir, "compose.yaml"), BASE_YAML);
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("ambiguous");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries multi-file discovery through the real discover -> parse -> classify chain", () => {
    dir = mkdtempSync(join(tmpdir(), "compose-caps-"));
    try {
      writeFileSync(join(dir, "docker-compose.yml"), BASE_YAML);
      writeFileSync(join(dir, "docker-compose.override.yml"), CAPPED_OVERLAY);
      expect(run(dir).code).toBe(0);

      writeFileSync(
        join(dir, "docker-compose.override.yml"),
        `${CAPPED_OVERLAY}  extra:\n    image: x\n`,
      );
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("'extra'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scans a compose file in a subdirectory, which a root-anchored pathspec missed", () => {
    dir = mkdtempSync(join(tmpdir(), "compose-caps-"));
    try {
      writeFileSync(join(dir, "docker-compose.yml"), BASE_YAML);
      mkdirSync(join(dir, "deploy"));
      writeFileSync(join(dir, "deploy", "docker-compose.yml"), "services:\n  app:\n    image: x\n");
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toContain("deploy/docker-compose.yml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a run that parsed files but examined no service block", () => {
    // A bad edit once left the docs.set() line inside a comment and the gate
    // printed "passed (7 file(s), 0 service block(s))". The file count was
    // non-zero, so NO_COMPOSE_FILES did not catch it.
    dir = mkdtempSync(join(tmpdir(), "compose-caps-"));
    try {
      writeFileSync(join(dir, "docker-compose.yml"), "volumes: {}\n");
      const { code, out } = run(dir);
      expect(code).toBe(1);
      expect(out).toMatch(/NO_SERVICES|no services found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("findViolations refuses an empty set", () => {
  it("does not report a pass when no document was examined", () => {
    // The verdict is computed from `docs`, so the emptiness check belongs on
    // `docs` — not on the file count, which was non-zero when this happened.
    expect(findViolations(new Map())).toHaveLength(1);
    expect(findViolations(new Map())[0]).toContain("refusing to pass on an empty set");
  });
});

describe("parseMaxSize matches the daemon's truncate-then-reject order", () => {
  it("rejects a positive decimal that floors to zero bytes", () => {
    // Measured: `docker run --log-opt max-size=0.1` is refused ("must be at
    // least 1"), as is 0.0000000001g. Checking the coefficient instead of the
    // byte product called both of these capped.
    expect(parseMaxSize("0.1")).toBeNull();
    expect(parseMaxSize("0.0000000001g")).toBeNull();
    expect(parseMaxSize("0.4")).toBeNull();
  });

  it("keeps a decimal that floors to a positive byte count, which the daemon takes", () => {
    expect(parseMaxSize("1.5m")).toBe(1_500_000);
    expect(parseMaxSize("1")).toBe(1);
  });

  it("returns whole bytes, never a fraction", () => {
    // `1.5` and `1.0000001k` are the cases that separate flooring from a bare
    // `>= 1` comparison: both are >= 1 unrounded, so only the floor makes the
    // returned value the byte count the daemon will actually use.
    for (const v of ["20m", "1.5m", "1g", "1024", "1.5", "1.0000001k", "2.7"]) {
      expect(Number.isInteger(parseMaxSize(v)), v).toBe(true);
    }
    expect(parseMaxSize("1.5")).toBe(1);
    expect(parseMaxSize("2.7")).toBe(2);
  });
});

describe("fixture exclusion is a named list, not a directory-name rule", () => {
  it("excludes only the paths it names", () => {
    for (const entry of FIXTURE_ALLOW) expect(isTestFixturePath(entry.path)).toBe(true);
  });

  it("does not excuse a production stack parked under a `fixtures` directory", () => {
    // The earlier path-segment rule made the gate's own exclusion the hole:
    // deploy/fixtures/docker-compose.yml would have been skipped by name.
    expect(isTestFixturePath("deploy/fixtures/docker-compose.yml")).toBe(false);
    expect(isTestFixturePath("deploy/__tests__/docker-compose.yml")).toBe(false);
  });

  it("gives every entry a reason", () => {
    expect(FIXTURE_ALLOW.length).toBeGreaterThan(0);
    for (const entry of FIXTURE_ALLOW) expect(entry.reason.length).toBeGreaterThan(10);
  });

  it("reports an entry that matches no tracked file", () => {
    expect(findStaleFixtureEntries(new Set())).toHaveLength(FIXTURE_ALLOW.length);
    expect(findStaleFixtureEntries(new Set(FIXTURE_ALLOW.map((f) => f.path)))).toEqual([]);
  });
});

describe("findAmbiguousDefaults groups by directory", () => {
  it("detects a collision below the repo root", () => {
    // Recursive discovery changed the inputs from basenames to paths; comparing
    // them against bare basenames stopped detecting anything but the root.
    const clashes = findAmbiguousDefaults(["deploy/compose.yaml", "deploy/docker-compose.yml"]);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toContain("deploy/compose.yaml");
    expect(clashes[0]).toContain("deploy/docker-compose.yml");
  });

  it("does not pair default names that live in different directories", () => {
    // Two stacks in two directories are two stacks, not an ambiguity.
    expect(findAmbiguousDefaults(["compose.yaml", "deploy/docker-compose.yml"])).toEqual([]);
  });
});
