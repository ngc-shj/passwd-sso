// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTeamEntryMutations } from "./use-team-entry-mutations";
import { TEAM_DATA_CHANGED_EVENT } from "@/lib/events";

type Entry = { id: string; title: string };

const teamId = "team-1";

function setup(fetchMock: Mock) {
  globalThis.fetch = fetchMock;
  const setEntries = vi.fn();
  const refetchEntries = vi.fn();
  const dispatchSpy = vi.spyOn(window, "dispatchEvent");

  const { result } = renderHook(() =>
    useTeamEntryMutations<Entry>({ teamId, setEntries, refetchEntries }),
  );

  return { result, setEntries, refetchEntries, dispatchSpy, fetchMock };
}

describe("useTeamEntryMutations", () => {
  let fetchMock: Mock;

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("toggleArchive", () => {
    it("optimistically removes entry, calls API, and dispatches event", async () => {
      const { result, setEntries, dispatchSpy } = setup(fetchMock);

      await act(async () => {
        await result.current.toggleArchive("entry-1", false);
      });

      // Optimistic filter was called
      expect(setEntries).toHaveBeenCalledWith(expect.any(Function));
      const filterFn = setEntries.mock.calls[0][0];
      const filtered = filterFn([{ id: "entry-1" }, { id: "entry-2" }]);
      expect(filtered).toEqual([{ id: "entry-2" }]);

      // API called with correct args
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/teams/${teamId}/passwords/entry-1`),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ isArchived: true }),
        }),
      );

      // Event dispatched
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: TEAM_DATA_CHANGED_EVENT }),
      );
    });

    it("refetches on API error and still dispatches event", async () => {
      fetchMock = vi.fn(async () => ({ ok: false }));
      const { result, refetchEntries, dispatchSpy } = setup(fetchMock);

      await act(async () => {
        await result.current.toggleArchive("entry-1", true);
      });

      expect(refetchEntries).toHaveBeenCalled();
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: TEAM_DATA_CHANGED_EVENT }),
      );
    });

    it("refetches on network error and still dispatches event", async () => {
      fetchMock = vi.fn(async () => {
        throw new Error("Network error");
      });
      const { result, refetchEntries, dispatchSpy } = setup(fetchMock);

      await act(async () => {
        await result.current.toggleArchive("entry-1", false);
      });

      expect(refetchEntries).toHaveBeenCalled();
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: TEAM_DATA_CHANGED_EVENT }),
      );
    });
  });

  describe("deleteEntry", () => {
    it("optimistically removes entry, calls DELETE API, and dispatches event", async () => {
      const { result, setEntries, dispatchSpy } = setup(fetchMock);

      await act(async () => {
        await result.current.deleteEntry("entry-1");
      });

      expect(setEntries).toHaveBeenCalledWith(expect.any(Function));
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/teams/${teamId}/passwords/entry-1`),
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: TEAM_DATA_CHANGED_EVENT }),
      );
    });

    it("refetches on error and still dispatches event", async () => {
      fetchMock = vi.fn(async () => ({ ok: false }));
      const { result, refetchEntries, dispatchSpy } = setup(fetchMock);

      await act(async () => {
        await result.current.deleteEntry("entry-1");
      });

      expect(refetchEntries).toHaveBeenCalled();
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: TEAM_DATA_CHANGED_EVENT }),
      );
    });

    it("refetches on network error and still dispatches event", async () => {
      fetchMock = vi.fn(async () => {
        throw new Error("Network error");
      });
      const { result, refetchEntries, dispatchSpy } = setup(fetchMock);

      await act(async () => {
        await result.current.deleteEntry("entry-1");
      });

      expect(refetchEntries).toHaveBeenCalled();
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: TEAM_DATA_CHANGED_EVENT }),
      );
    });
  });

  describe("handleSaved", () => {
    it("refetches and dispatches event", () => {
      const { result, refetchEntries, dispatchSpy } = setup(fetchMock);

      act(() => {
        result.current.handleSaved();
      });

      expect(refetchEntries).toHaveBeenCalled();
      expect(dispatchSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: TEAM_DATA_CHANGED_EVENT }),
      );
    });
  });
});
