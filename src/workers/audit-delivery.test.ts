import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac, createHash } from "node:crypto";

const {
  mockValidateAndFetch,
  mockSanitizeForExternalDelivery,
  mockSanitizeErrorForStorage,
} = vi.hoisted(() => ({
  mockValidateAndFetch: vi.fn(),
  mockSanitizeForExternalDelivery: vi.fn((v: unknown) => v),
  mockSanitizeErrorForStorage: vi.fn((v: unknown) => v),
}));

vi.mock("@/lib/external-http", () => ({
  validateAndFetch: mockValidateAndFetch,
  sanitizeForExternalDelivery: mockSanitizeForExternalDelivery,
  sanitizeErrorForStorage: mockSanitizeErrorForStorage,
}));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  webhookDeliverer,
  siemHecDeliverer,
  s3ObjectDeliverer,
  DELIVERERS,
} from "./audit-delivery";
import type { DeliveryPayload, TargetConfig } from "./audit-delivery";

// ─── Test fixtures ────────────────────────────────────────────

const PAYLOAD: DeliveryPayload = {
  id: "outbox-123",
  tenantId: "tenant-abc",
  action: "PASSWORD_CREATE",
  scope: "PERSONAL",
  userId: "user-xyz",
  actorType: "HUMAN",
  metadata: { entryId: "entry-1" },
  createdAt: "2024-03-15T10:30:00.000Z",
};

const WEBHOOK_CONFIG: TargetConfig = {
  url: "https://example.com/webhook",
  secret: "my-secret-key",
};

const HEC_CONFIG: TargetConfig = {
  url: "https://splunk.example.com/services/collector",
  token: "hec-token-xyz",
};

