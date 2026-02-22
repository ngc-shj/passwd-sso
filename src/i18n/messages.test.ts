import { describe, expect, it } from "vitest";
import { loadAllMessages, loadNamespaces, NAMESPACES } from "./messages";

describe("loadAllMessages", () => {
  it("returns an object with all namespace keys for a valid locale", async () => {
    const result = await loadAllMessages("en");
    expect(Object.keys(result).sort()).toEqual([...NAMESPACES].sort());
  });

  it("falls back to default locale for an invalid locale", async () => {
    const result = await loadAllMessages("xx");
    expect(Object.keys(result).sort()).toEqual([...NAMESPACES].sort());
  });
});

describe("loadNamespaces", () => {
  it("loads only the specified namespaces", async () => {
    const result = await loadNamespaces("en", ["Common", "Auth"]);
    expect(Object.keys(result).sort()).toEqual(["Auth", "Common"]);
  });

  it("throws on invalid namespace", async () => {
    await expect(loadNamespaces("en", ["Bogus"])).rejects.toThrow(
      "[i18n] Invalid namespace",
    );
  });

  it("returns empty object for empty array", async () => {
    const result = await loadNamespaces("en", []);
    expect(result).toEqual({});
  });
});
