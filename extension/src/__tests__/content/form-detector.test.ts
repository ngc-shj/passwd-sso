/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  findPasswordInputs,
  findUsernameInput,
  isUsableInput,
  isLikelyUsernameInput,
  isElementVisuallySafe,
  isPageVisuallySafe,
  isInputHitTestSafe,
  hasVisiblePopoverOverlayNear,
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

describe("clickjacking hardening guards", () => {
  it("treats opacity:0 input as visually unsafe", () => {
    const input = document.createElement("input");
    input.type = "password";
    input.style.opacity = "0";
    document.body.appendChild(input);
    expect(isElementVisuallySafe(input)).toBe(false);
  });

  it("treats page as unsafe when body opacity is reduced", () => {
    const original = document.body.style.opacity;
    document.body.style.opacity = "0";
    expect(isPageVisuallySafe()).toBe(false);
    document.body.style.opacity = original;
  });

  it("treats page as unsafe when body opacity is below threshold", () => {
    const original = document.body.style.opacity;
    document.body.style.opacity = "0.2";
    expect(isPageVisuallySafe()).toBe(false);
    document.body.style.opacity = original;
  });

  it("fails hit-test safety when another element is on top", () => {
    const input = document.createElement("input");
    input.type = "password";
    document.body.appendChild(input);

    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      top: 10,
      left: 10,
      bottom: 40,
      right: 210,
      width: 200,
      height: 30,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    });

    const overlay = document.createElement("div");
    document.body.appendChild(overlay);
    const original = (document as Document & { elementFromPoint?: (x: number, y: number) => Element | null }).elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: () => overlay,
    });
    expect(isInputHitTestSafe(input)).toBe(false);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      writable: true,
      value: original,
    });
  });

  it("detects visible popover overlapping input center", () => {
    const input = document.createElement("input");
    input.type = "password";
    document.body.appendChild(input);

    vi.spyOn(input, "getBoundingClientRect").mockReturnValue({
      top: 10,
      left: 10,
      bottom: 40,
      right: 210,
      width: 200,
      height: 30,
      x: 10,
      y: 10,
      toJSON: () => ({}),
    });

    const popover = document.createElement("div");
    popover.setAttribute("popover", "manual");
    popover.setAttribute("open", "");
    document.body.appendChild(popover);
    vi.spyOn(popover, "getBoundingClientRect").mockReturnValue({
      top: 0,
      left: 0,
      bottom: 100,
      right: 300,
      width: 300,
      height: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    expect(hasVisiblePopoverOverlayNear(input)).toBe(true);
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

describe("isLikelyUsernameInput", () => {
  it("detects autocomplete=username even without password field", () => {
    document.body.innerHTML = `<input id="uid" type="text" autocomplete="username" />`;
    const input = document.getElementById("uid") as HTMLInputElement;
    expect(isLikelyUsernameInput(input)).toBe(true);
  });

  it("detects email/login-like field by name/id/placeholder hints", () => {
    document.body.innerHTML = `<input id="login-id" name="user_email" type="text" placeholder="Email" />`;
    const input = document.getElementById("login-id") as HTMLInputElement;
    expect(isLikelyUsernameInput(input)).toBe(true);
  });

  it("does not detect generic search field", () => {
    document.body.innerHTML = `<input id="search" name="query" type="text" placeholder="Search" />`;
    const input = document.getElementById("search") as HTMLInputElement;
    expect(isLikelyUsernameInput(input)).toBe(false);
  });

  it("does not detect non text/email/tel inputs", () => {
    document.body.innerHTML = `<input id="age" type="number" name="user" />`;
    const input = document.getElementById("age") as HTMLInputElement;
    expect(isLikelyUsernameInput(input)).toBe(false);
  });

  it("detects Japanese contract-number login id fields", () => {
    document.body.innerHTML = `
      <label for="tx-contract-number">ご契約番号</label>
      <input id="tx-contract-number" type="tel" formcontrolname="keiyakuNum" placeholder="半角数字" />
    `;
    const input = document.getElementById("tx-contract-number") as HTMLInputElement;
    expect(isLikelyUsernameInput(input)).toBe(true);
  });

  it("does not detect Japanese search fields", () => {
    document.body.innerHTML = `
      <label for="q">検索</label>
      <input id="q" type="text" placeholder="検索キーワード" />
    `;
    const input = document.getElementById("q") as HTMLInputElement;
    expect(isLikelyUsernameInput(input)).toBe(false);
  });
});
