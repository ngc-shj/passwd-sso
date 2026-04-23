// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
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
  TeamLoginForm: () => <div data-testid="team-login-form" />,
}));
vi.mock("@/components/team/forms/team-secure-note-form", () => ({
  TeamSecureNoteForm: () => <div data-testid="team-secure-note-form" />,
}));
vi.mock("@/components/team/forms/team-credit-card-form", () => ({
  TeamCreditCardForm: () => <div data-testid="team-credit-card-form" />,
}));
vi.mock("@/components/team/forms/team-identity-form", () => ({
  TeamIdentityForm: () => <div data-testid="team-identity-form" />,
}));
vi.mock("@/components/team/forms/team-passkey-form", () => ({
  TeamPasskeyForm: () => <div data-testid="team-passkey-form" />,
}));
vi.mock("@/components/team/forms/team-bank-account-form", () => ({
  TeamBankAccountForm: () => <div data-testid="team-bank-account-form" />,
}));
vi.mock("@/components/team/forms/team-software-license-form", () => ({
  TeamSoftwareLicenseForm: () => <div data-testid="team-software-license-form" />,
}));

import { TeamEditDialog } from "@/components/team/management/team-edit-dialog";
import { TeamNewDialog } from "@/components/team/management/team-new-dialog";

describe("team entry dialogs", () => {
  it.each([
    [ENTRY_TYPE.LOGIN, "team-login-form", "new:password"],
    [ENTRY_TYPE.SECURE_NOTE, "team-secure-note-form", "new:secureNote"],
    [ENTRY_TYPE.CREDIT_CARD, "team-credit-card-form", "new:creditCard"],
    [ENTRY_TYPE.IDENTITY, "team-identity-form", "new:identity"],
    [ENTRY_TYPE.PASSKEY, "team-passkey-form", "new:passkey"],
    [ENTRY_TYPE.BANK_ACCOUNT, "team-bank-account-form", "new:bankAccount"],
    [ENTRY_TYPE.SOFTWARE_LICENSE, "team-software-license-form", "new:softwareLicense"],
  ])("TeamNewDialog selects the right form for %s", (entryType, testId, expectedTitle) => {
    render(
      <TeamNewDialog
        teamId="team-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        entryType={entryType}
      />,
    );

    expect(screen.getByTestId("dialog-title")).toHaveTextContent(expectedTitle);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });

  it.each([
    [ENTRY_TYPE.LOGIN, "team-login-form", "edit:password"],
    [ENTRY_TYPE.SECURE_NOTE, "team-secure-note-form", "edit:secureNote"],
    [ENTRY_TYPE.SOFTWARE_LICENSE, "team-software-license-form", "edit:softwareLicense"],
  ])("TeamEditDialog selects the right form for %s", (entryType, testId, expectedTitle) => {
    render(
      <TeamEditDialog
        teamId="team-1"
        open={true}
        onOpenChange={vi.fn()}
        onSaved={vi.fn()}
        editData={{
          id: "entry-1",
          entryType,
          title: "Entry",
          username: "alice",
          password: "secret",
          url: null,
          notes: null,
        }}
      />,
    );

    expect(screen.getByTestId("dialog-title")).toHaveTextContent(expectedTitle);
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });
});
