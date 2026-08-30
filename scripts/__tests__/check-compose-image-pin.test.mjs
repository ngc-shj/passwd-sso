/**
 * RT7 self-test for check-compose-image-pin.mjs.
 *
 * The guard's value is going red when a compose image resolves to `latest`, so
 * both spellings of that are mutated here and asserted to fail — the explicit
 * tag and the absent one, which Docker fills in and a `grep ':latest'` never
 * sees. The allow side is asserted just as hard: this repo runs three
 * deliberate floating MINOR tags, and a guard that reds on those would be
 * relaxed by whoever hit it first.
 *
 * The refusals are separated from the violations on purpose. A gate that exits
 * non-zero because it could not parse anything looks exactly like one that
 * found a defect, and the pre-pr log shows only the exit code.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseImageRef,
  judgeImageRef,
  collectImageRefs,
  findViolations,
} from "../checks/check-compose-image-pin.mjs";

const GATE = join(process.cwd(), "scripts/checks/check-compose-image-pin.mjs");

function runGate(files) {
  const dir = mkdtempSync(join(tmpdir(), "compose-pin-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      const path = join(dir, name);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body);
    }
    let stdout = "";
    let stderr = "";
    let status = 0;
    try {
      stdout = execFileSync("node", [GATE], {
        encoding: "utf8",
        env: {
          ...process.env,
          COMPOSE_IMAGE_PIN_ROOT: dir,
          COMPOSE_IMAGE_PIN_FIXTURE_MODE: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      status = e.status ?? 1;
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
    }
    return {
      status,
      stdout,
      stderr,
      // A refusal and a violation both exit non-zero. Telling them apart is the
      // whole point of asserting on the message rather than the code.
      refused: /NO_COMPOSE_FILES|NO_IMAGE_REFERENCES|PARSE_FAILED/.test(stderr),
      violated: /resolve to 'latest'/.test(stderr),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const svc = (image) => `services:\n  x:\n    image: ${image}\n`;

describe("check-compose-image-pin", () => {
  describe("judgeImageRef", () => {
    it.each([
      ["an explicit latest tag", "axllent/mailpit:latest"],
      ["a bare name with no tag", "axllent/mailpit"],
      ["a bare official image", "redis"],
      ["a registry-qualified name with no tag", "ghcr.io/org/thing"],
      // The colon that is a PORT, not a tag. Splitting on the first colon
      // would read "5000/mailpit" as the tag and call it pinned.
      ["a registry with a port and no tag", "localhost:5000/mailpit"],
    ])("rejects %s", (_label, ref) => {
      expect(judgeImageRef(ref)).toMatch(/LATEST/);
    });

    it.each([
      // The three floating MINOR tags this repo actually runs. If the predicate
      // were "fully pinned" these would red on day one.
      ["a floating minor tag", "redis:7-alpine"],
      ["a floating minor tag on postgres", "postgres:16-alpine"],
      ["a floating minor tag on fluent-bit", "fluent/fluent-bit:3.2"],
      ["an exact version", "axllent/mailpit:v1.31.0"],
      ["a dated release tag", "minio/minio:RELEASE.2024-10-13T13-34-11Z"],
      ["a digest", "redis@sha256:" + "a".repeat(64)],
      ["a digest alongside a tag", "redis:latest@sha256:" + "a".repeat(64)],
      // A tag is case-sensitive to the daemon: LATEST is a different tag.
      ["an uppercase LATEST, which is a different tag", "redis:LATEST"],
    ])("accepts %s", (_label, ref) => {
      expect(judgeImageRef(ref)).toBeNull();
    });

    it("refuses an interpolated tag rather than assuming it is safe", () => {
      expect(judgeImageRef("mailpit:${MAILPIT_TAG}")).toMatch(/UNRESOLVABLE_TAG/);
      expect(judgeImageRef("${MAILPIT_IMAGE}")).toMatch(/UNRESOLVABLE_TAG/);
    });
  });

  describe("parseImageRef", () => {
    it("does not read a registry port as a tag", () => {
      expect(parseImageRef("localhost:5000/mailpit")).toEqual({
        name: "localhost:5000/mailpit",
        tag: null,
        digest: null,
      });
    });

    it("reads the tag from the last segment only", () => {
      expect(parseImageRef("localhost:5000/mailpit:v1.31.0")).toEqual({
        name: "localhost:5000/mailpit",
        tag: "v1.31.0",
        digest: null,
      });
    });
  });

  describe("collectImageRefs", () => {
    it("reaches an image parked outside services", () => {
      // The shape in docker-compose.ha.yml: the sentinel image lives on a
      // top-level `x-sentinel` anchor and three services take it via `<<:`.
      // A services.*.image walk steps straight over it.
      const doc = {
        "x-sentinel": { image: "redis:7-alpine" },
        services: { app: { build: "." } },
      };
      expect(collectImageRefs(doc)).toEqual([
        { where: "x-sentinel.image", ref: "redis:7-alpine" },
      ]);
    });

    it("ignores a non-string image key", () => {
      expect(collectImageRefs({ services: { a: { image: { not: "a ref" } } } })).toEqual([]);
    });
  });

  describe("findViolations", () => {
    it("counts every reference it judged, so an empty scan is distinguishable", () => {
      const { violations, refCount } = findViolations([
        { file: "a.yml", doc: { services: { a: { image: "redis:7-alpine" } } } },
        { file: "b.yml", doc: { services: { b: { image: "redis" } } } },
      ]);
      expect(refCount).toBe(2);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("b.yml");
    });
  });

  describe("end to end", () => {
    it("PASSES a tree whose images all carry a bounded tag", () => {
      const r = runGate({ "docker-compose.yml": svc("redis:7-alpine") });
      expect(r.refused).toBe(false);
      expect(r.violated).toBe(false);
      expect(r.status).toBe(0);
    });

    it("FAILS an explicit :latest", () => {
      const r = runGate({ "docker-compose.yml": svc("axllent/mailpit:latest") });
      expect(r.violated).toBe(true);
      expect(r.refused).toBe(false);
      expect(r.status).not.toBe(0);
    });

    it("FAILS an untagged image, which grep ':latest' cannot see", () => {
      const body = svc("axllent/mailpit");
      expect(body).not.toContain(":latest");
      const r = runGate({ "docker-compose.yml": body });
      expect(r.violated).toBe(true);
      expect(r.stderr).toMatch(/IMPLICIT_LATEST/);
      expect(r.status).not.toBe(0);
    });

    it("FAILS an image reached only through a merge key", () => {
      // js-yaml 5's CORE_SCHEMA drops !!merge, so a loader that did not re-add
      // the tag would see a literal '<<' key here and report OK.
      const r = runGate({
        "docker-compose.yml": `x-sentinel: &sentinel
  image: redis:latest
services:
  sentinel-1:
    <<: *sentinel
`,
      });
      expect(r.violated).toBe(true);
      expect(r.status).not.toBe(0);
    });

    it("REFUSES when the tree holds no compose file", () => {
      const r = runGate({ "README.md": "nothing here" });
      expect(r.refused).toBe(true);
      expect(r.violated).toBe(false);
      expect(r.stderr).toMatch(/NO_COMPOSE_FILES/);
    });

    it("REFUSES when compose files carry no image at all", () => {
      const r = runGate({
        "docker-compose.yml": "services:\n  app:\n    build: .\n",
      });
      expect(r.refused).toBe(true);
      expect(r.violated).toBe(false);
      expect(r.stderr).toMatch(/NO_IMAGE_REFERENCES/);
    });

    it("REFUSES a scan-scope override in CI without fixture mode", () => {
      let status = 0;
      let stderr = "";
      try {
        execFileSync("node", [GATE], {
          encoding: "utf8",
          env: {
            ...process.env,
            CI: "true",
            COMPOSE_IMAGE_PIN_ROOT: tmpdir(),
            COMPOSE_IMAGE_PIN_FIXTURE_MODE: "",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        status = e.status ?? 1;
        stderr = e.stderr ?? "";
      }
      expect(status).not.toBe(0);
      expect(stderr).toMatch(/must not be set in CI/);
    });
  });

  it("is wired into scripts/pre-pr.sh", () => {
    const prepr = execFileSync("cat", ["scripts/pre-pr.sh"], { encoding: "utf8" });
    expect(prepr).toContain("check-compose-image-pin.mjs");
  });
});
