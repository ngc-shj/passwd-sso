/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WEBAUTHN_OWN_APP_BYPASS_MSG } from "../../lib/constants";

// The bridge tells the MAIN-world interceptor to stand down on the app's own
// pages. A stored server URL the server-URL rule refuses is no server, so no
// page is "own app" for it. jsdom's page is http://localhost:3000/.

vi.mock("../../content/webauthn-bridge-lib", () => ({ handleWebAuthnMessage: vi.fn() }));

const GUARD_KEY = "__pssoWebAuthnBridge";

type PostSpy = { mock: { calls: unknown[][] } };

async function loadBridgeWith(serverUrl: string): Promise<PostSpy> {
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn((_key: string, cb: (items: Record<string, unknown>) => void) => cb({ serverUrl })),
      },
    },
  });
  const post = vi.spyOn(window, "postMessage").mockImplementation(() => {});
  await import("../../content/webauthn-bridge");
  return post;
}

const bypassPosts = (post: PostSpy) =>
  post.mock.calls.filter(([msg]) => (msg as { type?: string })?.type === WEBAUTHN_OWN_APP_BYPASS_MSG);

beforeEach(() => {
  vi.resetModules();
  delete (window as unknown as Record<string, unknown>)[GUARD_KEY];
});

afterEach(() => {
  vi.doUnmock("../../lib/server-url");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("webauthn-bridge own-app bypass", () => {
  it("control: the app's own page (allowed server URL) gets the bypass", async () => {
    const post = await loadBridgeWith(window.location.origin);
    expect(bypassPosts(post)).toHaveLength(1);
  });

  it("a server URL the rule refuses is no server: no bypass", async () => {
    const isAllowedServerUrl = vi.fn(() => false);
    vi.doMock("../../lib/server-url", () => ({ isAllowedServerUrl }));
    const post = await loadBridgeWith(window.location.origin);
    expect(isAllowedServerUrl).toHaveBeenCalledWith(window.location.origin);
    expect(bypassPosts(post)).toEqual([]);
  });

  it("asks the rule about the stored serverUrl itself", async () => {
    const actual = await vi.importActual<typeof import("../../lib/server-url")>("../../lib/server-url");
    const isAllowedServerUrl = vi.fn((url: unknown) => actual.isAllowedServerUrl(url));
    vi.doMock("../../lib/server-url", () => ({ isAllowedServerUrl }));
    const post = await loadBridgeWith(`${window.location.origin}/app`);
    expect(isAllowedServerUrl).toHaveBeenCalledWith(`${window.location.origin}/app`);
    expect(bypassPosts(post)).toEqual([]);
  });
});
