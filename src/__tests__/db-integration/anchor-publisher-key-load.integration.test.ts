/**
 * The app's KeyProvider no longer loads the audit-anchor keys.
 *
 * The publisher reads its signing key and tag secret from its own env
 * (auditAnchorPublisherEnvSchema), and the app task no longer receives them —
 * so the app's boot-time validateKeys() must succeed with the publisher flag
 * on and neither key set, which is exactly the app task's env.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { getKeyProvider, _resetKeyProvider } from "@/lib/key-provider";

describe("app KeyProvider — audit-anchor keys are not the app's", () => {
  // Env is mutated via vi.stubEnv; setup.ts wires the afterEach unstub. Only the
  // KeyProvider singleton needs manual reset between tests.
  beforeEach(() => {
    _resetKeyProvider();
  });

  it("validateKeys() resolves with AUDIT_ANCHOR_PUBLISHER_ENABLED=true and no anchor keys", async () => {
    vi.stubEnv("SHARE_MASTER_KEY", "a".repeat(64));
    vi.stubEnv("AUDIT_ANCHOR_PUBLISHER_ENABLED", "true");
    vi.stubEnv("AUDIT_ANCHOR_SIGNING_KEY", undefined);
    vi.stubEnv("AUDIT_ANCHOR_TAG_SECRET", undefined);
    vi.stubEnv("KEY_PROVIDER", "env");

    const provider = await getKeyProvider();
    await expect(provider.validateKeys()).resolves.toBeUndefined();
  });

  it("validateKeys() resolves when AUDIT_ANCHOR_PUBLISHER_ENABLED is unset", async () => {
    vi.stubEnv("SHARE_MASTER_KEY", "a".repeat(64));
    vi.stubEnv("AUDIT_ANCHOR_PUBLISHER_ENABLED", undefined);
    vi.stubEnv("KEY_PROVIDER", "env");

    const provider = await getKeyProvider();
    await expect(provider.validateKeys()).resolves.toBeUndefined();
  });
});
