import { describe, it, expect, afterEach, vi } from "vitest";
import { VERIFIER_VERSION, getCurrentVerifierVersion } from "./verifier-version";

describe("getCurrentVerifierVersion", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns VERIFIER_VERSION when no env override is set", () => {
    vi.stubEnv("INTERNAL_TEST_VERIFIER_VERSION", "");
    expect(getCurrentVerifierVersion()).toBe(VERIFIER_VERSION);
  });

  it("honors INTERNAL_TEST_VERIFIER_VERSION=2 when NODE_ENV === 'test'", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("INTERNAL_TEST_VERIFIER_VERSION", "2");
    expect(getCurrentVerifierVersion()).toBe(2);
  });

  it("ignores INTERNAL_TEST_VERIFIER_VERSION when NODE_ENV === 'production'", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("INTERNAL_TEST_VERIFIER_VERSION", "2");
    expect(getCurrentVerifierVersion()).toBe(VERIFIER_VERSION);
  });

  it("ignores non-integer override value 'abc'", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("INTERNAL_TEST_VERIFIER_VERSION", "abc");
    expect(getCurrentVerifierVersion()).toBe(VERIFIER_VERSION);
  });

  it("ignores override value '0' (non-positive)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("INTERNAL_TEST_VERIFIER_VERSION", "0");
    expect(getCurrentVerifierVersion()).toBe(VERIFIER_VERSION);
  });

  it("ignores override value '-1' (non-positive)", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("INTERNAL_TEST_VERIFIER_VERSION", "-1");
    expect(getCurrentVerifierVersion()).toBe(VERIFIER_VERSION);
  });
});
