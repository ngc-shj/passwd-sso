import { describe, expect, it } from "vitest";
import {
  PSSO_SHOW_SAVE_BANNER,
  PSSO_TRIGGER_INLINE_SUGGESTIONS,
  PSSO_VAULT_STATE_CHANGED,
  AUTOFILL_FILL,
  WEBAUTHN_OWN_APP_BYPASS_MSG,
} from "../../lib/constants";
import { GCM_TAG_LENGTH } from "../../lib/crypto";
import { MS_PER_SECOND, MS_PER_MINUTE } from "../../lib/time";

// Value-pin assertions: each constant must equal the exact string/number the
// content-script ↔ background protocol relies on. A value change here means
// a breaking protocol change — deliberate renames must update this test too.

describe("C11 constant value pins", () => {
  it("PSSO_SHOW_SAVE_BANNER equals exact protocol string", () => {
    expect(PSSO_SHOW_SAVE_BANNER).toBe("PSSO_SHOW_SAVE_BANNER");
  });

  it("PSSO_TRIGGER_INLINE_SUGGESTIONS equals exact protocol string", () => {
    expect(PSSO_TRIGGER_INLINE_SUGGESTIONS).toBe("PSSO_TRIGGER_INLINE_SUGGESTIONS");
  });

  it("PSSO_VAULT_STATE_CHANGED equals exact protocol string", () => {
    expect(PSSO_VAULT_STATE_CHANGED).toBe("PSSO_VAULT_STATE_CHANGED");
  });

  it("AUTOFILL_FILL equals exact protocol string", () => {
    expect(AUTOFILL_FILL).toBe("AUTOFILL_FILL");
  });

  it("WEBAUTHN_OWN_APP_BYPASS_MSG equals exact protocol string", () => {
    expect(WEBAUTHN_OWN_APP_BYPASS_MSG).toBe("PASSWD_SSO_OWN_APP_BYPASS");
  });

  it("GCM_TAG_LENGTH equals 16 bytes", () => {
    expect(GCM_TAG_LENGTH).toBe(16);
  });

  it("MS_PER_SECOND equals 1000", () => {
    expect(MS_PER_SECOND).toBe(1_000);
  });

  it("MS_PER_MINUTE equals 60000", () => {
    expect(MS_PER_MINUTE).toBe(60_000);
  });
});

// Twin-sync assertions: the plain-JS files cannot import TS modules, so they
// hardcode the same string literals. If either side drifts the test fails.
// Pattern mirrors token-bridge-js-sync.test.ts (same ?raw import technique).

describe("C11 plain-JS twin sync", () => {
  it("autofill.js contains the AUTOFILL_FILL literal in sync with the TS constant", async () => {
    // autofill.js declares a matching local literal — keep both in sync.
    const { default: file } = await import("../../content/autofill.js?raw");
    expect(file).toContain(`"${AUTOFILL_FILL}"`);
  });

  it("webauthn-interceptor.js contains the PASSWD_SSO_OWN_APP_BYPASS literal in sync with the TS constant", async () => {
    // webauthn-interceptor.js (MAIN world, plain JS) declares a matching local
    // literal — keep both in sync (mirrors the WebAuthn note in constants.ts).
    const { default: file } = await import("../../content/webauthn-interceptor.js?raw");
    expect(file).toContain(`"${WEBAUTHN_OWN_APP_BYPASS_MSG}"`);
  });
});
