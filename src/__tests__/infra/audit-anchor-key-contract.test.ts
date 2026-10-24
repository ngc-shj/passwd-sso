/**
 * The anchors bucket policy's manifest pattern against the key the publisher
 * really writes. Both copies of the pattern — the publisher-only statement's
 * Resource and the catch-all's NotResource — are read from the rendered policy
 * and matched the way S3 matches a policy resource (`?` one character, `*` any
 * sequence including `/`) against buildManifestArtifactKey's output for a real
 * kid, joined to the configured prefix by S3Destination's joinS3Key.
 */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifestArtifactKey } from "@/workers/audit-anchor-publisher";
import { joinS3Key } from "@/lib/audit/anchor-destinations/s3-destination";
import { TerraformConfig, TERRAFORM_DIR, plain } from "../helpers/hcl-subset";

const BUCKET_ARN = "<ref:aws_s3_bucket.audit_anchors[0].arn>";

/** An S3 policy resource pattern as a RegExp over the whole ARN. */
function s3PatternToRegExp(pattern: string): RegExp {
  const body = [...pattern]
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\/]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "s");
}

/** A kid as scripts/audit-anchor-publisher.ts derives it: the public key's first 8 bytes. */
function realKid(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12);
  return `audit-anchor-${raw.subarray(0, 8).toString("hex")}`;
}

type Statement = { Sid: string; Resource?: string | string[]; NotResource?: string | string[] };