const S3_CONFIG: TargetConfig = {
  endpoint: "https://s3.us-east-1.amazonaws.com/my-bucket",
  region: "us-east-1",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

// ─── webhookDeliverer ─────────────────────────────────────────

describe("webhookDeliverer.deliver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSanitizeForExternalDelivery.mockImplementation((v: unknown) => v);
    mockSanitizeErrorForStorage.mockImplementation((v: unknown) => v);
    mockValidateAndFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it("calls validateAndFetch with POST and correct headers on happy path", async () => {
    await webhookDeliverer.deliver(WEBHOOK_CONFIG, PAYLOAD);

    expect(mockValidateAndFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockValidateAndFetch.mock.calls[0];
    expect(url).toBe("https://example.com/webhook");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
    expect(opts.headers["X-Signature"]).toMatch(/^sha256=/);
  });

  it("computes correct HMAC-SHA256 signature", async () => {
    await webhookDeliverer.deliver(WEBHOOK_CONFIG, PAYLOAD);

    const [, opts] = mockValidateAndFetch.mock.calls[0];
    const body = opts.body as string;
    const expectedSig = createHmac("sha256", "my-secret-key").update(body).digest("hex");
    expect(opts.headers["X-Signature"]).toBe(`sha256=${expectedSig}`);
  });

  it("calls sanitizeForExternalDelivery before sending", async () => {
    const sanitized = { ...PAYLOAD, metadata: {} };
    mockSanitizeForExternalDelivery.mockReturnValue(sanitized);

    await webhookDeliverer.deliver(WEBHOOK_CONFIG, PAYLOAD);

    expect(mockSanitizeForExternalDelivery).toHaveBeenCalledWith(PAYLOAD);
    const [, opts] = mockValidateAndFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual(sanitized);
  });

  it("throws 'Invalid webhook config' when url is missing", async () => {
    await expect(
      webhookDeliverer.deliver({ secret: "s" }, PAYLOAD),
    ).rejects.toThrow("Invalid webhook config");
  });

  it("throws 'Invalid webhook config' when secret is missing", async () => {
    await expect(
      webhookDeliverer.deliver({ url: "https://example.com" }, PAYLOAD),
    ).rejects.toThrow("Invalid webhook config");
  });

  it("throws 'Invalid webhook config' when url is not a valid URL", async () => {
    await expect(
      webhookDeliverer.deliver({ url: "not-a-url", secret: "s" }, PAYLOAD),
    ).rejects.toThrow("Invalid webhook config");
  });

  it("throws on HTTP error with status in message", async () => {
    mockValidateAndFetch.mockResolvedValue({ ok: false, status: 500 });

    await expect(
      webhookDeliverer.deliver(WEBHOOK_CONFIG, PAYLOAD),
    ).rejects.toThrow("Webhook delivery failed with HTTP 500");
  });

  it("throws with sanitized message on network error", async () => {
    mockValidateAndFetch.mockRejectedValue(new Error("network failure"));
    mockSanitizeErrorForStorage.mockReturnValue("sanitized network failure");

    await expect(
      webhookDeliverer.deliver(WEBHOOK_CONFIG, PAYLOAD),
    ).rejects.toThrow("Webhook delivery failed: sanitized network failure");

    expect(mockSanitizeErrorForStorage).toHaveBeenCalledWith("network failure");
  });
});

// ─── siemHecDeliverer ─────────────────────────────────────────

describe("siemHecDeliverer.deliver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSanitizeForExternalDelivery.mockImplementation((v: unknown) => v);
    mockSanitizeErrorForStorage.mockImplementation((v: unknown) => v);
    mockValidateAndFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it("sends correct HEC event format { event, time, sourcetype }", async () => {
    await siemHecDeliverer.deliver(HEC_CONFIG, PAYLOAD);

    expect(mockValidateAndFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockValidateAndFetch.mock.calls[0];
    const body = JSON.parse(opts.body as string);

    expect(body).toHaveProperty("event");
    expect(body).toHaveProperty("time");
    expect(body).toHaveProperty("sourcetype", "passwd-sso:audit");
    expect(body.time).toBe(Math.floor(new Date(PAYLOAD.createdAt).getTime() / 1000));
  });

  it("sends Authorization header as 'Splunk <token>'", async () => {
    await siemHecDeliverer.deliver(HEC_CONFIG, PAYLOAD);

    const [, opts] = mockValidateAndFetch.mock.calls[0];
    expect(opts.headers["Authorization"]).toBe("Splunk hec-token-xyz");
  });

  it("sends POST with Content-Type application/json", async () => {
    await siemHecDeliverer.deliver(HEC_CONFIG, PAYLOAD);

    const [url, opts] = mockValidateAndFetch.mock.calls[0];
    expect(url).toBe("https://splunk.example.com/services/collector");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/json");
  });

  it("calls sanitizeForExternalDelivery before sending", async () => {
    await siemHecDeliverer.deliver(HEC_CONFIG, PAYLOAD);

    expect(mockSanitizeForExternalDelivery).toHaveBeenCalledWith(PAYLOAD);
  });

  it("throws 'Invalid SIEM HEC config' when url is missing", async () => {
    await expect(
      siemHecDeliverer.deliver({ token: "t" }, PAYLOAD),
    ).rejects.toThrow("Invalid SIEM HEC config");
  });

  it("throws 'Invalid SIEM HEC config' when token is missing", async () => {
    await expect(
      siemHecDeliverer.deliver({ url: "https://example.com" }, PAYLOAD),
    ).rejects.toThrow("Invalid SIEM HEC config");
  });

  it("throws on HTTP error", async () => {
    mockValidateAndFetch.mockResolvedValue({ ok: false, status: 503 });

    await expect(
      siemHecDeliverer.deliver(HEC_CONFIG, PAYLOAD),
    ).rejects.toThrow("SIEM HEC delivery failed with HTTP 503");
  });

  it("throws with sanitized message on network error", async () => {
    mockValidateAndFetch.mockRejectedValue(new Error("connection refused"));
    mockSanitizeErrorForStorage.mockReturnValue("sanitized error");

    await expect(
      siemHecDeliverer.deliver(HEC_CONFIG, PAYLOAD),
    ).rejects.toThrow("SIEM HEC delivery failed: sanitized error");
  });
});

// ─── s3ObjectDeliverer ────────────────────────────────────────

describe("s3ObjectDeliverer.deliver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSanitizeForExternalDelivery.mockImplementation((v: unknown) => v);
    mockSanitizeErrorForStorage.mockImplementation((v: unknown) => v);
    mockValidateAndFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it("sends PUT request on happy path", async () => {
    await s3ObjectDeliverer.deliver(S3_CONFIG, PAYLOAD);

    expect(mockValidateAndFetch).toHaveBeenCalledTimes(1);
    const [, opts] = mockValidateAndFetch.mock.calls[0];
    expect(opts.method).toBe("PUT");
  });

  it("sets x-amz-content-sha256 to actual body hash (not UNSIGNED-PAYLOAD)", async () => {
    await s3ObjectDeliverer.deliver(S3_CONFIG, PAYLOAD);

    const [, opts] = mockValidateAndFetch.mock.calls[0];
    const bodyHash = opts.headers["x-amz-content-sha256"] as string;

    // Must be a valid SHA-256 hex string (64 chars)
    expect(bodyHash).toMatch(/^[0-9a-f]{64}$/);

    // Must match actual body content
    const body = opts.body as string;
    const expected = createHash("sha256").update(body).digest("hex");
    expect(bodyHash).toBe(expected);
  });

  it("builds correct object key format: audit-logs/<tenantId>/<YYYY>/<MM>/<DD>/<id>.json", async () => {
    await s3ObjectDeliverer.deliver(S3_CONFIG, PAYLOAD);

    const [url] = mockValidateAndFetch.mock.calls[0];
    // PAYLOAD.createdAt = "2024-03-15T10:30:00.000Z" → 2024/03/15
    expect(url).toContain("audit-logs/tenant-abc/2024/03/15/outbox-123.json");
  });

  it("includes SigV4 Authorization header starting with AWS4-HMAC-SHA256", async () => {
    await s3ObjectDeliverer.deliver(S3_CONFIG, PAYLOAD);

    const [, opts] = mockValidateAndFetch.mock.calls[0];
    const auth = opts.headers["Authorization"] as string;
    expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=/);
  });

  it("SigV4 Authorization header includes correct access key", async () => {
    await s3ObjectDeliverer.deliver(S3_CONFIG, PAYLOAD);

    const [, opts] = mockValidateAndFetch.mock.calls[0];
    const auth = opts.headers["Authorization"] as string;
    expect(auth).toContain("AKIAIOSFODNN7EXAMPLE/");
  });

  it("SigV4 Authorization SignedHeaders includes required headers", async () => {
    await s3ObjectDeliverer.deliver(S3_CONFIG, PAYLOAD);

    const [, opts] = mockValidateAndFetch.mock.calls[0];
    const auth = opts.headers["Authorization"] as string;
    expect(auth).toContain("SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date");
  });

  it("sends x-amz-date header", async () => {
    await s3ObjectDeliverer.deliver(S3_CONFIG, PAYLOAD);

    const [, opts] = mockValidateAndFetch.mock.calls[0];
    expect(opts.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
  });

  it("calls sanitizeForExternalDelivery before sending", async () => {
    await s3ObjectDeliverer.deliver(S3_CONFIG, PAYLOAD);

    expect(mockSanitizeForExternalDelivery).toHaveBeenCalledWith(PAYLOAD);
  });

  it("throws 'Invalid S3 object config' when endpoint is missing", async () => {
    await expect(
      s3ObjectDeliverer.deliver(
        { region: "us-east-1", accessKeyId: "k", secretAccessKey: "s" },
        PAYLOAD,
      ),
    ).rejects.toThrow("Invalid S3 object config");
  });

  it("throws 'Invalid S3 object config' when region is missing", async () => {
    await expect(
      s3ObjectDeliverer.deliver(
        { endpoint: "https://s3.amazonaws.com/bucket", accessKeyId: "k", secretAccessKey: "s" },
        PAYLOAD,
      ),
    ).rejects.toThrow("Invalid S3 object config");
  });

  it("throws on HTTP error", async () => {
    mockValidateAndFetch.mockResolvedValue({ ok: false, status: 403 });

    await expect(
      s3ObjectDeliverer.deliver(S3_CONFIG, PAYLOAD),
    ).rejects.toThrow("Object storage delivery failed with HTTP 403");
  });

  it("throws with sanitized message on network error", async () => {
    mockValidateAndFetch.mockRejectedValue(new Error("timeout"));
    mockSanitizeErrorForStorage.mockReturnValue("sanitized timeout");

    await expect(
      s3ObjectDeliverer.deliver(S3_CONFIG, PAYLOAD),
    ).rejects.toThrow("Object storage delivery failed: sanitized timeout");
  });
});

