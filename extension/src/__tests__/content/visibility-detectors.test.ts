/**
 * @vitest-environment jsdom
 */
// C1 dropdown gates and C2 reveal re-scans (#884) for the inline detectors.
// Field visibility runs for real against the global layout stub
// (helpers/layout-stub.ts); only the page-level and hit-test guards are stubbed.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EXT_MSG } from "../../lib/constants";
import { ATTR_RESCAN_DELAY_MS } from "../../content/rescan-scheduler";

const showDropdownMock = vi.fn();

vi.mock("../../content/ui/suggestion-dropdown", () => ({
  showDropdown: (opts: unknown) => showDropdownMock(opts),
  hideDropdown: () => {},
  isDropdownVisible: () => false,
  handleDropdownKeydown: () => false,
  MESSAGE_AUTO_DISMISS_MS: 5000,
}));

vi.mock("../../lib/i18n", () => ({ t: (key: string) => key }));

// Counts detector scans without faking detection (identity's rescan calls
// through to it as well).
const ccClaimedFieldsMock = vi.hoisted(() => vi.fn());
vi.mock("../../content/cc-field-detection-lib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../content/cc-field-detection-lib")>();
  ccClaimedFieldsMock.mockImplementation(actual.ccClaimedFields);
  return { ...actual, ccClaimedFields: ccClaimedFieldsMock };
});

vi.mock("../../content/form-detector-lib", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../content/form-detector-lib")>()),
  isPageVisuallySafe: () => true,
  isInputHitTestSafe: () => true,
  hasVisiblePopoverOverlayNear: () => false,
}));

if (typeof globalThis.CSS === "undefined") {
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
}

let sent: string[] = [];

function installChrome(): void {
  sent = [];
  vi.stubGlobal("chrome", {
    runtime: {
      id: "ext-test-id",
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      sendMessage: vi.fn((msg: { type?: string }, cb?: (r: unknown) => void) => {
        sent.push(msg.type ?? "");
        cb?.({ type: msg.type, entries: [], vaultLocked: false, suppressInline: false });
      }),
      lastError: null,
    },
    i18n: { getUILanguage: () => "en" },
  });
}

function requests(type: string): number {
  return sent.filter((t) => t === type).length;
}

