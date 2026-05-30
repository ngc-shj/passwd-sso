import { describe, it, expect, beforeEach } from "vitest";
import { stashPrf, takePrf, clearPrf, type PrfHandoff } from "./prf-handoff";

// Fresh buffers per call — stash/clear zeroize in place, so sharing one buffer
// across tests would leak mutations between them.
function makeSample(byte = 0xab): PrfHandoff {
  return {
    prfOutput: new Uint8Array(32).fill(byte),
    prfData: {
      prfEncryptedSecretKey: "ct",
      prfSecretKeyIv: "iv",
      prfSecretKeyAuthTag: "tag",
    },
  };
}

describe("prf-handoff", () => {
  beforeEach(() => {
    clearPrf();
  });

  it("returns null when nothing is stashed", () => {
    expect(takePrf()).toBeNull();
  });

  it("returns the same stashed reference once, then clears (single-use)", () => {
    const sample = makeSample();
    stashPrf(sample);
    const taken = takePrf();
    // Same reference — no copy, so the consumer can zeroize the real buffer.
    expect(taken).toBe(sample);
    expect(takePrf()).toBeNull();
  });

  it("clearPrf zeroizes the dropped buffer and consumes it", () => {
    const sample = makeSample();
    stashPrf(sample);
    clearPrf();
    expect(sample.prfOutput.every((b) => b === 0)).toBe(true);
    expect(takePrf()).toBeNull();
  });

  it("stashPrf overwrites a prior pending value and zeroizes the prior buffer", () => {
    const first = makeSample(0xab);
    const second = makeSample(0xcd);
    stashPrf(first);
    stashPrf(second);
    // The overwritten buffer is wiped; the new one survives intact.
    expect(first.prfOutput.every((b) => b === 0)).toBe(true);
    expect(takePrf()).toBe(second);
    expect(second.prfOutput.some((b) => b !== 0)).toBe(true);
  });
});
