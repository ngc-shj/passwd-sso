import { describe, it, expect, afterEach } from "vitest";
import { envInt } from "@/lib/env-utils";

describe("envInt", () => {
  const ENV_KEY = "TEST_ENV_INT_VAR";
  const original = process.env[ENV_KEY];

  afterEach(() => {
    if (original === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = original;
    }
  });

  // --- Happy path ---

  it("returns the parsed integer when env var is a valid number", () => {
    process.env[ENV_KEY] = "42";
    expect(envInt(ENV_KEY, 0)).toBe(42);
  });

  it("returns 0 when env var is '0'", () => {
    process.env[ENV_KEY] = "0";
    expect(envInt(ENV_KEY, 99)).toBe(0);
  });

  it("returns defaultVal when env var is not set", () => {
    delete process.env[ENV_KEY];
    expect(envInt(ENV_KEY, 100)).toBe(100);
  });

  it("returns defaultVal when env var is empty string", () => {
    process.env[ENV_KEY] = "";
    expect(envInt(ENV_KEY, 100)).toBe(100);
  });

  // --- Edge cases ---

  it("rejects float values and returns default", () => {
    process.env[ENV_KEY] = "3.14";
    expect(envInt(ENV_KEY, 10)).toBe(10);
  });

  it("rejects partial numbers like '20ms'", () => {
    process.env[ENV_KEY] = "20ms";
    expect(envInt(ENV_KEY, 10)).toBe(10);
  });

  it("rejects '10abc'", () => {
    process.env[ENV_KEY] = "10abc";
    expect(envInt(ENV_KEY, 10)).toBe(10);
  });

  it("rejects NaN", () => {
    process.env[ENV_KEY] = "not-a-number";
    expect(envInt(ENV_KEY, 5)).toBe(5);
  });

  it("rejects negative values with default min=0", () => {
    process.env[ENV_KEY] = "-1";
    expect(envInt(ENV_KEY, 10)).toBe(10);
  });

  it("accepts negative values when min allows it", () => {
    process.env[ENV_KEY] = "-5";
    expect(envInt(ENV_KEY, 10, { min: -10 })).toBe(-5);
  });

  // --- Range guards ---

  it("rejects values below min", () => {
    process.env[ENV_KEY] = "3";
    expect(envInt(ENV_KEY, 10, { min: 5 })).toBe(10);
  });

  it("accepts values at min boundary", () => {
    process.env[ENV_KEY] = "5";
    expect(envInt(ENV_KEY, 10, { min: 5 })).toBe(5);
  });

  it("rejects values above max", () => {
    process.env[ENV_KEY] = "200";
    expect(envInt(ENV_KEY, 10, { max: 100 })).toBe(10);
  });

  it("accepts values at max boundary", () => {
    process.env[ENV_KEY] = "100";
    expect(envInt(ENV_KEY, 10, { max: 100 })).toBe(100);
  });

  it("applies both min and max", () => {
    process.env[ENV_KEY] = "50";
    expect(envInt(ENV_KEY, 10, { min: 1, max: 100 })).toBe(50);

    process.env[ENV_KEY] = "0";
    expect(envInt(ENV_KEY, 10, { min: 1, max: 100 })).toBe(10);

    process.env[ENV_KEY] = "101";
    expect(envInt(ENV_KEY, 10, { min: 1, max: 100 })).toBe(10);
  });
});
