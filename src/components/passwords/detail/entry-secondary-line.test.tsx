// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { ENTRY_TYPE } from "@/lib/constants";
import { EntrySecondaryLine } from "./entry-secondary-line";

// Polyfill ResizeObserver for jsdom (needed by Dropdown primitives)
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// DISPLAY_FINGERPRINT_SHORT = 16 (from src/lib/validations/common.ts)
const DISPLAY_FINGERPRINT_SHORT = 16;

describe("EntrySecondaryLine — happy path per entry type", () => {
  it("LOGIN: renders username and urlHost", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.LOGIN}
        username="alice"
        urlHost="github.com"
      />,
    );
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("github.com")).toBeInTheDocument();
  });

  it("SECURE_NOTE: renders snippet text", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.SECURE_NOTE}
        snippet="My private note"
      />,
    );
    expect(screen.getByText("My private note")).toBeInTheDocument();
  });

  it("CREDIT_CARD: renders brand, masked lastFour, and cardholderName", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.CREDIT_CARD}
        brand="Visa"
        lastFour="4242"
        cardholderName="Alice Smith"
      />,
    );
    expect(screen.getByText("Visa")).toBeInTheDocument();
    expect(screen.getByText("•••• 4242")).toBeInTheDocument();
    expect(screen.getByText("Alice Smith")).toBeInTheDocument();
  });

  it("IDENTITY: renders fullName and masked idNumberLast4", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.IDENTITY}
        fullName="Bob Jones"
        idNumberLast4="7890"
      />,
    );
    expect(screen.getByText("Bob Jones")).toBeInTheDocument();
    expect(screen.getByText("•••• 7890")).toBeInTheDocument();
  });

  it("PASSKEY: renders relyingPartyId and username", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.PASSKEY}
        relyingPartyId="example.com"
        username="passkey-user"
      />,
    );
    expect(screen.getByText("example.com")).toBeInTheDocument();
    expect(screen.getByText("passkey-user")).toBeInTheDocument();
  });

  it("BANK_ACCOUNT: renders bankName and masked accountNumberLast4", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.BANK_ACCOUNT}
        bankName="Chase"
        accountNumberLast4="1234"
      />,
    );
    expect(screen.getByText("Chase")).toBeInTheDocument();
    expect(screen.getByText("•••• 1234")).toBeInTheDocument();
  });

  it("SOFTWARE_LICENSE: renders softwareName and licensee", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.SOFTWARE_LICENSE}
        softwareName="VS Code"
        licensee="dev@example.com"
      />,
    );
    expect(screen.getByText("VS Code")).toBeInTheDocument();
    expect(screen.getByText("dev@example.com")).toBeInTheDocument();
  });

  it("SSH_KEY: renders keyType and truncated fingerprint with ellipsis", () => {
    const fingerprint = "SHA256:abcdefghijklmnopqrstuvwxyz0123456789";
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.SSH_KEY}
        keyType="ed25519"
        fingerprint={fingerprint}
      />,
    );
    expect(screen.getByText("ed25519")).toBeInTheDocument();
    // Fingerprint is truncated at DISPLAY_FINGERPRINT_SHORT (16) chars + "…"
    const truncated = fingerprint.slice(0, DISPLAY_FINGERPRINT_SHORT) + "…";
    expect(screen.getByText(truncated)).toBeInTheDocument();
  });
});

