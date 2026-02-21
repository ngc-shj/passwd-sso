/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock chrome API
vi.stubGlobal("chrome", {
  runtime: { id: "test-id", sendMessage: vi.fn(), lastError: null },
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
} from "../content/login-detector-lib";
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

    it("skips forms with autocomplete='new-password'", () => {
      const form = createForm();
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
});
