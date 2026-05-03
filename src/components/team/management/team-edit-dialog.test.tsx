// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { ENTRY_TYPE } from "@/lib/constants";

vi.mock("@/hooks/form/use-entry-form-translations", () => ({
  useEntryFormTranslations: () => ({}),
  toTeamLoginFormTranslations: () => ({}),
}));

vi.mock("@/components/team/forms/team-entry-copy-data", () => ({
  buildTeamEntryCopyData: () => ({}),
}));

vi.mock("@/components/team/forms/team-entry-copy", () => ({
  buildTeamEntryCopy: ({
    isEdit,
    entryKind,
  }: {
    isEdit: boolean;
    entryKind: string;
  }) => ({
    dialogLabel: `${isEdit ? "edit" : "new"}:${entryKind}`,
  }),
}));

vi.mock("@/components/team/forms/team-entry-dialog-shell", () => ({
  TeamEntryDialogShell: ({
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

vi.mock("@/components/team/forms/team-login-form", () => ({
  TeamLoginForm: () => <div data-testid="form-LOGIN" />,
}));
vi.mock("@/components/team/forms/team-secure-note-form", () => ({
  TeamSecureNoteForm: () => <div data-testid="form-SECURE_NOTE" />,
}));
vi.mock("@/components/team/forms/team-credit-card-form", () => ({
  TeamCreditCardForm: () => <div data-testid="form-CREDIT_CARD" />,
}));
vi.mock("@/components/team/forms/team-identity-form", () => ({
  TeamIdentityForm: () => <div data-testid="form-IDENTITY" />,
}));
vi.mock("@/components/team/forms/team-passkey-form", () => ({
  TeamPasskeyForm: () => <div data-testid="form-PASSKEY" />,
}));
vi.mock("@/components/team/forms/team-bank-account-form", () => ({
  TeamBankAccountForm: () => <div data-testid="form-BANK_ACCOUNT" />,
}));
vi.mock("@/components/team/forms/team-software-license-form", () => ({
  TeamSoftwareLicenseForm: () => <div data-testid="form-SOFTWARE_LICENSE" />,
}));
vi.mock("@/components/team/forms/team-ssh-key-form", () => ({
  TeamSshKeyForm: () => <div data-testid="form-SSH_KEY" />,
}));

import { TeamEditDialog } from "./team-edit-dialog";

describe("TeamEditDialog — entry-type → form mapping", () => {
  it.each([
    [ENTRY_TYPE.LOGIN, "form-LOGIN", "edit:password"],
    [ENTRY_TYPE.SECURE_NOTE, "form-SECURE_NOTE", "edit:secureNote"],
    [ENTRY_TYPE.CREDIT_CARD, "form-CREDIT_CARD", "edit:creditCard"],
    [ENTRY_TYPE.IDENTITY, "form-IDENTITY", "edit:identity"],
    [ENTRY_TYPE.PASSKEY, "form-PASSKEY", "edit:passkey"],
    [ENTRY_TYPE.BANK_ACCOUNT, "form-BANK_ACCOUNT", "edit:bankAccount"],
    [ENTRY_TYPE.SOFTWARE_LICENSE, "form-SOFTWARE_LICENSE", "edit:softwareLicense"],
    [ENTRY_TYPE.SSH_KEY, "form-SSH_KEY", "edit:sshKey"],
  ])("renders the correct form for %s and uses edit dialog title", (entryType, testId, expectedTitle) => {
    render(
      <TeamEditDialog
        teamId="team-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        editData={{ id: "e1", entryType, title: "x" }}
      />,
    );
    expect(screen.getByTestId(testId)).toBeInTheDocument();
    expect(screen.getByTestId("dialog-title")).toHaveTextContent(expectedTitle);
  });

  it("falls back to login form when entryType missing", () => {
    render(
      <TeamEditDialog
        teamId="team-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        editData={{ id: "e1", title: "x" }}
      />,
    );
    expect(screen.getByTestId("form-LOGIN")).toBeInTheDocument();
  });
});
