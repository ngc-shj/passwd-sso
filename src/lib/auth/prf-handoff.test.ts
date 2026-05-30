import { describe, it, expect, beforeEach } from "vitest";
import { stashPrf, takePrf, clearPrf } from "./prf-handoff";

const sample = {
  prfOutputHex: "ab".repeat(32),
  prfData: {
    prfEncryptedSecretKey: "ct",
    prfSecretKeyIv: "iv",
    prfSecretKeyAuthTag: "tag",
  },
};

describe("prf-handoff", () => {
  beforeEach(() => {
    clearPrf();
  });

  it("returns null when nothing is stashed", () => {
    expect(takePrf()).toBeNull();
  });

  it("returns the stashed material once, then clears (single-use)", () => {
    stashPrf(sample);
    expect(takePrf()).toEqual(sample);
    // Second read is empty — material is not retained.
    expect(takePrf()).toBeNull();
  });

  it("clearPrf drops material without consuming it", () => {
    stashPrf(sample);
    clearPrf();
    expect(takePrf()).toBeNull();
  });

  it("stashPrf overwrites a prior pending value", () => {
    stashPrf(sample);
    const next = { ...sample, prfOutputHex: "cd".repeat(32) };
    stashPrf(next);
    expect(takePrf()).toEqual(next);
  });
});
