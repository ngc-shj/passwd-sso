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

import { PasskeySection } from "./passkey-section";
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
  relyingPartyId: "example.com",
  relyingPartyName: "Example",
  username: "alice",
  credentialId: "abcdef0123456789",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("PasskeySection", () => {
  it("renders relyingPartyId, relyingPartyName, and username", () => {
    render(
      <PasskeySection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("Example")).toBeInTheDocument();
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("masks the credentialId by default", () => {
    render(
      <PasskeySection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("••••••••")).toBeInTheDocument();
    expect(screen.queryByText("abcdef0123456789")).not.toBeInTheDocument();
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
  creationDate: "2024-05-06",
  deviceInfo: "YubiKey 5",
  notes: "passkey memo",
};

function renderFull(
  data: InlineDetailData = fullData,
  requireVerification: (id: string, r: boolean, cb: () => void) => void = passVerification,
) {
  return render(
    <PasskeySection
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

describe("PasskeySection copy and reveal", () => {
  beforeEach(() => {
    copied.length = 0;
  });

  it.each([
    ["relyingPartyId", "example.com"],
    ["username", "alice"],
  ])("copies %s as plain text without the reprompt guard", async (label, value) => {
    renderFull({ ...fullData, requireReprompt: true });
    fireEvent.click(screen.getByRole("button", { name: `copy ${label}` }));
    await waitFor(() => expect(copied).toEqual([value]));
  });

  it.each([
    ["credentialId", "abcdef0123456789"],
  ])("copies %s through the reprompt guard", async (label, value) => {
    renderFull({ ...fullData, requireReprompt: true });
    fireEvent.click(screen.getByRole("button", { name: `copy ${label}` }));
    await waitFor(() => expect(copied).toEqual([`guarded(e1,true):${value}`]));
  });

  it.each([
    ["credentialId", "abcdef0123456789"],
  ])("reveals %s with an auto-hide notice and masks it again on the second click", (label, shown) => {
    renderFull();
    fireEvent.click(revealToggle(label));
    expect(screen.getByText(shown)).toBeInTheDocument();
    expect(screen.getByText("autoHide")).toBeInTheDocument();

    fireEvent.click(revealToggle(label));
    expect(screen.queryByText(shown)).not.toBeInTheDocument();
    expect(screen.queryByText("autoHide")).not.toBeInTheDocument();
  });

  it("keeps credentialId masked when verification is not granted", () => {
    renderFull(fullData, denyVerification);
    fireEvent.click(revealToggle("credentialId"));
    expect(screen.queryByText("abcdef0123456789")).not.toBeInTheDocument();
    expect(screen.queryByText("autoHide")).not.toBeInTheDocument();
  });

  it("renders the formatted creation date, device info and notes", () => {
    renderFull();
    expect(screen.getByText(formatDate("2024-05-06", "en"))).toBeInTheDocument();
    expect(screen.getByText("YubiKey 5")).toBeInTheDocument();
    expect(screen.getByText("passkey memo")).toBeInTheDocument();
  });
});
