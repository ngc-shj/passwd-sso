import { describe, it, expect } from "vitest";
import { formatFileSize } from "./format-file-size";

describe("formatFileSize", () => {
  it("formats 0 bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
  });

  it("formats bytes below 1 KB", () => {
    expect(formatFileSize(1023)).toBe("1023 B");
  });

  it("formats exactly 1 KB", () => {
    expect(formatFileSize(1024)).toBe("1.0 KB");
  });

  it("formats KB range", () => {
    expect(formatFileSize(1024 * 512)).toBe("512.0 KB");
  });

  it("formats just below 1 MB", () => {
    expect(formatFileSize(1024 * 1024 - 1)).toBe("1024.0 KB");
  });

  it("formats exactly 1 MB", () => {
    expect(formatFileSize(1024 * 1024)).toBe("1.0 MB");
  });

  it("formats 10 MB (Send file size limit)", () => {
    expect(formatFileSize(10 * 1024 * 1024)).toBe("10.0 MB");
  });
});
