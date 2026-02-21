/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock chrome API
const messageListeners: Array<(message: unknown) => void> = [];
vi.stubGlobal("chrome", {
  runtime: {
    id: "test-id",
    sendMessage: vi.fn(),
    lastError: null,
    onMessage: {
      addListener: vi.fn((fn: (message: unknown) => void) => {
        messageListeners.push(fn);
      }),
      removeListener: vi.fn((fn: (message: unknown) => void) => {
        const idx = messageListeners.indexOf(fn);
        if (idx !== -1) messageListeners.splice(idx, 1);
      }),
    },
  },
});

// Mock form-detector-lib exports
vi.mock("../content/form-detector-lib", () => ({
  findPasswordInputs: vi.fn(),
  findUsernameInput: vi.fn(),
}));

// Mock save banner
vi.mock("../content/ui/save-banner", () => ({
  showSaveBanner: vi.fn(),
  hideSaveBanner: vi.fn(),
}));

import {
  shouldSkipForm,
  extractCredentials,
  extractCredentialsFromPage,
  initLoginDetector,
} from "../content/login-detector-lib";
import { showSaveBanner, hideSaveBanner } from "../content/ui/save-banner";
import { findPasswordInputs, findUsernameInput } from "../content/form-detector-lib";

const mockFindPasswordInputs = vi.mocked(findPasswordInputs);
const mockFindUsernameInput = vi.mocked(findUsernameInput);

function createForm(opts?: {
  action?: string;
  inputs?: Array<{
    type: string;
    name?: string;
    value?: string;
    autocomplete?: string;
  }>;
}): HTMLFormElement {
  const form = document.createElement("form");
  if (opts?.action) form.action = opts.action;
  for (const def of opts?.inputs ?? []) {
    const input = document.createElement("input");
    input.type = def.type;
    if (def.name) input.name = def.name;
    if (def.value) input.value = def.value;
    if (def.autocomplete) input.autocomplete = def.autocomplete;
    form.appendChild(input);
  }
  return form;
}

function createPasswordInput(value = "secret123"): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "password";
  input.value = value;
  return input;
}

function createTextInput(value = "alice", name = "username"): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "text";
  input.name = name;
  input.value = value;
  return input;
}

