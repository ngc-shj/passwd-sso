/**
 * The anchors bucket policy's manifest pattern against the key the publisher
 * really writes. Both copies of the pattern — the publisher-only statement's
 * Resource and the catch-all's NotResource — are read from the rendered policy
 * and matched the way S3 matches a policy resource (`?` one character, `*` any
 * sequence including `/`) against buildManifestArtifactKey's output for a real
 * kid, joined to the configured prefix by S3Destination's joinS3Key.
 *
 * Also the retention contract: the publisher's retain-until, from
 * AUDIT_ANCHOR_RETENTION_YEARS as S3Destination computes it, against the
 * bucket's default retention, its validation floor and the policy's cap.
 */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  STATEMENT_OP,
  buildManifestArtifactKey,
  publicKeyArtifactKey,
  statementArtifactKey,
} from "@/lib/audit/anchor-artifact-keys";
import { kidForPublicKey } from "@/lib/audit/anchor-manifest";
import { joinS3Key, s3ListPrefix } from "@/lib/audit/anchor-destinations/s3-destination";
import { AUDIT_ANCHOR_RETENTION_YEARS } from "@/lib/constants/audit/audit";
import { TerraformConfig, TERRAFORM_DIR, nested, plain } from "../helpers/hcl-subset";

const BUCKET_ARN = "<ref:aws_s3_bucket.audit_anchors[0].arn>";

/** An S3 policy resource pattern as a RegExp over the whole ARN. */
function s3PatternToRegExp(pattern: string): RegExp {
  const body = [...pattern]
    .map((c) => (c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\/]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}$`, "s");
}

/** The kid of a fresh key, as the publisher derives it. */
function realKid(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return kidForPublicKey((publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(12));
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
    joinS3Key(prefix, publicKeyArtifactKey(kid)),
    ...Object.values(STATEMENT_OP).flatMap((op) =>
      BOUNDARIES.map((day) => joinS3Key(prefix, statementArtifactKey(day, op, kid))),
    ),
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
  // The break-glass paths cover every key the scripts write, and no manifest key.
  for (const key of breakGlassKeys) {
    if (!breakGlass.some((pattern) => s3PatternToRegExp(pattern).test(`${BUCKET_ARN}/${key}`))) {
      out.push(`no break-glass path matches the script-written key ${key}`);
    }
  }
  for (const pattern of breakGlass) {
    const key = joinS3Key(prefix, buildManifestArtifactKey(BOUNDARIES[0], kid));
    if (s3PatternToRegExp(pattern).test(`${BUCKET_ARN}/${key}`)) out.push(`break-glass ${pattern} matches the manifest key ${key}`);
  }
  return out;
}

/** `s3:prefix` under StringLike: `*` any sequence, `?` one character, over the whole value. */
function stringLikeMatches(pattern: string, value: string): boolean {
  return s3PatternToRegExp(pattern).test(value);
}

/**
 * The publisher role's ListBucket condition against the prefixes S3Destination
 * lists under: `listPrefix` (list) and a full key (read's existence check).
 * `listPrefix` is a parameter so a red case can pass a wrong one.
 */
function listConditionViolations(tf: TerraformConfig, listPrefix: (prefix: string) => string): string[] {
  const out: string[] = [];
  const policy = plain(tf.attr(tf.resource("aws_iam_role_policy", "ecs_audit_anchor_publisher_s3"), "policy")) as {
    Statement: { Action: string | string[]; Condition?: { StringLike?: { "s3:prefix"?: string | string[] } } }[];
  };
  const statement = policy.Statement.find((s) => list(s.Action).includes("s3:ListBucket"));
  const patterns = list(statement?.Condition?.StringLike?.["s3:prefix"]);
  if (patterns.length !== 1) return [`ListBucket s3:prefix condition: ${patterns.length} patterns`];

  const prefix = tf.evalText("module.anchor_prefix.prefix") as string;
  const kid = realKid();
  const accepted = [
    listPrefix(prefix),
    joinS3Key(prefix, buildManifestArtifactKey(BOUNDARIES[0], kid)),
    joinS3Key(prefix, publicKeyArtifactKey(kid)),
  ];
  for (const value of accepted) {
    if (!stringLikeMatches(patterns[0], value)) out.push(`s3:prefix ${patterns[0]} does not admit ${JSON.stringify(value)}`);
  }
  // Prefixes outside the anchor prefix, including the bucket root and a sibling sharing its leading characters.
  for (const value of ["", `${prefix}x/`, "other-prefix/"]) {
    if (stringLikeMatches(patterns[0], value)) out.push(`s3:prefix ${patterns[0]} admits ${JSON.stringify(value)}`);
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

describe("publisher ListBucket condition", () => {
  const real = () => new TerraformConfig(TERRAFORM_DIR);
  const editedIam = (from: string, to: string) => {
    const text = readFileSync(join(TERRAFORM_DIR, "iam.tf"), "utf8");
    expect(text.split(from).length - 1, `fixture edit must match once in iam.tf: ${from}`).toBe(1);
    return new TerraformConfig(TERRAFORM_DIR, { "iam.tf": text.replace(from, to) });
  };

  it("admits the list prefix and a full key under it, and nothing outside", () => {
    expect(listConditionViolations(real(), s3ListPrefix)).toEqual([]);
  });

  it("admits them under a configured prefix, through the same module output", () => {
    const tf = new TerraformConfig(TERRAFORM_DIR, {
      "variables.tf": readFileSync(join(TERRAFORM_DIR, "variables.tf"), "utf8").replace(
        'default     = "audit-anchors"',
        'default     = "env/prod.anchors"',
      ),
    });
    expect(listConditionViolations(tf, s3ListPrefix)).toEqual([]);
  });

  it("catches a list prefix without the trailing slash", () => {
    expect(listConditionViolations(real(), (prefix) => prefix).join("\n")).toMatch(/does not admit/);
  });

  it("catches a condition widened past the prefix", () => {
    const tf = editedIam('"s3:prefix" = "${local.audit_anchor_prefix}/*"', '"s3:prefix" = "${local.audit_anchor_prefix}*"');
    expect(listConditionViolations(tf, s3ListPrefix).join("\n")).toMatch(/admits/);
  });

  it("catches a condition that no longer admits a full key", () => {
    const tf = editedIam('"s3:prefix" = "${local.audit_anchor_prefix}/*"', '"s3:prefix" = "${local.audit_anchor_prefix}/"');
    expect(listConditionViolations(tf, s3ListPrefix).join("\n")).toMatch(/does not admit/);
  });
});

/**
 * S3Destination locks every anchor until `now + retentionYears * 365 *
 * MS_PER_DAY`, so its retain-until is `years * 365` days ahead. A retain-until
 * computed from a 366-day year must still pass the policy's cap.
 */
function retentionContractViolations(tf: TerraformConfig, years: number): string[] {
  const out: string[] = [];
  const publisherDays = years * 365;
  const variable = tf.variable("audit_anchor_object_lock_days");
  const defaultDays = Number(tf.eval(variable.body.attrs.default));
  if (!(publisherDays <= defaultDays)) {
    out.push(`default retention ${defaultDays} days is below the publisher's ${publisherDays}`);
  }
  const validation = nested(variable, "validation")[0];
  if (!validation) return [...out, "audit_anchor_object_lock_days: no validation"];
  const admits = (days: number) => tf.attr(validation, "condition", { vars: { audit_anchor_object_lock_days: days } });
  if (admits(publisherDays - 1) !== false) {
    out.push(`validation admits ${publisherDays - 1} days, below the publisher's ${publisherDays}`);
  }
  if (admits(defaultDays) !== true) out.push(`validation refuses the default ${defaultDays}`);
  const capDays = Number(tf.local("audit_anchor_retention_cap_days"));
  if (!(years * 366 <= capDays)) {
    out.push(`retention cap ${capDays} days refuses a ${years} × 366-day retain-until`);
  }
  return out;
}

