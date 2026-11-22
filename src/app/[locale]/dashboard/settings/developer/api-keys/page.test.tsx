import { describe, it, expect, vi } from "vitest";
import type { ReactElement } from "react";

vi.mock("@/components/settings/developer/api-key-manager", () => ({ ApiKeyManager: () => null }));

import ApiKeysPage from "./page";
import { ApiKeyManager } from "@/components/settings/developer/api-key-manager";

describe("ApiKeysPage", () => {
  it("renders the API key manager", () => {
    const el = ApiKeysPage() as ReactElement;
    expect(el.type).toBe(ApiKeyManager);
    expect(el.props).toEqual({});
  });
});
