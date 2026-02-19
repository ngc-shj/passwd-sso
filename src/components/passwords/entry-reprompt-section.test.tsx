// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EntryRepromptSection } from "@/components/passwords/entry-reprompt-section";

describe("EntryRepromptSection", () => {
  it("renders title/description and calls on change", () => {
    const onCheckedChange = vi.fn();

    render(
      <EntryRepromptSection
        checked={false}
        onCheckedChange={onCheckedChange}
        title="Require reprompt"
        description="Ask master passphrase again"
      />,
    );

    expect(screen.getByText("Require reprompt")).toBeTruthy();
    expect(screen.getByText("Ask master passphrase again")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox"));
    expect(onCheckedChange).toHaveBeenCalled();
  });
});
