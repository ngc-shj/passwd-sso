// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { CopyButton } from "./copy-button";

describe("CopyButton", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
        readText: vi.fn().mockResolvedValue(""),
      },
      configurable: true,
    });
  });

  it("renders a button with copy tooltip text", () => {
    render(<CopyButton getValue={() => "secret"} />);
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("calls navigator.clipboard.writeText with resolved value when clicked", async () => {
    const writeTextSpy = navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    const getValue = vi.fn().mockResolvedValue("my-value");

    render(<CopyButton getValue={getValue} />);

    fireEvent.click(screen.getByRole("button"));

    await waitFor(() => {
      expect(getValue).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(writeTextSpy).toHaveBeenCalledWith("my-value");
    });
  });

  it("renders provided label alongside the icon", () => {
    render(<CopyButton getValue={() => "x"} label="Copy URL" />);
    expect(screen.getByText("Copy URL")).toBeInTheDocument();
  });
});
