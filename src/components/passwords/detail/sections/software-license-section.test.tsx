// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("../../shared/copy-button", () => ({
  CopyButton: () => <button type="button" data-testid="copy">copy</button>,
}));

import { SoftwareLicenseSection } from "./software-license-section";
import type { InlineDetailData } from "@/types/entry";

const baseData: InlineDetailData = {
  id: "e1",
  password: "",
  url: null,
  urlHost: null,
  notes: null,
  customFields: [],
  passwordHistory: [],
  softwareName: "Acme IDE",
  licenseKey: "AAAA-BBBB-CCCC-DDDD",
  version: "2.0",
  licensee: "Alice",
  email: "alice@example.com",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("SoftwareLicenseSection", () => {
  it("renders software name, version, and licensee", () => {
    render(
      <SoftwareLicenseSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("Acme IDE")).toBeInTheDocument();
    expect(screen.getByText("2.0")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
  });

  it("masks the license key by default", () => {
    render(
      <SoftwareLicenseSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(
      screen.queryByText("AAAA-BBBB-CCCC-DDDD"),
    ).not.toBeInTheDocument();
  });
});
