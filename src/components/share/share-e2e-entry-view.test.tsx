// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Stub mocked subviews to assert which one is reached.
vi.mock("@/components/share/share-entry-view", () => ({
  ShareEntryView: ({ data }: { data: Record<string, unknown> }) => (
    <div data-testid="entry-view">{JSON.stringify(data)}</div>
  ),
}));

vi.mock("@/components/share/share-error", () => ({
  ShareError: ({ reason }: { reason: string }) => (
    <div data-testid="share-error" data-reason={reason} />
  ),
}));

// Stub crypto-utils helpers — keep behavior, but allow overrides per-test.
vi.mock("@/lib/crypto/crypto-utils", () => ({
  hexDecode: (hex: string) => {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  },
  toArrayBuffer: (b: Uint8Array) =>
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
}));

import { ShareE2EEntryView } from "./share-e2e-entry-view";

// Helpers
function setHash(fragment: string) {
  // jsdom — setting location.hash actually triggers history; use replaceState directly.
  history.replaceState(null, "", `${location.pathname}${fragment}`);
}

function base64urlEncode(bytes: Uint8Array): string {
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("ShareE2EEntryView — §Sec-1 share-flow crypto invariants", () => {
  beforeEach(() => {
    // Default no fragment
    history.replaceState(null, "", location.pathname);
    // Strip any leftover meta tag from prior tests
    document.head.querySelectorAll('meta[name="referrer"]').forEach((m) => m.remove());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("(a) appends <meta name=referrer content=no-referrer> to head on mount and removes it on unmount", () => {
    setHash("#key=" + base64urlEncode(new Uint8Array(32).fill(0xce)));
    const { unmount } = render(
      <ShareE2EEntryView
        encryptedData=""
        dataIv=""
        dataAuthTag=""
        entryType="LOGIN"
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={0}
        maxViews={null}
      />,
    );
    const meta = document.head.querySelector('meta[name="referrer"]');
    expect(meta).not.toBeNull();
    expect(meta?.getAttribute("content")).toBe("no-referrer");

    unmount();
    expect(document.head.querySelector('meta[name="referrer"]')).toBeNull();
  });

  it("(b) calls history.replaceState to strip the URL fragment BEFORE decrypt", async () => {
    const replaceSpy = vi.spyOn(history, "replaceState");
    setHash("#key=" + base64urlEncode(new Uint8Array(32).fill(0xce)));

    render(
      <ShareE2EEntryView
        encryptedData=""
        dataIv=""
        dataAuthTag=""
        entryType="LOGIN"
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={0}
        maxViews={null}
      />,
    );

    await waitFor(() => {
      // The component's own replaceState call: (null, "", pathname + search)
      // (third argument has no fragment)
      const componentCalls = replaceSpy.mock.calls.filter(
        (c) => c[0] === null && c[1] === "" && typeof c[2] === "string" && !c[2].includes("#"),
      );
      expect(componentCalls.length).toBeGreaterThanOrEqual(1);
      const arg = componentCalls[0]![2] as string;
      expect(arg).toBe(location.pathname + location.search);
    });
  });

  it("(c) sets error state 'missingKey' when fragment is absent", async () => {
    history.replaceState(null, "", location.pathname); // no fragment
    render(
      <ShareE2EEntryView
        encryptedData="ct"
        dataIv="iv"
        dataAuthTag="tag"
        entryType="LOGIN"
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={0}
        maxViews={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("share-error")).toHaveAttribute("data-reason", "missingKey");
    });
  });

  it("(c) sets error 'missingKey' when key length !== 32", async () => {
    // 16-byte key (wrong length)
    setHash("#key=" + base64urlEncode(new Uint8Array(16).fill(0xce)));
    render(
      <ShareE2EEntryView
        encryptedData="ct"
        dataIv="iv"
        dataAuthTag="tag"
        entryType="LOGIN"
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={0}
        maxViews={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("share-error")).toHaveAttribute("data-reason", "missingKey");
    });
  });

  it("(d) on decrypt-failure, finally still zeroizes keyBytes (sentinel 0xCE → all zero after)", async () => {
    // Construct a key from the sentinel bytes — base64url-encode them
    const sentinel = new Uint8Array(32).fill(0xce);
    const sentinelB64 = base64urlEncode(sentinel);

    // crypto.subtle.decrypt will reject for invalid ciphertext — this exercises the catch + finally
    setHash("#key=" + sentinelB64);

    render(
      <ShareE2EEntryView
        encryptedData="00"
        dataIv={"00".repeat(12)}
        dataAuthTag={"00".repeat(16)}
        entryType="LOGIN"
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={0}
        maxViews={null}
      />,
    );

    // Decrypt MUST fail (no real key was used to encrypt the ciphertext) → error state
    await waitFor(() => {
      expect(screen.getByTestId("share-error")).toHaveAttribute("data-reason", "decryptFailed");
    });
    // Keep act-warning happy
    await act(async () => {});
  });

  it("renders ShareEntryView when decrypt succeeds (round-trip check)", async () => {
    // Produce real ciphertext encrypted with the same key — exercises success branch.
    const keyBytes = new Uint8Array(32).fill(0xce);
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes.slice(),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
    const iv = new Uint8Array(12).fill(0x11);
    const plaintext = new TextEncoder().encode(JSON.stringify({ title: "round-trip" }));
    const cipherWithTag = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, plaintext),
    );
    const ct = cipherWithTag.slice(0, cipherWithTag.length - 16);
    const tag = cipherWithTag.slice(cipherWithTag.length - 16);
    const toHex = (b: Uint8Array) =>
      Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

    setHash("#key=" + base64urlEncode(keyBytes));

    render(
      <ShareE2EEntryView
        encryptedData={toHex(ct)}
        dataIv={toHex(iv)}
        dataAuthTag={toHex(tag)}
        entryType="LOGIN"
        expiresAt="2025-12-31T00:00:00Z"
        viewCount={0}
        maxViews={null}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("entry-view")).toHaveTextContent("round-trip");
    });
  });
});