function focusIn(id: string): void {
  const el = document.getElementById(id) as HTMLInputElement;
  el.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

let cleanups: Array<{ destroy: () => void }> = [];
function registerDestroy<T extends { destroy: () => void }>(detector: T): T {
  cleanups.push(detector);
  return detector;
}

beforeEach(() => {
  showDropdownMock.mockReset();
  ccClaimedFieldsMock.mockClear();
  document.body.innerHTML = "";
  document.documentElement.className = "";
  cleanups = [];
  installChrome();
});

afterEach(() => {
  for (const d of cleanups) d.destroy();
  cleanups = [];
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  document.documentElement.className = "";
  vi.useRealTimers();
});

type Profile = {
  label: string;
  messageType: string;
  /** A form whose fields carry `prefix`-ed ids: `${prefix}a` is the field focused. */
  form: (prefix: string, attrs?: string) => string;
  init: () => Promise<{ destroy: () => void }>;
};

const profiles: Profile[] = [
  {
    label: "CC",
    messageType: EXT_MSG.GET_CC_MATCHES_FOR_URL,
    form: (p, attrs = "") =>
      `<input id="${p}a" autocomplete="cc-number" ${attrs}><input id="${p}b" autocomplete="cc-csc">`,
    init: async () => (await import("../../content/cc-form-detector-lib")).initCreditCardDetector(),
  },
  {
    label: "identity",
    messageType: EXT_MSG.GET_IDENTITY_MATCHES_FOR_URL,
    form: (p, attrs = "") =>
      `<input id="${p}a" autocomplete="name" ${attrs}><input id="${p}b" autocomplete="address-line1">`,
    init: async () => (await import("../../content/identity-form-detector-lib")).initIdentityDetector(),
  },
];

describe("dropdown gate: a zero-rect field gets no dropdown", () => {
  for (const profile of profiles) {
    describe(profile.label, () => {
      it("a visible field gets the dropdown (control)", async () => {
        document.body.innerHTML = profile.form("v");
        registerDestroy(await profile.init());
        focusIn("va");
        expect(requests(profile.messageType)).toBe(1);
        expect(showDropdownMock).toHaveBeenCalledTimes(1);
      });

      it("a zero-rect field gets none", async () => {
        document.body.innerHTML = profile.form("z", 'data-rect="0,0,0,0"');
        registerDestroy(await profile.init());
        focusIn("za");
        expect(requests(profile.messageType)).toBe(0);
        expect(showDropdownMock).not.toHaveBeenCalled();
      });
    });
  }

  describe("LOGIN", () => {
    it("a visible password gets a match request (control)", async () => {
      document.body.innerHTML = `<input id="pw" type="password">`;
      const { initFormDetector } = await import("../../content/form-detector-lib");
      registerDestroy(initFormDetector());
      focusIn("pw");
      await Promise.resolve();
      expect(requests("GET_MATCHES_FOR_URL")).toBe(1);
    });

    it("a zero-rect password gets none", async () => {
      document.body.innerHTML = `<input id="pw" type="password" data-rect="0,0,0,0">`;
      const { initFormDetector } = await import("../../content/form-detector-lib");
      registerDestroy(initFormDetector());
      focusIn("pw");
      await Promise.resolve();
      expect(requests("GET_MATCHES_FOR_URL")).toBe(0);
    });

    it("an opacity:0 password gets none", async () => {
      document.body.innerHTML = `<input id="pw" type="password" style="opacity:0">`;
      const { initFormDetector } = await import("../../content/form-detector-lib");
      registerDestroy(initFormDetector());
      focusIn("pw");
      await Promise.resolve();
      expect(requests("GET_MATCHES_FOR_URL")).toBe(0);
    });
  });
});

describe("C2: a revealed container's fields are admitted", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });

  for (const profile of profiles) {
    describe(profile.label, () => {
      it("opening a <details> re-scans: its field is a member before it is focused", async () => {
        document.body.innerHTML = `<details id="d"><summary>Pay</summary>${profile.form("d")}</details>`;
        registerDestroy(await profile.init());
        const details = document.getElementById("d") as HTMLDetailsElement;

        focusIn("da");
        expect(requests(profile.messageType)).toBe(0);

        details.open = true;
        await flushMicrotasks();
        vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);

        // A member focus costs no scan: the open itself admitted the field.
        const before = ccClaimedFieldsMock.mock.calls.length;
        focusIn("da");
        expect(ccClaimedFieldsMock.mock.calls.length - before).toBe(0);
        expect(requests(profile.messageType)).toBe(1);
      });

      it("a CSS-only reveal (<html> class flip) is admitted on focus, not before", async () => {
        document.head.innerHTML = `<style>html.collapsed .panel { display: none; }</style>`;
        document.documentElement.className = "collapsed";
        document.body.innerHTML = `<div class="panel">${profile.form("c")}</div>`;
        registerDestroy(await profile.init());

        focusIn("ca");
        expect(requests(profile.messageType)).toBe(0);

        // <html> is outside the observed <body>: no mutation reaches the detector.
        document.documentElement.className = "";
        await flushMicrotasks();
        vi.advanceTimersByTime(ATTR_RESCAN_DELAY_MS);

        focusIn("ca");
        expect(requests(profile.messageType)).toBe(1);
      });

      it("focusing a field still hidden after the last scan costs no request", async () => {
        document.head.innerHTML = `<style>html.collapsed .panel { display: none; }</style>`;
        document.documentElement.className = "collapsed";
        document.body.innerHTML = `<div class="panel">${profile.form("c")}</div>`;
        registerDestroy(await profile.init());

        const before = ccClaimedFieldsMock.mock.calls.length;
        focusIn("ca");
        expect(ccClaimedFieldsMock.mock.calls.length - before).toBe(0);
        expect(requests(profile.messageType)).toBe(0);
      });
    });
  }
});
