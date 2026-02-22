import { describe, expect, it, vi, beforeEach } from "vitest";

const { mockSendMail } = vi.hoisted(() => ({
  mockSendMail: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({ sendMail: mockSendMail }),
  },
}));

import { SmtpProvider } from "./smtp-provider";
import nodemailer from "nodemailer";

describe("SmtpProvider", () => {
  const opts = {
    host: "localhost",
    port: 1025,
    from: "noreply@localhost",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates transport with correct options", () => {
    new SmtpProvider(opts);

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: "localhost",
      port: 1025,
      secure: false,
    });
  });

  it("creates secure transport on port 465", () => {
    new SmtpProvider({ ...opts, port: 465 });

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: "localhost",
      port: 465,
      secure: true,
    });
  });

  it("includes auth when user and pass are provided", () => {
    new SmtpProvider({ ...opts, user: "admin", pass: "secret" });

    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: "localhost",
      port: 1025,
      secure: false,
      auth: { user: "admin", pass: "secret" },
    });
  });

  it("sends email via nodemailer", async () => {
    mockSendMail.mockResolvedValueOnce({});
    const provider = new SmtpProvider(opts);

    await provider.send({
      to: "user@example.com",
      subject: "Test",
      html: "<p>Hello</p>",
      text: "Hello",
    });

    expect(mockSendMail).toHaveBeenCalledWith({
      from: "noreply@localhost",
      to: "user@example.com",
      subject: "Test",
      html: "<p>Hello</p>",
      text: "Hello",
    });
  });

  it("propagates errors from nodemailer", async () => {
    const error = new Error("Connection refused");
    mockSendMail.mockRejectedValueOnce(error);
    const provider = new SmtpProvider(opts);

    await expect(
      provider.send({
        to: "user@example.com",
        subject: "Test",
        html: "<p>Hello</p>",
      }),
    ).rejects.toThrow("Connection refused");
  });
});
