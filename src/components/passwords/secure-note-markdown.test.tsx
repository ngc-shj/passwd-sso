/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SecureNoteMarkdown } from "./secure-note-markdown";

describe("SecureNoteMarkdown", () => {
  it("renders headings", () => {
    render(<SecureNoteMarkdown content="# Hello World" />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Hello World");
  });

  it("renders lists", () => {
    render(<SecureNoteMarkdown content={"- Item A\n- Item B\n- Item C"} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toBe("Item A");
  });

  it("renders GFM tables", () => {
    const md = `| Name | Value |\n|------|-------|\n| key  | 123   |`;
    render(<SecureNoteMarkdown content={md} />);
    const table = screen.getByRole("table");
    expect(table).toBeTruthy();
  });

  it("renders GFM strikethrough", () => {
    const { container } = render(
      <SecureNoteMarkdown content="~~deleted~~" />,
    );
    const del = container.querySelector("del");
    expect(del).not.toBeNull();
    expect(del!.textContent).toBe("deleted");
  });

  it("does not render raw HTML (no rehype-raw)", () => {
    const { container } = render(
      <SecureNoteMarkdown content='<div class="danger">raw html</div>' />,
    );
    // Raw HTML should NOT be rendered as actual DOM elements
    const dangerDiv = container.querySelector(".danger");
    expect(dangerDiv).toBeNull();
  });

  it("does not inject script tags", () => {
    const { container } = render(
      <SecureNoteMarkdown content='<script>alert("xss")</script>' />,
    );
    const scripts = container.querySelectorAll("script");
    expect(scripts).toHaveLength(0);
  });

  it("sanitizes javascript: protocol links", () => {
    const { container } = render(
      <SecureNoteMarkdown content='[click me](javascript:alert("xss"))' />,
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    // The href should be removed/empty, not javascript:
    expect(link!.getAttribute("href")).toBeNull();
  });

  it("allows safe http/https links", () => {
    const { container } = render(
      <SecureNoteMarkdown content="[example](https://example.com)" />,
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    expect(link!.getAttribute("href")).toBe("https://example.com");
    expect(link!.getAttribute("target")).toBe("_blank");
    expect(link!.getAttribute("rel")).toContain("noopener");
  });

  it("renders code blocks", () => {
    const { container } = render(
      <SecureNoteMarkdown content={"```\nconst x = 1;\n```"} />,
    );
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    expect(code!.textContent).toContain("const x = 1;");
  });
});
