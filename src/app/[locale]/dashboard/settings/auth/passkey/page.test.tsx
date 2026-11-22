import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/settings/security/passkey-credentials-card", () => ({ PasskeyCredentialsCard: () => null }));

import PasskeyPage from "./page";
import { PasskeyCredentialsCard } from "@/components/settings/security/passkey-credentials-card";

describe("PasskeyPage", () => {
  it("renders the passkey credentials card", () => {
    const el = PasskeyPage() as ReactElement;
    expect(el.type).toBe(PasskeyCredentialsCard);
    expect(el.props).toEqual({});
  });
});