// ─── Object key format ────────────────────────────────────────

describe("object key date formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSanitizeForExternalDelivery.mockImplementation((v: unknown) => v);
    mockValidateAndFetch.mockResolvedValue({ ok: true, status: 200 });
  });

  it("zero-pads single-digit month and day", async () => {
    const payload: DeliveryPayload = { ...PAYLOAD, createdAt: "2024-01-05T00:00:00.000Z" };
    await s3ObjectDeliverer.deliver(S3_CONFIG, payload);

    const [url] = mockValidateAndFetch.mock.calls[0];
    expect(url).toContain("audit-logs/tenant-abc/2024/01/05/outbox-123.json");
  });

  it("uses UTC date (not local date)", async () => {
    // 2024-12-31T23:59:59Z is Dec 31 in UTC
    const payload: DeliveryPayload = { ...PAYLOAD, createdAt: "2024-12-31T23:59:59.000Z" };
    await s3ObjectDeliverer.deliver(S3_CONFIG, payload);

    const [url] = mockValidateAndFetch.mock.calls[0];
    expect(url).toContain("audit-logs/tenant-abc/2024/12/31/outbox-123.json");
  });
});

// ─── DELIVERERS registry ──────────────────────────────────────

describe("DELIVERERS registry", () => {
  it("has WEBHOOK entry", () => {
    expect(DELIVERERS).toHaveProperty("WEBHOOK");
    expect(typeof DELIVERERS.WEBHOOK.deliver).toBe("function");
  });

  it("has SIEM_HEC entry", () => {
    expect(DELIVERERS).toHaveProperty("SIEM_HEC");
    expect(typeof DELIVERERS.SIEM_HEC.deliver).toBe("function");
  });

  it("has S3_OBJECT entry", () => {
    expect(DELIVERERS).toHaveProperty("S3_OBJECT");
    expect(typeof DELIVERERS.S3_OBJECT.deliver).toBe("function");
  });

  it("does NOT have DB entry", () => {
    expect(DELIVERERS).not.toHaveProperty("DB");
  });

  it("WEBHOOK entry points to webhookDeliverer", () => {
    expect(DELIVERERS.WEBHOOK).toBe(webhookDeliverer);
  });

  it("SIEM_HEC entry points to siemHecDeliverer", () => {
    expect(DELIVERERS.SIEM_HEC).toBe(siemHecDeliverer);
  });

  it("S3_OBJECT entry points to s3ObjectDeliverer", () => {
    expect(DELIVERERS.S3_OBJECT).toBe(s3ObjectDeliverer);
  });
});
