// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

const { copied } = vi.hoisted(() => ({ copied: [] as unknown[] }));

vi.mock("../../shared/copy-button", () => ({
  CopyButton: ({ getValue, fieldLabel }: { getValue: () => unknown; fieldLabel: string }) => (
    <button
      type="button"
      data-testid="copy"
      aria-label={`copy ${fieldLabel}`}
      onClick={async () => {
        copied.push(await getValue());
      }}
    >
      copy
    </button>
  ),
}));

import { SoftwareLicenseSection } from "./software-license-section";
import { formatDate } from "@/lib/format/format-datetime";
import type { InlineDetailData } from "@/types/entry";
import type { CreateGuardedGetterFn } from "./types";

const baseData: InlineDetailData = {
  id: "e1",
  requireReprompt: false,
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

// Marks values that went through the reprompt guard so a test can tell a
// guarded copy from a plain one.
const guardedGetter: CreateGuardedGetterFn = (id, reprompt, getter) => () =>
  Promise.resolve(`guarded(${id},${String(reprompt)}):${getter()}`);
const passVerification = (_id: string, _r: boolean, cb: () => void) => cb();
const denyVerification = () => {};

const fullData: InlineDetailData = {
  ...baseData,
  purchaseDate: "2024-01-01",
  expirationDate: "2026-01-01",
  notes: "license memo",
};

function renderFull(
  data: InlineDetailData = fullData,
  requireVerification: (id: string, r: boolean, cb: () => void) => void = passVerification,
) {
  return render(
    <SoftwareLicenseSection
      data={data}
      requireVerification={requireVerification}
      createGuardedGetter={guardedGetter}
    />,
  );
}

// The reveal toggle is the icon button in the same field as the label.
function revealToggle(label: string): HTMLElement {
  const field = screen.getByText(label).closest("div");
  if (!field) throw new Error(`no field for ${label}`);
  const toggle = within(field)
    .getAllByRole("button")
    .find((b) => b.dataset.testid !== "copy");
  if (!toggle) throw new Error(`no reveal toggle for ${label}`);
  return toggle;
}

describe("SoftwareLicenseSection copy and reveal", () => {
  beforeEach(() => {
    copied.length = 0;
  });

  it.each([
    ["softwareName", "Acme IDE"],
    ["licensee", "Alice"],
    ["email", "alice@example.com"],
  ])("copies %s as plain text without the reprompt guard", async (label, value) => {
    renderFull({ ...fullData, requireReprompt: true });
    fireEvent.click(screen.getByRole("button", { name: `copy ${label}` }));
    await waitFor(() => expect(copied).toEqual([value]));
  });

  it.each([
    ["licenseKey", "AAAA-BBBB-CCCC-DDDD"],
  ])("copies %s through the reprompt guard", async (label, value) => {
    renderFull({ ...fullData, requireReprompt: true });
    fireEvent.click(screen.getByRole("button", { name: `copy ${label}` }));
    await waitFor(() => expect(copied).toEqual([`guarded(e1,true):${value}`]));
  });

  it.each([
    ["licenseKey", "AAAA-BBBB-CCCC-DDDD"],
  ])("reveals %s with an auto-hide notice and masks it again on the second click", (label, shown) => {
    renderFull();
    fireEvent.click(revealToggle(label));
    expect(screen.getByText(shown)).toBeInTheDocument();
    expect(screen.getByText("autoHide")).toBeInTheDocument();

    fireEvent.click(revealToggle(label));
    expect(screen.queryByText(shown)).not.toBeInTheDocument();
    expect(screen.queryByText("autoHide")).not.toBeInTheDocument();
  });

  it("keeps licenseKey masked when verification is not granted", () => {
    renderFull(fullData, denyVerification);
    fireEvent.click(revealToggle("licenseKey"));
    expect(screen.queryByText("AAAA-BBBB-CCCC-DDDD")).not.toBeInTheDocument();
    expect(screen.queryByText("autoHide")).not.toBeInTheDocument();
  });

  it("renders the formatted purchase and expiration dates and notes", () => {
    renderFull();
    expect(screen.getByText(formatDate("2024-01-01", "en"))).toBeInTheDocument();
    expect(screen.getByText(formatDate("2026-01-01", "en"))).toBeInTheDocument();
    expect(screen.getByText("license memo")).toBeInTheDocument();
  });
});
