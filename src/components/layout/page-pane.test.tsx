// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { PagePane } from "./page-pane";

describe("PagePane", () => {
  it("renders only children when no header is provided", () => {
    render(
      <PagePane>
        <p>body content</p>
      </PagePane>,
    );

    expect(screen.getByText("body content")).toBeInTheDocument();
  });

  it("renders header above children when provided", () => {
    render(
      <PagePane header={<h1>my title</h1>}>
        <p>body content</p>
      </PagePane>,
    );

    const title = screen.getByText("my title");
    const body = screen.getByText("body content");
    expect(title).toBeInTheDocument();
    expect(body).toBeInTheDocument();

    // Header appears before body in document order
    expect(title.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
