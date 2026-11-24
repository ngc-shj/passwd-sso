import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/settings/security/rotate-key-card", () => ({ RotateKeyCard: () => null }));

import KeyRotationPage from "./page";
import { RotateKeyCard } from "@/components/settings/security/rotate-key-card";

describe("KeyRotationPage", () => {
  it("renders the key rotation card", () => {
    const el = KeyRotationPage() as ReactElement;
    expect(el.type).toBe(RotateKeyCard);
    expect(el.props).toEqual({});
  });
});
