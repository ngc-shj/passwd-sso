import { describe, expect, it, vi } from "vitest";
import { bindRangeInput, bindRangeNullableInput } from "./input-range";

function ev(value: string) {
  return { target: { value } };
}

describe("bindRangeInput (string-valued)", () => {
  describe("onChange", () => {
    it("accepts any digits without clamping (min)", () => {
      // User typing "15" should NOT be blocked at the "1" keystroke.
      const setValue = vi.fn();
      const { onChange } = bindRangeInput(setValue, { min: 5, max: 1440 });
      onChange(ev("1"));
      expect(setValue).toHaveBeenLastCalledWith("1");
      onChange(ev("15"));
      expect(setValue).toHaveBeenLastCalledWith("15");
    });

    it("accepts any digits without clamping (max)", () => {
      // User typing "25000" to verify max=1440 must see "25000" in the field.
      const setValue = vi.fn();
      const { onChange } = bindRangeInput(setValue, { min: 5, max: 1440 });
      onChange(ev("25000"));
      expect(setValue).toHaveBeenLastCalledWith("25000");
    });

    it("strips non-digit characters", () => {
      const setValue = vi.fn();
      const { onChange } = bindRangeInput(setValue, { min: 5, max: 1440 });
      onChange(ev("1e2"));
      expect(setValue).toHaveBeenLastCalledWith("12");
      onChange(ev("  45 "));
      expect(setValue).toHaveBeenLastCalledWith("45");
    });

    it("empty input resolves to empty string", () => {
      const setValue = vi.fn();
      const { onChange } = bindRangeInput(setValue, { min: 5, max: 1440 });
      onChange(ev(""));
      expect(setValue).toHaveBeenLastCalledWith("");
    });

    it("fires onEdit each time", () => {
      const setValue = vi.fn();
      const onEdit = vi.fn();
      const { onChange } = bindRangeInput(setValue, { min: 5, max: 1440, onEdit });
      onChange(ev("1"));
      onChange(ev("12"));
      expect(onEdit).toHaveBeenCalledTimes(2);
    });
  });

  describe("onBlur", () => {
    it("clamps below-min up to min", () => {
      const setValue = vi.fn();
      const { onBlur } = bindRangeInput(setValue, { min: 5, max: 1440 });
      onBlur(ev("3"));
      expect(setValue).toHaveBeenLastCalledWith("5");
    });

    it("clamps above-max down to max", () => {
      const setValue = vi.fn();
      const { onBlur } = bindRangeInput(setValue, { min: 5, max: 1440 });
      onBlur(ev("25000"));
      expect(setValue).toHaveBeenLastCalledWith("1440");
    });

    it("leaves in-range values untouched", () => {
      const setValue = vi.fn();
      const { onBlur } = bindRangeInput(setValue, { min: 5, max: 1440 });
      onBlur(ev("15"));
      expect(setValue).not.toHaveBeenCalled();
    });

    it("leaves empty untouched (doesn't auto-fill min)", () => {
      const setValue = vi.fn();
      const { onBlur } = bindRangeInput(setValue, { min: 5, max: 1440 });
      onBlur(ev(""));
      expect(setValue).not.toHaveBeenCalled();
    });
  });
});

describe("bindRangeNullableInput (number | null)", () => {
  describe("onChange", () => {
    it("empty input → null (inherit tenant)", () => {
      const setValue = vi.fn();
      const { onChange } = bindRangeNullableInput(setValue, { min: 5, max: 1440 });
      onChange(ev(""));
      expect(setValue).toHaveBeenLastCalledWith(null);
    });

    it("accepts any digits without clamping", () => {
      const setValue = vi.fn();
      const { onChange } = bindRangeNullableInput(setValue, { min: 5, max: 1440 });
      onChange(ev("1"));
      expect(setValue).toHaveBeenLastCalledWith(1);
      onChange(ev("25000"));
      expect(setValue).toHaveBeenLastCalledWith(25000);
    });
  });

  describe("onBlur", () => {
    it("clamps below-min up to min", () => {
      const setValue = vi.fn();
      const { onBlur } = bindRangeNullableInput(setValue, { min: 5, max: 1440 });
      onBlur(ev("3"));
      expect(setValue).toHaveBeenLastCalledWith(5);
    });

    it("clamps above-max down to max", () => {
      const setValue = vi.fn();
      const { onBlur } = bindRangeNullableInput(setValue, { min: 5, max: 1440 });
      onBlur(ev("25000"));
      expect(setValue).toHaveBeenLastCalledWith(1440);
    });

    it("leaves empty untouched (stays null)", () => {
      const setValue = vi.fn();
      const { onBlur } = bindRangeNullableInput(setValue, { min: 5, max: 1440 });
      onBlur(ev(""));
      expect(setValue).not.toHaveBeenCalled();
    });
  });
});
