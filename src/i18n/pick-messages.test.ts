import { describe, expect, it } from "vitest";
import { pickMessages } from "./pick-messages";

const sampleMessages = {
  Common: { back: "Back", save: "Save" },
  Auth: { signOut: "Sign out" },
  Dashboard: { passwords: "Passwords" },
};

describe("pickMessages", () => {
  it("returns only the specified namespaces", () => {
    const result = pickMessages(sampleMessages, ["Common", "Auth"]);
    expect(Object.keys(result).sort()).toEqual(["Auth", "Common"]);
    expect(result["Common"]).toEqual({ back: "Back", save: "Save" });
  });

  it("ignores namespaces not present in messages", () => {
    const result = pickMessages(sampleMessages, ["Common", "NonExistent"]);
    expect(Object.keys(result)).toEqual(["Common"]);
  });

  it("returns an empty object for an empty namespaces array", () => {
    const result = pickMessages(sampleMessages, []);
    expect(result).toEqual({});
  });
});
