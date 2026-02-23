import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock("./resend-provider", () => ({
  ResendProvider: class MockResend {
    static calls: unknown[][] = [];
    send = mockSend;
    constructor(...args: unknown[]) {
      MockResend.calls.push(args);
    }
  },
}));

vi.mock("./smtp-provider", () => ({
  SmtpProvider: class MockSmtp {
    static calls: unknown[][] = [];
    send = mockSend;
    constructor(...args: unknown[]) {
      MockSmtp.calls.push(args);
    }
  },
}));

vi.mock("@/lib/logger", () => {
  const warn = vi.fn();
  const error = vi.fn();
  const logger = { warn, error };
  return { getLogger: () => logger };
});

import { sendEmail, _resetForTesting } from "./index";
import { getLogger } from "@/lib/logger";
import { ResendProvider } from "./resend-provider";
import { SmtpProvider } from "./smtp-provider";

const testMessage = {
  to: "user@example.com",
  subject: "Test",
  html: "<p>Hello</p>",
};

// Access static calls for constructor assertion
const ResendCalls = (ResendProvider as unknown as { calls: unknown[][] }).calls;
const SmtpCalls = (SmtpProvider as unknown as { calls: unknown[][] }).calls;

describe("sendEmail", () => {
  beforeEach(() => {
    _resetForTesting();
    vi.clearAllMocks();
    ResendCalls.length = 0;
    SmtpCalls.length = 0;
    vi.stubEnv("EMAIL_PROVIDER", "");
    vi.stubEnv("EMAIL_FROM", "");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("SMTP_HOST", "");
    vi.stubEnv("SMTP_PORT", "");
    vi.stubEnv("SMTP_USER", "");
    vi.stubEnv("SMTP_PASS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("silently skips when EMAIL_PROVIDER is not set", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "");

    await sendEmail(testMessage);

    expect(mockSend).not.toHaveBeenCalled();
    expect(getLogger().warn).not.toHaveBeenCalled();
  });

  it("creates ResendProvider when EMAIL_PROVIDER=resend", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    vi.stubEnv("EMAIL_FROM", "noreply@test.com");

    await sendEmail(testMessage);

    expect(ResendCalls).toHaveLength(1);
    expect(ResendCalls[0]).toEqual(["re_test_key", "noreply@test.com"]);
    expect(mockSend).toHaveBeenCalledWith(testMessage);
  });

  it("warns and skips when RESEND_API_KEY is missing", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");

    await sendEmail(testMessage);

    expect(getLogger().warn).toHaveBeenCalledWith(
      "EMAIL_PROVIDER=resend but RESEND_API_KEY is not set",
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("creates SmtpProvider when EMAIL_PROVIDER=smtp", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "smtp");
    vi.stubEnv("SMTP_HOST", "localhost");
    vi.stubEnv("SMTP_PORT", "1025");
    vi.stubEnv("EMAIL_FROM", "noreply@localhost");

    await sendEmail(testMessage);

    expect(SmtpCalls).toHaveLength(1);
    expect(SmtpCalls[0]).toEqual([
      {
        host: "localhost",
        port: 1025,
        user: "",
        pass: "",
        from: "noreply@localhost",
      },
    ]);
    expect(mockSend).toHaveBeenCalledWith(testMessage);
  });

  it("warns and skips when SMTP_HOST is missing", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "smtp");

    await sendEmail(testMessage);

    expect(getLogger().warn).toHaveBeenCalledWith(
      "EMAIL_PROVIDER=smtp but SMTP_HOST is not set",
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("warns on unknown EMAIL_PROVIDER value", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "unknown");

    await sendEmail(testMessage);

    expect(getLogger().warn).toHaveBeenCalledWith(
      { provider: "unknown" },
      "Unknown EMAIL_PROVIDER value",
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("logs error on send failure but does not throw", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");
    const error = new Error("API error");
    mockSend.mockRejectedValueOnce(error);

    await expect(sendEmail(testMessage)).resolves.toBeUndefined();

    expect(getLogger().error).toHaveBeenCalledWith(
      { to: "user@example.com", subject: "Test", err: error },
      "email.send.failed",
    );
  });

  it("reuses provider on subsequent calls", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");

    await sendEmail(testMessage);
    await sendEmail(testMessage);

    expect(ResendCalls).toHaveLength(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it("defaults EMAIL_FROM to noreply@localhost", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_key");

    await sendEmail(testMessage);

    expect(ResendCalls[0]).toEqual(["re_test_key", "noreply@localhost"]);
  });
});
