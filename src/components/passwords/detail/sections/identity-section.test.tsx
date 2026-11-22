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

import { IdentitySection } from "./identity-section";
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

// Marks values that went through the reprompt guard so a test can tell a
// guarded copy from a plain one.
const guardedGetter: CreateGuardedGetterFn = (id, reprompt, getter) => () =>
  Promise.resolve(`guarded(${id},${String(reprompt)}):${getter()}`);
const passVerification = (_id: string, _r: boolean, cb: () => void) => cb();
const denyVerification = () => {};

const fullData: InlineDetailData = {
  ...baseData,
  familyName: "Yamada",
  givenName: "Taro",
  addressLine1: "1-2-3 Chiyoda",
  postalCode: "100-0001",
  nationality: "JP",
  dateOfBirth: "1990-01-02",
  notes: "id memo",
};

function renderFull(
  data: InlineDetailData = fullData,
  requireVerification: (id: string, r: boolean, cb: () => void) => void = passVerification,
) {
  return render(
    <IdentitySection
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

describe("IdentitySection copy and reveal", () => {
  beforeEach(() => {
    copied.length = 0;
  });

  it.each([
    ["familyName", "Yamada"],
    ["givenName", "Taro"],
    ["fullName", "John Doe"],
    ["phone", "555-0100"],
    ["email", "john@example.com"],
  ])("copies %s as plain text without the reprompt guard", async (label, value) => {
    renderFull({ ...fullData, requireReprompt: true });
    fireEvent.click(screen.getByRole("button", { name: `copy ${label}` }));
    await waitFor(() => expect(copied).toEqual([value]));
  });

  it.each([
    ["idNumber", "ABC-12345"],
    ["addressLine1", "1-2-3 Chiyoda"],
    ["postalCode", "100-0001"],
    ["address", "1 Main St"],
  ])("copies %s through the reprompt guard", async (label, value) => {
    renderFull({ ...fullData, requireReprompt: true });
    fireEvent.click(screen.getByRole("button", { name: `copy ${label}` }));
    await waitFor(() => expect(copied).toEqual([`guarded(e1,true):${value}`]));
  });

  it.each([
    ["idNumber", "ABC-12345"],
    ["addressLine1", "1-2-3 Chiyoda"],
  ])("reveals %s with an auto-hide notice and masks it again on the second click", (label, shown) => {
    renderFull();
    fireEvent.click(revealToggle(label));
    expect(screen.getByText(shown)).toBeInTheDocument();
    expect(screen.getByText("autoHide")).toBeInTheDocument();

    fireEvent.click(revealToggle(label));
    expect(screen.queryByText(shown)).not.toBeInTheDocument();
    expect(screen.queryByText("autoHide")).not.toBeInTheDocument();
  });

  it("keeps idNumber masked when verification is not granted", () => {
    renderFull(fullData, denyVerification);
    fireEvent.click(revealToggle("idNumber"));
    expect(screen.queryByText("ABC-12345")).not.toBeInTheDocument();
    expect(screen.queryByText("autoHide")).not.toBeInTheDocument();
  });

  it("reveals every address row together from one toggle", () => {
    renderFull();
    fireEvent.click(revealToggle("postalCode"));
    expect(screen.getByText("1-2-3 Chiyoda")).toBeInTheDocument();
    expect(screen.getByText("100-0001")).toBeInTheDocument();
    expect(screen.getByText("1 Main St")).toBeInTheDocument();
  });

  it("renders nationality, the formatted date of birth and notes", () => {
    renderFull();
    expect(screen.getByText("JP")).toBeInTheDocument();
    expect(screen.getByText(formatDate("1990-01-02", "en"))).toBeInTheDocument();
    expect(screen.getByText("id memo")).toBeInTheDocument();
  });
});
