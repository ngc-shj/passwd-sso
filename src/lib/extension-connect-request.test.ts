// @vitest-environment node
/**
 * Unit tests for extension-connect-request helpers.
 *
 * C5 (T9): `coerceErrorCode` is now exported so it can be tested directly.
 * The component test mocks `requestExtensionConnect` wholesale and cannot
 * reach this seam — direct testing is the only reliable way to assert the
 * allowlist is correct.
 */

import { describe, it, expect } from "vitest";
import {
  coerceErrorCode,
  EXTENSION_CONNECT_ERROR_CODE,
} from "./extension-connect-request";

describe("coerceErrorCode", () => {
  it("passes SESSION_STEP_UP_REQUIRED through unchanged", () => {
    expect(coerceErrorCode("SESSION_STEP_UP_REQUIRED")).toBe(
      EXTENSION_CONNECT_ERROR_CODE.SESSION_STEP_UP_REQUIRED,
    );
  });

  it("passes EXTENSION_ABSENT through unchanged", () => {
    expect(coerceErrorCode("EXTENSION_ABSENT")).toBe(
      EXTENSION_CONNECT_ERROR_CODE.EXTENSION_ABSENT,
    );
  });

  it("passes PASSKEY_REQUIRED through unchanged (C5)", () => {
    expect(coerceErrorCode("PASSKEY_REQUIRED")).toBe(
      EXTENSION_CONNECT_ERROR_CODE.PASSKEY_REQUIRED,
    );
  });

  it("coerces an unknown string to GENERIC_FAILURE", () => {
    expect(coerceErrorCode("SOME_UNKNOWN_CODE")).toBe(
      EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE,
    );
  });

  it("coerces a non-string input to GENERIC_FAILURE", () => {
    expect(coerceErrorCode(null)).toBe(EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE);
    expect(coerceErrorCode(undefined)).toBe(EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE);
    expect(coerceErrorCode(42)).toBe(EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE);
    expect(coerceErrorCode({})).toBe(EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE);
  });

  it("does NOT pass GENERIC_FAILURE through as an allowlisted code (it is the fallback)", () => {
    // GENERIC_FAILURE is not in the allowlist — it is the default. Passing
    // the literal "GENERIC_FAILURE" in a message also returns GENERIC_FAILURE,
    // which is correct (not a bypass).
    expect(coerceErrorCode("GENERIC_FAILURE")).toBe(
      EXTENSION_CONNECT_ERROR_CODE.GENERIC_FAILURE,
    );
  });
});
