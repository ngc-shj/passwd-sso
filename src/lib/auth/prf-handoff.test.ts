import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  stashPrf,
  takePrf,
  clearPrf,
  PRF_HANDOFF_TTL_MS,
  type PrfHandoff,
} from "./prf-handoff";

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

  describe("TTL self-expiry", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("zeroizes and drops an unconsumed handoff after the TTL elapses", () => {
      const sample = makeSample();
      stashPrf(sample);
      vi.advanceTimersByTime(PRF_HANDOFF_TTL_MS);
      expect(sample.prfOutput.every((b) => b === 0)).toBe(true);
      expect(takePrf()).toBeNull();
    });

    it("does NOT wipe before the TTL elapses", () => {
      const sample = makeSample();
      stashPrf(sample);
      vi.advanceTimersByTime(PRF_HANDOFF_TTL_MS - 1);
      expect(sample.prfOutput.some((b) => b !== 0)).toBe(true);
      expect(takePrf()).toBe(sample);
    });

    it("takePrf cancels the TTL so the consumer-owned buffer is not wiped later", () => {
      const sample = makeSample();
      stashPrf(sample);
      const taken = takePrf();
      expect(taken).toBe(sample);
      // After the consumer owns it, the expired timer must not reach back in.
      vi.advanceTimersByTime(PRF_HANDOFF_TTL_MS);
      expect(sample.prfOutput.some((b) => b !== 0)).toBe(true);
    });

    it("a re-stash resets the TTL and the prior timer cannot wipe the new buffer", () => {
      const first = makeSample(0xab);
      stashPrf(first);
      // Just before the first TTL would fire, stash a fresh handoff.
      vi.advanceTimersByTime(PRF_HANDOFF_TTL_MS - 1);
      const second = makeSample(0xcd);
      stashPrf(second);
      // The original timer (now cancelled) would have fired here.
      vi.advanceTimersByTime(1);
      expect(second.prfOutput.some((b) => b !== 0)).toBe(true);
      expect(takePrf()).toBe(second);
    });

    it("clearPrf cancels the pending TTL timer (no dangling timer left armed)", () => {
      // clearPrf's cancellation is timer hygiene, not a buffer-wipe effect (a
      // phantom fire would hit null pending and no-op). Assert it directly via
      // the fake-timer queue rather than an observable wipe.
      stashPrf(makeSample());
      expect(vi.getTimerCount()).toBe(1);
      clearPrf();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
