import { describe, it, expect, afterEach, vi } from "vitest";
import {
  logNoSelectMatch,
  SELECT_DIAG_FIELD,
} from "../../content/select-diag-lib";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("logNoSelectMatch", () => {
  it("emits one single-argument message naming the field", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});

    logNoSelectMatch(SELECT_DIAG_FIELD.IDENTITY_COUNTRY);

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]).toHaveLength(1);
    expect(debug.mock.calls[0][0]).toBe(
      "[passwd-sso] No exact match for select: identity-country",
    );
  });

  // The whole point of the closed union: the emitted string space is finite and
  // owned by this module, so no caller — and no page — can widen it. If this ever
  // fails, someone has added a free-form slot back.
  it("can only emit one of a fixed, enumerable set of messages", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const fields = Object.values(SELECT_DIAG_FIELD);

    for (const field of fields) logNoSelectMatch(field);

    const emitted = debug.mock.calls.flat();
    expect(emitted).toHaveLength(fields.length);
    expect(new Set(emitted).size).toBe(fields.length);
    for (const message of emitted) {
      expect(message).toMatch(
        /^\[passwd-sso\] No exact match for select: [a-z0-9-]+$/,
      );
    }
  });
});
