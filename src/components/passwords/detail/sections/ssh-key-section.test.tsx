// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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

import { SshKeySection } from "./ssh-key-section";
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
  keyType: "ed25519",
  keySize: 256,
  fingerprint: "SHA256:abc123",
  publicKey: "ssh-ed25519 AAAA...",
  privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----",
  sshPassphrase: "secret-pass",
  sshComment: "alice@laptop",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("SshKeySection", () => {
  it("renders keyType, keySize, fingerprint, and publicKey", () => {
    render(
      <SshKeySection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("ed25519")).toBeInTheDocument();
    expect(screen.getByText("256")).toBeInTheDocument();
    expect(screen.getByText("SHA256:abc123")).toBeInTheDocument();
    expect(screen.getByText("ssh-ed25519 AAAA...")).toBeInTheDocument();
  });

  it("masks the private key and passphrase by default", () => {
    render(
      <SshKeySection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(
      screen.queryByText("-----BEGIN OPENSSH PRIVATE KEY-----"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("secret-pass")).not.toBeInTheDocument();
    expect(screen.getAllByText("••••••••").length).toBeGreaterThan(0);
  });

  it("renders the comment", () => {
    render(
      <SshKeySection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("alice@laptop")).toBeInTheDocument();
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
  notes: "ssh memo",
};

function renderFull(
  data: InlineDetailData = fullData,
  requireVerification: (id: string, r: boolean, cb: () => void) => void = passVerification,
) {
  return render(
    <SshKeySection
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

describe("SshKeySection copy and reveal", () => {
  beforeEach(() => {
    copied.length = 0;
  });

  it.each([
    ["fingerprint", "SHA256:abc123"],
    ["publicKey", "ssh-ed25519 AAAA..."],
    ["comment", "alice@laptop"],
  ])("copies %s as plain text without the reprompt guard", async (label, value) => {
    renderFull({ ...fullData, requireReprompt: true });
    fireEvent.click(screen.getByRole("button", { name: `copy ${label}` }));
    await waitFor(() => expect(copied).toEqual([value]));
  });

  it.each([
    ["privateKey", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["passphrase", "secret-pass"],
  ])("copies %s through the reprompt guard", async (label, value) => {
    renderFull({ ...fullData, requireReprompt: true });
    fireEvent.click(screen.getByRole("button", { name: `copy ${label}` }));
    await waitFor(() => expect(copied).toEqual([`guarded(e1,true):${value}`]));
  });

  it.each([
    ["privateKey", "-----BEGIN OPENSSH PRIVATE KEY-----"],
    ["passphrase", "secret-pass"],
  ])("reveals %s with an auto-hide notice and masks it again on the second click", (label, shown) => {
    renderFull();
    fireEvent.click(revealToggle(label));
    expect(screen.getByText(shown)).toBeInTheDocument();
    expect(screen.getByText("autoHide")).toBeInTheDocument();

    fireEvent.click(revealToggle(label));
    expect(screen.queryByText(shown)).not.toBeInTheDocument();
    expect(screen.queryByText("autoHide")).not.toBeInTheDocument();
  });

  it("keeps passphrase masked when verification is not granted", () => {
    renderFull(fullData, denyVerification);
    fireEvent.click(revealToggle("passphrase"));
    expect(screen.queryByText("secret-pass")).not.toBeInTheDocument();
    expect(screen.queryByText("autoHide")).not.toBeInTheDocument();
  });

  it("renders the notes", () => {
    renderFull();
    expect(screen.getByText("ssh memo")).toBeInTheDocument();
  });
});
