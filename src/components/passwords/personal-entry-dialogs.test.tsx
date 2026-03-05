// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { ENTRY_TYPE } from "@/lib/constants";

vi.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}:${key}`,
}));

vi.mock("@/components/passwords/personal-entry-dialog-shell", () => ({
  PersonalEntryDialogShell: ({
    title,
    children,
  }: {
    title: string;
    children: React.ReactNode;
  }) => (
    <div>
      <div data-testid="dialog-title">{title}</div>
      {children}
    </div>
  ),
}));

vi.mock("@/components/passwords/personal-login-form", () => ({
  PersonalLoginForm: () => <div data-testid="personal-login-form" />,
}));
vi.mock("@/components/passwords/personal-secure-note-form", () => ({
  SecureNoteForm: () => <div data-testid="personal-secure-note-form" />,
}));
vi.mock("@/components/passwords/personal-credit-card-form", () => ({
  CreditCardForm: () => <div data-testid="personal-credit-card-form" />,
}));
vi.mock("@/components/passwords/personal-identity-form", () => ({
  IdentityForm: () => <div data-testid="personal-identity-form" />,
}));
vi.mock("@/components/passwords/personal-passkey-form", () => ({
  PasskeyForm: () => <div data-testid="personal-passkey-form" />,
}));
vi.mock("@/components/passwords/personal-bank-account-form", () => ({
  BankAccountForm: () => <div data-testid="personal-bank-account-form" />,
}));
vi.mock("@/components/passwords/personal-software-license-form", () => ({
  SoftwareLicenseForm: () => <div data-testid="personal-software-license-form" />,
}));
vi.mock("@/components/passwords/personal-ssh-key-form", () => ({
  SshKeyForm: () => <div data-testid="personal-ssh-key-form" />,
}));
vi.mock("@/components/passwords/attachment-section", () => ({
  AttachmentSection: () => <div data-testid="attachment-section" />,
}));

import { PasswordEditDialog } from "@/components/passwords/personal-password-edit-dialog";
import { PasswordNewDialog } from "@/components/passwords/personal-password-new-dialog";

describe("personal entry dialogs", () => {
  it.each([
    [undefined, "personal-login-form", "PasswordForm:newPassword"],
    [ENTRY_TYPE.SECURE_NOTE, "personal-secure-note-form", "SecureNoteForm:newNote"],
    [ENTRY_TYPE.CREDIT_CARD, "personal-credit-card-form", "CreditCardForm:newCard"],
    [ENTRY_TYPE.IDENTITY, "personal-identity-form", "IdentityForm:newIdentity"],
    [ENTRY_TYPE.PASSKEY, "personal-passkey-form", "PasskeyForm:newPasskey"],
    [ENTRY_TYPE.BANK_ACCOUNT, "personal-bank-account-form", "BankAccountForm:newBankAccount"],
    [ENTRY_TYPE.SOFTWARE_LICENSE, "personal-software-license-form", "SoftwareLicenseForm:newLicense"],
  ])("PasswordNewDialog selects the right form for %s", (entryType, testId, title) => {
    render(
      <PasswordNewDialog
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        entryType={entryType}
      />,
    );

    expect(screen.getByTestId("dialog-title")).toHaveTextContent(title);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });

  it.each([
    [ENTRY_TYPE.LOGIN, "personal-login-form", "PasswordForm:editPassword"],
    [ENTRY_TYPE.SECURE_NOTE, "personal-secure-note-form", "SecureNoteForm:editNote"],
    [ENTRY_TYPE.BANK_ACCOUNT, "personal-bank-account-form", "BankAccountForm:editBankAccount"],
    [ENTRY_TYPE.SOFTWARE_LICENSE, "personal-software-license-form", "SoftwareLicenseForm:editLicense"],
  ])("PasswordEditDialog selects the right form for %s", (entryType, testId, title) => {
    render(
      <PasswordEditDialog
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        attachments={[]}
        onAttachmentsChange={vi.fn()}
        editData={{
          id: "entry-1",
          entryType,
          title: "Entry",
          username: "alice",
          password: "secret",
          content: "",
          url: "",
          notes: "",
          tags: [],
        }}
      />,
    );

    expect(screen.getByTestId("dialog-title")).toHaveTextContent(title);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
    expect(screen.getByTestId("attachment-section")).toBeInTheDocument();
  });
});
