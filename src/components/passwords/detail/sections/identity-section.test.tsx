// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("../../shared/copy-button", () => ({
  CopyButton: () => <button type="button" data-testid="copy">copy</button>,
}));

import { IdentitySection } from "./identity-section";
import type { InlineDetailData } from "@/types/entry";

const baseData: InlineDetailData = {
  id: "e1",
  password: "",
  url: null,
  urlHost: null,
  notes: null,
  customFields: [],
  passwordHistory: [],
  fullName: "John Doe",
  address: "1 Main St",
  phone: "555-0100",
  email: "john@example.com",
  idNumber: "ABC-12345",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("IdentitySection", () => {
  it("renders non-sensitive fields in plaintext but masks the address", () => {
    render(
      <IdentitySection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("John Doe")).toBeInTheDocument();
    expect(screen.getByText("555-0100")).toBeInTheDocument();
    expect(screen.getByText("john@example.com")).toBeInTheDocument();
    // The address is sensitive (SENSITIVE_FIELDS.IDENTITY) → masked by default.
    expect(screen.queryByText("1 Main St")).not.toBeInTheDocument();
  });

  it("masks the idNumber AND the address by default (not exposing the values)", () => {
    render(
      <IdentitySection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    // Both idNumber and the legacy address render the dotted placeholder.
    expect(screen.getAllByText("••••••••").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("ABC-12345")).not.toBeInTheDocument();
    expect(screen.queryByText("1 Main St")).not.toBeInTheDocument();
  });

  it("reveals the masked address fields when the reveal toggle is clicked", () => {
    render(
      <IdentitySection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.queryByText("1 Main St")).not.toBeInTheDocument();
    // The legacy address row's reveal toggle (one of the "reveal" buttons).
    fireEvent.click(screen.getAllByRole("button", { name: "reveal" })[0]);
    expect(screen.getByText("1 Main St")).toBeInTheDocument();
  });

  it("renders structured fields: givenName/city plaintext, postalCode masked", () => {
    const structuredData: InlineDetailData = {
      ...baseData,
      address: null,
      givenName: "Taro",
      city: "Shinjuku",
      postalCode: "160-0022",
    };
    render(
      <IdentitySection
        data={structuredData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("Taro")).toBeInTheDocument();
    expect(screen.getByText("Shinjuku")).toBeInTheDocument();
    // postalCode is sensitive → masked.
    expect(screen.queryByText("160-0022")).not.toBeInTheDocument();
  });
});
