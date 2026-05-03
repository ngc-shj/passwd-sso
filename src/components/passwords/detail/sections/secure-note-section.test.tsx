// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("../../shared/copy-button", () => ({
  CopyButton: () => <button type="button" data-testid="copy">copy</button>,
}));

vi.mock("../../shared/secure-note-markdown", () => ({
  SecureNoteMarkdown: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

import { SecureNoteSection } from "./secure-note-section";
import type { InlineDetailData } from "@/types/entry";

const baseData: InlineDetailData = {
  id: "e1",
  password: "",
  url: null,
  urlHost: null,
  notes: null,
  customFields: [],
  passwordHistory: [],
  content: "Hello note",
  isMarkdown: false,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

describe("SecureNoteSection", () => {
  it("renders the content as plain text by default", () => {
    render(
      <SecureNoteSection
        data={baseData}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByText("Hello note")).toBeInTheDocument();
    expect(screen.queryByTestId("markdown")).not.toBeInTheDocument();
  });

  it("renders markdown view when isMarkdown is true", () => {
    render(
      <SecureNoteSection
        data={{ ...baseData, isMarkdown: true }}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByTestId("markdown")).toBeInTheDocument();
  });

  it("toggles between markdown view and source when button clicked", async () => {
    const user = userEvent.setup();
    render(
      <SecureNoteSection
        data={{ ...baseData, isMarkdown: true }}
        requireVerification={(_id, _r, cb) => cb()}
        createGuardedGetter={(_id, _r, getter) => () => Promise.resolve(getter())}
      />,
    );

    expect(screen.getByTestId("markdown")).toBeInTheDocument();

    const toggleButton = screen.getByRole("button", { name: /showSource/i });
    await user.click(toggleButton);

    expect(screen.queryByTestId("markdown")).not.toBeInTheDocument();
    // Now plain text view shows the content
    expect(screen.getByText("Hello note")).toBeInTheDocument();
  });
});
