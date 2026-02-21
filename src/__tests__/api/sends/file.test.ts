import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION } from "../../helpers/mock-auth";
import { createMultipartRequest, parseResponse } from "../../helpers/request-builder";

const { mockAuth, mockCreate, mockAggregate, mockCheck, mockLogAudit, mockFileTypeFromBuffer } =
  vi.hoisted(() => ({
    mockAuth: vi.fn(),
    mockCreate: vi.fn(),
    mockAggregate: vi.fn(),
    mockCheck: vi.fn().mockResolvedValue(true),
    mockLogAudit: vi.fn(),
    mockFileTypeFromBuffer: vi.fn(),
  }));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { create: mockCreate, aggregate: mockAggregate },
  },
}));
vi.mock("@/lib/crypto-server", () => ({
  generateShareToken: () => "a".repeat(64),
  hashToken: () => "h".repeat(64),
  encryptShareData: () => ({
    ciphertext: "encrypted",
    iv: "i".repeat(24),
    authTag: "t".repeat(32),
    masterKeyVersion: 1,
  }),
  encryptShareBinary: () => ({
    ciphertext: Buffer.from("encrypted-file"),
    iv: "f".repeat(24),
    authTag: "g".repeat(32),
    masterKeyVersion: 1,
  }),
}));
vi.mock("@/lib/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit", () => ({
  logAudit: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
}));
vi.mock("file-type", () => ({
  fileTypeFromBuffer: mockFileTypeFromBuffer,
}));

import { POST } from "@/app/api/sends/file/route";

function createFormData(overrides: Record<string, unknown> = {}): FormData {
  const fd = new FormData();
  fd.append("name", (overrides.name as string) ?? "Test File");
  fd.append("expiresIn", (overrides.expiresIn as string) ?? "1d");
  if (overrides.maxViews !== undefined) {
    fd.append("maxViews", String(overrides.maxViews));
  }

  if (overrides.file !== undefined) {
    fd.append("file", overrides.file as Blob);
  } else {
    const file = new File(["hello world"], overrides.filename as string ?? "test.txt", {
      type: (overrides.contentType as string) ?? "text/plain",
    });
    fd.append("file", file);
  }

  return fd;
}

