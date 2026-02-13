/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  showDropdown,
  hideDropdown,
  isDropdownVisible,
  handleDropdownKeydown,
  type DropdownOptions,
} from "../../../content/ui/suggestion-dropdown";

// Mock chrome.runtime
vi.stubGlobal("chrome", {
  runtime: {
    sendMessage: vi.fn(),
    lastError: null,
  },
  i18n: {
    getUILanguage: () => "en",
  },
});

function makeAnchorRect(): DOMRect {
  return {
    top: 100,
    left: 50,
    bottom: 130,
    right: 250,
    width: 200,
    height: 30,
    x: 50,
    y: 100,
    toJSON: () => ({}),
  };
}

function makeOptions(overrides?: Partial<DropdownOptions>): DropdownOptions {
  return {
    anchorRect: makeAnchorRect(),
    entries: [
      { id: "1", title: "Example", username: "alice", urlHost: "example.com", entryType: "LOGIN" },
      { id: "2", title: "Test", username: "bob", urlHost: "test.com", entryType: "LOGIN" },
    ],
    vaultLocked: false,
    onSelect: vi.fn(),
    onDismiss: vi.fn(),
    lockedMessage: "Vault is locked",
    noMatchesMessage: "No matches",
    headerLabel: "Logins",
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  hideDropdown();
  document.body.innerHTML = "";
});

describe("showDropdown", () => {
  it("creates a shadow host and renders entries", () => {
    showDropdown(makeOptions());
    expect(isDropdownVisible()).toBe(true);

    const host = document.getElementById("passwd-sso-shadow-host");
    expect(host).not.toBeNull();
  });

  it("renders locked message when vault is locked", () => {
    const opts = makeOptions({ vaultLocked: true });
    showDropdown(opts);
    expect(isDropdownVisible()).toBe(true);
  });

  it("renders no matches message when entries is empty", () => {
    const opts = makeOptions({ entries: [] });
    showDropdown(opts);
    expect(isDropdownVisible()).toBe(true);
  });
});

describe("hideDropdown", () => {
  it("removes the dropdown and calls onDismiss", () => {
    const opts = makeOptions();
    showDropdown(opts);
    expect(isDropdownVisible()).toBe(true);

    hideDropdown();
    expect(isDropdownVisible()).toBe(false);
    expect(opts.onDismiss).toHaveBeenCalledOnce();
  });

  it("is safe to call when no dropdown is shown", () => {
    expect(() => hideDropdown()).not.toThrow();
  });
});

describe("handleDropdownKeydown", () => {
  it("returns false when no dropdown is shown", () => {
    const e = new KeyboardEvent("keydown", { key: "ArrowDown" });
    expect(handleDropdownKeydown(e)).toBe(false);
  });

  it("navigates down with ArrowDown", () => {
    showDropdown(makeOptions());
    const e = new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true });
    const handled = handleDropdownKeydown(e);
    expect(handled).toBe(true);
  });

  it("navigates up with ArrowUp", () => {
    showDropdown(makeOptions());
    // First go down, then up
    handleDropdownKeydown(new KeyboardEvent("keydown", { key: "ArrowDown", cancelable: true }));
    const e = new KeyboardEvent("keydown", { key: "ArrowUp", cancelable: true });
    const handled = handleDropdownKeydown(e);
    expect(handled).toBe(true);
  });

  it("dismisses with Escape", () => {
    const opts = makeOptions();
    showDropdown(opts);
    const e = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    const handled = handleDropdownKeydown(e);
    expect(handled).toBe(true);
    expect(isDropdownVisible()).toBe(false);
  });
});
