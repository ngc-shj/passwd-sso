// @vitest-environment jsdom

import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: vi.fn(),
}));

import { useTenantRole } from "@/hooks/use-tenant-role";
import { fetchApi } from "@/lib/url-helpers";

const fetchApiMock = vi.mocked(fetchApi);

function mockJson<T>(body: T, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

describe("useTenantRole", () => {
  beforeEach(() => {
    fetchApiMock.mockReset();
  });

  it("hits /api/tenant/role on mount", async () => {
    fetchApiMock.mockResolvedValueOnce(mockJson({ role: "MEMBER" }));

    renderHook(() => useTenantRole());

    await waitFor(() => {
      expect(fetchApiMock).toHaveBeenCalledTimes(1);
    });
    expect(fetchApiMock.mock.calls[0][0]).toBe("/api/tenant/role");
  });

  it("starts in loading state with null role", () => {
    fetchApiMock.mockReturnValueOnce(new Promise(() => {}));

    const { result } = renderHook(() => useTenantRole());

    expect(result.current.loading).toBe(true);
    expect(result.current.role).toBeNull();
    expect(result.current.isOwner).toBe(false);
    expect(result.current.isAdmin).toBe(false);
  });

  it("reports OWNER as both isOwner and isAdmin", async () => {
    fetchApiMock.mockResolvedValueOnce(mockJson({ role: "OWNER" }));

    const { result } = renderHook(() => useTenantRole());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.role).toBe("OWNER");
    expect(result.current.isOwner).toBe(true);
    expect(result.current.isAdmin).toBe(true);
  });

  it("reports ADMIN as isAdmin but not isOwner", async () => {
    fetchApiMock.mockResolvedValueOnce(mockJson({ role: "ADMIN" }));

    const { result } = renderHook(() => useTenantRole());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.role).toBe("ADMIN");
    expect(result.current.isOwner).toBe(false);
    expect(result.current.isAdmin).toBe(true);
  });

  it("reports MEMBER as neither isOwner nor isAdmin", async () => {
    fetchApiMock.mockResolvedValueOnce(mockJson({ role: "MEMBER" }));

    const { result } = renderHook(() => useTenantRole());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.role).toBe("MEMBER");
    expect(result.current.isOwner).toBe(false);
    expect(result.current.isAdmin).toBe(false);
  });

  it("falls through to role=null when fetch rejects", async () => {
    fetchApiMock.mockRejectedValueOnce(new Error("offline"));

    const { result } = renderHook(() => useTenantRole());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.role).toBeNull();
    expect(result.current.isOwner).toBe(false);
    expect(result.current.isAdmin).toBe(false);
  });

  it("falls through to role=null when the server returns role=null (e.g. 401 body)", async () => {
    fetchApiMock.mockResolvedValueOnce(mockJson({ role: null }));

    const { result } = renderHook(() => useTenantRole());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.role).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });
});
