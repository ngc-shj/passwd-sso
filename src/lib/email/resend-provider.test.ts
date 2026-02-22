import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockResendSend } = vi.hoisted(() => ({
  mockResendSend: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: mockResendSend };
  },
}));

import { ResendProvider } from "./resend-provider";

describe("ResendProvider", () => {
  const from = "noreply@example.com";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends email via Resend SDK", async () => {
    mockResendSend.mockResolvedValueOnce({ id: "msg_123" });
    const provider = new ResendProvider("re_key", from);

    await provider.send({
      to: "user@example.com",
      subject: "Test",
      html: "<p>Hello</p>",
      text: "Hello",
    });

    expect(mockResendSend).toHaveBeenCalledWith({
      from,
      to: "user@example.com",
      subject: "Test",
      html: "<p>Hello</p>",
      text: "Hello",
    });
  });

  it("propagates errors from Resend SDK", async () => {
    const error = new Error("Rate limited");
    mockResendSend.mockRejectedValueOnce(error);
    const provider = new ResendProvider("re_key", from);

    await expect(
      provider.send({
        to: "user@example.com",
        subject: "Test",
        html: "<p>Hello</p>",
      }),
    ).rejects.toThrow("Rate limited");
  });
});
