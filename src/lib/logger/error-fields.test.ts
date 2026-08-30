import { describe, expect, it } from "vitest";
import { errorLogFields } from "./error-fields";

describe("errorLogFields", () => {
  it("keeps only a stable Error name and errno-style code", () => {
    const error = Object.assign(new TypeError("postgres://role:secret@db/internal"), {
      code: "ECONNREFUSED",
    });

    expect(errorLogFields(error)).toEqual({
      name: "TypeError",
      code: "ECONNREFUSED",
    });
    expect(errorLogFields(error)).not.toHaveProperty("message");
    expect(errorLogFields(error)).not.toHaveProperty("stack");
  });

  it("uses explicit unknown sentinels when no stable shape exists", () => {
    expect(errorLogFields("free-form failure text")).toEqual({
      name: "unknown",
      code: "unknown",
    });
  });

  it("rejects free-form custom names and codes", () => {
    const error = Object.assign(new Error("hidden message"), {
      name: "Error for tenant admin@example.com",
      code: "failed against db.internal.example",
    });

    expect(errorLogFields(error)).toEqual({
      name: "unknown",
      code: "unknown",
    });
  });

  it("does not throw when a caught value has a hostile code getter", () => {
    const error = new Error("original failure");
    Object.defineProperty(error, "code", {
      get() {
        throw new Error("getter failure");
      },
    });

    expect(errorLogFields(error)).toEqual({ name: "Error", code: "unknown" });
  });
});
