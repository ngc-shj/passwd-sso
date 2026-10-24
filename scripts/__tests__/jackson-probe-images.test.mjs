/**
 * Drift test for the C1 probe's image list (#742).
 *
 * ci-integration.yml's `jackson-probe` matrix is the one place the probed
 * Jackson versions and their digests are pinned. It must equal the set of
 * Jackson versions the repo deploys: the image tag in docker-compose.yml, and
 * the ECR re-tags in every terraform.tfvars.example (`...-jackson:v<x>` is a
 * re-tag of upstream `boxyhq/jackson:<x>`). A version bump in either place that
 * leaves the matrix behind would keep CI green while probing an image nobody
 * runs.
 *
 * A digest cannot be tied to its version offline; the probe does that at run
 * time by asserting the server's reported version. Here each entry's reference
 * must carry its own version as the tag next to a full digest, so the two
 * cannot be edited apart without this test noticing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

const ROOT = process.cwd();
const WORKFLOW = ".github/workflows/ci-integration.yml";
const TFVARS_ROOT = "infra/terraform";
const IMAGE_REF = /^boxyhq\/jackson:(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$/;
const TFVARS_JACKSON_IMAGE = /^\s*jackson_image\s*=\s*"([^"]*)"/gm;
const ECR_RETAG = /-jackson:v(\d+\.\d+\.\d+)$/;

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

function findTfvarsExamples(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === ".terraform" ? [] : findTfvarsExamples(rel);
    return entry.name === "terraform.tfvars.example" ? [rel] : [];
  });
}

/** Upstream Jackson versions the compose file and tfvars examples reference. */
function referencedVersions(composeText, tfvarsTexts) {
  const compose = load(composeText);
  const composeImage = compose?.services?.jackson?.image;
  const composeMatch = /^boxyhq\/jackson:(\d+\.\d+\.\d+)$/.exec(composeImage ?? "");
  if (!composeMatch) throw new Error(`docker-compose.yml services.jackson.image is not boxyhq/jackson:<x.y.z>: ${composeImage}`);
  const versions = new Set([composeMatch[1]]);
  for (const [name, text] of Object.entries(tfvarsTexts)) {
    const images = [...text.matchAll(TFVARS_JACKSON_IMAGE)].map((m) => m[1]);
    if (images.length !== 1) throw new Error(`${name}: expected one jackson_image, found ${images.length}`);
    const retag = ECR_RETAG.exec(images[0]);
    if (!retag) throw new Error(`${name}: jackson_image is not an ECR re-tag '...-jackson:v<x.y.z>': ${images[0]}`);
    versions.add(retag[1]);
  }
  return [...versions].sort();
}

function probeJob() {
  return load(read(WORKFLOW)).jobs["jackson-probe"];
}

describe("jackson-probe image list", () => {
  const tfvarsFiles = findTfvarsExamples(TFVARS_ROOT);
  const tfvarsTexts = Object.fromEntries(tfvarsFiles.map((f) => [f, read(f)]));

  it("finds the three terraform.tfvars.example files", () => {
    // Fail loud if the walk stops seeing them: an empty set would derive only
    // the compose version and still match a one-entry matrix.
    expect(tfvarsFiles.sort()).toEqual([
      "infra/terraform/envs/dev/terraform.tfvars.example",
      "infra/terraform/envs/prod/terraform.tfvars.example",
      "infra/terraform/terraform.tfvars.example",
    ]);
  });

  it("matrix versions equal the versions the compose file and tfvars examples reference", () => {
    const matrixVersions = probeJob().strategy.matrix.include.map((e) => e.jackson).sort();
    expect(matrixVersions).toEqual(referencedVersions(read("docker-compose.yml"), tfvarsTexts));
  });

  it("each matrix image is boxyhq/jackson:<its version>@sha256:<digest>, digests distinct", () => {
    const entries = probeJob().strategy.matrix.include;
    for (const entry of entries) {
      const m = IMAGE_REF.exec(entry.image);
      expect(m, entry.image).not.toBeNull();
      expect(m?.[1]).toBe(entry.jackson);
    }
    const digests = entries.map((e) => e.image.split("@")[1]);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("the probe driver image is the matrix entry for the docker-compose.yml version", () => {
    const job = probeJob();
    const composeVersion = /:(\d+\.\d+\.\d+)$/.exec(load(read("docker-compose.yml")).services.jackson.image)?.[1];
    const entry = job.strategy.matrix.include.find((e) => e.jackson === composeVersion);
    expect(entry).toBeDefined();
    expect(job.env.PROBE_DRIVER_IMAGE).toBe(entry?.image);
  });

  it("derivation picks up a bumped compose tag or re-tag (adjacent deny)", () => {
    const compose = read("docker-compose.yml");
    const base = referencedVersions(compose, tfvarsTexts);
    const bumpedCompose = compose.replace(/boxyhq\/jackson:\d+\.\d+\.\d+/, "boxyhq/jackson:9.9.9");
    expect(referencedVersions(bumpedCompose, tfvarsTexts)).toContain("9.9.9");
    const [first] = Object.keys(tfvarsTexts);
    const bumpedTf = { ...tfvarsTexts, [first]: tfvarsTexts[first].replace(/-jackson:v\d+\.\d+\.\d+/, "-jackson:v8.8.8") };
    expect(referencedVersions(compose, bumpedTf)).toContain("8.8.8");
    expect(base).not.toContain("8.8.8");
  });

  it("refuses a tfvars jackson_image that is not a v<x> re-tag", () => {
    expect(() =>
      referencedVersions(read("docker-compose.yml"), { "x.tfvars": 'jackson_image = "repo/passwd-sso-dev-jackson:latest"\n' }),
    ).toThrow(/not an ECR re-tag/);
  });
});
