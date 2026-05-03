// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("../entry/attachment-section", () => ({
  AttachmentSection: () => <div data-testid="attachment-section" />,
}));

vi.mock("@/components/team/forms/team-attachment-section", () => ({
  TeamAttachmentSection: () => <div data-testid="team-attachment-section" />,
}));

vi.mock("../entry/entry-history-section", () => ({
  EntryHistorySection: () => <div data-testid="history-section" />,
}));

vi.mock("@/lib/url-helpers", () => ({
  fetchApi: vi.fn().mockResolvedValue({ ok: true, json: async () => [] }),
}));

vi.mock("@/hooks/vault/use-reprompt", () => ({
  useReprompt: () => ({
    requireVerification: (_id: string, _r: boolean, cb: () => void) => cb(),
    createGuardedGetter:
      (_id: string, _r: boolean, getter: () => string) => () =>
        Promise.resolve(getter()),
    repromptDialog: null,
  }),
}));

vi.mock("./sections/ssh-key-section", () => ({
  SshKeySection: () => <div data-testid="ssh-section" />,
}));

vi.mock("./sections/bank-account-section", () => ({
  BankAccountSection: () => <div data-testid="bank-section" />,
}));

vi.mock("./sections/software-license-section", () => ({
  SoftwareLicenseSection: () => <div data-testid="software-section" />,
}));

vi.mock("./sections/passkey-section", () => ({
  PasskeySection: () => <div data-testid="passkey-section" />,
}));

vi.mock("./sections/identity-section", () => ({
  IdentitySection: () => <div data-testid="identity-section" />,
}));

vi.mock("./sections/credit-card-section", () => ({
  CreditCardSection: () => <div data-testid="credit-card-section" />,
}));

vi.mock("./sections/secure-note-section", () => ({
  SecureNoteSection: () => <div data-testid="secure-note-section" />,
}));

vi.mock("./sections/login-section", () => ({
  LoginSection: () => <div data-testid="login-section" />,
}));

import { PasswordDetailInline } from "./password-detail-inline";
import type { InlineDetailData } from "@/types/entry";
import { ENTRY_TYPE } from "@/lib/constants";

const baseData: InlineDetailData = {
  id: "e1",
  password: "",
  url: null,
  urlHost: null,
  notes: null,
  customFields: [],
  passwordHistory: [],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};

describe("PasswordDetailInline", () => {
  it("renders LoginSection by default for LOGIN entry type", () => {
    render(<PasswordDetailInline data={{ ...baseData, entryType: ENTRY_TYPE.LOGIN }} />);
    expect(screen.getByTestId("login-section")).toBeInTheDocument();
  });

  it("renders SecureNoteSection for SECURE_NOTE entry type", () => {
    render(
      <PasswordDetailInline
        data={{ ...baseData, entryType: ENTRY_TYPE.SECURE_NOTE }}
      />,
    );
    expect(screen.getByTestId("secure-note-section")).toBeInTheDocument();
  });

  it("renders CreditCardSection for CREDIT_CARD entry type", () => {
    render(
      <PasswordDetailInline
        data={{ ...baseData, entryType: ENTRY_TYPE.CREDIT_CARD }}
      />,
    );
    expect(screen.getByTestId("credit-card-section")).toBeInTheDocument();
  });

  it("renders SshKeySection for SSH_KEY entry type", () => {
    render(
      <PasswordDetailInline
        data={{ ...baseData, entryType: ENTRY_TYPE.SSH_KEY }}
      />,
    );
    expect(screen.getByTestId("ssh-section")).toBeInTheDocument();
  });

  it("hides history and attachments when readOnly is true", () => {
    render(
      <PasswordDetailInline
        data={{ ...baseData, entryType: ENTRY_TYPE.LOGIN }}
        readOnly={true}
      />,
    );
    expect(screen.queryByTestId("history-section")).not.toBeInTheDocument();
    expect(screen.queryByTestId("attachment-section")).not.toBeInTheDocument();
  });

  it("shows the Edit button only when onEdit is provided", async () => {
    const onEdit = vi.fn();
    const user = userEvent.setup();

    const { rerender } = render(
      <PasswordDetailInline
        data={{ ...baseData, entryType: ENTRY_TYPE.LOGIN }}
      />,
    );
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();

    rerender(
      <PasswordDetailInline
        data={{ ...baseData, entryType: ENTRY_TYPE.LOGIN }}
        onEdit={onEdit}
      />,
    );

    const editBtn = screen.getByRole("button", { name: /edit/i });
    await user.click(editBtn);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("renders TeamAttachmentSection when teamId is provided", () => {
    render(
      <PasswordDetailInline
        data={{ ...baseData, entryType: ENTRY_TYPE.LOGIN }}
        teamId="team-1"
      />,
    );
    expect(screen.getByTestId("team-attachment-section")).toBeInTheDocument();
    expect(screen.queryByTestId("attachment-section")).not.toBeInTheDocument();
  });
});
