/**
 * RT7 self-test for check-crypto-auth-deps-classified.mjs.
 */
import { describe, it, expect } from "vitest";
import { computeUnclassifiedDeps } from "../checks/check-crypto-auth-deps-classified.mjs";

describe("computeUnclassifiedDeps (classification-completeness E)", () => {
  it("flags a runtime dep that is neither classified nor excluded", () => {
    const classified = new Set(["next-auth", "clsx"]);
    expect(computeUnclassifiedDeps(["better-auth", "next-auth", "clsx"], classified)).toEqual([
      "better-auth",
    ]);
  });

  it("returns empty when every dep is classified", () => {
    const classified = new Set(["next-auth", "clsx"]);
    expect(computeUnclassifiedDeps(["next-auth", "clsx"], classified)).toEqual([]);
  });
});
