// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { render } from "@testing-library/react";

let mockSearchParams: URLSearchParams;

vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

import { ExtConnectBanner } from "./ext-connect-banner";

describe("ExtConnectBanner", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams();
  });

  it("renders banner when ext_connect=1 is present directly", () => {
    mockSearchParams = new URLSearchParams("ext_connect=1");
    const { container } = render(<ExtConnectBanner />);
    expect(container.textContent).toContain("connectingBanner");
  });

  it("renders banner when callbackUrl contains ext_connect=1", () => {
    mockSearchParams = new URLSearchParams(
      "callbackUrl=/ja/dashboard?ext_connect=1",
    );
    const { container } = render(<ExtConnectBanner />);
    expect(container.textContent).toContain("connectingBanner");
  });

  it("returns null when ext_connect is absent", () => {
    mockSearchParams = new URLSearchParams("callbackUrl=/ja/dashboard");
    const { container } = render(<ExtConnectBanner />);
    expect(container.innerHTML).toBe("");
  });

  it("applies className prop", () => {
    mockSearchParams = new URLSearchParams("ext_connect=1");
    const { container } = render(<ExtConnectBanner className="mb-4" />);
    const div = container.firstElementChild!;
    expect(div.classList.contains("mb-4")).toBe(true);
  });
});
