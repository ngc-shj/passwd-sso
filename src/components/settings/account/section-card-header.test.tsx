// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Shield } from "lucide-react";

import { SectionCardHeader } from "./section-card-header";

describe("SectionCardHeader", () => {
  it("renders title and description", () => {
    render(
      <SectionCardHeader
        icon={Shield}
        title="Security"
        description="Manage your security settings."
      />,
    );
    expect(screen.getByText("Security")).toBeInTheDocument();
    expect(
      screen.getByText("Manage your security settings."),
    ).toBeInTheDocument();
  });

  it("renders the action element when provided", () => {
    render(
      <SectionCardHeader
        icon={Shield}
        title="Security"
        description="Description"
        action={<button>Save</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("does not render an action region when action prop is omitted", () => {
    render(
      <SectionCardHeader
        icon={Shield}
        title="Security"
        description="Description"
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
