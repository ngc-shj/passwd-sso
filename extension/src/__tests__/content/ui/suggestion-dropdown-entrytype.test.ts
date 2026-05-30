/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Use an OPEN shadow root we control so the test can read the rendered DOM
// (the production host uses a closed root that tests cannot inspect).
const hostState: { host: HTMLDivElement | null; root: ShadowRoot | null } = {
  host: null,
  root: null,
};

vi.mock("../../../content/ui/shadow-host", () => ({
  getShadowHost: () => {
    if (!hostState.host || !document.body.contains(hostState.host)) {
      const host = document.createElement("div");
      host.setAttribute("data-passwd-sso-shadow-host", "test");
      const root = host.attachShadow({ mode: "open" });
      document.body.appendChild(host);
      hostState.host = host;
      hostState.root = root;
    }
    return { host: hostState.host, root: hostState.root };
  },
  removeShadowHost: () => {
    hostState.host?.remove();
    hostState.host = null;
    hostState.root = null;
  },
}));

import {
  showDropdown,
  hideDropdown,
  type DropdownOptions,
  type DropdownEntryType,
} from "../../../content/ui/suggestion-dropdown";
import { EXT_ENTRY_TYPE } from "../../../lib/constants";

// jsdom re-serializes inline SVG (self-closing → explicit close tags), so the
// raw icon strings won't match verbatim. Assert on a stable path-data fragment
// unique to each icon instead.
const CARD_PATH = "M1 4a2 2 0";
const ID_PATH = "M2 3.5A1.5";
const KEY_PATH = "M11.5 1a3.5";

function itemIconHtml(): string {
  return hostState.root?.querySelector(".psso-item-icon")?.innerHTML ?? "";
}

function makeAnchorRect(): DOMRect {
  return {
    top: 100, left: 50, bottom: 130, right: 250,
    width: 200, height: 30, x: 50, y: 100, toJSON: () => ({}),
  };
}

function makeOptions(overrides?: Partial<DropdownOptions>): DropdownOptions {
  return {
    anchorRect: makeAnchorRect(),
    entries: [
      { id: "1", title: "Card", username: "Alice", urlHost: "", entryType: EXT_ENTRY_TYPE.CREDIT_CARD },
    ],
    vaultLocked: false,
    onSelect: vi.fn(),
    onDismiss: vi.fn(),
    lockedMessage: "locked",
    noMatchesMessage: "none",
    headerLabel: "Cards",
    ...overrides,
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(() => {
  hideDropdown();
});

describe("showDropdown entryType parametrization", () => {
  it("renders the card icon and Cards header for CREDIT_CARD", () => {
    showDropdown(makeOptions({ entryType: "CREDIT_CARD", headerLabel: "Cards" }));
    expect(itemIconHtml()).toContain(CARD_PATH);
    expect(itemIconHtml()).not.toContain(KEY_PATH);
    expect(hostState.root?.querySelector(".psso-dropdown-header")?.textContent).toBe("Cards");
  });

  it("renders the identity icon and Identities header for IDENTITY", () => {
    showDropdown(makeOptions({ entryType: "IDENTITY", headerLabel: "Identities" }));
    expect(itemIconHtml()).toContain(ID_PATH);
    expect(hostState.root?.querySelector(".psso-dropdown-header")?.textContent).toBe("Identities");
  });

  it("defaults to the LOGIN key icon when entryType is omitted (T4)", () => {
    const opts = makeOptions({ headerLabel: "Logins" });
    delete (opts as Partial<DropdownOptions>).entryType;
    showDropdown(opts);
    expect(itemIconHtml()).toContain(KEY_PATH);
  });

  it("accepts the optional entryType type", () => {
    const t: DropdownEntryType = "IDENTITY";
    expect(t).toBe("IDENTITY");
  });
});