describe("POST /api/sends/file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheck.mockResolvedValue(true);
    mockFileTypeFromBuffer.mockResolvedValue(undefined); // text files
    mockAggregate.mockResolvedValue({ _sum: { sendSizeBytes: 0 } });
  });

  it("returns 401 when not authenticated", async () => {
    mockAuth.mockResolvedValue(null);

    const req = createMultipartRequest(
      "http://localhost/api/sends/file",
      createFormData()
    );
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 429 when rate limited", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCheck.mockResolvedValue(false);

    const req = createMultipartRequest(
      "http://localhost/api/sends/file",
      createFormData()
    );
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(429);
    expect(json.error).toBe("RATE_LIMIT_EXCEEDED");
  });

  it("returns 400 when FormData parsing fails", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    // Send non-FormData body that will cause req.formData() to throw
    const req = new (await import("next/server")).NextRequest(
      "http://localhost/api/sends/file",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      } as ConstructorParameters<typeof import("next/server").NextRequest>[1]
    );
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("INVALID_FORM_DATA");
  });

  it("returns 400 when file field is missing", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const fd = new FormData();
    fd.append("name", "Test");
    fd.append("expiresIn", "1d");
    // No file field appended

    const req = createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details.file).toBeDefined();
  });

  it("accepts file at exactly 10MB", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCreate.mockResolvedValue({ id: "share-1", expiresAt: new Date() });

    const exactContent = new Uint8Array(10 * 1024 * 1024);
    const exactFile = new File([exactContent], "exact.bin", {
      type: "application/octet-stream",
    });

    const req = createMultipartRequest(
      "http://localhost/api/sends/file",
      createFormData({ file: exactFile })
    );
    const res = await POST(req as never);

    expect(res.status).toBe(200);
  });

  it("returns 400 when file size exceeds 10MB", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    // Create a file just over 10MB
    const bigContent = new Uint8Array(10 * 1024 * 1024 + 1);
    const bigFile = new File([bigContent], "big.bin", {
      type: "application/octet-stream",
    });

    const req = createMultipartRequest(
      "http://localhost/api/sends/file",
      createFormData({ file: bigFile })
    );
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("SEND_FILE_TOO_LARGE");
  });

  it("accepts file when detected mime matches declared type", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/png", ext: "png" });
    mockCreate.mockResolvedValue({ id: "share-1", expiresAt: new Date() });

    const fd = createFormData({ contentType: "image/png", filename: "test.png" });
    const req = createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);

    expect(res.status).toBe(200);
  });

  it("accepts file when declared type is application/octet-stream even if detected type differs", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/png", ext: "png" });
    mockCreate.mockResolvedValue({ id: "share-1", expiresAt: new Date() });

    const fd = createFormData({ contentType: "application/octet-stream", filename: "test.bin" });
    const req = createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);

    expect(res.status).toBe(200);
  });

  it("returns 400 when magic byte does not match declared content type", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFileTypeFromBuffer.mockResolvedValue({ mime: "image/png", ext: "png" });

    const fd = createFormData({ contentType: "image/jpeg", filename: "test.jpg" });

    const req = createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("SEND_FILE_TYPE_NOT_ALLOWED");
  });

  it("accepts file when fileTypeFromBuffer returns undefined (text files)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFileTypeFromBuffer.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue({ id: "share-1", expiresAt: new Date() });

    const req = createMultipartRequest(
      "http://localhost/api/sends/file",
      createFormData()
    );
    const res = await POST(req as never);

    expect(res.status).toBe(200);
  });

  it("returns 400 when filename contains path traversal", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const fd = createFormData({ filename: "../etc/passwd" });

    const req = createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("accepts Japanese filename", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockCreate.mockResolvedValue({ id: "share-1", expiresAt: new Date() });

    const fd = createFormData({ filename: "テスト文書.txt" });

    const req = createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);

    expect(res.status).toBe(200);
  });

  it("returns 400 for emoji in filename", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const fd = createFormData({ filename: "test😀.txt" });

    const req = createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 for empty filename", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);

    const file = new File(["data"], "", { type: "text/plain" });
    const fd = createFormData({ file });

    const req = createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
  });

  it("returns 400 when storage limit exceeded", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    // 99MB already used, new file would exceed 100MB limit
    mockAggregate.mockResolvedValue({
      _sum: { sendSizeBytes: 99 * 1024 * 1024 },
    });

    // Default file is "hello world" = 11 bytes, so we need a larger file
    const largeFile = new File(
      [new Uint8Array(2 * 1024 * 1024)],
      "medium.bin",
      { type: "application/octet-stream" }
    );
    const fdLarge = createFormData({ file: largeFile });

    const req = createMultipartRequest(
      "http://localhost/api/sends/file",
      fdLarge
    );
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("SEND_STORAGE_LIMIT_EXCEEDED");
  });

  it("creates file send successfully", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const expiresAt = new Date(Date.now() + 86400_000);
    mockCreate.mockResolvedValue({ id: "share-1", expiresAt });

    const req = createMultipartRequest(
      "http://localhost/api/sends/file",
      createFormData()
    );
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(200);
    expect(json.id).toBe("share-1");
    expect(json.token).toBe("a".repeat(64));
    expect(json.url).toBe(`/s/${"a".repeat(64)}`);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shareType: "FILE",
          entryType: null,
          sendName: "Test File",
          sendFilename: "test.txt",
          createdById: DEFAULT_SESSION.user.id,
        }),
      })
    );

    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SEND_CREATE",
        metadata: expect.objectContaining({ sendType: "FILE" }),
      })
    );
  });
});
