// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { preventIMESubmit } from "./ime-guard";

function fakeKeyEvent(isComposing: boolean) {
  const preventDefault = vi.fn();
  return {
    key: "Enter",
    nativeEvent: { isComposing },
    preventDefault,
  } as unknown as React.KeyboardEvent;
}

describe("preventIMESubmit", () => {
  it("calls preventDefault when Enter is pressed during IME composition", () => {
    const event = fakeKeyEvent(true);
    preventIMESubmit(event);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("does NOT call preventDefault for normal Enter (not composing)", () => {
    const event = fakeKeyEvent(false);
    preventIMESubmit(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("does NOT call preventDefault for non-Enter keys during composition", () => {
    const event = {
      key: "a",
      nativeEvent: { isComposing: true },
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent;
    preventIMESubmit(event);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
