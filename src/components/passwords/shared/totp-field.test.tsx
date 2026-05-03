// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/ui/qr-scanner-client", () => ({
  parseOtpauthUri: (input: string) => {
    if (input.startsWith("otpauth://")) {
      return { secret: "JBSWY3DPEHPK3PXP", algorithm: "SHA1", digits: 6, period: 30 };
    }
    return null;
  },
}));

vi.mock("../dialogs/qr-capture-dialog", () => ({
  QRCaptureDialog: () => null,
}));

import { TOTPField } from "./totp-field";

describe("TOTPField (input mode)", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(""),
      },
      configurable: true,
    });
  });

  it("renders input with current secret and remove button when totp is set", () => {
    const onChange = vi.fn();
    render(
      <TOTPField
        mode="input"
        totp={{ secret: "ABCDEFGHIJKLMNOP" }}
        onChange={onChange}
      />,
    );

    const input = screen.getByPlaceholderText("inputPlaceholder") as HTMLInputElement;
    expect(input.value).toBe("ABCDEFGHIJKLMNOP");
  });

  it("calls onChange with parsed secret when given an otpauth URI", () => {
    const onChange = vi.fn();
    render(<TOTPField mode="input" totp={null} onChange={onChange} />);

    const input = screen.getByPlaceholderText("inputPlaceholder") as HTMLInputElement;
    fireEvent.change(input, {
      target: { value: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" },
    });

    expect(onChange).toHaveBeenCalledWith({
      secret: "JBSWY3DPEHPK3PXP",
      algorithm: "SHA1",
      digits: 6,
      period: 30,
    });
  });

  it("calls onChange with cleaned base32 secret when input is >= 16 chars", () => {
    const onChange = vi.fn();
    render(<TOTPField mode="input" totp={null} onChange={onChange} />);

    const input = screen.getByPlaceholderText("inputPlaceholder");
    fireEvent.change(input, { target: { value: "abcd-efgh ijkl mnop" } });

    expect(onChange).toHaveBeenCalledWith({ secret: "ABCDEFGHIJKLMNOP" });
  });

  it("calls onChange with null when cleared and totp was previously set", () => {
    const onChange = vi.fn();
    render(
      <TOTPField
        mode="input"
        totp={{ secret: "ABCDEFGHIJKLMNOP" }}
        onChange={onChange}
      />,
    );

    const input = screen.getByPlaceholderText("inputPlaceholder");
    fireEvent.change(input, { target: { value: "" } });

    expect(onChange).toHaveBeenCalledWith(null);
  });
});
