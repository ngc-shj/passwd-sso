/**
 * The hcl-subset evaluator's one() and floor(), which infra/terraform's
 * attachment backend wiring (#1020) uses: each modelled as Terraform defines
 * it, and refusing what Terraform refuses rather than reading it as something
 * else.
 */
import { describe, it, expect } from "vitest";
import { evaluate, parseHcl, HclUnknown } from "./hcl-subset";

const SCOPE = { vars: () => undefined, local: () => undefined, module: () => undefined };

function run(src: string): unknown {
  return evaluate(parseHcl(`x = ${src}\n`, "<test>").attrs.x, SCOPE);
}

describe("one()", () => {
  it("is null for an empty list", () => {
    expect(run("one([])")).toBeNull();
  });

  it("is the element of a one-element list", () => {
    expect(run('one(["a"])')).toBe("a");
  });

  it("refuses a list of two", () => {
    expect(() => run('one(["a", "b"])')).toThrow("one: more than one element");
  });

  it("refuses a value that is not a list", () => {
    expect(() => run('one("a")')).toThrow("one: not a list");
  });

  it("passes a resource splat through as an unknown", () => {
    const v = run("one(aws_s3_bucket.attachments[*].id)");
    expect(v).toBeInstanceOf(HclUnknown);
    expect(String(v)).toBe("<ref:aws_s3_bucket.attachments[*].id>");
  });
});

describe("floor()", () => {
  it.each([
    ["1.5", 1],
    ["2", 2],
    ["-1.5", -2],
  ])("floor(%s) is %s", (n, want) => {
    expect(run(`floor(${n})`)).toBe(want);
  });

  it("refuses a value that is not a number", () => {
    expect(() => run('floor("1")')).toThrow("floor: not a number");
  });
});
