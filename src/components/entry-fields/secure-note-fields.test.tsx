// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SECURE_NOTE_MAX } from "@/lib/validations";
import { SecureNoteFields } from "./secure-note-fields";

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

vi.mock("@/components/passwords/shared/secure-note-markdown", () => ({
  SecureNoteMarkdown: ({ content }: { content: string }) => (
    <div data-testid="markdown">{content}</div>
  ),
}));

// Stub Tabs so all panels render (Radix gates on active panel only)
/* eslint-disable jsx-a11y/role-has-required-aria-props, jsx-a11y/role-supports-aria-props */
vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <button type="button" data-value={value}>{children}</button>
  ),
  TabsContent: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
}));
/* eslint-enable jsx-a11y/role-has-required-aria-props, jsx-a11y/role-supports-aria-props */

describe("SecureNoteFields", () => {
  it("renders the textarea with maxLength=SECURE_NOTE_MAX (RT3)", () => {
    render(
      <SecureNoteFields
        content=""
        onContentChange={vi.fn()}
        contentLabel="Content"
        contentPlaceholder="ph"
        editTabLabel="Edit"
        previewTabLabel="Preview"
      />,
    );
    expect(screen.getByPlaceholderText("ph")).toHaveAttribute("maxLength", String(SECURE_NOTE_MAX));
  });

  it("renders the markdown hint when provided", () => {
    render(
      <SecureNoteFields
        content=""
        onContentChange={vi.fn()}
        contentLabel="Content"
        contentPlaceholder="ph"
        editTabLabel="Edit"
        previewTabLabel="Preview"
        markdownHint="Use **markdown**"
      />,
    );
    expect(screen.getByText("Use **markdown**")).toBeInTheDocument();
  });

  it("propagates onContentChange when typing", () => {
    const onContentChange = vi.fn();
    render(
      <SecureNoteFields
        content=""
        onContentChange={onContentChange}
        contentLabel="Content"
        contentPlaceholder="ph"
        editTabLabel="Edit"
        previewTabLabel="Preview"
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("ph"), { target: { value: "hello" } });
    expect(onContentChange).toHaveBeenCalledWith("hello");
  });

  it("renders SecureNoteMarkdown in the preview panel when content is set", () => {
    render(
      <SecureNoteFields
        content="# Title"
        onContentChange={vi.fn()}
        contentLabel="Content"
        contentPlaceholder="ph"
        editTabLabel="Edit"
        previewTabLabel="Preview"
      />,
    );
    // With stubbed Tabs, all panels are mounted regardless of active state.
    expect(screen.getByTestId("markdown")).toHaveTextContent("# Title");
  });
});
