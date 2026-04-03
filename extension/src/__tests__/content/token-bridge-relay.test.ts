/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

describe("token-bridge-relay behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards CustomEvent detail via postMessage", () => {
    const postMessageSpy = vi.spyOn(window, "postMessage");

    // Simulate what the relay script does
    const handler = (e: CustomEvent) => {
      if (e.detail?.token && typeof e.detail.expiresAt === "number") {
        window.postMessage({
          type: "PASSWD_SSO_TOKEN_RELAY",
          token: e.detail.token,
          expiresAt: e.detail.expiresAt,
        }, window.location.origin);
      }
    };
    document.addEventListener("passwd-sso-token-bridge", handler as EventListener);

    document.dispatchEvent(new CustomEvent("passwd-sso-token-bridge", {
      detail: { token: "test-token", expiresAt: 9999 },
    }));

    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: "PASSWD_SSO_TOKEN_RELAY", token: "test-token", expiresAt: 9999 },
      window.location.origin,
    );

    document.removeEventListener("passwd-sso-token-bridge", handler as EventListener);
  });

  it("ignores events with missing token", () => {
    const postMessageSpy = vi.spyOn(window, "postMessage");

    const handler = (e: CustomEvent) => {
      if (!e.detail || typeof e.detail.token !== "string" || typeof e.detail.expiresAt !== "number") return;
      window.postMessage(
        { type: "PASSWD_SSO_TOKEN_RELAY", token: e.detail.token, expiresAt: e.detail.expiresAt },
        window.location.origin,
      );
    };
    document.addEventListener("passwd-sso-token-bridge", handler as EventListener);

    document.dispatchEvent(new CustomEvent("passwd-sso-token-bridge", {
      detail: { expiresAt: 9999 },
    }));

    expect(postMessageSpy).not.toHaveBeenCalled();

    document.removeEventListener("passwd-sso-token-bridge", handler as EventListener);
  });

  it("ignores events with missing expiresAt", () => {
    const postMessageSpy = vi.spyOn(window, "postMessage");

    const handler = (e: CustomEvent) => {
      if (!e.detail || typeof e.detail.token !== "string" || typeof e.detail.expiresAt !== "number") return;
      window.postMessage(
        { type: "PASSWD_SSO_TOKEN_RELAY", token: e.detail.token, expiresAt: e.detail.expiresAt },
        window.location.origin,
      );
    };
    document.addEventListener("passwd-sso-token-bridge", handler as EventListener);

    document.dispatchEvent(new CustomEvent("passwd-sso-token-bridge", {
      detail: { token: "test-token" },
    }));

    expect(postMessageSpy).not.toHaveBeenCalled();

    document.removeEventListener("passwd-sso-token-bridge", handler as EventListener);
  });

  it("ignores events with null detail", () => {
    const postMessageSpy = vi.spyOn(window, "postMessage");

    const handler = (e: CustomEvent) => {
      if (!e.detail || typeof e.detail.token !== "string" || typeof e.detail.expiresAt !== "number") return;
      window.postMessage(
        { type: "PASSWD_SSO_TOKEN_RELAY", token: e.detail.token, expiresAt: e.detail.expiresAt },
        window.location.origin,
      );
    };
    document.addEventListener("passwd-sso-token-bridge", handler as EventListener);

    document.dispatchEvent(new CustomEvent("passwd-sso-token-bridge", { detail: null }));

    expect(postMessageSpy).not.toHaveBeenCalled();

    document.removeEventListener("passwd-sso-token-bridge", handler as EventListener);
  });
});
