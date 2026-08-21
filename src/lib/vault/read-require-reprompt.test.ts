import { describe, it, expect } from "vitest";

import { readRequireReprompt } from "./read-require-reprompt";

describe("readRequireReprompt", () => {
  it("passes a real boolean through in both directions", () => {
    // The allow side: an entry the user did NOT mark must not start prompting,
    // or the fail-closed default becomes a prompt on every copy.
    expect(readRequireReprompt({ requireReprompt: false })).toBe(false);
    expect(readRequireReprompt({ requireReprompt: true })).toBe(true);
  });

  it("denies when the field is absent", () => {
    // This is the shape build-team-get-detail.ts produced: the API sends the
    // flag, the builder dropped it, and every consumer's `?? false` read the
    // absence as "no prompt required" — disabling the control for the whole
    // team vault.
    expect(readRequireReprompt({})).toBe(true);
  });

  it("denies on an off-type value rather than coercing it", () => {
    // `as boolean` was an assertion, not validation: "false" is truthy and 0 is
    // falsy, so a type change on the wire silently flipped the control.
    expect(readRequireReprompt({ requireReprompt: "false" })).toBe(true);
    expect(readRequireReprompt({ requireReprompt: 0 })).toBe(true);
    expect(readRequireReprompt({ requireReprompt: null })).toBe(true);
    expect(readRequireReprompt({ requireReprompt: undefined })).toBe(true);
  });

  it("denies on a non-object payload", () => {
    expect(readRequireReprompt(null)).toBe(true);
    expect(readRequireReprompt(undefined)).toBe(true);
    expect(readRequireReprompt("nope")).toBe(true);
  });

  it("prefers the overview fallback over the fail-closed default", () => {
    // The personal path carries the flag on the already-decrypted overview row.
    // That is a real second source, not a guess, so a response that omits the
    // field must not start prompting for entries the user never marked.
    expect(readRequireReprompt({}, false)).toBe(false);
    expect(readRequireReprompt({}, true)).toBe(true);
  });

  it("still prefers the response over the fallback when both are present", () => {
    expect(readRequireReprompt({ requireReprompt: true }, false)).toBe(true);
    expect(readRequireReprompt({ requireReprompt: false }, true)).toBe(false);
  });

  it("falls closed when the fallback is also off-type", () => {
    expect(readRequireReprompt({}, "false")).toBe(true);
    expect(readRequireReprompt({}, undefined)).toBe(true);
  });
});
