// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ password: "GeneratedPwd1!" }),
  }),
}));

import { PasswordGenerator } from "./password-generator";
import { fetchApi } from "@/lib/url-helpers";

describe("PasswordGenerator", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders nothing when open is false", () => {
    const { container } = render(
      <PasswordGenerator open={false} onClose={vi.fn()} onUse={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("calls fetchApi to generate a password when open", async () => {
    render(<PasswordGenerator open={true} onClose={vi.fn()} onUse={vi.fn()} />);

    await waitFor(() => {
      expect(fetchApi).toHaveBeenCalled();
    });

    // The mocked password should appear in DOM
    await waitFor(() => {
      expect(screen.getByText("GeneratedPwd1!")).toBeInTheDocument();
    });
  });

  it("invokes onUse with generated password and current settings when Use is clicked", async () => {
    const onUse = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(
      <PasswordGenerator open={true} onClose={onClose} onUse={onUse} />,
    );

    await waitFor(() => {
      expect(screen.getByText("GeneratedPwd1!")).toBeInTheDocument();
    });

    const useButton = screen.getByRole("button", { name: "use" });
    await user.click(useButton);

    expect(onUse).toHaveBeenCalledWith(
      "GeneratedPwd1!",
      expect.objectContaining({ mode: expect.any(String) }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("calls onClose when Cancel is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<PasswordGenerator open={true} onClose={onClose} onUse={vi.fn()} />);

    const cancelButton = screen.getByRole("button", { name: "cancel" });
    await user.click(cancelButton);

    expect(onClose).toHaveBeenCalled();
  });
});
