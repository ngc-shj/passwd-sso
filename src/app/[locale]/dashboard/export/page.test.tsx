import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/passwords/export/password-export", () => ({ ExportPagePanel: () => null }));

import ExportPage from "./page";
import { ExportPagePanel } from "@/components/passwords/export/password-export";

describe("ExportPage", () => {
  it("renders the personal export panel", () => {
    const el = ExportPage() as ReactElement;
    expect(el.type).toBe(ExportPagePanel);
    expect(el.props).toEqual({});
  });
});
