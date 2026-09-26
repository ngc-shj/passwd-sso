// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { readCspNonce, _resetCspNonceCacheForTests } from "./csp-nonce";

function addNoncedScript(nonce: string): HTMLScriptElement {
  const s = document.createElement("script");
  // jsdom mirrors the attribute into the IDL property, the same way a browser
  // does before it hides the attribute — so this exercises the real read path.
  s.setAttribute("nonce", nonce);
  document.head.appendChild(s);
  return s;
}

function addMeta(content: string): HTMLMetaElement {
  const m = document.createElement("meta");
  m.name = "csp-nonce";
  m.content = content;
  document.head.appendChild(m);
  return m;
}

describe("readCspNonce", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    _resetCspNonceCacheForTests();
  });

  it("prefers the nonce IDL property of a nonced script over the meta tag", () => {
    addNoncedScript("from-script");
    addMeta("from-meta");

    expect(readCspNonce()).toBe("from-script");
  });

  it("falls back to the meta tag when no nonced script has been parsed", () => {
    addMeta("from-meta");

    expect(readCspNonce()).toBe("from-meta");
  });

  it("returns null when the document carries neither carrier", () => {
    expect(readCspNonce()).toBeNull();
  });

  // The root error boundary renders its own <html><body> with no <head>, so a
  // miss is a real state. Caching it would let one early read on such a page
  // strip the nonce from every later consumer in the document.
  it("does not memoize a miss — a later read still finds a carrier", () => {
    expect(readCspNonce()).toBeNull();

    addNoncedScript("arrived-later");

    expect(readCspNonce()).toBe("arrived-later");
  });

  it("memoizes a hit — repeated reads do not re-query the DOM", () => {
    addNoncedScript("cached-value");
    expect(readCspNonce()).toBe("cached-value");

    // Dropping the memo would make this read the (now absent) carrier and
    // return null, so the assertion pins the caching rather than restating it.
    const spy = vi.spyOn(document, "querySelector");
    document.head.innerHTML = "";

    expect(readCspNonce()).toBe("cached-value");
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it("ignores an empty nonce and keeps looking", () => {
    addNoncedScript("");
    addMeta("real-nonce");

    expect(readCspNonce()).toBe("real-nonce");
  });
});
