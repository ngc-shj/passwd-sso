// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  useBulkAction,
  resolveEndpoint,
  buildBody,
  extractCount,
} from "@/hooks/use-bulk-action";
import type { BulkScope } from "@/hooks/use-bulk-action";

// ---------------------------------------------------------------------------
// Mock sonner
// ---------------------------------------------------------------------------
const { mockSuccess, mockError } = vi.hoisted(() => ({
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: mockSuccess, error: mockError },
}));

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------
const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", mockFetch);
  mockFetch.mockReset();
  mockSuccess.mockReset();
  mockError.mockReset();
});

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------
describe("resolveEndpoint", () => {
  const personal: BulkScope = { type: "personal" };
  const team: BulkScope = { type: "team", teamId: "t1" };

  it("resolves personal trash endpoint", () => {
    expect(resolveEndpoint(personal, "trash")).toBe(
      "/api/passwords/bulk-trash",
    );
  });

  it("resolves personal archive endpoint", () => {
    expect(resolveEndpoint(personal, "archive")).toBe(
      "/api/passwords/bulk-archive",
    );
  });

  it("resolves personal unarchive endpoint (same as archive)", () => {
    expect(resolveEndpoint(personal, "unarchive")).toBe(
      "/api/passwords/bulk-archive",
    );
  });

  it("resolves personal restore endpoint", () => {
    expect(resolveEndpoint(personal, "restore")).toBe(
      "/api/passwords/bulk-restore",
    );
  });

  it("resolves team trash endpoint with teamId", () => {
    expect(resolveEndpoint(team, "trash")).toBe(
      "/api/teams/t1/passwords/bulk-trash",
    );
  });

  it("resolves team archive endpoint with teamId", () => {
    expect(resolveEndpoint(team, "archive")).toBe(
      "/api/teams/t1/passwords/bulk-archive",
    );
  });

  it("resolves team restore endpoint with teamId", () => {
    expect(resolveEndpoint(team, "restore")).toBe(
      "/api/teams/t1/passwords/bulk-restore",
    );
  });
});

describe("buildBody", () => {
  it("includes operation for archive", () => {
    expect(buildBody("archive", ["a", "b"])).toEqual({
      ids: ["a", "b"],
      operation: "archive",
    });
  });

  it("includes operation for unarchive", () => {
    expect(buildBody("unarchive", ["a"])).toEqual({
      ids: ["a"],
      operation: "unarchive",
    });
  });

  it("omits operation for trash", () => {
    expect(buildBody("trash", ["x"])).toEqual({ ids: ["x"] });
  });

  it("omits operation for restore", () => {
    expect(buildBody("restore", ["y"])).toEqual({ ids: ["y"] });
  });
});

