// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { mockToastError } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: mockToastError,
  },
}));

import { useSidebarFolderCrud } from "./use-sidebar-folder-crud";

const personalFolders = [
  { id: "f1", name: "Personal", parentId: null, sortOrder: 0, entryCount: 1 },
];
const orgFolders = [
  { id: "of1", name: "Org", parentId: null, sortOrder: 0, entryCount: 2 },
];

function makeParams() {
  return {
    folders: personalFolders,
    orgFolderGroups: [{ orgId: "org-1", orgName: "Acme", orgRole: "ADMIN", folders: orgFolders }],
    refreshData: vi.fn(),
    tErrors: (key: string) => key,
  };
}

describe("useSidebarFolderCrud", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens create dialog for personal and org contexts", () => {
    const { result } = renderHook(() => useSidebarFolderCrud(makeParams()));

    act(() => {
      result.current.handleFolderCreate();
    });
    expect(result.current.folderDialogOpen).toBe(true);
    expect(result.current.editingFolder).toBeNull();
    expect(result.current.dialogFolders).toEqual(personalFolders);

    act(() => {
      result.current.handleFolderCreate("org-1");
    });
    expect(result.current.dialogFolders).toEqual(orgFolders);
  });

  it("submits personal create and refreshes data", async () => {
    const params = makeParams();
    const fetchMock = vi.fn(async () => ({ ok: true })) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarFolderCrud(params));

    await act(async () => {
      await result.current.handleFolderSubmit({ name: "New", parentId: null });
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/folders", expect.objectContaining({ method: "POST" }));
    expect(params.refreshData).toHaveBeenCalledTimes(1);
  });

  it("submits org edit using org endpoint", async () => {
    const params = makeParams();
    const fetchMock = vi.fn(async () => ({ ok: true })) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarFolderCrud(params));

    act(() => {
      result.current.handleFolderEdit(orgFolders[0], "org-1");
    });

    await act(async () => {
      await result.current.handleFolderSubmit({ name: "Renamed", parentId: null });
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/teams/org-1/folders/of1",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("shows translated error on submit failure", async () => {
    const params = makeParams();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "FOLDER_ALREADY_EXISTS" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    ) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarFolderCrud(params));

    await expect(
      result.current.handleFolderSubmit({ name: "dup", parentId: null }),
    ).rejects.toThrow("API error");

    expect(mockToastError).toHaveBeenCalledWith("folderAlreadyExists");
  });

  it("deletes folder and clears deleting state", async () => {
    const params = makeParams();
    const fetchMock = vi.fn(async () => ({ ok: true })) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarFolderCrud(params));

    act(() => {
      result.current.handleFolderDeleteClick(personalFolders[0]);
    });

    await act(async () => {
      await result.current.handleFolderDelete();
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/folders/f1", { method: "DELETE" });
    expect(result.current.deletingFolder).toBeNull();
    expect(params.refreshData).toHaveBeenCalledTimes(1);
  });

  it("uses unknownError when submit failure response is not JSON", async () => {
    const params = makeParams();
    const fetchMock = vi.fn(
      async () =>
        new Response("not-json", {
          status: 500,
          headers: { "Content-Type": "text/plain" },
        }),
    ) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarFolderCrud(params));

    await expect(
      result.current.handleFolderSubmit({ name: "bad", parentId: null }),
    ).rejects.toThrow("API error");

    expect(mockToastError).toHaveBeenCalledWith("unknownError");
  });

  it("shows mapped error and clears deleting state when delete fails", async () => {
    const params = makeParams();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "FOLDER_NOT_FOUND" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
    ) as Mock;
    globalThis.fetch = fetchMock;

    const { result } = renderHook(() => useSidebarFolderCrud(params));

    act(() => {
      result.current.handleFolderDeleteClick(personalFolders[0]);
    });

    await act(async () => {
      await result.current.handleFolderDelete();
    });

    expect(mockToastError).toHaveBeenCalledWith("folderNotFound");
    expect(result.current.deletingFolder).toBeNull();
    expect(params.refreshData).not.toHaveBeenCalled();
  });

  it("clears deleting folder manually", () => {
    const { result } = renderHook(() => useSidebarFolderCrud(makeParams()));

    act(() => {
      result.current.handleFolderDeleteClick(personalFolders[0]);
    });
    expect(result.current.deletingFolder).not.toBeNull();

    act(() => {
      result.current.clearDeletingFolder();
    });
    expect(result.current.deletingFolder).toBeNull();
  });
});
