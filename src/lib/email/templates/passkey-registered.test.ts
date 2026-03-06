import { describe, it, expect } from "vitest";
import { passkeyRegisteredEmail } from "./passkey-registered";

describe("passkeyRegisteredEmail", () => {
  const testDate = new Date("2026-03-06T12:00:00.000Z");
  const testDevice = "macOS (Chrome)";

  it("returns subject, html, and text for ja locale (default)", () => {
    const result = passkeyRegisteredEmail(testDevice, testDate);
    expect(result.subject).toBe("新しいパスキーが登録されました");
    expect(result.html).toContain("macOS (Chrome)");
    expect(result.text).toContain("macOS (Chrome)");
  });

  it("returns English content for en locale", () => {
    const result = passkeyRegisteredEmail(testDevice, testDate, "en");
    expect(result.subject).toBe("New passkey registered");
    expect(result.html).toContain("New passkey registered");
    expect(result.text).toContain("A new passkey has been registered");
  });

  it("formats date as UTC ISO string", () => {
    const result = passkeyRegisteredEmail(testDevice, testDate, "en");
    expect(result.html).toContain("2026-03-06 12:00:00 UTC");
    expect(result.text).toContain("2026-03-06 12:00:00 UTC");
  });

  it("defaults to 'Unknown' when deviceName is empty", () => {
    const result = passkeyRegisteredEmail("", testDate, "en");
    expect(result.html).toContain("Unknown");
  });

  it("escapes HTML special characters in device name", () => {
    const result = passkeyRegisteredEmail('<script>alert("xss")</script>', testDate);
    expect(result.html).not.toContain("<script>");
    expect(result.html).toContain("&lt;script&gt;");
  });

  it("includes security warning in text body", () => {
    const result = passkeyRegisteredEmail(testDevice, testDate, "en");
    expect(result.text).toContain("remove the passkey");
  });

  it("falls back to en for unknown locale", () => {
    const result = passkeyRegisteredEmail(testDevice, testDate, "de");
    expect(result.subject).toBe("New passkey registered");
  });
});
