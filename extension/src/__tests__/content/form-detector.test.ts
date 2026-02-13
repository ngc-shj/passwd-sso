/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findPasswordInputs,
  findUsernameInput,
  isUsableInput,
} from "../../content/form-detector-lib";

// Mock chrome.runtime for the module import
vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: vi.fn(),
    lastError: null,
  },
  i18n: {
    getUILanguage: () => "en",
  },
});

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("isUsableInput", () => {
  it("returns true for a normal input", () => {
    const input = document.createElement("input");
    input.type = "text";
    expect(isUsableInput(input)).toBe(true);
  });

  it("returns false for a disabled input", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.disabled = true;
    expect(isUsableInput(input)).toBe(false);
  });

  it("returns false for a readonly input", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    expect(isUsableInput(input)).toBe(false);
  });
});

describe("findPasswordInputs", () => {
  it("finds password inputs in the document", () => {
    document.body.innerHTML = `
      <input type="text" />
      <input type="password" id="pw1" />
      <input type="password" id="pw2" />
    `;
    const inputs = findPasswordInputs(document);
    expect(inputs).toHaveLength(2);
    expect(inputs[0].id).toBe("pw1");
    expect(inputs[1].id).toBe("pw2");
  });

  it("excludes disabled password inputs", () => {
    document.body.innerHTML = `
      <input type="password" id="pw1" />
      <input type="password" id="pw2" disabled />
    `;
    const inputs = findPasswordInputs(document);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].id).toBe("pw1");
  });

  it("returns empty array when no password inputs exist", () => {
    document.body.innerHTML = `<input type="text" />`;
    expect(findPasswordInputs(document)).toHaveLength(0);
  });
});

describe("findUsernameInput", () => {
  it("finds input with autocomplete=username", () => {
    document.body.innerHTML = `
      <form>
        <input type="text" id="other" />
        <input type="email" id="user" autocomplete="username" />
        <input type="password" id="pw" />
      </form>
    `;
    const pw = document.getElementById("pw") as HTMLInputElement;
    const result = findUsernameInput(pw);
    expect(result?.id).toBe("user");
  });

  it("falls back to preceding text input when no autocomplete", () => {
    document.body.innerHTML = `
      <form>
        <input type="text" id="user" />
        <input type="password" id="pw" />
      </form>
    `;
    const pw = document.getElementById("pw") as HTMLInputElement;
    const result = findUsernameInput(pw);
    expect(result?.id).toBe("user");
  });

  it("falls back to preceding email input", () => {
    document.body.innerHTML = `
      <form>
        <input type="email" id="email" />
        <input type="password" id="pw" />
      </form>
    `;
    const pw = document.getElementById("pw") as HTMLInputElement;
    const result = findUsernameInput(pw);
    expect(result?.id).toBe("email");
  });

  it("returns null when no username input found", () => {
    document.body.innerHTML = `
      <form>
        <input type="password" id="pw" />
      </form>
    `;
    const pw = document.getElementById("pw") as HTMLInputElement;
    expect(findUsernameInput(pw)).toBeNull();
  });

  it("skips disabled inputs in fallback", () => {
    document.body.innerHTML = `
      <form>
        <input type="text" id="user" disabled />
        <input type="password" id="pw" />
      </form>
    `;
    const pw = document.getElementById("pw") as HTMLInputElement;
    expect(findUsernameInput(pw)).toBeNull();
  });

  it("uses document scope when no form", () => {
    document.body.innerHTML = `
      <input type="text" id="user" />
      <input type="password" id="pw" />
    `;
    const pw = document.getElementById("pw") as HTMLInputElement;
    const result = findUsernameInput(pw);
    expect(result?.id).toBe("user");
  });
});