describe("retention contract", () => {
  const variables = readFileSync(join(TERRAFORM_DIR, "variables.tf"), "utf8");
  const withVariables = (from: string, to: string) => {
    expect(variables.split(from).length - 1, `fixture edit must match once: ${from}`).toBe(1);
    return new TerraformConfig(TERRAFORM_DIR, { "variables.tf": variables.replace(from, to) });
  };

  it("holds for the committed configuration and AUDIT_ANCHOR_RETENTION_YEARS", () => {
    expect(retentionContractViolations(new TerraformConfig(TERRAFORM_DIR), AUDIT_ANCHOR_RETENTION_YEARS)).toEqual([]);
  });

  it("catches a publisher retention raised past the bucket's", () => {
    expect(retentionContractViolations(new TerraformConfig(TERRAFORM_DIR), AUDIT_ANCHOR_RETENTION_YEARS + 1).join("\n"))
      .toMatch(/is below the publisher's/);
  });

  it("catches a validation floor below the publisher's retention", () => {
    const tf = withVariables(
      "condition     = var.audit_anchor_object_lock_days >= 2557",
      "condition     = var.audit_anchor_object_lock_days >= 365",
    );
    expect(retentionContractViolations(tf, AUDIT_ANCHOR_RETENTION_YEARS).join("\n")).toMatch(/validation admits/);
  });

  it("catches a cap margin too small for a 366-day year", () => {
    const tf = new TerraformConfig(TERRAFORM_DIR, {
      "storage.tf": readFileSync(join(TERRAFORM_DIR, "storage.tf"), "utf8").replace(
        "var.audit_anchor_object_lock_days + 31",
        "var.audit_anchor_object_lock_days + 1",
      ),
    });
    expect(retentionContractViolations(tf, AUDIT_ANCHOR_RETENTION_YEARS).join("\n")).toMatch(/retention cap/);
  });
});

// The bucket policy refuses a PutObject that creates an object without
// If-None-Match (DenyUnconditionalPut). That binds the code: the one request
// that writes the anchors bucket must carry the header on every send.

const REPO_ROOT = join(TERRAFORM_DIR, "..", "..");
const S3_DESTINATION_SOURCE = "src/lib/audit/anchor-destinations/s3-destination.ts";
// What writes an S3 object: a PUT, a copy, a multipart upload, the upload helper.
const S3_WRITE_RE = /\b(PutObjectCommand|CopyObjectCommand|CreateMultipartUploadCommand|UploadPartCommand)\b|@aws-sdk\/lib-storage/;
// The attachments bucket's writer; it never names the anchors bucket.
const OTHER_S3_WRITERS = ["src/lib/blob-store/s3-blob-store.ts"];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "__tests__" && entry.name !== "node_modules") sourceFiles(path, out);
    } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(path);
    }
  }
  return out;
}

