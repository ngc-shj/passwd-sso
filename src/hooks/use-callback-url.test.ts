// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

let mockSearchParams: URLSearchParams;

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

// Keep real implementation — test the full integration
vi.mock("@/lib/url-helpers", () => ({
  BASE_PATH: "",
}));

import { useCallbackUrl } from "./use-callback-url";

describe("useCallbackUrl", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
  });

  it("returns /dashboard when no callbackUrl param", () => {
    const { result } = renderHook(() => useCallbackUrl());
    expect(result.current).toBe("/dashboard");
  });

  it("returns callbackUrl when valid relative path", () => {
    mockSearchParams = new URLSearchParams(
      "callbackUrl=/ja/dashboard?ext_connect=1",
    );
    const { result } = renderHook(() => useCallbackUrl());
    expect(result.current).toBe("/ja/dashboard?ext_connect=1");
  });

  it("returns default for protocol-relative URL", () => {
    mockSearchParams = new URLSearchParams("callbackUrl=//evil.com/phish");
    const { result } = renderHook(() => useCallbackUrl());
    expect(result.current).toBe("/dashboard");
  });

  it("returns pathname+search for same-origin absolute URL", () => {
    mockSearchParams = new URLSearchParams(
      `callbackUrl=${window.location.origin}/dashboard?ext_connect=1`,
    );
    const { result } = renderHook(() => useCallbackUrl());
    expect(result.current).toBe("/dashboard?ext_connect=1");
  });
});
