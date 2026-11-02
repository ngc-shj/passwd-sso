import { describe, it, expect, vi } from "vitest";
import { creatorAdmittedByShareId, isShareCreatorAdmitted } from "./share-admission";

function client(rows: unknown[]) {
  return { $queryRaw: vi.fn(async () => rows) } as unknown as Parameters<typeof isShareCreatorAdmitted>[0] & {
    $queryRaw: ReturnType<typeof vi.fn>;
  };
}

describe("isShareCreatorAdmitted", () => {
  it("admits only when the database answered true", async () => {
    expect(await isShareCreatorAdmitted(client([{ admitted: true }]), "s1")).toBe(true);
  });

  it.each([
    ["false", [{ admitted: false }]],
    ["NULL", [{ admitted: null }]],
    ["no row", []],
  ])("refuses on %s", async (_label, rows) => {
    expect(await isShareCreatorAdmitted(client(rows), "s1")).toBe(false);
  });

  it("asks share_creator_admitted about the given share id", async () => {
    const tx = client([{ admitted: true }]);
    await isShareCreatorAdmitted(tx, "share-1");
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toMatch(/share_creator_admitted\(\?::uuid\)/);
    expect(values).toEqual(["share-1"]);
  });
});

describe("creatorAdmittedByShareId", () => {
  it("sends no query for no ids", async () => {
    const tx = client([]);
    expect((await creatorAdmittedByShareId(tx, [])).size).toBe(0);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it("maps each id to the database's answer, false when unanswered or NULL", async () => {
    const tx = client([
      { id: "a", admitted: true },
      { id: "b", admitted: false },
      { id: "c", admitted: null },
    ]);
    const result = await creatorAdmittedByShareId(tx, ["a", "b", "c", "d"]);
    expect(Object.fromEntries(result)).toEqual({ a: true, b: false, c: false, d: false });
  });

  it("ignores a row for an id it did not ask about", async () => {
    const tx = client([{ id: "x", admitted: true }]);
    const result = await creatorAdmittedByShareId(tx, ["a"]);
    expect(Object.fromEntries(result)).toEqual({ a: false });
  });
});
