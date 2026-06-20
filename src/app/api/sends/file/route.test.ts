import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMultipartRequest, parseResponse } from "@/__tests__/helpers/request-builder";
import { DEFAULT_SESSION } from "@/__tests__/helpers/mock-auth";

const {
  mockAuth,
  mockCreate,
  mockAggregate,
  mockUserFindUnique,
  mockCheck,
  mockLogAudit,
  mockFileTypeFromBuffer,
  mockWithUserTenantRls,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockCreate: vi.fn(),
  mockAggregate: vi.fn(),
  mockUserFindUnique: vi.fn(),
  mockCheck: vi.fn().mockResolvedValue({ allowed: true }),
  mockLogAudit: vi.fn(),
  mockFileTypeFromBuffer: vi.fn(),
  mockWithUserTenantRls: vi.fn(async (_userId: string, fn: () => unknown) => fn()),
}));

vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    passwordShare: { create: mockCreate, aggregate: mockAggregate },
    user: { findUnique: mockUserFindUnique },
  },
}));
vi.mock("@/lib/crypto/crypto-server", () => ({
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
  generateAccessPassword: () => "generated-pw",
  hashAccessPassword: () => "hashed-pw",
}));
vi.mock("@/lib/security/rate-limit", () => ({
  createRateLimiter: () => ({ check: mockCheck, clear: vi.fn() }),
}));
vi.mock("@/lib/audit/audit", () => ({
  logAuditAsync: mockLogAudit,
  extractRequestMeta: () => ({ ip: "127.0.0.1", userAgent: "Test" }),
  personalAuditBase: vi.fn((_, userId) => ({ scope: "PERSONAL", userId })),
}));
vi.mock("@/lib/tenant-context", () => ({
  withUserTenantRls: mockWithUserTenantRls,
}));
vi.mock("file-type", () => ({
  fileTypeFromBuffer: mockFileTypeFromBuffer,
}));

import { POST } from "./route";

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
    const file = new File(["hello world"], (overrides.filename as string) ?? "test.txt", {
      type: (overrides.contentType as string) ?? "text/plain",
    });
    fd.append("file", file);
  }
  return fd;
}

