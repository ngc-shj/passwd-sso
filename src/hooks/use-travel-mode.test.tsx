// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: vi.fn(),
}));

import { TravelModeProvider, useTravelMode } from "@/hooks/use-travel-mode";
import { fetchApi } from "@/lib/url-helpers";

const fetchApiMock = vi.mocked(fetchApi);

function mockResponse(body: unknown, init: { ok: boolean; status?: number } = { ok: true }): Response {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function wrapper({ children }: { children: ReactNode }) {
  return <TravelModeProvider>{children}</TravelModeProvider>;
}

describe("useTravelMode", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it("throws when used outside the provider", () => {
    // Suppress React's expected error log for the thrown render.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useTravelMode())).toThrow(
      /useTravelMode must be used within TravelModeProvider/,
    );
    errSpy.mockRestore();
  });

  it("loads initial status from /api/travel-mode on mount", async () => {
    fetchApiMock.mockResolvedValueOnce(
      mockResponse({ active: true, activatedAt: "2026-05-03T00:00:00Z" }),
    );

    const { result } = renderHook(() => useTravelMode(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(fetchApiMock).toHaveBeenCalledWith("/api/travel-mode");
    expect(result.current.active).toBe(true);
    expect(result.current.activatedAt).toBe("2026-05-03T00:00:00Z");
    expect(result.current.error).toBeNull();
  });

  it("records error on initial-status fetch failure", async () => {
    fetchApiMock.mockResolvedValueOnce(mockResponse({}, { ok: false, status: 500 }));

    const { result } = renderHook(() => useTravelMode(), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("HTTP 500");
    expect(result.current.active).toBe(false);
  });

  it("enable() POSTs to /enable and updates state on success", async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ active: false, activatedAt: null }))
      .mockResolvedValueOnce(mockResponse({ active: true }));

    const { result } = renderHook(() => useTravelMode(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = false;
    await act(async () => {
      ok = await result.current.enable();
    });

    expect(ok).toBe(true);
    expect(fetchApiMock).toHaveBeenLastCalledWith(
      "/api/travel-mode/enable",
      expect.objectContaining({ method: "POST" }),
    );
    expect(result.current.active).toBe(true);
    expect(result.current.activatedAt).not.toBeNull();
  });

  it("enable() returns false on non-ok response without throwing", async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ active: false, activatedAt: null }))
      .mockResolvedValueOnce(mockResponse({}, { ok: false, status: 500 }));

    const { result } = renderHook(() => useTravelMode(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = true;
    await act(async () => {
      ok = await result.current.enable();
    });

    expect(ok).toBe(false);
    expect(result.current.active).toBe(false);
  });

  it("enable() returns false on network error", async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ active: false, activatedAt: null }))
      .mockRejectedValueOnce(new Error("offline"));

    const { result } = renderHook(() => useTravelMode(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = true;
    await act(async () => {
      ok = await result.current.enable();
    });

    expect(ok).toBe(false);
  });

  it("disable() returns success and clears active on 200", async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ active: true, activatedAt: "now" }))
      .mockResolvedValueOnce(mockResponse({ active: false }));

    const { result } = renderHook(() => useTravelMode(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome: { success: boolean; error?: string } = { success: false };
    await act(async () => {
      outcome = await result.current.disable("verifier-hash");
    });

    expect(outcome.success).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(result.current.active).toBe(false);
    expect(result.current.activatedAt).toBeNull();

    const lastCall = fetchApiMock.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("/api/travel-mode/disable");
    expect(lastCall?.[1]?.body).toBe(JSON.stringify({ verifierHash: "verifier-hash" }));
  });

  it("disable() maps 401 to INVALID_PASSPHRASE", async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ active: true, activatedAt: "now" }))
      .mockResolvedValueOnce(mockResponse({ error: "x" }, { ok: false, status: 401 }));

    const { result } = renderHook(() => useTravelMode(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome: { success: boolean; error?: string } = { success: true };
    await act(async () => {
      outcome = await result.current.disable("bad");
    });

    expect(outcome).toEqual({ success: false, error: "INVALID_PASSPHRASE" });
  });

  it("disable() maps 403 to ACCOUNT_LOCKED", async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ active: true, activatedAt: "now" }))
      .mockResolvedValueOnce(mockResponse({}, { ok: false, status: 403 }));

    const { result } = renderHook(() => useTravelMode(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome: { success: boolean; error?: string } = { success: true };
    await act(async () => {
      outcome = await result.current.disable("v");
    });

    expect(outcome).toEqual({ success: false, error: "ACCOUNT_LOCKED" });
  });

  it("disable() returns NETWORK_ERROR when fetch rejects", async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ active: true, activatedAt: "now" }))
      .mockRejectedValueOnce(new Error("network"));

    const { result } = renderHook(() => useTravelMode(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let outcome: { success: boolean; error?: string } = { success: true };
    await act(async () => {
      outcome = await result.current.disable("v");
    });

    expect(outcome).toEqual({ success: false, error: "NETWORK_ERROR" });
  });

  it("refresh() re-fetches the status endpoint", async () => {
    fetchApiMock
      .mockResolvedValueOnce(mockResponse({ active: false, activatedAt: null }))
      .mockResolvedValueOnce(mockResponse({ active: true, activatedAt: "later" }));

    const { result } = renderHook(() => useTravelMode(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await result.current.refresh();
    });

    expect(fetchApiMock.mock.calls.filter((c) => c[0] === "/api/travel-mode")).toHaveLength(2);
    expect(result.current.active).toBe(true);
    expect(result.current.activatedAt).toBe("later");
  });
});