describe("login-detector-lib", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messageListeners.length = 0;
  });

  describe("shouldSkipForm", () => {
    it("skips forms with multiple password fields", () => {
      const form = createForm();
      const pw1 = createPasswordInput();
      const pw2 = createPasswordInput();
      form.appendChild(pw1);
      form.appendChild(pw2);
      mockFindPasswordInputs.mockReturnValue([pw1, pw2]);

      expect(shouldSkipForm(form)).toBe(true);
    });

    it("does NOT skip forms with only autocomplete='new-password' (common misconfiguration)", () => {
      const form = createForm();
      const pw = createPasswordInput();
      pw.autocomplete = "new-password";
      form.appendChild(pw);
      mockFindPasswordInputs.mockReturnValue([pw]);

      // new-password alone is not enough — many login forms set it incorrectly
      expect(shouldSkipForm(form)).toBe(false);
    });

    it("skips forms with autocomplete='new-password' AND registration-like fields", () => {
      const form = createForm({
        inputs: [
          { type: "text", name: "first_name" },
        ],
      });
      const pw = createPasswordInput();
      pw.autocomplete = "new-password";
      form.appendChild(pw);
      mockFindPasswordInputs.mockReturnValue([pw]);

      expect(shouldSkipForm(form)).toBe(true);
    });

    it("skips forms with registration-like action URL", () => {
      const form = createForm({ action: "https://example.com/register" });
      const pw = createPasswordInput();
      form.appendChild(pw);
      mockFindPasswordInputs.mockReturnValue([pw]);

      expect(shouldSkipForm(form)).toBe(true);
    });

    it("skips forms with /signup action", () => {
      const form = createForm({ action: "https://example.com/signup" });
      const pw = createPasswordInput();
      form.appendChild(pw);
      mockFindPasswordInputs.mockReturnValue([pw]);

      expect(shouldSkipForm(form)).toBe(true);
    });

    it("skips forms with /forgot action", () => {
      const form = createForm({ action: "https://example.com/forgot" });
      const pw = createPasswordInput();
      form.appendChild(pw);
      mockFindPasswordInputs.mockReturnValue([pw]);

      expect(shouldSkipForm(form)).toBe(true);
    });

    it("skips forms with 3+ registration-like extra fields", () => {
      const form = createForm({
        inputs: [
          { type: "text", name: "first_name" },
          { type: "text", name: "last_name" },
          { type: "tel", name: "phone" },
          { type: "email" },
        ],
      });
      const pw = createPasswordInput();
      form.appendChild(pw);
      mockFindPasswordInputs.mockReturnValue([pw]);

      expect(shouldSkipForm(form)).toBe(true);
    });

    it("does NOT skip a normal login form", () => {
      const form = createForm();
      const pw = createPasswordInput();
      form.appendChild(pw);
      mockFindPasswordInputs.mockReturnValue([pw]);

      expect(shouldSkipForm(form)).toBe(false);
    });
  });

  describe("extractCredentials", () => {
    it("extracts username and password from login form", () => {
      const form = createForm();
      const pw = createPasswordInput("mypassword");
      const user = createTextInput("alice");
      form.appendChild(user);
      form.appendChild(pw);

      mockFindPasswordInputs.mockReturnValue([pw]);
      mockFindUsernameInput.mockReturnValue(user);

      const result = extractCredentials(form);
      expect(result).toEqual({ username: "alice", password: "mypassword" });
    });

    it("returns empty username when no username field found", () => {
      const form = createForm();
      const pw = createPasswordInput("mypassword");
      form.appendChild(pw);

      mockFindPasswordInputs.mockReturnValue([pw]);
      mockFindUsernameInput.mockReturnValue(null);

      const result = extractCredentials(form);
      expect(result).toEqual({ username: "", password: "mypassword" });
    });

    it("returns null when no password fields", () => {
      const form = createForm();
      mockFindPasswordInputs.mockReturnValue([]);

      expect(extractCredentials(form)).toBeNull();
    });

    it("returns null when password is empty", () => {
      const form = createForm();
      const pw = createPasswordInput("");
      form.appendChild(pw);

      mockFindPasswordInputs.mockReturnValue([pw]);

      expect(extractCredentials(form)).toBeNull();
    });

    it("returns null for registration form (shouldSkipForm true)", () => {
      const form = createForm({ action: "https://example.com/register" });
      const pw = createPasswordInput("pw");
      form.appendChild(pw);
      mockFindPasswordInputs.mockReturnValue([pw]);

      expect(extractCredentials(form)).toBeNull();
    });

    it("returns null when multiple password fields exist", () => {
      const form = createForm();
      const pw1 = createPasswordInput("pw1");
      const pw2 = createPasswordInput("pw2");
      form.appendChild(pw1);
      form.appendChild(pw2);
      mockFindPasswordInputs.mockReturnValue([pw1, pw2]);

      expect(extractCredentials(form)).toBeNull();
    });
  });

  describe("extractCredentialsFromPage", () => {
    beforeEach(() => {
      document.body.innerHTML = "";
    });

    it("extracts credentials from a filled password input on the page", () => {
      const user = createTextInput("alice");
      const pw = createPasswordInput("secret");
      document.body.appendChild(user);
      document.body.appendChild(pw);

      mockFindPasswordInputs.mockReturnValue([pw]);
      mockFindUsernameInput.mockReturnValue(user);

      const result = extractCredentialsFromPage();
      expect(result).toEqual({ username: "alice", password: "secret" });
    });

    it("returns null when no filled password fields", () => {
      const pw = createPasswordInput("");
      document.body.appendChild(pw);

      mockFindPasswordInputs.mockReturnValue([pw]);

      expect(extractCredentialsFromPage()).toBeNull();
    });

    it("returns null when more than 2 filled password fields", () => {
      const pw1 = createPasswordInput("pw1");
      const pw2 = createPasswordInput("pw2");
      const pw3 = createPasswordInput("pw3");
      document.body.appendChild(pw1);
      document.body.appendChild(pw2);
      document.body.appendChild(pw3);

      mockFindPasswordInputs.mockReturnValue([pw1, pw2, pw3]);

      expect(extractCredentialsFromPage()).toBeNull();
    });

    it("returns null when password is inside a registration form", () => {
      const form = createForm({ action: "https://example.com/register" });
      const pw = createPasswordInput("pw");
      form.appendChild(pw);
      document.body.appendChild(form);

      mockFindPasswordInputs.mockReturnValue([pw]);

      expect(extractCredentialsFromPage()).toBeNull();
    });
  });

  describe("initLoginDetector", () => {
    const mockSendMessage = vi.mocked(chrome.runtime.sendMessage);
    const mockShowSaveBanner = vi.mocked(showSaveBanner);

    beforeEach(() => {
      document.body.innerHTML = "";
    });

    it("sends LOGIN_DETECTED on form submit with credentials", () => {
      const form = createForm();
      const pw = createPasswordInput("secret");
      const user = createTextInput("bob");
      form.appendChild(user);
      form.appendChild(pw);
      document.body.appendChild(form);

      mockFindPasswordInputs.mockReturnValue([pw]);
      mockFindUsernameInput.mockReturnValue(user);

      const cleanup = initLoginDetector();

      form.dispatchEvent(new Event("submit", { bubbles: true }));

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "LOGIN_DETECTED",
          username: "bob",
          password: "secret",
        }),
        expect.any(Function),
      );

      cleanup.destroy();
    });

    it("does not send message for forms without credentials", () => {
      const form = createForm();
      const pw = createPasswordInput("");
      form.appendChild(pw);
      document.body.appendChild(form);

      mockFindPasswordInputs.mockReturnValue([pw]);

      const cleanup = initLoginDetector();

      form.dispatchEvent(new Event("submit", { bubbles: true }));

      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOGIN_DETECTED" }),
        expect.any(Function),
      );

      cleanup.destroy();
    });

    it("shows save banner when background responds with save action", () => {
      const form = createForm();
      const pw = createPasswordInput("secret");
      const user = createTextInput("bob");
      form.appendChild(user);
      form.appendChild(pw);
      document.body.appendChild(form);

      mockFindPasswordInputs.mockReturnValue([pw]);
      mockFindUsernameInput.mockReturnValue(user);

      // Mock sendMessage to invoke callback with "save" action
      mockSendMessage.mockImplementation((_msg: unknown, callback?: (resp: unknown) => void) => {
        if (callback) {
          callback({ type: "LOGIN_DETECTED", action: "save" });
        }
      });

      const cleanup = initLoginDetector();

      form.dispatchEvent(new Event("submit", { bubbles: true }));

      expect(mockShowSaveBanner).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "save",
          username: "bob",
        }),
      );

      cleanup.destroy();
    });

    it("does not show banner when background responds with none action", () => {
      const form = createForm();
      const pw = createPasswordInput("secret");
      const user = createTextInput("bob");
      form.appendChild(user);
      form.appendChild(pw);
      document.body.appendChild(form);

      mockFindPasswordInputs.mockReturnValue([pw]);
      mockFindUsernameInput.mockReturnValue(user);

      mockSendMessage.mockImplementation((_msg: unknown, callback?: (resp: unknown) => void) => {
        if (callback) {
          callback({ type: "LOGIN_DETECTED", action: "none" });
        }
      });

      const cleanup = initLoginDetector();

      form.dispatchEvent(new Event("submit", { bubbles: true }));

      expect(mockShowSaveBanner).not.toHaveBeenCalled();

      cleanup.destroy();
    });

    it("stops listening after destroy()", () => {
      const form = createForm();
      const pw = createPasswordInput("secret");
      const user = createTextInput("bob");
      form.appendChild(user);
      form.appendChild(pw);
      document.body.appendChild(form);

      mockFindPasswordInputs.mockReturnValue([pw]);
      mockFindUsernameInput.mockReturnValue(user);

      const cleanup = initLoginDetector();
      cleanup.destroy();

      form.dispatchEvent(new Event("submit", { bubbles: true }));

      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOGIN_DETECTED" }),
        expect.any(Function),
      );
    });

    it("calls hideSaveBanner on destroy()", () => {
      const mockHideSaveBanner = vi.mocked(hideSaveBanner);
      const cleanup = initLoginDetector();
      cleanup.destroy();
      expect(mockHideSaveBanner).toHaveBeenCalled();
    });

    it("registers onMessage listener for PSSO_SHOW_SAVE_BANNER", () => {
      const cleanup = initLoginDetector();
      expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
      cleanup.destroy();
    });

    it("removes onMessage listener on destroy()", () => {
      const cleanup = initLoginDetector();
      cleanup.destroy();
      expect(chrome.runtime.onMessage.removeListener).toHaveBeenCalled();
    });

    it("shows save banner when PSSO_SHOW_SAVE_BANNER message received", () => {
      const cleanup = initLoginDetector();

      // Simulate background pushing save banner
      for (const listener of messageListeners) {
        listener({
          type: "PSSO_SHOW_SAVE_BANNER",
          host: "example.com",
          username: "alice",
          password: "secret123",
          action: "save",
        });
      }

      expect(mockShowSaveBanner).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "example.com",
          username: "alice",
          action: "save",
        }),
      );

      cleanup.destroy();
    });

    it("does not show banner for PSSO_SHOW_SAVE_BANNER with action=none", () => {
      const cleanup = initLoginDetector();

      for (const listener of messageListeners) {
        listener({
          type: "PSSO_SHOW_SAVE_BANNER",
          host: "example.com",
          username: "alice",
          password: "secret123",
          action: "none",
        });
      }

      expect(mockShowSaveBanner).not.toHaveBeenCalled();

      cleanup.destroy();
    });

    it("ignores unrelated messages", () => {
      const cleanup = initLoginDetector();

      for (const listener of messageListeners) {
        listener({ type: "UNRELATED_MESSAGE" });
      }

      expect(mockShowSaveBanner).not.toHaveBeenCalled();

      cleanup.destroy();
    });

    it("sends CHECK_PENDING_SAVE on init", () => {
      const cleanup = initLoginDetector();

      expect(mockSendMessage).toHaveBeenCalledWith(
        { type: "CHECK_PENDING_SAVE" },
        expect.any(Function),
      );

      cleanup.destroy();
    });

    it("shows save banner when CHECK_PENDING_SAVE returns save action", () => {
      mockSendMessage.mockImplementation((msg: unknown, callback?: (resp: unknown) => void) => {
        const m = msg as { type: string };
        if (m.type === "CHECK_PENDING_SAVE" && callback) {
          callback({
            type: "CHECK_PENDING_SAVE",
            action: "save",
            host: "example.com",
            username: "pulled-user",
            password: "pulled-pw",
          });
        }
      });

      const cleanup = initLoginDetector();

      expect(mockShowSaveBanner).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "example.com",
          username: "pulled-user",
          action: "save",
        }),
      );

      cleanup.destroy();
    });

    it("does not show banner when CHECK_PENDING_SAVE returns none", () => {
      mockSendMessage.mockImplementation((msg: unknown, callback?: (resp: unknown) => void) => {
        const m = msg as { type: string };
        if (m.type === "CHECK_PENDING_SAVE" && callback) {
          callback({
            type: "CHECK_PENDING_SAVE",
            action: "none",
          });
        }
      });

      const cleanup = initLoginDetector();

      expect(mockShowSaveBanner).not.toHaveBeenCalled();

      cleanup.destroy();
    });

    it("sends LOGIN_DETECTED when a submit-like button is clicked near password fields", () => {
      const pw = createPasswordInput("secret");
      const user = createTextInput("bob");
      const button = document.createElement("button");
      button.id = "submit";
      button.type = "submit";
      button.textContent = "Log In";
      document.body.appendChild(user);
      document.body.appendChild(pw);
      document.body.appendChild(button);

      mockFindPasswordInputs.mockReturnValue([pw]);
      mockFindUsernameInput.mockReturnValue(user);

      const cleanup = initLoginDetector();

      button.click();

      expect(mockSendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "LOGIN_DETECTED",
          username: "bob",
          password: "secret",
        }),
        expect.any(Function),
      );

      cleanup.destroy();
    });

    it("does not send LOGIN_DETECTED for non-submit-like buttons", () => {
      const pw = createPasswordInput("secret");
      const user = createTextInput("bob");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Cancel";
      document.body.appendChild(user);
      document.body.appendChild(pw);
      document.body.appendChild(button);

      mockFindPasswordInputs.mockReturnValue([pw]);
      mockFindUsernameInput.mockReturnValue(user);

      const cleanup = initLoginDetector();

      button.click();

      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOGIN_DETECTED" }),
        expect.any(Function),
      );

      cleanup.destroy();
    });

    it("removes click listener after destroy()", () => {
      const pw = createPasswordInput("secret");
      const user = createTextInput("bob");
      const button = document.createElement("button");
      button.type = "submit";
      button.textContent = "Log In";
      document.body.appendChild(user);
      document.body.appendChild(pw);
      document.body.appendChild(button);

      mockFindPasswordInputs.mockReturnValue([pw]);
      mockFindUsernameInput.mockReturnValue(user);

      const cleanup = initLoginDetector();
      cleanup.destroy();

      button.click();

      expect(mockSendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "LOGIN_DETECTED" }),
        expect.any(Function),
      );
    });
  });
});
