import { describe, expect, it } from "vitest";

// Scratch PR for #958 manual test step 4: fails on CI only, so the local
// pre-pr gate passes and the GitHub run shows a red app-test shard.
describe("scratch #958 verification B", () => {
  it("fails in CI", () => {
    expect(process.env.CI === "true" ? "red" : "local").not.toBe("red");
  });
});