function conditionalWriteViolations(tf: TerraformConfig, destinationSource: string): string[] {
  const out: string[] = [];
  const policy = plain(tf.attr(tf.resource("aws_s3_bucket_policy", "audit_anchors"), "policy")) as {
    Statement: Array<{ Sid?: string; Condition?: Record<string, Record<string, unknown>> }>;
  };
  const deny = policy.Statement.find((s) => s.Sid === "DenyUnconditionalPut");
  // s3:if-none-match is the condition key of the If-None-Match request header.
  if (deny?.Condition?.Null?.["s3:if-none-match"] !== "true") {
    out.push("policy: no Deny on a PutObject whose s3:if-none-match is null");
  }
  // IfExists: plain Bool is false on a request that does not carry the key,
  // so the Deny would apply to nothing and say nothing.
  if (deny?.Condition?.BoolIfExists?.["s3:ObjectCreationOperation"] !== "true" || deny.Condition.Bool !== undefined) {
    out.push("policy: the Deny's object-creation test is not BoolIfExists");
  }
  const puts = [...destinationSource.matchAll(/new PutObjectCommand\(\{([\s\S]*?)\}\)/g)].map((m) => m[1]);
  if (puts.length !== 1) out.push(`destination: ${puts.length} PutObjectCommand literals, expected 1`);
  for (const put of puts) {
    if (!/^\s*IfNoneMatch: "\*",$/m.test(put)) out.push("destination: a PutObjectCommand without IfNoneMatch: \"*\"");
  }
  return out;
}

describe("conditional-write contract", () => {
  const destinationSource = readFileSync(join(REPO_ROOT, S3_DESTINATION_SOURCE), "utf8");
  const storage = readFileSync(join(TERRAFORM_DIR, "storage.tf"), "utf8");

  it("holds: the policy denies a PUT without If-None-Match, and the destination's one PUT sends it", () => {
    expect(conditionalWriteViolations(new TerraformConfig(TERRAFORM_DIR), destinationSource)).toEqual([]);
  });

  it("catches a destination PUT that drops the header", () => {
    const header = '            IfNoneMatch: "*",\n';
    expect(destinationSource.split(header).length - 1).toBe(1);
    expect(conditionalWriteViolations(new TerraformConfig(TERRAFORM_DIR), destinationSource.replace(header, ""))).toEqual([
      'destination: a PutObjectCommand without IfNoneMatch: "*"',
    ]);
  });

  it("catches a second PUT in the destination", () => {
    const second = `${destinationSource}\nexport const second = new PutObjectCommand({ Bucket: "b", Key: "k" });\n`;
    expect(conditionalWriteViolations(new TerraformConfig(TERRAFORM_DIR), second)).toEqual([
      "destination: 2 PutObjectCommand literals, expected 1",
      'destination: a PutObjectCommand without IfNoneMatch: "*"',
    ]);
  });

  it("catches a policy whose Deny is on another condition key", () => {
    const key = 'Null         = { "s3:if-none-match" = "true" }';
    expect(storage.split(key).length - 1).toBe(1);
    const tf = new TerraformConfig(TERRAFORM_DIR, { "storage.tf": storage.replace(key, 'Null = { "s3:if-match" = "true" }') });
    expect(conditionalWriteViolations(tf, destinationSource)).toEqual([
      "policy: no Deny on a PutObject whose s3:if-none-match is null",
    ]);
  });

  it("catches a policy whose object-creation test is a plain Bool", () => {
    const operator = 'BoolIfExists = { "s3:ObjectCreationOperation" = "true" }';
    expect(storage.split(operator).length - 1).toBe(1);
    const tf = new TerraformConfig(TERRAFORM_DIR, {
      "storage.tf": storage.replace(operator, 'Bool = { "s3:ObjectCreationOperation" = "true" }'),
    });
    expect(conditionalWriteViolations(tf, destinationSource)).toEqual([
      "policy: the Deny's object-creation test is not BoolIfExists",
    ]);
  });

  it("no other source writes an S3 object but the attachments blob store", () => {
    const writers = [...sourceFiles("src"), ...sourceFiles("scripts")].filter((file) =>
      S3_WRITE_RE.test(readFileSync(join(REPO_ROOT, file), "utf8")),
    );
    expect(writers.sort()).toEqual([S3_DESTINATION_SOURCE, ...OTHER_S3_WRITERS].sort());
  });
});
