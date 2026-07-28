import { describe, it, expect } from "vitest";
import { normalizeErrorCode } from "../../lib/error-utils";

describe("normalizeErrorCode", () => {
  it("normalizes Chrome network error", () => {
    expect(normalizeErrorCode(new Error("Failed to fetch"), "FALLBACK")).toBe(
      "NETWORK_ERROR",
    );
  });

  it("normalizes Firefox network error", () => {
    expect(
      normalizeErrorCode(
        new Error("NetworkError when attempting to fetch resource."),
        "FALLBACK",
      ),
    ).toBe("NETWORK_ERROR");
  });

  it("normalizes Safari network error", () => {
    expect(normalizeErrorCode(new Error("Load failed"), "FALLBACK")).toBe(
      "NETWORK_ERROR",
    );
  });

  it("returns raw message for non-network errors", () => {
    expect(normalizeErrorCode(new Error("INVALID_TOKEN"), "FALLBACK")).toBe(
      "INVALID_TOKEN",
    );
  });

  // The return value is rendered as a popup toast and postMessage'd into the page's
  // world by the WebAuthn bridge. A JSON.parse over decrypted vault plaintext throws
  // a SyntaxError whose message embeds a window of that plaintext, so a free-form
  // message must never pass through.
  it("does not pass through a SyntaxError carrying decrypted plaintext", () => {
    const err = (() => {
      try {
        JSON.parse('{"username":"bob","password":S3cr3t-Passw0rd-VeryLong}');
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect((err as Error).message).toContain("S3cr3t");
    expect(normalizeErrorCode(err, "FALLBACK")).toBe("FALLBACK");
  });

  it("does not pass through free-form prose messages", () => {
    expect(
      normalizeErrorCode(new Error("Expected uncompressed P-256 public key"), "FALLBACK"),
    ).toBe("FALLBACK");
    expect(normalizeErrorCode(new Error("not a code"), "FALLBACK")).toBe("FALLBACK");
    // A lowercase or mixed-case token is prose, not a code.
    expect(normalizeErrorCode(new Error("InvalidToken"), "FALLBACK")).toBe("FALLBACK");
  });

  it("returns fallback for non-Error values", () => {
    expect(normalizeErrorCode("string error", "FALLBACK")).toBe("FALLBACK");
    expect(normalizeErrorCode(42, "FALLBACK")).toBe("FALLBACK");
    expect(normalizeErrorCode(null, "FALLBACK")).toBe("FALLBACK");
  });

  it("returns fallback for Error with empty message", () => {
    expect(normalizeErrorCode(new Error(""), "FALLBACK")).toBe("FALLBACK");
  });
});
