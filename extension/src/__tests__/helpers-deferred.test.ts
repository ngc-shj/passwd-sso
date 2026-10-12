import { describe, it, expect, vi } from "vitest";
import { holdNextCall } from "./helpers/deferred";

describe("holdNextCall", () => {
  it("puts the previous implementation back once the hold fires", async () => {
    const original = async (x: string) => `orig-${x}`;
    const mock = vi.fn(original);

    const hold = holdNextCall(mock);
    const held = mock("a");
    await hold.reached;

    expect(mock.getMockImplementation()).toBe(original);
    hold.release();
    expect(await held).toBe("orig-a");
  });

  it("keeps a hold armed later on the same mock when an earlier one fires", async () => {
    const mock = vi.fn(async (x: string) => `orig-${x}`);
    const first = holdNextCall(mock, (x: string) => x === "a");
    const second = holdNextCall(mock, (x: string) => x === "b");

    const a = mock("a");
    await first.reached;
    first.release();
    const b = mock("b");
    await second.reached;
    second.release();

    expect(await Promise.all([a, b])).toEqual(["orig-a", "orig-b"]);
  });

  // In order: the first test leaves a hold that never fires (as a test that
  // fails before reaching it would); the second must find the mock unheld.
  describe("a hold that never fired", { shuffle: false }, () => {
    const original = async () => "orig";
    const shared = vi.fn(original);

    it("is armed while its test runs", () => {
      holdNextCall(shared);

      expect(shared.getMockImplementation()).not.toBe(original);
    });

    it("is removed when that test finishes", () => {
      expect(shared.getMockImplementation()).toBe(original);
    });
  });
});
