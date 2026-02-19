import { describe, expect, it, vi } from "vitest";
import { API_PATH } from "@/lib/constants";
import { resolveEntryTagIds, resolveTagNameToIdForImport } from "@/components/passwords/import-dialog-utils";

type ImportEntry = Parameters<
  typeof resolveTagNameToIdForImport
>[0][number];

function entryWithTags(tags: Array<{ name: string; color: string | null }>): ImportEntry {
  return { tags } as unknown as ImportEntry;
}

function response(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => data,
  } as unknown as Response;
}

describe("import tag resolution", () => {
  it("creates only missing tags and reuses existing ones", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([{ id: "t-work", name: "work", color: "#111111" }]))
      .mockResolvedValueOnce(response({ id: "t-new", name: "new", color: "#222222" }));

    const entries = [
      entryWithTags([
        { name: "work", color: "#111111" },
        { name: "new", color: "#222222" },
      ]),
      entryWithTags([{ name: "new", color: "#222222" }]),
    ];

    const map = await resolveTagNameToIdForImport(
      entries,
      API_PATH.TAGS,
      fetcher as never
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(1, API_PATH.TAGS);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      API_PATH.TAGS,
      expect.objectContaining({ method: "POST" })
    );
    expect(map.get("work")).toBe("t-work");
    expect(map.get("new")).toBe("t-new");
  });

  it("does not create tags when all already exist", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response([
          { id: "t-work", name: "work", color: "#111111" },
          { id: "t-new", name: "new", color: "#222222" },
        ])
      );

    const entries = [
      entryWithTags([
        { name: "work", color: "#111111" },
        { name: "new", color: "#222222" },
      ]),
    ];

    const map = await resolveTagNameToIdForImport(
      entries,
      API_PATH.TAGS,
      fetcher as never
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(map.get("work")).toBe("t-work");
    expect(map.get("new")).toBe("t-new");
  });

  it("continues when missing tag creation fails", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response([]))
      .mockRejectedValueOnce(new Error("network error"));

    const entries = [entryWithTags([{ name: "new", color: "#222222" }])];

    const map = await resolveTagNameToIdForImport(
      entries,
      API_PATH.TAGS,
      fetcher as never
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(map.has("new")).toBe(false);
  });

  it("resolves entry tagIds with trim and dedupe", () => {
    const map = new Map<string, string>([
      ["work", "t-work"],
      ["new", "t-new"],
    ]);

    const ids = resolveEntryTagIds(
      entryWithTags([
        { name: " work ", color: null },
        { name: "new", color: null },
        { name: "new", color: null },
        { name: "unknown", color: null },
      ]),
      map
    );

    expect(ids).toEqual(["t-work", "t-new"]);
  });
});