describe("POST /api/sends/file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindUnique.mockResolvedValue({ tenantId: "tenant-1" });
    mockCheck.mockResolvedValue({ allowed: true });
    mockFileTypeFromBuffer.mockResolvedValue(undefined);
    mockAggregate.mockResolvedValue({ _sum: { sendSizeBytes: 0 } });
  });

  it("returns 401 when unauthenticated", async () => {
    mockAuth.mockResolvedValue(null);
    const req = await createMultipartRequest("http://localhost/api/sends/file", createFormData());
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(401);
    expect(json.error).toBe("UNAUTHORIZED");
  });

  it("returns 400 when FormData parsing fails", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const { NextRequest } = await import("next/server");
    const body = JSON.stringify({ name: "test" });
    const req = new NextRequest("http://localhost/api/sends/file", {
      method: "POST",
      // Valid content-length so the multipart size gate passes and we reach
      // formData() — this test exercises the parse-failure path specifically.
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
      },
      body,
    } as ConstructorParameters<typeof NextRequest>[1]);
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
    const req = await createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("VALIDATION_ERROR");
    expect(json.details.file).toBeDefined();
  });

  it("returns 400 when file size exceeds 10MB", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const bigContent = new Uint8Array(10 * 1024 * 1024 + 1);
    const bigFile = new File([bigContent], "big.bin", { type: "application/octet-stream" });
    const req = await createMultipartRequest("http://localhost/api/sends/file", createFormData({ file: bigFile }));
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("SEND_FILE_TOO_LARGE");
  });

  it("returns 413 (fail-closed) when Content-Length is absent (chunked-body DoS guard)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const req = await createMultipartRequest(
      "http://localhost/api/sends/file",
      createFormData(),
      { omitContentLength: true },
    );
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(413);
    expect(json.error).toBe("PAYLOAD_TOO_LARGE");
  });

  it("returns 400 when storage limit exceeded (413 semantics)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockAggregate.mockResolvedValue({ _sum: { sendSizeBytes: 99 * 1024 * 1024 } });
    const largeFile = new File([new Uint8Array(2 * 1024 * 1024)], "medium.bin", {
      type: "application/octet-stream",
    });
    const req = await createMultipartRequest("http://localhost/api/sends/file", createFormData({ file: largeFile }));
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);
    expect(status).toBe(400);
    expect(json.error).toBe("SEND_STORAGE_LIMIT_EXCEEDED");
  });

  it("creates file send successfully and returns 201 with correct shape", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const expiresAt = new Date(Date.now() + 86400_000);
    mockCreate.mockResolvedValue({ id: "share-1", expiresAt });

    const req = await createMultipartRequest("http://localhost/api/sends/file", createFormData());
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.id).toBe("share-1");
    expect(json.token).toBe("a".repeat(64));
    expect(json.url).toBe(`/s/${"a".repeat(64)}`);
    expect(json).toHaveProperty("expiresAt");
    expect(json).not.toHaveProperty("accessPassword");

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          shareType: "FILE",
          entryType: null,
          sendName: "Test File",
          sendFilename: "test.txt",
          createdById: DEFAULT_SESSION.user.id,
        }),
      }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SEND_CREATE",
        metadata: expect.objectContaining({ sendType: "FILE" }),
      }),
    );
  });

  it("includes accessPassword in response when requirePassword is set", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const expiresAt = new Date(Date.now() + 86400_000);
    mockCreate.mockResolvedValue({ id: "share-2", expiresAt });

    const fd = createFormData();
    fd.append("requirePassword", "true");
    const req = await createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(201);
    expect(json.accessPassword).toBe("generated-pw");
  });

  it("aggregate and user lookups run in parallel (Promise.all)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    const expiresAt = new Date(Date.now() + 86400_000);
    mockCreate.mockResolvedValue({ id: "share-3", expiresAt });

    const req = await createMultipartRequest("http://localhost/api/sends/file", createFormData());
    await POST(req as never);

    // Both aggregate and user.findUnique must be called
    expect(mockAggregate).toHaveBeenCalledOnce();
    expect(mockUserFindUnique).toHaveBeenCalledOnce();
  });

  // H5 regression tests — the magic-byte gate previously accepted any file
  // whose declared Content-Type was application/octet-stream, including
  // SVG/HTML/JS payloads. Defense-in-depth: also deny by filename extension
  // so a renamed .html → .txt can't smuggle markup through the text/* path.

  it("rejects SVG declared as application/octet-stream (magic-byte denylist)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    // file-type detects the real bytes as image/svg+xml even though the
    // client labeled them as octet-stream.
    mockFileTypeFromBuffer.mockResolvedValueOnce({ mime: "image/svg+xml", ext: "svg" });

    const svgBytes = new TextEncoder().encode("<svg><script>alert(1)</script></svg>");
    const file = new File([svgBytes], "image.bin", {
      type: "application/octet-stream",
    });
    const fd = createFormData({ file });
    const req = await createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("SEND_FILE_TYPE_NOT_ALLOWED");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects HTML by filename extension even when bytes have no signature", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    // Plain-text HTML has no file-type magic — detected stays undefined.
    mockFileTypeFromBuffer.mockResolvedValueOnce(undefined);

    const html = new TextEncoder().encode("<html><script>alert(1)</script></html>");
    const file = new File([html], "page.html", { type: "text/plain" });
    const fd = createFormData({ file });
    const req = await createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("SEND_FILE_TYPE_NOT_ALLOWED");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("stores the magic-byte MIME, not the client-declared type, when they match", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFileTypeFromBuffer.mockResolvedValueOnce({ mime: "image/png", ext: "png" });
    const expiresAt = new Date(Date.now() + 86400_000);
    mockCreate.mockResolvedValue({ id: "share-mime", expiresAt });

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const file = new File([png], "image.png", { type: "image/png" });
    const fd = createFormData({ file });
    const req = await createMultipartRequest("http://localhost/api/sends/file", fd);
    await POST(req as never);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ sendContentType: "image/png" }),
      }),
    );
  });

  it("rejects when declared MIME mismatches the magic-byte MIME (strict consistency)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    mockFileTypeFromBuffer.mockResolvedValueOnce({ mime: "image/png", ext: "png" });

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    // A real PNG is being labeled as something else by the client — refuse,
    // both to flag tampering and to avoid storing a misleading content-type.
    const file = new File([png], "image.png", { type: "image/jpeg" });
    const fd = createFormData({ file });
    const req = await createMultipartRequest("http://localhost/api/sends/file", fd);
    const res = await POST(req as never);
    const { status, json } = await parseResponse(res);

    expect(status).toBe(400);
    expect(json.error).toBe("SEND_FILE_TYPE_NOT_ALLOWED");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("falls back sendContentType to application/octet-stream for unsigned text files (does NOT trust client-declared type)", async () => {
    mockAuth.mockResolvedValue(DEFAULT_SESSION);
    // file-type returns undefined for unsigned text — server must NOT
    // store the client-supplied content-type as authoritative.
    mockFileTypeFromBuffer.mockResolvedValueOnce(undefined);
    const expiresAt = new Date(Date.now() + 86400_000);
    mockCreate.mockResolvedValue({ id: "share-text", expiresAt });

    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    const fd = createFormData({ file });
    const req = await createMultipartRequest("http://localhost/api/sends/file", fd);
    await POST(req as never);

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          sendContentType: "application/octet-stream",
        }),
      }),
    );
  });
});