function list(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

const BOUNDARIES = [
  new Date("2026-01-15T00:05:00.000Z"),
  new Date("2026-10-04T00:05:00.000Z"),
  new Date("2027-12-31T00:05:00.000Z"),
];

function keyContractViolations(tf: TerraformConfig): string[] {
  const out: string[] = [];
  const policy = plain(tf.attr(tf.resource("aws_s3_bucket_policy", "audit_anchors"), "policy")) as { Statement: Statement[] };
  const bySid = (sid: string) => policy.Statement.find((s) => s.Sid === sid);
  const publisherOnly = list(bySid("DenyManifestWriteExceptPublisher")?.Resource);
  const breakGlass = list(bySid("DenyBreakGlassPathWriteExceptOperator")?.Resource);
  const catchAll = list(bySid("DenyPutOutsideAnchorPaths")?.NotResource);
  if (publisherOnly.length !== 1) return [`publisher-only statement: ${publisherOnly.length} resources`];
  if (breakGlass.length !== 2) return [`break-glass statement: ${breakGlass.length} resources`];

  const catchAllManifest = catchAll.filter((r) => !breakGlass.includes(r));
  if (catchAll.length !== 3 || catchAllManifest.length !== 1 || breakGlass.some((r) => !catchAll.includes(r))) {
    out.push(`catch-all NotResource is not [manifest, both break-glass paths]: ${JSON.stringify(catchAll)}`);
  }
  if (catchAllManifest[0] !== publisherOnly[0]) {
    out.push(`the two manifest copies differ: ${publisherOnly[0]} vs ${String(catchAllManifest[0])}`);
  }

  const prefix = tf.evalText("module.anchor_prefix.prefix") as string;
  const kid = realKid();
  const breakGlassKeys = [
    joinS3Key(prefix, "key-rotation-2026-01-15.json"),
    joinS3Key(prefix, `key-rotation-${kid}.jws`),
    joinS3Key(prefix, `public-keys/${kid}.pem`),
  ];
  for (const [name, copy] of [["publisher-only Resource", publisherOnly[0]], ["catch-all NotResource", catchAllManifest[0]]] as const) {
    if (copy === undefined) continue;
    const re = s3PatternToRegExp(copy);
    for (const boundary of BOUNDARIES) {
      const key = joinS3Key(prefix, buildManifestArtifactKey(boundary, kid));
      if (!re.test(`${BUCKET_ARN}/${key}`)) out.push(`${name} ${copy} does not match the published key ${key}`);
    }
    for (const key of breakGlassKeys) {
      if (re.test(`${BUCKET_ARN}/${key}`)) out.push(`${name} ${copy} matches the break-glass key ${key}`);
    }
  }
  // And the reverse: no manifest key falls under a break-glass path.
  for (const pattern of breakGlass) {
    const key = joinS3Key(prefix, buildManifestArtifactKey(BOUNDARIES[0], kid));
    if (s3PatternToRegExp(pattern).test(`${BUCKET_ARN}/${key}`)) out.push(`break-glass ${pattern} matches the manifest key ${key}`);
  }
  return out;
}

function edited(from: string, to: string, nth = 0): TerraformConfig {
  const text = readFileSync(join(TERRAFORM_DIR, "storage.tf"), "utf8");
  const parts = text.split(from);
  expect(parts.length - 1, `fixture edit must match in storage.tf: ${from}`).toBeGreaterThan(nth);
  const replaced = parts.slice(0, nth + 1).join(from) + to + parts.slice(nth + 1).join(from);
  return new TerraformConfig(TERRAFORM_DIR, { "storage.tf": replaced });
}

describe("S3 policy wildcard semantics", () => {
  it("matches ? to exactly one character", () => {
    expect(s3PatternToRegExp("a/?b").test("a/xb")).toBe(true);
    expect(s3PatternToRegExp("a/?b").test("a/b")).toBe(false);
    expect(s3PatternToRegExp("a/?b").test("a/xyb")).toBe(false);
  });

  it("matches * to any sequence, including / and the empty one", () => {
    expect(s3PatternToRegExp("a/*.jws").test("a/x/y.jws")).toBe(true);
    expect(s3PatternToRegExp("a/*.jws").test("a/.jws")).toBe(true);
    expect(s3PatternToRegExp("a/*.jws").test("a/x.json")).toBe(false);
  });

  it("treats every other character literally", () => {
    expect(s3PatternToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("manifest key contract", () => {
  it("holds for the committed policy", () => {
    expect(keyContractViolations(new TerraformConfig(TERRAFORM_DIR))).toEqual([]);
  });

  it("matches the key under a configured prefix, through the same module output", () => {
    const tf = new TerraformConfig(TERRAFORM_DIR, {
      "variables.tf": readFileSync(join(TERRAFORM_DIR, "variables.tf"), "utf8").replace(
        'default     = "audit-anchors"',
        'default     = "env/prod.anchors"',
      ),
    });
    expect(tf.evalText("module.anchor_prefix.prefix")).toBe("env/prod.anchors");
    expect(keyContractViolations(tf)).toEqual([]);
  });

  it("catches a YYYYMMDD date in the pattern", () => {
    const tf = edited(
      'audit_anchor_manifest_pattern = "${local.audit_anchor_prefix}/????-??-??.kid-*.jws"',
      'audit_anchor_manifest_pattern = "${local.audit_anchor_prefix}/????????.kid-*.jws"',
    );
    expect(keyContractViolations(tf).join("\n")).toMatch(/does not match the published key/);
  });

  it("catches a pattern without the prefix", () => {
    const tf = edited(
      'audit_anchor_manifest_pattern = "${local.audit_anchor_prefix}/????-??-??.kid-*.jws"',
      'audit_anchor_manifest_pattern = "????-??-??.kid-*.jws"',
    );
    expect(keyContractViolations(tf).join("\n")).toMatch(/does not match the published key/);
  });

  it("catches only the NotResource copy changed", () => {
    // The second occurrence of the manifest resource is the catch-all's.
    const tf = edited(
      '"${aws_s3_bucket.audit_anchors[0].arn}/${local.audit_anchor_manifest_pattern}"',
      '"${aws_s3_bucket.audit_anchors[0].arn}/${local.audit_anchor_prefix}/*.jws"',
      1,
    );
    const violations = keyContractViolations(tf).join("\n");
    expect(violations).toMatch(/the two manifest copies differ/);
  });

  it("catches a manifest pattern wide enough to cover a break-glass path", () => {
    const tf = edited(
      'audit_anchor_manifest_pattern = "${local.audit_anchor_prefix}/????-??-??.kid-*.jws"',
      'audit_anchor_manifest_pattern = "${local.audit_anchor_prefix}/*.jws"',
    );
    expect(keyContractViolations(tf).join("\n")).toMatch(/matches the break-glass key/);
  });
});
