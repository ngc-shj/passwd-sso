/**
 * Bind handlers for a range-constrained `<input type="number">`.
 *
 * Contract:
 *   - onChange: strip non-digits only. No min or max clamping during
 *     typing — the user must be able to transit any intermediate state
 *     (including "1" on the way to "15", or "25000" to verify max=1440
 *     rejection). Silent mid-stroke correction hides the user's intent
 *     and looks like the input is broken.
 *   - onBlur: silently clamp into `[min, max]` when the field is non-empty.
 *     Empty stays empty (lets the field fall back to a placeholder or,
 *     for the nullable variant, to "inherit tenant").
 *   - validate() at save-time is the hard stop; onBlur is a friendly
 *     auto-correct, not a substitute for server-side rules.
 *
 * Two variants share this file because the transit/clamp rules are
 * identical; only the setter signature differs.
 */

export interface RangeInputOptions {
  min: number;
  max: number;
  /** Called on every keystroke. Typical use: clear inline error, mark dirty. */
  onEdit?: () => void;
}

type InputEvent = { target: { value: string } };

/** Keep only digit characters from a raw input string. */
function toDigits(raw: string): string {
  return raw.replace(/[^\d]/g, "");
}

/**
 * String-valued input (tenant policy card: required non-null fields).
 * State is `""` when empty; otherwise a decimal digits string.
 */
export function bindRangeInput(
  setValue: (v: string) => void,
  { min, max, onEdit }: RangeInputOptions,
) {
  return {
    onChange: (e: InputEvent) => {
      // No clamping. The user must be able to type any intermediate
      // value on the way to a valid one.
      setValue(toDigits(e.target.value));
      onEdit?.();
    },
    onBlur: (e: InputEvent) => {
      const raw = e.target.value;
      if (!raw) return;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) {
        setValue("");
      } else if (n < min) {
        setValue(String(min));
      } else if (n > max) {
        setValue(String(max));
      }
    },
  };
}

/**
 * Nullable-number-valued input (team policy card: optional override;
 * null = inherit tenant).
 * State is `null` when empty; otherwise a number.
 */
export function bindRangeNullableInput(
  setValue: (v: number | null) => void,
  { min, max, onEdit }: RangeInputOptions,
) {
  return {
    onChange: (e: InputEvent) => {
      const digits = toDigits(e.target.value);
      if (!digits) {
        setValue(null);
        onEdit?.();
        return;
      }
      const n = parseInt(digits, 10);
      setValue(Number.isFinite(n) ? n : null);
      onEdit?.();
    },
    onBlur: (e: InputEvent) => {
      const raw = e.target.value;
      if (!raw) return;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) {
        setValue(null);
      } else if (n < min) {
        setValue(min);
      } else if (n > max) {
        setValue(max);
      }
    },
  };
}
