// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WEBAUTHN_BRIDGE_MSG, WEBAUTHN_BRIDGE_RESP } from "../lib/constants";

// Mock UI modules that touch the DOM — these are not under test here
vi.mock("../content/ui/passkey-dropdown", () => ({
  showPasskeyDropdown: vi.fn(),
  hidePasskeyDropdown: vi.fn(),
}));
vi.mock("../content/ui/passkey-save-banner", () => ({
  showPasskeySaveBanner: vi.fn(),
  hidePasskeySaveBanner: vi.fn(),
}));

// Install chrome mock before importing the module under test
vi.stubGlobal("chrome", {
  runtime: {
    id: "test-ext-id",
    sendMessage: vi.fn(),
    lastError: undefined,
  },
});

import { handleWebAuthnMessage } from "../content/webauthn-bridge-lib";

function makeEvent(overrides?: Partial<MessageEventInit> & { data?: unknown }): MessageEvent {
  return new MessageEvent("message", {
    source: window,
    origin: window.location.origin,
    data: {
      type: WEBAUTHN_BRIDGE_MSG,
      requestId: "req-1",
      action: "PASSKEY_GET_MATCHES",
      payload: { rpId: "example.com" },
    },
    ...overrides,
  });
}

describe("webauthn-bridge-lib handleWebAuthnMessage", () => {
  let sendMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sendMessageMock = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: {
        id: "test-ext-id",
        sendMessage: sendMessageMock,
        lastError: undefined,
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores events where source !== window", () => {
    const event = makeEvent({ source: null });
    handleWebAuthnMessage(event);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("ignores events with wrong origin", () => {
    const event = new MessageEvent("message", {
      source: window,
      origin: "https://evil.example.com",
      data: {
        type: WEBAUTHN_BRIDGE_MSG,
        requestId: "req-1",
        action: "PASSKEY_GET_MATCHES",
        payload: { rpId: "example.com" },
      },
    });
    handleWebAuthnMessage(event);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("ignores events with wrong message type", () => {
    const event = makeEvent({
      data: {
        type: "SOME_OTHER_MSG",
        requestId: "req-1",
        action: "PASSKEY_GET_MATCHES",
        payload: { rpId: "example.com" },
      },
    });
    handleWebAuthnMessage(event);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("ignores events with no data", () => {
    const event = makeEvent({ data: null });
    handleWebAuthnMessage(event);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("ignores events with missing requestId", () => {
    const event = makeEvent({
      data: {
        type: WEBAUTHN_BRIDGE_MSG,
        // requestId omitted
        action: "PASSKEY_GET_MATCHES",
        payload: { rpId: "example.com" },
      },
    });
    handleWebAuthnMessage(event);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("ignores events with missing action", () => {
    const event = makeEvent({
      data: {
        type: WEBAUTHN_BRIDGE_MSG,
        requestId: "req-1",
        // action omitted
        payload: { rpId: "example.com" },
      },
    });
    handleWebAuthnMessage(event);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("forwards PASSKEY_GET_MATCHES to chrome.runtime.sendMessage", () => {
    sendMessageMock.mockImplementation((_msg: unknown, _cb: (r: unknown) => void) => {
      _cb({ entries: [], vaultLocked: false });
    });

    const event = makeEvent();
    handleWebAuthnMessage(event);

    expect(sendMessageMock).toHaveBeenCalledWith(
      { type: "PASSKEY_GET_MATCHES", rpId: "example.com" },
      expect.any(Function),
    );
  });

  it("responds with the value returned by sendMessage for PASSKEY_GET_MATCHES", () => {
    const mockResponse = { entries: [{ id: "e1", title: "Test" }], vaultLocked: false };
    sendMessageMock.mockImplementation((_msg: unknown, cb: (r: unknown) => void) => {
      cb(mockResponse);
    });

    const postedMessages: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      postedMessages.push(data);
    });

    const event = makeEvent();
    handleWebAuthnMessage(event);

    expect(postedMessages).toContainEqual(
      expect.objectContaining({
        type: WEBAUTHN_BRIDGE_RESP,
        requestId: "req-1",
        response: mockResponse,
      }),
    );
  });

  it("responds with null when chrome.runtime.lastError is set", () => {
    sendMessageMock.mockImplementation((_msg: unknown, cb: (r: unknown) => void) => {
      // Simulate lastError by setting it before calling the callback
      Object.defineProperty(chrome.runtime, "lastError", {
        value: { message: "Extension context invalidated." },
        configurable: true,
        writable: true,
      });
      cb(undefined);
    });

    const postedMessages: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      postedMessages.push(data);
    });

    const event = makeEvent();
    handleWebAuthnMessage(event);

    expect(postedMessages).toContainEqual(
      expect.objectContaining({
        type: WEBAUTHN_BRIDGE_RESP,
        requestId: "req-1",
        response: null,
      }),
    );
  });

  it("forwards PASSKEY_SIGN_ASSERTION to chrome.runtime.sendMessage", () => {
    sendMessageMock.mockImplementation((_msg: unknown, cb: (r: unknown) => void) => {
      cb({ ok: true });
    });

    const event = makeEvent({
      data: {
        type: WEBAUTHN_BRIDGE_MSG,
        requestId: "req-sign",
        action: "PASSKEY_SIGN_ASSERTION",
        payload: {
          entryId: "entry-1",
          clientDataJSON: JSON.stringify({ type: "webauthn.get", challenge: "abc" }),
        },
      },
    });
    handleWebAuthnMessage(event);

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PASSKEY_SIGN_ASSERTION",
        entryId: "entry-1",
      }),
      expect.any(Function),
    );
  });

  it("forwards PASSKEY_CREATE_CREDENTIAL to chrome.runtime.sendMessage", () => {
    sendMessageMock.mockImplementation((_msg: unknown, cb: (r: unknown) => void) => {
      cb({ ok: true });
    });

    const event = makeEvent({
      data: {
        type: WEBAUTHN_BRIDGE_MSG,
        requestId: "req-create",
        action: "PASSKEY_CREATE_CREDENTIAL",
        payload: {
          rpId: "example.com",
          rpName: "Example",
          userId: "user-handle",
          userName: "alice",
          userDisplayName: "Alice",
          excludeCredentialIds: [],
          clientDataJSON: JSON.stringify({ type: "webauthn.create", challenge: "xyz" }),
        },
      },
    });
    handleWebAuthnMessage(event);

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PASSKEY_CREATE_CREDENTIAL",
        rpId: "example.com",
      }),
      expect.any(Function),
    );
  });

  it("responds with platform action when PASSKEY_SELECT receives empty entries list", () => {
    const postedMessages: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      postedMessages.push(data);
    });

    const event = makeEvent({
      data: {
        type: WEBAUTHN_BRIDGE_MSG,
        requestId: "req-select",
        action: "PASSKEY_SELECT",
        payload: { entries: [], rpId: "example.com" },
      },
    });
    handleWebAuthnMessage(event);

    // With no entries, should immediately respond with platform action (no sendMessage needed)
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(postedMessages).toContainEqual(
      expect.objectContaining({
        type: WEBAUTHN_BRIDGE_RESP,
        requestId: "req-select",
        response: { action: "platform" },
      }),
    );
  });
});