describe("EntrySecondaryLine — edge cases: null/empty fields render gracefully", () => {
  it("LOGIN: renders nothing when both username and urlHost are null", () => {
    const { container } = render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.LOGIN}
        username={null}
        urlHost={null}
      />,
    );
    // Container renders but has no meaningful text content
    expect(container.querySelector("div")).toBeInTheDocument();
    expect(container.textContent?.trim()).toBe("");
  });

  it("LOGIN: renders only username when urlHost is null", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.LOGIN}
        username="alice"
        urlHost={null}
      />,
    );
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("LOGIN: renders only urlHost when username is null", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.LOGIN}
        username={null}
        urlHost="example.com"
      />,
    );
    expect(screen.getByText("example.com")).toBeInTheDocument();
  });

  it("SECURE_NOTE: renders no text when snippet is null", () => {
    const { container } = render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.SECURE_NOTE}
        snippet={null}
      />,
    );
    expect(container.textContent?.trim()).toBe("");
  });

  it("CREDIT_CARD: renders only brand when lastFour and cardholderName are null", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.CREDIT_CARD}
        brand="Mastercard"
        lastFour={null}
        cardholderName={null}
      />,
    );
    expect(screen.getByText("Mastercard")).toBeInTheDocument();
    expect(screen.queryByText(/••••/)).not.toBeInTheDocument();
  });

  it("CREDIT_CARD: renders nothing when all fields are null", () => {
    const { container } = render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.CREDIT_CARD}
        brand={null}
        lastFour={null}
        cardholderName={null}
      />,
    );
    expect(container.textContent?.trim()).toBe("");
  });

  it("IDENTITY: renders only fullName when idNumberLast4 is null", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.IDENTITY}
        fullName="Carol White"
        idNumberLast4={null}
      />,
    );
    expect(screen.getByText("Carol White")).toBeInTheDocument();
    expect(screen.queryByText(/••••/)).not.toBeInTheDocument();
  });

  it("IDENTITY: renders nothing when all fields are null", () => {
    const { container } = render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.IDENTITY}
        fullName={null}
        idNumberLast4={null}
      />,
    );
    expect(container.textContent?.trim()).toBe("");
  });

  it("PASSKEY: renders only relyingPartyId when username is null", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.PASSKEY}
        relyingPartyId="login.example.com"
        username={null}
      />,
    );
    expect(screen.getByText("login.example.com")).toBeInTheDocument();
  });

  it("PASSKEY: renders nothing when all fields are null", () => {
    const { container } = render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.PASSKEY}
        relyingPartyId={null}
        username={null}
      />,
    );
    expect(container.textContent?.trim()).toBe("");
  });

  it("BANK_ACCOUNT: renders only bankName when accountNumberLast4 is null", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.BANK_ACCOUNT}
        bankName="Wells Fargo"
        accountNumberLast4={null}
      />,
    );
    expect(screen.getByText("Wells Fargo")).toBeInTheDocument();
    expect(screen.queryByText(/••••/)).not.toBeInTheDocument();
  });

  it("BANK_ACCOUNT: renders nothing when all fields are null", () => {
    const { container } = render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.BANK_ACCOUNT}
        bankName={null}
        accountNumberLast4={null}
      />,
    );
    expect(container.textContent?.trim()).toBe("");
  });

  it("SOFTWARE_LICENSE: renders only softwareName when licensee is null", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.SOFTWARE_LICENSE}
        softwareName="Sublime Text"
        licensee={null}
      />,
    );
    expect(screen.getByText("Sublime Text")).toBeInTheDocument();
  });

  it("SOFTWARE_LICENSE: renders nothing when all fields are null", () => {
    const { container } = render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.SOFTWARE_LICENSE}
        softwareName={null}
        licensee={null}
      />,
    );
    expect(container.textContent?.trim()).toBe("");
  });

  it("SSH_KEY: renders only keyType when fingerprint is null", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.SSH_KEY}
        keyType="rsa"
        fingerprint={null}
      />,
    );
    expect(screen.getByText("rsa")).toBeInTheDocument();
  });

  it("SSH_KEY: renders nothing when all fields are null", () => {
    const { container } = render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.SSH_KEY}
        keyType={null}
        fingerprint={null}
      />,
    );
    expect(container.textContent?.trim()).toBe("");
  });
});

describe("EntrySecondaryLine — isTeamMode shows entryTypeLabel", () => {
  it("renders entryTypeLabel when isTeamMode=true", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.LOGIN}
        username="alice"
        isTeamMode={true}
        entryTypeLabel="Login"
      />,
    );
    expect(screen.getByText("Login")).toBeInTheDocument();
  });

  it("does NOT render entryTypeLabel when isTeamMode is omitted", () => {
    render(
      <EntrySecondaryLine
        entryType={ENTRY_TYPE.LOGIN}
        username="alice"
        entryTypeLabel="Login"
      />,
    );
    expect(screen.queryByText("Login")).not.toBeInTheDocument();
  });
});