describe("extractCount", () => {
  it("uses processedCount when available", () => {
    expect(extractCount({ processedCount: 5 }, 10)).toBe(5);
  });

  it("falls back to archivedCount", () => {
    expect(extractCount({ archivedCount: 3 }, 10)).toBe(3);
  });

  it("falls back to unarchivedCount", () => {
    expect(extractCount({ unarchivedCount: 2 }, 10)).toBe(2);
  });

  it("falls back to movedCount", () => {
    expect(extractCount({ movedCount: 7 }, 10)).toBe(7);
  });

  it("falls back to restoredCount", () => {
    expect(extractCount({ restoredCount: 4 }, 10)).toBe(4);
  });

  it("falls back to fallback when all fields missing", () => {
    expect(extractCount({}, 10)).toBe(10);
  });

  it("prefers processedCount over archivedCount", () => {
    expect(
      extractCount({ processedCount: 1, archivedCount: 9 }, 10),
    ).toBe(1);
  });

  it("returns 0 when processedCount is 0 (not falsy-skipped)", () => {
    expect(extractCount({ processedCount: 0, archivedCount: 5 }, 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Hook tests
// ---------------------------------------------------------------------------
describe("useBulkAction", () => {
  const t = vi.fn((key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  );
  const onSuccess = vi.fn();

  beforeEach(() => {
    t.mockClear();
    onSuccess.mockClear();
  });

  function setup(
    selectedIds = new Set(["a", "b"]),
    scope: BulkScope = { type: "personal" },
  ) {
    return renderHook(() =>
      useBulkAction({ selectedIds, scope, t, onSuccess }),
    );
  }

  it("starts with dialog closed and no pending action", () => {
    const { result } = setup();
    expect(result.current.dialogOpen).toBe(false);
    expect(result.current.pendingAction).toBeNull();
    expect(result.current.processing).toBe(false);
  });

  it("requestAction opens dialog and sets pending action", () => {
    const { result } = setup();
    act(() => result.current.requestAction("trash"));
    expect(result.current.dialogOpen).toBe(true);
    expect(result.current.pendingAction).toBe("trash");
  });

  it("executeAction sends correct fetch for personal trash", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ movedCount: 2 }),
    });

    const { result } = setup();
    act(() => result.current.requestAction("trash"));

    await act(() => result.current.executeAction());

    expect(mockFetch).toHaveBeenCalledWith("/api/passwords/bulk-trash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: ["a", "b"] }),
    });
    expect(mockSuccess).toHaveBeenCalled();
    expect(onSuccess).toHaveBeenCalled();
  });

  it("executeAction sends correct fetch for team archive", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ processedCount: 2, archivedCount: 2 }),
    });

    const { result } = setup(new Set(["x"]), {
      type: "team",
      teamId: "team1",
    });
    act(() => result.current.requestAction("archive"));

    await act(() => result.current.executeAction());

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/teams/team1/passwords/bulk-archive",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["x"], operation: "archive" }),
      },
    );
  });

  it("does nothing when selectedIds is empty", async () => {
    const { result } = setup(new Set());
    act(() => result.current.requestAction("trash"));
    await act(() => result.current.executeAction());

    expect(mockFetch).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("shows error toast on fetch failure", async () => {
    mockFetch.mockResolvedValue({ ok: false });

    const { result } = setup();
    act(() => result.current.requestAction("archive"));
    await act(() => result.current.executeAction());

    expect(mockError).toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("resets processing to false after execution completes", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ movedCount: 2 }),
    });

    const { result } = setup();
    expect(result.current.processing).toBe(false);

    act(() => result.current.requestAction("trash"));
    await act(() => result.current.executeAction());

    expect(result.current.processing).toBe(false);
  });

  it("resets processing to false even on error", async () => {
    mockFetch.mockResolvedValue({ ok: false });

    const { result } = setup();
    act(() => result.current.requestAction("archive"));
    await act(() => result.current.executeAction());

    expect(result.current.processing).toBe(false);
  });

  it("does nothing when pendingAction is null", async () => {
    const { result } = setup();
    // executeAction without requestAction
    await act(() => result.current.executeAction());

    expect(mockFetch).not.toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("uses the most recent pendingAction when overridden", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ processedCount: 2 }),
    });

    const { result } = setup();
    act(() => result.current.requestAction("trash"));
    act(() => result.current.requestAction("archive"));

    await act(() => result.current.executeAction());

    expect(mockFetch).toHaveBeenCalledWith(
      "/api/passwords/bulk-archive",
      expect.objectContaining({
        body: JSON.stringify({ ids: ["a", "b"], operation: "archive" }),
      }),
    );
  });

  it("shows error toast when fetch throws (network error)", async () => {
    mockFetch.mockRejectedValue(new Error("Network error"));

    const { result } = setup();
    act(() => result.current.requestAction("trash"));
    await act(() => result.current.executeAction());

    expect(mockError).toHaveBeenCalled();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(result.current.processing).toBe(false);
  });

  it("keeps dialog open on error so user can retry", async () => {
    mockFetch.mockResolvedValue({ ok: false });

    const { result } = setup();
    act(() => result.current.requestAction("archive"));
    await act(() => result.current.executeAction());

    expect(result.current.dialogOpen).toBe(true);
  });

  it("setDialogOpen(false) closes dialog without clearing pendingAction", () => {
    const { result } = setup();
    act(() => result.current.requestAction("trash"));
    expect(result.current.dialogOpen).toBe(true);
    expect(result.current.pendingAction).toBe("trash");

    act(() => result.current.setDialogOpen(false));
    expect(result.current.dialogOpen).toBe(false);
    expect(result.current.pendingAction).toBe("trash");
  });

  it("guards against empty teamId in team scope", async () => {
    const { result } = setup(new Set(["a"]), {
      type: "team",
      teamId: "",
    });
    act(() => result.current.requestAction("trash"));
    await act(() => result.current.executeAction());

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("uses count fallback chain correctly", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({}), // No count fields at all
    });

    const ids = new Set(["a", "b", "c"]);
    const { result } = setup(ids);
    act(() => result.current.requestAction("trash"));
    await act(() => result.current.executeAction());

    // Should use fallback = selectedIds.size = 3
    expect(t).toHaveBeenCalledWith("bulkMovedToTrash", { count: 3 });
  });
});
