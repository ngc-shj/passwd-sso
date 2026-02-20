import { describe, it, expect } from "vitest";
import { isValidSendFilename } from "@/lib/validations";

describe("isValidSendFilename", () => {
  // ── Valid filenames ────────────────────────────────────────
  it("accepts simple ASCII filename", () => {
    expect(isValidSendFilename("document.pdf")).toBe(true);
  });

  it("accepts filename with spaces", () => {
    expect(isValidSendFilename("my document.txt")).toBe(true);
  });

  it("accepts filename with hyphens and underscores", () => {
    expect(isValidSendFilename("my-file_v2.tar.gz")).toBe(true);
  });

  it("accepts Japanese filename (CJK)", () => {
    expect(isValidSendFilename("テスト文書.pdf")).toBe(true);
  });

  it("accepts Korean filename (Hangul)", () => {
    expect(isValidSendFilename("한국어파일.txt")).toBe(true);
  });

  it("accepts CJK Compatibility Ideographs", () => {
    expect(isValidSendFilename("\uF900test.txt")).toBe(true);
  });

  it("accepts fullwidth space (U+3000)", () => {
    expect(isValidSendFilename("テスト\u3000文書.pdf")).toBe(true);
  });

  // ── Invalid filenames ──────────────────────────────────────
  it("rejects empty string", () => {
    expect(isValidSendFilename("")).toBe(false);
  });

  it("rejects filename exceeding 255 UTF-8 bytes", () => {
    // Each Japanese char = 3 UTF-8 bytes. 86 chars = 258 bytes > 255
    const longName = "あ".repeat(86) + ".txt";
    expect(isValidSendFilename(longName)).toBe(false);
  });

  it("accepts filename at exactly 255 UTF-8 bytes", () => {
    // 84 chars × 3 bytes = 252 + ".tx" (3 bytes) = 255
    const name = "あ".repeat(84) + ".tx";
    expect(new TextEncoder().encode(name).length).toBe(255);
    expect(isValidSendFilename(name)).toBe(true);
  });

  it("rejects leading dot", () => {
    expect(isValidSendFilename(".hidden")).toBe(false);
  });

  it("rejects trailing dot", () => {
    expect(isValidSendFilename("file.")).toBe(false);
  });

  it("rejects forward slash (path traversal)", () => {
    expect(isValidSendFilename("../etc/passwd")).toBe(false);
  });

  it("rejects backslash (Windows path)", () => {
    expect(isValidSendFilename("folder\\file.txt")).toBe(false);
  });

  it("rejects null byte", () => {
    expect(isValidSendFilename("file\0.txt")).toBe(false);
  });

  it("rejects emoji", () => {
    expect(isValidSendFilename("test😀.txt")).toBe(false);
  });

  it("rejects CRLF characters", () => {
    expect(isValidSendFilename("file\r\n.txt")).toBe(false);
  });

  // ── Windows reserved device names ─────────────────────────
  it("rejects CON", () => {
    expect(isValidSendFilename("CON")).toBe(false);
  });

  it("rejects CON.txt", () => {
    expect(isValidSendFilename("CON.txt")).toBe(false);
  });

  it("rejects con (case-insensitive)", () => {
    expect(isValidSendFilename("con")).toBe(false);
  });

  it("rejects PRN", () => {
    expect(isValidSendFilename("PRN")).toBe(false);
  });

  it("rejects AUX", () => {
    expect(isValidSendFilename("AUX")).toBe(false);
  });

  it("rejects NUL", () => {
    expect(isValidSendFilename("NUL")).toBe(false);
  });

  it("rejects COM1", () => {
    expect(isValidSendFilename("COM1")).toBe(false);
  });

  it("rejects LPT9.txt", () => {
    expect(isValidSendFilename("LPT9.txt")).toBe(false);
  });

  it("accepts CONX (not a reserved name)", () => {
    expect(isValidSendFilename("CONX")).toBe(true);
  });

  it("accepts COM10 (only COM1-9 are reserved)", () => {
    expect(isValidSendFilename("COM10")).toBe(true);
  });
});
