/**
 * The anchor S3 prefix rule is stated twice — the Terraform variable
 * validation in infra/terraform/modules/anchor-prefix and the Zod schema in
 * src/lib/env-schema.ts — and both are driven by one vector file. This file
 * runs the Zod column, and pins the module's .tftest.hcl runs to the
 * Terraform column; the terraform CI job runs those runs and requires the
 * passed count to equal that column's size
 * (scripts/checks/check-terraform-test-count.mjs).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auditAnchorPublisherEnvSchema, isValidAnchorS3Prefix } from "@/lib/env-schema";
import { parseHcl, evaluate, nested, TERRAFORM_DIR, type HclBody } from "../helpers/hcl-subset";

const MODULE_DIR = join(TERRAFORM_DIR, "modules/anchor-prefix");
const PREFIX_ENV = "AUDIT_ANCHOR_DESTINATION_S3_PREFIX";

type Verdict = "allow" | "deny";
type Vector = { value: string | null; terraform: Verdict | "n/a"; zod: Verdict };

const VECTORS = (JSON.parse(readFileSync(join(MODULE_DIR, "prefix-vectors.json"), "utf8")) as { vectors: Vector[] }).vectors;
const TFTEST = readFileSync(join(MODULE_DIR, "tests/prefix.tftest.hcl"), "utf8");

/** The Zod verdict for one value: the publisher schema, prefix set or unset. */
function zodVerdict(value: string | null): Verdict {
  const env = value === null ? {} : { [PREFIX_ENV]: value };
  const result = auditAnchorPublisherEnvSchema.safeParse(env);
  if (result.success) return "allow";
  // Refused for the prefix, not for some unrelated reason.
  expect(result.error.issues.map((i) => i.path.join("."))).toEqual([PREFIX_ENV]);
  return "deny";
}

function zodMismatches(vectors: Vector[]): string[] {
  return vectors.filter((v) => zodVerdict(v.value) !== v.zod).map((v) => JSON.stringify(v.value));
}

/** Each run as { value, verdict }: deny = expects var.prefix to fail, allow = asserts the output. */
function tftestRuns(body: HclBody): Array<{ value: unknown; verdict: string }> {
  const scope = { vars: () => undefined, local: () => undefined, module: () => undefined };
  return body.blocks
    .filter((b) => b.type === "run")
    .map((run) => {
      const variables = nested(run, "variables")[0];
      const value = variables ? evaluate(variables.body.attrs.prefix, scope) : undefined;
      const failures = run.body.attrs.expect_failures;
      const denies = failures?.t === "list" && failures.items.length === 1 && failures.items[0].t === "trav" && failures.items[0].src === "var.prefix";
      const asserts = nested(run, "assert");
      const command = run.body.attrs.command;
      const isPlan = command?.t === "name" && command.name === "plan";
      // An allowed run must assert the value passed through; anything else is
      // not a run this pin understands.
      const allows =
        !failures &&
        asserts.length === 1 &&
        asserts[0].body.attrs.condition?.t === "bin" &&
        JSON.stringify(asserts[0].body.attrs.condition) ===
          JSON.stringify({ t: "bin", op: "==", l: { t: "trav", base: { t: "name", name: "output" }, steps: [{ kind: "attr", name: "prefix" }], src: "output.prefix" }, r: { t: "tmpl", parts: [value] } });
      return { value, verdict: !isPlan ? "not-plan" : denies && asserts.length === 0 ? "deny" : allows ? "allow" : "unrecognised" };
    });
}

function terraformColumn(vectors: Vector[]): Array<{ value: unknown; verdict: string }> {
  return vectors.filter((v) => v.terraform !== "n/a").map((v) => ({ value: v.value, verdict: v.terraform }));
}

const byValue = (a: { value: unknown }, b: { value: unknown }) => String(a.value).localeCompare(String(b.value));

describe("anchor prefix vectors — Zod column", () => {
  it.each(VECTORS)("$value → $zod", ({ value, zod }) => {
    expect(zodVerdict(value)).toBe(zod);
  });

  it("agrees with Terraform on every non-empty value", () => {
    for (const v of VECTORS) {
      if (v.value === null || v.value === "" || v.terraform === "n/a") continue;
      expect(isValidAnchorS3Prefix(v.value) ? "allow" : "deny", JSON.stringify(v.value)).toBe(v.terraform);
    }
  });

  it("covers the cases the rule exists for", () => {
    const values = VECTORS.map((v) => v.value);
    for (const required of [null, "", "a", "a/b", "a.b", ".a", "*", "?", "/a", "a/", "a//b", ".", "..", "a/../b", "a/./b"]) {
      expect(values, JSON.stringify(required)).toContain(required);
    }
    const unset = VECTORS.find((v) => v.value === null);
    const empty = VECTORS.find((v) => v.value === "");
    expect(unset).toMatchObject({ zod: "allow", terraform: "n/a" });
    expect(empty).toMatchObject({ zod: "allow", terraform: "deny" });
  });

  it("detects a flipped verdict (the empty entry's Zod verdict)", () => {
    const flipped = VECTORS.map((v) => (v.value === "" ? { ...v, zod: "deny" as const } : v));
    expect(zodMismatches(VECTORS)).toEqual([]);
    expect(zodMismatches(flipped)).toEqual(['""']);
  });
});

describe("anchor prefix vectors — Terraform column", () => {
  it("has one plan run per non-n/a entry, each with its verdict", () => {
    expect(tftestRuns(parseHcl(TFTEST, "prefix.tftest.hcl")).sort(byValue)).toEqual(terraformColumn(VECTORS).sort(byValue));
  });

  it("detects a value dropped from the HCL", () => {
    const dropped = TFTEST.replace(/\nrun "deny_dotdot" \{[\s\S]*?\n\}\n/, "\n");
    expect(dropped).not.toBe(TFTEST);
    expect(tftestRuns(parseHcl(dropped)).sort(byValue)).not.toEqual(terraformColumn(VECTORS).sort(byValue));
  });

  it("detects a verdict flipped in the HCL", () => {
    const flipped = TFTEST.replace(
      /(run "deny_star" \{[\s\S]*?)expect_failures = \[var\.prefix\]/,
      '$1assert {\n    condition     = output.prefix == "*"\n    error_message = "x"\n  }',
    );
    expect(flipped).not.toBe(TFTEST);
    expect(tftestRuns(parseHcl(flipped)).sort(byValue)).not.toEqual(terraformColumn(VECTORS).sort(byValue));
  });
});
